# Implementation status

> This file describes the national release implemented in source. A merged SHA, green CI, Cloud
> Run revision, active traffic, live source health, and consumer integration are separate proof
> layers; revalidate them from the production handoff rather than treating this file as live state.

## Implemented national release

### Hardened v4 preview

- Conditional `POST /v4/net-worth/discover` contract, versioned as
  `nws-nearby-net-worth-v4-preview-1`; v2/v3 remain compatible.
- Exact 100/150/200 result targets with returned, eligible, and shortfall counts. No minimum-result
  guarantee or cross-market filler.
- `estimated`, `verified`, and `observed-only` financial modes; nearest-count and strict-radius
  geography modes; confidence, coverage, and asset-family filters.
- A/B plus qualified-C publication. D/E always fail closed. Verified mode requires direct evidence
  and at least 0.70 coverage; observed-only requires an attributable floor.
- NWS p10/median/p90 uncertainty, available-set rank intervals, concise ranking reasons, source
  host families, and public-association notices.
- Public-safe projection only: no raw citation documents, actor, credential, exact person location,
  residence, personal contact, family graph, or source payload.
- Per-consumer, per-project API keys backed by a strict, exact-byte SHA-256-pinned registry.
- Exact route/purpose grants with consumer tier, expiry, kill switch, count/radius ceilings,
  requests-per-minute policy, and consent-age ceiling.
- Redacted allowlist audit events with server-minted audit request IDs; events omit API key, IP,
  person, ZIP, and coordinates.
- `POST /v4/location-consent/receipt` for BFF-recorded affirmative location consent. Receipts are
  short-lived, signed, purpose/actor/project/consumer/route bound, location-free, and atomically
  single-use across instances through Cloud Storage.
- Startup validation for v4 registry bytes/hash and consent bucket. `/ready` reports v4 enabled
  state, registry version, and consumer count.
- Per-grant rate-limit headers and enforcement through the current process-local adapter. Production
  is capped at one warm instance to prevent autoscaling multiplication, but a restart resets the
  window. This is a
  migration guard, not a globally exact distributed quota.
- Explicit disclosures that financial coverage is not nationwide, the upstream snapshot is
  incomplete, rank intervals cover only the available set, and the planned geographic hierarchy
  is not yet materialized.

### Geography and routing

- Immutable 2025 U.S. Census Gazetteer ZCTA geography with 33,791 records.
- Readiness-time SHA-256 and record-count validation against
  `data/geography/us/2025/manifest.json`.
- Bare five-digit US ZIP and ZIP+4 normalization to the five-digit ZCTA base.
- ZIP+4 input preservation in response query metadata.
- Coordinate coarsening before coverage lookup and source retrieval.
- Explicit US coordinate routing.
- Labeled approximate US inference from the 2025 Census 1:500,000 state/territory boundary when
  country context is absent, including privacy-coarsened-cell intersection at coastlines.
- Explicit non-US and unresolved-country empty coverage states.
- Hybrid routing: reviewed Kirkland backend for `98033`/Kirkland radius; national backend for other
  resolved US queries.
- No cross-market Kirkland fallback.

### National people sources

- SEC Section 16 natural-person Officer/Director adapter.
- Required `ranking=professional` contract that excludes disclosed/market value ordering.
- Legal-entity and owner-only rejection.
- Whitelist projection of public role, issuer, filing date, and coarse issuer-office association.
- Bounded server-to-server timeout, response-size guard, no credential forwarding on redirects,
  and short-lived policy-safe cache.
- CMS NPPES adapter for active individual public-practice associations.
- Exact practice-ZIP-first retrieval with bounded PostGIS expansion for sparse postal input, and
  direct PostGIS `ST_DWithin` retrieval for coordinates.
- Fixed `public.nws_public_professionals_by_postal` and
  `public.nws_public_professionals_nearby` functions plus an execute-only NWS database role.
- Fail-soft source status with non-secret error codes, source freshness, and truncation disclosure.
- Source-verified NPPES records leave unsupported graph, outcome, reach, and financial features at
  zero.
- Per-source deduplication and public-safe candidate metadata.

### Governed source plane

- Source registry version 4 with fail-closed defaults applied to every source: disabled and
  kill-switched unless a source explicitly overrides both.
- Exact source-use authorization for operation + purpose + product before acquisition, query, or
  reviewed snapshot publication.
