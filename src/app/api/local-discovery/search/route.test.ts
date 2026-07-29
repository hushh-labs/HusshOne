import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the orchestration + spend layers. The HTTP envelope (http.ts), the real V1InputError class
// (v1-input.ts) and the in-memory rate limiter all run for real — this route has NO auth to mock, and we
// need the real V1InputError so the route's `instanceof` mapping is exercised end-to-end.
const mocks = vi.hoisted(() => ({
  createDiscoverySearch: vi.fn(),
  streamPathForQuery: vi.fn(() => "/api/local-discovery/search/s-1/events?lat=47.68&lng=-122.21"),
  spendSnapshot: vi.fn(() => ({
    day: "2026-07-29",
    totalUsd: 0,
    calls: 0,
    budgetUsd: 25,
    remainingUsd: 25,
    byProvider: {},
  })),
}));

vi.mock("@/lib/local-discovery/orchestrator", () => ({
  createDiscoverySearch: mocks.createDiscoverySearch,
  streamPathForQuery: mocks.streamPathForQuery,
}));
vi.mock("@/lib/local-discovery/spend", () => ({ spendSnapshot: mocks.spendSnapshot }));

import { V1InputError } from "@/lib/api/v1-input";
import type { ResolvedQuery } from "@/lib/local-discovery/types";
import { OPTIONS, POST } from "./route";

const QUERY: ResolvedQuery = {
  lat: 47.68,
  lng: -122.21,
  radiusMeters: 5000,
  countryCode: "US",
  approximateOrigin: false,
  categories: ["hotels", "healthcare"],
  limit: 20,
  sort: "recommended",
  filters: {},
  resolvedFrom: "coordinates",
};

// Distinct client IP per request so the shared in-memory per-IP limiter never trips across cases.
let ipSeq = 0;
function req(body: unknown, headers: Record<string, string> = {}): Request {
  ipSeq += 1;
  return new Request("https://one.hushh.ai/api/local-discovery/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.1.0.${ipSeq}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.streamPathForQuery.mockReturnValue("/api/local-discovery/search/s-1/events?lat=47.68&lng=-122.21");
  mocks.spendSnapshot.mockReturnValue({
    day: "2026-07-29",
    totalUsd: 0,
    calls: 0,
    budgetUsd: 25,
    remainingUsd: 25,
    byProvider: {},
  });
  mocks.createDiscoverySearch.mockResolvedValue({
    session: { searchId: "s-1" },
    query: QUERY,
    warnings: ["unknown category \"foo\" ignored"],
  });
});

describe("POST /api/local-discovery/search", () => {
  it("202s with the searchId, resolved query, warnings, links and a spend snapshot", async () => {
    const res = await POST(req({ lat: 47.68, lng: -122.21 }));
    expect(res.status).toBe(202);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const json = (await res.json()) as {
      ok: boolean;
      searchId: string;
      query: ResolvedQuery;
      warnings: string[];
      links: { self: string; events: string; stream: string };
      spend: { budgetUsd: number };
    };
    expect(json.ok).toBe(true);
    expect(json.searchId).toBe("s-1");
    expect(json.query).toMatchObject({ lat: 47.68, lng: -122.21, resolvedFrom: "coordinates" });
    expect(json.warnings).toContain('unknown category "foo" ignored');
    expect(json.links.self).toBe("/api/local-discovery/search/s-1");
    expect(json.links.events).toBe("/api/local-discovery/search/s-1/events");
    expect(json.links.stream).toContain("/events?");
    expect(json.spend.budgetUsd).toBe(25);
  });

  it("passes the parsed JSON body straight through to createDiscoverySearch", async () => {
    await POST(req({ lat: 1, lng: 2, categories: "hotels" }));
    expect(mocks.createDiscoverySearch).toHaveBeenCalledWith({ lat: 1, lng: 2, categories: "hotels" });
  });

  it("tolerates a non-JSON body (falls back to an empty object)", async () => {
    await POST(req("not json at all"));
    expect(mocks.createDiscoverySearch).toHaveBeenCalledWith({});
  });

  it("429 rate_limited once a client IP is over budget", async () => {
    // Same IP across the whole burst so the shared limiter counts them together.
    const ip = "10.9.9.9";
    let last: Response | undefined;
    for (let i = 0; i < 32; i += 1) {
      last = await POST(
        new Request("https://one.hushh.ai/api/local-discovery/search", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ lat: 1, lng: 2 }),
        }),
      );
    }
    expect(last!.status).toBe(429);
    expect(await last!.json()).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("maps a V1InputError to its own status + code, preserving the safe message", async () => {
    mocks.createDiscoverySearch.mockRejectedValueOnce(
      new V1InputError("Provide latitude+longitude or postalCode+countryCode.", 400, "missing_location"),
    );
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "missing_location",
      error: "Provide latitude+longitude or postalCode+countryCode.",
    });
  });

  it("maps an unexpected failure to a generic 502 without leaking internal detail", async () => {
    mocks.createDiscoverySearch.mockRejectedValueOnce(new Error("geocoder pool exploded"));
    const res = await POST(req({ lat: 1, lng: 2 }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("discovery_search_failed");
    expect(json.error).toBe("Could not start discovery search");
    expect(json.error).not.toContain("pool exploded");
  });

  it("OPTIONS preflight is 204 with CORS allowing POST", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
