// Regression tests for the request-plumbing controls.
//
// Every case here failed against the shipped implementation. They are written as the ABUSE,
// not as the happy path, because that is the direction each control exists to hold.

import { test } from "node:test";
import assert from "node:assert/strict";

import { clientIp, statusForError, DailyCap, UpstreamBudget, selectHydrationTargets } from "./http.mjs";
import { RateLimiter } from "./rate-limit.mjs";

const req = (xff, socket = "10.0.0.1") => ({
  headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  socket: { remoteAddress: socket },
});

// ---------------------------------------------------------------------------
// F3 — X-Forwarded-For spoofing reset both rate limits
// ---------------------------------------------------------------------------

test("clientIp: reads the RIGHTMOST hop, which is the one our own proxy appended", () => {
  // What Cloud Run actually delivers when a caller sends `X-Forwarded-For: 1.1.1.1`:
  // the front end APPENDS the address it saw, so the attacker's value is on the LEFT.
  assert.equal(clientIp(req("1.1.1.1, 203.0.113.9"), 1), "203.0.113.9");
  // The old implementation read [0] and would have returned "1.1.1.1" here.
  assert.notEqual(clientIp(req("1.1.1.1, 203.0.113.9"), 1), "1.1.1.1");
});

test("clientIp: rotating the spoofed prefix does NOT change the identity", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(clientIp(req(`198.51.100.${i}, 203.0.113.9`), 1));
  assert.deepEqual([...seen], ["203.0.113.9"], "one real caller must produce exactly one identity");
});

test("clientIp: trustedProxyCount 2 skips a load balancer's own entry", () => {
  // GCLB in front of Cloud Run: client, then the LB's address, then our peer.
  assert.equal(clientIp(req("1.1.1.1, 203.0.113.9, 35.191.0.7"), 2), "203.0.113.9");
});

test("clientIp: trustedProxyCount 0 ignores the header completely", () => {
  assert.equal(clientIp(req("1.1.1.1, 2.2.2.2"), 0), "10.0.0.1");
});

test("clientIp: a header shorter than the trusted chain is not trusted", () => {
  // Fewer hops than we expect means it did not come through the proxies we think it did.
  assert.equal(clientIp(req("1.1.1.1"), 2), "10.0.0.1");
  assert.equal(clientIp(req(undefined), 1), "10.0.0.1");
  assert.equal(clientIp(req(""), 1), "10.0.0.1");
});

test("clientIp: a repeated header arriving as an array is still read from the right", () => {
  assert.equal(clientIp(req(["1.1.1.1", "2.2.2.2, 203.0.113.9"]), 1), "203.0.113.9");
});

test("clientIp: never returns an empty identity", () => {
  assert.equal(clientIp({ headers: {}, socket: {} }, 1), "unknown");
  assert.equal(clientIp({}, 1), "unknown");
});

test("F3 end to end: 15 requests with rotating XFF now spend one bucket, not fifteen", () => {
  const limiter = new RateLimiter({ perMinute: 30, burst: 10 });
  const now = Date.now();
  let allowed = 0;
  let refused = 0;
  for (let i = 0; i < 15; i += 1) {
    const request = req(`198.51.100.${i}, 203.0.113.9`);
    const result = limiter.take(clientIp(request, 1), now);
    if (result.ok) allowed += 1;
    else refused += 1;
  }
  assert.equal(allowed, 10, "the burst capacity, and not one request more");
  assert.equal(refused, 5);

  // And the shipped behaviour, for contrast: reading [0] gave every request its own bucket.
  const old = new RateLimiter({ perMinute: 30, burst: 10 });
  let oldAllowed = 0;
  for (let i = 0; i < 15; i += 1) {
    const forwarded = String(`198.51.100.${i}, 203.0.113.9`).split(",")[0].trim();
    if (old.take(forwarded, now).ok) oldAllowed += 1;
  }
  assert.equal(oldAllowed, 15, "documents the bug this test locks closed");
});

test("F3 end to end: the DAILY cap is spoof-proof too", () => {
  const cap = new DailyCap(3);
  const now = Date.parse("2026-08-06T12:00:00Z");
  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(cap.take(`ip:${clientIp(req(`198.51.100.${i}, 203.0.113.9`), 1)}`, now).ok);
  }
  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(cap.status.trackedIdentities, 1);
});

// ---------------------------------------------------------------------------
// F5 — every non-QueryError became a 502
// ---------------------------------------------------------------------------

