import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeTwitterProfileUrl, twitterUsernameFromUrl } from "./scripts/lib/twitter-url.mjs";
import {
  checkTwitterProfileAccess,
  requestTwitterProfileAccess,
  scrapeTwitterProfile,
} from "./scripts/lib/live-browser-scraper.mjs";
import { buildTwitterTemplate } from "./scripts/lib/template-response.mjs";

const port = Number(process.env.PORT || 8080);
const maxUrls = Number(process.env.TWITTER_MAX_URLS_PER_REQUEST || 3);
const outputDir = process.env.OUTPUT_DIR || "/var/lib/twitter-scraper/outputs";
const apiKey = String(process.env.TWITTER_SCRAPER_API_KEY || process.env.SCRAPER_API_KEY || "").trim();
const liveBrowserEnabled = process.env.TWITTER_LIVE_BROWSER === "true";
const browserUrl = process.env.TWITTER_BROWSER_URL || "http://127.0.0.1:9222";
const noVncUrl = process.env.TWITTER_NOVNC_URL || "http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080";
const chromeProfileDir = process.env.PUPPETEER_USER_DATA_DIR || "/var/lib/twitter-scraper/chrome-profile";
const twitterLoginUrl = "https://x.com/i/flow/login";

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: "twitter-scraper", timestamp: new Date().toISOString() });
    }

    if (request.method === "GET" && requestUrl.pathname === "/session/status") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      return sendJson(response, 200, buildSessionStatus());
    }

    if (request.method === "GET" && requestUrl.pathname === "/login-intent") {
      if (!isLocalRequest(request)) {
        return sendJson(response, 403, {
          ok: false,
          error: "Login intent is local-only. Open it through an SSH tunnel on the VM API port or use the noVNC tunnel command.",
        });
      }
      return sendHtml(response, 200, buildLoginIntentHtml());
    }

    if (
      request.method === "POST" &&
      (requestUrl.pathname === "/scrape" || requestUrl.pathname === "/access-request" || requestUrl.pathname === "/access-check")
    ) {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const body = await readJson(request);
      const urls = normalizeInputUrls(body);
      const maxPosts = normalizeMaxPosts(body?.maxPosts);
      if (!urls.length) return sendJson(response, 400, { ok: false, error: "Provide `url` or `urls` with Twitter/X profile URL(s)." });
      if (urls.length > maxUrls) return sendJson(response, 400, { ok: false, error: `Too many URLs. Max ${maxUrls} per request.` });

      const results = [];
      for (const url of urls) {
        const result = await scrapeOne(url, { action: actionForPath(requestUrl.pathname), maxPosts });
        await writeResult(result);
        await writeAccessRecord(result);
        results.push(result);
      }
      return sendJson(response, 200, { ok: results.every((item) => item.ok), count: results.length, results });
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      type: error?.name || "Error",
    });
  }
});

server.listen(port, () => {
  console.log(JSON.stringify({ event: "server.started", service: "twitter-scraper", port }));
});

async function scrapeOne(profileUrl, options = {}) {
  const profileId = twitterUsernameFromUrl(profileUrl);
  try {
    const raw =
      options.action === "access_request"
        ? await requestTwitterProfileAccess(profileUrl, { maxPosts: options.maxPosts })
        : options.action === "access_check"
          ? await checkTwitterProfileAccess(profileUrl, { maxPosts: options.maxPosts })
          : await scrapeTwitterProfile(profileUrl, { maxPosts: options.maxPosts });
    const template = buildTwitterTemplate(profileUrl, raw);
    const access = normalizeAccess(raw, template);
    if (isAuthwallResponse(raw)) {
      return {
        ok: false,
        profileId,
        profileUrl,
        error: access.reason || "Twitter/X returned a login/checkpoint wall instead of profile data. Keep the VM Chrome browser logged in and retry.",
        type: typeForAccessState(access.state) || "TwitterAuthwall",
        access,
        raw,
        template,
      };
    }
    if (raw?.scrapeMeta?.notFound) {
      return { ok: false, profileId, profileUrl, error: "Twitter/X profile was not found.", type: "TwitterNotFound", access, raw, template };
    }
    if (!isVisibleAccess(access)) {
      return {
        ok: false,
        profileId,
        profileUrl,
        error: errorForAccess(access),
        type: typeForAccessState(access.state),
        access,
        raw,
        template,
      };
    }
    return { ok: true, profileId, profileUrl, access, raw, template };
  } catch (error) {
    return {
      ok: false,
      profileId,
      profileUrl,
      error: error instanceof Error ? error.message : String(error),
      type: error?.name || "Error",
    };
  }
}

