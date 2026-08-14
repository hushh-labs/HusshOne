import { z } from "zod";

const CountryCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/));

const PostalCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().min(3).max(16).regex(/^[A-Z0-9][A-Z0-9 -]*[A-Z0-9]$/));

const PostalQuerySchema = z
  .strictObject({
    postal_code: PostalCodeSchema,
    country_code: CountryCodeSchema.optional(),
  })
  .superRefine((query, context) => {
    if (
      (query.country_code === undefined || query.country_code === "US") &&
      !/^\d{5}(?:-\d{4})?$/.test(query.postal_code)
    ) {
      context.addIssue({
        code: "custom",
        message: "US postal codes must be a five-digit ZIP or ZIP+4",
        path: ["postal_code"],
      });
    }
  });

function coarsenCoordinate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

const CoordinateQuerySchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90).transform(coarsenCoordinate),
  longitude: z.number().finite().min(-180).max(180).transform(coarsenCoordinate),
  country_code: CountryCodeSchema.optional(),
});

export const NearbyClientRequestSchema = z
  .strictObject({
    query: z.union([PostalQuerySchema, CoordinateQuerySchema]),
    top_n: z.number().int().min(1).max(200).default(100),
    initial_radius_km: z.number().finite().gt(0).max(250).default(20),
    max_radius_km: z.number().finite().gt(0).max(500).default(100),
    auto_expand: z.boolean().default(true),
  })
  .superRefine((request, context) => {
    if (request.max_radius_km < request.initial_radius_km) {
      context.addIssue({
        code: "custom",
        message: "max_radius_km must be greater than or equal to initial_radius_km",
        path: ["max_radius_km"],
      });
    }
  });

/** Values accepted from the browser before defaults and coordinate coarsening. */
export type NearbyClientRequest = z.input<typeof NearbyClientRequestSchema>;
/** The only request shape the same-origin server may send upstream. */
export type NearbyNormalizedRequest = z.output<typeof NearbyClientRequestSchema>;

const BoundedTextSchema = z.string().trim().min(1).max(1_000);
const NullableTextSchema = BoundedTextSchema.nullable();
const PublicDateSchema = z.string().regex(/^\d{4}(?:-\d{2}-\d{2})?$/);
const DayDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoTimestampSchema = z.string().trim().min(20).max(64);
const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const NullableAmountSchema = SafeIntegerSchema.nullable();
const HttpUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:";
  }, "Only HTTPS source links are allowed");

const NearbyQueryResponseSchema = z.strictObject({
  label: BoundedTextSchema,
  mode: z.enum(["POSTAL_CODE", "COARSE_COORDINATE"]),
  postal_code: BoundedTextSchema.nullable().optional(),
  country_code: CountryCodeSchema.nullable(),
  approximate: z.boolean(),
});

const NearbyCoverageResponseSchema = z.strictObject({
  status: z.enum(["COVERED", "NOT_COVERED", "LOCATION_UNRESOLVED"]),
  reason_code: BoundedTextSchema,
  market_label: NullableTextSchema,
  country_code: CountryCodeSchema.nullable(),
  complete: z.literal(false),
  message: BoundedTextSchema,
});

const NetWorthSnapshotSchema = z.strictObject({
  score_kind: z.literal("NET_WORTH_SCORE"),
  scale_version: BoundedTextSchema,
  model_version: BoundedTextSchema,
  complete: z.literal(false),
  as_of: DayDateSchema,
  semantics: BoundedTextSchema,
});

const FinancialCoverageSchema = z
  .strictObject({
    status: z.enum([
      "AVAILABLE",
      "PARTIAL",
      "FINANCIAL_COVERAGE_INSUFFICIENT",
      "NOT_SEARCHED",
    ]),
    candidate_count: z.number().int().nonnegative().max(1_000_000),
    discovered_count: z.number().int().nonnegative().max(1_000_000),
    evaluated_count: z.number().int().nonnegative().max(1_000_000),
    unevaluated_count: z.number().int().nonnegative().max(1_000_000),
    scored_count: z.number().int().nonnegative().max(1_000_000),
    insufficient_evidence_count: z.number().int().nonnegative().max(1_000_000),
  })
  .superRefine((coverage, context) => {
    if (coverage.candidate_count !== coverage.discovered_count) {
      context.addIssue({
        code: "custom",
        message: "candidate_count must match discovered_count",
        path: ["candidate_count"],
      });
    }
    if (coverage.discovered_count !== coverage.evaluated_count + coverage.unevaluated_count) {
      context.addIssue({
        code: "custom",
        message: "discovered candidates must be evaluated or unevaluated",
        path: ["discovered_count"],
      });
    }
    if (coverage.scored_count > coverage.evaluated_count) {
      context.addIssue({
        code: "custom",
        message: "scored_count cannot exceed evaluated_count",
        path: ["scored_count"],
      });
    }
    if (
      coverage.scored_count + coverage.insufficient_evidence_count !==
      coverage.evaluated_count
    ) {
      context.addIssue({
        code: "custom",
        message: "financial coverage counts must account for every candidate",
        path: ["insufficient_evidence_count"],
      });
    }
  });

