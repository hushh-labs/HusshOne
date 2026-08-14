# NWS Nearby API contracts

## Hardened v4 preview

```text
POST /v4/location-consent/receipt
POST /v4/net-worth/discover
X-NWS-API-Key: <per-project server-held secret>
Content-Type: application/json
```

The contract version is `nws-nearby-net-worth-v4-preview-1`. It serves only `PUBLIC_SAFE` data and
returns best-effort financially eligible profiles plus mandatory count/coverage accountability.
It does not guarantee the requested count. The route is available only when `/ready` reports
`v4_enabled: true`.

### Access policy

The API key authenticates one registry consumer and project. The integrity-pinned registry grant
authorizes an exact route + purpose and caps count, radius, requests per minute, and coordinate-
consent age. The body `project_id` and `purpose_id` must match that grant. Disabled, expired, or
kill-switched consumers fail closed.

v4 keys match `nws_live_*` or `nws_test_*` and contain 256 bits of random key material. The
registry stores only `sha256(key)`; the raw key belongs only in the consumer BFF secret store.
Wildcard non-cookie CORS does not authorize a browser or mobile client to hold it.

### Discovery request

```json
{
  "query": {"postal_code": "60637", "country_code": "US"},
  "selection": {
    "count": 100,
    "financial_mode": "estimated",
    "geography_mode": "nearest-count"
  },
  "filters": {
    "minimum_confidence": "C",
    "minimum_coverage": 0.55,
    "asset_families": []
  },
  "caller_context": {
    "project_id": "your-project",
    "purpose_id": "NET_WORTH_LOOKUP",
    "authorization_scope": "PUBLIC_SAFE",
    "requested_data_tier": "PUBLIC_SAFE",
    "audit_actor": "subject:hush_7f3c9a2e1d4b",
    "model_version": "net-worth-v1.0.0"
  }
}
```

| Field | Contract |
| --- | --- |
| `query` | Exactly one five-digit US ZIP/ZIP+4 or latitude + longitude; optional `country_code` is two uppercase letters. |
| `selection.count` | Exactly `100`, `150`, or `200`. |
| `selection.financial_mode` | `estimated`, `verified`, or `observed-only`. |
| `selection.geography_mode` | `nearest-count` or `strict-radius`. |
| `selection.maximum_radius_miles` | Optional positive number up to `310.685596`; required for `strict-radius`. |
| `filters.minimum_confidence` | `A`, `B`, or `C`; default `C`. D/E never publish. |
| `filters.minimum_coverage` | `0.0` to `1.0`; default `0.55`. Mode minimums still apply. |
| `filters.asset_families` | Unique subset of `cash_and_near_cash`, `public_securities`, `private_business_equity`, `real_estate_equity`, `other_assets`. |
| `caller_context` | Registered project/purpose, public-safe scope/tier, opaque actor, and exact active model version. |
| `coordinate_consent` | Required only for coordinates; use the complete receipt response described below. |

All v4 models are strict and reject unknown fields, mixed location forms, non-finite numbers, and
stringified scalars. Postal requests reject a consent receipt. Coordinate requests require one.

`estimated` allows A/B and qualified C results; C needs at least 0.55 coverage and direct financial
evidence. `verified` requires A/B, direct evidence, and at least 0.70 coverage. `observed-only`
requires and ranks by an attributable observed floor. Asset filters require support in the
selected mode.

`nearest-count` is a best-effort upstream expansion capped at 500 km, not a guarantee. The planned
ZIP -> county -> CBSA -> state -> national hierarchy is not yet materialized. `strict-radius`
requires a radius-backed upstream result; an incompatible jurisdiction-wide result fails closed.

### Coordinate consent

After the product obtains and records affirmative location permission, its BFF calls:

```json
{
  "project_id": "your-project",
  "purpose_id": "NET_WORTH_LOOKUP",
  "audit_actor": "subject:hush_7f3c9a2e1d4b",
  "scope": "APPROXIMATE_LOCATION_QUERY",
  "consent_granted": true
}
```