- Enabled query-only public-safe bindings for SEC Section 16 candidate associations and CMS NPPES
  professional associations; neither is financial evidence.
- Florida Form 6 policy allows v3/v4 use under the same reviewed whole-declaration/privacy
  contract; the v4 route projects the already validated v3 public snapshot rather than loading a
  separate ledger.
- Immutable, content-addressed source-artifact and privacy-reduced financial-claim contracts.
- Offline CMS Open Payments ownership CSV projector with official-host allowlist, strict schema,
  NPI-only identity, exact decimal handling, deterministic deduplication, row accountability, and
  removal of name/contact/location/free text.
- CMS Open Payments remains disabled and kill-switched. Its output is only an
  `observed_business_interest` with partial asset coverage, unknown liabilities, and
  `nws_eligible: false`; it is not connected to live NWS scoring.
- No shared social scraper VM, disk, browser session, cookie, account, SSH key, or broad service
  identity is part of the NWS collection or request path.

### Reviewed market compatibility

- Existing 60-record Kirkland public-association release and manifest hashes.
- Existing 13-organization review-only anchor release.
- Candidate citations, source-family counts, evidence flags, and revalidation fields.
- Separate national model/data disclosure so national candidates are not presented as manually
  reviewed Kirkland records.

### API, ranking, and privacy

- Authenticated, per-project `POST /v4/net-worth/discover` and BFF-only
  `POST /v4/location-consent/receipt`.
- Authenticated `POST /v3/nearby-net-worth/discover`, where NWS means Net Worth Score.
- Fixed national logarithmic NWS scale, bounded whole-ledger simulation, separate confidence,
  mandatory liabilities, unknown-is-not-zero rules, and economic-interest deduplication.
- Direct Florida Form 6 public-jurisdiction adapter for sworn whole-net-worth declarations, with
  ZIP and bounded coordinate-to-ZCTA resolution, partial/truncated source status, and no fuzzy join.
- Declared whole totals remain undecomposed: every component is `INCLUDED_IN_DECLARED_TOTAL`,
  liquid wealth is unknown, and negative or zero declarations remain valid scores of zero.
- Nationwide candidate coverage and named financial coverage are distinct. Unsupported candidates
  return `FINANCIAL_COVERAGE_INSUFFICIENT`; no SEC holding or professional score becomes NWS.
- Authenticated `POST /v2/nearby-network/discover`.
- Public `GET /health`, `GET /ready`, `/docs`, and `/openapi.json`.
- `COVERED`, `NOT_COVERED`, and `LOCATION_UNRESOLVED` states.
- Strict JSON scalar validation, canonical US ZIP/ZIP+4 syntax checks, and normalized bounded tag
  filters. Malformed US ZIP syntax is a `422`; canonical syntax absent from the ZCTA release remains
  a truthful `LOCATION_UNRESOLVED` response.
- Sparse covered responses and fail-soft source outcomes without fabricated candidates.
- Additive final-result, ranking-radius search, distance-band, and aggregate source-health blocks so
  consumers can distinguish target-met, partial, empty, degraded, and not-searched outcomes.
- Confidence-aware radius behavior, lane/tag filters, NWS scoring, diversity, and public-safe
  serialization.
- Coordinate/request-body log suppression, 32 KiB request limit, security headers, in-process rate
  limiting, and wildcard non-cookie CORS.
- Explicit `financial_context: NOT_PROFILED` boundary.
- Per-result `PROFESSIONAL_NETWORK_PROVISIONAL`, `NOT_PROFILED` financial-evidence, and public-source
  freshness states; missing financial data is not emitted as a numeric zero or wealth inference.
- No private residence, exact person location, personal contact, family graph, raw source payload,
  securities/value/liquidity/property/income/net-worth output or ranking input.

### Tests and delivery

- National geography tests for record integrity, `60637`, ZIP+4, Kirkland routing, coordinate
  country context/inference, and non-US behavior.
- SEC adapter tests for value-free ordering, projection, entity/owner-only filtering, cache, and
  privacy omissions.
- NPPES tests for fixed-function calls, exact-ZIP/PostGIS query paths, source freshness,
  invalid/duplicate rejection, fail-soft behavior, and credential redaction.
- Existing API, scoring, policy, source-release, security, and parser regression suites.
- v4 request/projection tests for exact counts, all financial/geographic modes, A/B/C eligibility,
  D/E rejection, component filters, observed floors, uncertainty/rank intervals, privacy
  exclusions, shortfall, and strict-radius failures.
