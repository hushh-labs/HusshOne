import { describe, expect, it } from "vitest";
import {
  NearbyClientResponseSchema,
  curateNearbyUpstreamResponse,
  validateNearbyClientRequest,
  validateNearbyClientResponse,
} from "./contracts";

function unknownComponent(
  status: "UNKNOWN" | "NOT_PROVIDED" | "INCLUDED_IN_DECLARED_TOTAL" = "UNKNOWN",
) {
  return {
    status,
    low_usd: null,
    most_likely_usd: null,
    high_usd: null,
    confidence: null,
  };
}

function upstreamResponse() {
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
      reason_code: "US_PUBLIC_JURISDICTION_INDEX",
      market_label: "Florida public financial disclosures",
      country_code: "US",
      complete: false,
      message: "Search ran over supported public jurisdictions.",
    },
    snapshot: {
      score_kind: "NET_WORTH_SCORE",
      scale_version: "nws-us-log-v1",
      model_version: "net-worth-monte-carlo-v1",
      complete: false,
      as_of: "2026-08-14",
      semantics: "Location selects candidates only; NWS uses public financial evidence.",
    },
    financial_coverage: {
      status: "PARTIAL",
      candidate_count: 2,
      discovered_count: 2,
      evaluated_count: 2,
      unevaluated_count: 0,
      scored_count: 1,
      insufficient_evidence_count: 1,
    },
    result_set: {
      status: "PARTIAL",
      requested_count: 100,
      returned_count: 1,
      shortfall_count: 99,
      target_satisfied: false,
      reasons: ["FINANCIAL_EVIDENCE_PARTIAL"],
    },
    search: {
      performed: true,
      scope: "PUBLIC_JURISDICTION",
      expanded: true,
      expansion_steps_km: [20, 40],
      initial_radius_km: 20,
      effective_radius_km: 40,
      maximum_radius_km: 100,
      maximum_radius_reached: false,
    },
    source_status: [
      {
        source: "PUBLIC_ASSOCIATION_CANDIDATES",
        purpose: "CANDIDATE_DISCOVERY",
        status: "OK",
        as_of: "2026-08-14",
        reason_code: null,
      },
      {
        source: "FLORIDA_FORM_6",
        purpose: "FINANCIAL_EVIDENCE",
        status: "OK",
        as_of: "2025-12-31",
        reason_code: null,
      },
    ],
    generated_at: "2026-08-14T10:00:00+00:00",
    results: [
      {
        rank: 1,
        person: {
          id: "public-official:1",
          name: "Avery Jordan",
          headline: "Public official",
          organization: "State of Florida",
        },
        profile_status: "VERIFIED",
        estimated_net_worth: {
          status: "AVAILABLE",
          currency: "USD",
          p10_usd: 1_500_000,
          median_usd: 2_000_000,
          p90_usd: 2_700_000,
          method: "MONTE_CARLO",
          as_of: "2025-12-31",
        },
        nws: {
          status: "AVAILABLE",
          value: 38,
          scale_version: "nws-us-log-v1",
        },
        confidence: { score: 0.91, grade: "B", coverage: 0.76 },
        components: {
          cash_and_near_cash: {
            status: "SUPPORTED",
            low_usd: 100_000,
            most_likely_usd: 140_000,
            high_usd: 190_000,
            confidence: 0.9,
          },
          public_securities: {
            status: "MODELED_RANGE",
            low_usd: 350_000,
            most_likely_usd: 500_000,
            high_usd: 720_000,
            confidence: 0.65,
          },
          private_business_equity: unknownComponent("NOT_PROVIDED"),
          real_estate_equity: unknownComponent(),
          other_assets: unknownComponent("NOT_PROVIDED"),
          liabilities: unknownComponent("NOT_PROVIDED"),
        },
        liquid_wealth: {
          status: "AVAILABLE",
          currency: "USD",
          p10_usd: 450_000,
          median_usd: 640_000,
          p90_usd: 910_000,
        },
        liquidity_score: null,
        location_relationship: {
          label: "Florida public jurisdiction",
          association_kind: "PUBLIC_OFFICE_JURISDICTION",
          granularity: "STATE",
          approximate_distance_band: "within 25 km",
          note: "Public office relationship, not a residence or live location.",
        },
        last_financial_update: "2025-12-31",
        financial_update_precision: "DAY",
        sources: [
          {
            publisher: "Florida Commission on Ethics",
            title: "2025 Form 6 disclosure",
            url: "https://ethics.state.fl.us/example",
            fact_types: ["declared_asset", "liability"],
            source_date: "2025-12-31",
            retrieved_at: "2026-08-14T09:00:00+00:00",
          },
        ],
      },
    ],
  };
}

