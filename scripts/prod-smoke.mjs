#!/usr/bin/env node
/**
 * Production automation smoke / contract test for one.hushh.ai.
 * Verifies the public surface + security posture without needing a real login.
 * Usage:  node scripts/prod-smoke.mjs            (defaults to https://one.hushh.ai)
 *         BASE_URL=https://otel---one-...run.app node scripts/prod-smoke.mjs
 * Exit code 0 = all pass, 1 = a check failed (CI-friendly).
 */
const BASE = (process.env.BASE_URL || "https://one.hushh.ai").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);

let pass = 0;
let fail = 0;

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function req(path, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal, redirect: "manual" });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

const json = (obj) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

console.log(`\nProd smoke test → ${BASE}\n`);

// 1. Homepage serves the app
{
  const r = await req("/");
  ok("homepage 200", r.status === 200, `got ${r.status}`);
  ok("homepage renders One", /Meet One|One by Hussh/.test(r.body), "marker missing");
}

// 2. Scan API enforces auth (no token → 401)
{
  const r = await req("/api/one/dashboard", json({}));
  ok("scan API requires auth (401)", r.status === 401, `got ${r.status}`);
}

// 3. SECURITY: dev-auth bypass MUST be off in prod (DEV_TOKEN → 401, not accepted)
{
  const r = await req("/api/one/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer DEV_TOKEN" },
    body: JSON.stringify({ name: "x", email: "dev.one@hushh.ai", zipCode: "00000", consentAttestation: true, purpose: "self_audit" }),
  });
  ok("dev-auth OFF in prod (DEV_TOKEN rejected)", r.status === 401, `got ${r.status} — DEV bypass may be ENABLED!`);
}

// 4. Scan recovery route enforces auth
{
  const r = await req("/api/one/scans/00000000-0000-0000-0000-000000000000");
  ok("scans route requires auth (401)", r.status === 401, `got ${r.status}`);
}

// 5. Behaviour beacon accepts a valid event
{
  const r = await req("/api/one/events", json({ event: "stage_landing", sessionId: "prod-smoke" }));
  ok("events beacon accepts valid (204)", r.status === 204, `got ${r.status}`);
}

// 6. Behaviour beacon silently ignores unknown events (allowlist)
{
  const r = await req("/api/one/events", json({ event: "definitely_not_allowed" }));
  ok("events beacon ignores unknown (204)", r.status === 204, `got ${r.status}`);
}

// 7. Wrong method on scan API → 405
{
  const r = await req("/api/one/dashboard");
  ok("scan API rejects GET (405)", r.status === 405, `got ${r.status}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
