import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOneRequest } from "@/lib/auth/verify";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  persistInstagramAccessRecord: vi.fn(async () => undefined),
  persistInstagramProfile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "user@example.com",
    name: "User Example",
    picture: null,
  })),
}));

vi.mock("@/lib/instagram/connection", () => ({
  persistInstagramAccessRecord: mocks.persistInstagramAccessRecord,
  persistInstagramProfile: mocks.persistInstagramProfile,
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/instagram/enrich-url", {
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
        profileId: "ankit_ya_i_am",
        profileUrl: "https://www.instagram.com/ankit_ya_i_am/",
        template: {
          username: "ankit_ya_i_am",
          profileUrl: "https://www.instagram.com/ankit_ya_i_am/",
          displayName: "Ankit Kumar Singh",
          bio: "Builder at Hushh",
          avatarUrl: "https://cdn.example.com/avatar.jpg",
          externalUrl: "https://ankit.example.com/",
          isVerified: false,
          isPrivate: false,
          stats: { posts: "42", followers: "1,234", following: "567" },
          highlights: [{ title: "Bengaluru", thumbnailUrl: "https://cdn.example.com/highlight.jpg" }],
          recentPublicPosts: [
            {
              url: "https://www.instagram.com/p/abc/",
              caption: "Demo",
              thumbnailUrl: "https://cdn.example.com/post.jpg",
              cdnUrls: ["https://cdn.example.com/post.jpg"],
              position: 1,
              isCarousel: true,
              likes: "126",
              comments: "3",
            },
          ],
          access: { state: "public_visible", canScrapePosts: true },
          visibleProfileText: ["Builder at Hushh"],
        },
        access: { state: "public_visible", canScrapePosts: true },
        ...overrides,
      },
    ],
  };
}

describe("POST /api/instagram/enrich-url", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("INSTAGRAM_SCRAPER_URL", "http://instagram-scraper.local");
    vi.stubEnv("INSTAGRAM_SCRAPER_API_KEY", "test-key");
    global.fetch = vi.fn(async () => Response.json(scraperResponse())) as never;
  });

  it("requires auth before calling the scraper", async () => {
    vi.mocked(verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));

    const res = await POST(makeRequest({ url: "https://www.instagram.com/ankit_ya_i_am/" }));
    const json = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistInstagramProfile).not.toHaveBeenCalled();
  });

  it("rejects invalid Instagram URLs before calling the worker", async () => {
    const res = await POST(makeRequest({ url: "https://www.instagram.com/p/abc/" }));
    const json = (await res.json()) as { ok?: boolean; code?: string };

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ ok: false, code: "invalid_instagram_url" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistInstagramProfile).not.toHaveBeenCalled();
  });

  it("maps upstream timeout failures to 504", async () => {
    global.fetch = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as never;

    const res = await POST(makeRequest({ url: "https://www.instagram.com/ankit_ya_i_am/" }));
    const json = (await res.json()) as { ok?: boolean; code?: string; error?: string };

    expect(res.status).toBe(504);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("instagram_scraper_timeout");
    expect(json.error).toContain("took too long");
    expect(mocks.persistInstagramProfile).not.toHaveBeenCalled();
  });

  it("returns a controlled 202 for private Instagram profiles after requesting access", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({
        ok: false,
        count: 1,
        results: [
          {
            ok: false,
            profileId: "sumitsoni922",
            profileUrl: "https://www.instagram.com/sumitsoni922/",
            type: "InstagramAccessPending",
            error: "Instagram follow request is pending owner approval. One will continue without Instagram social context for now.",
            access: {
              state: "follow_requested",
              canScrapePosts: false,
              isPrivate: true,
              outgoingRequest: true,
              checkedAt: "2026-06-15T10:00:00.000Z",
              nextCheckAfter: "2026-06-15T16:00:00.000Z",
              reason: "Follow request is pending owner approval.",
            },
            template: {
              username: "sumitsoni922",
              profileUrl: "https://www.instagram.com/sumitsoni922/",
              displayName: "Sumit Soni",
              isPrivate: true,
              stats: { posts: "59", followers: "482", following: "610" },
              access: {
                state: "follow_requested",
                canScrapePosts: false,
                isPrivate: true,
                outgoingRequest: true,
                checkedAt: "2026-06-15T10:00:00.000Z",
                nextCheckAfter: "2026-06-15T16:00:00.000Z",
                reason: "Follow request is pending owner approval.",
              },
            },
          },
        ],
      }),
    ) as never;

    const res = await POST(makeRequest({ url: "https://www.instagram.com/sumitsoni922/" }));
    const json = (await res.json()) as { ok?: boolean; code?: string; error?: string; access?: { state?: string } };

    expect(res.status).toBe(202);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("instagram_access_pending");
    expect(json.access?.state).toBe("follow_requested");
    expect(json.error).toContain("pending");
    expect(mocks.persistInstagramProfile).not.toHaveBeenCalled();
    expect(mocks.persistInstagramAccessRecord).toHaveBeenCalledTimes(1);
  });

  it("enriches, maps, and persists a public Instagram profile URL", async () => {
    const res = await POST(makeRequest({ url: "instagram.com/ankit_ya_i_am?hl=en" }));
    const json = (await res.json()) as {
      ok?: boolean;
      normalizedUrl?: string;
      profile?: { username?: string; source?: string; highlights?: unknown[]; recentPublicPosts?: Array<{ isCarousel?: boolean }>; visibleProfileText?: string[] };
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.normalizedUrl).toBe("https://www.instagram.com/ankit_ya_i_am/");
    expect(json.profile).toMatchObject({ username: "ankit_ya_i_am", source: "scraper" });
    expect(json.profile?.highlights).toHaveLength(1);
    expect(json.profile?.recentPublicPosts).toHaveLength(1);
    expect(json.profile?.recentPublicPosts?.[0]?.isCarousel).toBe(true);
    expect(json.profile?.recentPublicPosts?.[0]).toMatchObject({ thumbnailUrl: "https://cdn.example.com/post.jpg" });
    expect(json.profile?.visibleProfileText).toEqual(["Builder at Hushh"]);
    expect(mocks.persistInstagramProfile).toHaveBeenCalledTimes(1);
    expect(mocks.persistInstagramAccessRecord).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://instagram-scraper.local/scrape",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: JSON.stringify({ url: "https://www.instagram.com/ankit_ya_i_am/" }),
      }),
    );
  });
});
