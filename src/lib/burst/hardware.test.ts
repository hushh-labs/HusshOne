import { describe, expect, it } from "vitest";
import { benchmarkHardware, recommendHardware } from "./hardware";

describe("recommendHardware — best hardware for the workload", () => {
  it("puts a small GPU job on a single mid GPU, not a frontier box", () => {
    const r = recommendHardware(40, "gpu", 1);
    expect(r.fits).toBe(true);
    expect(r.count).toBe(1);
    expect(r.accel.id).toBe("a100-40"); // best perf/$ that fits 40GB
  });

  it("sizes a 70B-class job to multiple 80GB GPUs", () => {
    const r = recommendHardware(220, "gpu", 8);
    expect(r.fits).toBe(true);
    expect(r.accel.id).toBe("a100-80");
    expect(r.count).toBe(8); // parallelism floor honored
    expect(r.usdPerHour).toBeGreaterThan(20);
  });

  it("routes TPU asks to a TPU class", () => {
    const r = recommendHardware(16, "tpu", 8);
    expect(r.accel.kind).toBe("tpu");
    expect(r.count).toBe(8);
  });

  it("flags a job too large for a single node", () => {
    const r = recommendHardware(2000, "gpu", 1); // 2 TB accel mem
    expect(r.fits).toBe(false);
  });
});

describe("benchmarkHardware — matched beats undersized and oversized", () => {
  it("matched fits, and never costs more than the 'biggest box' for the same result", () => {
    const rows = benchmarkHardware(220, "gpu", 8, 240);
    const matched = rows.find((r) => r.role === "matched")!;
    const oversized = rows.find((r) => r.role === "oversized")!;
    expect(matched.feasible).toBe(true);
    expect(matched.costUsd!).toBeLessThanOrEqual(oversized.costUsd!);
  });

  it("shows the cheap pick as infeasible for a job that can't fit it", () => {
    const rows = benchmarkHardware(220, "gpu", 8, 240);
    const undersized = rows.find((r) => r.role === "undersized")!;
    expect(undersized.feasible).toBe(false); // 220GB can't fit 8×T4 (128GB)
  });
});
