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

  it("bursts when the workload size is unknown (degenerate estimate)", () => {
    const decision = decidePlacement(estimate({ vramGb: 0, unifiedMemoryGb: 0 }), PUPPY, "gpu");
    expect(decision.target).toBe("gcp");
    expect(decision.reason).toMatch(/unknown/i);
  });

  it("treats unified memory (not just vram) as the binding requirement on Apple Silicon", () => {
    // vram tiny but host RAM need huge → still must burst.
    const decision = decidePlacement(estimate({ vramGb: 2, unifiedMemoryGb: 180 }), PUPPY, "gpu");
    expect(decision.target).toBe("gcp");
  });

  it("reports headroom on a local placement", () => {
    const decision = decidePlacement(estimate({ vramGb: 50, unifiedMemoryGb: 50, diskGb: 100 }), PUPPY, "gpu");
    expect(decision.target).toBe("puppy");
    // 192*0.8 - 50 = 103.6 memory headroom; 2048*0.8 - 100 = 1538.4 disk headroom
    expect(decision.headroom?.memoryGb).toBeCloseTo(103.6, 1);
    expect(decision.headroom?.diskGb).toBeCloseTo(1538.4, 1);
  });

  it("defaults the accelerator kind to gpu when omitted", () => {
    const decision = decidePlacement(estimate({ vramGb: 10, unifiedMemoryGb: 10 }), PUPPY);
    expect(decision.target).toBe("puppy");
  });
});
