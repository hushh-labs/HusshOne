import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  callGcp: vi.fn(),
  mintAccessToken: vi.fn(async () => "tok"),
  resolveGcpCreds: vi.fn(() => ({ projectId: "cust-proj", region: "us-central1", source: "request" })),
}));

vi.mock("./providers/gcp-common", () => ({ callGcp: h.callGcp, mintAccessToken: h.mintAccessToken }));
vi.mock("./credentials", () => ({ resolveGcpCreds: h.resolveGcpCreds }));

import { REQUIRED_PERMISSIONS, setupSteps, validateByocSetup } from "./setup";

function check(v: Awaited<ReturnType<typeof validateByocSetup>>, id: string) {
  return v.checks.find((c) => c.id === id);
}

describe("setupSteps", () => {
  it("returns a short, ordered, plain-English guide ending in 'paste the key'", () => {
    const steps = setupSteps("us-central1");
    expect(steps.map((s) => s.id)).toEqual(["project", "enable-api", "create-key", "gpu-quota", "connect"]);
    expect(steps.length).toBeLessThanOrEqual(5);
    expect(steps.at(-1)?.id).toBe("connect");
  });
});

describe("validateByocSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolveGcpCreds.mockReturnValue({ projectId: "cust-proj", region: "us-central1", source: "request" });
    h.mintAccessToken.mockResolvedValue("tok");
  });

  it("passes every check when auth, permissions, and GPU quota are all good", async () => {
    h.callGcp
      .mockResolvedValueOnce({ permissions: [...REQUIRED_PERMISSIONS] }) // testIamPermissions
      .mockResolvedValueOnce({ quotas: [{ metric: "NVIDIA_T4_GPUS", limit: 4 }] }); // regions
    const v = await validateByocSetup({ serviceAccountJson: "{}" });
    expect(v.ready).toBe(true);
    expect(check(v, "auth")?.status).toBe("pass");
    expect(check(v, "permissions")?.status).toBe("pass");
    expect(check(v, "gpu-quota")?.status).toBe("pass");
  });

  it("fails fast with a credential check when the credential is invalid", async () => {
    h.resolveGcpCreds.mockImplementation(() => {
      throw Object.assign(new Error("BYOC service-account JSON is not valid JSON"), { statusCode: 400 });
    });
    const v = await validateByocSetup({ serviceAccountJson: "{bad" });
    expect(v.ready).toBe(false);
    expect(check(v, "credential")?.status).toBe("fail");
    expect(h.mintAccessToken).not.toHaveBeenCalled();
  });

  it("fails on auth when the key cannot mint a token", async () => {
    h.mintAccessToken.mockRejectedValue(Object.assign(new Error("nope"), { statusCode: 502 }));
    const v = await validateByocSetup({ serviceAccountJson: "{}" });
    expect(v.ready).toBe(false);
    expect(check(v, "auth")?.status).toBe("fail");
    expect(h.callGcp).not.toHaveBeenCalled();
  });

  it("reports the exact missing permissions", async () => {
    h.callGcp
      .mockResolvedValueOnce({ permissions: ["compute.instances.get"] }) // only one granted
      .mockResolvedValueOnce({ quotas: [] });
    const v = await validateByocSetup({ serviceAccountJson: "{}" });
    expect(v.ready).toBe(false);
    const perms = check(v, "permissions");
    expect(perms?.status).toBe("fail");
    expect(perms?.detail).toMatch(/compute\.instances\.create/);
  });

  it("explains a 403 as 'enable Compute Engine'", async () => {
    h.callGcp.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { upstreamStatus: 403 }));
    // quota probe still runs and warns
    h.callGcp.mockResolvedValueOnce({ quotas: [] });
    const v = await validateByocSetup({ serviceAccountJson: "{}" });
    expect(check(v, "permissions")?.status).toBe("fail");
    expect(check(v, "permissions")?.detail).toMatch(/Compute Engine/i);
  });

  it("warns (does not fail) when GPU quota is absent", async () => {
    h.callGcp
      .mockResolvedValueOnce({ permissions: [...REQUIRED_PERMISSIONS] })
      .mockResolvedValueOnce({ quotas: [{ metric: "CPUS", limit: 24 }] });
    const v = await validateByocSetup({ serviceAccountJson: "{}" });
    expect(v.ready).toBe(true); // quota is advisory
    expect(check(v, "gpu-quota")?.status).toBe("warn");
  });
});
