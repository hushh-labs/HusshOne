import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  persistConnectedProfile: vi.fn(async () => undefined),
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

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/linkedin/enrich-url", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function scraperResponse(overrides: Record<string, unknown> = {}) {
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

describe("POST /api/linkedin/enrich-url", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("LINKEDIN_SCRAPER_URL", "http://scraper.local");
    vi.stubEnv("LINKEDIN_SCRAPER_API_KEY", "test-key");
    mocks.persistConnectedProfile.mockClear();
    global.fetch = vi.fn(async () => Response.json(scraperResponse())) as never;
  });

  it("enriches, maps, and persists a LinkedIn profile URL", async () => {
    const res = await POST(makeRequest({ url: "linkedin.com/in/anilsachdev" }));
    const json = (await res.json()) as { ok?: boolean; profile?: { name?: string; source?: string; email?: string }; normalizedUrl?: string };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.normalizedUrl).toBe("https://www.linkedin.com/in/anilsachdev");
    expect(json.profile).toMatchObject({ name: "Anil Sachdev", source: "scraper", email: "user@example.com" });
    expect(mocks.persistConnectedProfile).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://scraper.local/scrape",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: JSON.stringify({ url: "https://www.linkedin.com/in/anilsachdev" }),
      }),
    );
  });

  it("rejects invalid URLs before calling the scraper", async () => {
    const res = await POST(makeRequest({ url: "https://www.linkedin.com/company/hushh" }));
    const json = (await res.json()) as { ok?: boolean; code?: string };

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ ok: false, code: "invalid_linkedin_url" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistConnectedProfile).not.toHaveBeenCalled();
  });

  it("does not persist sparse scraper output as a connected profile", async () => {
    global.fetch = vi.fn(async () =>
      Response.json(
        scraperResponse({
          templates: {
            linkedinProfileScraper: {
              userProfile: {
                fullName: "Sparse User",
                title: "· 3rd",
                url: "https://www.linkedin.com/in/sparse-user/",
              },
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
    const json = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(422);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("enough LinkedIn profile detail");
    expect(mocks.persistConnectedProfile).not.toHaveBeenCalled();
  });

  it("returns controlled errors for scraper authwall responses and does not persist", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({
        ok: false,
        count: 1,
        results: [{ ok: false, type: "LinkedInAuthwall", error: "LinkedIn returned authwall/login" }],
      }),
    ) as never;

    const res = await POST(makeRequest({ url: "https://www.linkedin.com/in/anilsachdev" }));
    const json = (await res.json()) as { ok?: boolean; code?: string; error?: string };

    expect(res.status).toBe(503);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("LinkedInAuthwall");
    expect(json.error).toContain("authwall");
    expect(mocks.persistConnectedProfile).not.toHaveBeenCalled();
  });

  it("returns controlled errors for scraper 401/503 and does not persist", async () => {
    global.fetch = vi.fn(async () => Response.json({ ok: false, error: "Unauthorized" }, { status: 401 })) as never;

    const res = await POST(makeRequest({ url: "https://www.linkedin.com/in/anilsachdev" }));
    const json = (await res.json()) as { ok?: boolean; code?: string };

    expect(res.status).toBe(503);
    expect(json).toMatchObject({ ok: false, code: "linkedin_scraper_upstream_error" });
    expect(mocks.persistConnectedProfile).not.toHaveBeenCalled();
  });
});
