# SLO & Observability Spec — Hushh One: Xtreme Compute Burst

Defines the SLIs, SLOs, error budgets, logging/tracing/metrics contracts, dashboards, alerts, and cost/capacity guardrails that keep Xtreme Compute Burst fast, recoverable, and free of orphaned GPU spend.

**Status:** Specification — for SE/FDE
**Last updated:** 2026-06-18

---

## 1. Scope & system model

- **Control plane:** Next.js app on Google Cloud Run — service `one`, project `hushone-app`, region `us-central1`. Postgres on Cloud SQL via Prisma. Tracing exports to Cloud Trace via `@google-cloud/opentelemetry-cloud-trace-exporter`.
- **Data plane (cloud path):** ephemeral GCE GPU instance, labeled `hussh-burst`, polled via guest-attributes.
- **Data plane (on-device path):** "puppy" placement, result delivered via callback.
- **Surfaces:**
  - `POST /api/one/burst` — submit; NDJSON stream of frames `start` / `progress` / `done` / `error` / `pending`.
  - `GET /api/one/burst/[id]` — recovery/resume; self-heals a `running` row older than 2h to `failed`.
  - `POST /api/one/burst/[id]/puppy-result` — on-device result callback.
  - `GET /.well-known/agent.json` — A2A discovery.
- **Lifecycle:** placement decision → (cloud) provision GCE GPU → poll guest-attributes (`provisioning` → `running` → `completed`/`failed`) → teardown (`instances.delete`).
- **Teardown invariants:** fires on completion, failure, AND soft-deadline handoff; idempotent (404 = already gone); never throws.
- **Persisted timings (BurstJob row):** `provisionMs`, `runMs`, `totalMs`, `outcome` (`completed` | `completed_via_recovery` | `failed` | `torn_down`), `status`, `createdAt`, `completedAt`.
- **Tunable env knobs:** `ONE_BURST_POLL_INTERVAL_MS`, `ONE_BURST_DEADLINE_MS` (soft deadline ~1,650,000 ms before Cloud Run hard kill), `ONE_BURST_TIMEOUT_MS`, `ONE_BURST_STATUS_TIMEOUT_MS`, `ONE_BURST_RETRIES`, `ONE_BURST_TEARDOWN`.

**Top risks the SLOs defend against:**
1. **Orphaned cloud instances** — a live `hussh-burst` GCE instance with no active BurstJob = runaway, unbounded cost.
2. **Stuck/abandoned jobs** — a `running` row past 2h, self-healed to `failed` by the recovery route.

---

## 2. SLIs & SLOs

All windows are **rolling 28-day** unless noted. p-values are per-day percentiles aggregated over the window. "Good event" definitions drive the log/metric contracts in §5–7.

| # | SLI | Definition (good / valid) | SLO target | Window |
|---|-----|---------------------------|-----------|--------|
| 1 | **Submit availability** | `POST /api/one/burst` returns a `start` frame (HTTP 2xx, stream opened) / all non-precheck-rejected requests | ≥ 99.9% | 28d |
| 2 | **Placement-decision latency** | ms from request receipt to placement decision emitted | p50 ≤ 150 ms · p95 ≤ 400 ms · p99 ≤ 800 ms | 28d |
| 3 | **Time-to-first-progress** | ms from `start` frame to first `progress` frame | p50 ≤ 8 s · p95 ≤ 25 s · p99 ≤ 45 s | 28d |
| 4 | **Provision latency** (`provisionMs`) | ms from `instances.insert` to GCE `running` | p50 ≤ 35 s · p95 ≤ 75 s · p99 ≤ 120 s | 28d |
| 5 | **Burst success rate** | jobs ending `completed` or `completed_via_recovery` / all terminal jobs (excl. user-aborted) | ≥ 99.0% | 28d |
| 6 | **Orphaned-instance rate** | live `hussh-burst` instances with no active BurstJob, age > 15 min, observed by sweep / total sweeps | **target ~0; hard ceiling ≤ 0.1% of sweeps may observe ≥1 orphan**; any single orphan age > 30 min is a hard breach | 7d + instantaneous |
| 7 | **Teardown success rate** | teardown attempts ending succeeded or skipped-idempotent (404) / all teardown attempts | ≥ 99.95% | 28d |
| 8 | **Recovery success rate** | `GET /api/one/burst/[id]` resolving to a correct terminal state (resume to `done`, or clean self-heal to `failed` + teardown) / recovery invocations | ≥ 99.5% | 28d |
| 9 | **Cost-per-successful-burst** | (GCE GPU-seconds × rate) / count(`completed` + `completed_via_recovery`) | ≤ target $/burst (set per GPU SKU; alert on ≥ 1.5× 7d trailing median) | 7d |

