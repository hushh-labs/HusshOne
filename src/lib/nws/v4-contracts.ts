import { z } from "zod";

export const NWS_V4_CONTRACT_VERSION = "nws-nearby-net-worth-v4-preview-1" as const;
export const NWS_V4_COVERAGE_CONTRACT =
  "BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES" as const;
export const NWS_V4_PROJECT_ID = "hushone-app" as const;
export const NWS_V4_PURPOSE_ID = "NET_WORTH_LOOKUP" as const;
export const NWS_V4_MODEL_VERSION = "net-worth-v1.0.0" as const;

const BoundedTextSchema = z.string().trim().min(1).max(1_000);
const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const CountSchema = z.union([z.literal(100), z.literal(150), z.literal(200)]);
const CountryCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/));
const DayDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PublicDateSchema = z.string().regex(/^\d{4}(?:-\d{2}-\d{2})?$/);
const TimestampSchema = z
  .string()
  .trim()
  .min(20)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected an ISO timestamp");
const ReasonCodeSchema = z.string().regex(/^[A-Z0-9_]{2,128}$/);
const SourceFamilySchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const PHONE_NUMBER =
  /(?<!\d)(?:\+?1[-.\s]?)?(?:\([0-9]{3}\)|[0-9]{3})[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}(?!\d)/;
const STREET_ADDRESS =
  /\b\d{1,6}\s+[A-Za-z0-9 .'-]{1,80}\s(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way)\b/i;

const PublicDisplayTextSchema = BoundedTextSchema.refine(
  (value) =>
    !value.includes("@") &&
    !CONTROL_CHARACTERS.test(value) &&
    !PHONE_NUMBER.test(value) &&
    !STREET_ADDRESS.test(value),
  "Public display text contains private contact or address data",
);

function coarsenCoordinate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

const PostalQuerySchema = z.strictObject({
  postal_code: z
    .string()
    .trim()
    .regex(/^\d{5}(?:-\d{4})?$/),
  country_code: CountryCodeSchema.optional().default("US").pipe(z.literal("US")),
});

const CoordinateQuerySchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90).transform(coarsenCoordinate),
  longitude: z.number().finite().min(-180).max(180).transform(coarsenCoordinate),
  country_code: CountryCodeSchema.optional(),
});

export const NearbyV4ClientRequestSchema = z
  .strictObject({
    query: z.union([PostalQuerySchema, CoordinateQuerySchema]),
    count: CountSchema.default(100),
    consent_granted: z.literal(true).optional(),
  })
  .superRefine((request, context) => {
    const usesCoordinates = "latitude" in request.query;
    if (usesCoordinates && request.consent_granted !== true) {
      context.addIssue({
        code: "custom",
        message: "Coordinate searches require affirmative location consent",
        path: ["consent_granted"],
      });
    }
    if (!usesCoordinates && request.consent_granted !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Postal searches must not include location consent",
        path: ["consent_granted"],
      });
    }
  });

export type NearbyV4ClientRequest = z.input<typeof NearbyV4ClientRequestSchema>;
export type NearbyV4NormalizedRequest = z.output<typeof NearbyV4ClientRequestSchema>;

export const CoordinateConsentReceiptSchema = z
  .strictObject({
    receipt_id: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._~:-]{15,511}$/),
    purpose_id: z.literal(NWS_V4_PURPOSE_ID),
    audit_actor: z.string().regex(/^one-user:[0-9a-f]{32}$/),
    scope: z.literal("APPROXIMATE_LOCATION_QUERY"),
    issued_at: TimestampSchema,
    expires_at: TimestampSchema,
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.expires_at) <= Date.parse(receipt.issued_at)) {
      context.addIssue({
        code: "custom",
        message: "Consent receipt must expire after issuance",
        path: ["expires_at"],
      });
    }
  });

export type CoordinateConsentReceipt = z.infer<typeof CoordinateConsentReceiptSchema>;

