---
name: service-map
description: >-
  The canonical deployment map for One by hussh — every service, WHERE it runs (project / region / VM /
  URL), HOW it's deployed, how to reach/verify it, and which secret lives where. Use whenever someone asks
  "which service is where", "how is X deployed", "what project/region is X in", "what URL does One call for
  Instagram/X/Threads/LinkedIn", "where are the secrets", "the topology / infra map", or before touching any
  prod service so you don't hit the wrong project. Read-only reference. Pairs with: `deploy` (how to ship the
  app), `scraper-health` (test the scraper VMs), `intelligence-release` (the Deep Research pipeline).
---

# Service map — One by hussh

Repo: `/Users/ankitkumarsingh/Documents/husshone`

## ⚠️ The three-project split (the #1 trap)
- **`hushone-app`** — the app (Cloud Run `one`), the DB, ALL secrets, the internal workers + Cloud Scheduler.
- **`hushh-tech-prod`** — the 4 social **scraper VMs** (GCE).
- **`hushh-tech-uat`** — the **Deep Research API** (the intelligence engine).

Your local `gcloud config` default may be `hushh-tech-prod` — **always pass `--project` explicitly.**
Fetching app secrets from `hushh-tech-prod` returns empty → 401 (they're in `hushone-app`).

## 1. Control plane — the app
| | |
|---|---|
| Service | Cloud Run **`one`** |
| Project / region | **hushone-app** / us-central1 |
| URL | https://one.hushh.ai (custom domain) |
| Deploy | `gcloud run deploy one --source . --project hushone-app --region us-central1` — see the **`deploy`** skill (wrong-service trap: it's `one`, NOT `one-hushh-ai`) |
| Verify | `curl -s -o /dev/null -w '%{http_code}' https://one.hushh.ai/` → 200; `gcloud run services describe one --project hushone-app --region us-central1 --format='value(status.latestReadyRevisionName)'` |

## 2. Intelligence — Deep Research API (Phase-1 dossier + Phase-2 synthesis)
| | |
|---|---|
| Where | separate Cloud Run in **hushh-tech-uat** (asia); repo `~/Documents/hushh-deep-research-api` |
| One calls | `DEEP_RESEARCH_API_BASE_URL` (default `https://deep-research-api-bmrh3cdxwa-el.a.run.app`) — the env var is the source of truth |
| Auth | `DEEP_RESEARCH_API_TOKEN` |
| Verify | `curl -s -o /dev/null -w '%{http_code}' https://deep-research-api-bmrh3cdxwa-el.a.run.app/health` → 200 |
| Release | see the **`intelligence-release`** skill (bump INTELLIGENCE_VERSION so returning users re-run) |

## 3. Database
| | |
|---|---|
| Cloud SQL | `hushone-app:us-central1:hushh-identity-pg` (Postgres, via Prisma + Cloud SQL Auth Proxy) |
| Secret | `ONE_DATABASE_URL` (in hushone-app) |

## 4. Background workers (internal routes in the `one` app, drained by Cloud Scheduler in hushone-app)
Guarded by `ONE_INTERNAL_JOB_TOKEN`. Jobs (region us-central1):
- `one-social-archive` (`1-59/3 * * * *`) → `/api/internal/social-archive` — deep-scrape drain (IG/X/Threads + LinkedIn re-enrich)
- `one-preference-recompute` (`*/3 * * * *`) → `/api/internal/preference-recompute`
- `one-media-analyze` (`2-59/3 * * * *`) → `/api/internal/media-analyze`
- `firebase-schedule-pollGmailAllUsers` (15 min), `renewGmailWatches` (24h), `vertex-ai-token-refresh` (`*/50`)

## 5. The 4 social scraper VMs (GCE — **project hushh-tech-prod, zone us-central1-c**)
Each VM = persistent logged-in **Chromium** (CDP `127.0.0.1:9222`) + **Node API** (`:8080`) + Xvfb/x11vnc/**noVNC** (`127.0.0.1:6080`). Deploy: `services/<svc>-scraper/scripts/gcp-vm/deploy-gcp-vm.sh`. Re-login: `open-login-browser.sh` + SSH tunnel + noVNC.

| Service | Code | App route | VM name | One calls (env) | Secret (hushone-app) |
|---|---|---|---|---|---|
| LinkedIn | `services/linkedin-scraper` | `src/app/api/linkedin/enrich-url/route.ts` | `linkedin-scraper-vm` | `https://linkedin-scraper.136.114.82.27.sslip.io` (`LINKEDIN_SCRAPER_URL`) | `linkedin-scraper-api-key` |
| Instagram | `services/instagram-scraper` | `src/app/api/instagram/enrich-url/route.ts` | `instagram-scraper-vm` | `http://35.192.178.122:8080` (`INSTAGRAM_SCRAPER_URL`) | `instagram-scraper-api-key` |
| Threads | `services/threads-scraper` | `src/app/api/threads/enrich-url/route.ts` | `threads-scraper-vm` | `http://34.56.201.251:8080` (`THREADS_SCRAPER_URL`) | `threads-scraper-api-key` |
| X / Twitter | `services/twitter-scraper` | `src/app/api/x/enrich-url/route.ts` | `twitter-scraper-vm` | `http://34.27.236.224:8080` (`TWITTER_SCRAPER_URL`) | `twitter-scraper-api-key` |

Test these with the **`scraper-health`** skill. Known fragility: GCE datacenter IPs get **429-blocked** by the platforms (proxy egress = the fix, PR #56); sessions need periodic noVNC re-login.

## Auth (end users)
Firebase Auth — Google sign-in + guest (Firebase Admin custom token). If Firebase is down, nobody can sign in.

## Two flows to remember
- **Connect (`enrich-url`)**: X/IG/Threads = lightweight **handshake** (normalize → persist → "Connected", NO VM call at connect). LinkedIn = **synchronous** scrape (it's the Phase-1 anchor).
- **Background deep-scrape**: Send One → `one-social-archive` worker calls the scraper VMs (server-side key) → `indexSocialArchive` → preference recompute → dossier preference layer.

## Hard dependencies (if down → impact)
Firebase = total outage; DB = scans don't persist; Deep Research API = no new dossier; scraper VMs = preference depth degrades (dossier still renders). See `scraper-health` for live status.
