# NWS Nearby API contract

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
rejected.

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

Malformed, partial, mixed, ambiguous, or unknown-field input returns `422`.

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
- Confidence score/grade and `score_status`.
- `ranking_basis`, distinguishing provisional NWS scoring from source-verified registry ordering.
- Public association label, kind, granularity, and approximate distance band.
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
