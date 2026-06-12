import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCOPES,
  buildAuthorizeUrl,
  decodeJwt,
  isLocalhostRedirectUri,
  linkedInCallbackUriForOrigin,
  parseUnauthorizedScopes,
  runDataProbes,
  sanitizeScopes,
} from "./oauth";

const b64url = (obj: unknown) =>
  Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("sanitizeScopes", () => {
  it("keeps only known scopes, de-dupes, preserves order", () => {
    expect(sanitizeScopes("openid profile openid bogus email")).toEqual(["openid", "profile", "email"]);
    expect(sanitizeScopes(["w_member_social", "not_a_scope", "r_ads"])).toEqual(["w_member_social", "r_ads"]);
    expect(sanitizeScopes("")).toEqual([]);
    expect(sanitizeScopes(null)).toEqual([]);
  });
});

describe("parseUnauthorizedScopes", () => {
  it("extracts the exact offending scope without false substring matches", () => {
    expect(parseUnauthorizedScopes('Scope "r_ads" is not authorized for your application')).toEqual(["r_ads"]);
    // r_ads must NOT be matched inside r_ads_reporting
    expect(parseUnauthorizedScopes("Scope r_ads_reporting is not authorized")).toEqual(["r_ads_reporting"]);
    expect(parseUnauthorizedScopes("nothing relevant here")).toEqual([]);
    expect(parseUnauthorizedScopes(null)).toEqual([]);
  });
});

describe("decodeJwt", () => {
  it("decodes header and payload of a JWT (no signature check)", () => {
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iss: "https://www.linkedin.com", sub: "abc", aud: "client123" };
    const jwt = `${b64url(header)}.${b64url(payload)}.sig`;
    const decoded = decodeJwt(jwt);
    expect(decoded?.header).toEqual(header);
    expect(decoded?.payload).toEqual(payload);
    expect(decoded?.error).toBeUndefined();
  });

  it("returns an error for a non-JWT string, and null for empty", () => {
    expect(decodeJwt("not-a-jwt")?.error).toMatch(/not a JWT/i);
    expect(decodeJwt("")).toBeNull();
    expect(decodeJwt(null)).toBeNull();
  });
});

describe("OAuth redirect helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds authorize URLs with an explicit callback URI for the active local origin", () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "client-123");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "secret-456");
    vi.stubEnv("LINKEDIN_REDIRECT_URI", "http://localhost:3000/api/linkedin/callback");

    const redirectUri = linkedInCallbackUriForOrigin("http://localhost:3001");
    const url = new URL(buildAuthorizeUrl({ scopes: ["openid", "profile"], state: "state-abc", redirectUri }));

    expect(redirectUri).toBe("http://localhost:3001/api/linkedin/callback");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("openid profile");
  });

  it("recognizes localhost redirect URIs so local port fallbacks can follow the running app", () => {
    expect(isLocalhostRedirectUri("http://localhost:3000/api/linkedin/callback")).toBe(true);
    expect(isLocalhostRedirectUri("http://127.0.0.1:3001/api/linkedin/callback")).toBe(true);
    expect(isLocalhostRedirectUri("https://one.hushh.ai/api/linkedin/callback")).toBe(false);
  });
});

describe("runDataProbes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("attempts every read probe (granted or not); never calls the write-only probe", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ paging: { total: 42 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const probes = await runDataProbes("tok", ["r_organization_admin", "w_member_social"]);
    const byKey = Object.fromEntries(probes.map((p) => [p.key, p]));
    const readProbes = probes.filter((p) => p.kind === "read");

    // granted read probe → attempted, has a result, granted flag true
    expect(byKey.org_acls.granted).toBe(true);
    expect(byKey.org_acls.attempted).toBe(true);
    expect(byKey.org_acls.result?.status).toBe(200);

    // granted but write-only → never called
    expect(byKey.w_member_social.kind).toBe("write-only");
    expect(byKey.w_member_social.granted).toBe(true);
    expect(byKey.w_member_social.attempted).toBe(false);

    // ungranted read probe → STILL attempted now (so the raw 401/403 is shown)
    expect(byKey.legacy_me.granted).toBe(false);
    expect(byKey.legacy_me.attempted).toBe(true);
    expect(byKey.legacy_me.result).toBeDefined();
    expect(byKey.dma_snapshot.attempted).toBe(true);

    // one HTTP call per read probe; write-only made none
    expect(fetchMock).toHaveBeenCalledTimes(readProbes.length);

    // the org_acls call carried the bearer + versioned header
    const orgCall = fetchMock.mock.calls.find((c) => String((c as unknown[])[0]).includes("/rest/organizationAcls"));
    expect(orgCall).toBeTruthy();
    const headers = (orgCall as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["LinkedIn-Version"]).toBeTruthy();
  });
});

describe("DEFAULT_SCOPES", () => {
  it("is the self-serve set enabled on this app (incl. r_profile_basicinfo + r_verify)", () => {
    expect(DEFAULT_SCOPES).toEqual(["openid", "profile", "email", "w_member_social", "r_profile_basicinfo", "r_verify"]);
  });
});
