import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConnectorRecord, indexSocialArchive, indexSocialPreferenceEvidence, saveChatGptContextSnapshot, searchConnectorRecords } from "./scan-store";
import { ARCHIVE_MAX_ITEMS_PER_PROFILE } from "@/lib/social-intelligence/archive";
import type { SocialProfileFull } from "@/lib/ria/types";

const mocks = vi.hoisted(() => ({
  prisma: {
    oneUser: {
      findUnique: vi.fn(),
    },
    chatGptContextSnapshot: {
      create: vi.fn(),
    },
    socialContentItem: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    socialMediaAsset: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("./prisma", () => ({
  getPrismaClient: () => mocks.prisma,
}));

const snapshot = {
  id: "11111111-1111-1111-1111-111111111111",
  summary: "User is building one by hushh and prefers concise execution updates.",
  categories: ["goals", "preferences"],
  source: "chatgpt_user_approved_summary",
  capturedVia: "openai_connector",
  userPrompt: "Save this to one.hushh.ai.",
  consentText: "User explicitly approved this save.",
  metadata: null,
  createdAt: new Date("2026-06-16T12:00:00.000Z"),
  updatedAt: new Date("2026-06-16T12:05:00.000Z"),
};

function accountBundle(overrides: Record<string, unknown> = {}) {
  return {
    firebaseUid: "firebase-1",
    email: "user@example.com",
    name: "User Example",
    photoUrl: null,
    linkedInConnection: null,
    socialConnections: [],
    socialAccessRequests: [],
    scanRuns: [],
    chatGptContextSnapshots: [snapshot],
    ...overrides,
  };
}

describe("ChatGPT context connector records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves ChatGPT context snapshots against the One user", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce({ id: "one-user-id" });
    mocks.prisma.chatGptContextSnapshot.create.mockResolvedValueOnce({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      source: snapshot.source,
    });

    const saved = await saveChatGptContextSnapshot({
      firebaseUid: "firebase-1",
      summary: snapshot.summary,
      categories: ["goals", "preferences"],
      userPrompt: snapshot.userPrompt,
      consentText: snapshot.consentText,
    });

    expect(saved).toEqual({
      snapshotId: snapshot.id,
      savedAt: "2026-06-16T12:00:00.000Z",
      source: "chatgpt_user_approved_summary",
    });
    expect(mocks.prisma.chatGptContextSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "one-user-id",
          summary: snapshot.summary,
          categories: ["goals", "preferences"],
          source: "chatgpt_user_approved_summary",
          capturedVia: "openai_connector",
        }),
      }),
    );
  });

  it("returns saved ChatGPT context in connector search results", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce(accountBundle());

    const results = await searchConnectorRecords("firebase-1", "concise", "chatgpt_context", 10);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: `chatgpt-context:${snapshot.id}`,
      title: "ChatGPT context import: 2026-06-16T12:00:00.000Z",
      text: snapshot.summary,
      metadata: {
        type: "chatgpt_context",
        snapshotId: snapshot.id,
        source: "chatgpt_user_approved_summary",
        capturedVia: "openai_connector",
      },
    });
  });

  it("fetches only snapshots in the requesting user's account bundle", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce(accountBundle());
    const owned = await fetchConnectorRecord("firebase-1", `chatgpt-context:${snapshot.id}`);

    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce(accountBundle({ chatGptContextSnapshots: [] }));
    const missing = await fetchConnectorRecord("firebase-1", `chatgpt-context:${snapshot.id}`);

    expect(owned?.metadata).toMatchObject({ type: "chatgpt_context", snapshotId: snapshot.id });
    expect(owned?.text).toContain(snapshot.summary);
    expect(missing).toBeNull();
  });
});

