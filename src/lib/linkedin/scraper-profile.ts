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
// A RICH profile (full career/education/skills across detail pages) takes ~60s to read, so 90s gives margin
// without the old 180s that let slow/hung scrapes pile up and OOM the single-Chrome VM. Past this we fall
// back to a degraded handshake (resilient connect). Env LINKEDIN_SCRAPER_TIMEOUT_MS overrides.
const DEFAULT_TIMEOUT_MS = 90_000;

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
  grade?: unknown;
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
  if (isJunkLabel(headline)) return null;
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
const LINKEDIN_UI_LINES = new Set(["linkedin helped me get this job", "helped me get this job"]);
const EMPLOYMENT_TYPES = new Set([
  "full-time",
  "part-time",
  "self-employed",
  "freelance",
  "contract",
  "internship",
  "apprenticeship",
  "seasonal",
  "temporary",
]);

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

function cleanTextBlock(value: unknown, max = 1000): string {
  if (typeof value !== "string") return "";
  let lines = value
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const sidebarIdx = lines.findIndex((line) => SIDEBAR_RE.test(line));
  if (sidebarIdx >= 0) lines = lines.slice(0, sidebarIdx);
  const text = lines
    .filter((line) => {
      const lower = line.toLowerCase();
      return !BUTTON_TEXT.has(lower) && !LINKEDIN_UI_LINES.has(lower) && !isConnectionDegree(line);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s*(?:…|\\.\\.\\.)\s*more\s*$/i, "")
    .trim();
  return text.slice(0, max);
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

function isEmploymentType(value: string): boolean {
  return EMPLOYMENT_TYPES.has(value.trim().toLowerCase());
}

function isDateRangeLike(value: string): boolean {
  const v = value.trim();
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{4}|present|current)\b/i.test(v) && /[-–]|present|current/i.test(v);
}

function looksLikeCompanyOnly(value: string): boolean {
  return /\b(?:inc|llc|ltd|limited|technologies|systems|university|institute|college|school|cafe|capital|group)\b|\.ai|\.io|\.com/i.test(value);
}

function cleanCompanyParts(value: unknown): { company: string; employmentType?: string; dateRange?: string } {
  const raw = str(value, 180);
  if (!raw || isJunkLabel(raw)) return { company: "" };
  const parts = raw.split(/\s+·\s+/).map((part) => part.trim()).filter(Boolean);
  let company = parts[0] || "";
  let employmentType = parts.find(isEmploymentType);
  let dateRange = "";
  if (isEmploymentType(company)) {
    employmentType = company;
    company = "";
  } else if (isDateRangeLike(company)) {
    dateRange = company;
    company = "";
  }
  if (company && isJunkLabel(company)) company = "";
  return { company: company.slice(0, 160), employmentType, dateRange };
}

function cleanAbout(value: unknown): string | null {
  return cleanTextBlock(value, 2000) || null;
}

function cleanDescription(value: unknown): string | undefined {
  return cleanTextBlock(value, 1000) || undefined;
}

function mapExperiences(value: unknown): LinkedInExperience[] {
  const out: LinkedInExperience[] = [];
  for (const item of asArray<ScraperExperience>(value)) {
    const rec = asRecord(item);
    let title = str(rec.title, 160);
    const rawCompany = str(rec.company, 180);
    // Drop "More profiles for you" sidebar people — they arrive as title=<name>,
    // company="· 3rd" (a connection-degree token), and would otherwise become fake jobs.
    if (isJunkLabel(title) || isJunkLabel(rawCompany)) continue;
    const companyParts = cleanCompanyParts(rec.company);
    let company = companyParts.company;
    if (!company && companyParts.employmentType && looksLikeCompanyOnly(title)) {
      company = title;
      title = "";
    }
    if (!title && !company) continue;
    const dates = parseDateRange(rec.dateRange || companyParts.dateRange);
    const experience: LinkedInExperience = { title, company };
    if (companyParts.employmentType) experience.employmentType = companyParts.employmentType;
    const location = str(rec.location, 120);
    const description = cleanDescription(rec.description);
    if (location) experience.location = location;
    if (dates.startDate) experience.startDate = dates.startDate;
    if (dates.endDate) experience.endDate = dates.endDate;
    if (dates.current) experience.current = true;
    if (description) experience.description = description;
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
    const grade = str(rec.grade, 80);
    const description = cleanDescription(rec.description);
    if (degree) education.degree = degree;
    if (field) education.field = field;
    if (dates.startDate) education.startDate = dates.startDate;
    if (dates.endDate) education.endDate = dates.endDate;
    if (grade) education.grade = grade;
    if (description) education.description = description;
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

function staffValue(staff: Record<string, unknown>, key: string, max = 300): string {
  return str(staff[key], max);
}

function mapStaffExperiences(staff: Record<string, unknown>): LinkedInExperience[] {
  const out: LinkedInExperience[] = [];
  const currentCompany = cleanCompanyParts(staff.company);
  const currentTitle = cleanHeadline(staff.position) || "";
  if (currentTitle || currentCompany.company) {
    const current: LinkedInExperience = { title: currentTitle, company: currentCompany.company };
    if (currentCompany.employmentType) current.employmentType = currentCompany.employmentType;
    if (currentCompany.company) current.current = true;
    out.push(current);
  }
  for (let i = 1; i <= 5; i += 1) {
    const parts = cleanCompanyParts(staff[`past_company${i}`]);
    if (!parts.company) continue;
    const exp: LinkedInExperience = { title: "", company: parts.company };
    if (parts.employmentType) exp.employmentType = parts.employmentType;
    out.push(exp);
  }
  return out;
}

function mapStaffEducation(staff: Record<string, unknown>): LinkedInEducation[] {
  const out: LinkedInEducation[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const school = staffValue(staff, `school${i}`, 160);
    if (!school || isJunkLabel(school)) continue;
    const education: LinkedInEducation = { school };
    const degree = staffValue(staff, `degree${i}`, 120);
    if (degree && !isJunkLabel(degree)) education.degree = degree;
    out.push(education);
  }
  return out;
}

function mapStaffSkills(staff: Record<string, unknown>): string[] {
  const skills: string[] = [];
  for (let i = 1; i <= 20; i += 1) {
    const raw = staffValue(staff, `skill${i}`, 120);
    if (SIDEBAR_RE.test(raw)) break;
    const skill = cleanSkill(raw);
    if (!skill || isJunkLabel(skill)) continue;
    skills.push(skill);
  }
  return skills;
}

function mergeByKey<T>(primary: T[], fallback: T[], key: (item: T) => string): T[] {
  const out = [...primary];
  const seen = new Set(primary.map((item) => key(item)).filter(Boolean));
  for (const item of fallback) {
    const k = key(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function deriveHeadline(headline: string | null, experiences: LinkedInExperience[]): string | null {
  if (headline) return headline;
  const role = experiences.find((exp) => exp.current) ?? experiences[0];
  if (!role) return null;
  if (role.title && role.company) return `${role.title} at ${role.company}`;
  return role.title || (role.company ? `Current at ${role.company}` : null);
}

function boolOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
  }
  return undefined;
}

function profileStats(staff: Record<string, unknown>): LinkedInProfileFull["profileStats"] | undefined {
  const stats: NonNullable<LinkedInProfileFull["profileStats"]> = {};
  const followers = staffValue(staff, "followers", 80);
  const connections = staffValue(staff, "connections", 80);
  const isConnection = boolOrUndefined(staff.is_connection);
  const premium = boolOrUndefined(staff.premium);
  const creator = boolOrUndefined(staff.creator);
  if (followers) stats.followers = followers;
  if (connections) stats.connections = connections;
  if (typeof isConnection === "boolean") stats.isConnection = isConnection;
  if (typeof premium === "boolean") stats.premium = premium;
  if (typeof creator === "boolean") stats.creator = creator;
  return Object.keys(stats).length ? stats : undefined;
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
  const staff = asRecord(result.templates?.staffSpyStyle);
  const profileUrl =
    normalizeLinkedInUrl(userProfile.url) || normalizeLinkedInUrl(staff.profile_link) || normalizeLinkedInUrl(result.profileUrl) || null;
  const staffName = [staffValue(staff, "first_name", 80), staffValue(staff, "last_name", 80)].filter(Boolean).join(" ");
  const fullName = normalizeName(str(userProfile.fullName, 160) || staffValue(staff, "name", 160) || staffName);
  const split = splitName(fullName);
  const givenName = split.givenName || staffValue(staff, "first_name", 80);
  const familyName = split.familyName || staffValue(staff, "last_name", 80);
  const email = normalizeEmail(verifiedEmail);
  const handle = profileUrl ? linkedinHandleFromUrl(profileUrl) : str(result.profileId, 120);
  const primaryExperience = mapExperiences(template.experiences);
  const experience = mergeByKey(
    primaryExperience,
    primaryExperience.length ? [] : mapStaffExperiences(staff),
    (item) => `${item.title.toLowerCase()}|${item.company.toLowerCase()}|${item.startDate || ""}`,
  ).slice(0, 25);
  const education = mergeByKey(
    mapEducation(template.education),
    mapStaffEducation(staff),
    (item) => `${item.school.toLowerCase()}|${(item.degree || "").toLowerCase()}`,
  ).slice(0, 15);
  const skills = mergeByKey(mapSkills(template.skills), mapStaffSkills(staff), (item) => item.toLowerCase()).slice(0, 50);
  const headline = deriveHeadline(cleanHeadline(userProfile.title) || cleanHeadline(staff.position), experience);
  const stats = profileStats(staff);

  return {
    sub: handle || profileUrl || "linkedin-scraper",
    name: fullName,
    givenName,
    familyName,
    email: email || null,
    emailVerified: false,
    locale: null,
    pictureUrl: strOrNull(userProfile.photo, 1000) || strOrNull(staff.profile_photo, 1000),
    profileUrl,
    headline,
    location: strOrNull(userProfile.location, 160) || strOrNull(staff.location, 160),
    about: cleanAbout(userProfile.description) || cleanAbout(staff.bio),
    verifications: [],
    grantedScopes: ["scraper:linkedin-profile-url"],
    source: "scraper",
    experience,
    education,
    skills,
    certifications: mapCertifications(template.certifications),
    ...(stats ? { profileStats: stats } : {}),
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
