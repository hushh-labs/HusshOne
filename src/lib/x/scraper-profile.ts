import { normalizeXUrl, xHandleFromUrl } from "@/lib/auth/identity";
import type { XAccessInfo, XAccessState, XProfileFull, XScrapeMeta, XTimelineItem } from "./profile";

const DEFAULT_TIMEOUT_MS = 120_000;

export class XScraperError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = "x_scraper_error",
  ) {
    super(message);
    this.name = "XScraperError";
  }
}

type XScraperTemplate = {
  username?: unknown;
  handle?: unknown;
  profileUrl?: unknown;
  displayName?: unknown;
  bio?: unknown;
  avatarUrl?: unknown;
  bannerUrl?: unknown;
  externalUrl?: unknown;
  location?: unknown;
  joinedDate?: unknown;
  isVerified?: unknown;
  isProtected?: unknown;
  isPrivate?: unknown;
  stats?: {
    followers?: unknown;
    following?: unknown;
    posts?: unknown;
  };
  timelineItems?: unknown;
  recentPosts?: unknown;
  access?: unknown;
  scrapeMeta?: unknown;
  visibleProfileText?: unknown;
};

export type XScraperResult = {
  ok?: boolean;
  profileId?: string;
  profileUrl?: string;
  error?: string;
  type?: string;
  access?: unknown;
  raw?: unknown;
  template?: XScraperTemplate;
};

