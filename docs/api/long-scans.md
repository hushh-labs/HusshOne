# Long scans & timeouts

A guide to how long a One scan actually takes, why, and how to set client timeouts so nothing gets cut off.

A single scan spans three stages with very different timescales: the synchronous scrape that runs inside your `POST`, the deep-research dossier that runs for a few minutes after, and the preference/lifestyle layer that keeps enriching for another ~10-20 minutes. This page covers the timing budget for each, the SSE heartbeat and self-close behaviour, and when to stream versus poll.

- **Base URL:** `https://one.hushh.ai`
- **Auth:** `Authorization: Bearer $ONE_API_KEY` on every request.

For the request/response shapes referenced here, see [Start a scan](/docs/start-a-scan), [Streaming](/docs/api-streaming), and [Polling](/docs/polling).

---

## The three timescales

| Stage | Where it runs | Typical duration | How you observe it |
|---|---|---|---|
| Scrape | Inside your `POST /api/v1/scan` | Seconds up to ~3 min for very large timelines | The `POST` blocks until it returns `202` |
| Deep research (dossier) | Background after `202` | A few minutes | `dossier` event / `result` field |
| Preferences + lifestyle | Background, continues after the dossier | ~10-20 min more (image analysis) | `preferences` event / `preferences` field |

The dossier and the preference layer run in parallel, but the preference layer's deep pass (per-image analysis) keeps enriching well after the dossier is done. A fast-pass preference profile is available almost immediately; the enriched version lands minutes later.

---

## The `POST` scrapes synchronously — set a long client timeout

`POST /api/v1/scan` scrapes every profile URL you provide (LinkedIn, Instagram, X, Threads) **before it returns**. It does not return `202` until each provided profile has been fetched via its scraper VM. For accounts with very large timelines this can take up to roughly **3 minutes**.

Set your client's request timeout to **at least 120 seconds**, and prefer ~180 s to be safe for large accounts.

```bash
# Give the POST a generous timeout — it holds the connection open while it scrapes.
curl -s --max-time 180 https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Sundar Pichai",
    "email": "sundar@example.com",
    "zipCode": "94040",
    "instagramUrl": "https://www.instagram.com/sundarpichai/"
  }'
```

```js
// fetch: default has no timeout, but proxies/load balancers do — set one explicitly.
const res = await fetch("https://one.hushh.ai/api/v1/scan", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.ONE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name, email, zipCode, instagramUrl }),
  signal: AbortSignal.timeout(180_000), // 3 minutes
});
```

The server allows up to 300 s (`maxDuration`) for this route, so the scrape itself will not be cut off server-side within the documented window. The constraint is entirely on your side: a short client timeout, or an intermediary proxy with a 30/60 s default, will drop the connection while the scrape is still in progress. Once the `POST` returns `202` with a `scanId`, the deep-research and preference work continues in the background regardless of your connection.

---

## The stream: heartbeat and self-close

`GET /api/v1/scan/{id}/stream` multiplexes both background tracks (research and preferences) onto one Server-Sent Events connection. Because the work is long, the stream is engineered to stay alive and to fail gracefully at a deadline rather than hang indefinitely.

### Heartbeat (`ping`)

The stream emits a `ping` event roughly every **7 seconds**:

```
event: ping
data: {"elapsedMs":21043}
```

The heartbeat runs on its own interval, independent of the research poll loop. This matters because finalizing the dossier (Phase-2 synthesis) can block the poll loop for a stretch — the `ping` keeps the connection from being closed by idle-timeout intermediaries during that window. Treat `ping` as liveness only; it carries no result data.

### Soft deadline (~27.5 min)

The stream self-closes at a soft deadline of **~27.5 minutes** (1,650,000 ms), deliberately short of Cloud Run's 1,800 s request wall. What it emits at the deadline depends on progress:

| Situation at the deadline | Terminal event | What to do |
|---|---|---|
| Research still running | `pending` | Re-attach the stream, or poll `GET /api/v1/scan/{id}` |
| Research finished, preferences still enriching | `done` | Use the best-available preferences; poll `GET /api/v1/scan/{id}/preferences` for the enriched version |

The `pending` payload tells you exactly this:

```
event: pending
data: {"reason":"deadline","scanId":"…","message":"Still working — re-attach this stream or poll GET /api/v1/scan/{id}."}
```

In the normal case the stream reaches `done` well before the deadline — research completes and preferences settle (either `completed` or `skipped`), and the stream emits `done` and closes on its own.

### The stream is re-attachable

You can disconnect and reconnect to `GET /api/v1/scan/{id}/stream` at any time; it resumes from the current state of both tracks. That is what makes `pending` safe to act on — after a `pending`, simply open the stream again and it picks up where it left off. Reads are idempotent, so re-attaching costs nothing.

---

## Terminal events

Every stream ends with exactly one terminal event:

| Event | Meaning | Follow-up |
|---|---|---|
| `done` | Everything ready (or best-available at the deadline). | None — close the connection. |
| `error` | The scan failed (e.g. `research_failed`). | Inspect `code`/`error`; the scan will not complete. |
| `pending` | Still working past the soft deadline. | Re-attach the stream or poll. |

See [Streaming](/docs/api-streaming) for the full event reference and [Error handling](/docs/error-handling) for terminal-error codes.

---

## Stream for UX, poll for batch

Both paths reach the same result — pick by workload:

- **Stream** when a human is waiting on the result (interactive UX). The `progress`, `dossier`, and `preferences` events give live feedback, and the `ping` heartbeat keeps a browser or proxy connection warm.
- **Poll** for batch or server-to-server jobs where you are running many scans and holding open connections is impractical. Poll `GET /api/v1/scan/{id}` on an interval; each response is a snapshot with the current `status`, `result`, and `preferences`. Polling also sidesteps the ~27.5 min stream deadline entirely — a long-running preference layer just shows up on your next poll.

```bash
# Batch pattern: poll the snapshot endpoint on an interval until it settles.
while :; do
  curl -s https://one.hushh.ai/api/v1/scan/$SCAN_ID \
    -H "Authorization: Bearer $ONE_API_KEY"
  sleep 15
done
```

A common hybrid: stream for the dossier (a few minutes), then switch to polling `GET /api/v1/scan/{id}/preferences` for the slower ~10-20 min lifestyle enrichment. See [Polling](/docs/polling) for the snapshot response shape and recommended intervals.

---

## Quick reference

| Concern | Value |
|---|---|
| `POST` client timeout | ≥ 120 s; ~180 s for large timelines |
| `POST` server limit | 300 s |
| Stream heartbeat interval | ~7 s (`ping`) |
| Stream soft deadline | ~27.5 min |
| Stream server limit | 1,800 s (Cloud Run wall) |
| Deep research (dossier) | A few minutes |
| Preferences + lifestyle | ~10-20 min after the dossier |

---

## Related

- [Start a scan](/docs/start-a-scan)
- [Streaming](/docs/api-streaming)
- [Polling](/docs/polling)
- [Error handling](/docs/error-handling)
- [Status dashboard](/docs/status)
