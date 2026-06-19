import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  persistConnectedProfile: vi.fn(async () => undefined),
  enqueueSocialRefreshJobs: vi.fn(async () => 1),
}));

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "user@example.com",
    name: "User Example",
    picture: null,
  })),
}));

vi.mock("@/lib/linkedin/connection", () => ({
  persistConnectedProfile: mocks.persistConnectedProfile,
}));

vi.mock("@/lib/db/scan-store", () => ({
  enqueueSocialRefreshJobs: mocks.enqueueSocialRefreshJobs,
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/linkedin/enrich-url", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function richScraperResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    count: 1,
    results: [
      {
        ok: true,
        profileId: "anilsachdev",
        profileUrl: "https://www.linkedin.com/in/anilsachdev/",
        templates: {
          linkedinProfileScraper: {
            userProfile: {
              fullName: "Anil Sachdev",
              title: "Chief Operating Officer",
              location: "Dubai, United Arab Emirates",
              url: "https://www.linkedin.com/in/anilsachdev/",
            },
            experiences: [{ title: "Chief Operating Officer", company: "OTS Capital", dateRange: "Jan 2024 - Present" }],
            education: [{ schoolName: "University of Wales, UK", degreeName: "MBA, Finance" }],
            skills: [{ skillName: "Financial Markets" }],
          },
          staffSpyStyle: { full_name: "Anil Sachdev" },
        },
        ...overrides,
      },
    ],
  };
}

const enqueueArg = () =>
  (vi.mocked(mocks.enqueueSocialRefreshJobs).mock.calls[0] as unknown[] | undefined)?.[0] as
    | { firebaseUid: string; jobs: Array<{ platform: string; publicId: string; metadata?: { url?: string } }> }
    | undefined;

describe("POST /api/linkedin/enrich-url (resilient)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("LINKEDIN_SCRAPER_URL", "http://scraper.local");
    vi.stubEnv("LINKEDIN_SCRAPER_API_KEY", "test-key");
    global.fetch = vi.fn(async () => Response.json(richScraperResponse())) as never;
  });

  it("VM up → rich scrape: full profile persisted, NOT degraded, no bg job", async () => {
    const res = await POST(makeRequest({ url: "linkedin.com/in/anilsachdev" }));
    const json = (await res.json()) as { ok?: boolean; degraded?: boolean; profile?: { name?: string; source?: string } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.degraded).toBeUndefined();
    expect(json.profile).toMatchObject({ name: "Anil Sachdev", source: "scraper" });
    expect(mocks.persistConnectedProfile).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSocialRefreshJobs).not.toHaveBeenCalled();
  });

  it("invalid URL → 422, no scrape, no persist", async () => {
    const res = await POST(makeRequest({ url: "https://www.linkedin.com/company/hushh" }));
    const json = (await res.json()) as { ok?: boolean };

    expect(res.status).toBe(422);
    expect(json.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistConnectedProfile).not.toHaveBeenCalled();
  });

  it("VM down (scrape throws) → degraded connect (200), URL-only profile + bg re-enrich enqueued", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as never;

    const res = await POST(makeRequest({ url: "https://www.linkedin.com/in/anilsachdev" }));
    const json = (await res.json()) as { ok?: boolean; degraded?: boolean; profile?: { source?: string; enriched?: boolean; profileUrl?: string } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.degraded).toBe(true);
    expect(json.profile).toMatchObject({ source: "scraper", enriched: false, profileUrl: "https://www.linkedin.com/in/anilsachdev" });
    expect(mocks.persistConnectedProfile).toHaveBeenCalledTimes(1);
    expect(enqueueArg()?.jobs?.[0]).toMatchObject({ platform: "linkedin", metadata: { url: "https://www.linkedin.com/in/anilsachdev" } });
  });

  it("scrape returns sparse/insufficient → degraded connect (200) + bg re-enrich enqueued", async () => {
    global.fetch = vi.fn(async () =>
      Response.json(
        richScraperResponse({
          templates: {
            linkedinProfileScraper: {
              userProfile: { fullName: "Sparse User", title: "· 3rd", url: "https://www.linkedin.com/in/sparse-user/" },
              experiences: [],
              education: [],
              skills: [],
              certifications: [],
            },
            staffSpyStyle: { full_name: "Sparse User" },
          },
        }),
      ),
    ) as never;

    const res = await POST(makeRequest({ url: "https://www.linkedin.com/in/sparse-user" }));
    const json = (await res.json()) as { ok?: boolean; degraded?: boolean; profile?: { enriched?: boolean } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.degraded).toBe(true);
    expect(json.profile?.enriched).toBe(false);
    expect(mocks.persistConnectedProfile).toHaveBeenCalledTimes(1);
    expect(enqueueArg()?.jobs?.[0]?.platform).toBe("linkedin");
  });
});