**Notes**
- SLI #6 is the most important guardrail: it is the only line item with a *hard ceiling* and an instantaneous component. Orphans cost money every second they live.
- SLI #5 counts `completed_via_recovery` as success — recovery is a feature, not a failure, as long as the user got a result.
- User-aborted streams (client disconnect before `done`) are excluded from #1, #5; they still must trigger teardown (#7).

---

## 3. Error-budget policy

| SLO | 28d budget | Burn-rate alert (fast / slow) | Action on exhaustion |
|-----|-----------|-------------------------------|----------------------|
| Submit availability (99.9%) | 0.1% (~40 min/28d) | 14.4× over 1h / 6× over 6h | Freeze feature deploys |
| Burst success (99.0%) | 1.0% | 14.4× over 1h / 3× over 24h | Freeze + incident |
| Teardown success (99.95%) | 0.05% | 14.4× over 1h | **Page + freeze** (cost-bearing) |
| Orphaned-instance ceiling | none (≈0) | n/a — any sustained breach pages | **Page immediately; halt rollout** |

**What halts rollout (hard gates):**
- Any **orphaned-instance** alert firing, or teardown success-rate budget exhausted.
- Cost-per-successful-burst ≥ 1.5× trailing median for > 2h.
- Burst-success fast-burn (14.4×/1h) active.
- Two consecutive deploys regressing provision-latency p95 by > 25%.

When a hard gate is active: no new revisions to service `one` except a rollback or a fix that directly addresses the breach. Reference the FDE playbook for the rollback procedure.

---

## 4. Golden signals → this system

| Signal | Mapping |
|--------|---------|
| **Latency** | Placement-decision latency; time-to-first-progress; `provisionMs`; `runMs`; `totalMs`; teardown call latency. |
| **Traffic** | Submits/min on `POST /api/one/burst`; concurrent active BurstJobs; in-flight GCE `hussh-burst` instances; recovery GETs/min; puppy callbacks/min. |
| **Errors** | `precheck_failed`, `provision_failed`, `poll_transient_error` rate, `failed` outcomes, `teardown_failed`, deadline handoffs, recovery self-heals. |
| **Saturation** | Regional GPU quota utilization; Cloud Run concurrency/instance count; Cloud SQL connection-pool utilization (Prisma); poll loop count vs. timeout budget. |

---

## 5. Structured-logging event taxonomy

**Format:** single-line JSON via `console.info`/`warn`/`error`. **Common fields on every event:** `event`, `severity`, `burstJobId`, `provider` (`cloud` | `puppy`), `traceId` (Cloud Trace correlation), `ts`.

**Privacy/security — non-negotiable:** NEVER log credential material or PII. No BYOC keys/tokens, no user prompt or result content, no on-device identifiers beyond an opaque `burstJobId`. Log shapes, sizes, durations, and status — not payloads. Redact at the logger boundary.

Italicized fields below are *in addition to* the common fields.

