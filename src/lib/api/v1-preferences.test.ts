import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertOneUser: vi.fn(async (_input: unknown) => ({ id: "u" })),
  saveUserPreferenceProfile: vi.fn(async (_input: unknown) => ({ id: "p", updatedAt: "now" })),
  enqueueSocialRefreshJobs: vi.fn(async (_input: unknown) => 1),
  getUserPreferenceProfile: vi.fn(async (_uid: string): Promise<unknown> => null),
}));

vi.mock("@/lib/db/scan-store", () => ({
  upsertOneUser: mocks.upsertOneUser,
  saveUserPreferenceProfile: mocks.saveUserPreferenceProfile,
  enqueueSocialRefreshJobs: mocks.enqueueSocialRefreshJobs,
  getUserPreferenceProfile: mocks.getUserPreferenceProfile,
}));

import {
  apiSubjectUid,
  devPreferencesEnabled,
  enableDevPreferences,
  readDevPreferences,
  subjectInputHash,
} from "./v1-preferences";
import type { OneSubjectInput, SocialProfileFull } from "@/lib/ria/types";

// Two distinct subjects scanned under ONE key — the tenancy-collision case.
const SUNDAR_X: SocialProfileFull = {
  platform: "X",
  username: "sundarpichai",
  handle: "sundarpichai",
  displayName: "Sundar Pichai",
  bio: "CEO, Google & Alphabet",
  avatarUrl: null,
  bannerUrl: null,
  externalUrl: null,
  profileUrl: "https://x.com/sundarpichai",
  source: "scraper",
  timelineItems: [{ url: "https://x.com/sundarpichai/status/1", text: "Excited about AI." }],
} as unknown as SocialProfileFull;

const OTHER_X: SocialProfileFull = { ...SUNDAR_X, username: "someoneelse", profileUrl: "https://x.com/someoneelse" } as SocialProfileFull;

const sundarInput = (over: Partial<OneSubjectInput> = {}): OneSubjectInput => ({
  name: "Sundar Pichai",
  email: "sundar@example.com",
  zipCode: "94040",
  socialProfiles: [SUNDAR_X],
  confirmedProfiles: [],
  consentAttestation: true,
  socialPreferenceConsent: true,
  purpose: "self_audit",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsertOneUser.mockResolvedValue({ id: "u" });
  mocks.saveUserPreferenceProfile.mockResolvedValue({ id: "p", updatedAt: "now" });
  mocks.enqueueSocialRefreshJobs.mockResolvedValue(1);
  mocks.getUserPreferenceProfile.mockResolvedValue(null);
});
afterEach(() => vi.clearAllMocks());

describe("subjectInputHash + apiSubjectUid", () => {
  it("is deterministic per subject and DIFFERS across subjects (no collision)", () => {
    const a = subjectInputHash({ socialProfiles: [SUNDAR_X] });
    const a2 = subjectInputHash({ socialProfiles: [SUNDAR_X] });
    const b = subjectInputHash({ socialProfiles: [OTHER_X] });
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(apiSubjectUid("acme", a)).toMatch(/^api:acme:[0-9a-f]{24}$/);
    expect(apiSubjectUid("acme", a)).not.toBe(apiSubjectUid("acme", b));
  });
});

describe("devPreferencesEnabled", () => {
  it("true with a feed + consent; false when consent off or no feed", () => {
    expect(devPreferencesEnabled(sundarInput())).toBe(true);
    expect(devPreferencesEnabled(sundarInput({ socialPreferenceConsent: false }))).toBe(false);
    expect(devPreferencesEnabled({ ...sundarInput(), socialProfiles: [] })).toBe(false);
  });
});

describe("enableDevPreferences", () => {
  it("creates the per-subject user, saves a fast-pass keyed by inputHash, and enqueues the deep climb", async () => {
    const out = await enableDevPreferences({ keyId: "acme", input: sundarInput(), scanRunId: "scan-1" });
    expect(out).not.toBeNull();
    expect(out!.subjectUid).toBe(apiSubjectUid("acme", out!.inputHash));
    expect(mocks.upsertOneUser).toHaveBeenCalledWith(expect.objectContaining({ firebaseUid: out!.subjectUid, provider: "api" }));
    const saved = mocks.saveUserPreferenceProfile.mock.calls[0][0] as { firebaseUid: string; inputHash: string };
    expect(saved.firebaseUid).toBe(out!.subjectUid);
    expect(saved.inputHash).toBe(out!.inputHash);
    // deep climb enqueued for the X feed under the per-subject user
    const enq = mocks.enqueueSocialRefreshJobs.mock.calls[0][0] as { firebaseUid: string; jobs: Array<{ platform: string }> };
    expect(enq.firebaseUid).toBe(out!.subjectUid);
    expect(enq.jobs.map((j) => j.platform)).toContain("x");
  });

  it("no-ops (returns null) when preferences are not enabled", async () => {
    const out = await enableDevPreferences({ keyId: "acme", input: sundarInput({ socialPreferenceConsent: false }), scanRunId: "s" });
    expect(out).toBeNull();
    expect(mocks.saveUserPreferenceProfile).not.toHaveBeenCalled();
  });
});

describe("readDevPreferences (per-subject, no cross-leak)", () => {
  it("reads the profile from the SUBJECT's own user id — different subjects hit different ids", async () => {
    mocks.getUserPreferenceProfile.mockImplementation(async (uid: string) => {
      // Only Sundar's synthetic user has a profile; the other subject's user is empty.
      const sundarUid = apiSubjectUid("acme", subjectInputHash({ socialProfiles: [SUNDAR_X] }));
      if (uid === sundarUid) {
        return { status: "completed", version: "v", profile: { questionCoverage: { answered: 25, inferred: 3 }, lifestyle: { topBrands: [{ value: "Google", count: 9 }] } } };
      }
      return null;
    });

    const sundar = await readDevPreferences("acme", sundarInput());
    expect(sundar.status).toBe("completed");
    expect((sundar.profile as { lifestyle: { topBrands: unknown[] } }).lifestyle.topBrands).toHaveLength(1);

    // The OTHER subject under the SAME key must NOT see Sundar's profile.
    const other = await readDevPreferences("acme", sundarInput({ socialProfiles: [OTHER_X] }));
    expect(other.profile).toBeNull();
    expect(other.status).toBe("running");
  });

  it("reports running when the profile exists but is below the reveal gate", async () => {
    mocks.getUserPreferenceProfile.mockResolvedValue({ status: "completed", version: "v", profile: { questionCoverage: { answered: 5, inferred: 2 } } });
    const r = await readDevPreferences("acme", sundarInput());
    expect(r.status).toBe("running"); // 7 < SHOW_THRESHOLD(20)
  });

  it("skipped when not enabled", async () => {
    const r = await readDevPreferences("acme", sundarInput({ socialPreferenceConsent: false }));
    expect(r).toEqual({ status: "skipped", profile: null });
  });
});
