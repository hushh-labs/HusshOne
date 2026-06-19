import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimSocialRefreshJobs: vi.fn(async (): Promise<unknown[]> => []),
  completeSocialRefreshJob: vi.fn(async () => undefined),
  failSocialRefreshJob: vi.fn(async () => undefined),
  enqueueSocialRefreshJobs: vi.fn(async () => 1),
  indexSocialArchive: vi.fn(async () => ({ contentItems: 0, mediaAssets: 0, perPlatform: {} })),
  upsertLinkedInConnection: vi.fn(async () => undefined),
  scrapeInstagram: vi.fn(),
  scrapeThreads: vi.fn(),
  scrapeX: vi.fn(),
  scrapeLinkedIn: vi.fn(),
}));

vi.mock("@/lib/auth/internal", () => ({ verifyInternalJobRequest: vi.fn(() => undefined) }));
vi.mock("@/lib/db/scan-store", () => ({
  claimSocialRefreshJobs: mocks.claimSocialRefreshJobs,
  completeSocialRefreshJob: mocks.completeSocialRefreshJob,
  failSocialRefreshJob: mocks.failSocialRefreshJob,
  enqueueSocialRefreshJobs: mocks.enqueueSocialRefreshJobs,
  indexSocialArchive: mocks.indexSocialArchive,
  upsertLinkedInConnection: mocks.upsertLinkedInConnection,
  PREFERENCE_RECOMPUTE_PLATFORM: "__recompute__",
}));
vi.mock("@/lib/instagram/scraper-profile", () => ({ scrapeInstagramProfileUrl: mocks.scrapeInstagram }));
vi.mock("@/lib/threads/scraper-profile", () => ({ scrapeThreadsProfileUrl: mocks.scrapeThreads }));
vi.mock("@/lib/x/scraper-profile", () => ({ scrapeXProfileUrl: mocks.scrapeX }));
vi.mock("@/lib/linkedin/scraper-profile", () => ({ scrapeLinkedInProfileUrl: mocks.scrapeLinkedIn }));
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

function igProfile(postCount: number, accountPosts: string | null, access?: { state?: string; canScrapePosts?: boolean }) {
  return {
    status: "profile" as const,
    profile: {
      platform: "Instagram",
      username: "ankit",
      stats: { posts: accountPosts },
      ...(access ? { access } : {}),
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

  it("completes (no grow) for a genuinely small account (returned ≈ account total)", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(100, "100")); // account only has ~100 posts

    await POST(req());

    expect(findEnqueue("instagram")).toBeFalsy();
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-ig");
    expect(mocks.failSocialRefreshJob).not.toHaveBeenCalled();
    expect(findEnqueue("__recompute__")).toBeTruthy();
  });

  it("completes (no grow) when returned is low and the account total is unknown (can't confirm more)", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(33, null)); // got 33, stats unparseable → accept

    await POST(req());

    expect(findEnqueue("instagram")).toBeFalsy();
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-ig");
    expect(mocks.failSocialRefreshJob).not.toHaveBeenCalled();
  });

  it("RETRIES (does not freeze) when the VM returns far fewer than the account clearly has", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(33, "900")); // account has 900, got 33 → throttle/degraded

    await POST(req());

    expect(mocks.failSocialRefreshJob).toHaveBeenCalledWith("job-ig", expect.stringContaining("retry for depth"));
    expect(mocks.completeSocialRefreshJob).not.toHaveBeenCalled();
    expect(findEnqueue("instagram")).toBeFalsy(); // no grow re-enqueue; backoff retry via failJob
  });

  it("RETRIES on a degraded session (0 posts / canScrapePosts:false) instead of completing", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([igJob(240)]);
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(0, null, { state: "public_visible", canScrapePosts: false }));

    await POST(req());

    expect(mocks.failSocialRefreshJob).toHaveBeenCalledWith("job-ig", expect.stringContaining("retry for depth"));
    expect(mocks.completeSocialRefreshJob).not.toHaveBeenCalled();
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

  it("refresh job: indexes + recomputes + completes, and NEVER grows the ladder", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([
      { id: "job-ig", firebaseUid: "uid-1", platform: "instagram", publicId: "ankit", metadata: { url: "https://www.instagram.com/ankit/", maxPosts: 240, scanRunId: "scan-1", refresh: true }, attempts: 1 },
    ]);
    // Full batch from a big account — WOULD trigger a grow if this weren't a refresh job.
    mocks.scrapeInstagram.mockResolvedValueOnce(igProfile(240, "900"));

    await POST(req());

    expect(findEnqueue("instagram")).toBeFalsy(); // no grow re-enqueue
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-ig");
    expect(findEnqueue("__recompute__")).toBeTruthy(); // recompute still kicked so new posts surface
  });

  function liJob() {
    return {
      id: "job-li",
      firebaseUid: "uid-1",
      platform: "linkedin",
      publicId: "ankit",
      metadata: { url: "https://www.linkedin.com/in/ankit" },
      attempts: 1,
    };
  }
  const richLi = {
    profile: {
      sub: "ankit",
      name: "Ankit",
      givenName: "Ankit",
      familyName: "K",
      email: null,
      emailVerified: false,
      locale: null,
      pictureUrl: null,
      profileUrl: "https://www.linkedin.com/in/ankit",
      headline: "Engineer",
      verifications: [],
      grantedScopes: [],
      source: "scraper",
      skills: ["AI"],
    },
    raw: {},
    normalizedUrl: "https://www.linkedin.com/in/ankit",
  };

  it("linkedin re-enrich: rich scrape → upserts the connection + completes (no index/recompute)", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([liJob()]);
    mocks.scrapeLinkedIn.mockResolvedValueOnce(richLi);

    await POST(req());

    expect(mocks.upsertLinkedInConnection).toHaveBeenCalledWith("uid-1", expect.objectContaining({ source: "scraper" }));
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-li");
    expect(mocks.indexSocialArchive).not.toHaveBeenCalled();
    expect(findEnqueue("__recompute__")).toBeFalsy();
    expect(mocks.failSocialRefreshJob).not.toHaveBeenCalled();
  });

  it("linkedin re-enrich: scraper down → retries (failJob), no upsert/complete", async () => {
    mocks.claimSocialRefreshJobs.mockResolvedValueOnce([liJob()]);
    mocks.scrapeLinkedIn.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await POST(req());

    expect(mocks.failSocialRefreshJob).toHaveBeenCalledWith("job-li", expect.stringContaining("linkedin re-enrich"));
    expect(mocks.upsertLinkedInConnection).not.toHaveBeenCalled();
    expect(mocks.completeSocialRefreshJob).not.toHaveBeenCalled();
  });
});
