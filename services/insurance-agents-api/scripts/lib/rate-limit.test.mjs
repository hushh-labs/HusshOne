import test from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rate-limit.mjs";

test("allows a burst up to capacity, then refuses", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 3 });
  const t = 1_000_000;
  assert.equal(limiter.take("a", t).ok, true);
  assert.equal(limiter.take("a", t).ok, true);
  assert.equal(limiter.take("a", t).ok, true);
  const denied = limiter.take("a", t);
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1);
});

test("refills over time", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 2 }); // 1 token/sec
  const t = 1_000_000;
  limiter.take("a", t);
  limiter.take("a", t);
  assert.equal(limiter.take("a", t).ok, false);
  assert.equal(limiter.take("a", t + 1_100).ok, true);
});

test("buckets are per-key — one noisy IP cannot starve another", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 1 });
  const t = 1_000_000;
  assert.equal(limiter.take("a", t).ok, true);
  assert.equal(limiter.take("a", t).ok, false);
  assert.equal(limiter.take("b", t).ok, true);
});

test("never accumulates beyond capacity while idle", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 2 });
  const t = 1_000_000;
  limiter.take("a", t);
  // A long idle period must not bank unlimited tokens.
  limiter.take("a", t + 10 * 60_000);
  assert.equal(limiter.take("a", t + 10 * 60_000).ok, true);
  assert.equal(limiter.take("a", t + 10 * 60_000).ok, false);
});

test("key table stays bounded under a flood of unique IPs", () => {
  const limiter = new RateLimiter({ perMinute: 600, burst: 5, maxKeys: 50 });
  for (let i = 0; i < 500; i++) limiter.take(`ip-${i}`, 1_000_000 + i * 1000);
  assert.ok(limiter.size <= 50, `expected <= 50 buckets, got ${limiter.size}`);
});
