import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  RateLimitedError,
  Semaphore,
  TimeoutError,
  TokenBucket,
  __resetReliabilityForTests,
  guardedCall,
  retry,
  withTimeout,
} from "./reliability";

describe("local-discovery/reliability", () => {
  beforeEach(() => {
    __resetReliabilityForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("TokenBucket", () => {
    it("allows up to capacity then refuses until refill", () => {
      vi.useFakeTimers();
      const b = new TokenBucket(2, 1); // 2 burst, 1/sec
      expect(b.tryRemove()).toBe(true);
      expect(b.tryRemove()).toBe(true);
      expect(b.tryRemove()).toBe(false);
      vi.advanceTimersByTime(1000); // +1 token
      expect(b.tryRemove()).toBe(true);
      expect(b.tryRemove()).toBe(false);
    });
  });

  describe("CircuitBreaker", () => {
    it("opens after threshold failures and blocks requests", () => {
      const cb = new CircuitBreaker(3, 10_000);
      expect(cb.canRequest()).toBe(true);
      cb.onFailure();
      cb.onFailure();
      expect(cb.isOpen).toBe(false);
      cb.onFailure(); // 3rd -> open
      expect(cb.isOpen).toBe(true);
      expect(cb.canRequest()).toBe(false);
    });

    it("half-opens after cooldown and closes on success", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker(1, 5_000);
      cb.onFailure(); // open
      expect(cb.canRequest()).toBe(false);
      vi.advanceTimersByTime(5_000);
      expect(cb.canRequest()).toBe(true); // half-open trial allowed
      cb.onSuccess();
      expect(cb.isOpen).toBe(false);
    });
  });

  describe("Semaphore", () => {
    it("bounds concurrency to max and drains the queue in order", async () => {
      const sem = new Semaphore(2);
      const order: number[] = [];
      const run = async (id: number) => {
        const release = await sem.acquire();
        order.push(id);
        await Promise.resolve();
        release();
      };
      await Promise.all([run(1), run(2), run(3), run(4)]);
      expect(order).toEqual([1, 2, 3, 4]);
    });
  });

  describe("withTimeout", () => {
    it("resolves when the promise settles in time", async () => {
      await expect(withTimeout(Promise.resolve("ok"), 50, "t")).resolves.toBe("ok");
    });
    it("rejects with TimeoutError when it doesn't", async () => {
      const slow = new Promise((r) => setTimeout(r, 50));
      await expect(withTimeout(slow, 5, "slow")).rejects.toBeInstanceOf(TimeoutError);
    });
  });

  describe("retry", () => {
    it("retries up to the bound then succeeds", async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
        return "done";
      });
      await expect(retry(fn, { retries: 3, baseMs: 1, maxMs: 2 })).resolves.toBe("done");
      expect(calls).toBe(3);
    });

    it("throws after exhausting retries", async () => {
      const fn = vi.fn(async () => {
        throw new Error("always");
      });
      await expect(retry(fn, { retries: 2, baseMs: 1, maxMs: 2 })).rejects.toThrow("always");
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("stops early when shouldRetry returns false", async () => {
      const fn = vi.fn(async () => {
        throw new Error("fatal");
      });
      await expect(retry(fn, { retries: 5, baseMs: 1, shouldRetry: () => false })).rejects.toThrow("fatal");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("guardedCall", () => {
    it("returns the result on success", async () => {
      await expect(guardedCall("p1", async () => 42, { retries: 0 })).resolves.toBe(42);
    });

    it("throws RateLimitedError once the bucket is drained", async () => {
      const policy = { bucketCapacity: 1, bucketRefillPerSec: 0 };
      await guardedCall("p2", async () => "a", { retries: 0, policy });
      await expect(guardedCall("p2", async () => "b", { retries: 0, policy })).rejects.toBeInstanceOf(
        RateLimitedError,
      );
    });

    it("opens the breaker after repeated failures and then short-circuits", async () => {
      const policy = { breakerThreshold: 2, bucketCapacity: 100, bucketRefillPerSec: 100 };
      const boom = async () => {
        throw new Error("provider down");
      };
      await expect(guardedCall("p3", boom, { retries: 0, policy })).rejects.toThrow("provider down");
      await expect(guardedCall("p3", boom, { retries: 0, policy })).rejects.toThrow("provider down");
      // breaker now open -> next call short-circuits without invoking fn
      const fn = vi.fn(async () => "ok");
      await expect(guardedCall("p3", fn, { retries: 0, policy })).rejects.toBeInstanceOf(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