describe("NearbyClientRequestSchema", () => {
  it("normalizes the v3 request and applies bounded defaults", () => {
    const parsed = validateNearbyClientRequest({
      query: { postal_code: " 32301 ", country_code: "us" },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      query: { postal_code: "32301", country_code: "US" },
      top_n: 100,
      initial_radius_km: 20,
      max_radius_km: 100,
      auto_expand: true,
    });
  });

  it("coarsens consented coordinates and never adds a country", () => {
    const parsed = validateNearbyClientRequest({
      query: { latitude: 30.4383, longitude: -84.2807 },
      top_n: 200,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query).toEqual({ latitude: 30.44, longitude: -84.28 });
    }
  });

  it.each([
    { query: { postal_code: "32301", latitude: 30.44, longitude: -84.28 } },
    { query: { latitude: 30.44 } },
    { query: { postal_code: "not-a-us-zip", country_code: "US" } },
    { query: { postal_code: "32301", street_address: "private" } },
    { query: { postal_code: "32301" }, top_n: 201 },
    { query: { postal_code: "32301" }, diversity: true },
    { query: { postal_code: "32301" }, filters: {} },
    { query: { postal_code: "32301" }, auto_expand: "true" },
    { query: { postal_code: "32301" }, initial_radius_km: 101, max_radius_km: 100 },
  ])("rejects malformed, legacy, mixed, or unknown-field input", (input) => {
    expect(validateNearbyClientRequest(input).success).toBe(false);
  });
});

