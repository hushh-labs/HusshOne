# healthcare-directory

A **24/7 US healthcare-provider directory builder**. It ingests the **entire NPPES NPI
Registry** — every provider in the United States (**8M+ individuals and organizations**) —
geo-tags each provider by its practice ZIP, stores them in a clean Cloud SQL
(Postgres + PostGIS) database, and **emails a daily progress report** (total providers,
% of US ZIPs covered) to the ops team.

It follows the existing directory-fleet conventions (Node ESM `.mjs`, `node:http`, Bearer
auth, a `gcp-vm/` deploy, Gmail-SMTP mailer, shared Cloud SQL) but is a **bulk-ingest**
service, not a per-ZIP crawler — the NPI Registry ships the whole country as one file, so
there is no outward spiral and no browser/login stack (the data is public domain).

## How it works

```
NPPES index HTML ──(discover)──► newest monthly full ZIP + newest weekly "V2" ZIP
        │                        (regex-parsed hrefs — no filenames are hardcoded)
        ▼
   download → unzip (system `unzip`) → npidata_pfile_*.csv (~9GB unzipped, 8M+ rows)
        │
        ▼
   24/7 worker: STREAM-parse the CSV (flat memory) → map rows → batch upsert
        │        ON CONFLICT (npi); LEFT JOIN zips to fill lat/lng from the ZIP centroid
        ▼
   Cloud SQL (Postgres + PostGIS): providers (data) + zips (geo lookup)
        + ingest_runs (resumability/audit) + email_reports (audit)
        ▼
   Daily report (systemd timer) → email ankit@, manish@, kushal@hushh.ai
```

The worker is **resumable** (each file is recorded in `ingest_runs`; an already-ingested
file is skipped), **idempotent** (`ON CONFLICT (npi) DO UPDATE`, so re-ingesting a file is
safe), and **self-refreshing** (it re-checks the NPPES index daily and ingests any newer
monthly/weekly file automatically).

GeoNames `zips` is loaded verbatim from the fleet's shared loader, ordered by distance from
Kirkland, WA — it is used here purely as the **ZIP → lat/lng** lookup that geo-tags each
provider (there is no per-ZIP work queue in this vertical).

## Data sources

- **NPPES NPI Registry bulk files (PRIMARY)** — `https://download.cms.gov/nppes/NPI_Files.html`.
  A **monthly full-replacement** ZIP (the complete registry) plus **weekly incremental "V2"**
  ZIPs. Public domain, no key, no rate limit. We stream the `npidata_pfile_*.csv` (skipping
  the `*_FileHeader.csv` and the endpoint/othername/pl sidecar files) and never hold it in
  memory. Filenames rotate monthly, so `discoverLatestBulkUrl()` parses the index HTML and
  picks the newest monthly + weekly hrefs.
- **NPI Registry API (SECONDARY, targeted refresh only)** —
  `https://npiregistry.cms.hhs.gov/api/?version=2.1`. It **caps at 1200 results** per query
  (`skip` ≤ 1000 + `limit` ≤ 200), so it **cannot enumerate the country** — it exists only
  to refresh a specific state/ZIP/taxonomy slice between bulk drops (`scripts/api-refresh.mjs`).

Upsert key: `npi` (the 10-digit National Provider Identifier — globally unique by
definition, so no fuzzy dedup is needed). `sources` accumulates `{nppes_bulk, nppes_weekly,
npi_api}` as a provider is seen across feeds.

## Layout

```
server.mjs            # node:http control API: GET /health (open), GET /status, POST /run (Bearer)
worker.mjs            # the 24/7 ingest loop (--once / --no-loop / --csv PATH for local runs)
schema.sql            # PostGIS + zips + providers + ingest_runs + email_reports
scripts/
  apply-schema.mjs    # apply schema.sql via pg (no psql needed)
  load-zips.mjs       # GeoNames US.txt → zips (+ haversine dist from Kirkland)
  ingest.mjs          # bulk ingest CLI (--discover / --csv PATH / --url U --name F --kind)
  api-refresh.mjs     # targeted NPI API refresh CLI (--state / --zip / --taxonomy)
  report.mjs          # daily email (--dry-run / --to a@b.com)
  lib/                # config, db, nppes, npi-api, pipeline, report, zip, mailer (+ *.test.mjs)
  gcp-vm/             # deploy-gcp-vm.sh, run-now.sh, test-vm-api.sh
inputs/US.txt         # GeoNames US ZIP export (fetched on the VM at deploy time)
```

