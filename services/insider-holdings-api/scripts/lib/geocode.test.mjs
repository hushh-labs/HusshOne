import assert from "node:assert/strict";
import test from "node:test";

import { MAX_BATCH, geocodeBatch, parseResponse, streetVariant, toCsv } from "./geocode.mjs";

test("a leading spelled number offers a digit variant", () => {
  // TIGER stores house numbers as digits, so these miss as words.
  assert.equal(streetVariant("ONE APPLE PARK WAY"), "1 APPLE PARK WAY");
  assert.equal(streetVariant("One Vanderbilt Avenue"), "1 Vanderbilt Avenue");
  assert.equal(streetVariant("TWO PENN PLAZA"), "2 PENN PLAZA");
});

test("the variant is only ever an ALTERNATIVE, never a rewrite", () => {
  // "Seven Hills Road" is a place name, "Four Times Square" is a house number, and no
  // rule separates them. So the variant is offered and only tried after the literal
  // address has already failed — the original is never discarded.
  const csv = toCsv([{ id: "1", street: "Seven Hills Road", city: "X", state: "OH", zip: "44131" }]);
  assert.ok(csv.includes("Seven Hills Road"), "the filed address must be sent as filed");
  assert.equal(streetVariant("Seven Hills Road"), "7 Hills Road", "offered as a fallback only");
});

test("streets with nothing to vary return null", () => {
  assert.equal(streetVariant("410 TERRY AVENUE NORTH"), null);
  assert.equal(streetVariant("ONE"), null, "a bare word is not a house number");
  assert.equal(streetVariant(""), null);
  assert.equal(streetVariant(null), null);
});

test("CSV is headerless and comma-safe", () => {
  const csv = toCsv([{ id: "1", street: "410 TERRY AVE N", city: "SEATTLE", state: "WA", zip: "98109" }]);
  assert.equal(csv, "1,410 TERRY AVE N,SEATTLE,WA,98109");

  const quoted = toCsv([{ id: "2", street: "1 A ST, STE 5", city: "NY", state: "NY", zip: "10001" }]);
  assert.ok(quoted.includes('"1 A ST, STE 5"'), "an embedded comma must be quoted");
});

test("coordinates are parsed as lng,lat and returned as lat,lng", () => {
  // Census returns longitude FIRST. Getting this backwards moves every company.
  const found = parseResponse(
    '"1","410 TERRY AVENUE NORTH, SEATTLE, WA, 98109","Match","Exact",' +
      '"410 TERRY AVE N, SEATTLE, WA, 98109","-122.337065327617,47.622201075898","186583744","R"',
  );

  const point = found.get("1");
  assert.ok(point.lat > 47 && point.lat < 48, `latitude should be ~47.6, got ${point.lat}`);
  assert.ok(point.lng < -122 && point.lng > -123, `longitude should be ~-122.3, got ${point.lng}`);
});

test("No_Match rows yield nothing rather than a bad point", () => {
  const found = parseResponse('"2","ONE APPLE PARK WAY, CUPERTINO, CA, 95014","No_Match"');
  assert.equal(found.size, 0);
});

test("garbage and empty input are survivable", () => {
  assert.equal(parseResponse("").size, 0);
  assert.equal(parseResponse("not,a,real,row").size, 0);
  assert.equal(parseResponse(null).size, 0);
});

test("an oversized batch is refused before it is sent", async () => {
  const rows = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ id: String(i) }));
  await assert.rejects(() => geocodeBatch(rows, "Public_AR_Current"), /exceeds the 10000 limit/);
});

test("an upstream failure degrades to no matches, never a throw", async () => {
  const failing = async () => ({ ok: false, status: 500 });
  const found = await geocodeBatch([{ id: "1", street: "x", city: "y", state: "WA", zip: "98109" }],
    "Public_AR_Current", { fetchImpl: failing });
  assert.equal(found.size, 0, "the caller keeps its ZIP centroid instead of losing the issuer");
});
