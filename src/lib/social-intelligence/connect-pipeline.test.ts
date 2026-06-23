import { beforeEach, describe, expect, it, vi } from "vitest";

type EnqueueArg = {
  firebaseUid: string;
  jobs: Array<{ platform: string; publicId: string; metadata?: Record<string, unknown>; priority?: number }>;
};

const mocks = vi.hoisted(() => ({
  getLatestScanForUser: vi.fn(),
  getResearchJob: vi.fn(),
  getConnectedFeedProfiles: vi.fn(async () => [] as unknown[]),
  getLinkedInConnection: vi.fn(async (): Promise<unknown> => null),
  getArchiveDepthSummary: vi.fn(async (): Promise<unknown> => null),
  hasPendingPreferenceWork: vi.fn(async () => false),
  enqueueSocialRefreshJobs: vi.fn(async (_input: EnqueueArg) => 1),
  requeueOutdatedMediaAssets: vi.fn(async () => 0),
}));

vi.mock("@/lib/db/scan-store", () => ({
  getLatestScanForUser: mocks.getLatestScanForUser,
  getResearchJob: mocks.getResearchJob,
  getConnectedFeedProfiles: mocks.getConnectedFeedProfiles,
  getLinkedInConnection: mocks.getLinkedInConnection,
  getArchiveDepthSummary: mocks.getArchiveDepthSummary,
  hasPendingPreferenceWork: mocks.hasPendingPreferenceWork,
  enqueueSocialRefreshJobs: mocks.enqueueSocialRefreshJobs,
  requeueOutdatedMediaAssets: mocks.requeueOutdatedMediaAssets,
  PREFERENCE_RECOMPUTE_PLATFORM: "__recompute__",
}));

// Per-platform archived counts → the smart full-scrape-vs-refresh decision in enqueueManualRefresh.
const depthOf = (perPlatform: Record<string, number>) => ({
  perPlatform: Object.fromEntries(Object.entries(perPlatform).map(([p, items]) => [p, { items, mediaTotal: 0, mediaAnalyzed: 0, mediaPending: 0, mediaFailed: 0 }])),
  totals: { items: 0, mediaTotal: 0, mediaAnalyzed: 0, mediaPending: 0 },
});

import {
  enqueueManualRefresh,
  getPreferenceConsentContext,
  maybeEnqueueConnectDeepScrape,
  maybeEnqueueConnectRecompute,
} from "./connect-pipeline";

function resetMocks() {
  vi.clearAllMocks();
  // clearAllMocks wipes call history but NOT implementations — re-establish the defaults each test.
  mocks.getConnectedFeedProfiles.mockResolvedValue([]);
  mocks.getLinkedInConnection.mockResolvedValue(null);
  mocks.getArchiveDepthSummary.mockResolvedValue(null);
  mocks.hasPendingPreferenceWork.mockResolvedValue(false);
  mocks.enqueueSocialRefreshJobs.mockResolvedValue(1);
  mocks.requeueOutdatedMediaAssets.mockResolvedValue(0);
}

const withConsent = (consent: boolean) => {
  mocks.getLatestScanForUser.mockResolvedValue({ id: "scan-1" });
  mocks.getResearchJob.mockResolvedValue({ input: { socialPreferenceConsent: consent } });
};

const firstJob = () => mocks.enqueueSocialRefreshJobs.mock.calls[0]?.[0];

