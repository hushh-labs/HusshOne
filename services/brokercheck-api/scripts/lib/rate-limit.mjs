// Per-IP token bucket. This is what stands in for an API key on a public endpoint: the
// service stays open to consumers while remaining useless as a free proxy onto FINRA.
//
// Pure and time-injectable, so it unit-tests without sleeping.

export class RateLimiter {
  #buckets = new Map();

  constructor({ perMinute = 30, burst = 10, maxKeys = 20_000 } = {}) {
    this.refillPerMs = perMinute / 60_000;
    this.capacity = Math.max(burst, 1);
    this.maxKeys = maxKeys;
  }

  take(key, now = Date.now()) {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      // Cheap bound on memory: a flood of unique IPs must not grow this without limit.
      if (this.#buckets.size >= this.maxKeys) this.#evictStale(now);
      bucket = { tokens: this.capacity, updated: now };
      this.#buckets.set(key, bucket);
    }

    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updated) * this.refillPerMs);
    bucket.updated = now;

    if (bucket.tokens < 1) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000)) };
    }
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  /** Drop buckets that have refilled to capacity — they carry no state worth keeping. */
  #evictStale(now) {
    const fullAfterMs = this.capacity / this.refillPerMs;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updated >= fullAfterMs) this.#buckets.delete(key);
    }
    // Still full? Evict oldest-touched until there is room.
    if (this.#buckets.size >= this.maxKeys) {
      const sorted = [...this.#buckets.entries()].sort((a, b) => a[1].updated - b[1].updated);
      for (let i = 0; i < Math.ceil(sorted.length / 4); i++) this.#buckets.delete(sorted[i][0]);
    }
  }

  get size() {
    return this.#buckets.size;
  }
}
