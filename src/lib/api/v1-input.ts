/* v1 developer API: validate the simple URL-based body, scrape each provided profile URL via its
   service layer (VM) in parallel, and build the OneSubjectInput that Phase-1 consumes — exactly the
   objects the One web app preloads. Returns both the `OneSubjectInput` (enriched profiles attached)
   and a `profiles` map (the per-platform scraped contracts) for the API response. A failed/private/thin
   profile is reported in `profiles` and simply omitted from the scan — it never throws. No preference
   layer is touched here. */
import { scrapeLinkedInProfileUrl } from "@/lib/linkedin/scraper-profile";
import { normalizeLinkedInUrl } from "@/lib/auth/identity";
import { scrapeInstagramProfileUrl } from "@/lib/instagram/scraper-profile";
import { scrapeThreadsProfileUrl } from "@/lib/threads/scraper-profile";
import { scrapeXProfileUrl } from "@/lib/x/scraper-profile";
import { hasUrlEnrichedLinkedInProfile } from "@/lib/linkedin/profile";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";
import type { ConfirmedProfile, OneSubjectInput, SocialProfileFull } from "@/lib/ria/types";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class V1InputError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode = 400, code = "bad_input") {
    super(message);
    this.name = "V1InputError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Per-platform value in the response `profiles` map: the full scraped profile, a pending/failed
 *  marker, or null when the URL wasn't provided. */
export type V1ProfileReport =
  | LinkedInProfileFull
  | SocialProfileFull
  | { access: string; profileUrl: string }
  | { status: "failed"; error: string }
  | { status: "too_thin"; profileUrl: string }
  | null;

export interface V1Profiles {
  linkedin: V1ProfileReport;
  instagram: V1ProfileReport;
  threads: V1ProfileReport;
  x: V1ProfileReport;
}

export interface V1ScanBuild {
  input: OneSubjectInput;
  profiles: V1Profiles;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Boolean flag with a default: absent/null → default; explicit false → false; anything truthy → true. */
function asBool(value: unknown, dflt: boolean): boolean {
  if (value === undefined || value === null) return dflt;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !/^(false|0|no)$/i.test(value.trim());
  return Boolean(value);
}

async function enrichLinkedIn(url: unknown): Promise<{ profile?: LinkedInProfileFull; report: V1ProfileReport }> {
  if (!asString(url)) return { report: null };
  try {
    const { profile, normalizedUrl } = await scrapeLinkedInProfileUrl(url);
    if (hasUrlEnrichedLinkedInProfile(profile)) return { profile, report: profile };
    return { report: { status: "too_thin", profileUrl: normalizedUrl } };
  } catch (error) {
    return { report: { status: "failed", error: error instanceof Error ? error.message : "linkedin scrape failed" } };
  }
}

type SocialScraper = (url: unknown, opts?: { maxPosts?: number }) =>
  Promise<{ status: "profile"; profile: SocialProfileFull } | { status: "access_pending"; access?: { state?: string } | null; normalizedUrl: string }>;

async function enrichSocial(
  scrape: SocialScraper,
  url: unknown,
): Promise<{ profile?: SocialProfileFull; report: V1ProfileReport }> {
  if (!asString(url)) return { report: null };
  try {
    const outcome = await scrape(url);
    if (outcome.status === "profile") return { profile: outcome.profile, report: outcome.profile };
    return { report: { access: outcome.access?.state || "access_pending", profileUrl: outcome.normalizedUrl } };
  } catch (error) {
    return { report: { status: "failed", error: error instanceof Error ? error.message : "scrape failed" } };
  }
}

/** Sanitize optional caller-provided confirmed anchors (pre-resolved identity pivots — e.g. an SEC
 *  AdviserInfo record) into ConfirmedProfile[]. Mirrors the One web route's parseConfirmedProfiles:
 *  trim + slice each field, canonicalize LinkedIn URLs, drop entries without an http(s) URL, cap 8. */
function parseConfirmedProfiles(value: unknown): ConfirmedProfile[] {
  if (!Array.isArray(value)) return [];
  const out: ConfirmedProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const rawUrl = typeof p.url === "string" ? p.url.trim().slice(0, 400) : "";
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    // Canonicalize the LinkedIn pivot so the anchor is clean ground truth for both phases
    // (fall back to the raw value if it doesn't normalize).
    const url = /linkedin\.com/i.test(rawUrl) ? normalizeLinkedInUrl(rawUrl) || rawUrl : rawUrl;
    out.push({
      url,
      platform: typeof p.platform === "string" ? p.platform.trim().slice(0, 60) : "",
      handle: typeof p.handle === "string" ? p.handle.trim().slice(0, 120) : "",
      category: typeof p.category === "string" ? p.category.trim().slice(0, 60) : "",
    });
    if (out.length >= 8) break;
  }
  return out;
}

function confirmedFrom(linkedin: LinkedInProfileFull | undefined, socials: SocialProfileFull[]): ConfirmedProfile[] {
  const out: ConfirmedProfile[] = [];
  if (linkedin?.profileUrl) out.push({ platform: "LinkedIn", handle: linkedin.profileUrl.split("/in/")[1]?.replace(/\/$/, "") || "", url: linkedin.profileUrl, category: "Professional" });
  for (const social of socials) {
    if (social.profileUrl) out.push({ platform: social.platform, handle: social.username || "", url: social.profileUrl, category: "Social" });
  }
  return out;
}

/** Validate the body, scrape provided URLs in parallel, and assemble the Phase-1 input + contracts. */
export async function buildV1ScanInput(body: Record<string, unknown>): Promise<V1ScanBuild> {
  const name = asString(body.name).slice(0, 80);
  if (!name) throw new V1InputError("`name` is required");
  const email = asString(body.email);
  if (!EMAIL_RE.test(email)) throw new V1InputError("`email` is required and must be a valid email");
  const latitude = asNumber(body.latitude);
  const longitude = asNumber(body.longitude);
  const zipCode = asString(body.zipCode) || undefined;
  const hasGeo = typeof latitude === "number" && typeof longitude === "number";
  if (!hasGeo && !zipCode) throw new V1InputError("Provide `latitude`+`longitude` or `zipCode`");

  // Scrape every provided URL in parallel via its service VM. Each is independent and never throws
  // into the caller — failures/pending are recorded in the report map.
  const [li, ig, th, x] = await Promise.all([
    enrichLinkedIn(body.linkedinUrl),
    enrichSocial(scrapeInstagramProfileUrl as SocialScraper, body.instagramUrl),
    enrichSocial(scrapeThreadsProfileUrl as SocialScraper, body.threadsUrl),
    enrichSocial(scrapeXProfileUrl as SocialScraper, body.xUrl),
  ]);

  const socialProfiles = [ig.profile, th.profile, x.profile].filter((p): p is SocialProfileFull => Boolean(p));
  // Caller-provided anchors (pre-resolved identity) come first, then the scraped-profile-derived ones.
  const confirmedProfiles = [...parseConfirmedProfiles(body.confirmedProfiles), ...confirmedFrom(li.profile, socialProfiles)];

  const phone = asString(body.phone) || undefined;
  // Consent is part of the contract: default true (the API-key holder attests authorization), the dev may
  // override to false. consentAttestation=false → the route rejects with 403. socialPreferenceConsent
  // gates the preference/lifestyle layer (default true, like the One web app).
  const consentAttestation = asBool(body.consentAttestation, true);
  const socialPreferenceConsent = asBool(body.socialPreferenceConsent, true);

  const input: OneSubjectInput = {
    name,
    email,
    ...(hasGeo ? { latitude, longitude } : {}),
    ...(zipCode ? { zipCode } : {}),
    ...(phone ? { phone } : {}),
    ...(li.profile ? { linkedinProfile: li.profile } : {}),
    ...(socialProfiles.length ? { socialProfiles } : {}),
    ...(confirmedProfiles.length ? { confirmedProfiles } : {}),
    consentAttestation,
    socialPreferenceConsent,
    purpose: "self_audit",
  };

  return {
    input,
    profiles: { linkedin: li.report, instagram: ig.report, threads: th.report, x: x.report },
  };
}
