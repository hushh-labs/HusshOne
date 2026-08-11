/**
 * Serving layer for the Form ADV Schedule A/B owner roster.
 *
 * Search by name, CRD, ownership band and control status. There is no geography here
 * at all — Schedule A/B carries no address of any kind, which is why this is the one
 * source in the service with nothing to strip.
 */

import fs from "node:fs";
import path from "node:path";

let store = null;
let byCrd = null;

export function loadAdv(dataDir) {
  if (store) return store;

  const file = path.join(dataDir, "adv-owners.json");
  if (!fs.existsSync(file)) {
    store = { people: [], meta: { built: false } };
    byCrd = new Map();
    return store;
  }

  store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.meta = { ...store.meta, built: true };
  byCrd = new Map();
  for (const person of store.people) {
    if (person.crd) byCrd.set(String(person.crd), person);
  }
  return store;
}

export function resetAdv() {
  store = null;
  byCrd = null;
}

export function setAdv(next) {
  store = next;
  byCrd = new Map();
  for (const person of next.people || []) {
    if (person.crd) byCrd.set(String(person.crd), person);
  }
}

export function advMeta(dataDir) {
  const loaded = loadAdv(dataDir);
  return { ...loaded.meta, people: loaded.people.length };
}

/**
 * One owner by CRD.
 *
 * The CRD is the same identifier IAPD and this repo's ria-identity-api use, so this is
 * a direct join rather than a name match.
 */
export function advOwnerByCrd(crd, dataDir) {
  loadAdv(dataDir);
  return byCrd?.get(String(crd).replace(/^0+/, "")) || null;
}

const normalise = (value) => String(value || "").trim().toLowerCase();

export function searchAdvOwners({ name, crd, minOwnership, controlOnly, limit = 25, offset = 0 }, dataDir) {
  const loaded = loadAdv(dataDir);

  if (crd) {
    const one = advOwnerByCrd(crd, dataDir);
    return { total: one ? 1 : 0, rows: one ? [one] : [] };
  }

  const wantedName = normalise(name);
  if (!wantedName && !controlOnly && minOwnership == null) {
    return { total: 0, rows: [], error: "Provide name, crd, minOwnership or controlOnly." };
  }

  const matches = loaded.people.filter((person) => {
    if (wantedName && !normalise(person.name).includes(wantedName)) return false;
    if (controlOnly && !person.controlPersonAt) return false;
    // Compares the band's LOWER bound: "at least this much". An ambiguous F has no
    // largestOwnership at all, so it is excluded from a threshold rather than assumed.
    if (minOwnership != null && (person.largestOwnership?.min ?? -1) < minOwnership) return false;
    return true;
  });

  matches.sort((a, b) => {
    const byBand = (b.largestOwnership?.min ?? -1) - (a.largestOwnership?.min ?? -1);
    return byBand !== 0 ? byBand : b.controlPersonAt - a.controlPersonAt;
  });

  return {
    total: matches.length,
    rows: matches.slice(offset, offset + limit),
  };
}
