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
const JOBS_PER_RUN = 2; // deep scrape is slow (≤180s/platform) — keep each invocation bounded

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
      await completeSocialRefreshJob(job.id);
      results.push({ id: job.id, ok: true, platform: job.platform, indexed });
    } catch (error) {
      await failSocialRefreshJob(job.id, error instanceof Error ? error.message : "archive worker error");
      results.push({ id: job.id, ok: false, reason: "exception" });
    }
  }

  return NextResponse.json({ ok: true, claimed: jobs.length, results });
}
