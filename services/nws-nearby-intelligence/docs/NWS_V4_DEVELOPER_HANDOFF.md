# NWS v4 developer handoff

## What this service returns

`POST /v4/net-worth/discover` returns a best-effort, public-safe ranking of financially eligible
people associated with a US query location. It accepts a US ZIP/ZIP+4 or a consented coordinate.

The route does not promise 100, 150, or 200 people. It always reports the requested count,
returned count, and shortfall. A location can be covered while named financial coverage is empty.

Current evidence boundary:

- National query geography: packaged 2025 Census ZCTA data.
- National candidate discovery: public SEC Section 16 Officer/Director associations and active
  individual CMS NPPES public-practice associations.
- Positive named NWS coverage: a bounded, partial Florida public-official roster backed by reviewed
  sworn Form 6 whole-net-worth declarations.
- SEC holdings, NPPES records, compensation, funding, revenue, and AUM do not become personal net
  worth.
- “Nearby” is a public office, issuer, practice, institution, or opt-in association. It is not a
  residence or current physical-presence claim.

The v4 contract is versioned as `nws-nearby-net-worth-v4-preview-1`. v2 and v3 remain stable for
existing consumers; new consumers should use v4 only when `GET /ready` reports `v4_enabled: true`.

## Integration boundary

Call NWS from a trusted BFF or server:

```text
Browser or app -> product BFF -> NWS v4
                             X-NWS-API-Key: per-project secret
```

Do not put the key in client JavaScript, `NEXT_PUBLIC_*`, a mobile bundle, source control, logs, or
DevTools. Wildcard non-cookie CORS prevents origin allowlist failures; it does not make a secret
safe in a browser.

Each consumer receives its own `nws_live_*` key and policy. SSH is not an API authentication
mechanism. Developers do not need VM, scraper, database, or Cloud Run SSH access to call NWS.

Base utilities:

```text
GET  /health
GET  /ready
GET  /docs
GET  /openapi.json
POST /v4/location-consent/receipt
POST /v4/net-worth/discover
```

## Postal request

```bash
curl -sS "$NWS_BASE_URL/v4/net-worth/discover" \
  -H "Content-Type: application/json" \
  -H "X-NWS-API-Key: $NWS_API_KEY" \
  -d '{
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
  }'
```

Rules:

- Supply exactly one location form.
- Postal input is a five-digit US ZIP or ZIP+4. ZIP+4 resolves through its five-digit ZCTA base.
- `selection.count` is exactly `100`, `150`, or `200`.
- Unknown fields and stringified numbers/booleans return `422`.
- Postal requests must not include `coordinate_consent`.
- `caller_context.project_id` and `purpose_id` must match the authenticated registry grant.
- v4 currently serves only `PUBLIC_SAFE` scope and tier.
- `audit_actor` must be a stable, product-scoped opaque user/session subject, not a person's name,
  email, raw account ID, or a service-wide constant. Keep the underlying login and consent record in
  the consumer BFF. A service-account actor is reserved for machine smoke tests only.
- `model_version` must match `/ready.net_worth_model_version`. The current source model is
  `net-worth-v1.0.0`; a mismatch fails closed.

## Coordinate consent flow

The product must obtain location permission and record the user's affirmative action first. Its
BFF then mints a short-lived receipt. This endpoint receives no ZIP or coordinates:

```bash
curl -sS "$NWS_BASE_URL/v4/location-consent/receipt" \
  -H "Content-Type: application/json" \
  -H "X-NWS-API-Key: $NWS_API_KEY" \
  -d '{
    "project_id": "your-project",
    "purpose_id": "NET_WORTH_LOOKUP",
    "audit_actor": "subject:hush_7f3c9a2e1d4b",
    "scope": "APPROXIMATE_LOCATION_QUERY",
    "consent_granted": true
  }'
```

The response is a receipt object:

```json
{
  "receipt_id": "nwc1.<signed-payload>.<signature>",
  "purpose_id": "NET_WORTH_LOOKUP",
  "audit_actor": "subject:hush_7f3c9a2e1d4b",
  "scope": "APPROXIMATE_LOCATION_QUERY",
  "issued_at": "2026-08-14T12:00:00Z",
  "expires_at": "2026-08-14T12:15:00Z"
}
```

Send that object unchanged with the coordinate query:

