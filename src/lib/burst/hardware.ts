/* "Best hardware for the workload" — the matching engine (pure, no I/O).
   One understands a workload's shape (accelerator memory, parallelism, accelerator
   family) and picks the accelerator class with the best performance-per-dollar that
   actually fits — not the biggest box (overpay), not the smallest (won't fit / crawls).
   Pure + testable, like placement.ts. Catalog prices/perf are modeled inputs
   (approx on-demand us-central1) — edit to your committed-use / spot rates. */
import type { AcceleratorKind } from "./types";

export interface AcceleratorClass {
  id: string;
  kind: AcceleratorKind;
  label: string;
  /** Accelerator memory per chip, GB. */
  memGbPerChip: number;
  /** Relative throughput vs a T4 baseline (=1.0). Modeled. */
  perf: number;
  /** Approx on-demand $/hour per chip (incl. host share). Modeled. */
  usdPerHourPerChip: number;
  bestFor: string;
}

export const ACCEL_CATALOG: AcceleratorClass[] = [
  { id: "nvidia-t4",  kind: "gpu", label: "NVIDIA T4",       memGbPerChip: 16, perf: 1.0,  usdPerHourPerChip: 0.35, bestFor: "light inference, small fine-tunes, IO-bound jobs" },
  { id: "nvidia-l4",  kind: "gpu", label: "NVIDIA L4",       memGbPerChip: 24, perf: 2.0,  usdPerHourPerChip: 0.70, bestFor: "diffusion, batch inference, media" },
  { id: "a100-40",    kind: "gpu", label: "NVIDIA A100 40GB", memGbPerChip: 40, perf: 8.0,  usdPerHourPerChip: 2.90, bestFor: "mid/large training, fine-tunes" },
  { id: "a100-80",    kind: "gpu", label: "NVIDIA A100 80GB", memGbPerChip: 80, perf: 9.0,  usdPerHourPerChip: 3.67, bestFor: "large-model training, big batches" },
  { id: "h100-80",    kind: "gpu", label: "NVIDIA H100 80GB (A3)", memGbPerChip: 80, perf: 22.0, usdPerHourPerChip: 9.80, bestFor: "frontier training, lowest time-to-result" },
  { id: "h200-141",   kind: "gpu", label: "NVIDIA H200 141GB (A3 Ultra)", memGbPerChip: 141, perf: 26.0, usdPerHourPerChip: 10.90, bestFor: "memory-bound frontier training, long-context inference" },
  { id: "b200-180",   kind: "gpu", label: "NVIDIA B200 180GB (A4)",       memGbPerChip: 180, perf: 45.0, usdPerHourPerChip: 21.00, bestFor: "largest single-node training runs, Blackwell-class throughput" },
  { id: "gb200-186",  kind: "gpu", label: "NVIDIA GB200 NVL (A4X)",       memGbPerChip: 186, perf: 55.0, usdPerHourPerChip: 27.50, bestFor: "rack-scale frontier workloads, the biggest jobs GCP offers" },
  { id: "tpu-v5e",    kind: "tpu", label: "Cloud TPU v5e",    memGbPerChip: 16, perf: 7.0,  usdPerHourPerChip: 1.20, bestFor: "JAX/XLA, protein folding, large matmul" },
  { id: "tpu-v6e",    kind: "tpu", label: "Cloud TPU v6e (Trillium)", memGbPerChip: 32, perf: 14.0, usdPerHourPerChip: 2.70, bestFor: "high-throughput JAX/XLA training and serving" },
  { id: "tpu-v5p",    kind: "tpu", label: "Cloud TPU v5p",    memGbPerChip: 95, perf: 18.0, usdPerHourPerChip: 4.20, bestFor: "largest TPU training pods, memory-heavy XLA models" },
];

const MAX_CHIPS = 8;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface HardwareRecommendation {
  accel: AcceleratorClass;
  count: number;
  usdPerHour: number;
  fits: boolean;
  rationale: string;
}

