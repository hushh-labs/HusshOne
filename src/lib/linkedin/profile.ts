/**
 * Normalize the raw LinkedIn OAuth responses (OIDC userinfo + /rest/identityMe +
 * /rest/verificationReport + decoded id_token) into ONE clean profile object that
 * the product feeds into Phase-1 Deep Research as authoritative identity anchor
 * facts. Pure — no Next/React deps; consumes what src/lib/linkedin/oauth.ts returns.
 *
 * The OIDC `userinfo` is the guaranteed floor (sub/name/email/picture/locale).
 * identityMe (r_profile_basicinfo) adds the public `profileUrl`, a larger cropped
 * photo, AND the `headline` (a MultiLocaleString carrying current + past roles/
 * companies — the strongest disambiguator); verificationReport adds `verifications`.
 */
import type { ProbeResult, RawApiResult } from "./oauth";
import { normalizeLinkedInUrl } from "@/lib/auth/identity";

export interface LinkedInProfile {
  sub: string;
  name: string;
  givenName: string;
  familyName: string;
  email: string | null;
  emailVerified: boolean;
  locale: string | null;
  pictureUrl: string | null; // media.licdn.com — SIGNED, expires (capture bytes early for the image pipeline)
  profileUrl: string | null; // the anchor Phase-1 uses
  headline: string | null; // identityMe MultiLocaleString — current + past roles/companies
  verifications: string[]; // e.g. ["WORKPLACE"]
  grantedScopes: string[];
}

/* ── Full LinkedIn profile (URL-paste enrichment) ──────────────────────────
   The OAuth path (buildLinkedInProfile above) only yields name/email/photo/
   headline + verifications. The "Paste your LinkedIn URL" step (src/lib/linkedin/
   scraper-profile.ts) enriches a pasted /in/ URL into the FULL profile — bio,
   structured roles, schools, skills. We carry those as extra fields on top of the
   same LinkedInProfile shape so every existing reader keeps working, and the
   dossier can build a real (not headline-parsed) career spine from the About+roles. */
export interface LinkedInExperience {
  title: string;
  company: string;
  employmentType?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  current?: boolean;
  description?: string;
}
export interface LinkedInEducation {
  school: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  grade?: string;
  description?: string;
}
export interface LinkedInCertification {
  name: string;
  authority?: string;
  date?: string;
}
export interface LinkedInProfileStats {
  followers?: string;
  connections?: string;
  isConnection?: boolean;
  premium?: boolean;
  creator?: boolean;
}
export interface LinkedInProfileFull extends LinkedInProfile {
  location?: string | null;
  about?: string | null;
  experience?: LinkedInExperience[];
  education?: LinkedInEducation[];
  skills?: string[];
  certifications?: LinkedInCertification[];
  profileStats?: LinkedInProfileStats;
  /** Where this profile came from: "oauth" (limited), "mcp" (user live-login), or "scraper" (URL enrichment). */
  source?: "oauth" | "mcp" | "scraper";
}

/** True only for the URL-paste enrichment profile that is rich enough to anchor
    Phase-1 with complete normalized LinkedIn JSON. OAuth-lite profiles are not
    enough for the current One intelligence contract. */
export function hasUrlEnrichedLinkedInProfile(profile: LinkedInProfileFull | null | undefined): profile is LinkedInProfileFull {
  if (!profile || profile.source !== "scraper") return false;
  if (!normalizeLinkedInUrl(profile.profileUrl ?? "")) return false;
  return Boolean(
    (profile.about && profile.about.trim()) ||
      (profile.experience ?? []).some((item) => item && (item.title || item.company)) ||
      (profile.education ?? []).some((item) => item && item.school) ||
      (profile.skills ?? []).some((skill) => typeof skill === "string" && skill.trim()) ||
      (profile.certifications ?? []).some((item) => item && item.name),
  );
}

/** A minimal URL-only "degraded" LinkedIn profile, built when the scraper VM is down/unreachable at
 *  connect time. It deliberately FAILS hasUrlEnrichedLinkedInProfile (no about/experience/education/
 *  skills) so the strict anchor gate stays closed until a background re-enrich upgrades it to the real
 *  rich profile — i.e. a VM blip never hard-errors the connect, but a weak anchor never reaches Phase-1. */
export function buildLinkedInHandshakeProfile(normalizedUrl: string): LinkedInProfileFull | null {
  const handle = normalizedUrl.match(/\/in\/([^/]+)\/?$/i)?.[1];
  if (!handle) return null;
  const name = handle
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return {
    sub: handle,
    name: name || handle,
    givenName: name.split(" ")[0] || handle,
    familyName: name.split(" ").slice(1).join(" "),
    email: null,
    emailVerified: false,
    locale: null,
    pictureUrl: null,
    profileUrl: normalizedUrl,
    headline: null,
    verifications: [],
    grantedScopes: ["scraper:linkedin-profile-url"],
    source: "scraper",
  };
}

