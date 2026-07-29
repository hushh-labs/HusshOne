# hotel-scraper

A **24/7 US hotel crawler**. It collects hotels across **every US ZIP code (~42,000, all
states)**, crawling **outward from Kirkland, WA (98033)**, stores each hotel with its
coordinates linked to its ZIP in a clean Cloud SQL (Postgres + PostGIS) database, and
**emails a daily progress report** (how many ZIPs done / left) to the ops team.

It follows the existing scraper-fleet conventions (Node ESM `.mjs`, `node:http`, Bearer
auth, a `gcp-vm/` deploy) but has **no browser/login stack** — hotel data is public.

## How it works

```
GeoNames US.txt ──(load-zips)──► zips table (~42k rows, ordered by dist from Kirkland)
        │
        ├─ (A) OSM bulk load  ── Overpass per-state lodging → hotels(source=osm)   [FREE, full coverage]
        │
        └─ (B) 24/7 worker    ── nearest-pending ZIP → Google Places (New) enrichment
                                  → merge/dedup into hotels → mark ZIP done → repeat, forever
        ▼
   Cloud SQL (Postgres + PostGIS): zips (progress) + hotels (data) + email_reports (audit)
        ▼
   Daily report (systemd timer) → email ankit@, manish@, kushal@hushh.ai
```

"Starting from Kirkland" = the work queue is `ORDER BY dist_km_from_kirkland ASC`, so the
crawler begins at Kirkland and spirals outward. The whole ZIP universe is covered
immediately by the free OSM layer; the paid Places layer grinds outward 24/7.

## Data sources (hybrid)

- **OpenStreetMap (Overpass)** — free, full coverage. `tourism=hotel|motel|resort`
  + `building=hotel`, one query per state (hotels/motels/resorts only — no hostels/guest houses). No ratings/reviews.
- **Google Places API (New)** — `places:searchText` with a field mask, `includedType=lodging`,
  `regionCode=US`, up to 3 pages (≤60 results) per ZIP. Adds rating, reviews count, price,
  phone, website, Maps URI. 429 → exponential backoff.

Merge/dedup key: `normalize(name) + "|" + geohash(lat,lng,6)`. OSM and Places rows for the
same hotel collapse into one row (`sources` becomes `{osm,places}`). DB `UNIQUE(dedup_key)`
and `UNIQUE(place_id)` are the durable backstops.

## Layout

```
server.mjs            # node:http control API: GET /health (open), GET /status, POST /run (Bearer)
worker.mjs            # the 24/7 crawl loop (--limit N / --once for local runs)
schema.sql            # PostGIS + zips + hotels + email_reports
scripts/
  apply-schema.mjs    # apply schema.sql via pg (no psql needed)
  load-zips.mjs       # GeoNames US.txt → zips (+ haversine dist from Kirkland)
  osm-ingest.mjs      # OSM bulk load CLI (--only US-WA / --gap-ms)
  report.mjs          # daily email (--dry-run / --to a@b.com)
  lib/                # config, db, zip, hotels, places-client, osm-ingest, pipeline, mailer (+ *.test.mjs)
  gcp-vm/             # deploy-gcp-vm.sh, run-now.sh, test-vm-api.sh
inputs/US.txt         # GeoNames US ZIP export (fetched on the VM at deploy time)
```

## Local development

```bash
npm install
npm test                         # unit tests (no DB/network needed)
```

Full local run against a throwaway PostGIS:

```bash
docker run -d --name hotel-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=hotel_scraper \
  -p 5432:5432 postgis/postgis:16-3.4
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=hotel_scraper PGUSER=postgres PGPASSWORD=pw
node scripts/apply-schema.mjs

# ZIP universe (download GeoNames first: needs `unzip`)
curl -fsSL -o /tmp/US.zip https://download.geonames.org/export/zip/US.zip
unzip -o /tmp/US.zip US.txt -d inputs/
node scripts/load-zips.mjs       # expect ~42k rows; Kirkland (98033) dist ≈ 0

export PLACES_API_KEY=...        # a Places (New) key
node worker.mjs --limit 5        # process 5 ZIPs from Kirkland outward
node scripts/osm-ingest.mjs --only US-WA
node scripts/report.mjs --dry-run
```

## Environment

| var | purpose |
|---|---|
| `PORT` | API port (default 8080, loopback on the VM) |
| `SCRAPER_API_KEY` | Bearer key for `/status` and `/run` |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Postgres (via Cloud SQL proxy on the VM) |
| `PLACES_API_KEY` | Google Places API (New) key |
| `GMAIL_USER` `GMAIL_APP_PASSWORD` | Gmail SMTP creds (shared hushh-tech Gmail app password) |
| `GMAIL_SENDER_EMAIL` | send-as address (default: the authenticated `GMAIL_USER`; set only to a verified alias) |
| `REPORT_RECIPIENTS` | CSV (default `ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai`) |

