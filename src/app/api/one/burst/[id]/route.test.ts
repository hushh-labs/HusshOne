import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({ uid: "firebase-1", email: "u@example.com", name: "U", picture: null, provider: "google" })),
}));

vi.mock("@/lib/db/burst-store", () => ({
  getOwnedBurstJob: vi.fn(),
  completeBurstJob: vi.fn(async () => undefined),
  failBurstJob: vi.fn(async () => undefined),
}));

vi.mock("@/lib/burst/provider-factory", () => ({
  getBurstProvider: vi.fn(() => ({ id: "mock" })),
}));

vi.mock("@/lib/burst/client", () => ({
  pollBurst: vi.fn(),
  teardownBurst: vi.fn(async () => undefined),
}));

function makeRequest() {
  return new Request("http://localhost/api/one/burst/burst-1", { headers: { Authorization: "Bearer test" } });
}
const ctx = { params: Promise.resolve({ id: "burst-1" }) };

const runningRow = {
  id: "burst-1",
  status: "running",
  placement: "gcp",
  provider: "mock",
  result: null,
  error: null,
  providerJobId: "p-1",
  instanceName: "mock-1",
  region: "us-central1",
  createdAt: new Date(),
};

describe("GET /api/one/burst/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the saved result for a completed burst", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue({ ...runningRow, status: "completed", result: { ok: 1 } } as never);
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ ok: true, status: "completed", result: { ok: 1 } });
  });

  it("resumes a running burst, completes it, and tears the instance down", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue(runningRow as never);
    const client = await import("@/lib/burst/client");
    vi.mocked(client.pollBurst).mockResolvedValue({ status: "completed", progress: "done", result: { done: true }, exitCode: 0, error: null });

    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();

    expect(json).toMatchObject({ ok: true, status: "completed", result: { done: true } });
    expect(client.teardownBurst).toHaveBeenCalledTimes(1);
    expect(store.completeBurstJob).toHaveBeenCalledWith("burst-1", { done: true }, expect.any(Object));
  });

  it("self-heals an abandoned (stale) running burst by failing it", async () => {
    const store = await import("@/lib/db/burst-store");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago > 2h stale window
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue({ ...runningRow, createdAt: old } as never);

    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ ok: false, status: "failed" });
    expect(store.failBurstJob).toHaveBeenCalled();
  });

  it("returns the auth status for an unauthorized recovery request", async () => {
    const auth = await import("@/lib/auth/verify");
    vi.mocked(auth.verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("Invalid session"), { statusCode: 401 }));
    const { GET } = await import("./route");
    const response = await GET(makeRequest(), ctx);
    expect(response.status).toBe(401);
  });

  it("returns 404 for an unknown burst id", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue(null);
    const { GET } = await import("./route");
    const response = await GET(makeRequest(), ctx);
    expect(response.status).toBe(404);
  });

  it("returns the saved error for a failed burst", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue({ ...runningRow, status: "failed", error: "boom" } as never);
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ ok: false, status: "failed", error: "boom" });
  });

  it("reports a Puppy job as running (it completes out-of-band)", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue({ ...runningRow, placement: "puppy" } as never);
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ status: "running", placement: "puppy" });
  });

  it("reports running when the provider job id was never recorded", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue({ ...runningRow, providerJobId: null } as never);
    const client = await import("@/lib/burst/client");
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ status: "running" });
    expect(client.pollBurst).not.toHaveBeenCalled();
  });

  it("tears down and fails the job when a resumed poll reports failure", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue(runningRow as never);
    const client = await import("@/lib/burst/client");
    vi.mocked(client.pollBurst).mockResolvedValue({ status: "failed", progress: null, result: null, exitCode: 1, error: "crashed" });
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ ok: false, status: "failed", error: "crashed" });
    expect(client.teardownBurst).toHaveBeenCalledTimes(1);
    expect(store.failBurstJob).toHaveBeenCalled();
  });

  it("reports running (does not crash) when a poll throws transiently", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue(runningRow as never);
    const client = await import("@/lib/burst/client");
    vi.mocked(client.pollBurst).mockRejectedValue(new Error("status check timed out"));
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ status: "running" });
  });

  it("dedupes a concurrent finalize: returns the result without re-completing", async () => {
    const store = await import("@/lib/db/burst-store");
    // First read → running (we proceed to poll); re-check after poll → already completed.
    vi.mocked(store.getOwnedBurstJob)
      .mockResolvedValueOnce(runningRow as never)
      .mockResolvedValueOnce({ ...runningRow, status: "completed", result: { won: "race" } } as never);
    const client = await import("@/lib/burst/client");
    vi.mocked(client.pollBurst).mockResolvedValue({ status: "completed", progress: "done", result: { ignored: true }, exitCode: 0, error: null });

    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ ok: true, status: "completed", result: { won: "race" } });
    // The other request already finalized → we must NOT complete/teardown again.
    expect(store.completeBurstJob).not.toHaveBeenCalled();
    expect(client.teardownBurst).not.toHaveBeenCalled();
  });

  it("reports running for a real-cloud resume when no env/ADC creds are resolvable", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJob).mockResolvedValue({ ...runningRow, provider: "gcp" } as never);
    const factory = await import("@/lib/burst/provider-factory");
    vi.mocked(factory.getBurstProvider).mockReturnValueOnce({ id: "gcp" } as never);
    const client = await import("@/lib/burst/client");
    // No BYOC_GCP_* env → resolveGcpCreds throws → we can only report running.
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest(), ctx)).json();
    expect(json).toMatchObject({ status: "running" });
    expect(client.pollBurst).not.toHaveBeenCalled();
  });
});
