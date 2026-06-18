/* Internal worker: drain preference-recompute jobs → read the user's full archive + completed media
   analyses → run Vertex synthesis (30 answers) → persist + merge into the scan's dashboard result.
   Guarded by ONE_INTERNAL_JOB_TOKEN (Cloud Scheduler). Idempotent: re-running upgrades partial →
   media-enriched as more media completes.

   Synthesis runs iteratively: a first full pass, then up to 2 re-passes that re-ask ONLY the
   still-unknown questions, merging any newly answered ones in. This pushes coverage toward
   RE_PASS_TARGET so a sparse first pass (e.g. 6/30) doesn't get frozen as "completed". A SHOW_THRESHOLD
   gate keeps the layer "partial"/"running" until enough questions are answered. Every run emits a
   structured log line + a SocialPreferenceRunLog row (both best-effort; never break the worker). */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import {
  claimSocialRefreshJobs,
  completeSocialRefreshJob,
  failSocialRefreshJob,
  getArchiveDepthSummary,
  getCompletedMediaAnalyses,
  getLatestScanForUser,
  getSocialContentItems,
  logUserPreferenceRun,
  saveUserPreferenceProfile,
  updateDeepTier,
  PREFERENCE_RECOMPUTE_PLATFORM,
} from "@/lib/db/scan-store";
import { buildPreferenceCollage, synthesizePreferences, toRenderablePreferenceProfile } from "@/lib/social-intelligence/preference-synthesis";
import { PREFERENCE_QUESTIONS } from "@/lib/social-intelligence/preference-profile";
import type { SynthesizedAnswer } from "@/lib/social-intelligence/preference-synthesis";

export const runtime = "nodejs";
export const maxDuration = 300;

const JOBS_PER_RUN = 1;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Coverage gate + re-pass tuning. SHOW_THRESHOLD is the minimum answered/inferred count before the
// layer is allowed to flip to "completed"; RE_PASS_TARGET is the coverage we try to reach via re-passes
// (kept above SHOW_THRESHOLD so the gate clears comfortably). MAX_RE_PASSES bounds the extra Vertex calls.
const SHOW_THRESHOLD = 20;
const RE_PASS_TARGET = 24;
const MAX_RE_PASSES = 2;

const isAnswered = (a: SynthesizedAnswer): boolean => a.status === "answered" || a.status === "inferred";

