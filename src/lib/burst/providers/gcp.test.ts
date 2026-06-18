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

  it("threads container env vars into the startup-script as docker -e flags", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, 200, { name: "op" }));
    vi.stubGlobal("fetch", fetchMock);
    await gcpBurstProvider.provision(spec({ env: { MODEL: "llama", SEED: "7" }, command: ["python", "train.py"] }), creds);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const startup = body.metadata.items.find((i: { key: string }) => i.key === "startup-script").value as string;
    expect(startup).toContain("-e 'MODEL'='llama'");
    expect(startup).toContain("-e 'SEED'='7'");
    expect(startup).toContain("'python' 'train.py'");
  });

  it("requires a result bucket for TPU bursts (503 until ONE_BURST_TPU_RESULT_BUCKET is set)", async () => {
    delete process.env.ONE_BURST_TPU_RESULT_BUCKET;
    vi.stubGlobal("fetch", vi.fn());
    await expect(gcpBurstProvider.provision(spec({ acceleratorKind: "tpu" }), creds)).rejects.toMatchObject({
      statusCode: 503,
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

  it("honors an explicit zone and custom machine type", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, 200, { name: "op" }));
    vi.stubGlobal("fetch", fetchMock);
    await gcpBurstProvider.provision(spec({ zone: "europe-west4-b", machineType: "a2-highgpu-1g" }), creds);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/zones/europe-west4-b/instances");
    expect(JSON.parse(init.body as string).machineType).toContain("a2-highgpu-1g");
  });

  it("requires credentials to provision", async () => {
    await expect(gcpBurstProvider.provision(spec(), null)).rejects.toMatchObject({ statusCode: 503 });
  });

  describe("pollStatus", () => {
    const prov = { providerJobId: "j", instanceName: "hussh-burst-x", zone: "us-central1-a" };
    const attrs = (items: Array<{ key: string; value: string }>) => ({ queryValue: { items } });

    it("reports provisioning when guest attributes don't exist yet (404)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(false, 404, { error: { message: "no attrs" } })));
      const result = await gcpBurstProvider.pollStatus(prov, creds, { fast: true });
      expect(result.status).toBe("provisioning");
    });

    it("reports running while the workload runs", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(true, 200, attrs([{ key: "status", value: "running" }]))));
      expect((await gcpBurstProvider.pollStatus(prov, creds, { fast: true })).status).toBe("running");
    });

    it("reports completed with the result blob and exit code", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(true, 200, attrs([
            { key: "status", value: "completed" },
            { key: "exitCode", value: "0" },
            { key: "result", value: "all good" },
          ])),
        ),
      );
      const result = await gcpBurstProvider.pollStatus(prov, creds, { fast: true });
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.result).toBe("all good");
    });

    it("reports failed with the exit code", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(true, 200, attrs([
            { key: "status", value: "failed" },
            { key: "exitCode", value: "137" },
          ])),
        ),
      );
      const result = await gcpBurstProvider.pollStatus(prov, creds, { fast: true });
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/137/);
    });

    it("reports provisioning for an unrecognized/empty marker", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(true, 200, attrs([]))));
      expect((await gcpBurstProvider.pollStatus(prov, creds, { fast: true })).status).toBe("provisioning");
    });

    it("requires credentials to poll", async () => {
      await expect(gcpBurstProvider.pollStatus(prov, null)).rejects.toMatchObject({ statusCode: 503 });
    });

    it("propagates a non-404 error from the guest-attributes read", async () => {
      process.env.ONE_BURST_RETRIES = "0";
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(false, 500, { error: { message: "boom" } })));
      await expect(gcpBurstProvider.pollStatus(prov, creds, { fast: true })).rejects.toMatchObject({ upstreamStatus: 500 });
    });
  });

  it("teardown propagates a non-404 delete error", async () => {
    process.env.ONE_BURST_RETRIES = "0";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(false, 500, { error: { message: "server" } })));
    await expect(
      gcpBurstProvider.teardown({ providerJobId: "j", instanceName: "vm", zone: "z" }, creds),
    ).rejects.toMatchObject({ upstreamStatus: 500 });
  });

  it("teardown issues a DELETE and resolves on success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, 200, { name: "del-op" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      gcpBurstProvider.teardown({ providerJobId: "j", instanceName: "hussh-burst-x", zone: "us-central1-a" }, creds),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("/instances/hussh-burst-x");
  });

  it("teardown is a no-op when teardown is disabled via env", async () => {
    process.env.ONE_BURST_TEARDOWN = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await gcpBurstProvider.teardown({ providerJobId: "j", instanceName: "vm", zone: "z" }, creds);
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.ONE_BURST_TEARDOWN;
  });

  it("teardown is a no-op when there is no instance to delete", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await gcpBurstProvider.teardown({ providerJobId: "j", instanceName: undefined, zone: "z" }, creds);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