| Event | When | Added fields | Severity |
|-------|------|-------------|----------|
| `one.burst.precheck_failed` | Submit rejected before placement (quota, validation, auth) | *`reason`, `httpStatus`* | WARNING |
| `one.burst.puppy_placement` | Placement chose on-device path | *`deviceClass`, `decisionMs`* | INFO |
| `one.burst.provision_started` | `instances.insert` issued | *`zone`, `machineType`, `gpuType`, `instanceName`, `labels.hussh-burst`* | INFO |
| `one.burst.provision_succeeded` | GCE reached `running` | *`provisionMs`, `instanceName`, `zone`* | INFO |
| `one.burst.provision_failed` | insert errored or never reached `running` | *`reason`, `attempt`, `instanceName`, `zone`* | ERROR |
| `one.burst.poll_transient_error` | Guest-attr poll errored but retried | *`attempt`, `maxRetries`, `reason`, `instanceName`* | WARNING |
| `one.burst.deadline_handoff` | Soft deadline (`ONE_BURST_DEADLINE_MS`) hit; handoff to recovery | *`elapsedMs`, `deadlineMs`, `instanceName`* | WARNING |
| `one.burst.puppy_result` | On-device result callback received | *`runMs`, `resultBytes`, `httpStatus`* | INFO |
| `one.burst.recovery_resume` | `GET /[id]` resumed an in-flight job | *`priorStatus`, `ageMs`* | INFO |
| `one.burst.recovery_dedupe` | Concurrent recovery deduped to one resolver | *`priorStatus`* | INFO |
| `one.burst.recovery_selfheal` | `running` row > 2h healed to `failed` | *`ageMs`, `instanceName`* | WARNING |
| `one.burst.completed` | Terminal success | *`outcome`, `provisionMs`, `runMs`, `totalMs`* | INFO |
| `one.burst.failed` | Terminal failure | *`reason`, `provisionMs`, `runMs`, `totalMs`* | ERROR |
| `one.burst.teardown_succeeded` | `instances.delete` confirmed | *`instanceName`, `zone`, `teardownMs`, `trigger`* | INFO |
| `one.burst.teardown_skipped` | Idempotent no-op (404 / `ONE_BURST_TEARDOWN=0`) | *`instanceName`, `reason`* | INFO |
| `one.burst.teardown_failed` | Delete errored (will retry / sweep will catch) | *`instanceName`, `zone`, `reason`, `attempt`* | ERROR |

`trigger` on teardown ∈ `completion` | `failure` | `deadline_handoff` | `reconciliation_sweep`.

---

## 6. Tracing

Root span per submit: **`one.burst`**. Child spans across the lifecycle:

| Span | Parent | Key attributes |
|------|--------|----------------|
| `one.burst.submit` | root | `burst.id`, `http.route`, `provider`, `placement.decisionMs` |
| `one.burst.placement` | submit | `provider`, `device.class`, `gpu.type` |
| `one.burst.provision` | submit | `gce.instanceName`, `gce.zone`, `gce.machineType`, `gce.gpuType`, `provisionMs` |
| `one.burst.poll` | submit | `poll.intervalMs`, `poll.attempts`, `poll.lastStatus`, `poll.transientErrors` |
| `one.burst.run` | submit | `runMs`, `outcome` |
| `one.burst.teardown` | submit / recovery | `gce.instanceName`, `teardown.trigger`, `teardownMs`, `teardown.idempotent` |
| `one.burst.recovery` | root (GET) | `burst.id`, `recovery.action` (`resume`/`dedupe`/`selfheal`), `ageMs` |

**Correlation contract:** every log line carries `traceId` matching the active Cloud Trace span. Set `burst.id` = `burstJobId` on all spans so trace ↔ log ↔ BurstJob row join on one key. Record exceptions on the span AND emit the matching `*_failed` log. Sample at 100% for failures/recovery; head-sample successes per cost.

---

## 7. Metrics (Cloud Monitoring)

**Log-based metrics** (derived from §5 events):