describe("social preference evidence indexing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts visible social content and media assets without LinkedIn rows", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce({ id: "one-user-id" });
    mocks.prisma.socialContentItem.upsert.mockResolvedValue({});
    mocks.prisma.socialMediaAsset.upsert.mockResolvedValue({});

    const result = await indexSocialPreferenceEvidence({
      firebaseUid: "firebase-1",
      scanRunId: "scan-1",
      version: "2026-06-18.social-preference-questions-v2",
      evidence: [
        {
          id: "ig1",
          platform: "instagram",
          type: "media",
          url: "https://www.instagram.com/p/abc/",
          text: "Goa sea view coffee",
          mediaUrl: "https://cdn.example.com/goa.jpg",
          timestamp: "2026-06-18T10:00:00.000Z",
          reason: "instagram visible text plus media context.",
          signals: ["seaside / beach-view places"],
        },
        {
          id: "li1",
          platform: "linkedin",
          type: "profile",
          url: "https://www.linkedin.com/in/user",
          text: "AI product leader",
          mediaUrl: null,
          timestamp: null,
          reason: "LinkedIn career anchor",
          signals: ["AI"],
        },
      ],
    });

    expect(result).toEqual({ contentItems: 1, mediaAssets: 1 });
    expect(mocks.prisma.socialContentItem.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.socialContentItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_platform_itemId: { userId: "one-user-id", platform: "instagram", itemId: "ig1" } },
        create: expect.objectContaining({
          publicId: "visible-feed",
          itemUrl: "https://www.instagram.com/p/abc/",
          itemType: "media",
          text: "Goa sea view coffee",
          features: expect.objectContaining({
            indexVersion: "2026-06-18.social-preference-questions-v2",
            source: "preference_v2_fast_pass",
            scanRunId: "scan-1",
            evidenceId: "ig1",
          }),
        }),
      }),
    );
    expect(mocks.prisma.socialMediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_platform_assetHash: { userId: "one-user-id", platform: "instagram", assetHash: expect.any(String) } },
        create: expect.objectContaining({
          sourceUrl: "https://cdn.example.com/goa.jpg",
          analysis: expect.objectContaining({
            status: "pending",
            provider: "vertex_gemini_cloud_vision",
            sourceEvidenceIds: ["ig1"],
          }),
        }),
      }),
    );
  });

  it("swallows optional indexing failures", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce({ id: "one-user-id" });
    mocks.prisma.socialContentItem.upsert.mockRejectedValueOnce(new Error("missing table"));

    const result = await indexSocialPreferenceEvidence({
      firebaseUid: "firebase-1",
      version: "2026-06-18.social-preference-questions-v2",
      evidence: [
        {
          id: "x1",
          platform: "x",
          type: "post",
          url: "https://x.com/user/status/1",
          text: "Coffee",
          mediaUrl: null,
          timestamp: null,
          reason: "x visible text",
          signals: [],
        },
      ],
    });

    expect(result).toBeNull();
  });
});

describe("indexSocialArchive rolling window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function igProfile(): SocialProfileFull {
    return {
      platform: "Instagram",
      username: "ankit",
      displayName: null,
      bio: null,
      avatarUrl: null,
      externalUrl: null,
      profileUrl: "https://www.instagram.com/ankit/",
      source: "scraper",
      recentPublicPosts: [
        { url: "https://www.instagram.com/p/a/", kind: "post", caption: "a" },
        { url: "https://www.instagram.com/p/b/", kind: "post", caption: "b" },
      ],
    } as unknown as SocialProfileFull;
  }

  it("evicts the oldest beyond the rolling window (latest-in/oldest-out)", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce({ id: "u" });
    mocks.prisma.socialContentItem.upsert.mockResolvedValue({});
    mocks.prisma.socialMediaAsset.upsert.mockResolvedValue({});
    // Archive is full → findMany returns exactly the window of newest ids to KEEP.
    const keep = Array.from({ length: ARCHIVE_MAX_ITEMS_PER_PROFILE }, (_, i) => ({ id: `keep-${i}` }));
    mocks.prisma.socialContentItem.findMany.mockResolvedValueOnce(keep);
    mocks.prisma.socialContentItem.deleteMany.mockResolvedValueOnce({ count: 7 });

    await indexSocialArchive({ firebaseUid: "firebase-1", scanRunId: "scan-1", version: "v", profiles: [igProfile()] });

    expect(mocks.prisma.socialContentItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u", platform: "instagram" }, take: ARCHIVE_MAX_ITEMS_PER_PROFILE }),
    );
    expect(mocks.prisma.socialContentItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u", platform: "instagram", id: { notIn: keep.map((k) => k.id) } },
    });
  });

  it("does NOT evict when the archive is under the rolling window", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce({ id: "u" });
    mocks.prisma.socialContentItem.upsert.mockResolvedValue({});
    mocks.prisma.socialMediaAsset.upsert.mockResolvedValue({});
    mocks.prisma.socialContentItem.findMany.mockResolvedValueOnce([{ id: "only-1" }]);

    await indexSocialArchive({ firebaseUid: "firebase-1", scanRunId: null, version: "v", profiles: [igProfile()] });

    expect(mocks.prisma.socialContentItem.deleteMany).not.toHaveBeenCalled();
  });

  it("never breaks a scan if eviction throws (best-effort)", async () => {
    mocks.prisma.oneUser.findUnique.mockResolvedValueOnce({ id: "u" });
    mocks.prisma.socialContentItem.upsert.mockResolvedValue({});
    mocks.prisma.socialMediaAsset.upsert.mockResolvedValue({});
    mocks.prisma.socialContentItem.findMany.mockRejectedValueOnce(new Error("db blip"));

    const result = await indexSocialArchive({ firebaseUid: "firebase-1", scanRunId: null, version: "v", profiles: [igProfile()] });

    // content still indexed; eviction failure is swallowed
    expect(result?.contentItems).toBe(2);
  });
});
