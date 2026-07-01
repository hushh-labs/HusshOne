/* Dev-API preference layer. `UserPreferenceProfile.userId` is @unique, so if every scan under a key
   shared the one synthetic user `api:<keyId>` the preference row would COLLIDE across different subjects
   scanned under that key. Fix: each subject gets its OWN synthetic user `api:<keyId>:<inputHash>` — the
   profile row is then naturally per-subject and `getUserPreferenceProfile` is safe (no cross-subject
   leak). At scan time we build the inline fast-pass (immediate) AND enqueue the async deep/lifestyle
   pipeline under that user; reads transparently upgrade fast-pass → v3 + lifestyle. Everything is
   best-effort — a preference failure never breaks the scan. */
import crypto from "node:crypto";
import {
  enqueueSocialRefreshJobs,
  getUserPreferenceProfile,
  saveUserPreferenceProfile,
  upsertOneUser,
} from "@/lib/db/scan-store";
import {
  buildUserPreferenceProfile,
  PROFILE_VERSION,
  QUESTION_REGISTRY_VERSION,
} from "@/lib/social-intelligence/preference-profile";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";
import type { OneSubjectInput, SocialProfileFull } from "@/lib/ria/types";

// Reveal gate — mirror the app: don't call the layer "completed" until enough of the 30 questions land.
const SHOW_THRESHOLD = 20;
const DEEP_PLATFORMS = new Set(["instagram", "threads", "x"]);
// Matches the social-archive worker's FIRST_TARGET: a job with this maxPosts + NO `refresh` flag enters
// the staged deep climb that fills the archive → media-analyze → recompute → v3 + lifestyle.
const FIRST_TARGET = 240;

export type DevPreferenceStatus = "skipped" | "running" | "completed";

/** Deterministic, ORDER-STABLE hash of the subject's social handles (version-salted) — the per-subject
 *  identity. Keyed on the sorted profile URLs/usernames, NOT the full scraped objects: those get stored in
 *  Postgres `jsonb`, which does not preserve key order, so hashing the whole object would produce a
 *  DIFFERENT hash at POST (in-memory) vs GET (from the DB) → the profile saved under one subject-uid but
 *  read under another. Sorted scalar handles are stable across that round-trip. */
export function subjectInputHash(input: { linkedinProfile?: unknown; socialProfiles?: unknown }): string {
  const ids: string[] = [];
  const li = input.linkedinProfile as { profileUrl?: unknown } | null | undefined;
  const liUrl = li && typeof li.profileUrl === "string" ? li.profileUrl : "";
  if (liUrl) ids.push(`linkedin:${liUrl.toLowerCase().replace(/\/+$/, "")}`);
  const socials = Array.isArray(input.socialProfiles) ? (input.socialProfiles as Array<Record<string, unknown>>) : [];
  for (const p of socials) {
    const platform = typeof p.platform === "string" ? p.platform.toLowerCase() : "social";
    const handle = (typeof p.profileUrl === "string" && p.profileUrl) || (typeof p.username === "string" && p.username) || "";
    if (handle) ids.push(`${platform}:${String(handle).toLowerCase().replace(/\/+$/, "")}`);
  }
  ids.sort();
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ profileVersion: PROFILE_VERSION, questionRegistryVersion: QUESTION_REGISTRY_VERSION, ids }))
    .digest("hex");
}

/** Per-subject synthetic user id: `api:<keyId>:<inputHash-prefix>`. */
export function apiSubjectUid(keyId: string, inputHash: string): string {
  return `api:${keyId}:${inputHash.slice(0, 24)}`;
}

function coverageAnswered(coverage: unknown): number {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return 0;
  const c = coverage as { answered?: unknown; inferred?: unknown };
  const answered = typeof c.answered === "number" && Number.isFinite(c.answered) ? c.answered : 0;
  const inferred = typeof c.inferred === "number" && Number.isFinite(c.inferred) ? c.inferred : 0;
  return answered + inferred;
}

