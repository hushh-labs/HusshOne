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
});
