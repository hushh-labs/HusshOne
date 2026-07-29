// resolveHotelPhotos orchestrates the (free) Place Details name fetch and the
// (paid) media-URL resolve. We stub global.fetch (rather than mock the ESM module,
// whose namespace exports are non-configurable) so the REAL client code runs too.
// The two request kinds are told apart by URL: media calls end in "/media".
process.env.PLACES_API_KEY = process.env.PLACES_API_KEY || "test-places-key";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { resolveHotelPhotos } = await import("./photos.mjs");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function okJson(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

// Build a fetch stub: details returns `photos`; each media URL resolves via `mediaFor(name)`
// (return a string URL, null, or throw an Error to simulate a failed fetch).
function stub({ photos = [], mediaFor = () => null, onDetails } = {}) {
  const counts = { details: 0, media: 0 };
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.endsWith("/media") || s.includes("/media?")) {
      counts.media++;
      const name = decodeURIComponent(s.split("/v1/")[1].split("/media")[0]);
      const out = mediaFor(name);
      if (out instanceof Error) throw out;
      return okJson({ photoUri: out });
    }
    counts.details++;
    if (onDetails) return onDetails();
    return okJson({ photos });
  };
  return counts;
}

test("returns 'none' immediately when the hotel has no place_id (no calls)", async () => {
  const c = stub({});
  const r = await resolveHotelPhotos({ id: 1, placeId: null });
  assert.equal(r.status, "none");
  assert.deepEqual(r.photos, []);
  assert.equal(c.details, 0);
  assert.equal(c.media, 0);
});

test("returns 'none' when Place Details reports no photos", async () => {
  const c = stub({ photos: [] });
  const r = await resolveHotelPhotos({ id: 1, placeId: "P" });
  assert.equal(r.status, "none");
  assert.equal(c.details, 1);
  assert.equal(c.media, 0);
});

test("resolves up to maxPerHotel images and shapes each photo row", async () => {
  stub({
    photos: [
      { name: "places/P/photos/A", widthPx: 4000, heightPx: 3000, authorAttributions: [{ displayName: "Jo", uri: "https://jo" }] },
      { name: "places/P/photos/B", widthPx: 1000, heightPx: 800 },
      { name: "places/P/photos/C" },
      { name: "places/P/photos/D" },
    ],
    mediaFor: (name) => `https://img/${name.split("/").pop()}`,
  });

  const r = await resolveHotelPhotos({ id: 1, placeId: "P" }, { maxPerHotel: 2 });
  assert.equal(r.status, "done");
  assert.equal(r.refs.length, 4); // refs holds ALL names found
  assert.equal(r.photos.length, 2); // photos capped at maxPerHotel
  assert.equal(r.billedMedia, 2); // two media 200s -> two billed fetches
  assert.deepEqual(r.photos[0], {
    ref: "places/P/photos/A",
    uri: "https://img/A",
    widthPx: 4000,
    heightPx: 3000,
    attribution: { displayName: "Jo", uri: "https://jo" },
  });
  assert.equal(r.photos[1].attribution, null); // no authorAttributions -> null
});

test("skips a photo whose media fetch throws but keeps the others (partial success)", async () => {
  stub({
    photos: [{ name: "places/P/photos/A" }, { name: "places/P/photos/B" }],
    mediaFor: (name) => (name.endsWith("A") ? new Error("boom") : "https://img/B"),
  });
  const r = await resolveHotelPhotos({ id: 1, placeId: "P" }, { maxPerHotel: 5 });
  assert.equal(r.status, "done");
  assert.equal(r.photos.length, 1);
  assert.equal(r.photos[0].ref, "places/P/photos/B");
  assert.equal(r.billedMedia, 1); // A threw (not billed), B was a billed 200
});

test("throws a soft retryable error when a place has photos but ALL media fail", async () => {
  stub({
    photos: [{ name: "places/P/photos/A" }],
    mediaFor: () => new Error("media down"),
  });
  await assert.rejects(
    () => resolveHotelPhotos({ id: 1, placeId: "P" }),
    (err) => err.softAllFailed === true && err.billedMedia === 0, // throw = not billed
  );
});

test("throws a soft retryable error when every media call returns null", async () => {
  stub({
    photos: [{ name: "places/P/photos/A" }],
    mediaFor: () => null,
  });
  await assert.rejects(
    () => resolveHotelPhotos({ id: 1, placeId: "P" }),
    // A 200-with-null body IS billed, so spend must still be recorded (billedMedia===1).
    (err) => err.softAllFailed === true && err.billedMedia === 1,
  );
});
