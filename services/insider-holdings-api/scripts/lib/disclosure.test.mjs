import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTRIBUTION,
  FORBIDDEN_OWNER_FIELDS,
  assertDisclosable,
  isSection16Insider,
  stripOwnerAddress,
} from "./disclosure.mjs";

test("Section 16 roles are accepted", () => {
  assert.equal(isSection16Insider("Officer"), true);
  assert.equal(isSection16Insider("Director"), true);
  assert.equal(isSection16Insider("TenPercentOwner"), true);
  assert.equal(isSection16Insider("Director,Officer"), true);
  assert.equal(isSection16Insider("Director,Officer,TenPercentOwner"), true);
});

test("anything that is not a Section 16 role is refused", () => {
  // Fail-closed: an unfamiliar string is a reason to exclude someone, never to include.
  assert.equal(isSection16Insider("Spouse"), false);
  assert.equal(isSection16Insider("Beneficial owner"), false);
  assert.equal(isSection16Insider(""), false);
  assert.equal(isSection16Insider(null), false);
  assert.equal(isSection16Insider(undefined), false);
  assert.equal(isSection16Insider("Officers"), false, "near-miss must not pass");
});

test("assertDisclosable throws for a non-filer and names why", () => {
  assert.throws(
    () => assertDisclosable({ name: "A PRIVATE PERSON", relationship: "Spouse" }),
    /not a Section 16 role/,
  );
});

test("assertDisclosable returns the row for a real insider", () => {
  const row = { name: "REAL FILER", relationship: "Officer" };
  assert.equal(assertDisclosable(row), row);
});

test("owner address fields are stripped at any depth", () => {
  const dirty = {
    name: "SOMEONE",
    RPTOWNER_STREET1: "12 PRIVATE ROAD",
    RPTOWNER_CITY: "THEIR TOWN",
    nested: { ownerZip: "94105", keep: "yes" },
    list: [{ homeAddress: "somewhere", ticker: "AAPL" }],
  };

  const clean = stripOwnerAddress(dirty);

  assert.equal(clean.name, "SOMEONE");
  assert.equal(clean.nested.keep, "yes");
  assert.equal(clean.list[0].ticker, "AAPL");
  for (const field of FORBIDDEN_OWNER_FIELDS) {
    assert.equal(JSON.stringify(clean).includes(field), false, `${field} survived stripping`);
  }
});

test("stripOwnerAddress leaves primitives and null alone", () => {
  assert.equal(stripOwnerAddress(null), null);
  assert.equal(stripOwnerAddress("text"), "text");
  assert.equal(stripOwnerAddress(42), 42);
});

test("attribution states the two facts most likely to be misread", () => {
  assert.match(ATTRIBUTION.valuationNotice, /not the person's net worth/i);
  assert.match(ATTRIBUTION.locationNotice, /never reads or returns a filer's own address/i);
});
