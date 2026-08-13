# NWS Nearby Intelligence Service

This is a standalone, privacy-safe Cloud Run API whose source lives in
[`hushh-labs/HusshOne`](https://github.com/hushh-labs/HusshOne) at
`services/nws-nearby-intelligence/`. It is deliberately independent of the HusshOne `one` web
application so any Hushh project can integrate it through its own server route.

The service accepts a location query and returns only approved public-professional or opted-in
profiles associated with public organizations, institutions, civic offices, or opt-in locations.
It never exposes a private residence, a person's exact location, physical presence, or inferred
financial net worth.

## Location inputs and coverage behavior

Use a consented device coordinate whenever a user grants location access. The service rounds it to
two decimals before retrieval and never puts the raw coordinate in application logs.

```json
{
  "query": {
    "latitude": 47.6715,
    "longitude": -122.2133,
    "country_code": "US"
  },
  "top_n": 100
}
```

The service also accepts postal input. Send an ISO-3166 alpha-2 country code with every postal
code except the legacy US bootstrap request `{"postal_code":"98033"}`.

```json
{"query": {"postal_code": "110001", "country_code": "IN"}}
```

Every successful request includes `coverage`:

| Status | Meaning | Results |
| --- | --- | --- |
| `COVERED` | An approved market dataset and query geography are loaded. | Ranked public-association records. |
| `NOT_COVERED` | The coordinate is valid, but there is no approved market dataset there. | Empty; no fallback market is used. |
| `LOCATION_UNRESOLVED` | The postal input is valid but absent from the canonical postal-geography index. | Empty; no guessed centroid is used. |

The current approved data is the Kirkland, Washington reviewed market release: 60
public-association records for US postal code `98033`. The coordinate `47.6715, -122.2133` is
inside that market. A globally valid coordinate or postal code is therefore handled safely today,
but it does **not** imply worldwide people coverage. New markets need approved geography plus
reviewed public-association data before `COVERED` can be returned. See the
[Kirkland 98033 source release](docs/KIRKLAND_98033_SOURCE_RELEASE.md) for the exact source
families, release hash, refresh requirements, and safe expansion process.

## Organization-first discovery

The service now has an O1 organization-anchor intake foundation: a reviewed
organization/page scope can create a **human-review proposal**, but it cannot
write people directly into NWS or the active market release. The current
Kirkland anchor release contains 13 organizations that support the reviewed
60-record release; it is not a completed census. See
[Organization Discovery O1](docs/ORGANIZATION_DISCOVERY_O1.md).

## Financial-data boundary

NWS does not create or rank personal financial strength, net worth, property,
compensation, assets, or liquidity. A response includes an explicit
`financial_context: NOT_PROFILED` boundary, and the public `capital_access`
component remains a professional-relationship signal only. See
[Financial Context Boundary](docs/FINANCIAL_CONTEXT_BOUNDARY.md).

## API

`POST /v2/nearby-network/discover` requires `X-NWS-API-Key` from a trusted server-side caller.
`GET /health` and `GET /ready` are public. Interactive OpenAPI documentation is at `/docs`.
Former `/v1/*` and `/internal/*` routes return `404`.

The service deliberately allows non-cookie wildcard CORS for `POST` and `OPTIONS` so consuming
projects do not need an origin allowlist. CORS does **not** make an API key safe in browser or
mobile-client code. Each consumer must call through its BFF/server route and keep the key in that
project's secret store. Do not put it in `NEXT_PUBLIC_*`, a mobile bundle, source code, or DevTools.

## Product user story

1. A user grants location access. Their app's BFF sends the coarse coordinate, optionally with its
   country context.
2. The API returns public-association results only if that coarse point is in an approved market.
3. If location access is unavailable, the user can enter postal code and country instead.
4. Any valid non-covered or unresolved location receives a normal `200` response with explicit
   coverage status and an empty result set, allowing the product to show an honest availability
   state instead of an error or a fake list of people.

“Nearby” always means relevance to a public professional, institutional, civic, or opt-in
association—not that a person is physically near the user.

## Local development

Requires Python 3.13.

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Copy `.env.example` to `.env` only for local development. Never commit a real production key.

## Operations

- [API contract](docs/API_CONTRACT.md)
- [Kirkland 98033 source release](docs/KIRKLAND_98033_SOURCE_RELEASE.md)
- [Organization discovery O1](docs/ORGANIZATION_DISCOVERY_O1.md)
- [Financial context boundary](docs/FINANCIAL_CONTEXT_BOUNDARY.md)
- [Production handoff and integration guide](docs/PRODUCTION_HANDOFF.md)
- [Architecture roadmap](ARCHITECTURE.md)
- [Source catalog](docs/SCRAPER_CATALOG.md)
- [Future ingestion and incident runbook](docs/RUNBOOK.md)
