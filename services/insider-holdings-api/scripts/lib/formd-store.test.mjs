import assert from "node:assert/strict";
import test from "node:test";

import { resetFormD, searchFormD, setFormD } from "./formd-store.mjs";

function seed() {
  setFormD({
    meta: { built: true },
    people: [
      {
        name: "Edward Ellingsworth", roles: ["Director"], largestOfferingAmount: 1250000,
        offerings: [{ accession: "a1", totalAmountSold: 1250000 }],
        issuer: { cik: "2133962", name: "INANAM Holdings Fund 2026-A LLC", city: "LEAGUE CITY", state: "TX" },
      },
      {
        name: "Jane Founder", roles: ["Executive Officer"], largestOfferingAmount: 50000000,
        offerings: [{ accession: "a2", totalAmountSold: 50000000 }],
        issuer: { cik: "999", name: "Big Startup Inc", city: "SEATTLE", state: "WA" },
      },
      {
        name: "Edward Ellingsworth", roles: ["Promoter"], largestOfferingAmount: 400,
        offerings: [{ accession: "a3", totalAmountSold: 400 }],
        issuer: { cik: "888", name: "Other Co", city: "AUSTIN", state: "TX" },
      },
    ],
  });
}

test("name search is a substring match, since Form D has no personal ID", () => {
  seed();
  const found = searchFormD({ name: "ellingsworth" }, ".");
  assert.equal(found.total, 2, "same name at two companies must both return");
  assert.equal(found.rows[0].company.name, "INANAM Holdings Fund 2026-A LLC", "largest raise first");
});

test("company search works and can be combined with state", () => {
  seed();
  assert.equal(searchFormD({ company: "big startup" }, ".").total, 1);
  assert.equal(searchFormD({ name: "ellingsworth", state: "TX" }, ".").total, 2);
  assert.equal(searchFormD({ name: "ellingsworth", state: "WA" }, ".").total, 0);
});

test("a bare search is refused rather than dumping the roster", () => {
  seed();
  const result = searchFormD({}, ".");
  assert.equal(result.total, 0);
  assert.match(result.error, /Provide name or company/);
});

test("results carry city and state but never a street, postcode or coordinate", () => {
  seed();
  const serialised = JSON.stringify(searchFormD({ name: "ellingsworth" }, "."));
  for (const field of ["street1", "zipCode", "zip", "lat", "lng", "distanceMiles", "geoPrecision"]) {
    assert.equal(serialised.includes(field), false, `${field} must never appear on a Form D result`);
  }
  assert.ok(serialised.includes("LEAGUE CITY"), "city is kept — coarse but useful");
});

test("no per-person wealth figure is produced", () => {
  seed();
  const row = searchFormD({ name: "jane" }, ".").rows[0];
  // The amount is the company's raise. Naming it largestOfferingAmount rather than
  // 'value' or 'netWorth' is deliberate — Form D never says what share the person owns.
  assert.equal(row.largestOfferingAmount, 50000000);
  assert.equal("netWorth" in row, false);
  assert.equal("disclosedValue" in row, false);
  resetFormD();
});
