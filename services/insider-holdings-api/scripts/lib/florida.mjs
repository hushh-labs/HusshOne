/**
 * Florida Form 6 — the only sworn, exact NET WORTH published anywhere in the US.
 *
 * Article II §8(j)(1) of the Florida Constitution requires certain officials to file
 * "a sworn statement showing net worth and identifying each asset and liability in
 * excess of $1,000 and its value". Not a band, not an estimate, not a model — a figure
 * the filer swore to. Verified on a real filing: $1,730,712.88.
 *
 * ── The extraction rule, and why it is this narrow ────────────────────────────────
 *
 * The Form 6 PDF is far more than a net-worth figure. Its instructions require real
 * property to be identified "by providing the street address of the property", and a
 * filer's residence is an asset over $1,000, so home addresses are printed in these
 * documents next to their value. Some filers also attach their entire federal tax
 * return.
 *
 * So this parser is an ALLOWLIST OF ONE. It reads the net-worth figure and nothing
 * else. It never returns the asset schedule, the liability schedule, the income
 * schedule, or any free text — not because those are hard to parse, but because they
 * are exactly what must not be republished.
 *
 * Identity comes from the roster API instead (name, office, county), which carries no
 * financial detail and no address. The two are joined on the filing id.
 */

/**
 * Pull the sworn net worth out of Form 6 PDF text.
 *
 * The figure appears as "Net Worth as of December 31, 2025 was $ 1,730,712.88", with
 * line breaks and spacing that vary by filing, so the date portion is skipped rather
 * than matched. Returns null when no figure is found — a scanned filing has no text
 * layer at all, and a null must never be mistaken for a net worth of zero.
 */
export function extractNetWorth(text) {
  const raw = String(text || "");
  if (!raw) return null;

  // "Net Worth as of <date> was $ 1,730,712.88" — allow up to 120 chars of date and
  // whitespace between the label and the amount, but require both anchors.
  const match = /net\s*worth\s*as\s*of[\s\S]{0,120}?\$\s*([\d,]+(?:\.\d{2})?)/i.exec(raw);
  if (!match) return null;

  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;

  /**
   * A net worth may legitimately be negative or zero, and Form 6 prints a negative as
   * "($ 12,345.00)". The regex above cannot see the parenthesis, so check the text
   * immediately before the dollar sign rather than assuming every figure is positive.
   */
  const before = raw.slice(Math.max(0, match.index), match.index + match[0].length);
  const negative = /\(\s*\$?\s*[\d,]/.test(before) || /-\s*\$\s*[\d,]/.test(before);

  return negative ? -value : value;
}

/**
 * Build a filer record.
 *
 * Everything identifying comes from `roster` — the API response, which has no address
 * and no financial detail. `netWorth` is the single number lifted from the PDF. There is
 * deliberately no parameter for the PDF's other contents.
 */
export function buildFiler(roster, netWorth) {
  if (!roster || netWorth == null) return null;

  /**
   * The two Florida roster endpoints describe the same person with different field
   * names, and reading only one shape silently yields a record with no office at all —
   * which is this source's entire geographic anchor.
   *
   *   SearchPublicFilings  ->  delimitedOrganizationNames (a string), countyName
   *   SearchPublicFilers   ->  fullOrganizations (objects),           countyOfResidence
   *
   * Both are accepted rather than pinning to whichever endpoint the builder happens to
   * call today.
   */
  const offices = [
    ...(roster.fullOrganizations || []).map((o) => o.fullOrganizationName || o.organizationName),
    ...String(roster.delimitedOrganizationNames || "").split(/\s*[;|]\s*/),
  ]
    .map((office) => String(office || "").trim())
    .filter(Boolean);

  return {
    filingId: roster.filingId ?? roster.pid ?? null,
    name: roster.fullName || [roster.firstName, roster.middleName, roster.lastName].filter(Boolean).join(" "),
    prefix: roster.prefix || null,
    // The public office the person holds. This IS their public location — a county
    // commissioner's jurisdiction is a matter of record — and it is the only geography
    // this source contributes. No street, no postcode, no coordinates.
    offices: [...new Set(offices)],
    county: roster.countyName || roster.countyOfResidence || null,
    formYear: roster.formYear ?? null,
    netWorth,
    source: "Florida Form 6 (Art. II §8(j)(1), Fla. Const.) — sworn statement of net worth",
    filingUrl: roster.filingId
      ? `https://disclosure.floridaethics.gov/api/Report/RenderPdf/${roster.filingId}/False`
      : null,
  };
}

/** Rank filers by sworn net worth, largest first. */
export function rankByNetWorth(filers) {
  return [...filers].filter(Boolean).sort((a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0));
}
