# Health & status

A public, unauthenticated endpoint that reports whether the One Developer API and its dependencies are operational.

## `GET /api/v1/health`

Returns a sanitized status report for the API and the services a scan depends on. This endpoint is **public** — no `Authorization` header is required — and is **CORS-open** so it can be polled directly from a browser-based status dashboard.

For a human-readable, always-live view of the same data, see the [status dashboard](/docs/status).

```bash
curl https://one.hushh.ai/api/v1/health
```

No request body or parameters are accepted.

## Response

```json
{
  "ok": true,
  "status": "operational",
  "checkedAt": "2026-07-02T12:34:56.789Z",
  "components": [
    {
      "id": "api",
      "name": "API",
      "status": "operational",
      "description": "Developer API request handling",
      "latencyMs": 0
    },
    {
      "id": "database",
      "name": "Database",
      "status": "operational",
      "description": "Scan storage & retrieval",
      "latencyMs": 12
    },
    {
      "id": "research",
      "name": "Research engine",
      "status": "operational",
      "description": "Deep-research dossier (Vertex + Deep Research)",
      "latencyMs": 340
    },
    {
      "id": "scrapers",
      "name": "Profile scrapers",
      "status": "operational",
      "description": "Public-profile scrapers — 5/5 sources operational",
      "latencyMs": 210
    }
  ]
}
```

### Top-level fields

| Field | Type | Description |
| --- | --- | --- |
| `ok` | boolean | `true` unless overall `status` is `down`. |
| `status` | string | Overall status: `operational`, `degraded`, or `down`. |
| `checkedAt` | string | ISO 8601 timestamp of when the underlying checks were last run. |
| `components` | array | Per-component status entries (see below). |

### Component fields

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Stable component identifier: `api`, `database`, `research`, or `scrapers`. |
| `name` | string | Human-readable component name. |
| `status` | string | Component status: `operational`, `degraded`, or `down`. |
| `description` | string | Short description of what the component covers. |
| `latencyMs` | number | Measured latency for the component's dependency probe, in milliseconds. |

### Components

| `id` | Covers | Critical |
| --- | --- | --- |
| `api` | Developer API request handling. Always reported `operational` when the endpoint responds. | — |
| `database` | Scan storage & retrieval. | Yes |
| `research` | Deep-research dossier (Vertex + the Deep Research service). | Yes |
| `scrapers` | Public-profile scrapers across all sources. The `description` reports how many sources are operational, e.g. `5/5 sources operational`. | No |

## Status values

| Status | Meaning |
| --- | --- |
| `operational` | The component (or overall service) is fully healthy. |
| `degraded` | Reachable but impaired — a critical component is degraded, or one or more scraper sources are not fully operational. |
| `down` | A critical component is unavailable. |

**Overall status is derived from the components:**

- `down` — if `database` or `research` is `down`.
- `degraded` — if `database` or `research` is `degraded`, or if the `scrapers` component is not fully operational.
- `operational` — otherwise.

The `scrapers` component is **non-critical**: a degraded or down scraper only reduces scrape depth and never fails the overall verdict. `database` and `research` are **critical** — either being down takes the whole service `down`.

## HTTP status codes

| HTTP | When |
| --- | --- |
| `200` | Overall status is `operational` or `degraded`. |
| `503` | Overall status is `down` (a critical component is unavailable). |

Inspect the response body (`status` and `components`) to distinguish `operational` from `degraded` — both return `200`.

See [Status codes](/docs/status-codes) for the full list of codes used across the API.

## Caching

Results are cached server-side for roughly 30 seconds, so repeated polling will not stampede the underlying dependencies. Responses are also served with a short client cache header. Expect `checkedAt` to advance at most every ~30 seconds regardless of how often you call the endpoint.

## Example: polling from a dashboard

```js
async function poll() {
  const res = await fetch("https://one.hushh.ai/api/v1/health");
  const health = await res.json();
  console.log(health.status, `(HTTP ${res.status})`);
  for (const c of health.components) {
    console.log(`  ${c.name}: ${c.status} (${c.latencyMs}ms)`);
  }
}
```

For programmatic monitoring, poll no more often than the ~30-second cache window. For a visual view, use the live [status dashboard](/docs/status).
