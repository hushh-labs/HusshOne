import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimSocialRefreshJobs: vi.fn(async (): Promise<unknown[]> => []),
  completeSocialRefreshJob: vi.fn(async () => undefined),
  failSocialRefreshJob: vi.fn(async () => undefined),
  enqueueSocialRefreshJobs: vi.fn(async () => 1),
  indexSocialArchive: vi.fn(async () => ({ contentItems: 0, mediaAssets: 0, perPlatform: {} })),
  scrapeInstagram: vi.fn(),
  scrapeThreads: vi.fn(),
  scrapeX: vi.fn(),
}));

vi.mock("@/lib/auth/internal", () => ({ verifyInternalJobRequest: vi.fn(() => undefined) }));
vi.mock("@/lib/db/scan-store", () => ({
  claimSocialRefreshJobs: mocks.claimSocialRefreshJobs,
  completeSocialRefreshJob: mocks.completeSocialRefreshJob,
  failSocialRefreshJob: mocks.failSocialRefreshJob,
  enqueueSocialRefreshJobs: mocks.enqueueSocialRefreshJobs,
  indexSocialArchive: mocks.indexSocialArchive,
  PREFERENCE_RECOMPUTE_PLATFORM: "__recompute__",
}));
vi.mock("@/lib/instagram/scraper-profile", () => ({ scrapeInstagramProfileUrl: mocks.scrapeInstagram }));
vi.mock("@/lib/threads/scraper-profile", () => ({ scrapeThreadsProfileUrl: mocks.scrapeThreads }));
vi.mock("@/lib/x/scraper-profile", () => ({ scrapeXProfileUrl: mocks.scrapeX }));
vi.mock("@/lib/social-intelligence/preference-profile", () => ({ PROFILE_VERSION: "test-profile-v" }));

import { POST } from "./route";

function req() {
  return new Request("http://localhost/api/internal/social-archive", { method: "POST", headers: { Authorization: "Bearer x" } });
}

function igJob(maxPosts: number) {
  return {
    id: "job-ig",
    firebaseUid: "uid-1",
    platform: "instagram",
    publicId: "ankit",
    metadata: { url: "https://www.instagram.com/ankit/", maxPosts, scanRunId: "scan-1" },
    attempts: 1,
  };
}

function igProfile(postCount: number, accountPosts: string | null) {
  return {
    status: "profile" as const,
    profile: {
      platform: "Instagram",
      username: "ankit",
      stats: { posts: accountPosts },
      recentPublicPosts: Array.from({ length: postCount }, (_, i) => ({ url: `https://www.instagram.com/p/${i}/` })),
    },
  };
}

type EnqueueArg = {
  jobs: Array<{ platform: string; publicId: string; metadata?: { maxPosts?: number }; resetAttempts?: boolean }>;
};
const enqueueArgs = (): EnqueueArg[] => vi.mocked(mocks.enqueueSocialRefreshJobs).mock.calls.map((c) => (c as unknown[])[0] as EnqueueArg);
const findEnqueue = (platform: string) => enqueueArgs().find((a) => a.jobs?.[0]?.platform === platform);

describe("POST /api/internal/social-archive — staged batched deep-scrape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.indexSocialArchive.mockResolvedValue({ contentItems: 0, mediaAssets: 0, perPlatform: {} });
  });

  it("grows the same job by +120 when the batch comes back full and the account has more", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(240, "900"));

    await POST(req());

    const grow = findEnqueue("instagram");
    expect(grow).toBeTruthy();
    expect(grow?.jobs[0]).toMatchObject({ platform: "instagram", publicId: "ankit", resetAttempts: true });
    expect(grow?.jobs[0]?.metadata?.maxPosts).toBe(360);
    // Re-enqueue re-arms the row → must NOT also complete it.
    expect(mocks.completeSocialRefreshJob).not.toHaveBeenCalled();
    // Preference recompute is always kicked.
    expect(findEnqueue("__recompute__")).toBeTruthy();
  });

  it("completes (no grow) when the account is exhausted (returned < requested − tolerance)", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(100, "900"));

    await POST(req());

    expect(findEnqueue("instagram")).toBeFalsy();
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-ig");
    expect(findEnqueue("__recompute__")).toBeTruthy();
  });

  it("completes (no grow) once the 1024 ceiling is requested", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(1024)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(1024, "5000"));

    await POST(req());

    expect(findEnqueue("instagram")).toBeFalsy();
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-ig");
  });

  it("stops early when the requested target already covers the account's total posts", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(240, "240")); // account has exactly 240

    await POST(req());

    expect(findEnqueue("instagram")).toBeFalsy();
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-ig");
  });

  it("applies the same staging to X (timelineItems)", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([
      { id: "job-x", firebaseUid: "uid-1", platform: "x", publicId: "ankit", metadata: { url: "https://x.com/ankit", maxPosts: 240, scanRunId: "scan-1" }, attempts: 1 },
    ]);
    mocks.scrapeX.mockResolvedValueOnce({
      status: "profile",
      profile: { platform: "X", username: "ankit", stats: { posts: "5000" }, timelineItems: Array.from({ length: 240 }, (_, i) => ({ id: String(i) })) },
    });

    await POST(req());

    const grow = findEnqueue("x");
    expect(grow?.jobs[0]?.metadata?.maxPosts).toBe(360);
    expect(grow?.jobs[0]?.resetAttempts).toBe(true);
    expect(mocks.completeSocialRefreshJob).not.toHaveBeenCalled();
  });

  it("fails the job (retry) when the scraper returns no profile", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce({ status: "access", profile: null });

    await POST(req());

    expect(mocks.failSocialRefreshJob).toHaveBeenCalledWith("job-ig", expect.any(String));
    expect(findEnqueue("instagram")).toBeFalsy();
    expect(mocks.completeSocialRefreshJob).not.toHaveBeenCalled();
  });
});
