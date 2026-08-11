/**
 * SEC Form ADV Schedule A/B — who owns and controls investment advisers.
 *
 * The largest clean population available to this service: roughly 154,000 distinct
 * named individuals across registered advisers and exempt reporting advisers. Schedule A
 * lists direct owners and executive officers; Schedule B lists indirect owners.
 *
 * Two things make it unusually valuable here:
 *
 *   1. `OwnerID` IS the individual's CRD number, so these records join directly to
 *      IAPD and to this repo's ria-identity-api. No other source in this service
 *      supplies a person-level regulator identifier.
 *
 *   2. It reports CONTROL, not just economic size — `Control Person` marks whoever
 *      actually directs the firm, which a percentage alone does not tell you.
 *
 * No address of any kind appears in Schedule A/B, so unlike every other source here
 * there is nothing to strip. Records carry no coordinates and are not distance-ranked.
 *
 * ── Ownership is a BAND, and one code is genuinely ambiguous ──────────────────────
 *
 * The current form legend defines: NA <5%, A 5-10%, B 10-25%, C 25-50%, D 50-75%,
 * E 75%+. The bulk archive spans 2011-2024 and also contains code F on ~202,000 rows,
 * which that legend does not define at all — older Form ADV and Form BD used a scale
 * where E was 50-75% and F was 75%+.
 *
 * So F is reported as ambiguous rather than guessed. Silently mapping it to 75%+ would
 * be a one-band error on 200,000 records, and mapping it to E's current meaning would
 * be a different one-band error. Neither is worth inventing.
 */

/** Ownership code -> percentage band, per the CURRENT Form ADV legend. */
export const OWNERSHIP_BANDS = Object.freeze({
  NA: { min: 0, max: 5, label: "under 5%" },
  A: { min: 5, max: 10, label: "5-10%" },
  B: { min: 10, max: 25, label: "10-25%" },
  C: { min: 25, max: 50, label: "25-50%" },
  D: { min: 50, max: 75, label: "50-75%" },
  E: { min: 75, max: 100, label: "75% or more" },
});

/**
 * Describe an ownership code.
 *
 * Returns `ambiguous: true` for F rather than a band, because its meaning depends on
 * which vintage of the form the row came from and the archive contains both.
 */
export function describeOwnership(code) {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return null;

  const band = OWNERSHIP_BANDS[raw];
  if (band) return { code: raw, ...band, ambiguous: false };

  if (raw === "F") {
    return {
      code: "F",
      min: null,
      max: null,
      label: "75% or more on the older form scale; not defined on the current one",
      ambiguous: true,
    };
  }

  return { code: raw, min: null, max: null, label: "unrecognised code", ambiguous: true };
}

/**
 * Parse one CSV line, honouring quoted fields.
 *
 * Legal names in this file contain commas — "SMITH, JOHN, JR" — so splitting on commas
 * silently shifts every later column, which would attach one person's ownership code to
 * the next person's row.
 */
export function parseCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { out.push(field); field = ""; }
    else field += char;
  }
  out.push(field);
  return out.map((value) => value.trim());
}

/** `DE/FE/I` is `I` for a natural person; DE and FE are domestic and foreign entities. */
export const isIndividual = (row) => String(row["DE/FE/I"] || "").trim().toUpperCase() === "I";

const yes = (value) => /^y(es)?$/i.test(String(value || "").trim());

/**
 * Turn a CSV row into an owner record, or null when it is not an indexable person.
 *
 * A row with no OwnerID is kept only if it has a name — some older filings omit the CRD
 * — but it cannot be joined to IAPD, and `crd: null` says so rather than inventing one.
 */