describe("v3 net-worth response curation", () => {
  it("returns the strict public-financial allowlist", () => {
    const curated = curateNearbyUpstreamResponse(upstreamResponse());

    expect(curated).toMatchObject({
      snapshot: { score_kind: "NET_WORTH_SCORE", scale_version: "nws-us-log-v1" },
      financial_coverage: {
        status: "PARTIAL",
        candidate_count: 2,
        discovered_count: 2,
        evaluated_count: 2,
        unevaluated_count: 0,
        scored_count: 1,
        insufficient_evidence_count: 1,
      },
      results: [
        {
          person: { name: "Avery Jordan", headline: "Public official" },
          estimated_net_worth: { median_usd: 2_000_000 },
          nws: { value: 38 },
          confidence: { score: 0.91, grade: "B", coverage: 0.76 },
          location_relationship: { association_kind: "PUBLIC_OFFICE_JURISDICTION" },
        },
      ],
    });
    expect(validateNearbyClientResponse(curated).success).toBe(true);
  });

  it("fails closed on coordinates, addresses, contacts, private data, or raw source rows", () => {
    const forbidden = [
      ["query", "latitude"],
      ["results", 0, "person", "email"],
      ["results", 0, "location_relationship", "exact_address"],
      ["source_status", 0, "rows_received"],
    ] as const;

    for (const path of forbidden) {
      const candidate = structuredClone(upstreamResponse()) as Record<string, unknown>;
      let parent: Record<string | number, unknown> = candidate;
      for (const part of path.slice(0, -1)) {
        parent = parent[part] as Record<string | number, unknown>;
      }
      parent[path.at(-1)!] = "forbidden";
      expect(() => curateNearbyUpstreamResponse(candidate)).toThrow();
    }
  });

  it("rejects unsafe citation protocols", () => {
    const candidate = upstreamResponse();
    candidate.results[0]!.sources[0]!.url = "javascript:alert(1)";
    expect(() => curateNearbyUpstreamResponse(candidate)).toThrow();
  });

  it("treats absent financial evidence as unavailable, never zero", () => {
    const candidate = upstreamResponse();
    candidate.financial_coverage = {
      status: "FINANCIAL_COVERAGE_INSUFFICIENT",
      candidate_count: 12,
      discovered_count: 12,
      evaluated_count: 12,
      unevaluated_count: 0,
      scored_count: 0,
      insufficient_evidence_count: 12,
    };
    candidate.result_set = {
      status: "EMPTY",
      requested_count: 100,
      returned_count: 0,
      shortfall_count: 100,
      target_satisfied: false,
      reasons: ["FINANCIAL_COVERAGE_INSUFFICIENT"],
    };
    candidate.results = [];

    const curated = curateNearbyUpstreamResponse(candidate);
    expect(curated.financial_coverage.scored_count).toBe(0);
    expect(curated.results).toEqual([]);
    expect(JSON.stringify(curated)).not.toContain('"median_usd":0');
  });

  it("never itemizes components when the source declares only a whole total", () => {
    const candidate = curateNearbyUpstreamResponse(upstreamResponse());
    candidate.results[0]!.estimated_net_worth.method = "DECLARED_TOTAL_SIMULATION";
    candidate.results[0]!.components = {
      cash_and_near_cash: unknownComponent("INCLUDED_IN_DECLARED_TOTAL"),
      public_securities: unknownComponent("INCLUDED_IN_DECLARED_TOTAL"),
      private_business_equity: unknownComponent("INCLUDED_IN_DECLARED_TOTAL"),
      real_estate_equity: unknownComponent("INCLUDED_IN_DECLARED_TOTAL"),
      other_assets: unknownComponent("INCLUDED_IN_DECLARED_TOTAL"),
      liabilities: unknownComponent("INCLUDED_IN_DECLARED_TOTAL"),
    };
    candidate.results[0]!.estimated_net_worth.p10_usd = 2_000_000;
    candidate.results[0]!.estimated_net_worth.p90_usd = 2_000_000;
    candidate.results[0]!.liquid_wealth = {
      status: "UNKNOWN",
      currency: "USD",
      p10_usd: null,
      median_usd: null,
      p90_usd: null,
    };

    expect(validateNearbyClientResponse(candidate).success).toBe(true);

    candidate.results[0]!.components.cash_and_near_cash = {
      status: "SUPPORTED",
      low_usd: 100,
      most_likely_usd: 200,
      high_usd: 300,
      confidence: 0.9,
    };
    expect(validateNearbyClientResponse(candidate).success).toBe(false);
  });

  it("preserves annual disclosure precision without fabricating a day", () => {
    const candidate = upstreamResponse();
    candidate.results[0]!.estimated_net_worth.as_of = "2025";
    candidate.results[0]!.last_financial_update = "2025";
    candidate.results[0]!.financial_update_precision = "YEAR";
    candidate.results[0]!.sources[0]!.source_date = "2025";

    expect(validateNearbyClientResponse(candidate).success).toBe(true);

    candidate.results[0]!.last_financial_update = "2025-01-01";
    expect(validateNearbyClientResponse(candidate).success).toBe(false);
  });

  it("accepts older citations when the newest citation matches the financial update", () => {
    const candidate = upstreamResponse();
    const newest = candidate.results[0]!.sources[0]!;
    candidate.results[0]!.sources = [
      { ...newest, title: "Earlier ownership filing", source_date: "2024-06-30" },
      newest,
    ];

    expect(validateNearbyClientResponse(candidate).success).toBe(true);

    candidate.results[0]!.sources[1]!.source_date = "2025-01-01";
    expect(validateNearbyClientResponse(candidate).success).toBe(false);
  });

  it("keeps the public response schema strict", () => {
    expect(
      NearbyClientResponseSchema.safeParse({
        ...upstreamResponse(),
        private_contact_enrichment: { email: "secret@example.com" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["score drift", (candidate: ReturnType<typeof upstreamResponse>) => { candidate.results[0]!.nws.value = 99; }],
    ["scale drift", (candidate: ReturnType<typeof upstreamResponse>) => { candidate.results[0]!.nws.scale_version = "other-scale"; }],
    ["update drift", (candidate: ReturnType<typeof upstreamResponse>) => { candidate.results[0]!.last_financial_update = "2024-12-31"; }],
    ["citation-year drift", (candidate: ReturnType<typeof upstreamResponse>) => { candidate.results[0]!.sources[0]!.source_date = "2024-12-31"; }],
    ["coverage-count drift", (candidate: ReturnType<typeof upstreamResponse>) => { candidate.financial_coverage.unevaluated_count = 1; }],
  ])("rejects %s across the curated response", (_label, mutate) => {
    const candidate = upstreamResponse();
    mutate(candidate);
    expect(validateNearbyClientResponse(candidate).success).toBe(false);
  });
});
