import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({ uid: "firebase-1", email: "u@example.com", name: "U", picture: null, provider: "google" })),
}));

vi.mock("@/lib/db/burst-store", () => ({
  getOwnedBurstJobStatus: vi.fn(),
  completeBurstJob: vi.fn(async () => undefined),
  failBurstJob: vi.fn(async () => undefined),
}));

const ctx = { params: Promise.resolve({ id: "burst-1" }) };
function makeRequest(body: unknown) {
  return new Request("http://localhost/api/one/burst/burst-1/puppy-result", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/one/burst/[id]/puppy-result", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a successful on-device run", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJobStatus).mockResolvedValue({ id: "burst-1", status: "running", placement: "puppy" } as never);
    const { POST } = await import("./route");
    const json = await (await POST(makeRequest({ status: "completed", result: { ok: 1 }, runMs: 1200 }), ctx)).json();
    expect(json).toMatchObject({ ok: true, status: "completed" });
    expect(store.completeBurstJob).toHaveBeenCalledWith("burst-1", { ok: 1 }, { runMs: 1200, totalMs: 1200 });
  });

  it("records a failed on-device run", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJobStatus).mockResolvedValue({ id: "burst-1", status: "running", placement: "puppy" } as never);
    const { POST } = await import("./route");
    const json = await (await POST(makeRequest({ status: "failed", error: "OOM on device" }), ctx)).json();
    expect(json).toMatchObject({ ok: true, status: "failed" });
    expect(store.failBurstJob).toHaveBeenCalledWith("burst-1", "OOM on device", expect.any(Object));
  });

  it("rejects an invalid status with 400", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest({ status: "weird" }), ctx);
    expect(response.status).toBe(400);
  });

  it("404s an unknown or unowned job", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJobStatus).mockResolvedValue(null);
    const { POST } = await import("./route");
    expect((await POST(makeRequest({ status: "completed" }), ctx)).status).toBe(404);
  });

  it("409s a cloud (non-Puppy) job — the control plane finalizes those", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJobStatus).mockResolvedValue({ id: "burst-1", status: "running", placement: "gcp" } as never);
    const { POST } = await import("./route");
    expect((await POST(makeRequest({ status: "completed" }), ctx)).status).toBe(409);
  });

  it("is idempotent: a report after the job already settled is a no-op success", async () => {
    const store = await import("@/lib/db/burst-store");
    vi.mocked(store.getOwnedBurstJobStatus).mockResolvedValue({ id: "burst-1", status: "completed", placement: "puppy" } as never);
    const { POST } = await import("./route");
    const json = await (await POST(makeRequest({ status: "completed" }), ctx)).json();
    expect(json).toMatchObject({ ok: true, idempotent: true });
    expect(store.completeBurstJob).not.toHaveBeenCalled();
  });

  it("returns the auth status when unauthorized", async () => {
    const auth = await import("@/lib/auth/verify");
    vi.mocked(auth.verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("nope"), { statusCode: 401 }));
    const { POST } = await import("./route");
    expect((await POST(makeRequest({ status: "completed" }), ctx)).status).toBe(401);
  });
});
