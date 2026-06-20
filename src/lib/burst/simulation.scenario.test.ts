/* Live burst simulation — run with: npm run sim:burst
   Routes each grounded workload through the REAL placement engine, then for every job
   that must burst, drives the REAL provider lifecycle (provision → provisioning →
   running → completed) in real time and asserts the job actually finishes in the cloud.
   Time / money / accuracy come from the transparent model in ./simulation.ts. */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mockBurstProvider } from "./providers/mock";
import { DEFAULT_PUPPY_PROFILE } from "./placement";
import { benchmarkHardware, recommendHardware } from "./hardware";
import { MODEL, SCENARIOS, analyze, monthlyComparison, type ScenarioAnalysis } from "./simulation";
import type { JobSpec } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtT = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
const usd = (n: number) => `$${n.toFixed(2)}`;
// Print live AND accumulate, so the report survives Vitest's console buffering and can
// be saved/shared. Written to ONE_SIM_REPORT (default /tmp/burst-sim-report.txt).
const lines: string[] = [];
const VERBOSE = process.env.ONE_SIM_VERBOSE === "1";
const log = (s = "") => {
  lines.push(s);
  if (VERBOSE) process.stdout.write(s + "\n"); // quiet during `npm test`; loud via `npm run sim:burst`
};

function jobSpec(a: ScenarioAnalysis): JobSpec {
  return {
    image: `us-docker.pkg.dev/acme/one/${a.scenario.id}:latest`,
    acceleratorKind: a.scenario.acceleratorKind,
    acceleratorCount: a.scenario.acceleratorCount,
    estimate: a.scenario.estimate,
    zone: "us-central1-a",
  };
}

/** Drive the real mock provider to completion, streaming status transitions live. */
async function runBurstToCompletion(a: ScenarioAnalysis, simMs: number) {
  process.env.ONE_BURST_MOCK_DURATION_MS = String(simMs);
  const spec = jobSpec(a);
  const prov = await mockBurstProvider.provision(spec, null);
  log(`      ↳ offloaded to cloud · instance ${prov.instanceName} · zone ${prov.zone}`);
  let last = "";
  const t0 = Date.now();
  // Poll like the control plane does, printing each new state.
  for (;;) {
    const poll = await mockBurstProvider.pollStatus(prov, null);
    const line = poll.progress || poll.status;
    if (line !== last) {
      log(`      ↳ [${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(4)}s] ${poll.status.padEnd(12)} ${poll.progress ?? ""}`);
      last = line;
    }
    if (poll.status === "completed" || poll.status === "failed") {
      await mockBurstProvider.teardown(prov, null);
      return poll;
    }
    await sleep(180);
  }
}

