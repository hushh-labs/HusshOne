import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  verifyOneRequest: vi.fn(async () => ({ uid: "firebase-1", email: "u@example.com", name: "U", picture: null })),
  enqueueManualRefresh: vi.fn(
    async (): Promise<{ ok: boolean; alreadyRunning: boolean; platforms: string[]; recompute: boolean; reason: string }> => ({
      ok: true,
      alreadyRunning: false,
      platforms: ["instagram", "linkedin"],
      recompute: true,
      reason: "enqueued",
    }),
  ),
}));

vi.mock("@/lib/auth/verify", () => ({ verifyOneRequest: mocks.verifyOneRequest }));
vi.mock("@/lib/social-intelligence/connect-pipeline", () => ({ enqueueManualRefresh: mocks.enqueueManualRefresh }));

function request() {
  return new Request("http://localhost/api/one/preferences/refresh", { method: "POST", headers: { Authorization: "Bearer test" } });
}

describe("POST /api/one/preferences/refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("triggers a manual refresh for the verified user", async () => {
    const res = await POST(request());
    const json = (await res.json()) as { ok?: boolean; platforms?: string[]; recompute?: boolean };
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, platforms: ["instagram", "linkedin"], recompute: true });
    expect(mocks.enqueueManualRefresh).toHaveBeenCalledWith("firebase-1");
  });

  it("returns 200 with the benign result when nothing is connected", async () => {
    mocks.enqueueManualRefresh.mockResolvedValueOnce({ ok: false, alreadyRunning: false, platforms: [], recompute: false, reason: "nothing_connected" });
    const res = await POST(request());
    const json = (await res.json()) as { ok?: boolean; reason?: string };
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: false, reason: "nothing_connected" });
  });

  it("401s when auth fails", async () => {
    mocks.verifyOneRequest.mockRejectedValueOnce(Object.assign(new Error("nope"), { statusCode: 401 }));
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(mocks.enqueueManualRefresh).not.toHaveBeenCalled();
  });
});