## Local development

```bash
npm install
npm test                         # unit tests (no DB/network needed — fixtures + injected deps)
```

Full local run against a throwaway PostGIS:

```bash
docker run -d --name healthcare-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=healthcare \
  -p 5432:5432 postgis/postgis:16-3.4
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=healthcare PGUSER=postgres PGPASSWORD=pw
node scripts/apply-schema.mjs

# ZIP lookup table (download GeoNames first: needs `unzip`)
curl -fsSL -o /tmp/US.zip https://download.geonames.org/export/zip/US.zip
unzip -o /tmp/US.zip US.txt -d inputs/
node scripts/load-zips.mjs       # expect ~42k rows; Kirkland (98033) dist ≈ 0

# Ingest a bulk file. Discover + download+unzip the newest monthly/weekly (multi-GB):
node scripts/ingest.mjs --discover
# ...or point at a pre-unzipped npidata pfile CSV (no download):
node scripts/ingest.mjs --csv /path/to/npidata_pfile_sample.csv
# Cap rows for a smoke test:
NPPES_MAX_ROWS=5000 node scripts/ingest.mjs --csv /path/to/npidata_pfile_sample.csv

# Targeted API refresh of one slice (bounded to 1200 results):
node scripts/api-refresh.mjs --state WA --taxonomy 207Q00000X

node scripts/report.mjs --dry-run
```

The **worker** is the 24/7 driver used on the VM:

```bash
node worker.mjs --once                 # one refresh cycle, then exit (discover→ingest)
node worker.mjs --csv /path/pfile.csv  # ingest a local CSV once, then loop for newer files
node worker.mjs --no-loop              # initial ingest only, no daily re-check
```

## Environment

| var | purpose |
|---|---|
| `PORT` | API port (default 8080, loopback on the VM) |
| `SCRAPER_API_KEY` | Bearer key for `/status` and `/run` |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Postgres (via Cloud SQL proxy on the VM); `PGDATABASE` defaults to `healthcare` |
| `NPPES_CSV_PATH` | optional pre-unzipped pfile CSV (skips download); empty ⇒ discover+download |
| `NPPES_DOWNLOAD_DIR` | where the monthly/weekly ZIP is downloaded + unzipped (default `./inputs`) |
| `NPPES_MAX_ROWS` | cap rows ingested per file (0 = no cap; for smoke tests) |
| `GMAIL_USER` `GMAIL_APP_PASSWORD` | Gmail SMTP creds (shared hushh-tech Gmail app password) |
| `GMAIL_SENDER_EMAIL` | send-as address (default: the authenticated `GMAIL_USER`; set only to a verified alias) |
| `GMAIL_FROM_NAME` | display name (default `Hushh Healthcare Directory`) |
| `REPORT_RECIPIENTS` | CSV (default `ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai`) |

Optional tunables (`NPPES_INDEX_URL`, `NPPES_BASE_URL`, `NPPES_BATCH_SIZE`,
`HEALTHCARE_REFRESH_CHECK_MS`, `HEALTHCARE_REFRESH_AFTER_DAYS`, `NPI_API_ENDPOINT`, …) have
sane defaults in `scripts/lib/config.mjs`.

## Email = Gmail SMTP (the repo's own mechanism)