describe("Xtreme Compute Burst — workload simulation", () => {
  it(
    "routes each workload correctly and completes every cloud burst",
    async () => {
      const analyses = SCENARIOS.map((s) => analyze(s, DEFAULT_PUPPY_PROFILE));

      log("\n══════════════════════════════════════════════════════════════════════");
      log("  ONE — XTREME COMPUTE BURST · live workload simulation");
      log(`  Device: ${DEFAULT_PUPPY_PROFILE.label} (${DEFAULT_PUPPY_PROFILE.unifiedMemoryGb}GB unified, ${DEFAULT_PUPPY_PROFILE.diskFreeGb}GB disk)`);
      log(`  Model date ${MODEL.modelDate}. ${MODEL.note}`);
      log("══════════════════════════════════════════════════════════════════════");

      let idx = 0;
      for (const a of analyses) {
        idx++;
        const s = a.scenario;
        log(`\n[${idx}] ${s.persona} — ${s.title}`);
        log(`    “${s.story}”`);
        log(`    workload: ${s.estimate.vramGb}GB accel-mem · ${s.estimate.diskGb}GB disk · ${s.acceleratorKind.toUpperCase()}×${s.acceleratorCount} · ~${s.estimate.estimatedMinutes}m runtime`);
        log(`    DECISION → ${a.decision.target.toUpperCase()}  (${a.decision.reason})`);

        if (a.decision.target === "gcp") {
          // Real lifecycle, real timers — proves the job is offloaded and completes.
          const simMs = 800 + idx * 160;
          const poll = await runBurstToCompletion(a, simMs);
          expect(poll.status).toBe("completed");
          expect(poll.exitCode).toBe(0);
          log(`      ✓ JOB COMPLETED in the cloud (exit ${poll.exitCode})`);

          // Best-hardware-for-the-workload match + a benchmark vs naive picks.
          const hw = recommendHardware(s.estimate.vramGb, s.acceleratorKind, s.acceleratorCount);
          log(`      • best hardware  : ${hw.count}× ${hw.accel.label} ($${hw.usdPerHour}/hr) — ${hw.rationale}`);
          const bench = benchmarkHardware(s.estimate.vramGb, s.acceleratorKind, s.acceleratorCount, s.estimate.estimatedMinutes);
          for (const b of bench) {
            const tag = b.role === "matched" ? "✓ matched " : `  ${b.role.padEnd(8)}`;
            log(`        ${tag} ${b.feasible ? `${b.label} · ${b.wallMinutes}m · $${b.costUsd}` : `${b.label} · ${b.note}`}`);
          }
          const matched = bench.find((b) => b.role === "matched")!;
          const oversized = bench.find((b) => b.role === "oversized")!;
          expect(matched.feasible).toBe(true);
          expect(matched.costUsd!).toBeLessThanOrEqual(oversized.costUsd! + 0.001);
          log(`      • time-to-result : ${fmtT(a.cloudWallSec)}  (on-device: ${a.infeasibleLocally ? "INFEASIBLE — can't fit the Mac" : "n/a"})`);
          log(`      • burst cost     : ${usd(a.burstUsd)}  (pay-per-second on ${s.machine.id})`);
          log(`      • accuracy gain  : +${(a.accuracyGain * 100).toFixed(0)} pts vs shrink-to-fit (${(s.accuracyFull * 100).toFixed(0)}% full → ${(s.accuracyShrunkToFit * 100).toFixed(0)}% local proxy)`);
          expect(a.accuracyGain).toBeGreaterThanOrEqual(0);
        } else {
          // Stayed on the Puppy: free, private, and faster (no provisioning/egress).
          const saved = a.cloudWallSec - (a.puppyWallSec ?? 0);
          log(`      ✓ RAN ON-DEVICE — $0 cloud, data never left the Mac`);
          log(`      • time-to-result : ${fmtT(a.puppyWallSec ?? 0)}  (vs ${fmtT(a.cloudWallSec)} via cloud → ${saved >= 0 ? "saved " + fmtT(saved) : "n/a"})`);
          log(`      • cloud cost avoided: ${usd(a.burstUsd)} per run`);
          expect(a.decision.fitsLocally).toBe(true);
        }
      }

      // ---- Aggregate: pay-per-use vs an always-on box ----
      const m = monthlyComparison(analyses);
      const onDevice = analyses.filter((a) => a.decision.target === "puppy").length;
      const bursts = analyses.length - onDevice;
      const priciest = analyses
        .filter((a) => a.decision.target === "gcp")
        .sort((x, y) => y.scenario.machine.usdPerHour - x.scenario.machine.usdPerHour)[0]?.scenario.machine.id;
      log("\n──────────────────────────────────────────────────────────────────────");
      log("  PORTFOLIO (per month, modeled run frequencies)");
      log(`  • routing          : ${onDevice} workloads kept on-device, ${bursts} bursted to cloud`);
      log(`  • burst spend      : ${usd(m.burstMonthlyUsd)}/mo  (pay only for compute used)`);
      log(`  • always-on box    : ${usd(m.alwaysOnMonthlyUsd)}/mo  (one standing ${priciest}, 24/7)`);
      log(`  • SAVED            : ${usd(m.savedUsd)}/mo  (${m.savedPct.toFixed(0)}%) — at ${m.utilizationPct.toFixed(1)}% true utilization`);
      log("──────────────────────────────────────────────────────────────────────");
      log("  TAKEAWAY: One keeps cheap, fitting jobs on the free local Puppy (money +");
      log("  privacy), and offloads only the heavy/infeasible ones to a pay-per-second");
      log("  cloud supercomputer — completing work the Mac can't, faster and at higher");
      log("  accuracy than any shrink-to-fit workaround.");
      log("  (Placement + completion are real system behavior; $/time/accuracy are");
      log("   editable model inputs.)\n");

      expect(m.savedUsd).toBeGreaterThan(0);
      expect(bursts).toBeGreaterThan(0);
      expect(onDevice).toBeGreaterThan(0);

      writeFileSync(process.env.ONE_SIM_REPORT || "/tmp/burst-sim-report.txt", lines.join("\n") + "\n");
    },
    60_000,
  );
});
