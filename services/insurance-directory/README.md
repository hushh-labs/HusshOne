# insurance-directory

A **24/7 US insurance-producer directory**. It collects **licensed insurance producers /
agents / agencies** from **per-state Departments of Insurance (DOI)**, geo-tags each
licensee by its mailing ZIP against the GeoNames ZIP universe, stores everything in a
clean Cloud SQL (Postgres + PostGIS) database, and **emails a daily progress report** to
the ops team.

It follows the scraper-fleet conventions (Node ESM `.mjs`, `node:http`, Bearer auth, a
`gcp-vm/` deploy, Gmail-SMTP mailer) but has **no browser/login stack** — every working
source is a public open-data file pulled over HTTPS. States without a free bulk source are
wired as **`blocked` adapters** that yield nothing and record *why* + *how to unblock*.

> **Honesty note.** There is **no free national producer file**. The authoritative
> cross-state source is the **NIPR Producer Database (PDB)**, which is **paid / access-gated**
> (not scraped here). Coverage is therefore state-by-state and depends entirely on whether a
> given DOI publishes a free bulk export. Today **Texas is the one fully-working state**;
> WA, CA, FL, NY are honestly flagged `blocked`. See the table below.

## How it works

```
GeoNames US.txt ──(load-zips)──► zips table (~42k rows: ZIP → city/state/centroid)   [geo-reference only]
        │
        └─ (24/7 worker) ── claim next workable state → run its adapter → stream licensee rows
                             → normalize → upsert into producers (geo-tag by ZIP) → stamp
                             state_progress → next state → … → refresh stalest weekly, forever
        ▼
   Cloud SQL (Postgres + PostGIS): producers (data) + state_progress (queue/ledger)
                                   + zips (geo-reference) + email_reports (audit)
        ▼
   Daily report (systemd timer) → email ankit@, manish@, kushal@hushh.ai
```

One row per **`(source_state, license_no)`** — the issuing DOI plus its license number. A
producer licensed in several states appears once per state (that is how each DOI models
it); the **NPN** (National Producer Number) is the cross-state identity when a source
publishes it. Repeated license rows for the same licensee **merge** on upsert
(`license_types` / `lines_of_authority` / `sources` are unioned; scalars `COALESCE`d).

`blocked` states are marked once at worker startup and **never claimed** by the loop
(re-running them can't help until their adapter gains a real source), so they stay honest
in `/status` and the report without burning cycles.

## Data sources (per state — the honest table)

| State | Kind | Source | Reality |
|---|---|---|---|
| **TX** | `download` ✅ | data.texas.gov (Socrata) — individuals `kxv3-diwf`, agencies `3yqc-fcdt` | **Works.** Full TDI licensee data as public CSV/JSON, no key, no CAPTCHA. ~960k individual licenses + agencies. Streamed via SoQL `$limit/$offset`. |
| WA | `blocked` | fortress.wa.gov/oic/consumertoolkit/Search.aspx | Interactive ASP.NET consumer lookup only (viewstate/per-query form posts, no bulk export). data.wa.gov has no OIC licensee dataset. |
| CA | `blocked` | interactive.web.insurance.ca.gov | Interactive per-record license inquiry only. data.ca.gov (CKAN) checked — no CDI producer dataset. |
| FL | `blocked` | licenseesearch.fldfs.com | Interactive licensee search only; a bulk file exists **only via a paid DFS data request**, not a free download. |
| NY | `blocked` | myportal.dfs.ny.gov | Interactive DFS Portal lookup only. data.ny.gov has no DFS producer licensee dataset. |

**Unblock path for any `blocked` state:** the paid **NIPR Producer Database (PDB)**, or an
official **public-records / data-file request** to that state's DOI (PRA in CA, FOIL in NY,
public-records request in WA/FL). Per project policy this service does **not** build
brittle viewstate/CAPTCHA-bypass scrapers.

### Adding a state (the entire extension surface)

Create `scripts/lib/adapters/<code>.mjs` exporting one object and register it in
`scripts/lib/adapters/index.mjs` (`ALL`):

```js
export const XX = {
  code: "XX",
  label: "State DOI (source description)",
  kind: "download",          // 'download' | 'api' | 'search' | 'blocked'
  datasets: ["https://…"],   // citable source URLs ([] for blocked)
  note: "…",                 // REQUIRED for kind:'blocked' — why + unblock path
  async *records({ log, fetchImpl }) {
    // yield normalized producer records (see scripts/lib/producers.mjs)
  },
};
```

