import assert from "node:assert/strict";
import test from "node:test";

import { buildFiler, extractNetWorth, rankByNetWorth } from "./florida.mjs";

/** Real text layer shape from filing 1054795, including the asset schedule that follows. */
const PDF_TEXT = `
Net Worth as of
December 31, 2025
 was

$ 1,730,712.88
.
Net Worth
Household goods and personal effects may be reported in a
Home
$ 469,000.00
Bank of America Checking
$ 12,056.61
Discover Savings
$ 29,793.85
`;

test("the sworn net worth is extracted across the real line breaks", () => {
  assert.equal(extractNetWorth(PDF_TEXT), 1730712.88);
});

test("the asset schedule is never returned — only the figure is", () => {
  // The parser's whole contract: one number out, nothing else. Form 6 prints property
  // by STREET ADDRESS next to its value, so anything beyond the figure is exactly what
  // must not be republished.
  const value = extractNetWorth(PDF_TEXT);
  assert.equal(typeof value, "number", "the return type is a number, not a document");
});

test("a home address in the PDF cannot leak through a filer record", () => {
  const roster = { filingId: 1, fullName: "Edward Hand", countyOfResidence: "Wakulla", fullOrganizations: [] };
  const filer = buildFiler(roster, extractNetWorth(`
    Net Worth as of December 31, 2025 was $ 189,425.97.
    Main Home at 169 Martin Farms Road, Crawfordville, FL 5.4 acres
    $ 723,300.00
  `));

  const serialised = JSON.stringify(filer);
  assert.equal(filer.netWorth, 189425.97);
  assert.equal(serialised.includes("Martin Farms"), false, "street address leaked");
  assert.equal(serialised.includes("723,300"), false, "asset detail leaked");
  assert.equal(serialised.includes("Crawfordville"), false, "property town leaked");
});

test("a negative net worth stays negative", () => {
  // Form 6 prints a deficit in parentheses; reading it as positive would rank someone
  // in debt above someone solvent.
  assert.equal(extractNetWorth("Net Worth as of December 31, 2025 was ($ 45,120.00)"), -45120);
  assert.equal(extractNetWorth("Net Worth as of Dec 31 2025 was -$ 1,000.00"), -1000);
});

test("a whole-dollar figure with no cents parses", () => {
  assert.equal(extractNetWorth("Net Worth as of December 31, 2025 was $ 6,629,408"), 6629408);
});

test("a missing figure is null, never zero", () => {
  // Pre-2023 filings are scans with no text layer at all. Treating that as $0 would
  // rank a scanned filer as the poorest person in Florida.
  assert.equal(extractNetWorth(""), null);
  assert.equal(extractNetWorth(null), null);
  assert.equal(extractNetWorth("a page of prose with no such figure"), null);
  assert.equal(extractNetWorth("Net Worth"), null, "the label alone is not a figure");
});

test("buildFiler refuses a record with no figure rather than inventing one", () => {
  assert.equal(buildFiler({ fullName: "Someone" }, null), null);
  assert.equal(buildFiler(null, 100), null);
});

test("the public office is kept — it is the person's public location", () => {
  const filer = buildFiler({
    filingId: 1067851, fullName: "Craig Latimer", countyOfResidence: "Hillsborough",
    fullOrganizations: [{ fullOrganizationName: "Supervisor Of Elections - Elected Constitutional Officer" }],
  }, 6629408.0);

  assert.deepEqual(filer.offices, ["Supervisor Of Elections - Elected Constitutional Officer"]);
  assert.equal(filer.county, "Hillsborough");
  assert.equal(filer.netWorth, 6629408);
  // County and office only. No coordinates from this source, ever.
  for (const field of ["lat", "lng", "street1", "zip", "distanceMiles"]) {
    assert.equal(field in filer, false, `${field} must not exist on a Florida record`);
  }
});

test("ranking is by sworn net worth, largest first", () => {
  const ranked = rankByNetWorth([
    buildFiler({ fullName: "A" }, 189425.97),
    buildFiler({ fullName: "B" }, 8288706.31),
    null,
    buildFiler({ fullName: "C" }, 6629408),
  ]);
  assert.deepEqual(ranked.map((f) => f.name), ["B", "C", "A"]);
  assert.equal(ranked.length, 3, "nulls are dropped, not ranked as zero");
});