```json
{
  "query": {
    "latitude": 47.6715,
    "longitude": -122.2133,
    "country_code": "US"
  },
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
  },
  "coordinate_consent": {
    "receipt_id": "nwc1.<signed-payload>.<signature>",
    "purpose_id": "NET_WORTH_LOOKUP",
    "audit_actor": "subject:hush_7f3c9a2e1d4b",
    "scope": "APPROXIMATE_LOCATION_QUERY",
    "issued_at": "2026-08-14T12:00:00Z",
    "expires_at": "2026-08-14T12:15:00Z"
  }
}
```

The receipt is bound to consumer, project, route, purpose, actor, and expiry; it contains no
location. It is consumed once across service instances using an atomic Cloud Storage write. An
expired, altered, replayed, mismatched, or unverifiable receipt fails closed. A coordinate
discovery request without the receipt object fails request validation.

NWS verifies the BFF's signed assertion; it cannot observe the device permission UI. The consuming
product remains responsible for showing the prompt and retaining consent audit evidence.

## Modes and filters

| Control | Behavior |
| --- | --- |
| `financial_mode: estimated` | Ranks by median estimate. Allows A/B and qualified C only; C needs at least 0.55 coverage and direct financial evidence. |
| `financial_mode: verified` | A/B only, direct financial evidence, and at least 0.70 coverage. |
| `financial_mode: observed-only` | Requires an attributable observed floor and ranks by that floor. |
| `geography_mode: nearest-count` | Expands within the upstream maximum and returns the eligible set found; count is a target, not a guarantee. |
| `geography_mode: strict-radius` | Requires `maximum_radius_miles`; returns only a compatible radius-backed result or fails closed. |
| `minimum_confidence` | `A`, `B`, or `C`; D/E are always excluded. |
| `minimum_coverage` | `0.0` to `1.0`; mode-specific minimums still apply. |
| `asset_families` | Optional unique subset of cash, public securities, private business, real estate, or other assets. |

`maximum_radius_miles` is capped at `310.685596` (500 km). The active upstream does not yet
materialize the planned ZIP -> county -> CBSA -> state -> national expansion hierarchy. The
response discloses that limitation; `nearest-count` must not be described as complete national
exhaustion.

## Response contract

An abbreviated contract example based on the current implementation's `98033` zero-result path
looks like this; it is not live-deployment proof. Intermediate expansion-step objects and additive
disclosures are omitted, and counts remain data-dependent:

