/**
 * Per-client token bucket.
 *
 * The client is identified from x-forwarded-for, counting back exactly
 * TRUSTED_PROXY_COUNT hops from the right. Taking the leftmost value would let a
 * caller reset their own budget by sending a header, which is the usual way this
 * control is quietly defeated.
 */

export class RateLimiter {
  constructor({ perMinute = 30, burst = 10 } = {}) {
    this.capacity = burst;
    this.refillPerMs = perMinute / 60000;
    this.buckets = new Map();
  }

  take(key, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updated: now };
      this.buckets.set(key, bucket);
    }

    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.updated) * this.refillPerMs,
    );
    bucket.updated = now;

    if (bucket.tokens < 1) {
      return { ok: false, retryAfterSec: Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000) };
    }
    bucket.tokens -= 1;
    return { ok: true };
  }

  get trackedClients() {
    return this.buckets.size;
  }
}

export function clientIp(request, trustedProxyCount = 1) {
  const header = String(request.headers?.["x-forwarded-for"] || "");
  const hops = header.split(",").map((part) => part.trim()).filter(Boolean);
  if (hops.length === 0) return request.socket?.remoteAddress || "unknown";

  const index = Math.max(0, hops.length - trustedProxyCount);
  return hops[index] || hops[hops.length - 1];
}
