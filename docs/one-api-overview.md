# One Developer API (v1) — overview & contract

One's intelligence, over HTTP. Give the API a person's identity + (optional) public profile URLs; it
scrapes each profile, runs a deep‑research **dossier**, and builds a 6‑section **preference profile** with
**lifestyle facts** — the *same* pipeline that powers [one.hushh.ai](https://one.hushh.ai). You can
**stream the whole thing live** (SSE) or poll. No SDK — it's plain JSON + `curl`/`fetch`.

> **New here?** This page is the contract. For the live stream + preference layer, see
> [Streaming (SSE)](/docs/api-streaming). New to the API? Start with the [Quickstart](/docs/quickstart).

---

## At a glance

| | |
|---|---|
| **Base URL** | `https://one.hushh.ai` |
| **Auth** | `Authorization: Bearer <YOUR_API_KEY>` on every request (issued by hushh; the API is **key‑gated**). |
| **Request format** | `application/json`. |
| **Response format** | JSON, except the stream (`text/event-stream`). Every response includes an `ok` boolean. |
| **CORS** | Enabled for all origins — browser clients welcome; the key is still required. |
| **Spec** | [`GET /api/v1/openapi.json`](https://one.hushh.ai/api/v1/openapi.json) — OpenAPI 3.1, no auth, import into Postman/Swagger/codegen. |
| **Ownership** | A scan is owned by the key that created it. Another key cannot read it (`404`). |

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/scan` | Bearer | Start a scan. Scrapes any provided URLs, starts deep research, enables the preference layer. Returns **202** with `scanId` + links. |
| `GET` | `/api/v1/scan/{id}` | Bearer | Poll status → dossier + preferences. |
| `GET` | `/api/v1/scan/{id}/stream` | Bearer | Live progress over **SSE** (research + preferences multiplexed). Re‑attachable. |
| `GET` | `/api/v1/scan/{id}/preferences` | Bearer | The 6‑section preference profile + lifestyle facts. |
| `GET` | `/api/v1/directory` | Bearer | Coordinate‑driven proximity search across four verticals (hotels / healthcare / ria / insurance), merged and sorted by distance. |
| `GET` | `/api/v1/health` | none | Service status — overall + per‑component (api / database / research / scrapers). |
| `GET` | `/api/v1/openapi.json` | none | Machine‑readable OpenAPI 3.1 contract. |

---

## Request contract — `POST /api/v1/scan`

The body is the same identity One itself consumes: **name + email + a location are required**; every social
URL is optional. Send any subset of URLs — a private/failed profile is reported and skipped, and the scan
still runs on the public web.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | ✅ | — | Subject's full name. Trimmed; capped at **80 chars**. Empty → `400`. |
| `email` | string | ✅ | — | Subject's contact email — identity only, **not** login‑matched. Must be a valid address, else `400`. |
| `latitude` + `longitude` | number | ✅¹ | — | Both present → **`precise`** mode. |
| `zipCode` | string | ✅¹ | — | Used when `lat`/`lon` are absent → **`limited`** mode. |
| `linkedinUrl` | string | ⬜ | — | Scraped in parallel; drives professional + preference signal. |
| `instagramUrl` | string | ⬜ | — | **Best for lifestyle** (photos → brands / colours / places / eyewear). |
| `xUrl` | string | ⬜ | — | Any subset. |
| `threadsUrl` | string | ⬜ | — | Any subset. |
| `phone` | string | ⬜ | — | Footprint enrichment only. |
| `consentAttestation` | boolean | ⬜ | `true` | By calling, the key holder attests they're authorized to audit this subject. `false` → `403`; the scan is **not started** — no deep research, no preference layer, nothing stored. |
| `socialPreferenceConsent` | boolean | ⬜ | `true` | Build the preference/lifestyle layer. `false` → **dossier only**. |

¹ Provide **either** `latitude`+`longitude` **or** `zipCode`. Neither → `400`.

**Validation (exact 400/403 messages)**
- `name` missing → `` `name` is required `` · code `bad_input`
- `email` missing/invalid → `` `email` is required and must be a valid email `` · code `bad_input`
- no location → `` Provide `latitude`+`longitude` or `zipCode` `` · code `bad_input`
- `consentAttestation: false` → `consentAttestation must be true to run a scan.` · code `consent_required` (403)

**Edge cases**
- **No social URLs** → dossier only; `preferences.status` = `skipped`.
- **Blocked / private / thin scrape** → reported in `profiles`, omitted from the scan; the dossier still runs.
- Booleans are lenient: `"false"`, `"0"`, `"no"` (any case) read as `false`; absent/`null` → the default.

---

## Lifecycle

```
POST /api/v1/scan ──▶ 202 { scanId, links, profiles }        (URLs scraped synchronously during POST)
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                    ▼
  GET …/{id}/stream  (SSE, live)       GET …/{id}          (poll ~10s)
    start → progress → dossier            status: running → completed
          → preferences → done            result + preferences included
```

Two tracks run in **parallel** and finish independently: **research** (deep‑research → dossier, a few
minutes) and **preferences** (a fast text pass is available immediately, then the image/lifestyle layer
enriches over ~10–20 min). The stream multiplexes both; polling returns the best‑available of each.

> ⏱ The `POST` scrapes each provided URL **synchronously** before returning. For very large timelines this
> can take up to ~3 min — set a generous client timeout (≥120s) on the POST.

---

## Responses

### `202` — scan accepted (`POST /api/v1/scan`)
```json
{
  "ok": true,
  "scanId": "285d9ef0-774f-45db-b450-669206a0d51f",
  "status": "running",
  "statusUrl": "/api/v1/scan/285d9ef0-…",
  "links": {
    "self":        "/api/v1/scan/285d9ef0-…",
    "stream":      "/api/v1/scan/285d9ef0-…/stream",
    "preferences": "/api/v1/scan/285d9ef0-…/preferences"
  },
  "preferences": { "enabled": true, "status": "running" },
  "profiles": { "linkedin": { "…": "…" }, "instagram": { "…": "…" }, "threads": null, "x": null }
}
```
`statusUrl` is a back‑compat alias of `links.self`.

### `200` — poll (`GET /api/v1/scan/{id}`)
```json
{
  "ok": true,
  "scanId": "285d9ef0-…",
  "status": "completed",
  "profiles": { "…": "…" },
  "result":  { "…": "OneDashboardResult — dossier report, footprint categories, citations" },
  "preferences": { "status": "completed", "profile": { "…": "6 sections + lifestyle" } }
}
```
`status`: `running` | `completed` | `failed` | `unknown` (the `unknown` body is a `404`). While running,
`result` is `null` and `preferences.status` is `running`/`skipped`.

### The `profiles` map
Each key (`linkedin` · `instagram` · `threads` · `x`) is one of:

| Value | Meaning |
|---|---|
| full profile object | Scraped OK (see the per‑platform contracts in [Profile data contracts](/docs/profile-contracts)). |
| `null` | URL not provided. |
| `{ "access": "<state>", "profileUrl": "…" }` | Private / gated (e.g. `private_not_following`, `login_required`). |
| `{ "status": "failed", "error": "…" }` | Scrape errored. |
| `{ "status": "too_thin", "profileUrl": "…" }` | Reachable but too little public data to use. |

### `200` — preferences (`GET /api/v1/scan/{id}/preferences`)
```json
{ "ok": true, "scanId": "285d9ef0-…", "status": "completed", "preferences": { "…": "profile + lifestyle" } }
```
`status`: `skipped` (no consent / no feed) · `running` (fast pass ready, lifestyle filling in) · `completed`.
Full shape on [Preferences & lifestyle](/docs/preferences).

---

## Status & error codes

Most error bodies are `{ "ok": false, "error": "<human message>", "code": "<machine_code>" }`.
**One exception:** a `404` on `GET /scan/{id}` and `GET /scan/{id}/preferences` returns
`{ "ok": false, "status": "unknown", … }` with **no `code`/`error`** — detect it by the HTTP `404`
together with `status: "unknown"`.

| Code | HTTP | Where | When |
|---|---|---|---|
| `unauthorized` | 401 | all authed | Missing / invalid `Authorization: Bearer` key. |
| `bad_input` | 400 | POST | Missing `name` / `email` / location. |
| `consent_required` | 403 | POST | `consentAttestation` was `false`. |
| `scan_start_failed` | 502 | POST | Upstream deep research could not start. |
| `not_found` | 404 | stream | Scan id not owned by this key (returned as JSON before the stream opens). |
| *(none)* | 404 | GET, preferences | Unknown / unowned scan id → `{ "ok": false, "status": "unknown" }` (no `code`/`error`). |
| `scan_read_failed` | 500 | GET | Unexpected error reading the scan. |
| `preferences_read_failed` | 500 | preferences | Unexpected error reading preferences. |
| `research_failed` | SSE `error` | stream | Deep research failed mid‑stream. |
| `stream_error` | SSE `error` | stream | Unexpected stream error. |

---

## Health & status

`GET /api/v1/health` is **public** (no key) — poll it for a live status of the API and its dependencies.
Human dashboard: **[/docs/status](/docs/status)**.

```json
{
  "ok": true,
  "status": "operational",
  "checkedAt": "2026-07-02T09:12:04.001Z",
  "components": [
    { "id": "api",      "name": "API",             "status": "operational", "description": "Developer API request handling",                 "latencyMs": 0 },
    { "id": "database", "name": "Database",         "status": "operational", "description": "Scan storage & retrieval",                        "latencyMs": 12 },
    { "id": "research", "name": "Research engine",  "status": "operational", "description": "Deep-research dossier (Vertex + Deep Research)",   "latencyMs": 210 },
    { "id": "scrapers", "name": "Profile scrapers", "status": "degraded",    "description": "Public-profile scrapers — 4/5 sources operational","latencyMs": 180 }
  ]
}
```

- **`status`** (overall and per component): `operational` · `degraded` · `down`.
- **HTTP:** `200` when operational/degraded, `503` when a **critical** component (`database` or `research`) is down.
- Cached **~30s** server-side; no auth, CORS-open — safe to hit from a browser or an external monitor.
- `scrapers` is non-critical: a degraded/down scraper only reduces scrape depth; scans still run on the public web.

---

## Quickstart

```bash
# 1) Start a scan (URLs scraped during this call → contracts come back in the 202)
curl -s https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Sundar Pichai",
    "email": "subject@example.com",
    "zipCode": "94040",
    "instagramUrl": "https://www.instagram.com/sundarpichai/",
    "linkedinUrl":  "https://www.linkedin.com/in/sundarpichai/"
  }'
# → { "ok": true, "scanId": "…", "links": { "stream": "…", "preferences": "…" }, "profiles": { … } }

# 2a) Stream live: progress → dossier → preferences → done
curl -sN https://one.hushh.ai/api/v1/scan/<scanId>/stream -H "Authorization: Bearer $ONE_API_KEY"

# 2b) …or poll instead
curl -s https://one.hushh.ai/api/v1/scan/<scanId> -H "Authorization: Bearer $ONE_API_KEY"
```

Same flow in JavaScript (`fetch`):

```js
const KEY = process.env.ONE_API_KEY;
const auth = { Authorization: `Bearer ${KEY}` };

// 1) start
const started = await fetch("https://one.hushh.ai/api/v1/scan", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Sundar Pichai",
    email: "subject@example.com",
    zipCode: "94040",
    instagramUrl: "https://www.instagram.com/sundarpichai/",
  }),
}).then((r) => r.json());

// 2) poll until completed (or stream the SSE endpoint instead)
let scan;
do {
  await new Promise((r) => setTimeout(r, 10_000));
  scan = await fetch(`https://one.hushh.ai${started.links.self}`, { headers: auth }).then((r) => r.json());
} while (scan.status === "running");

console.log(scan.result.summary, scan.preferences.status);
```

---

## Guarantees

- **Same engine as one.hushh.ai** — two‑phase deep research + the v5 preference layer (per‑image reads →
  6 sections + lifestyle). Nothing is stripped.
- **Privacy** — only public/visible content is used; sensitive traits (health, religion, politics, skin
  tone) are never inferred; other people in photos are never identified.
- **Isolation** — each subject is scoped to its own tenant, so two subjects scanned under one key never
  see each other's preferences.
- **Idempotent reads** — `GET` endpoints are safe to poll; the SSE stream is re‑attachable.

---

**Next:** [Start a scan](/docs/start-a-scan) · [Streaming (SSE)](/docs/api-streaming) ·
[Polling](/docs/polling) · [Preferences & lifestyle](/docs/preferences) · [OpenAPI spec](/docs/openapi)
