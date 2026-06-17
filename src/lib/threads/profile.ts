import { normalizeThreadsUrl } from "@/lib/auth/identity";

export interface ThreadsProfileStats {
  followers?: string | null;
  threads?: string | null;
  following?: string | null;
}

export interface ThreadsPost {
  url: string;
  position?: number;
  text?: string | null;
  contentSeed?: string | null;
  timestamp?: string | null;
  mediaUrls?: string[];
  thumbnailUrl?: string | null;
  feedPhotoUrl?: string | null;
  externalLinks?: string[];
  replyCount?: string | null;
  repostCount?: string | null;
  likeCount?: string | null;
  quoteCount?: string | null;
  visibleLabels?: string[];
  visibleText?: string | null;
}

export type ThreadsAccessState =
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

export interface ThreadsAccessInfo {
  state: ThreadsAccessState;
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

export interface ThreadsProfileFull {
  platform: "Threads";
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  externalUrl: string | null;
  profileUrl: string;
  isVerified?: boolean;
  isPrivate?: boolean;
  stats?: ThreadsProfileStats;
  recentThreads?: ThreadsPost[];
  access?: ThreadsAccessInfo;
  visibleProfileText?: string[];
  source: "scraper";
  connectedAt?: string;
}

export function hasThreadsProfile(profile: ThreadsProfileFull | null | undefined): profile is ThreadsProfileFull {
  if (!profile || profile.platform !== "Threads" || profile.source !== "scraper") return false;
  if (!profile.username || !normalizeThreadsUrl(profile.profileUrl)) return false;
  return true;
}
