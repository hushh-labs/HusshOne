# NWS Nearby API and Product Contract

> **Current release:** `REVIEWED_PUBLIC_ASSOCIATION_RELEASE`. The query interface accepts global
> coordinates and country-qualified postal input, but the only approved people dataset is the
> Kirkland, Washington public-association market. A valid global input must never be relabelled as Kirkland
> or filled with Kirkland candidates.

## Endpoint and authentication

```text
POST /v2/nearby-network/discover
X-NWS-API-Key: <server-held secret>
```

The service accepts non-cookie wildcard CORS for cross-project clients. Consumers still use a BFF
or server route: a browser-exposed API key is public, not authentication.

## Location query contract

Supply exactly one location form.

### Consented device location

```json
{
  "query": {
    "latitude": 47.6715,
    "longitude": -122.2133,
    "country_code": "US"
  },
  "top_n": 100,
  "initial_radius_km": 20,
  "max_radius_km": 100,
  "filters": {"minimum_confidence_grade": "B"}
}
```

- `latitude` and `longitude` are required together.
- `country_code` is optional client context, not a reverse-geocoded fact or an authorization
  signal. It must be ISO-3166 alpha-2 when supplied.
- The API rounds coordinates to its configured coarse precision before coverage lookup, retrieval,
  and response serialization. It does not log the raw coordinate.

### Postal fallback

```json
{
  "query": {"postal_code": "110001", "country_code": "IN"},
  "top_n": 100
}
```

- `postal_code` is normalized to uppercase and accepts 3–16 alphanumeric, space, or hyphen
  characters.
- `country_code` is required with postal input, except for the backward-compatible legacy request
  `{"postal_code":"98033"}`, which is interpreted as US.
- A postal code is eligible to select people only after its canonical `(country_code, postal_code)`
  geography has been loaded and the resulting market is approved. The reference `PostalCentroidIndex`
  is development-only and cannot be used as a global index.

Malformed, partial, or mixed postal-plus-coordinate input returns `422`. Valid location input that
does not have product coverage returns `200`; see the coverage section below.

## Coverage response contract

Every successful response includes:

```json
{
  "coverage": {
    "status": "COVERED | NOT_COVERED | LOCATION_UNRESOLVED",
    "reason_code": "...",
    "complete": false,
    "data_mode": "REVIEWED_PUBLIC_ASSOCIATION_RELEASE",
    "message": "..."
  }
}
```

`COVERED` also includes the canonical market id, label, and country. `NOT_COVERED` may include a
supplied country context. `LOCATION_UNRESOLVED` includes the declared postal country; it is not a
claim that the postal input was geocoded.

| Status | Normal response behavior |
| --- | --- |
| `COVERED` | Candidate filtering, ranking, and public-safe serialization run. |
| `NOT_COVERED` | A coordinate was understood but no approved public-association dataset exists for its market. `results` and candidate counts are zero. |
| `LOCATION_UNRESOLVED` | Postal input was valid but is absent from the canonical geography index. `results` and candidate counts are zero. |

The current `COVERED` condition is US `98033` or a coarse coordinate within the declared
Kirkland public-association market boundary. If a caller sends a non-US country context for an
otherwise Kirkland coordinate, the service returns `NOT_COVERED` with
`COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET` rather than returning people.

## Current response shape

```json
{
  "query": {
    "label": "Kirkland public-association market query area",
    "mode": "COARSE_COORDINATE",
    "normalized_coordinate": {"latitude": 47.67, "longitude": -122.21}
  },
  "coverage": {
    "status": "COVERED",
    "reason_code": "APPROVED_MARKET_RELEASE",
    "market_id": "us-wa-kirkland-public-association",
    "complete": false,
    "data_mode": "REVIEWED_PUBLIC_ASSOCIATION_RELEASE"
  },
  "snapshot": {
    "score_status": "PROVISIONAL",
    "complete": false,
    "model_version": "nws-v2.3.0-kirkland.2026-08-13",
    "reviewed_at": "2026-08-13"
  },
  "summary": {
    "reviewed_public_association_candidate_count": 60,
    "returned_count": 60,
    "search_performed": true,
    "candidate_backend": "reviewed-public-association-release"
  },
  "results": []
}
```

Result fields include only public-association labels, coarse public-association distance bands,
source links, score confidence, and provisional/revalidation indicators. They never contain a
private home, exact person coordinate, personal contact data, family graph, asset/net-worth claim,
or raw evidence document.

## Ranking and privacy invariant

NWS estimates public professional network strength and opportunity access. It is not financial net
worth. “Nearby” refers to a public professional, institutional, civic, or opt-in association; it
does not mean physical presence near the user.

The current release has 60 reviewed public-association records, not a synthetic top-100 list.
Each response declares `score_status: "PROVISIONAL"` and `complete: false` until approved
PostGIS/graph snapshots and market-specific source coverage are available. The response also
contains the versioned release identifier, public manifest hashes, citation/source-family counts,
and refresh flags. Two URLs from one organization domain are never presented as independent
source families.

## Future market enablement gate

A country, postal area, or coordinate market may transition to `COVERED` only after all of these
are present:

1. Canonical country-qualified postal or coordinate coverage geometry with provenance.
2. Reviewed public-institution, organization, civic, or opt-in location associations.
3. Privacy/policy approval and suppression handling.
4. A versioned candidate and scoring snapshot in the production retrieval path.
5. Integration and negative-coverage tests proving no fallback candidates leak into the market.
