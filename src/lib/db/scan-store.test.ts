import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConnectorRecord, saveChatGptContextSnapshot, searchConnectorRecords } from "./scan-store";

const mocks = vi.hoisted(() => ({
  prisma: {
    oneUser: {
      findUnique: vi.fn(),
    },
    chatGptContextSnapshot: {
      create: vi.fn(),
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

