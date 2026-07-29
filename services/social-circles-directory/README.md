# social-circles-directory

A **24/7 "who-knows-who" graph builder**. Unlike the other four directory verticals it is
**not a scraper** — it links the people and orgs those directories already collected into a
single **relationship graph**. It reads (read-only) across the four source databases
(**healthcare, ria, insurance, hotel_scraper**) plus the IG / X / Threads social scrapers,
resolves duplicate real-world entities into graph **nodes**, derives **edges** between them
(shared address, same firm, name aliases, social follows/mentions…), and writes the whole
graph to its **own `social` database**. It also **emails one combined daily roll-up** across
all five verticals + the graph to the ops team.

It follows the existing fleet conventions (Node ESM `.mjs`, `node:http` + Bearer auth, one
runtime dep `pg`, Gmail-SMTP mailer, a `gcp-vm/` deploy) but has **no browser/crawler stack**
— all its inputs are other services' databases.

## How it works

```
                    ┌── healthcare DB ─┐
 Cloud SQL Auth     ├── ria DB ────────┤   one pg.Pool PER database
 Proxy (one host)   ├── insurance DB ──┤   (Postgres can't cross-DB query)
                    └── hotel_scraper ─┘
                          │  (+ social scrapers: honest STUB — no shared DB)
                          ▼
     source connectors ── normalize rows → entities
                          ▼
     resolve.mjs ──────── union-find clustering → NODES (persons/orgs)   [pure]
                          ▼
     edges.mjs ────────── derive relationships → EDGES                   [pure]
                          ▼
     `social` DB ──────── persons + person_sources + edges + build_runs
                          ▼
     worker loop: rebuild pass → sleep 6h → rebuild, forever (idempotent upserts)
                          ▼
     daily report (systemd timer) → combined roll-up email → ankit@, manish@, kushal@
```

Every source database lives on the **same shared Cloud SQL instance** and is reached through
the **same** Cloud SQL Auth Proxy on `127.0.0.1:5432` — only the database *name* differs, so
the builder opens a separate small `pg.Pool` per source DB (host/port/user/password shared).
Postgres cannot cross-database query, which is the whole reason this service exists as its own
graph store rather than a view.

## Cross-database architecture (5 DBs, one instance)

| DB | role | primary table | node kind | stable key |
|---|---|---|---|---|
| `healthcare` | source (read-only) | `providers` | person | `npi` |
| `ria` | source (read-only) | `advisers`, `firms` | person / org | `crd` |
| `insurance` | source (read-only) | `producers` | person | `license_no` |
| `hotel_scraper` | source (read-only) | `hotels` | org | `dedup_key` |
| `social` | **this service's own DB** (read/write) | `persons`, `edges`, … | — | `cluster_key` |

Table names are overridable per source (`HEALTHCARE_TABLE`, `RIA_ADVISERS_TABLE`,
`RIA_FIRMS_TABLE`, `INSURANCE_TABLE`, `HOTEL_TABLE`) since the exact upstream schemas are owned
by the sibling services. Connectors read each field from a **list of candidate column names**
and degrade to `null`, so they tolerate reasonable schema drift without fabricating data. A
source table streams through a **server-side cursor** (`DECLARE … FETCH FORWARD`) so a large
table never buffers in memory.

**Resilient to missing sources.** A source DB may be empty (table exists, 0 rows) or entirely
absent (sibling service not provisioned yet). Connectors classify the pg error codes for
"missing database / missing table / can't connect" as *unavailable*, log a line, and return
zero entities — they never throw. A rebuild pass over zero reachable data completes cleanly
(0 nodes, 0 edges) instead of crashing the 24/7 worker.

## Social scrapers: honest STUB (not wired to a graph)

The IG / X / Threads scrapers **have no shared, queryable datastore**: each persists
per-request scrape JSON to *its own VM's local disk*, and the scrape "template" exposes
follower/following **counts, not follower lists** — so from this VM there is nothing to query
and no follow-graph to read. Rather than fabricate social edges, the social connectors are an
honest **stub with a clear ingest interface**: point `SOCIAL_INSTAGRAM_DIR` /
`SOCIAL_TWITTER_DIR` / `SOCIAL_THREADS_DIR` at a directory of exported scrape JSON and it will
be ingested (nodes + `social_follow`/`social_mention` edges when the export includes
follow/mention lists); **unset — the default — yields nothing.** The daily report counts how
many social nodes were actually linked into the graph instead of pretending to count a DB.

> TODO(social): when a central social store exists (a shared `social_raw` DB, or a GCS bucket
> the scrapers export to), replace `readSocialDir` with a real reader. Until then this is
> intentionally empty in production.

## Entity resolution (conservative)

Pure union-find (`scripts/lib/resolve.mjs`) — never merges two distinct people just because
they share a common name.

