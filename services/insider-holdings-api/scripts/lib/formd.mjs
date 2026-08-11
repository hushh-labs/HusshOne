/**
 * Form D — officers and directors of PRIVATE companies that raised money.
 *
 * Section 16 only sees public companies, so the entire private-company world — every
 * startup founder — is invisible to it. Form D is the filing a company makes with the
 * SEC when it raises under Regulation D, and its "Related Persons" block names the
 * executive officers, directors and promoters. That is the founder population.
 *
 * ── Why this is NOT on the proximity map ──────────────────────────────────────────
 *
 * Everywhere else in this service a person is placed at their employer's address,
 * which is safe because a public company's address is a corporate headquarters.
 *
 * That reasoning collapses for Form D. Checked against a real 2026 filing
 * (0002133962-26-000001): the issuer address is 2312 CASA GRANDE DRIVE, League City TX
 * — and the two related persons list *the same address*, because it is their house. For
 * a small private company the "business address" is routinely a residence.
 *
 * So Form D people are searchable by name and company, reported at CITY level, and
 * never geocoded or ranked by distance. Putting these on a proximity map would place
 * homes on it by the back door, which is the one thing this service does not do.
 *
 * `relatedPersonAddress` is never read at all — not for placement, not for display.
 */

const text = (xml, tag) => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? match[1].trim() : null;
};

const blocks = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let match;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
};

const number = (value) => {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

/** Section 16-style role filter: only people with a stated governance role. */
const KEPT_ROLES = Object.freeze(["Executive Officer", "Director", "Promoter"]);

/**
 * Parse one Form D `primary_doc.xml`.
 *
 * Returns null when the filing names nobody we may index, so a caller can skip it
 * without special-casing empty results.
 */
export function parseFormD(xml, { accession = null } = {}) {
  if (!xml || !xml.includes("<edgarSubmission")) return null;

  const issuerBlock = blocks(xml, "primaryIssuer")[0] || xml;
  const addressBlock = blocks(issuerBlock, "issuerAddress")[0] || "";

  const issuer = {
    cik: text(issuerBlock, "cik"),
    name: text(issuerBlock, "entityName"),
    entityType: text(issuerBlock, "entityType"),
    jurisdiction: text(issuerBlock, "jurisdictionOfInc"),
    yearOfIncorporation: number(text(blocks(issuerBlock, "yearOfInc")[0] || "", "value")),
    phone: text(issuerBlock, "issuerPhoneNumber"),
    // CITY AND STATE ONLY. The street line is deliberately not read — on a small
    // private issuer it is frequently the founder's home. See the note at the top.
    city: text(addressBlock, "city"),
    state: text(addressBlock, "stateOrCountry"),
  };

  if (!issuer.cik || !issuer.name) return null;

  const offering = blocks(xml, "offeringData")[0] || xml;
  const amounts = blocks(offering, "offeringSalesAmounts")[0] || "";

  const raised = {
    totalOfferingAmount: number(text(amounts, "totalOfferingAmount")),
    totalAmountSold: number(text(amounts, "totalAmountSold")),
    totalRemaining: number(text(amounts, "totalRemaining")),
    minimumInvestment: number(text(offering, "minimumInvestmentAccepted")),
    investorCount: number(text(blocks(offering, "investors")[0] || "", "totalNumberAlreadyInvested")),
    industry: text(offering, "industryGroupType"),
    dateOfFirstSale: text(blocks(offering, "dateOfFirstSale")[0] || offering, "value"),
  };

  const people = [];
  for (const person of blocks(blocks(xml, "relatedPersonsList")[0] || "", "relatedPersonInfo")) {
    const nameBlock = blocks(person, "relatedPersonName")[0] || "";
    const first = text(nameBlock, "firstName");
    const middle = text(nameBlock, "middleName");
    const last = text(nameBlock, "lastName");
    if (!first && !last) continue;

    const roles = blocks(blocks(person, "relatedPersonRelationshipList")[0] || "", "relationship")
      .map((role) => role.trim())
      .filter((role) => KEPT_ROLES.includes(role));
    if (roles.length === 0) continue;

    // NOTE: relatedPersonAddress is intentionally not read.
    people.push({
      name: [first, middle, last].filter(Boolean).join(" "),
      firstName: first,
      lastName: last,
      roles,
      // Free text such as "Co-Manager of the Manager" — genuinely useful context.
      roleNote: text(person, "relationshipClarification"),
    });
  }

  if (people.length === 0) return null;

  return {
    accession,
    issuer,
    raised,
    people,
    filingUrl: issuer.cik
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${issuer.cik}&type=D`
      : null,
  };
}

/**
 * Fold parsed filings into a person-keyed roster.
 *
 * Keyed on lowercased name plus issuer CIK: Form D carries no personal identifier at
 * all — no CRD, no CIK for the individual — so two different people with the same name
 * at different companies must stay separate, and the same person filing twice for one
 * company must merge. Name alone would conflate the first case; accession alone would
 * split the second.
 */
export function buildRoster(filings) {
  const roster = new Map();

  for (const filing of filings) {
    if (!filing) continue;
    for (const person of filing.people) {
      const key = `${person.name.toLowerCase()}:${filing.issuer.cik}`;
      const existing = roster.get(key);

      const entry = existing || {
        name: person.name,
        roles: new Set(),
        offerings: [],
        issuer: filing.issuer,
      };

      for (const role of person.roles) entry.roles.add(role);
      if (person.roleNote) entry.roleNote = person.roleNote;
      entry.offerings.push({
        accession: filing.accession,
        totalOfferingAmount: filing.raised.totalOfferingAmount,
        totalAmountSold: filing.raised.totalAmountSold,
        investorCount: filing.raised.investorCount,
        industry: filing.raised.industry,
        dateOfFirstSale: filing.raised.dateOfFirstSale,
      });

      roster.set(key, entry);
    }
  }

  return [...roster.values()].map((entry) => ({
    ...entry,
    roles: [...entry.roles],
    // The largest raise this person is named on. NOT their wealth, and labelled so at
    // every layer: it is money the COMPANY raised, and Form D never states what share
    // of the company any related person holds.
    largestOfferingAmount: entry.offerings.reduce(
      (max, o) => Math.max(max, o.totalAmountSold ?? o.totalOfferingAmount ?? 0),
      0,
    ),
  }));
}
