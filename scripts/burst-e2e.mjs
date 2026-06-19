#!/usr/bin/env node
/* End-to-end burst driver — exercises the REAL control plane over HTTP.
   Posts each workload to POST /api/one/burst, reads the live NDJSON stream (or the
   Puppy handshake for on-device jobs), and asserts the cloud bursts actually complete.
   This drives the real route → auth → placement engine → provider factory → teardown;
   only the provider is the mock (ONE_ENABLE_MOCK_BURST=true), so no GCP creds are needed.

   Run the server with the demo flags, then this driver:
     ONE_ENABLE_MOCK_BURST=true ONE_ENABLE_DEV_AUTH=true \
     ONE_BURST_MOCK_DURATION_MS=3000 ONE_BURST_POLL_INTERVAL_MS=400 \
     PORT=3000 node .next/standalone/server.js &
     npm run sim:burst:e2e

   Scenarios mirror src/lib/burst/simulation.ts (the canonical model). */

const BASE = process.env.ONE_BURST_BASE_URL || "http://localhost:3000";
const TOKEN = process.env.ONE_BURST_TOKEN || "DEV_TOKEN";

const SCENARIOS = [
  { id: "lora-8b", persona: "Indie iOS dev", expect: "puppy", accel: "gpu", count: 1, estimate: { vramGb: 40, unifiedMemoryGb: 40, vcpus: 8, diskGb: 80, estimatedMinutes: 22 } },
  { id: "diffusion-batch", persona: "Design studio", expect: "puppy", accel: "gpu", count: 1, estimate: { vramGb: 60, unifiedMemoryGb: 64, vcpus: 12, diskGb: 220, estimatedMinutes: 35 } },
  { id: "ft-70b", persona: "AI startup", expect: "gcp", accel: "gpu", count: 8, estimate: { vramGb: 220, unifiedMemoryGb: 220, vcpus: 96, diskGb: 1200, estimatedMinutes: 240 } },
  { id: "quant-backtest", persona: "Quant researcher", expect: "gcp", accel: "gpu", count: 1, estimate: { vramGb: 24, unifiedMemoryGb: 64, vcpus: 16, diskGb: 5000, estimatedMinutes: 180 } },
  { id: "protein-tpu", persona: "Biotech", expect: "gcp", accel: "tpu", count: 8, estimate: { vramGb: 16, unifiedMemoryGb: 32, vcpus: 8, diskGb: 300, estimatedMinutes: 90 } },
  { id: "hpo-sweep", persona: "Enterprise DS", expect: "gcp", accel: "gpu", count: 8, estimate: { vramGb: 300, unifiedMemoryGb: 300, vcpus: 96, diskGb: 800, estimatedMinutes: 120 } },
];

const log = (s = "") => process.stdout.write(s + "\n");

async function drive(s) {
  const res = await fetch(`${BASE}/api/one/burst`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image: `us-docker.pkg.dev/acme/one/${s.id}:latest`,
      acceleratorKind: s.accel,
      acceleratorCount: s.count,
      estimate: s.estimate,
    }),
  });

  const ct = res.headers.get("content-type") || "";

  // On-device (Puppy) → a single JSON handshake, no stream.
  if (ct.includes("application/json")) {
    const body = await res.json();
    if (!res.ok || body.ok !== true) throw new Error(`HTTP ${res.status}: ${body.error || "no handshake"}`);
    log(`    DECISION → ${String(body.placement).toUpperCase()}  (${body.reason})`);
    log(`    ✓ on-device handshake · jobId ${body.burstJobId ?? "(no-db)"} · reportEndpoint ${body.handshake?.reportResultEndpoint ?? "n/a"}`);
    return body.placement;
  }

  // Cloud burst → read the NDJSON lifecycle stream to completion.
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let placement = "gcp";
  let last = "";
  let done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.type === "start") {
        placement = ev.placement;
        log(`    DECISION → ${String(ev.placement).toUpperCase()}  · provider ${ev.provider} · offloaded`);
      } else if (ev.type === "progress" && ev.scanning && ev.scanning !== last) {
        log(`    ↳ [${String((ev.elapsedMs / 1000).toFixed(1)).padStart(4)}s] ${ev.scanning}`);
        last = ev.scanning;
      } else if (ev.type === "done") {
        done = ev;
      } else if (ev.type === "error") {
        throw new Error(ev.error || "burst error");
      }
    }
  }
  if (!done || done.ok !== true || done.exitCode !== 0) throw new Error("burst did not complete (exit≠0)");
  log(`    ✓ COMPLETED via control plane · exit ${done.exitCode} · result: ${JSON.stringify(done.result)}`);
  return placement;
}

async function main() {
  log("\n════════════════════════════════════════════════════════════════════");
  log("  ONE — XTREME COMPUTE BURST · end-to-end control-plane drive");
  log(`  POST ${BASE}/api/one/burst  (real route · placement engine · mock provider)`);
  log("════════════════════════════════════════════════════════════════════");

  // Preflight: clear message if the server isn't up with the demo flags.
  try {
    await fetch(`${BASE}/docs`, { method: "HEAD" });
  } catch {
    log(`\n✗ Could not reach ${BASE}. Start the server with the demo flags first (see the header of this file).`);
    process.exit(2);
  }

  let puppy = 0,
    cloud = 0,
    failed = 0;
  let i = 0;
  for (const s of SCENARIOS) {
    i++;
    log(`\n[${i}/${SCENARIOS.length}] ${s.persona} — ${s.id}`);
    try {
      const placement = await drive(s);
      if (placement !== s.expect) {
        failed++;
        log(`    ✗ expected ${s.expect}, got ${placement}`);
      } else if (placement === "puppy") puppy++;
      else cloud++;
    } catch (e) {
      failed++;
      log(`    ✗ ${e.message}`);
    }
  }

  log("\n────────────────────────────────────────────────────────────────────");
  log(`  RESULT: ${cloud} cloud bursts completed end-to-end · ${puppy} kept on-device · ${failed} failed`);
  log("  Every cloud job was offloaded, run, and torn down by the real control plane.");
  log("────────────────────────────────────────────────────────────────────\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