- **Name key**: lowercase, strip diacritics/punctuation, drop honorifics + credentials +
  generational suffixes (`dr`, `md`, `cfp`, `jr`, `iii`, …) and lone middle initials. Orgs get
  a separate key that strips corporate suffixes (`llc`, `inc`, `pllc`, `associates`, …).
- **Merge rule**: two entities collapse into one node **only** when they share a name key
  **AND** a corroborating discriminator — **same ZIP** *or* **same org**. Name-only overlap
  does **not** merge; it becomes a `name_alias` edge instead (a flagged merge candidate).
- **cluster_key**: a deterministic anchor (`name + smallest discriminator`, else the unique
  source identity) — the idempotency key so a rebuild upserts the same node instead of
  duplicating it. `person_sources` keeps provenance back to every source row
  (`UNIQUE(source_vertical, source_key)`).

## Edge rules

Pure derivation (`scripts/lib/edges.mjs`). Undirected types are normalized `src<dst` and
de-duped; the two social types keep their direction.

| edge_type | when | weight |
|---|---|---|
| `name_alias` | same name key across **≥2 different verticals** (likely same person) | 0.95 |
| `shared_address` | same normalized street **+** ZIP | 0.9 |
| `same_org` | same normalized employer / firm (colleagues, adviser↔firm) | 0.7 |
| `social_follow` | directed, from social export | 0.5 |
| `social_mention` | directed, from social export | 0.3 |
| `same_zip_profession` | same ZIP + same profession bucket (coarse) | 0.2 |

`same_zip_profession` is O(n²) within a ZIP cohort, so groups larger than
`GRAPH_MAX_SAME_ZIP_GROUP` (default 250) are skipped to keep the graph from exploding into a
hairball.

## Layout

```
server.mjs            # node:http control API: GET /health (open), GET /status, POST /run (Bearer)
worker.mjs            # the 24/7 rebuild loop (--once / --interval <seconds>)
schema.sql            # persons + person_sources + edges + build_runs + email_reports
scripts/
  apply-schema.mjs    # apply schema.sql via pg (best-effort CREATE EXTENSION postgis)
  report.mjs          # combined 5-vertical + graph daily email (--dry-run / --to a@b.com)
  lib/
    config.mjs        # env-driven config (source DB names, mail, worker pacing) — no secrets in code
    db.mjs            # `social` DB access + makeSourcePool() for source DBs (owns pg)
    source-connectors.mjs  # pure row mappers + guarded SQL readers + social stubs (NO pg import)
    resolve.mjs       # pure union-find entity resolution
    edges.mjs         # pure edge derivation
    build.mjs         # one full rebuild pass (orchestration)
    report-render.mjs # pure HTML/subject builder for the roll-up
    mailer.mjs        # Gmail SMTP over node:tls
    *.test.mjs        # pure unit tests (fixtures only, no DB/network)
  gcp-vm/             # deploy-gcp-vm.sh, run-now.sh, test-vm-api.sh
```

## Local development

```bash
npm install
npm test                         # unit tests — no DB or network needed
```

The mappers/resolver/edges/report renderer are **pure**, so the whole suite runs against
fixtures with nothing else installed. Full local run against throwaway Postgres:

```bash
docker run -d --name graph-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=social \
  -p 5432:5432 postgres:16
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=social PGUSER=postgres PGPASSWORD=pw
node scripts/apply-schema.mjs

# point the source DB names at whatever you have locally (they can all be `social`
# for a smoke test — connectors just find no source tables and yield 0 entities)
export SOURCE_DBS=social,social,social,social
node worker.mjs --once            # one rebuild pass, then exit
node scripts/report.mjs --dry-run # render the roll-up to stdout, no send
```

## Environment

