import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidUsZip, normalizeZip, haversineKm, parseGeoNamesLine } from "./zip.mjs";
import { KIRKLAND } from "./config.mjs";

test("isValidUsZip accepts 5 digits, rejects everything else", () => {
  assert.equal(isValidUsZip("98033"), true);
  assert.equal(isValidUsZip("00501"), true);
  assert.equal(isValidUsZip("9803"), false);
  assert.equal(isValidUsZip("980333"), false);
  assert.equal(isValidUsZip("9803a"), false);
  assert.equal(isValidUsZip(""), false);
  assert.equal(isValidUsZip(null), false);
});

test("normalizeZip strips +4 and left-pads short codes", () => {
  assert.equal(normalizeZip("98033-1234"), "98033");
  assert.equal(normalizeZip(2138), "02138"); // leading-zero ZIP from a numeric source
  assert.equal(normalizeZip("  98033 "), "98033");
  assert.equal(normalizeZip(""), null);
  assert.equal(normalizeZip(null), null);
});

test("haversineKm: identical points are 0, one degree of longitude at equator ≈ 111km", () => {
  assert.equal(haversineKm(KIRKLAND, KIRKLAND), 0);
  const d = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.ok(Math.abs(d - 111.19) < 0.5, `expected ~111.19, got ${d}`);
});

test("parseGeoNamesLine parses a Kirkland row; distance from Kirkland ≈ 0", () => {
  const line = `US\t98033\tKirkland\tWashington\tWA\tKing\t033\t\t\t${KIRKLAND.lat}\t${KIRKLAND.lng}\t4`;
  const row = parseGeoNamesLine(line);
  assert.equal(row.zip, "98033");
  assert.equal(row.city, "Kirkland");
  assert.equal(row.state, "WA");
  assert.equal(row.county, "King");
  assert.equal(row.lat, KIRKLAND.lat);
  assert.equal(row.lng, KIRKLAND.lng);
  assert.ok(row.distKm < 0.001, `expected ~0, got ${row.distKm}`);
});

test("parseGeoNamesLine computes a large distance for a far ZIP (Miami)", () => {
  const line = `US\t33101\tMiami\tFlorida\tFL\tMiami-Dade\t086\t\t\t25.7743\t-80.1937\t4`;
  const row = parseGeoNamesLine(line);
  assert.equal(row.zip, "33101");
  assert.equal(row.state, "FL");
  assert.ok(row.distKm > 3000 && row.distKm < 6000, `expected 3000-6000km, got ${row.distKm}`);
});

test("parseGeoNamesLine rejects blank, short, and non-numeric-coord lines", () => {
  assert.equal(parseGeoNamesLine(""), null);
  assert.equal(parseGeoNamesLine("   "), null);
  assert.equal(parseGeoNamesLine("US\t98033\tKirkland"), null); // too few columns
  const badCoords = `US\t98033\tKirkland\tWashington\tWA\tKing\t033\t\t\tNaN\tNaN\t4`;
  assert.equal(parseGeoNamesLine(badCoords), null);
});