const AssetFamilySchema = z.enum([
  "cash_and_near_cash",
  "public_securities",
  "private_business_equity",
  "real_estate_equity",
  "other_assets",
]);
const FinancialModeSchema = z.enum(["verified", "estimated", "observed-only"]);
const GeographyModeSchema = z.enum(["nearest-count", "strict-radius"]);
const ConfidenceGradeSchema = z.enum(["A", "B", "C"]);

const RequestPolicySchema = z.strictObject({
  project_id: BoundedTextSchema,
  purpose_id: BoundedTextSchema,
  authorization_scope: z.literal("PUBLIC_SAFE"),
  requested_data_tier: z.literal("PUBLIC_SAFE"),
  audit_actor_reference: z.string().regex(/^actor_[0-9a-f]{16}$/),
  financial_mode: FinancialModeSchema,
  geography_mode: GeographyModeSchema,
  minimum_confidence: ConfidenceGradeSchema,
  minimum_coverage: z.number().finite().min(0).max(1),
  asset_families: z.array(AssetFamilySchema).max(5),
});

const QuerySummarySchema = z.strictObject({
  label: PublicDisplayTextSchema,
  mode: z.enum(["POSTAL_CODE", "COARSE_COORDINATE"]),
  postal_code: z.string().regex(/^\d{5}(?:-\d{4})?$/).nullable(),
  country_code: CountryCodeSchema.nullable(),
  approximate: z.boolean(),
});

const CoverageSchema = z.strictObject({
  status: z.enum(["COVERED", "NOT_COVERED", "LOCATION_UNRESOLVED"]),
  reason_code: ReasonCodeSchema,
  market_label: PublicDisplayTextSchema.nullable(),
  country_code: CountryCodeSchema.nullable(),
});

const SnapshotSchema = z.strictObject({
  model_version: BoundedTextSchema,
  scale_version: BoundedTextSchema,
  as_of: DayDateSchema,
  upstream_complete: z.boolean(),
});

const FinancialCoverageSchema = z.strictObject({
  upstream_status: z.enum([
    "AVAILABLE",
    "PARTIAL",
    "FINANCIAL_COVERAGE_INSUFFICIENT",
    "NOT_SEARCHED",
  ]),
  discovered_count: z.number().int().nonnegative().max(1_000_000),
  evaluated_count: z.number().int().nonnegative().max(1_000_000),
  upstream_scored_count: z.number().int().nonnegative().max(1_000_000),
  v4_eligible_count: z.number().int().nonnegative().max(1_000_000),
});

const ExpansionStepSchema = z.strictObject({
  order: z.number().int().positive().max(64),
  stage: z.enum(["LEGACY_RADIUS", "PUBLIC_JURISDICTION"]),
  radius_miles: z.number().finite().nonnegative().max(310.685596).nullable(),
  count_status: z.enum(["AVAILABLE", "UPSTREAM_NOT_REPORTED"]),
  discovered_count: z.number().int().nonnegative().max(1_000_000).nullable(),
  evaluated_count: z.number().int().nonnegative().max(1_000_000).nullable(),
  financially_eligible_count: z.number().int().nonnegative().max(1_000_000).nullable(),
  cumulative_returned_count: z.number().int().nonnegative().max(200).nullable(),
});

const ExpansionSchema = z.strictObject({
  requested_strategy: GeographyModeSchema,
  upstream_strategy: z.enum(["LEGACY_RADIUS", "PUBLIC_JURISDICTION", "NOT_SEARCHED"]),
  status: z.enum(["PARTIAL", "NOT_SEARCHED"]),
  steps: z.array(ExpansionStepSchema).max(64),
  effective_radius_miles: z.number().finite().nonnegative().max(310.685596).nullable(),
  maximum_radius_reached: z.boolean(),
  disclosure_code: z.enum([
    "UPSTREAM_PER_STEP_COUNTS_UNAVAILABLE",
    "UPSTREAM_JURISDICTION_WITHOUT_DISTANCE",
    "LOCATION_NOT_SEARCHED",
  ]),
});

