import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  persistConnectedProfile: vi.fn(async () => undefined),
  maybeEnqueueConnectRecompute: vi.fn(async () => ({ enqueued: false, reason: "no_consent" as const })),
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

vi.mock("@/lib/social-intelligence/connect-pipeline", () => ({
  maybeEnqueueConnectRecompute: mocks.maybeEnqueueConnectRecompute,
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
    mocks.maybeEnqueueConnectRecompute.mockClear();
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
    // connect-later: LinkedIn re-grounds the preference layer via a recompute (consent-gated in the helper)
    expect(mocks.maybeEnqueueConnectRecompute).toHaveBeenCalledWith("firebase-1");
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

  // #55 resilience: a sparse read or any transient scraper failure (authwall / upstream / VM down) must
  // NOT hard-block — it persists a degraded URL-only handshake (200 + degraded:true) so the client can
  // retry/re-enrich. Only an invalid URL is terminal. A degraded profile fails hasUrlEnriched, so the
  // strict anchor gate stays closed (no recompute) until a retry upgrades it.
  const expectDegraded = async () => {
    const res = await POST(makeRequest({ url: "https://www.linkedin.com/in/anilsachdev" }));
    const json = (await res.json()) as { ok?: boolean; degraded?: boolean; profile?: { source?: string; profileUrl?: string } };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.degraded).toBe(true);
    expect(json.profile).toMatchObject({ source: "scraper", profileUrl: "https://www.linkedin.com/in/anilsachdev" });
    expect(mocks.persistConnectedProfile).toHaveBeenCalledTimes(1); // degraded handshake persisted
    expect(mocks.maybeEnqueueConnectRecompute).not.toHaveBeenCalled(); // no recompute on a weak anchor
  };

  it("sparse scraper output → degraded connect (200), not a hard error", async () => {
    global.fetch = vi.fn(async () =>
      Response.json(
        scraperResponse({
          templates: {
            linkedinProfileScraper: {
              userProfile: { fullName: "Sparse User", title: "· 3rd", url: "https://www.linkedin.com/in/anilsachdev/" },
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
    await expectDegraded();
  });

  it("scraper authwall → degraded connect (200), not a hard error", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false, count: 1, results: [{ ok: false, type: "LinkedInAuthwall", error: "authwall/login" }] }),
    ) as never;
    await expectDegraded();
  });

  it("scraper upstream 401/503 → degraded connect (200), not a hard error", async () => {
    global.fetch = vi.fn(async () => Response.json({ ok: false, error: "Unauthorized" }, { status: 401 })) as never;
    await expectDegraded();
  });

  it("scraper VM unreachable (network throw) → degraded connect (200)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as never;
    await expectDegraded();
  });
});
