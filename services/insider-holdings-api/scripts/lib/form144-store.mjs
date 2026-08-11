/**
 * Serving layer for Form 144 liquidity notices.
 *
 * Two uses. On its own it answers "who has signalled they may sell, and how much".
 * Joined by CIK it enriches a Section 16 row from "holds $X" to "holds $X, and has
 * noticed an intent to sell up to $Y" — which is the question a holdings figure alone
 * cannot answer, because shares are not cash.
 */

import fs from "node:fs";
import path from "node:path";

let store = null;
let byCik = null;

export function loadForm144(dataDir) {
  if (store) return store;

  const file = path.join(dataDir, "form-144.json");
  if (!fs.existsSync(file)) {
    store = { people: [], meta: { built: false } };
    byCik = new Map();
    return store;
  }

  store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.meta = { ...store.meta, built: true };
  byCik = new Map();
  for (const person of store.people) {
    if (person.filerCik) byCik.set(String(person.filerCik), person);
  }
  return store;
}

export function resetForm144() {
  store = null;
  byCik = null;
}

export function setForm144(next) {
  store = next;
  byCik = new Map();
  for (const person of next.people || []) {
    if (person.filerCik) byCik.set(String(person.filerCik), person);
  }
}

export function form144Meta(dataDir) {
  const loaded = loadForm144(dataDir);
  return { ...loaded.meta, people: loaded.people.length };
}

/**
 * Liquidity signal for one CIK, or null.
 *
 * Deliberately compact — a search row wants the headline, not every notice. Named to
 * keep it distinct from a holding at the point of use.
 */
export function liquidityFor(cik, dataDir) {
  loadForm144(dataDir);
  const person = byCik?.get(String(cik).replace(/^0+/, ""));
  if (!person) return null;

  return {
    noticeCount: person.noticeCount,
    largestProposedSale: person.largestProposedSale,
    mostRecent: person.notices[person.notices.length - 1]?.approxSaleDate || null,
    note: "Proposed sale, not a completed one. Never added to the holding.",
  };
}

const normalise = (value) => String(value || "").trim().toLowerCase();

export function searchLiquidity({ name, issuer, minValue = 0, limit = 25, offset = 0 }, dataDir) {
  const loaded = loadForm144(dataDir);
  const wantedName = normalise(name);
  const wantedIssuer = normalise(issuer);

  const matches = loaded.people.filter((person) => {
    if (wantedName && !normalise(person.name).includes(wantedName)) return false;
    if (wantedIssuer && !person.notices.some((n) => normalise(n.issuerName).includes(wantedIssuer))) return false;
    if (minValue && (person.largestProposedSale || 0) < minValue) return false;
    return true;
  });

  matches.sort((a, b) => (b.largestProposedSale || 0) - (a.largestProposedSale || 0));

  return {
    total: matches.length,
    rows: matches.slice(offset, offset + limit).map((person) => ({
      name: person.name,
      filerCik: person.filerCik,
      roles: person.roles,
      noticeCount: person.noticeCount,
      largestProposedSale: person.largestProposedSale,
      notices: person.notices,
    })),
  };
}