The receipt endpoint accepts no location. It returns `receipt_id`, purpose, actor, scope,
`issued_at`, and `expires_at`. Send that complete object as `coordinate_consent` with the coordinate
discovery request. The signed receipt is bound to consumer, project, discovery route, purpose,
actor, and time; it is consumed once through atomic Cloud Storage creation. Expired, replayed,
altered, mismatched, or unverifiable receipts fail closed.

NWS can verify the BFF's signed, single-use assertion; it cannot observe the device permission UI.
The consumer remains responsible for showing the prompt and retaining its consent audit evidence.

### Discovery response

Every `200` v4 response contains the following field groups. Nested fields are abbreviated here;
this block is a map, not a complete wire example:

```json
{
  "contract_version": "nws-nearby-net-worth-v4-preview-1",
  "coverage_contract": "BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES",
  "data_tier": "PUBLIC_SAFE",
  "request_policy": {},
  "query": {},
  "coverage": {},
  "snapshot": {},
  "financial_coverage": {},
  "expansion": {},
  "result_set": {
    "requested_count": 100,
    "upstream_result_count": 0,
    "eligible_count": 0,
    "returned_count": 0,
    "shortfall_count": 100,
    "target_satisfied": false,
    "reasons": ["INSUFFICIENT_ELIGIBLE_PROFILES"]
  },
  "generated_at": "...",
  "disclosures": [
    "UPSTREAM_SNAPSHOT_DECLARED_INCOMPLETE",
    "RANK_INTERVAL_AVAILABLE_SET_ONLY",
    "PUBLIC_ASSOCIATION_NOT_PHYSICAL_PRESENCE",
    "SOURCE_FAMILIES_REPLACE_RAW_CITATIONS",
    "QUOTA_ENFORCEMENT_PROCESS_LOCAL",
    "GEOGRAPHIC_HIERARCHY_NOT_YET_MATERIALIZED",
    "FINANCIAL_COVERAGE_NOT_NATIONWIDE"
  ],
  "results": []
}
```

`request_policy` echoes only approved policy and a hashed actor reference. `financial_coverage`
separates discovered, evaluated, upstream-scored, and v4-eligible counts. `expansion` declares the
requested/upstream strategies, the counts available for each reported step, effective radius, and
any missing hierarchy/per-step data. `result_set.shortfall_count` is always
`max(0, requested_count - returned_count)`.

Each result includes person display fields, p10/median/p90 estimate, observed floor, fixed-scale NWS
and uncertainty interval, confidence and component coverage, public-association notice, available-
set rank interval, concise ranking reasons, and source host families derived from accepted upstream
citations. v4 intentionally replaces raw citations with source families. It never emits the raw
actor, credential, residence, exact person location/distance, personal contact, family graph,
filing schedule, or raw source payload.

Current positive financial coverage is a bounded, partial Florida Form 6 public-official roster.
National SEC/NPPES candidate discovery does not itself produce NWS. A covered ZIP such as `98033`
can therefore truthfully return zero results and a full shortfall.

### v4 errors

| HTTP | Representative condition |
| --- | --- |
| `401` | `INVALID_CREDENTIALS` or stale authentication context. |
| `403` | Consumer disabled/expired, project/purpose/tier denied, grant limit exceeded, or invalid/expired consent. |
| `409` | `V4_REQUEST_CANNOT_BE_SATISFIED` by the active public snapshot. |
| `413` | Request body exceeds 32 KiB. |
| `422` | Strict request model failed, including a coordinate request without a receipt. |
| `429` | `RATE_LIMITED`; honor `Retry-After`. |
| `503` | v4 disabled, consent verification unavailable, rate-limit backend unavailable, or required source unavailable. |

`X-Request-ID` is safe to retain for support. v4 rate-limit headers reflect the consumer grant, but
the current limiter is process-local. Production is deliberately capped at one warm instance so
it cannot multiply by autoscaling, but a restart resets the window; it is not a durable distributed
quota.

See [NWS v4 developer handoff](NWS_V4_DEVELOPER_HANDOFF.md) for provisioning, source-plane,
operations, and rollout details.

## Stable v3 financial contract

NWS means **Net Worth Score** on the current product route:

```text
POST /v3/nearby-net-worth/discover
X-NWS-API-Key: <server-held secret>
Content-Type: application/json
```

