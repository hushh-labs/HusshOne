/* Shared health-check core. One place that self-checks every live dependency of One in parallel
   (DB, Vertex auth, the Deep Research API, the 4 scraper VMs + the LinkedIn posts capability) and
   returns a structured, secret-free-per-check status. Consumed by:
     • the token-gated internal probe (src/app/api/internal/health) — full detail, powers the watchdog;
     • the public dev-API status endpoint (src/app/api/v1/health) — a SANITIZED subset (see that route).
   Each check is independently timed + fully defensive: one slow/broken dependency can't hang the probe. */
import { getPrismaClient } from "@/lib/db/prisma";
import { vertexConfig, adcAccessToken } from "@/lib/gcp/auth";
import { deepResearchBaseUrl } from "@/lib/research/client";

export type HealthStatus = "up" | "degraded" | "down";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  critical: boolean; // a critical check being down fails the overall verdict (ok=false)
  detail: string;
  latencyMs: number;
}

/** Run one check with a hard timeout; any throw/timeout → down. */
export async function timed(
  name: string,
  critical: boolean,
  fn: (signal: AbortSignal) => Promise<{ status: HealthStatus; detail: string }>,
  timeoutMs = 8000,
): Promise<HealthCheck> {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { status, detail } = await fn(ctrl.signal);
    return { name, status, critical, detail, latencyMs: Date.now() - started };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "error";
    return { name, status: "down", critical, detail: ctrl.signal.aborted ? `timeout after ${timeoutMs}ms` : msg, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

async function checkDb(): Promise<{ status: HealthStatus; detail: string }> {
  const prisma = getPrismaClient();
  if (!prisma) return { status: "down", detail: "no DATABASE_URL / prisma unavailable" };
  await prisma.$queryRaw`SELECT 1`;
  return { status: "up", detail: "SELECT 1 ok" };
}

async function checkVertex(signal: AbortSignal): Promise<{ status: HealthStatus; detail: string }> {
  const cfg = vertexConfig();
  if (!cfg) return { status: "down", detail: "vertexConfig() null (project/location unset)" };
  void signal;
  const token = await adcAccessToken(6000);
  if (!token) return { status: "degraded", detail: "config present but could not mint an ADC token" };
  return { status: "up", detail: "config + ADC token ok" };
}

/** A scraper VM is up if its status endpoint returns 200 + ok:true; degraded if reachable but its live
 *  browser session isn't usable (e.g. logged out); down if unreachable / non-200. Non-critical: a down
 *  scraper degrades scrape depth but the app + preference reads still work. */
async function checkScraper(urlEnv: string, keyEnv: string, path: string, signal: AbortSignal): Promise<{ status: HealthStatus; detail: string }> {
  const base = (process.env[urlEnv] || "").trim().replace(/\/+$/, "");
  const key = (process.env[keyEnv] || "").trim();
  if (!base) return { status: "down", detail: `${urlEnv} unset` };
  const res = await fetch(`${base}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal });
  if (!res.ok) return { status: "down", detail: `${path} HTTP ${res.status}` };
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; liveBrowser?: boolean; usableForDeepScrape?: boolean };
  if (body.ok === false) return { status: "down", detail: `${path} ok:false` };
  if (body.usableForDeepScrape === false || body.liveBrowser === false) return { status: "degraded", detail: "reachable but session not usable (relogin?)" };
  return { status: "up", detail: `${path} ok` };
}

/** Verify the LinkedIn POSTS capability is DEPLOYED + reachable WITHOUT running a real scrape: POST an
 *  empty body — a wired route returns 400 ("provide url") fast; 404 = not deployed; 401 = key mismatch;
 *  timeout/000 = VM down. Non-critical. */
async function checkLinkedInPosts(signal: AbortSignal): Promise<{ status: HealthStatus; detail: string }> {
  const base = (process.env.LINKEDIN_SCRAPER_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.LINKEDIN_SCRAPER_API_KEY || "").trim();
  if (!base) return { status: "down", detail: "LINKEDIN_SCRAPER_URL unset" };
  const res = await fetch(`${base}/scrape-posts`, {
    method: "POST",
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (res.status === 400) return { status: "up", detail: "/scrape-posts wired (400 on empty body)" };
  if (res.status === 404) return { status: "down", detail: "/scrape-posts not deployed (404)" };
  if (res.status === 401) return { status: "degraded", detail: "/scrape-posts auth rejected (key mismatch)" };
  return { status: "degraded", detail: `/scrape-posts HTTP ${res.status}` };
}

async function checkDeepResearch(signal: AbortSignal): Promise<{ status: HealthStatus; detail: string }> {
  const base = deepResearchBaseUrl();
  if (!base) return { status: "down", detail: "no Deep Research base URL" };
  const token = (process.env.DEEP_RESEARCH_API_TOKEN || "").trim();
  const res = await fetch(`${base}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
  if (!res.ok) return { status: "down", detail: `/health HTTP ${res.status}` };
  return { status: "up", detail: "/health 200" };
}

/** Run the full dependency sweep in parallel. Names are stable — callers map them to public buckets. */
export async function runHealthChecks(): Promise<HealthCheck[]> {
  return Promise.all([
    timed("database", true, () => checkDb()),
    timed("vertex", true, (s) => checkVertex(s)),
    timed("deep_research_api", true, (s) => checkDeepResearch(s)),
    timed("scraper_instagram", false, (s) => checkScraper("INSTAGRAM_SCRAPER_URL", "INSTAGRAM_SCRAPER_API_KEY", "/session/status", s)),
    timed("scraper_x", false, (s) => checkScraper("TWITTER_SCRAPER_URL", "TWITTER_SCRAPER_API_KEY", "/session/status", s)),
    timed("scraper_threads", false, (s) => checkScraper("THREADS_SCRAPER_URL", "THREADS_SCRAPER_API_KEY", "/session/status", s)),
    timed("scraper_linkedin", false, (s) => checkScraper("LINKEDIN_SCRAPER_URL", "LINKEDIN_SCRAPER_API_KEY", "/health", s)),
    timed("scraper_linkedin_posts", false, (s) => checkLinkedInPosts(s)),
  ]);
}

export interface HealthSummary {
  up: number;
  degraded: number;
  down: number;
}

export function summarize(checks: HealthCheck[]): HealthSummary {
  return {
    up: checks.filter((c) => c.status === "up").length,
    degraded: checks.filter((c) => c.status === "degraded").length,
    down: checks.filter((c) => c.status === "down").length,
  };
}

/** Overall verdict: ok only when every CRITICAL dependency is up. Degraded scrapers don't fail it. */
export function overallOk(checks: HealthCheck[]): boolean {
  return checks.every((c) => !c.critical || c.status === "up");
}
