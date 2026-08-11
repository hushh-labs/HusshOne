/**
 * Serving layer for the Florida Form 6 net-worth roster.
 *
 * Name, county and office search. No geography beyond the county a person is elected to
 * serve, and no coordinates: the underlying PDFs carry home addresses, and this service
 * reads only the net-worth figure out of them.
 */

import fs from "node:fs";
import path from "node:path";

let store = null;

export function loadFlorida(dataDir) {
  if (store) return store;
  const file = path.join(dataDir, "florida-net-worth.json");
  if (!fs.existsSync(file)) {
    store = { people: [], meta: { built: false } };
    return store;
  }
  store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.meta = { ...store.meta, built: true };
  return store;
}

export function resetFlorida() {
  store = null;
}

export function setFlorida(next) {
  store = next;
}

export function floridaMeta(dataDir) {
  const loaded = loadFlorida(dataDir);
  return { ...loaded.meta, people: loaded.people.length };
}

const normalise = (value) => String(value || "").trim().toLowerCase();

/**
 * Search by name, county or office, ranked by sworn net worth.
 *
 * Unlike the Form D roster this permits a bare listing, because a ranked table of
 * officials by declared net worth is the point of the source — Florida publishes these
 * precisely so the public can read them, and no address is involved.
 */
export function searchFlorida({ name, county, office, minNetWorth = 0, limit = 25, offset = 0 }, dataDir) {
  const loaded = loadFlorida(dataDir);
  const wantedName = normalise(name);
  const wantedCounty = normalise(county);
  const wantedOffice = normalise(office);

  const matches = loaded.people.filter((person) => {
    if (wantedName && !normalise(person.name).includes(wantedName)) return false;
    if (wantedCounty && !normalise(person.county).includes(wantedCounty)) return false;
    if (wantedOffice && !(person.offices || []).some((o) => normalise(o).includes(wantedOffice))) return false;
    // A negative net worth is real and must survive a zero floor, so the filter is only
    // applied when the caller actually asked for one.
    if (minNetWorth && (person.netWorth ?? 0) < minNetWorth) return false;
    return true;
  });

  return {
    total: matches.length,
    rows: matches.slice(offset, offset + limit).map((person) => ({
      name: person.name,
      prefix: person.prefix,
      offices: person.offices,
      county: person.county,
      formYear: person.formYear,
      netWorth: person.netWorth,
      filingUrl: person.filingUrl,
    })),
  };
}
