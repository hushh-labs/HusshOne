import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOneRequest } from "@/lib/auth/verify";
import type { OneDashboardResult } from "@/lib/ria/types";

vi.mock("@/lib/auth/verify", () => ({
  isGuestOneUser: (user: { uid: string; provider?: string | null }) => user.provider === "guest" || user.uid.startsWith("guest:"),
  oneUserProvider: (user: { uid: string; provider?: string | null }) =>
    user.provider === "guest" || user.uid.startsWith("guest:") ? "guest" : user.provider === "dev" || user.uid === "dev-one-user" ? "dev" : "google",
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "ankit@example.com",
    name: "Ankit Kumar Singh",
    picture: null,
    provider: "google",
  })),
}));

vi.mock("@/lib/db/scan-store", () => ({
  upsertOneUser: vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000001" })),
  createConsentAndScan: vi.fn(async () => ({ scanRunId: "scan-1" })),
  completeScanRun: vi.fn(async () => undefined),
  failScanRun: vi.fn(async () => undefined),
  recordScanDeadline: vi.fn(async () => undefined),
}));

vi.mock("@/lib/research/client", () => ({
  startResearch: vi.fn(async () => ({ jobId: "job-1" })),
  pollResearch: vi.fn(async () => ({
    status: "completed",
    report: "# Raw report\n\nThe report body.",
    citations: [],
    progress: null,
    error: null,
  })),
}));

function result(): OneDashboardResult {
  return {
    scanRunId: "scan-1",
    mode: "precise",
    source: "deep_research",
    subject: { name: "Ankit Kumar Singh", email: "ankit@example.com" },
    summary: "Deep research summary",
    entityId: "Ankit Kumar Singh",
    categories: { newsAndMedia: [], socials: [], education: [], government: [], otherFootprints: [], connectedIdentities: [] },
    privateDataEstimation: [],
    locationIntelligence: null,
    auditJobId: null,
    redactions: [],
    warnings: [],
    rich: null,
    report: "# Final report",
    citations: [],
  };
}

vi.mock("@/lib/research/finalize", () => ({
  finalizeResearch: vi.fn(async () => ({ result: result(), phase2Ms: 12 })),
}));

vi.mock("@/lib/notifications/scan-email", () => ({
  sendScanResultEmails: vi.fn(async () => ({
    user: { status: "sent", recipients: [{ recipient: "ankit@example.com", status: "sent", messageId: "msg-user" }], error: null },
    admins: { status: "skipped", recipients: [], error: "no_valid_recipients" },
  })),
}));

