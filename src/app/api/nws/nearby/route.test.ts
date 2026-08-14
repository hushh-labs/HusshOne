import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NWS_REQUEST_BYTES,
  NWS_UPSTREAM_TIMEOUT_MS,
  NWS_UPSTREAM_URL,
  POST,
} from "./route";

let requestNumber = 0;

function validUpstreamResponse() {
  const includedComponent = {
    status: "INCLUDED_IN_DECLARED_TOTAL",
    low_usd: null,
    most_likely_usd: null,
    high_usd: null,
    confidence: null,
  };
  return {
    query: {
      label: "Tallahassee, Florida 32301 query area",
      mode: "POSTAL_CODE",
      postal_code: "32301",
      country_code: "US",
      approximate: true,
    },
    coverage: {
      status: "COVERED",
      reason_code: "FLORIDA_PUBLIC_FORM_6_JURISDICTION",
      market_label: "Leon County public Form 6 jurisdiction",
      country_code: "US",
      complete: false,
      message: "The postal query is matched to a public disclosure jurisdiction.",
    },
    snapshot: {
      score_kind: "NET_WORTH_SCORE",
      scale_version: "nws-fixed-us-log-v1.0.0",
      model_version: "net-worth-monte-carlo-v1.0.0",
      complete: false,
      as_of: "2026-08-14",
      semantics: "Location selects candidates only; NWS uses public financial evidence.",
    },
    financial_coverage: {
      status: "PARTIAL",
      candidate_count: 3,
      discovered_count: 3,
      evaluated_count: 2,
      unevaluated_count: 1,
      scored_count: 1,
      insufficient_evidence_count: 1,
    },
    result_set: {
      status: "PARTIAL",
      requested_count: 100,
      returned_count: 1,
      shortfall_count: 99,
      target_satisfied: false,
      reasons: ["SOURCE_INDEX_PARTIAL"],
    },
    search: {
      performed: true,
      scope: "PUBLIC_JURISDICTION",
      expanded: false,
      expansion_steps_km: [],
      initial_radius_km: 20,
      effective_radius_km: 0,
      maximum_radius_km: 100,
      maximum_radius_reached: false,
    },
    generated_at: "2026-08-14T10:00:00+00:00",
    source_status: [
      {
        source: "FLORIDA_FORM_6_PUBLIC_FILERS",
        purpose: "CANDIDATE_DISCOVERY",
        status: "OK",
        as_of: "2026-08-14T09:00:00+00:00",
        reason_code: "SOURCE_INDEX_PARTIAL",
      },
      {
        source: "FLORIDA_FORM_6_DECLARED_TOTALS",
        purpose: "FINANCIAL_EVIDENCE",
        status: "OK",
        as_of: "2026-08-14T09:00:00+00:00",
        reason_code: "SOURCE_INDEX_PARTIAL",
      },
    ],
    results: [
      {
        rank: 1,
        person: {
          id: "florida-form6:2025:avery-jordan",
          name: "Avery Jordan",
          headline: "Public official",
          organization: null,
        },
        profile_status: "VERIFIED",
        estimated_net_worth: {
          status: "AVAILABLE",
          currency: "USD",
          p10_usd: 2_000_000,
          median_usd: 2_000_000,
          p90_usd: 2_000_000,
          method: "DECLARED_TOTAL_SIMULATION",
          as_of: "2025",
        },
        nws: {
          status: "AVAILABLE",
          value: 38,
          scale_version: "nws-fixed-us-log-v1.0.0",
        },
        confidence: { score: 0.91, grade: "A", coverage: 1 },
        components: {
          cash_and_near_cash: { ...includedComponent },
          public_securities: { ...includedComponent },
          private_business_equity: { ...includedComponent },
          real_estate_equity: { ...includedComponent },
          other_assets: { ...includedComponent },
          liabilities: { ...includedComponent },
        },
        liquid_wealth: {
          status: "UNKNOWN",
          currency: "USD",
          p10_usd: null,
          median_usd: null,
          p90_usd: null,
        },
        liquidity_score: null,
        location_relationship: {
          label: "Leon County public service jurisdiction",
          association_kind: "PUBLIC_SERVICE_JURISDICTION",
          granularity: "REGION",
          approximate_distance_band: "public jurisdiction match",
          note: "Public-office association, not a residence or physical-presence claim.",
        },
        last_financial_update: "2025",
        financial_update_precision: "YEAR",
        sources: [
          {
            publisher: "Florida Commission on Ethics",
            title: "Florida Form 6 sworn whole net worth declaration",
            url: "https://disclosure.floridaethics.gov/",
            fact_types: ["STATE_WHOLE_NET_WORTH_DISCLOSURE"],
            source_date: "2025",
            retrieved_at: "2026-08-14T09:00:00+00:00",
          },
        ],
      },
    ],
  };
}

