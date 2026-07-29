import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCombinedReport } from "./report-render.mjs";

const metrics = {
  generatedAt: "2026-07-28T00:00:00.000Z",
  verticals: [
    { key: "healthcare", label: "Healthcare providers", available: true, count: 1200 },
    { key: "ria", label: "RIA advisers + firms", available: true, count: 340 },
    { key: "insurance", label: "Insurance producers", available: false, count: null },
    { key: "hotel", label: "Hotels", available: true, count: 88 },
    { key: "social", label: "Social (IG / X / Threads)", available: false, count: 0, note: "no shared DB" },
  ],
  graph: {
    personsTotal: 1500,
    edgesTotal: 4200,
    sourcesTotal: 1628,
    personsByProfession: { healthcare: 1200, ria: 300 },
    edgesByType: { shared_address: 100, same_org: 4000 },
    sourcesByVertical: { healthcare: 1200, ria: 340 },
    lastBuild: { ok: true, persons_upserted: 1500, edges_upserted: 4200, finished_at: "2026-07-28T01:23:00.000Z" },
  },
};

test("subject summarizes graph totals + live source count", () => {
  const { subject } = buildCombinedReport(metrics);
  assert.match(subject, /5 verticals \+ graph/);
  assert.match(subject, /1,500 nodes/);
  assert.match(subject, /4,200 edges/);
  assert.match(subject, /3\/5 sources live/, "healthcare+ria+hotel available");
});

test("html renders each vertical, marks unavailable, breaks down edges", () => {
  const { html } = buildCombinedReport(metrics);
  assert.match(html, /Healthcare providers/);
  assert.match(html, /Insurance producers/);
  assert.match(html, /unavailable/, "an unavailable source is flagged");
  assert.match(html, /no shared DB/, "social note is shown");
  assert.match(html, /shared_address/);
  assert.match(html, /same_org/);
  assert.match(html, /1,200/, "counts are thousands-formatted");
});

test("degrades to sane output with empty metrics", () => {
  const { subject, html } = buildCombinedReport({ verticals: [], graph: {} });
  assert.match(subject, /0\/0 sources live/);
  assert.match(html, /no build runs yet/);
});
