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

// ── The One family: Adam, Reserve, network, stories ────────────────────────────

// 8. Adam serves and carries the promise
{
  const r = await req("/adam");
  ok("/adam 200", r.status === 200, `got ${r.status}`);
  ok("/adam renders the promise", /Your phone is a supercomputer/i.test(r.body), "hero missing");
}

// 9. Adam's planning API — presets list, and a real plan both ways
{
  const list = await req("/api/adam/plan");
  let presets = [];
  try { presets = JSON.parse(list.body).presets; } catch {}
  ok("adam plan GET lists presets", list.status === 200 && presets.length >= 6, `got ${list.status}, ${presets.length} presets`);

  const burst = await req("/api/adam/plan", json({ presetId: "finetune-70b", deviceId: "iphone-17-pro" }));
  let plan = null;
  try { plan = JSON.parse(burst.body); } catch {}
  ok("iPhone 70B ask bursts to GCP", burst.status === 200 && plan?.placement?.target === "gcp" && plan?.recommendation?.fits === true,
    `got ${burst.status}, target=${plan?.placement?.target}`);

  const local = await req("/api/adam/plan", json({ presetId: "clip-edit", deviceId: "iphone-17-pro" }));
  let lp = null;
  try { lp = JSON.parse(local.body); } catch {}
  ok("small ask stays on-device at $0", local.status === 200 && lp?.placement?.target === "puppy" && lp?.estimatedCostUsd === 0,
    `got ${local.status}, target=${lp?.placement?.target}, cost=${lp?.estimatedCostUsd}`);
}

// 10. Reserve serves, and books with a preview mandate attached
{
  const page = await req("/reserve");
  ok("/reserve 200", page.status === 200, `got ${page.status}`);

  const cat = await req("/api/reserve");
  let catalog = [];
  try { catalog = JSON.parse(cat.body).catalog; } catch {}
  ok("reserve GET lists services with slots", cat.status === 200 && catalog.length >= 6 && catalog[0]?.slots?.length > 0,
    `got ${cat.status}, ${catalog.length} services`);

  const slot = catalog[0]?.slots?.[0];
  if (slot) {
    const book = await req("/api/reserve", json({
      categoryId: catalog[0].id, seniority: "established",
      startsAt: slot.startsAt, minutes: slot.minutes,
      feeUsd: catalog[0].bands.established.feeSuggestedUsd,
    }));
    let resv = null;
    try { resv = JSON.parse(book.body).reservation; } catch {}
    ok("reserve POST books with ap2 mandate (preview)", book.status === 201
      && resv?.mandate?.kind === "ap2.payment-mandate" && resv?.mandate?.mode === "preview",
      `got ${book.status}, mandate=${resv?.mandate?.kind}/${resv?.mandate?.mode}`);
  } else {
    ok("reserve POST books with ap2 mandate (preview)", false, "no slot available to book");
  }
}

// 11. Network + stories pages
{
  const net = await req("/network");
  ok("/network 200 + names Adam", net.status === 200 && /Adam/.test(net.body), `got ${net.status}`);
  const cust = await req("/customers");
  ok("/customers 200", cust.status === 200, `got ${cust.status}`);
}

// 12. Agent-discoverable surfaces: A2A card + AP2 offers
{
  const card = await req("/.well-known/agent.json");
  let c = null;
  try { c = JSON.parse(card.body); } catch {}
  ok("A2A card serves with 3 skills", card.status === 200 && c?.skills?.length >= 3, `got ${card.status}, skills=${c?.skills?.length}`);
  ok("A2A card carries the continuum positioning", /compute continuum/i.test(c?.description ?? ""), "old description still live");

  const offers = await req("/.well-known/ap2/offers.json");
  ok("AP2 offers serve", offers.status === 200, `got ${offers.status}`);
}

// 13. Installability: manifest + icon
{
  const man = await req("/manifest.webmanifest");
  let m = null;
  try { m = JSON.parse(man.body); } catch {}
  ok("manifest serves, starts at /adam", man.status === 200 && m?.start_url === "/adam", `got ${man.status}, start=${m?.start_url}`);
  const icon = await req("/icon.png");
  ok("icon.png serves", icon.status === 200, `got ${icon.status}`);
}

// 14. Sitemap lists the family
{
  const sm = await req("/sitemap.xml");
  ok("sitemap lists /adam and /reserve", sm.status === 200 && sm.body.includes("/adam") && sm.body.includes("/reserve"),
    `got ${sm.status}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
