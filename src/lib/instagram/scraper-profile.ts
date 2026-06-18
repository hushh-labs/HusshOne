import { instagramHandleFromUrl, normalizeInstagramUrl } from "@/lib/auth/identity";
import type { InstagramAccessInfo, InstagramAccessState, InstagramHighlight, InstagramProfileFull, InstagramPublicPost } from "./profile";

const DEFAULT_TIMEOUT_MS = 120_000;

export class InstagramScraperError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = "instagram_scraper_error",
  ) {
    super(message);
    this.name = "InstagramScraperError";
  }
}

type InstagramScraperTemplate = {
  username?: unknown;
  profileUrl?: unknown;
  displayName?: unknown;
  bio?: unknown;
  avatarUrl?: unknown;
  externalUrl?: unknown;
  isVerified?: unknown;
  isPrivate?: unknown;
  stats?: {
    posts?: unknown;
    followers?: unknown;
    following?: unknown;
  };
  highlights?: unknown;
  recentPublicPosts?: unknown;
  access?: unknown;
  visibleProfileText?: unknown;
};

export type InstagramScraperResult = {
  ok?: boolean;
  profileId?: string;
  profileUrl?: string;
  error?: string;
  type?: string;
  access?: unknown;
  raw?: unknown;
  template?: InstagramScraperTemplate;
};

