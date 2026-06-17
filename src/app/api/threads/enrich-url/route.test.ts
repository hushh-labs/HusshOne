import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOneRequest } from "@/lib/auth/verify";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  persistThreadsAccessRecord: vi.fn(async () => undefined),
  persistThreadsProfile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "user@example.com",
    name: "User Example",
    picture: null,
  })),
}));

vi.mock("@/lib/threads/connection", () => ({
  persistThreadsAccessRecord: mocks.persistThreadsAccessRecord,
  persistThreadsProfile: mocks.persistThreadsProfile,
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/threads/enrich-url", {
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
        profileId: "threads",
        profileUrl: "https://www.threads.com/@threads",
        template: {
          username: "threads",
          profileUrl: "https://www.threads.com/@threads",
          displayName: "Threads",
          bio: "Say more with Threads.",
          avatarUrl: "https://cdn.example.com/avatar.jpg",
          externalUrl: "https://about.example.com/",
          isVerified: true,
          isPrivate: false,
          stats: { followers: "6.5M", threads: "1.2K", following: null },
          recentThreads: [
            {
              url: "https://www.threads.com/@threads/post/Cabc123",
              text: "Visible post",
              contentSeed: "Visible post https://example.com/article",
              thumbnailUrl: "https://cdn.example.com/post.jpg",
              feedPhotoUrl: "https://cdn.example.com/post.jpg",
              mediaUrls: ["https://cdn.example.com/post.jpg"],
              externalLinks: ["https://example.com/article"],
              position: 1,
              likeCount: "126",
              replyCount: "3",
              repostCount: "2",
            },
          ],
          access: { state: "public_visible", canScrapePosts: true },
          visibleProfileText: ["Say more with Threads."],
        },
        access: { state: "public_visible", canScrapePosts: true },
        ...overrides,
      },
    ],
  };
}

describe("POST /api/threads/enrich-url", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("THREADS_SCRAPER_URL", "http://threads-scraper.local");
    vi.stubEnv("THREADS_SCRAPER_API_KEY", "test-key");
    global.fetch = vi.fn(async () => Response.json(scraperResponse())) as never;
  });

  it("requires Firebase auth before calling the scraper", async () => {
    vi.mocked(verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));

    const res = await POST(makeRequest({ url: "https://www.threads.com/@threads" }));
    const json = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistThreadsProfile).not.toHaveBeenCalled();
  });

  it("rejects invalid Threads URLs before calling the worker", async () => {
    const res = await POST(makeRequest({ url: "https://www.threads.com/@threads/post/ABC" }));
    const json = (await res.json()) as { ok?: boolean; code?: string };

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ ok: false, code: "invalid_threads_url" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.persistThreadsProfile).not.toHaveBeenCalled();
  });

  it("returns a controlled 202 for private Threads profiles", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({
        ok: false,
        count: 1,
        results: [
          {
            ok: false,
            profileId: "private_user",
            profileUrl: "https://www.threads.com/@private_user",
            type: "ThreadsAccessPending",
            error: "Threads follow request is pending owner approval. One will continue without Threads social context for now.",
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
              username: "private_user",
              profileUrl: "https://www.threads.com/@private_user",
              displayName: "Private User",
              isPrivate: true,
              stats: { followers: "482", threads: "59" },
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

    const res = await POST(makeRequest({ url: "https://www.threads.com/@private_user" }));
    const json = (await res.json()) as { ok?: boolean; code?: string; error?: string; access?: { state?: string } };

    expect(res.status).toBe(202);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("threads_access_pending");
    expect(json.access?.state).toBe("follow_requested");
    expect(json.error).toContain("pending");
    expect(mocks.persistThreadsProfile).not.toHaveBeenCalled();
    expect(mocks.persistThreadsAccessRecord).toHaveBeenCalledTimes(1);
  });

  it("enriches, maps, and persists a public Threads profile URL", async () => {
    const res = await POST(makeRequest({ url: "threads.com/@threads?hl=en" }));
    const json = (await res.json()) as {
      ok?: boolean;
      normalizedUrl?: string;
      profile?: { username?: string; source?: string; recentThreads?: Array<{ likeCount?: string }>; visibleProfileText?: string[] };
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.normalizedUrl).toBe("https://www.threads.com/@threads");
    expect(json.profile).toMatchObject({ username: "threads", source: "scraper" });
    expect(json.profile?.recentThreads).toHaveLength(1);
    expect(json.profile?.recentThreads?.[0]).toMatchObject({ likeCount: "126" });
    expect(json.profile?.visibleProfileText).toEqual(["Say more with Threads."]);
    expect(mocks.persistThreadsProfile).toHaveBeenCalledTimes(1);
    expect(mocks.persistThreadsAccessRecord).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://threads-scraper.local/scrape",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: JSON.stringify({ url: "https://www.threads.com/@threads" }),
      }),
    );
  });
});
