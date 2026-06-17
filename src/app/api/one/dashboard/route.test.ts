import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOneRequest } from "@/lib/auth/verify";
import type { OneDashboardResult } from "@/lib/ria/types";

vi.mock("@/lib/auth/verify", () => ({
  isGuestOneUser: (user: { uid: string; provider?: string | null }) => user.provider === "guest" || user.uid.startsWith("guest:"),
  oneUserProvider: (user: { uid: string; provider?: string | null }) =>
    user.provider === "guest" || user.uid.startsWith("guest:") ? "guest" : user.provider === "dev" || user.uid === "dev-one-user" ? "dev" : "google",
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "ankit@example.com",
    name: "Ankit Kumar Singh",
    picture: null,
    provider: "google",
  })),
}));

vi.mock("@/lib/db/scan-store", () => ({
  upsertOneUser: vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000001" })),
  createConsentAndScan: vi.fn(async () => ({ scanRunId: "scan-1" })),
  completeScanRun: vi.fn(async () => undefined),
  failScanRun: vi.fn(async () => undefined),
}));

vi.mock("@/lib/notifications/scan-email", () => ({
  sendScanResultEmails: vi.fn(async () => ({
    user: { status: "sent", recipients: [{ recipient: "ankit@example.com", status: "sent", messageId: "msg-user" }], error: null },
    admins: { status: "sent", recipients: [{ recipient: "ankit@hushh.ai", status: "sent", messageId: "msg-admin" }], error: null },
  })),
}));

function shadowResult(): OneDashboardResult {
  return {
    scanRunId: "scan-1",
    mode: "precise",
    source: "shadow",
    subject: { name: "Ankit Kumar Singh", email: "ankit@example.com" },
    summary: "Shadow report summary",
    entityId: "Ankit Kumar Singh",
    categories: {
      newsAndMedia: [],
      socials: ["GitHub public profile"],
      education: [],
      government: [],
      otherFootprints: [],
      connectedIdentities: [],
    },
    privateDataEstimation: [],
    locationIntelligence: "Pune",
    auditJobId: null,
    redactions: [],
    warnings: [],
    rich: {
      overallConfidence: "medium",
      confidenceScore: 68,
      sourceCount: 5,
      professional: null,
      education: null,
      digitalFootprint: null,
      network: null,
      preferenceSignals: null,
      evidence: [],
      discovery: null,
      conflicts: [],
      missingEvidence: [],
      sourceUrls: [],
      sourceCards: [],
      verifiedWebCount: 0,
    },
  };
}

vi.mock("@/lib/ria/shadow", () => ({
  fetchShadowReport: vi.fn(async () => ({ success: true, status: "completed", report: { title: "ok" } })),
  mapShadowReport: vi.fn(() => shadowResult()),
}));