const linkedinProfile = {
  sub: "ankit-kumar-singh",
  name: "Ankit Kumar Singh",
  givenName: "Ankit",
  familyName: "Kumar Singh",
  email: "ankit@example.com",
  emailVerified: false,
  locale: null,
  pictureUrl: "https://media.licdn.com/profile.jpg",
  profileUrl: "https://www.linkedin.com/in/ankit-kumar-singh",
  headline: "Founding Engineer at Hushh",
  location: "Pune District, Maharashtra, India",
  about: "Builder at Hushh working across product, mobile, and AI systems.",
  source: "scraper",
  verifications: [],
  grantedScopes: ["scraper:linkedin-profile-url"],
  experience: [
    {
      title: "Founding Engineer",
      company: "Hushh Technologies LLC",
      employmentType: "Full-time",
      current: true,
      description: "Product, mobile, and AI systems.",
    },
    { title: "Mobile Engineer Trainee", company: "CRED", endDate: "Dec 2023" },
  ],
  education: [{ school: "Indian Institute of Technology, Kharagpur", degree: "Data Analytics AI - ML", grade: "Grade: 9.24" }],
  skills: [
    "Interpersonal Skills",
    "Technical Support",
    "Generative AI",
    "Large Language Models",
    "Machine Learning",
    "Team Building",
    "Agile Project Management",
    "Cross-functional Team Leadership",
    "Leadership",
  ],
  certifications: [{ name: "Generative AI for Leadership", authority: "LinkedIn Learning", date: "2026" }],
  profileStats: { followers: "1,234", connections: "500+" },
};

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/one/research", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readStream(response: Response) {
  const text = await response.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("POST /api/one/research", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the full normalized LinkedIn JSON into the Phase-1 Deep Research question", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        name: "Ankit Kumar Singh",
        email: "ankit@example.com",
        latitude: 18.564739,
        longitude: 73.740322,
        consentAttestation: true,
        purpose: "self_audit",
        sessionId: "test-session",
        linkedinProfile,
      }),
    );

    expect(response.status).toBe(200);
    const lines = await readStream(response);
    expect(lines.at(-1)?.type).toBe("done");

    const research = await import("@/lib/research/client");
    expect(research.startResearch).toHaveBeenCalledWith(expect.stringContaining("LINKEDIN_ENRICHED_PROFILE_JSON"), "fast");
    const question = vi.mocked(research.startResearch).mock.calls[0]?.[0] as string;
    expect(question).toContain('"skills": [');
    expect(question).toContain('"Leadership"');
    expect(question).toContain('"experience": [');
    expect(question).toContain('"company": "CRED"');
    expect(question).toContain('"employmentType": "Full-time"');
    expect(question).toContain('"Product, mobile, and AI systems."');
    expect(question).toContain('"grade": "Grade: 9.24"');
    expect(question).toContain('"certifications": [');
    expect(question).toContain('"Generative AI for Leadership"');
    expect(question).toContain('"profileStats": {');
    expect(question).toContain('"connections": "500+"');
    expect(question).toContain("Treat this JSON as LOCKED GROUND TRUTH");
  });

  it("passes optional Instagram and Threads social context into Phase-1 without replacing LinkedIn ground truth", async () => {
    const instagramProfile = {
      platform: "Instagram",
      username: "ankit_ya_i_am",
      displayName: "Ankit Kumar Singh",
      bio: "Builder at Hushh",
      avatarUrl: "https://cdn.example.com/avatar.jpg",
      externalUrl: "https://ankit.example.com/",
      profileUrl: "https://www.instagram.com/ankit_ya_i_am/",
      isVerified: false,
      isPrivate: false,
      stats: { posts: "42", followers: "1,234", following: "567" },
      recentPublicPosts: [{ url: "https://www.instagram.com/p/abc/", caption: "Demo" }],
      source: "scraper",
    };
    const threadsProfile = {
      platform: "Threads",
      username: "threads",
      displayName: "Threads",
      bio: "Say more with Threads.",
      avatarUrl: "https://cdn.example.com/threads-avatar.jpg",
      externalUrl: "https://about.example.com/",
      profileUrl: "https://www.threads.com/@threads",
      isVerified: true,
      isPrivate: false,
      stats: { followers: "6.5M", threads: "1.2K" },
      recentThreads: [{ url: "https://www.threads.com/@threads/post/Cabc123", text: "Visible post", contentSeed: "Visible post", feedPhotoUrl: "https://cdn.example.com/feed.jpg", likeCount: "126" }],
      source: "scraper",
    };
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        name: "Ankit Kumar Singh",
        email: "ankit@example.com",
        latitude: 18.564739,
        longitude: 73.740322,
        consentAttestation: true,
        purpose: "self_audit",
        linkedinProfile,
        socialProfiles: [instagramProfile, threadsProfile],
      }),
    );

    expect(response.status).toBe(200);
    await readStream(response);

    const research = await import("@/lib/research/client");
    const question = vi.mocked(research.startResearch).mock.calls[0]?.[0] as string;
    expect(question).toContain("LINKEDIN_ENRICHED_PROFILE_JSON");
    expect(question).toContain("SOCIAL_ENRICHED_PROFILES_JSON");
    expect(question).toContain('"username": "ankit_ya_i_am"');
    expect(question).toContain('"platform": "Threads"');
    expect(question).toContain('"recentThreads"');
    expect(question).toContain("supporting cross-platform context only");
    expect(question).toContain("Treat this JSON as LOCKED GROUND TRUTH");

    const db = await import("@/lib/db/scan-store");
    const input = vi.mocked(db.createConsentAndScan).mock.calls[0]?.[0]?.input as {
      socialProfiles?: Array<{ platform?: string; username?: string; profileUrl?: string }>;
      confirmedProfiles?: Array<{ platform?: string; url?: string }>;
    };
    expect(input.socialProfiles?.[0]).toMatchObject({
      platform: "Instagram",
      username: "ankit_ya_i_am",
      profileUrl: "https://www.instagram.com/ankit_ya_i_am/",
    });
    expect(input.socialProfiles?.[1]).toMatchObject({
      platform: "Threads",
      username: "threads",
      profileUrl: "https://www.threads.com/@threads",
    });
    expect(input.confirmedProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "Instagram", url: "https://www.instagram.com/ankit_ya_i_am/" }),
        expect.objectContaining({ platform: "Threads", url: "https://www.threads.com/@threads" }),
      ]),
    );
  });

  it("allows Google users to start Phase-1 without LinkedIn", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        name: "Ankit Kumar Singh",
        email: "ankit@example.com",
        latitude: 18.564739,
        longitude: 73.740322,
        consentAttestation: true,
        purpose: "self_audit",
      }),
    );

    expect(response.status).toBe(200);
    await readStream(response);

    const research = await import("@/lib/research/client");
    expect(research.startResearch).toHaveBeenCalledWith(expect.not.stringContaining("LINKEDIN_ENRICHED_PROFILE_JSON"), "fast");
    const question = vi.mocked(research.startResearch).mock.calls[0]?.[0] as string;
    expect(question).toContain('"linkedinProfile": null');
  });

  it("requires rich LinkedIn before a provider-guest user can start Phase-1", async () => {
    vi.mocked(verifyOneRequest).mockResolvedValueOnce({
      uid: "firebase-guest",
      email: "guest@example.com",
      name: "Guest User",
      picture: null,
      provider: "guest",
    });
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        name: "Guest User",
        email: "guest@example.com",
        latitude: 18.564739,
        longitude: 73.740322,
        consentAttestation: true,
        purpose: "self_audit",
      }),
    );
    const json = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(json.error).toContain("LinkedIn profile URL is required");

    const research = await import("@/lib/research/client");
    expect(research.startResearch).not.toHaveBeenCalled();
  });

  it("requires rich LinkedIn before a guest uid-prefix user can start Phase-1", async () => {
    vi.mocked(verifyOneRequest).mockResolvedValueOnce({
      uid: "guest:scan-owner",
      email: "guest@example.com",
      name: "Guest User",
      picture: null,
      provider: null,
    });
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        name: "Guest User",
        email: "guest@example.com",
        latitude: 18.564739,
        longitude: 73.740322,
        consentAttestation: true,
        purpose: "self_audit",
      }),
    );
    const json = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(json.error).toContain("LinkedIn profile URL is required");

    const research = await import("@/lib/research/client");
    expect(research.startResearch).not.toHaveBeenCalled();
  });

  it("accepts a guest custom-token user when the guest owns the requested email and LinkedIn anchor", async () => {
    vi.mocked(verifyOneRequest).mockResolvedValueOnce({
      uid: "guest:scan-owner",
      email: "guest@example.com",
      name: "Guest User",
      picture: null,
      provider: "guest",
    });
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        name: "Guest User",
        email: "guest@example.com",
        latitude: 18.564739,
        longitude: 73.740322,
        consentAttestation: true,
        purpose: "self_audit",
        linkedinProfile: { ...linkedinProfile, email: "guest@example.com", name: "Guest User" },
      }),
    );

    expect(response.status).toBe(200);
    await readStream(response);

    const db = await import("@/lib/db/scan-store");
    expect(db.upsertOneUser).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "guest:scan-owner",
        email: "guest@example.com",
        name: "Guest User",
        provider: "guest",
      }),
    );
  });

  it("rejects OAuth-lite LinkedIn profiles so existing users return to URL capture", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        name: "Ankit Kumar Singh",
        email: "ankit@example.com",
        latitude: 18.564739,
        longitude: 73.740322,
        consentAttestation: true,
        purpose: "self_audit",
        linkedinProfile: {
          ...linkedinProfile,
          source: "oauth",
          about: null,
          experience: [],
          education: [],
          skills: [],
          certifications: [],
        },
      }),
    );
    const json = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(json.error).toContain("full LinkedIn profile");

    const research = await import("@/lib/research/client");
    expect(research.startResearch).not.toHaveBeenCalled();
  });
});
