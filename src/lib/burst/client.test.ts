import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const provider = {
    id: "gcp" as "gcp" | "mock",
    provision: vi.fn(async () => ({ providerJobId: "p-1", instanceName: "vm-1", zone: "us-central1-a" })),
    submit: vi.fn(async () => undefined),
    pollStatus: vi.fn(async () => ({ status: "running", progress: null, result: null, exitCode: null, error: null })),
    teardown: vi.fn(async () => undefined),
  };
  return { provider };
});

vi.mock("./provider-factory", () => ({
  getBurstProvider: vi.fn(() => h.provider),
  mockBurstEnabled: vi.fn(() => false),
}));

import { pollBurst, startBurst, teardownBurst } from "./client";
import type { ComputeBurstProvider, JobSpec, ResolvedGcpCreds } from "./types";

const asProvider = (p: typeof h.provider) => p as unknown as ComputeBurstProvider;

const spec: JobSpec = {
  image: "busybox",
  acceleratorKind: "gpu",
  acceleratorCount: 1,
  estimate: { vramGb: 10, unifiedMemoryGb: 10, vcpus: 2, diskGb: 10, estimatedMinutes: 5 },
};
const creds: ResolvedGcpCreds = { projectId: "p", region: "us-central1", source: "request" };

describe("burst client wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.provider.id = "gcp";
  });

  it("startBurst provisions then submits, passing creds through for a cloud provider", async () => {
    const { provision } = await startBurst(spec, creds, "gcp");
    expect(provision.providerJobId).toBe("p-1");
    expect(h.provider.provision).toHaveBeenCalledWith(spec, creds);
    expect(h.provider.submit).toHaveBeenCalledWith(spec, provision, creds);
  });

  it("nulls creds out for the mock provider (mock must not require credentials)", async () => {
    h.provider.id = "mock";
    await startBurst(spec, creds, "mock");
    expect(h.provider.provision).toHaveBeenCalledWith(spec, null);
  });

  it("pollBurst delegates to the provider with opts", async () => {
    const prov = { providerJobId: "p-1", instanceName: "vm-1", zone: "z" };
    await pollBurst(asProvider(h.provider), prov, creds, { fast: true });
    expect(h.provider.pollStatus).toHaveBeenCalledWith(prov, creds, { fast: true });
  });

  it("teardownBurst never throws even when the provider teardown fails (cost cleanup must not mask errors)", async () => {
    h.provider.teardown.mockRejectedValueOnce(new Error("delete failed"));
    const prov = { providerJobId: "p-1", instanceName: "vm-1", zone: "z" };
    await expect(teardownBurst(asProvider(h.provider), prov, creds)).resolves.toBeUndefined();
  });
});
