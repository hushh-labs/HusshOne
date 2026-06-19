/* Burst simulation model (pure, no I/O).
   Drives the REAL placement engine (decidePlacement) over a set of grounded workload
   scenarios, then layers a transparent, editable time / money / accuracy model on top.
   The decision of WHERE each job runs is the product's real logic — only the prices,
   runtimes, and accuracy figures here are modeled inputs (clearly labeled), so anyone
   can swap in their own numbers. The actual "job completed in the cloud" proof is the
   live mock-provider lifecycle exercised by simulation.scenario.test.ts. */
import { DEFAULT_PUPPY_PROFILE, decidePlacement } from "./placement";
import type { AcceleratorKind, DeviceProfile, PlacementDecision, WorkloadEstimate } from "./types";

/** A cloud shape + its approximate on-demand price. MODEL INPUT — edit to your rates. */
export interface MachineClass {
  id: string;
  /** Approx on-demand us-central1 $/hour for the whole instance (incl. accelerators). */
  usdPerHour: number;
}

export interface Scenario {
  id: string;
  persona: string;
  title: string;
  story: string;
  acceleratorKind: AcceleratorKind;
  acceleratorCount: number;
  /** estimatedMinutes = runtime on the chosen cloud accelerator. */
  estimate: WorkloadEstimate;
  machine: MachineClass;
  /** Monthly run frequency — used for the pay-per-use vs always-on cost model. */
  runsPerMonth: number;
  /** Task accuracy at full size (what a burst delivers). MODEL INPUT. */
  accuracyFull: number;
  /** Best accuracy if forced to shrink/quantize the job to fit a Mac. MODEL INPUT. */
  accuracyShrunkToFit: number;
  /** When it DOES fit locally, how the Mac's wall-clock compares to the cloud run. */
  puppyTimeFactor: number;
}

/* ---- Modeled constants (editable) ---- */
export const MODEL = {
  /** Instance create + boot + image pull before a burst starts doing work. */
  cloudOverheadSec: 120,
  /** Result fetch + teardown signalling after the workload finishes. */
  cloudReturnSec: 25,
  /** Hours/month an always-on alternative box is billed (24/7 to match burst availability). */
  alwaysOnHoursPerMonth: 730,
  modelDate: "2026-06",
  note: "Prices/runtimes/accuracy are modeled inputs (approx on-demand us-central1). Placement and job completion are real system behavior.",
};

/* ---- Scenarios: grounded personas spanning fit-locally and must-burst ---- */
export const SCENARIOS: Scenario[] = [
  {
    id: "lora-8b",
    persona: "Indie iOS developer",
    title: "Fine-tune an 8B model (LoRA) for an on-device feature",
    story: "As a solo dev, I want to tune a small model on my own data without renting a GPU or shipping data to anyone.",
    acceleratorKind: "gpu",
    acceleratorCount: 1,
    estimate: { vramGb: 40, unifiedMemoryGb: 40, vcpus: 8, diskGb: 80, estimatedMinutes: 22 },
    machine: { id: "n1-standard-8 + T4", usdPerHour: 0.73 },
    runsPerMonth: 40,
    accuracyFull: 0.9,
    accuracyShrunkToFit: 0.9, // fits at full size locally — no compromise
    puppyTimeFactor: 1.25,
  },
  {
    id: "diffusion-batch",
    persona: "Design studio",
    title: "Batch-render 500 product frames (diffusion)",
    story: "As a studio, I want an overnight batch of brand-safe renders without per-seat cloud GPU bills.",
    acceleratorKind: "gpu",
    acceleratorCount: 1,
    estimate: { vramGb: 60, unifiedMemoryGb: 64, vcpus: 12, diskGb: 220, estimatedMinutes: 35 },
    machine: { id: "g2-standard-8 + L4", usdPerHour: 0.85 },
    runsPerMonth: 60,
    accuracyFull: 0.95,
    accuracyShrunkToFit: 0.95,
    puppyTimeFactor: 1.4,
  },
  {
    id: "ft-70b",
    persona: "AI startup ML engineer",
    title: "Full fine-tune a 70B-class model",
    story: "As an ML eng, I need to train the full model — quantizing it to fit a laptop tanks quality, and I can't justify a standing 8×A100 box.",
    acceleratorKind: "gpu",
    acceleratorCount: 8,
    estimate: { vramGb: 220, unifiedMemoryGb: 220, vcpus: 96, diskGb: 1200, estimatedMinutes: 240 },
    machine: { id: "a2-highgpu-8g (8×A100)", usdPerHour: 29.39 },
    runsPerMonth: 8,
    accuracyFull: 0.91,
    accuracyShrunkToFit: 0.73, // forced to a 4-bit 8B proxy to fit → big quality loss
    puppyTimeFactor: 1,
  },
  {
    id: "quant-backtest",
    persona: "Quant researcher",
    title: "Backtest across a 5 TB market dataset",
    story: "As a quant, I want to sweep strategies over the full tick history overnight, not a 10% sample that hides tail risk.",
    acceleratorKind: "gpu",
    acceleratorCount: 1,
    estimate: { vramGb: 24, unifiedMemoryGb: 64, vcpus: 16, diskGb: 5000, estimatedMinutes: 180 },
    machine: { id: "n1-standard-16 + T4", usdPerHour: 1.11 },
    runsPerMonth: 20,
    accuracyFull: 0.99,
    accuracyShrunkToFit: 0.86, // 10% sample → wider error / missed tails
    puppyTimeFactor: 1,
  },
  {
    id: "protein-tpu",
    persona: "Biotech researcher",
    title: "Protein-structure / MD run on TPU",
    story: "As a researcher, my pipeline targets TPUs — there's no Apple-Silicon path at all.",
    acceleratorKind: "tpu",
    acceleratorCount: 8,
    estimate: { vramGb: 16, unifiedMemoryGb: 32, vcpus: 8, diskGb: 300, estimatedMinutes: 90 },
    machine: { id: "TPU v5e-8", usdPerHour: 9.6 },
    runsPerMonth: 12,
    accuracyFull: 0.95,
    accuracyShrunkToFit: 0.0, // not runnable on the Mac at all
    puppyTimeFactor: 1,
  },
  {
    id: "hpo-sweep",
    persona: "Enterprise data scientist",
    title: "100-trial hyperparameter sweep",
    story: "As a DS, I want the whole sweep done before standup — fanned out in parallel, not run serially for two days on one box.",
    acceleratorKind: "gpu",
    acceleratorCount: 8,
    estimate: { vramGb: 300, unifiedMemoryGb: 300, vcpus: 96, diskGb: 800, estimatedMinutes: 120 },
    machine: { id: "a2-highgpu-8g (8×A100)", usdPerHour: 29.39 },
    runsPerMonth: 6,
    accuracyFull: 0.93,
    accuracyShrunkToFit: 0.81, // only a handful of trials fit locally → worse best-model
    puppyTimeFactor: 1,
  },
];