export type InstagramScraperResponse = {
  ok?: boolean;
  count?: number;
  results?: InstagramScraperResult[];
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

function accessState(value: unknown): InstagramAccessState | null {
  const state = str(value, 80);
  const allowed = new Set<InstagramAccessState>([
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
  return allowed.has(state as InstagramAccessState) ? (state as InstagramAccessState) : null;
}

function mapAccess(value: unknown): InstagramAccessInfo | null {
  const rec = asRecord(value);
  const state = accessState(rec.state);
  if (!state) return null;
  const out: InstagramAccessInfo = { state };
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

function pendingAccessState(state: InstagramAccessState): boolean {
  return state === "private_not_following" || state === "follow_requested" || state === "pending_approval";
}

function mapPosts(value: unknown): InstagramPublicPost[] {
  if (!Array.isArray(value)) return [];
  const out: InstagramPublicPost[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    const url = str(rec.url, 500);
    if (!/^https:\/\/www\.instagram\.com\/(?:p|reel)\//i.test(url)) continue;
    const kind = /\/reel\//i.test(url) ? "reel" : "post";
    const position = Number(rec.position);
    out.push({
      url,
      kind,
      ...(Number.isFinite(position) && position > 0 ? { position: Math.round(position) } : {}),
      caption: strOrNull(rec.caption, 500),
      thumbnailUrl: strOrNull(rec.thumbnailUrl, 1000),
      cdnUrls: Array.isArray(rec.cdnUrls)
        ? rec.cdnUrls.map((item) => str(item, 1000)).filter((item) => /^https?:\/\//i.test(item)).slice(0, 12)
        : undefined,
      alt: strOrNull(rec.alt, 500),
      ariaLabel: strOrNull(rec.ariaLabel, 300),
      isCarousel: rec.isCarousel === true || undefined,
      isVideo: rec.isVideo === true || undefined,
      timestamp: strOrNull(rec.timestamp, 80),
      likes: strOrNull(rec.likes, 40),
      comments: strOrNull(rec.comments, 40),
      visibleText: strOrNull(rec.visibleText, 300),
    });
    if (out.length >= 1024) break;
  }
  return out;
}

function mapHighlights(value: unknown): InstagramHighlight[] {
  if (!Array.isArray(value)) return [];
  const out: InstagramHighlight[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    const title = str(rec.title, 120);
    if (!title) continue;
    out.push({
      title,
      url: strOrNull(rec.url, 500),
      thumbnailUrl: strOrNull(rec.thumbnailUrl, 1000),
    });
    if (out.length >= 24) break;
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

export function mapInstagramResultToProfile(result: InstagramScraperResult): InstagramProfileFull {
  const template = result.template;
  if (!template) {
    throw new InstagramScraperError("Instagram profile data was not returned.", 503, "instagram_profile_unavailable");
  }
  const profileUrl = normalizeInstagramUrl(template.profileUrl) || normalizeInstagramUrl(result.profileUrl) || null;
  const username = str(template.username, 60) || (profileUrl ? instagramHandleFromUrl(profileUrl) : str(result.profileId, 60));
  if (!profileUrl || !username) {
    throw new InstagramScraperError("Instagram profile data was incomplete.", 422, "instagram_profile_incomplete");
  }
  const stats = asRecord(template.stats);
  const profile: InstagramProfileFull = {
    platform: "Instagram",
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
    posts: strOrNull(stats.posts, 40),
    followers: strOrNull(stats.followers, 40),
    following: strOrNull(stats.following, 40),
  };
  if (Object.values(profileStats).some(Boolean)) profile.stats = profileStats;
  const highlights = mapHighlights(template.highlights);
  if (highlights.length) profile.highlights = highlights;
  const posts = mapPosts(template.recentPublicPosts);
  if (posts.length) profile.recentPublicPosts = posts;
  const visibleProfileText = mapVisibleProfileText(template.visibleProfileText);
  if (visibleProfileText.length) profile.visibleProfileText = visibleProfileText;
  return profile;
}

export function mapInstagramResponseToProfile(
  response: InstagramScraperResponse,
  normalizedUrl: string,
): { profile: InstagramProfileFull; raw: InstagramScraperResult } {
  const first = response.results?.[0];
  if (!response.ok || !first?.ok) {
    const error = first?.error || "We could not read this Instagram profile. Check that it is public/visible and try again.";
    const type = first?.type || "instagram_profile_unavailable";
    const text = `${type} ${error}`;
    const status = /private/i.test(text)
      ? 422
      : /notfound|not found/i.test(text)
        ? 404
        : /authwall|login|checkpoint|challenge/i.test(text)
          ? 503
          : 502;
    throw new InstagramScraperError(error, status, type);
  }
  const profile = mapInstagramResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
  return { profile, raw: first };
}

export type InstagramEnrichmentOutcome =
  | { status: "profile"; profile: InstagramProfileFull; raw: InstagramScraperResult; normalizedUrl: string; access?: InstagramAccessInfo | null }
  | {
      status: "access_pending";
      access: InstagramAccessInfo;
      profileSnapshot: InstagramProfileFull | null;
      raw: InstagramScraperResult;
      normalizedUrl: string;
    };

function mapInstagramResponseToOutcome(response: InstagramScraperResponse, normalizedUrl: string): InstagramEnrichmentOutcome {
  const first = response.results?.[0];
  if (!first) {
    throw new InstagramScraperError("Instagram profile data was not returned.", 503, "instagram_profile_unavailable");
  }
  const access = mapAccess(first.access || first.template?.access);
  if (response.ok && first.ok) {
    const profile = mapInstagramResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
    return { status: "profile", profile, raw: first, normalizedUrl, access };
  }
  if (access && pendingAccessState(access.state)) {
    let profileSnapshot: InstagramProfileFull | null = null;
    try {
      profileSnapshot = mapInstagramResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
    } catch {
      profileSnapshot = null;
    }
    return { status: "access_pending", access, profileSnapshot, raw: first, normalizedUrl };
  }
  return { status: "profile", ...mapInstagramResponseToProfile(response, normalizedUrl), normalizedUrl, access };
}

export async function scrapeInstagramProfileUrl(
  inputUrl: unknown,
  opts: { maxPosts?: number } = {},
): Promise<InstagramEnrichmentOutcome> {
  const normalizedUrl = normalizeInstagramUrl(inputUrl);
  if (!normalizedUrl) {
    throw new InstagramScraperError("Provide a valid Instagram profile URL.", 400, "invalid_instagram_url");
  }

  const baseUrl = (process.env.INSTAGRAM_SCRAPER_URL || "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.INSTAGRAM_SCRAPER_API_KEY || "").trim();
  const timeoutMs = Number(process.env.INSTAGRAM_SCRAPER_TIMEOUT_MS || "") || DEFAULT_TIMEOUT_MS;
  if (!baseUrl || !apiKey) {
    throw new InstagramScraperError("Instagram enrichment is not configured.", 503, "instagram_scraper_not_configured");
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
      body: JSON.stringify({ url: normalizedUrl, ...(opts.maxPosts ? { maxPosts: opts.maxPosts } : {}) }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as InstagramScraperResponse | { error?: string } | null;
    if (!res.ok) {
      const upstream = asRecord(data);
      const message =
        typeof upstream.error === "string"
          ? upstream.error
          : "Instagram enrichment service is unavailable. Please try again.";
      throw new InstagramScraperError(message, res.status === 401 ? 503 : res.status, "instagram_scraper_upstream_error");
    }
    return mapInstagramResponseToOutcome(data as InstagramScraperResponse, normalizedUrl);
  } catch (error) {
    if (error instanceof InstagramScraperError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new InstagramScraperError("Instagram enrichment took too long. Please try again.", 504, "instagram_scraper_timeout");
    }
    throw new InstagramScraperError(
      error instanceof Error ? error.message : "Instagram enrichment service is unavailable. Please try again.",
      503,
      "instagram_scraper_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
