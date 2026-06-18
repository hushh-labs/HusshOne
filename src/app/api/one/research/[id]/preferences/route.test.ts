import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  getResearchJob: vi.fn(),
  getUserPreferenceProfile: vi.fn(async (): Promise<unknown> => null),
  getUserPreferenceProfileByInputHash: vi.fn(async (): Promise<unknown> => null),
  hasPendingPreferenceWork: vi.fn(async () => false),
  indexSocialPreferenceEvidence: vi.fn(async () => ({ contentItems: 1, mediaAssets: 1 })),
  logUserPreferenceRun: vi.fn(async () => undefined),
  saveUserPreferenceProfile: vi.fn(async () => undefined),
  updateDeepTier: vi.fn(async (_uid: string, _id: string, fields: Record<string, unknown>) => ({
    scanRunId: "scan-1",
    report: "# Dossier",
    ...fields,
  })),
}));

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "user@example.com",
    name: "User Example",
    picture: null,
  })),
}));

vi.mock("@/lib/db/scan-store", () => ({
  getResearchJob: mocks.getResearchJob,
  getUserPreferenceProfile: mocks.getUserPreferenceProfile,
  getUserPreferenceProfileByInputHash: mocks.getUserPreferenceProfileByInputHash,
  hasPendingPreferenceWork: mocks.hasPendingPreferenceWork,
  indexSocialPreferenceEvidence: mocks.indexSocialPreferenceEvidence,
  logUserPreferenceRun: mocks.logUserPreferenceRun,
  saveUserPreferenceProfile: mocks.saveUserPreferenceProfile,
  updateDeepTier: mocks.updateDeepTier,
}));

const result = {
  scanRunId: "scan-1",
  mode: "precise",
  source: "deep_research",
  subject: { name: "User Example", email: "user@example.com" },
  summary: "Summary",
  entityId: "User Example",
  categories: { newsAndMedia: [], socials: [], education: [], government: [], otherFootprints: [], connectedIdentities: [] },
  privateDataEstimation: [],
  locationIntelligence: null,
  auditJobId: null,
  redactions: [],
  warnings: [],
  rich: null,
  report: "# Dossier",
};

function request() {
  return new Request("http://localhost/api/one/research/scan-1/preferences", {
    headers: { Authorization: "Bearer test" },
  });
}

function context() {
  return { params: Promise.resolve({ id: "scan-1" }) };
}