const ResultSetSchema = z
  .strictObject({
    requested_count: CountSchema,
    upstream_result_count: z.number().int().nonnegative().max(200),
    eligible_count: z.number().int().nonnegative().max(1_000_000),
    returned_count: z.number().int().nonnegative().max(200),
    shortfall_count: z.number().int().nonnegative().max(200),
    target_satisfied: z.boolean(),
    reasons: z.array(ReasonCodeSchema).max(64),
  })
  .superRefine((resultSet, context) => {
    if (resultSet.shortfall_count !== Math.max(0, resultSet.requested_count - resultSet.returned_count)) {
      context.addIssue({
        code: "custom",
        message: "shortfall_count is inconsistent",
        path: ["shortfall_count"],
      });
    }
    if (resultSet.target_satisfied !== (resultSet.returned_count >= resultSet.requested_count)) {
      context.addIssue({
        code: "custom",
        message: "target_satisfied is inconsistent",
        path: ["target_satisfied"],
      });
    }
    if (resultSet.target_satisfied && resultSet.reasons.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Satisfied result sets cannot include shortfall reasons",
        path: ["reasons"],
      });
    }
  });

const PersonSchema = z.strictObject({
  id: BoundedTextSchema,
  name: PublicDisplayTextSchema,
  headline: PublicDisplayTextSchema,
  organization: PublicDisplayTextSchema.nullable(),
});

const DistributionSchema = z
  .strictObject({
    status: z.enum(["AVAILABLE", "PARTIAL_ESTIMATE"]),
    currency: z.literal("USD"),
    p10_usd: SafeIntegerSchema,
    median_usd: SafeIntegerSchema,
    p90_usd: SafeIntegerSchema,
    method: z.enum(["MONTE_CARLO", "DECLARED_TOTAL_SIMULATION"]),
    as_of: PublicDateSchema,
  })
  .superRefine((distribution, context) => {
    if (
      distribution.p10_usd > distribution.median_usd ||
      distribution.median_usd > distribution.p90_usd
    ) {
      context.addIssue({
        code: "custom",
        message: "Net-worth interval must be ordered",
        path: ["median_usd"],
      });
    }
  });

const ScoreIntervalSchema = z
  .strictObject({
    low: z.number().int().min(0).max(100),
    median: z.number().int().min(0).max(100),
    high: z.number().int().min(0).max(100),
    basis: z.literal("P10_MEDIAN_P90_FIXED_SCALE"),
  })
  .superRefine((interval, context) => {
    if (interval.low > interval.median || interval.median > interval.high) {
      context.addIssue({
        code: "custom",
        message: "NWS interval must be ordered",
        path: ["median"],
      });
    }
  });

const NwsSchema = z.strictObject({
  value: z.number().int().min(0).max(100),
  scale_version: BoundedTextSchema,
  uncertainty: ScoreIntervalSchema,
});

const ConfidenceSchema = z.strictObject({
  score: z.number().finite().min(0).max(1),
  grade: ConfidenceGradeSchema,
  coverage: z.number().finite().min(0).max(1),
});

const ComponentSchema = z.strictObject({
  status: z.enum([
    "SUPPORTED",
    "MODELED_RANGE",
    "INCLUDED_IN_DECLARED_TOTAL",
    "UNKNOWN",
    "NOT_PROVIDED",
    "NOT_APPLICABLE",
  ]),
  low_usd: SafeIntegerSchema.nullable(),
  most_likely_usd: SafeIntegerSchema.nullable(),
  high_usd: SafeIntegerSchema.nullable(),
  confidence: z.number().finite().min(0).max(1).nullable(),
});

const ComponentsSchema = z.strictObject({
  cash_and_near_cash: ComponentSchema,
  public_securities: ComponentSchema,
  private_business_equity: ComponentSchema,
  real_estate_equity: ComponentSchema,
  other_assets: ComponentSchema,
  liabilities: ComponentSchema,
});

const ObservedFloorSchema = z
  .strictObject({
    status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    amount_usd: SafeIntegerSchema.nullable(),
    method: z.enum([
      "DIRECT_DECLARED_TOTAL_P10",
      "SUPPORTED_ASSET_LOWS_LESS_SUPPORTED_LIABILITY_HIGH",
      "UNAVAILABLE",
    ]),
    supporting_asset_families: z.array(AssetFamilySchema).max(5),
  })
  .superRefine((floor, context) => {
    const available = floor.status === "AVAILABLE";
    if (available !== (floor.amount_usd !== null) || (!available && floor.method !== "UNAVAILABLE")) {
      context.addIssue({
        code: "custom",
        message: "Observed floor status is inconsistent",
        path: ["amount_usd"],
      });
    }
  });

