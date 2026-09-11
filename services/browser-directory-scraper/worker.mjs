import puppeteer from "puppeteer-core";
import { VERTICAL_CONFIG, cleanText, domainFor, extractJsonLd, jsonLdToObservation, normalizeObservation } from "./app.mjs";
import { claimTask, close, completeTask, failTask, heartbeat, requeueExpired, upsertObservation } from "./db.mjs";

const workerId = process.env.WORKER_ID || "browser-01";
const vertical = process.env.WORKER_VERTICAL || "all";
const cdpPort = Number(process.env.CDP_PORT || 9222);
const profileDir = process.env.WORKER_PROFILE_DIR || "";
const maxResultPages = Math.max(1, Math.min(8, Number(process.env.MAX_RESULT_PAGES || 5)));
const leaseMinutes = Math.max(3, Number(process.env.TASK_LEASE_MINUTES || 10));
const gapMs = Math.max(1000, Number(process.env.WORKER_GAP_MS || 4000));
const timeoutMs = Math.max(20_000, Number(process.env.PAGE_TIMEOUT_MS || 45_000));
let stopping = false;
let currentTask = null;
let currentError = null;

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

async function run() {
  await requeueExpired();
  await heartbeat(workerId, { vertical, cdpPort, profileDir, status: "starting", leaseMinutes });
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null });
  const timer = setInterval(() => heartbeat(workerId, { vertical, cdpPort, profileDir, status: currentError ? "degraded" : "running", taskId: currentTask?.task_id, error: currentError, leaseMinutes }).catch(() => {}), 15_000);
  console.log(JSON.stringify({ event: "worker.started", workerId, vertical, cdpPort }));
  try {
    while (!stopping) {
      currentError = null;
      currentTask = await claimTask({ workerId, vertical, leaseMinutes });
      if (!currentTask) {
        await heartbeat(workerId, { vertical, cdpPort, profileDir, status: "idle", leaseMinutes });
        await sleep(15_000);
        continue;
      }
      try {
        const result = await scrapeTask(browser, currentTask);
        let saved = 0;
        for (const item of result.observations) if (await upsertObservation(item)) saved++;
        await completeTask(currentTask.task_id, result.resultCount, saved);
        console.log(JSON.stringify({ event: "task.done", workerId, taskId: currentTask.task_id, zip: currentTask.query_zip, resultCount: result.resultCount, recordsSaved: saved }));
      } catch (error) {
        currentError = error instanceof Error ? error.message : String(error);
        await failTask(currentTask, currentError);
        console.log(JSON.stringify({ event: "task.error", workerId, taskId: currentTask.task_id, error: currentError }));
      } finally {
        currentTask = null;
        await sleep(gapMs);
      }
    }
  } finally {
    clearInterval(timer);
    await heartbeat(workerId, { vertical, cdpPort, profileDir, status: "stopped", leaseMinutes }).catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}

async function scrapeTask(browser, task) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(timeoutMs);
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(task.query)}&num=10`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    const search = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a[href]")];
      return links.map((link) => ({
        href: link.href,
        text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
        title: link.querySelector("h3")?.innerText?.trim() || "",
      })).map((item) => ({ ...item, href: externalResultHref(item.href) }))
        .filter((item) => item.href);
    });
    if (search.some((item) => /unusual traffic|captcha|sorry/i.test(`${item.title} ${item.text}`))) throw new Error("search_guard_or_captcha");
    const unique = [];
    const seen = new Set();
    for (const item of search) {
      const key = item.href.split("#")[0];
      if (!seen.has(key)) { seen.add(key); unique.push(item); }
    }
    const observations = [];
    for (const [index, result] of unique.slice(0, maxResultPages).entries()) {
      const detail = await inspectResult(browser, result.href, task, index + 1).catch(() => null);
      const fallback = normalizeObservation({
        vertical: task.vertical,
        queryZip: task.query_zip,
        name: result.title || result.text.split(" - ")[0],
        sourceUrl: result.href,
        source: "google_search",
        sourceRank: index + 1,
        raw: result,
      });
      if (detail) observations.push(detail);
      else if (fallback) observations.push(fallback);
    }
    return { resultCount: unique.length, observations };
  } finally {
    await page.close().catch(() => {});
  }
}

function externalResultHref(rawHref) {
  try {
    const parsed = new URL(rawHref, "https://www.google.com");
    const hostIsGoogle = /(^|\.)google\./i.test(parsed.hostname);
    if (hostIsGoogle) {
      const redirected = parsed.searchParams.get("q") || parsed.searchParams.get("url");
      if (!redirected) return null;
      const target = new URL(redirected);
      if (!/^https?:$/i.test(target.protocol) || /(^|\.)google\./i.test(target.hostname)) return null;
      return `${target.origin}${target.pathname}${target.search}`;
    }
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

async function inspectResult(browser, url, task, sourceRank) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(timeoutMs);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(1200);
    const payload = await page.evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 5000),
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => {
        try { return JSON.parse(node.textContent || "{}"); } catch { return null; }
      }).filter(Boolean),
    }));
    const nodes = extractJsonLd(payload.jsonLd);
    const context = { vertical: task.vertical, queryZip: task.query_zip, sourceUrl: url, source: "website_jsonld", sourceRank, raw: { title: payload.title, text: payload.text.slice(0, 2000) } };
    const fromLd = nodes.map((node) => jsonLdToObservation(node, { ...context, raw: { ...context.raw, jsonLd: node } })).filter(Boolean);
    if (fromLd.length) return fromLd[0];
    const text = cleanText(payload.text, 3000);
    const phone = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-])\d{3}[\s.-]\d{4}/)?.[0] || null;
    return normalizeObservation({ ...context, name: payload.title.split("|")[0].split("-")[0], phone, website: url, raw: { ...context.raw, domain: domainFor(url) } });
  } finally {
    await page.close().catch(() => {});
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

run().catch(async (error) => {
  console.log(JSON.stringify({ event: "worker.fatal", workerId, error: error instanceof Error ? error.message : String(error) }));
  await close().catch(() => {});
  process.exit(1);
});
