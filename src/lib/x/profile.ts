import { normalizeXUrl, xHandleFromUrl } from "@/lib/auth/identity";

export interface XProfileStats {
  followers?: string | null;
  following?: string | null;
  posts?: string | null;
}

export interface XTimelineItem {
  url: string;
  id?: string | null;
  tab?: "posts" | "replies";
  position?: number;
  text?: string | null;
  timestamp?: string | null;
  mediaUrls?: string[];
  thumbnailUrl?: string | null;
  primaryPhotoUrl?: string | null;
  externalLinks?: string[];
  replyCount?: string | null;
  repostCount?: string | null;
  quoteCount?: string | null;
  likeCount?: string | null;
  viewCount?: string | null;
  visibleLabels?: string[];
  visibleText?: string | null;
  isReply?: boolean;
  replyContext?: string | null;
}

export type XAccessState =
  | "public_visible"
  | "protected_not_following"
  | "follow_requested"
  | "pending_approval"
  | "approved_visible"
  | "login_required"
  | "checkpoint_required"
  | "rate_limited"
  | "blocked"
  | "not_found"
  | "suspended_or_unavailable";

export interface XAccessInfo {
  state: XAccessState;
  canScrapePosts?: boolean;
  isProtected?: boolean;
  isPrivate?: boolean;
  following?: boolean;
  outgoingRequest?: boolean;
  canRequest?: boolean;
  reason?: string | null;
  evidenceText?: string | null;
  requestedAction?: unknown;
  checkedAt?: string;
  nextCheckAfter?: string | null;
}

export interface XScrapeMeta {
  selectedTabs?: string[];
  targetPostCount?: number;
  extractedCount?: number;
  countsByTab?: { posts?: number; replies?: number };
  scrollPasses?: number;
  reachedItemCap?: boolean;
  postsWithText?: number;
  postsWithMedia?: number;
  postsWithExternalLinks?: number;
  postsWithVisibleCounters?: number;
}

export interface XProfileFull {
  platform: "X";
  username: string;
  handle: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  externalUrl: string | null;
  profileUrl: string;
  location?: string | null;
  joinedDate?: string | null;
  isVerified?: boolean;
  isProtected?: boolean;
  isPrivate?: boolean;
  stats?: XProfileStats;
  timelineItems?: XTimelineItem[];
  access?: XAccessInfo;
  scrapeMeta?: XScrapeMeta;
  visibleProfileText?: string[];
  source: "scraper";
  connectedAt?: string;
}

export function hasXProfile(profile: XProfileFull | null | undefined): profile is XProfileFull {
  if (!profile || profile.platform !== "X" || profile.source !== "scraper") return false;
  if (!profile.username || !normalizeXUrl(profile.profileUrl)) return false;
  return true;
}

/** Minimal "connected" profile from a normalized X URL — no scrape.
 *  Used by the connect handshake; the heavy post archive is built later in
 *  the background deep-scrape pipeline. Returns null if the URL is not a
 *  canonical X profile URL. */
export function buildXHandshakeProfile(normalizedUrl: string): XProfileFull | null {
  const handle = xHandleFromUrl(normalizedUrl);
  if (!handle) return null;
  return {
    platform: "X",
    username: handle,
    handle,
    displayName: null,
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    externalUrl: null,
    profileUrl: normalizedUrl,
    source: "scraper",
    connectedAt: new Date().toISOString(),
  };
}
