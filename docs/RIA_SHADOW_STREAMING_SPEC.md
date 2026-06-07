# RIA Shadow streaming contract (SSE) — spec for `hushh-ria-intelligence-api`

This spec lets the One app show a **real per-source "what's being scanned" feed**
during the ~3.5-min Shadow run, instead of a curated/time-based one. The One side
is already built to consume this (see "One-side relay" below). **Implementing this
is purely additive — the final report must stay byte-identical to today.**

## 1. Endpoint behavior (backward-compatible)
`POST /v1/hushh-shadow/report` (unchanged path, body, `x-api-key`).

- **No `Accept: text/event-stream` header → today's behavior**: one JSON
  `ShadowReportResponse`. Do not change this path.
- **`Accept: text/event-stream` → Server-Sent Events** stream of progress events,
  ending with one terminal `report` event carrying the **exact same**
  `ShadowReportResponse` JSON that the non-streaming path returns.

Rollout is gated on the One side by `ONE_SHADOW_STREAMING=true`, so RIA can ship
this first with zero impact until we flip the flag.

## 2. SSE events
Each event: `event: <type>\ndata: <json>\n\n`.

| event | when | data shape |
|---|---|---|
| `phase` | a pipeline phase starts | `{ "index": 0, "name": "Searching the public web" }` |
| `source` | a source/query is being grounded or read | `{ "title": "github.com", "url": "https://github.com/…", "usedFor": "identity" }` |
| `agent` | an expert model starts/finishes | `{ "name": "vertex_anthropic", "status": "started"\|"completed", "latencyMs": 42170 }` |
| `report` | end — terminal | the full `ShadowReportResponse` (identical to non-streaming) |
| `error` | fatal | `{ "message": "…" }` |

`source` is the important one — it drives the live feed. Emit one per grounding
source/query as it's discovered (a clean title/domain is enough; the One app
resolves/cleans URLs itself).

## 3. Where to emit (hooks already exist)
The pipeline already logs these exact checkpoints — emit an SSE event at the same
spots (these strings are visible in Cloud Logging today):
- `phase` ← at each stage boundary (e.g. "phase-one Gemini discovery completed").
- `source` ← as each grounding source/query in the discovery/sourceMap is found.
- `agent` ← "agent completed agent=vertex_grok model=… latency_ms=…".
- `report` ← when the synthesized report is ready (send the existing response object).

## 4. Hard guarantees
- The `report` event payload == the current non-streaming JSON. No field changes.
- If streaming fails mid-way, send `error` and the One side falls back gracefully.
- Keep the stream alive (a comment heartbeat `: ping\n\n` every ~10s is fine).

## 5. One-side relay (already designed; activate when RIA ships)
In this repo, two small changes activate real streaming (currently the One app
shows a curated feed via `scanningSourceAt` until then):
1. `src/lib/ria/shadow.ts` — add a streaming `fetchShadowReport` variant: send
   `Accept: text/event-stream` when `process.env.ONE_SHADOW_STREAMING === "true"`;
   parse SSE; on `source`/`phase` invoke a callback; on `report` resolve with the
   parsed `ShadowReportResponse` (then map exactly as today).
2. `src/app/api/one/dashboard/route.ts` — pass that callback so each `source`/`phase`
   is forwarded into the existing NDJSON heartbeat as
   `{ type: "progress", stage, elapsedMs, scanning: "<label>" }`.

The client already renders `msg.scanning` (see `CollectionOverlay` /
`OneExperience.runScan`), so **no client change is needed** — the curated label is
simply replaced by the real one the moment these events arrive.
