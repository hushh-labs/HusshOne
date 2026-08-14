import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validV4UpstreamResponse } from "@/test/nws-v4-fixtures";

const auth = vi.hoisted(() => ({
  verify: vi.fn(),
}));

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: auth.verify,
}));

import {
  DEFAULT_NWS_V4_BASE_URL,
  MAX_NWS_REQUEST_BYTES,
  NWS_UPSTREAM_TIMEOUT_MS,
  NWS_V4_CONSENT_PATH,
  NWS_V4_DISCOVER_PATH,
  POST,
} from "./route";

const NWS_DISCOVER_REQUEST_ID = `req-${"d".repeat(32)}`;
let requestNumber = 0;

function makeRequest(
  body: unknown,
  options: {
    authorization?: string | null;
    contentType?: string | null;
    ip?: string;
    serializedBody?: string;
  } = {},
) {
  requestNumber += 1;
  const headers = new Headers({
    "X-Forwarded-For": options.ip ?? `198.51.100.${requestNumber}`,
  });
  if (options.authorization !== null) {
    headers.set("Authorization", options.authorization ?? "Bearer firebase-token");
  }
  if (options.contentType !== null) {
    headers.set("Content-Type", options.contentType ?? "application/json");
  }

  return new Request("https://intelligence.hushh.ai/api/nws/v4/nearby", {
    method: "POST",
    headers,
    body: options.serializedBody ?? JSON.stringify(body),
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = { "X-Request-ID": NWS_DISCOVER_REQUEST_ID },
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function bindAuditActorReference(body: unknown, init?: RequestInit): unknown {
  if (!body || typeof body !== "object" || !("request_policy" in body) || !init?.body) {
    return body;
  }
  const request = JSON.parse(String(init.body)) as {
    caller_context?: { audit_actor?: string };
  };
  const auditActor = request.caller_context?.audit_actor;
  if (!auditActor) return body;
  const reference = createHash("sha256")
    .update(`hushone-app\0${auditActor}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  const bound = structuredClone(body) as {
    request_policy: { audit_actor_reference: string };
  };
  bound.request_policy.audit_actor_reference = `actor_${reference}`;
  return bound;
}

function mockDiscover(
  body: unknown = validV4UpstreamResponse(),
  status = 200,
  headers?: HeadersInit,
) {
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
    jsonResponse(bindAuditActorReference(body, init), status, headers),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function upstreamBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) {
  return JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;
}

describe("POST /api/nws/v4/nearby", () => {
  beforeEach(() => {
    requestNumber = Math.floor(Math.random() * 100) + 1;
    vi.stubEnv("NWS_NEARBY_V4_API_KEY", "server-only-v4-secret");
    vi.stubEnv("NWS_NEARBY_V4_ACTOR_HMAC_KEY", "a-dedicated-actor-key-with-32-plus-bytes"); // gitleaks:allow
    vi.stubEnv("NWS_NEARBY_V4_BASE_URL", DEFAULT_NWS_V4_BASE_URL);
    auth.verify.mockReset();
    auth.verify.mockResolvedValue({
      uid: "firebase-uid-a",
      email: "person@example.com",
      name: "Person",
      picture: null,
      provider: "google",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("calls the approved v4 discovery route with a server-held key and curated response", async () => {
    const fetchMock = mockDiscover(validV4UpstreamResponse({ resultCount: 2, discoveredCount: 7 }));
    const response = await POST(
      makeRequest({ query: { postal_code: " 32301 ", country_code: "us" }, count: 100 }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const body = upstreamBody(fetchMock);

    expect(url).toBe(`${DEFAULT_NWS_V4_BASE_URL}${NWS_V4_DISCOVER_PATH}`);
    expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("x-nws-api-key")).toBe("server-only-v4-secret");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-request-id")).toBeNull();
    expect(body).toMatchObject({
      query: { postal_code: "32301", country_code: "US" },
      selection: { count: 100, financial_mode: "estimated", geography_mode: "nearest-count" },
      filters: { minimum_confidence: "C", minimum_coverage: 0.55, asset_families: [] },
      caller_context: {
        project_id: "hushone-app",
        purpose_id: "NET_WORTH_LOOKUP",
        authorization_scope: "PUBLIC_SAFE",
        requested_data_tier: "PUBLIC_SAFE",
        model_version: "net-worth-v1.0.0",
      },
    });
    expect((body.caller_context as { audit_actor: string }).audit_actor).toMatch(
      /^one-user:[0-9a-f]{32}$/,
    );

    const wire = JSON.stringify(payload);
    expect(payload).toMatchObject({
      financial_coverage: { discovered_count: 7, eligible_count: 2 },
      result_set: { returned_count: 2, shortfall_count: 98, target_satisfied: false },
    });
    expect(wire).not.toContain("server-only-v4-secret");
    expect(wire).not.toContain("firebase-uid-a");
    expect(wire).not.toContain("components");
    expect(wire).not.toContain("audit_actor");
    expect(response.headers.get("x-request-id")).toMatch(/^nwsbff_[0-9a-f-]{36}$/);
    expect(response.headers.get("x-nws-request-id")).toBe(NWS_DISCOVER_REQUEST_ID);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("accepts the production 60637 expansion at the rounded 500 km boundary", async () => {
    const upstream = validV4UpstreamResponse({ resultCount: 0, discoveredCount: 60 });
    Object.assign(upstream.query, {
      label: "Chicago, Illinois 60637 query area",
      postal_code: "60637",
    });
    Object.assign(upstream.expansion, {
      upstream_strategy: "LEGACY_RADIUS",
      effective_radius_miles: 310.69,
      disclosure_code: "UPSTREAM_PER_STEP_COUNTS_UNAVAILABLE",
    });
    Object.assign(upstream.expansion.steps[0]!, {
      order: 8,
      stage: "LEGACY_RADIUS",
      radius_miles: 310.69,
    });
    mockDiscover(upstream);

    const response = await POST(
      makeRequest({ query: { postal_code: "60637", country_code: "US" }, count: 100 }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      query: { postal_code: "60637" },
      expansion: {
        upstream_strategy: "LEGACY_RADIUS",
        effective_radius_miles: 310.69,
        maximum_radius_reached: true,
      },
      financial_coverage: { discovered_count: 60, eligible_count: 0 },
      result_set: { returned_count: 0, shortfall_count: 100 },
    });
  });

  it("keeps each user's opaque actor stable across NWS API-key rotation", async () => {
    const fetchMock = mockDiscover();
    const requestBody = { query: { postal_code: "32301" }, count: 100 };

    await POST(makeRequest(requestBody));
    await POST(makeRequest(requestBody));
    vi.stubEnv("NWS_NEARBY_V4_API_KEY", "rotated-server-only-v4-secret");
    await POST(makeRequest(requestBody));
    auth.verify.mockResolvedValue({
      uid: "firebase-uid-b",
      email: "other@example.com",
      name: null,
      picture: null,
      provider: "google",
    });
    await POST(makeRequest(requestBody));

    const actors = fetchMock.mock.calls.map(
      (_, index) =>
        (upstreamBody(fetchMock, index).caller_context as { audit_actor: string }).audit_actor,
    );
    expect(actors[0]).toBe(actors[1]);
    expect(actors[2]).toBe(actors[0]);
    expect(actors[3]).not.toBe(actors[0]);
    expect(actors.join(" ")).not.toContain("firebase-uid");
    expect(actors.join(" ")).not.toContain("@");
  });

  it("fails closed without a verified signed-in user", async () => {
    auth.verify.mockRejectedValue(Object.assign(new Error("Invalid session"), { statusCode: 401 }));
    const fetchMock = mockDiscover();

    const response = await POST(
      makeRequest({ query: { postal_code: "32301" } }, { authorization: null }),
    );

    await expect(response.json()).resolves.toMatchObject({
      code: "authentication_required",
      retryable: false,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toMatch(/^nwsbff_/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the v4 secret and never falls back to the legacy key", async () => {
    vi.stubEnv("NWS_NEARBY_V4_API_KEY", "");
    vi.stubEnv("NWS_NEARBY_API_KEY", "legacy-shared-key");
    const fetchMock = mockDiscover();

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("legacy-shared-key");
  });

  it("fails closed without a dedicated actor pseudonymization key", async () => {
    vi.stubEnv("NWS_NEARBY_V4_ACTOR_HMAC_KEY", "");
    const fetchMock = mockDiscover();

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an undersized actor pseudonymization key", async () => {
    vi.stubEnv("NWS_NEARBY_V4_ACTOR_HMAC_KEY", "too-short");
    const fetchMock = mockDiscover();

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example",
    "https://127.0.0.1",
    "https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app.evil.example",
    `${DEFAULT_NWS_V4_BASE_URL}/unexpected-path`,
  ])("refuses an unapproved upstream origin: %s", async (baseUrl) => {
    vi.stubEnv("NWS_NEARBY_V4_BASE_URL", baseUrl);
    const fetchMock = mockDiscover();

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints and binds coordinate consent before discovery without logging coordinates", async () => {
    const consentNwsRequestId = `req-${"c".repeat(32)}`;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith(NWS_V4_CONSENT_PATH)) {
        return jsonResponse(
          {
            receipt_id: `receipt:${"a".repeat(40)}`,
            purpose_id: "NET_WORTH_LOOKUP",
            audit_actor: body.audit_actor,
            scope: "APPROXIMATE_LOCATION_QUERY",
            issued_at: "2026-08-14T10:00:00+00:00",
            expires_at: "2026-08-14T10:05:00+00:00",
          },
          200,
          { "X-Request-ID": consentNwsRequestId },
        );
      }
      return jsonResponse(
        bindAuditActorReference(
          validV4UpstreamResponse({ queryMode: "COARSE_COORDINATE" }),
          init,
        ),
        200,
        { "X-Request-ID": NWS_DISCOVER_REQUEST_ID },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      makeRequest({
        query: { latitude: 47.6715, longitude: -122.2133 },
        count: 100,
        consent_granted: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${DEFAULT_NWS_V4_BASE_URL}${NWS_V4_CONSENT_PATH}`,
    );
    const consentBody = upstreamBody(fetchMock, 0);
    const discoverBody = upstreamBody(fetchMock, 1);
    expect(consentBody).toMatchObject({
      project_id: "hushone-app",
      purpose_id: "NET_WORTH_LOOKUP",
      scope: "APPROXIMATE_LOCATION_QUERY",
      consent_granted: true,
    });
    expect(consentBody).not.toHaveProperty("query");
    expect(JSON.stringify(consentBody)).not.toContain("47.67");
    expect(discoverBody).toMatchObject({
      query: { latitude: 47.67, longitude: -122.21 },
      coordinate_consent: {
        purpose_id: "NET_WORTH_LOOKUP",
        audit_actor: consentBody.audit_actor,
      },
      caller_context: { audit_actor: consentBody.audit_actor },
    });
    expect(response.headers.get("x-nws-request-id")).toBe(NWS_DISCOVER_REQUEST_ID);

    const logs = JSON.stringify(info.mock.calls);
    expect(logs).toContain(consentNwsRequestId);
    expect(logs).toContain(NWS_DISCOVER_REQUEST_ID);
    expect(logs).not.toContain("47.67");
    expect(logs).not.toContain("-122.21");
    expect(logs).not.toContain("firebase-uid-a");
    expect(logs).not.toContain("person@example.com");
    expect(logs).not.toContain("server-only-v4-secret");
    expect(logs).not.toContain("a-dedicated-actor-key-with-32-plus-bytes");
    expect(JSON.stringify(await response.json())).not.toContain("latitude");
  });

  it.each([
    { query: { latitude: 47.67, longitude: -122.21 } },
    { query: { postal_code: "98033" }, consent_granted: true },
    { query: { postal_code: "980-33" } },
    { query: { postal_code: "98033" }, count: 50 },
    { query: { postal_code: "98033" }, extra: "field" },
  ])("rejects invalid client input before calling NWS: %#", async (body) => {
    const fetchMock = mockDiscover();
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds media type, JSON, and request size", async () => {
    const fetchMock = mockDiscover();
    const unsupported = await POST(
      makeRequest({}, { contentType: "text/plain", serializedBody: "{}" }),
    );
    const malformed = await POST(makeRequest({}, { serializedBody: "{" }));
    const oversized = await POST(
      makeRequest({}, { serializedBody: JSON.stringify({ data: "x".repeat(MAX_NWS_REQUEST_BYTES) }) }),
    );

    expect(unsupported.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 503, "service_unavailable"],
    [403, 503, "service_unavailable"],
    [409, 409, "coverage_unavailable"],
    [422, 422, "invalid_request"],
    [429, 429, "rate_limited"],
    [500, 503, "service_unavailable"],
  ] as const)("maps NWS %s without exposing its body", async (upstreamStatus, status, code) => {
    mockDiscover({ detail: "private upstream detail" }, upstreamStatus, {
      "X-Request-ID": NWS_DISCOVER_REQUEST_ID,
      "Retry-After": "99999",
    });

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));
    const payload = await response.json();

    expect(response.status).toBe(status);
    expect(payload).toMatchObject({ code });
    expect(JSON.stringify(payload)).not.toContain("private upstream detail");
    expect(response.headers.get("x-nws-request-id")).toBe(NWS_DISCOVER_REQUEST_ID);
    if (upstreamStatus === 429) expect(response.headers.get("retry-after")).toBe("3600");
  });

  it("fails closed on malformed, expanded, or mismatched upstream data", async () => {
    const expanded = validV4UpstreamResponse();
    Object.assign(expanded, { private_payload: { email: "secret@example.com" } });
    const fetchMock = mockDiscover(expanded);

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "invalid_upstream_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a response bound to another audit actor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(validV4UpstreamResponse({ auditActorReference: "actor_deadbeefdeadbeef" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "invalid_upstream_response" });
  });

  it("omits an untrusted upstream correlation header", async () => {
    mockDiscover(validV4UpstreamResponse(), 200, { "X-Request-ID": "attacker-controlled" });

    const response = await POST(makeRequest({ query: { postal_code: "32301" } }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^nwsbff_/);
    expect(response.headers.get("x-nws-request-id")).toBeNull();
  });

  it("times out the whole upstream flow", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = POST(makeRequest({ query: { postal_code: "32301" } }));
    await vi.advanceTimersByTimeAsync(NWS_UPSTREAM_TIMEOUT_MS + 1);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "upstream_timeout", retryable: true });
  });

  it("applies a bounded same-origin abuse budget", async () => {
    mockDiscover();
    const ip = `203.0.113.${Math.floor(Math.random() * 100) + 100}`;
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      statuses.push(
        (await POST(makeRequest({ query: { postal_code: "32301" } }, { ip }))).status,
      );
    }

    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(statuses[20]).toBe(429);
  });
});
