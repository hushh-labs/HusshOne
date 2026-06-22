---
name: health-check
description: End-to-end production health/E2E check for one.hushh.ai — tells you with confidence whether the whole stack is up (the app, Phase-1 Deep Research, the preference/intelligence layer, the scrapers, DB, Vertex, and the Cloud Scheduler workers). Use WHENEVER the user asks "is it up / kaise chal rha hai / sab theek hai / health check / e2e test / is prod working / 110% up / kya one.hushh.ai working hai", or after a deploy to confirm everything is green. Runs the live probes and reports per-subsystem status with a single clear verdict.
---

# health-check — is one.hushh.ai 110% up, end to end?

Run the real probes (don't guess) and give a per-subsystem verdict. There are 3 layers; do all 3, then a single verdict.

## 1. App + deep dependency self-check (the harness)

The harness hits the public app AND `/api/internal/health` (which self-checks DB, Vertex, the Deep Research API, and the 4 scraper VMs in parallel). Get the internal token from Secret Manager and run it:

```bash
cd /Users/ankitkumarsingh/Documents/husshone
TOKEN=$(gcloud secrets versions access latest --secret=ONE_INTERNAL_JOB_TOKEN --project hushone-app 2>/dev/null)
ONE_INTERNAL_JOB_TOKEN="$TOKEN" BASE_URL=https://one.hushh.ai node scripts/health-e2e.mjs
```

Reads as a dashboard (● green/yellow/red per check) + a verdict line. Exit 0 = healthy, 1 = a critical dep is down. Critical = app, **database**, **vertex** (the preference-layer brain), **deep_research_api** (Phase-1/2 backbone). Scrapers are non-critical (a down/degraded scraper only reduces scrape depth; Threads is expected degraded until re-login).

If the token secret name differs, find it: `gcloud secrets list --project hushone-app | grep -i internal`.

## 2. Background workers (Cloud Scheduler) — is the preference pipeline actually firing?

The app can't self-check the schedulers; verify they're enabled and their last run succeeded:

```bash
gcloud scheduler jobs list --project hushone-app --location us-central1 \
  --format="table(name.basename(), state, lastAttemptTime, status.code)" 2>&1 | \
  grep -E "one-social-archive|one-preference-recompute|one-media-analyze|one-social-refresh-sweep|vertex-ai-token-refresh|NAME"
```

Healthy = every `one-*` + `vertex-ai-token-refresh` job is `ENABLED` with a recent `lastAttemptTime`. (`status.code` empty/0 = last run ok.)

## 3. Live revision sanity

```bash
gcloud run services describe one --region us-central1 --project hushone-app \
  --format="value(status.latestReadyRevisionName, status.traffic[0].percent)"
```

Confirms which build is serving 100%.

## Optional deeper proof (Phase-1 Deep Research end-to-end)

`/api/internal/health` already proves the Deep Research API + Vertex are reachable (the Phase-1/2 backbone). For a *full* synthetic scan you'd need a real signed-in user; don't run that routinely — the self-check + a recent real user scan in logs is enough. To inspect recent real scans: use the `scan-timings` skill.

## Report format (what to tell the user)

Give a one-line verdict first, then the breakdown:

> **✅ one.hushh.ai — 110% up** (live: `one-00106-rs6`)
> - App: / 200, /docs 200, fresh ✓
> - Phase-1 DR backbone: Deep Research API ✓ · Vertex ✓
> - Preference layer: DB ✓ · Vertex ✓ · recompute/archive schedulers ENABLED + last-run ok ✓
> - Scrapers: IG ✓ · X ✓ · Threads ⚠ (logged out — depth only) · LinkedIn ✓

If anything critical is red, say so plainly and point to the failing subsystem + the likely fix (e.g. scraper relogin via the `scraper-health` skill, scheduler disabled, DB unreachable). Never claim "all good" unless the harness exited 0 AND the schedulers are enabled.
```