```json
{
  "contract_version": "nws-nearby-net-worth-v4-preview-1",
  "coverage_contract": "BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES",
  "data_tier": "PUBLIC_SAFE",
  "request_policy": {
    "project_id": "your-project",
    "purpose_id": "NET_WORTH_LOOKUP",
    "authorization_scope": "PUBLIC_SAFE",
    "requested_data_tier": "PUBLIC_SAFE",
    "audit_actor_reference": "actor_0123456789abcdef",
    "financial_mode": "estimated",
    "geography_mode": "nearest-count",
    "minimum_confidence": "C",
    "minimum_coverage": 0.55,
    "asset_families": []
  },
  "query": {
    "label": "Kirkland, Washington 98033 query area",
    "mode": "POSTAL_CODE",
    "postal_code": "98033",
    "country_code": "US",
    "approximate": true
  },
  "coverage": {
    "status": "COVERED",
    "reason_code": "APPROVED_MARKET_RELEASE",
    "market_label": "Kirkland public-association market",
    "country_code": "US"
  },
  "snapshot": {
    "model_version": "net-worth-v1.0.0",
    "scale_version": "nws-fixed-us-log-v1.0.0",
    "as_of": "...",
    "upstream_complete": false
  },
  "financial_coverage": {
    "upstream_status": "FINANCIAL_COVERAGE_INSUFFICIENT",
    "discovered_count": 60,
    "evaluated_count": 60,
    "upstream_scored_count": 0,
    "v4_eligible_count": 0
  },
  "expansion": {
    "requested_strategy": "nearest-count",
    "upstream_strategy": "LEGACY_RADIUS",
    "status": "PARTIAL",
    "steps": [
      {
        "order": 8,
        "stage": "LEGACY_RADIUS",
        "radius_miles": 310.69,
        "count_status": "AVAILABLE",
        "discovered_count": 60,
        "evaluated_count": 60,
        "financially_eligible_count": 0,
        "cumulative_returned_count": 0
      }
    ],
    "effective_radius_miles": 310.69,
    "maximum_radius_reached": true,
    "disclosure_code": "UPSTREAM_PER_STEP_COUNTS_UNAVAILABLE"
  },
  "result_set": {
    "requested_count": 100,
    "upstream_result_count": 0,
    "eligible_count": 0,
    "returned_count": 0,
    "shortfall_count": 100,
    "target_satisfied": false,
    "reasons": [
      "FINANCIAL_COVERAGE_INSUFFICIENT",
      "NO_UPSTREAM_FINANCIAL_RESULTS",
      "UPSTREAM_NEAREST_COUNT_EXPANSION_INCOMPLETE",
      "INSUFFICIENT_ELIGIBLE_PROFILES"
    ]
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

Always render `result_set`, not an assumed minimum. A positive result additionally includes:

- the person projection and public-association notice;
- estimated p10/median/p90 USD and fixed-scale NWS uncertainty;
- an observed floor when supportable;
- confidence grade/score/coverage and component statuses;
- an available-set-only rank interval and concise `why_ranked` reasons;
- source host families derived from accepted upstream citations, not raw documents or filing
  schedules.

The discovery response never includes the API key, raw audit actor, exact person coordinates/
distance, residence, street address, phone/email, family graph, raw source payload, or private
browser data.

## Consumer registry

The runtime loads exact JSON bytes from `NWS_CONSUMER_REGISTRY_JSON` and verifies their SHA-256
against `NWS_CONSUMER_REGISTRY_SHA256`. Startup fails if the registry is absent, malformed, or not
byte-for-byte pinned while v4 is enabled.

```json
{
  "schema_version": "nws-consumer-access-registry-v1",
  "registry_version": 1,
  "consumers": [
    {
      "consumer_id": "your-product-prod",
      "project_id": "your-project",
      "tier": "STANDARD",
      "api_key_sha256": "<64-lowercase-hex-digest>",
      "expires_at": "2027-08-14T23:59:59Z",
      "kill_switch": false,
      "grants": [
        {
          "route": "/v4/net-worth/discover",
          "purpose": "NET_WORTH_LOOKUP",
          "max_top_n": 200,
          "max_radius_km": 500.0,
          "requests_per_minute": 30,
          "coordinate_consent_max_age_seconds": 900
        }
      ]
    }
  ]
}
```

Provisioning rules:

1. Generate one 256-bit `nws_live_*` key for one consumer/environment.
2. Store the raw key only in that consumer's server-side secret store.
3. Put only `sha256(key)` in the registry; never reuse a digest across consumers.
4. Canonicalize the final registry once, calculate its SHA-256, and store both exact JSON and hash
   as numbered deployment inputs.
5. Increment `registry_version` for every policy or key change.
6. Use `kill_switch: true`, expiry, or key rotation to revoke access.
7. Verify `/ready` reports the expected registry version and consumer count.

The grant enforces exact route and purpose, result-count ceiling, radius ceiling, requests per
minute, and coordinate-consent age. Production is capped at one warm instance so the current
process-local quota cannot multiply across autoscaled replicas. A restart still resets it; use an API
gateway or shared atomic limiter before treating it as a globally exact multi-instance quota.

## Source plane and scraper boundary

Source registry v4 applies fail-closed defaults. A source must be explicitly enabled, its kill
switch must be off, and operation + product + purpose must match before acquisition, query, or
snapshot publication. The current approved manifest pins 27 catalog entries; catalog presence is
not evidence that a collector, parser, snapshot, or live query is enabled.

Current enabled uses:

| Source | Allowed use | NWS evidence? |
| --- | --- | --- |
| Florida Form 6 reviewed snapshot | Sworn whole-net-worth declaration | Yes, within the reviewed partial roster. |
| SEC Section 16 professional snapshot | Candidate identity and issuer-office association | No. |
| CMS NPPES public professionals | Candidate identity and practice-area association | No. |

The remaining catalog entries—including broader SEC filings, ADV, Form D, IRS, USPTO, research,
official-site, open-web, business-registry, award, and social families—inherit disabled and
kill-switched defaults unless a future reviewed release explicitly overrides them. Do not report
them as live sources based only on `sources.yaml`.

CMS Open Payments ownership support is an offline, privacy-reducing parser foundation only. Its
registry entry is disabled and kill-switched. It accepts immutable, content-addressed official CMS
CSV artifacts, requires NPI, excludes immediate-family/non-physician rows, strips person/contact/
location/free-text fields, and emits only `observed_business_interest` claims with partial asset
coverage, unknown liabilities, and `nws_eligible: false`. It does not feed the live v4 response.

Existing social scraper infrastructure may supply operational patterns—dedicated workers, jobs,
queues, observability, Secret Manager, immutable artifacts, and deploy automation—but not shared
machines or identity material. Do not reuse Instagram/LinkedIn/X/Threads VMs, disks, sessions,
cookies, accounts, SSH keys, broad service accounts, or private-page/CAPTCHA bypass behavior.

If an approved public source later requires a browser worker, isolate it behind a dedicated NWS
service account, private VM or job, source-specific egress, separate disk/secrets, and an immutable
artifact handoff. Prefer IAP + OS Login for break-glass administration; do not distribute a shared
SSH private key. Browser workers can propose source facts but cannot publish people or financial
scores directly.

## Operations

Required v4 runtime settings:

```text
NWS_V4_ENABLED=true
NWS_CONSUMER_REGISTRY_JSON=<secret-mounted exact JSON>
NWS_CONSUMER_REGISTRY_SHA256=<pinned digest>
NWS_CONSENT_RECEIPT_BUCKET=<unqualified bucket name>
```

Grant the runtime identity read access only to the numbered registry secret and create-only access
to receipt-use markers in the dedicated bucket. Apply a short retention lifecycle to those hashed
markers; do not place coordinates or user identifiers in that bucket.

`GET /ready` should expose the expected service/model versions, `v4_enabled`,
`consumer_registry_version`, `consumer_count`, and active financial snapshot identity without
revealing registry contents or keys.

Financial scoring additionally depends on the reviewed snapshot settings documented in
[Net Worth Score handoff](NET_WORTH_SCORE_HANDOFF.md). Candidate discovery depends on the SEC and
NPPES services described in [US national coverage handoff](US_NATIONAL_COVERAGE_HANDOFF.md).

Release verification:

```bash
.venv/bin/python -m pytest -q
.venv/bin/python -m ruff check \
  app/main.py app/settings.py app/security.py app/net_worth_v4.py \
  app/consumer_access.py app/coordinate_consent.py app/source_plane \
  tests/test_net_worth_v4.py tests/test_net_worth_v4_api.py \
  tests/test_consumer_access.py tests/test_coordinate_consent.py \
  tests/test_cms_open_payments_source_plane.py
