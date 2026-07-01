---
name: scraper-health
description: >-
  Smoke-test the four self-hosted social scraper VMs (Instagram, X/Twitter, Threads, LinkedIn) that One's
  scan pipeline depends on, WITHOUT consuming platform rate-limit. Use whenever someone says "test the
  scrapers", "are the scrapers working", "is Instagram/X/Threads/LinkedIn scraper up/down", "check scraper
  health before/after deploy", "did I break prod", or after touching scraper code/VMs. Read-only by default
  (per-VM /health + /session/status) — confirms each VM is up and its logged-in session is usable, and
  diagnoses the common failure (datacenter-IP 429 / logged-out session). Encodes the exact endpoints,
  the secret-project trap, LinkedIn's missing /session/status, how to read the signals, and the fixes.
---

# Scraper health — smoke-test the social scraper VMs

One's scan depth depends on four self-hosted Puppeteer scraper VMs. They are the fragile part: their
logged-in browser sessions expire and their **datacenter IPs get 429-blocked** by the platforms. This skill
checks all four **safely** (read-only — no scrape, so it never consumes rate-limit or risks a ban).

## Topology (memorize the two-project split — easy to get wrong)
- **VMs live in project `hushh-tech-prod`**, zone `us-central1-c`:
  | Service | VM name | Endpoint |
  |---|---|---|
  | Instagram | `instagram-scraper-vm` | `http://35.192.178.122:8080` ⚠️ EPHEMERAL — drifts on VM restart |
  | X / Twitter | `twitter-scraper-vm` | `http://34.27.236.224:8080` |
  | Threads | `threads-scraper-vm` | `http://34.56.201.251:8080` |
  | LinkedIn | `linkedin-scraper-vm` | `https://linkedin-scraper.136.114.82.27.sslip.io` |

  ⚠️ **IG /health 000 is usually a stale IP, NOT a down service.** The reserved static IP
  `instagram-scraper-ip`=`35.192.178.122` is currently DETACHED (RESERVED, not attached); the VM runs on an
  ephemeral IP that changes on restart. The TRUTH is the `one` Cloud Run service's `INSTAGRAM_SCRAPER_URL`
  env (that's what the app actually calls) — or `gcloud compute instances describe instagram-scraper-vm
  --project hushh-tech-prod --zone us-central1-c --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`.
  Durable fix: re-attach the static IP to the VM (delete its ephemeral access-config, add
  `--address=35.192.178.122`) and set `INSTAGRAM_SCRAPER_URL=http://35.192.178.122:8080`. Verify inside the
  VM first: `ssh … curl localhost:8080/health` — 200 there but 000 outside == IP/network, not the service.
- **API-key secrets live in project `hushone-app`** (the One app's project), NOT `hushh-tech-prod`:
  `instagram-scraper-api-key`, `twitter-scraper-api-key`, `threads-scraper-api-key`, `linkedin-scraper-api-key`.
  ⚠️ **Trap:** fetching with `--project hushh-tech-prod` returns empty → 401 "Unauthorized". Always
  `--project hushone-app` for the keys. An empty key length is the tell.

## Endpoints
- `GET /health` — no auth, all four. Just "is the Node server up".
- `GET /session/status` — **Bearer key required**; reports session health. Shapes differ:
  - **Instagram**: rich — `usableForDeepScrape`, `requiresHumanLogin`, `hasSessionId`, `last429At`,
    `cooldownUntil`, `sessionInspection{...}`. This is the gold signal.
  - **X / Threads**: minimal — `{ ok, service, liveBrowser, ... }`. Confirms up + logged-in browser
    attached; does NOT expose deep login-validity (no usableForDeepScrape field).
  - **LinkedIn**: **no `/session/status` endpoint → 404** (older server). Health-only.

## Run it (safe, read-only)
Canonical test profiles: `linkedin.com/in/sundarpichai`, `x.com/sundarpichai`,
`threads.com/@sundarpichai`, `instagram.com/sundarpichai`.

```bash
declare -a SVC=(
  "instagram|http://35.192.178.122:8080|instagram-scraper-api-key"
  "twitter|http://34.27.236.224:8080|twitter-scraper-api-key"
  "threads|http://34.56.201.251:8080|threads-scraper-api-key"
  "linkedin|https://linkedin-scraper.136.114.82.27.sslip.io|linkedin-scraper-api-key"
)
for row in "${SVC[@]}"; do
  IFS='|' read -r name base secret <<< "$row"
  echo "## $name — $base"
  curl -s -m 12 "$base/health" -o /dev/null -w "  /health → HTTP %{http_code}\n"
  KEY=$(gcloud secrets versions access latest --secret="$secret" --project hushone-app 2>/dev/null)  # NOTE: hushone-app
  [ -z "$KEY" ] && { echo "  KEY EMPTY — wrong project? use --project hushone-app"; continue; }
  curl -s -m 15 "$base/session/status" -H "Authorization: Bearer $KEY" -w "\n  [HTTP %{http_code}]\n" | head -c 700
  echo
done
```
Never print the key. Don't paste secrets into chat.

## Interpret
| Signal | Meaning | Verdict |
|---|---|---|
| `/health` 200 | Node server up | needed, not sufficient |
| IG `usableForDeepScrape:true` + `hasSessionId:true` | logged-in, can deep-scrape | ✅ PASS |
| IG `usableForDeepScrape:false` / `requiresHumanLogin:true` / `hasSessionId:false` | logged out | 🔴 needs noVNC re-login |
| IG `last429At` recent / `cooldownUntil` future / browser login page shows HTTP 429 | datacenter IP rate-limited | 🔴 needs proxy (or cooldown) |
| X/Threads `ok:true, liveBrowser:true` | up + browser attached | 🟡 PASS-ish (login-validity not exposed; confirm via a real scan or a maxPosts=1 probe) |
| LinkedIn `/health` 200, `/session/status` 404 | up; no session endpoint (older server) | 🟡 health-only — confirm via a real scan |
| LinkedIn `/scrape` returns 200 + `fullName`/`title` (e.g. "Sundar Pichai", "CEO at Google") | working | ✅ PASS |
| LinkedIn `/scrape` HTTP 502/000 on a SHORT client timeout | the full-detail scrape (experience/education/skills subpages) is just SLOW — NOT a down signal | ⚠️ retry with a longer timeout / lighter request before calling it down |

## Fixes
- **Logged out (re-login):** `services/<svc>-scraper/scripts/gcp-vm/open-login-browser.sh` (project
  `hushh-tech-prod`, zone `us-central1-c`) → SSH tunnel `-L 6080:localhost:6080 -L 8080:localhost:8080`
  → open `http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080` → log in in the VM's Chrome → leave it open.
- **429 / datacenter-IP block:** the durable fix is residential/mobile **proxy egress** — see
  `services/instagram-scraper/scripts/gcp-vm/proxy-forwarder.mjs` + `SCRAPER_PROXY_URL` (PR #56). A login
  won't even load while the IP is 429'd, so the proxy must come first.

## Optional functional probe (CONSUMES rate-limit — opt-in only, never in a routine health run)
A `maxPosts=1` scrape confirms the end-to-end path for X/Threads/LinkedIn (whose status can't prove
login-validity). Use sparingly; expect Instagram to fail while its IP is 429'd:
```bash
KEY=$(gcloud secrets versions access latest --secret=twitter-scraper-api-key --project hushone-app)
curl -s -m 60 -X POST http://34.27.236.224:8080/scrape -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"url":"https://x.com/sundarpichai","maxPosts":1}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); r=(d.get("results") or [{}])[0]; t=r.get("template") or {}; print("ok",r.get("ok"),"posts",len(t.get("timelineItems") or t.get("recentThreads") or t.get("recentPublicPosts") or []),"access",(r.get("access") or {}).get("state"))'
```

## Safety
Read-only by default. Never run deep scrapes (high `maxPosts`) as a health check — that consumes the
shared rate-limit budget and can trigger bans. Never print API keys. App behavior is unaffected by this skill.