function actionForPath(pathname) {
  if (pathname === "/access-request") return "access_request";
  if (pathname === "/access-check") return "access_check";
  return "scrape";
}

function isAuthwallResponse(raw) {
  return raw?.scrapeMeta?.authwall === true || /\/login|\/i\/flow\/login|\/account\/access|\/challenge/i.test(String(raw?.scrapeMeta?.url || ""));
}

function normalizeAccess(raw, template) {
  const source = raw?.access || template?.access || {};
  const requestedAction = source.requestedAction || null;
  const rawState = String(
    source.state || raw?.scrapeMeta?.accessState || (raw?.isProtected || raw?.isPrivate ? "protected_not_following" : "public_visible"),
  );
  const state = requestedAction?.clicked === true && rawState === "protected_not_following" ? "follow_requested" : rawState;
  const checkedAt = typeof source.checkedAt === "string" ? source.checkedAt : new Date().toISOString();
  return {
    state,
    canScrapePosts: source.canScrapePosts === true,
    isProtected: source.isProtected === true || raw?.isProtected === true || template?.isProtected === true,
    isPrivate: source.isPrivate === true || raw?.isPrivate === true || raw?.isProtected === true || template?.isPrivate === true,
    following: source.following === true,
    outgoingRequest: source.outgoingRequest === true || state === "pending_approval" || state === "follow_requested",
    canRequest: source.canRequest === true,
    reason: typeof source.reason === "string" ? source.reason : null,
    evidenceText: typeof source.evidenceText === "string" ? source.evidenceText : null,
    requestedAction,
    checkedAt,
    nextCheckAfter: nextCheckAfterForState(state, checkedAt),
  };
}

function isVisibleAccess(access) {
  return access.state === "public_visible" || access.state === "approved_visible" || access.canScrapePosts === true;
}

function typeForAccessState(state) {
  const types = {
    protected_not_following: "TwitterAccessRequired",
    follow_requested: "TwitterAccessPending",
    pending_approval: "TwitterAccessPending",
    login_required: "TwitterLoginRequired",
    checkpoint_required: "TwitterCheckpointRequired",
    rate_limited: "TwitterRateLimited",
    blocked: "TwitterBlocked",
    not_found: "TwitterNotFound",
    suspended_or_unavailable: "TwitterUnavailable",
  };
  return types[state] || "TwitterAccessRequired";
}

function errorForAccess(access) {
  if (access.state === "protected_not_following") return "Twitter/X profile is protected and the VM account is not following it yet.";
  if (access.state === "follow_requested" || access.state === "pending_approval") {
    return "Twitter/X follow request is pending owner approval. No One integration is invoked in this standalone phase.";
  }
  if (access.reason) return access.reason;
  return "Twitter/X profile is not visible to the VM browser session yet.";
}

function nextCheckAfterForState(state, checkedAt) {
  if (state !== "follow_requested" && state !== "pending_approval" && state !== "protected_not_following") return null;
  const base = Number.isFinite(Date.parse(checkedAt)) ? new Date(checkedAt) : new Date();
  base.setHours(base.getHours() + 6);
  return base.toISOString();
}

function normalizeInputUrls(body) {
  const raw = Array.isArray(body?.urls) ? body.urls : body?.url ? [body.url] : [];
  return [...new Set(raw.map(normalizeTwitterProfileUrl).filter(Boolean))];
}

