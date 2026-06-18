import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFERENCE_QUESTIONS } from "@/lib/social-intelligence/preference-profile";

/* The worker calls synthesizePreferences (full pass, then re-passes on the unknown subset) and
   toRenderablePreferenceProfile. We mock the whole synthesis module so we can script how many
   questions resolve per pass, and give toRenderablePreferenceProfile a faithful coverage counter so
   the gate + logging assertions exercise the REAL route logic, not the mock. */

type Status = "answered" | "inferred" | "needs_confirmation" | "unknown";
interface Answer {
  questionId: string;
  sectionId: string;
  prompt: string;
  status: Status;
  answer: string | null;
  confidence: "low" | "medium" | "high";
  source: "self_declared" | "observed" | "inferred" | "aggregate" | "not_available";
  evidenceIds: string[];
  mediaEvidenceIds: string[];
  why: string | null;
  needsUserConfirmation: boolean;
}

const ALL_IDS = PREFERENCE_QUESTIONS.map((q) => q.id);

function answer(id: string, status: Status): Answer {
  const q = PREFERENCE_QUESTIONS.find((x) => x.id === id)!;
  return {
    questionId: id,
    sectionId: q.sectionId,
    prompt: q.prompt,
    status,
    answer: status === "unknown" ? null : "a",
    confidence: "medium",
    source: "observed",
    evidenceIds: [],
    mediaEvidenceIds: [],
    why: null,
    needsUserConfirmation: false,
  };
}

/** Build a full 30-answer result where the first `answeredCount` questions are "answered". */
function fullResult(answeredCount: number) {
  return {
    version: "test-v3",
    model: "gemini-test",
    answers: ALL_IDS.map((id, i) => answer(id, i < answeredCount ? "answered" : "unknown")),
    context: { platforms: ["instagram"], contentItems: 100, mediaAnalyzed: 10 },
  };
}

/** Build a re-pass result: answers ONLY for the requested unknown questions, marking the first
 *  `resolveCount` of them as "answered". */
function rePassResult(questions: Array<{ id: string }>, resolveCount: number) {
  return {
    version: "test-v3",
    model: "gemini-test",
    answers: questions.map((q, i) => answer(q.id, i < resolveCount ? "answered" : "unknown")),
    context: { platforms: ["instagram"], contentItems: 100, mediaAnalyzed: 10 },
  };
}

const mocks = vi.hoisted(() => ({
  verifyInternalJobRequest: vi.fn(),
  claimSocialRefreshJobs: vi.fn(),
  completeSocialRefreshJob: vi.fn(async () => undefined),
  failSocialRefreshJob: vi.fn(async () => undefined),
  getArchiveDepthSummary: vi.fn(),
  getCompletedMediaAnalyses: vi.fn(async () => []),
  getLatestScanForUser: vi.fn(async () => ({ id: "scan-1" })),
  getSocialContentItems: vi.fn(async () => [{ itemId: "i1" }]),
  logUserPreferenceRun: vi.fn(async () => ({ id: "log-1", createdAt: "now" })),
  saveUserPreferenceProfile: vi.fn(async () => undefined),
  updateDeepTier: vi.fn(async () => undefined),
  synthesizePreferences: vi.fn(),
  toRenderablePreferenceProfile: vi.fn(),
}));

vi.mock("@/lib/auth/internal", () => ({
  verifyInternalJobRequest: mocks.verifyInternalJobRequest,
  InternalAuthError: class extends Error {},
}));

vi.mock("@/lib/db/scan-store", () => ({
  claimSocialRefreshJobs: mocks.claimSocialRefreshJobs,
  completeSocialRefreshJob: mocks.completeSocialRefreshJob,
  failSocialRefreshJob: mocks.failSocialRefreshJob,
  getArchiveDepthSummary: mocks.getArchiveDepthSummary,
  getCompletedMediaAnalyses: mocks.getCompletedMediaAnalyses,
  getLatestScanForUser: mocks.getLatestScanForUser,
  getSocialContentItems: mocks.getSocialContentItems,
  logUserPreferenceRun: mocks.logUserPreferenceRun,
  saveUserPreferenceProfile: mocks.saveUserPreferenceProfile,
  updateDeepTier: mocks.updateDeepTier,
  PREFERENCE_RECOMPUTE_PLATFORM: "preference_recompute",
}));

