/**
 * CMS Open Payments — physicians' ownership and investment interests.
 *
 * The Physician Payments Sunshine Act (42 U.S.C. §1320a-7h) requires drug and device
 * manufacturers and group purchasing organisations to report, by name, any ownership or
 * investment interest a physician holds in them. Public domain, no commercial-use
 * restriction, and — unusually — it carries an EXACT DOLLAR VALUE of the stake rather
 * than a band.
 *
 * It is the only source here covering a profession rather than a corporate role, so it
 * reaches people no SEC filing ever will.
 *
 * ── Two things this parser refuses to pass through ────────────────────────────────
 *
 * 1. FAMILY MEMBERS. Records are flagged as held by the physician or by an "Immediate
 *    family member" — about 6% of a sample of 400. A physician accepted a disclosure
 *    duty with their role; their relative did not. Consistent with assertDisclosable()
 *    elsewhere, only the physician's own interests are indexed.
 *
 * 2. THE STREET ADDRESS. The field is labelled "primary business address", and for a
 *    hospital that is true. For a solo practitioner it is routinely the practice —
 *    which is routinely a home. There is no flag separating the two, so the street line
 *    is never read and only city and state are kept.
 */

const number = (value) => {
  const raw = String(value ?? "").replace(/[,$]/g, "").trim();
  // Number("") is 0, so an absent value must be rejected before conversion or a missing
  // stake becomes a stake worth nothing.
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Only the physician's own interests. See the note above. */
export function isPhysicianHeld(row) {
  return /physician covered recipient/i.test(String(row?.interest_held_by_physician_or_an_immediate_family_member || ""));
}

/**
 * Pull the ownership percentage out of the free-text terms when it is stated.
 *
 * `terms_of_interest` is prose — "50 PERCENT OWNER IN REPORTING ENTITY" — and only
 * about 3% of rows state a figure. Returns null rather than guessing, so a UI can show
 * a percentage when one was disclosed and say nothing when it was not.
 */
export function extractPercent(terms) {
  const match = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/i.exec(String(terms || ""));
  if (!match) return null;
  const percent = Number(match[1]);
  return percent >= 0 && percent <= 100 ? percent : null;
}

/**
 * Redact anything address-shaped from third-party free text.
 *
 * `terms_of_interest` is prose written by the reporting manufacturer, and it is the one
 * field here whose contents nobody controls. Today's data contains no street address in
 * it — that was checked across all 2,646 rows of the 2025 file — but the field is
 * unbounded, so relying on that is relying on luck rather than on a rule.
 *
 * The text is worth keeping: "45% ownership in Cascade Surgical Solutions" is real
 * explanatory context. So it is scrubbed rather than dropped, and a redaction is
 * visible rather than silent.
 */
export function scrubFreeText(value) {
  const raw = String(value || "");
  if (!raw) return null;

  return (
    raw
      // "1234 Main Street", "89 Leuning St", "12 Oak Ave Suite 4"
      .replace(
        /\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy)\b\.?/gi,
        "[address redacted]",
      )
      // "Suite 400", "Apt 12B", "PO Box 900"
      .replace(/\b(?:Suite|Ste|Apt|Apartment|Unit|P\.?\s?O\.?\s+Box)\s+[\w-]+/gi, "[address redacted]")
      // A bare 5- or 9-digit postcode. Dollar figures carry commas or a $, so this does
      // not swallow them.
      .replace(/(?<![\d,$.])\b\d{5}(?:-\d{4})?\b(?![\d,.])/g, "[postcode redacted]")
      .trim() || null
  );
}

/** Parse one CMS ownership row. Returns null for anything not indexable. */
export function parseOwnership(row) {
  if (!row || !isPhysicianHeld(row)) return null;

  const value = number(row.value_of_interest);
  const invested = number(row.total_amount_invested_usdollars);
  if (value == null && invested == null) return null;

  const name = [row.physician_first_name, row.physician_middle_name, row.physician_last_name, row.physician_name_suffix]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  if (!name) return null;

  return {
    // The NPI is a stable national identifier for a clinician, which no other source
    // here provides — it is what makes these records joinable and de-duplicable.
    npi: String(row.physician_npi || "").trim() || null,
    profileId: String(row.physician_profile_id || "").trim() || null,
    name,
    primaryType: String(row.physician_primary_type || "").trim() || null,
    // Pipe-delimited in the source: "Dental Providers|Dentist|Oral and Maxillofacial".
    specialties: String(row.physician_specialty || "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean),
    // CITY AND STATE ONLY — the street line is deliberately not read.
    city: String(row.recipient_city || "").trim() || null,
    state: String(row.recipient_state || "").trim() || null,
    interest: {
      // Exact dollars, reported by the manufacturer, not modelled.
      valueOfInterest: value,
      amountInvested: invested,
      // The percentage is read from the ORIGINAL text, then the text is scrubbed —
      // scrubbing first could remove digits the percentage parser needs.
      percentOwned: extractPercent(row.terms_of_interest),
      terms: scrubFreeText(row.terms_of_interest),
      inCompany: String(row.submitting_applicable_manufacturer_or_applicable_gpo_name || "").trim() || null,
      disputed: /^yes$/i.test(String(row.dispute_status_for_publication || "")),
    },
  };
}

/**
 * Fold rows into one record per physician.
 *
 * Keyed on NPI when present, name plus company otherwise. A physician can hold stakes
 * in several manufacturers, and each is a separate disclosure.
 */
export function buildPhysicians(rows) {
  const byPerson = new Map();

  for (const row of rows) {
    const parsed = parseOwnership(row);
    if (!parsed) continue;

    const key = parsed.npi ? `npi:${parsed.npi}` : `name:${parsed.name.toLowerCase()}:${parsed.interest.inCompany}`;
    const entry = byPerson.get(key) || {
      npi: parsed.npi,
      name: parsed.name,
      primaryType: parsed.primaryType,
      specialties: parsed.specialties,
      city: parsed.city,
      state: parsed.state,
      interests: [],
    };

    entry.interests.push(parsed.interest);
    byPerson.set(key, entry);
  }

  return [...byPerson.values()].map((entry) => ({
    ...entry,
    interestCount: entry.interests.length,
    /**
     * Summed across companies, and the sum is honest here in a way it is not for
     * Form 144: these are concurrent stakes in different entities, each valued once,
     * not repeated notices of the same shares.
     */
    totalDisclosedInterest: entry.interests.reduce((sum, i) => sum + (i.valueOfInterest || 0), 0),
  }));
}
