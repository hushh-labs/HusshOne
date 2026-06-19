import { instagramUsernameFromUrl } from "./instagram-url.mjs";

export function buildInstagramTemplate(profileUrl, raw) {
  const username = raw?.username || instagramUsernameFromUrl(profileUrl);
  return {
    username,
    profileUrl: raw?.profileUrl || profileUrl,
    displayName: raw?.displayName || null,
    bio: raw?.bio || null,
    avatarUrl: raw?.avatarUrl || null,
    externalUrl: raw?.externalUrl || null,
    isVerified: raw?.isVerified === true,
    isPrivate: raw?.isPrivate === true,
    stats: {
      posts: raw?.stats?.posts || null,
      followers: raw?.stats?.followers || null,
      following: raw?.stats?.following || null,
    },
    highlights: Array.isArray(raw?.highlights) ? raw.highlights.slice(0, 24) : [],
    recentPublicPosts: Array.isArray(raw?.recentPublicPosts) ? raw.recentPublicPosts.slice(0, 1024) : [],
    access: raw?.access || null,
    visibleProfileText: Array.isArray(raw?.visibleProfileText) ? raw.visibleProfileText.slice(0, 80) : [],
    scrapeMeta: {
      parser: raw?.scrapeMeta?.parser || "instagram-browser-dom",
      title: raw?.scrapeMeta?.title || null,
      url: raw?.scrapeMeta?.url || profileUrl,
      authwall: raw?.scrapeMeta?.authwall === true,
      notFound: raw?.scrapeMeta?.notFound === true,
      chromeError: raw?.scrapeMeta?.chromeError === true,
      httpErrorCode: raw?.scrapeMeta?.httpErrorCode || null,
      rateLimited: raw?.scrapeMeta?.rateLimited === true,
      accessState: raw?.scrapeMeta?.accessState || raw?.access?.state || null,
      lineCount: raw?.scrapeMeta?.lineCount || 0,
      requestedMaxPosts: raw?.scrapeMeta?.requestedMaxPosts || null,
      returnedPosts: raw?.scrapeMeta?.returnedPosts || 0,
      returnedPostLinks: raw?.scrapeMeta?.returnedPostLinks || 0,
      scrollEngine: raw?.scrapeMeta?.scrollEngine || null,
      scrollPasses: raw?.scrapeMeta?.scrollPasses || 0,
      stablePasses: raw?.scrapeMeta?.stablePasses || 0,
      stopReason: raw?.scrapeMeta?.stopReason || raw?.scrapeMeta?.scrollStopReason || null,
      scrollStopReason: raw?.scrapeMeta?.scrollStopReason || raw?.scrapeMeta?.stopReason || null,
      maxScrollPasses: raw?.scrapeMeta?.maxScrollPasses || null,
      stableLimit: raw?.scrapeMeta?.stableLimit || null,
      detailHydrationLimit: raw?.scrapeMeta?.detailHydrationLimit || 0,
      detailHydratedPosts: raw?.scrapeMeta?.detailHydratedPosts || 0,
    },
  };
}
