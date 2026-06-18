/* Internal worker: drain preference-recompute jobs → read the user's full archive + completed media
   analyses → run Vertex synthesis (30 answers) → persist + merge into the scan's dashboard result.
   Guarded by ONE_INTERNAL_JOB_TOKEN (Cloud Scheduler). Idempotent: re-running upgrades partial →
   media-enriched as more media completes. */
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
  saveUserPreferenceProfile,
  updateDeepTier,
  PREFERENCE_RECOMPUTE_PLATFORM,
} from "@/lib/db/scan-store";
import { synthesizePreferences, toRenderablePreferenceProfile } from "@/lib/social-intelligence/preference-synthesis";

export const runtime = "nodejs";
export const maxDuration = 300;

const JOBS_PER_RUN = 3;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  try {
    verifyInternalJobRequest(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const jobs = await claimSocialRefreshJobs(JOBS_PER_RUN, { platforms: [PREFERENCE_RECOMPUTE_PLATFORM] });
  const results: Array<Record<string, unknown>> = [];

  for (const job of jobs) {
    try {
      if (!job.firebaseUid) {
        await failSocialRefreshJob(job.id, "missing firebaseUid");
        results.push({ id: job.id, ok: false, reason: "missing_uid" });
        continue;
      }
      const meta = (job.metadata && typeof job.metadata === "object" ? job.metadata : {}) as { scanRunId?: string | null };
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
      const synthesis = await synthesizePreferences({ contentItems, mediaAnalyses });
      if (!synthesis) {
        await failSocialRefreshJob(job.id, "synthesis unavailable (Vertex not configured or failed)");
        results.push({ id: job.id, ok: false, reason: "synthesis_unavailable" });
        continue;
      }

      const mediaPending = depth?.totals ? depth.totals.mediaTotal - depth.totals.mediaAnalyzed : 0;
      // "partial" while media is still being analyzed; "completed" once the archive+media settle.
      const preferenceStatus = mediaPending > 0 ? "partial" : "completed";

      // Render-compatible profile: reuses the dashboard's existing PreferenceIntelligence UI and
      // carries the live archive depth so the user sees e.g. "Instagram 684/1024 · 512 analyzed".
      const profile = toRenderablePreferenceProfile(synthesis, depth, {
        generatedAt: new Date().toISOString(),
        preferenceStatus,
      });

      await saveUserPreferenceProfile({
        firebaseUid: job.firebaseUid,
        scanRunId: meta.scanRunId ?? null,
        status: preferenceStatus === "completed" ? "completed" : "partial",
        version: synthesis.version,
        profile,
        staleAfter: new Date(Date.now() + STALE_AFTER_MS).toISOString(),
      });

      const scanRunId = meta.scanRunId ?? (await getLatestScanForUser(job.firebaseUid))?.id ?? null;
      if (scanRunId) {
        // The dashboard renders `preferenceProfile`; on "completed" mark the layer done, on "partial"
        // keep it "running" so the client poll keeps upgrading as media finishes.
        await updateDeepTier(job.firebaseUid, scanRunId, {
          preferenceStatus: preferenceStatus === "completed" ? "completed" : "running",
          preferenceProfile: profile,
          preferenceSynthesisVersion: synthesis.version,
          preferenceSynthesisModel: synthesis.model,
        });
      }
      await completeSocialRefreshJob(job.id);
      results.push({ id: job.id, ok: true, preferenceStatus, answers: synthesis.answers.length, mediaPending });
    } catch (error) {
      await failSocialRefreshJob(job.id, error instanceof Error ? error.message : "recompute worker error");
      results.push({ id: job.id, ok: false, reason: "exception" });
    }
  }

  return NextResponse.json({ ok: true, claimed: jobs.length, results });
}