vi.mock("@/lib/ria/client", () => ({
  fetchDashboardIntelligence: vi.fn(async () => ({
    entityId: "Ankit Kumar Singh",
    summary: "Person-intelligence fallback summary",
    categorizedData: {
      newsAndMedia: [],
      socials: ["GitHub public profile"],
      education: [],
      government: [],
      otherFootprints: [],
      connectedIdentities: [],
    },
    privateDataEstimation: [],
    locationIntelligence: "Pune",
  })),
  buildTemporaryDashboard: vi.fn((input: { name: string }) => ({
    entityId: input.name,
    summary: "One saved the request while personal intelligence warms back up.",
    categorizedData: {
      newsAndMedia: [],
      socials: [],
      education: [],
      government: [],
      otherFootprints: ["Personal intelligence is queued for another pass."],
      connectedIdentities: [],
    },
    privateDataEstimation: [],
    locationIntelligence: "Temporary partial state.",
  })),
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/one/dashboard", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  name: "Ankit Kumar Singh",
  email: "ankit@example.com",
  latitude: 18.5643,
  longitude: 73.7398,
  consentAttestation: true,
  purpose: "self_audit",
};

const linkedinProfile = {
  sub: "ankit-kumar-singh",
  name: "Ankit Kumar Singh",
  givenName: "Ankit",
  familyName: "Kumar Singh",
  email: "ankit@example.com",
  emailVerified: false,
  locale: null,
  pictureUrl: "https://media.licdn.com/profile.jpg",
  profileUrl: "https://www.linkedin.com/in/ankit-kumar-singh",
  headline: "Founding Engineer at Hushh",
  source: "scraper",
  verifications: [],
  grantedScopes: ["scraper:linkedin-profile-url"],
  about: "Builder at Hushh.",
  experience: [{ title: "Founding Engineer", company: "Hushh Technologies LLC", current: true }],
  education: [],
  skills: ["AI"],
  certifications: [],
};

async function readStream(response: Response) {
  const text = await response.text();
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { lines, final: lines[lines.length - 1] };
}

describe("POST /api/one/dashboard (Hushh Shadow streaming)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams a Shadow-sourced result and emails it", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const { lines, final } = await readStream(response);
    expect(lines[0].type).toBe("start");
    expect(final.type).toBe("done");
    expect(final.ok).toBe(true);
    expect(final.result.source).toBe("shadow");

    const notifications = await import("@/lib/notifications/scan-email");
    expect(notifications.sendScanResultEmails).toHaveBeenCalledWith(
      expect.objectContaining({ scanRunId: "scan-1", audit: null, result: expect.objectContaining({ source: "shadow" }) }),
    );
  });

  it("allows Google users to stream without LinkedIn", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(200);
    const { final } = await readStream(response);
    expect(final.ok).toBe(true);
  });

  it("rejects guest users without LinkedIn before streaming", async () => {
    vi.mocked(verifyOneRequest).mockResolvedValueOnce({
      uid: "guest:dashboard",
      email: "guest@example.com",
      name: "Guest User",
      picture: null,
      provider: null,
    });
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ ...validBody, name: "Guest User", email: "guest@example.com" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.error).toContain("LinkedIn profile URL is required");

    const db = await import("@/lib/db/scan-store");
    expect(db.createConsentAndScan).not.toHaveBeenCalled();
  });

  it("accepts guest users with rich LinkedIn and persists the guest provider", async () => {
    vi.mocked(verifyOneRequest).mockResolvedValueOnce({
      uid: "guest:dashboard",
      email: "guest@example.com",
      name: "Guest User",
      picture: null,
      provider: "guest",
    });
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        ...validBody,
        name: "Guest User",
        email: "guest@example.com",
        linkedinProfile: { ...linkedinProfile, name: "Guest User", email: "guest@example.com" },
      }),
    );

    expect(response.status).toBe(200);
    await readStream(response);

    const db = await import("@/lib/db/scan-store");
    expect(db.upsertOneUser).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "guest:dashboard",
        email: "guest@example.com",
        provider: "guest",
      }),
    );
    const input = vi.mocked(db.createConsentAndScan).mock.calls[0]?.[0]?.input as {
      linkedinProfile?: { profileUrl?: string };
      confirmedProfiles?: Array<{ platform?: string; url?: string }>;
    };
    expect(input.linkedinProfile?.profileUrl).toBe("https://www.linkedin.com/in/ankit-kumar-singh");
    expect(input.confirmedProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "LinkedIn", url: "https://www.linkedin.com/in/ankit-kumar-singh" }),
      ]),
    );
  });

  it("rejects an email mismatch before streaming with a 403 JSON", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ ...validBody, email: "other@example.com" }));

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.ok).toBe(false);

    const notifications = await import("@/lib/notifications/scan-email");
    expect(notifications.sendScanResultEmails).not.toHaveBeenCalled();
  });

  it("renders a partial Shadow result (maps with partial status)", async () => {
    const shadow = await import("@/lib/ria/shadow");
    vi.mocked(shadow.fetchShadowReport).mockResolvedValueOnce({ success: true, status: "partial", report: { title: "p" } });

    const { POST } = await import("./route");
    const { final } = await readStream(await POST(makeRequest(validBody)));

    expect(final.type).toBe("done");
    expect(final.ok).toBe(true);
    expect(shadow.mapShadowReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "precise",
      "scan-1",
      "partial",
    );
  });

  it("falls back to person-intelligence when Shadow returns failed", async () => {
    const shadow = await import("@/lib/ria/shadow");
    const ria = await import("@/lib/ria/client");
    vi.mocked(shadow.fetchShadowReport).mockResolvedValueOnce({ success: false, status: "failed", report: {} });

    const { POST } = await import("./route");
    const { final } = await readStream(await POST(makeRequest(validBody)));

    expect(final.type).toBe("done");
    expect(final.result.source).toBe("person_intelligence");
    expect(shadow.mapShadowReport).not.toHaveBeenCalled();
    expect(ria.fetchDashboardIntelligence).toHaveBeenCalled();
  });

  it("falls back to person-intelligence when Shadow throws a transient error", async () => {
    const shadow = await import("@/lib/ria/shadow");
    vi.mocked(shadow.fetchShadowReport).mockRejectedValueOnce(
      Object.assign(new Error("temporarily unavailable"), { statusCode: 502, upstreamStatus: 502 }),
    );

    const { POST } = await import("./route");
    const { final } = await readStream(await POST(makeRequest(validBody)));

    expect(final.type).toBe("done");
    expect(final.result.source).toBe("person_intelligence");
  });

  it("surfaces a 503 config error when Shadow auth fails (no fallback)", async () => {
    const shadow = await import("@/lib/ria/shadow");
    const ria = await import("@/lib/ria/client");
    vi.mocked(shadow.fetchShadowReport).mockRejectedValueOnce(
      Object.assign(new Error("unauthorized"), { statusCode: 401, upstreamStatus: 401 }),
    );

    const { POST } = await import("./route");
    const { final } = await readStream(await POST(makeRequest(validBody)));

    expect(final.type).toBe("error");
    expect(final.status).toBe(503);
    expect(ria.fetchDashboardIntelligence).not.toHaveBeenCalled();
  });

  it("uses a temporary dashboard when both Shadow and person-intelligence fail", async () => {
    const shadow = await import("@/lib/ria/shadow");
    const ria = await import("@/lib/ria/client");
    vi.mocked(shadow.fetchShadowReport).mockRejectedValueOnce(
      Object.assign(new Error("temporarily unavailable"), { statusCode: 502, upstreamStatus: 502 }),
    );
    vi.mocked(ria.fetchDashboardIntelligence).mockRejectedValueOnce(
      Object.assign(new Error("also down"), { statusCode: 502, upstreamStatus: 502 }),
    );

    const { POST } = await import("./route");
    const { final } = await readStream(await POST(makeRequest(validBody)));

    expect(final.type).toBe("done");
    expect(final.result.source).toBe("temporary");
    expect(ria.buildTemporaryDashboard).toHaveBeenCalled();
  });

  it("keeps the scan successful when email delivery fails", async () => {
    const notifications = await import("@/lib/notifications/scan-email");
    vi.mocked(notifications.sendScanResultEmails).mockRejectedValueOnce(new Error("Gmail down"));

    const { POST } = await import("./route");
    const { final } = await readStream(await POST(makeRequest(validBody)));

    expect(final.type).toBe("done");
    expect(final.ok).toBe(true);
    expect(final.emailDelivery).toBeNull();
  });
});
