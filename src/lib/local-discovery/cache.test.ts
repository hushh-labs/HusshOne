import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCacheForTests,
  cacheSnapshot,
  getCachedEntity,
  getCachedSearch,
  searchCacheKey,
  setCachedEntity,
  setCachedSearch,
} from "./cache";
import type { UnifiedProfile } from "./types";

function profile(id: string): UnifiedProfile {
  return {
    id,
    category: "hotels",
    name: `Place ${id}`,
    externalIds: {},
    sources: [{ kind: "google_places", label: "Google" }],
    provenance: {},
    qualityScore: 80,
    quality: "standard",
    distanceApproximate: false,
    approximateLocation: false,
    fetchedAt: new Date(0).toISOString(),
  };
}

describe("local-discovery/cache", () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => {
    vi.useRealTimers();
    __resetCacheForTests();
  });

  describe("searchCacheKey", () => {
    it("is stable for equivalent inputs and folds nearby coords / radii into one bucket", () => {
      const a = searchCacheKey({ countryCode: "us", lat: 47.6801, lng: -122.2087, radiusMeters: 5000, category: "hotels" });
      const b = searchCacheKey({ countryCode: "US", lat: 47.68013, lng: -122.20872, radiusMeters: 5100, category: "hotels" });
      expect(a).toBe(b);
    });

    it("differs by category and filters", () => {
      const base = { countryCode: "US", lat: 47.68, lng: -122.2, radiusMeters: 5000 } as const;
      expect(searchCacheKey({ ...base, category: "hotels" })).not.toBe(searchCacheKey({ ...base, category: "healthcare" }));
      expect(searchCacheKey({ ...base, category: "hotels" })).not.toBe(
        searchCacheKey({ ...base, category: "hotels", filters: { minRating: 4 } }),
      );
    });

    it("is order-independent for subcategories", () => {
      const base = { countryCode: "US", lat: 47.68, lng: -122.2, radiusMeters: 5000, category: "healthcare" } as const;
      expect(searchCacheKey({ ...base, filters: { subcategories: ["a", "b"] } })).toBe(
        searchCacheKey({ ...base, filters: { subcategories: ["b", "a"] } }),
      );
    });
  });

  describe("search + entity cache", () => {
    it("stores and returns a search result and warms the entity cache", () => {
      const key = searchCacheKey({ countryCode: "US", lat: 47.68, lng: -122.2, radiusMeters: 5000, category: "hotels" });
      expect(getCachedSearch(key)).toBeNull();
      setCachedSearch(key, [profile("hotels:1"), profile("hotels:2")]);
      expect(getCachedSearch(key)).toHaveLength(2);
      // setCachedSearch warms entities:
      expect(getCachedEntity("hotels:1")?.name).toBe("Place hotels:1");
    });

    it("expires entries after the TTL", () => {
      vi.useFakeTimers();
      setCachedEntity(profile("hotels:9"));
      expect(getCachedEntity("hotels:9")).not.toBeNull();
      vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1); // just past 6h entity TTL
      expect(getCachedEntity("hotels:9")).toBeNull();
    });

    it("evicts the least-recently-used entity beyond the cap", () => {
      vi.stubEnv("LOCAL_DISCOVERY_ENTITY_CACHE_MAX", "2");
      __resetCacheForTests();
      setCachedEntity(profile("hotels:1"));
      setCachedEntity(profile("hotels:2"));
      getCachedEntity("hotels:1"); // touch 1 -> 2 becomes LRU
      setCachedEntity(profile("hotels:3")); // evicts 2
      expect(getCachedEntity("hotels:1")).not.toBeNull();
      expect(getCachedEntity("hotels:2")).toBeNull();
      expect(getCachedEntity("hotels:3")).not.toBeNull();
      vi.unstubAllEnvs();
    });

    it("reports a snapshot", () => {
      setCachedEntity(profile("hotels:1"));
      const snap = cacheSnapshot();
      expect(snap.entityEntries).toBe(1);
      expect(snap.config.searchTtlMs).toBeGreaterThan(0);
    });
  });
});