function normalizeMaxPosts(value) {
  const n = Number(value || process.env.TWITTER_MAX_POSTS_PER_PROFILE || 1024);
  if (!Number.isFinite(n) || n <= 0) return 1024;
  return Math.max(1, Math.min(1024, Math.round(n)));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function isAuthorized(request) {
  if (!apiKey) return true;
  const header = String(request.headers.authorization || "");
  return header === `Bearer ${apiKey}`;
}

function isLocalRequest(request) {
  const address = String(request.socket.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("::ffff:127.");
}

function buildSessionStatus() {
  return {
    ok: true,
    service: "twitter-scraper",
    liveBrowser: liveBrowserEnabled,
    browserUrl,
    noVncUrl,
    chromeProfileDir,
    loginUrl: twitterLoginUrl,
    outputDir,
    maxPostsPerProfile: normalizeMaxPosts(),
    tabs: ["posts", "replies"],
    notes: [
      "Use /login-intent through an SSH/local tunnel when Twitter/X asks for login, 2FA, CAPTCHA, or checkpoint handling.",
      "Leave the VM Chrome window open after login; normal /scrape requests reuse the same persistent Chromium profile.",
      "Protected profiles trigger one Follow/Request action only through /access-request, then return pending state until owner approval.",
      "The worker only extracts Posts and Replies visible to that logged-in browser session.",
      "No One app persistence or prompt handoff is performed by this standalone service.",
    ],
  };
}

function buildLoginIntentHtml() {
  const status = buildSessionStatus();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Twitter/X Scraper Login Intent</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #0b0f14; color: #eef2f7; }
      main { max-width: 880px; margin: 0 auto; padding: 48px 24px; }
      h1 { font-size: 32px; margin: 0 0 12px; letter-spacing: 0; }
      p { color: #b8c3cf; line-height: 1.6; }
      a { color: #8fd2ff; }
      code, pre { background: #111821; border: 1px solid #273445; border-radius: 8px; color: #d8e7f7; }
      code { padding: 2px 6px; }
      pre { padding: 16px; overflow-x: auto; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin: 24px 0; }
      .panel { border: 1px solid #273445; border-radius: 8px; padding: 16px; background: #10161f; }
      .label { color: #8ca0b3; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .value { margin-top: 8px; overflow-wrap: anywhere; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 24px 0; }
      .button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border-radius: 8px; background: #1f8fff; color: #06111f; font-weight: 700; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>Twitter/X Scraper Login Intent</h1>
      <p>Use this local-only page while connected to the VM tunnel. Complete Twitter/X login, 2FA, CAPTCHA, or checkpoint work inside noVNC, then leave Chromium open.</p>
      <div class="grid">
        <div class="panel"><div class="label">Service</div><div class="value">${status.service}</div></div>
        <div class="panel"><div class="label">Browser Debug</div><div class="value">${status.browserUrl}</div></div>
        <div class="panel"><div class="label">Chrome Profile</div><div class="value">${status.chromeProfileDir}</div></div>
        <div class="panel"><div class="label">Outputs</div><div class="value">${status.outputDir}</div></div>
      </div>
      <div class="actions">
        <a class="button" href="${status.noVncUrl}">Open noVNC</a>
        <a class="button" href="${status.loginUrl}">Open Twitter/X Login</a>
      </div>
      <p>Smoke after login:</p>
      <pre>curl -H "Authorization: Bearer $TWITTER_SCRAPER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://x.com/sundarpichai"}' \\
  http://127.0.0.1:8080/scrape</pre>
    </main>
  </body>
</html>`;
}

async function writeResult(result) {
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const safeId = String(result.profileId || "unknown").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
    const file = path.join(outputDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeId}.json`);
    await fs.writeFile(file, `${JSON.stringify(redactResult(result), null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(JSON.stringify({ event: "result.write_failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function writeAccessRecord(result) {
  if (!result.access) return;
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const file = path.join(outputDir, "twitter-access-state.json");
    await fs.writeFile(
      file,
      `${JSON.stringify({ profileId: result.profileId, profileUrl: result.profileUrl, access: result.access, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn(JSON.stringify({ event: "access.write_failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

function redactResult(result) {
  return JSON.parse(
    JSON.stringify(result, (key, value) => {
      if (/cookie|session|token|password|authorization|localStorage|storageState/i.test(key)) return undefined;
      return value;
    }),
  );
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendHtml(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}
