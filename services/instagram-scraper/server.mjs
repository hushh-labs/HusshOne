import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeInstagramProfileUrl, instagramUsernameFromUrl } from "./scripts/lib/instagram-url.mjs";
import {
  checkInstagramProfileAccess,
  requestInstagramProfileAccess,
  scrapeInstagramProfile,
} from "./scripts/lib/live-browser-scraper.mjs";
import { buildInstagramTemplate } from "./scripts/lib/template-response.mjs";

const port = Number(process.env.PORT || 8080);
const maxUrls = Number(process.env.INSTAGRAM_MAX_URLS_PER_REQUEST || 3);
const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), "outputs", "api");
const apiKey = String(process.env.SCRAPER_API_KEY || "").trim();
const liveBrowserEnabled = process.env.INSTAGRAM_LIVE_BROWSER === "true";
const browserUrl = process.env.INSTAGRAM_BROWSER_URL || "http://127.0.0.1:9222";
const noVncUrl = process.env.INSTAGRAM_NOVNC_URL || "http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080";
const chromeProfileDir = process.env.PUPPETEER_USER_DATA_DIR || "/var/lib/instagram-scraper/chrome-profile";
const instagramLoginUrl = "https://www.instagram.com/accounts/login/";

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: "instagram-scraper", timestamp: new Date().toISOString() });
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
      if (!urls.length) return sendJson(response, 400, { ok: false, error: "Provide `url` or `urls` with Instagram profile URL(s)." });
      if (urls.length > maxUrls) return sendJson(response, 400, { ok: false, error: `Too many URLs. Max ${maxUrls} per request.` });
      const maxPosts = normalizeMaxPosts(body?.maxPosts);

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
  console.log(JSON.stringify({ event: "server.started", service: "instagram-scraper", port }));
});

