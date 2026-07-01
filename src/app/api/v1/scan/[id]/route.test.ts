import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDevApiRequest: vi.fn(() => ({ keyId: "acme" })),
  recoverScan: vi.fn(),
  getResearchJob: vi.fn(),
}));

vi.mock("@/lib/auth/dev-api", () => ({
  verifyDevApiRequest: mocks.verifyDevApiRequest,
  apiOwnerUid: (keyId: string) => `api:${keyId}`,
  DevApiAuthError: class extends Error {},
}));
vi.mock("@/lib/research/recover", () => ({ recoverScan: mocks.recoverScan }));
vi.mock("@/lib/db/scan-store", () => ({ getResearchJob: mocks.getResearchJob }));

import { GET } from "./route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function req(headers: Record<string, string> = { authorization: "Bearer sk" }): Request {
  return new Request("https://one.hushh.ai/api/v1/scan/scan-1", { headers });
}

describe("GET /api/v1/scan/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyDevApiRequest.mockReturnValue({ keyId: "acme" });
  });

  it("returns the FULL native dossier result + scraped profiles + a top-level preferences block", async () => {
    mocks.recoverScan.mockResolvedValueOnce({
      httpStatus: 200,
      body: { ok: true, status: "completed", result: { report: "# Dossier", summary: "S" } },
    });
    // No socials/consent in the stored input → readDevPreferences resolves to "skipped" (no cross-subject read).
    mocks.getResearchJob.mockResolvedValueOnce({ input: { apiProfiles: { linkedin: { name: "Sundar" }, instagram: null, threads: null, x: null } } });

    const res = await GET(req(), ctx("scan-1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      status: string;
      profiles: Record<string, unknown>;
      result: Record<string, unknown>;
      preferences: { status: string; profile: unknown };
    };
    expect(json).toMatchObject({ ok: true, scanId: "scan-1", status: "completed" });
    expect((json.profiles.linkedin as { name: string }).name).toBe("Sundar");
    expect(json.result.report).toBe("# Dossier"); // full result, not stripped
    expect(json.preferences).toEqual({ status: "skipped", profile: null });
    // ownership scoped to the key's synthetic user
    expect(mocks.recoverScan).toHaveBeenCalledWith(expect.objectContaining({ uid: "api:acme", id: "scan-1" }));
  });

  it("404s for an unknown id / another key's scan", async () => {
    mocks.recoverScan.mockResolvedValueOnce({ httpStatus: 404, body: { ok: false, status: "unknown", result: null } });
    const res = await GET(req(), ctx("scan-x"));
    expect(res.status).toBe(404);
  });

  it("401s when the API key is invalid", async () => {
    mocks.verifyDevApiRequest.mockImplementationOnce(() => {
      throw new Error("Invalid or missing API key");
    });
    const res = await GET(req({ authorization: "Bearer bad" }), ctx("scan-1"));
    expect(res.status).toBe(401);
    expect(mocks.recoverScan).not.toHaveBeenCalled();
  });
});
