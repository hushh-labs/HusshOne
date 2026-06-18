import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../credentials", () => ({
  mintAccessToken: vi.fn(async () => "test-access-token"),
}));

import { gcpBurstProvider } from "./gcp";
import type { JobSpec, ResolvedGcpCreds } from "../types";

const creds: ResolvedGcpCreds = { projectId: "cust-proj", region: "us-central1", source: "request" };

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return {
    image: "us-docker.pkg.dev/p/r/trainer:latest",
    acceleratorKind: "gpu",
    acceleratorCount: 2,
    estimate: { vramGb: 80, unifiedMemoryGb: 64, vcpus: 16, diskGb: 100, estimatedMinutes: 30 },
    ...over,
  };
}

function jsonResponse(ok: boolean, status: number, payload: unknown) {
  return { ok, status, json: async () => payload } as unknown as Response;
}

describe("gcpBurstProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ONE_BURST_DEFAULT_MACHINE_TYPE = "n1-standard-8";
    process.env.ONE_BURST_DEFAULT_GPU_TYPE = "nvidia-tesla-t4";
  });
  afterEach(() => {
    delete process.env.ONE_BURST_RETRIES;
  });

  it("provision builds an instances.insert with GPU accelerators, TERMINATE scheduling, and startup-script", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, 200, { name: "op-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await gcpBurstProvider.provision(spec(), creds);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/projects/cust-proj/zones/us-central1-a/instances");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.guestAccelerators[0].acceleratorCount).toBe(2);
    expect(body.guestAccelerators[0].acceleratorType).toContain("nvidia-tesla-t4");
    expect(body.scheduling.onHostMaintenance).toBe("TERMINATE");
    expect(body.labels["hussh-burst"]).toBe("1");
    const startup = body.metadata.items.find((i: { key: string }) => i.key === "startup-script");
    expect(startup.value).toContain("docker run");
    expect(result.instanceName).toMatch(/^hussh-burst-/);
  });

  it("rejects TPU bursts with 501 (Cloud TPU API not implemented in v1)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(gcpBurstProvider.provision(spec({ acceleratorKind: "tpu" }), creds)).rejects.toMatchObject({
      statusCode: 501,
    });
  });

  it("teardown deletes the instance and treats a 404 as already-gone", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(false, 404, { error: { message: "not found" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      gcpBurstProvider.teardown({ providerJobId: "j", instanceName: "hussh-burst-x", zone: "us-central1-a" }, creds),
    ).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("retries a transient 503 then succeeds", async () => {
    process.env.ONE_BURST_RETRIES = "2";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(false, 503, { error: { message: "unavailable" } }))
      .mockResolvedValueOnce(jsonResponse(true, 200, { name: "op-2" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await gcpBurstProvider.provision(spec(), creds);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.providerJobId).toBeTruthy();
  });

  it("does not retry a non-transient 403", async () => {
    process.env.ONE_BURST_RETRIES = "2";
    const fetchMock = vi.fn(async () => jsonResponse(false, 403, { error: { message: "forbidden" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(gcpBurstProvider.provision(spec(), creds)).rejects.toMatchObject({ upstreamStatus: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
