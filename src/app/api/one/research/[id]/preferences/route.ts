import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import {
  getResearchJob,
  getUserPreferenceProfile,
  getUserPreferenceProfileByInputHash,
  hasPendingPreferenceWork,
  indexSocialPreferenceEvidence,
  logUserPreferenceRun,
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
    // pass. While still "partial" (media analyzing) report "running" so the client keeps polling.
    const v3 = await getUserPreferenceProfile<Record<string, unknown>>(verified.uid).catch(() => null);
    if (v3 && v3.version === PREFERENCE_SYNTHESIS_VERSION && v3.profile) {
      const v3Status = v3.status === "completed" ? "completed" : "running";
      const merged = result
        ? await updateDeepTier(verified.uid, id, { preferenceStatus: v3Status, preferenceProfile: v3.profile })
        : null;
      return NextResponse.json({ ok: true, preferenceStatus: v3Status, preferenceProfile: v3.profile, result: merged ?? result });
    }

    const stored = (scan.input ?? {}) as Partial<OneSubjectInput>;
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
    // upgrades the fast pass to the v3 synthesis once the worker finishes.
    const pendingWork = await hasPendingPreferenceWork(verified.uid).catch(() => false);
    const settledStatus: "running" | "completed" = pendingWork ? "running" : "completed";

    const inputHash = profileInputHash({ linkedinProfile: stored.linkedinProfile, socialProfiles: stored.socialProfiles });
    const existing = await getUserPreferenceProfileByInputHash<UserPreferenceProfile>(verified.uid, inputHash).catch(() => null);
    if (existing?.status === "completed" && isCurrentPreferenceProfile(existing)) {
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
