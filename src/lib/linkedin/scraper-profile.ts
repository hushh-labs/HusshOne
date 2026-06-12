import {
  linkedinHandleFromUrl,
  normalizeEmail,
  normalizeLinkedInUrl,
  normalizeName,
} from "@/lib/auth/identity";
import type {
  LinkedInCertification,
  LinkedInEducation,
  LinkedInExperience,
  LinkedInProfileFull,
} from "./profile";

const DEFAULT_SCRAPER_URL = "http://136.114.82.27:8080";
const DEFAULT_TIMEOUT_MS = 180_000;

export class LinkedInScraperError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = "linkedin_scraper_error",
  ) {
    super(message);
    this.name = "LinkedInScraperError";
  }
}

type ScraperUserProfile = {
  fullName?: unknown;
  title?: unknown;
  location?: unknown;
  photo?: unknown;
  description?: unknown;
  url?: unknown;
};

type ScraperExperience = {
  title?: unknown;
  company?: unknown;
  dateRange?: unknown;
  location?: unknown;
  description?: unknown;
};

type ScraperEducation = {
  schoolName?: unknown;
  degreeName?: unknown;
  fieldOfStudy?: unknown;
  dateRange?: unknown;
  description?: unknown;
};

type ScraperSkill = {
  skillName?: unknown;
  name?: unknown;
};

type LinkedInProfileScraperTemplate = {
  userProfile?: ScraperUserProfile;
  experiences?: ScraperExperience[];
  education?: ScraperEducation[];
  volunteerExperiences?: unknown[];
  skills?: ScraperSkill[];
  certifications?: unknown[];
};

export type LinkedInScraperResult = {
  ok?: boolean;
  profileId?: string;
  profileUrl?: string;
  error?: string;
  type?: string;
  templates?: {
    linkedinProfileScraper?: LinkedInProfileScraperTemplate;
    staffSpyStyle?: unknown;
  };
};