| Metric name | Type | Source event | Labels |
|-------------|------|--------------|--------|
| `one/burst/submits` | counter | `start` frame emitted | `provider` |
| `one/burst/precheck_failed` | counter | `precheck_failed` | `reason` |
| `one/burst/provision_failed` | counter | `provision_failed` | `zone`, `gpuType`, `reason` |
| `one/burst/poll_transient_error` | counter | `poll_transient_error` | `reason` |
| `one/burst/deadline_handoff` | counter | `deadline_handoff` | — |
| `one/burst/completed` | counter | `completed` | `outcome`, `provider` |
| `one/burst/failed` | counter | `failed` | `reason` |
| `one/burst/teardown_failed` | counter | `teardown_failed` | `zone`, `reason` |
| `one/burst/recovery_selfheal` | counter | `recovery_selfheal` | — |
| `one/burst/provision_ms` | distribution | `completed`/`provision_succeeded` (`provisionMs`) | `gpuType` |
| `one/burst/total_ms` | distribution | `completed` (`totalMs`) | `outcome` |
| `one/burst/teardown_ms` | distribution | `teardown_succeeded` (`teardownMs`) | `trigger` |

**Custom metrics** (written by the control plane / sweep):

| Metric name | Type | Labels | Notes |
|-------------|------|--------|-------|
| `custom.googleapis.com/one/burst/active_jobs` | gauge | `status` | concurrent BurstJobs |
| `custom.googleapis.com/one/burst/live_instances` | gauge | `zone` | count of `hussh-burst` GCE instances |
| `custom.googleapis.com/one/burst/orphan_instances` | gauge | `zone` | live instance, no active BurstJob (from sweep) |
| `custom.googleapis.com/one/burst/orphan_max_age_sec` | gauge | — | age of oldest orphan |
| `custom.googleapis.com/one/burst/gpu_quota_utilization` | gauge | `region`, `gpuType` | from Compute quota API |
| `custom.googleapis.com/one/burst/cost_per_success_usd` | gauge | `gpuType` | rolling estimate |

---

## 8. On-call dashboard panels

1. **Submit availability** (28d SLO + error-budget burndown).
2. **Latency strip:** placement-decision, time-to-first-progress, `provisionMs`, `totalMs` — p50/p95/p99 sparklines.
3. **Burst success rate** with `outcome` breakdown (`completed` vs `completed_via_recovery` vs `failed` vs `torn_down`).
4. **Live vs. active:** `live_instances` overlaid on `active_jobs` — divergence = forming orphans.
5. **Orphan panel:** `orphan_instances` (target line at 0) + `orphan_max_age_sec`.
6. **Teardown health:** success/skip/fail rate by `trigger`; `teardown_ms` distribution.
7. **Recovery:** resume/dedupe/self-heal counts; recovery success rate.
8. **Errors:** stacked `precheck_failed` / `provision_failed` / `poll_transient_error` / `failed` / `teardown_failed` by reason.
9. **Saturation:** GPU quota utilization by region/SKU; Cloud Run instance count & concurrency; Cloud SQL connections.
10. **Cost:** `cost_per_success_usd` vs. 7d median; GPU-hours/day.

---

## 9. Alerts

Every alert names a runbook section in **docs/runbooks/forward-deployed-engineer-playbook.md**.

| Alert | Condition | Severity | Runbook |
|-------|-----------|----------|---------|
| **Orphaned instance** | `orphan_instances` ≥ 1 for > 10 min **OR** any `hussh-burst` GCE instance older than **N=15 min** with no live/active BurstJob (label-scoped sweep) | **PAGE** | Orphan remediation |
| **Orphan age critical** | `orphan_max_age_sec` > 1800 (30 min) | **PAGE** | Orphan remediation |
| **Cost spike** | `cost_per_success_usd` ≥ 1.5× 7d median for > 2h **OR** GPU-hours/day ≥ 2× 7d median | **PAGE** | Cost-spike triage |
| **Teardown failing** | `one/burst/teardown_failed` rate fast-burn (14.4×/1h) | **PAGE** | Teardown failures |
| **Submit availability burn** | 14.4×/1h or 6×/6h on submit SLO | **PAGE** / TICKET | Submit availability |
| **Burst success burn** | 14.4×/1h or 3×/24h on success SLO | **PAGE** / TICKET | Burst failures |
| **Provision latency** | `provision_ms` p95 > 75 s for 30 min | TICKET | Provision latency |
| **Self-heal surge** | `recovery_selfheal` > 3 in 1h | TICKET | Stuck jobs |
| **GPU quota saturation** | `gpu_quota_utilization` > 85% for 15 min | TICKET | Quota |
| **Poll transient surge** | `poll_transient_error` rate > baseline ×5 for 15 min | TICKET | GCE/guest-attr health |

