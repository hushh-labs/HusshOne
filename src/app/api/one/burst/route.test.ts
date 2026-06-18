import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({ uid: "firebase-1", email: "u@example.com", name: "U", picture: null, provider: "google" })),
}));

vi.mock("@/lib/db/burst-store", () => ({
  createBurstJob: vi.fn(async () => ({ burstJobId: "burst-1" })),
  completeBurstJob: vi.fn(async () => undefined),
  failBurstJob: vi.fn(async () => undefined),
  markBurstProvisioned: vi.fn(async () => undefined),
}));

vi.mock("@/lib/burst/client", () => ({
  mockBurstEnabled: vi.fn(() => true), // force the mock provider path (no creds needed)
  startBurst: vi.fn(async () => ({
    provider: { id: "mock" },
    provision: { providerJobId: "p-1", instanceName: "mock-1", zone: "mock-zone-a" },
  })),
  pollBurst: vi.fn(async () => ({ status: "completed", progress: "done", result: { mock: true }, exitCode: 0, error: null })),
  teardownBurst: vi.fn(async () => undefined),
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/one/burst", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readStream(response: Response) {
  const text = await response.text();
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

// A workload too big for the Puppy → bursts to (mock) cloud.
const burstBody = {
  image: "busybox",
  acceleratorKind: "gpu",
  acceleratorCount: 1,
  estimate: { vramGb: 300, unifiedMemoryGb: 300, vcpus: 16, diskGb: 100, estimatedMinutes: 30 },
  deviceProfile: { online: true, unifiedMemoryGb: 192, diskFreeGb: 2048 },
};

describe("POST /api/one/burst", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams a cloud burst to completion and tears the instance down", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest(burstBody));
    expect(response.status).toBe(200);

    const lines = await readStream(response);
    expect(lines[0]?.type).toBe("start");
    expect(lines.at(-1)?.type).toBe("done");

    const client = await import("@/lib/burst/client");
    const store = await import("@/lib/db/burst-store");
    expect(client.startBurst).toHaveBeenCalled();
    expect(client.teardownBurst).toHaveBeenCalledTimes(1);
    expect(store.completeBurstJob).toHaveBeenCalledWith("burst-1", { mock: true }, expect.any(Object));
  });

  it("tears down AND fails the job when the workload fails", async () => {
    const client = await import("@/lib/burst/client");
    vi.mocked(client.pollBurst).mockResolvedValueOnce({ status: "failed", progress: null, result: null, exitCode: 1, error: "boom" });
    const store = await import("@/lib/db/burst-store");

    const { POST } = await import("./route");
    const response = await POST(makeRequest(burstBody));
    const lines = await readStream(response);

    expect(lines.at(-1)?.type).toBe("error");
    expect(client.teardownBurst).toHaveBeenCalledTimes(1);
    expect(store.failBurstJob).toHaveBeenCalled();
  });

  it("routes a small workload to the Puppy without provisioning anything", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest({
        ...burstBody,
        estimate: { vramGb: 8, unifiedMemoryGb: 8, vcpus: 4, diskGb: 20, estimatedMinutes: 5 },
      }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.placement).toBe("puppy");
    expect(json.handshake.target).toBe("puppy");

    const client = await import("@/lib/burst/client");
    expect(client.startBurst).not.toHaveBeenCalled();
  });

  it("rejects an invalid spec (missing image) with 400 and never provisions", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ ...burstBody, image: "" }));
    expect(response.status).toBe(400);

    const client = await import("@/lib/burst/client");
    expect(client.startBurst).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range acceleratorCount with 400", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ ...burstBody, acceleratorCount: 99 }));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/acceleratorCount/i);
  });

  it("returns the auth status when the request is unauthorized", async () => {
    const auth = await import("@/lib/auth/verify");
    vi.mocked(auth.verifyOneRequest).mockRejectedValueOnce(
      Object.assign(new Error("Missing authorization header"), { statusCode: 401 }),
    );
    const { POST } = await import("./route");
    const response = await POST(makeRequest(burstBody));
    expect(response.status).toBe(401);
  });

  it("returns 400 on an invalid JSON body", async () => {
    const { POST } = await import("./route");
    const bad = new Request("http://localhost/api/one/burst", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: "{not json",
    });
    const response = await POST(bad);
    expect(response.status).toBe(400);
  });

  it("emits a start frame naming the placement and provider", async () => {
    const { POST } = await import("./route");
    const lines = await readStream(await POST(makeRequest(burstBody)));
    expect(lines[0]).toMatchObject({ type: "start", placement: "gcp", provider: "mock" });
  });

  it("surfaces a BYOC credential error (503) when a cloud burst has no resolvable creds", async () => {
    const client = await import("@/lib/burst/client");
    // Force the real (non-mock) path so resolveGcpCreds runs; no BYOC env is set.
    vi.mocked(client.mockBurstEnabled).mockReturnValueOnce(false);
    const { POST } = await import("./route");
    const response = await POST(makeRequest(burstBody)); // no `byoc` block, no env
    expect(response.status).toBe(503);
    expect(client.startBurst).not.toHaveBeenCalled();
  });

  it("accepts per-request BYOC credentials and bursts to the customer's cloud", async () => {
    const client = await import("@/lib/burst/client");
    vi.mocked(client.mockBurstEnabled).mockReturnValueOnce(false); // real provider path
    const sa = JSON.stringify({ client_email: "svc@cust.iam.gserviceaccount.com", private_key: "PEM", project_id: "cust-proj" });

    const { POST } = await import("./route");
    const response = await POST(makeRequest({ ...burstBody, byoc: { serviceAccountJson: sa, region: "europe-west4" } }));
    expect(response.status).toBe(200);
    const lines = await readStream(response);
    expect(lines.at(-1)?.type).toBe("done");
    // The customer creds were resolved and handed to startBurst.
    const startArgs = vi.mocked(client.startBurst).mock.calls[0];
    expect(startArgs?.[1]).toMatchObject({ source: "request", projectId: "cust-proj", region: "europe-west4" });
  });

  it("streams running progress before completing", async () => {
    process.env.ONE_BURST_POLL_INTERVAL_MS = "1"; // don't wait the default 5s in tests
    const client = await import("@/lib/burst/client");
    vi.mocked(client.pollBurst)
      .mockResolvedValueOnce({ status: "running", progress: "Running… 50%", result: null, exitCode: null, error: null })
      .mockResolvedValueOnce({ status: "completed", progress: "done", result: { mock: true }, exitCode: 0, error: null });

    const { POST } = await import("./route");
    const lines = await readStream(await POST(makeRequest(burstBody)));
    expect(lines.some((l) => l.scanning === "Running… 50%")).toBe(true);
    expect(lines.at(-1)?.type).toBe("done");
    delete process.env.ONE_BURST_POLL_INTERVAL_MS;
  });

  it("hands off and tears down when the soft deadline is exceeded", async () => {
    process.env.ONE_BURST_DEADLINE_MS = "-1"; // deadline already passed → immediate handoff
    const client = await import("@/lib/burst/client");
    const store = await import("@/lib/db/burst-store");

    const { POST } = await import("./route");
    const lines = await readStream(await POST(makeRequest(burstBody)));
    expect(lines.at(-1)).toMatchObject({ type: "pending", reason: "deadline" });
    expect(client.teardownBurst).toHaveBeenCalledTimes(1);
    expect(store.failBurstJob).toHaveBeenCalled();
    delete process.env.ONE_BURST_DEADLINE_MS;
  });

  it("stops cleanly when the client disconnects mid-stream (no teardown — recovery owns it)", async () => {
    process.env.ONE_BURST_POLL_INTERVAL_MS = "5";
    const client = await import("@/lib/burst/client");
    // Never completes on its own — we cancel the consumer instead.
    vi.mocked(client.pollBurst).mockResolvedValue({ status: "running", progress: "Running…", result: null, exitCode: null, error: null });

    const { POST } = await import("./route");
    const response = await POST(makeRequest(burstBody));
    const reader = response.body!.getReader();
    await reader.read(); // consume the start frame
    await reader.cancel(); // simulate the client going away → triggers stream cancel()

    // The streamed request does not tear down on disconnect; the recovery route resumes it.
    expect(client.teardownBurst).not.toHaveBeenCalled();
    delete process.env.ONE_BURST_POLL_INTERVAL_MS;
  });
});