/** Compact career-spine summary for the preference synthesis `professionalContext` slot — this is how
 *  LinkedIn (a profile, not a post feed) enters the intelligence layer: it grounds the preference
 *  inferences (especially mental-models / professional questions) in the user's real career instead of
 *  guessing from social posts alone. Pure; returns null when there's nothing useful. Kept short — the
 *  synthesis already carries the social evidence. */
export function buildProfessionalContext(profile: LinkedInProfileFull | null | undefined): string | null {
  if (!profile) return null;
  const parts: string[] = [];
  const headline = strOrNull(profile.headline);
  if (headline) parts.push(`Headline: ${headline}`);
  const location = strOrNull(profile.location ?? null);
  if (location) parts.push(`Location: ${location}`);
  const roles = (profile.experience ?? [])
    .filter((e) => e && (e.title || e.company))
    .slice(0, 6)
    .map((e) => {
      const role = [e.title, e.company].filter(Boolean).join(" @ ");
      const span = [e.startDate, e.current ? "present" : e.endDate].filter(Boolean).join("–");
      return `- ${role}${span ? ` (${span})` : ""}`;
    });
  if (roles.length) parts.push(`Experience:\n${roles.join("\n")}`);
  const schools = (profile.education ?? [])
    .filter((e) => e && e.school)
    .slice(0, 3)
    .map((e) => `- ${[e.school, e.degree, e.field].filter(Boolean).join(", ")}`);
  if (schools.length) parts.push(`Education:\n${schools.join("\n")}`);
  const skills = (profile.skills ?? []).filter((s) => typeof s === "string" && s.trim()).slice(0, 20);
  if (skills.length) parts.push(`Skills: ${skills.join(", ")}`);
  const about = strOrNull(profile.about ?? null);
  if (about) parts.push(`About: ${about.slice(0, 600)}`);
  const text = parts.join("\n").trim();
  return text ? text.slice(0, 2000) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function strOrNull(value: unknown): string | null {
  const s = str(value);
  return s ? s : null;
}

/** LinkedIn MultiLocaleString → plain string (prefers en_US, else first locale). */
function localized(value: unknown): string {
  const rec = asRecord(value);
  const loc = asRecord(rec.localized);
  if (typeof loc.en_US === "string") return loc.en_US;
  const first = Object.values(loc).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

/** OIDC locale may be a string ("en-US") or an object ({country, language}). */
function normalizeLocale(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  const rec = asRecord(value);
  const lang = str(rec.language);
  const country = str(rec.country);
  if (lang && country) return `${lang}-${country}`;
  return lang || country || null;
}

function probeData(probes: ProbeResult[], key: string): Record<string, unknown> | null {
  const probe = probes.find((p) => p.key === key);
  if (!probe || !probe.result || !probe.result.ok) return null;
  return asRecord(probe.result.data);
}

export function buildLinkedInProfile(params: {
  userinfo: RawApiResult;
  probes: ProbeResult[];
  idTokenClaims: unknown;
  grantedScopes: string[];
}): LinkedInProfile {
  const info = params.userinfo.ok ? asRecord(params.userinfo.data) : {};
  const claims = asRecord(params.idTokenClaims);

  // identityMe (r_profile_basicinfo): { basicInfo: { firstName, lastName, primaryEmailAddress, profileUrl, profilePicture } }
  const identity = probeData(params.probes, "identity_me");
  const basicInfo = asRecord(identity?.basicInfo);
  const croppedImage = asRecord(asRecord(basicInfo.profilePicture).croppedImage);

  // verificationReport (r_verify): { verifications: ["IDENTITY","WORKPLACE"] }
  const verification = probeData(params.probes, "verification_report");
  const verifications = Array.isArray(verification?.verifications)
    ? (verification!.verifications as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  const givenName = str(info.given_name) || localized(basicInfo.firstName);
  const familyName = str(info.family_name) || localized(basicInfo.lastName);
  const name = str(info.name) || [givenName, familyName].filter(Boolean).join(" ");

  return {
    sub: str(info.sub) || str(claims.sub),
    name,
    givenName,
    familyName,
    email: strOrNull(info.email) ?? strOrNull(basicInfo.primaryEmailAddress),
    emailVerified: info.email_verified === true,
    locale: normalizeLocale(info.locale ?? claims.locale),
    // Prefer identityMe's larger cropped photo (shrink_800) over OIDC's shrink_100.
    pictureUrl: strOrNull(croppedImage.downloadUrl) ?? strOrNull(info.picture),
    profileUrl: strOrNull(basicInfo.profileUrl),
    // identityMe returns headline as a MultiLocaleString (current + past roles/companies —
    // the strongest disambiguator), NOT a plain string. Was being dropped before.
    headline: strOrNull(localized(basicInfo.headline)) ?? strOrNull(info.headline),
    verifications,
    grantedScopes: params.grantedScopes,
  };
}
