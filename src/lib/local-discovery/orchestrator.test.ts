import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the infra-bound + heavy layers so the orchestrator's fan-out logic is tested in isolation.
vi.mock("./location", () => ({ resolveLocation: vi.fn() }));
vi.mock("./adapters", () => ({ adaptersForCountry: vi.fn(() => []) }));
vi.mock("./cache", () => ({
  searchCacheKey: vi.fn((input: { category: string }) => `${input.category}:key`),
  getCachedSearch: vi.fn(() => null),
  setCachedSearch: vi.fn(),
}));
// Merge + rank are identity here so we assert orchestration, not their internals (covered by their own suites).
vi.mock("./merge", () => ({ dedupeAndMerge: vi.fn((p: unknown[]) => p) }));
vi.mock("./rank", () => ({ rankProfiles: vi.fn((p: unknown[]) => p) }));

import { V1InputError } from "@/lib/api/v1-input";
import { adaptersForCountry } from "./adapters";
import { getCachedSearch, setCachedSearch } from "./cache";
import { resolveLocation } from "./location";
import { RequestBudget } from "./spend";
import { DISCOVERY_CATEGORIES } from "./types";
import type {
  DiscoveryAdapterResult,
  DiscoveryCategory,
  DiscoveryEvent,
  LocalDiscoveryAdapter,
  UnifiedProfile,
} from "./types";
import {
  __resetSessionsForTests,
  createDiscoverySearch,
  ensureSearchStarted,
  getDiscoverySession,
  parseDiscoverySearchInput,
  searchParamsToBody,
  streamPathForQuery,
  subscribeToSession,
  type DiscoverySession,
} from "./orchestrator";

const mockResolve = vi.mocked(resolveLocation);
const mockAdapters = vi.mocked(adaptersForCountry);
const mockGetCached = vi.mocked(getCachedSearch);
const mockSetCached = vi.mocked(setCachedSearch);

function resolvedLocation(overrides: Record<string, unknown> = {}) {
  return {
    lat: 47.68,
    lng: -122.2,
    radiusMeters: 5000,
    countryCode: "US",
    city: "Kirkland",
    state: "WA",
    postalCode: "98033",
    approximateOrigin: false,
    precision: "rooftop",
    resolvedFrom: "coordinates",
    warnings: [],
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof resolveLocation>>;
}

function profile(id: string): UnifiedProfile {
  return { id, name: id } as unknown as UnifiedProfile;
}

function fakeAdapter(category: DiscoveryCategory, result: Partial<DiscoveryAdapterResult>): LocalDiscoveryAdapter {
  const full: DiscoveryAdapterResult = {
    category,
    profiles: [],
    warnings: [],
    sourcesUsed: [],
    degraded: false,
    ...result,
  };
  return {
    category,
    supportedCountries: "all",
    search: vi.fn(async () => full),
  } as unknown as LocalDiscoveryAdapter;
}

function throwingAdapter(category: DiscoveryCategory, message: string): LocalDiscoveryAdapter {
  return {
    category,
    supportedCountries: "all",
    search: vi.fn(async () => {
      throw new Error(message);
    }),
  } as unknown as LocalDiscoveryAdapter;
}

/** Run a session to completion, capturing every emitted event in order. */
async function runToCompletion(session: DiscoverySession): Promise<DiscoveryEvent[]> {
  const events: DiscoveryEvent[] = [];
  subscribeToSession(session, (e) => events.push(e));
  ensureSearchStarted(session);
  await vi.waitFor(() => expect(session.done).toBe(true));
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionsForTests();
  mockResolve.mockResolvedValue(resolvedLocation());
  mockAdapters.mockReturnValue([]);
  mockGetCached.mockReturnValue(null);
});