A `download` adapter wires a real open-data CSV (copy `tx.mjs`, which uses the reusable
Socrata pager in `scripts/lib/socrata.mjs`); a `blocked` adapter yields nothing and
explains the unblock path (copy `wa.mjs`). Map raw rows onto the normalized producer shape
with the helpers in `producers.mjs` (`normalizeProducer`, `splitName`,
`statusFromExpiration`, `toList`).

## Layout

```
server.mjs            # node:http control API: GET /health (open), GET /status, POST /run (Bearer)
worker.mjs            # the 24/7 collection loop (--limit N / --once for local runs)
schema.sql            # PostGIS + producers + state_progress + zips + email_reports
scripts/
  apply-schema.mjs    # apply schema.sql via pg (no psql needed)
  load-zips.mjs       # GeoNames US.txt → zips geo-reference table
  report.mjs          # daily email (--dry-run / --to a@b.com)
  lib/
    config.mjs        # env-driven config (secrets never printed)
    db.mjs            # pg pool, upsertProducer, per-state work queue, getProgress
    producers.mjs     # normalize raw rows → one producer shape (+ TX row mappers)
    socrata.mjs       # reusable Socrata .csv pager (SoQL $limit/$offset + backoff)
    csv.mjs           # zero-dep RFC-4180 CSV parser
    zip.mjs           # ZIP validation + GeoNames parsing (shared fleet lib)
    mailer.mjs        # Gmail SMTP over node:tls (shared fleet lib)
    pipeline.mjs      # runStateAdapter: stream one adapter → upsert → counts
    adapters/         # index.mjs (registry) + tx.mjs (working) + wa/ca/fl/ny.mjs (blocked)
    *.test.mjs        # unit tests (pure, fixtures only — no DB/network)
  gcp-vm/             # deploy-gcp-vm.sh, run-now.sh, test-vm-api.sh
inputs/               # GeoNames US.txt lands here on the VM (git-ignored; not committed)
```

## Local development

```bash
npm install
npm test                         # unit tests (no DB/network needed)
```

Full local run against a throwaway PostGIS:

```bash
docker run -d --name insurance-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=insurance \
  -p 5432:5432 postgis/postgis:16-3.4
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=insurance PGUSER=postgres PGPASSWORD=pw
node scripts/apply-schema.mjs

# ZIP geo-reference (download GeoNames first: needs `unzip`)
curl -fsSL -o /tmp/US.zip https://download.geonames.org/export/zip/US.zip
unzip -o /tmp/US.zip US.txt -d inputs/
node scripts/load-zips.mjs                        # ~42k rows

# Collect Texas only, capped for a quick smoke test
INSURANCE_STATES=TX INSURANCE_MAX_RECORDS_PER_STATE=5000 node worker.mjs --once
node scripts/report.mjs --dry-run
```

## Environment

| var | purpose |
|---|---|
| `PORT` | API port (default 8080, loopback on the VM) |
| `SCRAPER_API_KEY` | Bearer key for `/status` and `/run` |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Postgres (via Cloud SQL proxy on the VM) |
| `INSURANCE_STATES` | CSV of target states in run order (default `WA,CA,TX,FL,NY`) |
| `SOCRATA_APP_TOKEN` | optional — raises the anonymous Socrata throttle ceiling |
| `INSURANCE_MAX_RECORDS_PER_STATE` | cap rows/state for smoke runs (default: full dataset) |
| `GMAIL_USER` `GMAIL_APP_PASSWORD` | Gmail SMTP creds (shared hushh-tech Gmail app password) |
| `GMAIL_SENDER_EMAIL` | send-as address (default: the authenticated `GMAIL_USER`; set only to a verified alias) |
| `GMAIL_FROM_NAME` | display name (default `Hushh Insurance Directory`) |
| `REPORT_RECIPIENTS` | CSV (default `ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai`) |

Worker pacing tunables (`INSURANCE_WORKER_STATE_GAP_MS`, `INSURANCE_REFRESH_AFTER_DAYS`,
`INSURANCE_WORKER_MAX_BACKOFF_MS`, `INSURANCE_STALE_RUNNING_MINUTES`, `SOCRATA_PAGE_SIZE`)
have sane defaults in `scripts/lib/config.mjs`.

