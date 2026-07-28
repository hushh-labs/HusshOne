import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDevApiRequest: vi.fn(() => ({ keyId: "acme" })),
  queryVertical: vi.fn(),
  resolveZipCentroid: vi.fn(),
}));

vi.mock("@/lib/auth/dev-api", () => ({
  verifyDevApiRequest: mocks.verifyDevApiRequest,
  apiOwnerUid: (keyId: string) => `api:${keyId}`,
}));
vi.mock("@/lib/directory/query", () => ({
  queryVertical: mocks.queryVertical,
  resolveZipCentroid: mocks.resolveZipCentroid,
}));

// The validator (v1-directory), V1InputError, the db guard (hasDirectoryDb), and the HTTP helpers are all
// used for real — only the auth + DB query layers are mocked.
import { GET, OPTIONS } from "./route";

type Row = {
  vertical: string;
  id: string;
  name: string;
  subtitle: string | null;
  distanceM: number;
  geoPrecision: string;
  lat: number | null;
  lng: number | null;
  fields: Record<string, unknown>;
};

function row(vertical: string, distanceM: number): Row {
  return {
    vertical,
    id: `${vertical}-1`,
    name: `${vertical} one`,
    subtitle: null,
    distanceM,
    geoPrecision: vertical === "hotels" ? "rooftop" : "zip_centroid",
    lat: 1,
    lng: 2,
    fields: {},
  };
}

// Distinct distances so a correct global sort interleaves verticals.
const DIST: Record<string, number> = { hotels: 300, healthcare: 100, ria: 500, insurance: 50 };

function req(qs = "", headers: Record<string, string> = { authorization: "Bearer sk" }): Request {
  return new Request(`https://one.hushh.ai/api/v1/directory${qs ? `?${qs}` : ""}`, { headers });
}

describe("GET /api/v1/directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DIRECTORIES_DB_HOST = "/cloudsql/proj:region:inst";
    process.env.DIRECTORIES_DB_USER = "directories_ro";
    process.env.DIRECTORIES_DB_PASSWORD = "pw";
    mocks.verifyDevApiRequest.mockReturnValue({ keyId: "acme" });
    mocks.queryVertical.mockImplementation(async (v: string) => ({ vertical: v, rows: [row(v, DIST[v])] }));
    mocks.resolveZipCentroid.mockResolvedValue({ lat: 47.6, lng: -122.3 });
  });

  it("merges all verticals and sorts by distance, nearest first", async () => {
    const res = await GET(req("lat=47.68&lng=-122.21"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; count: number; results: Row[]; query: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(4);
    expect(json.results.map((r) => r.vertical)).toEqual(["insurance", "healthcare", "hotels", "ria"]);
    const distances = json.results.map((r) => r.distanceM);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(json.query).toMatchObject({ lat: 47.68, lng: -122.21, radiusM: 5000, limit: 50, resolvedFrom: "coordinates" });
  });

  it("applies the global limit after merging", async () => {
    const res = await GET(req("lat=47.68&lng=-122.21&limit=2"));
    const json = (await res.json()) as { count: number; results: Row[] };
    expect(json.count).toBe(2);
    expect(json.results.map((r) => r.vertical)).toEqual(["insurance", "healthcare"]);
  });

  it("queries only the requested verticals", async () => {
    await GET(req("lat=47.68&lng=-122.21&verticals=hotels,ria"));
    const queried = mocks.queryVertical.mock.calls.map((c) => c[0]);
    expect(queried.sort()).toEqual(["hotels", "ria"]);
  });

  it("records a per-vertical failure as a warning without failing the request", async () => {
    mocks.queryVertical.mockImplementation(async (v: string) =>
      v === "ria" ? { vertical: v, rows: [], error: "boom" } : { vertical: v, rows: [row(v, DIST[v])] },
    );
    const res = await GET(req("lat=47.68&lng=-122.21"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { count: number; warnings: string[] };
    expect(json.count).toBe(3);
    expect(json.warnings.some((w) => w.includes("ria") && w.includes("boom"))).toBe(true);
  });

  it("echoes validator warnings (e.g. social excluded)", async () => {
    const res = await GET(req("lat=47.68&lng=-122.21&verticals=hotels,social"));
    const json = (await res.json()) as { warnings: string[] };
    expect(json.warnings.some((w) => w.includes("social"))).toBe(true);
  });

  it("resolves a zip to its centroid when coordinates are absent", async () => {
    const res = await GET(req("zip=98033"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { query: { resolvedFrom: string; zip: string; lat: number; lng: number } };
    expect(json.query.resolvedFrom).toBe("zip");
    expect(json.query.zip).toBe("98033");
    expect(json.query.lat).toBe(47.6);
    expect(mocks.resolveZipCentroid).toHaveBeenCalledWith("98033");
    // downstream queries run against the resolved centroid
    expect(mocks.queryVertical.mock.calls[0][1]).toMatchObject({ lat: 47.6, lng: -122.3 });
  });

  it("400 unknown_zip when the zip cannot be resolved", async () => {
    mocks.resolveZipCentroid.mockResolvedValueOnce(null);
    const res = await GET(req("zip=00000"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "unknown_zip" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("401 when the API key is invalid", async () => {
    mocks.verifyDevApiRequest.mockImplementationOnce(() => {
      throw new Error("Invalid or missing API key");
    });
    const res = await GET(req("lat=1&lng=2", { authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: "unauthorized" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("503 when the directory database is not configured", async () => {
    delete process.env.DIRECTORIES_DB_HOST;
    delete process.env.DIRECTORIES_DB_USER;
    delete process.env.DIRECTORIES_DB_PASSWORD;
    const res = await GET(req("lat=1&lng=2"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "directory_unavailable" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("400 bad_coordinates on out-of-range latitude", async () => {
    const res = await GET(req("lat=999&lng=0"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_coordinates" });
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });

  it("400 missing_coordinates when neither coords nor zip are given", async () => {
    const res = await GET(req("radius=1000"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "missing_coordinates" });
  });

  it("OPTIONS preflight is 204 with CORS allowing GET", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
