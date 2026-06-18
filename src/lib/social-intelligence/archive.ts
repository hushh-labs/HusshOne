/* Pure extraction of the FULL social archive (up to 1024 visible items/profile) from scraped
   profiles into normalized content-item + media-asset rows. This is the v3 preference archive —
   independent of the compact Phase-1 prompt. No DB, no Next, no network: scan-store persists the
   rows and the media worker reads the media assets. Kept pure so it is exhaustively unit-testable. */
import crypto from "node:crypto";
import type { SocialProfileFull } from "@/lib/ria/types";

/** Hard ceiling on indexed items per profile. Matches the scraper depth target. */
export const ARCHIVE_MAX_ITEMS_PER_PROFILE = 1024;

export type ArchiveMediaType = "image" | "video" | "thumbnail";

export interface ArchiveMediaAsset {
  platform: string; // instagram | threads | x
  assetHash: string; // sha256(sourceUrl)
  sourceUrl: string;
  mediaType: ArchiveMediaType;
}

export interface ArchiveContentRow {
  platform: string;
  publicId: string; // username / handle
  itemId: string; // stable per (platform,item) — the item URL, else a content hash
  itemUrl: string;
  itemType: string; // post | reel | thread | reply | tweet | profile
  text: string | null;
  timestamp: string | null;
  media: { primaryUrl: string; urls: string[]; assetHashes: string[] } | null;
  metrics: Record<string, string> | null;
  mediaAssets: ArchiveMediaAsset[];
}

