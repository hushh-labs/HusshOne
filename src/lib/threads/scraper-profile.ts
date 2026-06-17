import { normalizeThreadsUrl, threadsHandleFromUrl } from "@/lib/auth/identity";
import type { ThreadsAccessInfo, ThreadsAccessState, ThreadsPost, ThreadsProfileFull } from "./profile";

const DEFAULT_TIMEOUT_MS = 120_000;

export class ThreadsScraperError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = "threads_scraper_error",
  ) {
    super(message);
    this.name = "ThreadsScraperError";
  }
}

type ThreadsScraperTemplate = {
  username?: unknown;
  profileUrl?: unknown;
  displayName?: unknown;
  bio?: unknown;
  avatarUrl?: unknown;
  externalUrl?: unknown;
  isVerified?: unknown;
  isPrivate?: unknown;
  stats?: {
    followers?: unknown;
    threads?: unknown;
    following?: unknown;
  };
  recentThreads?: unknown;
  access?: unknown;
  visibleProfileText?: unknown;
};

export type ThreadsScraperResult = {
  ok?: boolean;
  profileId?: string;
  profileUrl?: string;
  error?: string;
  type?: string;
  access?: unknown;
  raw?: unknown;
  template?: ThreadsScraperTemplate;
};

export type ThreadsScraperResponse = {
  ok?: boolean;
  count?: number;
  results?: ThreadsScraperResult[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, max = 300): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strOrNull(value: unknown, max = 300): string | null {
  const s = str(value, max);
  return s || null;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
  }
  return undefined;
}

function accessState(value: unknown): ThreadsAccessState | null {
  const state = str(value, 80);
  const allowed = new Set<ThreadsAccessState>([
    "public_visible",
    "private_not_following",
    "follow_requested",
    "pending_approval",
    "approved_visible",
    "login_required",
    "checkpoint_required",
    "rate_limited",
    "blocked",
    "not_found",
  ]);
  return allowed.has(state as ThreadsAccessState) ? (state as ThreadsAccessState) : null;
}

function mapAccess(value: unknown): ThreadsAccessInfo | null {
  const rec = asRecord(value);
  const state = accessState(rec.state);
  if (!state) return null;
  const out: ThreadsAccessInfo = { state };
  const canScrapePosts = bool(rec.canScrapePosts);
  const isPrivate = bool(rec.isPrivate);
  const following = bool(rec.following);
  const outgoingRequest = bool(rec.outgoingRequest);
  const canRequest = bool(rec.canRequest);
  if (typeof canScrapePosts === "boolean") out.canScrapePosts = canScrapePosts;
  if (typeof isPrivate === "boolean") out.isPrivate = isPrivate;
  if (typeof following === "boolean") out.following = following;
  if (typeof outgoingRequest === "boolean") out.outgoingRequest = outgoingRequest;
  if (typeof canRequest === "boolean") out.canRequest = canRequest;
  out.reason = strOrNull(rec.reason, 300);
  out.evidenceText = strOrNull(rec.evidenceText, 300);
  out.checkedAt = strOrNull(rec.checkedAt, 80) || new Date().toISOString();
  out.nextCheckAfter = strOrNull(rec.nextCheckAfter, 80);
  if (rec.requestedAction) out.requestedAction = rec.requestedAction;
  return out;
}

function pendingAccessState(state: ThreadsAccessState): boolean {
  return state === "private_not_following" || state === "follow_requested" || state === "pending_approval";
}

function mapThreads(value: unknown): ThreadsPost[] {
  if (!Array.isArray(value)) return [];
  const out: ThreadsPost[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    const url = str(rec.url, 500);
    if (!/^https:\/\/www\.threads\.com\/@[^/]+\/post\/[^/]+/i.test(url)) continue;
    const position = Number(rec.position);
    out.push({
      url,
      ...(Number.isFinite(position) && position > 0 ? { position: Math.round(position) } : {}),
      text: strOrNull(rec.text, 1200),
      contentSeed: strOrNull(rec.contentSeed, 1500),
      timestamp: strOrNull(rec.timestamp, 80),
      mediaUrls: Array.isArray(rec.mediaUrls)
        ? rec.mediaUrls.map((item) => str(item, 1000)).filter((item) => /^https?:\/\//i.test(item)).slice(0, 12)
        : undefined,
      thumbnailUrl: strOrNull(rec.thumbnailUrl, 1000),
      feedPhotoUrl: strOrNull(rec.feedPhotoUrl, 1000),
      externalLinks: Array.isArray(rec.externalLinks)
        ? rec.externalLinks.map((item) => str(item, 1000)).filter((item) => /^https?:\/\//i.test(item)).slice(0, 8)
        : undefined,
      replyCount: strOrNull(rec.replyCount, 40),
      repostCount: strOrNull(rec.repostCount, 40),
      likeCount: strOrNull(rec.likeCount, 40),
      quoteCount: strOrNull(rec.quoteCount, 40),
      visibleLabels: Array.isArray(rec.visibleLabels)
        ? rec.visibleLabels.map((item) => str(item, 120)).filter(Boolean).slice(0, 24)
        : undefined,
      visibleText: strOrNull(rec.visibleText, 1200),
    });
    if (out.length >= 1024) break;
  }
  return out;
}

function mapVisibleProfileText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => str(item, 300))
    .filter(Boolean)
    .slice(0, 80);
}