The v3 request accepts the same exclusive ZIP/ZIP+4 or coordinate location form documented below,
plus `top_n` (1–200), `initial_radius_km`, `max_radius_km`, and `auto_expand`. It deliberately
rejects professional lanes, tags, diversity, and confidence filters.

Its response separates `coverage` (location), `financial_coverage` (eligible financial ledgers),
`result_set`, `search`, and `source_status`. Each scored result exposes an estimated USD range,
fixed-national `nws`, separate confidence, six component states, liquid wealth when supportable,
a public location relationship, last financial update, and official citations. Missing evidence
never becomes zero. See [NET_WORTH_SCORE_HANDOFF.md](NET_WORTH_SCORE_HANDOFF.md) for the complete
v3 JSON, source matrix, edge cases, and operational contract.

## Legacy professional contract

The remaining sections document `/v2/nearby-network/discover`. Its historical `global_nws` is now
explicitly `PROFESSIONAL_NETWORK_PROVISIONAL`; it is not Net Worth Score and must not be displayed
as wealth.

> **Release mode:** hybrid reviewed Kirkland plus US national public-professional snapshots.
>
> `COVERED` is source-query coverage, not a population census, residence claim, physical-presence
> claim, or guaranteed result count.

## Endpoint and authentication

```text
POST /v2/nearby-network/discover
X-NWS-API-Key: <server-held secret>
Content-Type: application/json
```

Call from a consumer BFF/server route. Wildcard non-cookie CORS supports multiple projects but does
not make a key safe in browser JavaScript or a mobile binary.

Public utility endpoints:

```text
GET /health
GET /ready
GET /docs
GET /openapi.json
```

Former `/v1/*` and `/internal/*` discovery routes are not public product surfaces.

`/ready` reports the reviewed bootstrap `candidate_count`, `geography_record_count: 33791`, whether
national sources are enabled, `complete: false`, and the compatibility model version. The model
actually used for a national discovery response is in that response's `snapshot.model_version` and
`release.model_version`; do not interpret readiness `candidate_count` as the size of the national
source indexes.

## Request

Supply exactly one location form. Unknown fields and mixed postal-plus-coordinate requests are
rejected. This section documents the legacy v2 compatibility route, which preserves its historical
Pydantic scalar coercion. New financial clients use v3, whose JSON scalar types are strict and
reject stringified numbers or booleans.

### US postal

```json
{
  "query": {"postal_code": "60637"},
  "top_n": 60,
  "initial_radius_km": 20,
  "max_radius_km": 100,
  "auto_expand": true,
  "diversity": true,
  "filters": {"minimum_confidence_grade": "B"}
}
```

Rules:

- A bare five-digit US ZIP or ZIP+4 is interpreted as US.
- `country_code: "US"` is accepted and preferred when the client already knows the country.
- Malformed US input such as `980-33` returns `422`. It is not silently repaired or confused with
  an absent geography record.
- ZIP+4, for example `60637-1234`, is normalized to base ZCTA `60637`; the original value may be
  preserved as `query.input_postal_code`.
- The packaged geography contains 33,791 records from the 2025 Census Gazetteer ZCTA release.
- ZCTA internal points are approximate statistical geography, not USPS delivery boundaries,
  residences, or rooftop coordinates.
- A ZIP absent from the packaged ZCTA index returns `200` with `LOCATION_UNRESOLVED`; no nearest-ZIP
  fallback is used.
- Non-US postal input requires a country code and is unresolved by this US release.

### Consented coordinate

```json
{
  "query": {
    "latitude": 41.782504,
    "longitude": -87.602734,
    "country_code": "US"
  },
  "top_n": 60,
  "initial_radius_km": 20,
  "max_radius_km": 100
}
```

Rules:

- Latitude and longitude are required together.
- The API rounds coordinates to the configured two decimal places before coverage lookup and
  source retrieval. Raw request bodies/coordinates are not written by application logging.
- `country_code` is ISO-3166 alpha-2 client context. An explicit non-US value never enters the US
  candidate fan-out.
- Without a country, US context is inferred from the packaged 2025 Census state/territory boundary.
  At coastlines the service checks the represented coarsened cell—not the discarded raw point—so
  two-decimal rounding cannot move an onshore coordinate just offshore.
