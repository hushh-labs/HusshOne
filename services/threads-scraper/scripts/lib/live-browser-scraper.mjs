import fs from "node:fs";
import puppeteer from "puppeteer-core";

const DEFAULT_BROWSER_URL = process.env.THREADS_BROWSER_URL || "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = Number(process.env.THREADS_PROFILE_SCRAPER_TIMEOUT_MS || 120_000);
const DEFAULT_MAX_POSTS = Number(process.env.THREADS_MAX_POSTS_PER_PROFILE || 1024);

export async function scrapeThreadsProfile(profileUrl, options = {}) {
  return runThreadsProfileBrowser(profileUrl, {
    action: options.requestAccess ? "request_access" : "scrape",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

export async function requestThreadsProfileAccess(profileUrl, options = {}) {
  return runThreadsProfileBrowser(profileUrl, {
    action: "request_access",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

export async function checkThreadsProfileAccess(profileUrl, options = {}) {
  return runThreadsProfileBrowser(profileUrl, {
    action: "check_access",
    maxPosts: Number(options.maxPosts || DEFAULT_MAX_POSTS),
  });
}

async function runThreadsProfileBrowser(profileUrl, options = {}) {
  const useLiveBrowser = process.env.THREADS_LIVE_BROWSER === "true";
  const browser = useLiveBrowser ? await connectBrowser() : await launchBrowser();
  let page;
  const maxPosts = Number(options.maxPosts || DEFAULT_MAX_POSTS);
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900 });
    await page.setUserAgent(
      process.env.THREADS_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    );
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await delay(4000);
    await dismissThreadsInterruption(page);
    if (options.action === "request_access") {
      let raw = await page.evaluate(extractThreadsProfileFromDom, { maxPosts });
      if (shouldClickFollowRequest(raw)) {
        const requestedAction = await clickFollowRequestButton(page);
        await delay(requestedAction.clicked ? 2500 : 1000);
        await dismissThreadsInterruption(page);
        raw = await page.evaluate(extractThreadsProfileFromDom, { maxPosts });
        raw.access = { ...raw.access, requestedAction };
      }
      if (!raw.access || raw.access.canScrapePosts || raw.access.state === "public_visible" || raw.access.state === "approved_visible") {
        const scrolledPosts = await autoScroll(page, maxPosts);
        await delay(1200);
        return mergeScrolledPosts(await page.evaluate(extractThreadsProfileFromDom, { maxPosts }), scrolledPosts, maxPosts);
      }
      return raw;
    }
    const scrolledPosts = await autoScroll(page, maxPosts);
    await delay(1200);
    return mergeScrolledPosts(await page.evaluate(extractThreadsProfileFromDom, { maxPosts }), scrolledPosts, maxPosts);
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (useLiveBrowser) await browser.disconnect();
    else await browser.close().catch(() => undefined);
  }
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
  const userDataDir = process.env.PUPPETEER_USER_DATA_DIR || process.env.THREADS_USER_DATA_DIR;
  return puppeteer.launch({
    executablePath,
    userDataDir,
    headless: process.env.THREADS_PROFILE_SCRAPER_HEADLESS !== "false",
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
  const target = Math.max(1, Math.min(1024, Number(maxPosts) || DEFAULT_MAX_POSTS));
  const seen = new Map();
  const collect = async () => {
    const raw = await page.evaluate(extractThreadsProfileFromDom, { maxPosts: target });
    for (const post of raw?.recentThreads || []) {
      if (post?.url && !seen.has(post.url)) seen.set(post.url, post);
    }
    return raw;
  };

  await collect();
  let previousHeight = 0;
  let stable = 0;
  let previousCount = seen.size;
  for (let pass = 0; pass < 180; pass += 1) {
    const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    await page.evaluate(() => window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)));
    await delay(900);
    await collect();
    const nextHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const grew = seen.size > previousCount || nextHeight > previousHeight || nextHeight > height;
    stable = grew ? 0 : stable + 1;
    previousHeight = nextHeight;
    previousCount = seen.size;
    if (seen.size >= target) break;
    if (stable >= 4) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  return [...seen.values()].slice(0, target);
}

function mergeScrolledPosts(raw, scrolledPosts, maxPosts) {
  const target = Math.max(1, Math.min(1024, Number(maxPosts) || DEFAULT_MAX_POSTS));
  const posts = [];
  const seen = new Set();
  for (const post of [...(scrolledPosts || []), ...(raw?.recentThreads || [])]) {
    if (!post?.url || seen.has(post.url)) continue;
    seen.add(post.url);
    posts.push({ ...post, position: posts.length + 1 });
    if (posts.length >= target) break;
  }
  raw.recentThreads = posts;
  const blockedStates = new Set(["login_required", "checkpoint_required", "rate_limited", "blocked", "not_found"]);
  if (raw.access && posts.length > 0 && !blockedStates.has(raw.access.state)) {
    raw.access = { ...raw.access, canScrapePosts: true };
  }
  if (raw.scrapeMeta) raw.scrapeMeta.accessState = raw.access?.state || raw.scrapeMeta.accessState;
  return raw;
}

async function dismissThreadsInterruption(page) {
  await page
    .evaluate(() => {
      const labels = /^(not now|not now\.|cancel|maybe later|close)$/i;
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

export function extractThreadsProfileFromDom(options = {}) {
  const maxPosts = Math.max(1, Math.min(1024, Number(options.maxPosts || 1024)));
  const text = document.body.innerText || document.body.textContent || "";
  const allLines = lines(text);
  const url = stripQuery(location.href);
  const username = profileUsernameFromPath(location.pathname);
  const title = document.title || "";
  const ogTitle = meta("property", "og:title") || meta("name", "twitter:title") || title;
  const ogDescription = meta("property", "og:description") || meta("name", "description") || "";
  const avatarUrl = meta("property", "og:image") || meta("name", "twitter:image") || null;
  const authwall =
    /\/login|\/accounts|\/challenge/i.test(location.pathname) ||
    /^Log in/i.test(title) ||
    (/\bLog in to Threads\b|\bLog in or sign up\b/i.test(text) && !username);
  const notFound = /This page isn't available|Page Not Found|Profile not found|Sorry, this profile isn't available/i.test(text);
  const isPrivate = /This (?:profile|account) is private|Only approved followers can see|private profile/i.test(text);
  const parsedTitle = parseTitle(ogTitle, username);
  const parsedStats = parseStats(ogDescription) || parseStats(text);
  const externalUrl = firstExternalUrl();
  const bio = deriveBio(allLines, ogDescription, parsedTitle.displayName, username, externalUrl);
  const posts = recentThreads();
  const access = deriveAccessState(posts);
  const quality = scrapeQuality(posts, maxPosts);

  return {
    username,
    profileUrl: username ? `https://www.threads.com/@${username}` : url,
    displayName: parsedTitle.displayName,
    bio,
    avatarUrl,
    externalUrl,
    isVerified: hasVerifiedSignal(),
    isPrivate,
    stats: parsedStats,
    recentThreads: posts,
    access,
    visibleProfileText: boundedVisibleText(allLines),
    scrapeMeta: {
      parser: "threads-browser-dom-v1",
      title,
      url,
      authwall,
      notFound,
      accessState: access.state,
      lineCount: allLines.length,
      ...quality,
    },
  };

  function meta(attr, key) {
    return document.querySelector(`meta[${attr}="${key}"]`)?.getAttribute("content")?.trim() || "";
  }

  function profileUsernameFromPath(pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return "";
    const segment = parts[0];
    if (!segment.startsWith("@")) return "";
    const candidate = segment.slice(1).toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(candidate) ? candidate : "";
  }

  function parseTitle(raw, fallbackUsername) {
    const compact = String(raw || "").replace(/\s+/g, " ").trim();
    const match = compact.match(/^(.*?)\s+\(@([a-z0-9._]+)\)/i);
    if (match) return { displayName: clean(match[1], 120), username: match[2].toLowerCase() };
    const at = compact.match(/@([a-z0-9._]+)/i);
    return {
      displayName: fallbackUsername ? clean(compact.replace(/\s*[•-]\s*Threads.*$/i, "").replace(/\s+on Threads.*$/i, ""), 120) || null : null,
      username: at?.[1]?.toLowerCase() || fallbackUsername,
    };
  }

  function parseStats(raw) {
    const s = String(raw || "").replace(/\s+/g, " ");
    const followers = s.match(/([\d.,]+\s*[KMB]?)\s+Followers?/i)?.[1] || null;
    const threads = s.match(/([\d.,]+\s*[KMB]?)\s+Threads?/i)?.[1] || null;
    const following = s.match(/([\d.,]+\s*[KMB]?)\s+Following/i)?.[1] || null;
    if (!followers && !threads && !following) return { followers: null, threads: null, following: null };
    return {
      followers: followers ? clean(followers, 40) : null,
      threads: threads ? clean(threads, 40) : null,
      following: following ? clean(following, 40) : null,
    };
  }

  function firstExternalUrl() {
    const anchors = [...document.querySelectorAll("main a[href], article a[href], header a[href]")];
    for (const a of anchors) {
      const href = a.href || "";
      if (!/^https?:\/\//i.test(href)) continue;
      try {
        const u = new URL(href);
        if (!u.hostname.endsWith("threads.com") && !u.hostname.endsWith("threads.net")) return stripQuery(href);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function deriveBio(sourceLines, description, displayName, handle, link) {
    const fromDescription = descriptionBio(description);
    if (fromDescription) return fromDescription;
    const blocked = new Set(
      [
        displayName,
        handle,
        `@${handle}`,
        "threads",
        "followers",
        "following",
        "follow",
        "message",
        "reply",
        "repost",
        "like",
        "log in",
        "sign up",
        link,
      ]
        .filter(Boolean)
        .map((item) => String(item).toLowerCase()),
    );
    const kept = [];
    for (const line of sourceLines) {
      const cleaned = trimThreadsFooter(line);
      if (!cleaned) continue;
      const lower = cleaned.toLowerCase();
      if (blocked.has(lower)) continue;
      if (/^\d[\d.,kmb]*$/i.test(cleaned)) continue;
      if (/followers|following|threads|followed by|suggested for you/i.test(cleaned)) continue;
      if (/^log in|^sign up|meta verified|already follow|continue with/i.test(cleaned)) continue;
      if (/This (?:account|profile) is private/i.test(cleaned)) continue;
      if (/^(home|search|activity|profile|about|help|privacy|terms)$/i.test(cleaned)) continue;
      kept.push(cleaned);
      if (kept.join(" ").length > 500) break;
    }
    return trimThreadsFooter(kept.join(" ")).trim().slice(0, 500) || null;
  }

  function descriptionBio(description) {
    const parts = String(description || "")
      .split(/[•|]/)
      .map((part) => clean(part, 500))
      .filter(Boolean)
      .filter((part) => !/^[\d.,]+\s*[KMB]?\s+(followers?|threads?|following)$/i.test(part));
    const value = parts.join(" ").trim();
    return value ? value.slice(0, 500) : null;
  }

  function trimThreadsFooter(line) {
    let value = clean(line, 1000);
    const lower = value.toLowerCase();
    const markers = [
      "about help privacy terms",
      "help privacy terms",
      "log in to threads",
      "get the app",
      "threads from instagram",
      " © ",
    ];
    const cut = markers
      .map((marker) => lower.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (typeof cut === "number") value = value.slice(0, cut);
    return value.trim();
  }

  function recentThreads() {
    const out = [];
    const seen = new Set();
    const links = [...document.querySelectorAll('main a[href*="/post/"], article a[href*="/post/"]')];
    for (const link of links) {
      const postPath = threadsPostPathFromHref(link.getAttribute("href") || "");
      if (!postPath) continue;
      const postUrl = new URL(postPath, location.origin).href.replace(/\/$/, "");
      if (seen.has(postUrl)) continue;
      seen.add(postUrl);
      const container = link.closest("article") || link.closest("[role='article']") || link.closest("div") || link;
      const visibleText = clean(container.innerText || container.textContent || link.getAttribute("aria-label") || "", 1200) || null;
      const metrics = parseThreadMetrics(visibleText || "");
      const mediaUrls = mediaUrlsForContainer(container);
      const feedPhotoUrl = mediaUrls[0] || null;
      const externalLinks = externalLinksForContainer(container, postUrl);
      const textValue = deriveThreadText(container, link, visibleText);
      out.push({
        url: postUrl,
        position: out.length + 1,
        text: textValue,
        contentSeed: buildContentSeed(textValue, visibleText, externalLinks),
        timestamp: clean(container.querySelector("time")?.getAttribute("datetime") || container.querySelector("time")?.getAttribute("title") || "", 80) || null,
        mediaUrls,
        thumbnailUrl: feedPhotoUrl,
        feedPhotoUrl,
        externalLinks,
        visibleText,
        visibleLabels: visibleLabelsForContainer(container),
        ...metrics,
      });
      if (out.length >= maxPosts) break;
    }
    return out;
  }

  function scrapeQuality(posts, targetPosts) {
    const total = Array.isArray(posts) ? posts.length : 0;
    return {
      targetPostCount: targetPosts,
      extractedThreadCount: total,
      reachedPostCap: total >= targetPosts,
      postsWithText: posts.filter((post) => Boolean(post.text || post.contentSeed || post.visibleText)).length,
      postsWithMedia: posts.filter((post) => (post.mediaUrls || []).length > 0 || post.feedPhotoUrl).length,
      postsWithExternalLinks: posts.filter((post) => (post.externalLinks || []).length > 0).length,
      postsWithVisibleCounters: posts.filter((post) => post.likeCount || post.replyCount || post.repostCount || post.quoteCount).length,
    };
  }

  function deriveThreadText(container, link, visibleText) {
    const aria = clean(link.getAttribute("aria-label") || link.getAttribute("title") || "", 600);
    const imageAlt = clean(container.querySelector("img[alt]")?.getAttribute("alt") || "", 600);
    const value = visibleText || aria || imageAlt;
    if (!value) return null;
    return trimThreadChrome(value).slice(0, 1200) || null;
  }

  function buildContentSeed(textValue, visibleText, externalLinks) {
    const seed = [textValue, visibleText, ...(externalLinks || [])].filter(Boolean).join(" ");
    return clean(seed, 1500) || null;
  }

  function trimThreadChrome(value) {
    return clean(value, 1600)
      .replace(/\b(?:Like|Reply|Repost|Share|Send|Views?)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function mediaUrlsForContainer(container) {
    const urls = [];
    const push = (value) => {
      const src = clean(value, 1200);
      if (/^https?:\/\//i.test(src) && !urls.includes(src)) urls.push(src);
    };
    for (const img of container.querySelectorAll("img[src]")) {
      push(img.getAttribute("src") || "");
      const srcset = img.getAttribute("srcset") || "";
      for (const candidate of srcset.split(",")) push(candidate.trim().split(/\s+/)[0] || "");
    }
    for (const nested of container.querySelectorAll("video[src], source[src]")) push(nested.getAttribute("src") || "");
    return urls.slice(0, 12);
  }

  function externalLinksForContainer(container, selfUrl) {
    const urls = [];
    for (const a of container.querySelectorAll("a[href]")) {
      const href = a.href || "";
      if (!/^https?:\/\//i.test(href)) continue;
      try {
        const u = new URL(href);
        if (u.href.replace(/\/$/, "") === selfUrl) continue;
        if (u.hostname.endsWith("threads.com") || u.hostname.endsWith("threads.net")) continue;
        const cleanUrl = stripQuery(href);
        if (!urls.includes(cleanUrl)) urls.push(cleanUrl);
      } catch {
        /* ignore */
      }
      if (urls.length >= 8) break;
    }
    return urls;
  }

  function visibleLabelsForContainer(container) {
    return lines(container.innerText || container.textContent || "")
      .map((line) => clean(line, 120))
      .filter(Boolean)
      .slice(0, 24);
  }

  function threadsPostPathFromHref(rawHref) {
    try {
      const pathname = new URL(rawHref, location.origin).pathname;
      const parts = pathname.split("/").filter(Boolean);
      if (!parts[0]?.startsWith("@") || parts[1] !== "post" || !parts[2]) return null;
      return `/${parts[0]}/post/${parts[2]}`;
    } catch {
      return null;
    }
  }

  function deriveAccessState(posts) {
    const relationship = relationshipSignals();
    const checkpoint = /checkpoint|challenge|confirm it's you|help us confirm/i.test(text) || /\/challenge/i.test(location.pathname);
    const loginRequired = authwall && !checkpoint;
    const rateLimited = /try again later|please wait a few minutes|temporarily blocked|rate limit|too many requests/i.test(text);
    const blocked = /restricted|blocked|not available/i.test(text) && !notFound;
    const canScrapePosts = posts.length > 0 && !authwall && !notFound && !rateLimited;
    let state = "public_visible";
    let reason = null;

    if (checkpoint) {
      state = "checkpoint_required";
      reason = "Threads requires a manual checkpoint in the VM browser.";
    } else if (loginRequired) {
      state = "login_required";
      reason = "Threads requires the VM browser to log in.";
    } else if (rateLimited) {
      state = "rate_limited";
      reason = "Threads asked the session to slow down.";
    } else if (notFound) {
      state = "not_found";
      reason = "Threads says this profile is not available.";
    } else if (blocked) {
      state = "blocked";
      reason = "Threads did not allow this session to view the profile.";
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
      outgoingRequest: hasExact(/^(requested|request sent|pending)$/i) || /\bRequested\b|\bRequest sent\b/i.test(text),
      canRequest: hasExact(/^(follow|follow back|request to follow)$/i),
      labels: labels.slice(0, 20),
    };
  }

  function accessEvidence() {
    const match = allLines.find((line) =>
      /This (?:account|profile) is private|Only approved followers|Follow to see|Requested|Request sent|Log in|checkpoint|try again later|This page isn't available/i.test(line),
    );
    return match ? clean(match, 300) : null;
  }

  function parseThreadMetrics(value) {
    const s = String(value || "").replace(/\s+/g, " ");
    const likeCount = s.match(/([\d.,]+\s*[KMB]?)\s+likes?/i)?.[1] || null;
    const replyCount = s.match(/([\d.,]+\s*[KMB]?)\s+repl(?:y|ies)/i)?.[1] || null;
    const repostCount = s.match(/([\d.,]+\s*[KMB]?)\s+reposts?/i)?.[1] || null;
    const quoteCount = s.match(/([\d.,]+\s*[KMB]?)\s+quotes?/i)?.[1] || null;
    return {
      likeCount: likeCount ? clean(likeCount, 40) : null,
      replyCount: replyCount ? clean(replyCount, 40) : null,
      repostCount: repostCount ? clean(repostCount, 40) : null,
      quoteCount: quoteCount ? clean(quoteCount, 40) : null,
    };
  }

  function boundedVisibleText(sourceLines) {
    const blocked = /^(home|search|activity|profile|log in|sign up|get the app)$/i;
    const kept = [];
    for (const line of sourceLines) {
      const cleaned = trimThreadsFooter(line);
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
      return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return String(value || "");
    }
  }
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
