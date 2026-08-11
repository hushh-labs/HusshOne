import assert from "node:assert/strict";
import test from "node:test";

import { isPlaceholderZip, isUsAddress } from "./geo-us.mjs";

test("all-zero postcodes are placeholders, not postcodes", () => {
  // EDGAR writes these for foreign issuers. 48 appear in the 2026Q2 index.
  assert.equal(isPlaceholderZip("00000"), true);
  assert.equal(isPlaceholderZip("000000"), true);
  assert.equal(isPlaceholderZip("00000-0000"), true);
  assert.equal(isPlaceholderZip(""), true);
  assert.equal(isPlaceholderZip(null), true);
});

test("real postcodes are not placeholders, including leading-zero ones", () => {
  assert.equal(isPlaceholderZip("98109"), false);
  assert.equal(isPlaceholderZip("02139"), false, "Cambridge MA must survive");
  assert.equal(isPlaceholderZip("00601"), false, "Puerto Rico is a real US postcode");
});

test("a US address is placeable", () => {
  assert.equal(isUsAddress({ state: "WA", zip: "98109" }), true);
  assert.equal(isUsAddress({ state: "wa", zip: "98109" }), true, "case must not matter");
  assert.equal(isUsAddress({ state: "PR", zip: "00601" }), true, "territories count");
});

test("foreign addresses are refused whatever the isForeign flag claims", () => {
  // United Microelectronics, Taipei — state F5, and EDGAR flags it isForeign: false.
  assert.equal(isUsAddress({ state: "F5", zip: "11493", isForeign: false }), false);
  // Toyota — ZIP 00000, also flagged false.
  assert.equal(isUsAddress({ state: "M0", zip: "00000", isForeign: false }), false);
});

test("a US state with a placeholder postcode is not placeable", () => {
  assert.equal(isUsAddress({ state: "NY", zip: "00000" }), false);
});

test("missing or unknown input is refused rather than guessed", () => {
  assert.equal(isUsAddress(null), false);
  assert.equal(isUsAddress({}), false);
  assert.equal(isUsAddress({ state: "ZZ", zip: "12345" }), false);
});