export interface ScenarioAnalysis {
  scenario: Scenario;
  decision: PlacementDecision;
  /** Wall-clock to a result via burst (overhead + runtime + return), seconds. */
  cloudWallSec: number;
  /** What the burst itself costs (pay-per-second), USD. */
  burstUsd: number;
  /** Local wall-clock when it fits on the Puppy; null when it must burst. */
  puppyWallSec: number | null;
  /** True when the job genuinely can't run on the Mac (memory/disk/TPU). */
  infeasibleLocally: boolean;
  /** Accuracy you'd forfeit by NOT bursting (0 when it fits locally at full size). */
  accuracyGain: number;
}

export function analyze(scenario: Scenario, device: DeviceProfile = DEFAULT_PUPPY_PROFILE): ScenarioAnalysis {
  const decision = decidePlacement(scenario.estimate, device, scenario.acceleratorKind);
  const runtimeSec = scenario.estimate.estimatedMinutes * 60;
  const cloudWallSec = MODEL.cloudOverheadSec + runtimeSec + MODEL.cloudReturnSec;
  const burstUsd = scenario.machine.usdPerHour * (cloudWallSec / 3600);

  const onPuppy = decision.target === "puppy";
  const puppyWallSec = onPuppy ? Math.round(runtimeSec * scenario.puppyTimeFactor) : null;
  // A must-burst job is "infeasible locally" — at full size it doesn't fit the Mac.
  const infeasibleLocally = !onPuppy;
  const accuracyGain = onPuppy ? 0 : round2(scenario.accuracyFull - scenario.accuracyShrunkToFit);

  return { scenario, decision, cloudWallSec, burstUsd: round2(burstUsd), puppyWallSec, infeasibleLocally, accuracyGain };
}

export interface MonthlyComparison {
  /** Pay-per-use: sum of burst costs across all bursted runs in a month. */
  burstMonthlyUsd: number;
  /** Always-on alternative: one standing instance of the priciest needed class, 24/7. */
  alwaysOnMonthlyUsd: number;
  savedUsd: number;
  savedPct: number;
  /** Fraction of the month that standing capacity would actually be working. */
  utilizationPct: number;
}

export function monthlyComparison(analyses: ScenarioAnalysis[]): MonthlyComparison {
  const bursted = analyses.filter((a) => a.decision.target === "gcp");
  const burstMonthlyUsd = bursted.reduce((sum, a) => sum + a.burstUsd * a.scenario.runsPerMonth, 0);
  const burstHours = bursted.reduce((sum, a) => sum + (a.cloudWallSec / 3600) * a.scenario.runsPerMonth, 0);
  const priciest = Math.max(0, ...bursted.map((a) => a.scenario.machine.usdPerHour));
  const alwaysOnMonthlyUsd = priciest * MODEL.alwaysOnHoursPerMonth;
  const savedUsd = alwaysOnMonthlyUsd - burstMonthlyUsd;
  return {
    burstMonthlyUsd: round2(burstMonthlyUsd),
    alwaysOnMonthlyUsd: round2(alwaysOnMonthlyUsd),
    savedUsd: round2(savedUsd),
    savedPct: round2(alwaysOnMonthlyUsd ? (savedUsd / alwaysOnMonthlyUsd) * 100 : 0),
    utilizationPct: round2(MODEL.alwaysOnHoursPerMonth ? (burstHours / MODEL.alwaysOnHoursPerMonth) * 100 : 0),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
