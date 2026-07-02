# One Developer API (v1)

The One Developer API runs One's intelligence over HTTP — the same pipeline that powers
[one.hushh.ai](https://one.hushh.ai). Give it a person's identity + public profile URLs; it scrapes each
profile, runs a deep-research dossier, and builds a 6-section **preference profile** with **lifestyle facts**
— and you can **stream the whole thing live** over Server-Sent Events.

- **Base URL:** `https://one.hushh.ai`
- **Auth:** `Authorization: Bearer <YOUR_API_KEY>` on every request (issued by hushh; the API is key-gated).
- **Content type:** `application/json` for requests; responses are JSON, except the stream (`text/event-stream`).
- **Machine-readable spec:** [`GET /api/v1/openapi.json`](https://one.hushh.ai/api/v1/openapi.json) (OpenAPI 3.1).
- **CORS:** enabled for all origins (browser clients welcome; the key is still required).

---

## Quickstart

```bash
# 1) Start a scan
curl -s https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Sundar Pichai",
    "email": "sundar@example.com",
    "zipCode": "94040",
    "instagramUrl": "https://www.instagram.com/sundarpichai/",
    "linkedinUrl": "https://www.linkedin.com/in/sundarpichai/"
  }'
# → { "ok": true, "scanId": "…", "links": { "stream": "/api/v1/scan/…/stream", … }, … }

# 2) Stream live progress → dossier → preferences → done
curl -sN https://one.hushh.ai/api/v1/scan/<scanId>/stream -H "Authorization: Bearer $ONE_API_KEY"

# …or poll instead of streaming:
curl -s https://one.hushh.ai/api/v1/scan/<scanId> -H "Authorization: Bearer $ONE_API_KEY"
```

**Timing:** a scan takes a few minutes (deep research), and the preference/lifestyle layer enriches for
~10–20 minutes after (image analysis). The `stream` gives live progress; polling also works.
> ⏱ The `POST` scrapes each provided URL **synchronously** before returning. For accounts with very large
> timelines this can take up to ~3 minutes — set a generous client timeout on the POST.

---

## Request contract — `POST /api/v1/scan`

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | ✅ | — | Subject's full name. |
| `email` | ✅ | — | Subject's contact email (identity, **not** login-matched). |
| `latitude` + `longitude` **or** `zipCode` | ✅ | — | `lat`+`lon` → `precise` mode; `zipCode` only → `limited`. Neither → `400`. |
| `linkedinUrl` | ⬜ | — | Scraped in parallel; drives professional + preference signal. |
| `instagramUrl` | ⬜ | — | **Best for lifestyle** (photos → brands/colours/places/eyewear). |
| `xUrl` / `threadsUrl` | ⬜ | — | Any subset. A private/failed profile is reported and skipped; the scan continues. |
| `phone` | ⬜ | — | Footprint enrichment only. |
| `consentAttestation` | ⬜ | `true` | By sending a request the API-key holder attests they're authorized to audit this subject. `false` → `403`. |
| `socialPreferenceConsent` | ⬜ | `true` | Build the preference/lifestyle layer. `false` → dossier only. |

**Edge cases**
- No social URLs → dossier only; `preferences.status` = `skipped`.
- A blocked/private/failed scrape → reported in `profiles`, omitted from the scan; the dossier still runs on the public web.
- `consentAttestation: false` → `403 consent_required`; the scan is **not started** (no deep research, no preference layer, nothing stored).
- On the stream, if research is still running at the soft deadline (~27.5 min) it emits `pending` and finishes in the background — re-attach or poll. (If research already finished but the preference layer is still enriching at the deadline, it emits `done` with the best-available preferences instead.)

### Response — `202 Accepted`
```json
{
  "ok": true,
  "scanId": "285d9ef0-774f-45db-b450-669206a0d51f",
  "status": "running",
  "statusUrl": "/api/v1/scan/285d9ef0-…",
  "links": {
    "self": "/api/v1/scan/285d9ef0-…",
    "stream": "/api/v1/scan/285d9ef0-…/stream",
    "preferences": "/api/v1/scan/285d9ef0-…/preferences"
  },
  "preferences": { "enabled": true, "status": "running" },
  "profiles": { "linkedin": { … }, "instagram": { … }, "threads": null, "x": null }
}
```
`profiles` echoes the scraped per-platform contract (or `null` if not provided, or a `{ status }` / `{ access }`
marker if the scrape failed / is gated).

---

## `GET /api/v1/scan/{id}` — poll status + result + preferences

Poll every ~10 s until `status` is `completed` or `failed`.

```json
{
  "ok": true,
  "scanId": "6b8fa49e-…",
  "status": "completed",
  "profiles": { … },
  "result": {
    "scanRunId": "6b8fa49e-…",
    "mode": "limited",
    "source": "deep_research",
    "subject": { "name": "Sundar Pichai", "email": "sundar@example.com" },
    "summary": "This is Sundar Pichai — High confidence — …",
    "report": "# Dossier … (markdown, ~19k chars)",
    "categories": {
      "socials": [ … ], "newsAndMedia": [ … ], "education": [ … ],
      "government": [ … ], "otherFootprints": [ … ], "connectedIdentities": [ … ]
    },
    "citations": [ … ],
    "privateDataEstimation": [ … ],
    "intelligenceVersion": "…"
  },
  "preferences": { "status": "completed", "profile": { … } }
}
```
`result` is the full `OneDashboardResult`. `status`: `running` | `completed` | `failed` | `unknown` (404 body).

---

## `GET /api/v1/scan/{id}/stream` — live progress (Server-Sent Events)

`Content-Type: text/event-stream`. Two tracks run in parallel and are multiplexed onto one connection:
**research** (deep-research phases → dossier) and **preferences** (fast profile → enriched v5 + lifestyle).
Re-attachable — reconnect any time and it resumes from the current state.

```bash
curl -sN https://one.hushh.ai/api/v1/scan/<scanId>/stream -H "Authorization: Bearer $ONE_API_KEY"
```
```
event: start
data: {"scanId":"…","status":"running"}

event: progress
data: {"phaseIndex":0,"phase":"Searching the public web","elapsedMs":7209}

event: dossier
data: {"status":"completed","result":{ …OneDashboardResult… }}

event: preferences
data: {"status":"completed","profile":{ …sections + lifestyle… }}

event: done
data: {"scan":{ … },"preferences":{ "status":"completed","profile":{ … } }}
```

### Event reference
| Event | Payload | Meaning |
|---|---|---|
| `start` | `{ scanId, status }` | Stream opened. |
| `progress` | `{ phaseIndex, phase, elapsedMs }` | Research phase advancing (6 phases). |
| `dossier` | `{ status, result }` | Deep-research result ready (`OneDashboardResult`). |
| `preferences` | `{ status, profile }` | Preference profile — fast pass first, then enriched (v5 + lifestyle). |
| `ping` | `{ elapsedMs }` | Heartbeat (~7 s) — keeps the connection alive during long work. |
| `done` | `{ scan, preferences }` | **Terminal** — everything ready. |
| `error` | `{ code, error }` | **Terminal** — failed. |
| `pending` | `{ reason, scanId, message }` | **Terminal** — still working past the deadline; re-attach or poll. |

Browser example:
```js
const es = new EventSource(`/api/v1/scan/${scanId}/stream`); // add the Bearer header via a proxy/fetch-stream
es.addEventListener("preferences", (e) => render(JSON.parse(e.data).profile));
es.addEventListener("done", () => es.close());
```

---

## `GET /api/v1/scan/{id}/preferences` — preference profile + lifestyle

```json
{
  "ok": true,
  "scanId": "285d9ef0-…",
  "status": "completed",
  "preferences": {
    "version": "2026-06-24.social-preference-questions-v5",
    "generatedAt": "2026-07-01T…",
    "questionCoverage": { "total": 30, "answered": 17, "inferred": 13, "needsConfirmation": 0, "unknown": 0 },
    "sectionSummaries": [
      { "sectionId": "brand_look", "title": "Brand & Look", "answeredCount": 5, "totalCount": 5, "confidence": "medium" }
    ],
    "questionAnswers": [
      {
        "questionId": "look_top_brands",
        "sectionId": "brand_look",
        "prompt": "Which clothing or accessory brands show up most across your photos?",
        "status": "answered",
        "answer": "The most visible brand by a wide margin is Google, appearing frequently on company-branded apparel like t-shirts, vests, and jackets. Other tech brands (Android, Chrome) and event sponsors (McLaren) also appear.",
        "confidence": { "level": "high", "score": 0.9, "rationale": "Google appears 30× under 'brands', 17× under 'logos'; images consistently show Google-branded apparel." },
        "sourceMode": "observed",
        "updatedFrom": "media_pass",
        "mediaEvidenceIds": ["e0feec48…", "b2084d1b…"]
      }
    ],
    "lifestyle": {
      "sampleSize": 144,
      "topBrands":   [{ "value": "Google", "count": 30 }, … ],
      "topColours":  [{ "value": "white", "count": 41 }, { "value": "blue", "count": 32 }, … ],
      "footwear":    [{ "value": "sneakers" }, … ],
      "foods":       [ … ],
      "places":      [{ "value": "Shoreline Amphitheatre", "count": 7 }, { "value": "Googleplex", "count": 3 }, … ],
      "surroundings":[{ "value": "event space" }, … ],
      "timeOfDay":   [{ "value": "afternoon" }, { "value": "morning" }, … ],
      "eyewear":     { "present": 2, "absent": 1, "topStyles": [ … ] },
      "soloVsSocial":{ "solo": 67, "group": 54 },
      "events":      { "events": 5, "casual": 7, "topTypes": [ … ] }
    }
  }
}
```

**The 6 sections** (`sectionId`): `brand_look`, `food_drink`, `travel_places`, `social_vibe`,
`lifestyle_daily`, `mindset_values` — 5 questions each (30 total).

**`status`**: `skipped` (no consent / no feed) · `running` (building — fast pass is available immediately,
lifestyle fills in over minutes) · `completed` (crossed the reveal gate).

**Answer fields:** `status` (`answered` | `inferred` | `needs_confirmation` | `unknown`), `confidence`
(`{ level, score, rationale }`), `sourceMode`, and `updatedFrom` (`fast_text_pass` → `media_pass` once the
image analysis lands).

---

## `GET /api/v1/openapi.json`

Public (no auth) OpenAPI 3.1 document describing every endpoint, the request contract, and the SSE event
schema — import it into Postman/Swagger/codegen.

---

## Errors

Most errors: `{ "ok": false, "error": "<human message>", "code": "<machine_code>" }`.

| Code | HTTP | When |
|---|---|---|
| `unauthorized` | 401 | Missing / invalid `Authorization: Bearer` key. |
| `bad_input` | 400 | Missing `name` / `email` / location. |
| `consent_required` | 403 | `consentAttestation` was `false`. |
| `not_found` | 404 | Scan id not owned by this key — **stream endpoint only** (returned as JSON before the stream opens). |
| `scan_start_failed` | 502 | Upstream deep research could not start. |
| `research_failed` | (SSE `error`) | Deep research failed mid-stream. |

> The `404` on `GET /api/v1/scan/{id}` and `GET /api/v1/scan/{id}/preferences` is returned as
> `{ "ok": false, "status": "unknown", … }` **without** a `code`/`error` — match on the HTTP `404` +
> `status: "unknown"`.

**Ownership:** a key only ever sees the scans it created.

---

## Notes & guarantees
- **Same engine as one.hushh.ai:** two-phase deep research (Gemini → Claude synthesis) + the v5 preference
  layer (per-image "pixel" reads → 6 sections + lifestyle). Nothing is stripped.
- **Privacy:** only public/visible content is used; sensitive traits (health, religion, politics, skin tone)
  are never inferred; other people in photos are never identified.
- **Isolation:** each subject is scoped separately — two subjects scanned under one key never see each other's
  preferences.
- **Idempotent reads:** `GET` endpoints are safe to poll; the SSE stream is re-attachable.
