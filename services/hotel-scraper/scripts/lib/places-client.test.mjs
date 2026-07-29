// A Places key must exist before config.mjs loads (it reads env at import time),
// so set a dummy one, then dynamic-import the client. No real network is used —
// global.fetch is stubbed per test.
process.env.PLACES_API_KEY = process.env.PLACES_API_KEY || "test-places-key";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { searchLodging, getPlacePhotos, resolvePhotoUri } = await import("./places-client.mjs");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function okJson(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test("searchLodging sends the field mask, lodging type, and US region on one page", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return okJson({ places: [{ id: "a" }] });
  };

  const { places, calls: billed } = await searchLodging("hotels in 98033", { pageTokenDelayMs: 0 });
  assert.equal(places.length, 1);
  assert.equal(billed, 1);
  assert.equal(calls.length, 1);

  const { url, opts } = calls[0];
  assert.match(String(url), /places\.googleapis\.com/);
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers["X-Goog-Api-Key"], "test-places-key");
  const mask = opts.headers["X-Goog-FieldMask"];
  assert.match(mask, /places\.rating/);
  assert.match(mask, /places\.location/);
  assert.match(mask, /places\.photos/); // photo refs ride along free
  assert.match(mask, /nextPageToken/);
  const body = JSON.parse(opts.body);
  assert.equal(body.includedType, "lodging");
  assert.equal(body.regionCode, "US");
  assert.equal(typeof body.pageSize, "number");
});

test("searchLodging follows nextPageToken and accumulates results", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) return okJson({ places: [{ id: "a" }, { id: "b" }], nextPageToken: "TOK" });
    return okJson({ places: [{ id: "c" }] }); // no token -> stop
  };

  const { places, calls } = await searchLodging("hotels in 98033", { maxPages: 3, pageTokenDelayMs: 0 });
  assert.equal(calls, 2);
  assert.deepEqual(places.map((p) => p.id), ["a", "b", "c"]);
});

test("searchLodging retries a 429 then succeeds (calls counts only billed pages)", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, text: async () => "rate limited" };
    return okJson({ places: [{ id: "a" }] });
  };

  const { places, calls } = await searchLodging("hotels in 98033", {
    maxBackoffMs: 5,
    pageTokenDelayMs: 0,
  });
  assert.equal(n, 2); // fetched twice (one 429, one success)
  assert.equal(calls, 1); // only the successful page is billed
  assert.equal(places.length, 1);
});

test("searchLodging surfaces non-rate-limit HTTP errors", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => "bad request" });
  await assert.rejects(
    () => searchLodging("hotels in 98033", { pageTokenDelayMs: 0 }),
    /Places HTTP 400/,
  );
});

test("getPlacePhotos requests Place Details with the photos-only field mask", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return okJson({ photos: [{ name: "places/P/photos/AAA" }, { name: "places/P/photos/BBB" }] });
  };
  const photos = await getPlacePhotos("ChIJ abc");
  assert.equal(photos.length, 2);
  const { url, opts } = calls[0];
  // place_id is URL-encoded into the path (spaces etc.).
  assert.match(String(url), /places\/ChIJ%20abc$/);
  assert.equal(opts.method ?? "GET", "GET");
  assert.equal(opts.headers["X-Goog-Api-Key"], "test-places-key");
  assert.equal(opts.headers["X-Goog-FieldMask"], "photos");
});

test("getPlacePhotos returns [] when the place has no photos, and for a missing id", async () => {
  globalThis.fetch = async () => okJson({}); // no photos array
  assert.deepEqual(await getPlacePhotos("P"), []);
  // Never even fetches without an id.
  let hit = false;
  globalThis.fetch = async () => {
    hit = true;
    return okJson({});
  };
  assert.deepEqual(await getPlacePhotos(""), []);
  assert.equal(hit, false);
});

test("getPlacePhotos throws on a 404 (stale/drifted place_id)", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "NOT_FOUND" });
  await assert.rejects(() => getPlacePhotos("P", { maxBackoffMs: 5 }), /Place Details HTTP 404/);
});

test("getPlacePhotos caps retries on a persistent 429 and throws RateLimitError", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return { ok: false, status: 429, text: async () => "RESOURCE_EXHAUSTED" };
  };
  await assert.rejects(
    () => getPlacePhotos("P", { maxBackoffMs: 1, maxAttempts: 3 }),
    /Place Details rate-limited after 3 attempts/,
  );
  assert.equal(n, 3); // stops after maxAttempts, doesn't spin forever
});

test("getPlacePhotos treats a 403-with-quota body as retryable and caps it", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return { ok: false, status: 403, text: async () => "Quota exceeded for this project" };
  };
  await assert.rejects(
    () => getPlacePhotos("P", { maxBackoffMs: 1, maxAttempts: 2 }),
    /Place Details rate-limited after 2 attempts/,
  );
  assert.equal(n, 2);
});

test("resolvePhotoUri hits the media endpoint, clamps width, and returns photoUri", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return okJson({ name: "places/P/photos/AAA/media", photoUri: "https://img.example/AAA=w1200" });
  };
  const uri = await resolvePhotoUri("places/P/photos/AAA", { maxWidthPx: 999999 });
  assert.equal(uri, "https://img.example/AAA=w1200");
  const { url, opts } = calls[0];
  const s = String(url);
  assert.match(s, /places\/P\/photos\/AAA\/media/);
  assert.match(s, /skipHttpRedirect=true/);
  assert.match(s, /maxWidthPx=4800/); // 999999 clamped to the 4800 ceiling
  assert.equal(opts.headers["X-Goog-Api-Key"], "test-places-key");
});

test("resolvePhotoUri returns null for an empty name and on a soft-null body", async () => {
  let hit = false;
  globalThis.fetch = async () => {
    hit = true;
    return okJson({});
  };
  assert.equal(await resolvePhotoUri(""), null);
  assert.equal(hit, false); // no name -> no call
  assert.equal(await resolvePhotoUri("places/P/photos/AAA"), null); // body without photoUri
});

test("resolvePhotoUri surfaces non-rate-limit HTTP errors", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "denied" });
  await assert.rejects(
    () => resolvePhotoUri("places/P/photos/AAA", { maxBackoffMs: 5 }),
    /Place Photo HTTP 403/,
  );
});

test("resolvePhotoUri caps retries on a persistent 429 and throws RateLimitError", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return { ok: false, status: 429, text: async () => "rate limited" };
  };
  await assert.rejects(
    () => resolvePhotoUri("places/P/photos/AAA", { maxBackoffMs: 1, maxAttempts: 3 }),
    /Place Photo rate-limited after 3 attempts/,
  );
  assert.equal(n, 3);
});