const ResultSetSchema = z.strictObject({
  status: z.enum(["TARGET_MET", "PARTIAL", "EMPTY", "NOT_SEARCHED"]),
  requested_count: z.number().int().nonnegative().max(200),
  returned_count: z.number().int().nonnegative().max(200),
  shortfall_count: z.number().int().nonnegative().max(200),
  target_satisfied: z.boolean(),
  reasons: z.array(BoundedTextSchema).max(20),
});

const SearchSchema = z.strictObject({
  performed: z.boolean(),
  scope: z.enum(["NOT_SEARCHED", "ASSOCIATION_RADIUS", "PUBLIC_JURISDICTION"]),
  expanded: z.boolean(),
  expansion_steps_km: z.array(z.number().finite().nonnegative().max(500)).max(20),
  initial_radius_km: z.number().finite().nonnegative().max(250),
  effective_radius_km: z.number().finite().nonnegative().max(500),
  maximum_radius_km: z.number().finite().nonnegative().max(500),
  maximum_radius_reached: z.boolean(),
});

const SourceStatusSchema = z.strictObject({
  source: BoundedTextSchema,
  purpose: z.enum(["CANDIDATE_DISCOVERY", "FINANCIAL_EVIDENCE"]),
  status: z.enum(["OK", "EMPTY", "UNAVAILABLE", "NOT_QUERIED"]),
  as_of: NullableTextSchema,
  reason_code: NullableTextSchema,
});

const PersonSchema = z.strictObject({
  id: BoundedTextSchema,
  name: BoundedTextSchema,
  headline: BoundedTextSchema,
  organization: NullableTextSchema,
});

const NetWorthDistributionSchema = z
  .strictObject({
    status: z.enum(["AVAILABLE", "PARTIAL_ESTIMATE"]),
    currency: z.literal("USD"),
    p10_usd: SafeIntegerSchema,
    median_usd: SafeIntegerSchema,
    p90_usd: SafeIntegerSchema,
    method: z.enum(["MONTE_CARLO", "DECLARED_TOTAL_SIMULATION"]),
    as_of: PublicDateSchema,
  })
  .superRefine((estimate, context) => {
    if (estimate.p10_usd > estimate.median_usd || estimate.median_usd > estimate.p90_usd) {
      context.addIssue({
        code: "custom",
        message: "net-worth percentiles must be ordered",
        path: ["median_usd"],
      });
    }
  });

const NetWorthScoreSchema = z.strictObject({
  status: z.literal("AVAILABLE"),
  value: z.number().int().min(0).max(100),
  scale_version: BoundedTextSchema,
});

const ConfidenceSchema = z.strictObject({
  score: z.number().finite().min(0).max(1),
  grade: z.enum(["A", "B", "C", "D", "E"]),
  coverage: z.number().finite().min(0).max(1),
});

export const NetWorthComponentSchema = z
  .strictObject({
    status: z.enum([
      "SUPPORTED",
      "MODELED_RANGE",
      "INCLUDED_IN_DECLARED_TOTAL",
      "UNKNOWN",
      "NOT_PROVIDED",
      "NOT_APPLICABLE",
    ]),
    low_usd: NullableAmountSchema,
    most_likely_usd: NullableAmountSchema,
    high_usd: NullableAmountSchema,
    confidence: z.number().finite().min(0).max(1).nullable(),
  })
  .superRefine((component, context) => {
    const hasItemizedAmounts = component.status === "SUPPORTED" || component.status === "MODELED_RANGE";
    const values = [component.low_usd, component.most_likely_usd, component.high_usd];
    if (hasItemizedAmounts) {
      if (values.some((value) => value === null) || component.confidence === null) {
        context.addIssue({
          code: "custom",
          message: "supported components require a range and confidence",
          path: ["low_usd"],
        });
      } else if (
        component.low_usd! > component.most_likely_usd! ||
        component.most_likely_usd! > component.high_usd!
      ) {
        context.addIssue({
          code: "custom",
          message: "component amounts must be ordered",
          path: ["most_likely_usd"],
        });
      }
    } else if (values.some((value) => value !== null) || component.confidence !== null) {
      context.addIssue({
        code: "custom",
        message: "non-itemized components must not contain amounts or confidence",
        path: ["low_usd"],
      });
    }
  });