Optional tunables (`HOTEL_WORKER_ZIP_GAP_MS`, `HOTEL_REFRESH_AFTER_DAYS`,
`PLACES_MAX_PAGES`, `OVERPASS_ENDPOINT`, …) have sane defaults in `scripts/lib/config.mjs`.

## Email = Gmail SMTP (the repo's own mechanism)

`scripts/lib/mailer.mjs` sends over **Gmail SMTP + app password** — the same mechanism
`src/lib/notifications/gmail.ts` uses ("reuses the proven hushh-tech Gmail credentials:
`GMAIL_USER` + `GMAIL_APP_PASSWORD`"). It talks SMTP directly on `node:tls`
(`smtp.gmail.com:465`, `AUTH LOGIN`), so the service keeps a single runtime dependency
(`pg`) — no nodemailer, no service-account/JWT/Workspace setup. The shared creds live in
Secret Manager as `hushh-tech-gmail-user` / `hushh-tech-gmail-app-password`.

## Cloud SQL setup (shared instance)

This service shares one Cloud SQL instance with the other directories
(`hushh-directories-db`), using its own database `hotel_scraper`:

```bash
# One-time (already provisioned): instance + PostGIS-capable databases + app user.
gcloud sql instances create hushh-directories-db --edition=ENTERPRISE \
  --database-version=POSTGRES_16 --tier=db-custom-1-3840 --region=us-central1
gcloud sql databases create hotel_scraper --instance=hushh-directories-db
gcloud sql users create directories --instance=hushh-directories-db --password=<PW>
# PostGIS: connect once as a cloudsqlsuperuser and run  CREATE EXTENSION IF NOT EXISTS postgis;
# (apply-schema.mjs also tries this, but needs cloudsqlsuperuser to create the extension)
```

Connection name: `hushh-tech-prod:us-central1:hushh-directories-db`.

## Deploy (VM in the fleet)

Prerequisites: the shared Cloud SQL instance above, and Secret Manager secrets
`hotel-scraper-places-api-key`, `hotel-scraper-db-password`, plus the shared
`hushh-tech-gmail-user` / `hushh-tech-gmail-app-password`. The VM service account needs
`roles/cloudsql.client` + `roles/secretmanager.secretAccessor`.

```bash
cd services/hotel-scraper
INSTANCE_CONNECTION_NAME=hushh-tech-prod:us-central1:hushh-directories-db \
  PGUSER=directories SECRET_DB_PASSWORD=directories-db-password \
  PROJECT=hushh-tech-prod ZONE=us-central1-c \
  ./scripts/gcp-vm/deploy-gcp-vm.sh
```

The deploy creates an `e2-medium` debian-12 VM with a **static egress IP** (allowlist it on
the Places key), installs Node + the Cloud SQL Auth Proxy, fetches GeoNames, and installs
systemd units:

| unit | role |
|---|---|
| `cloud-sql-proxy.service` | Postgres on `127.0.0.1:5432` (Restart=always) |
| `hotel-scraper-init.service` | one-shot: apply schema + load ZIPs |
| `hotel-scraper-osm.service` | one-shot (background): OSM bulk load |
| `hotel-scraper-worker.service` | **the 24/7 crawler** (Restart=always) |
| `hotel-scraper-api.service` | control/health API on `127.0.0.1:8080` |
| `hotel-scraper-report.service` + `.timer` | daily progress email |

**No public firewall rule is opened** — the API is loopback-only.

## Operate

```bash
./scripts/gcp-vm/test-vm-api.sh          # /health + /status + unit states (over SSH)
./scripts/gcp-vm/run-now.sh report       # send the daily email right now
./scripts/gcp-vm/run-now.sh zip 5        # process 5 ZIPs now
./scripts/gcp-vm/run-now.sh osm          # (re)run OSM bulk load

# logs
gcloud compute ssh hotel-scraper-vm --zone us-central1-c \
  --command 'sudo journalctl -u hotel-scraper-worker -f'
```

Progress query:

```sql
SELECT count(*) FILTER (WHERE places_status='done') AS done, count(*) AS total FROM zips;
SELECT count(*) FROM hotels;
```

## Cost

OSM: **$0**. Places: one full US pass ≈ **$3,000–4,400** (Text Search), then ongoing refresh
as ZIPs age out. No daily cap (bounded only by the Places quota). The daily email's
"Est. Places spend" line keeps this visible. Cloud SQL `db-custom-1-3840` ≈ $50/mo.

## Compliance

- **OSM** data is ODbL — freely storable with attribution.
- **Google Places** — `place_id` may be stored indefinitely; other fields (rating, phone,
  address) are treated as a refreshable cache (`last_seen` bumped each pass), the compliant
  pattern. Review retention against the Google Maps Platform ToS for your use.