const RankIntervalSchema = z
  .strictObject({
    low: z.number().int().positive().max(1_000_000),
    high: z.number().int().positive().max(1_000_000),
    basis: z.enum(["P10_P90_OVERLAP_AVAILABLE_SET", "OBSERVED_FLOOR_AVAILABLE_SET"]),
    population_complete: z.literal(false),
  })
  .superRefine((interval, context) => {
    if (interval.low > interval.high) {
      context.addIssue({
        code: "custom",
        message: "Rank interval must be ordered",
        path: ["high"],
      });
    }
  });

const LocationRelationshipSchema = z.strictObject({
  label: PublicDisplayTextSchema,
  association_kind: BoundedTextSchema,
  granularity: BoundedTextSchema,
  approximate_distance_band: PublicDisplayTextSchema,
  notice: z.literal(
    "Public professional or opt-in association; not residence or physical presence.",
  ),
});

const UpstreamResultSchema = z.strictObject({
  rank: z.number().int().positive().max(200),
  rank_interval: RankIntervalSchema,
  person: PersonSchema,
  estimated_net_worth: DistributionSchema,
  observed_net_worth_floor: ObservedFloorSchema,
  nws: NwsSchema,
  confidence: ConfidenceSchema,
  components: ComponentsSchema,
  location_relationship: LocationRelationshipSchema,
  last_financial_update: PublicDateSchema,
  financial_update_precision: z.enum(["DAY", "YEAR"]),
  why_ranked: z.array(BoundedTextSchema).min(1).max(5),
  source_families: z.array(SourceFamilySchema).min(1).max(20),
});

const UpstreamResponseSchema = z
  .strictObject({
    contract_version: z.literal(NWS_V4_CONTRACT_VERSION),
    coverage_contract: z.literal(NWS_V4_COVERAGE_CONTRACT),
    data_tier: z.literal("PUBLIC_SAFE"),
    request_policy: RequestPolicySchema,
    query: QuerySummarySchema,
    coverage: CoverageSchema,
    snapshot: SnapshotSchema,
    financial_coverage: FinancialCoverageSchema,
    expansion: ExpansionSchema,
    result_set: ResultSetSchema,
    generated_at: TimestampSchema,
    disclosures: z.array(ReasonCodeSchema).max(64),
    results: z.array(UpstreamResultSchema).max(200),
  })
  .superRefine((response, context) => {
    if (response.result_set.returned_count !== response.results.length) {
      context.addIssue({
        code: "custom",
        message: "returned_count must match the results array",
        path: ["result_set", "returned_count"],
      });
    }
    if (response.result_set.eligible_count !== response.financial_coverage.v4_eligible_count) {
      context.addIssue({
        code: "custom",
        message: "Eligible counts must match",
        path: ["financial_coverage", "v4_eligible_count"],
      });
    }
    if (response.result_set.eligible_count < response.results.length) {
      context.addIssue({
        code: "custom",
        message: "Eligible count cannot be lower than returned results",
        path: ["result_set", "eligible_count"],
      });
    }

    const mandatoryDisclosures = [
      "PUBLIC_ASSOCIATION_NOT_PHYSICAL_PRESENCE",
      "GEOGRAPHIC_HIERARCHY_NOT_YET_MATERIALIZED",
      "FINANCIAL_COVERAGE_NOT_NATIONWIDE",
    ];
    for (const disclosure of mandatoryDisclosures) {
      if (!response.disclosures.includes(disclosure)) {
        context.addIssue({
          code: "custom",
          message: `Missing mandatory disclosure: ${disclosure}`,
          path: ["disclosures"],
        });
      }
    }

    const personIds = new Set<string>();
    for (const [index, result] of response.results.entries()) {
      if (personIds.has(result.person.id)) {
        context.addIssue({
          code: "custom",
          message: "Person identifiers must be unique",
          path: ["results", index, "person", "id"],
        });
      }
      personIds.add(result.person.id);
      if (result.rank !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Results must have contiguous ranks",
          path: ["results", index, "rank"],
        });
      }
      if (result.rank_interval.low > result.rank || result.rank_interval.high < result.rank) {
        context.addIssue({
          code: "custom",
          message: "Rank must fall inside its uncertainty interval",
          path: ["results", index, "rank_interval"],
        });
      }
      if (
        result.nws.scale_version !== response.snapshot.scale_version ||
        result.nws.value !== result.nws.uncertainty.median
      ) {
        context.addIssue({
          code: "custom",
          message: "Result NWS must match its snapshot and interval",
          path: ["results", index, "nws"],
        });
      }
      if (result.last_financial_update !== result.estimated_net_worth.as_of) {
        context.addIssue({
          code: "custom",
          message: "Financial update date must match the estimate",
          path: ["results", index, "last_financial_update"],
        });
      }
    }
  });

