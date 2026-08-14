# Implementation status

> This file describes the national release implemented in source. A merged SHA, green CI, Cloud
> Run revision, active traffic, live source health, and consumer integration are separate proof
> layers; revalidate them from the production handoff rather than treating this file as live state.

## Implemented national release

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

### Reviewed market compatibility

- Existing 60-record Kirkland public-association release and manifest hashes.
- Existing 13-organization review-only anchor release.
- Candidate citations, source-family counts, evidence flags, and revalidation fields.
- Separate national model/data disclosure so national candidates are not presented as manually
  reviewed Kirkland records.

### API, ranking, and privacy

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

## Acceptance boundary

`60637` is the dense release-health probe. With both current national snapshots healthy, the
standard `top_n: 60` request is expected to return at least 60 public-association results. That
threshold tests deployment/source health for this release; it is not a per-ZIP API guarantee.

Production sign-off still requires the exact source SHA on `main`, green NWS CI, deployed Cloud Run
revision/traffic proof, `/health` and `/ready`, authenticated `60637` and `98033`, multi-region and
sparse-ZIP checks, explicit non-US checks, and response/log privacy verification.

See [US national coverage handoff](US_NATIONAL_COVERAGE_HANDOFF.md) for the operational checklist
and rollback procedure.
