import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOneRequest } from "@/lib/auth/verify";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  persistXAccessRecord: vi.fn(async () => undefined),
  persistXProfile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "user@example.com",
    name: "User Example",
    picture: null,
  })),
}));

vi.mock("@/lib/x/connection", () => ({
  persistXAccessRecord: mocks.persistXAccessRecord,
  persistXProfile: mocks.persistXProfile,
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/x/enrich-url", {
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
        profileId: "sundarpichai",
        profileUrl: "https://x.com/sundarpichai",
        template: {
          username: "sundarpichai",
          profileUrl: "https://x.com/sundarpichai",
          displayName: "Sundar Pichai",
          bio: "CEO of Google and Alphabet",
          avatarUrl: "https://cdn.example.com/avatar.jpg",
          bannerUrl: "https://cdn.example.com/banner.jpg",
          externalUrl: "https://google.com",
          isVerified: true,
          isProtected: false,
          stats: { followers: "6.5M", following: "200", posts: "3,412" },
          timelineItems: [
            {
              url: "https://x.com/sundarpichai/status/123",
              id: "123",
              tab: "posts",
              text: "AI product update from Google",
              mediaUrls: ["https://cdn.example.com/post.jpg"],
              externalLinks: ["https://blog.google/example"],
              likeCount: "1200",
              replyCount: "42",
            },
          ],
          access: { state: "public_visible", canScrapePosts: true },
          visibleProfileText: ["CEO of Google and Alphabet"],
        },
        access: { state: "public_visible", canScrapePosts: true },
        ...overrides,
      },
    ],
  };
}

describe("POST /api/x/enrich-url", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("TWITTER_SCRAPER_URL", "http://twitter-scraper.local");
    vi.stubEnv("TWITTER_SCRAPER_API_KEY", "test-key");
    global.fetch = vi.fn(async () => Response.json(scraperResponse())) as never;
  });

  it("requires Firebase auth before calling the scraper", async () => {
    vi.mocked(verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));

    const res = await POST(makeRequest({ url: "https://x.com/sundarpichai" }));
    const json = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistXProfile).not.toHaveBeenCalled();
  });

  it("rejects invalid X URLs before calling the worker", async () => {
    const res = await POST(makeRequest({ url: "https://x.com/sundarpichai/status/123" }));
    const json = (await res.json()) as { ok?: boolean; code?: string };

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ ok: false, code: "invalid_x_url" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistXProfile).not.toHaveBeenCalled();
  });

  it("enriches, maps, and persists a public X profile URL", async () => {
    const res = await POST(makeRequest({ url: "twitter.com/sundarpichai?lang=en" }));
    const json = (await res.json()) as {
      ok?: boolean;
      normalizedUrl?: string;
      profile?: { username?: string; source?: string; timelineItems?: Array<{ likeCount?: string; externalLinks?: string[] }> };
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.normalizedUrl).toBe("https://x.com/sundarpichai");
    expect(json.profile).toMatchObject({ username: "sundarpichai", source: "scraper" });
    expect(json.profile?.timelineItems?.[0]).toMatchObject({ likeCount: "1200", externalLinks: ["https://blog.google/example"] });
    expect(mocks.persistXProfile).toHaveBeenCalledTimes(1);
    expect(mocks.persistXAccessRecord).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://twitter-scraper.local/scrape",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: JSON.stringify({ url: "https://x.com/sundarpichai", maxPosts: 300 }),
      }),
    );
  });
});
