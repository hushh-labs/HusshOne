# Preferences & lifestyle

Read a subject's 6-section preference profile plus derived lifestyle facts from a scan you started.

`GET /api/v1/scan/{id}/preferences` returns the best-available preference profile for a scan, built by the same layer that powers [one.hushh.ai](https://one.hushh.ai). The fast text pass is available almost immediately after the scan starts; the deeper media and lifestyle analysis fills in over roughly 10–20 minutes as image analysis completes. Reads transparently upgrade from the fast pass to the enriched profile — poll this endpoint (or [stream](/docs/api-streaming)) and the same shape gains detail over time.

- **Base URL:** `https://one.hushh.ai`
- **Auth:** `Authorization: Bearer $ONE_API_KEY` on every request.
- **Ownership:** a key only ever sees scans it created. Each subject is scoped to its own synthetic user, so two subjects scanned under one key never see each other's preferences.

## Request

```bash
curl -s https://one.hushh.ai/api/v1/scan/<scanId>/preferences \
  -H "Authorization: Bearer $ONE_API_KEY"
```

| Parameter | In | Notes |
|---|---|---|
| `id` | path | The `scanId` returned by [`POST /api/v1/scan`](/docs/start-a-scan). |

There is no request body and no query parameters. The endpoint is idempotent and safe to poll.

## Response

`200 OK` with an envelope wrapping the profile:

| Field | Type | Notes |
|---|---|---|
| `ok` | boolean | `true` on success. |
| `scanId` | string | Echoes the requested id. |
| `status` | string | `skipped` \| `running` \| `completed` (see below). |
| `preferences` | object \| null | The preference profile, or `null` when there is nothing to show yet. |

### `status`

| Value | Meaning |
|---|---|
| `skipped` | No preference layer was built — the subject had no social/LinkedIn feed source, or `socialPreferenceConsent` was `false` at scan time. `preferences` is `null`. |
| `running` | The layer is building. The fast text pass is available immediately; the media and lifestyle facts fill in over minutes. `preferences` may be `null` at first, then upgrades in place. |
| `completed` | The profile has crossed the reveal gate (at least 20 of the 30 questions answered or inferred). |

## The preference profile

The `preferences` object carries a `version` string (currently ending in `-v5`, e.g. `2026-06-24.social-preference-questions-v5`), coverage counts, per-section summaries, the 30 individual question answers, and a `lifestyle` object of aggregated facts.

### The 6 sections

Every profile is organised into six sections, five questions each, for 30 questions total.

| `sectionId` | Covers |
|---|---|
| `brand_look` | Clothing, accessories, and visual style. |
| `food_drink` | Food and drink preferences. |
| `travel_places` | Travel and the places that show up. |
| `social_vibe` | Solo vs. social, events, company. |
| `lifestyle_daily` | Everyday routine and surroundings. |
| `mindset_values` | Mindset and values signal. |

### Question answers

Each entry in `questionAnswers` describes one of the 30 questions.

| Field | Type | Notes |
|---|---|---|
| `status` | string | `answered` \| `inferred` \| `needs_confirmation` \| `blocked_by_access` \| `unknown`. |
| `confidence` | object | `{ level, score, rationale }` — a coarse level, a numeric score, and a short explanation. |
| `sourceMode` | string | How the answer was derived (e.g. observed vs. inferred signal). |
| `updatedFrom` | string | `fast_text_pass` on the immediate pass; upgrades to `media_pass` once image analysis lands. |

The `answered` and `inferred` counts together drive the reveal gate: once they reach 20, `status` can report `completed`.

### The `lifestyle` object

Aggregated facts derived from the analysed media. Most list fields are arrays of `{ value, count }` (or just `{ value }` where no count applies), ordered by frequency.

| Field | Shape | Notes |
|---|---|---|
| `sampleSize` | number | How many media items were analysed. |
| `topBrands` | list | Most frequent brands. |
| `topColours` | list | Most frequent colours. |
| `footwear` | list | Footwear seen. |
| `foods` | list | Foods seen. |
| `places` | list | Recurring places. |
| `surroundings` | list | Setting / environment types. |
| `timeOfDay` | list | When photos tend to be taken. |
| `eyewear` | object | `{ present, absent, topStyles }`. |
| `soloVsSocial` | object | `{ solo, group }` counts. |
| `events` | object | Event-type breakdown. |

## Example

A trimmed `completed` response:

```json
{
  "ok": true,
  "scanId": "285d9ef0-774f-45db-b450-669206a0d51f",
  "status": "completed",
  "preferences": {
    "version": "2026-06-24.social-preference-questions-v5",
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
        "answer": "Google appears most by a wide margin on company-branded apparel; other tech brands and event sponsors also show up.",
        "confidence": { "level": "high", "score": 0.9, "rationale": "Google appears repeatedly under brands and logos; images consistently show branded apparel." },
        "sourceMode": "observed",
        "updatedFrom": "media_pass"
      }
    ],
    "lifestyle": {
      "sampleSize": 144,
      "topBrands":   [{ "value": "Google", "count": 30 }],
      "topColours":  [{ "value": "white", "count": 41 }, { "value": "blue", "count": 32 }],
      "footwear":    [{ "value": "sneakers" }],
      "foods":       [],
      "places":      [{ "value": "Shoreline Amphitheatre", "count": 7 }],
      "surroundings":[{ "value": "event space" }],
      "timeOfDay":   [{ "value": "afternoon" }, { "value": "morning" }],
      "eyewear":     { "present": 2, "absent": 1, "topStyles": [] },
      "soloVsSocial":{ "solo": 67, "group": 54 },
      "events":      { "events": 5, "casual": 7, "topTypes": [] }
    }
  }
}
```

## Timing

The fast text pass runs over the already-scraped profiles and is available immediately after the scan starts, so an early read returns partial answers with `updatedFrom: "fast_text_pass"`. The deeper media and lifestyle analysis (per-image reads → the `lifestyle` object and `media_pass` upgrades) fills in over roughly 10–20 minutes. Poll every 10 seconds or so, or subscribe to the `preferences` events on the [stream](/docs/api-streaming) to get each upgrade live.

## Status codes

| HTTP | Body | When |
|---|---|---|
| `200` | `{ ok: true, ... }` | Profile returned (any `status`). |
| `400` | `{ code: "invalid_input" }` | Missing scan id. |
| `401` | `{ code: "unauthorized" }` | Missing or invalid `Authorization: Bearer` key. |
| `404` | `{ ok: false, status: "unknown", preferences: null }` | Scan id not owned by this key. Note there is no `code`/`error` field — match on the `404` plus `status: "unknown"`. |
| `500` | `{ code: "preferences_read_failed" }` | The profile could not be loaded. |

See [Status codes](/docs/status-codes) and [Error handling](/docs/error-handling) for the full reference.

## Related

- [Polling](/docs/polling) — poll `GET /api/v1/scan/{id}` alongside this endpoint.
- [Streaming](/docs/api-streaming) — receive `preferences` upgrades live over SSE.
- [Consent & privacy](/docs/consent-privacy) — what the `socialPreferenceConsent` flag controls and what is never inferred.
