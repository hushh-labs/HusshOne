import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../credentials", () => ({
  mintAccessToken: vi.fn(async () => "test-access-token"),
}));

import { gcpBurstProvider } from "./gcp";
import { pollTpu, provisionTpu, teardownTpu } from "./gcp-tpu";
import type { JobSpec, ProvisionResult, ResolvedGcpCreds } from "../types";

const creds: ResolvedGcpCreds = { projectId: "cust-proj", region: "us-central2", source: "request" };

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return {
    image: "us-docker.pkg.dev/p/r/trainer:latest",
    acceleratorKind: "tpu",
    acceleratorCount: 1,
    estimate: { vramGb: 512, unifiedMemoryGb: 512, vcpus: 96, diskGb: 200, estimatedMinutes: 60 },
    ...over,
  };
}
function jsonResponse(ok: boolean, status: number, payload: unknown) {
  return { ok, status, json: async () => payload, text: async () => String(payload) } as unknown as Response;
}
function textResponse(ok: boolean, status: number, text: string) {
  return { ok, status, json: async () => ({}), text: async () => text } as unknown as Response;
}

const prov: ProvisionResult = { providerJobId: "job-1", instanceName: "hushh-burst-x", zone: "us-central2-b", kind: "tpu" };

describe("TPU burst provider (Cloud TPU API + GCS result channel)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ONE_BURST_TPU_RESULT_BUCKET = "hushh-burst-results";
    process.env.ONE_BURST_DEFAULT_TPU_TYPE = "v5litepod-8";
    process.env.ONE_BURST_RETRIES = "0";
  });
  afterEach(() => {
    delete process.env.ONE_BURST_TPU_RESULT_BUCKET;
    delete process.env.ONE_BURST_DEFAULT_TPU_TYPE;
    delete process.env.ONE_BURST_RETRIES;
    delete process.env.ONE_BURST_TEARDOWN;
  });

  it("provisions a TPU node with acceleratorType, runtimeVersion, and a GCS-writing startup-script", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, 200, { name: "op" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await provisionTpu(spec({ env: { MODEL: "x" }, command: ["python", "run.py"] }), creds);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/projects/cust-proj/locations/us-central2-a/nodes?nodeId=hushh-burst-");
    const body = JSON.parse(init.body as string);
    expect(body.acceleratorType).toBe("v5litepod-8");
    expect(body.runtimeVersion).toBeTruthy();
    expect(body.metadata["startup-script"]).toContain("docker run");
    expect(body.metadata["startup-script"]).toContain("hushh-burst-results"); // GCS bucket in upload URL
    expect(body.metadata["startup-script"]).toContain("-e 'MODEL'='x'");
    expect(result.kind).toBe("tpu");
    expect(result.instanceName).toMatch(/^hushh-burst-/);
  });

  it("503s a TPU burst when no result bucket is configured", async () => {
    delete process.env.ONE_BURST_TPU_RESULT_BUCKET;
    vi.stubGlobal("fetch", vi.fn());
    await expect(provisionTpu(spec(), creds)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("dispatches a tpu JobSpec to the TPU path via the provider", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, 200, { name: "op" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await gcpBurstProvider.provision(spec(), creds);
    expect(result.kind).toBe("tpu");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("tpu.googleapis.com");
  });

  describe("pollTpu", () => {
    it("reports completed with result + exit code read from GCS", async () => {
      // status → "completed", then exitCode → "0", then result → "ok".
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(textResponse(true, 200, "completed"))
        .mockResolvedValueOnce(textResponse(true, 200, "0"))
        .mockResolvedValueOnce(textResponse(true, 200, "ok"));
      vi.stubGlobal("fetch", fetchMock);
      const r = await pollTpu(prov, creds, { fast: true });
      expect(r.status).toBe("completed");
      expect(r.exitCode).toBe(0);
      expect(r.result).toBe("ok");
    });

    it("reports failed when the GCS status is failed", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(textResponse(true, 200, "failed"))
        .mockResolvedValueOnce(textResponse(true, 200, "137"))
        .mockResolvedValueOnce(textResponse(true, 200, "oom"));
      vi.stubGlobal("fetch", fetchMock);
      const r = await pollTpu(prov, creds, { fast: true });
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/137/);
    });

    it("reports running while the workload runs", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => textResponse(true, 200, "running")));
      expect((await pollTpu(prov, creds, { fast: true })).status).toBe("running");
    });

    it("reports provisioning when the status object is absent and the node is CREATING", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(textResponse(false, 404, "")) // status object not written yet
        .mockResolvedValueOnce(jsonResponse(true, 200, { state: "CREATING" })); // node state
      vi.stubGlobal("fetch", fetchMock);
      expect((await pollTpu(prov, creds, { fast: true })).status).toBe("provisioning");
    });

    it("reports failed when the node entered a terminal bad state", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(textResponse(false, 404, ""))
        .mockResolvedValueOnce(jsonResponse(true, 200, { state: "PREEMPTED" }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await pollTpu(prov, creds, { fast: true })).status).toBe("failed");
    });
  });

  it("teardown deletes the TPU node (idempotent) and best-effort removes result objects", async () => {
    const calls: Array<{ method?: string; url: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: init?.method, url });
      return jsonResponse(true, 200, { name: "del-op" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await teardownTpu(prov, creds);
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes[0].url).toContain("tpu.googleapis.com");
    expect(deletes[0].url).toContain("/nodes/hushh-burst-x");
    expect(deletes.length).toBe(1 + 3); // node + 3 GCS objects
  });

  it("teardown is a no-op when disabled via env", async () => {
    process.env.ONE_BURST_TEARDOWN = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await teardownTpu(prov, creds);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
