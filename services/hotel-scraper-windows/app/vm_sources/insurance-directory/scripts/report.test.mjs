import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./report.mjs";

const progress = {
  producersTotal: 963880,
  producersActive: 900000,
  producersInactive: 63880,
  producersGeocoded: 800000,
  zipsCovered: 12345,
  statesConfigured: 5,
  statesActive: 1,
  statesBlocked: 4,
  statesWithData: 1,
  states: [
    { state: "TX", kind: "download", status: "done", note: null, producers: 963880, lastError: null },
    { state: "WA", kind: "blocked", status: "blocked", note: "No free bulk source <fortress>", producers: 0, lastError: null },
    { state: "CA", kind: "download", status: "error", note: null, producers: 0, lastError: "boom & fail" },
  ],
};

test("buildReport subject summarizes producers and active/configured states", () => {
  const { subject } = buildReport(progress);
  assert.match(subject, /Hushh Insurance Directory/);
  assert.match(subject, /963,880 producers/);
  assert.match(subject, /1\/5 states active/);
});

test("buildReport html renders per-state rows, the blocked note, and the error", () => {
  const { html } = buildReport(progress);
  assert.match(html, />TX</);
  assert.match(html, />WA</);
  assert.match(html, />CA</);
  assert.match(html, /No free bulk source/); // blocked note surfaces
  assert.match(html, /boom/); // error state surfaces its last error
});

test("buildReport HTML-escapes untrusted note/error text", () => {
  const { html } = buildReport(progress);
  assert.match(html, /&lt;fortress&gt;/);
  assert.ok(!html.includes("<fortress>"), "raw angle brackets must not leak into HTML");
  assert.match(html, /boom &amp; fail/);
});
