/**
 * LinkedIn POSTS (activity feed) types — how LinkedIn enters One as a FEED (content the member actively
 * pushes), complementary to the career-context profile (`buildProfessionalContext` in ./profile.ts).
 * Professionals often push on LinkedIn, not Instagram, so their posts must reach the preference layer.
 *
 * Scraped by the VM service (`POST /scrape-posts` on linkedin-scraper-vm) from /in/<handle>/recent-activity/all/.
 * `LinkedInPostsProfile` is the archive-facing shape (platform "LinkedIn", source "scraper") that flows
 * through the SAME pipeline as IG/X/Threads: extractSocialArchive → SocialContentItem → recompute → synthesis.
 */
export interface LinkedInPost {
  urn?: string | null;
  url?: string | null;
  /** original post | reshare | reply/comment | article. */
  type?: "post" | "reshare" | "reply" | "article" | string;
  text?: string | null;
  /** Relative timestamp as shown by LinkedIn (e.g. "2d") — best-effort, not absolute. */
  timestamp?: string | null;
  reactions?: string | null;
  comments?: string | null;
  reposts?: string | null;
  media?: string[];
}

export interface LinkedInPostsProfile {
  platform: "LinkedIn";
  username: string; // /in/<handle>
  profileUrl: string;
  source: "scraper";
  recentPosts?: LinkedInPost[];
  scrapeMeta?: { parser?: string; scrollRounds?: number; stopReason?: string; authwall?: boolean };
  access?: { state?: string; canScrapePosts?: boolean };
}
