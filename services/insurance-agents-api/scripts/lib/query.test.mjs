import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, QueryError } from "./query.mjs";

const q = (s) => new URLSearchParams(s);

test("postalCode becomes the upstream q", () => {
  const p = parseQuery(q("postalCode=98033"));
  assert.equal(p.q, "98033");
  assert.equal(p.resolvedFrom, "postal");
});

test("zip and q are accepted as aliases for postalCode", () => {
  assert.equal(parseQuery(q("zip=98033")).q, "98033");
  assert.equal(parseQuery(q("q=Kirkland, WA")).q, "Kirkland, WA");
});

test("lat/lng become q='lat,lng'", () => {
  const p = parseQuery(q("lat=47.6769&lng=-122.206"));
  assert.equal(p.q, "47.6769,-122.206");
  assert.equal(p.resolvedFrom, "coordinates");
});

test("postalCode wins when both are supplied", () => {
  assert.equal(parseQuery(q("postalCode=98033&lat=47&lng=-122")).q, "98033");
});

test("requires some location", () => {
  assert.throws(() => parseQuery(q("")), QueryError);
  assert.throws(() => parseQuery(q("lat=47")), QueryError);
});

test("rejects out-of-range coordinates", () => {
  assert.throws(() => parseQuery(q("lat=91&lng=0")), QueryError);
  assert.throws(() => parseQuery(q("lat=0&lng=181")), QueryError);
});

test("radiusMi is validated and passed through as a client-side filter", () => {
  assert.equal(parseQuery(q("postalCode=98033&radiusMi=10")).radiusMi, 10);
  assert.throws(() => parseQuery(q("postalCode=98033&radiusMi=0")), QueryError);
  assert.throws(() => parseQuery(q("postalCode=98033&radiusMi=99999")), QueryError);
});

test("clamps limit/offset and validates stream", () => {
  const p = parseQuery(q("postalCode=98033&limit=99999&offset=5&stream=sse"));
  assert.equal(p.limit, 200);
  assert.equal(p.offset, 5);
  assert.equal(p.stream, "sse");
  assert.throws(() => parseQuery(q("postalCode=98033&stream=websocket")), QueryError);
});