- The response labels direct boundary containment versus quantized-cell intersection as
  approximate; send explicit country context when possible.

### Fields

| Field | Type / default | Constraint |
| --- | --- | --- |
| `query.postal_code` | string | Five-digit US ZIP or ZIP+4 for the US path; mutually exclusive with coordinates. |
| `query.country_code` | string | ISO-3166 alpha-2 when present. |
| `query.latitude` | number | `-90` to `90`; required with longitude. |
| `query.longitude` | number | `-180` to `180`; required with latitude. |
| `top_n` | integer / `100` | `1` to `400`. |
| `initial_radius_km` | number / `20` | Greater than `0`, at most `250`. |
| `max_radius_km` | number / `100` | Greater than `0`, at most `500`, and not less than initial radius. |
| `auto_expand` | boolean / `true` | May expand within the request maximum. |
| `diversity` | boolean / `true` | Enables result diversification when supported. |
| `filters.minimum_confidence_grade` | `A`, `B`, `C`, `D` / `B` | Minimum accepted confidence. |
| `filters.lanes` | array | Optional professional-lane filter. |
| `filters.tags` | array | Optional tags; at most 20. |

Tags are whitespace-compacted, case-normalized, deduplicated in request order, and limited to 64
characters each. Empty tags return `422`.

Malformed, partial, mixed, ambiguous, incorrectly typed, or unknown-field input returns `422`.
A canonical five-digit US value that is absent from the packaged ZCTA index, such as `00000`, is
different: it returns `200` with `LOCATION_UNRESOLVED` because syntax succeeded but geography did
not resolve.

## Backend selection

| Resolved query | Backend |
| --- | --- |
| Postal `98033` | Versioned reviewed Kirkland public-association release. |
| Coarsened coordinate within the configured Kirkland market radius | Versioned reviewed Kirkland public-association release. |
| Other explicit or approximately inferred US coordinate | National SEC/NPPES fan-out. |
| Other packaged US ZCTA | National SEC/NPPES fan-out. |
| Explicit non-US coordinate | No people backend; `NOT_COVERED`. |
| Unresolved country or postal geography | No people backend; explicit empty coverage state. |

Kirkland candidates are never used as filler outside the reviewed market.

## Coverage response

Every successful request includes:

```json
{
  "coverage": {
    "status": "COVERED | NOT_COVERED | LOCATION_UNRESOLVED",
    "reason_code": "...",
    "complete": false,
    "candidate_backend": "...",
    "message": "..."
  }
}
```

| Status | Contract |
| --- | --- |
| `COVERED` | Search ran against the selected reviewed/national backend. Results may be populated or empty. |
| `NOT_COVERED` | The coordinate is explicitly non-US or country context could not be established. `results` and candidate counts are zero. |
| `LOCATION_UNRESOLVED` | Postal syntax was accepted but canonical geography was not found/selected. `results` and candidate counts are zero. |

For national US requests, `COVERED` means approved public-source fan-out coverage. It does not mean
the response is complete, every person is indexed, or every ZIP will return 60 results.

## Successful response shape

All successful responses include:

```json
{
  "query": {},
  "coverage": {},
  "snapshot": {
    "data_mode": "NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT",
    "score_status": "PROVISIONAL",
    "score_kind": "PROFESSIONAL_NETWORK_PROVISIONAL",
    "complete": false,
    "model_version": "..."
  },
  "release": {},
  "discovery": {},
  "financial_context": {
    "status": "NOT_PROFILED",
    "personal_financial_strength": "NOT_PROVIDED"
  },
  "score_definition": "...",
  "generated_at": "...",
  "source_status": [],
  "source_health": {},
  "result_set": {},
  "search": {},
  "summary": {},
  "results": []
}
```

The reviewed Kirkland path preserves its release identifiers, manifest hashes, review date, and
organization-anchor disclosure; it does not include national `source_status`. The national path
uses release id `us-national-public-professional-live-snapshot`, market id
`us-national-public-association`, the national model/source-policy version, Census geography
source/count, and `complete: false`. It reports source fan-out status rather than pretending to be
part of the Kirkland manifest.