export function mapThreadsResultToProfile(result: ThreadsScraperResult): ThreadsProfileFull {
  const template = result.template;
  if (!template) {
    throw new ThreadsScraperError("Threads profile data was not returned.", 503, "threads_profile_unavailable");
  }
  const profileUrl = normalizeThreadsUrl(template.profileUrl) || normalizeThreadsUrl(result.profileUrl) || null;
  const username = str(template.username, 60) || (profileUrl ? threadsHandleFromUrl(profileUrl) : str(result.profileId, 60));
  if (!profileUrl || !username) {
    throw new ThreadsScraperError("Threads profile data was incomplete.", 422, "threads_profile_incomplete");
  }
  const stats = asRecord(template.stats);
  const profile: ThreadsProfileFull = {
    platform: "Threads",
    username,
    displayName: strOrNull(template.displayName, 120),
    bio: strOrNull(template.bio, 1000),
    avatarUrl: strOrNull(template.avatarUrl, 1000),
    externalUrl: strOrNull(template.externalUrl, 500),
    profileUrl,
    source: "scraper",
    connectedAt: new Date().toISOString(),
  };
  const isVerified = bool(template.isVerified);
  const isPrivate = bool(template.isPrivate);
  if (typeof isVerified === "boolean") profile.isVerified = isVerified;
  if (typeof isPrivate === "boolean") profile.isPrivate = isPrivate;
  const access = mapAccess(result.access || template.access);
  if (access) profile.access = access;
  const profileStats = {
    followers: strOrNull(stats.followers, 40),
    threads: strOrNull(stats.threads, 40),
    following: strOrNull(stats.following, 40),
  };
  if (Object.values(profileStats).some(Boolean)) profile.stats = profileStats;
  const threads = mapThreads(template.recentThreads);
  if (threads.length) profile.recentThreads = threads;
  const visibleProfileText = mapVisibleProfileText(template.visibleProfileText);
  if (visibleProfileText.length) profile.visibleProfileText = visibleProfileText;
  return profile;
}

export function mapThreadsResponseToProfile(
  response: ThreadsScraperResponse,
  normalizedUrl: string,
): { profile: ThreadsProfileFull; raw: ThreadsScraperResult } {
  const first = response.results?.[0];
  if (!response.ok || !first?.ok) {
    const error = first?.error || "We could not read this Threads profile. Check that it is public/visible and try again.";
    const type = first?.type || "threads_profile_unavailable";
    const text = `${type} ${error}`;
    const status = /private/i.test(text)
      ? 422
      : /notfound|not found/i.test(text)
        ? 404
        : /authwall|login|checkpoint|challenge/i.test(text)
          ? 503
          : 502;
    throw new ThreadsScraperError(error, status, type);
  }
  const profile = mapThreadsResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
  return { profile, raw: first };
}

export type ThreadsEnrichmentOutcome =
  | { status: "profile"; profile: ThreadsProfileFull; raw: ThreadsScraperResult; normalizedUrl: string; access?: ThreadsAccessInfo | null }
  | {
      status: "access_pending";
      access: ThreadsAccessInfo;
      profileSnapshot: ThreadsProfileFull | null;
      raw: ThreadsScraperResult;
      normalizedUrl: string;
    };

function mapThreadsResponseToOutcome(response: ThreadsScraperResponse, normalizedUrl: string): ThreadsEnrichmentOutcome {
  const first = response.results?.[0];
  if (!first) {
    throw new ThreadsScraperError("Threads profile data was not returned.", 503, "threads_profile_unavailable");
  }
  const access = mapAccess(first.access || first.template?.access);
  if (response.ok && first.ok) {
    const profile = mapThreadsResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
    return { status: "profile", profile, raw: first, normalizedUrl, access };
  }
  if (access && pendingAccessState(access.state)) {
    let profileSnapshot: ThreadsProfileFull | null = null;
    try {
      profileSnapshot = mapThreadsResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
    } catch {
      profileSnapshot = null;
    }
    return { status: "access_pending", access, profileSnapshot, raw: first, normalizedUrl };
  }
  return { status: "profile", ...mapThreadsResponseToProfile(response, normalizedUrl), normalizedUrl, access };
}

export async function scrapeThreadsProfileUrl(inputUrl: unknown): Promise<ThreadsEnrichmentOutcome> {
  const normalizedUrl = normalizeThreadsUrl(inputUrl);
  if (!normalizedUrl) {
    throw new ThreadsScraperError("Provide a valid Threads profile URL.", 400, "invalid_threads_url");
  }

  const baseUrl = (process.env.THREADS_SCRAPER_URL || "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.THREADS_SCRAPER_API_KEY || "").trim();
  const timeoutMs = Number(process.env.THREADS_SCRAPER_TIMEOUT_MS || "") || DEFAULT_TIMEOUT_MS;
  if (!baseUrl || !apiKey) {
    throw new ThreadsScraperError("Threads enrichment is not configured.", 503, "threads_scraper_not_configured");
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
    const data = (await res.json().catch(() => null)) as ThreadsScraperResponse | { error?: string } | null;
    if (!res.ok) {
      const upstream = asRecord(data);
      const message =
        typeof upstream.error === "string"
          ? upstream.error
          : "Threads enrichment service is unavailable. Please try again.";
      throw new ThreadsScraperError(message, res.status === 401 ? 503 : res.status, "threads_scraper_upstream_error");
    }
    return mapThreadsResponseToOutcome(data as ThreadsScraperResponse, normalizedUrl);
  } catch (error) {
    if (error instanceof ThreadsScraperError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new ThreadsScraperError("Threads enrichment took too long. Please try again.", 504, "threads_scraper_timeout");
    }
    throw new ThreadsScraperError(
      error instanceof Error ? error.message : "Threads enrichment service is unavailable. Please try again.",
      503,
      "threads_scraper_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
