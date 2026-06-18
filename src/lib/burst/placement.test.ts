import { describe, expect, it } from "vitest";
import { DEFAULT_PUPPY_PROFILE, decidePlacement } from "./placement";
import type { DeviceProfile, WorkloadEstimate } from "./types";

const PUPPY: DeviceProfile = { ...DEFAULT_PUPPY_PROFILE }; // 192GB unified, 2048GB disk

function estimate(over: Partial<WorkloadEstimate> = {}): WorkloadEstimate {
  return { vramGb: 40, unifiedMemoryGb: 40, vcpus: 8, diskGb: 100, estimatedMinutes: 20, ...over };
}

describe("decidePlacement", () => {
  it("runs on the Puppy when memory + disk fit under the 0.8 safety budget", () => {
    // 192 * 0.8 = 153.6 usable; need 153 → fits (boundary).
    const decision = decidePlacement(estimate({ vramGb: 153, unifiedMemoryGb: 153 }), PUPPY, "gpu");
    expect(decision.target).toBe("puppy");
    expect(decision.fitsLocally).toBe(true);
    expect(decision.headroom?.memoryGb).toBeGreaterThanOrEqual(0);
  });

  it("bursts to GCP when accelerator memory exceeds the Puppy budget", () => {
    const decision = decidePlacement(estimate({ vramGb: 200, unifiedMemoryGb: 60 }), PUPPY, "gpu");
    expect(decision.target).toBe("gcp");
    expect(decision.fitsLocally).toBe(false);
    expect(decision.reason).toMatch(/accelerator memory/i);
  });

  it("bursts to GCP when disk exceeds the Puppy budget", () => {
    const decision = decidePlacement(estimate({ diskGb: 5000 }), PUPPY, "gpu");
    expect(decision.target).toBe("gcp");
    expect(decision.reason).toMatch(/disk/i);
  });

  it("always bursts TPU workloads regardless of size", () => {
    const decision = decidePlacement(estimate({ vramGb: 1, unifiedMemoryGb: 1, diskGb: 1 }), PUPPY, "tpu");
    expect(decision.target).toBe("gcp");
    expect(decision.reason).toMatch(/TPU/i);
  });

  it("bursts when the Puppy is offline", () => {
    const decision = decidePlacement(estimate({ vramGb: 1, unifiedMemoryGb: 1 }), { ...PUPPY, online: false }, "gpu");
    expect(decision.target).toBe("gcp");
    expect(decision.reason).toMatch(/offline/i);
  });
});