National `discovery.mode` is `AUTHORITATIVE_PUBLIC_REGISTRY_FANOUT`; its publication rule requires
a stable registry identifier plus source-specific identity, role/practice, location, freshness,
and privacy gates. `market_census_complete` remains false. This is deterministic registry
projection, not automatic publication of arbitrary crawler output.

A national `summary` exposes at least the requested/returned counts, effective radius, coverage
status, national candidate backend, search state, and freshness/graph disclosure. Source status
identifies SEC and NPPES as `OK`, `EMPTY`, or `UNAVAILABLE` (with bounded, non-secret error codes),
candidate counts, source-as-of/index timestamps, and truncation/cache state where applicable.

Source unavailability is fail-soft: a healthy source may still return candidates when the other is
down. An `EMPTY` source is healthy but sparse. If every configured national source is unavailable,
the endpoint returns `503` with `NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE`. The response must not
fabricate candidates; a covered response can otherwise be empty.

### Result and search accountability

Covered responses add a final-result block derived after user filters, publication policy,
confidence gating, radius expansion, scoring, and diversification:

```json
{
  "result_set": {
    "status": "TARGET_MET | PARTIAL | EMPTY",
    "requested_count": 200,
    "returned_count": 73,
    "shortfall_count": 127,
    "target_satisfied": false,
    "reasons": ["MAX_RADIUS_REACHED", "SOURCE_TARGET_NOT_MET"]
  },
  "search": {
    "performed": true,
    "scope": "FINAL_RANKING_RADIUS",
    "auto_expand": true,
    "expanded": true,
    "expansion_steps_km": [20, 35, 61.25, 100],
    "effective_radius_km": 100,
    "maximum_radius_km": 100,
    "maximum_radius_reached": true,
    "returned_by_distance_band": [
      {"band": "10–25 km", "count": 31},
      {"band": "25–50 km", "count": 42}
    ]
  }
}
```

`returned_by_distance_band` aggregates the same coarse association-distance bands already safe on
individual results. It never exposes an exact person distance. `result_set` is the final response
target state; a source-specific `target_satisfied` field is only that source's retrieval state.

Uncovered or unresolved requests use `result_set.status: NOT_SEARCHED`, `search.performed: false`,
and the coverage reason code. They are not described as a healthy-but-empty source search.

`result_set.reasons` is additive and can include source degradation, disabled expansion, filters,
publication policy, confidence gating, maximum radius, source target shortfall, source sparsity, or
reviewed-pool exhaustion. A target-met response has an empty reason list.

### Aggregate source health

National responses retain full `source_status` and add a bounded `source_health` projection:

```json
{
  "source_health": {
    "status": "HEALTHY | DEGRADED | UNAVAILABLE | NOT_QUERIED",
    "mode": "LIVE_PUBLIC_SOURCE_SNAPSHOTS",
    "queried_source_count": 2,
    "successful_sources": ["CMS_NPPES"],
    "empty_sources": [],
    "unavailable_sources": ["SEC_SECTION16"],
    "partial_sources": [],
    "stale_sources": [],
    "reasons": ["SOURCE_UNAVAILABLE"]
  }
}
```

SEC partial/stale indexes and degraded NPPES expansion stages make aggregate health `DEGRADED`.
An `EMPTY` source is successful and does not by itself mean unhealthy. Kirkland and uncovered paths
use `NOT_QUERIED` with `REVIEWED_RELEASE` or `NOT_QUERIED` mode rather than pretending a live source
fan-out occurred.

The national summary uses
`candidate_backend: "national-sec-nppes-public-professional-snapshot"`,
`public_registry_candidate_count`, and
`reviewed_public_association_candidate_count: 0`. The reviewed Kirkland summary uses
`candidate_backend: "reviewed-public-association-release"` and its reviewed count.

### National source status

NPPES status can include:

```json
{
  "source": "CMS_NPPES",
  "status": "OK | EMPTY | UNAVAILABLE",
  "scope": "US_ACTIVE_INDIVIDUAL_HEALTHCARE_PROFESSIONALS",
  "candidate_count": 0,
  "rows_received": 0,
  "rows_rejected": 0,
  "source_as_of": "...",
  "queried_at": "...",
  "query_mode": "POSTAL_CODE | POSTAL_THEN_RADIUS_EXPANSION | COORDINATE_RADIUS",
  "truncated": false,
  "location_granularity": "POSTAL_AREA",
  "score_status": "PROVISIONAL"
}
```

