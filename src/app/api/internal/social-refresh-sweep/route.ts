/* Internal worker: gentle periodic freshness sweep — the "latest posts keep flowing in" engine. Runs on
   a short Cloud Scheduler cadence (e.g. every ~30 min) and each run picks a small batch of users whose
   archive is stale (last indexed > ARCHIVE_STALE_HOURS ago, default 24h) with NO deep-scrape job in
   flight, enqueuing a lightweight deep-scrape REFRESH (recent window) per connected platform to pull new
   posts (upsert adds them; scan-store evicts the oldest beyond the 512 rolling window). Staggering a
   small batch per tick keeps each account ≈daily-fresh while spreading scrape load (gentle on the IP).
   Guarded by ONE_INTERNAL_JOB_TOKEN. Complements the lazy on-revisit refresh in /preferences — the "no
   deep job in flight" selector + that route's !pendingWork gate keep the two from double-firing. */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import { enqueueSocialRefreshJobs, requeueOutdatedMediaAssets, selectStaleArchiveRefreshTargets } from "@/lib/db/scan-store";
import { MEDIA_ANALYSIS_VERSION } from "@/lib/social-intelligence/media-analyze";

export const runtime = "nodejs";
export const maxDuration = 60;

// Per-account ≈daily freshness. ARCHIVE_STALE_HOURS gates how stale an account must be before it's
// re-swept; with a ~30-min scheduler + SWEEP_BATCH/run, each connected account is refreshed about once a
// day. (Legacy ARCHIVE_STALE_DAYS still honored as a fallback.)
const STALE_HOURS = Number(process.env.ARCHIVE_STALE_HOURS) || (Number(process.env.ARCHIVE_STALE_DAYS) || 1) * 24;
const ARCHIVE_STALE_MS = STALE_HOURS * 60 * 60 * 1000;
// Refresh pulls only a small recent window (most are already indexed → cheap upsert). 90 comfortably
// covers anyone's daily posting; new posts land, the rolling window drops the oldest.
const REFRESH_MAX_POSTS = Number(process.env.REFRESH_MAX_POSTS) || 90;
const SWEEP_BATCH = Number(process.env.REFRESH_SWEEP_BATCH) || 8;

export async function POST(request: Request) {
  try {
    verifyInternalJobRequest(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const targets = await selectStaleArchiveRefreshTargets(SWEEP_BATCH, Date.now() - ARCHIVE_STALE_MS);
  let swept = 0;
  for (const target of targets) {
    const jobs = target.jobs.map((j) => ({
      platform: j.platform,
      publicId: j.publicId,
      metadata: { url: j.url, maxPosts: REFRESH_MAX_POSTS, refresh: true },
    }));
    if (jobs.length) {
      await enqueueSocialRefreshJobs({ firebaseUid: target.firebaseUid, jobs });
      // v5: drain the back-catalogue — re-pend this user's recently-rescraped, outdated-version media so the
      // deep pixel read reaches older accounts over successive sweeps. Best-effort; fresh-URL-windowed.
      await requeueOutdatedMediaAssets({ firebaseUid: target.firebaseUid, currentVersion: MEDIA_ANALYSIS_VERSION, limit: 128 }).catch(() => 0);
      swept += 1;
    }
  }
  return NextResponse.json({ ok: true, swept, candidates: targets.length });
}
