import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared spies, hoisted so the google-auth-library mock factory can reference them.
const h = vi.hoisted(() => ({
  getAccessToken: vi.fn(async (): Promise<{ token: string | null }> => ({ token: "tok-123" })),
  jwtCtor: vi.fn(),
  googleAuthCtor: vi.fn(),
  authGetClient: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  JWT: class {
    constructor(opts: unknown) {
      h.jwtCtor(opts);
    }
    getAccessToken() {
      return h.getAccessToken();
    }
  },
  GoogleAuth: class {
    constructor(opts: unknown) {
      h.googleAuthCtor(opts);
    }
    getClient() {
      h.authGetClient();
      return Promise.resolve({ getAccessToken: h.getAccessToken });
    }
  },
}));

import { __resetAuthClientCacheForTests, mintAccessToken, resolveGcpCreds } from "./credentials";

const SA = JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: "PEM", project_id: "sa-proj" });

const BYOC_ENV = ["BYOC_GCP_SERVICE_ACCOUNT_JSON", "BYOC_GCP_PROJECT_ID", "BYOC_GCP_REGION"];

describe("resolveGcpCreds", () => {
  beforeEach(() => {
    for (const k of BYOC_ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of BYOC_ENV) delete process.env[k];
  });

  it("uses per-request service-account JSON first (source=request)", () => {
    const creds = resolveGcpCreds({ serviceAccountJson: SA });
    expect(creds.source).toBe("request");
    expect(creds.projectId).toBe("sa-proj");
    expect(creds.serviceAccountJson?.client_email).toBe("svc@proj.iam.gserviceaccount.com");
  });

  it("lets an explicit request projectId/region override the SA project", () => {
    const creds = resolveGcpCreds({ serviceAccountJson: SA, projectId: "override-proj", region: "europe-west4" });
    expect(creds.projectId).toBe("override-proj");
    expect(creds.region).toBe("europe-west4");
  });

  it("falls back to the env service account (source=env)", () => {
    process.env.BYOC_GCP_SERVICE_ACCOUNT_JSON = SA;
    const creds = resolveGcpCreds();
    expect(creds.source).toBe("env");
    expect(creds.projectId).toBe("sa-proj");
  });

  it("falls back to ADC when only a project id is configured (source=adc)", () => {
    process.env.BYOC_GCP_PROJECT_ID = "adc-proj";
    const creds = resolveGcpCreds();
    expect(creds.source).toBe("adc");
    expect(creds.projectId).toBe("adc-proj");
    expect(creds.serviceAccountJson).toBeUndefined();
  });

  it("defaults the region to us-central1", () => {
    process.env.BYOC_GCP_PROJECT_ID = "adc-proj";
    expect(resolveGcpCreds().region).toBe("us-central1");
  });

  it("throws 400 on malformed service-account JSON", () => {
    expect(() => resolveGcpCreds({ serviceAccountJson: "{not json" })).toThrow(/not valid JSON/i);
  });

  it("throws 400 when the service-account JSON is missing required fields", () => {
    expect(() => resolveGcpCreds({ serviceAccountJson: JSON.stringify({ client_email: "x" }) })).toThrow(
      /must include/i,
    );
  });

  it("throws 503 when no project can be determined", () => {
    try {
      resolveGcpCreds();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(503);
    }
  });
});

describe("mintAccessToken (auth-client caching)", () => {
  beforeEach(() => {
    __resetAuthClientCacheForTests();
    vi.clearAllMocks();
  });

  it("builds the JWT once and reuses it across calls (no re-sign per poll)", async () => {
    const creds = resolveGcpCreds({ serviceAccountJson: SA });
    const a = await mintAccessToken(creds);
    const b = await mintAccessToken(creds);
    expect(a).toBe("tok-123");
    expect(b).toBe("tok-123");
    // Client constructed ONCE; token fetched per call (the library caches it internally).
    expect(h.jwtCtor).toHaveBeenCalledTimes(1);
    expect(h.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("builds the ADC client once and reuses it", async () => {
    const creds = resolveGcpCreds({ projectId: "adc-proj" });
    await mintAccessToken(creds);
    await mintAccessToken(creds);
    expect(h.googleAuthCtor).toHaveBeenCalledTimes(1);
    expect(h.authGetClient).toHaveBeenCalledTimes(1);
  });

  it("throws 502 when the auth client returns no token", async () => {
    h.getAccessToken.mockResolvedValueOnce({ token: null });
    const creds = resolveGcpCreds({ serviceAccountJson: SA });
    await expect(mintAccessToken(creds)).rejects.toMatchObject({ statusCode: 502 });
  });
});