## Email = Gmail SMTP (the repo's own mechanism)

`scripts/lib/mailer.mjs` sends over **Gmail SMTP + app password** — the same mechanism
`src/lib/notifications/gmail.ts` uses. It talks SMTP directly on `node:tls`
(`smtp.gmail.com:465`, `AUTH LOGIN`), so the service keeps a **single runtime dependency**
(`pg`) — no nodemailer, no service-account/JWT setup. The shared creds live in Secret
Manager as `hushh-tech-gmail-user` / `hushh-tech-gmail-app-password`.

## Cloud SQL setup (shared instance)

This service shares one Cloud SQL instance with the other directories
(`hushh-directories-db`), using its own database `insurance`:

```bash
# One-time (mostly already provisioned): instance + per-service DB + shared app user.
gcloud sql databases create insurance --instance=hushh-directories-db
# App role (shared across the directory services):
gcloud sql users create directories --instance=hushh-directories-db --password=<PW>
# PostGIS: connect once as a cloudsqlsuperuser and run  CREATE EXTENSION IF NOT EXISTS postgis;
# (apply-schema.mjs also tries this, but needs cloudsqlsuperuser to create the extension)
```

Connection name: `hushh-tech-prod:us-central1:hushh-directories-db`.

## Deploy (VM in the fleet)

Prerequisites: the shared Cloud SQL instance above, and Secret Manager secrets for the DB
password plus the shared `hushh-tech-gmail-user` / `hushh-tech-gmail-app-password`. The VM
service account needs `roles/cloudsql.client` + `roles/secretmanager.secretAccessor`.

```bash
cd services/insurance-directory
INSTANCE_CONNECTION_NAME=hushh-tech-prod:us-central1:hushh-directories-db \
  PGDATABASE=insurance PGUSER=directories SECRET_DB_PASSWORD=directories-db-password \
  PROJECT=hushh-tech-prod ZONE=us-central1-c \
  ./scripts/gcp-vm/deploy-gcp-vm.sh
```

The deploy defaults are service-named (`PGUSER=insurance`,
`SECRET_DB_PASSWORD=insurance-db-password`); the command above overrides them to the shared
`directories` role. It creates an `e2-medium` debian-12 VM with a **static egress IP**,
installs Node + the Cloud SQL Auth Proxy, fetches GeoNames, and installs systemd units:

| unit | role |
|---|---|
| `cloud-sql-proxy.service` | Postgres on `127.0.0.1:5432` (Restart=always) |
| `insurance-directory-init.service` | one-shot: apply schema + load ZIP geo-reference |
| `insurance-directory-worker.service` | **the 24/7 collector** (Restart=always) |
| `insurance-directory-api.service` | control/health API on `127.0.0.1:8080` |
| `insurance-directory-report.service` + `.timer` | daily progress email |

**No public firewall rule is opened** — the API is loopback-only.

## Operate

```bash
./scripts/gcp-vm/test-vm-api.sh          # /health + /status + unit states (over SSH)
./scripts/gcp-vm/run-now.sh report       # send the daily email right now
./scripts/gcp-vm/run-now.sh run 3        # claim + collect up to 3 workable states now
./scripts/gcp-vm/run-now.sh state TX     # force-collect one state now

# logs
gcloud compute ssh insurance-directory-vm --zone us-central1-c \
  --command 'sudo journalctl -u insurance-directory-worker -f'
```

Progress query:

```sql
SELECT source_state, count(*) FROM producers GROUP BY source_state ORDER BY 2 DESC;
SELECT state, status, adapter_kind, producers_upserted, last_run_finished_at, note
  FROM state_progress ORDER BY state;
```

## Cost

Open-data collection: **$0** (public CSV over HTTPS; an optional Socrata app token is free
and only raises the throttle ceiling). Cloud SQL `db-custom-1-3840` ≈ $50/mo, shared across
the directory fleet. The only paid path is **unblocking states via NIPR PDB or DOI data
requests**, which is a procurement decision, not a code change.

## Compliance

- **State DOI open data** (e.g. data.texas.gov) is public-record licensing data published by
  the regulator; storable, with source attribution retained per row in `sources`.
- Licensee records are treated as a **refreshable cache** (`last_seen` bumped each pass;
  weekly refresh window). Review each state's terms of use before redistribution.
- `blocked` states are intentionally empty — no scraping around an interactive-only or
  paywalled source.
```
