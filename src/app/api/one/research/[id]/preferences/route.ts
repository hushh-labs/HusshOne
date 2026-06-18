import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import {
  enqueueSocialRefreshJobs,
  getArchiveFreshness,
  getResearchJob,
  getUserPreferenceProfile,
  getUserPreferenceProfileByInputHash,
  hasPendingPreferenceWork,
  indexSocialPreferenceEvidence,
  logUserPreferenceRun,
  PREFERENCE_RECOMPUTE_PLATFORM,
  saveUserPreferenceProfile,
  updateDeepTier,
} from "@/lib/db/scan-store";
import {
  buildUserPreferenceProfile,
  PROFILE_VERSION,
  QUESTION_REGISTRY_VERSION,
  type UserPreferenceProfile,
} from "@/lib/social-intelligence/preference-profile";
import { PREFERENCE_SYNTHESIS_VERSION } from "@/lib/social-intelligence/preference-synthesis";
import type { OneDashboardResult, OneSubjectInput, SocialProfileFull } from "@/lib/ria/types";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Surface gate: don't report the preference layer "completed" until at least this many of the 30
 * questions are answered/inferred. A weak fast-pass profile keeps reporting "running" so the client
 * shows a building state instead of a thin "completed" layer.
 */
const SHOW_THRESHOLD = 20;

// Freshness: when a returning user's archive hasn't been re-scraped in this many days, the read path kicks
// a lightweight deep-scrape REFRESH (recent window) per connected platform to pull any new posts.
const ARCHIVE_STALE_MS = (Number(process.env.ARCHIVE_STALE_DAYS) || 3) * 24 * 60 * 60 * 1000;
const REFRESH_MAX_POSTS = Number(process.env.REFRESH_MAX_POSTS) || 240;
const DEEP_REFRESH_PLATFORMS = new Set(["instagram", "threads", "x"]);

/** answeredTotal = questionCoverage.answered + questionCoverage.inferred, robust to missing fields. */
function answeredCoverage(coverage: unknown): number {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return 0;
  const c = coverage as { answered?: unknown; inferred?: unknown };
  const answered = typeof c.answered === "number" && Number.isFinite(c.answered) ? c.answered : 0;
  const inferred = typeof c.inferred === "number" && Number.isFinite(c.inferred) ? c.inferred : 0;
  return answered + inferred;
}

function statusCodeOf(error: unknown): number {
  if (typeof error === "object" && error && "statusCode" in error) {
    const n = Number((error as { statusCode?: number }).statusCode);
    if (Number.isFinite(n) && n >= 400) return n;
  }
  return 401;
}

function profileInputHash(input: { linkedinProfile?: unknown; socialProfiles?: unknown }): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        profileVersion: PROFILE_VERSION,
        questionRegistryVersion: QUESTION_REGISTRY_VERSION,
        linkedinProfile: input.linkedinProfile ?? null,
        socialProfiles: input.socialProfiles ?? [],
      }),
    )
    .digest("hex");
}

function isCurrentPreferenceProfile(profile: unknown): profile is UserPreferenceProfile {
  return Boolean(
    profile &&
      typeof profile === "object" &&
      !Array.isArray(profile) &&
      (profile as { version?: unknown }).version === PROFILE_VERSION &&
      (profile as { questionRegistryVersion?: unknown }).questionRegistryVersion === QUESTION_REGISTRY_VERSION,
  );
}

function preferenceCounts(profile: ReturnType<typeof buildUserPreferenceProfile>) {
  return {
    indexedItems: profile.updatedFrom.indexedItems,
    mediaAssets: profile.updatedFrom.mediaAssets,
    externalLinks: profile.updatedFrom.externalLinks,
    questionRegistryVersion: profile.questionRegistryVersion,
    questionCoverage: profile.questionCoverage,
    evidencePoolSize: profile.selection.evidencePoolSize,
    selectedEvidenceCount: profile.selection.selectedEvidenceCount,
    selectedSignalCount: profile.selection.selectedSignalCount,
    droppedEvidenceCount: profile.selection.droppedEvidenceCount,
    byPlatform: profile.selection.byPlatform,
    selectedByPlatform: profile.selection.selectedByPlatform,
    byDomain: profile.selection.byDomain,
    selectionRules: profile.selection.selectionRules,
  };
}

