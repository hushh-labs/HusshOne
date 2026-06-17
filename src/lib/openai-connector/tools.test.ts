import { beforeEach, describe, expect, it, vi } from "vitest";
import { callConnectorToolForUser, connectorTools } from "./tools";
import type { ConnectorUser } from "./oauth";

const mocks = vi.hoisted(() => ({
  fetchConnectorRecord: vi.fn(),
  getLatestScanForUser: vi.fn(),
  getOwnedScanRun: vi.fn(),
  getScanEmailDelivery: vi.fn(),
  saveChatGptContextSnapshot: vi.fn(),
  searchConnectorRecords: vi.fn(),
}));

vi.mock("@/lib/db/scan-store", () => ({
  fetchConnectorRecord: mocks.fetchConnectorRecord,
  getLatestScanForUser: mocks.getLatestScanForUser,
  getOwnedScanRun: mocks.getOwnedScanRun,
  getScanEmailDelivery: mocks.getScanEmailDelivery,
  saveChatGptContextSnapshot: mocks.saveChatGptContextSnapshot,
  searchConnectorRecords: mocks.searchConnectorRecords,
}));

vi.mock("@/lib/linkedin/connection", () => ({ persistConnectedProfile: vi.fn() }));
vi.mock("@/lib/linkedin/profile", () => ({ hasUrlEnrichedLinkedInProfile: vi.fn(() => true) }));
vi.mock("@/lib/linkedin/scraper-profile", () => ({ scrapeLinkedInProfileUrl: vi.fn() }));
vi.mock("@/lib/instagram/connection", () => ({ persistInstagramAccessRecord: vi.fn(), persistInstagramProfile: vi.fn() }));
vi.mock("@/lib/instagram/profile", () => ({ hasInstagramProfile: vi.fn(() => true) }));
vi.mock("@/lib/instagram/scraper-profile", () => ({ scrapeInstagramProfileUrl: vi.fn() }));

const user: ConnectorUser = {
  firebaseUid: "firebase-1",
  email: "user@example.com",
  name: "User Example",
  picture: null,
  scopes: ["one.profile.read", "one.context.write"],
};

describe("one_save_chatgpt_context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveChatGptContextSnapshot.mockResolvedValue({
      snapshotId: "snapshot-1",
      savedAt: "2026-06-16T12:00:00.000Z",
      source: "chatgpt_user_approved_summary",
    });
  });

  it("is exposed with explicit write annotations and output schema", () => {
    const tool = connectorTools.find((item) => item.name === "one_save_chatgpt_context");

    expect(tool).toBeTruthy();
    expect(tool?.annotations).toEqual({ readOnlyHint: false, openWorldHint: false, destructiveHint: false });
    expect(tool?.outputSchema).toMatchObject({
      required: ["ok", "snapshotId", "savedAt", "source"],
    });
  });

  it("requires the context write scope", async () => {
    const result = await callConnectorToolForUser(
      { ...user, scopes: ["one.profile.read"] },
      "one_save_chatgpt_context",
      { summary: "Save this approved context." },
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "connector_tool_failed" },
    });
    expect(mocks.saveChatGptContextSnapshot).not.toHaveBeenCalled();
  });

  it("rejects empty summaries", async () => {
    const result = await callConnectorToolForUser(user, "one_save_chatgpt_context", { summary: "   " });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "chatgpt_context_summary_required" },
    });
    expect(mocks.saveChatGptContextSnapshot).not.toHaveBeenCalled();
  });

  it("saves only the user-approved summary payload", async () => {
    const result = await callConnectorToolForUser(user, "one_save_chatgpt_context", {
      summary: "User is building one by hushh and prefers concise execution updates.",
      categories: ["goals", "preferences", "goals"],
      userPrompt: "Save this to one.hushh.ai.",
      consentText: "User explicitly asked ChatGPT to save this summary.",
    });

    expect(result).toMatchObject({
      structuredContent: {
        ok: true,
        snapshotId: "snapshot-1",
        savedAt: "2026-06-16T12:00:00.000Z",
        source: "chatgpt_user_approved_summary",
      },
    });
    expect(mocks.saveChatGptContextSnapshot).toHaveBeenCalledWith({
      firebaseUid: "firebase-1",
      summary: "User is building one by hushh and prefers concise execution updates.",
      categories: ["goals", "preferences"],
      userPrompt: "Save this to one.hushh.ai.",
      consentText: "User explicitly asked ChatGPT to save this summary.",
    });
  });
});

