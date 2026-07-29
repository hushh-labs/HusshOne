/* Reliability primitives for Local Discovery's paid/external calls: per-provider token-bucket rate limits,
   per-provider circuit breakers, per-call timeouts, bounded exponential backoff, and a concurrency
   semaphore. Providers wrap every outbound call in `guardedCall(providerKey, fn, …)` so a flaky or
   rate-limited provider is contained (breaker opens → we skip it and degrade to seed/cache) rather than
   dragging the whole search down.

   Like the spend ledger, breaker/bucket state lives on `globalThis` — per-instance, which is the correct
   scope for rate limiting and breaking against a specific process's own call stream. */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(providerKey: string) {
    super(`circuit open for ${providerKey}`);
    this.name = "CircuitOpenError";
  }
}

export class RateLimitedError extends Error {
  constructor(providerKey: string) {
    super(`rate limited for ${providerKey}`);
    this.name = "RateLimitedError";
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Classic token bucket: `capacity` tokens, refilled at `refillPerSec`. Non-blocking `tryRemove`. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  tryRemove(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

type BreakerState = "closed" | "open" | "half_open";

/** Trips to `open` after `threshold` consecutive failures; after `cooldownMs` it allows a single
 *  half-open trial, closing on success or re-opening on failure. */
export class CircuitBreaker {
  private failures = 0;
  private state: BreakerState = "closed";
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  canRequest(): boolean {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half_open";
        return true;
      }
      return false;
    }
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  get isOpen(): boolean {
    return this.state === "open" && Date.now() - this.openedAt < this.cooldownMs;
  }
}

/** Bounded FIFO semaphore for concurrency control. `acquire()` resolves to a release fn. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Timeout + retry
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reject with `TimeoutError` if `p` doesn't settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  /** Return false to stop retrying a particular error (e.g. a 4xx that won't self-heal). */
  shouldRetry?: (error: unknown) => boolean;
}

/** Bounded exponential backoff with 25% jitter. Never retries more than `retries` times. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseMs = 200, maxMs = 2000, shouldRetry = () => true } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) throw error;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      await sleep(backoff + Math.random() * backoff * 0.25);
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-provider registry + guardedCall
// ---------------------------------------------------------------------------

export interface ProviderPolicy {
  /** Token-bucket capacity (burst). */
  bucketCapacity: number;
  /** Token-bucket refill per second (sustained rate). */
  bucketRefillPerSec: number;
  /** Consecutive failures before the breaker opens. */
  breakerThreshold: number;
  /** Breaker cooldown before a half-open trial. */
  breakerCooldownMs: number;
}

const DEFAULT_POLICY: ProviderPolicy = {
  bucketCapacity: 10,
  bucketRefillPerSec: 5,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
};

interface ProviderRuntime {
  bucket: TokenBucket;
  breaker: CircuitBreaker;
}

interface ReliabilityGlobal {
  providers: Map<string, ProviderRuntime>;
}

const rg = globalThis as typeof globalThis & { __oneLdReliability?: ReliabilityGlobal };
function reliabilityStore(): ReliabilityGlobal {
  if (!rg.__oneLdReliability) rg.__oneLdReliability = { providers: new Map() };
  return rg.__oneLdReliability;
}

function runtimeFor(providerKey: string, policy: ProviderPolicy): ProviderRuntime {
  const s = reliabilityStore();
  let rt = s.providers.get(providerKey);
  if (!rt) {
    rt = {
      bucket: new TokenBucket(policy.bucketCapacity, policy.bucketRefillPerSec),
      breaker: new CircuitBreaker(policy.breakerThreshold, policy.breakerCooldownMs),
    };
    s.providers.set(providerKey, rt);
  }
  return rt;
}

export interface GuardedCallOptions {
  timeoutMs?: number;
  retries?: number;
  policy?: Partial<ProviderPolicy>;
  shouldRetry?: (error: unknown) => boolean;
}

/** Run `fn` under the provider's rate limit, circuit breaker, timeout, and bounded retry.
 *  Throws `RateLimitedError` / `CircuitOpenError` / `TimeoutError` (or `fn`'s own error) — callers treat
 *  any throw as "this provider is unavailable right now, degrade gracefully". */
export async function guardedCall<T>(
  providerKey: string,
  fn: () => Promise<T>,
  options: GuardedCallOptions = {},
): Promise<T> {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const { timeoutMs = 2500, retries = 1, shouldRetry } = options;
  const rt = runtimeFor(providerKey, policy);

  if (!rt.breaker.canRequest()) throw new CircuitOpenError(providerKey);
  if (!rt.bucket.tryRemove(1)) throw new RateLimitedError(providerKey);

  try {
    const result = await retry(() => withTimeout(fn(), timeoutMs, providerKey), { retries, shouldRetry });
    rt.breaker.onSuccess();
    return result;
  } catch (error) {
    rt.breaker.onFailure();
    throw error;
  }
}

/** TEST-ONLY: clear all breaker/bucket state. */
export function __resetReliabilityForTests(): void {
  reliabilityStore().providers.clear();
}
