/* Internal worker: gentle periodic freshness sweep. Selects a bounded batch of users whose social archive
   is stale (no re-scrape in ARCHIVE_STALE_DAYS) and who have NO deep-scrape job in flight, and enqueues a
   lightweight deep-scrape REFRESH (recent window) per connected platform to pull any new posts. Guarded by
   ONE_INTERNAL_JOB_TOKEN (Cloud Scheduler). Complements the lazy on-revisit refresh in the /preferences
   route — the "no deep job in flight" selector + that route's !pendingWork gate keep the two from
   double-firing on the same user. */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import { enqueueSocialRefreshJobs, selectStaleArchiveRefreshTargets } from "@/lib/db/scan-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const ARCHIVE_STALE_MS = (Number(process.env.ARCHIVE_STALE_DAYS) || 3) * 24 * 60 * 60 * 1000;
const REFRESH_MAX_POSTS = Number(process.env.REFRESH_MAX_POSTS) || 240;
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
      swept += 1;
    }
  }
  return NextResponse.json({ ok: true, swept, candidates: targets.length });
}
