import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the orchestrator so no real fan-out, budget, or timers run. subscribeToSession/ensureSearchStarted
// are the only side-effecting hooks the stream uses; the real HTTP + SSE framing (http.ts) and the real
// V1InputError class run for real so the JSON-before-stream error path is exercised end-to-end.
const mocks = vi.hoisted(() => ({
  getDiscoverySession: vi.fn(),
  ensureSearchStarted: vi.fn(),
  subscribeToSession: vi.fn(() => () => {}),
  createDiscoverySearch: vi.fn(),
  searchParamsToBody: vi.fn(() => ({})),
}));

vi.mock("@/lib/local-discovery/orchestrator", () => ({
  getDiscoverySession: mocks.getDiscoverySession,
  ensureSearchStarted: mocks.ensureSearchStarted,
  subscribeToSession: mocks.subscribeToSession,
  createDiscoverySearch: mocks.createDiscoverySearch,
  searchParamsToBody: mocks.searchParamsToBody,
}));

import { V1InputError } from "@/lib/api/v1-input";
import type { DiscoveryEvent } from "@/lib/local-discovery/types";
import { GET, OPTIONS } from "./route";

/** A completed session whose event buffer ends in `search_complete` — pump() drains it and closes the
 *  stream synchronously during start(), so no timers need to fire for the body to resolve. */
function doneSession(searchId = "s-1") {
  const events: DiscoveryEvent[] = [
    { type: "search_started", searchId, query: {} as never },
    { type: "category_started", category: "hotels" },
    { type: "category_results", category: "hotels", profiles: [], status: "done", warnings: [] },
    { type: "search_complete", count: 0, results: [], warnings: ["all clear"] },
  ];
  return { searchId, events, done: true, listeners: new Set() };
}

/** Parse an SSE body into ordered { event, data } frames. */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? "";
      const dataLine = block.match(/^data: (.+)$/m)?.[1] ?? "null";
      return { event, data: JSON.parse(dataLine) };
    });
}

function req(searchId: string, qs = ""): Request {
  return new Request(`https://one.hushh.ai/api/local-discovery/search/${searchId}/events${qs ? `?${qs}` : ""}`);
}
function ctx(searchId: string) {
  return { params: Promise.resolve({ searchId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribeToSession.mockReturnValue(() => {});
});

describe("GET /api/local-discovery/search/[searchId]/events (SSE)", () => {
  it("replays a completed session's buffered frames and closes on search_complete", async () => {
    mocks.getDiscoverySession.mockReturnValue(doneSession("s-1"));

    const res = await GET(req("s-1"), ctx("s-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const frames = parseSse(await res.text());
    const events = frames.map((f) => f.event);
    expect(events[0]).toBe("search_started");
    expect(events).toContain("category_results");
    expect(events.at(-1)).toBe("search_complete");

    // The attach both subscribes and drives the (idempotent) fan-out.
    expect(mocks.subscribeToSession).toHaveBeenCalledOnce();
    expect(mocks.ensureSearchStarted).toHaveBeenCalledOnce();

    const complete = frames.find((f) => f.event === "search_complete")!.data as { warnings: string[] };
    expect(complete.warnings).toContain("all clear");
  });

  it("404 when the session is absent and the client carries no query params to rebuild from", async () => {
    mocks.getDiscoverySession.mockReturnValue(null);

    const res = await GET(req("missing"), ctx("missing"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ ok: false, code: "not_found" });
    expect(mocks.createDiscoverySearch).not.toHaveBeenCalled();
  });

  it("rebuilds an equivalent session from query params when absent on this instance (cross-instance fallback)", async () => {
    mocks.getDiscoverySession.mockReturnValue(null);
    mocks.searchParamsToBody.mockReturnValue({ lat: "47.68", lng: "-122.21" });
    mocks.createDiscoverySearch.mockResolvedValue({ session: doneSession("s-2"), query: {}, warnings: [] });

    const res = await GET(req("s-2", "lat=47.68&lng=-122.21"), ctx("s-2"));
    expect(res.status).toBe(200);
    expect(mocks.createDiscoverySearch).toHaveBeenCalledWith({ lat: "47.68", lng: "-122.21" }, { searchId: "s-2" });

    const events = parseSse(await res.text()).map((f) => f.event);
    expect(events.at(-1)).toBe("search_complete");
  });

  it("returns JSON (not a stream) when the rebuild fails validation", async () => {
    mocks.getDiscoverySession.mockReturnValue(null);
    mocks.searchParamsToBody.mockReturnValue({ lat: "999" });
    mocks.createDiscoverySearch.mockRejectedValue(new V1InputError("Latitude out of range.", 400, "bad_coordinates"));

    const res = await GET(req("s-3", "lat=999"), ctx("s-3"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_coordinates", error: "Latitude out of range." });
  });

  it("hides internal detail when the rebuild fails unexpectedly (502, generic message)", async () => {
    mocks.getDiscoverySession.mockReturnValue(null);
    mocks.searchParamsToBody.mockReturnValue({ lat: "1", lng: "2" });
    mocks.createDiscoverySearch.mockRejectedValue(new Error("geocoder pool exploded"));

    const res = await GET(req("s-4", "lat=1&lng=2"), ctx("s-4"));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; code: string; error: string };
    expect(json.code).toBe("discovery_search_failed");
    expect(json.error).not.toContain("pool exploded");
  });

  it("OPTIONS preflight is 204 with SSE/CORS headers", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
