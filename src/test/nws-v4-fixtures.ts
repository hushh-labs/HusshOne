import {
  NWS_V4_CONTRACT_VERSION,
  NWS_V4_COVERAGE_CONTRACT,
  NWS_V4_MODEL_VERSION,
  NWS_V4_PROJECT_ID,
  NWS_V4_PURPOSE_ID,
  curateNearbyV4UpstreamResponse,
} from "@/lib/nws/v4-contracts";

export const TEST_V4_AUDIT_ACTOR_REFERENCE = "actor_0123456789abcdef";

// Keep fixtures on the exact public wire contract. Tests mutate clones to prove
// that the browser boundary fails closed when upstream data drifts.
export function validV4UpstreamResponse(options: {
  auditActorReference?: string;
  count?: 100 | 150 | 200;
  resultCount?: number;
  discoveredCount?: number;
  queryMode?: "POSTAL_CODE" | "COARSE_COORDINATE";
} = {}) {
  const count = options.count ?? 100;
  const resultCount = options.resultCount ?? 1;
  const discoveredCount = options.discoveredCount ?? Math.max(resultCount, 3);
  const queryMode = options.queryMode ?? "POSTAL_CODE";
  const emptyComponent = {
    status: "NOT_PROVIDED",
    low_usd: null,
    most_likely_usd: null,
    high_usd: null,
    confidence: null,
  };
  const results = Array.from({ length: resultCount }, (_, index) => {
    const rank = index + 1;
    return {
      rank,
      rank_interval: {
        low: rank,
        high: Math.min(resultCount, rank + 1) || 1,
        basis: "P10_P90_OVERLAP_AVAILABLE_SET",
        population_complete: false,
      },
      person: {
        id: `florida-form6:2025:person-${rank}`,
        name: `Person ${rank}`,
        headline: "Public official",
        organization: "State of Florida",
      },
      estimated_net_worth: {
        status: "AVAILABLE",
        currency: "USD",
        p10_usd: 1_500_000,
        median_usd: 2_000_000,
        p90_usd: 2_700_000,
        method: "MONTE_CARLO",
        as_of: "2025-12-31",
      },
      observed_net_worth_floor: {
        status: "AVAILABLE",
        amount_usd: 1_100_000,
        method: "SUPPORTED_ASSET_LOWS_LESS_SUPPORTED_LIABILITY_HIGH",
        supporting_asset_families: ["cash_and_near_cash"],
      },
      nws: {
        value: 38,
        scale_version: "nws-fixed-us-log-v1.0.0",
        uncertainty: {
          low: 36,
          median: 38,
          high: 41,
          basis: "P10_MEDIAN_P90_FIXED_SCALE",
        },
      },
      confidence: { score: 0.91, grade: "B", coverage: 0.76 },
      components: {
        cash_and_near_cash: {
          status: "SUPPORTED",
          low_usd: 1_200_000,
          most_likely_usd: 1_300_000,
          high_usd: 1_400_000,
          confidence: 0.9,
        },
        public_securities: { ...emptyComponent },
        private_business_equity: { ...emptyComponent },
        real_estate_equity: { ...emptyComponent },
        other_assets: { ...emptyComponent },
        liabilities: {
          status: "SUPPORTED",
          low_usd: 50_000,
          most_likely_usd: 75_000,
          high_usd: 100_000,
          confidence: 0.8,
        },
      },
      location_relationship: {
        label: "Florida public-service jurisdiction",
        association_kind: "PUBLIC_SERVICE_JURISDICTION",
        granularity: "REGION",
        approximate_distance_band: "public jurisdiction match",
        notice: "Public professional or opt-in association; not residence or physical presence.",
      },
      last_financial_update: "2025-12-31",
      financial_update_precision: "DAY",
      why_ranked: [
        "Median estimate: $2,000,000",
        "Confidence B; 76% coverage",
        "Sources: floridaethics.gov",
      ],
      source_families: ["floridaethics.gov"],
    };
  });
  const targetSatisfied = resultCount >= count;

  return {
    contract_version: NWS_V4_CONTRACT_VERSION,
    coverage_contract: NWS_V4_COVERAGE_CONTRACT,
    data_tier: "PUBLIC_SAFE",
    request_policy: {
      project_id: NWS_V4_PROJECT_ID,
      purpose_id: NWS_V4_PURPOSE_ID,
      authorization_scope: "PUBLIC_SAFE",
      requested_data_tier: "PUBLIC_SAFE",
      audit_actor_reference: options.auditActorReference ?? TEST_V4_AUDIT_ACTOR_REFERENCE,
      financial_mode: "estimated",
      geography_mode: "nearest-count",
      minimum_confidence: "C",
      minimum_coverage: 0.55,
      asset_families: [],
    },
    query:
      queryMode === "POSTAL_CODE"
        ? {
            label: "Tallahassee, Florida 32301 query area",
            mode: "POSTAL_CODE",
            postal_code: "32301",
            country_code: "US",
            approximate: true,
          }
        : {
            label: "Coarsened coordinate query area",
            mode: "COARSE_COORDINATE",
            postal_code: null,
            country_code: "US",
            approximate: true,
          },
    coverage: {
      status: "COVERED",
      reason_code: "APPROVED_MARKET_RELEASE",
      market_label: "Public-association market",
      country_code: "US",
    },
    snapshot: {
      model_version: NWS_V4_MODEL_VERSION,
      scale_version: "nws-fixed-us-log-v1.0.0",
      as_of: "2026-08-14",
      upstream_complete: false,
    },
    financial_coverage: {
      upstream_status: resultCount > 0 ? "PARTIAL" : "FINANCIAL_COVERAGE_INSUFFICIENT",
      discovered_count: discoveredCount,
      evaluated_count: discoveredCount,
      upstream_scored_count: resultCount,
      v4_eligible_count: resultCount,
    },
    expansion: {
      requested_strategy: "nearest-count",
      upstream_strategy: "PUBLIC_JURISDICTION",
      status: "PARTIAL",
      steps: [
        {
          order: 1,
          stage: "PUBLIC_JURISDICTION",
          radius_miles: null,
          count_status: "AVAILABLE",
          discovered_count: discoveredCount,
          evaluated_count: discoveredCount,
          financially_eligible_count: resultCount,
          cumulative_returned_count: resultCount,
        },
      ],
      effective_radius_miles: null,
      maximum_radius_reached: true,
      disclosure_code: "UPSTREAM_JURISDICTION_WITHOUT_DISTANCE",
    },
    result_set: {
      requested_count: count,
      upstream_result_count: resultCount,
      eligible_count: resultCount,
      returned_count: resultCount,
      shortfall_count: Math.max(0, count - resultCount),
      target_satisfied: targetSatisfied,
      reasons: targetSatisfied ? [] : ["INSUFFICIENT_ELIGIBLE_PROFILES"],
    },
    generated_at: "2026-08-14T10:00:00+00:00",
    disclosures: [
      "UPSTREAM_SNAPSHOT_DECLARED_INCOMPLETE",
      "RANK_INTERVAL_AVAILABLE_SET_ONLY",
      "PUBLIC_ASSOCIATION_NOT_PHYSICAL_PRESENCE",
      "SOURCE_FAMILIES_REPLACE_RAW_CITATIONS",
      "GEOGRAPHIC_HIERARCHY_NOT_YET_MATERIALIZED",
      "FINANCIAL_COVERAGE_NOT_NATIONWIDE",
    ],
    results,
  };
}

export function validV4ClientResponse(options: Parameters<typeof validV4UpstreamResponse>[0] = {}) {
  const upstream = validV4UpstreamResponse(options);
  return curateNearbyV4UpstreamResponse(upstream, {
    auditActorReference: options.auditActorReference ?? TEST_V4_AUDIT_ACTOR_REFERENCE,
    count: options.count ?? 100,
    queryMode: options.queryMode ?? "POSTAL_CODE",
  });
}