const ComponentsSchema = z.strictObject({
  cash_and_near_cash: NetWorthComponentSchema,
  public_securities: NetWorthComponentSchema,
  private_business_equity: NetWorthComponentSchema,
  real_estate_equity: NetWorthComponentSchema,
  other_assets: NetWorthComponentSchema,
  liabilities: NetWorthComponentSchema,
});

const LiquidWealthSchema = z
  .strictObject({
    status: z.enum(["AVAILABLE", "UNKNOWN"]),
    currency: z.literal("USD"),
    p10_usd: NullableAmountSchema,
    median_usd: NullableAmountSchema,
    p90_usd: NullableAmountSchema,
  })
  .superRefine((liquid, context) => {
    const values = [liquid.p10_usd, liquid.median_usd, liquid.p90_usd];
    if (liquid.status === "AVAILABLE") {
      if (values.some((value) => value === null)) {
        context.addIssue({
          code: "custom",
          message: "available liquid wealth requires a range",
          path: ["p10_usd"],
        });
      } else if (
        liquid.p10_usd! > liquid.median_usd! ||
        liquid.median_usd! > liquid.p90_usd!
      ) {
        context.addIssue({
          code: "custom",
          message: "liquid-wealth percentiles must be ordered",
          path: ["median_usd"],
        });
      }
    } else if (values.some((value) => value !== null)) {
      context.addIssue({
        code: "custom",
        message: "unknown liquid wealth must not contain amounts",
        path: ["p10_usd"],
      });
    }
  });

const LocationRelationshipSchema = z.strictObject({
  label: BoundedTextSchema,
  association_kind: BoundedTextSchema,
  granularity: BoundedTextSchema,
  approximate_distance_band: BoundedTextSchema,
  note: BoundedTextSchema,
});

const CitationSchema = z.strictObject({
  publisher: BoundedTextSchema,
  title: BoundedTextSchema,
  url: HttpUrlSchema,
  fact_types: z.array(BoundedTextSchema).max(20),
  source_date: PublicDateSchema,
  retrieved_at: IsoTimestampSchema,
});

export const NearbyClientResultSchema = z
  .strictObject({
    rank: z.number().int().positive().max(200),
    person: PersonSchema,
    profile_status: z.enum(["VERIFIED", "PARTIALLY_OBSERVABLE"]),
    estimated_net_worth: NetWorthDistributionSchema,
    nws: NetWorthScoreSchema,
    confidence: ConfidenceSchema,
    components: ComponentsSchema,
    liquid_wealth: LiquidWealthSchema,
    liquidity_score: z.number().int().min(0).max(100).nullable(),
    location_relationship: LocationRelationshipSchema,
    last_financial_update: PublicDateSchema,
    financial_update_precision: z.enum(["DAY", "YEAR"]),
    sources: z.array(CitationSchema).min(1).max(20),
  })
  .superRefine((result, context) => {
    const datePattern =
      result.financial_update_precision === "YEAR"
        ? /^\d{4}$/
        : /^\d{4}-\d{2}-\d{2}$/;
    for (const [key, value] of [
      ["last_financial_update", result.last_financial_update],
      ["estimated_net_worth.as_of", result.estimated_net_worth.as_of],
    ] as const) {
      if (!datePattern.test(value)) {
        context.addIssue({
          code: "custom",
          message: `financial update date must match ${result.financial_update_precision} precision`,
          path: key.split("."),
        });
      }
    }
    if (result.estimated_net_worth.method !== "DECLARED_TOTAL_SIMULATION") return;
    for (const [key, component] of Object.entries(result.components)) {
      if (component.status !== "INCLUDED_IN_DECLARED_TOTAL") {
        context.addIssue({
          code: "custom",
          message: "declared totals must not imply itemized component values",
          path: ["components", key, "status"],
        });
      }
    }
  });

export type NearbyClientResult = z.infer<typeof NearbyClientResultSchema>;

function netWorthToNws(medianUsd: number): number {
  if (medianUsd <= 10_000) return 0;
  if (medianUsd >= 10_000_000_000) return 100;
  return Math.min(100, Math.max(0, Math.floor((Math.log10(medianUsd) - 4) * (100 / 6) + 0.5)));
}

