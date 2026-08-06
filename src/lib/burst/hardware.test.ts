import { describe, expect, it } from "vitest";
import { benchmarkHardware, recommendHardware } from "./hardware";

describe("recommendHardware — best hardware for the workload", () => {
  it("puts a small GPU job on a single mid GPU, not a frontier box", () => {
    const r = recommendHardware(40, "gpu", 1);
    expect(r.fits).toBe(true);
    expect(r.count).toBe(1);
    expect(r.accel.id).toBe("a100-40"); // best perf/$ that fits 40GB
  });

  it("sizes a 70B-class job onto the newest large-memory GPUs", () => {
    const r = recommendHardware(220, "gpu", 8);
    expect(r.fits).toBe(true);
    expect(r.accel.id).toBe("h200-141"); // fewer, bigger chips win on perf/$ once H200-class exists
    expect(r.count).toBe(8); // parallelism floor honored
    expect(r.usdPerHour).toBeGreaterThan(20);
  });

  it("routes TPU asks to a TPU class, and small TPU jobs stay on v5e", () => {
    const r = recommendHardware(16, "tpu", 8);
    expect(r.accel.kind).toBe("tpu");
    expect(r.accel.id).toBe("tpu-v5e"); // newest isn't forced when the small class is better perf/$
    expect(r.count).toBe(8);
  });

  it("fits a ~1TB frontier job on Blackwell-class single-node hardware", () => {
    const r = recommendHardware(1000, "gpu", 1);
    expect(r.fits).toBe(true);
    expect(["b200-180", "gb200-186"]).toContain(r.accel.id);
  });

  it("routes memory-heavy TPU jobs to v5p's large HBM", () => {
    const r = recommendHardware(400, "tpu", 1); // needs 95GB-class chips to fit in 8
    expect(r.fits).toBe(true);
    expect(r.accel.id).toBe("tpu-v5p");
  });

  it("flags a job too large for a single node", () => {
    const r = recommendHardware(2000, "gpu", 1); // 2 TB accel mem — beyond 8× even of GB200
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
