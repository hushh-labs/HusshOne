/**
 * SEC Form 144 — notice of a proposed sale of restricted or control securities.
 *
 * Everything else in this service reports what someone HOLDS. Form 144 reports what
 * they are about to SELL, with an exact dollar figure the filer supplied
 * (`aggregateMarketValue`). That is a liquidity signal and it is modelled as one.
 *
 * ── It is a flow, not a stock, and the difference matters ─────────────────────────
 *
 * A Form 144 is a NOTICE OF INTENT. The sale need not happen, and the same shares can
 * be noticed more than once. So this never adds to a holding, never sums with a
 * Section 16 position, and is exposed under names that say what it is —
 * `proposedSaleValue`, not `value`.
 *
 * ── The address rule, and a correction ────────────────────────────────────────────
 *
 * Published guidance describes Form 144 as carrying no filer address at all. That is
 * WRONG, and it was checked: `sellerDetails/address` exists and is seller-supplied. In
 * the filing verified here (Expensify, 0001892682-26-000021) it happens to be the
 * company's office at 88 Kearny St — but nothing in the form requires that, exactly as
 * with Form 3/4/5 where only 42% are explicitly "c/o".
 *
 * So the seller address is never read, and neither is the broker's. Location for these
 * people continues to come from the issuer, as everywhere else.
 *
 * The XML is namespaced (`own:`, `com:`), which is easy to miss — a naive
 * `<([a-zA-Z]+)>` scan returns nothing at all and looks like an empty document.
 */

/**
 * Read a value, accepting either XML shape EDGAR serves.
 *
 * Filing agents emit Form 144 two different ways and both are live in 2026/QTR2:
 *
 *   <own:edgarSubmission xmlns:own="…/ownership">   ->  <own:aggregateMarketValue>
 *   <edgarSubmission xmlns="…/ownership">           ->  <aggregateMarketValue>
 *
 * The second uses a DEFAULT namespace, so the ownership elements carry no prefix at
 * all. Hardcoding `own:` parsed the first shape and silently rejected the second —
 * measured at a 91% skip rate over the first 200 filings, which looked like a data
 * problem and was a parser bug. The prefix is therefore optional.
 */
const text = (xml, tag) => {
  const match = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return match ? match[1].trim() : null;
};

/** Multi-value read, same prefix tolerance. */
const all = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  let match;
  while ((match = re.exec(xml)) !== null) out.push(match[1].trim());
  return out;
};

/**
 * Parse a number, treating absent as absent.
 *
 * `Number("")` is `0`, so the obvious one-liner turns a MISSING sale value into a
 * filing worth zero dollars — the same failure that valued an 842-million-share SpaceX
 * position at nothing. An empty string is checked before conversion, not after.
 */
const number = (value) => {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Relationships we index — the same Section 16 roles used everywhere else. */
const KEPT_ROLES = Object.freeze(["Officer", "Director", "10% Owner", "10% Stockholder", "TenPercentOwner"]);

const normaliseRole = (role) => {
  const raw = String(role || "").trim();
  return /10\s*%/.test(raw) ? "TenPercentOwner" : raw;
};

/**
 * Parse one Form 144 `primary_doc.xml`.
 *
 * Returns null for a filing that names nobody indexable or carries no sale value, so a
 * caller can skip it without special-casing.
 */
export function parseForm144(xml, { accession = null } = {}) {
  if (!xml || !xml.includes("edgarSubmission")) return null;
  if (text(xml, "submissionType") !== "144") return null;

  const name = text(xml, "nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold");
  if (!name) return null;

  const roles = [...new Set(all(xml, "relationshipToIssuer").map(normaliseRole))]
    .filter((role) => KEPT_ROLES.includes(role) || role === "TenPercentOwner");
  if (roles.length === 0) return null;

  const issuerCik = String(text(xml, "issuerCik") || "").replace(/^0+/, "");
  if (!issuerCik) return null;

  // The filer CIK in headerData is the person's own CIK on most Form 144s, which is
  // what lets this join to the Section 16 index. It is an agent's CIK on some, so it is
  // reported as `filerCik` rather than asserted to be the person.
  const filerCik = String(text(xml, "cik") || "").replace(/^0+/, "") || null;

  const proposedSaleValue = number(text(xml, "aggregateMarketValue"));
  if (proposedSaleValue == null) return null;

  // NOTE: sellerDetails/address and brokerOrMarketmakerDetails/address are deliberately
  // not read. See the correction at the top of this file.
  return {
    accession,
    name,
    filerCik,
    roles,
    issuerCik,
    issuerName: text(xml, "issuerName"),
    securityClass: text(xml, "securitiesClassTitle"),
    unitsToBeSold: number(text(xml, "noOfUnitsSold")),
    unitsOutstanding: number(text(xml, "noOfUnitsOutstanding")),
    // Exact dollars, supplied by the filer. A PROPOSED sale, not a completed one.
    proposedSaleValue,
    approxSaleDate: text(xml, "approxSaleDate"),
    exchange: text(xml, "securitiesExchangeName"),
    filingUrl: filerCik
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${filerCik}&type=144`
      : null,
  };
}

/**
 * Fold notices into a per-person liquidity record.
 *
 * Keyed on filer CIK when present and on lowercased name plus issuer otherwise, because
 * a Form 144 filed through an agent carries the agent's CIK and would otherwise merge
 * unrelated people who share a filing agent.
 */
export function buildLiquidity(notices) {
  const byPerson = new Map();

  for (const notice of notices) {
    if (!notice) continue;
    const key = notice.filerCik
      ? `cik:${notice.filerCik}`
      : `name:${notice.name.toLowerCase()}:${notice.issuerCik}`;

    const entry = byPerson.get(key) || {
      name: notice.name,
      filerCik: notice.filerCik,
      roles: new Set(),
      notices: [],
    };

    for (const role of notice.roles) entry.roles.add(role);
    entry.notices.push({
      accession: notice.accession,
      issuerCik: notice.issuerCik,
      issuerName: notice.issuerName,
      securityClass: notice.securityClass,
      unitsToBeSold: notice.unitsToBeSold,
      proposedSaleValue: notice.proposedSaleValue,
      approxSaleDate: notice.approxSaleDate,
      exchange: notice.exchange,
    });

    byPerson.set(key, entry);
  }

  return [...byPerson.values()].map((entry) => ({
    ...entry,
    roles: [...entry.roles],
    noticeCount: entry.notices.length,
    /**
     * The LARGEST single notice, not a sum.
     *
     * Summing would double-count: the same shares can be noticed repeatedly, and a
     * notice is an intention rather than a completed sale. The largest single figure is
     * the only honest one-number summary of "how much has this person signalled they
     * may sell at once".
     */
    largestProposedSale: entry.notices.reduce((max, n) => Math.max(max, n.proposedSaleValue || 0), 0),
  }));
}
