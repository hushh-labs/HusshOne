/* Shared health-check core. One place that self-checks every live dependency of One in parallel
   (DB, Vertex auth, the Deep Research API, the 4 scraper VMs + the LinkedIn posts capability) and
   returns a structured, secret-free-per-check status. Consumed by:
     • the token-gated internal probe (src/app/api/internal/health) — full detail, powers the watchdog;
     • the public dev-API status endpoint (src/app/api/v1/health) — a SANITIZED subset (see that route).
   Each check is independently timed + fully defensive: one slow/broken dependency can't hang the probe. */
import { getPrismaClient } from "@/lib/db/prisma";
import { vertexConfig, adcAccessToken } from "@/lib/gcp/auth";
import { deepResearchBaseUrl } from "@/lib/research/client";
import { reportScraperReadiness } from "@/lib/health/session-signal";

export type HealthStatus = "up" | "degraded" | "down";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  critical: boolean; // a critical check being down fails the overall verdict (ok=false)
  detail: string;
  latencyMs: number;
  cached?: boolean; // true → replayed from the probe-rate cache, not freshly measured (scrapers only)
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
async function checkScraper(platform: string, urlEnv: string, keyEnv: string, path: string, signal: AbortSignal): Promise<{ status: HealthStatus; detail: string }> {
  const base = (process.env[urlEnv] || "").trim().replace(/\/+$/, "");
  const key = (process.env[keyEnv] || "").trim();
  if (!base) return { status: "down", detail: `${urlEnv} unset` };
  const res = await fetch(`${base}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal });
  if (!res.ok) return { status: "down", detail: `${path} HTTP ${res.status}` };
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; liveBrowser?: boolean; usableForDeepScrape?: boolean; requiresHumanLogin?: boolean };
  if (body.ok === false) return { status: "down", detail: `${path} ok:false` };
  if (body.usableForDeepScrape === false || body.liveBrowser === false) {
    // The one readiness outcome worth waking someone for: the session is alive but logged out, and only a
    // human can clear it. Raised to the same alert real scrapes feed, so idle decay is caught before a user
    // hits it. Unreachable/slow VMs deliberately do NOT reach here — they are not human-actionable.
    reportScraperReadiness({ platform, requiresHumanLogin: body.requiresHumanLogin === true });
    return { status: "degraded", detail: "reachable but session not usable (relogin?)" };
  }
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

/* Scraper session probes are EXPENSIVE and RARELY-CHANGING. Each `/session/status` drives a live Chrome
   DevTools inspection on a 2-vCPU VM (measured 13-30s on Instagram), and what it detects — a logged-out /
   checkpointed / rate-limited session — decays over hours, not minutes. Running it on every 10-min watchdog
   sweep was ~144 synthetic browser inspections a day that gated NOTHING: the real scrape path posts straight
   to /scrape (see src/lib/instagram/scraper-profile.ts) and never reads this verdict.
   So we rate-limit the probe and serve the last verdict in between. A healthy session is re-checked every 6h;
   an unhealthy one every 10 min, so recovery still shows up quickly.
   This is a rate limiter, NOT a source of truth — it is per-instance and Cloud Run scales to zero, so a cold
   start re-probes. The authoritative, always-real signal is `one.scraper.session_blocked`, emitted by ACTUAL
   scrapes (see @/lib/health/session-signal). */
const SCRAPER_OK_TTL_MS = 6 * 60 * 60_000;
const SCRAPER_BAD_TTL_MS = 10 * 60_000;
/** Session-status endpoints inspect a live browser, so they need far more headroom than the 8s default. */
const SCRAPER_TIMEOUT_MS = 20_000;

const scraperCache = new Map<string, { at: number; check: HealthCheck }>();

/** Reset the probe-rate cache. Test-only seam; never called in production. */
export function __resetScraperCache(): void {
  scraperCache.clear();
}

/** Run `fn` at most once per TTL (TTL depends on the last verdict); otherwise replay the cached check. */
async function rateLimited(name: string, fn: () => Promise<HealthCheck>): Promise<HealthCheck> {
  const hit = scraperCache.get(name);
  if (hit) {
    const ttl = hit.check.status === "up" ? SCRAPER_OK_TTL_MS : SCRAPER_BAD_TTL_MS;
    if (Date.now() - hit.at < ttl) return { ...hit.check, cached: true };
  }
  const check = await fn();
  scraperCache.set(name, { at: Date.now(), check });
  return check;
}

const scraperChecks = (): Promise<HealthCheck>[] => [
  rateLimited("scraper_instagram", () =>
    timed("scraper_instagram", false, (s) => checkScraper("instagram", "INSTAGRAM_SCRAPER_URL", "INSTAGRAM_SCRAPER_API_KEY", "/session/status", s), SCRAPER_TIMEOUT_MS),
  ),
  rateLimited("scraper_x", () =>
    timed("scraper_x", false, (s) => checkScraper("x", "TWITTER_SCRAPER_URL", "TWITTER_SCRAPER_API_KEY", "/session/status", s), SCRAPER_TIMEOUT_MS),
  ),
  rateLimited("scraper_threads", () =>
    timed("scraper_threads", false, (s) => checkScraper("threads", "THREADS_SCRAPER_URL", "THREADS_SCRAPER_API_KEY", "/session/status", s), SCRAPER_TIMEOUT_MS),
  ),
  rateLimited("scraper_linkedin", () =>
    timed("scraper_linkedin", false, (s) => checkScraper("linkedin", "LINKEDIN_SCRAPER_URL", "LINKEDIN_SCRAPER_API_KEY", "/health", s), SCRAPER_TIMEOUT_MS),
  ),
  rateLimited("scraper_linkedin_posts", () => timed("scraper_linkedin_posts", false, (s) => checkLinkedInPosts(s), SCRAPER_TIMEOUT_MS)),
];

export interface HealthCheckOptions {
  /** false → probe only the critical deps (DB, Vertex, Deep Research). Used by the 10-min watchdog, which
   *  pages a human; scrapers are non-critical and are swept separately on a slow cadence. */
  includeScrapers?: boolean;
}

/** Run the dependency sweep in parallel. Names are stable — callers map them to public buckets. */
export async function runHealthChecks({ includeScrapers = true }: HealthCheckOptions = {}): Promise<HealthCheck[]> {
  return Promise.all([
    timed("database", true, () => checkDb()),
    timed("vertex", true, (s) => checkVertex(s)),
    timed("deep_research_api", true, (s) => checkDeepResearch(s)),
    ...(includeScrapers ? scraperChecks() : []),
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

/** How many CRITICAL deps are down. This — not summary.down — is what may wake a human: a non-critical
 *  scraper being unreachable degrades scrape depth but leaves the app fully serving, so it must never page. */
export function criticalDownCount(checks: HealthCheck[]): number {
  return checks.filter((c) => c.critical && c.status === "down").length;
}
