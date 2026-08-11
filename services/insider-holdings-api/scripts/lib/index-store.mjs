/**
 * The served index: positions grouped by person, and issuers placed on the map.
 *
 * Built offline by scripts/build-index.mjs and loaded here as a single JSON file, so
 * a request never waits on the SEC. The whole index for one quarter is roughly 30 MB
 * of JSON and sits in memory; there is no database, matching the rest of this fleet.
 */

import fs from "node:fs";
import path from "node:path";

import { describeDistance, haversineMi, resolveZip } from "./geo.mjs";
import { stripOwnerAddress } from "./disclosure.mjs";

/** @type {{people: Map<string, object>, issuers: Map<string, object>, meta: object}|null} */
let store = null;

export function loadIndex(dataDir) {
  if (store) return store;

  const file = path.join(dataDir, "index.json");
  if (!fs.existsSync(file)) {
    store = { people: new Map(), issuers: new Map(), meta: { built: false } };
    return store;
  }

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  store = {
    people: new Map(raw.people.map((person) => [person.cik, person])),
    issuers: new Map(raw.issuers.map((issuer) => [issuer.cik, issuer])),
    meta: raw.meta || { built: true },
  };
  return store;
}

export function resetIndex() {
  store = null;
}

/** Replace the in-memory index directly. Used by tests to avoid touching disk. */
export function setIndex(next) {
  store = next;
}

export function indexMeta(dataDir) {
  const loaded = loadIndex(dataDir);
  const builtAt = loaded.meta?.builtAt || null;
  const ageDays = builtAt
    ? Math.round(((Date.now() - Date.parse(builtAt)) / 86400000) * 10) / 10
    : null;

  return {
    ...loaded.meta,
    people: loaded.people.size,
    issuers: loaded.issuers.size,
    ageDays,
  };
}