.venv/bin/python -m mypy --follow-imports=skip \
  app/consumer_access.py app/coordinate_consent.py app/net_worth_v4.py \
  app/collectors/registry.py app/collectors/fetcher.py
```

The protected workflow contains the complete production path-scoped Ruff list.

Then verify the exact merged SHA, green CI, Cloud Run revision and traffic, `/health`, `/ready`, a
postal v4 request, consent issuance plus one successful coordinate request, receipt replay denial,
an unresolved ZIP, explicit non-US coordinates, a sparse covered location, and redacted audit
logs. Roll back by moving traffic to the last verified revision or disabling v4; do not substitute
Kirkland or cached people for another location.

## Consumer error handling

| HTTP | Meaning | Action |
| --- | --- | --- |
| `401` | Invalid service credential | Fix BFF secret injection; never move the key client-side. |
| `403` | Consumer expired/disabled, or project, purpose, tier, limit, or consent policy denied | Correct the registered request or policy; do not broaden scope locally. |
| `409` | Active public snapshot cannot truthfully satisfy the v4 projection | Relax a compatible filter/radius or wait for a supported snapshot. |
| `413` | Payload exceeds 32 KiB | Reduce the request. |
| `422` | Strict request validation failed | Fix the exact field/type or obtain coordinate consent first. |
| `429` | Per-consumer request window exceeded | Honor `Retry-After` and back off. |
| `503` | v4, consent verification, or required upstream is unavailable | Show a retryable unavailable state; never fabricate/fallback people. |

Persist `X-Request-ID` for support. Consumer-access audit events intentionally omit key, IP,
person, ZIP, and coordinates. Treat `X-RateLimit-*` as operational guidance; globally exact quotas
require the future shared limiter.

## Not claimed

- A census of US people or a guaranteed count in any ZIP.
- Nationwide named Net Worth Score coverage.
- Current presence, home, or street-level location.
- Total net worth from one holding, ownership interest, salary, funding round, revenue, or AUM.
- Completed ZIP -> county -> CBSA -> state -> national expansion.
- Request-time social/open-web scraping.
- Restricted/private data access, eligibility decisions, or adverse-action use.
- Globally exact distributed rate limits.
