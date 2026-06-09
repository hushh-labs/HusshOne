---
name: scan-timings
description: >-
  Report how long One scans take — per user, per scan, and in aggregate — and why
  a scan did or didn't deliver. Use whenever someone asks "how long did this user's
  scan take", "how long is Phase-1 / Phase-2 taking", "why did <user>'s scan get
  stuck / time out / not finish", "what's our time-to-result", "how many scans hit
  the 900s wall", or "show me the scan logs for <email/session>". Encodes the exact
  Cloud Logging queries (the structured one.research.* events + Cloud Run request
  latency) and how to read the durable ScanRun timing columns from the DB, so a
  per-user phase breakdown takes ~10 seconds instead of manual timestamp correlation.
---

# Scan timings — per-user phase breakdown + time-to-result

A scan has two phases, both orchestrated by husshone:
- **Phase-1** = Gemini deep-research-max (polled). The variable bottleneck (~240–530s typical; can exceed 900s).
- **Phase-2** = Opus synthesis (`/v1/synthesize`). Predictable (~30–190s).
- **Time-to-result** = `totalMs` = Phase-1 + Phase-2 + overhead. The headline metric.

The hard ceiling is **900s** (Cloud Run + `maxDuration`); past a soft deadline (840s) the
scan **hands off** to recovery + email instead of being silently killed.

## What's logged (all on service `one`, project `hushone-app`)

Structured `jsonPayload.event` values, all carrying `scanRunId` + (where known) `sessionId` + `email` + `jobId`:
- `one.research.phase1_done` — `{phase1Ms}` (Gemini finished)
- `one.research.synth_ok` / `one.research.synth_failed` — `{phase2Ms}` (Opus synth)
- `one.research.completed` — `{phase1Ms, phase2Ms, totalMs, outcome, source}` (`outcome`: `completed` | `completed_via_recovery`)
- `one.research.deadline` — `{phase1Ms, elapsedMs, at, depth}` (soft-deadline handoff; `at`: `phase1` | `phase2_reserve`)
- `one.research.failed` — `{phase1Ms, elapsedMs, message}`
- `one.ui.*` — funnel events, keyed by `sessionId` (link UI ↔ scan via the shared `sessionId`)

`gcloud` is already authed as `ankit@hushh.ai`. All queries take `--project hushone-app`.

## 1. One user / one scan — phase breakdown

