# Start a scan

Submit a subject's identity and profile URLs to `POST /api/v1/scan`, which scrapes each provided profile and starts a Deep Research scan.

## Endpoint

`POST /api/v1/scan`

Base URL: `https://one.hushh.ai`

## Authentication

Send your key as a Bearer token:

```
Authorization: Bearer $ONE_API_KEY
```

See [Authentication](/docs/authentication) for details.

## How it works

The provided profile URLs (LinkedIn, Instagram, X, Threads) are scraped **in parallel and synchronously during the request** — the POST does not return until every scrape has finished and the scan has been started. Rich profiles with long timelines take longer, so a single request can take up to roughly 3 minutes.

Set a client timeout of **at least 120 seconds** (longer for accounts with large timelines). See [Long-running scans](/docs/long-scans) for timeout and retry guidance.

A profile that is private, fails, or is too thin does not fail the request. It is reported in the `profiles` map and simply omitted from the scan. See [Profile contracts](/docs/profile-contracts) for the per-platform report shapes.

## Request body

Content type: `application/json`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | Yes | Subject's name. Trimmed and truncated to 80 characters. |
| `email` | string | Yes | Subject's email. Must be a valid address. |
| `latitude` | number | Conditional | Provide with `longitude` for `precise` location. |
| `longitude` | number | Conditional | Provide with `latitude` for `precise` location. |
| `zipCode` | string | Conditional | Alternative to lat/long, yields `limited` location. |
| `linkedinUrl` | string | No | LinkedIn profile URL to scrape. |
| `instagramUrl` | string | No | Instagram profile URL to scrape. |
| `xUrl` | string | No | X (Twitter) profile URL to scrape. |
| `threadsUrl` | string | No | Threads profile URL to scrape. |
| `phone` | string | No | Subject's phone number. |
| `consentAttestation` | boolean | No | Defaults to `true`. Setting it to `false` rejects the request with `403`. |
| `socialPreferenceConsent` | boolean | No | Defaults to `true`. Setting it to `false` runs the dossier only and skips the preference/lifestyle layer. |

### Location

You must provide **either** `latitude` **and** `longitude`, **or** `zipCode`. Supplying `latitude`+`longitude` sets the scan to `precise` mode; `zipCode` alone sets `limited` mode. See [Choosing inputs](/docs/choosing-inputs).

### Consent flags

Both consent flags default to `true`, so a minimal request runs a full scan with the preference layer enabled. The flags accept booleans; the string values `false`, `0`, and `no` (case-insensitive) are also treated as `false`.

- `consentAttestation: false` — the request is rejected with `403` and no scan is started.
- `socialPreferenceConsent: false` — the scan runs and produces the dossier, but the preference/lifestyle layer is skipped.

See [Consent and privacy](/docs/consent-privacy).

## Response

On success the endpoint returns `202 Accepted`. The scan is running; use the returned links to poll or stream progress.

```json
{
  "ok": true,
  "scanId": "scn_...",
  "status": "running",
  "statusUrl": "/api/v1/scan/scn_...",
  "links": {
    "self": "/api/v1/scan/scn_...",
    "stream": "/api/v1/scan/scn_.../stream",
    "preferences": "/api/v1/scan/scn_.../preferences"
  },
  "preferences": {
    "enabled": true,
    "status": "running"
  },
  "profiles": {
    "linkedin": null,
    "instagram": null,
    "threads": null,
    "x": null
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | `true` on success. |
| `scanId` | string | The scan identifier. |
| `status` | string | Always `running` on a `202`. |
| `statusUrl` | string | Path to the scan status resource (kept for back-compat; same as `links.self`). |
| `links.self` | string | Poll this path for status. See [Polling](/docs/polling). |
| `links.stream` | string | SSE stream for live progress. See [Streaming](/docs/api-streaming). |
| `links.preferences` | string | Preference/lifestyle results. See [Preferences](/docs/preferences). |
| `preferences.enabled` | boolean | Whether the preference layer was enabled for this scan. |
| `preferences.status` | string | `running` when enabled, `skipped` otherwise. |
| `profiles` | object | Per-platform scrape reports keyed by `linkedin`, `instagram`, `threads`, `x`. Each is the scraped profile, a pending/failed/too-thin marker, or `null` when no URL was provided. |

`links` and `statusUrl` are `null` if the scan record could not be created.

For the shapes inside `profiles`, see [Profile contracts](/docs/profile-contracts).

## Errors

| Status | `code` | `error` message |
| --- | --- | --- |
| `400` | `bad_input` | `` `name` is required `` |
| `400` | `bad_input` | `` `email` is required and must be a valid email `` |
| `400` | `bad_input` | `` Provide `latitude`+`longitude` or `zipCode` `` |
| `401` | `unauthorized` | Authentication failed (invalid or missing key). |
| `403` | `consent_required` | `consentAttestation must be true to run a scan.` |
| `502` | `scan_start_failed` | The scan could not be started. |

Errors use a consistent envelope: `{ "ok": false, "error": "<message>", "code": "<machine_code>" }`. See [Error handling](/docs/error-handling) and [Status codes](/docs/status-codes).

## Examples

### curl

```bash
curl -X POST https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 180 \
  -d '{
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "latitude": 37.7749,
    "longitude": -122.4194,
    "linkedinUrl": "https://www.linkedin.com/in/ada",
    "instagramUrl": "https://www.instagram.com/ada"
  }'
```

### JavaScript

```js
const res = await fetch("https://one.hushh.ai/api/v1/scan", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.ONE_API_KEY}`,
    "Content-Type": "application/json",
  },
  // URLs are scraped synchronously during the request; allow ample time.
  signal: AbortSignal.timeout(180_000),
  body: JSON.stringify({
    name: "Ada Lovelace",
    email: "ada@example.com",
    zipCode: "94103",
    xUrl: "https://x.com/ada",
  }),
});

const data = await res.json();
if (!res.ok) throw new Error(`${data.code}: ${data.error}`);

// Poll data.links.self or open data.links.stream for progress.
console.log(data.scanId, data.status);
```

## Next steps

- [Polling](/docs/polling) — read scan status over HTTP.
- [Streaming](/docs/api-streaming) — subscribe to live progress via SSE.
- [Preferences](/docs/preferences) — read the preference/lifestyle layer.
- [Choosing inputs](/docs/choosing-inputs) — which fields to send.
- [Profile contracts](/docs/profile-contracts) — the per-platform `profiles` shapes.
- [Consent and privacy](/docs/consent-privacy) — how consent flags behave.
- [Long-running scans](/docs/long-scans) — timeouts for large timelines.
- [Error handling](/docs/error-handling) — the error envelope and recovery.
