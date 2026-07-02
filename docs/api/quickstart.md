# Quickstart

Go from zero to your first dossier in three steps: get a key, start a scan, then read the result.

The base URL is `https://one.hushh.ai`. Every authenticated request carries `Authorization: Bearer $ONE_API_KEY`.

## 1. Get your key

The API is key-gated: keys are issued by hushh. Once you have one, keep it in an environment variable and send it as a Bearer token on every call.

```bash
export ONE_API_KEY="your_key_here"
```

A missing or invalid key returns `401` with code `unauthorized`. More detail on [Authentication](/docs/authentication).

## 2. Start a scan

`POST /api/v1/scan` with the subject's identity. `name`, `email`, and a location (`latitude`+`longitude` **or** `zipCode`) are required; every profile URL is optional. Each URL you provide is scraped during this call and preloaded into the research.

| Field | Type | Required | Default |
|---|---|---|---|
| `name` | string | yes | — |
| `email` | string | yes | — |
| `latitude` + `longitude` | number | yes¹ | — |
| `zipCode` | string | yes¹ | — |
| `linkedinUrl` | string | no | — |
| `instagramUrl` | string | no | — |
| `xUrl` | string | no | — |
| `threadsUrl` | string | no | — |
| `phone` | string | no | — |
| `consentAttestation` | boolean | no | `true` |
| `socialPreferenceConsent` | boolean | no | `true` |

¹ Provide either `latitude`+`longitude` (→ `precise` mode) or `zipCode` (→ `limited` mode). Neither returns `400`.

```bash
curl -s https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ada Lovelace",
    "email": "subject@example.com",
    "zipCode": "94040",
    "linkedinUrl": "https://www.linkedin.com/in/example/",
    "instagramUrl": "https://www.instagram.com/example/"
  }'
```

```js
const started = await fetch("https://one.hushh.ai/api/v1/scan", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.ONE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "Ada Lovelace",
    email: "subject@example.com",
    zipCode: "94040",
    linkedinUrl: "https://www.linkedin.com/in/example/",
    instagramUrl: "https://www.instagram.com/example/",
  }),
}).then((r) => r.json());
```

A successful start returns `202`:

```json
{
  "ok": true,
  "scanId": "285d9ef0-774f-45db-b450-669206a0d51f",
  "status": "running",
  "statusUrl": "/api/v1/scan/285d9ef0-...",
  "links": {
    "self": "/api/v1/scan/285d9ef0-...",
    "stream": "/api/v1/scan/285d9ef0-.../stream",
    "preferences": "/api/v1/scan/285d9ef0-.../preferences"
  },
  "preferences": { "enabled": true, "status": "running" },
  "profiles": { "linkedin": { "...": "..." }, "instagram": { "...": "..." }, "threads": null, "x": null }
}
```

Keep `scanId` (or `links.self`) for the next step. The `profiles` map echoes each scraped contract — a URL you did not send is `null`, and a private, failed, or thin profile is reported here and skipped without failing the scan. Because scraping happens synchronously inside this call, set a generous client timeout (the endpoint allows up to 300 seconds).

See [Start a scan](/docs/start-a-scan) for the full request contract and [Choosing inputs](/docs/choosing-inputs) for which URLs to send.

## 3. Get the dossier + preferences

The scan runs two tracks in parallel — the deep-research dossier and the preference/lifestyle layer. Stream them live, or poll.

### Stream (SSE)

```bash
curl -sN https://one.hushh.ai/api/v1/scan/<scanId>/stream \
  -H "Authorization: Bearer $ONE_API_KEY"
```

The stream multiplexes research progress and preferences until both finish. Details on [Streaming](/docs/api-streaming).

### Poll

`GET /api/v1/scan/{id}` returns the best-available result. `status` is `running`, `completed`, or `failed`; an unknown or unowned scan id returns `404` with `status: "unknown"`.

```js
const auth = { Authorization: `Bearer ${process.env.ONE_API_KEY}` };
let scan;
do {
  await new Promise((r) => setTimeout(r, 10_000));
  scan = await fetch(`https://one.hushh.ai${started.links.self}`, { headers: auth })
    .then((r) => r.json());
} while (scan.status === "running");
```

A completed poll looks like:

```json
{
  "ok": true,
  "scanId": "285d9ef0-...",
  "status": "completed",
  "profiles": { "...": "..." },
  "result": { "...": "dossier report, footprint categories, citations" },
  "preferences": { "status": "completed", "profile": { "...": "6 sections + lifestyle" } }
}
```

While the scan is running, `result` is `null` and `preferences.status` is `running` (or `skipped` when there is no consent or no social feed). See [Polling](/docs/polling) for the loop details and [Preferences](/docs/preferences) for the profile shape.

## Next steps

- [Authentication](/docs/authentication) — how keys work and per-key scan ownership.
- [Start a scan](/docs/start-a-scan) — every field, validation, and edge case.
- [Streaming](/docs/api-streaming) — the SSE event sequence.
- [Polling](/docs/polling) — the two-call poll flow.
- [API overview](/docs/api-overview) — endpoints, lifecycle, and guarantees.
- [Error handling](/docs/error-handling) and [Status codes](/docs/status-codes).