SEC status can include:

```json
{
  "source": "SEC_SECTION16",
  "status": "OK | EMPTY | UNAVAILABLE",
  "source_id": "sec_section16_professional",
  "ranking_mode": "professional",
  "index_built_at": "...",
  "index_partial": false,
  "index_stale": false,
  "raw_candidate_count": 0,
  "upstream_total": 0,
  "truncated": false,
  "accepted_candidate_count": 0,
  "rejected_entity_count": 0,
  "rejected_owner_only_count": 0,
  "rejected_invalid_count": 0,
  "cache_hit": false
}
```

Unavailable statuses carry bounded error codes, never exception text, connection strings, or
credentials.

## Result contract

Each public result may include:

- Rank, stable source-scoped person ID, public name/headline, organization, lane, and tags.
- Provisional `global_nws`, `nearby_rank_score`, score components, coverage/integrity factors,
  reasons, and warnings.
- Confidence score/grade, `score_status`, and
  `score_kind: PROFESSIONAL_NETWORK_PROVISIONAL`.
- `ranking_basis`, distinguishing provisional NWS scoring from source-verified registry ordering.
- Public association label, kind, granularity, and approximate distance band.
- `freshness`, containing the public association as-of date, latest source-observation timestamp,
  and whether revalidation is required.
- `financial_evidence.status: NOT_PROFILED`, `personal_financial_strength: NOT_PROVIDED`, and
  `used_for_ranking: false`. Missing financial evidence is never serialized as a numeric zero.
- Citation count, source-family/evidence-fact count, review flags, revalidation state, and public
  source links/retrieval timestamps.
- Model version.

The service never serializes:

- A person's raw/exact coordinate or exact distance.
- Home/residence, street or mailing address, phone, email, or personal contact enrichment.
- Family/household graph, private page, check-in, or device-location assertion.
- Securities, shares, disclosed/market value, compensation, liquidity, property, income, assets,
  net worth, or named financial-strength inference.
- Raw SEC/NPPES records or database/source credentials.

For SEC records, location means a public issuer-office association. For NPPES records, location
means a public practice postal-area association. Neither proves current physical presence.

The current score is a provisional professional-network score. It must not be relabeled as wealth,
financial capacity, net worth, liquidity, or ability to pay.

## Source and freshness semantics

- **Kirkland:** immutable reviewed manifest and candidate-level public citations.
- **SEC:** live server-to-server query over a built Section 16 snapshot using confirmed
  value-free professional ordering; includes index/filing freshness disclosure.
- **NPPES:** live Cloud SQL query over a restricted active-individual read model; includes
  `last_seen`/query freshness and truncation status.

The product-safe term is **live query over current public-source snapshots**. The API does not
crawl source websites during the request and does not return live person locations.

## Errors and headers

| HTTP | Condition | Consumer behavior |
| --- | --- | --- |
| `200` | Covered, non-covered, unresolved, sparse, or fail-soft source outcome | Parse `coverage` and source status. |
| `401` | Missing/invalid `X-NWS-API-Key` | Fix server-side secret injection; never add a client key. |
| `413` | Request over 32 KiB | Reduce payload. |
| `422` | Invalid request contract | Correct request without guessing a different location. |
| `429` | Rate limited | Honor `Retry-After` and back off. |
| `503` | National sources disabled or all configured sources unavailable | Show a retryable service state; do not substitute people from another place. |
| Other `5xx` | Service-level failure | Show a retryable error; do not substitute cached people from another place. |

Responses can include `X-Request-ID`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, and `Retry-After`.

## Acceptance example: 60637

For the healthy national source snapshots used for release acceptance, a `60637` request with
`top_n: 60` is expected to be `COVERED` and return at least 60 public-association results. This is a
deployment-health assertion for that snapshot, not an API guarantee. Filters, snapshot freshness,
source outages, corrections/suppressions, and genuinely sparse geographies can reduce the count.

See [US national coverage handoff](US_NATIONAL_COVERAGE_HANDOFF.md) for infrastructure, source
policy, production probes, monitoring, and rollback.
