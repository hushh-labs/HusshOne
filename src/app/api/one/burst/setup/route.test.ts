import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({ uid: "u1", email: "u@example.com", name: "U", picture: null, provider: "google" })),
}));

function makeRequest(url = "http://localhost/api/one/burst/setup") {
  return new Request(url, { headers: { Authorization: "Bearer test" } });
}

describe("GET /api/one/burst/setup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the guided steps and required permissions", async () => {
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest())).json();
    expect(json.ok).toBe(true);
    expect(json.steps.map((s: { id: string }) => s.id)).toContain("connect");
    expect(json.requiredPermissions).toContain("compute.instances.create");
  });

  it("honors a region query param", async () => {
    const { GET } = await import("./route");
    const json = await (await GET(makeRequest("http://localhost/api/one/burst/setup?region=europe-west4"))).json();
    expect(json.region).toBe("europe-west4");
  });

  it("returns 401 when unauthorized", async () => {
    const auth = await import("@/lib/auth/verify");
    vi.mocked(auth.verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("no"), { statusCode: 401 }));
    const { GET } = await import("./route");
    expect((await GET(makeRequest())).status).toBe(401);
  });
});
