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
});