describe("orchestrator — input parsing", () => {
  it("defaults categories to all and warns on unknown ones", () => {
    const p = parseDiscoverySearchInput({ categories: "hotels,spaceships" });
    expect(p.categories).toEqual(["hotels"]);
    expect(p.warnings.some((w) => /spaceships/.test(w))).toBe(true);

    // Asserted against the registry rather than a literal list, so adding a category doesn't fail here.
    const empty = parseDiscoverySearchInput({});
    expect(empty.categories).toEqual([...DISCOVERY_CATEGORIES]);
    expect(empty.categories).toContain("ria");
    expect(empty.categories).toContain("insurance");
  });

  it("clamps limit and falls back to a valid sort", () => {
    expect(parseDiscoverySearchInput({ limit: 999 }).limit).toBe(50);
    expect(parseDiscoverySearchInput({ limit: 0 }).limit).toBe(1);
    expect(parseDiscoverySearchInput({ limit: 12 }).limit).toBe(12);
    expect(parseDiscoverySearchInput({ sort: "weird" }).sort).toBe("recommended");
    expect(parseDiscoverySearchInput({ sort: "nearest" }).sort).toBe("nearest");
  });

  it("parses filters from both nested and flattened forms", () => {
    const nested = parseDiscoverySearchInput({ filters: { minRating: 4.5, openNow: true, query: "peds" } });
    expect(nested.filters).toEqual({ minRating: 4.5, openNow: true, query: "peds" });

    const flat = parseDiscoverySearchInput({ minRating: "4", openNow: "true", subcategories: "a,b" });
    expect(flat.filters).toEqual({ minRating: 4, openNow: true, subcategories: ["a", "b"] });
  });

  it("searchParamsToBody feeds parseDiscoverySearchInput", () => {
    const sp = new URLSearchParams("lat=1&lng=2&categories=hotels&openNow=true&country=US");
    const body = searchParamsToBody(sp);
    const parsed = parseDiscoverySearchInput(body);
    expect(parsed.location.latitude).toBe("1");
    expect(parsed.location.countryCode).toBe("US");
    expect(parsed.categories).toEqual(["hotels"]);
    expect(parsed.filters.openNow).toBe(true);
  });
});

describe("orchestrator — createDiscoverySearch", () => {
  it("resolves the location with a shared budget and registers the session", async () => {
    const { session, query, warnings } = await createDiscoverySearch({
      latitude: 47.68,
      longitude: -122.2,
      countryCode: "US",
      categories: "hotels,healthcare",
    });

    expect(session.searchId).toBeTruthy();
    expect(query.resolvedFrom).toBe("coordinates");
    expect(query.categories).toEqual(["hotels", "healthcare"]);
    expect(getDiscoverySession(session.searchId)).toBe(session);
    expect(warnings).toEqual([]);

    // Location resolution shares the ONE per-request budget instance.
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 47.68, longitude: -122.2 }),
      expect.any(RequestBudget),
      expect.any(Number),
    );
    expect(mockResolve.mock.calls[0][1]).toBe(session.budget);
  });

  it("carries location + parse warnings into the prelude", async () => {
    mockResolve.mockResolvedValue(resolvedLocation({ warnings: ["approximate location"] }));
    const { session, warnings } = await createDiscoverySearch({ postalCode: "98033", countryCode: "US", categories: "nope" });
    expect(warnings).toContain("approximate location");
    expect(warnings.some((w) => /nope/.test(w))).toBe(true);
    expect(session.preludeWarnings).toEqual(warnings);
  });

  it("propagates a V1InputError from location resolution (no session created)", async () => {
    mockResolve.mockRejectedValue(new V1InputError("bad coords", 400, "bad_coordinates"));
    await expect(createDiscoverySearch({ latitude: 999 })).rejects.toBeInstanceOf(V1InputError);
  });

  it("honors a provided searchId (SSE rebuild path)", async () => {
    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2 }, { searchId: "fixed-id" });
    expect(session.searchId).toBe("fixed-id");
    expect(getDiscoverySession("fixed-id")).toBe(session);
  });
});

