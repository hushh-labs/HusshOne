import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeState,
  splitName,
  statusFromExpiration,
  toList,
  normalizeProducer,
  mapTxIndividualRow,
  mapTxAgencyRow,
} from "./producers.mjs";

test("normalizeState uppercases valid 2-letter codes, rejects the rest", () => {
  assert.equal(normalizeState("tx"), "TX");
  assert.equal(normalizeState(" ca "), "CA");
  assert.equal(normalizeState("TXX"), null);
  assert.equal(normalizeState("1"), null);
  assert.equal(normalizeState(""), null);
  assert.equal(normalizeState(null), null);
});

test("splitName handles 'LAST, FIRST', 'FIRST MIDDLE LAST', org, and blank", () => {
  assert.deepEqual(splitName("SMITH, JOHN A"), { firstName: "JOHN A", lastName: "SMITH" });
  assert.deepEqual(splitName("JOHN A SMITH"), { firstName: "JOHN A", lastName: "SMITH" });
  assert.deepEqual(splitName("ACME"), { firstName: null, lastName: "ACME" });
  assert.deepEqual(splitName("   "), { firstName: null, lastName: null });
});

test("statusFromExpiration derives active/inactive/unknown", () => {
  const now = new Date("2026-07-28T00:00:00Z");
  assert.equal(statusFromExpiration("2027-01-01", now), "active");
  assert.equal(statusFromExpiration("2020-01-01", now), "inactive");
  assert.equal(statusFromExpiration("", now), null);
  assert.equal(statusFromExpiration("not-a-date", now), null);
  assert.equal(statusFromExpiration(null, now), null);
});

test("toList flattens, trims, dedups, and drops blanks", () => {
  assert.deepEqual(toList("a", "a", "", "b"), ["a", "b"]);
  assert.deepEqual(toList(["x", " y ", null]), ["x", "y"]);
  assert.deepEqual(toList(null), []);
  assert.deepEqual(toList(), []);
});

test("normalizeProducer requires sourceState + licenseNo, and fills a DB-ready shape", () => {
  assert.equal(normalizeProducer(null), null);
  assert.equal(normalizeProducer({ sourceState: "TX" }), null);
  assert.equal(normalizeProducer({ licenseNo: "1" }), null);

  const p = normalizeProducer({
    sourceState: "tx",
    licenseNo: " 123 ",
    fullName: "Jane Doe",
    entityType: "individual",
    licenseTypes: "Agent",
    linesOfAuthority: "Life",
    state: "wa",
    zip: "98033-1234",
  });
  assert.equal(p.sourceState, "TX");
  assert.equal(p.licenseNo, "123");
  assert.equal(p.entityType, "individual");
  assert.deepEqual(p.licenseTypes, ["Agent"]);
  assert.deepEqual(p.linesOfAuthority, ["Life"]);
  assert.equal(p.state, "WA");
  assert.equal(p.zip, "98033");
  assert.deepEqual(p.sources, []);
});

test("normalizeProducer coerces unknown entityType to null", () => {
  const p = normalizeProducer({ sourceState: "TX", licenseNo: "1", entityType: "weird" });
  assert.equal(p.entityType, null);
});

test("mapTxIndividualRow maps a TDI individual row to a normalized producer", () => {
  const now = new Date("2026-07-28T00:00:00Z");
  const row = {
    npn: "9876543",
    license_number: "1234567",
    name: "SMITH, JOHN A",
    license_type: "General Lines Agent",
    qualification: "Life",
    expiration_date: "2027-03-15",
    city: "Austin",
    state: "TX",
    pstl_cd: "78701-1234",
  };
  const rec = mapTxIndividualRow(row, now);
  assert.equal(rec.sourceState, "TX");
  assert.equal(rec.licenseNo, "1234567");
  assert.equal(rec.npn, "9876543");
  assert.equal(rec.entityType, "individual");
  assert.equal(rec.firstName, "JOHN A");
  assert.equal(rec.lastName, "SMITH");
  assert.deepEqual(rec.licenseTypes, ["General Lines Agent"]);
  assert.deepEqual(rec.linesOfAuthority, ["Life"]);
  assert.equal(rec.status, "active");
  assert.equal(rec.zip, "78701");
  assert.deepEqual(rec.sources, ["data.texas.gov/kxv3-diwf"]);
});

test("mapTxIndividualRow returns null without a license number", () => {
  assert.equal(mapTxIndividualRow({ name: "No License" }), null);
  assert.equal(mapTxIndividualRow(null), null);
});

test("mapTxAgencyRow maps a TDI agency row and unions license/agency type", () => {
  const now = new Date("2026-07-28T00:00:00Z");
  const row = {
    npn: "111",
    agency_license_number: "AG-42",
    org_name: "ACME INSURANCE LLC",
    agency_type: "Corporation",
    license_type: "General Lines",
    qualification: "Property",
    expiration_date: "2020-01-01",
    city: "Dallas",
    state: "TX",
    pstl_cd: "75201",
  };
  const rec = mapTxAgencyRow(row, now);
  assert.equal(rec.sourceState, "TX");
  assert.equal(rec.licenseNo, "AG-42");
  assert.equal(rec.entityType, "agency");
  assert.equal(rec.fullName, "ACME INSURANCE LLC");
  assert.equal(rec.lastName, null);
  assert.deepEqual(rec.licenseTypes, ["General Lines", "Corporation"]);
  assert.equal(rec.status, "inactive");
  assert.deepEqual(rec.sources, ["data.texas.gov/3yqc-fcdt"]);
});
