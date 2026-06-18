/* End-to-end through the REAL burst layer (no mocks): provider-factory → mock provider
   → client lifecycle. Proves placement + provision/poll/teardown work without GCP. */
import { beforeAll, describe, expect, it } from "vitest";
import { decidePlacement, DEFAULT_PUPPY_PROFILE } from "./placement";
import { pollBurst, startBurst, teardownBurst } from "./client";
import type { JobSpec } from "./types";

beforeAll(() => {
  process.env.ONE_ENABLE_MOCK_BURST = "true";
  process.env.ONE_BURST_MOCK_DURATION_MS = "20";
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const spec: JobSpec = {
  image: "busybox",
  acceleratorKind: "gpu",
  acceleratorCount: 1,
  estimate: { vramGb: 300, unifiedMemoryGb: 300, vcpus: 16, diskGb: 100, estimatedMinutes: 30 },
};

describe("burst client + mock provider (integration)", () => {
  it("a too-big workload bursts and runs to completion, then tears down", async () => {
    const placement = decidePlacement(spec.estimate, DEFAULT_PUPPY_PROFILE, spec.acceleratorKind);
    expect(placement.target).toBe("gcp");

    const { provider, provision } = await startBurst(spec, null, "mock");
    expect(provider.id).toBe("mock");
    expect(provision.providerJobId).toBeTruthy();

    let final;
    for (let i = 0; i < 50; i += 1) {
      final = await pollBurst(provider, provision, null);
      if (final.status === "completed" || final.status === "failed") break;
      await sleep(10);
    }
    expect(final?.status).toBe("completed");
    expect(final?.result).toMatchObject({ mock: true });

    await expect(teardownBurst(provider, provision, null)).resolves.toBeUndefined();
    // After teardown the job is gone — a subsequent poll reports failure (unknown job).
    const afterTeardown = await pollBurst(provider, provision, null);
    expect(afterTeardown.status).toBe("failed");
  });

  it("a fail:// image surfaces as a failed workload", async () => {
    const { provider, provision } = await startBurst({ ...spec, image: "fail://boom" }, null, "mock");
    let final;
    for (let i = 0; i < 50; i += 1) {
      final = await pollBurst(provider, provision, null);
      if (final.status === "completed" || final.status === "failed") break;
      await sleep(10);
    }
    expect(final?.status).toBe("failed");
    await teardownBurst(provider, provision, null);
  });
});