function makeRequest(
  body: unknown,
  options: {
    contentType?: string | null;
    ip?: string;
    contentLength?: string;
    serializedBody?: string;
  } = {},
) {
  requestNumber += 1;
  const headers = new Headers({
    "X-Forwarded-For": options.ip ?? `198.51.100.${requestNumber}`,
  });
  if (options.contentType !== null) {
    headers.set("Content-Type", options.contentType ?? "application/json");
  }
  if (options.contentLength !== undefined) headers.set("Content-Length", options.contentLength);

  return new Request("https://intelligence.hushh.ai/api/nws/nearby", {
    method: "POST",
    headers,
    body: options.serializedBody ?? JSON.stringify(body),
  });
}

function mockUpstream(body: unknown = validUpstreamResponse(), status = 200, headers?: HeadersInit) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /api/nws/nearby", () => {
  beforeEach(() => {
    requestNumber = Math.floor(Math.random() * 100);
    vi.stubEnv("NWS_NEARBY_API_KEY", "server-only-secret");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("calls only the fixed HTTPS upstream with a normalized request and server-held key", async () => {
    const fetchMock = mockUpstream();
    const response = await POST(
      makeRequest({
        query: { postal_code: " 32301 ", country_code: "us" },
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const forwardedHeaders = new Headers(init?.headers);
    expect(url).toBe(NWS_UPSTREAM_URL);
    expect(NWS_UPSTREAM_URL).toContain("/v3/nearby-net-worth/discover");
    expect(NWS_UPSTREAM_URL.startsWith("https://")).toBe(true);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(forwardedHeaders.get("x-nws-api-key")).toBe("server-only-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: { postal_code: "32301", country_code: "US" },
      top_n: 100,
      initial_radius_km: 20,
      max_radius_km: 100,
      auto_expand: true,
    });

    expect(payload).toMatchObject({
      query: { postal_code: "32301", country_code: "US" },
      coverage: { status: "COVERED" },
      snapshot: { score_kind: "NET_WORTH_SCORE" },
      financial_coverage: {
        discovered_count: 3,
        evaluated_count: 2,
        unevaluated_count: 1,
        scored_count: 1,
      },
      result_set: { status: "PARTIAL", shortfall_count: 99 },
      search: { scope: "PUBLIC_JURISDICTION", expanded: false },
      results: [
        {
          person: { name: "Avery Jordan" },
          nws: { value: 38 },
          confidence: { score: 0.91, grade: "A", coverage: 1 },
          financial_update_precision: "YEAR",
          last_financial_update: "2025",
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("server-only-secret");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("coarsens coordinates again at the server boundary", async () => {
    const fetchMock = mockUpstream();
    const response = await POST(
      makeRequest({
        query: { latitude: 41.782504, longitude: -87.602734 },
      }),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: { latitude: 41.78, longitude: -87.6 },
    });
  });

  it("fails closed when the server secret is absent", async () => {
    vi.stubEnv("NWS_NEARBY_API_KEY", "");
    const fetchMock = mockUpstream();
    const response = await POST(makeRequest({ query: { postal_code: "60637" } }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "service_unavailable",
      retryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires application/json so cross-origin simple requests cannot invoke the key", async () => {
    const fetchMock = mockUpstream();
    const response = await POST(
      makeRequest({ query: { postal_code: "60637" } }, { contentType: "text/plain" }),
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: "unsupported_media_type" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps actual streamed bytes even when Content-Length lies", async () => {
    const fetchMock = mockUpstream();
    const oversized = `{"query":{"postal_code":"60637"},"padding":"${"x".repeat(
      MAX_NWS_REQUEST_BYTES,
    )}"}`;
    const response = await POST(
      makeRequest(null, {
        contentLength: "1",
        serializedBody: oversized,
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "request_too_large", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps malformed JSON and strict-contract failures without forwarding them", async () => {
    const fetchMock = mockUpstream();
    const invalidJson = await POST(makeRequest(null, { serializedBody: "{" }));
    const invalidContract = await POST(
      makeRequest({
        query: { postal_code: "60637", latitude: 41.78, longitude: -87.6 },
      }),
    );

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ code: "invalid_json" });
    expect(invalidContract.status).toBe(422);
    expect(await invalidContract.json()).toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { upstreamStatus: 413, expectedStatus: 413, expectedCode: "request_too_large" },
    { upstreamStatus: 422, expectedStatus: 422, expectedCode: "invalid_request" },
    { upstreamStatus: 401, expectedStatus: 503, expectedCode: "service_unavailable" },
    { upstreamStatus: 403, expectedStatus: 503, expectedCode: "service_unavailable" },
    { upstreamStatus: 503, expectedStatus: 503, expectedCode: "service_unavailable" },
  ])(
    "safely maps upstream $upstreamStatus without proxying its body",
    async ({ upstreamStatus, expectedStatus, expectedCode }) => {
      mockUpstream({ detail: "server-only-secret and internal exception" }, upstreamStatus);
      const response = await POST(makeRequest({ query: { postal_code: "60637" } }));
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(expectedStatus);
      expect(serialized).toContain(expectedCode);
      expect(serialized).not.toContain("server-only-secret");
      expect(serialized).not.toContain("internal exception");
      expect(response.headers.get("cache-control")).toContain("no-store");
    },
  );

  it("bounds upstream Retry-After before returning it", async () => {
    mockUpstream({ detail: "slow down" }, 429, { "Retry-After": "999999" });
    const response = await POST(makeRequest({ query: { postal_code: "60637" } }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("keeps non-US and unresolved coverage states as successful empty responses", async () => {
    const upstream: Record<string, unknown> = validUpstreamResponse();
    upstream.query = {
      label: "Coarsened coordinate query area",
      mode: "COARSE_COORDINATE",
      country_code: "IN",
      approximate: true,
    };
    upstream.coverage = {
      status: "NOT_COVERED",
      reason_code: "COUNTRY_NOT_IN_NATIONAL_INDEX",
      market_label: "Outside current US coverage",
      country_code: "IN",
      complete: false,
      message: "This release currently covers the United States.",
    };
    upstream.financial_coverage = {
      status: "NOT_SEARCHED",
      candidate_count: 0,
      discovered_count: 0,
      evaluated_count: 0,
      unevaluated_count: 0,
      scored_count: 0,
      insufficient_evidence_count: 0,
    };
    upstream.source_status = [
      {
        source: "PUBLIC_ASSOCIATION_CANDIDATES",
        purpose: "CANDIDATE_DISCOVERY",
        status: "NOT_QUERIED",
        as_of: null,
        reason_code: "COUNTRY_NOT_IN_NATIONAL_INDEX",
      },
      {
        source: "NET_WORTH_LEDGER",
        purpose: "FINANCIAL_EVIDENCE",
        status: "NOT_QUERIED",
        as_of: null,
        reason_code: "COUNTRY_NOT_IN_NATIONAL_INDEX",
      },
    ];
    upstream.search = {
      performed: false,
      scope: "NOT_SEARCHED",
      expanded: false,
      expansion_steps_km: [],
      initial_radius_km: 20,
      effective_radius_km: 0,
      maximum_radius_km: 100,
      maximum_radius_reached: false,
    };
    upstream.result_set = {
      status: "NOT_SEARCHED",
      requested_count: 100,
      returned_count: 0,
      shortfall_count: 100,
      target_satisfied: false,
      reasons: ["COUNTRY_NOT_IN_NATIONAL_INDEX"],
    };
    upstream.results = [];
    mockUpstream(upstream);

    const response = await POST(
      makeRequest({
        query: { latitude: 28.6139, longitude: 77.209, country_code: "IN" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      query: { mode: "COARSE_COORDINATE", country_code: "IN", approximate: true },
      coverage: { status: "NOT_COVERED" },
      financial_coverage: { status: "NOT_SEARCHED", discovered_count: 0 },
      result_set: { status: "NOT_SEARCHED" },
      search: { scope: "NOT_SEARCHED", performed: false },
      results: [],
    });
  });

  it("rejects malformed or newly expanded upstream success envelopes", async () => {
    mockUpstream({ ...validUpstreamResponse(), private_contact_enrichment: { email: "x@y.com" } });
    const response = await POST(makeRequest({ query: { postal_code: "60637" } }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "invalid_upstream_response",
      retryable: true,
    });
  });

  it("applies a best-effort per-IP request budget", async () => {
    const fetchMock = mockUpstream();
    const ip = "203.0.113.240";
    let response: Response | undefined;

    for (let requestIndex = 0; requestIndex < 21; requestIndex += 1) {
      response = await POST(makeRequest({ query: { postal_code: "60637" } }, { ip }));
    }

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
  });

  it("aborts a stalled upstream within the bounded timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pendingResponse = POST(makeRequest({ query: { postal_code: "60637" } }));
    await vi.advanceTimersByTimeAsync(NWS_UPSTREAM_TIMEOUT_MS);
    const response = await pendingResponse;

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "upstream_timeout", retryable: true });
  });
});
