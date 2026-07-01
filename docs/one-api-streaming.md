# One Developer API — streaming + preferences (v1)

Consume One exactly the way **one.hushh.ai** works: submit a subject, **stream live progress** while the
pipeline runs in parallel, and receive the deep-research dossier **plus** the 6-section preference profile
and v5 lifestyle facts.

- **Base URL:** `https://one.hushh.ai`
- **Auth:** `Authorization: Bearer <YOUR_API_KEY>` on every request (hushh-issued; key-gated).
- **Machine-readable contract:** `GET /api/v1/openapi.json` (OpenAPI 3.1).

---

## Request contract — `POST /api/v1/scan`

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | ✅ | — | Subject's full name. |
| `email` | ✅ | — | Subject's contact email (not identity-matched). |
| `latitude` + `longitude` **or** `zipCode` | ✅ | — | lat/lon → `precise` mode; zip only → `limited`. Neither → `400`. |
| `linkedinUrl` | ⬜ | — | Scraped in parallel; drives professional + preference signal. |
| `instagramUrl` / `xUrl` / `threadsUrl` | ⬜ | — | Any subset; a private/failed profile is reported and skipped, the scan continues. |
| `phone` | ⬜ | — | Footprint enrichment only. |
| `consentAttestation` | ⬜ | `true` | The API-key holder attests authorization. `false` → `403 consent_required`. |
| `socialPreferenceConsent` | ⬜ | `true` | Build the preference/lifestyle layer. `false` → dossier only. |

**Edge cases:** no social URLs → dossier only (preferences `skipped`); all scrapes blocked → dossier still
runs on the public web; deadline hit on the stream → `pending` event and the scan finishes in the
background (re-attach the stream or poll).

```bash
curl -sN https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Sundar Pichai",
    "email": "sundar@example.com",
    "zipCode": "94040",
    "linkedinUrl": "https://www.linkedin.com/in/sundarpichai/",
    "xUrl": "https://x.com/sundarpichai"
  }'
```

```json
{
  "ok": true,
  "scanId": "…",
  "status": "running",
  "links": { "self": "/api/v1/scan/…", "stream": "/api/v1/scan/…/stream", "preferences": "/api/v1/scan/…/preferences" },
  "preferences": { "enabled": true, "status": "running" },
  "profiles": { "linkedin": {…}, "instagram": null, "threads": null, "x": {…} }
}
```

---

## Live progress — `GET /api/v1/scan/{id}/stream` (Server-Sent Events)

`text/event-stream`. Two tracks run in parallel and are multiplexed onto one connection. Re-attachable —
reconnect any time and it resumes from the current state.

| Event | Payload | Meaning |
|---|---|---|
| `start` | `{ scanId, status }` | Stream opened. |
| `progress` | `{ phaseIndex, phase, elapsedMs }` | Research phase advancing. |
| `dossier` | `{ status, result }` | Deep-research result ready (`OneDashboardResult`). |
| `preferences` | `{ status, profile }` | Preference profile — fast-pass first, upgraded to v3 + lifestyle. |
| `ping` | `{ elapsedMs }` | ~7s heartbeat. |
| `done` | `{ scan, preferences }` | Terminal — everything ready. |
| `error` | `{ code, error }` | Terminal — failed. |
| `pending` | `{ reason, scanId, message }` | Terminal — still working; re-attach or poll. |

```bash
curl -sN https://one.hushh.ai/api/v1/scan/$SCAN_ID/stream \
  -H "Authorization: Bearer $ONE_API_KEY"
```

```
event: start
data: {"scanId":"…","status":"running"}

event: progress
data: {"phaseIndex":1,"phase":"Reading what it finds","elapsedMs":12000}

event: dossier
data: {"status":"completed","result":{…}}

event: preferences
data: {"status":"completed","profile":{"sectionSummaries":[…],"lifestyle":{…}}}

event: done
data: {"scan":{…},"preferences":{…}}
```

---

## Poll instead of stream — `GET /api/v1/scan/{id}`

Returns the full result + preferences without SSE. Poll every ~10s until `status` is `completed`/`failed`.

```json
{ "ok": true, "scanId": "…", "status": "completed",
  "result": { "report": "…", "categories": {…} },
  "preferences": { "status": "completed", "profile": {…} } }
```

## Preferences only — `GET /api/v1/scan/{id}/preferences`

The 6-section preference profile + lifestyle facts (`{ ok, scanId, status, preferences }`). Status:
`skipped` (no consent/feed), `running` (building), `completed` (ready).

---

## Errors

Every error is `{ "ok": false, "error": "<message>", "code": "<machine_code>" }`.

| Code | HTTP | When |
|---|---|---|
| `unauthorized` | 401 | Missing/invalid Bearer key. |
| `invalid_input` | 400 | Missing `name`/`email`/location. |
| `consent_required` | 403 | `consentAttestation` was `false`. |
| `not_found` | 404 | Scan id not owned by this key. |
| `scan_start_failed` | 502 | Upstream research could not start. |

A key only ever sees the scans it created.