export type XScraperResponse = {
  ok?: boolean;
  count?: number;
  results?: XScraperResult[];
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

function accessState(value: unknown): XAccessState | null {
  const state = str(value, 80);
  const allowed = new Set<XAccessState>([
    "public_visible",
    "protected_not_following",
    "follow_requested",
    "pending_approval",
    "approved_visible",
    "login_required",
    "checkpoint_required",
    "rate_limited",
    "blocked",
    "not_found",
    "suspended_or_unavailable",
  ]);
  return allowed.has(state as XAccessState) ? (state as XAccessState) : null;
}

function mapAccess(value: unknown): XAccessInfo | null {
  const rec = asRecord(value);
  const state = accessState(rec.state);
  if (!state) return null;
  const out: XAccessInfo = { state };
  const canScrapePosts = bool(rec.canScrapePosts);
  const isProtected = bool(rec.isProtected);
  const isPrivate = bool(rec.isPrivate);
  const following = bool(rec.following);
  const outgoingRequest = bool(rec.outgoingRequest);
  const canRequest = bool(rec.canRequest);
  if (typeof canScrapePosts === "boolean") out.canScrapePosts = canScrapePosts;
  if (typeof isProtected === "boolean") out.isProtected = isProtected;
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

function pendingAccessState(state: XAccessState): boolean {
  return state === "protected_not_following" || state === "follow_requested" || state === "pending_approval";
}

function mapTimelineItems(value: unknown): XTimelineItem[] {
  if (!Array.isArray(value)) return [];
  const out: XTimelineItem[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    const url = str(rec.url, 500) || str(rec.postUrl, 500);
    if (!/^https:\/\/x\.com\/[^/]+\/status\/\d+/i.test(url)) continue;
    const position = Number(rec.position);
    const rawTab = str(rec.tab, 30).toLowerCase();
    out.push({
      url,
      id: strOrNull(rec.id ?? rec.postId ?? rec.tweetId, 80),
      tab: rawTab === "replies" ? "replies" : "posts",
      ...(Number.isFinite(position) && position > 0 ? { position: Math.round(position) } : {}),
      text: strOrNull(rec.text, 2000),
      timestamp: strOrNull(rec.timestamp, 80),
      mediaUrls: Array.isArray(rec.mediaUrls)
        ? rec.mediaUrls.map((entry) => str(entry, 1000)).filter((entry) => /^https?:\/\//i.test(entry)).slice(0, 12)
        : undefined,
      thumbnailUrl: strOrNull(rec.thumbnailUrl, 1000),
      primaryPhotoUrl: strOrNull(rec.primaryPhotoUrl ?? rec.feedPhotoUrl, 1000),
      externalLinks: Array.isArray(rec.externalLinks)
        ? rec.externalLinks.map((entry) => str(entry, 1000)).filter((entry) => /^https?:\/\//i.test(entry)).slice(0, 8)
        : undefined,
      replyCount: strOrNull(rec.replyCount, 40),
      repostCount: strOrNull(rec.repostCount, 40),
      quoteCount: strOrNull(rec.quoteCount, 40),
      likeCount: strOrNull(rec.likeCount, 40),
      viewCount: strOrNull(rec.viewCount, 40),
      visibleLabels: Array.isArray(rec.visibleLabels)
        ? rec.visibleLabels.map((entry) => str(entry, 120)).filter(Boolean).slice(0, 24)
        : undefined,
      visibleText: strOrNull(rec.visibleText, 2000),
      isReply: rec.isReply === true || rawTab === "replies" || undefined,
      replyContext: strOrNull(rec.replyContext, 500),
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
    .slice(0, 120);
}

function mapScrapeMeta(value: unknown): XScrapeMeta | undefined {
  const rec = asRecord(value);
  if (!Object.keys(rec).length) return undefined;
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  };
  const counts = asRecord(rec.countsByTab);
  return {
    selectedTabs: Array.isArray(rec.selectedTabs) ? rec.selectedTabs.map((entry) => str(entry, 40)).filter(Boolean).slice(0, 4) : undefined,
    targetPostCount: num(rec.targetPostCount),
    extractedCount: num(rec.extractedCount),
    countsByTab: Object.keys(counts).length
      ? { posts: num(counts.posts), replies: num(counts.replies) }
      : undefined,
    scrollPasses: num(rec.scrollPasses),
    reachedItemCap: rec.reachedItemCap === true || undefined,
    postsWithText: num(rec.postsWithText),
    postsWithMedia: num(rec.postsWithMedia),
    postsWithExternalLinks: num(rec.postsWithExternalLinks),
    postsWithVisibleCounters: num(rec.postsWithVisibleCounters),
  };
}

export function mapXResultToProfile(result: XScraperResult): XProfileFull {
  const template = result.template;
  if (!template) {
    throw new XScraperError("X profile data was not returned.", 503, "x_profile_unavailable");
  }
  const profileUrl = normalizeXUrl(template.profileUrl) || normalizeXUrl(result.profileUrl) || null;
  const username = str(template.username, 60) || str(template.handle, 60) || (profileUrl ? xHandleFromUrl(profileUrl) : str(result.profileId, 60));
  if (!profileUrl || !username) {
    throw new XScraperError("X profile data was incomplete.", 422, "x_profile_incomplete");
  }
  const stats = asRecord(template.stats);
  const timelineItems = mapTimelineItems(template.timelineItems || template.recentPosts);
  const profile: XProfileFull = {
    platform: "X",
    username,
    handle: username,
    displayName: strOrNull(template.displayName, 120),
    bio: strOrNull(template.bio, 1000),
    avatarUrl: strOrNull(template.avatarUrl, 1000),
    bannerUrl: strOrNull(template.bannerUrl, 1000),
    externalUrl: strOrNull(template.externalUrl, 500),
    profileUrl,
    source: "scraper",
    connectedAt: new Date().toISOString(),
  };
  const location = strOrNull(template.location, 160);
  const joinedDate = strOrNull(template.joinedDate, 80);
  if (location) profile.location = location;
  if (joinedDate) profile.joinedDate = joinedDate;
  const isVerified = bool(template.isVerified);
  const isProtected = bool(template.isProtected);
  const isPrivate = bool(template.isPrivate);
  if (typeof isVerified === "boolean") profile.isVerified = isVerified;
  if (typeof isProtected === "boolean") profile.isProtected = isProtected;
  if (typeof isPrivate === "boolean") profile.isPrivate = isPrivate;
  const access = mapAccess(result.access || template.access);
  if (access) profile.access = access;
  const profileStats = {
    followers: strOrNull(stats.followers, 40),
    following: strOrNull(stats.following, 40),
    posts: strOrNull(stats.posts, 40),
  };
  if (Object.values(profileStats).some(Boolean)) profile.stats = profileStats;
  if (timelineItems.length) profile.timelineItems = timelineItems;
  const visibleProfileText = mapVisibleProfileText(template.visibleProfileText);
  if (visibleProfileText.length) profile.visibleProfileText = visibleProfileText;
  const scrapeMeta = mapScrapeMeta(template.scrapeMeta);
  if (scrapeMeta) profile.scrapeMeta = scrapeMeta;
  return profile;
}

export function mapXResponseToProfile(
  response: XScraperResponse,
  normalizedUrl: string,
): { profile: XProfileFull; raw: XScraperResult } {
  const first = response.results?.[0];
  if (!response.ok || !first?.ok) {
    const error = first?.error || "We could not read this X profile. Check that it is public/visible and try again.";
    const type = first?.type || "x_profile_unavailable";
    const text = `${type} ${error}`;
    const status = /protected|private/i.test(text)
      ? 422
      : /notfound|not found/i.test(text)
        ? 404
        : /authwall|login|checkpoint|challenge/i.test(text)
          ? 503
          : /rate/i.test(text)
            ? 429
            : 502;
    throw new XScraperError(error, status, type);
  }
  const profile = mapXResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
  return { profile, raw: first };
}

export type XEnrichmentOutcome =
  | { status: "profile"; profile: XProfileFull; raw: XScraperResult; normalizedUrl: string; access?: XAccessInfo | null }
  | {
      status: "access_pending";
      access: XAccessInfo;
      profileSnapshot: XProfileFull | null;
      raw: XScraperResult;
      normalizedUrl: string;
    };

function mapXResponseToOutcome(response: XScraperResponse, normalizedUrl: string): XEnrichmentOutcome {
  const first = response.results?.[0];
  if (!first) {
    throw new XScraperError("X profile data was not returned.", 503, "x_profile_unavailable");
  }
  const access = mapAccess(first.access || first.template?.access);
  if (response.ok && first.ok) {
    const profile = mapXResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
    return { status: "profile", profile, raw: first, normalizedUrl, access };
  }
  if (access && pendingAccessState(access.state)) {
    let profileSnapshot: XProfileFull | null = null;
    try {
      profileSnapshot = mapXResultToProfile({ ...first, profileUrl: first.profileUrl || normalizedUrl });
    } catch {
      profileSnapshot = null;
    }
    return { status: "access_pending", access, profileSnapshot, raw: first, normalizedUrl };
  }
  return { status: "profile", ...mapXResponseToProfile(response, normalizedUrl), normalizedUrl, access };
}

export async function scrapeXProfileUrl(inputUrl: unknown, opts: { maxPosts?: number } = {}): Promise<XEnrichmentOutcome> {
  const normalizedUrl = normalizeXUrl(inputUrl);
  if (!normalizedUrl) {
    throw new XScraperError("Provide a valid X profile URL.", 400, "invalid_x_url");
  }

  const baseUrl = (process.env.TWITTER_SCRAPER_URL || process.env.X_SCRAPER_URL || "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.TWITTER_SCRAPER_API_KEY || process.env.X_SCRAPER_API_KEY || "").trim();
  const timeoutMs = Number(process.env.TWITTER_SCRAPER_TIMEOUT_MS || process.env.X_SCRAPER_TIMEOUT_MS || "") || DEFAULT_TIMEOUT_MS;
  if (!baseUrl || !apiKey) {
    throw new XScraperError("X enrichment is not configured.", 503, "x_scraper_not_configured");
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
      body: JSON.stringify({ url: normalizedUrl, maxPosts: opts.maxPosts ?? (Number(process.env.X_PROMPT_POST_LIMIT || "300") || 300) }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as XScraperResponse | { error?: string } | null;
    if (!res.ok) {
      const upstream = asRecord(data);
      const message =
        typeof upstream.error === "string"
          ? upstream.error
          : "X enrichment service is unavailable. Please try again.";
      throw new XScraperError(message, res.status === 401 ? 503 : res.status, "x_scraper_upstream_error");
    }
    return mapXResponseToOutcome(data as XScraperResponse, normalizedUrl);
  } catch (error) {
    if (error instanceof XScraperError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new XScraperError("X enrichment took too long. Please try again.", 504, "x_scraper_timeout");
    }
    throw new XScraperError(
      error instanceof Error ? error.message : "X enrichment service is unavailable. Please try again.",
      503,
      "x_scraper_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
