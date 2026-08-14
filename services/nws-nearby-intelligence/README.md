# NWS Nearby Intelligence Service

Standalone, privacy-safe US Net Worth Score and legacy public-professional discovery API in the
[`hushh-labs/HusshOne`](https://github.com/hushh-labs/HusshOne) monorepo. It runs independently of
the HusshOne `one` application so multiple Hushh products can integrate through their own
server-side BFF.

The financial API accepts a US ZIP/ZIP+4 or a consented coordinate and returns only eligible public
or opted-in profiles. NWS means **Net Worth Score**. “Nearby” is a public office, issuer, practice,
institution, or opt-in association; it never means residence or current physical presence.

`POST /v4/net-worth/discover` is the hardened per-project preview contract. It adds purpose-bound
access, single-use coordinate-consent receipts, evidence filters, score/rank uncertainty, and
explicit count shortfall. Use it only when `/ready` reports `v4_enabled: true`.
`POST /v3/nearby-net-worth/discover` remains the stable financial contract. The older
`POST /v2/nearby-network/discover` remains compatible and is a provisional professional-network
response; its historical `global_nws` must not be shown as Net Worth Score.

## National release

The geography layer loads the complete packaged **2025 Census Gazetteer ZCTA release: 33,791
records**. This is national query geography, not a promise that every USPS delivery ZIP exists or
that every covered ZIP has a fixed number of people.

Candidate geography is hybrid:

- `98033` and coordinates in the Kirkland market use the 60-record reviewed Kirkland release.
- Other resolved US locations query natural-person SEC Section 16 Officers/Directors with public
  issuer-office associations plus active individual CMS NPPES providers with public practice
  associations.
- Non-US or unresolved locations return an explicit empty coverage state. Kirkland people are
  never copied into another market.

The service keeps candidate coverage and financial coverage separate. Nationwide geography can
resolve a query without producing a named NWS. Current positive financial coverage is a bounded,
partial roster of Florida officials with a sworn Form 6 whole-net-worth declaration. Other nearby
profiles return `FINANCIAL_COVERAGE_INSUFFICIENT` until a complete attributable asset-and-liability
ledger exists. SEC holdings, Form D, compensation, AUM, company revenue, and funding are not total
personal net worth.

## Requests

All discovery routes require `X-NWS-API-Key` from a trusted server-side caller. v4 uses a distinct
key and allowlisted policy for each project; v2/v3 retain the legacy shared-key contract.
`GET /health` and `GET /ready` are public; OpenAPI is at `/docs` and `/openapi.json`.

New v4 integrations should start with the [v4 developer handoff](docs/NWS_V4_DEVELOPER_HANDOFF.md).
Its request is intentionally stricter than the compact v3 examples below: result count is exactly
100, 150, or 200, caller context is required, and coordinates need a single-use receipt from
`POST /v4/location-consent/receipt`.

US ZIP and ZIP+4 are accepted with or without `country_code: "US"`; ZIP+4 is searched by its
five-digit Census ZCTA base:

```json
{"query":{"postal_code":"60637"},"top_n":60}
```

```json
{"query":{"postal_code":"60637-1234","country_code":"US"},"top_n":60}
```

For a consented coordinate, send explicit country context when available:

```json
{
  "query": {
    "latitude": 41.782504,
    "longitude": -87.602734,
    "country_code": "US"
  },
  "top_n": 60
}
```

Coordinates are rounded to two decimals before coverage lookup and retrieval. If country is
omitted, US context is inferred from the packaged 2025 Census state/territory boundary. The service
tests the represented coarsened cell at coastlines so rounding cannot move an onshore coordinate
just offshore; that inference is labeled approximate. An explicit non-US country always stays out
of the US source fan-out.

Every `200` response includes coverage:

| Status | Meaning |
| --- | --- |
| `COVERED` | The reviewed Kirkland backend or US national source fan-out was selected. Results may still be sparse. |
| `LOCATION_UNRESOLVED` | Postal syntax was accepted but the ZIP is absent from canonical packaged geography. No fallback is used. |
| `NOT_COVERED` | The coordinate is non-US or country context could not be established. No people are selected. |

## Net Worth Score contract

The engine estimates:

```text
cash + public securities + private-business equity + real-estate equity
+ other supported assets - liabilities
```

Every component requires attributable evidence, all unknown categories remain unknown, and
liabilities are mandatory. The dollar range is primary. Its median maps to a versioned fixed
national 0–100 logarithmic scale; confidence remains separate and never multiplies NWS. A sworn
whole total is already net of liabilities and is never added to itemized assets.

See [Net Worth Score handoff](docs/NET_WORTH_SCORE_HANDOFF.md) for the full API, source, edge-case,
privacy, test, and operational contract.

## Privacy and source boundary

The public response omits raw/exact person coordinates, private residence, street or mailing
address, phone/email, family graph, raw source documents, and filing schedules. v4 adds a hashed
actor reference, uncertainty/shortfall, and source host families while retaining only the
public-safe projection. v3 contains the allowed derived estimate, NWS, component statuses/ranges,
confidence, public-jurisdiction relationship, freshness, and official citations. v2 remains
`financial_context: NOT_PROFILED`.

SEC selection uses a value-free professional ordering and excludes owner-only/legal-entity
records. NPPES is read through fixed, least-privilege Cloud SQL functions over active individual
public-practice facts; the runtime role cannot query the underlying provider/ZIP tables or
inspection view.
BrokerCheck is excluded pending written terms clearance.

## Integration and CORS

Wildcard non-cookie CORS prevents origin allowlist friction across projects, but a browser-exposed
API key is public. Keep each project's NWS key in its BFF/server secret store. Never place it in
`NEXT_PUBLIC_*`, client JavaScript, a mobile bundle, source control, logs, or DevTools. SSH keys,
scraper sessions, and VM credentials are not API credentials.

Consumer UI must branch on `coverage.status`, preserve public-association/freshness language, and
never label results as people physically around the user. It must also distinguish no candidates,
insufficient financial evidence, and a source outage.

## Local development

Requires Python 3.13.

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080
```

The protected NWS workflow runs a production path-scoped Ruff gate. Reproduce the exact command
from [NWS Nearby CI](../../.github/workflows/nws-nearby-ci.yml); a repository-wide
`ruff check app tests` is not the release gate for the separate experimental modules.

Copy `.env.example` only for local development. Never commit a real API or database credential.

## Developer handoff

- [NWS v4 developer handoff](docs/NWS_V4_DEVELOPER_HANDOFF.md) — per-project access, ZIP and
  consented-coordinate requests, filters, source plane, operations, and limits.
- [Net Worth Score handoff](docs/NET_WORTH_SCORE_HANDOFF.md) — canonical financial model, v3 API,
  source eligibility, edge cases, and rollout boundary.
- [US national coverage handoff](docs/US_NATIONAL_COVERAGE_HANDOFF.md) — legacy v2 candidate-source,
  infrastructure, freshness, test, acceptance, and rollback guide.
- [End-to-end technical handoff](docs/END_TO_END_TECHNICAL_HANDOFF.md)
- [API contract](docs/API_CONTRACT.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Kirkland 98033 reviewed source release](docs/KIRKLAND_98033_SOURCE_RELEASE.md)
- [Financial context boundary](docs/FINANCIAL_CONTEXT_BOUNDARY.md)
- [Organization discovery O1](docs/ORGANIZATION_DISCOVERY_O1.md)
- [Production handoff](docs/PRODUCTION_HANDOFF.md)
- [Architecture roadmap](ARCHITECTURE.md)
- [Source catalog](docs/SCRAPER_CATALOG.md)
