import { test } from "node:test";
import assert from "node:assert/strict";
import {
  geohashEncode,
  normalizeName,
  dedupKey,
  mapPlaceToHotel,
  mapOsmElementToHotel,
} from "./hotels.mjs";

test("geohashEncode matches the canonical reference value", () => {
  // Classic geohash example: (57.64911, 10.40744) → "u4pruydqqvj"; first 6 chars.
  assert.equal(geohashEncode(57.64911, 10.40744, 6), "u4pruy");
  assert.equal(geohashEncode(57.64911, 10.40744, 6).length, 6);
});

test("geohashEncode is deterministic and cell-stable for nearby points", () => {
  const a = geohashEncode(47.6769, -122.206, 6);
  const b = geohashEncode(47.6769, -122.206, 6);
  assert.equal(a, b);
  // A few meters away stays in the same precision-6 cell.
  const near = geohashEncode(47.67695, -122.20605, 6);
  assert.equal(a, near);
  // Far away differs.
  assert.notEqual(a, geohashEncode(25.7743, -80.1937, 6));
});

test("normalizeName strips diacritics, punctuation, and expands &", () => {
  assert.equal(normalizeName("Hôtel Déjà-Vu!"), "hotel deja vu");
  assert.equal(normalizeName("Smith & Sons"), "smith and sons");
  assert.equal(normalizeName("  The   Ritz-Carlton  "), "the ritz carlton");
  assert.equal(normalizeName(null), "");
});

test("dedupKey is name+geohash and stable across identical inputs", () => {
  const k1 = dedupKey("Hôtel Déjà-Vu!", 47.6769, -122.206);
  const k2 = dedupKey("Hotel Deja Vu", 47.6769, -122.206);
  assert.equal(k1, k2); // normalization makes these collapse to one key
  assert.ok(k1.includes("|"));
  assert.equal(k1, `hotel deja vu|${geohashEncode(47.6769, -122.206, 6)}`);
});

test("mapPlaceToHotel extracts name, zip, state, and rich fields", () => {
  const place = {
    id: "ChIJ_test",
    displayName: { text: "The Heathman Hotel" },
    formattedAddress: "220 Kirkland Ave, Kirkland, WA 98033, USA",
    location: { latitude: 47.6769, longitude: -122.206 },
    addressComponents: [
      { types: ["postal_code"], longText: "98033", shortText: "98033" },
      { types: ["administrative_area_level_1"], shortText: "WA", longText: "Washington" },
    ],
    rating: 4.5,
    userRatingCount: 1234,
    priceLevel: "PRICE_LEVEL_MODERATE",
    nationalPhoneNumber: "(425) 555-1000",
    websiteUri: "https://example.com",
    googleMapsUri: "https://maps.google.com/?cid=1",
    types: ["lodging", "hotel"],
    primaryType: "hotel",
    businessStatus: "OPERATIONAL",
  };
  const rec = mapPlaceToHotel(place, "98033");
  assert.equal(rec.source, "places");
  assert.equal(rec.placeId, "ChIJ_test");
  assert.equal(rec.name, "The Heathman Hotel");
  assert.equal(rec.zip, "98033");
  assert.equal(rec.queryZip, "98033");
  assert.equal(rec.state, "WA");
  assert.equal(rec.rating, 4.5);
  assert.equal(rec.userRatingsTotal, 1234);
  assert.equal(rec.phone, "(425) 555-1000");
  assert.ok(rec.dedupKey.includes("|"));
});

test("mapPlaceToHotel collects photo names and strips them out of raw", () => {
  const place = {
    id: "ChIJ_photo",
    displayName: { text: "Photo Hotel" },
    location: { latitude: 47.6769, longitude: -122.206 },
    photos: [
      { name: "places/ChIJ_photo/photos/AAA", widthPx: 4000, heightPx: 3000 },
      { name: "places/ChIJ_photo/photos/BBB" },
      { widthPx: 100 }, // no name -> dropped
    ],
  };
  const rec = mapPlaceToHotel(place);
  assert.deepEqual(rec.photoRefs, [
    "places/ChIJ_photo/photos/AAA",
    "places/ChIJ_photo/photos/BBB",
  ]);
  // Photo names must NOT be duplicated inside raw (ToS: one refreshable location).
  assert.equal(rec.raw.photos, undefined);
  assert.equal(rec.raw.id, "ChIJ_photo");
});

test("mapPlaceToHotel yields empty photoRefs when a place has no photos", () => {
  const rec = mapPlaceToHotel({
    id: "X",
    displayName: { text: "No Photos" },
    location: { latitude: 1, longitude: 2 },
  });
  assert.deepEqual(rec.photoRefs, []);
});

test("mapPlaceToHotel returns null without a name or coordinates", () => {
  assert.equal(mapPlaceToHotel(null), null);
  assert.equal(mapPlaceToHotel({ location: { latitude: 1, longitude: 2 } }), null);
  assert.equal(mapPlaceToHotel({ displayName: { text: "X" } }), null);
});

test("mapOsmElementToHotel maps a node and derives osm_id + primary_type", () => {
  const el = {
    type: "node",
    id: 123456,
    lat: 47.6769,
    lon: -122.206,
    tags: {
      name: "Kirkland Inn",
      tourism: "hotel",
      "addr:postcode": "98033",
      "addr:state": "WA",
      "addr:housenumber": "12",
      "addr:street": "Lake St",
      "addr:city": "Kirkland",
      phone: "+1 425 555 0100",
      website: "https://kirklandinn.example",
    },
  };
  const rec = mapOsmElementToHotel(el, null);
  assert.equal(rec.source, "osm");
  assert.equal(rec.osmId, "node/123456");
  assert.equal(rec.name, "Kirkland Inn");
  assert.equal(rec.zip, "98033");
  assert.equal(rec.state, "WA");
  assert.equal(rec.primaryType, "hotel");
  assert.deepEqual(rec.types, ["hotel"]);
  assert.equal(rec.formattedAddress, "12 Lake St, Kirkland, WA, 98033");
  assert.equal(rec.rating, null);
});

test("mapOsmElementToHotel uses way/relation centroid from `center`", () => {
  const el = {
    type: "way",
    id: 42,
    center: { lat: 47.61, lon: -122.33 },
    tags: { name: "Grand Resort", building: "hotel" },
  };
  const rec = mapOsmElementToHotel(el);
  assert.equal(rec.osmId, "way/42");
  assert.equal(rec.lat, 47.61);
  assert.equal(rec.lng, -122.33);
  assert.equal(rec.primaryType, "hotel"); // from building=hotel fallback
});

test("mapOsmElementToHotel returns null when unnamed", () => {
  assert.equal(mapOsmElementToHotel({ type: "node", id: 1, lat: 1, lon: 2, tags: {} }), null);
  assert.equal(mapOsmElementToHotel(null), null);
});