---

## 10. Cost guardrails & reconciliation sweep

**Guardrails:**
- Every provisioned instance is labeled `hussh-burst` at insert — non-negotiable; the label is the only thing that makes orphans findable.
- Teardown is invoked on every terminal path (completion, failure, deadline handoff) and is idempotent + non-throwing.
- Soft deadline (`ONE_BURST_DEADLINE_MS` ≈ 1,650,000 ms) hands off to recovery *before* Cloud Run's hard kill so teardown always runs in-process.
- `ONE_BURST_TEARDOWN=0` is a break-glass only; emits `teardown_skipped` and must trip a dashboard banner.

**Reconciliation sweep (defense-in-depth — the backstop teardown):**
- **Cadence:** every 5 min (Cloud Scheduler → control-plane endpoint or Cloud Run Job).
- **Algorithm:**
  1. `instances.list` filtered to label `hussh-burst` across burst zones.
  2. For each instance, look up the BurstJob by `instanceName`.
  3. **Delete** any instance where: no matching BurstJob row, OR the job is in a terminal state (`completed`/`failed`/`torn_down`), OR the job is `running` but older than the 2h self-heal threshold (and instance age > 15 min grace to avoid racing fresh provisions).
  4. On delete, emit `teardown_succeeded` with `trigger=reconciliation_sweep`; on row mismatch also self-heal the DB.
  5. Update `orphan_instances`, `orphan_max_age_sec`, `live_instances` gauges every run.
- **Safety:** 15-min grace window prevents deleting instances mid-provision. Sweep is idempotent and never throws (404 = already gone). Deletes are logged with full `instanceName`/`zone` for audit.
- **Invariant the sweep enforces:** no `hussh-burst` instance outlives its BurstJob by more than one sweep interval + grace.

---

## 11. Capacity & quota

- **GPU quota (per region):** us-central1 is primary. Track `gpu_quota_utilization` per SKU; alert at 85%. Max concurrent cloud bursts ≤ regional GPU quota ÷ GPUs-per-instance. Pre-provision quota headroom for the 99th-percentile concurrency; request increases before campaigns.
- **Zone spread:** spread `instances.insert` across zones within the region to dodge per-zone stockouts; `provision_failed` with stockout `reason` should trigger zone failover before surfacing an error frame.
- **Cloud Run concurrency:** each in-flight burst holds a request for up to ~`ONE_BURST_DEADLINE_MS` (~27.5 min). Set per-instance concurrency low (long-lived streams starve the event loop) and size `max instances` ≥ peak concurrent bursts. The soft deadline must stay below Cloud Run's request timeout / hard-kill so teardown runs in-process.
- **Cloud SQL (Prisma):** each active job holds connections for polling + writes. Size the pool to peak `active_jobs`; alert on pool-utilization saturation. Recovery GETs must not exhaust the pool under a thundering-herd reconnect.
- **Backpressure:** when GPU quota or Cloud Run max-instances is near saturation, prefer puppy (on-device) placement or return `pending` rather than queueing unbounded provisions.

---

## Related specs

- The white paper — Xtreme Compute Burst (docs/whitepaper-xtreme-compute-burst.md)
- BYOC Security & Privacy spec (docs/specs/byoc-security-privacy.md)
- Forward-Deployed Engineer Playbook (docs/runbooks/forward-deployed-engineer-playbook.md)
