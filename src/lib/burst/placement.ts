/* "One Puppy" placement engine (pure, no I/O).
   Decides whether a workload runs on the local Mac ("One Puppy" — a personal
   supercomputer) or bursts to the customer's cloud (GCP in v1). This is the real,
   testable core of the Puppy tier; the Mac-side execution itself is a native concern
   reached via the handshake the route returns (see docs/xtreme-compute-burst.md). */
import type { AcceleratorKind, DeviceProfile, PlacementDecision, WorkloadEstimate } from "./types";

// Never pack the Puppy to 100% — leave headroom for the OS, the agent, and the user's
// foreground work. A job must fit under this fraction of unified memory / free disk.
const SAFETY = 0.8;

/** A maxed high-end Mac (e.g. M3 Ultra Mac Studio): the reference One Puppy device. */
export const DEFAULT_PUPPY_PROFILE: DeviceProfile = {
  id: "puppy-m3-ultra",
  label: "One Puppy — Mac Studio (M3 Ultra)",
  cpuCores: 32,
  gpuCores: 80,
  unifiedMemoryGb: 192,
  diskFreeGb: 2048,
  networkMbps: 10_000,
  online: true,
};

/**
 * Route a workload to the Puppy when it comfortably fits locally, else burst to GCP.
 *
 * Rules (first match wins):
 *  - Puppy offline → gcp.
 *  - TPU workloads → gcp (Apple Silicon has no TPU; TPUs only exist in-cloud).
 *  - GPU job whose memory + disk fit under the SAFETY fraction → puppy.
 *  - Otherwise → gcp, naming the binding constraint.
 */
export function decidePlacement(
  estimate: WorkloadEstimate,
  device: DeviceProfile,
  acceleratorKind: AcceleratorKind = "gpu",
): PlacementDecision {
  if (!device.online) {
    return { target: "gcp", reason: "One Puppy is offline — bursting to the cloud.", fitsLocally: false };
  }

  if (acceleratorKind === "tpu") {
    // TPUs are a cloud-only accelerator — Apple Silicon can't run a TPU workload.
    return { target: "gcp", reason: "TPU workloads run only in the cloud — bursting to GCP.", fitsLocally: false };
  }

  if (estimate.vramGb <= 0 && estimate.unifiedMemoryGb <= 0) {
    // Degenerate/unknown estimate: don't gamble the local device, burst it.
    return { target: "gcp", reason: "Workload size is unknown — bursting to the cloud.", fitsLocally: false };
  }

  const memBudgetGb = device.unifiedMemoryGb * SAFETY;
  const diskBudgetGb = device.diskFreeGb * SAFETY;
  // On Apple Silicon, GPU/VRAM and host RAM share one unified pool — the binding
  // requirement is the larger of the two against the unified-memory budget.
  const memNeedGb = Math.max(estimate.vramGb, estimate.unifiedMemoryGb);

  const memoryHeadroomGb = memBudgetGb - memNeedGb;
  const diskHeadroomGb = diskBudgetGb - estimate.diskGb;
  const headroom = { memoryGb: round(memoryHeadroomGb), diskGb: round(diskHeadroomGb) };

  if (memoryHeadroomGb < 0) {
    return {
      target: "gcp",
      reason: `Needs ~${estimate.vramGb}GB accelerator memory; One Puppy offers ~${round(memBudgetGb)}GB usable — bursting to the cloud.`,
      fitsLocally: false,
      headroom,
    };
  }
  if (diskHeadroomGb < 0) {
    return {
      target: "gcp",
      reason: `Needs ~${estimate.diskGb}GB disk; One Puppy has ~${round(diskBudgetGb)}GB usable — bursting to the cloud.`,
      fitsLocally: false,
      headroom,
    };
  }

  return {
    target: "puppy",
    reason: `Fits on ${device.label} with ~${headroom.memoryGb}GB memory headroom — running on-device.`,
    fitsLocally: true,
    headroom,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
