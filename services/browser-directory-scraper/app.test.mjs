import test from "node:test";
import assert from "node:assert/strict";
import { buildQueries, normalizeObservation, stableKey, taskKey } from "./app.mjs";

test("priority query includes the ZIP and vertical intent", () => {
  assert.deepEqual(buildQueries("healthcare", "98033", "Kirkland", "WA")[0], "healthcare providers in Kirkland, WA, 98033");
});

test("observations normalize and point to the canonical lane", () => {
  const row = normalizeObservation({
    vertical: "insurance",
    queryZip: "98033",
    name: "  North & West Insurance  ",
    sourceUrl: "https://example.com/team",
    phone: "+1 (425) 555-1212",
    postalCode: "98033-1234",
  });
  assert.equal(row.normalizedName, "north and west insurance");
  assert.equal(row.postalCode, "98033");
  assert.equal(row.canonicalDatabase, "insurance");
  assert.equal(row.canonicalTable, "producers");
  assert.equal(row.stableKey, stableKey(row));
});

test("task keys are deterministic", () => {
  assert.equal(taskKey({ vertical: "advisory", zip: "98033", query: "RIA firms in 98033" }), taskKey({ vertical: "advisory", zip: "98033", query: "RIA firms in 98033" }));
});
