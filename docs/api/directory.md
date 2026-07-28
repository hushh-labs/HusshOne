# Directory search

Find nearby entities across four directories — **hotels**, **healthcare** providers, **RIA** firms, and **insurance** producers — ranked by distance from a set of coordinates.

## Endpoint

`GET /api/v1/directory`

Base URL: `https://one.hushh.ai`

## Authentication

Send your key as a Bearer token:

```
Authorization: Bearer $ONE_API_KEY
```

See [Authentication](/docs/authentication) for details.

## How it works

The directory is **coordinate-driven**. You pass a latitude/longitude and a search radius; the API queries each requested vertical for rows within that radius, then **merges all verticals and sorts the combined list by true geographic distance** (nearest first), capping the result at `limit`.

The four verticals live in separate databases, so results are gathered per vertical and merged in the response — there is no cross-vertical join. If one vertical's lookup fails, the others are still returned and the failure is reported in `warnings` (the request does not fail).

### Coordinate precision

Every row carries a `geoPrecision` flag so distance ranking is honest:

| Vertical | Coordinate source | `geoPrecision` |
| --- | --- | --- |
| `hotels` | The venue's own coordinates (Places / OSM) | `rooftop` |
| `healthcare` | ZIP-code centroid | `zip_centroid` |
| `ria` | ZIP-code centroid | `zip_centroid` |
| `insurance` | ZIP-code centroid | `zip_centroid` |

`rooftop` rows are precise to the address. `zip_centroid` rows share one point per ZIP code until per-address geocoding lands — at which point they flip to `rooftop` with no change to this API. The `social` vertical has no coordinates and is **excluded** from proximity search.

> RIA proximity matches **firms** only. Individual advisers rarely carry a mappable address and are omitted.

## Query parameters

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `lat` | number | Conditional | Latitude, `-90`…`90`. Required unless `zip` is provided. Alias: `latitude`. |
| `lng` | number | Conditional | Longitude, `-180`…`180`. Required unless `zip` is provided. Aliases: `lon`, `longitude`. |
| `radius` | integer | No | Search radius in **metres**. Default `5000`. Clamped to `[100, 50000]`. |
| `limit` | integer | No | Max results across all verticals (applied after merge). Default `50`. Clamped to `[1, 200]`. |
| `verticals` | string | No | Comma-separated subset of `hotels,healthcare,ria,insurance`. Default: all four. Unknown or `social` values are ignored with a warning. |
| `zip` | string | No | Backward-compat fallback. When `lat`/`lng` are absent, the ZIP is resolved to its centroid and used as the search point. |

You must provide **either** `lat`+`lng` **or** `zip`. Coordinates always win when both are present.

## Response

Returns `200 OK` with the merged, distance-sorted rows.

```json
{
  "ok": true,
  "query": {
    "lat": 47.68,
    "lng": -122.21,
    "radiusM": 5000,
    "limit": 20,
    "verticals": ["hotels", "healthcare", "ria", "insurance"],
    "resolvedFrom": "coordinates"
  },
  "count": 20,
  "results": [
    {
      "vertical": "hotels",
      "id": "1042",
      "name": "The Heathman Hotel",
      "subtitle": "220 Kirkland Ave, Kirkland, WA 98033, USA · 4.5★",
      "distanceM": 312.4,
      "geoPrecision": "rooftop",
      "lat": 47.6768,
      "lng": -122.2085,
      "fields": {
        "address": "220 Kirkland Ave, Kirkland, WA 98033, USA",
        "zip": "98033",
        "state": "WA",
        "rating": 4.5,
        "userRatingsTotal": 812,
        "priceLevel": 3,
        "phone": "+1 425-284-5800",
        "website": "https://example.com",
        "googleMapsUri": "https://maps.google.com/?cid=...",
        "primaryType": "hotel",
        "photosCount": 10
      }
    }
  ],
  "warnings": []
}
```

### Top-level fields

| Field | Type | Description |
| --- | --- | --- |
| `ok` | boolean | `true` on success. |
| `query` | object | Echo of the resolved search: `lat`, `lng`, `radiusM`, `limit`, `verticals`, `resolvedFrom` (`coordinates` or `zip`), and `zip` when a ZIP was resolved. |
| `count` | integer | Number of rows in `results` (after the global `limit`). |
| `results` | array | Directory rows, sorted by `distanceM` ascending. |
| `warnings` | array | Non-fatal notes — excluded/unknown verticals and any per-vertical query failures. |

### Result row

| Field | Type | Description |
| --- | --- | --- |
| `vertical` | string | `hotels`, `healthcare`, `ria`, or `insurance`. |
| `id` | string | Stable identifier within the vertical (hotel id, NPI, CRD, or producer id). |
| `name` | string | Display name. |
| `subtitle` | string \| null | A short human summary composed from the vertical's key fields. |
| `distanceM` | number | Distance from the query point, in metres. |
| `geoPrecision` | string | `rooftop` or `zip_centroid` (see above). |
| `lat` / `lng` | number \| null | The row's coordinates. |
| `fields` | object | Vertical-specific columns (address, phone, and e.g. `rating`/`aum`/`specialty`/`licenseTypes`). |

## Errors

| Status | `code` | `error` message |
| --- | --- | --- |
| `400` | `bad_coordinates` | `` Provide both `latitude` and `longitude` `` / out-of-range latitude or longitude |
| `400` | `missing_coordinates` | `` Provide `latitude`+`longitude` (or `zip` as a fallback) `` |
| `400` | `unknown_zip` | The supplied `zip` could not be resolved to coordinates. |
| `401` | `unauthorized` | Authentication failed (invalid or missing key). |
| `503` | `directory_unavailable` | The directory database is not configured. |
| `502` | `directory_query_failed` | The directory query failed unexpectedly. |

Errors use a consistent envelope: `{ "ok": false, "error": "<message>", "code": "<machine_code>" }`. See [Error handling](/docs/error-handling) and [Status codes](/docs/status-codes).

## Examples

### curl

```bash
curl -G https://one.hushh.ai/api/v1/directory \
  -H "Authorization: Bearer $ONE_API_KEY" \
  --data-urlencode "lat=47.68" \
  --data-urlencode "lng=-122.21" \
  --data-urlencode "radius=5000" \
  --data-urlencode "limit=20" \
  --data-urlencode "verticals=hotels,ria"
```

### JavaScript

```js
const url = new URL("https://one.hushh.ai/api/v1/directory");
url.search = new URLSearchParams({
  lat: "47.68",
  lng: "-122.21",
  radius: "5000",
  limit: "20",
}).toString();

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${process.env.ONE_API_KEY}` },
});

const data = await res.json();
if (!res.ok) throw new Error(`${data.code}: ${data.error}`);

for (const row of data.results) {
  console.log(`${Math.round(row.distanceM)}m  ${row.vertical}  ${row.name}`);
}
```

## Next steps

- [Authentication](/docs/authentication) — API keys and the Bearer header.
- [Error handling](/docs/error-handling) — the error envelope and recovery.
- [Status & error codes](/docs/status-codes) — every status and machine code.
- [OpenAPI spec](/docs/openapi) — the machine-readable contract.