describe("getPreferenceConsentContext", () => {
  beforeEach(resetMocks);

  it("returns no-consent when the user has no scan yet", async () => {
    mocks.getLatestScanForUser.mockResolvedValue(null);
    expect(await getPreferenceConsentContext("u1")).toEqual({ consent: false, scanRunId: null });
    expect(mocks.getResearchJob).not.toHaveBeenCalled();
  });

  it("reads consent + scanRunId from the latest scan's input", async () => {
    withConsent(true);
    expect(await getPreferenceConsentContext("u1")).toEqual({ consent: true, scanRunId: "scan-1" });
  });

  it("treats a missing/false consent flag as no-consent (keeps the scanRunId)", async () => {
    mocks.getLatestScanForUser.mockResolvedValue({ id: "scan-9" });
    mocks.getResearchJob.mockResolvedValue({ input: {} });
    expect(await getPreferenceConsentContext("u1")).toEqual({ consent: false, scanRunId: "scan-9" });
  });

  it("grants consent when the scan never consented but a feed account is connected (connect-later)", async () => {
    mocks.getLatestScanForUser.mockResolvedValue({ id: "scan-9" });
    mocks.getResearchJob.mockResolvedValue({ input: { socialPreferenceConsent: false } });
    mocks.getConnectedFeedProfiles.mockResolvedValue([
      { platform: "Instagram", username: "ankit", profileUrl: "https://www.instagram.com/ankit/" },
    ]);
    expect(await getPreferenceConsentContext("u1")).toEqual({ consent: true, scanRunId: "scan-9" });
  });
});

describe("maybeEnqueueConnectDeepScrape", () => {
  beforeEach(resetMocks);

  it("enqueues a DEEP job (maxPosts 240, no refresh flag) for a consented user", async () => {
    withConsent(true);
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "instagram", username: "SundarPichai", profileUrl: "https://www.instagram.com/sundarpichai/" });
    expect(res).toEqual({ enqueued: true, reason: "enqueued" });
    expect(mocks.enqueueSocialRefreshJobs).toHaveBeenCalledTimes(1);
    const arg = firstJob();
    expect(arg?.firebaseUid).toBe("u1");
    expect(arg?.jobs[0]).toEqual({
      platform: "instagram",
      publicId: "sundarpichai", // lowercased
      metadata: { url: "https://www.instagram.com/sundarpichai/", maxPosts: 240, scanRunId: "scan-1" },
    });
    expect(arg?.jobs[0]?.metadata).not.toHaveProperty("refresh"); // deep climb, not a shallow refresh
  });

  it("does NOT enqueue without prior consent (privacy-safe no-op)", async () => {
    withConsent(false);
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "x", username: "a", profileUrl: "https://x.com/a" });
    expect(res).toEqual({ enqueued: false, reason: "no_consent" });
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });

  it("still enqueues when other preference work is in flight (distinct platform dedup key, no pending_work gate)", async () => {
    // Regression for the multi-platform-connect bug: connecting Threads while an IG deep-scrape is queued
    // must NOT be dropped — each platform is its own (userId,platform,publicId) dedup key.
    withConsent(true);
    mocks.hasPendingPreferenceWork.mockResolvedValue(true);
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "threads", username: "a", profileUrl: "https://www.threads.com/@a" });
    expect(res).toEqual({ enqueued: true, reason: "enqueued" });
    expect(mocks.enqueueSocialRefreshJobs).toHaveBeenCalledTimes(1);
  });

  it("enqueues via a connected feed account even when the scan input never consented (connect-later opt-in)", async () => {
    // skip-at-sign-up: scan consent is false, but the user has a connected IG account → connecting is consent.
    mocks.getLatestScanForUser.mockResolvedValue({ id: "scan-1" });
    mocks.getResearchJob.mockResolvedValue({ input: { socialPreferenceConsent: false } });
    mocks.getConnectedFeedProfiles.mockResolvedValue([
      { platform: "Instagram", username: "ankit", profileUrl: "https://www.instagram.com/ankit/" },
    ]);
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "x", username: "ankit", profileUrl: "https://x.com/ankit" });
    expect(res).toEqual({ enqueued: true, reason: "enqueued" });
    expect(mocks.enqueueSocialRefreshJobs).toHaveBeenCalledTimes(1);
  });

  it("ignores non-deep platforms", async () => {
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "facebook", username: "a", profileUrl: "https://facebook.com/a" });
    expect(res).toEqual({ enqueued: false, reason: "not_deep_platform" });
    expect(mocks.getLatestScanForUser).not.toHaveBeenCalled();
  });

  it("enqueues a LinkedIn POSTS deep-scrape (linkedin is a deep platform now)", async () => {
    withConsent(true);
    const res = await maybeEnqueueConnectDeepScrape({
      firebaseUid: "u1",
      platform: "linkedin",
      username: "ankit-kumar-singh",
      profileUrl: "https://www.linkedin.com/in/ankit-kumar-singh/",
    });
    expect(res).toEqual({ enqueued: true, reason: "enqueued" });
    expect(firstJob()?.jobs[0]?.platform).toBe("linkedin");
    expect(firstJob()?.jobs[0]?.metadata).not.toHaveProperty("refresh");
  });

  it("a connected LinkedIn account is itself consent (LinkedIn-only professional)", async () => {
    mocks.getLatestScanForUser.mockResolvedValue({ id: "scan-1" });
    mocks.getResearchJob.mockResolvedValue({ input: { socialPreferenceConsent: false } });
    mocks.getConnectedFeedProfiles.mockResolvedValue([]); // no IG/X/Threads
    mocks.getLinkedInConnection.mockResolvedValue({ profileUrl: "https://www.linkedin.com/in/ankit/" });
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "linkedin", username: "ankit", profileUrl: "https://www.linkedin.com/in/ankit/" });
    expect(res).toEqual({ enqueued: true, reason: "enqueued" });
  });
});

