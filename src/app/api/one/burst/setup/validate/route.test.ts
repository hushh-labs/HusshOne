import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({ uid: "u1", email: "u@example.com", name: "U", picture: null, provider: "google" })),
}));
vi.mock("@/lib/burst/setup", () => ({
  validateByocSetup: vi.fn(async () => ({
    ready: true,
    projectId: "cust-proj",
    region: "us-central1",
    checks: [{ id: "auth", label: "Sign-in to Google Cloud", status: "pass", detail: "ok" }],
  })),
}));

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/one/burst/setup/validate", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/one/burst/setup/validate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the validation checklist for the supplied BYOC creds", async () => {
    const { POST } = await import("./route");
    const json = await (await POST(makeRequest({ byoc: { serviceAccountJson: "{}", projectId: "cust-proj" } }))).json();
    expect(json).toMatchObject({ ok: true, ready: true, projectId: "cust-proj" });

    const setup = await import("@/lib/burst/setup");
    expect(setup.validateByocSetup).toHaveBeenCalledWith(
      expect.objectContaining({ serviceAccountJson: "{}", projectId: "cust-proj" }),
    );
  });

  it("returns 401 when unauthorized", async () => {
    const auth = await import("@/lib/auth/verify");
    vi.mocked(auth.verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("no"), { statusCode: 401 }));
    const { POST } = await import("./route");
    expect((await POST(makeRequest({}))).status).toBe(401);
  });
});