export function parseOwnerRow(row) {
  if (!row || !isIndividual(row)) return null;

  const name = String(row["Full Legal Name"] || "").trim();
  if (!name) return null;

  const crd = String(row.OwnerID || "").trim().replace(/^0+/, "") || null;

  return {
    // The individual's CRD. This is the join key to IAPD and to ria-identity-api.
    crd,
    name,
    filingId: String(row.FilingID || "").trim() || null,
    // Free text: "MANAGING MEMBER & CHIEF COMPLIANCE OFFICER".
    title: String(row["Title or Status"] || "").trim() || null,
    acquired: String(row["Status Acquired"] || "").trim() || null,
    schedule: String(row.Schedule || "").trim().toUpperCase() || null,
    ownership: describeOwnership(row["Ownership Code"]),
    // Whoever actually directs the firm. Distinct from size: a 5% holder can control it
    // and a 30% holder may not.
    isControlPerson: yes(row["Control Person"]),
    isPubliclyReporting: yes(row.PR),
    entityInWhich: String(row["Entity in Which"] || "").trim() || null,
  };
}

/**
 * Fold rows into one record per person.
 *
 * Keyed on CRD when present, name otherwise. The archive spans 2011-2024 and the same
 * person appears once per filing, so a firm that filed twelve times contributes twelve
 * identical rows — deduped on filing id within a person.
 */
/**
 * How many per-filing positions to keep on each person.
 *
 * The archive spans thirteen years, and an owner of many advisers accumulates a
 * position row per firm per filing — Milton Berlinski is a control person at 2,546.
 * Keeping every one produced a 485 MB index that will not load in the service's 2 GiB
 * container, for detail no caller needs: the summary fields answer "how much" and "how
 * many", and the sample answers "what does one look like".
 *
 * `filingCount` and `controlPersonAt` are always the TRUE totals, computed before the
 * cap, so trimming the sample never changes a reported number.
 */
export const MAX_POSITIONS_KEPT = 3;

export function buildOwners(rows) {
  const byPerson = new Map();

  for (const row of rows) {
    const parsed = parseOwnerRow(row);
    if (!parsed) continue;

    const key = parsed.crd ? `crd:${parsed.crd}` : `name:${parsed.name.toLowerCase()}`;
    const entry = byPerson.get(key) || {
      crd: parsed.crd,
      name: parsed.name,
      titles: new Set(),
      positions: new Map(),
      controlOf: 0,
    };

    if (parsed.title) entry.titles.add(parsed.title);
    if (parsed.isControlPerson) entry.controlOf += 1;

    // One position per filing; a later filing for the same id replaces the earlier.
    if (parsed.filingId) {
      entry.positions.set(parsed.filingId, {
        filingId: parsed.filingId,
        schedule: parsed.schedule,
        ownership: parsed.ownership,
        isControlPerson: parsed.isControlPerson,
        title: parsed.title,
        acquired: parsed.acquired,
      });
    }

    byPerson.set(key, entry);
  }

  return [...byPerson.values()].map((entry) => {
    const positions = [...entry.positions.values()];
    /**
     * The strongest band this person holds anywhere, by lower bound.
     *
     * Ambiguous F rows are excluded from the maximum rather than treated as 75%+, so an
     * undefined code can never inflate someone's apparent stake.
     */
    const ranked = positions
      .map((p) => p.ownership)
      .filter((o) => o && !o.ambiguous && o.min != null)
      .sort((a, b) => b.min - a.min);

    return {
      crd: entry.crd,
      name: entry.name,
      // A prolific owner accumulates hundreds of distinct titles too; the cap keeps a
      // record readable without changing any count.
      titles: [...entry.titles].slice(0, MAX_POSITIONS_KEPT),
      // TRUE totals, computed over every position before the sample is trimmed.
      filingCount: positions.length,
      controlPersonAt: entry.controlOf,
      largestOwnership: ranked[0] || null,
      hasAmbiguousCode: positions.some((p) => p.ownership?.ambiguous),
      positionsSampled: Math.min(positions.length, MAX_POSITIONS_KEPT),
      positions: positions.slice(0, MAX_POSITIONS_KEPT),
    };
  });
}
