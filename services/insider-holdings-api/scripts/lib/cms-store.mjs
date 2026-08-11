/**
 * Serving layer for the CMS physician-ownership roster.
 *
 * Search by name, specialty, company and state, ranked by the exact dollar value of the
 * declared stake. City and state only — the source's street field is often a solo
 * practitioner's home, so it is never read.
 */

import fs from "node:fs";
import path from "node:path";

let store = null;

export function loadCms(dataDir) {
  if (store) return store;
  const file = path.join(dataDir, "physician-ownership.json");
  if (!fs.existsSync(file)) {
    store = { people: [], meta: { built: false } };
    return store;
  }
  store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.meta = { ...store.meta, built: true };
  return store;
}

export function resetCms() {
  store = null;
}

export function setCms(next) {
  store = next;
}

export function cmsMeta(dataDir) {
  const loaded = loadCms(dataDir);
  return { ...loaded.meta, people: loaded.people.length };
}

const normalise = (value) => String(value || "").trim().toLowerCase();

export function searchPhysicians({ name, specialty, company, state, minValue = 0, limit = 25, offset = 0 }, dataDir) {
  const loaded = loadCms(dataDir);
  const wantedName = normalise(name);
  const wantedSpecialty = normalise(specialty);
  const wantedCompany = normalise(company);
  const wantedState = normalise(state);

  const matches = loaded.people.filter((person) => {
    if (wantedName && !normalise(person.name).includes(wantedName)) return false;
    if (wantedState && normalise(person.state) !== wantedState) return false;
    if (wantedSpecialty && !(person.specialties || []).some((s) => normalise(s).includes(wantedSpecialty))) return false;
    if (wantedCompany && !person.interests.some((i) => normalise(i.inCompany).includes(wantedCompany))) return false;
    if (minValue && (person.totalDisclosedInterest || 0) < minValue) return false;
    return true;
  });

  matches.sort((a, b) => (b.totalDisclosedInterest || 0) - (a.totalDisclosedInterest || 0));

  return {
    total: matches.length,
    rows: matches.slice(offset, offset + limit).map((person) => ({
      name: person.name,
      npi: person.npi,
      primaryType: person.primaryType,
      specialties: person.specialties,
      city: person.city,
      state: person.state,
      interestCount: person.interestCount,
      totalDisclosedInterest: person.totalDisclosedInterest,
      interests: person.interests,
    })),
  };
}
