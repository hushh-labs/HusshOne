import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveZipCentroid: vi.fn(),
  directorySummary: vi.fn(),
}));

// Only the DB-touching layers are mocked. The input validator (v1-directory), V1InputError, the
// hasDirectoryDb guard and the HTTP helpers all run for real — this route has NO auth to mock.
vi.mock("@/lib/directory/query", () => ({ resolveZipCentroid: mocks.resolveZipCentroid }));
vi.mock("@/lib/directory/summary", () => ({ directorySummary: mocks.directorySummary }));

import { GET, OPTIONS } from "./route";

const SUMMARY = {
  totals: { records: 42, verticals: 4 },
  verticals: [
    { vertical: "hotels", label: "Hotels", count: 12, sample: [] },
    { vertical: "healthcare", label: "Healthcare", count: 20, sample: [] },
    { vertical: "ria", label: "RIA firms", count: 6, sample: [] },
    { vertical: "insurance", label: "Insurance", count: 4, sample: [] },
  ],
  healthcareSpecialties: [{ specialty: "Family Medicine", count: 9 }],
  warnings: [],
};

// Distinct client IP per request so the in-memory per-IP rate limiter never trips across cases.
let ipSeq = 0;
function req(qs = ""): Request {
  ipSeq += 1;
  return new Request(`https://one.hushh.ai/api/localfinder${qs ? `?${qs}` : ""}`, {
    headers: { "x-forwarded-for": `10.0.0.${ipSeq}` },
  });
}

describe("GET /api/localfinder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DIRECTORIES_DB_HOST = "/cloudsql/proj:region:inst";
    process.env.DIRECTORIES_DB_USER = "directories_ro";
    process.env.DIRECTORIES_DB_PASSWORD = "pw";
    mocks.resolveZipCentroid.mockResolvedValue({ lat: 47.6, lng: -122.3 });
    mocks.directorySummary.mockResolvedValue(SUMMARY);
  });

  it("returns the summary for explicit coordinates", async () => {
    const res = await GET(req("lat=47.68&lng=-122.21&radius=5000"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      query: Record<string, unknown>;
      totals: { records: number };
      healthcareSpecialties: unknown[];
    };
    expect(json.ok).toBe(true);
    expect(json.query).toMatchObject({ lat: 47.68, lng: -122.21, radiusM: 5000, resolvedFrom: "coordinates" });
    expect(json.totals.records).toBe(42);
    expect(json.healthcareSpecialties).toHaveLength(1);
    // never leaks a zip field on the coordinate path
    expect(json.query).not.toHaveProperty("zip");
  });

  it("resolves a zip to its centroid when no coordinates are given", async () => {
    const res = await GET(req("zip=98033"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { query: { resolvedFrom: string; zip: string; lat: number } };
    expect(json.query.resolvedFrom).toBe("zip");
    expect(json.query.zip).toBe("98033");
    expect(json.query.lat).toBe(47.6);
    expect(mocks.resolveZipCentroid).toHaveBeenCalledWith("98033");
  });

  it("400 unknown_zip when the zip cannot be resolved", async () => {
    mocks.resolveZipCentroid.mockResolvedValueOnce(null);
    const res = await GET(req("zip=00000"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "unknown_zip" });
    expect(mocks.directorySummary).not.toHaveBeenCalled();
  });

  it("400 missing_coordinates when neither coords nor zip are given", async () => {
    const res = await GET(req("radius=1000"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "missing_coordinates" });
    expect(mocks.directorySummary).not.toHaveBeenCalled();
  });

  it("400 bad_coordinates on out-of-range latitude", async () => {
    const res = await GET(req("lat=999&lng=0"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_coordinates" });
    expect(mocks.directorySummary).not.toHaveBeenCalled();
  });

  it("503 when the directory database is not configured", async () => {
    delete process.env.DIRECTORIES_DB_HOST;
    delete process.env.DIRECTORIES_DB_USER;
    delete process.env.DIRECTORIES_DB_PASSWORD;
    const res = await GET(req("lat=1&lng=2"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "directory_unavailable" });
    expect(mocks.directorySummary).not.toHaveBeenCalled();
  });

  it("passes only the requested verticals through to the summary", async () => {
    await GET(req("lat=47.68&lng=-122.21&verticals=hotels,healthcare"));
    const passed = mocks.directorySummary.mock.calls[0]?.[1];
    expect([...(passed as string[])].sort()).toEqual(["healthcare", "hotels"]);
  });

  it("maps an unexpected summary failure to 502 directory_query_failed", async () => {
    mocks.directorySummary.mockRejectedValueOnce(new Error("pool exploded"));
    const res = await GET(req("lat=47.68&lng=-122.21"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "directory_query_failed" });
  });

  it("OPTIONS preflight is 204 with CORS allowing GET", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