async function scrapeOne(profileUrl, options = {}) {
  const profileId = instagramUsernameFromUrl(profileUrl);
  try {
    const raw =
      options.action === "access_request"
        ? await requestInstagramProfileAccess(profileUrl)
        : options.action === "access_check"
          ? await checkInstagramProfileAccess(profileUrl)
          : await scrapeInstagramProfile(profileUrl, { requestAccess: true, maxPosts: options.maxPosts });
    const template = buildInstagramTemplate(profileUrl, raw);
    const access = normalizeAccess(raw, template);
    if (isAuthwallResponse(raw)) {
      return {
        ok: false,
        profileId,
        profileUrl,
        error: access.reason || "Instagram returned a login/checkpoint wall instead of profile data. Keep the VM Chrome browser logged in and retry.",
        type: typeForAccessState(access.state) || "InstagramAuthwall",
        access,
        raw,
        template,
      };
    }
    if (raw?.scrapeMeta?.notFound) {
      return { ok: false, profileId, profileUrl, error: "Instagram profile was not found.", type: "InstagramNotFound", access, raw, template };
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
  return raw?.scrapeMeta?.authwall === true || /accounts\/login|challenge/i.test(String(raw?.scrapeMeta?.url || ""));
}

function normalizeAccess(raw, template) {
  const source = raw?.access || template?.access || {};
  const requestedAction = source.requestedAction || null;
  const rawState = String(source.state || raw?.scrapeMeta?.accessState || (raw?.isPrivate ? "private_not_following" : "public_visible"));
  const state = requestedAction?.clicked === true && rawState === "private_not_following" ? "follow_requested" : rawState;
  const checkedAt = typeof source.checkedAt === "string" ? source.checkedAt : new Date().toISOString();
  return {
    state,
    canScrapePosts: source.canScrapePosts === true,
    isPrivate: source.isPrivate === true || raw?.isPrivate === true || template?.isPrivate === true,
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
    private_not_following: "InstagramAccessRequired",
    follow_requested: "InstagramAccessPending",
    pending_approval: "InstagramAccessPending",
    login_required: "InstagramLoginRequired",
    checkpoint_required: "InstagramCheckpointRequired",
    rate_limited: "InstagramRateLimited",
    blocked: "InstagramBlocked",
    not_found: "InstagramNotFound",
  };
  return types[state] || "InstagramAccessRequired";
}

function errorForAccess(access) {
  if (access.state === "private_not_following") return "Instagram profile is private and the VM account is not following it yet.";
  if (access.state === "follow_requested" || access.state === "pending_approval") {
    return "Instagram follow request is pending owner approval. One will continue without Instagram social context for now.";
  }
  if (access.reason) return access.reason;
  return "Instagram profile is not visible to the VM browser session yet.";
}

function nextCheckAfterForState(state, checkedAt) {
  if (state !== "follow_requested" && state !== "pending_approval" && state !== "private_not_following") return null;
  const base = Number.isFinite(Date.parse(checkedAt)) ? new Date(checkedAt) : new Date();
  base.setHours(base.getHours() + 6);
  return base.toISOString();
}

function normalizeInputUrls(body) {
  const raw = Array.isArray(body?.urls) ? body.urls : body?.url ? [body.url] : [];
  return [...new Set(raw.map(normalizeInstagramProfileUrl).filter(Boolean))];
}

// Honor a per-request `maxPosts` (the One worker sends 1024), clamped to the service ceiling.
// Falls back to the env default when omitted. Mirrors the Threads/X scrapers.
function normalizeMaxPosts(value) {
  const n = Number(value || process.env.INSTAGRAM_MAX_POSTS_PER_PROFILE || 1024);
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
    service: "instagram-scraper",
    liveBrowser: liveBrowserEnabled,
    browserUrl,
    noVncUrl,
    chromeProfileDir,
    loginUrl: instagramLoginUrl,
    outputDir,
    notes: [
      "Use /login-intent through an SSH/local tunnel when Instagram asks for login, 2FA, CAPTCHA, or checkpoint handling.",
      "Leave the VM Chrome window open after login; normal /scrape requests reuse the same persistent Chromium profile.",
      "Private profiles trigger one Follow/Request action at most, then return pending state until owner approval.",
      "The worker only extracts profile-page data visible to that logged-in browser session.",
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
    <title>Instagram Scraper Login Intent</title>
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
      .button.secondary { background: #182231; color: #d8e7f7; border: 1px solid #304056; }
    </style>
  </head>
  <body>
    <main>
      <h1>Instagram Scraper Login Intent</h1>
      <p>
        Use this page only through the VM/local tunnel. Open noVNC, complete Instagram login or checkpoint in the VM Chrome browser,
        then leave Chrome open and retry <code>POST /scrape</code>. The scraper will reuse this persistent Chromium session.
      </p>
      <div class="actions">
        <a class="button" href="${escapeHtml(status.noVncUrl)}">Open noVNC</a>
      </div>
      <p>Inside the VM Chrome window, open <code>${escapeHtml(status.loginUrl)}</code> if Instagram is not already on the login screen.</p>
      <div class="grid">
        <section class="panel">
          <div class="label">Live Browser</div>
          <div class="value">${status.liveBrowser ? "enabled" : "disabled"}</div>
        </section>
        <section class="panel">
          <div class="label">Chrome DevTools</div>
          <div class="value">${escapeHtml(status.browserUrl)}</div>
        </section>
        <section class="panel">
          <div class="label">Chrome Profile</div>
          <div class="value">${escapeHtml(status.chromeProfileDir)}</div>
        </section>
      </div>
      <p>Expected tunnel command from your laptop:</p>
      <pre>gcloud compute ssh instagram-scraper-vm --project hushh-tech-prod --zone us-central1-c -- -N -L 6080:localhost:6080 -L 8080:localhost:8080</pre>
      <p>After login, verify the session from your laptop with:</p>
      <pre>curl -sS -H "Authorization: Bearer $SCRAPER_API_KEY" http://127.0.0.1:8080/session/status</pre>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function writeResult(result) {
  const profileId = result.profileId || "unknown-profile";
  const suffix = result.ok ? "json" : "error.json";
  const filePath = path.join(outputDir, `${profileId}.${suffix}`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`);
}

async function writeAccessRecord(result) {
  if (!result?.access || !result.profileId) return;
  const filePath = path.join(outputDir, "instagram-access-state.json");
  await fs.mkdir(outputDir, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    current = {};
  }
  current[result.profileId] = {
    profileId: result.profileId,
    profileUrl: result.profileUrl,
    status: result.access.state,
    access: result.access,
    profileSnapshot: result.template || null,
    lastError: result.ok ? null : result.error || null,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response, status, html) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}