`scripts/lib/mailer.mjs` sends over **Gmail SMTP + app password** — the same mechanism
`src/lib/notifications/gmail.ts` uses ("reuses the proven hushh-tech Gmail credentials:
`GMAIL_USER` + `GMAIL_APP_PASSWORD`"). It talks SMTP directly on `node:tls`
(`smtp.gmail.com:465`, `AUTH LOGIN`), so the service keeps a single runtime dependency
(`pg`) — no nodemailer, no service-account/JWT/Workspace setup. The shared creds live in
Secret Manager as `hushh-tech-gmail-user` / `hushh-tech-gmail-app-password`.

## Cloud SQL setup (shared instance)

This service shares one Cloud SQL instance with the other directories
(`hushh-directories-db`), using its own database `healthcare`:

```bash
# One-time (already provisioned): instance + PostGIS-capable databases + app user.
gcloud sql instances create hushh-directories-db --edition=ENTERPRISE \
  --database-version=POSTGRES_16 --tier=db-custom-1-3840 --region=us-central1
gcloud sql databases create healthcare --instance=hushh-directories-db
gcloud sql users create directories --instance=hushh-directories-db --password=<PW>
# PostGIS: connect once as a cloudsqlsuperuser and run  CREATE EXTENSION IF NOT EXISTS postgis;
# (apply-schema.mjs also tries this, but needs cloudsqlsuperuser to create the extension)
```

Connection name: `hushh-tech-prod:us-central1:hushh-directories-db`.

## Deploy (VM in the fleet)

Prerequisites: the shared Cloud SQL instance above, and Secret Manager secrets
`directories-db-password`, plus the shared `hushh-tech-gmail-user` /
`hushh-tech-gmail-app-password`. The VM service account needs `roles/cloudsql.client` +
`roles/secretmanager.secretAccessor`. (No API-key secret — NPPES needs no key.)

```bash
cd services/healthcare-directory
INSTANCE_CONNECTION_NAME=hushh-tech-prod:us-central1:hushh-directories-db \
  PGUSER=directories SECRET_DB_PASSWORD=directories-db-password \
  PROJECT=hushh-tech-prod ZONE=us-central1-c \
  ./scripts/gcp-vm/deploy-gcp-vm.sh
```

The deploy creates an `e2-medium` debian-12 VM with a **60GB boot disk** (room for the
~9GB unzipped pfile) and a static egress IP, installs Node + `unzip` + the Cloud SQL Auth
Proxy, fetches GeoNames, and installs systemd units:

| unit | role |
|---|---|
| `cloud-sql-proxy.service` | Postgres on `127.0.0.1:5432` (Restart=always) |
| `healthcare-directory-init.service` | one-shot: apply schema + load ZIPs |
| `healthcare-directory-worker.service` | **the 24/7 NPPES ingest** (discover→download→stream-upsert→loop; Restart=always) |
| `healthcare-directory-api.service` | control/health API on `127.0.0.1:8080` |
| `healthcare-directory-report.service` + `.timer` | daily progress email |

**No public firewall rule is opened** — the API is loopback-only. (The bulk ingest is done
by the worker itself, so there is no separate `-osm`-style one-shot unit as in hotel-scraper.)

## Operate

```bash
./scripts/gcp-vm/test-vm-api.sh          # /health + /status + unit states (over SSH)
./scripts/gcp-vm/run-now.sh report       # send the daily email right now
./scripts/gcp-vm/run-now.sh refresh      # trigger an NPPES refresh cycle now (POST /run)
./scripts/gcp-vm/run-now.sh worker       # restart the 24/7 ingest worker

# logs
gcloud compute ssh healthcare-directory-vm --zone us-central1-c \
  --command 'sudo journalctl -u healthcare-directory-worker -f'
```

Progress queries:

```sql
SELECT count(*) AS providers FROM providers;
SELECT entity_type, count(*) FROM providers GROUP BY entity_type;
SELECT count(DISTINCT zip) AS zips_covered FROM providers WHERE zip IS NOT NULL;
SELECT source_file, kind, rows_upserted, finished_at
  FROM ingest_runs WHERE ok ORDER BY finished_at DESC LIMIT 5;
```

## Cost

NPPES bulk + weekly + the NPI API are all **$0** (public domain, no key, no quota) — the
only real cost is Cloud SQL `db-custom-1-3840` ≈ $50/mo (shared across the directory fleet)
plus the VM (`e2-medium` ≈ $25/mo) and its boot disk. Egress to download the monthly file
(~1GB compressed) once a month is negligible.

## Compliance

NPPES / NPI Registry data is **public domain** (published by CMS under the HIPAA
Administrative Simplification standard) — freely storable and redistributable, no
attribution required. `raw` retains the source row per provider so field-level provenance
is auditable; `last_seen` is bumped every ingest so the record doubles as a freshness cache.
