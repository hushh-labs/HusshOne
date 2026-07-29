# ria-directory

A **24/7 US RIA (Registered Investment Adviser) directory builder**. It ingests the
**SEC IAPD / Form ADV compilation feeds** — the public national registry of every
SEC-registered investment adviser **firm** and **individual** — geo-tags each firm to its
main-office ZIP, stores everything in a clean Cloud SQL (Postgres + PostGIS) database, and
**emails a daily progress report** to the ops team.

Unlike the sibling `hotel-scraper`, this is a **bulk registry ingest, not a per-ZIP
crawl**. There is no work queue and no outward spiral: the worker downloads the newest
compilation, stream-upserts it, then sleeps and re-checks (roughly monthly). It follows
the same fleet conventions (Node ESM `.mjs`, `node:http`, Bearer auth, `gcp-vm/` deploy,
Gmail-SMTP mailer) and has **no browser/login stack** — adviser data is public.

## How it works

```
GeoNames US.txt ──(load-zips)──► zips table (~42k rows, geo-reference only)
        │
SEC Form ADV / IAPD compilation ──(discover → download → stream-ingest)──►
   ├─ firm feed      → firms    (crd PK, name, address, AUM, employees, geog ← ZIP join)
   └─ individual feed→ advisers (crd PK, name, current firm, address, geog ← ZIP join)
        ▼
   Cloud SQL (Postgres + PostGIS): firms + advisers + zips + ingest_runs + email_reports
        ▼
   Daily report (systemd timer) → email ankit@, manish@, kushal@hushh.ai
```

The `zips` table is purely a **geo-reference**: a firm/adviser row copies `lat`/`lng` from
`zips` by its main-office ZIP so it gets a PostGIS `geog` point for spatial queries. Nothing
is ordered by distance-from-Kirkland (that column is retained only so `zip.mjs` /
`load-zips.mjs` stay byte-for-byte shared across the fleet).

Idempotency: every upsert is `ON CONFLICT (crd) DO UPDATE` with `COALESCE` (new non-null
values win, old ones are preserved) and a `sources` array union. Re-ingesting the same
compilation is a no-op; a kill/restart resumes cleanly. `ingest_runs` is the freshness
ledger the worker consults to decide "is a newer compilation available?".

## ⚠️ Source-format reality (read before trusting the ingest)

The task brief describes the compilation as **CSV**. The SEC's **live** Investment Adviser
feeds are in fact **gzipped / zipped XML**, discovered via a reports manifest:

```
IA_FIRM_SEC_Feed_MM_DD_YYYY.xml.gz    (firms — gzip)
IA_INDVL_Feed_MM_DD_YYYY.xml.zip      (individuals — zip container)
```

This service is built to the brief (a full CSV pipeline: quoted-field parser, header-alias
mapping, firm/adviser mappers, all unit-tested) **and** is honest about the discrepancy:

1. `downloadToFile()` is **format-aware** — it transparently **gunzips** a `.gz`, and writes
   a `.zip` as-is flagging `needsUnzip` (Node has no built-in zip-container extraction; the
   deploy/init step unzips it, exactly like GeoNames `US.zip`).
2. `ingestCsvFile()` has an **XML guard** (`looksLikeXml`): it peeks the first bytes and
   **refuses to parse XML as CSV**, failing loudly into `ingest_runs.error` rather than
   silently corrupting the tables.

**What still needs doing on the VM (TODO / risk):**

- **Verify the discovery URLs.** `discoverLatestCompilationUrls()` tries, in order: the
  **manifest JSON** (`CompilationReports.manifest.json`), an **HTML scrape** of the
  compilation index, then a **dated static-path fallback** which is returned
  `verified:false`. The exact manifest shape, filenames, and daily date stamp were **not
  reachable to confirm from the build environment** and must be checked live (the SEC index
  is an Angular app; direct fetches were blocked here). Run `run-now.sh ingest` on the VM
  and read the `ingest.discovered` log line.
- **Add an XML→rows path (or a CSV export).** Once a real feed is confirmed to be XML, add
  an XML streaming parser feeding the same `mapAdvRowToFirm` / `mapAdvRowToAdviser` shape,
  or point the worker at a converted CSV via `--firms-file` / `--individuals-file`. The
  `.zip` individual feed also needs the init-step unzip wired to re-invoke the worker with
  the extracted path (the hook + log hint are already in `runIngestCycle`).

## Layout

```
server.mjs            # node:http control API: GET /health (open), GET /status, POST /run (Bearer)
worker.mjs            # the 24/7 ingest loop (--once / --force / --firms-file / --individuals-file)
schema.sql            # PostGIS + zips + firms + advisers + ingest_runs + email_reports
scripts/
  apply-schema.mjs    # apply schema.sql via pg (no psql needed)
  load-zips.mjs       # GeoNames US.txt → zips geo-reference table
  report.mjs          # daily email (--dry-run / --to a@b.com)
  lib/                # config, db, zip, adv, pipeline, report-render, mailer (+ *.test.mjs)
  gcp-vm/             # deploy-gcp-vm.sh, run-now.sh, test-vm-api.sh
inputs/.gitkeep       # US.txt + SEC feeds are fetched at deploy/run time (never committed)
```

Test boundary: the pure, unit-tested modules (`adv.mjs`, `report-render.mjs`, `zip.mjs`,
`mailer.mjs`) import only `config.mjs` + node builtins, so `node --test` needs **no `pg`**
and **no network** (discovery/download are tested with injected `fetchImpl` fixtures). The
DB/network glue lives in `db.mjs` + `pipeline.mjs`, which are not unit-tested.

