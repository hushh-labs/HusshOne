/* Adam's device + workload presets (pure, no I/O).
   The consumer entry point is a phone, not a Mac — these profiles let the placement
   engine answer "does this fit on YOUR device?" for the devices people actually hold:
   iPhone, iPad, Mac, Windows. Numbers are conservative usable capacity, not spec-sheet
   maxima (the OS and foreground apps keep their share; placement.ts applies its own
   safety fraction on top). */
import { DEFAULT_PUPPY_PROFILE } from "./placement";
import type { AcceleratorKind, DeviceProfile, WorkloadEstimate } from "./types";

export const DEVICE_PROFILES: DeviceProfile[] = [
  {
    id: "iphone-17-pro",
    label: "iPhone 17 Pro",
    cpuCores: 6,
    gpuCores: 6,
    unifiedMemoryGb: 12,
    diskFreeGb: 128,
    networkMbps: 1_000,
    online: true,
  },
  {
    id: "ipad-pro-m4",
    label: "iPad Pro (M4)",
    cpuCores: 10,
    gpuCores: 10,
    unifiedMemoryGb: 16,
    diskFreeGb: 256,
    networkMbps: 1_200,
    online: true,
  },
  {
    id: "macbook-pro-m4-max",
    label: "MacBook Pro (M4 Max)",
    cpuCores: 16,
    gpuCores: 40,
    unifiedMemoryGb: 128,
    diskFreeGb: 1_024,
    networkMbps: 2_000,
    online: true,
  },
  DEFAULT_PUPPY_PROFILE, // Mac Studio (M3 Ultra) — the reference One Puppy
  {
    id: "windows-laptop",
    label: "Windows laptop (RTX 4070)",
    cpuCores: 14,
    gpuCores: 0,
    unifiedMemoryGb: 8, // discrete VRAM is the binding accelerator budget
    diskFreeGb: 512,
    networkMbps: 1_000,
    online: true,
  },
  {
    id: "windows-workstation",
    label: "Windows workstation (RTX 4090)",
    cpuCores: 24,
    gpuCores: 0,
    unifiedMemoryGb: 24,
    diskFreeGb: 2_048,
    networkMbps: 2_000,
    online: true,
  },
];

export function findDeviceProfile(id: string): DeviceProfile | undefined {
  return DEVICE_PROFILES.find((d) => d.id === id);
}

/** A ready-made ask Adam can plan without the user knowing what a "GB of VRAM" is. */
export interface WorkloadPreset {
  id: string;
  emoji: string;
  title: string;
  subtitle: string;
  acceleratorKind: AcceleratorKind;
  /** Wall-clock minutes on the matched (recommended) hardware — drives cost/benchmarks. */
  matchedRuntimeMin: number;
  /** How many chips the job can actually use in parallel. */
  parallelChips: number;
  estimate: WorkloadEstimate;
}

export const WORKLOAD_PRESETS: WorkloadPreset[] = [
  {
    id: "photos-model",
    emoji: "📸",
    title: "Train on my photos",
    subtitle: "A private model of your 5,000 photos",
    acceleratorKind: "gpu",
    matchedRuntimeMin: 25,
    parallelChips: 1,
    estimate: { vramGb: 12, unifiedMemoryGb: 16, vcpus: 8, diskGb: 20, estimatedMinutes: 25 },
  },
  {
    id: "clip-edit",
    emoji: "🎬",
    title: "Enhance a 4K clip",
    subtitle: "On-device when your phone can take it",
    acceleratorKind: "gpu",
    matchedRuntimeMin: 6,
    parallelChips: 1,
    estimate: { vramGb: 4, unifiedMemoryGb: 6, vcpus: 4, diskGb: 8, estimatedMinutes: 6 },
  },
  {
    id: "finetune-70b",
    emoji: "🧠",
    title: "Fine-tune the full 70B",
    subtitle: "The whole model — not a shrunk proxy",
    acceleratorKind: "gpu",
    matchedRuntimeMin: 90,
    parallelChips: 4,
    estimate: { vramGb: 640, unifiedMemoryGb: 256, vcpus: 48, diskGb: 400, estimatedMinutes: 90 },
  },
  {
    id: "render-film",
    emoji: "🎥",
    title: "Render a film sequence",
    subtitle: "4K frames, overnight → over coffee",
    acceleratorKind: "gpu",
    matchedRuntimeMin: 40,
    parallelChips: 2,
    estimate: { vramGb: 48, unifiedMemoryGb: 64, vcpus: 16, diskGb: 250, estimatedMinutes: 40 },
  },
  {
    id: "backtest-markets",
    emoji: "📈",
    title: "Backtest 10 years of markets",
    subtitle: "Every tick, the full history",
    acceleratorKind: "gpu",
    matchedRuntimeMin: 20,
    parallelChips: 1,
    estimate: { vramGb: 24, unifiedMemoryGb: 96, vcpus: 32, diskGb: 5_000, estimatedMinutes: 20 },
  },
  {
    id: "fold-protein",
    emoji: "🧬",
    title: "Fold a protein",
    subtitle: "TPU-class science from your pocket",
    acceleratorKind: "tpu",
    matchedRuntimeMin: 30,
    parallelChips: 2,
    estimate: { vramGb: 100, unifiedMemoryGb: 128, vcpus: 24, diskGb: 100, estimatedMinutes: 30 },
  },
  {
    id: "frontier-run",
    emoji: "🚀",
    title: "A frontier training run",
    subtitle: "Blackwell-class — the biggest GCP offers",
    acceleratorKind: "gpu",
    matchedRuntimeMin: 240,
    parallelChips: 8,
    estimate: { vramGb: 1_000, unifiedMemoryGb: 512, vcpus: 96, diskGb: 2_000, estimatedMinutes: 240 },
  },
];

export function findWorkloadPreset(id: string): WorkloadPreset | undefined {
  return WORKLOAD_PRESETS.find((p) => p.id === id);
}
