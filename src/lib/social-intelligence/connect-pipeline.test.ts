import { beforeEach, describe, expect, it, vi } from "vitest";

type EnqueueArg = {
  firebaseUid: string;
  jobs: Array<{ platform: string; publicId: string; metadata?: Record<string, unknown>; priority?: number }>;
};

const mocks = vi.hoisted(() => ({
  getLatestScanForUser: vi.fn(),
  getResearchJob: vi.fn(),
  hasPendingPreferenceWork: vi.fn(async () => false),
  enqueueSocialRefreshJobs: vi.fn(async (_input: EnqueueArg) => 1),
}));

vi.mock("@/lib/db/scan-store", () => ({
  getLatestScanForUser: mocks.getLatestScanForUser,
  getResearchJob: mocks.getResearchJob,
  hasPendingPreferenceWork: mocks.hasPendingPreferenceWork,
  enqueueSocialRefreshJobs: mocks.enqueueSocialRefreshJobs,
  PREFERENCE_RECOMPUTE_PLATFORM: "__recompute__",
}));

import {
  getPreferenceConsentContext,
  maybeEnqueueConnectDeepScrape,
  maybeEnqueueConnectRecompute,
} from "./connect-pipeline";

function resetMocks() {
  vi.clearAllMocks();
  // clearAllMocks wipes call history but NOT implementations — re-establish the defaults each test.
  mocks.hasPendingPreferenceWork.mockResolvedValue(false);
  mocks.enqueueSocialRefreshJobs.mockResolvedValue(1);
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

  it("skips when preference work is already in flight (anti-thrash)", async () => {
    withConsent(true);
    mocks.hasPendingPreferenceWork.mockResolvedValue(true);
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "threads", username: "a", profileUrl: "https://www.threads.com/@a" });
    expect(res).toEqual({ enqueued: false, reason: "pending_work" });
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });

  it("ignores non-deep platforms", async () => {
    const res = await maybeEnqueueConnectDeepScrape({ firebaseUid: "u1", platform: "linkedin", username: "a", profileUrl: "https://linkedin.com/in/a" });
    expect(res).toEqual({ enqueued: false, reason: "not_deep_platform" });
    expect(mocks.getLatestScanForUser).not.toHaveBeenCalled();
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
