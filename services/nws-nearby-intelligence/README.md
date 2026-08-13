# NWS Nearby Intelligence Service

Standalone, privacy-safe US public-professional discovery API in the
[`hushh-labs/HusshOne`](https://github.com/hushh-labs/HusshOne) monorepo. It runs independently of
the HusshOne `one` application so multiple Hushh products can integrate through their own
server-side BFF.

The API accepts a consented coordinate or US ZIP and returns ranked public professional
associations. “Nearby” means relevance to a public issuer office, public practice area,
institution, civic office, or other reviewed public association. It never means current physical
presence or residence.

## National release

The geography layer loads the complete packaged **2025 Census Gazetteer ZCTA release: 33,791
records**. This is national query geography, not a promise that every USPS delivery ZIP exists or
that every covered ZIP has a fixed number of people.

The candidate path is hybrid:

- `98033` and coordinates in the Kirkland market use the 60-record reviewed Kirkland release.
- Other resolved US locations query natural-person SEC Section 16 Officers/Directors with public
  issuer-office associations plus active individual CMS NPPES providers with public practice
  associations.
- Non-US or unresolved locations return an explicit empty coverage state. Kirkland people are
  never copied into another market.

The national sources are queried live over current source snapshots. This is not request-time web
crawling or a real-time person-location system. Every response remains `complete: false`, and a
covered sparse ZIP may correctly return fewer results or zero.

## Requests

`POST /v2/nearby-network/discover` requires `X-NWS-API-Key` from a trusted server-side caller.
`GET /health` and `GET /ready` are public; OpenAPI is at `/docs` and `/openapi.json`.

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

## Privacy and source boundary

The public response omits raw/exact person coordinates, private residence, street or mailing
address, phone/email, family graph, raw source documents, securities, shares, market/disclosed
value, liquidity, property, income, and inferred net worth. `financial_context` is explicitly
`NOT_PROFILED`.

SEC selection uses a value-free professional ordering and excludes owner-only/legal-entity
records. NPPES is read through a least-privilege Cloud SQL view containing active individual
public-practice facts; the runtime role has no access to the underlying address/phone/raw table.
BrokerCheck is excluded pending written terms clearance.

## Integration and CORS

Wildcard non-cookie CORS prevents origin allowlist friction across projects, but a browser-exposed
API key is public. Keep `NWS_API_KEY` in each consumer's BFF/server secret store. Never place it in
`NEXT_PUBLIC_*`, client JavaScript, a mobile bundle, source control, logs, or DevTools.

Consumer UI must branch on `coverage.status`, preserve public-association/freshness language, and
never label results as people physically around the user.

## Local development

Requires Python 3.13.

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/python -m ruff check app tests
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Copy `.env.example` only for local development. Never commit a real API or database credential.

## Developer handoff

- [US national coverage handoff](docs/US_NATIONAL_COVERAGE_HANDOFF.md) — canonical source,
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
