import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsvLine,
  buildNppesIndex,
  entityTypeFromCode,
  toIsoDate,
  taxonomyDesc,
  statusFromDates,
  pickPrimaryTaxonomy,
  mapNppesRow,
  discoverLatestBulkUrl,
} from "./nppes.mjs";

// A representative NPPES header row (subset of columns, in an arbitrary order to
// prove name-based mapping). Two taxonomy slots exercise the primary-switch pick.
const HEADER = [
  "NPI",
  "Entity Type Code",
  "Provider Organization Name (Legal Business Name)",
  "Provider Last Name (Legal Name)",
  "Provider First Name",
  "Provider Middle Name",
  "Provider Credential Text",
  "Provider First Line Business Practice Location Address",
  "Provider Second Line Business Practice Location Address",
  "Provider Business Practice Location Address City Name",
  "Provider Business Practice Location Address State Name",
  "Provider Business Practice Location Address Postal Code",
  "Provider Business Practice Location Address Telephone Number",
  "Provider Enumeration Date",
  "NPI Deactivation Date",
  "NPI Reactivation Date",
  "Healthcare Provider Taxonomy Code_1",
  "Healthcare Provider Primary Taxonomy Switch_1",
  "Healthcare Provider Taxonomy Code_2",
  "Healthcare Provider Primary Taxonomy Switch_2",
];