/** One person's record, with every position and the total of the priced ones. */
export function getPerson(cik, dataDir) {
  const loaded = loadIndex(dataDir);
  const person = loaded.people.get(String(cik).replace(/^0+/, ""));
  if (!person) return null;

  const positions = person.positions.map((position) => ({
    ...position,
    issuer: summariseIssuer(loaded.issuers.get(position.issuerCik)),
  }));

  return stripOwnerAddress({
    cik: person.cik,
    name: person.name,
    roles: person.roles,
    titles: person.titles,
    issuerCount: positions.length,
    disclosedValue: person.disclosedValue,
    // The same holdings at current market prices. Differs from disclosedValue by
    // however much the stocks moved since each filing, and covers more positions,
    // because a security can be priced even when the person's own filing carried no
    // price at all (a Form 3 holding reports shares with no transaction).
    marketValue: person.marketValue ?? null,
    // Named so nobody reads it as a total: some positions carry no disclosed price.
    positionsValued: person.positionsValued,
    positionsUnvalued: positions.length - person.positionsValued,
    positions,
    reportUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${person.cik}&type=4`,
  });
}

export function getIssuer(cik, dataDir) {
  const loaded = loadIndex(dataDir);
  const issuer = loaded.issuers.get(String(cik).replace(/^0+/, ""));
  return issuer ? stripOwnerAddress({ ...issuer }) : null;
}

/**
 * The company's public contact details.
 *
 * This is a switchboard and a headquarters — the number and address the company itself
 * filed with EDGAR for the public to use. It is the only contact route this service
 * will ever carry.
 *
 * There is no personal contact information here and there never will be: the SEC does
 * not publish an insider's phone, email or home address, and reaching a named person
 * privately is not what a disclosure filing is for. To contact someone, you call their
 * employer's published number like anyone else would.
 */
function summariseIssuer(issuer) {
  if (!issuer) return null;
  return {
    cik: issuer.cik,
    name: issuer.name,
    tickers: issuer.tickers,
    exchanges: issuer.exchanges || [],
    industry: issuer.sicDescription || null,
    city: issuer.address?.city || null,
    state: issuer.address?.state || null,
    phone: issuer.phone || null,
    reportUrl: issuer.reportUrl || null,
  };
}

/**
 * The value a position is ranked and compared by.
 *
 * The market value when the security could be priced, the filed value otherwise, and
 * -1 when neither exists so an unpriced position sorts below a priced one of any size
 * rather than above a zero.
 */
const rankValue = (position) => position?.marketValue ?? position?.value ?? -1;

/**
 * Rank insiders near a point.
 *
 * The unit of ranking is a PERSON's single largest disclosed position within range,
 * not a sum across companies. Two reasons. A sum would silently mix positions filed
 * on different dates at different prices into one number that was never true at any
 * moment. And a person's companies can sit in different cities, so summing them would
 * attribute value to a location where it isn't.
 */
export function searchNearby({ lat, lng, radiusMi, limit, offset = 0, minValue = 0 }, dataDir) {
  const loaded = loadIndex(dataDir);

  // Which issuers fall inside the radius? Everything hangs off this.
  const nearby = new Map();
  for (const issuer of loaded.issuers.values()) {
    if (issuer.lat == null || issuer.lng == null) continue;
    const miles = haversineMi(lat, lng, issuer.lat, issuer.lng);
    if (miles <= radiusMi) nearby.set(issuer.cik, { issuer, miles });
  }

  const rows = [];
  for (const person of loaded.people.values()) {
    let best = null;
    for (const position of person.positions) {
      const hit = nearby.get(position.issuerCik);
      if (!hit) continue;
      /**
       * Rank on the MARKET value, not the filed one.
       *
       * Both are carried on every row, but the comparison has to use one of them and
       * the filed price is whatever the stock happened to trade at on the day that
       * person last filed. Ranking by it orders people partly by how recently they
       * traded. `marketValue` prices everyone in a stock identically, so the order
       * reflects position size rather than filing date. It falls back to the filed
       * value when no market price exists for the security.
       */
      const value = rankValue(position);
      if (!best || value > rankValue(best.position)) best = { position, ...hit };
    }
    if (!best) continue;
    if (Math.max(rankValue(best.position), 0) < minValue) continue;

    rows.push({
      cik: person.cik,
      name: person.name,
      roles: person.roles,
      title: best.position.title || null,
      position: {
        issuerCik: best.position.issuerCik,
        issuerName: best.position.issuerName,
        ticker: best.position.ticker,
        security: best.position.security,
        // "direct" holds the shares; "derivative" holds options/RSUs over them, valued
        // at intrinsic worth. Surfaced so a UI can label the two differently rather
        // than implying an option holder owns the stock.
        kind: best.position.kind || "direct",
        shares: best.position.shares,
        pricePerShare: best.position.pricePerShare,
        strikePrice: best.position.strikePrice ?? null,
        // As the filer disclosed it: their shares at the price on their own filing.
        disclosedValue: best.position.value,
        /**
         * The same shares at the security's most recent market price.
         *
         * This is what the ranking uses and what a net-worth reading should quote.
         * `marketPriceAsOf` is the day that price was struck, which is the real age of
         * this number — the SEC publishes quarterly, so it trails the current quarter.
         */
        marketValue: best.position.marketValue ?? null,
        marketPrice: best.position.marketPrice ?? null,
        marketPriceAsOf: best.position.marketPriceAsOf ?? null,
        marketPriceBasis: best.position.marketPriceBasis ?? null,
        // Set only when a market price replaced the filed one, so the move is visible.
        repricedFrom: best.position.repricedFrom ?? null,
        // A move beyond 3x is more likely a share split than a real move. See prices.mjs.
        priceMovedSuspiciously: best.position.priceMovedSuspiciously ?? false,
        asOf: best.position.asOf,
        formType: best.position.formType,
      },
      issuer: {
        ...summariseIssuer(best.issuer),
        // The full street line is carried on a search row (the summary omits it) so a
        // result card can show a complete company address without a second call.
        street1: best.issuer.address?.street1 || null,
        street2: best.issuer.address?.street2 || null,
        zip: best.issuer.address?.zip || null,
      },
      ...describeDistance(best.miles, best.issuer.geoTier),
      otherIssuersInRange: person.positions.filter((p) => nearby.has(p.issuerCik)).length,
      profileUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${person.cik}&type=4`,
    });
  }

  // Priced positions first, largest first; unpriced fall to the end by distance so they
  // are still reachable rather than silently dropped.
  rows.sort((a, b) => {
    const av = a.position.marketValue ?? a.position.disclosedValue;
    const bv = b.position.marketValue ?? b.position.disclosedValue;
    if (av == null && bv == null) return a.distanceMiles - b.distanceMiles;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  return {
    total: rows.length,
    issuersInRange: nearby.size,
    rows: rows.slice(offset, offset + limit).map(stripOwnerAddress),
  };
}

export { resolveZip };
