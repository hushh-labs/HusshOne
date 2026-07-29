import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  personNameKey,
  normalizeOrg,
  normalizeStreet,
  cleanZip,
  cleanState,
  addressKey,
  resolveEntities,
} from "./resolve.mjs";

test("normalizeName strips diacritics, punctuation, expands &", () => {
  assert.equal(normalizeName("Dr. José A. Smith-Jones & Co."), "dr jose a smith jones and co");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName("  Multiple   Spaces "), "multiple spaces");
});

test("personNameKey collapses honorifics/suffixes/initials to a stable key", () => {
  assert.equal(personNameKey({ firstName: "Jane", lastName: "Smith" }), "jane smith");
  assert.equal(personNameKey({ name: "Dr. Jane A. Smith, MD" }), "jane smith");
  // explicit first/last preferred over parsing a full name
  assert.equal(personNameKey({ firstName: "  Jane ", lastName: "SMITH" }), "jane smith");
});

test("normalizeOrg drops corporate suffixes but never returns empty", () => {
  assert.equal(normalizeOrg("Acme Advisors, LLC"), "acme");
  assert.equal(normalizeOrg("Acme Advisors"), "acme");
  // all-suffix name falls back to the raw tokens instead of ""
  assert.equal(normalizeOrg("The Co"), "the co");
});

test("normalizeStreet applies USPS abbreviations", () => {
  assert.equal(normalizeStreet("12 Lake Street"), "12 lake st");
  assert.equal(normalizeStreet("12 Lake St"), "12 lake st");
  assert.equal(normalizeStreet("400 North Boulevard"), "400 n blvd");
});

test("cleanZip / cleanState normalize or reject", () => {
  assert.equal(cleanZip("98033-1234"), "98033");
  assert.equal(cleanZip(98033), "98033");
  assert.equal(cleanZip("123"), null);
  assert.equal(cleanState("wa"), "WA");
  assert.equal(cleanState("Washington"), null);
});

test("addressKey requires BOTH a street and a zip", () => {
  assert.equal(addressKey("12 Lake Street", "98033-1234"), "12 lake st|98033");
  assert.equal(addressKey("12 Lake Street", null), null);
  assert.equal(addressKey("", "98033"), null);
});

test("resolveEntities merges same name + same zip across verticals", () => {
  const { clusters, sourceMap } = resolveEntities([
    { sourceVertical: "healthcare", sourceKey: "npi1", kind: "person", firstName: "Jane", lastName: "Smith", zip: "98033", state: "WA", profession: "healthcare" },
    { sourceVertical: "insurance", sourceKey: "lic1", kind: "person", name: "Jane Smith", zip: "98033-0000", state: "WA", profession: "insurance" },
    { sourceVertical: "ria", sourceKey: "crd1", kind: "person", name: "Jane Smith", zip: "10001", profession: "ria" },
  ]);
  assert.equal(clusters.length, 2, "same name+zip merges; different zip stays separate");
  const merged = clusters.find((c) => c.sources.length === 2);
  assert.ok(merged, "one cluster has two sources");
  assert.deepEqual(merged.verticals, ["healthcare", "insurance"]);
  assert.equal(merged.zip, "98033");
  // provenance map points every source at its cluster
  assert.equal(sourceMap.get("healthcare:npi1"), merged.clusterKey);
  assert.equal(sourceMap.get("insurance:lic1"), merged.clusterKey);
});

test("resolveEntities merges same name + same org", () => {
  const { clusters } = resolveEntities([
    { sourceVertical: "healthcare", sourceKey: "a", kind: "person", name: "John Doe", org: "Acme Advisors LLC" },
    { sourceVertical: "ria", sourceKey: "b", kind: "person", name: "John Doe", org: "Acme Advisors" },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].sources.length, 2);
});

test("resolveEntities NEVER merges different names even at same zip", () => {
  const { clusters } = resolveEntities([
    { sourceVertical: "healthcare", sourceKey: "a", kind: "person", name: "Jane Smith", zip: "98033" },
    { sourceVertical: "insurance", sourceKey: "b", kind: "person", name: "Bob Jones", zip: "98033" },
  ]);
  assert.equal(clusters.length, 2);
});

test("resolveEntities keeps distinct source keys distinct (idempotent anchors unique)", () => {
  const { clusters } = resolveEntities([
    { sourceVertical: "hotel", sourceKey: "h1", kind: "org", name: "Grand Hotel", zip: "98033" },
    { sourceVertical: "hotel", sourceKey: "h2", kind: "org", name: "Grand Hotel", zip: "98033" },
  ]);
  // same name+zip -> these two DO merge (org co-location); anchor stays unique
  const keys = new Set(clusters.map((c) => c.clusterKey));
  assert.equal(keys.size, clusters.length, "cluster keys are unique");
});