export async function POST(request: Request) {
  try {
    verifyInternalJobRequest(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const jobs = await claimSocialRefreshJobs(JOBS_PER_RUN, { platforms: [PREFERENCE_RECOMPUTE_PLATFORM] });
  const results: Array<Record<string, unknown>> = [];

  for (const job of jobs) {
    const startedAt = Date.now();
    try {
      if (!job.firebaseUid) {
        await failSocialRefreshJob(job.id, "missing firebaseUid");
        results.push({ id: job.id, ok: false, reason: "missing_uid" });
        continue;
      }
      const meta = (job.metadata && typeof job.metadata === "object" ? job.metadata : {}) as {
        scanRunId?: string | null;
        professionalContext?: string | null;
      };
      const [contentItems, mediaAnalyses, depth] = await Promise.all([
        getSocialContentItems(job.firebaseUid, { limit: 1024 }),
        getCompletedMediaAnalyses(job.firebaseUid, { limit: 1024 }),
        getArchiveDepthSummary(job.firebaseUid),
      ]);
      if (!contentItems.length) {
        // Nothing indexed yet — complete quietly; a later archive job will re-enqueue.
        await completeSocialRefreshJob(job.id);
        results.push({ id: job.id, ok: true, skipped: "no_archive" });
        continue;
      }

      const professionalContext = typeof meta.professionalContext === "string" && meta.professionalContext.trim()
        ? meta.professionalContext.trim()
        : undefined;

      const synthesis = await synthesizePreferences({ contentItems, mediaAnalyses, professionalContext });
      if (!synthesis) {
        await failSocialRefreshJob(job.id, "synthesis unavailable (Vertex not configured or failed)");
        // Floor: once retries are exhausted (failSocialRefreshJob gives up at >=5 attempts), stop the
        // client from "building" forever — mark the preference layer failed so the UI shows a terminal
        // "needs another run" state instead of a perpetual spinner.
        if (job.attempts >= 5) {
          const sid = meta.scanRunId ?? (await getLatestScanForUser(job.firebaseUid))?.id ?? null;
          if (sid) await updateDeepTier(job.firebaseUid, sid, { preferenceStatus: "failed" }).catch(() => null);
        }
        results.push({ id: job.id, ok: false, reason: "synthesis_unavailable" });
        continue;
      }

      // Merge map keyed by questionId; start from the first full pass.
      const merged = new Map<string, SynthesizedAnswer>(synthesis.answers.map((a) => [a.questionId, a]));
      let answeredTotal = [...merged.values()].filter(isAnswered).length;
      let passes = 1;

      // Iterative re-pass: re-ask ONLY the still-unknown questions and fold in any that now resolve.
      // Stop when we hit the target, run out of unknowns, exhaust the re-pass budget, or a pass yields
      // nothing new (no point burning another Vertex call on the same gap).
      while (answeredTotal < RE_PASS_TARGET && passes <= MAX_RE_PASSES) {
        const unknownIds = new Set([...merged.values()].filter((a) => !isAnswered(a)).map((a) => a.questionId));
        if (unknownIds.size === 0) break;
        const unknownQuestions = PREFERENCE_QUESTIONS.filter((q) => unknownIds.has(q.id));
        if (unknownQuestions.length === 0) break;

        const rePass = await synthesizePreferences({
          contentItems,
          mediaAnalyses,
          professionalContext,
          questions: unknownQuestions,
        });
        passes += 1;
        if (!rePass) break;

        let improved = 0;
        for (const answer of rePass.answers) {
          const prior = merged.get(answer.questionId);
          // Only replace a still-unknown prior with a newly answered/inferred one.
          if (prior && !isAnswered(prior) && isAnswered(answer)) {
            merged.set(answer.questionId, answer);
            improved += 1;
          }
        }
        if (improved === 0) break; // no improvement → stop early
        answeredTotal = [...merged.values()].filter(isAnswered).length;
      }

      // Rebuild the synthesis result with the merged answers, preserving original question order.
      const mergedAnswers = synthesis.answers.map((a) => merged.get(a.questionId) ?? a);
      const mergedSynthesis = { ...synthesis, answers: mergedAnswers };

      const mediaPending = depth?.totals ? depth.totals.mediaTotal - depth.totals.mediaAnalyzed : 0;
      // Reveal when coverage crosses the show threshold (snappy, even if media still trickling) OR
      // once media is fully analyzed — the FLOOR that prevents a sparse account from building forever.
      // While media is still analyzing AND coverage is below the threshold, stay "partial" (building).
      const preferenceStatus = answeredTotal >= SHOW_THRESHOLD || mediaPending <= 0 ? "completed" : "partial";

      // Render-compatible profile: reuses the dashboard's existing PreferenceIntelligence UI and
      // carries the live archive depth so the user sees e.g. "Instagram 684/1024 · 512 analyzed".
      const profile = toRenderablePreferenceProfile(mergedSynthesis, depth, {
        generatedAt: new Date().toISOString(),
        preferenceStatus,
        collage: buildPreferenceCollage(contentItems, 24),
      });

      // Recompute the canonical counts from the rendered coverage so the log + persisted status agree.
      const coverage = profile.questionCoverage;
      answeredTotal = coverage.answered + coverage.inferred;

      await saveUserPreferenceProfile({
        firebaseUid: job.firebaseUid,
        scanRunId: meta.scanRunId ?? null,
        status: preferenceStatus === "completed" ? "completed" : "partial",
        version: mergedSynthesis.version,
        profile,
        staleAfter: new Date(Date.now() + STALE_AFTER_MS).toISOString(),
      });

      const scanRunId = meta.scanRunId ?? (await getLatestScanForUser(job.firebaseUid))?.id ?? null;
      if (scanRunId) {
        // The dashboard renders `preferenceProfile`; on "completed" mark the layer done, on "partial"
        // keep it "running" so the client poll keeps upgrading as media finishes / coverage improves.
        await updateDeepTier(job.firebaseUid, scanRunId, {
          preferenceStatus: preferenceStatus === "completed" ? "completed" : "running",
          preferenceProfile: profile,
          preferenceSynthesisVersion: mergedSynthesis.version,
          preferenceSynthesisModel: mergedSynthesis.model,
        });
      }

      const durationMs = Date.now() - startedAt;
      // Best-effort observability: structured log line + a durable run-log row. Never throws out.
      try {
        const perSection = profile.sectionSummaries.map((s) => ({
          sectionId: s.sectionId,
          answered: s.answeredCount,
          total: s.totalCount,
        }));
        console.info(
          JSON.stringify({
            event: "one.preference.recompute",
            severity: "INFO",
            scanRunId,
            model: mergedSynthesis.model,
            answered: coverage.answered,
            inferred: coverage.inferred,
            needsConfirmation: coverage.needsConfirmation,
            unknown: coverage.unknown,
            answeredTotal,
            passes,
            durationMs,
            perSection,
          }),
        );
        await logUserPreferenceRun({
          firebaseUid: job.firebaseUid,
          scanRunId,
          status: preferenceStatus,
          event: "one.preference.recompute",
          version: mergedSynthesis.version,
          platforms: mergedSynthesis.context.platforms,
          counts: {
            answered: coverage.answered,
            inferred: coverage.inferred,
            needsConfirmation: coverage.needsConfirmation,
            unknown: coverage.unknown,
            answeredTotal,
            passes,
            mediaPending,
          },
          durationMs,
        });
      } catch {
        // Logging is non-fatal — swallow so the worker still completes the job.
      }

      await completeSocialRefreshJob(job.id);
      results.push({ id: job.id, ok: true, preferenceStatus, answeredTotal, passes, mediaPending });
    } catch (error) {
      await failSocialRefreshJob(job.id, error instanceof Error ? error.message : "recompute worker error");
      results.push({ id: job.id, ok: false, reason: "exception" });
    }
  }

  return NextResponse.json({ ok: true, claimed: jobs.length, results });
}