## Local development

```bash
npm install
npm test                         # unit tests (no DB / no network)
```

Full local run against a throwaway PostGIS:

```bash
docker run -d --name ria-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=ria \
  -p 5432:5432 postgis/postgis:16-3.4
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=ria PGUSER=postgres PGPASSWORD=pw
node scripts/apply-schema.mjs

# ZIP geo-reference (download GeoNames first: needs `unzip`)
curl -fsSL -o /tmp/US.zip https://download.geonames.org/export/zip/US.zip
unzip -o /tmp/US.zip US.txt -d inputs/
node scripts/load-zips.mjs       # expect ~42k rows

# Ingest a CSV export you control (bypasses discovery). See the format note above.
node worker.mjs --firms-file inputs/firms.csv --individuals-file inputs/individuals.csv --once
node scripts/report.mjs --dry-run
```

## Environment

| var | purpose |
|---|---|
| `PORT` | API port (default 8080, loopback on the VM) |
| `SCRAPER_API_KEY` | Bearer key for `/status` and `/run` |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Postgres (via Cloud SQL proxy on the VM) |
| `GMAIL_USER` `GMAIL_APP_PASSWORD` | Gmail SMTP creds (shared hushh-tech Gmail app password) |
| `GMAIL_SENDER_EMAIL` | send-as address (default: the authenticated `GMAIL_USER`; set only to a verified alias) |
| `REPORT_RECIPIENTS` | CSV (default `ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai`) |

Optional tunables (`SEC_COMPILATION_MANIFEST_URL`, `SEC_REPORTS_BASE_URL`,
`SEC_FIRM_FILE_PATTERN`, `SEC_INDIVIDUAL_FILE_PATTERN`, `RIA_REFRESH_AFTER_DAYS`,
`RIA_CHECK_INTERVAL_MS`, …) have sane defaults in `scripts/lib/config.mjs`.

## Email = Gmail SMTP (the repo's own mechanism)

`scripts/lib/mailer.mjs` sends over **Gmail SMTP + app password** — the same mechanism
`src/lib/notifications/gmail.ts` uses. It talks SMTP directly on `node:tls`
(`smtp.gmail.com:465`, `AUTH LOGIN`), so the service keeps a single runtime dependency
(`pg`) — no nodemailer, no service-account/JWT/Workspace setup. The shared creds live in
Secret Manager as `hushh-tech-gmail-user` / `hushh-tech-gmail-app-password`.

## Cloud SQL setup (shared instance)

This service shares one Cloud SQL instance with the other directories
(`hushh-directories-db`), using its own database `ria`:

```bash
gcloud sql databases create ria --instance=hushh-directories-db
gcloud sql users create directories --instance=hushh-directories-db --password=<PW>   # if not already present
# PostGIS: connect once as a cloudsqlsuperuser and run  CREATE EXTENSION IF NOT EXISTS postgis;
# (apply-schema.mjs also tries this, but needs cloudsqlsuperuser to create the extension)
```

Connection name: `hushh-tech-prod:us-central1:hushh-directories-db`.

## Deploy (VM in the fleet)

Prerequisites: the shared Cloud SQL instance above, and Secret Manager secrets
`ria-db-password` plus the shared `hushh-tech-gmail-user` / `hushh-tech-gmail-app-password`.
The VM service account needs `roles/cloudsql.client` + `roles/secretmanager.secretAccessor`.

```bash
cd services/ria-directory
INSTANCE_CONNECTION_NAME=hushh-tech-prod:us-central1:hushh-directories-db \
  PGDATABASE=ria PGUSER=directories SECRET_DB_PASSWORD=ria-db-password \
  PROJECT=hushh-tech-prod ZONE=us-central1-c \
  ./scripts/gcp-vm/deploy-gcp-vm.sh
```

The deploy creates an `e2-medium` debian-12 VM with a static egress IP, installs Node + the
Cloud SQL Auth Proxy, fetches GeoNames, and installs systemd units:

| unit | role |
|---|---|
| `cloud-sql-proxy.service` | Postgres on `127.0.0.1:5432` (Restart=always) |
| `ria-directory-init.service` | one-shot: apply schema + load ZIP geo-reference |
| `ria-directory-worker.service` | **the 24/7 Form ADV ingest worker** (Restart=always) |
| `ria-directory-api.service` | control/health API on `127.0.0.1:8080` |
| `ria-directory-report.service` + `.timer` | daily progress email |

**No public firewall rule is opened** — the API is loopback-only.

## Operate

```bash
./scripts/gcp-vm/test-vm-api.sh          # /health + /status + unit states (over SSH)
./scripts/gcp-vm/run-now.sh report       # send the daily email right now
./scripts/gcp-vm/run-now.sh ingest       # run an ingest cycle now (discover + ingest latest)
./scripts/gcp-vm/run-now.sh ingest force # force re-ingest even if current

# logs
gcloud compute ssh ria-directory-vm --zone us-central1-c \
  --command 'sudo journalctl -u ria-directory-worker -f'
```

Progress query:

```sql
SELECT count(*) AS firms, count(geog) AS geocoded FROM firms;
SELECT count(*) AS advisers FROM advisers;
SELECT kind, source_file, finished_at, ok, rows_upserted FROM ingest_runs ORDER BY id DESC LIMIT 10;
```

## Compliance

SEC IAPD / Form ADV data is **public record** published by the U.S. SEC. It is freely
storable; the `raw` JSONB keeps each source row verbatim and `last_seen` is bumped on each
refresh so the tables act as a refreshable cache of the public registry.
