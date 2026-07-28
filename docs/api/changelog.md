# Changelog

Notable changes to the One Developer API and its documentation, newest first.

## 2026-07-29

- New `GET /api/v1/directory` — coordinate-driven proximity search across four directory verticals (`hotels`, `healthcare`, `ria`, `insurance`). Pass `lat`+`lng` (or a `zip` fallback) and a `radius`; results from all requested verticals are merged and sorted by true geographic distance, nearest first. Each row carries a `geoPrecision` flag (`rooftop` for hotels, `zip_centroid` for the others until per-address geocoding lands). Bearer-key gated. See [Directory search](/docs/directory).

## 2026-07-02

- Public `GET /api/v1/health` status endpoint — no key required, CORS-open, safe to hit from a browser or an external monitor. Returns an overall `status` (`operational` · `degraded` · `down`) plus per-component checks for `api`, `database`, `research`, and `scrapers`. Responds `200` when operational or degraded, `503` when a critical component (`database` or `research`) is down. Cached ~30s server-side.
- Live status dashboard at [/docs/status](/docs/status), backed by the health endpoint.
- Documentation revamped into a full guide plus reference, with light/dark theming and on-page navigation. See [API overview](/docs/api-overview) and [Health & status](/docs/health).

## 2026-07-01

- v1 developer API is live. `POST /api/v1/scan` starts a scan — scrapes any provided profile URLs synchronously, kicks off the deep-research dossier, and enables the preference layer. Returns `202` with a `scanId`, `links`, and the scraped `profiles` map.
- Live progress over SSE at `GET /api/v1/scan/{id}/stream` — research and preferences multiplexed, re-attachable. See [Streaming](/docs/api-streaming).
- Polling at `GET /api/v1/scan/{id}` — `status` moves `running` → `completed`, with `result` (dossier) and `preferences` included when ready. See [Polling](/docs/polling).
- 6-section preference profile plus lifestyle facts at `GET /api/v1/scan/{id}/preferences`. See [Preferences](/docs/preferences).
- Public OpenAPI 3.1 spec at `GET /api/v1/openapi.json` — no auth, importable into Postman/Swagger/codegen. See [OpenAPI spec](/docs/openapi).
- Bearer-key auth on every scan endpoint: `Authorization: Bearer $ONE_API_KEY`. Base URL `https://one.hushh.ai`. A scan is owned by the key that created it.

**See also:** [API overview](/docs/api-overview) · [Health & status](/docs/health)
