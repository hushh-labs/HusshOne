/**
 * Serving layer for the Form D roster.
 *
 * Deliberately offers name and company search only. There is no proximity search here
 * and there should never be one: Form D issuer addresses are frequently the founder's
 * home, so ranking these by distance would put residences on the map indirectly.
 */

import fs from "node:fs";
import path from "node:path";

let store = null;

export function loadFormD(dataDir) {
  if (store) return store;

  const file = path.join(dataDir, "form-d.json");
  if (!fs.existsSync(file)) {
    store = { people: [], meta: { built: false } };
    return store;
  }
  store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.meta = { ...store.meta, built: true };
  return store;
}

export function resetFormD() {
  store = null;
}

export function setFormD(next) {
  store = next;
}

export function formDMeta(dataDir) {
  const loaded = loadFormD(dataDir);
  return { ...loaded.meta, people: loaded.people.length };
}

const normalise = (value) => String(value || "").trim().toLowerCase();

/**
 * Search the roster by person name and/or company name.
 *
 * Substring matching on a lowercased haystack: Form D carries no personal identifier —
 * no CRD, no individual CIK — so a name is the only handle a caller can have, and an
 * exact-match requirement would fail on middle names and initials.
 */
export function searchFormD({ name, company, state, limit = 25, offset = 0 }, dataDir) {
  const loaded = loadFormD(dataDir);
  const wantedName = normalise(name);
  const wantedCompany = normalise(company);
  const wantedState = normalise(state);

  if (!wantedName && !wantedCompany) {
    return { total: 0, rows: [], error: "Provide name or company." };
  }

  const matches = loaded.people.filter((person) => {
    if (wantedName && !normalise(person.name).includes(wantedName)) return false;
    if (wantedCompany && !normalise(person.issuer?.name).includes(wantedCompany)) return false;
    if (wantedState && normalise(person.issuer?.state) !== wantedState) return false;
    return true;
  });

  // Largest raise first — the most substantial companies are the useful answer to
  // "who runs private companies that raised money here".
  matches.sort((a, b) => (b.largestOfferingAmount || 0) - (a.largestOfferingAmount || 0));

  return {
    total: matches.length,
    rows: matches.slice(offset, offset + limit).map((person) => ({
      name: person.name,
      roles: person.roles,
      roleNote: person.roleNote || null,
      company: {
        cik: person.issuer.cik,
        name: person.issuer.name,
        entityType: person.issuer.entityType,
        jurisdiction: person.issuer.jurisdiction,
        yearOfIncorporation: person.issuer.yearOfIncorporation,
        // City and state only. No street, no postcode, no coordinates — by design.
        city: person.issuer.city,
        state: person.issuer.state,
      },
      offerings: person.offerings,
      largestOfferingAmount: person.largestOfferingAmount,
      filingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${person.issuer.cik}&type=D`,
    })),
  };
}
