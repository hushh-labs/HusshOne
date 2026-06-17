import { twitterUsernameFromUrl } from "./twitter-url.mjs";

const MAX_TEMPLATE_ITEMS = 1024;

export function buildTwitterTemplate(profileUrl, raw) {
  const username = raw?.username || raw?.handle || twitterUsernameFromUrl(profileUrl);
  const timelineItems = Array.isArray(raw?.timelineItems)
    ? raw.timelineItems.slice(0, MAX_TEMPLATE_ITEMS)
    : Array.isArray(raw?.recentPosts)
      ? raw.recentPosts.slice(0, MAX_TEMPLATE_ITEMS)
      : [];

  return {
    username,
    handle: username,
    profileUrl: raw?.profileUrl || (username ? `https://x.com/${username}` : profileUrl),
    displayName: raw?.displayName || null,
    bio: raw?.bio || null,
    avatarUrl: raw?.avatarUrl || null,
    bannerUrl: raw?.bannerUrl || null,
    externalUrl: raw?.externalUrl || null,
    location: raw?.location || null,
    joinedDate: raw?.joinedDate || null,
    isVerified: raw?.isVerified === true,
    isProtected: raw?.isProtected === true,
    isPrivate: raw?.isPrivate === true || raw?.isProtected === true,
    stats: {
      followers: raw?.stats?.followers || null,
      following: raw?.stats?.following || null,
      posts: raw?.stats?.posts || null,
    },
    tabs: Array.isArray(raw?.tabs) ? raw.tabs : ["posts", "replies"],
    timelineItems,
    recentPosts: timelineItems,
    access: raw?.access || null,
    visibleProfileText: Array.isArray(raw?.visibleProfileText) ? raw.visibleProfileText.slice(0, 120) : [],
    scrapeMeta: {
      parser: raw?.scrapeMeta?.parser || "twitter-browser-dom",
      title: raw?.scrapeMeta?.title || null,
      url: raw?.scrapeMeta?.url || profileUrl,
      authwall: raw?.scrapeMeta?.authwall === true,
      notFound: raw?.scrapeMeta?.notFound === true,
      suspendedOrUnavailable: raw?.scrapeMeta?.suspendedOrUnavailable === true,
      accessState: raw?.scrapeMeta?.accessState || raw?.access?.state || null,
      selectedTabs: Array.isArray(raw?.scrapeMeta?.selectedTabs) ? raw.scrapeMeta.selectedTabs : ["posts", "replies"],
      lineCount: raw?.scrapeMeta?.lineCount || 0,
      targetPostCount: raw?.scrapeMeta?.targetPostCount || 0,
      extractedCount: raw?.scrapeMeta?.extractedCount || timelineItems.length,
      countsByTab: raw?.scrapeMeta?.countsByTab || countByTab(timelineItems),
      scrollPasses: raw?.scrapeMeta?.scrollPasses || 0,
      scrollStopReason: raw?.scrapeMeta?.scrollStopReason || raw?.scrapeMeta?.stopReason || null,
      stopReason: raw?.scrapeMeta?.stopReason || raw?.scrapeMeta?.scrollStopReason || null,
      stableScrollPasses: raw?.scrapeMeta?.stableScrollPasses || 0,
      lastNewItemAtPass: raw?.scrapeMeta?.lastNewItemAtPass ?? null,
      lastScrollY: raw?.scrapeMeta?.lastScrollY || 0,
      lastScrollHeight: raw?.scrapeMeta?.lastScrollHeight || 0,
      tabScrollMeta: raw?.scrapeMeta?.tabScrollMeta || null,
      reachedItemCap: raw?.scrapeMeta?.reachedItemCap === true,
      postsWithText: raw?.scrapeMeta?.postsWithText || 0,
      postsWithMedia: raw?.scrapeMeta?.postsWithMedia || 0,
      postsWithExternalLinks: raw?.scrapeMeta?.postsWithExternalLinks || 0,
      postsWithVisibleCounters: raw?.scrapeMeta?.postsWithVisibleCounters || 0,
    },
  };
}

function countByTab(items) {
  return items.reduce(
    (acc, item) => {
      const tab = item?.tab === "replies" ? "replies" : "posts";
      acc[tab] += 1;
      return acc;
    },
    { posts: 0, replies: 0 },
  );
}