test("parseCsvLine handles quoted fields, escaped quotes, and commas inside quotes", () => {
  assert.deepEqual(parseCsvLine('"1234567890","1",""'), ["1234567890", "1", ""]);
  assert.deepEqual(parseCsvLine('"a","b, c","d"'), ["a", "b, c", "d"]);
  assert.deepEqual(parseCsvLine('"He said ""hi""","x"'), ['He said "hi"', "x"]);
  // Trailing CR from a CRLF line is stripped off the last field.
  assert.deepEqual(parseCsvLine('"a","b"\r'), ["a", "b"]);
  // Unquoted values (defensive) still split on commas.
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("buildNppesIndex maps header names to positions and collects taxonomy slots", () => {
  const idx = buildNppesIndex(HEADER);
  assert.equal(idx.npi, 0);
  assert.equal(idx.entityType, 1);
  assert.equal(idx.postal, 11);
  assert.equal(idx.enumerationDate, 13);
  assert.deepEqual(idx.taxonomyCodes, [16, 18]);
  assert.deepEqual(idx.taxonomySwitches, [17, 19]);
  // A header not present resolves to -1 (mapper treats it as null).
  const idx2 = buildNppesIndex(["NPI"]);
  assert.equal(idx2.state, -1);
});

test("entityTypeFromCode maps 1/2, else null", () => {
  assert.equal(entityTypeFromCode("1"), "individual");
  assert.equal(entityTypeFromCode("2"), "organization");
  assert.equal(entityTypeFromCode(""), null);
  assert.equal(entityTypeFromCode("9"), null);
});

test("toIsoDate converts MM/DD/YYYY to YYYY-MM-DD, else null", () => {
  assert.equal(toIsoDate("05/23/2007"), "2007-05-23");
  assert.equal(toIsoDate("5/3/2007"), "2007-05-03");
  assert.equal(toIsoDate(""), null);
  assert.equal(toIsoDate("2007-05-23"), null); // already ISO — not the NPPES format
});

test("taxonomyDesc resolves known codes and returns null for unknown", () => {
  assert.equal(taxonomyDesc("207Q00000X"), "Family Medicine");
  assert.equal(taxonomyDesc("207q00000x"), "Family Medicine"); // case-insensitive
  assert.equal(taxonomyDesc("ZZZ"), null);
});

test("statusFromDates: deactivation without later reactivation => deactivated", () => {
  assert.equal(statusFromDates("", ""), "active");
  assert.equal(statusFromDates("01/01/2020", ""), "deactivated");
  assert.equal(statusFromDates("01/01/2020", "06/01/2021"), "active"); // reactivated later
  assert.equal(statusFromDates("06/01/2021", "01/01/2020"), "deactivated"); // reactivation before deact
});

test("pickPrimaryTaxonomy prefers the Y-switched slot, else first non-empty", () => {
  const idx = buildNppesIndex(HEADER);
  const fields = new Array(HEADER.length).fill("");
  fields[16] = "207R00000X";
  fields[17] = "N";
  fields[18] = "207Q00000X";
  fields[19] = "Y";
  assert.equal(pickPrimaryTaxonomy(fields, idx), "207Q00000X");
  // No Y => first non-empty.
  fields[19] = "N";
  assert.equal(pickPrimaryTaxonomy(fields, idx), "207R00000X");
});

test("mapNppesRow maps an individual provider (practice address, primary taxonomy)", () => {
  const idx = buildNppesIndex(HEADER);
  const fields = [
    "1234567890", "1", "", "SMITH", "JANE", "A", "MD",
    "123 MAIN ST", "STE 4", "KIRKLAND", "WA", "980332145", "4255551234",
    "05/23/2007", "", "", "207R00000X", "N", "207Q00000X", "Y",
  ];
  const rec = mapNppesRow(fields, idx, "nppes_bulk");
  assert.equal(rec.npi, "1234567890");
  assert.equal(rec.entityType, "individual");
  assert.equal(rec.lastName, "SMITH");
  assert.equal(rec.firstName, "JANE");
  assert.equal(rec.credential, "MD");
  assert.equal(rec.organizationName, null);
  assert.equal(rec.primaryTaxonomyCode, "207Q00000X");
  assert.equal(rec.primaryTaxonomyDesc, "Family Medicine");
  assert.equal(rec.enumerationDate, "2007-05-23");
  assert.equal(rec.status, "active");
  assert.equal(rec.addressLine1, "123 MAIN ST");
  assert.equal(rec.city, "KIRKLAND");
  assert.equal(rec.state, "WA");
  assert.equal(rec.zip, "98033"); // 9-digit ZIP+4 normalized to 5
  assert.equal(rec.phone, "4255551234");
  assert.equal(rec.source, "nppes_bulk");
  assert.equal(rec.raw, null);
});

test("mapNppesRow returns null when the NPI is not 10 digits", () => {
  const idx = buildNppesIndex(HEADER);
  const bad = new Array(HEADER.length).fill("");
  bad[0] = "12345"; // too short
  assert.equal(mapNppesRow(bad, idx), null);
});

test("discoverLatestBulkUrl picks newest monthly + weekly, skips deactivation report", () => {
  const html = `
    <a href="./NPPES_Data_Dissemination_March_2026.zip">march</a>
    <a href="./NPPES_Data_Dissemination_April_2026.zip">april</a>
    <a href="NPPES_Data_Dissemination_April_2026_V2.zip">april v2</a>
    <a href="./NPPES_Data_Dissemination_040626_041226_Weekly.zip">weekly older</a>
    <a href="./NPPES_Data_Dissemination_041326_041926_Weekly_V2.zip">weekly newer v2</a>
    <a href="./NPPES_Deactivated_NPI_Report_041026.zip">deactivation report</a>
  `;
  const { monthly, weekly } = discoverLatestBulkUrl(html, "https://download.cms.gov/nppes/");
  assert.equal(monthly.filename, "NPPES_Data_Dissemination_April_2026_V2.zip");
  assert.equal(monthly.url, "https://download.cms.gov/nppes/NPPES_Data_Dissemination_April_2026_V2.zip");
  assert.equal(weekly.filename, "NPPES_Data_Dissemination_041326_041926_Weekly_V2.zip");
  // The deactivation report must never be selected.
  assert.ok(!/Deactivated/i.test(monthly.filename));
  assert.ok(!/Deactivated/i.test(weekly.filename));
});

test("discoverLatestBulkUrl returns nulls when no matching files present", () => {
  const { monthly, weekly } = discoverLatestBulkUrl("<a href='readme.txt'>x</a>");
  assert.equal(monthly, null);
  assert.equal(weekly, null);
});
