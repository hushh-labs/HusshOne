/* Connect-later pipeline: when a user connects/updates a social platform AFTER onboarding (e.g. from the
   Settings "Connected accounts" section), kick off the SAME deep pipeline the initial "Send One" scan would
   — deep-scrape → archive → preference recompute — so the platform's intelligence flows in automatically,
   WITHOUT a re-scan. Privacy-safe: only fires for users who already consented to preference building.

   Consent is NOT a uid-level flag — it lives in ScanRun.input — so we resolve it via the latest scan. All
   functions are fully defensive (any failure → a no-op skip); the connect handshake must never break because
   of this. Idempotency comes for free from enqueueSocialRefreshJobs' (userId, platform, publicId) dedup:
   re-connecting the same handle just re-arms the existing job; a changed handle creates a correct new one. */
import {
  enqueueSocialRefreshJobs,
  getLatestScanForUser,
  getResearchJob,
  hasPendingPreferenceWork,
  PREFERENCE_RECOMPUTE_PLATFORM,
} from "@/lib/db/scan-store";

// Matches the social-archive worker's FIRST_TARGET — a job with this maxPosts and NO `refresh` flag enters
// the staged 240→512 deep climb (a `refresh:true` job would be the shallow recent-window path instead).
const FIRST_TARGET = 240;
const DEEP_PLATFORMS = new Set(["instagram", "threads", "x"]);

export interface PreferenceConsentContext {
  consent: boolean;
  scanRunId: string | null;
}

/** Whether the user consented to preference building, plus their latest scanRunId. Consent lives in
 *  ScanRun.input (no uid-level column), so we read the latest scan → its input. Defensive: any failure
 *  (no scan yet, DB unset) → { consent:false }. */
export async function getPreferenceConsentContext(firebaseUid: string): Promise<PreferenceConsentContext> {
  try {
    const latest = await getLatestScanForUser(firebaseUid);
    const scanRunId = latest?.id ?? null;
    if (!scanRunId) return { consent: false, scanRunId: null };
    const job = await getResearchJob(firebaseUid, scanRunId);
    const input = (job?.input ?? null) as { socialPreferenceConsent?: unknown } | null;
    return { consent: input?.socialPreferenceConsent === true, scanRunId };
  } catch {
    return { consent: false, scanRunId: null };
  }
}

export interface ConnectPipelineResult {
  enqueued: boolean;
  reason: "enqueued" | "no_consent" | "pending_work" | "not_deep_platform" | "missing_input" | "enqueue_failed" | "error";
}

/** Connecting a deep-scrape platform (IG/X/Threads) later → enqueue the full deep climb if consented and no
 *  job is already in flight. Fire-and-forget; the archive worker auto-enqueues the recompute after indexing. */
export async function maybeEnqueueConnectDeepScrape(opts: {
  firebaseUid: string;
  platform: string;
  username: string;
  profileUrl: string;
}): Promise<ConnectPipelineResult> {
  try {
    const platform = opts.platform.trim().toLowerCase();
    if (!DEEP_PLATFORMS.has(platform)) return { enqueued: false, reason: "not_deep_platform" };
    if (!opts.firebaseUid || !opts.username || !opts.profileUrl) return { enqueued: false, reason: "missing_input" };
    const { consent, scanRunId } = await getPreferenceConsentContext(opts.firebaseUid);
    if (!consent) return { enqueued: false, reason: "no_consent" };
    if (await hasPendingPreferenceWork(opts.firebaseUid)) return { enqueued: false, reason: "pending_work" };
    const n = await enqueueSocialRefreshJobs({
      firebaseUid: opts.firebaseUid,
      jobs: [
        {
          platform,
          publicId: opts.username.trim().toLowerCase(),
          metadata: { url: opts.profileUrl, maxPosts: FIRST_TARGET, scanRunId },
        },
      ],
    });
    return { enqueued: n > 0, reason: n > 0 ? "enqueued" : "enqueue_failed" };
  } catch {
    return { enqueued: false, reason: "error" };
  }
}

/** Connecting/updating LinkedIn (a profile, not a post feed) → enqueue a preference RECOMPUTE so the
 *  refreshed career context (buildProfessionalContext) reaches synthesis. Consent-gated, idempotent. */
export async function maybeEnqueueConnectRecompute(firebaseUid: string): Promise<ConnectPipelineResult> {
  try {
    if (!firebaseUid) return { enqueued: false, reason: "missing_input" };
    const { consent, scanRunId } = await getPreferenceConsentContext(firebaseUid);
    if (!consent) return { enqueued: false, reason: "no_consent" };
    if (await hasPendingPreferenceWork(firebaseUid)) return { enqueued: false, reason: "pending_work" };
    const n = await enqueueSocialRefreshJobs({
      firebaseUid,
      jobs: [{ platform: PREFERENCE_RECOMPUTE_PLATFORM, publicId: scanRunId ?? "latest", metadata: { scanRunId }, priority: 1 }],
    });
    return { enqueued: n > 0, reason: n > 0 ? "enqueued" : "enqueue_failed" };
  } catch {
    return { enqueued: false, reason: "error" };
  }
}
