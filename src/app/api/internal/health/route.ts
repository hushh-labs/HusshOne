/* Internal health endpoint: one token-gated probe that self-checks every live dependency of One in
   parallel (DB, Vertex auth, the 4 scraper VMs, the Deep Research API) and returns a structured status
   WITH per-check detail. Powers the health-e2e harness, the `health-check` skill, the post-deploy gate,
   and the continuous uptime monitor. Guarded by ONE_INTERNAL_JOB_TOKEN. The shared check core lives in
   @/lib/health/checks (also used by the public, sanitized /api/v1/health). */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import { runHealthChecks, summarize, overallOk, criticalDownCount } from "@/lib/health/checks";

export const runtime = "nodejs";
export const maxDuration = 30;

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

  // ?scope=critical → DB / Vertex / Deep Research only. The 10-min watchdog uses this: those are the deps
  // whose failure actually breaks the product and warrants waking someone. Scrapers are non-critical and
  // swept on a slow cadence (separate scheduler job, default full scope), because probing them is expensive
  // and their real failure signal comes from actual scrapes — see @/lib/health/session-signal.
  const scope = new URL(request.url).searchParams.get("scope") === "critical" ? "critical" : "full";
  const checks = await runHealthChecks({ includeScrapers: scope === "full" });
  const summary = summarize(checks);
  const ok = overallOk(checks);
  // Structured log on EVERY probe so the continuous watchdog (Cloud Scheduler → this route) leaves a trail
  // in Cloud Logging — a hung scraper / DB / Vertex shows up immediately (log-based metric + alert), so an
  // outage is caught in minutes instead of when a user complains.
  // `criticalDown` is the PAGING signal (drives the one_health_dep_down metric); `summary.down` counts
  // non-critical scrapers too and is kept for dashboards/history only — alerting on it pages on non-events.
  const notUp = checks.filter((c) => c.status !== "up").map((c) => `${c.name}:${c.status}`);
  const criticalDown = criticalDownCount(checks);
  console.log(JSON.stringify({ event: "one.health.check", ok, scope, summary, criticalDown, notUp }));
  return NextResponse.json({ ok, checkedAt: new Date().toISOString(), scope, summary, criticalDown, checks }, { status: ok ? 200 : 503 });
}
