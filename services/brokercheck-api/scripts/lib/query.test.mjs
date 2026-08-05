import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, QueryError } from "./query.mjs";

const q = (s) => new URLSearchParams(s);
const stubResolver = async (postal) => (postal === "98033" ? { lat: 47.673156, lng: -122.197628 } : null);

test("parses coordinates and applies defaults", async () => {
  const parsed = await parseQuery(q("lat=47.6769&lng=-122.206"));
  assert.equal(parsed.lat, 47.6769);
  assert.equal(parsed.lng, -122.206);
  assert.equal(parsed.resolvedFrom, "coordinates");
  assert.equal(parsed.radiusMi, 10);
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.batchSize, 10);
  assert.equal(parsed.type, "ia");
  assert.equal(parsed.status, "active");
  assert.equal(parsed.stream, "ndjson");
  assert.equal(parsed.detail, true);
});

test("accepts `lon` as an alias for `lng` (FINRA's own spelling)", async () => {
  const parsed = await parseQuery(q("lat=47.6769&lon=-122.206"));
  assert.equal(parsed.lng, -122.206);
});

test("resolves a postal code and reports the weaker provenance", async () => {
  const parsed = await parseQuery(q("postalCode=98033"), { resolveLocation: stubResolver });
  assert.equal(parsed.resolvedFrom, "postal");
  assert.equal(parsed.lat, 47.673156);
});

test("an unresolvable postal code is a 400, not a silent empty search", async () => {
  await assert.rejects(() => parseQuery(q("postalCode=00000"), { resolveLocation: stubResolver }), QueryError);
});

test("requires a location", async () => {
  await assert.rejects(() => parseQuery(q("")), QueryError);
  await assert.rejects(() => parseQuery(q("lat=47.6769")), QueryError);
});

test("rejects out-of-range coordinates", async () => {
  await assert.rejects(() => parseQuery(q("lat=91&lng=0")), QueryError);
  await assert.rejects(() => parseQuery(q("lat=0&lng=181")), QueryError);
});

test("rejects non-numeric input rather than coercing it", async () => {
  await assert.rejects(() => parseQuery(q("lat=abc&lng=-122")), QueryError);
});

test("clamps radius and limit into range instead of failing", async () => {
  const big = await parseQuery(q("lat=47&lng=-122&radiusMi=9999&limit=99999"));
  assert.equal(big.radiusMi, 100);
  assert.equal(big.limit, 500);
  const small = await parseQuery(q("lat=47&lng=-122&radiusMi=0&limit=0"));
  assert.equal(small.radiusMi, 0.1);
  assert.equal(small.limit, 1);
});

test("validates enums and names the allowed values", async () => {
  await assert.rejects(() => parseQuery(q("lat=47&lng=-122&type=bogus")), QueryError);
  await assert.rejects(() => parseQuery(q("lat=47&lng=-122&stream=websocket")), QueryError);
  const parsed = await parseQuery(q("lat=47&lng=-122&type=both&status=all&groupBy=branch&stream=sse"));
  assert.equal(parsed.type, "both");
  assert.equal(parsed.status, "all");
  assert.equal(parsed.groupBy, "branch");
  assert.equal(parsed.stream, "sse");
});

test("detail can be switched off for a pins-only caller", async () => {
  for (const off of ["false", "0", "no", "off"]) {
    assert.equal((await parseQuery(q(`lat=47&lng=-122&detail=${off}`))).detail, false);
  }
  assert.equal((await parseQuery(q("lat=47&lng=-122&detail=true"))).detail, true);
});

test("rejects an absurd experience floor", async () => {
  await assert.rejects(() => parseQuery(q("lat=47&lng=-122&minExperienceYears=200")), QueryError);
  assert.equal((await parseQuery(q("lat=47&lng=-122&minExperienceYears=20"))).minExperienceYears, 20);
});
