# Observability — one.hushh.ai (end-to-end)

Config-as-code for the production observability of **one.hushh.ai** (Cloud Run
service `one`, project `hushone-app`, region `us-central1`). The upstream Shadow
API (`hushh-ria-intelligence-api`) is observed **without modifying it** — via
trace-context propagation, log-based metrics on its existing logs, and a
`/health` uptime check.

## What's set up

| Layer | Tool | What |
|---|---|---|
| Tracing | Cloud Trace (OTel) | `src/instrumentation.ts` → spans for every request + `fetch` to the Shadow API. `traceparent` propagation stitches one → RIA into one trace. |
| Success logging | Cloud Logging | `one.scan.completed` structured log (scanRunId, source, totalMs, counts, trace id). |
| Metrics | Log-based metrics | `metrics/*.json` — scan count/duration/errors (One) + Shadow duration/5xx (RIA). |
| Dashboard | Cloud Monitoring | `dashboards/one_e2e_dashboard.json` — One + RIA golden signals + scan metrics. |
| Uptime | Cloud Monitoring | `one.hushh.ai/` and RIA `/health` checks (API downtime). |
| Alerting | Cloud Monitoring | `alerts/*.json` — 5xx spikes, scan errors, uptime down → email channel. |
| Error grouping | Error Reporting | auto, from `severity:ERROR` + `stack_trace` in logs. |
| Ad-hoc SQL | Log Analytics | `_Default` bucket analytics + `one_logs` BigQuery link; `queries/*.sql`. |

## Dependency health — what is allowed to page

Two policies, split by whether a human can *do* anything about it.

| Policy | Metric | Fires when | Producer |
|---|---|---|---|
| `[one.hushh.ai] dependency DOWN` | `one_health_dep_down` | a **critical** dep (DB / Vertex / Deep Research) is down ~20 min | `one-health-watchdog`, every 10 min, `?scope=critical` |
| `[one.hushh.ai] scraper session needs human re-login` | `one_scraper_session_blocked` | a scraper VM's browser session is logged out / checkpointed | real scrapes (`source=real_scrape`); idle canary `one-scraper-readiness-sweep` every 6h (`source=readiness_probe`) |

The rules that keep these honest:

- **Scraper VMs never page the dependency alert.** They are `critical: false` — a down scraper reduces
  scrape depth, it does not stop the product serving. `one_health_dep_down` keys on `criticalDown`, *not*
  `summary.down`; `summary` counts scrapers too and is for dashboards only.
- **Liveness and latency are not alertable for scrapers.** The VMs are non-preemptible and stay up for
  months; "unreachable or slow" was ~100% false positives. Only `requiresHumanLogin` pages.
- **The real signal comes from real traffic.** A session dies on the platform's schedule, silently. The
  authoritative detector is the outcome of scrapes users actually waited for (`@/lib/health/session-signal`);
  the 6-hourly canary exists only to cover idle periods with no real scrapes.
- **Probes are rate-limited, not per-sweep.** Each `/session/status` drives a live browser inspection on the
  VM (13–30s), so `@/lib/health/checks` re-probes a healthy scraper every 6h and an unhealthy one every 10 min.

## Reproduce / re-apply

```bash
./observability/setup.sh        # idempotent-ish; safe to re-run (skips existing)
```

App instrumentation ships with the normal deploy:

```bash
gcloud run deploy one --source . --project=hushone-app --region=us-central1
```

## Notes
- Runtime SA `53407187172-compute@developer.gserviceaccount.com` has `cloudtrace.agent` + `editor` + `logging.logWriter`.
- Cloud Trace exporter uses ADC on Cloud Run — no keys.
- Latency SLO must exclude `/api/one/dashboard` (Shadow scans run 40–280s by design).
- Log-based metrics do **not** backfill — they count from creation time onward.
