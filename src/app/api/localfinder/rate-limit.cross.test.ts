import { beforeEach, describe, expect, it, vi } from "vitest";

/* Finding #3 regression: the summary route (GET /api/localfinder) and the paging route
   (GET /api/localfinder/rows) MUST share a single per-IP rate-limit budget, so a client can't
   sidestep the limit by alternating between the two endpoints. Both import the same
   @/lib/api/rate-limit module, so within this file's module graph they resolve to the same
   in-memory `hits` map — hammering one and then hitting the other from the SAME IP proves the
   shared window. The DB-touching layers are mocked; hasDirectoryDb runs for real off env. */

const mocks = vi.hoisted(() => ({
  directorySummary: vi.fn(),
  queryVertical: vi.fn(),
  resolveZipCentroid: vi.fn(),
}));

vi.mock("@/lib/directory/query", () => ({
  queryVertical: mocks.queryVertical,
  resolveZipCentroid: mocks.resolveZipCentroid,
}));
vi.mock("@/lib/directory/summary", () => ({
  directorySummary: mocks.directorySummary,
  toSampleRow: (row: { id: string; name: string }) => ({ id: row.id, name: row.name }),
}));

import { GET as summaryGET } from "./route";
import { GET as rowsGET } from "./rows/route";

// A single fixed IP shared by both routes for the whole budget-exhaustion sequence.
const IP = "203.0.113.77";
function summaryReq(qs: string): Request {
  return new Request(`https://one.hushh.ai/api/localfinder?${qs}`, {
    headers: { "x-forwarded-for": IP },
  });
}
function rowsReq(qs: string): Request {
  return new Request(`https://one.hushh.ai/api/localfinder/rows?${qs}`, {
    headers: { "x-forwarded-for": IP },
  });
}

describe("shared per-IP rate-limit budget across /api/localfinder and /rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DIRECTORIES_DB_HOST = "/cloudsql/proj:region:inst";
    process.env.DIRECTORIES_DB_USER = "directories_ro";
    process.env.DIRECTORIES_DB_PASSWORD = "pw";
    mocks.directorySummary.mockResolvedValue({
      totals: { records: 0, verticals: 0 },
      verticals: [],
      healthcareSpecialties: [],
      warnings: [],
    });
    mocks.queryVertical.mockResolvedValue({ vertical: "hotels", rows: [] });
  });

  it("rows request is 429'd once the summary route has spent the window from the same IP", async () => {
    // Default budget is 30 requests / 60s (trips on the 31st). Spend exactly 30 on the summary route.
    for (let i = 0; i < 30; i += 1) {
      const res = await summaryGET(summaryReq("lat=47.68&lng=-122.21&radius=5000"));
      expect(res.status).toBe(200);
    }
    // The 31st request from the SAME IP — this time on the OTHER route — must be rate-limited,
    // proving both routes draw from one shared budget rather than a per-route one.
    const res = await rowsGET(rowsReq("vertical=hotels&lat=47.68&lng=-122.21&radius=5000"));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false, code: "rate_limited" });
    // The over-budget request must never reach the DB layer.
    expect(mocks.queryVertical).not.toHaveBeenCalled();
  });
});