test("statusForError: honours a typed upstream status", () => {
  assert.equal(statusForError(Object.assign(new Error("no such CRD"), { status: 404 })), 404);
  assert.equal(statusForError(Object.assign(new Error("bad crd"), { status: 400 })), 400);
  assert.equal(statusForError(Object.assign(new Error("throttled"), { status: 429 })), 429);
});

test("statusForError: a QueryError is always 400", () => {
  assert.equal(statusForError(new Error("whatever"), { isQueryError: true }), 400);
  // Even if it somehow carries a status of its own.
  assert.equal(statusForError(Object.assign(new Error("x"), { status: 503 }), { isQueryError: true }), 400);
});

test("statusForError: an unclassified failure is still 502", () => {
  assert.equal(statusForError(new Error("socket hang up")), 502);
  assert.equal(statusForError(Object.assign(new Error("x"), { status: 0 })), 502);
  assert.equal(statusForError(Object.assign(new Error("x"), { status: 200 })), 502);
  assert.equal(statusForError(Object.assign(new Error("x"), { status: 600 })), 502);
  assert.equal(statusForError(null), 502);
});

// ---------------------------------------------------------------------------
// F6 — unbounded upstream fan-out on detail=true
// ---------------------------------------------------------------------------

test("UpstreamBudget: refuses the call that would overspend, and keeps counting", () => {
  const budget = new UpstreamBudget(3);
  assert.equal(budget.take(1), true);
  assert.equal(budget.take(1), true);
  assert.equal(budget.take(1), true);
  assert.equal(budget.take(1), false);
  assert.equal(budget.spent, 3);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.exhausted, true);
  assert.equal(budget.status.denied, 1);
});

test("UpstreamBudget: a block charge is all-or-nothing", () => {
  const budget = new UpstreamBudget(5);
  assert.equal(budget.take(6), false, "a 6-call chain must not half-run inside a budget of 5");
  assert.equal(budget.spent, 0);
  assert.equal(budget.take(5), true);
});

test("UpstreamBudget: status is JSON-safe when unlimited", () => {
  const budget = new UpstreamBudget();
  assert.equal(budget.take(9999), true);
  assert.deepEqual(JSON.parse(JSON.stringify(budget.status)), {
    limit: null,
    spent: 9999,
    remaining: null,
    denied: 0,
    exhausted: false,
  });
});

test("selectHydrationTargets: caps at config, not at the caller's limit", () => {
  const candidates = Array.from({ length: 50 }, (_, i) => ({ individualCrd: i + 1 }));
  const plan = selectHydrationTargets(candidates, { max: 10 });
  assert.equal(plan.targets.length, 10, "the shipped code fanned out all 50");
  assert.equal(plan.capped, true);
});

test("selectHydrationTargets: skips candidates with no CRD instead of fetching them", () => {
  // A Schedule A officer has no IAPD record. The old code called getIndividual(null) and
  // handed the caller the internal validation message as `profileError`.
  const candidates = [{ individualCrd: null, name: "A" }, { individualCrd: 7, name: "B" }, { individualCrd: 0, name: "C" }];
  const plan = selectHydrationTargets(candidates, { max: 10 });
  assert.deepEqual(plan.targets.map((c) => c.name), ["B"]);
  assert.deepEqual(plan.skipped.map((c) => c.name), ["A", "C"]);
});

test("selectHydrationTargets: a spent budget shrinks the plan below the config max", () => {
  const budget = new UpstreamBudget(12);
  budget.take(10); // the Places chain and the roster pages already ran
  const candidates = Array.from({ length: 20 }, (_, i) => ({ individualCrd: i + 1 }));
  const plan = selectHydrationTargets(candidates, { max: 10, budget });
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.capped, true);
});

// ---------------------------------------------------------------------------
// DailyCap, unchanged behaviour that must stay unchanged
// ---------------------------------------------------------------------------

test("DailyCap: resets at the UTC day boundary and drops its memory", () => {
  const cap = new DailyCap(1);
  const day1 = Date.parse("2026-08-06T23:59:59Z");
  const day2 = Date.parse("2026-08-07T00:00:00Z");
  assert.equal(cap.take("a", day1).ok, true);
  assert.equal(cap.take("a", day1).ok, false);
  assert.equal(cap.take("a", day2).ok, true);
  assert.equal(cap.status.trackedIdentities, 1);
});