describe("orchestrator — fan-out", () => {
  it("emits the full progressive event sequence and maps degraded status", async () => {
    mockAdapters.mockReturnValue([
      fakeAdapter("hotels", { profiles: [profile("h1")], warnings: ["w1"], sourcesUsed: ["directory"], degraded: false }),
      fakeAdapter("healthcare", { profiles: [profile("d1")], sourcesUsed: ["registry"], degraded: true }),
    ]);

    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2, countryCode: "US" });
    const events = await runToCompletion(session);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("search_started");
    expect(types.filter((t) => t === "category_started")).toHaveLength(2);
    expect(types.at(-1)).toBe("search_complete");

    const hotels = events.find((e) => e.type === "category_results" && e.category === "hotels");
    const health = events.find((e) => e.type === "category_results" && e.category === "healthcare");
    expect(hotels && hotels.type === "category_results" && hotels.status).toBe("done");
    expect(health && health.type === "category_results" && health.status).toBe("degraded");

    const complete = events.find((e) => e.type === "search_complete");
    expect(complete && complete.type === "search_complete" && complete.count).toBe(2);
    expect(mockSetCached).toHaveBeenCalledTimes(2);
  });

  it("isolates an adapter failure: category_error, but the search still completes with the others", async () => {
    mockAdapters.mockReturnValue([
      fakeAdapter("hotels", { profiles: [profile("h1")] }),
      throwingAdapter("healthcare", "provider down"),
    ]);

    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2, countryCode: "US" });
    const events = await runToCompletion(session);

    const err = events.find((e) => e.type === "category_error" && e.category === "healthcare");
    expect(err && err.type === "category_error" && err.error).toMatch(/provider down/);

    const complete = events.find((e) => e.type === "search_complete");
    expect(complete && complete.type === "search_complete" && complete.count).toBe(1); // only hotels survived
    expect(session.done).toBe(true);
  });

  it("serves a category from cache without calling the adapter", async () => {
    const hotels = fakeAdapter("hotels", { profiles: [profile("live")] });
    mockAdapters.mockReturnValue([hotels]);
    mockGetCached.mockImplementation((key: string) => (key.startsWith("hotels") ? [profile("cached")] : null));

    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2, countryCode: "US", categories: "hotels" });
    const events = await runToCompletion(session);

    expect(hotels.search).not.toHaveBeenCalled();
    const results = events.find((e) => e.type === "category_results" && e.category === "hotels");
    expect(results && results.type === "category_results" && results.warnings).toContain("served from cache");
  });

  it("surfaces a category_error for a requested category that has no adapter for the country", async () => {
    mockAdapters.mockReturnValue([fakeAdapter("hotels", { profiles: [profile("h1")] })]); // healthcare dropped

    const { session } = await createDiscoverySearch({
      latitude: 1,
      longitude: 2,
      countryCode: "IN",
      categories: "hotels,healthcare",
    });
    const events = await runToCompletion(session);

    const drop = events.find((e) => e.type === "category_error" && e.category === "healthcare");
    expect(drop).toBeTruthy();
  });

  it("threads the ONE shared budget through every adapter", async () => {
    const hotels = fakeAdapter("hotels", { profiles: [profile("h1")] });
    mockAdapters.mockReturnValue([hotels]);

    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2, countryCode: "US", categories: "hotels" });
    await runToCompletion(session);

    const searchMock = hotels.search as unknown as ReturnType<typeof vi.fn>;
    const ctxArg = searchMock.mock.calls[0][0];
    expect(ctxArg.budget).toBe(session.budget);
    expect(mockResolve.mock.calls[0][1]).toBe(session.budget);
  });

  it("runs the fan-out exactly once no matter how many times it is triggered", async () => {
    const hotels = fakeAdapter("hotels", { profiles: [profile("h1")] });
    mockAdapters.mockReturnValue([hotels]);

    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2, countryCode: "US", categories: "hotels" });
    ensureSearchStarted(session);
    ensureSearchStarted(session);
    await vi.waitFor(() => expect(session.done).toBe(true));

    expect(hotels.search).toHaveBeenCalledTimes(1);
  });

  it("still emits a terminal search_complete if the whole fan-out throws", async () => {
    mockAdapters.mockImplementation(() => {
      throw new Error("catastrophic");
    });

    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2, countryCode: "US" });
    const events = await runToCompletion(session);

    const complete = events.find((e) => e.type === "search_complete");
    expect(complete && complete.type === "search_complete" && complete.count).toBe(0);
    expect(complete && complete.type === "search_complete" && complete.warnings.some((w) => /catastrophic/.test(w))).toBe(true);
  });
});

describe("orchestrator — session registry + helpers", () => {
  it("returns null for an unknown session id", () => {
    expect(getDiscoverySession("nope")).toBeNull();
  });

  it("buffers events for replay (a late subscriber still sees everything via the buffer)", async () => {
    mockAdapters.mockReturnValue([fakeAdapter("hotels", { profiles: [profile("h1")] })]);
    const { session } = await createDiscoverySearch({ latitude: 1, longitude: 2, countryCode: "US", categories: "hotels" });
    ensureSearchStarted(session);
    await vi.waitFor(() => expect(session.done).toBe(true));

    // Buffer holds the whole sequence for a stream that attaches after completion.
    expect(session.events[0].type).toBe("search_started");
    expect(session.events.at(-1)?.type).toBe("search_complete");
  });

  it("streamPathForQuery encodes the resolved query for cross-instance reattachment", async () => {
    const { session, query } = await createDiscoverySearch({
      latitude: 47.68,
      longitude: -122.2,
      countryCode: "US",
      categories: "hotels",
    });
    const path = streamPathForQuery(session.searchId, query);
    expect(path).toContain(`/api/local-discovery/search/${session.searchId}/events?`);
    expect(path).toContain("lat=47.68");
    expect(path).toContain("categories=hotels");
    expect(path).toContain("country=US");
  });
});
