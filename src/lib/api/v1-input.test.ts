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

describe("buildV1ScanInput — confirmedProfiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes valid caller-provided anchors through, trimmed", async () => {
    const { input } = await buildV1ScanInput({
      ...base,
      confirmedProfiles: [
        { platform: " SEC AdviserInfo ", handle: " 1234567 ", url: " https://adviserinfo.sec.gov/individual/summary/1234567 ", category: " Government/Regulatory " },
      ],
    });
    expect(input.confirmedProfiles).toEqual([
      { platform: "SEC AdviserInfo", handle: "1234567", url: "https://adviserinfo.sec.gov/individual/summary/1234567", category: "Government/Regulatory" },
    ]);
  });

  it("drops entries without an http(s) url or that aren't objects", async () => {
    const { input } = await buildV1ScanInput({
      ...base,
      confirmedProfiles: [
        { platform: "SEC AdviserInfo", handle: "1", url: "javascript:alert(1)", category: "Government/Regulatory" },
        { platform: "Firm website", handle: "acme.com", category: "Professional" },
        "not-an-object",
        null,
        { platform: "Firm website", handle: "acme.com", url: "https://acme.com", category: "Professional" },
      ],
    });
    expect(input.confirmedProfiles).toEqual([{ platform: "Firm website", handle: "acme.com", url: "https://acme.com", category: "Professional" }]);
  });

  it("caps caller-provided anchors at 8", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ platform: "Web", handle: `h${i}`, url: `https://example.com/${i}`, category: "Professional" }));
    const { input } = await buildV1ScanInput({ ...base, confirmedProfiles: many });
    expect(input.confirmedProfiles).toHaveLength(8);
    expect(input.confirmedProfiles?.[7]?.url).toBe("https://example.com/7");
  });

  it("absent (or non-array) confirmedProfiles ⇒ undefined; unknown sibling fields still ignored", async () => {
    const { input } = await buildV1ScanInput({ ...base, mystery: "ignored" });
    expect(input.confirmedProfiles).toBeUndefined();
    const { input: input2 } = await buildV1ScanInput({ ...base, confirmedProfiles: "not-an-array" });
    expect(input2.confirmedProfiles).toBeUndefined();
  });

  it("caller anchors come before scraped-profile anchors", async () => {
    mocks.scrapeLinkedInProfileUrl.mockResolvedValueOnce({ profile: richLinkedIn(), raw: {}, normalizedUrl: "https://www.linkedin.com/in/sundarpichai" });
    const { input } = await buildV1ScanInput({
      ...base,
      linkedinUrl: "https://www.linkedin.com/in/sundarpichai",
      confirmedProfiles: [{ platform: "SEC AdviserInfo", handle: "1234567", url: "https://adviserinfo.sec.gov/individual/summary/1234567", category: "Government/Regulatory" }],
    });
    expect(input.confirmedProfiles?.map((p) => p.platform)).toEqual(["SEC AdviserInfo", "LinkedIn"]);
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
