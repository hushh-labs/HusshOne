import assert from "node:assert/strict";
import test from "node:test";

import { RateLimiter, clientIp } from "./rate-limit.mjs";

test("a burst is allowed, then refused", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 3 });
  assert.equal(limiter.take("a", 0).ok, true);
  assert.equal(limiter.take("a", 0).ok, true);
  assert.equal(limiter.take("a", 0).ok, true);

  const refused = limiter.take("a", 0);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterSec >= 0);
});

test("tokens refill over time", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 1 });
  assert.equal(limiter.take("a", 0).ok, true);
  assert.equal(limiter.take("a", 0).ok, false);
  assert.equal(limiter.take("a", 1000).ok, true, "one token per second at 60/min");
});

test("clients are budgeted independently", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 1 });
  assert.equal(limiter.take("a", 0).ok, true);
  assert.equal(limiter.take("b", 0).ok, true);
  assert.equal(limiter.trackedClients, 2);
});

test("the client is read from the right of x-forwarded-for", () => {
  // A caller who prepends their own value must not be able to reset their budget.
  const request = {
    headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" },
    socket: { remoteAddress: "10.0.0.1" },
  };
  assert.equal(clientIp(request, 1), "3.3.3.3");
  assert.equal(clientIp(request, 2), "2.2.2.2");
});

test("with no forwarding header the socket address is used", () => {
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }, 1), "10.0.0.1");
});

test("a spoofed header cannot win a fresh budget", () => {
  const limiter = new RateLimiter({ perMinute: 60, burst: 1 });
  const attacker = { headers: { "x-forwarded-for": "9.9.9.9, 5.5.5.5" }, socket: {} };
  const rotated = { headers: { "x-forwarded-for": "8.8.8.8, 5.5.5.5" }, socket: {} };

  assert.equal(limiter.take(clientIp(attacker, 1), 0).ok, true);
  assert.equal(limiter.take(clientIp(rotated, 1), 0).ok, false,
    "rotating the leftmost hop must not reset the bucket");
});