export const NearbyClientResponseSchema = z
  .strictObject({
    query: NearbyQueryResponseSchema,
    coverage: NearbyCoverageResponseSchema,
    snapshot: NetWorthSnapshotSchema,
    financial_coverage: FinancialCoverageSchema,
    result_set: ResultSetSchema,
    search: SearchSchema,
    source_status: z.array(SourceStatusSchema).max(20),
    generated_at: IsoTimestampSchema,
    results: z.array(NearbyClientResultSchema).max(200),
  })
  .superRefine((response, context) => {
    if (response.result_set.returned_count !== response.results.length) {
      context.addIssue({
        code: "custom",
        message: "returned_count must match results length",
        path: ["result_set", "returned_count"],
      });
    }
    if (response.financial_coverage.scored_count < response.results.length) {
      context.addIssue({
        code: "custom",
        message: "scored_count cannot be lower than the returned result count",
        path: ["financial_coverage", "scored_count"],
      });
    }
    for (const [index, result] of response.results.entries()) {
      if (result.nws.scale_version !== response.snapshot.scale_version) {
        context.addIssue({
          code: "custom",
          message: "result and snapshot scale versions must match",
          path: ["results", index, "nws", "scale_version"],
        });
      }
      if (result.nws.value !== netWorthToNws(result.estimated_net_worth.median_usd)) {
        context.addIssue({
          code: "custom",
          message: "NWS must match the fixed median-net-worth scale",
          path: ["results", index, "nws", "value"],
        });
      }
      if (result.last_financial_update !== result.estimated_net_worth.as_of) {
        context.addIssue({
          code: "custom",
          message: "estimate and result financial dates must match",
          path: ["results", index, "last_financial_update"],
        });
      }
      const comparableDate = (value: string) =>
        value.length === 4 ? `${value}-01-01` : value;
      const newestSourceDate = result.sources
        .map((source) => comparableDate(source.source_date))
        .sort()
        .at(-1);
      if (
        newestSourceDate !== undefined &&
        newestSourceDate !== comparableDate(result.last_financial_update)
      ) {
        context.addIssue({
          code: "custom",
          message: "last financial update must match the newest citation",
          path: ["results", index, "sources"],
        });
      }
      if (result.estimated_net_worth.method === "DECLARED_TOTAL_SIMULATION") {
        if (
          result.estimated_net_worth.p10_usd !== result.estimated_net_worth.median_usd ||
          result.estimated_net_worth.median_usd !== result.estimated_net_worth.p90_usd
        ) {
          context.addIssue({
            code: "custom",
            message: "declared totals must remain a single undecomposed value",
            path: ["results", index, "estimated_net_worth"],
          });
        }
        if (Object.values(result.components).some((component) => component.status !== "INCLUDED_IN_DECLARED_TOTAL")) {
          context.addIssue({
            code: "custom",
            message: "all declared-total components must be included but not itemized",
            path: ["results", index, "components"],
          });
        }
        if (result.liquid_wealth.status !== "UNKNOWN" || result.liquidity_score !== null) {
          context.addIssue({
            code: "custom",
            message: "declared totals cannot imply liquidity",
            path: ["results", index, "liquid_wealth"],
          });
        }
      }
    }
  });

export type NearbyClientResponse = z.infer<typeof NearbyClientResponseSchema>;

export const NearbyClientErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    "unsupported_media_type",
    "invalid_json",
    "request_too_large",
    "invalid_request",
    "rate_limited",
    "service_unavailable",
    "upstream_timeout",
    "invalid_upstream_response",
  ]),
  message: BoundedTextSchema,
  retryable: z.boolean(),
});

export type NearbyClientError = z.infer<typeof NearbyClientErrorSchema>;

/** Strictly validates and normalizes a browser/client request. */
export function validateNearbyClientRequest(input: unknown) {
  return NearbyClientRequestSchema.safeParse(input);
}

/** Validates a response already returned by the same-origin BFF. */
export function validateNearbyClientResponse(input: unknown) {
  return NearbyClientResponseSchema.safeParse(input);
}

/**
 * Fail-closed curation for the browser boundary. Every nested object is strict,
 * so coordinates, exact addresses, contacts, private data, and raw source rows
 * can neither survive parsing nor be serialized to the client.
 */
export function curateNearbyUpstreamResponse(input: unknown): NearbyClientResponse {
  return NearbyClientResponseSchema.parse(input);
}
