import fs from "node:fs";
import puppeteer from "puppeteer-core";

const DEFAULT_BROWSER_URL = process.env.TWITTER_BROWSER_URL || "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = Number(process.env.TWITTER_SCRAPER_TIMEOUT_MS || process.env.TWITTER_PROFILE_SCRAPER_TIMEOUT_MS || 120_000);
const DEFAULT_MAX_POSTS = Number(process.env.TWITTER_MAX_POSTS_PER_PROFILE || 1024);
const MAX_POSTS = 1024;
const DEFAULT_SCROLL_PASSES = Number(process.env.TWITTER_MAX_SCROLL_PASSES || 1300);
const DEFAULT_STABLE_SCROLL_PASSES = Number(process.env.TWITTER_STABLE_SCROLL_PASSES || 35);
const DEFAULT_SCROLL_STEP_PX = Number(process.env.TWITTER_SCROLL_STEP_PX || 850);
const DEFAULT_SCROLL_DELAY_MS = Number(process.env.TWITTER_SCROLL_DELAY_MS || 750);

export async function scrapeTwitterProfile(profileUrl, options = {}) {
  return runTwitterProfileBrowser(profileUrl, {
    action: options.requestAccess ? "request_access" : "scrape",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

export async function requestTwitterProfileAccess(profileUrl, options = {}) {
  return runTwitterProfileBrowser(profileUrl, {
    action: "request_access",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

export async function checkTwitterProfileAccess(profileUrl, options = {}) {
  return runTwitterProfileBrowser(profileUrl, {
    action: "check_access",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

async function runTwitterProfileBrowser(profileUrl, options = {}) {
  const useLiveBrowser = process.env.TWITTER_LIVE_BROWSER === "true";
  const browser = useLiveBrowser ? await connectBrowser() : await launchBrowser();
  let page;
  const maxPosts = clampMaxPosts(options.maxPosts);
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });
    await page.setUserAgent(
      process.env.TWITTER_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    );

    const postsRaw = await scrapeTab(page, profileUrl, { tab: "posts", maxPosts, action: options.action });
    if (options.action === "request_access" && shouldClickFollowRequest(postsRaw)) {
      const requestedAction = await clickFollowRequestButton(page);
      await delay(requestedAction.clicked ? 2500 : 1000);
      await dismissTwitterInterruption(page);
      const refreshed = await page.evaluate(extractTwitterProfileFromDom, { maxPosts, tab: "posts" });
      postsRaw.access = { ...refreshed.access, requestedAction };
      postsRaw.isProtected = refreshed.isProtected;
      postsRaw.isPrivate = refreshed.isPrivate;
      postsRaw.timelineItems = refreshed.timelineItems;
      postsRaw.recentPosts = refreshed.recentPosts;
      postsRaw.scrapeMeta = refreshed.scrapeMeta;
    }

    if (options.action === "check_access" || !isVisibleRaw(postsRaw)) return postsRaw;

    const remaining = Math.max(0, maxPosts - (postsRaw.timelineItems || []).length);
    if (remaining <= 0) return mergeTwitterTimelineItems(postsRaw, [], maxPosts);

    const repliesRaw = await scrapeTab(page, withRepliesUrl(profileUrl), { tab: "replies", maxPosts: remaining, action: options.action });
    return mergeTabResults(postsRaw, repliesRaw, maxPosts);
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (useLiveBrowser) await browser.disconnect();
    else await browser.close().catch(() => undefined);
  }
}

async function scrapeTab(page, tabUrl, options) {
  await page.goto(tabUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  await delay(4000);
  await dismissTwitterInterruption(page);
  const initial = await page.evaluate(extractTwitterProfileFromDom, { maxPosts: options.maxPosts, tab: options.tab });
  if (!isVisibleRaw(initial) || options.action === "check_access") return initial;
  const scrolled = await autoScroll(page, options.maxPosts, options.tab);
  await delay(1200);
  const raw = await page.evaluate(extractTwitterProfileFromDom, { maxPosts: options.maxPosts, tab: options.tab });
  return mergeTwitterTimelineItems(raw, scrolled.items, options.maxPosts, {
    scrollPasses: scrolled.scrollPasses,
    stopReason: scrolled.stopReason,
    stableScrollPasses: scrolled.stableScrollPasses,
    lastNewItemAtPass: scrolled.lastNewItemAtPass,
    lastScrollY: scrolled.lastScrollY,
    lastScrollHeight: scrolled.lastScrollHeight,
    selectedTabs: [options.tab],
  });
}

function shouldClickFollowRequest(raw) {
  const access = raw?.access || {};
  return access.state === "protected_not_following" && access.canRequest === true && access.outgoingRequest !== true;
}

function isVisibleRaw(raw) {
  const access = raw?.access || {};
  return access.state === "public_visible" || access.state === "approved_visible" || access.canScrapePosts === true;
}

async function connectBrowser() {
  return puppeteer.connect({ browserURL: DEFAULT_BROWSER_URL, defaultViewport: null });
}

async function launchBrowser() {
  const executablePath = resolveChromePath();
  const userDataDir = process.env.PUPPETEER_USER_DATA_DIR || process.env.TWITTER_USER_DATA_DIR;
  return puppeteer.launch({
    executablePath,
    userDataDir,
    headless: process.env.TWITTER_PROFILE_SCRAPER_HEADLESS !== "false",
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1365,900",
    ],
  });
}

function resolveChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Chromium executable not found. Set PUPPETEER_EXECUTABLE_PATH.");
  return found;
}

async function autoScroll(page, maxPosts, tab) {
  const target = clampMaxPosts(maxPosts);
  const seen = new Map();
  let scrollPasses = 0;
  let latestRaw = null;
  const collect = async () => {
    const raw = await page.evaluate(extractTwitterProfileFromDom, { maxPosts: target, tab });
    latestRaw = raw;
    for (const item of raw?.timelineItems || []) {
      if (item?.url && !seen.has(item.url)) seen.set(item.url, item);
    }
    return raw;
  };

  await collect();
  let stable = 0;
  let lastNewItemAtPass = seen.size > 0 ? 0 : null;
  let stopReason = "max_scroll_passes";
  let previousCount = seen.size;
  let metrics = await scrollMetrics(page);
  const maxScrollPasses = Math.max(1, Math.min(2500, Number(DEFAULT_SCROLL_PASSES) || 1300));
  const stableLimit = Math.max(5, Math.min(120, Number(DEFAULT_STABLE_SCROLL_PASSES) || 35));
  const stepPx = Math.max(250, Math.min(3000, Number(DEFAULT_SCROLL_STEP_PX) || 850));
  const delayMs = Math.max(250, Math.min(3000, Number(DEFAULT_SCROLL_DELAY_MS) || 750));
  for (let pass = 0; pass < maxScrollPasses; pass += 1) {
    scrollPasses = pass + 1;
    await clickTimelineRetry(page);
    const delta = stable > 0 && stable % 9 === 0 ? -Math.round(stepPx * 0.55) : stepPx;
    await page.evaluate((dy) => window.scrollBy(0, dy), delta).catch(() => undefined);
    if (pass % 6 === 5) await page.keyboard.press("PageDown").catch(() => undefined);
    if (stable > 0 && stable % 14 === 0) {
      await page
        .evaluate((dy) => {
          window.scrollBy(0, -Math.round(dy * 0.8));
          window.scrollBy(0, Math.round(dy * 1.6));
        }, stepPx)
        .catch(() => undefined);
    }
    await delay(delayMs);
    await collect();
    metrics = await scrollMetrics(page);
    const hasNewItems = seen.size > previousCount;
    if (hasNewItems) {
      stable = 0;
      lastNewItemAtPass = scrollPasses;
    } else {
      stable += 1;
    }
    previousCount = seen.size;
    if (seen.size >= target) {
      stopReason = "target_reached";
      break;
    }
    const accessState = latestRaw?.access?.state || latestRaw?.scrapeMeta?.accessState;
    if (["login_required", "checkpoint_required", "rate_limited", "blocked", "not_found", "suspended_or_unavailable"].includes(accessState)) {
      stopReason = accessState;
      break;
    }
    if (stable >= stableLimit) {
      stopReason = "stable_feed";
      break;
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  return {
    items: [...seen.values()].slice(0, target),
    scrollPasses,
    stopReason,
    stableScrollPasses: stable,
    lastNewItemAtPass,
    lastScrollY: metrics.scrollY,
    lastScrollHeight: metrics.scrollHeight,
  };
}

export function mergeTwitterTimelineItems(raw, scrolledItems = [], maxPosts = DEFAULT_MAX_POSTS, meta = {}) {
  const target = clampMaxPosts(maxPosts);
  const items = [];
  const seen = new Set();
  for (const item of [...(scrolledItems || []), ...(raw?.timelineItems || []), ...(raw?.recentPosts || [])]) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    items.push({ ...item, position: items.length + 1 });
    if (items.length >= target) break;
  }
  raw.timelineItems = items;
  raw.recentPosts = items;
  const blockedStates = new Set(["login_required", "checkpoint_required", "rate_limited", "blocked", "not_found", "suspended_or_unavailable"]);
  if (raw.access && items.length > 0 && !blockedStates.has(raw.access.state)) {
    raw.access = { ...raw.access, canScrapePosts: true };
  }
  raw.scrapeMeta = {
    ...(raw.scrapeMeta || {}),
    selectedTabs: meta.selectedTabs || raw.scrapeMeta?.selectedTabs || [raw.scrapeMeta?.tab || "posts"],
    accessState: raw.access?.state || raw.scrapeMeta?.accessState,
    extractedCount: items.length,
    countsByTab: countByTab(items),
    scrollPasses: meta.scrollPasses ?? raw.scrapeMeta?.scrollPasses ?? 0,
    scrollStopReason: meta.stopReason ?? raw.scrapeMeta?.scrollStopReason ?? raw.scrapeMeta?.stopReason ?? null,
    stopReason: meta.stopReason ?? raw.scrapeMeta?.stopReason ?? raw.scrapeMeta?.scrollStopReason ?? null,
    stableScrollPasses: meta.stableScrollPasses ?? raw.scrapeMeta?.stableScrollPasses ?? 0,
    lastNewItemAtPass: meta.lastNewItemAtPass ?? raw.scrapeMeta?.lastNewItemAtPass ?? null,
    lastScrollY: meta.lastScrollY ?? raw.scrapeMeta?.lastScrollY ?? 0,
    lastScrollHeight: meta.lastScrollHeight ?? raw.scrapeMeta?.lastScrollHeight ?? 0,
    reachedItemCap: items.length >= target,
    ...scrapeQuality(items, target),
  };
  return raw;
}

function mergeTabResults(postsRaw, repliesRaw, maxPosts) {
  const target = clampMaxPosts(maxPosts);
  const merged = mergeTwitterTimelineItems(postsRaw, [...(postsRaw.timelineItems || []), ...(repliesRaw?.timelineItems || [])], target, {
    selectedTabs: ["posts", "replies"],
    scrollPasses: Number(postsRaw?.scrapeMeta?.scrollPasses || 0) + Number(repliesRaw?.scrapeMeta?.scrollPasses || 0),
  });
  merged.tabs = ["posts", "replies"];
  merged.scrapeMeta = {
    ...merged.scrapeMeta,
    selectedTabs: ["posts", "replies"],
    repliesAccessState: repliesRaw?.access?.state || repliesRaw?.scrapeMeta?.accessState || null,
    tabScrollMeta: {
      posts: pickScrollMeta(postsRaw?.scrapeMeta),
      replies: pickScrollMeta(repliesRaw?.scrapeMeta),
    },
  };
  return merged;
}

function pickScrollMeta(meta = {}) {
  return {
    scrollPasses: meta.scrollPasses || 0,
    scrollStopReason: meta.scrollStopReason || meta.stopReason || null,
    stableScrollPasses: meta.stableScrollPasses || 0,
    lastNewItemAtPass: meta.lastNewItemAtPass ?? null,
    lastScrollY: meta.lastScrollY || 0,
    lastScrollHeight: meta.lastScrollHeight || 0,
    extractedCount: meta.extractedCount || 0,
  };
}

async function scrollMetrics(page) {
  return page
    .evaluate(() => ({
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0),
      viewportHeight: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
      scrollHeight: Math.round(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)),
    }))
    .catch(() => ({ scrollY: 0, viewportHeight: 0, scrollHeight: 0 }));
}

async function dismissTwitterInterruption(page) {
  await page
    .evaluate(() => {
      const labels = /^(not now|not now\.|cancel|maybe later|close|got it)$/i;
      const candidates = [...document.querySelectorAll("button, div[role='button']")];
      const target = candidates.find((el) => labels.test(String(el.innerText || el.textContent || "").trim()));
      if (!target) return false;
      target.click();
      return true;
    })
    .catch(() => false);
}

async function clickTimelineRetry(page) {
  await page
    .evaluate(() => {
      const labels = /^(retry|try again)$/i;
      const candidates = [...document.querySelectorAll("button, div[role='button']")];
      const target = candidates.find((el) => labels.test(String(el.innerText || el.textContent || "").trim()));
      if (!target) return false;
      target.click();
      return true;
    })
    .catch(() => false);
}

async function clickFollowRequestButton(page) {
  const first = await page.evaluate(clickFollowRequestButtonFromDom).catch((error) => ({
    clicked: false,
    label: null,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!first.clicked) return first;
  const confirmation = await page.evaluate(clickFollowConfirmButtonFromDom).catch(() => ({ clicked: false, label: null }));
  return { ...first, confirmation: confirmation.clicked ? confirmation : undefined };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampMaxPosts(value) {
  const n = Number(value || DEFAULT_MAX_POSTS);
  if (!Number.isFinite(n) || n <= 0) return MAX_POSTS;
  return Math.max(1, Math.min(MAX_POSTS, Math.round(n)));
}

function withRepliesUrl(profileUrl) {
  const url = new URL(profileUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/with_replies`;
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

export function extractTwitterProfileFromDom(options = {}) {
  const maxPosts = Math.max(1, Math.min(1024, Number(options.maxPosts || 1024)));
  const tab = options.tab === "replies" ? "replies" : "posts";
  const text = document.body.innerText || document.body.textContent || "";
  const allLines = lines(text);
  const url = stripQuery(location.href);
  const username = profileUsernameFromPath(location.pathname);
  const title = document.title || "";
  const ogTitle = meta("property", "og:title") || meta("name", "twitter:title") || title;
  const ogDescription = meta("property", "og:description") || meta("name", "description") || "";
  const avatarUrl = meta("property", "og:image") || meta("name", "twitter:image") || null;
  const bannerUrl = firstBannerUrl();
  const authwall =
    /\/login|\/i\/flow\/login|\/account\/access|\/challenge/i.test(location.pathname) ||
    /^Log in|^Sign in/i.test(title) ||
    /\b(Log in|Sign in) to X\b|\b(Log in|Sign in) to Twitter\b/i.test(text);
  const notFound = /This account doesn't exist|This page doesn't exist|Page Not Found|Profile not found|Try searching for another/i.test(text);
  const suspendedOrUnavailable =
    /Account suspended|This account is suspended|temporarily restricted|profile isn't available|account is unavailable/i.test(text);
  const isProtected = /These posts are protected|Only approved followers can see|protected posts|protected account/i.test(text);
  const parsedTitle = parseTitle(ogTitle, username);
  const stats = parseStats(ogDescription) || parseStats(text);
  const externalUrl = firstExternalUrl();
  const bio = deriveBio(allLines, ogDescription, parsedTitle.displayName, username, externalUrl);
  const joinedDate = deriveJoinedDate(allLines);
  const locationText = deriveLocation(allLines);
  const timelineItems = timelinePosts();
  const access = deriveAccessState(timelineItems);
  const quality = scrapeQualityForBrowser(timelineItems, maxPosts);

  return {
    username,
    handle: username,
    profileUrl: username ? `https://x.com/${username}` : url,
    displayName: parsedTitle.displayName,
    bio,
    avatarUrl,
    bannerUrl,
    externalUrl,
    location: locationText,
    joinedDate,
    isVerified: hasVerifiedSignal(),
    isProtected,
    isPrivate: isProtected,
    stats,
    tabs: ["posts", "replies"],
    timelineItems,
    recentPosts: timelineItems,
    access,
    visibleProfileText: boundedVisibleText(allLines),
    scrapeMeta: {
      parser: "twitter-browser-dom-v1",
      title,
      url,
      tab,
      selectedTabs: [tab],
      authwall,
      notFound,
      suspendedOrUnavailable,
      accessState: access.state,
      lineCount: allLines.length,
      extractedCount: timelineItems.length,
      countsByTab: countByTabForBrowser(timelineItems),
      scrollPasses: 0,
      ...quality,
    },
  };

  function meta(attr, key) {
    return document.querySelector(`meta[${attr}="${key}"]`)?.getAttribute("content")?.trim() || "";
  }

  function profileUsernameFromPath(pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (!parts.length) return "";
    const candidate = String(parts[0] || "").replace(/^@/, "").toLowerCase();
    if (/^(home|i|intent|search|explore|messages|notifications|settings|compose|login|logout|share)$/i.test(candidate)) return "";
    return /^[a-z0-9_]{1,15}$/.test(candidate) ? candidate : "";
  }

  function parseTitle(raw, fallbackUsername) {
    const compact = String(raw || "").replace(/\s+/g, " ").trim();
    const match = compact.match(/^(.*?)\s+\(@([a-z0-9_]{1,15})\)\s*(?:\/|on)?\s*(?:X|Twitter)?/i);
    if (match) return { displayName: clean(match[1], 120), username: match[2].toLowerCase() };
    const at = compact.match(/@([a-z0-9_]{1,15})/i);
    return {
      displayName: fallbackUsername ? clean(compact.replace(/\s*(?:\/|on)?\s*(?:X|Twitter).*$/i, ""), 120) || null : null,
      username: at?.[1]?.toLowerCase() || fallbackUsername,
    };
  }

  function parseStats(raw) {
    const fromLinks = parseStatsFromProfileLinks();
    const s = String(raw || "").replace(/\s+/g, " ");
    const following = s.match(/([\d.,]+\s*[KMB]?)\s+Following/i)?.[1] || null;
    const followers = s.match(/([\d.,]+\s*[KMB]?)\s+Followers?/i)?.[1] || null;
    const posts = s.match(/([\d.,]+\s*[KMB]?)\s+(?:Posts?|Tweets?)/i)?.[1] || null;
    const fromVisible = parseStatsFromVisibleLines();
    const merged = {
      followers: fromLinks.followers || (followers ? clean(followers, 40) : null) || fromVisible.followers,
      following: fromLinks.following || (following ? clean(following, 40) : null) || fromVisible.following,
      posts: fromLinks.posts || (posts ? clean(posts, 40) : null) || fromVisible.posts,
    };
    if (!merged.followers && !merged.following && !merged.posts) return { followers: null, following: null, posts: null };
    return {
      followers: merged.followers,
      following: merged.following,
      posts: merged.posts,
    };
  }

  function parseStatsFromProfileLinks() {
    const result = { followers: null, following: null, posts: null };
    const handle = username || parsedTitle.username || "";
    const selectors = handle
      ? [
          { key: "following", selector: `a[href="/${handle}/following"]` },
          { key: "followers", selector: `a[href="/${handle}/followers"], a[href="/${handle}/verified_followers"]` },
        ]
      : [];
    for (const { key, selector } of selectors) {
      const el = document.querySelector(selector);
      const value = statValueFromText(el?.innerText || el?.textContent || "");
      if (value) result[key] = value;
    }
    const headerText = clean(document.querySelector('[data-testid="UserName"]')?.innerText || document.querySelector('[data-testid="UserName"]')?.textContent || "", 300);
    const posts = headerText.match(/([\d.,]+\s*[KMB]?)\s+(?:Posts?|Tweets?)$/i)?.[1] || null;
    if (posts) result.posts = clean(posts, 40);
    return result;
  }

  function statValueFromText(value) {
    const compact = clean(value, 120);
    const inline = compact.match(/([\d.,]+\s*[KMB]?)\s*(?:Followers?|Following)/i)?.[1] || null;
    if (inline) return clean(inline, 40);
    const split = lines(value).find((line) => /^[\d.,]+\s*[KMB]?$/i.test(line));
    return split ? clean(split, 40) : null;
  }

  function parseStatsFromVisibleLines() {
    const result = { followers: null, following: null, posts: null };
    for (let index = 0; index < allLines.length; index += 1) {
      const line = clean(allLines[index], 80);
      const next = clean(allLines[index + 1], 80);
      const inlinePosts = line.match(/^([\d.,]+\s*[KMB]?)\s+(?:Posts?|Tweets?)$/i)?.[1] || null;
      if (inlinePosts) result.posts = clean(inlinePosts, 40);
      if (/^[\d.,]+\s*[KMB]?$/i.test(line) && /^Followers?$/i.test(next)) result.followers = line;
      if (/^[\d.,]+\s*[KMB]?$/i.test(line) && /^Following$/i.test(next)) result.following = line;
    }
    return result;
  }

  function firstExternalUrl() {
    const anchors = [...document.querySelectorAll("main a[href], article a[href], header a[href]")];
    for (const a of anchors) {
      const href = a.href || "";
      if (!/^https?:\/\//i.test(href)) continue;
      try {
        const u = new URL(href);
        if (isTwitterHost(u.hostname)) continue;
        const cleanUrl = stripQuery(href);
        if (cleanUrl) return cleanUrl;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function firstBannerUrl() {
    const candidates = [...document.querySelectorAll("img[src]")];
    const banner = candidates.find((img) => /profile_banners|banner/i.test(img.getAttribute("src") || img.getAttribute("alt") || ""));
    return banner ? clean(banner.getAttribute("src") || "", 1200) || null : null;
  }

  function deriveBio(sourceLines, description, displayName, handle, link) {
    const fromProfileDescription = profileDescriptionFromDom();
    if (fromProfileDescription) return fromProfileDescription;
    const fromDescription = descriptionBio(description);
    if (fromDescription) return fromDescription;
    const blocked = new Set(
      [
        displayName,
        handle,
        `@${handle}`,
        "x",
        "twitter",
        "posts",
        "followers",
        "following",
        "follow",
        "message",
        "reply",
        "repost",
        "like",
        "log in",
        "sign in",
        link,
      ]
        .filter(Boolean)
        .map((item) => String(item).toLowerCase()),
    );
    const kept = [];
    for (const line of sourceLines) {
      const cleaned = trimTwitterChrome(line);
      if (!cleaned) continue;
      const lower = cleaned.toLowerCase();
      if (blocked.has(lower)) continue;
      if (/^\d[\d.,kmb]*$/i.test(cleaned)) continue;
      if (/followers|following|posts|tweets|followed by|suggested for you/i.test(cleaned)) continue;
      if (/^log in|^sign in|^sign up|premium|verified orgs|already follow|continue with/i.test(cleaned)) continue;
      if (/These posts are protected|Only approved followers/i.test(cleaned)) continue;
      if (/^(home|search|explore|profile|about|help|privacy|terms)$/i.test(cleaned)) continue;
      kept.push(cleaned);
      if (kept.join(" ").length > 500) break;
    }
    return trimTwitterChrome(kept.join(" ")).trim().slice(0, 500) || null;
  }

  function profileDescriptionFromDom() {
    const direct = clean(
      document.querySelector('[data-testid="UserDescription"]')?.innerText ||
        document.querySelector('[data-testid="UserDescription"]')?.textContent ||
        "",
      500,
    );
    return direct || null;
  }

  function deriveJoinedDate(sourceLines) {
    const value = sourceLines.find((line) => /^Joined\s+[A-Z][a-z]+\s+\d{4}$/i.test(line));
    return value ? clean(value.replace(/^Joined\s+/i, ""), 80) : null;
  }

  function deriveLocation(sourceLines) {
    const joinedIndex = sourceLines.findIndex((line) => /^Joined\s+/i.test(line));
    if (joinedIndex <= 0) return null;
    const candidate = clean(sourceLines[joinedIndex - 1], 120);
    if (!candidate || /^CEO,|^Founder|^Joined|^Following|^Followers|^Posts$/i.test(candidate)) return null;
    if (/^https?:\/\//i.test(candidate) || candidate.startsWith("@")) return null;
    return candidate;
  }

  function descriptionBio(description) {
    const value = String(description || "")
      .replace(/^The latest posts from\s+/i, "")
      .split(/[•|]/)
      .map((part) => clean(part, 500))
      .filter(Boolean)
      .filter((part) => !/^[\d.,]+\s*[KMB]?\s+(followers?|following|posts?|tweets?)$/i.test(part))
      .join(" ")
      .trim();
    return value ? value.slice(0, 500) : null;
  }

  function timelinePosts() {
    const out = [];
    const seen = new Set();
    const containers = uniqueElements([
      ...document.querySelectorAll("main article"),
      ...document.querySelectorAll("article"),
      ...document.querySelectorAll('[data-testid="tweet"]'),
      ...document.querySelectorAll("[role='article']"),
    ]);
    const fallbackLinks = [...document.querySelectorAll('main a[href*="/status/"], article a[href*="/status/"]')];
    const candidates = containers.length ? containers : fallbackLinks;
    for (const candidate of candidates) {
      const container = candidate.matches?.('a[href*="/status/"]')
        ? candidate.closest("article") || candidate.closest("[data-testid='tweet']") || candidate.closest("[role='article']") || candidate.closest("div") || candidate
        : candidate;
      const statusLinks = candidate.matches?.('a[href*="/status/"]')
        ? [candidate]
        : [...container.querySelectorAll('a[href*="/status/"]')];
      const parsedLinks = statusLinks.map((link) => ({ link, parsed: twitterStatusFromHref(link.getAttribute("href") || "") })).filter((item) => item.parsed);
      if (!parsedLinks.length) continue;
      const preferred = parsedLinks.find((item) => item.parsed.owner === username) || (parsedLinks.length === 1 ? parsedLinks[0] : null);
      if (!preferred) continue;
      const { link, parsed } = preferred;
      if (!parsed) continue;
      if (seen.has(parsed.url)) continue;
      seen.add(parsed.url);
      const visibleText = clean(container.innerText || container.textContent || link.getAttribute("aria-label") || "", 1800) || null;
      const mediaUrls = mediaUrlsForContainer(container);
      const feedPhotoUrl = mediaUrls[0] || null;
      const externalLinks = externalLinksForContainer(container, parsed.url);
      const textValue = derivePostText(container, link, visibleText);
      const replyContext = deriveReplyContext(container, visibleText);
      const metrics = parsePostMetrics(visibleText || "", container);
      const timestampLabel = timestampLabelForContainer(container, visibleText);
      out.push({
        id: parsed.id,
        url: parsed.url,
        tab,
        position: out.length + 1,
        text: textValue,
        contentSeed: buildContentSeed(textValue, visibleText, externalLinks),
        timestamp: clean(container.querySelector("time")?.getAttribute("datetime") || container.querySelector("time")?.getAttribute("title") || "", 80) || timestampLabel,
        timestampLabel,
        mediaUrls,
        thumbnailUrl: feedPhotoUrl,
        feedPhotoUrl,
        externalLinks,
        isReply: tab === "replies" || Boolean(replyContext),
        replyContext,
        visibleText,
        visibleLabels: visibleLabelsForContainer(container),
        ...metrics,
      });
      if (out.length >= maxPosts) break;
    }
    return out;
  }

  function twitterStatusFromHref(rawHref) {
    try {
      const u = new URL(rawHref, location.origin);
      if (!isTwitterHost(u.hostname)) return null;
      const parts = u.pathname.split("/").filter(Boolean);
      const statusIndex = parts.indexOf("status");
      if (statusIndex <= 0 || !parts[statusIndex + 1]) return null;
      const owner = String(parts[statusIndex - 1] || "").replace(/^@/, "").toLowerCase();
      const id = String(parts[statusIndex + 1] || "");
      if (!/^[a-z0-9_]{1,15}$/i.test(owner) || !/^\d{5,30}$/.test(id)) return null;
      return { id, owner, url: `https://x.com/${owner}/status/${id}` };
    } catch {
      return null;
    }
  }

  function timestampLabelForContainer(container, visibleText) {
    const timeText = clean(container.querySelector("time")?.innerText || container.querySelector("time")?.textContent || "", 80);
    if (timeText) return timeText;
    const match = lines(container.innerText || container.textContent || visibleText || "").find((line) =>
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(,\s*\d{4})?$|^\d+[smhd]$|^\d+\s+(?:sec|min|hour|day)s?\s+ago$/i.test(line),
    );
    return match ? clean(match, 80) : null;
  }

  function derivePostText(container, link, visibleText) {
    const tweetText = clean(
      [...container.querySelectorAll('[data-testid="tweetText"]')]
        .map((el) => el.innerText || el.textContent || "")
        .join(" "),
      1600,
    );
    const aria = clean(link.getAttribute("aria-label") || link.getAttribute("title") || "", 800);
    const imageAlt = clean(container.querySelector('img[alt]:not([alt=""])')?.getAttribute("alt") || "", 800);
    const value = tweetText || visibleText || aria || imageAlt;
    if (!value) return null;
    return trimPostChrome(value).slice(0, 1600) || null;
  }

  function deriveReplyContext(container, visibleText) {
    const linesForContainer = lines(container.innerText || container.textContent || visibleText || "");
    const replyLine = linesForContainer.find((line) => /^(Replying to|In reply to)\b/i.test(line));
    return replyLine ? clean(replyLine, 240) : null;
  }

  function buildContentSeed(textValue, visibleText, externalLinks) {
    const seed = [textValue, visibleText, ...(externalLinks || [])].filter(Boolean).join(" ");
    return clean(seed, 2200) || null;
  }

  function mediaUrlsForContainer(container) {
    const urls = [];
    const push = (value) => {
      const src = clean(value, 1600);
      if (/^https?:\/\//i.test(src) && !urls.includes(src)) urls.push(src);
    };
    for (const img of container.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src") || "";
      if (/\/media\/|pbs\.twimg\.com\/media|video_thumb|amplify_video_thumb/i.test(src)) push(src);
      const srcset = img.getAttribute("srcset") || "";
      for (const candidate of srcset.split(",")) {
        const candidateUrl = candidate.trim().split(/\s+/)[0] || "";
        if (/\/media\/|pbs\.twimg\.com\/media|video_thumb|amplify_video_thumb/i.test(candidateUrl)) push(candidateUrl);
      }
    }
    for (const video of container.querySelectorAll("video[poster]")) push(video.getAttribute("poster") || "");
    for (const nested of container.querySelectorAll("video[src], source[src]")) push(nested.getAttribute("src") || "");
    return urls.slice(0, 16);
  }

  function externalLinksForContainer(container, selfUrl) {
    const urls = [];
    for (const a of container.querySelectorAll("a[href]")) {
      const href = a.href || "";
      if (!/^https?:\/\//i.test(href)) continue;
      try {
        const u = new URL(href);
        const cleanUrl = stripQuery(href);
        if (cleanUrl === selfUrl) continue;
        if (isTwitterHost(u.hostname)) continue;
        if (!urls.includes(cleanUrl)) urls.push(cleanUrl);
      } catch {
        /* ignore */
      }
      if (urls.length >= 12) break;
    }
    return urls;
  }

  function visibleLabelsForContainer(container) {
    return lines(container.innerText || container.textContent || "")
      .map((line) => clean(line, 160))
      .filter(Boolean)
      .slice(0, 32);
  }

  function deriveAccessState(items) {
    const relationship = relationshipSignals();
    const checkpoint =
      /\/account\/access|\/challenge/i.test(location.pathname) ||
      /confirm it's you|verify your identity|account access|suspicious activity|unusual login activity|authenticate your account|enter your verification code|help us keep your account safe|we need to verify|are you a robot/i.test(
        text,
      );
    const loginRequired = authwall && !checkpoint;
    const rateLimited = hasRateLimitSignal(text);
    const blocked = /you are blocked|blocked from following|blocked you|cannot view/i.test(text);
    const canScrapePosts = items.length > 0 && !authwall && !notFound && !rateLimited && !blocked && !suspendedOrUnavailable;
    let state = "public_visible";
    let reason = null;

    if (checkpoint) {
      state = "checkpoint_required";
      reason = "Twitter/X requires a manual checkpoint in the VM browser.";
    } else if (loginRequired) {
      state = "login_required";
      reason = "Twitter/X requires the VM browser to log in.";
    } else if (rateLimited) {
      state = "rate_limited";
      reason = "Twitter/X asked the session to slow down.";
    } else if (notFound) {
      state = "not_found";
      reason = "Twitter/X says this profile does not exist.";
    } else if (suspendedOrUnavailable) {
      state = "suspended_or_unavailable";
      reason = "Twitter/X says this profile is suspended, restricted, or unavailable.";
    } else if (blocked) {
      state = "blocked";
      reason = "Twitter/X did not allow this session to view the profile.";
    } else if (isProtected && relationship.outgoingRequest) {
      state = "pending_approval";
      reason = "Follow request is pending owner approval.";
    } else if (isProtected && relationship.canRequest) {
      state = "protected_not_following";
      reason = "Profile is protected and the VM account is not following it.";
    } else if (isProtected && canScrapePosts) {
      state = "approved_visible";
      reason = "Protected profile is visible to the VM account.";
    } else if (isProtected) {
      state = relationship.following ? "approved_visible" : "protected_not_following";
      reason = relationship.following ? "VM account appears to follow this profile." : "Profile is protected.";
    }

    return {
      state,
      canScrapePosts,
      isProtected,
      isPrivate: isProtected,
      following: relationship.following || (isProtected && canScrapePosts),
      outgoingRequest: relationship.outgoingRequest,
      canRequest: isProtected && relationship.canRequest && !relationship.outgoingRequest,
      reason,
      evidenceText: accessEvidence(),
      checkedAt: new Date().toISOString(),
    };
  }

  function relationshipSignals() {
    const labels = [...document.querySelectorAll("button, div[role='button'], a[role='button']")]
      .map((el) => clean(el.innerText || el.textContent || el.getAttribute("aria-label") || "", 100))
      .filter(Boolean);
    const hasExact = (pattern) => labels.some((label) => pattern.test(label));
    return {
      following: hasExact(/^(following|message)$/i),
      outgoingRequest: hasExact(/^(requested|request sent|pending)$/i) || /\bRequested\b|\bRequest sent\b|\bPending\b/i.test(text),
      canRequest: hasExact(/^(follow|follow back|request to follow)$/i),
      labels: labels.slice(0, 24),
    };
  }

  function accessEvidence() {
    const match = allLines.find((line) =>
      /These posts are protected|Only approved followers|Requested|Request sent|Sign in|Log in|checkpoint|rate limit|too many requests|This account doesn't exist|Account suspended|You are blocked/i.test(
        line,
      ) || hasRateLimitSignal(line),
    );
    return match ? clean(match, 320) : null;
  }

  function hasRateLimitSignal(source) {
    return /rate limit exceeded|rate limited|too many requests|please wait a few minutes before you try again|temporarily blocked from|automated requests|unusual traffic|you have exceeded/i.test(
      source || "",
    );
  }

  function parsePostMetrics(value, container) {
    const source = `${value || ""} ${[...container.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") || "").join(" ")}`.replace(
      /\s+/g,
      " ",
    );
    const replyCount =
      source.match(/([\d.,]+\s*[KMB]?)\s+repl(?:y|ies)\b/i)?.[1] || source.match(/\bReplies?\s+([\d.,]+\s*[KMB]?)/i)?.[1] || null;
    const repostCount =
      source.match(/([\d.,]+\s*[KMB]?)\s+reposts?\b/i)?.[1] || source.match(/\bReposts?\s+([\d.,]+\s*[KMB]?)/i)?.[1] || null;
    const quoteCount = source.match(/([\d.,]+\s*[KMB]?)\s+quotes?/i)?.[1] || null;
    const likeCount = source.match(/([\d.,]+\s*[KMB]?)\s+likes?\b/i)?.[1] || source.match(/\bLikes?\s+([\d.,]+\s*[KMB]?)/i)?.[1] || null;
    const viewCount =
      source.match(/([\d.,]+\s*[KMB]?)\s+views?\b/i)?.[1] || source.match(/\b(?:Views?|analytics)\s+([\d.,]+\s*[KMB]?)/i)?.[1] || null;
    return {
      replyCount: replyCount ? clean(replyCount, 40) : null,
      repostCount: repostCount ? clean(repostCount, 40) : null,
      quoteCount: quoteCount ? clean(quoteCount, 40) : null,
      likeCount: likeCount ? clean(likeCount, 40) : null,
      viewCount: viewCount ? clean(viewCount, 40) : null,
    };
  }

  function boundedVisibleText(sourceLines) {
    const blocked = /^(home|search|explore|notifications|messages|profile|log in|sign in|sign up|get the app)$/i;
    const kept = [];
    for (const line of sourceLines) {
      const cleaned = trimTwitterChrome(line);
      if (!cleaned || blocked.test(cleaned)) continue;
      if (/^log in|^sign in|^sign up|premium|verified orgs|suggested for you/i.test(cleaned)) continue;
      kept.push(cleaned);
      if (kept.length >= 120) break;
    }
    return kept;
  }

  function hasVerifiedSignal() {
    return Boolean(document.querySelector('svg[aria-label="Verified account"], svg[aria-label="Verified"], [aria-label="Verified account"], [aria-label="Verified"]'));
  }

  function trimPostChrome(value) {
    return clean(value, 2200)
      .replace(/\b(?:Reply|Repost|Quote|Like|Share|Views?|Bookmarks?|Analytics)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function trimTwitterChrome(line) {
    let value = clean(line, 1200);
    const lower = value.toLowerCase();
    const markers = ["terms of service privacy policy", "help center", "download the x app", " © ", "don't miss what's happening"];
    const cut = markers
      .map((marker) => lower.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (typeof cut === "number") value = value.slice(0, cut);
    return value.trim();
  }

  function clean(value, max) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function lines(value) {
    return String(value || "")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function stripQuery(value) {
    try {
      const u = new URL(value, location.origin);
      return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return String(value || "");
    }
  }

  function isTwitterHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com";
  }

  function uniqueElements(elements) {
    return [...new Set(elements)].filter(Boolean);
  }

  function scrapeQualityForBrowser(items, targetPosts) {
    const total = Array.isArray(items) ? items.length : 0;
    return {
      targetPostCount: targetPosts,
      extractedCount: total,
      reachedItemCap: total >= targetPosts,
      postsWithText: items.filter((item) => Boolean(item.text || item.contentSeed || item.visibleText)).length,
      postsWithMedia: items.filter((item) => (item.mediaUrls || []).length > 0 || item.feedPhotoUrl).length,
      postsWithExternalLinks: items.filter((item) => (item.externalLinks || []).length > 0).length,
      postsWithVisibleCounters: items.filter((item) => item.likeCount || item.replyCount || item.repostCount || item.quoteCount || item.viewCount).length,
    };
  }

  function countByTabForBrowser(items) {
    return (items || []).reduce(
      (acc, item) => {
        const tab = item?.tab === "replies" ? "replies" : "posts";
        acc[tab] += 1;
        return acc;
      },
      { posts: 0, replies: 0 },
    );
  }
}

function scrapeQuality(items, targetPosts) {
  const total = Array.isArray(items) ? items.length : 0;
  return {
    targetPostCount: targetPosts,
    extractedCount: total,
    reachedItemCap: total >= targetPosts,
    postsWithText: items.filter((item) => Boolean(item.text || item.contentSeed || item.visibleText)).length,
    postsWithMedia: items.filter((item) => (item.mediaUrls || []).length > 0 || item.feedPhotoUrl).length,
    postsWithExternalLinks: items.filter((item) => (item.externalLinks || []).length > 0).length,
    postsWithVisibleCounters: items.filter((item) => item.likeCount || item.replyCount || item.repostCount || item.quoteCount || item.viewCount).length,
  };
}

function countByTab(items) {
  return (items || []).reduce(
    (acc, item) => {
      const tab = item?.tab === "replies" ? "replies" : "posts";
      acc[tab] += 1;
      return acc;
    },
    { posts: 0, replies: 0 },
  );
}

function clickFollowRequestButtonFromDom() {
  const candidates = [...document.querySelectorAll("button, div[role='button'], a[role='button']")];
  for (const el of candidates) {
    const label = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!/^(follow|follow back|request to follow)$/i.test(label)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    el.scrollIntoView?.({ block: "center", inline: "center" });
    el.click();
    return { clicked: true, label, clickedAt: new Date().toISOString() };
  }
  return { clicked: false, label: null, reason: "No visible Follow button found." };
}

function clickFollowConfirmButtonFromDom() {
  const dialogs = [...document.querySelectorAll('[role="dialog"], div[aria-modal="true"]')];
  for (const dialog of dialogs) {
    const buttons = [...dialog.querySelectorAll("button, div[role='button']")];
    for (const el of buttons) {
      const label = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/^follow$/i.test(label)) continue;
      el.click();
      return { clicked: true, label, clickedAt: new Date().toISOString() };
    }
  }
  return { clicked: false, label: null };
}