/** Pick the accelerator class with the best performance-per-dollar that fits the job. */
export function recommendHardware(vramGb: number, kind: AcceleratorKind, parallelChips = 1): HardwareRecommendation {
  const candidates = ACCEL_CATALOG.filter((c) => c.kind === kind);
  let best: { c: AcceleratorClass; memChips: number; proxy: number } | null = null;
  for (const c of candidates) {
    const memChips = Math.max(1, Math.ceil(vramGb / c.memGbPerChip));
    if (memChips > MAX_CHIPS) continue; // can't fit this job on one node of this class
    // Lower is better: dollars needed to cover the memory, per unit of throughput.
    const proxy = (c.usdPerHourPerChip * memChips) / c.perf;
    if (!best || proxy < best.proxy) best = { c, memChips, proxy };
  }
  if (!best) {
    // Nothing in this family fits on a single node — fall back to the biggest class.
    const big = candidates.sort((a, b) => b.memGbPerChip - a.memGbPerChip)[0];
    const count = clamp(parallelChips, 1, MAX_CHIPS);
    return { accel: big, count, usdPerHour: round2(big.usdPerHourPerChip * count), fits: false,
      rationale: `~${vramGb}GB exceeds a single ${big.label} node — needs multi-node (sharded) ${big.label}.` };
  }
  const count = clamp(Math.max(best.memChips, parallelChips), 1, MAX_CHIPS);
  const totalMem = count * best.c.memGbPerChip;
  return {
    accel: best.c,
    count,
    usdPerHour: round2(best.c.usdPerHourPerChip * count),
    fits: true,
    rationale: `~${vramGb}GB${parallelChips > 1 ? ` · ${parallelChips}× parallel` : ""} → ${count}× ${best.c.label} (${totalMem}GB) — best performance-per-dollar that fits.`,
  };
}

export interface BenchmarkRow {
  role: "undersized" | "matched" | "oversized";
  label: string;
  count: number;
  feasible: boolean;
  wallMinutes: number | null;
  costUsd: number | null;
  note: string;
}

const OVERHEAD_SEC = 120;

function rowFor(c: AcceleratorClass, vramGb: number, parallel: number, runtimeMinOnMatched: number, matchedPerf: number, role: BenchmarkRow["role"], note: string): BenchmarkRow {
  const memChips = Math.max(1, Math.ceil(vramGb / c.memGbPerChip));
  if (memChips > MAX_CHIPS) return { role, label: c.label, count: memChips, feasible: false, wallMinutes: null, costUsd: null, note: `won't fit on one node (needs ${memChips}× ${c.label})` };
  const count = clamp(Math.max(memChips, parallel), 1, MAX_CHIPS);
  const runtimeMin = runtimeMinOnMatched * (matchedPerf / c.perf);
  const wallMinutes = round2(runtimeMin + OVERHEAD_SEC / 60);
  const costUsd = round2(c.usdPerHourPerChip * count * (wallMinutes / 60));
  return { role, label: `${count}× ${c.label}`, count, feasible: true, wallMinutes, costUsd, note };
}

/** Compare One's matched choice against an undersized-cheap and an oversized-premium pick. */
export function benchmarkHardware(vramGb: number, kind: AcceleratorKind, parallel: number, runtimeMinOnMatched: number): BenchmarkRow[] {
  const fam = ACCEL_CATALOG.filter((c) => c.kind === kind);
  const matched = recommendHardware(vramGb, kind, parallel);
  const cheapest = [...fam].sort((a, b) => a.usdPerHourPerChip - b.usdPerHourPerChip)[0];
  const fastest = [...fam].sort((a, b) => b.perf - a.perf)[0];
  return [
    rowFor(cheapest, vramGb, parallel, runtimeMinOnMatched, matched.accel.perf, "undersized", "naive cheap pick"),
    rowFor(matched.accel, vramGb, parallel, runtimeMinOnMatched, matched.accel.perf, "matched", "One's choice — perf/$ that fits"),
    rowFor(fastest, vramGb, parallel, runtimeMinOnMatched, matched.accel.perf, "oversized", "naive 'biggest box' pick"),
  ];
}
