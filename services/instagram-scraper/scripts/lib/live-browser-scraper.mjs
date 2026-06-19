import fs from "node:fs";
import puppeteer from "puppeteer-core";

const DEFAULT_BROWSER_URL = process.env.INSTAGRAM_BROWSER_URL || "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = Number(process.env.INSTAGRAM_PROFILE_SCRAPER_TIMEOUT_MS || 120_000);
const DEFAULT_MAX_POSTS = Number(process.env.INSTAGRAM_MAX_POSTS_PER_PROFILE || 1024);
const DEFAULT_SCROLL_PASSES = Number(process.env.INSTAGRAM_MAX_SCROLL_PASSES || 250);
const DEFAULT_STABLE_SCROLL_PASSES = Number(process.env.INSTAGRAM_STABLE_SCROLL_PASSES || 5);
const DEFAULT_SCROLL_ENGINE = process.env.INSTAGRAM_SCROLL_ENGINE === "v2" ? "v2" : "v1";
const DEFAULT_DETAIL_HYDRATION_LIMIT = Math.max(0, Math.min(24, Number(process.env.INSTAGRAM_DETAIL_HYDRATION_LIMIT || 0) || 0));

export async function scrapeInstagramProfile(profileUrl, options = {}) {
  return runInstagramProfileBrowser(profileUrl, {
    action: options.requestAccess ? "request_access" : "scrape",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

export async function requestInstagramProfileAccess(profileUrl, options = {}) {
  return runInstagramProfileBrowser(profileUrl, {
    action: "request_access",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

export async function checkInstagramProfileAccess(profileUrl, options = {}) {
  return runInstagramProfileBrowser(profileUrl, {
    action: "check_access",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

async function runInstagramProfileBrowser(profileUrl, options = {}) {
  const useLiveBrowser = process.env.INSTAGRAM_LIVE_BROWSER === "true";
  const browser = useLiveBrowser ? await connectBrowser() : await launchBrowser();
  let page;
  const maxPosts = Number(options.maxPosts || DEFAULT_MAX_POSTS);
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });
    await page.setUserAgent(
      process.env.INSTAGRAM_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    );
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await delay(4000);
    await dismissInstagramInterruption(page);
    if (options.action === "request_access") {
      let raw = await page.evaluate(extractInstagramProfileFromDom, { maxPosts });
      if (shouldClickFollowRequest(raw)) {
        const requestedAction = await clickFollowRequestButton(page);
        await delay(requestedAction.clicked ? 2500 : 1000);
        await dismissInstagramInterruption(page);
        raw = await page.evaluate(extractInstagramProfileFromDom, { maxPosts });
        raw.access = { ...raw.access, requestedAction };
      }
      if (!raw.access || raw.access.canScrapePosts || raw.access.state === "public_visible" || raw.access.state === "approved_visible") {
        const scrollMeta = await autoScroll(page, maxPosts);
        await delay(1200);
        return await extractProfileWithMeta(page, { maxPosts, scrollMeta });
      }
      return withScrapeMeta(raw, {
        requestedMaxPosts: maxPosts,
        returnedPosts: Array.isArray(raw?.recentPublicPosts) ? raw.recentPublicPosts.length : 0,
        scrollEngine: DEFAULT_SCROLL_ENGINE,
        scrollPasses: 0,
        stablePasses: 0,
        stopReason: raw?.access?.state || "access_not_visible",
        scrollStopReason: raw?.access?.state || "access_not_visible",
        detailHydrationLimit: DEFAULT_DETAIL_HYDRATION_LIMIT,
        detailHydratedPosts: 0,
      });
    }
    const scrollMeta = await autoScroll(page, maxPosts);
    await delay(1200);
    return await extractProfileWithMeta(page, { maxPosts, scrollMeta });
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (useLiveBrowser) await browser.disconnect();
    else await browser.close().catch(() => undefined);
  }
}

async function extractProfileWithMeta(page, { maxPosts, scrollMeta }) {
  let raw = await page.evaluate(extractInstagramProfileFromDom, { maxPosts });
  const detailLimit = Math.min(DEFAULT_DETAIL_HYDRATION_LIMIT, raw?.recentPublicPosts?.length || 0);
  let detailHydratedPosts = 0;
  if (detailLimit > 0 && raw?.access?.canScrapePosts === true) {
    const hydrated = await hydrateVisiblePostDetails(page, raw.recentPublicPosts.slice(0, detailLimit));
    detailHydratedPosts = hydrated.filter(Boolean).length;
    raw = {
      ...raw,
      recentPublicPosts: raw.recentPublicPosts.map((post, index) => (index < hydrated.length && hydrated[index] ? { ...post, ...hydrated[index] } : post)),
    };
  }
  return withScrapeMeta(raw, {
    ...scrollMeta,
    requestedMaxPosts: maxPosts,
    returnedPosts: Array.isArray(raw?.recentPublicPosts) ? raw.recentPublicPosts.length : 0,
    detailHydrationLimit: DEFAULT_DETAIL_HYDRATION_LIMIT,
    detailHydratedPosts,
    stopReason: stopReasonForRaw(raw, scrollMeta),
    scrollStopReason: stopReasonForRaw(raw, scrollMeta),
  });
}

function withScrapeMeta(raw, extra) {
  return {
    ...raw,
    scrapeMeta: {
      ...(raw?.scrapeMeta || {}),
      ...extra,
      accessState: raw?.access?.state || raw?.scrapeMeta?.accessState || null,
    },
  };
}

function stopReasonForRaw(raw, scrollMeta = {}) {
  if (raw?.access?.state === "rate_limited") return "rate_limited";
  if (raw?.access?.state === "login_required") return "login_required";
  if (raw?.access?.state === "checkpoint_required") return "checkpoint_required";
  if (raw?.scrapeMeta?.chromeError) return raw?.scrapeMeta?.httpErrorCode === "429" ? "rate_limited" : "chrome_error";
  if (raw?.scrapeMeta?.authwall) return "authwall";
  if (raw?.scrapeMeta?.notFound) return "not_found";
  return scrollMeta.stopReason || "unknown";
}

function shouldClickFollowRequest(raw) {
  const access = raw?.access || {};
  return access.state === "private_not_following" && access.canRequest === true && access.outgoingRequest !== true;
}

async function connectBrowser() {
  return puppeteer.connect({ browserURL: DEFAULT_BROWSER_URL, defaultViewport: null });
}

async function launchBrowser() {
  const executablePath = resolveChromePath();
  const userDataDir = process.env.PUPPETEER_USER_DATA_DIR || process.env.INSTAGRAM_USER_DATA_DIR;
  return puppeteer.launch({
    executablePath,
    userDataDir,
    headless: process.env.INSTAGRAM_PROFILE_SCRAPER_HEADLESS !== "false",
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

async function autoScroll(page, maxPosts) {
  if (DEFAULT_SCROLL_ENGINE === "v2") return autoScrollV2(page, maxPosts);
  return autoScrollV1(page, maxPosts);
}

async function autoScrollV1(page, maxPosts) {
  return await page.evaluate(
    async (limit, maxScrollPasses, stableLimit) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let previousHeight = 0;
      let stable = 0;
      let postCount = 0;
      let stopReason = "max_scroll_passes";
      let pass = 0;
      for (; pass < maxScrollPasses; pass += 1) {
        const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        window.scrollTo(0, height);
        await wait(800);
        const next = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        postCount = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].filter((link) =>
          /\/(?:p|reel)\/[^/]+/i.test(link.getAttribute("href") || ""),
        ).length;
        stable = next === previousHeight ? stable + 1 : 0;
        previousHeight = next;
        if (postCount >= limit) {
          stopReason = "limit_reached";
          break;
        }
        if (stable >= stableLimit) {
          stopReason = "stable_feed";
          break;
        }
      }
      window.scrollTo(0, 0);
      return {
        scrollEngine: "v1",
        requestedMaxPosts: limit,
        scrollPasses: pass,
        stablePasses: stable,
        returnedPostLinks: postCount,
        stopReason,
        scrollStopReason: stopReason,
        maxScrollPasses,
        stableLimit,
      };
    },
    maxPosts,
    DEFAULT_SCROLL_PASSES,
    DEFAULT_STABLE_SCROLL_PASSES,
  );
}

async function autoScrollV2(page, maxPosts) {
  return await page.evaluate(
    async (limit, maxScrollPasses, stableLimit) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const postLinks = () =>
        [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
          .map((link) => link.getAttribute("href") || "")
          .filter((href) => /\/(?:p|reel)\/[^/]+/i.test(href));
      const pageState = () => {
        const text = document.body.innerText || "";
        const url = location.href || "";
        const httpError = text.match(/\bHTTP ERROR\s+(\d{3})\b/i)?.[1] || null;
        return {
          rateLimited:
            httpError === "429" ||
            /try again later|please wait a few minutes|feedback required|temporarily blocked|too many requests/i.test(text),
          authwall: /\/accounts\/login|\/challenge/i.test(location.pathname) || /\bLog in to Instagram\b/i.test(text),
          chromeError: /^chrome-error:\/\//i.test(url) || /This page isn.t working|ERR_[A-Z_]+|\bHTTP ERROR\s+\d{3}\b/i.test(text),
        };
      };
      let previousHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      let previousCount = postLinks().length;
      let stable = 0;
      let pass = 0;
      let stopReason = previousCount >= limit ? "limit_reached" : "max_scroll_passes";

      for (; pass < maxScrollPasses && previousCount < limit; pass += 1) {
        const state = pageState();
        if (state.rateLimited) {
          stopReason = "rate_limited";
          break;
        }
        if (state.authwall) {
          stopReason = "authwall";
          break;
        }
        if (state.chromeError) {
          stopReason = "chrome_error";
          break;
        }

        window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
        await wait(900 + Math.min(stable * 350, 1600));
        const nextHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const nextCount = postLinks().length;

        if (nextCount >= limit) {
          previousCount = nextCount;
          stopReason = "limit_reached";
          break;
        }

        if (nextCount <= previousCount && nextHeight <= previousHeight) {
          stable += 1;
          if (stable % 2 === 1) {
            window.scrollBy(0, -Math.round(window.innerHeight * 0.8));
            await wait(450);
          }
          if (stable >= stableLimit) {
            stopReason = "stable_feed";
            previousCount = nextCount;
            break;
          }
        } else {
          stable = 0;
        }
        previousHeight = nextHeight;
        previousCount = nextCount;
      }

      window.scrollTo(0, 0);
      return {
        scrollEngine: "v2",
        requestedMaxPosts: limit,
        scrollPasses: pass,
        stablePasses: stable,
        returnedPostLinks: previousCount,
        stopReason,
        scrollStopReason: stopReason,
        maxScrollPasses,
        stableLimit,
      };
    },
    maxPosts,
    DEFAULT_SCROLL_PASSES,
    DEFAULT_STABLE_SCROLL_PASSES,
  );
}

async function hydrateVisiblePostDetails(page, posts) {
  const details = [];
  const profileUrl = page.url();
  for (const post of posts) {
    if (!post?.url) {
      details.push(null);
      continue;
    }
    try {
      await page.goto(post.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
      await delay(1200);
      details.push(await page.evaluate(extractInstagramPostDetailFromDom));
    } catch (error) {
      details.push({ detailError: error instanceof Error ? error.message : String(error) });
    }
  }
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS }).catch(() => undefined);
  return details;
}

async function dismissInstagramInterruption(page) {
  await page
    .evaluate(() => {
      const labels = /^(not now|not now\.|cancel|maybe later)$/i;
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

export function extractInstagramProfileFromDom(options = {}) {
  const maxPosts = Number(options.maxPosts || 1024);
  const text = document.body.innerText || "";
  const allLines = lines(text);
  const url = stripQuery(location.href);
  const username = profileUsernameFromPath(location.pathname);
  const title = document.title || "";
  const ogTitle = meta("property", "og:title") || meta("name", "twitter:title") || title;
  const ogDescription = meta("property", "og:description") || meta("name", "description") || "";
  const avatarUrl = meta("property", "og:image") || meta("name", "twitter:image") || null;
  const httpErrorCode = text.match(/\bHTTP ERROR\s+(\d{3})\b/i)?.[1] || null;
  const chromeError = /^chrome-error:\/\//i.test(location.href) || /This page isn.t working|ERR_[A-Z_]+|\bHTTP ERROR\s+\d{3}\b/i.test(text);
  const authwall =
    /\/accounts\/login|\/challenge/i.test(location.pathname) ||
    /^Login/i.test(title) ||
    /\bLog in to Instagram\b/i.test(text) && !username;
  const notFound = /Sorry, this page isn't available|Page Not Found/i.test(text);
  const isPrivate = /This (?:account|profile) is private/i.test(text);
  const parsedTitle = parseTitle(ogTitle, username);
  const parsedStats = parseStats(ogDescription) || parseStats(text);
  const externalUrl = firstExternalUrl();
  const bio = deriveBio(allLines, parsedTitle.displayName, username, externalUrl);
  const highlights = profileHighlights();
  const posts = recentPosts();
  const access = deriveAccessState(posts);

  return {
    username,
    profileUrl: username ? `https://www.instagram.com/${username}/` : url,
    displayName: parsedTitle.displayName,
    bio,
    avatarUrl,
    externalUrl,
    isVerified: hasVerifiedSignal(),
    isPrivate,
    stats: parsedStats,
    highlights,
    recentPublicPosts: posts,
    access,
    visibleProfileText: boundedVisibleText(allLines),
    scrapeMeta: {
      parser: "instagram-browser-dom-v2",
      title,
      url,
      authwall,
      notFound,
      chromeError,
      httpErrorCode,
      rateLimited: access.state === "rate_limited",
      accessState: access.state,
      lineCount: allLines.length,
    },
  };

  function meta(attr, key) {
    return document.querySelector(`meta[${attr}="${key}"]`)?.getAttribute("content")?.trim() || "";
  }

  function profileUsernameFromPath(pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return "";
    const candidate = parts[0].toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(candidate) ? candidate : "";
  }

  function parseTitle(raw, fallbackUsername) {
    const compact = String(raw || "").replace(/\s+/g, " ").trim();
    const match = compact.match(/^(.*?)\s+\(@([a-z0-9._]+)\)/i);
    if (match) return { displayName: clean(match[1], 120), username: match[2].toLowerCase() };
    const at = compact.match(/@([a-z0-9._]+)/i);
    return { displayName: fallbackUsername ? clean(compact.replace(/Instagram.*$/i, ""), 120) || null : null, username: at?.[1]?.toLowerCase() || fallbackUsername };
  }

  function parseStats(raw) {
    const s = String(raw || "").replace(/\s+/g, " ");
    const match = s.match(/([\d.,]+\s*[KMB]?)\s+Followers,\s*([\d.,]+\s*[KMB]?)\s+Following,\s*([\d.,]+\s*[KMB]?)\s+Posts/i);
    if (!match) return { posts: null, followers: null, following: null };
    return { followers: clean(match[1], 40), following: clean(match[2], 40), posts: clean(match[3], 40) };
  }

  function firstExternalUrl() {
    const anchors = [...document.querySelectorAll("main a[href], article a[href], header a[href]")];
    for (const a of anchors) {
      const href = a.href || "";
      if (!/^https?:\/\//i.test(href)) continue;
      try {
        const u = new URL(href);
        if (!u.hostname.endsWith("instagram.com")) return stripQuery(href);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function deriveBio(sourceLines, displayName, handle, link) {
    const blocked = new Set(
      [
        displayName,
        handle,
        `@${handle}`,
        "posts",
        "followers",
        "following",
        "follow",
        "message",
        "log in",
        "sign up",
        link,
      ]
        .filter(Boolean)
        .map((item) => String(item).toLowerCase()),
    );
    const kept = [];
    for (const line of sourceLines) {
      const cleaned = trimInstagramFooter(line);
      if (!cleaned) continue;
      const lower = cleaned.toLowerCase();
      if (blocked.has(lower)) continue;
      if (/^\d[\d.,kmb]*$/i.test(cleaned)) continue;
      if (/followers|following|posts|followed by|suggested for you/i.test(cleaned)) continue;
      if (/^see instagram photos and videos/i.test(cleaned)) continue;
      if (/^log in|^sign up|meta verified|threads|already follow/i.test(cleaned)) continue;
      if (/This (?:account|profile) is private/i.test(cleaned)) continue;
      if (/^(highlights|meta|about|blog|jobs|help|api|privacy|terms|locations|popular)$/i.test(cleaned)) continue;
      if (/^(english|afrikaans|arabic|deutsch|espa.ol|fran.ais|italiano|bahasa|norsk|nederlands|polski|portugu.s)/i.test(cleaned)) continue;
      kept.push(cleaned);
      if (kept.join(" ").length > 500) break;
    }
    return trimInstagramFooter(kept.join(" ")).trim().slice(0, 500) || null;
  }

  function trimInstagramFooter(line) {
    let value = clean(line, 1000);
    const lower = value.toLowerCase();
    const markers = [
      "highlights meta about blog jobs help api privacy terms",
      " highlights meta about blog jobs help api privacy terms",
      "meta about blog jobs help api privacy terms",
      " meta about blog jobs help api privacy terms",
      "locations popular instagram lite",
      " locations popular instagram lite",
      "instagram lite",
      " instagram lite",
      "meta ai contact uploading and non-users",
      " meta ai contact uploading and non-users",
      "english (uk)",
      " english (uk)",
      "see photos, videos and",
      " see photos, videos and",
      " © ",
    ];
    const cut = markers
      .map((marker) => lower.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (typeof cut === "number") value = value.slice(0, cut);
    return value.trim();
  }

  function recentPosts() {
    const out = [];
    const seen = new Set();
    const links = [...document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"], article a[href*="/p/"], article a[href*="/reel/"]')];
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const postPath = instagramPostPathFromHref(href);
      if (!postPath) continue;
      const kind = postPath.kind;
      const postUrl = new URL(postPath.path, location.origin).href.replace(/\/$/, "");
      if (seen.has(postUrl)) continue;
      seen.add(postUrl);
      const img = link.querySelector("img");
      const aria = clean(link.getAttribute("aria-label") || link.getAttribute("title") || "", 300) || null;
      const caption = clean(img?.alt || aria || "", 500) || null;
      const tileText = clean(link.innerText || link.textContent || "", 300) || null;
      const metrics = parsePostMetrics(tileText || aria || "");
      const cdnUrls = mediaUrlsForLink(link, img);
      out.push({
        url: postUrl,
        kind,
        position: out.length + 1,
        caption,
        thumbnailUrl: img?.src || null,
        cdnUrls,
        alt: clean(img?.alt || "", 500) || null,
        ariaLabel: aria,
        isCarousel: Boolean(link.querySelector('svg[aria-label="Carousel"], [aria-label="Carousel"]')),
        isVideo: kind === "reel" || Boolean(link.querySelector('svg[aria-label="Video"], [aria-label="Video"]')),
        timestamp: clean(link.querySelector("time")?.getAttribute("datetime") || "", 80) || null,
        visibleText: tileText,
        ...metrics,
      });
      if (out.length >= maxPosts) break;
    }
    return out;
  }

  function mediaUrlsForLink(link, img) {
    const urls = [];
    const push = (value) => {
      const src = clean(value, 1200);
      if (/^https?:\/\//i.test(src) && !urls.includes(src)) urls.push(src);
    };
    push(img?.src || "");
    const srcset = img?.getAttribute?.("srcset") || "";
    for (const candidate of srcset.split(",")) {
      push(candidate.trim().split(/\s+/)[0] || "");
    }
    for (const nested of link.querySelectorAll("video[src], source[src]")) {
      push(nested.getAttribute("src") || "");
    }
    return urls.slice(0, 12);
  }

  function instagramPostPathFromHref(rawHref) {
    try {
      const pathname = new URL(rawHref, location.origin).pathname;
      const parts = pathname.split("/").filter(Boolean);
      const markerIndex = parts.findIndex((part) => part === "p" || part === "reel");
      if (markerIndex < 0 || !parts[markerIndex + 1]) return null;
      const marker = parts[markerIndex];
      return { kind: marker === "reel" ? "reel" : "post", path: `/${marker}/${parts[markerIndex + 1]}/` };
    } catch {
      return null;
    }
  }

  function profileHighlights() {
    const out = [];
    const seen = new Set();
    const candidates = [
      ...document.querySelectorAll('a[href*="/stories/highlights/"], a[href*="/s/"], div[role="button"], button'),
    ];
    for (const el of candidates) {
      const textValue = clean(el.innerText || el.textContent || el.getAttribute("aria-label") || "", 120);
      const img = el.querySelector?.("img");
      const imageAlt = clean(img?.alt || "", 120);
      const title = textValue || imageAlt;
      if (!title) continue;
      if (/^(follow|message|posts|followers|following|grid|tagged|home|search|create|notifications)$/i.test(title)) continue;
      if (/log in|sign up|switch|more options|profile picture/i.test(title)) continue;
      const href = el.getAttribute?.("href");
      const url = href ? new URL(href, location.origin).href : null;
      const key = `${title.toLowerCase()}|${url || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title,
        url,
        thumbnailUrl: img?.src || null,
      });
      if (out.length >= 24) break;
    }
    return out;
  }

  function deriveAccessState(posts) {
    const relationship = relationshipSignals();
    const checkpoint = /checkpoint|challenge|confirm it's you|help us confirm/i.test(text) || /\/challenge/i.test(location.pathname);
    const loginRequired = authwall && !checkpoint;
    const rateLimited =
      httpErrorCode === "429" ||
      /try again later|please wait a few minutes|feedback required|temporarily blocked|too many requests/i.test(text);
    const blocked = (chromeError || /user not found|profile isn't available|restricted|blocked/i.test(text)) && !notFound;
    const canScrapePosts = posts.length > 0 && !authwall && !notFound && !rateLimited && !chromeError;
    let state = "public_visible";
    let reason = null;

    if (checkpoint) {
      state = "checkpoint_required";
      reason = "Instagram requires a manual checkpoint in the VM browser.";
    } else if (loginRequired) {
      state = "login_required";
      reason = "Instagram requires the VM browser to log in.";
    } else if (rateLimited) {
      state = "rate_limited";
      reason = "Instagram asked the VM browser session to slow down.";
    } else if (notFound) {
      state = "not_found";
      reason = "Instagram says this profile is not available.";
    } else if (blocked) {
      state = "blocked";
      reason = "Instagram did not allow this session to view the profile.";
    } else if (isPrivate && relationship.outgoingRequest) {
      state = "pending_approval";
      reason = "Follow request is pending owner approval.";
    } else if (isPrivate && relationship.canRequest) {
      state = "private_not_following";
      reason = "Profile is private and the VM account is not following it.";
    } else if (isPrivate && canScrapePosts) {
      state = "approved_visible";
      reason = "Private profile is visible to the VM account.";
    } else if (isPrivate) {
      state = relationship.following ? "approved_visible" : "private_not_following";
      reason = relationship.following ? "VM account appears to follow this profile." : "Profile is private.";
    }

    return {
      state,
      canScrapePosts,
      isPrivate,
      following: relationship.following || (isPrivate && canScrapePosts),
      outgoingRequest: relationship.outgoingRequest,
      canRequest: isPrivate && relationship.canRequest && !relationship.outgoingRequest,
      reason,
      evidenceText: accessEvidence(),
      checkedAt: new Date().toISOString(),
    };
  }

  function relationshipSignals() {
    const labels = [...document.querySelectorAll("button, div[role='button'], a[role='button']")]
      .map((el) => clean(el.innerText || el.textContent || el.getAttribute("aria-label") || "", 80))
      .filter(Boolean);
    const hasExact = (pattern) => labels.some((label) => pattern.test(label));
    return {
      following: hasExact(/^(following|message)$/i),
      outgoingRequest: hasExact(/^requested$/i) || /\bRequested\b/i.test(text),
      canRequest: hasExact(/^(follow|follow back)$/i),
      labels: labels.slice(0, 20),
    };
  }

  function accessEvidence() {
    const priority = allLines.find((line) => /HTTP ERROR|try again later|please wait a few minutes|feedback required|temporarily blocked|too many requests/i.test(line));
    if (priority) return clean(priority, 300);
    const match = allLines.find((line) =>
      /This (?:account|profile) is private|Follow to see|Requested|Log in|checkpoint|try again later|HTTP ERROR|This page isn.t working|Sorry, this page/i.test(line),
    );
    return match ? clean(match, 300) : null;
  }

  function parsePostMetrics(value) {
    const s = String(value || "").replace(/\s+/g, " ");
    const likes = s.match(/([\d.,]+\s*[KMB]?)\s+likes?/i)?.[1] || null;
    const comments = s.match(/([\d.,]+\s*[KMB]?)\s+comments?/i)?.[1] || null;
    return {
      likes: likes ? clean(likes, 40) : null,
      comments: comments ? clean(comments, 40) : null,
    };
  }

  function boundedVisibleText(sourceLines) {
    const blocked = /^(home|search|explore|reels|messages|notifications|create|profile|more|threads)$/i;
    const kept = [];
    for (const line of sourceLines) {
      const cleaned = trimInstagramFooter(line);
      if (!cleaned || blocked.test(cleaned)) continue;
      if (/^log in|^sign up|meta verified|suggested for you/i.test(cleaned)) continue;
      kept.push(cleaned);
      if (kept.length >= 80) break;
    }
    return kept;
  }

  function hasVerifiedSignal() {
    return Boolean(document.querySelector('svg[aria-label="Verified"], [aria-label="Verified"]'));
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
      return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "/");
    } catch {
      return String(value || "");
    }
  }
}

export function extractInstagramPostDetailFromDom() {
  const clean = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const text = document.body.innerText || "";
  const meta = (attr, key) => document.querySelector(`meta[${attr}="${key}"]`)?.getAttribute("content")?.trim() || "";
  const caption = meta("property", "og:description") || meta("name", "description") || "";
  const timestamp = document.querySelector("time[datetime]")?.getAttribute("datetime") || null;
  return {
    detailCaption: clean(caption, 1000) || null,
    detailTimestamp: clean(timestamp, 80) || null,
    detailVisibleText: clean(text, 1200) || null,
    detailSource: "post_page_dom",
  };
}

export async function inspectInstagramSession() {
  if (process.env.INSTAGRAM_LIVE_BROWSER !== "true") {
    return { inspected: false, reason: "live_browser_disabled" };
  }
  const browser = await connectBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    await delay(1000);
    const cookies = await page.cookies("https://www.instagram.com/");
    const cookieNames = new Set(cookies.map((cookie) => String(cookie.name || "").toLowerCase()));
    const pageState = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        const httpErrorCode = text.match(/\bHTTP ERROR\s+(\d{3})\b/i)?.[1] || null;
        const chromeError = /^chrome-error:\/\//i.test(location.href) || /This page isn.t working|ERR_[A-Z_]+|\bHTTP ERROR\s+\d{3}\b/i.test(text);
        const checkpoint = /checkpoint|challenge|confirm it's you|help us confirm/i.test(text) || /\/challenge/i.test(location.pathname);
        const loginRequired = /\/accounts\/login/i.test(location.pathname) || /\bLog in to Instagram\b/i.test(text);
        const rateLimited =
          httpErrorCode === "429" ||
          /try again later|please wait a few minutes|feedback required|temporarily blocked|too many requests/i.test(text);
        return {
          url: location.href,
          title: document.title || null,
          httpErrorCode,
          chromeError,
          checkpoint,
          loginRequired,
          rateLimited,
        };
      })
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    const hasSessionId = cookieNames.has("sessionid");
    const hasDsUserId = cookieNames.has("ds_user_id");
    return {
      inspected: true,
      hasSessionId,
      hasDsUserId,
      usableForDeepScrape: Boolean(hasSessionId && !pageState.checkpoint && !pageState.loginRequired && !pageState.rateLimited && !pageState.chromeError),
      requiresHumanLogin: Boolean(!hasSessionId || pageState.checkpoint || pageState.loginRequired),
      ...pageState,
    };
  } finally {
    if (page) await page.close().catch(() => undefined);
    await browser.disconnect();
  }
}

function clickFollowRequestButtonFromDom() {
  const candidates = [...document.querySelectorAll("button, div[role='button'], a[role='button']")];
  for (const el of candidates) {
    const label = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!/^(follow|follow back)$/i.test(label)) continue;
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