export interface SocialArchive {
  content: ArchiveContentRow[];
  /** Deduped (platform + assetHash) media assets across all profiles. */
  media: ArchiveMediaAsset[];
  perPlatform: Record<string, { items: number; media: number }>;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function platformKey(profile: SocialProfileFull): string {
  return profile.platform.trim().toLowerCase();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : null;
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function metricsObject(entries: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(entries)) {
    const value = cleanText(raw);
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

interface RawItem {
  url: string | null;
  itemType: string;
  text: string | null;
  timestamp: string | null;
  /** [url, mediaType] pairs — order matters; first is primary. */
  mediaCandidates: Array<[string, ArchiveMediaType]>;
  metrics: Record<string, string> | null;
}

function buildRow(platform: string, publicId: string, index: number, raw: RawItem): ArchiveContentRow {
  // Dedup media within the item, preserving order; first becomes primary.
  const seen = new Set<string>();
  const mediaAssets: ArchiveMediaAsset[] = [];
  for (const [url, mediaType] of raw.mediaCandidates) {
    const clean = cleanUrl(url);
    if (!clean) continue;
    const assetHash = sha256(clean);
    if (seen.has(assetHash)) continue;
    seen.add(assetHash);
    mediaAssets.push({ platform, assetHash, sourceUrl: clean, mediaType });
  }
  const urls = mediaAssets.map((m) => m.sourceUrl);
  const media = urls.length
    ? { primaryUrl: urls[0], urls, assetHashes: mediaAssets.map((m) => m.assetHash) }
    : null;
  // Stable itemId: the item URL when present (survives re-scrapes), else a content hash.
  const itemId = raw.url ?? `urn:one:item:${platform}:${publicId}:${sha256(`${raw.text ?? ""}|${index}`)}`;
  return {
    platform,
    publicId,
    itemId,
    itemUrl: raw.url ?? itemId,
    itemType: raw.itemType,
    text: raw.text,
    timestamp: raw.timestamp,
    media,
    metrics: raw.metrics,
    mediaAssets,
  };
}

function instagramItems(profile: Extract<SocialProfileFull, { platform: "Instagram" }>, limit: number): ArchiveContentRow[] {
  const publicId = profile.username;
  return (profile.recentPublicPosts ?? []).slice(0, limit).map((post, index) => {
    const isVideo = post.isVideo === true || post.kind === "reel";
    const mediaCandidates: Array<[string, ArchiveMediaType]> = [];
    for (const url of post.cdnUrls ?? []) mediaCandidates.push([url ?? "", isVideo ? "video" : "image"]);
    if (post.thumbnailUrl) mediaCandidates.push([post.thumbnailUrl, "thumbnail"]);
    return buildRow("instagram", publicId, index, {
      url: cleanUrl(post.url),
      itemType: post.kind === "reel" ? "reel" : "post",
      text: cleanText(post.caption) ?? cleanText(post.visibleText) ?? cleanText(post.alt) ?? cleanText(post.ariaLabel),
      timestamp: cleanText(post.timestamp),
      mediaCandidates,
      metrics: metricsObject({ likes: post.likes, comments: post.comments }),
    });
  });
}

function threadsItems(profile: Extract<SocialProfileFull, { platform: "Threads" }>, limit: number): ArchiveContentRow[] {
  const publicId = profile.username;
  return (profile.recentThreads ?? []).slice(0, limit).map((post, index) => {
    const mediaCandidates: Array<[string, ArchiveMediaType]> = [];
    for (const url of post.mediaUrls ?? []) mediaCandidates.push([url ?? "", "image"]);
    if (post.feedPhotoUrl) mediaCandidates.push([post.feedPhotoUrl, "image"]);
    if (post.thumbnailUrl) mediaCandidates.push([post.thumbnailUrl, "thumbnail"]);
    return buildRow("threads", publicId, index, {
      url: cleanUrl(post.url),
      itemType: "thread",
      text: cleanText(post.text) ?? cleanText(post.contentSeed) ?? cleanText(post.visibleText),
      timestamp: cleanText(post.timestamp),
      mediaCandidates,
      metrics: metricsObject({ likes: post.likeCount, replies: post.replyCount, reposts: post.repostCount, quotes: post.quoteCount }),
    });
  });
}

function xItems(profile: Extract<SocialProfileFull, { platform: "X" }>, limit: number): ArchiveContentRow[] {
  const publicId = profile.username;
  return (profile.timelineItems ?? []).slice(0, limit).map((item, index) => {
    const mediaCandidates: Array<[string, ArchiveMediaType]> = [];
    for (const url of item.mediaUrls ?? []) mediaCandidates.push([url ?? "", "image"]);
    if (item.primaryPhotoUrl) mediaCandidates.push([item.primaryPhotoUrl, "image"]);
    if (item.thumbnailUrl) mediaCandidates.push([item.thumbnailUrl, "thumbnail"]);
    return buildRow("x", publicId, index, {
      url: cleanUrl(item.url),
      itemType: item.isReply ? "reply" : "tweet",
      text: cleanText(item.text) ?? cleanText(item.visibleText) ?? cleanText(item.replyContext),
      timestamp: cleanText(item.timestamp),
      mediaCandidates,
      metrics: metricsObject({ likes: item.likeCount, replies: item.replyCount, reposts: item.repostCount, quotes: item.quoteCount, views: item.viewCount }),
    });
  });
}

function profileItems(profile: SocialProfileFull, limit: number): ArchiveContentRow[] {
  switch (profile.platform) {
    case "Instagram":
      return instagramItems(profile, limit);
    case "Threads":
      return threadsItems(profile, limit);
    case "X":
      return xItems(profile, limit);
    default:
      return [];
  }
}

/** Extract the full archive from scraped profiles. Pure: no DB, no network. Media is deduped
 *  globally by (platform, assetHash) so re-shared images are analyzed once. */
export function extractSocialArchive(
  profiles: SocialProfileFull[] | undefined,
  opts: { maxItemsPerProfile?: number } = {},
): SocialArchive {
  const limit = Math.max(0, Math.min(opts.maxItemsPerProfile ?? ARCHIVE_MAX_ITEMS_PER_PROFILE, ARCHIVE_MAX_ITEMS_PER_PROFILE));
  const content: ArchiveContentRow[] = [];
  const mediaByKey = new Map<string, ArchiveMediaAsset>();
  const perPlatform: Record<string, { items: number; media: number }> = {};

  for (const profile of profiles ?? []) {
    if (!profile || profile.source !== "scraper") continue;
    const key = platformKey(profile);
    const rows = profileItems(profile, limit);
    for (const row of rows) {
      content.push(row);
      for (const asset of row.mediaAssets) {
        const dedupeKey = `${asset.platform}:${asset.assetHash}`;
        if (!mediaByKey.has(dedupeKey)) mediaByKey.set(dedupeKey, asset);
      }
    }
    const bucket = (perPlatform[key] ??= { items: 0, media: 0 });
    bucket.items += rows.length;
  }

  const media = [...mediaByKey.values()];
  for (const asset of media) {
    const bucket = (perPlatform[asset.platform] ??= { items: 0, media: 0 });
    bucket.media += 1;
  }

  return { content, media, perPlatform };
}
