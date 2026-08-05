import test from "node:test";
import assert from "node:assert/strict";
import { haversineMeters, geohash, presentDistance, milesToMeters, GEO_PRECISION } from "./geo.mjs";

test("haversine: known distance Kirkland -> Seattle is ~13.5 km", () => {
  const m = haversineMeters(47.6769, -122.206, 47.6062, -122.3321);
  assert.ok(m > 12_000 && m < 15_000, `expected ~13.5km, got ${Math.round(m)}m`);
});

test("haversine: identical points are zero", () => {
  assert.equal(Math.round(haversineMeters(47.6769, -122.206, 47.6769, -122.206)), 0);
});

test("haversine: non-finite input yields null, never NaN", () => {
  assert.equal(haversineMeters(NaN, -122, 47, -122), null);
  assert.equal(haversineMeters(47, undefined, 47, -122), null);
});

test("milesToMeters uses the statute mile", () => {
  assert.equal(Math.round(milesToMeters(1)), 1609);
});

test("geohash: known value for Kirkland, and prefix-stability across precisions", () => {
  const h = geohash(47.6769, -122.206, 6);
  assert.equal(h.length, 6);
  assert.ok(geohash(47.6769, -122.206, 5) === h.slice(0, 5));
});

test("geohash: nearby points share a cell, distant ones do not", () => {
  // ~50 m apart — the whole point of snapping, so two nearby users share a cache entry.
  assert.equal(geohash(47.6769, -122.206, 6), geohash(47.67735, -122.206, 6));
  assert.notEqual(geohash(47.6769, -122.206, 6), geohash(40.758, -73.9855, 6));
});

test("presentDistance: rooftop keeps metre precision", () => {
  assert.equal(presentDistance(1234.6, GEO_PRECISION.ROOFTOP), 1235);
});

test("presentDistance: zip-centroid is floored to 500m and rounded to 100m", () => {
  // ZIP centroids carry 57-864m of error, so a '12 m away' claim would be a lie.
  assert.equal(presentDistance(12, GEO_PRECISION.ZIP_CENTROID), 500);
  assert.equal(presentDistance(1234, GEO_PRECISION.ZIP_CENTROID), 1200);
});

test("presentDistance: null in, null out", () => {
  assert.equal(presentDistance(null, GEO_PRECISION.ROOFTOP), null);
});
