# Status & error codes

Every response the One Developer API returns carries a meaningful HTTP status and, on failure, a machine-readable `code` you can branch on.

Base URL: `https://one.hushh.ai`. All authenticated endpoints expect `Authorization: Bearer $ONE_API_KEY`.

## Error envelope

Failures use a consistent JSON body. The flat `error` string is a human-readable message; `code` is the stable machine value to switch on. Both accompany a non-2xx HTTP status.

```json
{
  "ok": false,
  "error": "consentAttestation must be true to run a scan.",
  "code": "consent_required"
}
```

All error responses (and every JSON response) are CORS-open, so browser clients can read them directly.

## Code reference

| `code` | HTTP | Endpoint(s) | When |
| --- | --- | --- | --- |
| `unauthorized` | 401 | all authenticated endpoints | Missing or invalid Bearer key. |
| `bad_input` | 400 | `POST /api/v1/scan` | Request body failed validation (missing/invalid required fields). |
| `bad_coordinates` | 400 | `GET /api/v1/directory` | `lat`/`lng` supplied singly, non-numeric, or out of range. |
| `missing_coordinates` | 400 | `GET /api/v1/directory` | Neither coordinates nor a `zip` fallback were provided. |
| `unknown_zip` | 400 | `GET /api/v1/directory` | The `zip` fallback could not be resolved to coordinates. |
| `directory_query_failed` | 502 | `GET /api/v1/directory` | Unexpected failure running the proximity query. |
| `directory_unavailable` | 503 | `GET /api/v1/directory` | The directory database is not configured. |
| `consent_required` | 403 | `POST /api/v1/scan` | `consentAttestation` was explicitly `false`. |
| `scan_start_failed` | 502 | `POST /api/v1/scan` | Scan could not be started (e.g. an upstream/scrape failure). |
| `not_found` | 404 | `GET /api/v1/scan/{id}/stream` | Scan id does not exist for this key — returned as JSON before the stream opens. |
| _(no code)_ | 404 | `GET /api/v1/scan/{id}`, `GET /api/v1/scan/{id}/preferences` | Scan id not found for this key — see the caveat below. |
| `scan_read_failed` | 500 | `GET /api/v1/scan/{id}` | Unexpected error loading the scan. |
| `preferences_read_failed` | 500 | `GET /api/v1/scan/{id}/preferences` | Unexpected error loading the preference profile. |
| `research_failed` | SSE `error` frame | `GET /api/v1/scan/{id}/stream` | The Deep Research job failed while streaming. |
| `stream_error` | SSE `error` frame | `GET /api/v1/scan/{id}/stream` | An unexpected error inside the open stream. |

The `bad_input` and `consent_required` codes on `POST /api/v1/scan` are the validated-input path; any other thrown failure falls back to `502 scan_start_failed`. See [Start a scan](/docs/start-a-scan) for the request contract.

### HTTP status quick map

| HTTP | Meaning |
| --- | --- |
| 202 | Scan accepted and started (`POST /api/v1/scan`). |
| 200 | Scan / preferences read succeeded; SSE stream opened; health operational or degraded. |
| 400 | Malformed request (bad body, or bad/missing directory coordinates). |
| 401 | Authentication failed. |
| 403 | Consent not attested. |
| 404 | Scan id not found for this key. |
| 500 | Server error while reading. |
| 502 | Scan failed to start, or a directory query failed. |
| 503 | Health: a critical component is down; or the directory database is not configured. |

## The 404 no-code caveat

`GET /api/v1/scan/{id}` and `GET /api/v1/scan/{id}/preferences` do **not** use the `code` error envelope for a missing scan. Instead they return HTTP 404 with an `ok:false`, `status:"unknown"` body:

```json
{
  "ok": false,
  "scanId": "abc123",
  "status": "unknown",
  "result": null
}
```

The preferences endpoint returns the same shape with `preferences: null` in place of `result`. Detect this case by checking `status === "unknown"` (or the 404 status), not a `code` field.

The stream endpoint is the exception: it returns the `code:"not_found"` error envelope (with HTTP 404) when the scan is missing, because that JSON is emitted **before** the event stream opens.

```js
const res = await fetch(`https://one.hushh.ai/api/v1/scan/${id}`, {
  headers: { Authorization: `Bearer ${process.env.ONE_API_KEY}` },
});
const body = await res.json();
if (res.status === 404 || body.status === "unknown") {
  // scan id not found for this key
}
```

## SSE error frames

The stream endpoint returns HTTP 200 once the connection opens; failures after that are delivered as SSE frames, not HTTP statuses. A terminal `error` frame carries a `code` and `error`:

```
event: error
data: {"code":"research_failed","error":"Research failed"}
```

- `research_failed` — the Deep Research job reached a failed state.
- `stream_error` — an unexpected error was caught inside the stream loop.

Both are terminal and close the connection. Auth (`401 unauthorized`) and a missing scan (`404 not_found`) are still returned as JSON before the stream opens. See [Streaming](/docs/api-streaming) for the full frame catalogue and [Error handling](/docs/error-handling) for retry guidance.

## Health status

`GET /api/v1/health` is public (no auth) and reports overall status plus per-component detail:

| HTTP | `status` | Meaning |
| --- | --- | --- |
| 200 | `operational` | All components healthy. |
| 200 | `degraded` | A critical component is degraded, or profile scrapers are not fully up. |
| 503 | `down` | A critical component (database or research engine) is down. |

The response includes `ok` (false only when `down`), `checkedAt`, and a `components` array (`api`, `database`, `research`, `scrapers`). Results are cached briefly server-side, so consecutive calls may return identical `checkedAt`. See [Health](/docs/health) or the live [status dashboard](/docs/status).

## Related

- [Error handling](/docs/error-handling) — recommended retry and backoff patterns.
- [Health](/docs/health) — the health endpoint in detail.
- [Streaming](/docs/api-streaming) — SSE frames including `error`.
- [Authentication](/docs/authentication) — how the Bearer key is verified.
