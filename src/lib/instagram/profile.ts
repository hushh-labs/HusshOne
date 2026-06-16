import { normalizeInstagramUrl } from "@/lib/auth/identity";

export interface InstagramProfileStats {
  posts?: string | null;
  followers?: string | null;
  following?: string | null;
}

export interface InstagramPublicPost {
  url: string;
  kind?: "post" | "reel";
  position?: number;
  caption?: string | null;
  thumbnailUrl?: string | null;
  cdnUrls?: string[];
  alt?: string | null;
  ariaLabel?: string | null;
  isCarousel?: boolean;
  isVideo?: boolean;
  timestamp?: string | null;
  likes?: string | null;
  comments?: string | null;
  visibleText?: string | null;
}

export interface InstagramHighlight {
  title: string;
  url?: string | null;
  thumbnailUrl?: string | null;
}

export type InstagramAccessState =
  | "public_visible"
  | "private_not_following"
  | "follow_requested"
  | "pending_approval"
  | "approved_visible"
  | "login_required"
  | "checkpoint_required"
  | "rate_limited"
  | "blocked"
  | "not_found";

export interface InstagramAccessInfo {
  state: InstagramAccessState;
  canScrapePosts?: boolean;
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

export interface InstagramProfileFull {
  platform: "Instagram";
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  externalUrl: string | null;
  profileUrl: string;
  isVerified?: boolean;
  isPrivate?: boolean;
  stats?: InstagramProfileStats;
  highlights?: InstagramHighlight[];
  recentPublicPosts?: InstagramPublicPost[];
  access?: InstagramAccessInfo;
  visibleProfileText?: string[];
  source: "scraper";
  connectedAt?: string;
}

export function hasInstagramProfile(profile: InstagramProfileFull | null | undefined): profile is InstagramProfileFull {
  if (!profile || profile.platform !== "Instagram" || profile.source !== "scraper") return false;
  if (!profile.username || !normalizeInstagramUrl(profile.profileUrl)) return false;
  return true;
}