const ClientDistributionSchema = z
  .strictObject({
    currency: z.literal("USD"),
    p10_usd: SafeIntegerSchema,
    median_usd: SafeIntegerSchema,
    p90_usd: SafeIntegerSchema,
    as_of: PublicDateSchema,
  })
  .superRefine((distribution, context) => {
    if (
      distribution.p10_usd > distribution.median_usd ||
      distribution.median_usd > distribution.p90_usd
    ) {
      context.addIssue({
        code: "custom",
        message: "Net-worth interval must be ordered",
        path: ["median_usd"],
      });
    }
  });

const ClientResultSchema = z.strictObject({
  rank: z.number().int().positive().max(200),
  rank_interval: z.strictObject({
    low: z.number().int().positive().max(1_000_000),
    high: z.number().int().positive().max(1_000_000),
  }),
  person: PersonSchema,
  estimated_net_worth: ClientDistributionSchema,
  observed_net_worth_floor: z.strictObject({
    status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    amount_usd: SafeIntegerSchema.nullable(),
  }),
  nws: z.strictObject({
    value: z.number().int().min(0).max(100),
    uncertainty: z.strictObject({
      low: z.number().int().min(0).max(100),
      high: z.number().int().min(0).max(100),
    }),
  }),
  confidence: ConfidenceSchema,
  location_relationship: z.strictObject({
    label: PublicDisplayTextSchema,
    approximate_distance_band: PublicDisplayTextSchema,
    notice: LocationRelationshipSchema.shape.notice,
  }),
  last_financial_update: PublicDateSchema,
  financial_update_precision: z.enum(["DAY", "YEAR"]),
  source_families: z.array(SourceFamilySchema).min(1).max(20),
});

export const NearbyV4ClientResponseSchema = z.strictObject({
  contract_version: z.literal(NWS_V4_CONTRACT_VERSION),
  coverage_contract: z.literal(NWS_V4_COVERAGE_CONTRACT),
  query: QuerySummarySchema,
  coverage: CoverageSchema,
  snapshot: z.strictObject({ as_of: DayDateSchema }),
  financial_coverage: z.strictObject({
    status: FinancialCoverageSchema.shape.upstream_status,
    discovered_count: FinancialCoverageSchema.shape.discovered_count,
    evaluated_count: FinancialCoverageSchema.shape.evaluated_count,
    eligible_count: FinancialCoverageSchema.shape.v4_eligible_count,
  }),
  expansion: z.strictObject({
    status: ExpansionSchema.shape.status,
    upstream_strategy: ExpansionSchema.shape.upstream_strategy,
    effective_radius_miles: ExpansionSchema.shape.effective_radius_miles,
    maximum_radius_reached: ExpansionSchema.shape.maximum_radius_reached,
  }),
  result_set: ResultSetSchema,
  limitations: z.strictObject({
    financial_coverage_nationwide: z.literal(false),
    geographic_hierarchy_complete: z.literal(false),
    association_is_live_presence: z.literal(false),
  }),
  results: z.array(ClientResultSchema).max(200),
});