vi.mock("@/lib/social-intelligence/preference-synthesis", () => ({
  synthesizePreferences: mocks.synthesizePreferences,
  // Faithful coverage counter over whatever merged answers the route hands us.
  toRenderablePreferenceProfile: mocks.toRenderablePreferenceProfile,
}));

import { POST } from "./route";

function renderProfile(result: { answers: Answer[] }, _depth: unknown, opts: { preferenceStatus: string }) {
  const answered = result.answers.filter((a) => a.status === "answered").length;
  const inferred = result.answers.filter((a) => a.status === "inferred").length;
  const needsConfirmation = result.answers.filter((a) => a.status === "needs_confirmation").length;
  const unknown = result.answers.filter((a) => a.status === "unknown").length;
  return {
    preferenceStatus: opts.preferenceStatus,
    questionCoverage: { total: result.answers.length, answered, inferred, needsConfirmation, unknown, blockedByAccess: 0 },
    sectionSummaries: [{ sectionId: "style_brands_color", title: "Style", summary: "", answeredCount: answered, totalCount: result.answers.length, confidence: "low" }],
  };
}

function req(headers: Record<string, string> = { authorization: "Bearer t" }): Request {
  return new Request("https://one.hushh.ai/api/internal/preference-recompute", { method: "POST", headers });
}

const JOB = { id: "job-1", firebaseUid: "uid-1", metadata: { scanRunId: "scan-1" } };