- Consumer-registry tests for exact-byte integrity, duplicate/unknown-field rejection, key format,
  kill switch/expiry, route-purpose/count/radius policy, rate limiting, forged contexts, and
  redacted audit events.
- API tests for missing credentials, project mismatch, truthful zero-result shortfall, safe request
  IDs, coordinate-consent issuance, successful single use, and replay denial.
- Source-plane tests for artifact integrity, CMS schema/host enforcement, immediate-family and
  non-physician exclusion, no name/address/contact leakage, no name fallback, and deterministic
  claim deduplication.
- Path-scoped NWS CI on Python 3.13.
- Protected production workflow using OIDC, an immutable image digest, dedicated service accounts,
  numbered Secret Manager versions, a Cloud SQL attachment, and public probes.

## Production dependencies

The national response requires these resources to be healthy:

| Dependency | Requirement |
| --- | --- |
| SEC source | `insider-holdings-api` exposes and honors value-free `professional` ranking over its current nationwide index. |
| NPPES database | `hushh-directories-db`, database `healthcare`, contains a current active-individual snapshot, owner-inspection view, and fixed postal/coordinate functions. |
| Database grants | `nws_nearby_ro` can execute only the fixed NWS postal/coordinate functions; it cannot select the owner-inspection view or underlying `providers`/`zips`. |
| Runtime secrets | Numbered versions of `nws-nearby-api-key`, `insider-api-key`, and `nws-nearby-nppes-db-password`. |
| v4 consumer policy | Exact JSON from a numbered secret version plus its pinned SHA-256; one raw key remains only in each consumer's BFF secret store. |
| Consent receipts | Dedicated Cloud Storage bucket supporting atomic create-only receipt-use markers; runtime needs object creation, not broad bucket administration. |
| Cloud Run identity | `nws-nearby-runtime@hushh-tech-prod.iam.gserviceaccount.com` has only required Cloud SQL/secret access. |

One national source may fail soft while another serves results, but source status must disclose the
failure. If both national sources are unavailable, NWS must not synthesize, reuse Kirkland, or
claim a complete result set.

## Deliberately not claimed

- A census of all people in the United States.
- A guarantee of 60 results for every ZIP or coordinate.
- Current physical presence, residence, or a live person location.
- Global people coverage outside the US.
- Complete USPS ZIP coverage; the geography is the 33,791-record 2025 Census ZCTA release.
- A completed observed national professional graph or nationally calibrated final score.
- Nationwide named Net Worth Score coverage. The current positive source is a partial Florida Form
  6 public-official roster; all other named profiles fail closed without a complete ledger.
- That one SEC holding, salary, company funding/revenue, fund AUM, nonprofit assets, or lifestyle
  represents a person's total net worth, liquidity, or ability to pay.
- Request-time crawling of SEC, CMS, social networks, or the open web.
- BrokerCheck integration; it remains excluded pending written terms clearance.
- Instagram, LinkedIn, Crunchbase, check-in, private-page, CAPTCHA-bypass, or data-broker sourcing.
- A distributed per-consumer quota, analyst review UI, cursor service, or completed national
  corrections/appeals workflow.
- A completed ZIP -> county -> CBSA -> state -> national expansion hierarchy. v4 currently exposes
  the upstream radius/jurisdiction steps and discloses the gap.
- CMS Open Payments as a live source, complete balance sheet, total net worth, or scoring input.
- Reuse of an existing social-scraper machine, login session, cookie, disk, SSH key, or account.

## Acceptance boundary

`60637` is the dense release-health probe. With both current national snapshots healthy, the
standard `top_n: 60` request is expected to return at least 60 public-association results. That
threshold tests deployment/source health for this release; it is not a per-ZIP API guarantee.

Production sign-off still requires the exact source SHA on `main`, green NWS CI, deployed Cloud Run
revision/traffic proof, `/health` and `/ready`, authenticated v3 and v4 `60637`/`98033`, v4 registry
version/count, consent issuance plus one successful coordinate use and replay denial, multi-region
and sparse-ZIP checks, explicit non-US checks, and response/log privacy verification.

See [US national coverage handoff](US_NATIONAL_COVERAGE_HANDOFF.md) for the operational checklist
and rollback procedure. See [NWS v4 developer handoff](NWS_V4_DEVELOPER_HANDOFF.md) for the v4
integration and source-control boundary.
