/* Internal worker: drain pending SocialMediaAsset rows → Cloud Vision + Vertex Gemini analysis →
   persist the result. Guarded by ONE_INTERNAL_JOB_TOKEN (Cloud Scheduler). When media completes for
   a user, a preference recompute is enqueued so synthesis upgrades from text-only to media-enriched. */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import {
  claimPendingMediaAssetsGlobal,
  enqueueSocialRefreshJobs,
  updateMediaAssetAnalysis,
  PREFERENCE_RECOMPUTE_PLATFORM,
} from "@/lib/db/scan-store";
import { analyzeMediaAsset } from "@/lib/social-intelligence/media-analyze";

export const runtime = "nodejs";
export const maxDuration = 300;

// Raised 8→24→32 so the analyzed-image count keeps up with the deeper staged archives + the v5 re-analysis
// backlog (global claim ceiling is 64). Env PREFERENCE_MEDIA_BATCH overrides.
const ASSETS_PER_RUN = Number(process.env.PREFERENCE_MEDIA_BATCH || "32") || 32;
// v5.1: analyze assets in bounded-concurrency WAVES (was strictly sequential) so a run drains far more
// images within the 300s budget — async agents doing the work in parallel. Env PREFERENCE_MEDIA_CONCURRENCY.
const MEDIA_CONCURRENCY = Number(process.env.PREFERENCE_MEDIA_CONCURRENCY || "6") || 6;

export async function POST(request: Request) {
  try {
    verifyInternalJobRequest(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const assets = await claimPendingMediaAssetsGlobal(ASSETS_PER_RUN);
  const results: Array<Record<string, unknown>> = [];
  const affectedUsers = new Set<string>();

  // Analyze one claimed asset end-to-end; never throws (a failure is persisted as "failed").
  async function processAsset(asset: (typeof assets)[number]): Promise<{ id: string; status: string; safe?: boolean }> {
    try {
      const result = await analyzeMediaAsset({ sourceUrl: asset.sourceUrl, mediaType: asset.mediaType, assetHash: asset.assetHash, context: asset.caption ?? "" });
      await updateMediaAssetAnalysis({
        assetId: asset.id,
        analysisStatus: result.status,
        analysis: result,
        analysisModel: result.model,
        analysisVersion: result.version,
        analysisError: result.error ?? null,
      });
      if (result.status === "completed" && asset.firebaseUid) affectedUsers.add(asset.firebaseUid);
      return { id: asset.id, status: result.status, safe: result.safe };
    } catch (error) {
      // Never leave a claimed asset stuck in "processing" — mark it failed so it isn't re-claimed.
      await updateMediaAssetAnalysis({ assetId: asset.id, analysisStatus: "failed", analysisError: error instanceof Error ? error.message.slice(0, 300) : "media worker error" });
      return { id: asset.id, status: "failed" };
    }
  }

  // Bounded-concurrency waves — drains the batch in parallel without blowing Vision/Vertex rate limits.
  for (let i = 0; i < assets.length; i += MEDIA_CONCURRENCY) {
    const wave = await Promise.all(assets.slice(i, i + MEDIA_CONCURRENCY).map(processAsset));
    results.push(...wave);
  }

  for (const firebaseUid of affectedUsers) {
    await enqueueSocialRefreshJobs({
      firebaseUid,
      jobs: [{ platform: PREFERENCE_RECOMPUTE_PLATFORM, publicId: "latest", metadata: {}, priority: -1 }],
    });
  }

  return NextResponse.json({ ok: true, claimed: assets.length, recomputeUsers: affectedUsers.size, results });
}
