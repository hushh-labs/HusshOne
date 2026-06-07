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
