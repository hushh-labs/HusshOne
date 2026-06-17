import {
  linkedinHandleFromUrl,
  normalizeLinkedInUrl,
} from "@/lib/auth/identity";
import {
  hasUrlEnrichedLinkedInProfile,
  type LinkedInCertification,
  type LinkedInEducation,
  type LinkedInExperience,
  type LinkedInProfileFull,
} from "@/lib/linkedin/profile";
import type { ConfirmedProfile } from "@/lib/ria/types";

type LinkedInProfileOptions = {
  requireLinkedIn: boolean;
};

function badInput(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Sanitize the verified LinkedIn profile sent by the client into a bounded,
    scraper-enriched LinkedInProfileFull candidate. */
export function parseLinkedInProfileInput(value: unknown): LinkedInProfileFull | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const s = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const sub = s(p.sub, 120);
  if (!sub) return undefined;
  const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const list = (v: unknown, max: number) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 80)).slice(0, max) : [];

  const experience: LinkedInExperience[] = (Array.isArray(p.experience) ? p.experience : [])
    .slice(0, 25)
    .map((it) => {
      const e = rec(it);
      return {
        title: s(e.title, 160),
        company: s(e.company, 160),
        employmentType: s(e.employmentType, 80) || undefined,
        location: s(e.location, 120) || undefined,
        startDate: s(e.startDate, 40) || undefined,
        endDate: s(e.endDate, 40) || undefined,
        current: e.current === true || undefined,
        description: s(e.description, 1000) || undefined,
      };
    })
    .filter((e) => e.title || e.company);
  const education: LinkedInEducation[] = (Array.isArray(p.education) ? p.education : [])
    .slice(0, 15)
    .map((it) => {
      const e = rec(it);
      return {
        school: s(e.school, 160),
        degree: s(e.degree, 120) || undefined,
        field: s(e.field, 120) || undefined,
        startDate: s(e.startDate, 40) || undefined,
        endDate: s(e.endDate, 40) || undefined,
        grade: s(e.grade, 80) || undefined,
        description: s(e.description, 1000) || undefined,
      };
    })
    .filter((e) => e.school);
  const certifications: LinkedInCertification[] = (Array.isArray(p.certifications) ? p.certifications : [])
    .slice(0, 25)
    .map((it) => {
      const e = rec(it);
      return { name: s(e.name, 160), authority: s(e.authority, 120) || undefined, date: s(e.date, 40) || undefined };
    })
    .filter((c) => c.name);
  const skills = list(p.skills, 50);
  const rawStats = rec(p.profileStats);
  const profileStats = {
    followers: s(rawStats.followers, 80) || undefined,
    connections: s(rawStats.connections, 80) || undefined,
    isConnection: rawStats.isConnection === true || undefined,
    premium: rawStats.premium === true || undefined,
    creator: rawStats.creator === true || undefined,
  };
  const hasProfileStats = Object.values(profileStats).some((v) => v !== undefined);

  return {
    sub,
    name: s(p.name, 120),
    givenName: s(p.givenName, 80),
    familyName: s(p.familyName, 80),
    email: s(p.email, 200) || null,
    emailVerified: p.emailVerified === true,
    locale: s(p.locale, 20) || null,
    pictureUrl: s(p.pictureUrl, 1000) || null,
    profileUrl: s(p.profileUrl, 400) || null,
    headline: s(p.headline, 300) || null,
    verifications: list(p.verifications, 10),
    grantedScopes: list(p.grantedScopes, 20),
    source: p.source === "mcp" ? "mcp" : p.source === "oauth" ? "oauth" : p.source === "scraper" ? "scraper" : undefined,
    location: s(p.location, 160) || null,
    about: s(p.about, 2000) || null,
    ...(experience.length ? { experience } : {}),
    ...(education.length ? { education } : {}),
    ...(skills.length ? { skills } : {}),
    ...(certifications.length ? { certifications } : {}),
    ...(hasProfileStats ? { profileStats } : {}),
  };
}

export function validateLinkedInProfileInput(
  value: unknown,
  options: LinkedInProfileOptions,
): LinkedInProfileFull | undefined {
  const profile = parseLinkedInProfileInput(value);
  if (!profile) {
    if (options.requireLinkedIn) {
      throw badInput("LinkedIn profile URL is required when continuing as guest.");
    }
    return undefined;
  }
  if (!hasUrlEnrichedLinkedInProfile(profile)) {
    throw badInput("Use the LinkedIn URL enrichment step before sending a full LinkedIn profile to One.");
  }
  return profile;
}

export function appendLinkedInConfirmedProfile(
  confirmedProfiles: ConfirmedProfile[] | undefined,
  linkedinProfile: LinkedInProfileFull | undefined,
): ConfirmedProfile[] | undefined {
  if (!linkedinProfile?.profileUrl) return confirmedProfiles;
  const url = normalizeLinkedInUrl(linkedinProfile.profileUrl) || linkedinProfile.profileUrl;
  const hasLinkedIn = (confirmedProfiles ?? []).some(
    (p) => /linkedin/i.test(p.platform || "") || /linkedin\.com\/in\//i.test(p.url),
  );
  if (hasLinkedIn) return confirmedProfiles;
  return [
    {
      platform: "LinkedIn",
      handle: linkedinHandleFromUrl(url) || "",
      url,
      category: "Professional",
    },
    ...(confirmedProfiles ?? []),
  ];
}
