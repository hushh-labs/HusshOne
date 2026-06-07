import { beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_SCAN_ADMIN_RECIPIENTS } from "./allowlist";
import type { OneDashboardResult, PersonAuditStatus } from "@/lib/ria/types";

vi.mock("./gmail", () => ({
  sendGmailEmail: vi.fn(async () => ({ success: true, messageId: "gmail-message-1" })),
}));

vi.mock("@/lib/db/notification-store", () => ({
  createPendingOneNotification: vi.fn(async () => ({ id: "notification-1", skipped: false })),
  markOneNotificationSent: vi.fn(async () => undefined),
  markOneNotificationFailed: vi.fn(async () => undefined),
}));

const result: OneDashboardResult = {
  scanRunId: "00000000-0000-0000-0000-000000000111",
  mode: "precise",
  source: "shadow",
  subject: {
    name: "Ankit Kumar Singh",
    email: "ankit@example.com",
  },
  summary: "Source-backed profile summary with [redacted-phone]",
  entityId: "Ankit Kumar Singh",
  categories: {
    newsAndMedia: ["https://example.com/profile"],
    socials: ["GitHub public profile", "LinkedIn public profile"],
    education: ["University profile"],
    government: [],
    otherFootprints: ["Personal site"],
    connectedIdentities: ["https://github.com/ankit"],
  },
  privateDataEstimation: [
    {
      id: "private-1",
      label: "Signal type 1",
      detail: "Consumer platforms may hold records",
      confidence: "possible",
    },
  ],
  locationIntelligence: "Pune context",
  auditJobId: "audit-1",
  redactions: ["phone"],
  warnings: ["One stores sanitized dashboard results by default."],
  rich: {
    overallConfidence: "medium",
    confidenceScore: 68,
    sourceCount: 5,
    professional: {
      currentRole: "Product engineer",
      validatedClaims: ["Engineering role appears in public profiles"],
      unverifiedClaims: [],
      confidence: "medium",
    },
    education: null,
    digitalFootprint: {
      profiles: [{ platform: "GitHub", url: "https://github.com/ankit", confidence: "medium" }],
      handles: [],
    },
    network: null,
    preferenceSignals: null,
    evidence: [
      {
        claim: "Public code presence",
        category: "public_work",
        confidence: "medium",
        support: null,
        sources: ["https://github.com/ankit"],
      },
    ],
    discovery: null,
    conflicts: ["Two possible employers listed"],
    missingEvidence: ["No confirmed contact details"],
    sourceUrls: ["https://github.com/ankit"],
    sourceCards: [],
    verifiedWebCount: 0,
  },
};

const audit: PersonAuditStatus = {
  jobId: "audit-1",
  status: "running",
  totalShards: 107,
  completedShards: 12,
  failedShards: 1,
  reportAvailable: false,
  errors: [],
};

describe("sendScanResultEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the full normalized scan result to the user and admin allowlist", async () => {
    const { sendGmailEmail } = await import("./gmail");
    const { sendScanResultEmails } = await import("./scan-email");

    const delivery = await sendScanResultEmails({
      userId: "00000000-0000-0000-0000-000000000001",
      scanRunId: result.scanRunId,
      result,
      audit,
      completedAt: new Date("2026-06-05T12:00:00.000Z"),
    });

    expect(delivery.user.status).toBe("sent");
    expect(delivery.admins.status).toBe("sent");
    expect(sendGmailEmail).toHaveBeenCalledTimes(1 + FULL_SCAN_ADMIN_RECIPIENTS.length);

    const html = vi.mocked(sendGmailEmail).mock.calls.map(([input]) => input.htmlContent).join("\n");
    expect(html).toContain("GitHub public profile");
    expect(html).toContain("Consumer platforms may hold records");
    expect(html).toContain("Pune context");
    expect(html).toContain("&quot;scanRunId&quot;");
    expect(html).toContain("audit-1");
    // rich Shadow sections
    expect(html).toContain("Overall confidence");
    expect(html).toContain("Evidence ledger");
    expect(html).toContain("Two possible employers listed");
  });

  it("records failed sends without hiding the recipient-level status", async () => {
    const { sendGmailEmail } = await import("./gmail");
    const store = await import("@/lib/db/notification-store");
    vi.mocked(sendGmailEmail).mockImplementation(async (input) =>
      input.recipients[0] === "ankit@example.com"
        ? { success: false, error: "Missing Google Service Account credentials" }
        : { success: true, messageId: "gmail-message-1" },
    );
    const { sendScanResultEmails } = await import("./scan-email");

    const delivery = await sendScanResultEmails({
      userId: "00000000-0000-0000-0000-000000000001",
      scanRunId: result.scanRunId,
      result,
      audit,
    });

    expect(delivery.user.status).toBe("failed");
    expect(delivery.user.recipients[0]?.error).toBe("Missing Google Service Account credentials");
    expect(store.markOneNotificationFailed).toHaveBeenCalledWith(
      "notification-1",
      "Missing Google Service Account credentials",
    );
  });

  it("skips duplicate notification rows before calling Gmail", async () => {
    const { sendGmailEmail } = await import("./gmail");
    const store = await import("@/lib/db/notification-store");
    vi.mocked(store.createPendingOneNotification).mockResolvedValue({ id: null, skipped: true, error: "duplicate_notification" });
    const { sendScanResultEmails } = await import("./scan-email");

    const delivery = await sendScanResultEmails({
      userId: "00000000-0000-0000-0000-000000000001",
      scanRunId: result.scanRunId,
      result,
      audit,
    });

    expect(delivery.user.status).toBe("skipped");
    expect(delivery.admins.status).toBe("skipped");
    expect(sendGmailEmail).not.toHaveBeenCalled();
  });
});
