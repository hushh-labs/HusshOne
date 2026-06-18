import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scrapeLinkedInProfileUrl: vi.fn(),
  scrapeInstagramProfileUrl: vi.fn(),
  scrapeThreadsProfileUrl: vi.fn(),
  scrapeXProfileUrl: vi.fn(),
}));

vi.mock("@/lib/linkedin/scraper-profile", () => ({ scrapeLinkedInProfileUrl: mocks.scrapeLinkedInProfileUrl }));
vi.mock("@/lib/instagram/scraper-profile", () => ({ scrapeInstagramProfileUrl: mocks.scrapeInstagramProfileUrl }));
vi.mock("@/lib/threads/scraper-profile", () => ({ scrapeThreadsProfileUrl: mocks.scrapeThreadsProfileUrl }));
vi.mock("@/lib/x/scraper-profile", () => ({ scrapeXProfileUrl: mocks.scrapeXProfileUrl }));

import { buildV1ScanInput, V1InputError } from "./v1-input";

function richLinkedIn() {
  return {
    sub: "sundar",
    name: "Sundar Pichai",
    givenName: "Sundar",
    familyName: "Pichai",
    email: "subject@example.com",
    emailVerified: false,
    locale: null,
    pictureUrl: null,
    profileUrl: "https://www.linkedin.com/in/sundarpichai",
    headline: "CEO at Google",
    verifications: [],
    grantedScopes: [],
    source: "scraper",
    about: "CEO of Google and Alphabet.",
    experience: [{ title: "CEO", company: "Google", current: true }],
    education: [],
    skills: ["Leadership"],
    certifications: [],
  };
}

const base = { name: "Sundar Pichai", email: "subject@example.com", latitude: 37.42, longitude: -122.08 };

describe("buildV1ScanInput — validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires name, email, and a location signal", async () => {
    await expect(buildV1ScanInput({ email: "a@b.com", latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(V1InputError);
    await expect(buildV1ScanInput({ name: "X", email: "bad", latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(V1InputError);
    await expect(buildV1ScanInput({ name: "X", email: "a@b.com" })).rejects.toBeInstanceOf(V1InputError);
  });

  it("accepts zipCode as the location and zero URLs", async () => {
    const { input, profiles } = await buildV1ScanInput({ name: "X", email: "a@b.com", zipCode: "94043" });
    expect(input.zipCode).toBe("94043");
    expect(input.linkedinProfile).toBeUndefined();
    expect(input.socialProfiles).toBeUndefined();
    expect(profiles).toEqual({ linkedin: null, instagram: null, threads: null, x: null });
  });
});

describe("buildV1ScanInput — enrichment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("attaches a rich LinkedIn profile + reports it in profiles", async () => {
    mocks.scrapeLinkedInProfileUrl.mockResolvedValueOnce({ profile: richLinkedIn(), raw: {}, normalizedUrl: "https://www.linkedin.com/in/sundarpichai" });
    const { input, profiles } = await buildV1ScanInput({ ...base, linkedinUrl: "https://www.linkedin.com/in/sundarpichai" });
    expect(input.linkedinProfile?.name).toBe("Sundar Pichai");
    expect((profiles.linkedin as { name?: string }).name).toBe("Sundar Pichai");
    expect(input.confirmedProfiles?.some((p) => p.platform === "LinkedIn")).toBe(true);
  });

  it("flags a thin LinkedIn and omits it from the scan (never blocks)", async () => {
    mocks.scrapeLinkedInProfileUrl.mockResolvedValueOnce({ profile: { source: "scraper", profileUrl: "https://www.linkedin.com/in/x" }, raw: {}, normalizedUrl: "https://www.linkedin.com/in/x" });
    const { input, profiles } = await buildV1ScanInput({ ...base, linkedinUrl: "https://www.linkedin.com/in/x" });
    expect(input.linkedinProfile).toBeUndefined();
    expect(profiles.linkedin).toMatchObject({ status: "too_thin" });
  });

  it("reports a private social as access_pending and excludes it from socialProfiles", async () => {
    mocks.scrapeInstagramProfileUrl.mockResolvedValueOnce({ status: "access_pending", access: { state: "private_not_following" }, normalizedUrl: "https://www.instagram.com/x/" });
    const { input, profiles } = await buildV1ScanInput({ ...base, instagramUrl: "https://www.instagram.com/x/" });
    expect(profiles.instagram).toEqual({ access: "private_not_following", profileUrl: "https://www.instagram.com/x/" });
    expect(input.socialProfiles).toBeUndefined();
  });

  it("includes a successful social and survives a thrown scraper (failed, not thrown)", async () => {
    mocks.scrapeThreadsProfileUrl.mockResolvedValueOnce({ status: "profile", profile: { platform: "Threads", username: "t", profileUrl: "https://www.threads.com/@t", source: "scraper" } });
    mocks.scrapeXProfileUrl.mockRejectedValueOnce(new Error("rate limited"));
    const { input, profiles } = await buildV1ScanInput({ ...base, threadsUrl: "https://www.threads.com/@t", xUrl: "https://x.com/t" });
    expect(input.socialProfiles).toHaveLength(1);
    expect((profiles.threads as { username?: string }).username).toBe("t");
    expect(profiles.x).toMatchObject({ status: "failed", error: "rate limited" });
  });
});
