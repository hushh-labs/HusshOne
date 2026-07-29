import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEdges, EDGE_WEIGHTS } from "./edges.mjs";

const node = (o) => ({
  id: 0,
  nameKey: null,
  zip: null,
  state: null,
  profession: null,
  orgKey: null,
  addressKey: null,
  verticals: [],
  ...o,
});

test("shared_address: one undirected edge, src<dst, weight 0.9", () => {
  const edges = deriveEdges([
    node({ id: 5, addressKey: "12 lake st|98033" }),
    node({ id: 2, addressKey: "12 lake st|98033" }),
  ]);
  const sa = edges.filter((e) => e.edgeType === "shared_address");
  assert.equal(sa.length, 1);
  assert.equal(sa[0].srcPersonId, 2);
  assert.equal(sa[0].dstPersonId, 5);
  assert.equal(sa[0].weight, EDGE_WEIGHTS.shared_address);
});

test("same_org groups colleagues", () => {
  const edges = deriveEdges([
    node({ id: 1, orgKey: "acme" }),
    node({ id: 2, orgKey: "acme" }),
    node({ id: 3, orgKey: "other" }),
  ]);
  const so = edges.filter((e) => e.edgeType === "same_org");
  assert.equal(so.length, 1);
  assert.deepEqual([so[0].srcPersonId, so[0].dstPersonId], [1, 2]);
});

test("name_alias only spans >=2 verticals", () => {
  const same = deriveEdges([
    node({ id: 1, nameKey: "jane smith", verticals: ["healthcare"] }),
    node({ id: 2, nameKey: "jane smith", verticals: ["healthcare"] }),
  ]);
  assert.equal(same.filter((e) => e.edgeType === "name_alias").length, 0, "same vertical -> no alias");

  const cross = deriveEdges([
    node({ id: 1, nameKey: "jane smith", verticals: ["healthcare"] }),
    node({ id: 2, nameKey: "jane smith", verticals: ["insurance"] }),
  ]);
  const alias = cross.filter((e) => e.edgeType === "name_alias");
  assert.equal(alias.length, 1);
  assert.equal(alias[0].weight, EDGE_WEIGHTS.name_alias);
  assert.deepEqual(alias[0].evidence.verticals, ["healthcare", "insurance"]);
});

test("same_zip_profession respects the group cap", () => {
  const nodes = [
    node({ id: 1, zip: "98033", profession: "healthcare" }),
    node({ id: 2, zip: "98033", profession: "healthcare" }),
    node({ id: 3, zip: "98033", profession: "healthcare" }),
  ];
  const capped = deriveEdges(nodes, [], { maxSameZipGroup: 2 });
  assert.equal(capped.filter((e) => e.edgeType === "same_zip_profession").length, 0, "group > cap skipped");

  const uncapped = deriveEdges(nodes, [], { maxSameZipGroup: 0 });
  assert.equal(uncapped.filter((e) => e.edgeType === "same_zip_profession").length, 3, "3 pairs among 3 nodes");
});

test("social relations produce directed follow/mention edges", () => {
  const edges = deriveEdges(
    [node({ id: 1 }), node({ id: 2 })],
    [
      { srcId: 1, dstId: 2, type: "follow", evidence: { vertical: "instagram" } },
      { srcId: 2, dstId: 1, type: "mention", evidence: { vertical: "instagram" } },
    ],
  );
  const follow = edges.find((e) => e.edgeType === "social_follow");
  const mention = edges.find((e) => e.edgeType === "social_mention");
  assert.deepEqual([follow.srcPersonId, follow.dstPersonId], [1, 2]);
  assert.equal(follow.weight, EDGE_WEIGHTS.social_follow);
  assert.deepEqual([mention.srcPersonId, mention.dstPersonId], [2, 1]);
  assert.equal(mention.weight, EDGE_WEIGHTS.social_mention);
});

test("self-edges and null ids are dropped", () => {
  const edges = deriveEdges(
    [node({ id: 1, orgKey: "acme" }), node({ id: 1, orgKey: "acme" }), node({ id: null, orgKey: "acme" })],
    [{ srcId: 3, dstId: 3, type: "follow" }],
  );
  assert.equal(edges.length, 0);
});

test("output is deterministically sorted", () => {
  const nodes = [
    node({ id: 3, orgKey: "acme", addressKey: "x|1" }),
    node({ id: 1, orgKey: "acme", addressKey: "x|1" }),
    node({ id: 2, orgKey: "acme", addressKey: "x|1" }),
  ];
  const a = JSON.stringify(deriveEdges(nodes));
  const b = JSON.stringify(deriveEdges([...nodes].reverse()));
  assert.equal(a, b);
});