| var | purpose |
|---|---|
| `PORT` | API port (default 8080, loopback on the VM) |
| `SCRAPER_API_KEY` | Bearer key for `/status` and `/run` |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` | shared Postgres creds (via Cloud SQL proxy on the VM) |
| `PGDATABASE` | this service's own graph DB (default `social`) |
| `SOURCE_DBS` | CSV of the 4 source DB names (default `healthcare,ria,insurance,hotel_scraper`) |
| `SOURCE_DB_HEALTHCARE` … `_HOTEL` | override an individual source DB name |
| `HEALTHCARE_TABLE` `RIA_ADVISERS_TABLE` `RIA_FIRMS_TABLE` `INSURANCE_TABLE` `HOTEL_TABLE` | override source table names |
| `SOCIAL_INSTAGRAM_DIR` `SOCIAL_TWITTER_DIR` `SOCIAL_THREADS_DIR` | optional dirs of exported scrape JSON to ingest (stub; empty by default) |
| `GMAIL_USER` `GMAIL_APP_PASSWORD` | Gmail SMTP creds (shared hushh-tech app password) |
| `GMAIL_SENDER_EMAIL` | send-as address (default: the authenticated `GMAIL_USER`) |
| `GMAIL_FROM_NAME` | display name (default `Hushh Social Graph`) |
| `REPORT_RECIPIENTS` | CSV (default `ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai`) |

Optional tunables (`GRAPH_REBUILD_INTERVAL_MS` default 6h, `GRAPH_MAX_SAME_ZIP_GROUP`,
`GRAPH_PRUNE_STALE_EDGES`, `SOURCE_BATCH_SIZE`, `SOURCE_MAX_ENTITIES`, …) have sane defaults in
`scripts/lib/config.mjs`.

## Email = Gmail SMTP (the repo's own mechanism)

`scripts/lib/mailer.mjs` sends over **Gmail SMTP + app password** — the same mechanism
`src/lib/notifications/gmail.ts` uses (the proven hushh-tech Gmail credentials `GMAIL_USER` +
`GMAIL_APP_PASSWORD`). It talks SMTP directly on `node:tls` (`smtp.gmail.com:465`,
`AUTH LOGIN`), so the service keeps a single runtime dependency (`pg`) — no nodemailer, no
service-account/JWT setup. The shared creds live in Secret Manager as `hushh-tech-gmail-user`
/ `hushh-tech-gmail-app-password`.

This service **owns the cross-vertical roll-up** because it is the only one with (read-only)
reach into every database. The email degrades gracefully — a missing/empty source shows
"unavailable" rather than failing the whole report.

## Cloud SQL setup (shared instance)

This service shares the one directories Cloud SQL instance (`hushh-directories-db`) and uses
its own database `social`. The `directories` DB user needs **read** access to the four source
databases on that instance.

```bash
gcloud sql databases create social --instance=hushh-directories-db
# `directories` user already exists (shared across the directory services)
```

Connection name: `hushh-tech-prod:us-central1:hushh-directories-db`.

## Deploy (VM in the fleet)

Prerequisites: the shared Cloud SQL instance above with a `social` database, and Secret
Manager secrets `directories-db-password` plus the shared `hushh-tech-gmail-user` /
`hushh-tech-gmail-app-password`. The VM service account needs `roles/cloudsql.client` +
`roles/secretmanager.secretAccessor`.

```bash
cd services/social-circles-directory
INSTANCE_CONNECTION_NAME=hushh-tech-prod:us-central1:hushh-directories-db \
  PGDATABASE=social PGUSER=directories SECRET_DB_PASSWORD=directories-db-password \
  PROJECT=hushh-tech-prod ZONE=us-central1-c \
  ./scripts/gcp-vm/deploy-gcp-vm.sh
```

The deploy creates an `e2-medium` debian-12 VM, installs Node + the Cloud SQL Auth Proxy, and
installs systemd units:

| unit | role |
|---|---|
| `cloud-sql-proxy.service` | Postgres on `127.0.0.1:5432` (Restart=always) |
| `social-circles-directory-init.service` | one-shot: apply `schema.sql` to `social` |
| `social-circles-directory-worker.service` | **the 24/7 graph builder** (Restart=always) |
| `social-circles-directory-api.service` | control/health API on `127.0.0.1:8080` |
| `social-circles-directory-report.service` + `.timer` | combined daily roll-up email |

**No public firewall rule is opened** — the API is loopback-only (no static IP needed, since
there's no third-party key to allowlist).

## Operate

```bash
./scripts/gcp-vm/test-vm-api.sh          # /health + /status + unit states (over SSH)
./scripts/gcp-vm/run-now.sh report       # send the combined roll-up email right now
./scripts/gcp-vm/run-now.sh rebuild      # trigger one full rebuild pass now (POST /run)

# logs
gcloud compute ssh social-circles-directory-vm --zone us-central1-c \
  --command 'sudo journalctl -u social-circles-directory-worker -f'
```

Graph queries:

```sql
SELECT count(*) FROM persons;
SELECT edge_type, count(*) FROM edges GROUP BY 1 ORDER BY 2 DESC;
SELECT source_vertical, count(*) FROM person_sources GROUP BY 1 ORDER BY 2 DESC;
SELECT * FROM build_runs ORDER BY started_at DESC LIMIT 5;
```

## Cost & compliance

- **Compute**: one `e2-medium` VM; the Cloud SQL instance is shared with the other
  directories (no new DB cost beyond the `social` database). No paid APIs — inputs are
  internal databases and the free Gmail SMTP path.
- **Data**: the graph is **derived** from data the sibling directories already collected and
  are responsible for; this service stores only normalized keys, provenance, and relationship
  edges. Honor each source's own retention/compliance rules — deleting a node's sources
  upstream cascades (`ON DELETE CASCADE`) or is pruned on the next rebuild.
</content>
</invoke>
