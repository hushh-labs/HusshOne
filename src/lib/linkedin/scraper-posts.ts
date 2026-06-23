/**
 * Client for the VM LinkedIn ACTIVITY scraper (`POST /scrape-posts` on linkedin-scraper-vm). Mirrors
 * src/lib/instagram/scraper-profile.ts: returns a discriminated outcome the social-archive worker drains
 * (`status: "profile"` → index it; anything else → treated as "no profile" → retry/skip). Resilient and
 * isolated — a LinkedIn block never touches the profile-connect path.
 */
import { normalizeLinkedInUrl, linkedinHandleFromUrl } from "@/lib/auth/identity";
import type { LinkedInPost, LinkedInPostsProfile } from "./posts";

const DEFAULT_SCRAPER_URL = "http://136.114.82.27:8080";
// A deep recent-activity scroll is longer than a profile read; allow more headroom. Env override:
// LINKEDIN_POSTS_TIMEOUT_MS. Kept independent of the profile timeout so tuning one can't break the other.
const DEFAULT_TIMEOUT_MS = 150_000;

export class LinkedInPostsScraperError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = "linkedin_posts_scraper_error",
  ) {
    super(message);
    this.name = "LinkedInPostsScraperError";
  }
}

type ScrapedPost = {
  urn?: unknown;
  url?: unknown;
  type?: unknown;
  text?: unknown;
  timestamp?: unknown;
  reactions?: unknown;
  comments?: unknown;
  reposts?: unknown;
  media?: unknown;
};

type ScrapePostsResponse = {
  ok?: boolean;
  profileUrl?: string;
  count?: number;
  posts?: ScrapedPost[];
  authwall?: boolean;
  error?: string;
  type?: string;
  scrapeMeta?: { parser?: string; scrollRounds?: number; stopReason?: string };
};

export type LinkedInPostsOutcome =
  | { status: "profile"; profile: LinkedInPostsProfile; normalizedUrl: string }
  | { status: "authwall"; normalizedUrl: string }
  | { status: "empty"; normalizedUrl: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanUrl(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(s) ? s : null;
}

function mapPosts(raw: unknown): LinkedInPost[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LinkedInPost[] = [];
  for (const item of raw as ScrapedPost[]) {
    const rec = asRecord(item);
    const text = str(rec.text, 3000);
    const media = Array.isArray(rec.media) ? (rec.media as unknown[]).map(cleanUrl).filter((u): u is string => !!u).slice(0, 4) : [];
    if (!text && media.length === 0) continue; // drop empty control tiles
    const urn = str(rec.urn, 120);
    const url = cleanUrl(rec.url);
    const dedupeKey = urn || url || `${text?.slice(0, 60) ?? ""}`;
    if (dedupeKey && seen.has(dedupeKey)) continue;
    if (dedupeKey) seen.add(dedupeKey);
    out.push({
      urn,
      url,
      type: str(rec.type, 16) ?? "post",
      text,
      timestamp: str(rec.timestamp, 40),
      reactions: str(rec.reactions, 24),
      comments: str(rec.comments, 24),
      reposts: str(rec.reposts, 24),
      media,
    });
    if (out.length >= 512) break;
  }
  return out;
}

export async function scrapeLinkedInPostsUrl(
  inputUrl: unknown,
  opts: { maxPosts?: number } = {},
): Promise<LinkedInPostsOutcome> {
  const normalizedUrl = normalizeLinkedInUrl(inputUrl);
  if (!normalizedUrl) {
    throw new LinkedInPostsScraperError("Provide a valid LinkedIn personal profile URL.", 400, "invalid_linkedin_url");
  }

  const baseUrl = (process.env.LINKEDIN_SCRAPER_URL || DEFAULT_SCRAPER_URL).trim().replace(/\/+$/, "");
  const apiKey = (process.env.LINKEDIN_SCRAPER_API_KEY || "").trim();
  const timeoutMs = Number(process.env.LINKEDIN_POSTS_TIMEOUT_MS || "") || DEFAULT_TIMEOUT_MS;
  if (!apiKey) {
    throw new LinkedInPostsScraperError("LinkedIn posts scraping is not configured.", 503, "linkedin_posts_not_configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/scrape-posts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: normalizedUrl, ...(opts.maxPosts ? { maxPosts: opts.maxPosts } : {}) }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as ScrapePostsResponse | { error?: string } | null;
    if (!res.ok) {
      const upstream = asRecord(data);
      // authwall/session issues come back 503 — surface as a soft "authwall" so the worker retries with
      // backoff rather than hard-erroring (best-effort isolation).
      if (res.status === 503 || /authwall|login|checkpoint|session/i.test(`${upstream.type ?? ""} ${upstream.error ?? ""}`)) {
        return { status: "authwall", normalizedUrl };
      }
      const message = typeof upstream.error === "string" ? upstream.error : "LinkedIn posts service is unavailable.";
      throw new LinkedInPostsScraperError(message, res.status, "linkedin_posts_upstream_error");
    }
    const body = (data ?? {}) as ScrapePostsResponse;
    if (body.authwall) return { status: "authwall", normalizedUrl };
    const recentPosts = mapPosts(body.posts);
    if (!recentPosts.length) return { status: "empty", normalizedUrl };
    const handle = linkedinHandleFromUrl(normalizedUrl) || normalizedUrl;
    const profile: LinkedInPostsProfile = {
      platform: "LinkedIn",
      username: handle,
      profileUrl: normalizedUrl,
      source: "scraper",
      recentPosts,
      scrapeMeta: { parser: body.scrapeMeta?.parser, scrollRounds: body.scrapeMeta?.scrollRounds, stopReason: body.scrapeMeta?.stopReason },
      access: { canScrapePosts: true },
    };
    return { status: "profile", profile, normalizedUrl };
  } catch (error) {
    if (error instanceof LinkedInPostsScraperError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new LinkedInPostsScraperError("LinkedIn posts scrape took too long.", 504, "linkedin_posts_timeout");
    }
    throw new LinkedInPostsScraperError(
      error instanceof Error ? error.message : "LinkedIn posts service is unavailable.",
      503,
      "linkedin_posts_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