export type LinkedInScraperResponse = {
  ok?: boolean;
  count?: number;
  results?: LinkedInScraperResult[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function str(value: unknown, max = 300): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strOrNull(value: unknown, max = 300): string | null {
  const s = str(value, max);
  return s || null;
}

function splitName(fullName: string) {
  const parts = normalizeName(fullName).split(" ").filter(Boolean);
  return {
    givenName: parts[0] || "",
    familyName: parts.length > 1 ? parts.slice(1).join(" ") : "",
  };
}

function cleanHeadline(value: unknown): string | null {
  const headline = str(value, 300);
  if (!headline) return null;
  if (/^(?:·\s*)?\d+(st|nd|rd|th)\+?$/i.test(headline)) return null;
  return headline;
}

function cleanSkill(value: unknown): string {
  const name = typeof value === "string" ? str(value, 80) : str(asRecord(value).skillName ?? asRecord(value).name, 80);
  if (!name) return "";
  if (/^\d+\s+endorsements?$/i.test(name)) return "";
  return name;
}

const SIDEBAR_RE = /more profiles for you/i;
const BUTTON_TEXT = new Set(["message", "follow", "following", "connect", "show more", "show all", "see more"]);

/** "· 3rd", "2nd+", "3rd" — a LinkedIn connection-degree marker, never a real job/skill. */
function isConnectionDegree(value: string): boolean {
  return /^(?:·\s*)?\d+(?:st|nd|rd|th)\+?$/i.test(value.trim());
}

/** Sidebar / UI junk that LinkedIn's "More profiles for you" rail leaks into the arrays. */
function isJunkLabel(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return isConnectionDegree(v) || BUTTON_TEXT.has(v.toLowerCase()) || SIDEBAR_RE.test(v);
}

/** The "More profiles for you" rail is always appended AFTER the real rows — cut there. */
function cutAtSidebar<T>(items: T[], text: (item: T) => string): T[] {
  const idx = items.findIndex((it) => SIDEBAR_RE.test(text(it)));
  return idx >= 0 ? items.slice(0, idx) : items;
}

function parseDateRange(value: unknown): { startDate?: string; endDate?: string; current?: boolean } {
  const range = str(value, 120);
  if (!range) return {};
  const compact = range.split("·")[0]?.trim() || range;
  const parts = compact.split(/\s[-–]\s/).map((p) => p.trim()).filter(Boolean);
  const startDate = parts[0] || undefined;
  const rawEnd = parts[1] || "";
  const current = /present|current/i.test(rawEnd);
  return {
    startDate,
    endDate: rawEnd && !current ? rawEnd : undefined,
    current: current || undefined,
  };
}

function cleanCompany(value: unknown): string {
  return str(value, 160).split(/\s+·\s+/)[0]?.trim() || "";
}

function mapExperiences(value: unknown): LinkedInExperience[] {
  const out: LinkedInExperience[] = [];
  for (const item of asArray<ScraperExperience>(value)) {
    const rec = asRecord(item);
    const title = str(rec.title, 160);
    const rawCompany = str(rec.company, 160);
    // Drop "More profiles for you" sidebar people — they arrive as title=<name>,
    // company="· 3rd" (a connection-degree token), and would otherwise become fake jobs.
    if (isJunkLabel(title) || isJunkLabel(rawCompany)) continue;
    const company = cleanCompany(rec.company);
    if (!title && !company) continue;
    const dates = parseDateRange(rec.dateRange);
    const experience: LinkedInExperience = { title, company };
    const location = str(rec.location, 120);
    if (location) experience.location = location;
    if (dates.startDate) experience.startDate = dates.startDate;
    if (dates.endDate) experience.endDate = dates.endDate;
    if (dates.current) experience.current = true;
    out.push(experience);
    if (out.length >= 25) break;
  }
  return out;
}

function mapEducation(value: unknown): LinkedInEducation[] {
  const out: LinkedInEducation[] = [];
  const seen = new Set<string>();
  for (const item of asArray<ScraperEducation>(value)) {
    const rec = asRecord(item);
    const school = str(rec.schoolName, 160);
    if (!school || isJunkLabel(school)) continue;
    const dates = parseDateRange(rec.dateRange);
    // De-dupe (the scraper repeats a school whose description carries the sidebar dump).
    const key = `${school.toLowerCase()}|${dates.startDate || ""}|${dates.endDate || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const education: LinkedInEducation = { school };
    const degree = str(rec.degreeName, 120);
    const field = str(rec.fieldOfStudy, 120);
    if (degree) education.degree = degree;
    if (field) education.field = field;
    if (dates.startDate) education.startDate = dates.startDate;
    if (dates.endDate) education.endDate = dates.endDate;
    out.push(education);
    if (out.length >= 15) break;
  }
  return out;
}

function mapSkills(value: unknown): string[] {
  const out: string[] = [];
  // Cut the "More profiles for you" rail (people + their headlines) that trails the skills.
  const items = cutAtSidebar(asArray<ScraperSkill | string>(value), (it) =>
    typeof it === "string" ? it : str(asRecord(it).skillName ?? asRecord(it).name, 80),
  );
  for (const item of items) {
    const name = cleanSkill(item);
    if (!name || isJunkLabel(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

function mapCertifications(value: unknown): LinkedInCertification[] {
  return asArray(value)
    .map((item) => {
      if (typeof item === "string") return item.trim() ? { name: item.trim().slice(0, 160) } : null;
      const rec = asRecord(item);
      const name = str(rec.name ?? rec.title ?? rec.certification, 160);
      if (!name) return null;
      return {
        name,
        authority: str(rec.authority ?? rec.issuer ?? rec.organization, 120) || undefined,
        date: str(rec.date ?? rec.issued ?? rec.issueDate, 40) || undefined,
      } satisfies LinkedInCertification;
    })
    .filter((item): item is LinkedInCertification => Boolean(item))
    .slice(0, 25);
}

export function mapScraperResultToLinkedInProfile(
  result: LinkedInScraperResult,
  verifiedEmail?: string | null,
): LinkedInProfileFull {
  const template = result.templates?.linkedinProfileScraper;
  if (!template) {
    throw new LinkedInScraperError("LinkedIn profile data was not returned.", 503, "linkedin_profile_unavailable");
  }

  const userProfile = asRecord(template.userProfile);
  const profileUrl = normalizeLinkedInUrl(userProfile.url) || normalizeLinkedInUrl(result.profileUrl) || null;
  const fullName = normalizeName(str(userProfile.fullName, 160));
  const { givenName, familyName } = splitName(fullName);
  const email = normalizeEmail(verifiedEmail);
  const handle = profileUrl ? linkedinHandleFromUrl(profileUrl) : str(result.profileId, 120);

  return {
    sub: handle || profileUrl || "linkedin-scraper",
    name: fullName,
    givenName,
    familyName,
    email: email || null,
    emailVerified: false,
    locale: null,
    pictureUrl: strOrNull(userProfile.photo, 1000),
    profileUrl,
    headline: cleanHeadline(userProfile.title),
    location: strOrNull(userProfile.location, 160),
    about: strOrNull(userProfile.description, 2000),
    verifications: [],
    grantedScopes: ["scraper:linkedin-profile-url"],
    source: "scraper",
    experience: mapExperiences(template.experiences),
    education: mapEducation(template.education),
    skills: mapSkills(template.skills),
    certifications: mapCertifications(template.certifications),
  };
}

export function mapScraperResponseToLinkedInProfile(
  response: LinkedInScraperResponse,
  normalizedUrl: string,
  verifiedEmail?: string | null,
): { profile: LinkedInProfileFull; raw: LinkedInScraperResult } {
  const first = response.results?.[0];
  if (!response.ok || !first?.ok) {
    const error = first?.error || "We could not read this profile. Check that the URL is public/visible and try again.";
    const type = first?.type || "linkedin_profile_unavailable";
    const status = /authwall|login|checkpoint|session/i.test(`${type} ${error}`) ? 503 : 502;
    throw new LinkedInScraperError(error, status, type);
  }
  const profile = mapScraperResultToLinkedInProfile(
    { ...first, profileUrl: first.profileUrl || normalizedUrl },
    verifiedEmail,
  );
  return { profile, raw: first };
}

export async function scrapeLinkedInProfileUrl(
  inputUrl: unknown,
  verifiedEmail?: string | null,
): Promise<{ profile: LinkedInProfileFull; raw: LinkedInScraperResult; normalizedUrl: string }> {
  const normalizedUrl = normalizeLinkedInUrl(inputUrl);
  if (!normalizedUrl) {
    throw new LinkedInScraperError("Provide a valid LinkedIn personal profile URL.", 400, "invalid_linkedin_url");
  }

  const baseUrl = (process.env.LINKEDIN_SCRAPER_URL || DEFAULT_SCRAPER_URL).trim().replace(/\/+$/, "");
  const apiKey = (process.env.LINKEDIN_SCRAPER_API_KEY || "").trim();
  const timeoutMs = Number(process.env.LINKEDIN_SCRAPER_TIMEOUT_MS || "") || DEFAULT_TIMEOUT_MS;
  if (!apiKey) {
    throw new LinkedInScraperError("LinkedIn enrichment is not configured.", 503, "linkedin_scraper_not_configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: normalizedUrl }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as LinkedInScraperResponse | { error?: string } | null;
    if (!res.ok) {
      const upstream = asRecord(data);
      const message =
        typeof upstream.error === "string"
          ? upstream.error
          : "LinkedIn enrichment service is unavailable. Please try again.";
      throw new LinkedInScraperError(message, res.status === 401 ? 503 : res.status, "linkedin_scraper_upstream_error");
    }
    const mapped = mapScraperResponseToLinkedInProfile(data as LinkedInScraperResponse, normalizedUrl, verifiedEmail);
    return { ...mapped, normalizedUrl };
  } catch (error) {
    if (error instanceof LinkedInScraperError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new LinkedInScraperError("LinkedIn enrichment took too long. Please try again.", 504, "linkedin_scraper_timeout");
    }
    throw new LinkedInScraperError(
      error instanceof Error ? error.message : "LinkedIn enrichment service is unavailable. Please try again.",
      503,
      "linkedin_scraper_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
