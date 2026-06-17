import { threadsUsernameFromUrl } from "./threads-url.mjs";

export function buildThreadsTemplate(profileUrl, raw) {
  const username = raw?.username || threadsUsernameFromUrl(profileUrl);
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
      followers: raw?.stats?.followers || null,
      threads: raw?.stats?.threads || null,
      following: raw?.stats?.following || null,
    },
    recentThreads: Array.isArray(raw?.recentThreads) ? raw.recentThreads.slice(0, 1024) : [],
    access: raw?.access || null,
    visibleProfileText: Array.isArray(raw?.visibleProfileText) ? raw.visibleProfileText.slice(0, 80) : [],
    scrapeMeta: {
      parser: raw?.scrapeMeta?.parser || "threads-browser-dom",
      title: raw?.scrapeMeta?.title || null,
      url: raw?.scrapeMeta?.url || profileUrl,
      authwall: raw?.scrapeMeta?.authwall === true,
      notFound: raw?.scrapeMeta?.notFound === true,
      accessState: raw?.scrapeMeta?.accessState || raw?.access?.state || null,
      lineCount: raw?.scrapeMeta?.lineCount || 0,
      targetPostCount: raw?.scrapeMeta?.targetPostCount || 0,
      extractedThreadCount: raw?.scrapeMeta?.extractedThreadCount || 0,
      reachedPostCap: raw?.scrapeMeta?.reachedPostCap === true,
      postsWithText: raw?.scrapeMeta?.postsWithText || 0,
      postsWithMedia: raw?.scrapeMeta?.postsWithMedia || 0,
      postsWithExternalLinks: raw?.scrapeMeta?.postsWithExternalLinks || 0,
      postsWithVisibleCounters: raw?.scrapeMeta?.postsWithVisibleCounters || 0,
    },
  };
}
