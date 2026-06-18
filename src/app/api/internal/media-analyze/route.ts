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

// Raised 8→24 so the analyzed-image count keeps up with the deeper staged archives (global claim ceiling
// is 64). Env PREFERENCE_MEDIA_BATCH overrides.
const ASSETS_PER_RUN = Number(process.env.PREFERENCE_MEDIA_BATCH || "24") || 24;

export async function POST(request: Request) {
  try {
    verifyInternalJobRequest(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const assets = await claimPendingMediaAssetsGlobal(ASSETS_PER_RUN);
  const results: Array<Record<string, unknown>> = [];
  const affectedUsers = new Set<string>();

  for (const asset of assets) {
    try {
      const result = await analyzeMediaAsset({ sourceUrl: asset.sourceUrl, mediaType: asset.mediaType });
      await updateMediaAssetAnalysis({
        assetId: asset.id,
        analysisStatus: result.status,
        analysis: result,
        analysisModel: result.model,
        analysisVersion: result.version,
        analysisError: result.error ?? null,
      });
      if (result.status === "completed" && asset.firebaseUid) affectedUsers.add(asset.firebaseUid);
      results.push({ id: asset.id, status: result.status, safe: result.safe });
    } catch (error) {
      // Never leave a claimed asset stuck in "processing" — mark it failed so it isn't re-claimed.
      await updateMediaAssetAnalysis({ assetId: asset.id, analysisStatus: "failed", analysisError: error instanceof Error ? error.message.slice(0, 300) : "media worker error" });
      results.push({ id: asset.id, status: "failed" });
    }
  }

  for (const firebaseUid of affectedUsers) {
    await enqueueSocialRefreshJobs({
      firebaseUid,
      jobs: [{ platform: PREFERENCE_RECOMPUTE_PLATFORM, publicId: "latest", metadata: {}, priority: -1 }],
    });
  }

  return NextResponse.json({ ok: true, claimed: assets.length, recomputeUsers: affectedUsers.size, results });
}
