import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyInternalJobRequest: vi.fn(),
  selectStaleArchiveRefreshTargets: vi.fn(async (): Promise<unknown[]> => []),
  enqueueSocialRefreshJobs: vi.fn(async () => 1),
}));

vi.mock("@/lib/auth/internal", () => ({
  verifyInternalJobRequest: mocks.verifyInternalJobRequest,
  InternalAuthError: class extends Error {},
}));
vi.mock("@/lib/db/scan-store", () => ({
  selectStaleArchiveRefreshTargets: mocks.selectStaleArchiveRefreshTargets,
  enqueueSocialRefreshJobs: mocks.enqueueSocialRefreshJobs,
}));

import { POST } from "./route";

function req(headers: Record<string, string> = { authorization: "Bearer t" }): Request {
  return new Request("https://one.hushh.ai/api/internal/social-refresh-sweep", { method: "POST", headers });
}

type EnqueueArg = { firebaseUid: string; jobs: Array<{ platform: string; publicId: string; metadata: { refresh?: boolean; maxPosts?: number; url?: string } }> };
const firstEnqueue = (): EnqueueArg => (vi.mocked(mocks.enqueueSocialRefreshJobs).mock.calls[0] as unknown[])[0] as EnqueueArg;

describe("POST /api/internal/social-refresh-sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyInternalJobRequest.mockReturnValue(undefined);
  });

  it("401s on an invalid internal token (no work done)", async () => {
    mocks.verifyInternalJobRequest.mockImplementationOnce(() => {
      throw new Error("Unauthorized");
    });
    const res = await POST(req({ authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
    expect(mocks.selectStaleArchiveRefreshTargets).not.toHaveBeenCalled();
  });

  it("enqueues refresh:true deep jobs for each stale user", async () => {
    mocks.selectStaleArchiveRefreshTargets.mockResolvedValueOnce([
      { firebaseUid: "u1", jobs: [{ platform: "instagram", publicId: "a", url: "https://www.instagram.com/a/" }, { platform: "x", publicId: "a", url: "https://x.com/a" }] },
      { firebaseUid: "u2", jobs: [{ platform: "threads", publicId: "b", url: "https://www.threads.com/@b" }] },
    ]);

    const res = await POST(req());
    const json = (await res.json()) as { ok: boolean; swept: number; candidates: number };

    expect(json).toMatchObject({ ok: true, swept: 2, candidates: 2 });
    expect(mocks.enqueueSocialRefreshJobs).toHaveBeenCalledTimes(2);
    const arg = firstEnqueue();
    expect(arg.firebaseUid).toBe("u1");
    expect(arg.jobs[0].metadata).toMatchObject({ refresh: true, maxPosts: 240, url: "https://www.instagram.com/a/" });
  });

  it("returns swept:0 when nothing is stale", async () => {
    mocks.selectStaleArchiveRefreshTargets.mockResolvedValueOnce([]);

    const res = await POST(req());
    const json = (await res.json()) as { swept: number };

    expect(json.swept).toBe(0);
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });
});
