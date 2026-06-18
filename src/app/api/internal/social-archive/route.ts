/* Internal worker: drain SocialRefreshJob deep-scrape jobs → scrape the platform at 1024 depth →
   index the full archive (SocialContentItem + SocialMediaAsset). Guarded by ONE_INTERNAL_JOB_TOKEN
   (Cloud Scheduler). Each successful index enqueues a preference-recompute job for the user. */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import {
  claimSocialRefreshJobs,
  completeSocialRefreshJob,
  enqueueSocialRefreshJobs,
  failSocialRefreshJob,
  indexSocialArchive,
  PREFERENCE_RECOMPUTE_PLATFORM,
} from "@/lib/db/scan-store";
import { scrapeInstagramProfileUrl } from "@/lib/instagram/scraper-profile";
import { scrapeThreadsProfileUrl } from "@/lib/threads/scraper-profile";
import { scrapeXProfileUrl } from "@/lib/x/scraper-profile";
import { PROFILE_VERSION } from "@/lib/social-intelligence/preference-profile";
import type { SocialProfileFull } from "@/lib/ria/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEEP_PLATFORMS = ["instagram", "threads", "x"];
// Staged batched deep-scrape: the first scrape targets FIRST_TARGET posts, then each successful run grows
// the SAME job by STEP up to CEILING (or until the account is exhausted). Asking for 1024 in one shot was
// timing out on the node-side fetch (~120s); modest batches finish reliably and depth fills in over the
// 3-min scheduler ticks. JOBS_PER_RUN=1 so a single deep batch can't blow the worker's 300s maxDuration.
const JOBS_PER_RUN = 1;
const FIRST_TARGET = 240;
const STEP = 120;
const CEILING = 1024;
const TOLERANCE = 12; // in-VM dedupe can return a few fewer than requested — don't mis-read as exhausted

/** How many posts the scraper actually returned this run (raw, pre-index-dedupe) — the honest signal for
 *  whether more depth is available. (indexed.perPlatform[].items is deduped/capped, so unreliable here.) */
function scrapedPostCount(platform: string, profile: SocialProfileFull): number {
  const p = profile as { recentPublicPosts?: unknown[]; recentThreads?: unknown[]; timelineItems?: unknown[] };
  if (platform === "instagram") return p.recentPublicPosts?.length ?? 0;
  if (platform === "threads") return p.recentThreads?.length ?? 0;
  if (platform === "x") return p.timelineItems?.length ?? 0;
  return 0;
}

/** The account's stated total post/thread count (handles "1,234" / "1.2K" / "3M"). Best-effort: returns
 *  null when it can't parse confidently, so it only ever STOPS the ladder early, never falsely. */
function accountTotalCount(platform: string, profile: SocialProfileFull): number | null {
  const stats = (profile as { stats?: { posts?: string | null; threads?: string | null } }).stats;
  const raw = platform === "threads" ? stats?.threads : stats?.posts;
  if (typeof raw !== "string") return null;
  const m = raw.trim().replace(/,/g, "").match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2]?.toUpperCase();
  if (suffix === "K") n *= 1e3;
  else if (suffix === "M") n *= 1e6;
  else if (suffix === "B") n *= 1e9;
  return n > 0 ? Math.round(n) : null;
}

async function scrapeProfile(platform: string, url: string, maxPosts: number): Promise<SocialProfileFull | null> {
  if (platform === "instagram") {
    const outcome = await scrapeInstagramProfileUrl(url, { maxPosts });
    return outcome.status === "profile" ? outcome.profile : null;
  }
  if (platform === "threads") {
    const outcome = await scrapeThreadsProfileUrl(url, { maxPosts });
    return outcome.status === "profile" ? outcome.profile : null;
  }
  if (platform === "x") {
    const outcome = await scrapeXProfileUrl(url, { maxPosts });
    return outcome.status === "profile" ? outcome.profile : null;
  }
  return null;
}

