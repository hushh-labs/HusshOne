import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEARCH_FIELD_MASK, hasPlacesProvider, searchPlaces } from "./places";
import { RequestBudget, __resetSpendLedgerForTests } from "../spend";
import { __resetReliabilityForTests } from "../reliability";

/* Regression coverage for the Places (New) search client.

   The bug this file guards against: `nextPageToken` in the `X-Goog-FieldMask` is REJECTED by
   places:searchNearby (HTTP 400 INVALID_ARGUMENT) — the default path — which was silently caught as
   `skipped:"error"`, killing live enrichment on every discovery search in production. */

const RAW_PLACE = {
  id: "places/ChIJ_test_1",
  displayName: { text: "Test Lodging" },
  formattedAddress: "1 Test St, Kirkland, WA 98033, USA",
  location: { latitude: 47.68, longitude: -122.2 },
  rating: 4.4,
  userRatingCount: 210,
  types: ["lodging"],
};

/** Capture the fetch call args so we can assert on endpoint + headers. */
function stubFetchOk(): { calls: Array<{ url: string; fieldMask: string }> } {
  const calls: Array<{ url: string; fieldMask: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), fieldMask: headers["X-Goog-FieldMask"] ?? "" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [RAW_PLACE] }),
        text: async () => "",
      } as Response;
    }),
  );
  return { calls };
}

describe("places search field mask", () => {
  beforeEach(() => {
    process.env.PLACES_API_KEY = "test-key";
    __resetSpendLedgerForTests();
    __resetReliabilityForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLACES_API_KEY;
  });

  it("never includes nextPageToken (invalid for Nearby Search / unused everywhere)", () => {
    expect(SEARCH_FIELD_MASK).not.toContain("nextPageToken");
  });

  it("hasPlacesProvider reflects the configured key", () => {
    expect(hasPlacesProvider()).toBe(true);
    delete process.env.PLACES_API_KEY;
    expect(hasPlacesProvider()).toBe(false);
  });

  it("default (no textQuery) hits Nearby Search with a mask free of nextPageToken", async () => {
    const { calls } = stubFetchOk();
    const out = await searchPlaces(
      { lat: 47.68, lng: -122.2, radiusMeters: 5000, includedTypes: ["lodging"], regionCode: "US" },
      new RequestBudget(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("places:searchNearby");
    expect(calls[0].fieldMask).not.toContain("nextPageToken");
    expect(out.skipped).toBeUndefined();
    expect(out.calls).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].name).toBe("Test Lodging");
  });

  it("free-text refine hits Text Search, also without nextPageToken", async () => {
    const { calls } = stubFetchOk();
    const out = await searchPlaces(
      { lat: 47.68, lng: -122.2, radiusMeters: 5000, includedTypes: ["lodging"], textQuery: "boutique" },
      new RequestBudget(),
    );

    expect(calls[0].url).toContain("places:searchText");
    expect(calls[0].fieldMask).not.toContain("nextPageToken");
    expect(out.results.length).toBeGreaterThanOrEqual(0);
  });

  it("degrades to skipped:error (never throws) on a provider 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "INVALID_ARGUMENT" }) as Response),
    );
    const out = await searchPlaces(
      { lat: 47.68, lng: -122.2, radiusMeters: 5000, includedTypes: ["lodging"] },
      new RequestBudget(),
    );
    expect(out.skipped).toBe("error");
    expect(out.results).toEqual([]);
  });
});