describe("POST /api/internal/preference-recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.verifyInternalJobRequest.mockReturnValue(undefined);
    mocks.claimSocialRefreshJobs.mockResolvedValue([JOB]);
    mocks.getSocialContentItems.mockResolvedValue([{ itemId: "i1" }]);
    mocks.getCompletedMediaAnalyses.mockResolvedValue([]);
    mocks.getArchiveDepthSummary.mockResolvedValue({ totals: { mediaTotal: 0, mediaAnalyzed: 0 } });
    mocks.getLatestScanForUser.mockResolvedValue({ id: "scan-1" });
    mocks.toRenderablePreferenceProfile.mockImplementation(renderProfile as never);
  });

  it("runs re-passes when below the target and merges newly answered questions", async () => {
    // First pass answers 6/30; each re-pass resolves 9 more unknowns → 15 → 24 (hits RE_PASS_TARGET).
    mocks.synthesizePreferences
      .mockResolvedValueOnce(fullResult(6))
      .mockImplementationOnce(async (input: { questions: Array<{ id: string }> }) => rePassResult(input.questions, 9))
      .mockImplementationOnce(async (input: { questions: Array<{ id: string }> }) => rePassResult(input.questions, 9));

    const res = await POST(req());
    const json = (await res.json()) as { results: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    // Full pass + 2 re-passes = 3 synthesis calls.
    expect(mocks.synthesizePreferences).toHaveBeenCalledTimes(3);
    // Re-passes are scoped to the still-unknown subset (24 unknowns after first pass).
    const secondCall = mocks.synthesizePreferences.mock.calls[1][0] as { questions: Array<{ id: string }> };
    expect(secondCall.questions).toHaveLength(24);
    expect(json.results[0]).toMatchObject({ ok: true, passes: 3, answeredTotal: 24, preferenceStatus: "completed" });
  });

  it("stops early when a re-pass yields no improvement", async () => {
    mocks.synthesizePreferences
      .mockResolvedValueOnce(fullResult(6))
      .mockImplementationOnce(async (input: { questions: Array<{ id: string }> }) => rePassResult(input.questions, 0));

    const res = await POST(req());
    const json = (await res.json()) as { results: Array<Record<string, unknown>> };

    // Full pass + 1 fruitless re-pass = 2 calls, then break.
    expect(mocks.synthesizePreferences).toHaveBeenCalledTimes(2);
    expect(json.results[0]).toMatchObject({ ok: true, passes: 2, answeredTotal: 6 });
  });

  it("keeps status running/partial below the show threshold (answeredTotal < 20)", async () => {
    // Stays at 12 even after re-passes (re-passes resolve nothing).
    mocks.synthesizePreferences
      .mockResolvedValueOnce(fullResult(12))
      .mockImplementation(async (input: { questions: Array<{ id: string }> }) => rePassResult(input.questions, 0));

    const res = await POST(req());
    const json = (await res.json()) as { results: Array<Record<string, unknown>> };

    expect(json.results[0]).toMatchObject({ preferenceStatus: "partial", answeredTotal: 12 });
    // Persisted as partial; deep tier kept "running".
    expect(mocks.saveUserPreferenceProfile).toHaveBeenCalledWith(expect.objectContaining({ status: "partial" }));
    expect(mocks.updateDeepTier).toHaveBeenCalledWith("uid-1", "scan-1", expect.objectContaining({ preferenceStatus: "running" }));
  });

  it("flips to completed at or above the show threshold (answeredTotal >= 20)", async () => {
    mocks.synthesizePreferences.mockResolvedValueOnce(fullResult(28));

    const res = await POST(req());
    const json = (await res.json()) as { results: Array<Record<string, unknown>> };

    // 28 >= RE_PASS_TARGET so no re-pass; 28 >= SHOW_THRESHOLD so completed.
    expect(mocks.synthesizePreferences).toHaveBeenCalledTimes(1);
    expect(json.results[0]).toMatchObject({ preferenceStatus: "completed", answeredTotal: 28 });
    expect(mocks.saveUserPreferenceProfile).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect(mocks.updateDeepTier).toHaveBeenCalledWith("uid-1", "scan-1", expect.objectContaining({ preferenceStatus: "completed" }));
  });

  it("stays partial when media is still pending even with full coverage", async () => {
    mocks.getArchiveDepthSummary.mockResolvedValue({ totals: { mediaTotal: 100, mediaAnalyzed: 40 } });
    mocks.synthesizePreferences.mockResolvedValueOnce(fullResult(28));

    const res = await POST(req());
    const json = (await res.json()) as { results: Array<Record<string, unknown>> };

    expect(json.results[0]).toMatchObject({ preferenceStatus: "partial", mediaPending: 60 });
  });

  it("emits the structured log line and the run-log row", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.synthesizePreferences.mockResolvedValueOnce(fullResult(28));

    await POST(req());

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(infoSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({ event: "one.preference.recompute", severity: "INFO", scanRunId: "scan-1", answeredTotal: 28, passes: 1 });
    expect(typeof logged.durationMs).toBe("number");
    expect(Array.isArray(logged.perSection)).toBe(true);

    expect(mocks.logUserPreferenceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "uid-1",
        scanRunId: "scan-1",
        event: "one.preference.recompute",
        status: "completed",
        counts: expect.objectContaining({ answered: 28, answeredTotal: 28, passes: 1 }),
      }),
    );
  });

  it("never throws and does not break when logging fails", async () => {
    mocks.synthesizePreferences.mockResolvedValueOnce(fullResult(28));
    mocks.logUserPreferenceRun.mockRejectedValueOnce(new Error("db down"));

    const res = await POST(req());
    const json = (await res.json()) as { results: Array<Record<string, unknown>> };

    // Logging failure is swallowed; the job still completes.
    expect(json.results[0]).toMatchObject({ ok: true });
    expect(mocks.completeSocialRefreshJob).toHaveBeenCalledWith("job-1");
  });

  it("401s when the internal token is invalid", async () => {
    mocks.verifyInternalJobRequest.mockImplementationOnce(() => {
      throw new Error("Unauthorized");
    });
    const res = await POST(req({ authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
    expect(mocks.claimSocialRefreshJobs).not.toHaveBeenCalled();
  });
});
