import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryVertical: vi.fn(),
  resolveZipCentroid: vi.fn(),
}));

// Only the DB-touching query layer is mocked. The input validator (v1-directory), V1InputError, the
// hasDirectoryDb guard, the vertical whitelist (DIRECTORY_VERTICALS) and the HTTP helpers all run for
// real — this public route has no auth to mock. toSampleRow is stubbed to a tiny identity mapper so the
// assertions target the route's paging/validation, not the (separately tested) detail enrichment.
vi.mock("@/lib/directory/query", () => ({
  queryVertical: mocks.queryVertical,
  resolveZipCentroid: mocks.resolveZipCentroid,
}));
vi.mock("@/lib/directory/summary", () => ({
  toSampleRow: (row: { id: string; name: string }) => ({ id: row.id, name: row.name }),
}));

import { GET, OPTIONS } from "./route";

const ROWS = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

// Distinct client IP per request so the shared in-memory per-IP rate limiter never trips across cases.
let ipSeq = 0;
function req(qs = ""): Request {
  ipSeq += 1;
  return new Request(`https://one.hushh.ai/api/localfinder/rows${qs ? `?${qs}` : ""}`, {
    headers: { "x-forwarded-for": `10.1.0.${ipSeq}` },
  });
}

/** The single `{ lat, lng, radiusM, limit, offset }` params object queryVertical was last called with. */
function lastParams(): Record<string, number> {
  return mocks.queryVertical.mock.calls[0]?.[1] as Record<string, number>;
}

describe("GET /api/localfinder/rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DIRECTORIES_DB_HOST = "/cloudsql/proj:region:inst";
    process.env.DIRECTORIES_DB_USER = "directories_ro";
    process.env.DIRECTORIES_DB_PASSWORD = "pw";
    mocks.resolveZipCentroid.mockResolvedValue({ lat: 47.6, lng: -122.3 });
    mocks.queryVertical.mockResolvedValue({ vertical: "healthcare", rows: ROWS });
  });

  it("returns page 0 (default page/pageSize) for explicit coordinates", async () => {
    const res = await GET(req("vertical=healthcare&lat=47.68&lng=-122.21&radius=5000"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      vertical: string;
      page: number;
      pageSize: number;
      rows: { id: string }[];
      query: Record<string, unknown>;
    };
    expect(json.ok).toBe(true);
    expect(json.vertical).toBe("healthcare");
    expect(json.page).toBe(0);
    expect(json.pageSize).toBe(10);
    expect(json.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(json.query).toMatchObject({ lat: 47.68, lng: -122.21, radiusM: 5000, resolvedFrom: "coordinates" });
    expect(json.query).not.toHaveProperty("zip");
    // default paging: offset 0, limit = default page size 10
    expect(lastParams()).toMatchObject({ lat: 47.68, lng: -122.21, radiusM: 5000, limit: 10, offset: 0 });
  });

  it("computes offset = page * pageSize", async () => {
    const res = await GET(req("vertical=healthcare&lat=1&lng=2&page=2&pageSize=10"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { page: number; pageSize: number };
    expect(json.page).toBe(2);
    expect(json.pageSize).toBe(10);
    expect(lastParams()).toMatchObject({ limit: 10, offset: 20 });
  });

  it("clamps pageSize to the max (50) and offsets by the clamped size", async () => {
    const res = await GET(req("vertical=hotels&lat=1&lng=2&page=1&pageSize=999"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pageSize: number };
    expect(json.pageSize).toBe(50);
    expect(lastParams()).toMatchObject({ limit: 50, offset: 50 });
  });

  it("falls back to the default pageSize when it is non-numeric", async () => {
    await GET(req("vertical=hotels&lat=1&lng=2&pageSize=abc"));
    expect(lastParams()).toMatchObject({ limit: 10, offset: 0 });
  });

  it("floors a negative page to 0", async () => {
    const res = await GET(req("vertical=hotels&lat=1&lng=2&page=-4"));
    const json = (await res.json()) as { page: number };
    expect(json.page).toBe(0);
    expect(lastParams()).toMatchObject({ offset: 0 });
  });

  it("400 bad_page when page exceeds the max (bounds the OFFSET walk)", async () => {
    const res = await GET(req("vertical=hotels&lat=1&lng=2&page=100000"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_page" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("400 bad_page when page is non-finite (1e309 → Infinity, never reaches pg)", async () => {
    const res = await GET(req("vertical=hotels&lat=1&lng=2&page=1e309"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_page" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("400 bad_vertical for an unsupported vertical", async () => {
    const res = await GET(req("vertical=social&lat=1&lng=2"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_vertical" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("400 bad_vertical when the vertical param is missing", async () => {
    const res = await GET(req("lat=1&lng=2"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_vertical" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("400 bad_coordinates on out-of-range latitude", async () => {
    const res = await GET(req("vertical=hotels&lat=999&lng=0"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_coordinates" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("400 missing_coordinates when neither coords nor zip are given", async () => {
    const res = await GET(req("vertical=hotels&radius=1000"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "missing_coordinates" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("resolves a zip to its centroid when no coordinates are given", async () => {
    const res = await GET(req("vertical=healthcare&zip=98033&page=1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { query: { resolvedFrom: string; zip: string; lat: number } };
    expect(json.query.resolvedFrom).toBe("zip");
    expect(json.query.zip).toBe("98033");
    expect(json.query.lat).toBe(47.6);
    expect(mocks.resolveZipCentroid).toHaveBeenCalledWith("98033");
    // paging still applies on the zip path
    expect(lastParams()).toMatchObject({ lat: 47.6, lng: -122.3, offset: 10 });
  });

  it("400 unknown_zip when the zip cannot be resolved", async () => {
    mocks.resolveZipCentroid.mockResolvedValueOnce(null);
    const res = await GET(req("vertical=healthcare&zip=00000"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "unknown_zip" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("503 when the directory database is not configured", async () => {
    delete process.env.DIRECTORIES_DB_HOST;
    delete process.env.DIRECTORIES_DB_USER;
    delete process.env.DIRECTORIES_DB_PASSWORD;
    const res = await GET(req("vertical=hotels&lat=1&lng=2"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "directory_unavailable" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("502 directory_query_failed when the vertical query reports an error", async () => {
    mocks.queryVertical.mockResolvedValueOnce({ vertical: "healthcare", rows: [], error: "boom" });
    const res = await GET(req("vertical=healthcare&lat=1&lng=2"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "directory_query_failed" });
  });

  it("502 directory_query_failed on an unexpected throw", async () => {
    mocks.queryVertical.mockRejectedValueOnce(new Error("pool exploded"));
    const res = await GET(req("vertical=healthcare&lat=1&lng=2"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "directory_query_failed" });
  });

  it("OPTIONS preflight is 204 with CORS allowing GET", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("429 once a single client IP exceeds the shared window", async () => {
    const hammer = () =>
      GET(
        new Request("https://one.hushh.ai/api/localfinder/rows?vertical=hotels&lat=1&lng=2", {
          headers: { "x-forwarded-for": "10.9.9.9" },
        }),
      );
    let sawLimited = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await hammer();
      if (res.status === 429) {
        expect(await res.json()).toMatchObject({ ok: false, code: "rate_limited" });
        sawLimited = true;
        break;
      }
    }
    expect(sawLimited).toBe(true);
  });
});
