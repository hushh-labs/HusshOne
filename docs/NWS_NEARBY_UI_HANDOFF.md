# NWS nearby UI handoff

## Meaning and boundary

NWS means **Net Worth Score**. It is a 0–100 national log-scale representation of an estimated
total net-worth range derived from supported public financial evidence. Confidence is separate.

Location has one job: choose the public candidate pool or public jurisdiction searched. It never
raises, lowers, or otherwise affects NWS. A location relationship is a public-office or public
professional association, not a residence, live location, or claim of physical presence.

Missing evidence is unavailable, never zero. A person is returned only when the service has enough
public evidence to publish an estimate. Nearby candidates without enough evidence are accounted for
in `financial_coverage`; they do not receive zero-dollar estimates or zero scores.

## Surfaces

| Surface | Purpose |
| --- | --- |
| `/nearby` | Quiet ZIP/device-location UI for nearby public financial disclosures. |
| `POST /api/nws/nearby` | Same-origin server boundary. Validates the request, adds the server-held key, and returns the strict curated contract. |
| `POST /v3/nearby-net-worth/discover` | Authenticated FastAPI endpoint used by trusted server integrations. |

The UI copy is intentionally short:

- Headline: `Net worth nearby`
- Support: `Verified public financial disclosures.`
- Primary action: `Find people`
- Secondary action: `Use location`
- Privacy: `Approximate location. Public filings only.`

## Request contract

```json
{
  "query": { "postal_code": "32301", "country_code": "US" },
  "top_n": 100,
  "initial_radius_km": 20,
  "max_radius_km": 100,
  "auto_expand": true
}
```

Coordinates use the same endpoint:

```json
{
  "query": { "latitude": 30.44, "longitude": -84.28 },
  "top_n": 100,
  "initial_radius_km": 20,
  "max_radius_km": 100,
  "auto_expand": true
}
```

Rules:

- Send exactly one location form: `postal_code`, or both `latitude` and `longitude`.
- US ZIP and ZIP+4 are accepted. Client coordinates are rounded to two decimals.
- `top_n` is `1..200`; initial radius is `>0..250`; maximum radius is `>0..500` and cannot
  be lower than the initial radius.
- Unknown keys, partial or mixed coordinates, legacy professional-network filters, stringified
  numbers/booleans, and malformed input fail closed.

## Curated response contract

`NearbyClientResponseSchema` mirrors the v3 public response and permits only:

- `query`
- `coverage`
- `snapshot`
- `financial_coverage`
- `result_set`
- `search`
- `source_status`
- `generated_at`
- `results`

The snapshot must identify `score_kind: NET_WORTH_SCORE` and carries independent scale/model
versions, as-of date, completeness, and semantics. Financial coverage reports discovered,
evaluated, unevaluated, scored, and insufficient-evidence counts. `candidate_count` remains the
discovered-count compatibility field. Search declares whether it ran and whether it used
`NOT_SEARCHED`, `ASSOCIATION_RADIUS`, or `PUBLIC_JURISDICTION` scope.

Each result permits only:

- rank and public person identity/headline/organization;
- profile status;
- estimated net-worth p10/median/p90 range, method, currency, and as-of date;
- NWS value and scale version;
- confidence score and grade, separately from balance-sheet or declared-total coverage and NWS;
- six financial component states;
- liquid-wealth range and separately calibrated liquidity score when available;
- coarse public jurisdiction/association relationship;
- last financial update; and
- explicit financial-update precision (`DAY` or `YEAR`); and
- bounded HTTPS public citations.

Every nested object is strict. Unknown fields cause the BFF curation step to fail rather than being
forwarded. Coordinates, exact distances, street or home addresses, phone numbers, email addresses,
contact enrichment, private data, and raw source rows are not browser fields.

## Component truthfulness

The component keys are:

1. `cash_and_near_cash`
2. `public_securities`
3. `private_business_equity`
4. `real_estate_equity`
5. `other_assets`
6. `liabilities`

`SUPPORTED` and `MODELED_RANGE` require an ordered range and confidence. `UNKNOWN`,
`NOT_PROVIDED`, `NOT_APPLICABLE`, and `INCLUDED_IN_DECLARED_TOTAL` require null amounts and null
confidence.