function logInfo(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

function logError(payload: Record<string, unknown>) {
  console.error(JSON.stringify(payload));
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  let firebaseUid: string | null = null;
  let scanRunId: string | null = null;
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    firebaseUid = verified.uid;
    const { id } = await context.params;
    scanRunId = id || null;
    if (!id) return NextResponse.json({ ok: false, error: "Missing scan id" }, { status: 400 });

    const scan = await getResearchJob(verified.uid, id);
    if (!scan) return NextResponse.json({ ok: false, preferenceStatus: "unknown", result: null }, { status: 404 });

    const hasCompletedResult =
      scan.status === "completed" &&
      scan.normalizedResult &&
      typeof scan.normalizedResult === "object" &&
      !Array.isArray(scan.normalizedResult);
    const result = hasCompletedResult ? (scan.normalizedResult as OneDashboardResult & Record<string, unknown>) : null;
    if (
      result &&
      (result.preferenceStatus === "failed" || result.preferenceStatus === "skipped" || isCurrentPreferenceProfile(result.preferenceProfile))
    ) {
      return NextResponse.json({ ok: true, preferenceStatus: result.preferenceStatus, result });
    }

    // v3 upgrade: once the Vertex synthesis worker has produced a profile it supersedes the v2 fast
    // pass. TRUST the worker's terminal status — it already encodes the floor (reveal at >=20 OR once
    // media is fully analyzed), so a sparse account's settled partial is served as "completed" and
    // never hangs the client on "building". While the worker still has it "partial", report "running".
    const stored = (scan.input ?? {}) as Partial<OneSubjectInput>;

    const v3 = await getUserPreferenceProfile<Record<string, unknown>>(verified.uid).catch(() => null);
    if (v3 && v3.profile) {
      const isCurrent = v3.version === PREFERENCE_SYNTHESIS_VERSION;
      if (!isCurrent) {
        // Lazy self-heal: a stored profile from an OLDER synthesis version is stale (the prompt/schema/
        // sections/model/questions/collage changed → the auto-derived version hash flipped). Enqueue an
        // in-place recompute (deduped, higher priority than routine jobs) so the one-preference-recompute
        // scheduler rebuilds it with the current version, and serve the stale profile NOW as "running" so
        // the user still sees best-available data + the render-time headline while it upgrades (~3 min).
        // We never drop to the weaker v2 fast-pass when a v3 profile already exists. The worker re-stamps
        // THIS same version, so the loop converges after one pass.
        void enqueueSocialRefreshJobs({
          firebaseUid: verified.uid,
          jobs: [{ platform: PREFERENCE_RECOMPUTE_PLATFORM, publicId: id ?? "latest", metadata: { scanRunId: id }, priority: 1 }],
        }).catch(() => 0);
      } else if (stored.socialPreferenceConsent === true && stored.socialProfiles?.length) {
        // Lazy FRESHNESS refresh: a returning user whose archive hasn't been re-scraped in
        // ARCHIVE_STALE_DAYS gets a lightweight deep-scrape refresh (recent window) per connected platform
        // to pull any new posts. Best-effort; the current profile is still served immediately and the
        // worker upgrades it within minutes. The !pendingWork gate + same-row dedupe prevent poll-thrash.
        const freshness = await getArchiveFreshness(verified.uid).catch(() => null);
        if (freshness != null && Date.now() - freshness > ARCHIVE_STALE_MS) {
          const pendingWork = await hasPendingPreferenceWork(verified.uid).catch(() => false);
          if (!pendingWork) {
            const refreshJobs = stored.socialProfiles
              .filter((p) => p && p.profileUrl && p.username && DEEP_REFRESH_PLATFORMS.has(p.platform.trim().toLowerCase()))
              .map((p) => ({
                platform: p.platform.trim().toLowerCase(),
                publicId: p.username,
                metadata: { url: p.profileUrl, maxPosts: REFRESH_MAX_POSTS, scanRunId: id, refresh: true },
              }));
            if (refreshJobs.length) void enqueueSocialRefreshJobs({ firebaseUid: verified.uid, jobs: refreshJobs }).catch(() => 0);
          }
        }
      }
      const v3Status = isCurrent && v3.status === "completed" ? "completed" : "running";
      const merged = result
        ? await updateDeepTier(verified.uid, id, { preferenceStatus: v3Status, preferenceProfile: v3.profile })
        : null;
      return NextResponse.json({ ok: true, preferenceStatus: v3Status, preferenceProfile: v3.profile, result: merged ?? result });
    }

    if (stored.socialPreferenceConsent !== true || !stored.socialProfiles?.length) {
      const durationMs = Date.now() - startedAt;
      await logUserPreferenceRun({
        firebaseUid: verified.uid,
        scanRunId: id,
        status: "completed",
        event: "skipped",
        platforms: [],
        counts: {
          reason: stored.socialPreferenceConsent !== true ? "missing_consent" : "no_social_profiles",
          socialProfileCount: stored.socialProfiles?.length ?? 0,
        },
        durationMs,
      }).catch(() => null);
      const preferenceStatus = "skipped";
      logInfo({
        event: "one.preference.skipped",
        severity: "INFO",
        scanRunId: id,
        reason: stored.socialPreferenceConsent !== true ? "missing_consent" : "no_social_profiles",
        durationMs,
      });
      if (!result) {
        return NextResponse.json({ ok: true, preferenceStatus, preferenceProfile: null, result: null });
      }
      const merged = await updateDeepTier(verified.uid, id, { preferenceStatus, preferenceStartedAt: undefined });
      return NextResponse.json({ ok: true, preferenceStatus, preferenceProfile: null, result: merged ?? result });
    }

    // Keep the layer "running" while deep-archive/media jobs are still in flight so the client poll
    // upgrades the fast pass to the v3 synthesis once the worker finishes. Also stay "running" until
    // the profile clears the 20/30 surface gate, so a thin fast pass never reports "completed".
    const pendingWork = await hasPendingPreferenceWork(verified.uid).catch(() => false);
    const settledStatusFor = (profile: { questionCoverage?: unknown }): "running" | "completed" =>
      pendingWork || answeredCoverage(profile.questionCoverage) < SHOW_THRESHOLD ? "running" : "completed";

    const inputHash = profileInputHash({ linkedinProfile: stored.linkedinProfile, socialProfiles: stored.socialProfiles });
    const existing = await getUserPreferenceProfileByInputHash<UserPreferenceProfile>(verified.uid, inputHash).catch(() => null);
    if (existing?.status === "completed" && isCurrentPreferenceProfile(existing)) {
      const settledStatus = settledStatusFor(existing);
      const durationMs = Date.now() - startedAt;
      const counts = preferenceCounts(existing);
      await logUserPreferenceRun({
        firebaseUid: verified.uid,
        scanRunId: id,
        status: existing.status,
        event: "reused",
        version: existing.version,
        inputHash,
        platforms: existing.updatedFrom.platforms,
        counts,
        selectedEvidenceIds: existing.selection.selectedEvidenceIds,
        selectedSignalIds: existing.selection.selectedSignalIds,
        durationMs,
      }).catch(() => null);
      logInfo({
        event: "one.preference.reused",
        severity: "INFO",
        scanRunId: id,
        version: existing.version,
        platforms: existing.updatedFrom.platforms,
        durationMs,
        ...counts,
      });
      if (!result) {
        return NextResponse.json({ ok: true, preferenceStatus: settledStatus, preferenceProfile: existing, result: null });
      }
      const merged = await updateDeepTier(verified.uid, id, {
        preferenceStatus: settledStatus,
        preferenceVersion: existing.version,
        preferenceInputHash: inputHash,
        preferenceProfile: existing,
        preferenceStartedAt: undefined,
      });
      return NextResponse.json({
        ok: true,
        preferenceStatus: settledStatus,
        preferenceProfile: existing,
        result: merged ?? { ...result, preferenceStatus: settledStatus, preferenceVersion: existing.version, preferenceInputHash: inputHash, preferenceProfile: existing },
      });
    }

    logInfo({
      event: "one.preference.started",
      severity: "INFO",
      scanRunId: id,
      socialProfileCount: stored.socialProfiles.length,
      platforms: stored.socialProfiles.map((profile) => profile.platform),
    });

    const profile = buildUserPreferenceProfile({
      linkedinProfile: stored.linkedinProfile as LinkedInProfileFull | undefined,
      socialProfiles: stored.socialProfiles as SocialProfileFull[] | undefined,
    });
    const settledStatus = settledStatusFor(profile);
    const indexed = await indexSocialPreferenceEvidence({
      firebaseUid: verified.uid,
      scanRunId: id,
      version: profile.version,
      evidence: profile.evidence,
    }).catch(() => null);
    await saveUserPreferenceProfile({
      firebaseUid: verified.uid,
      scanRunId: id,
      status: profile.status,
      version: profile.version,
      profile,
      inputHash,
      generatedAt: profile.generatedAt,
      staleAfter: profile.refresh.staleAfter,
    }).catch(() => null);
    const durationMs = Date.now() - startedAt;
    const counts = { ...preferenceCounts(profile), indexedContentItems: indexed?.contentItems ?? null, indexedMediaAssets: indexed?.mediaAssets ?? null };
    await logUserPreferenceRun({
      firebaseUid: verified.uid,
      scanRunId: id,
      status: profile.status,
      event: "completed",
      version: profile.version,
      inputHash,
      platforms: profile.updatedFrom.platforms,
      counts,
      selectedEvidenceIds: profile.selection.selectedEvidenceIds,
      selectedSignalIds: profile.selection.selectedSignalIds,
      durationMs,
    }).catch(() => null);
    logInfo({
      event: "one.preference.completed",
      severity: "INFO",
      scanRunId: id,
      version: profile.version,
      platforms: profile.updatedFrom.platforms,
      durationMs,
      ...counts,
    });

    if (!result) {
      return NextResponse.json({ ok: true, preferenceStatus: settledStatus, preferenceProfile: profile, result: null });
    }
    const merged = await updateDeepTier(verified.uid, id, {
      preferenceStatus: settledStatus,
      preferenceVersion: profile.version,
      preferenceInputHash: inputHash,
      preferenceProfile: profile,
      preferenceStartedAt: undefined,
    });
    return NextResponse.json({
      ok: true,
      preferenceStatus: settledStatus,
      preferenceProfile: profile,
      result: merged ?? { ...result, preferenceStatus: settledStatus, preferenceVersion: profile.version, preferenceInputHash: inputHash, preferenceProfile: profile },
    });
  } catch (error) {
    const status = statusCodeOf(error);
    const message = error instanceof Error ? error.message : "Could not advance preference intelligence";
    const durationMs = Date.now() - startedAt;
    if (firebaseUid && scanRunId) {
      await logUserPreferenceRun({
        firebaseUid,
        scanRunId,
        status: "failed",
        event: "failed",
        durationMs,
        error: message.slice(0, 500),
      }).catch(() => null);
      await updateDeepTier(firebaseUid, scanRunId, { preferenceStatus: "failed", preferenceStartedAt: undefined }).catch(() => null);
    }
    logError({
      event: "one.preference.failed",
      severity: "ERROR",
      scanRunId,
      status,
      durationMs,
      message,
    });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
