import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { LinkedInProfileScraper } from "linkedin-profile-scraper";
import { normalizeLinkedInProfileUrl, profileIdFromUrl } from "./scripts/lib/linkedin-url.mjs";
import { buildDualTemplate } from "./scripts/lib/template-response.mjs";
import { scrapeWithLiveBrowser } from "./scripts/lib/live-browser-scraper.mjs";

const port = Number(process.env.PORT || 8080);
const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;

const secretPath = process.env.LINKEDIN_LI_AT_FILE || "/app/secrets/li_at";
const cookiesSecretPath = process.env.LINKEDIN_COOKIES_JSON_FILE || "/app/secrets/linkedin-cookies.json";
const defaultTimeoutMs = Number(process.env.LINKEDIN_PROFILE_SCRAPER_TIMEOUT_MS || 90_000);
const defaultUserAgent =
  process.env.LINKEDIN_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const maxUrls = Number(process.env.LINKEDIN_MAX_URLS_PER_REQUEST || 5);
const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), "outputs", "api");
const apiKey = String(process.env.SCRAPER_API_KEY || "").trim();
const usePersistentProfile = process.env.LINKEDIN_USE_PERSISTENT_PROFILE === "true";
const useLiveBrowser = process.env.LINKEDIN_LIVE_BROWSER === "true";

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, { ok: true, service: "linkedin-profile-scraper", timestamp: new Date().toISOString() });
    }

    if (request.method === "POST" && request.url === "/scrape") {
      if (!isAuthorized(request)) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
      const body = await readJson(request);
      const urls = normalizeInputUrls(body);
      if (!urls.length) return sendJson(response, 400, { ok: false, error: "Provide `url` or `urls` with LinkedIn /in/<id> profile URL(s)." });
      if (urls.length > maxUrls) return sendJson(response, 400, { ok: false, error: `Too many URLs. Max ${maxUrls} per request.` });

      const sessionCookieValue = await readLinkedInSession();
      const cookiesJson = await readLinkedInCookiesJson();
      if (!sessionCookieValue && !usePersistentProfile && !useLiveBrowser) {
        return sendJson(response, 503, {
          ok: false,
          error: "LinkedIn session is not configured.",
          needs: "Use persistent profile mode or add li_at to Secret Manager and mount it at /app/secrets/li_at or set LINKEDIN_LI_AT.",
        });
      }

      const results = [];
      for (const url of urls) {
        const result = await scrapeOne(url, sessionCookieValue, cookiesJson);
        await writeResult(result);
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
  console.log(JSON.stringify({ event: "server.started", port }));
});

async function scrapeOne(profileUrl, sessionCookieValue, cookiesJson) {
  let scraper;
  try {
    if (useLiveBrowser) {
      const raw = await scrapeWithLiveBrowser(profileUrl);
      const templates = buildDualTemplate(profileUrl, raw);
      if (isAuthwallResponse(raw)) {
        return {
          ok: false,
          profileId: profileIdFromUrl(profileUrl),
          profileUrl,
          error: "LinkedIn returned authwall/login instead of profile data. Keep the VM Chrome browser logged in and retry.",
          type: "LinkedInAuthwall",
          templates,
        };
      }

      return {
        ok: true,
        profileId: profileIdFromUrl(profileUrl),
        profileUrl,
        templates,
      };
    }

    if (cookiesJson && !usePersistentProfile) process.env.LINKEDIN_COOKIES_JSON = cookiesJson;
    else delete process.env.LINKEDIN_COOKIES_JSON;

    if (!process.env.LINKEDIN_SKIP_LOGIN_CHECK) {
      process.env.LINKEDIN_SKIP_LOGIN_CHECK = cookiesJson && !usePersistentProfile ? "true" : "false";
    }

    scraper = new LinkedInProfileScraper({
      sessionCookieValue: sessionCookieValue || (usePersistentProfile ? "persistent-profile" : ""),
      keepAlive: false,
      userAgent: defaultUserAgent,
      headless: process.env.LINKEDIN_PROFILE_SCRAPER_HEADLESS !== "false",
      timeout: defaultTimeoutMs,
    });
    await scraper.setup();
    const raw = await scraper.run(profileUrl);
    const templates = buildDualTemplate(profileUrl, raw);
    if (isAuthwallResponse(raw)) {
      return {
        ok: false,
        profileId: profileIdFromUrl(profileUrl),
        profileUrl,
        error: "LinkedIn returned authwall/login instead of profile data. Refresh the li_at session and retry.",
        type: "LinkedInAuthwall",
        templates,
      };
    }

    return {
      ok: true,
      profileId: profileIdFromUrl(profileUrl),
      profileUrl,
      templates,
    };
  } catch (error) {
    return {
      ok: false,
      profileId: profileIdFromUrl(profileUrl),
      profileUrl,
      error: error instanceof Error ? error.message : String(error),
      type: error?.name || "Error",
    };
  } finally {
    if (scraper?.close) await scraper.close().catch(() => undefined);
  }
}

function isAuthwallResponse(raw) {
  const profileUrl = String(raw?.userProfile?.url || "");
  if (profileUrl.includes("/authwall") || profileUrl.includes("/login")) return true;

  const profile = raw?.userProfile || {};
  const hasProfileFields = Boolean(profile.fullName || profile.title || profile.location || profile.description || profile.photo);
  const hasSections = ["experiences", "education", "volunteerExperiences", "skills"].some((key) => Array.isArray(raw?.[key]) && raw[key].length > 0);
  return !hasProfileFields && !hasSections;
}

function normalizeInputUrls(body) {
  const raw = Array.isArray(body?.urls) ? body.urls : body?.url ? [body.url] : [];
  return [...new Set(raw.map(normalizeLinkedInProfileUrl).filter(Boolean))];
}

async function readLinkedInSession() {
  if (usePersistentProfile) return "";
  const fromEnv = String(process.env.LINKEDIN_LI_AT || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return (await fs.readFile(path.resolve(secretPath), "utf8")).trim();
  } catch {
    return "";
  }
}

async function readLinkedInCookiesJson() {
  if (usePersistentProfile) return "";
  const fromEnv = String(process.env.LINKEDIN_COOKIES_JSON || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return (await fs.readFile(path.resolve(cookiesSecretPath), "utf8")).trim();
  } catch {
    return "";
  }
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

async function writeResult(result) {
  const profileId = result.profileId || "unknown-profile";
  const suffix = result.ok ? "json" : "error.json";
  const filePath = path.join(outputDir, `${profileId}.${suffix}`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