For a whole declared total, `method` is `DECLARED_TOTAL_SIMULATION`. All six components must say
`INCLUDED_IN_DECLARED_TOTAL`; the UI renders `Included, not itemized`. It also states that the
disclosed total was not decomposed. The six categories must never receive invented allocations or
appear individually verified from a whole total.

Annual disclosures preserve year-only dates such as `2025`. The response marks them with
`financial_update_precision: YEAR`, and the UI renders `2025`; it must not invent `2025-01-01`.
Day-precision records require `YYYY-MM-DD` and use `financial_update_precision: DAY`. The BFF also
rejects score/scale drift, a last update that is not the newest citation, inconsistent coverage counts,
and declared-total responses that imply a range, itemization, or liquidity.

## UI state priority

| Condition | UI state |
| --- | --- |
| `coverage.status: NOT_COVERED` | `Location not covered` |
| `coverage.status: LOCATION_UNRESOLVED` | `Location unresolved` |
| financial-evidence source `UNAVAILABLE` | `Financial source unavailable`; this outranks candidate-count empty states |
| covered with `candidate_count: 0` | `No public candidates nearby` |
| candidates exist with `FINANCIAL_COVERAGE_INSUFFICIENT` | `Financial evidence unavailable` plus the nearby candidate count |
| `financial_coverage.status: PARTIAL` | Results remain visible with the insufficient-evidence count |
| financial-evidence source `EMPTY` | Valid searched state; not treated as an outage |
| HTTP `429` | `Too many searches` |
| upstream timeout / HTTP `504` | `Search timed out` |
| service/source failure / HTTP `503` | `Source unavailable` |
| geolocation denied or unavailable | ZIP fallback without an API request |

Positive rows show the person, public office/headline, estimated net-worth range, NWS, confidence,
public jurisdiction relationship, and update date. Details reveal the six components, liquidity,
and public citations.

## Security and privacy

- `NWS_NEARBY_API_KEY` remains server-side and must never use a `NEXT_PUBLIC_` name.
- The browser calls only the same-origin BFF. The BFF uses a fixed upstream and sends `no-store`.
- The request contains a query location, never a person, address, contact, or private record.
- The response may describe a coarse public jurisdiction relationship only. Never render exact
  coordinates, exact person distance, street/home address, phone, email, or contact/private data.
- Source URLs are limited to HTTPS and open with `noopener noreferrer`.

## Focused verification

```bash
npx vitest run src/lib/nws/contracts.test.ts src/app/nearby/NearbyPeople.test.tsx
npx eslint src/lib/nws/contracts.ts src/lib/nws/contracts.test.ts \
  src/app/nearby/page.tsx src/app/nearby/NearbyPeople.tsx \
  src/app/nearby/NearbyPeople.test.tsx src/app/nearby/error.tsx
npx tsc --noEmit
```

## Production cutover

Deploy the API before the UI. The independent production surfaces are:

| Surface | Target |
| --- | --- |
| NWS API | `hushh-tech-prod/us-central1/nws-nearby-intelligence` |
| One UI/BFF | `hushone-app/us-central1/one` at `https://intelligence.hushh.ai` |

The One runtime needs `NWS_NEARBY_API_KEY` as a server-only, numbered cross-project Secret Manager
reference to `hushh-tech-prod/nws-nearby-api-key`. Grant `roles/secretmanager.secretAccessor` only
on that secret to the active One runtime service account. Do not copy the value into GitHub, source,
`NEXT_PUBLIC_*`, or a second secret.

Acceptance order:

1. Promote and verify the NWS candidate revision, including authenticated Florida v3,
   nationwide-insufficient, non-US, and legacy v2 probes.
2. Bind the pinned NWS key to One and deploy the root app without changing unrelated secrets.
3. Verify `GET https://intelligence.hushh.ai/nearby` is `200`.
4. Verify same-origin `POST /api/nws/nearby` returns the curated Miami-Dade partial result, a
   truthful financially-insufficient non-Florida state, and no raw coordinates/contact/private
   fields.
5. Inspect Cloud Run traffic and keep the prior API and UI revisions available for rollback.

These checks prove source behavior only. Merge, CI, deployed revision/traffic, live route probes,
and real-browser/device behavior remain separate release evidence.
