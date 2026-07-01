import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDevApiRequest: vi.fn(() => ({ keyId: "acme" })),
  buildV1ScanInput: vi.fn(),
  buildPersonDossierQuestion: vi.fn(() => "QUESTION"),
  startResearch: vi.fn(async () => ({ jobId: "job-1" })),
  upsertOneUser: vi.fn(async () => ({ id: "owner-1" })),
  createConsentAndScan: vi.fn(async (_input: { input: Record<string, unknown> }) => ({ scanRunId: "scan-1" })),
}));

vi.mock("@/lib/auth/dev-api", () => ({
  verifyDevApiRequest: mocks.verifyDevApiRequest,
  apiOwnerUid: (keyId: string) => `api:${keyId}`,
  DevApiAuthError: class extends Error {},
}));
vi.mock("@/lib/api/v1-input", () => ({
  buildV1ScanInput: mocks.buildV1ScanInput,
  V1InputError: class V1InputError extends Error {
    statusCode = 400;
    code = "bad_input";
  },
}));
vi.mock("@/lib/research/dossier", () => ({ buildPersonDossierQuestion: mocks.buildPersonDossierQuestion }));
vi.mock("@/lib/research/client", () => ({ startResearch: mocks.startResearch }));
vi.mock("@/lib/db/scan-store", () => ({ upsertOneUser: mocks.upsertOneUser, createConsentAndScan: mocks.createConsentAndScan }));

import { POST, OPTIONS } from "./route";

function req(body: unknown, headers: Record<string, string> = { authorization: "Bearer sk" }): Request {
  return new Request("https://one.hushh.ai/api/v1/scan", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /api/v1/scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyDevApiRequest.mockReturnValue({ keyId: "acme" });
    mocks.buildV1ScanInput.mockResolvedValue({
      input: { name: "Sundar", email: "s@e.com", latitude: 1, longitude: 2, purpose: "self_audit", consentAttestation: true },
      profiles: { linkedin: { name: "Sundar" }, instagram: null, threads: null, x: { username: "s" } },
    });
  });

  it("starts a scan and returns 202 with scanId + scraped profiles", async () => {
    const res = await POST(req({ name: "Sundar", email: "s@e.com", latitude: 1, longitude: 2, linkedinUrl: "…" }));
    expect(res.status).toBe(202);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, scanId: "scan-1", status: "running", statusUrl: "/api/v1/scan/scan-1" });
    expect((json.profiles as { linkedin: { name: string } }).linkedin.name).toBe("Sundar");
    // owner is the synthetic api:<keyId> user, scan input carries the DR job id + apiProfiles
    expect(mocks.upsertOneUser).toHaveBeenCalledWith(expect.objectContaining({ firebaseUid: "api:acme", provider: "api" }));
    const scanArg = mocks.createConsentAndScan.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(scanArg.input).toMatchObject({ deepResearchJobId: "job-1", apiKeyId: "acme" });
  });

  it("401s when the API key is invalid", async () => {
    mocks.verifyDevApiRequest.mockImplementationOnce(() => {
      throw new Error("Invalid or missing API key");
    });
    const res = await POST(req({}, { authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
    expect(mocks.createConsentAndScan).not.toHaveBeenCalled();
  });

  it("propagates a validation error as 400 without starting a scan", async () => {
    const { V1InputError } = await import("@/lib/api/v1-input");
    mocks.buildV1ScanInput.mockRejectedValueOnce(new V1InputError("`name` is required"));
    const res = await POST(req({ email: "s@e.com" }));
    expect(res.status).toBe(400);
    expect(mocks.startResearch).not.toHaveBeenCalled();
  });

  it("403 consent_required when consentAttestation is false — before any research starts", async () => {
    mocks.buildV1ScanInput.mockResolvedValueOnce({
      input: { name: "Sundar", email: "s@e.com", zipCode: "94040", purpose: "self_audit", consentAttestation: false },
      profiles: { linkedin: null, instagram: null, threads: null, x: null },
    });
    const res = await POST(req({ name: "Sundar", email: "s@e.com", zipCode: "94040", consentAttestation: false }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: "consent_required" });
    expect(mocks.startResearch).not.toHaveBeenCalled();
  });

  it("returns links{self,stream,preferences} on 202", async () => {
    const res = await POST(req({ name: "Sundar", email: "s@e.com", latitude: 1, longitude: 2 }));
    const json = (await res.json()) as { links?: { self: string; stream: string; preferences: string } };
    expect(json.links).toEqual({ self: "/api/v1/scan/scan-1", stream: "/api/v1/scan/scan-1/stream", preferences: "/api/v1/scan/scan-1/preferences" });
  });

  it("OPTIONS preflight is 204 with CORS", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
