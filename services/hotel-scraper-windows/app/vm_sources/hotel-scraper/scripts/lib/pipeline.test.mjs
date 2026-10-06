import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, processZip } from "./pipeline.mjs";

test("buildQuery prefers city+state, degrades gracefully", () => {
  assert.equal(buildQuery({ zip: "98033", city: "Kirkland", state: "WA" }), "hotels in Kirkland, WA 98033");
  assert.equal(buildQuery({ zip: "98033", state: "WA" }), "hotels in 98033, WA");
  assert.equal(buildQuery({ zip: "98033" }), "hotels in 98033");
});

// A minimal Places result that mapPlaceToHotel will accept.
function fakePlace(id, name) {
  return {
    id,
    displayName: { text: name },
    location: { latitude: 47.6769, longitude: -122.206 },
    addressComponents: [
      { types: ["postal_code"], longText: "98033" },
      { types: ["administrative_area_level_1"], shortText: "WA" },
    ],
  };
}

test("processZip searches, maps, upserts, and reports counts (deps injected)", async () => {
  const upserts = [];
  const deps = {
    searchLodging: async (q) => {
      assert.equal(q, "hotels in Kirkland, WA 98033");
      return { places: [fakePlace("a", "Hotel A"), fakePlace("b", "Hotel B")], calls: 1 };
    },
    upsertHotel: async (rec) => {
      upserts.push(rec);
      return { id: upserts.length, inserted: true };
    },
    countHotelsForQueryZip: async (zip) => {
      assert.equal(zip, "98033");
      return 2;
    },
  };

  const out = await processZip({ zip: "98033", city: "Kirkland", state: "WA" }, deps);
  assert.equal(out.placesCalls, 1);
  assert.equal(out.results, 2);
  assert.equal(out.mapped, 2);
  assert.equal(out.inserted, 2);
  assert.equal(out.hotelsFound, 2);
  assert.equal(upserts.length, 2);
  assert.equal(upserts[0].source, "places");
  assert.equal(upserts[0].queryZip, "98033");
});

test("processZip skips unmappable results (no name) without upserting them", async () => {
  let upsertCount = 0;
  const deps = {
    searchLodging: async () => ({
      places: [fakePlace("a", "Hotel A"), { id: "x", location: { latitude: 1, longitude: 2 } }],
      calls: 1,
    }),
    upsertHotel: async () => {
      upsertCount++;
      return { id: upsertCount, inserted: true };
    },
    countHotelsForQueryZip: async () => 1,
  };

  const out = await processZip({ zip: "98033", city: "Kirkland", state: "WA" }, deps);
  assert.equal(out.results, 2); // two raw results returned by search
  assert.equal(out.mapped, 1); // only one was mappable
  assert.equal(upsertCount, 1);
});
