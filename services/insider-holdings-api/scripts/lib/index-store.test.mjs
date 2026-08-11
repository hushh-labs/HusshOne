import assert from "node:assert/strict";
import test from "node:test";

import { getPerson, resetIndex, searchNearby, setIndex } from "./index-store.mjs";

/**
 * Two issuers in San Francisco, one in New York, and three filers — including one
 * whose only priced position is small and one with no price at all.
 */
function seed() {
  const issuers = new Map([
    ["320193", { cik: "320193", name: "Apple Inc.", tickers: ["AAPL"], address: { city: "SF", state: "CA", street1: "1 WAY", zip: "94105" }, lat: 37.789, lng: -122.396 }],
    ["789019", { cik: "789019", name: "Msft", tickers: ["MSFT"], address: { city: "SF", state: "CA", street1: "2 WAY", zip: "94105" }, lat: 37.79, lng: -122.4 }],
    ["111111", { cik: "111111", name: "Far Co", tickers: ["FAR"], address: { city: "NY", state: "NY", street1: "3 AVE", zip: "10001" }, lat: 40.75, lng: -73.997 }],
  ]);

  const people = new Map([
    ["1", { cik: "1", name: "BIG HOLDER", roles: ["Officer"], titles: ["CEO"], disclosedValue: 500, positionsValued: 1,
      positions: [{ issuerCik: "320193", issuerName: "Apple Inc.", ticker: "AAPL", security: "Common Stock", shares: 5, pricePerShare: 100, value: 500, asOf: "2026-06-30", formType: "4", title: "CEO" }] }],
    ["2", { cik: "2", name: "SMALL HOLDER", roles: ["Director"], titles: [], disclosedValue: 10, positionsValued: 1,
      positions: [{ issuerCik: "789019", issuerName: "Msft", ticker: "MSFT", security: "Common Stock", shares: 1, pricePerShare: 10, value: 10, asOf: "2026-06-30", formType: "4", title: null }] }],
    ["3", { cik: "3", name: "UNPRICED HOLDER", roles: ["Director"], titles: [], disclosedValue: 0, positionsValued: 0,
      positions: [{ issuerCik: "320193", issuerName: "Apple Inc.", ticker: "AAPL", security: "Common Stock", shares: 999, pricePerShare: null, value: null, asOf: "2026-06-30", formType: "3", title: null }] }],
    ["4", { cik: "4", name: "FAR AWAY", roles: ["Officer"], titles: [], disclosedValue: 9999, positionsValued: 1,
      positions: [{ issuerCik: "111111", issuerName: "Far Co", ticker: "FAR", security: "Common Stock", shares: 1, pricePerShare: 9999, value: 9999, asOf: "2026-06-30", formType: "4", title: null }] }],
  ]);

  setIndex({ people, issuers, meta: { built: true, builtAt: new Date().toISOString() } });
}

const SF = { lat: 37.789, lng: -122.396, radiusMi: 25, limit: 10 };

test("only insiders at issuers inside the radius are returned", () => {
  seed();
  const result = searchNearby(SF, ".");
  const names = result.rows.map((row) => row.name);
  assert.ok(names.includes("BIG HOLDER"));
  assert.ok(names.includes("SMALL HOLDER"));
  assert.equal(names.includes("FAR AWAY"), false, "New York issuer is 2,500 miles away");
  assert.equal(result.issuersInRange, 2);
});

test("ranking is by disclosed value, largest first", () => {
  seed();
  const rows = searchNearby(SF, ".").rows;
  assert.equal(rows[0].name, "BIG HOLDER");
  assert.equal(rows[0].position.disclosedValue, 500);
});

test("unpriced positions sort last but are not dropped", () => {
  seed();
  const rows = searchNearby(SF, ".").rows;
  assert.equal(rows.at(-1).name, "UNPRICED HOLDER");
  assert.equal(rows.at(-1).position.disclosedValue, null);
  assert.equal(rows.at(-1).position.shares, 999, "the share count is still disclosed");
});

test("minValue filters out smaller positions", () => {
  seed();
  const rows = searchNearby({ ...SF, minValue: 100 }, ".").rows;
  assert.deepEqual(rows.map((row) => row.name), ["BIG HOLDER"]);
});

test("offset pages without reordering", () => {
  seed();
  const all = searchNearby(SF, ".").rows;
  const page2 = searchNearby({ ...SF, limit: 1, offset: 1 }, ".").rows;
  assert.equal(page2.length, 1);
  assert.equal(page2[0].name, all[1].name);
});

test("no response carries an owner address field", () => {
  seed();
  const serialised = JSON.stringify(searchNearby(SF, "."));
  for (const field of ["RPTOWNER_STREET1", "ownerCity", "homeAddress", "residentialAddress"]) {
    assert.equal(serialised.includes(field), false, `${field} leaked into a search response`);
  }
});

test("a person record separates valued from unvalued positions", () => {
  seed();
  const person = getPerson("3", ".");
  assert.equal(person.name, "UNPRICED HOLDER");
  assert.equal(person.positionsValued, 0);
  assert.equal(person.positionsUnvalued, 1);
});

test("an unknown CIK is null, not a throw", () => {
  seed();
  assert.equal(getPerson("99999", "."), null);
  resetIndex();
});