/** Preference building is enabled when the subject has a feed source AND consent isn't explicitly off. */
export function devPreferencesEnabled(input: Partial<OneSubjectInput>): boolean {
  const hasFeed = Boolean(input.socialProfiles?.length || input.linkedinProfile);
  return input.socialPreferenceConsent !== false && hasFeed;
}

/** At scan time: create the per-subject user, persist the inline fast-pass (immediate preferences), and
 *  enqueue the deep climb (→ archive → media-analyze → recompute → v3 + lifestyle). Best-effort. */
export async function enableDevPreferences(opts: {
  keyId: string;
  input: OneSubjectInput;
  scanRunId: string | null;
}): Promise<{ subjectUid: string; inputHash: string } | null> {
  const { keyId, input, scanRunId } = opts;
  if (!devPreferencesEnabled(input)) return null;
  const inputHash = subjectInputHash(input);
  const subjectUid = apiSubjectUid(keyId, inputHash);
  try {
    await upsertOneUser({ firebaseUid: subjectUid, email: input.email, name: input.name, photoUrl: null, provider: "api" });

    const linkedinProfile = input.linkedinProfile as LinkedInProfileFull | undefined;
    const socialProfiles = (input.socialProfiles ?? []) as SocialProfileFull[];

    // Inline fast-pass over the already-scraped profiles → preferences available immediately.
    const profile = buildUserPreferenceProfile({ linkedinProfile, socialProfiles });
    await saveUserPreferenceProfile({
      firebaseUid: subjectUid,
      scanRunId,
      status: profile.status,
      version: profile.version,
      profile,
      inputHash,
      generatedAt: profile.generatedAt,
      staleAfter: profile.refresh.staleAfter,
    }).catch(() => null);

    // Enqueue the deep climb per platform (the social-archive worker scrapes posts + images under this
    // per-subject user → media-analyze → recompute → v3 + lifestyle). LinkedIn posts scraped from its URL.
    const jobs: Array<{ platform: string; publicId: string; metadata: Record<string, unknown> }> = [];
    for (const p of socialProfiles) {
      const platform = p.platform?.trim().toLowerCase();
      if (platform && p.profileUrl && p.username && DEEP_PLATFORMS.has(platform)) {
        jobs.push({ platform, publicId: p.username, metadata: { url: p.profileUrl, maxPosts: FIRST_TARGET, scanRunId } });
      }
    }
    if (linkedinProfile?.profileUrl) {
      const handle = linkedinProfile.profileUrl.replace(/\/+$/, "").split("/").pop() || "linkedin";
      jobs.push({ platform: "linkedin", publicId: handle.toLowerCase(), metadata: { url: linkedinProfile.profileUrl, maxPosts: FIRST_TARGET, scanRunId } });
    }
    if (jobs.length) await enqueueSocialRefreshJobs({ firebaseUid: subjectUid, jobs }).catch(() => 0);

    return { subjectUid, inputHash };
  } catch {
    return null;
  }
}

export interface DevPreferenceRead {
  status: DevPreferenceStatus;
  profile: unknown | null;
}

/** Read the best-available preferences for a subject (fast-pass → v3 + lifestyle), per-subject-safe. */
export async function readDevPreferences(keyId: string, input: Partial<OneSubjectInput>): Promise<DevPreferenceRead> {
  if (!devPreferencesEnabled(input)) return { status: "skipped", profile: null };
  const inputHash = subjectInputHash(input);
  const subjectUid = apiSubjectUid(keyId, inputHash);
  const stored = await getUserPreferenceProfile<Record<string, unknown>>(subjectUid).catch(() => null);
  if (!stored?.profile) return { status: "running", profile: null };
  const coverage = (stored.profile as { questionCoverage?: unknown }).questionCoverage;
  const answered = coverageAnswered(coverage);
  const status: DevPreferenceStatus = stored.status === "completed" && answered >= SHOW_THRESHOLD ? "completed" : "running";
  return { status, profile: stored.profile };
}
