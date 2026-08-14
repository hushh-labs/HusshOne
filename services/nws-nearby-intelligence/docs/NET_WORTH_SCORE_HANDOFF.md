# Net Worth Score technical handoff

Status date: 2026-08-14. This is the integration and operations contract for the true Net Worth
Score route. It does not rename the legacy professional-network score.

## Contract in one minute

| Item | Contract |
| --- | --- |
| True NWS route | `POST /v3/nearby-net-worth/discover` |
| Legacy compatibility route | `POST /v2/nearby-network/discover` |
| Authentication | Server-held `X-NWS-API-Key`; never ship it in browser or mobile code |
| Location input | Exactly one of US ZIP/ZIP+4 or latitude plus longitude |
| NWS meaning | Net Worth Score, calculated from estimated total personal net worth |
| Ranking | Location selects the eligible pool; median net worth determines order |
| Completeness | Always `false`; coverage is not a census |

The v3 request model is strict. Unknown fields, mixed ZIP-and-coordinate input, professional lane
filters, diversity controls, stringified numbers, and invalid radii return `422`. `top_n` is 1-200;
`max_radius_km` must be at least `initial_radius_km`.

The v2 route remains available for existing consumers. It discovers public professional
associations and returns its legacy professional score. A v2 score is **not financial net worth**
and must never be displayed as v3 NWS.

## NWS model

For a component-led profile:

```text
estimated net worth =
  cash and near cash
  + public securities
  + private-business equity
  + real-estate equity
  + other supported personal assets
  - supported personal liabilities
```

Version `net-worth-v1.0.0` samples bounded input ranges and returns p10, median, and p90. Version
`nws-fixed-us-log-v1.0.0` maps the median to a location-independent score:

```text
NWS = clamp(round((log10(median USD) - 4) * 100 / 6), 0, 100)
```

| Median net worth | NWS |
| ---: | ---: |
| $10,000 or less | 0 |
| $100,000 | 17 |
| $1 million | 33 |
| $10 million | 50 |
| $100 million | 67 |
| $1 billion | 83 |
| $10 billion or more | 100 |

Negative and zero net worth are valid and score 0. Evidence confidence is reported separately; it
never multiplies or changes NWS. Distance also never raises NWS.

## Requests

ZIP and ZIP+4 use the five-digit Census ZCTA base:

```http
POST /v3/nearby-net-worth/discover
Content-Type: application/json
X-NWS-API-Key: <server-held value>

{
  "query": {"postal_code": "33130", "country_code": "US"},
  "top_n": 25,
  "initial_radius_km": 20,
  "max_radius_km": 100,
  "auto_expand": true
}
```

Real-time location uses coordinates:

```json
{
  "query": {
    "latitude": 25.7617,
    "longitude": -80.1918,
    "country_code": "US"
  },
  "top_n": 25
}
```

The packaged 2025 Census geography resolves 33,791 ZCTAs. That is location resolution, **not
universal named-person NWS coverage**. A ZCTA is statistical geography, not a USPS boundary or a
residence. Unknown US ZCTAs return `LOCATION_UNRESOLVED`; non-US queries are accepted but currently
return `NOT_COVERED`/`NOT_SEARCHED`, not invented US results.

## Location semantics

| Query | Current behavior |
| --- | --- |
| US ZIP/ZIP+4 | Resolve the exact five-digit ZCTA internal point. Never substitute a nearby ZIP. |
| US coordinate | Quantize for normal discovery; do not return or log the raw coordinate. |
| Florida ZIP | Map the ZCTA to its largest-overlap 2020 Census county, explicitly as approximate. |
| Florida coordinate | Use the nearest packaged ZCTA only within 10 km, then its primary county. |
| Other covered US location | Build a public-association candidate pool within the requested radius. |

Florida results describe a `PUBLIC_SERVICE_JURISDICTION`, not residence or physical presence. The
current adapter queries the Form 6 public-office index with the resolved county name because many
source rows lack a county field. Radius values are echoed for contract consistency, but this direct
path reports `search.scope=PUBLIC_JURISDICTION` and does not distance-rank filers.

## Response and coverage states

Every `200` must be interpreted through all four layers:

| Layer | States | Meaning |
| --- | --- | --- |
| `coverage.status` | `COVERED`, `NOT_COVERED`, `LOCATION_UNRESOLVED` | Can the service resolve and route the location? |
| `financial_coverage.status` | `AVAILABLE`, `PARTIAL`, `FINANCIAL_COVERAGE_INSUFFICIENT`, `NOT_SEARCHED` | How many location candidates have publishable financial evidence? |
| `result_set.status` | `TARGET_MET`, `PARTIAL`, `EMPTY`, `NOT_SEARCHED` | Did the response meet `top_n`? |
| `source_status[].status` | `OK`, `EMPTY`, `UNAVAILABLE`, `NOT_QUERIED` | Did each candidate or financial source answer? |

