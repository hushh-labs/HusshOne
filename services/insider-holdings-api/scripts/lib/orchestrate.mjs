/**
 * The layer that turns several disclosure sources into one coherent answer.
 *
 * Two jobs, both of which only make sense above the individual sources:
 *
 *  1. COLLAPSE CO-FILED POSITIONS. A single economic holding is frequently reported by
 *     a stack of related entities — one real group in the index has THIRTY-SEVEN filers
 *     all reporting the same 1,650,000 shares on the same date. Ranked naively that one
 *     position occupies 37 of the top rows and crowds out everyone else. Measured on the
 *     live index: 3,713 position groups are filed by more than one entity.
 *
 *  2. ROUTE BY WHAT EACH SOURCE CAN HONESTLY ANSWER. Section 16 people carry a public
 *     company address and can be ranked by distance. Form D founders cannot — their
 *     filed address is frequently a home — so they are reported alongside, by city,
 *     never distance-ranked. The orchestrator states that split rather than hiding it.
 */

/**
 * Merge rows that describe the same economic position.
 *
 * The key is issuer + share count + as-of date. Two unrelated people holding an
 * identical share count in the same company on the same day is possible for small round
 * numbers, so nothing is hidden when it happens: every filer is listed in `filers`, and
 * `filerCount` tells the caller a collapse occurred. Showing one position once with its
 * full filer list is accurate either way; showing it 37 times never is.
 */
export function collapseCoFiled(rows) {
  const groups = new Map();

  for (const row of rows) {
    const p = row.position;
    const key = `${p.issuerCik}:${p.shares}:${p.asOf}:${p.kind || "direct"}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, { ...row, filers: [{ cik: row.cik, name: row.name, roles: row.roles, title: row.title }] });
      continue;
    }

    existing.filers.push({ cik: row.cik, name: row.name, roles: row.roles, title: row.title });

    // Prefer a natural person as the row's headline name. A fund stack usually lists
    // its LLCs and LPs first, and "Lightspeed SPV II, LLC" is a less useful label than
    // the human being who also signed the same filing.
    if (looksLikeEntity(existing.name) && !looksLikeEntity(row.name)) {
      existing.cik = row.cik;
      existing.name = row.name;
      existing.roles = row.roles;
      existing.title = row.title;
    }
  }

  return [...groups.values()].map((row) => ({
    ...row,
    filerCount: row.filers.length,
    // Dedupe the filer list itself: the same entity can appear on several filings for
    // one position, which is how "37 filers" contained repeated names.
    filers: dedupeFilers(row.filers),
  }));
}

const ENTITY_MARKERS = /\b(LLC|L\.L\.C|LP|L\.P|INC|CORP|LTD|GMBH|N\.V|B\.V|TRUST|FUND|PARTNERS|HOLDINGS?|CAPITAL|GROUP|MANAGEMENT|ADVISORS?|AG|PLC|CO)\b/i;

/** Is this filer an organisation rather than a person? Used only to pick a display name. */
export function looksLikeEntity(name) {
  return ENTITY_MARKERS.test(String(name || ""));
}

function dedupeFilers(filers) {
  const seen = new Map();
  for (const filer of filers) {
    if (!seen.has(filer.cik)) seen.set(filer.cik, filer);
  }
  return [...seen.values()];
}

/**
 * Aggregate view of the disclosed wealth around a point.
 *
 * Computed from COLLAPSED rows, so one position counts once however many entities filed
 * it. Summing the raw rows would have counted that 1,650,000-share holding 37 times.
 */
export function summarise(rows) {
  const byIssuer = new Map();
  let disclosedTotal = 0;
  let priced = 0;

  for (const row of rows) {
    const value = row.position.disclosedValue;
    if (value != null) {
      disclosedTotal += value;
      priced += 1;
    }
    const key = row.position.issuerCik;
    const seen = byIssuer.get(key) || { name: row.position.issuerName, people: 0, disclosed: 0 };
    seen.people += 1;
    seen.disclosed += value || 0;
    byIssuer.set(key, seen);
  }

  const employers = [...byIssuer.entries()]
    .map(([cik, v]) => ({ cik, ...v }))
    .sort((a, b) => b.disclosed - a.disclosed)
    .slice(0, 5);

  return {
    people: rows.length,
    companies: byIssuer.size,
    positionsPriced: priced,
    positionsUnpriced: rows.length - priced,
    // Named to resist being read as "the wealth of this area": it is the sum of the
    // single largest disclosed position of each person in range, nothing more.
    sumOfLargestDisclosedPositions: disclosedTotal,
    topEmployersByDisclosedValue: employers,
  };
}