export type NearbyV4ClientResponse = z.infer<typeof NearbyV4ClientResponseSchema>;
export type NearbyV4ClientResult = z.infer<typeof ClientResultSchema>;

export const NearbyV4ClientErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    "authentication_required",
    "unsupported_media_type",
    "invalid_json",
    "request_too_large",
    "invalid_request",
    "rate_limited",
    "service_unavailable",
    "upstream_timeout",
    "coverage_unavailable",
    "invalid_upstream_response",
  ]),
  message: BoundedTextSchema,
  retryable: z.boolean(),
});

export type NearbyV4ClientError = z.infer<typeof NearbyV4ClientErrorSchema>;

export function validateNearbyV4ClientRequest(input: unknown) {
  return NearbyV4ClientRequestSchema.safeParse(input);
}

export function curateNearbyV4UpstreamResponse(
  input: unknown,
  expected: {
    auditActorReference: string;
    count: 100 | 150 | 200;
    queryMode: "POSTAL_CODE" | "COARSE_COORDINATE";
  },
): NearbyV4ClientResponse {
  const upstream = UpstreamResponseSchema.parse(input);
  if (
    upstream.request_policy.project_id !== NWS_V4_PROJECT_ID ||
    upstream.request_policy.purpose_id !== NWS_V4_PURPOSE_ID ||
    upstream.request_policy.financial_mode !== "estimated" ||
    upstream.request_policy.geography_mode !== "nearest-count" ||
    upstream.request_policy.minimum_confidence !== "C" ||
    upstream.request_policy.minimum_coverage !== 0.55 ||
    upstream.request_policy.asset_families.length !== 0 ||
    upstream.request_policy.audit_actor_reference !== expected.auditActorReference ||
    upstream.snapshot.model_version !== NWS_V4_MODEL_VERSION ||
    upstream.result_set.requested_count !== expected.count ||
    upstream.query.mode !== expected.queryMode
  ) {
    throw new Error("NWS v4 response does not match the approved consumer request");
  }

  return NearbyV4ClientResponseSchema.parse({
    contract_version: upstream.contract_version,
    coverage_contract: upstream.coverage_contract,
    query: upstream.query,
    coverage: upstream.coverage,
    snapshot: { as_of: upstream.snapshot.as_of },
    financial_coverage: {
      status: upstream.financial_coverage.upstream_status,
      discovered_count: upstream.financial_coverage.discovered_count,
      evaluated_count: upstream.financial_coverage.evaluated_count,
      eligible_count: upstream.financial_coverage.v4_eligible_count,
    },
    expansion: {
      status: upstream.expansion.status,
      upstream_strategy: upstream.expansion.upstream_strategy,
      effective_radius_miles: upstream.expansion.effective_radius_miles,
      maximum_radius_reached: upstream.expansion.maximum_radius_reached,
    },
    result_set: upstream.result_set,
    limitations: {
      financial_coverage_nationwide: false,
      geographic_hierarchy_complete: false,
      association_is_live_presence: false,
    },
    results: upstream.results.map((result) => ({
      rank: result.rank,
      rank_interval: {
        low: result.rank_interval.low,
        high: result.rank_interval.high,
      },
      person: result.person,
      estimated_net_worth: {
        currency: result.estimated_net_worth.currency,
        p10_usd: result.estimated_net_worth.p10_usd,
        median_usd: result.estimated_net_worth.median_usd,
        p90_usd: result.estimated_net_worth.p90_usd,
        as_of: result.estimated_net_worth.as_of,
      },
      observed_net_worth_floor: {
        status: result.observed_net_worth_floor.status,
        amount_usd: result.observed_net_worth_floor.amount_usd,
      },
      nws: {
        value: result.nws.value,
        uncertainty: {
          low: result.nws.uncertainty.low,
          high: result.nws.uncertainty.high,
        },
      },
      confidence: result.confidence,
      location_relationship: {
        label: result.location_relationship.label,
        approximate_distance_band: result.location_relationship.approximate_distance_band,
        notice: result.location_relationship.notice,
      },
      last_financial_update: result.last_financial_update,
      financial_update_precision: result.financial_update_precision,
      source_families: result.source_families,
    })),
  });
}
