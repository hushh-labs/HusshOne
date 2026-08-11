import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describeDistance, haversineMi, resolveZip, resetCentroids } from "./geo.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-"));
  fs.writeFileSync(
    path.join(dir, "zcta-centroids.tsv"),
    "94105\t37.789\t-122.396\n10001\t40.750\t-73.997\n00601\t18.180\t-66.749\n",
  );
  resetCentroids();
  return dir;
}

test("resolveZip finds a postcode", () => {
  const dir = fixture();
  const point = resolveZip("94105", dir);
  assert.equal(point.lat, 37.789);
  assert.equal(point.lng, -122.396);
});

test("ZIP+4 resolves via its 5-digit prefix", () => {
  const dir = fixture();
  assert.ok(resolveZip("94105-1234", dir), "ZIP+4 must not read as unknown");
});

test("a leading-zero postcode survives", () => {
  const dir = fixture();
  // "00601" parsed as a number would become 601 and never match.
  assert.ok(resolveZip("00601", dir));
  assert.ok(resolveZip("601", dir), "padded short form should also resolve");
});

test("unknown and malformed postcodes return null", () => {
  const dir = fixture();
  assert.equal(resolveZip("99999", dir), null);
  assert.equal(resolveZip("abcde", dir), null);
  assert.equal(resolveZip("", dir), null);
});

test("a missing centroid file is empty, not an exception", () => {
  resetCentroids();
  assert.equal(resolveZip("94105", fs.mkdtempSync(path.join(os.tmpdir(), "empty-"))), null);
});

test("haversine matches a known distance", () => {
  // San Francisco -> New York is about 2,570 miles.
  const miles = haversineMi(37.789, -122.396, 40.75, -73.997);
  assert.ok(miles > 2500 && miles < 2650, `got ${miles}`);
  assert.equal(Math.round(haversineMi(37.789, -122.396, 37.789, -122.396)), 0);
});

test("sub-half-mile distances report as 0 rather than false precision", () => {
  const near = describeDistance(0.2);
  assert.equal(near.distanceMiles, 0);
  assert.equal(near.distanceApproximate, true);
  assert.equal(near.geoPrecision, "zip_centroid");

  assert.equal(describeDistance(12.34).distanceMiles, 12.3);
});
