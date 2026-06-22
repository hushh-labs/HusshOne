/* Internal health endpoint: one token-gated probe that self-checks every live dependency of One in
   parallel (DB, Vertex auth, the 4 scraper VMs, the Deep Research API) and returns a structured,
   secret-free status. Powers the health-e2e harness, the `health-check` skill, the post-deploy gate,
   and the continuous uptime monitor. Guarded by ONE_INTERNAL_JOB_TOKEN. Each check is independently
   timed + fully defensive — one slow dependency can't hang or crash the probe. */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import { getPrismaClient } from "@/lib/db/prisma";
import { vertexConfig, adcAccessToken } from "@/lib/gcp/auth";
import { deepResearchBaseUrl } from "@/lib/research/client";

export const runtime = "nodejs";
export const maxDuration = 30;

type Status = "up" | "degraded" | "down";

export interface HealthCheck {
  name: string;
  status: Status;
  critical: boolean; // a critical check being down fails the overall verdict (ok=false)
  detail: string;
  latencyMs: number;
}

/** Run one check with a hard timeout; any throw/timeout → down. */
async function timed(name: string, critical: boolean, fn: (signal: AbortSignal) => Promise<{ status: Status; detail: string }>, timeoutMs = 8000): Promise<HealthCheck> {
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

async function checkDb(): Promise<{ status: Status; detail: string }> {
  const prisma = getPrismaClient();
  if (!prisma) return { status: "down", detail: "no DATABASE_URL / prisma unavailable" };
  await prisma.$queryRaw`SELECT 1`;
  return { status: "up", detail: "SELECT 1 ok" };
}

async function checkVertex(signal: AbortSignal): Promise<{ status: Status; detail: string }> {
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
async function checkScraper(name: string, urlEnv: string, keyEnv: string, path: string, signal: AbortSignal): Promise<{ status: Status; detail: string }> {
  const base = (process.env[urlEnv] || "").trim().replace(/\/+$/, "");
  const key = (process.env[keyEnv] || "").trim();
  if (!base) return { status: "down", detail: `${urlEnv} unset` };
  const res = await fetch(`${base}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal,
  });
  if (!res.ok) return { status: "down", detail: `${path} HTTP ${res.status}` };
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; liveBrowser?: boolean; usableForDeepScrape?: boolean };
  if (body.ok === false) return { status: "down", detail: `${path} ok:false` };
  // /session/status exposes liveBrowser/usableForDeepScrape; treat a reachable-but-not-usable session as degraded.
  if (body.usableForDeepScrape === false || body.liveBrowser === false) return { status: "degraded", detail: "reachable but session not usable (relogin?)" };
  return { status: "up", detail: `${path} ok` };
}

async function checkDeepResearch(signal: AbortSignal): Promise<{ status: Status; detail: string }> {
  // Resolve the SAME way the real client does (env override → built-in default); env-unset is normal.
  const base = deepResearchBaseUrl();
  if (!base) return { status: "down", detail: "no Deep Research base URL" };
  const token = (process.env.DEEP_RESEARCH_API_TOKEN || "").trim();
  const res = await fetch(`${base}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
  if (!res.ok) return { status: "down", detail: `/health HTTP ${res.status}` };
  return { status: "up", detail: "/health 200" };
}

export async function POST(request: Request) {
  return handle(request);
}
export async function GET(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  try {
    verifyInternalJobRequest(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  const checks = await Promise.all([
    timed("database", true, () => checkDb()),
    timed("vertex", true, (s) => checkVertex(s)),
    timed("deep_research_api", true, (s) => checkDeepResearch(s)),
    timed("scraper_instagram", false, (s) => checkScraper("instagram", "INSTAGRAM_SCRAPER_URL", "INSTAGRAM_SCRAPER_API_KEY", "/session/status", s)),
    timed("scraper_x", false, (s) => checkScraper("x", "TWITTER_SCRAPER_URL", "TWITTER_SCRAPER_API_KEY", "/session/status", s)),
    timed("scraper_threads", false, (s) => checkScraper("threads", "THREADS_SCRAPER_URL", "THREADS_SCRAPER_API_KEY", "/session/status", s)),
    timed("scraper_linkedin", false, (s) => checkScraper("linkedin", "LINKEDIN_SCRAPER_URL", "LINKEDIN_SCRAPER_API_KEY", "/health", s)),
  ]);

  const summary = {
    up: checks.filter((c) => c.status === "up").length,
    degraded: checks.filter((c) => c.status === "degraded").length,
    down: checks.filter((c) => c.status === "down").length,
  };
  // Overall verdict: ok only when every CRITICAL dependency is up. Degraded scrapers don't fail it.
  const ok = checks.every((c) => !c.critical || c.status === "up");
  // Structured log on EVERY probe so the continuous watchdog (Cloud Scheduler → this route) leaves a trail
  // in Cloud Logging — a hung scraper / DB / Vertex shows up immediately (log-based metric + alert), so an
  // outage is caught in minutes instead of when a user complains.
  const notUp = checks.filter((c) => c.status !== "up").map((c) => `${c.name}:${c.status}`);
  console.log(JSON.stringify({ event: "one.health.check", ok, summary, notUp }));
  return NextResponse.json({ ok, checkedAt: new Date().toISOString(), summary, checks }, { status: ok ? 200 : 503 });
}
