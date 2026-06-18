import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBurstProvider } from "./mock";
import type { JobSpec } from "../types";

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return {
    image: "busybox",
    acceleratorKind: "gpu",
    acceleratorCount: 1,
    estimate: { vramGb: 10, unifiedMemoryGb: 10, vcpus: 2, diskGb: 10, estimatedMinutes: 5 },
    ...over,
  };
}

describe("mockBurstProvider", () => {
  beforeEach(() => {
    process.env.ONE_BURST_MOCK_DURATION_MS = "1000";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ONE_BURST_MOCK_DURATION_MS;
    delete process.env.ONE_BURST_MOCK_MAX_JOBS;
  });

  it("walks provisioning → running → completed over the simulated duration", async () => {
    const prov = await mockBurstProvider.provision(spec(), null);
    expect(prov.providerJobId).toBeTruthy();
    expect(prov.instanceName).toMatch(/^mock-/);

    // t=0 → provisioning (< 35% of 1000ms)
    expect((await mockBurstProvider.pollStatus(prov, null)).status).toBe("provisioning");
    // t=500 → running
    vi.setSystemTime(Date.now() + 500);
    const running = await mockBurstProvider.pollStatus(prov, null);
    expect(running.status).toBe("running");
    expect(running.progress).toMatch(/%/);
    // t=1100 → completed
    vi.setSystemTime(Date.now() + 600);
    const done = await mockBurstProvider.pollStatus(prov, null);
    expect(done.status).toBe("completed");
    expect(done.exitCode).toBe(0);
    expect(done.result).toMatchObject({ mock: true });
  });

  it("simulates a failure for a fail:// image", async () => {
    const prov = await mockBurstProvider.provision(spec({ image: "fail://boom" }), null);
    vi.setSystemTime(Date.now() + 2000);
    const result = await mockBurstProvider.pollStatus(prov, null);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
  });

  it("reports an unknown job after teardown (no dangling state)", async () => {
    const prov = await mockBurstProvider.provision(spec(), null);
    await mockBurstProvider.teardown(prov, null);
    const result = await mockBurstProvider.pollStatus(prov, null);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unknown/i);
  });

  it("bounds the in-flight job table (abandoned jobs cannot leak)", async () => {
    vi.useRealTimers();
    const first = await mockBurstProvider.provision(spec(), null);
    // Flood past the default 1024-entry bound without tearing any down.
    for (let i = 0; i < 1100; i += 1) await mockBurstProvider.provision(spec(), null);
    // The very first (untouched, oldest) job has been evicted → polling it reports
    // unknown rather than being retained forever.
    const result = await mockBurstProvider.pollStatus(first, null);
    expect(result.status).toBe("failed");
  });
});
