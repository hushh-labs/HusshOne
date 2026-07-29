#!/usr/bin/env node
/* End-to-end production health probe for the `one` service (public domain intelligence.hushh.ai).
 * HTTP-only, zero deps (Node 20 fetch).
 *
 * Checks, in order:
 *   1. Public app shell    — GET / and /docs return 200, and the document revalidates (no stale deploy)
 *   2. Deep self-check     — GET /api/internal/health (token-gated): DB, Vertex, Deep Research API, the
 *                            4 scraper VMs — each up/degraded/down with latency
 *   3. Verdict             — "110% green" only when public is up AND every CRITICAL dependency is up
 *
 * Usage:
 *   ONE_INTERNAL_JOB_TOKEN=… node scripts/health-e2e.mjs
 *   BASE_URL=https://intelligence.hushh.ai node scripts/health-e2e.mjs
 * Exit code 0 = healthy, 1 = unhealthy (so it gates a deploy / CI).
 *
 * NOTE: default target is intelligence.hushh.ai — the canonical public domain that maps to the `one`
 * service (hushone-app). one.hushh.ai is a DIFFERENT service (project hushh-pda) and 404s here.
 */

const BASE_URL = (process.env.BASE_URL || "https://intelligence.hushh.ai").replace(/\/+$/, "");
const TOKEN = (process.env.ONE_INTERNAL_JOB_TOKEN || "").trim();
const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 30000);

const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", DIM = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const icon = (s) => (s === "up" ? `${G}●${X}` : s === "degraded" ? `${Y}●${X}` : `${R}●${X}`);

async function get(path, headers = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: String(e?.message || e), ms: Date.now() - started, error: true };
  } finally {
    clearTimeout(t);
  }
}

const rows = []; // {name, status:"up|degraded|down", detail, ms, critical}
const add = (name, status, detail, ms, critical = true) => rows.push({ name, status, detail, ms, critical });

async function run() {
  console.log(`\n${B}One health — ${BASE_URL}${X}  ${DIM}${new Date().toISOString()}${X}\n`);

  // 1) Public app shell
  const home = await get("/");
  add("app:/", home.status === 200 ? "up" : "down", `HTTP ${home.status}`, home.ms);
  const cc = home.headers.get("cache-control") || "";
  add("app:cache-control", /no-cache/.test(cc) ? "up" : "degraded", cc || "(none)", 0, false);
  const docs = await get("/docs");
  add("app:/docs", docs.status === 200 ? "up" : "down", `HTTP ${docs.status}`, docs.ms);

  // 2) Deep self-check (token-gated)
  if (!TOKEN) {
    add("internal/health", "degraded", "ONE_INTERNAL_JOB_TOKEN not set — deep checks skipped", 0, false);
  } else {
    const h = await get("/api/internal/health", { "x-one-job-token": TOKEN });
    let body = null;
    try { body = JSON.parse(h.text); } catch { /* non-json */ }
    if (!body || !Array.isArray(body.checks)) {
      add("internal/health", "down", `HTTP ${h.status} (no check payload)`, h.ms);
    } else {
      for (const c of body.checks) add(c.name, c.status, c.detail, c.latencyMs ?? 0, Boolean(c.critical));
    }
  }

  // Render
  const pad = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    console.log(`  ${icon(r.status)} ${r.name.padEnd(pad)}  ${DIM}${String(r.ms).padStart(5)}ms${X}  ${r.detail}`);
  }

  const criticalDown = rows.filter((r) => r.critical && r.status === "down");
  const degraded = rows.filter((r) => r.status === "degraded");
  const healthy = criticalDown.length === 0;
  console.log("");
  if (healthy && degraded.length === 0) {
    console.log(`${G}${B}✅ 110% GREEN — every check up.${X}\n`);
  } else if (healthy) {
    console.log(`${Y}${B}✅ HEALTHY (with ${degraded.length} degraded — non-blocking): ${degraded.map((d) => d.name).join(", ")}${X}\n`);
  } else {
    console.log(`${R}${B}❌ DOWN — critical: ${criticalDown.map((d) => d.name).join(", ")}${X}\n`);
  }
  process.exit(healthy ? 0 : 1);
}

run().catch((e) => {
  console.error("health-e2e crashed:", e);
  process.exit(1);
});