export async function POST(request: Request) {
  try {
    verifyInternalJobRequest(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const jobs = await claimSocialRefreshJobs(JOBS_PER_RUN, { platforms: DEEP_PLATFORMS });
  const results: Array<Record<string, unknown>> = [];

  for (const job of jobs) {
    try {
      const meta = (job.metadata && typeof job.metadata === "object" ? job.metadata : {}) as {
        url?: string;
        maxPosts?: number;
        scanRunId?: string | null;
        refresh?: boolean;
      };
      if (!job.firebaseUid || !meta.url) {
        await failSocialRefreshJob(job.id, "missing firebaseUid or url");
        results.push({ id: job.id, ok: false, reason: "missing_input" });
        continue;
      }
      const profile = await scrapeProfile(job.platform, meta.url, meta.maxPosts ?? 1024);
      if (!profile) {
        // access pending, rate-limited, or scraper error — retry with backoff (failJob re-queues)
        await failSocialRefreshJob(job.id, "scrape returned no profile (access pending / rate limited / error)");
        results.push({ id: job.id, ok: false, reason: "no_profile" });
        continue;
      }
      const indexed = await indexSocialArchive({
        firebaseUid: job.firebaseUid,
        scanRunId: meta.scanRunId ?? null,
        version: PROFILE_VERSION,
        profiles: [profile],
        maxItemsPerProfile: 1024,
      });
      // Kick a preference recompute now that this platform's archive landed (media may still be
      // processing — synthesis handles partial state and will be re-run as media completes).
      await enqueueSocialRefreshJobs({
        firebaseUid: job.firebaseUid,
        jobs: [{ platform: PREFERENCE_RECOMPUTE_PLATFORM, publicId: meta.scanRunId ?? "latest", metadata: { scanRunId: meta.scanRunId ?? null }, priority: -1 }],
      });

      // Freshness refresh job: just pull the recent window to catch NEW posts (upsert adds them), recompute,
      // and COMPLETE — do NOT re-grow the ladder (the full 1024 depth already exists; re-growing every few
      // days would be wasteful). Branch out before the staged-grow block so `refresh` never leaks into a
      // grow re-enqueue.
      if (meta.refresh) {
        await completeSocialRefreshJob(job.id);
        results.push({ id: job.id, ok: true, platform: job.platform, indexed, refresh: true });
        continue;
      }

      // Staged growth: if this batch came back full (≈ requested) and we're below the ceiling and the
      // account has more, re-arm the SAME deep job for the next +STEP batch (resetAttempts so the climb
      // doesn't burn the 5-attempt budget). Otherwise the account is exhausted or we hit the ceiling →
      // complete. Re-enqueue flips the just-claimed row back to "queued"; never also complete it.
      const requested = typeof meta.maxPosts === "number" ? meta.maxPosts : FIRST_TARGET;
      const returned = scrapedPostCount(job.platform, profile);
      const total = accountTotalCount(job.platform, profile);
      const reachedAccount = total != null && requested >= total;
      const moreAvailable = requested < CEILING && returned >= requested - TOLERANCE && !reachedAccount;
      if (moreAvailable) {
        const nextTarget = Math.min(requested + STEP, CEILING);
        await enqueueSocialRefreshJobs({
          firebaseUid: job.firebaseUid,
          jobs: [{ platform: job.platform, publicId: job.publicId, metadata: { ...meta, maxPosts: nextTarget }, resetAttempts: true }],
        });
        results.push({ id: job.id, ok: true, platform: job.platform, indexed, returned, requested, nextTarget });
      } else {
        await completeSocialRefreshJob(job.id);
        results.push({ id: job.id, ok: true, platform: job.platform, indexed, returned, requested, done: true });
      }
    } catch (error) {
      await failSocialRefreshJob(job.id, error instanceof Error ? error.message : "archive worker error");
      results.push({ id: job.id, ok: false, reason: "exception" });
    }
  }

  return NextResponse.json({ ok: true, claimed: jobs.length, results });
}
