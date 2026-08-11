import assert from "node:assert/strict";
import test from "node:test";

import { buildOwners, describeOwnership, isIndividual, parseCsvLine, parseOwnerRow } from "./adv-owners.mjs";

/** Real row shape from IA_Schedule_A_B_20111105_20241231.csv. */
const ROW = {
  FilingID: "736572",
  "SchA-3": "N",
  Schedule: "A",
  "Full Legal Name": "CIEHANSKI, CHRISTOPHER, JOHN",
  "DE/FE/I": "I",
  "Entity in Which": "",
  "Title or Status": "MANAGING MEMBER & CHIEF COMPLIANCE OFFICER",
  "Status Acquired": "09/2012",
  "Ownership Code": "D",
  "Control Person": "Y",
  PR: "N",
  OwnerID: "2491297",
};

test("a natural person is parsed and the CRD is the join key", () => {
  const owner = parseOwnerRow(ROW);
  assert.equal(owner.name, "CIEHANSKI, CHRISTOPHER, JOHN");
  assert.equal(owner.crd, "2491297", "OwnerID IS the individual CRD");
  assert.equal(owner.isControlPerson, true);
  assert.equal(owner.ownership.label, "50-75%");
});

test("entities are not indexed as people", () => {
  assert.equal(isIndividual({ "DE/FE/I": "I" }), true);
  assert.equal(isIndividual({ "DE/FE/I": "DE" }), false, "domestic entity");
  assert.equal(isIndividual({ "DE/FE/I": "FE" }), false, "foreign entity");
  assert.equal(parseOwnerRow({ ...ROW, "DE/FE/I": "DE" }), null);
});

test("the current ownership legend maps to bands", () => {
  assert.deepEqual(describeOwnership("NA"), { code: "NA", min: 0, max: 5, label: "under 5%", ambiguous: false });
  assert.equal(describeOwnership("A").label, "5-10%");
  assert.equal(describeOwnership("E").label, "75% or more");
  assert.equal(describeOwnership("e").code, "E", "case-insensitive");
});

test("code F is reported as AMBIGUOUS, never guessed", () => {
  // ~202,000 rows carry F. The current legend does not define it; the older Form ADV
  // and Form BD scale used E = 50-75% and F = 75%+. Guessing either way is a one-band
  // error on 200,000 records.
  const f = describeOwnership("F");
  assert.equal(f.ambiguous, true);
  assert.equal(f.min, null, "no band is asserted");
  assert.match(f.label, /older form scale/);
});

test("an unrecognised code is ambiguous rather than dropped", () => {
  assert.equal(describeOwnership("Z").ambiguous, true);
  assert.equal(describeOwnership(""), null);
  assert.equal(describeOwnership(null), null);
});

test("CSV parsing survives commas inside quoted legal names", () => {
  // "SMITH, JOHN, JR" would otherwise shift every later column, attaching one person's
  // ownership code to the next person's row.
  const cells = parseCsvLine('736572,"N","A","SMITH, JOHN, JR","I","","CEO",09/2012,"D","Y","N",2491297');
  assert.equal(cells[3], "SMITH, JOHN, JR");
  assert.equal(cells[8], "D", "the ownership code stays in its own column");
  assert.equal(cells[11], "2491297");
});

test("CSV parsing handles escaped quotes", () => {
  const cells = parseCsvLine('1,"He said ""hi""",I');
  assert.equal(cells[1], 'He said "hi"');
});

test("a row with no CRD is kept but says so", () => {
  const owner = parseOwnerRow({ ...ROW, OwnerID: "" });
  assert.equal(owner.crd, null, "null, not an invented id");
  assert.equal(owner.name, "CIEHANSKI, CHRISTOPHER, JOHN");
});

test("repeat filings by one person collapse to one record", () => {
  // The archive spans 2011-2024, so a firm filing twelve times contributes twelve
  // identical rows for the same person.
  const rows = [ROW, { ...ROW }, { ...ROW, FilingID: "800000", "Ownership Code": "E" }];
  const [person] = buildOwners(rows);

  assert.equal(person.filingCount, 2, "deduped on filing id");
  assert.equal(person.crd, "2491297");
  assert.equal(person.largestOwnership.label, "75% or more", "strongest band wins");
});

test("an ambiguous F never inflates the largest ownership", () => {
  const rows = [
    { ...ROW, FilingID: "1", "Ownership Code": "A" },
    { ...ROW, FilingID: "2", "Ownership Code": "F" },
  ];
  const [person] = buildOwners(rows);

  assert.equal(person.largestOwnership.label, "5-10%", "F is excluded from the maximum");
  assert.equal(person.hasAmbiguousCode, true, "but the caller is told it exists");
});

test("control is counted separately from size", () => {
  // A 5% holder can control a firm and a 30% holder may not, so the two are not merged.
  const rows = [
    { ...ROW, FilingID: "1", "Ownership Code": "A", "Control Person": "Y" },
    { ...ROW, FilingID: "2", "Ownership Code": "C", "Control Person": "N" },
  ];
  const [person] = buildOwners(rows);
  assert.equal(person.controlPersonAt, 1);
  assert.equal(person.largestOwnership.label, "25-50%");
});

test("positions are sampled, but every reported COUNT stays true", () => {
  // Milton Berlinski is a control person at 2,546 advisers. Keeping every position row
  // produced a 485 MB index that would not load in the service's container.
  const many = Array.from({ length: 60 }, (_, i) => ({
    ...ROW, FilingID: String(1000 + i), "Ownership Code": "A", "Control Person": "Y",
  }));
  const [person] = buildOwners(many);

  assert.equal(person.filingCount, 60, "the true total, not the sample size");
  assert.equal(person.controlPersonAt, 60, "counted before trimming");
  assert.equal(person.positions.length, 3, "sample is capped");
  assert.equal(person.positionsSampled, 3, "and the cap is stated");
});

test("the strongest band is found even when it falls outside the sample", () => {
  // The maximum is computed over every position, so a big stake in filing #60 is not
  // lost because only the first ten rows are kept.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ ...ROW, FilingID: String(i), "Ownership Code": "NA" })),
    { ...ROW, FilingID: "999", "Ownership Code": "E" },
  ];
  const [person] = buildOwners(rows);
  assert.equal(person.largestOwnership.label, "75% or more");
});

test("no address field exists anywhere in a record", () => {
  // Schedule A/B carries no address at all, so unlike every other source here there is
  // nothing to strip — this test pins that assumption.
  const serialised = JSON.stringify(buildOwners([ROW]));
  for (const field of ["street", "address", "city", "zip", "lat", "lng"]) {
    assert.equal(serialised.toLowerCase().includes(field), false, `${field} appeared`);
  }
});
