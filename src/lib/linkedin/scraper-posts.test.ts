import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrapeLinkedInPostsUrl, LinkedInPostsScraperError } from "./scraper-posts";

const URL = "https://www.linkedin.com/in/ankit-kumar-singh/";

describe("scrapeLinkedInPostsUrl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LINKEDIN_SCRAPER_URL = "http://scraper.test:8080";
    process.env.LINKEDIN_SCRAPER_API_KEY = "k";
  });
  afterEach(() => {
    delete process.env.LINKEDIN_SCRAPER_URL;
    delete process.env.LINKEDIN_SCRAPER_API_KEY;
  });

  function mockFetch(status: number, body: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
  }

  it("maps a successful response into a LinkedIn posts profile (platform LinkedIn, posts cleaned)", async () => {
    mockFetch(200, {
      ok: true,
      profileUrl: URL,
      count: 2,
      posts: [
        { urn: "urn:li:activity:1", url: "https://www.linkedin.com/feed/update/urn:li:activity:1/", type: "post", text: "  Hello   world ", reactions: "10", media: ["https://m.licdn.com/a.jpg"] },
        { urn: "urn:li:activity:2", type: "reshare", text: "", media: [] }, // empty → dropped
      ],
    });
    const outcome = await scrapeLinkedInPostsUrl(URL, { maxPosts: 240 });
    expect(outcome.status).toBe("profile");
    if (outcome.status !== "profile") return;
    expect(outcome.profile.platform).toBe("LinkedIn");
    expect(outcome.profile.username).toBe("ankit-kumar-singh");
    expect(outcome.profile.recentPosts).toHaveLength(1); // the empty post was dropped
    expect(outcome.profile.recentPosts?.[0].text).toBe("Hello world");
  });

  it("returns authwall (soft) on a 503 so the worker retries instead of hard-erroring", async () => {
    mockFetch(503, { ok: false, error: "authwall" });
    const outcome = await scrapeLinkedInPostsUrl(URL);
    expect(outcome.status).toBe("authwall");
  });

  it("returns authwall when the body flags it even on a 200", async () => {
    mockFetch(200, { ok: true, authwall: true, posts: [] });
    const outcome = await scrapeLinkedInPostsUrl(URL);
    expect(outcome.status).toBe("authwall");
  });

  it("returns empty when the scrape succeeds with zero usable posts", async () => {
    mockFetch(200, { ok: true, posts: [] });
    const outcome = await scrapeLinkedInPostsUrl(URL);
    expect(outcome.status).toBe("empty");
  });

  it("throws on an invalid URL (terminal)", async () => {
    await expect(scrapeLinkedInPostsUrl("not-a-linkedin-url")).rejects.toBeInstanceOf(LinkedInPostsScraperError);
  });

  it("throws not_configured when the API key is missing", async () => {
    delete process.env.LINKEDIN_SCRAPER_API_KEY;
    await expect(scrapeLinkedInPostsUrl(URL)).rejects.toMatchObject({ code: "linkedin_posts_not_configured" });
  });
});