describe("maybeEnqueueConnectRecompute", () => {
  beforeEach(resetMocks);

  it("enqueues a recompute for a consented user", async () => {
    withConsent(true);
    const res = await maybeEnqueueConnectRecompute("u1");
    expect(res).toEqual({ enqueued: true, reason: "enqueued" });
    const arg = firstJob();
    expect(arg?.jobs[0]?.platform).toBe("__recompute__");
    expect(arg?.jobs[0]?.priority).toBe(1);
  });

  it("does NOT recompute without consent", async () => {
    withConsent(false);
    expect(await maybeEnqueueConnectRecompute("u1")).toEqual({ enqueued: false, reason: "no_consent" });
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });
});

describe("enqueueManualRefresh", () => {
  beforeEach(resetMocks);

  it("DEEP-ENOUGH platforms get a cheap recent-window refresh, then a recompute", async () => {
    withConsent(true);
    mocks.getConnectedFeedProfiles.mockResolvedValue([
      { platform: "Instagram", username: "ig", profileUrl: "https://www.instagram.com/ig/" },
      { platform: "X", username: "xh", profileUrl: "https://x.com/xh" },
    ]);
    mocks.getLinkedInConnection.mockResolvedValue({ profileUrl: "https://www.linkedin.com/in/ankit/" });
    mocks.getArchiveDepthSummary.mockResolvedValue(depthOf({ instagram: 300, x: 300, linkedin: 300 })); // all deep enough

    const res = await enqueueManualRefresh("u1");
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("enqueued");
    expect(res.platforms).toEqual(expect.arrayContaining(["instagram", "x", "linkedin"]));
    expect(res.deepScraped).toEqual([]); // none thin → none deep-scraped
    expect(res.recompute).toBe(true);
    const scrapeCall = mocks.enqueueSocialRefreshJobs.mock.calls[0]?.[0];
    expect(scrapeCall?.jobs.map((j) => j.platform)).toEqual(expect.arrayContaining(["instagram", "x", "linkedin"]));
    expect(scrapeCall?.jobs.every((j) => j.metadata?.refresh === true)).toBe(true); // all recent-window
    const recomputeCall = mocks.enqueueSocialRefreshJobs.mock.calls[1]?.[0];
    expect(recomputeCall?.jobs[0]?.platform).toBe("__recompute__");
  });

  it("THIN / never-scraped platform activates the FULL service layer (no refresh flag → deep climb)", async () => {
    withConsent(true);
    mocks.getConnectedFeedProfiles.mockResolvedValue([{ platform: "Instagram", username: "ig", profileUrl: "https://www.instagram.com/ig/" }]);
    mocks.getLinkedInConnection.mockResolvedValue({ profileUrl: "https://www.linkedin.com/in/ankit/" });
    // IG is deep (300 ≥ 50); LinkedIn just added → not in depth map → archived 0 < 50 → DEEP
    mocks.getArchiveDepthSummary.mockResolvedValue(depthOf({ instagram: 300 }));

    const res = await enqueueManualRefresh("u1");
    expect(res.deepScraped).toEqual(["linkedin"]);
    const jobs = mocks.enqueueSocialRefreshJobs.mock.calls[0]?.[0]?.jobs ?? [];
    const ig = jobs.find((j) => j.platform === "instagram");
    const li = jobs.find((j) => j.platform === "linkedin");
    expect(ig?.metadata?.refresh).toBe(true); // deep enough → recent refresh
    expect(li?.metadata).not.toHaveProperty("refresh"); // thin → full deep climb
    expect(li?.metadata?.maxPosts).toBe(240); // FIRST_TARGET
  });

  it("threshold is strict: 49 → deep, 50 → refresh", async () => {
    withConsent(true);
    mocks.getConnectedFeedProfiles.mockResolvedValue([
      { platform: "Instagram", username: "ig", profileUrl: "https://www.instagram.com/ig/" },
      { platform: "X", username: "xh", profileUrl: "https://x.com/xh" },
    ]);
    mocks.getArchiveDepthSummary.mockResolvedValue(depthOf({ instagram: 49, x: 50 }));
    const res = await enqueueManualRefresh("u1");
    expect(res.deepScraped).toEqual(["instagram"]); // 49 < 50 → deep; 50 not < 50 → refresh
    const jobs = mocks.enqueueSocialRefreshJobs.mock.calls[0]?.[0]?.jobs ?? [];
    expect(jobs.find((j) => j.platform === "instagram")?.metadata).not.toHaveProperty("refresh");
    expect(jobs.find((j) => j.platform === "x")?.metadata?.refresh).toBe(true);
  });

  it("null depth (DB blip / new user) → every platform treated as thin → all deep", async () => {
    withConsent(true);
    mocks.getConnectedFeedProfiles.mockResolvedValue([{ platform: "Instagram", username: "ig", profileUrl: "https://www.instagram.com/ig/" }]);
    mocks.getArchiveDepthSummary.mockResolvedValue(null);
    const res = await enqueueManualRefresh("u1");
    expect(res.deepScraped).toEqual(["instagram"]);
    expect(mocks.enqueueSocialRefreshJobs.mock.calls[0]?.[0]?.jobs[0]?.metadata).not.toHaveProperty("refresh");
  });

  it("returns already_running and enqueues nothing when preference work is in flight", async () => {
    withConsent(true);
    mocks.getConnectedFeedProfiles.mockResolvedValue([{ platform: "Instagram", username: "ig", profileUrl: "https://www.instagram.com/ig/" }]);
    mocks.hasPendingPreferenceWork.mockResolvedValue(true);
    const res = await enqueueManualRefresh("u1");
    expect(res).toMatchObject({ ok: true, alreadyRunning: true, reason: "already_running" });
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });

  it("returns nothing_connected when the user has no socials", async () => {
    withConsent(true); // consented but no connected accounts
    const res = await enqueueManualRefresh("u1");
    expect(res).toMatchObject({ ok: false, reason: "nothing_connected" });
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });

  it("returns no_consent when not consented and nothing connected", async () => {
    withConsent(false);
    const res = await enqueueManualRefresh("u1");
    expect(res).toMatchObject({ ok: false, reason: "no_consent" });
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });
});
