import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDevApiRequest: vi.fn(() => ({ keyId: "acme" })),
  recoverScan: vi.fn(),
  getResearchJob: vi.fn(),
  readDevPreferences: vi.fn(),
}));

vi.mock("@/lib/auth/dev-api", () => ({
  verifyDevApiRequest: mocks.verifyDevApiRequest,
  apiOwnerUid: (keyId: string) => `api:${keyId}`,
  DevApiAuthError: class extends Error {},
}));
vi.mock("@/lib/research/recover", () => ({ recoverScan: mocks.recoverScan }));
vi.mock("@/lib/db/scan-store", () => ({ getResearchJob: mocks.getResearchJob }));
vi.mock("@/lib/api/v1-preferences", () => ({ readDevPreferences: mocks.readDevPreferences }));

import { GET, OPTIONS } from "./route";

const SUNDAR_RESULT = { scanRunId: "scan-1", summary: "Sundar Pichai — CEO of Google & Alphabet.", report: "# Dossier\n…", categories: {} };
const SUNDAR_PREFS = { status: "completed" as const, profile: { questionCoverage: { answered: 26, inferred: 3 }, lifestyle: { topBrands: [{ value: "Google", count: 9 }] } } };

function req() {
  return new Request("https://one.hushh.ai/api/v1/scan/scan-1/stream", { headers: { authorization: "Bearer sk_test" } });
}
const ctx = { params: Promise.resolve({ id: "scan-1" }) };

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyDevApiRequest.mockReturnValue({ keyId: "acme" });
  mocks.getResearchJob.mockResolvedValue({ status: "running", input: { name: "Sundar Pichai", socialProfiles: [{ platform: "X" }] }, normalizedResult: null });
  // Research completes on the first advance → the loop terminates in one iteration (no 6s wait).
  mocks.recoverScan.mockResolvedValue({ httpStatus: 200, body: { ok: true, status: "completed", result: SUNDAR_RESULT } });
  mocks.readDevPreferences.mockResolvedValue(SUNDAR_PREFS);
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/v1/scan/[id]/stream (SSE)", () => {
  it("streams start → dossier → preferences → done, terminating cleanly", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const frames = parseSse(await res.text());
    const events = frames.map((f) => f.event);
    expect(events[0]).toBe("start");
    expect(events).toContain("dossier");
    expect(events).toContain("preferences");
    expect(events.at(-1)).toBe("done");

    const dossier = frames.find((f) => f.event === "dossier")!.data as { result: { summary: string } };
    expect(dossier.result.summary).toContain("Sundar Pichai");
    const done = frames.find((f) => f.event === "done")!.data as { scan: unknown; preferences: { status: string; profile: { lifestyle: unknown } } };
    expect(done.preferences.status).toBe("completed");
    expect(done.preferences.profile.lifestyle).toBeTruthy();
    // dossier must precede done
    expect(events.indexOf("dossier")).toBeLessThan(events.indexOf("done"));
  });

  it("emits a terminal error when research fails", async () => {
    mocks.recoverScan.mockResolvedValue({ httpStatus: 200, body: { ok: false, status: "failed", error: "Deep Research could not complete" } });
    const frames = parseSse(await (await GET(req(), ctx)).text());
    const err = frames.find((f) => f.event === "error");
    expect(err).toBeTruthy();
    expect((err!.data as { code: string }).code).toBe("research_failed");
    expect(frames.at(-1)!.event).toBe("error");
  });

  it("401 (JSON, not SSE) when the API key is missing/invalid", async () => {
    mocks.verifyDevApiRequest.mockImplementation(() => {
      throw new Error("Invalid developer API key");
    });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("404 when the scan isn't owned by this key", async () => {
    mocks.getResearchJob.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_found" });
  });

  it("OPTIONS preflight is 204", () => {
    expect(OPTIONS().status).toBe(204);
  });
});