describe("GET /api/one/research/[id]/preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips preference synthesis when social preference consent is absent", async () => {
    mocks.getResearchJob.mockResolvedValueOnce({
      status: "completed",
      normalizedResult: result,
      input: {
        socialPreferenceConsent: false,
        socialProfiles: [],
      },
    });

    const res = await GET(request(), context());
    const json = (await res.json()) as { ok?: boolean; preferenceStatus?: string };

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, preferenceStatus: "skipped" });
    expect(mocks.saveUserPreferenceProfile).not.toHaveBeenCalled();
    expect(mocks.logUserPreferenceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "firebase-1",
        scanRunId: "scan-1",
        status: "completed",
        event: "skipped",
      }),
    );
    expect(mocks.updateDeepTier).toHaveBeenCalledWith("firebase-1", "scan-1", {
      preferenceStatus: "skipped",
      preferenceStartedAt: undefined,
    });
  });

  it("builds preference profile while Phase 1 is still running", async () => {
    mocks.getResearchJob.mockResolvedValueOnce({
      status: "running",
      normalizedResult: null,
      input: {
        name: "User Example",
        email: "user@example.com",
        consentAttestation: true,
        purpose: "self_audit",
        socialPreferenceConsent: true,
        socialProfiles: [
          {
            platform: "Instagram",
            username: "user",
            displayName: "User",
            bio: "Coffee and Goa",
            avatarUrl: null,
            externalUrl: null,
            profileUrl: "https://www.instagram.com/user/",
            source: "scraper",
            recentPublicPosts: [
              {
                url: "https://www.instagram.com/p/abc/",
                caption: "Goa sea view coffee again",
                thumbnailUrl: "https://cdn.example.com/goa.jpg",
              },
            ],
          },
        ],
      },
    });

    const res = await GET(request(), context());
    const json = (await res.json()) as {
      ok?: boolean;
      preferenceStatus?: string;
      preferenceProfile?: { summary?: string };
      result?: unknown;
    };

    expect(res.status).toBe(200);
    expect(json.preferenceStatus).toBe("completed");
    expect(json.preferenceProfile?.summary).toContain("visible social evidence");
    expect(json.result).toBeNull();
    expect(mocks.saveUserPreferenceProfile).toHaveBeenCalled();
    expect(mocks.updateDeepTier).not.toHaveBeenCalled();
  });

  it("builds, persists, and patches a social preference profile", async () => {
    mocks.getResearchJob.mockResolvedValueOnce({
      status: "completed",
      normalizedResult: result,
      input: {
        name: "User Example",
        email: "user@example.com",
        consentAttestation: true,
        purpose: "self_audit",
        socialPreferenceConsent: true,
        linkedinProfile: {
          sub: "user",
          name: "User Example",
          email: "user@example.com",
          profileUrl: "https://www.linkedin.com/in/user",
          source: "scraper",
          skills: ["AI", "Product"],
        },
        socialProfiles: [
          {
            platform: "Instagram",
            username: "user",
            displayName: "User",
            bio: "Coffee and Goa",
            avatarUrl: null,
            externalUrl: null,
            profileUrl: "https://www.instagram.com/user/",
            source: "scraper",
            recentPublicPosts: [
              {
                url: "https://www.instagram.com/p/abc/",
                caption: "Goa sea view coffee again",
                thumbnailUrl: "https://cdn.example.com/goa.jpg",
              },
            ],
          },
        ],
      },
    });

    const res = await GET(request(), context());
    const json = (await res.json()) as {
      ok?: boolean;
      preferenceStatus?: string;
      result?: { preferenceProfile?: { summary?: string; selection?: { selectedEvidenceCount?: number } } };
    };

    expect(res.status).toBe(200);
    expect(json.preferenceStatus).toBe("completed");
    expect(json.result?.preferenceProfile?.summary).toContain("visible social evidence");
    expect(json.result?.preferenceProfile?.selection?.selectedEvidenceCount).toBeGreaterThan(0);
    expect(mocks.saveUserPreferenceProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "firebase-1",
        scanRunId: "scan-1",
        status: "completed",
        version: "2026-06-18.social-preference-questions-v2",
      }),
    );
    expect(mocks.indexSocialPreferenceEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "firebase-1",
        scanRunId: "scan-1",
        version: "2026-06-18.social-preference-questions-v2",
        evidence: expect.any(Array),
      }),
    );
    expect(mocks.updateDeepTier).toHaveBeenCalledWith(
      "firebase-1",
      "scan-1",
      expect.objectContaining({
        preferenceStatus: "completed",
        preferenceVersion: "2026-06-18.social-preference-questions-v2",
        preferenceInputHash: expect.any(String),
        preferenceProfile: expect.objectContaining({
          questionAnswers: expect.arrayContaining([expect.objectContaining({ questionId: "travel_perfect_escape" })]),
          topSignals: expect.arrayContaining([expect.objectContaining({ label: "seaside / beach-view places" })]),
        }),
      }),
    );
    expect(mocks.logUserPreferenceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "firebase-1",
        scanRunId: "scan-1",
        status: "completed",
        event: "completed",
        selectedEvidenceIds: expect.any(Array),
        selectedSignalIds: expect.any(Array),
        counts: expect.objectContaining({
          selectedEvidenceCount: expect.any(Number),
          selectedSignalCount: expect.any(Number),
        }),
      }),
    );
  });

  it("reuses an existing v2 same-input preference profile", async () => {
    const existing = {
      version: "2026-06-18.social-preference-questions-v2",
      status: "completed",
      generatedAt: "2026-06-17T09:00:00.000Z",
      questionRegistryVersion: "2026-06-18.preference-30q-v1",
      questionAnswers: [],
      questionCoverage: { total: 30, answered: 0, inferred: 0, needsConfirmation: 0, unknown: 30, blockedByAccess: 0, bySection: {} },
      sectionSummaries: [],
      updatedFrom: { platforms: ["instagram"], indexedItems: 1, mediaAssets: 1, ocrSignals: 0, externalLinks: 0, recentWindowDays: 30 },
      summary: "Existing preference profile",
      topSignals: [],
      domains: {},
      evidence: [],
      collage: [],
      selection: {
        selectedAt: "2026-06-17T09:00:00.000Z",
        evidencePoolSize: 1,
        selectedEvidenceCount: 1,
        selectedEvidenceIds: ["e1"],
        selectedSignalCount: 0,
        selectedSignalIds: [],
        collageEvidenceIds: ["e1"],
        droppedEvidenceCount: 0,
        byPlatform: { instagram: 1, threads: 0, x: 0, linkedin: 0 },
        selectedByPlatform: { instagram: 1, threads: 0, x: 0, linkedin: 0 },
        byDomain: {},
        selectionRules: { evidenceCap: 2600, topSignalCap: 12, signalEvidenceCap: 12, collageCap: 16, promptPostLimit: null },
      },
      refresh: { lastIndexedAt: "2026-06-17T09:00:00.000Z", staleAfter: "2026-06-18T09:00:00.000Z", mode: "refresh_ready" },
      guardrails: {
        linkedinUntouched: true,
        noPrivateContent: true,
        sensitiveInferencePolicy: "self_declared_or_needs_confirmation",
      },
      mediaIntelligence: { status: "pending", provider: "vertex_gemini_cloud_vision", queuedAssets: 1, note: "pending" },
    };
    mocks.getUserPreferenceProfileByInputHash.mockResolvedValueOnce(existing);
    mocks.getResearchJob.mockResolvedValueOnce({
      status: "running",
      normalizedResult: null,
      input: {
        socialPreferenceConsent: true,
        socialProfiles: [
          {
            platform: "Instagram",
            username: "user",
            displayName: "User",
            bio: "Coffee and Goa",
            avatarUrl: null,
            externalUrl: null,
            profileUrl: "https://www.instagram.com/user/",
            source: "scraper",
            recentPublicPosts: [],
          },
        ],
      },
    });

    const res = await GET(request(), context());
    const json = (await res.json()) as { preferenceStatus?: string; preferenceProfile?: { summary?: string }; result?: unknown };

    expect(res.status).toBe(200);
    expect(json.preferenceStatus).toBe("completed");
    expect(json.preferenceProfile?.summary).toBe("Existing preference profile");
    expect(json.result).toBeNull();
    expect(mocks.saveUserPreferenceProfile).not.toHaveBeenCalled();
    expect(mocks.logUserPreferenceRun).toHaveBeenCalledWith(expect.objectContaining({ event: "reused" }));
  });

  it("does not reuse a v1 preference profile when v2 is required", async () => {
    mocks.getUserPreferenceProfileByInputHash.mockResolvedValueOnce({
      version: "2026-06-17.social-preference-v1",
      status: "completed",
      generatedAt: "2026-06-17T09:00:00.000Z",
      updatedFrom: { platforms: ["instagram"], indexedItems: 1, mediaAssets: 1, ocrSignals: 0, externalLinks: 0, recentWindowDays: 30 },
      summary: "Old v1 preference profile",
      topSignals: [],
      domains: {},
      evidence: [],
      collage: [],
      selection: {
        selectedAt: "2026-06-17T09:00:00.000Z",
        evidencePoolSize: 1,
        selectedEvidenceCount: 1,
        selectedEvidenceIds: ["e1"],
        selectedSignalCount: 0,
        selectedSignalIds: [],
        collageEvidenceIds: ["e1"],
        droppedEvidenceCount: 0,
        byPlatform: { instagram: 1, threads: 0, x: 0, linkedin: 0 },
        selectedByPlatform: { instagram: 1, threads: 0, x: 0, linkedin: 0 },
        byDomain: {},
        selectionRules: { evidenceCap: 2600, topSignalCap: 12, signalEvidenceCap: 12, collageCap: 16, promptPostLimit: null },
      },
      refresh: { lastIndexedAt: "2026-06-17T09:00:00.000Z", staleAfter: "2026-06-18T09:00:00.000Z", mode: "refresh_ready" },
      guardrails: {
        linkedinUntouched: true,
        noPrivateContent: true,
        sensitiveInferencePolicy: "self_declared_or_needs_confirmation",
      },
    });
    mocks.getResearchJob.mockResolvedValueOnce({
      status: "running",
      normalizedResult: null,
      input: {
        socialPreferenceConsent: true,
        socialProfiles: [
          {
            platform: "Instagram",
            username: "user",
            displayName: "User",
            bio: "Coffee and Goa",
            avatarUrl: null,
            externalUrl: null,
            profileUrl: "https://www.instagram.com/user/",
            source: "scraper",
            recentPublicPosts: [{ url: "https://www.instagram.com/p/abc/", caption: "Goa sea view coffee", thumbnailUrl: "https://cdn.example.com/goa.jpg" }],
          },
        ],
      },
    });

    const res = await GET(request(), context());
    const json = (await res.json()) as { preferenceStatus?: string; preferenceProfile?: { version?: string; summary?: string } };

    expect(res.status).toBe(200);
    expect(json.preferenceStatus).toBe("completed");
    expect(json.preferenceProfile?.version).toBe("2026-06-18.social-preference-questions-v2");
    expect(json.preferenceProfile?.summary).not.toBe("Old v1 preference profile");
    expect(mocks.saveUserPreferenceProfile).toHaveBeenCalled();
  });
});