`COVERED` alone does not promise a named NWS result. A normal nationwide response today can be
`COVERED` plus `FINANCIAL_COVERAGE_INSUFFICIENT`, with `results: []`.

A published result contains:

| Field | Meaning |
| --- | --- |
| `person` | Stable public ID, name, public role headline, and optional organization |
| `estimated_net_worth` | USD p10/median/p90, method, and financial as-of date |
| `nws` | Fixed 0-100 score and scale version |
| `confidence` | Separate evidence grade and coverage |
| `components` | Six asset/liability coverage blocks; unknowns are explicit |
| `liquid_wealth` / `liquidity_score` | Returned only when supported; otherwise `UNKNOWN`/`null` |
| `location_relationship` | Public association and its approximation note |
| `sources` | Publisher, official URL, supported fact types, source date, retrieval time |

Results are sorted by median net worth, then p10, coverage, freshness, location confidence, and
stable ID. Professional score and distance are not financial tie breakers.

## Florida Form 6 direct path

The current positive whole-net-worth source is the [Florida Commission on Ethics Form 6 public
search](https://disclosure.floridaethics.gov/PublicSearch/Filings). The internal provider calls the
bounded `/v1/net-worth` adapter server-to-server over HTTPS with bearer authentication, timeout,
short cache, no redirects, an origin allowlist, and at most two 50-row pages by default.
The direct Florida path therefore returns at most 100 records even when `top_n` is larger and marks
any remaining source rows as truncated.

Only these person fields cross the adapter boundary: public name, public office/jurisdiction,
`formYear`, signed whole declared `netWorth`, and official filing URL. Stable IDs are derived from
the filing URL. Unknown fields are discarded. Asset, liability, income, address, and contact
schedules are neither copied nor exposed.

Form 6's declared number is already total assets minus liabilities. Therefore:

- all six component blocks return `INCLUDED_IN_DECLARED_TOTAL`, without itemized amounts;
- liabilities are included, but are not separately disclosed;
- liquid wealth remains `UNKNOWN` and `liquidity_score` remains `null`;
- the declared total cannot be added to any component ledger; doing so raises a double-count risk;
- negative and zero declarations remain valid; a missing number never becomes zero;
- year-only provenance is represented conservatively as January 1 of `formYear`.

The repository's current source snapshot was built on 2026-08-11 for form year 2025 and contains
120 readable declarations from 120 inspected filings. It is marked `partial=true`. Treat every
current Florida response as partial coverage and inspect `SOURCE_INDEX_PARTIAL`; it is not a full
state roster.

## Nationwide versus financial coverage

The service can resolve nationwide US location queries and can build public candidate pools from
SEC Section 16 officer/director associations and CMS NPPES public practice associations. Those are
candidate-discovery sources only. Outside the direct Florida path, the current
`NET_WORTH_LEDGER` provider fails closed with `NO_ELIGIBLE_FINANCIAL_LEDGER_CONFIGURED`.

Consequently, nationwide candidate coverage is broader than financial coverage. The 33,791-ZCTA
index, a 60-person professional response, or an SEC holding does not imply 33,791 ZIPs with named
NWS results. **SEC holdings are not net worth**: a reported stake is one interest in one issuer and
does not establish cash, other assets, or liabilities.

## Source policy

| Source | Current use | Financial rule |
| --- | --- | --- |
| [Florida Form 6](https://disclosure.floridaethics.gov/PublicSearch/Filings) | Live adapter, partial roster | Whole signed declared total; do not add components |
| [SEC insider datasets](https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets) | Nationwide professional candidates | Holdings alone are never total wealth |
| [CMS NPI Registry](https://npiregistry.cms.hhs.gov/) | Nationwide professional candidates | Practice identity/location is not financial evidence |
| [Census 2025 ZCTA Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip) | Location resolution | No person or wealth inference |
| [Census 2020 ZCTA-county relationship](https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt) | Approximate public jurisdiction | Never a residence claim |
| OGE public financial disclosures | Engine-supported, provider not wired | Future only; ranges and liabilities must be bounded |
| SEC Forms 3/4/5, 13D/13G, proxy, S-1, annual report plus market price | Engine-supported components, not wired | Ownership and value may support one interest, never a total by themselves |
| Official ownership, private valuation, property recorder/assessment, arm's-length sale, FHFA HPI | Engine-supported components, not wired | Requires identity, ownership, valuation, debt, coverage, and privacy review |
| Opt-in verified balance sheet | Engine-supported, not wired | May publish only within the user's consent and verification scope |
| Form D, company funding/revenue, fund AUM, IRS 990/nonprofit assets | Forbidden for personal amount | Discovery/context only |
| Compensation, salary, lifestyle, social posts, follower counts | Forbidden for personal amount | Never infer net worth |

No source is enabled merely because it is public or scrapeable. New providers need authority and
terms review, field allowlists, bounded acquisition, identity tests, freshness, retention,
schema-drift quarantine, privacy review, and a kill switch.

## Liabilities, unknowns, and deduplication

The component-led engine publishes nothing unless liabilities start from person-attributable
liability evidence. A model policy may widen that supported range, but cannot invent debt for a
named person. Every asset category must be `VERIFIED`, `PARTIAL`, `MODELED`, or a supported
`NOT_APPLICABLE`; `UNKNOWN` and unsupported `NOT_APPLICABLE` fail closed.

Each component carries a stable `economic_interest_id`. Duplicate representations keep the newest,
strongest supported fact once. Reusing one evidence fact across different interests, representing
one interest as both asset and liability, or subtracting a debt already netted into an asset raises
`DoubleCountRiskError`. A whole declared total is mutually exclusive with every itemized component.

Private people without adequate verified public or opt-in evidence receive no NWS and the internal
reason `Not enough verified public financial information.`

## Privacy, security, and BFF integration

Use a project BFF/server route:

```text
browser or mobile app -> project BFF -> NWS Cloud Run service -> approved source
```

The service permits wildcard non-cookie CORS (`*`, no credentials) so projects do not need origin
whitelisting. That is not permission to expose the API key. Store the key only in the BFF/runtime
secret manager, call NWS server-to-server, and return the curated v3 response. There is no SSH key,
persistent VM login, or client-side credential in this design.

The runtime enforces request-size limits, constant-time key comparison, per-instance rate limits,
`Cache-Control: no-store`, security headers, and route/status/latency-only request logs. Do not log
request bodies, raw coordinates, source credentials, source payloads, filing schedules, addresses,
phones, or emails.

## Local verification

```bash
cd services/nws-nearby-intelligence
python -m pip install --require-hashes -r requirements.dev.lock
python -m pytest -q
python -m ruff check app/net_worth.py app/florida_net_worth.py app/jurisdiction.py \
  tests/test_net_worth.py tests/test_florida_net_worth.py \
  tests/test_jurisdiction.py tests/test_net_worth_api.py
python -m mypy app/net_worth.py app/florida_net_worth.py app/jurisdiction.py
python -m compileall -q app tests
uvicorn app.main:app --port 8080
```

Focused tests must prove fixed anchors, confidence separation, liability gating, source-purpose
allowlists, deduplication, declared-total exclusivity, negative/zero handling, missing-value failure,
malicious-field omission, partial-index disclosure, strict v3 input, Florida ZIP and coordinate
routing, and no fuzzy join to the professional pool.

## Deployment and live acceptance

Deployment is Cloud Run `nws-nearby-intelligence` in `hushh-tech-prod/us-central1`. The workflow
builds an immutable image, deploys a zero-traffic candidate, probes it, promotes it to 100%, and
retains the previous revision for rollback.

The workflow now includes the new modules/tests in its explicit Ruff gate and probes one positive
Florida v3 result before and after traffic promotion. Operators should also run the following
extended checks against both the candidate URL and final service URL. Supply `SERVICE_URL` and
`NWS_API_KEY` through the approved operator shell; never paste their values into tickets or docs.

```bash
curl --fail-with-body "$SERVICE_URL/health" | jq -e '.status == "ok"'
curl --fail-with-body "$SERVICE_URL/ready" \
  | jq -e '
      .status == "ok" and
      .geography_record_count == 33791 and
      .public_jurisdiction_record_count == 33791 and
      .form6_source_enabled == true and
      .net_worth_model_version == "net-worth-v1.0.0" and
      .nws_scale_version == "nws-fixed-us-log-v1.0.0" and
      .complete == false'

test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"postal_code":"33130"}}' \
  "$SERVICE_URL/v3/nearby-net-worth/discover")" = 401

FLORIDA="$(curl --fail-with-body -H 'Content-Type: application/json' \
  -H "X-NWS-API-Key: $NWS_API_KEY" \
  -d '{"query":{"postal_code":"33130","country_code":"US"},"top_n":10}' \
  "$SERVICE_URL/v3/nearby-net-worth/discover")"
jq -e '
  .snapshot.score_kind == "NET_WORTH_SCORE" and
  .search.scope == "PUBLIC_JURISDICTION" and
  .coverage.complete == false and
  (.results | length) > 0 and
  all(.results[];
    .nws.status == "AVAILABLE" and
    .components.liabilities.status == "INCLUDED_IN_DECLARED_TOTAL" and
    .liquid_wealth.status == "UNKNOWN") and
  any(.source_status[];
    .source == "FLORIDA_FORM_6_DECLARED_TOTALS" and .status == "OK")
' <<<"$FLORIDA"

NATIONWIDE="$(curl --fail-with-body -H 'Content-Type: application/json' \
  -H "X-NWS-API-Key: $NWS_API_KEY" \
  -d '{"query":{"postal_code":"60637","country_code":"US"},"top_n":10}' \
  "$SERVICE_URL/v3/nearby-net-worth/discover")"
jq -e '
  .coverage.status == "COVERED" and
  .financial_coverage.status == "FINANCIAL_COVERAGE_INSUFFICIENT" and
  (.results | length) == 0 and
  any(.source_status[];
    .source == "NET_WORTH_LEDGER" and .status == "EMPTY")
' <<<"$NATIONWIDE"

NON_US="$(curl --fail-with-body -H 'Content-Type: application/json' \
  -H "X-NWS-API-Key: $NWS_API_KEY" \
  -d '{"query":{"latitude":28.6139,"longitude":77.209,"country_code":"IN"}}' \
  "$SERVICE_URL/v3/nearby-net-worth/discover")"
jq -e '
  .coverage.status == "NOT_COVERED" and
  .financial_coverage.status == "NOT_SEARCHED" and
  .search.performed == false and
  (.results | length) == 0
' <<<"$NON_US"
```

Also retain the existing authenticated v2 probes for `60637` and reviewed `98033`, verify wildcard
preflight without credential support, inspect response/log samples for prohibited fields, and prove
that the promoted revision has 100% traffic. Repository code or a green local test is not live proof.

## Operational source status

| Source status | Operator action |
| --- | --- |
| Florida `OK` plus `SOURCE_INDEX_PARTIAL` | Serve scored declarations but label financial coverage `PARTIAL`. |
| Florida `EMPTY` | Return no declarations; do not fill from SEC holdings or another county. |
| Florida `UNAVAILABLE` | Return explicit source failure and no NWS; investigate auth, timeout, schema, or index build. |
| `NET_WORTH_LEDGER=EMPTY` | Expected outside Florida until an approved provider is wired. |
| SEC/NPPES candidate source degraded | Preserve source status; never convert candidate facts to financial evidence. |

`/ready` validates the packaged geography and service boot contract; it does not prove the Florida,
SEC, or NPPES source is healthy. Live business probes and `source_status` are required after every
deploy and source refresh.

## Failure and rollback

- Source schema or attribution drift fails closed as `UNAVAILABLE`; no partially mapped people are
  published.
- A missing declaration is never coerced to zero, and a future form year is not published.
- If all national candidate backends are unavailable, the radius path returns `503` with
  `NATIONAL_CANDIDATE_BACKEND_UNAVAILABLE`.
- Resolved but financially unsupported locations return a truthful empty `200`; clients should show
  “Not enough verified public financial information,” not retry as a different ZIP.
- Never recover counts by widening privacy rules, mixing v2 scores into v3, using a neighboring
  market, or treating SEC holdings as total wealth.

If a promoted revision fails acceptance, return all traffic to the last verified revision:

```bash
gcloud run services update-traffic nws-nearby-intelligence \
  --project=hushh-tech-prod \
  --region=us-central1 \
  --to-revisions=<known-good-revision>=100
```

Re-run revision/traffic, `/health`, `/ready`, authentication, v2 compatibility, v3 Florida,
nationwide-insufficient, non-US, CORS, and privacy probes. A rollback restores code only; continue to
report an upstream source failure as `UNAVAILABLE`.

## Implementation map

| Concern | File |
| --- | --- |
| v3/v2 HTTP contract and routing | `app/main.py` |
| Net-worth ledger, simulation, anchors, evidence policy | `app/net_worth.py` |
| Florida Form 6 privacy/source adapter | `app/florida_net_worth.py` |
| ZCTA-to-primary-county public jurisdiction | `app/jurisdiction.py` |
| National ZCTA resolution | `app/postal.py` |
| API and direct-path tests | `tests/test_net_worth_api.py` |
| Engine safety tests | `tests/test_net_worth.py` |
| Adapter boundary tests | `tests/test_florida_net_worth.py` |