By email (everything that scan logged, newest last):
```bash
gcloud logging read '
resource.type="cloud_run_revision" resource.labels.service_name="one"
jsonPayload.event:"one.research" jsonPayload.email="USER@EXAMPLE.COM"
' --project hushone-app --freshness=7d --limit=50 \
  --format="table(timestamp.date('%m-%d %H:%M:%S'), jsonPayload.event, jsonPayload.phase1Ms, jsonPayload.phase2Ms, jsonPayload.totalMs, jsonPayload.outcome)"
```
By session id (also pulls the user's UI funnel — replace `one.research` with `one.` to include `one.ui.*`):
```bash
gcloud logging read '
resource.type="cloud_run_revision" resource.labels.service_name="one"
jsonPayload.sessionId="ONE_SID"
' --project hushone-app --freshness=7d --limit=80 \
  --format="table(timestamp.date('%H:%M:%S'), jsonPayload.event, jsonPayload.phase1Ms, jsonPayload.phase2Ms, jsonPayload.totalMs, jsonPayload.outcome)"
```
By `scanRunId`: swap the filter for `jsonPayload.scanRunId="<uuid>"`.

Read it as: `phase1_done.phase1Ms` = Gemini time, `synth_ok.phase2Ms` = Opus time,
`completed.totalMs` = time-to-result. A `deadline` row (no `completed`) = handed off →
look for a later `completed` with `outcome=completed_via_recovery` (finished async + emailed).

## 2. Completed scans — time-to-result table (all users)
```bash
gcloud logging read '
resource.type="cloud_run_revision" resource.labels.service_name="one"
jsonPayload.event="one.research.completed"
' --project hushone-app --freshness=3d --limit=100 \
  --format="table(timestamp.date('%m-%d %H:%M'), jsonPayload.email, jsonPayload.phase1Ms, jsonPayload.phase2Ms, jsonPayload.totalMs, jsonPayload.outcome)"
```

## 3. Aggregate SLO — p50/p90 time-to-result + % within the wall
Pull `totalMs` and compute locally (no Log Analytics needed):
```bash
gcloud logging read '
resource.type="cloud_run_revision" resource.labels.service_name="one"
jsonPayload.event="one.research.completed"
' --project hushone-app --freshness=7d --limit=500 --format="value(jsonPayload.totalMs)" \
| sort -n | awk '{a[NR]=$1} END{if(!NR){print "no data";exit} print "n="NR" p50="a[int(NR*0.5)]"ms p90="a[int(NR*0.9)]"ms max="a[NR]"ms"}'
```
Delivery rate within the wall (completed vs deadline) over a window:
```bash
C=$(gcloud logging read 'resource.labels.service_name="one" jsonPayload.event="one.research.completed"' --project hushone-app --freshness=3d --limit=1000 --format="value(jsonPayload.scanRunId)" | wc -l)
D=$(gcloud logging read 'resource.labels.service_name="one" jsonPayload.event="one.research.deadline"'  --project hushone-app --freshness=3d --limit=1000 --format="value(jsonPayload.scanRunId)" | wc -l)
echo "completed=$C deadline-handoffs=$D"
```

## 4. Slow / killed scans (the 900s wall)
Initial heavy POST latency — anything ≥ ~840s is at/over the wall (a raw `~901s` with no
`deadline` event means it predates this fix or was hard-killed):
```bash
gcloud logging read '
resource.type="cloud_run_revision" resource.labels.service_name="one"
httpRequest.requestUrl="https://one.hushh.ai/api/one/research"
' --project hushone-app --freshness=3d --limit=60 \
  --format="value(timestamp.date('%m-%d %H:%M'), httpRequest.status, httpRequest.latency)"
```
Handoffs (graceful, post-fix) with where they bailed:
```bash
gcloud logging read '
resource.type="cloud_run_revision" resource.labels.service_name="one"
jsonPayload.event="one.research.deadline"
' --project hushone-app --freshness=3d --limit=50 \
  --format="table(timestamp.date('%m-%d %H:%M'), jsonPayload.email, jsonPayload.at, jsonPayload.phase1Ms)"
```

## 5. Phase-2 from the DR side (cross-check)
Opus synth latency lives on the `deep-research-api` service (project `hushh-tech-uat`, `asia-south1`):
```bash
gcloud logging read '
resource.type="cloud_run_revision" resource.labels.service_name="deep-research-api"
httpRequest.requestUrl:"/v1/synthesize"
' --project hushh-tech-uat --freshness=3d --limit=25 \
  --format="value(timestamp.date('%m-%d %H:%M'), httpRequest.status, httpRequest.latency)"
```

## 6. Durable per-user record in the DB
Timings are also persisted on `ScanRun` (`phase1Ms`, `phase2Ms`, `totalMs`, `outcome`,
`deepResearchJobId`, `sessionId`) for all users — survives log retention. Needs prod
`DATABASE_URL` (don't print it):
```sql
SELECT s.id, u.email, s."createdAt", s.status, s.outcome, s."phase1Ms", s."phase2Ms", s."totalMs"
FROM "ScanRun" s JOIN "OneUser" u ON u.id = s."userId"
WHERE u.email = 'USER@EXAMPLE.COM'
ORDER BY s."createdAt" DESC LIMIT 20;
```
> Columns ship via the `20260609222540_scan_timings` migration (idempotent
> `ADD COLUMN IF NOT EXISTS`). Until it's applied, the columns read NULL and the
> structured logs above are the source of truth (code degrades gracefully).

## Baseline (confirm against after a few days)
Today: time-to-result ≈ **5.5–13 min** for successes, **Phase-1 ≈ 70–85%** of it,
**~36%** of scans exceeded the wall (now handed off + emailed instead of dying).
