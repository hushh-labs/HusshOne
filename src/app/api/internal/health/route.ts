/* Internal health endpoint: one token-gated probe that self-checks every live dependency of One in
   parallel (DB, Vertex auth, the 4 scraper VMs, the Deep Research API) and returns a structured status
   WITH per-check detail. Powers the health-e2e harness, the `health-check` skill, the post-deploy gate,
   and the continuous uptime monitor. Guarded by ONE_INTERNAL_JOB_TOKEN. The shared check core lives in
   @/lib/health/checks (also used by the public, sanitized /api/v1/health). */
import { NextResponse } from "next/server";
import { verifyInternalJobRequest } from "@/lib/auth/internal";
import { runHealthChecks, summarize, overallOk } from "@/lib/health/checks";

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

  const checks = await runHealthChecks();
  const summary = summarize(checks);
  const ok = overallOk(checks);
  // Structured log on EVERY probe so the continuous watchdog (Cloud Scheduler → this route) leaves a trail
  // in Cloud Logging — a hung scraper / DB / Vertex shows up immediately (log-based metric + alert), so an
  // outage is caught in minutes instead of when a user complains.
  const notUp = checks.filter((c) => c.status !== "up").map((c) => `${c.name}:${c.status}`);
  console.log(JSON.stringify({ event: "one.health.check", ok, summary, notUp }));
  return NextResponse.json({ ok, checkedAt: new Date().toISOString(), summary, checks }, { status: ok ? 200 : 503 });
}
