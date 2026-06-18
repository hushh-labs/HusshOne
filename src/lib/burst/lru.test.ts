import { describe, expect, it } from "vitest";
import { BoundedLru } from "./lru";

describe("BoundedLru", () => {
  it("stores and retrieves values", () => {
    const lru = new BoundedLru<string, number>(3);
    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
    expect(lru.has("a")).toBe(true);
    expect(lru.size).toBe(1);
  });

  it("never grows beyond maxSize (the memory-bound guarantee)", () => {
    const lru = new BoundedLru<number, number>(100);
    for (let i = 0; i < 10_000; i += 1) lru.set(i, i);
    expect(lru.size).toBe(100);
  });

  it("evicts the least-recently-used entry first", () => {
    const lru = new BoundedLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a"); // touch "a" → "b" is now LRU
    lru.set("c", 3); // evicts "b"
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
  });

  it("refreshes recency when an existing key is re-set", () => {
    const lru = new BoundedLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10); // re-set "a" → "b" becomes LRU
    lru.set("c", 3); // evicts "b"
    expect(lru.get("a")).toBe(10);
    expect(lru.has("b")).toBe(false);
  });

  it("supports delete and clear", () => {
    const lru = new BoundedLru<string, number>(3);
    lru.set("a", 1);
    expect(lru.delete("a")).toBe(true);
    expect(lru.delete("a")).toBe(false);
    lru.set("b", 2);
    lru.clear();
    expect(lru.size).toBe(0);
  });

  it("rejects a nonsensical capacity", () => {
    expect(() => new BoundedLru(0)).toThrow();
  });
});
