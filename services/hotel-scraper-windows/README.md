# Windows hotel scraper and review dashboard

A Python/Playwright Windows service and desktop dashboard for the existing Cloud SQL
`hotel_scraper` database. This is an additional service alongside
[`../hotel-scraper`](../hotel-scraper/README.md), the Node/Places/OSM VM crawler.

## What is included

- Google Maps browser discovery and ZIP-based OSM lookups.
- Hotel directory explorer and read-only Data Review & Recovery dashboard.
- Production catalog/schema guard, record validation, quarantine, SQL firewall,
  inventory watermarks, dedicated Google credential isolation, and an owned proxy.
- Durable SQLite outbox and immutable run journal for crash recovery.
- Browser child-process watchdog, recycling, CAPTCHA backoff, daily cap,
  rotating logs, and optional canary and stale-ZIP refresh.
- Windows background launch, status/stop tools, optional login scheduled task,
  and PyInstaller desktop executable build.

## Setup

Use Python 3.11+, Chrome, Google Cloud CLI, and Cloud SQL Auth Proxy on Windows.
Run all commands from this service directory.

```powershell
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
powershell -ExecutionPolicy Bypass -File .\setup_dedicated_gcloud_account.ps1
.\venv\Scripts\python.exe .\preflight_cloud_sql.py --timeout 60
.\venv\Scripts\python.exe .\run.py
```

Use `.env.example` for configuration. Store credentials only in local/private
configuration or Secret Manager. The setup script isolates the project Google
account from the operator's normal gcloud identity. The Cloud SQL preflight
checks connectivity and schema without scraping or writing hotel/ZIP rows.

The dashboard is at `http://127.0.0.1:8080`. Open Chrome Account to complete
interactive sign-in in the scraper's separate browser profile, then start
scraping from the dashboard.

To build a Windows desktop executable:

```powershell
powershell -ExecutionPolicy Bypass -File .\build_exe.ps1
```

Distribute the entire `dist/HusshOne-Hotel-Scraper` folder, including
`_internal`. Executables are build outputs and are not committed.

## Database contract and review

Writes use `public.hotels` and ZIP processing fields in `public.zips`.
`sources` retains production-compatible `places`/`osm` values;
`raw.scraped_via`, `raw.run_id`/`raw.scrape_run_id`, `raw.scraped_at`, and
`raw.google_cid` carry collection evidence. Cloud SQL generates `geog`;
existing photo data is preserved.

Review all existing records or filter scraper-traced records in Data Review &
Recovery. The paginated JSON endpoint is:

```text
/api/review/hotels?scope=scraper_traced&provenance=chrome_google_maps&include_raw=true&limit=100
```

Runtime files live under `%LOCALAPPDATA%/HusshOne-Hotel-Scraper`, including
the outbox, journal, private gcloud configuration, Chrome profile, and logs.

See [production safety and recovery](docs/PRODUCTION_WRITE_SAFETY.md) and
[dedicated Google account setup](docs/DEDICATED_GCLOUD_ACCOUNT.md).

## VM compatibility and remaining limits

ZIP work uses the VM's atomic `FOR UPDATE SKIP LOCKED` / `in_progress` claim
protocol. Browser claims carry an ownership marker in `last_error` until they
finish and heartbeat every 30 seconds. Result writes verify ownership under a
row lock; recovery waits for a different worker and preserves newer VM data.
Clean shutdown releases owned claims. Expired browser claims are recoverable
after 30 minutes, matching the VM stale-work window.

`hotels_found` counts stored hotels by `query_zip`, name normalization matches
the VM algorithm, and refresh defaults to 30 days. Existing runtime overrides
are respected; use `REFRESH_AFTER_DAYS=0` to disable refresh.

Maps detail pages provide address, review count, phone, website, rating, price
category, closed status, and coordinates when visible. Unavailable fields stay
empty and detail failures are recorded. Missing business status remains unknown.
Only a genuine Place ID from an explicit Maps link is stored; a CID/feature ID
is never substituted. Filling a verified Place ID makes a hotel eligible for
the existing VM photo resolver without overwriting photo data. Many Maps pages
do not expose a Place ID, so those rows remain ineligible until API enrichment.

Scheduled progress reporting remains owned by the existing fleet roll-up,
which reads the same hotel and ZIP tables. This service does not send a duplicate
scheduled email, and standalone SMTP incident alerts are not implemented.
The separate `browser-directory-scraper` stages cross-category observations;
this service continues to write validated hotels into the canonical table.

Live Maps selectors, concurrent production operation, and the 72-hour soak
must be verified on the running machines; unit/CI tests do not prove those.

Production schema/IAM migrations and VM deployment are separate operator actions.
This service must not run `apply-schema` against the shared production database.

## Tests

```powershell
.\venv\Scripts\python.exe -m pytest tests -q
```

Most tests use temporary SQLite and mocked external services. CI additionally
checks real PostgreSQL row locking against a disposable `scraper_ci_windows`
database. They do not require a production scrape or database mutation.

## Imported four-directory fleet

The desktop includes a pinned snapshot of the repository's hotel, healthcare,
RIA and insurance services (`app/vm_sources/manifest.json`). These are local
processes, not newly deployed VMs. Hotel uses the original per-ZIP mapping
pipeline with an injected local-Chrome transport and the existing protected
desktop outbox writer; the paid Places client and original photo-replacing
writer are not invoked. Healthcare, RIA and insurance use their imported
registry ingestion and database code, with a local safety wrapper.

| Directory | Existing database | Canonical tables / native identity |
| --- | --- | --- |
| Hotel | `hotel_scraper` | `hotels` / existing dedup key, Places ID or CID |
| Healthcare | `healthcare` | `providers` / NPI |
| RIA | `ria` | `firms`, `advisers` / CRD |
| Insurance | `insurance` | `producers` / source state + license number |

Start each registry worker from the dashboard once. Desired state is persisted
locally and resumes after restart. Each uses a separate below-normal Node process
with a 256 MB V8 heap cap (not a total RSS cap), two pooled DB connections, query
timeouts and a session lock against another copy of this local worker. Existing
remote VM workers do not participate in that local lock; native upserts remain
idempotent. Blocking I/O runs outside the UI/event loop. Startup verifies existing
tables, types, identity constraints and write grants; it never applies schema.sql,
creates databases, sends emails or starts photo jobs. Bulk feeds require disk
headroom. Authoritative non-null registry values may refresh old values, but null
source values cannot erase existing fields and raw metadata is merged.

The upstream insurance adapter currently collects Texas only. Other configured
state adapters remain explicitly blocked. Local imports do not create missing
sources or guarantee coverage. RIA multipart completion has a local recovery fix:
the compilation is successful only after every XML part succeeds.

### Stored-data endpoint

`GET /api/v1/businesses?q=Example&vertical=all&limit=20` or
`GET /api/v1/businesses?zip=98033&vertical=healthcare` queries existing Cloud SQL
data read-only. `vertical` accepts `all`, `hotel`, `healthcare`, `ria`, `insurance`.
`POST /api/v1/businesses/search` accepts the same fields as JSON. Responses include
the canonical table, native identity and public fields; hotel website evidence is
included without returning the full raw payload. Partial directory failures are
reported as warnings, not disguised as empty successful data. These are local
loopback endpoints; do not expose this dashboard directly to the internet.
Directory membership is not proof of ownership for onboarding.

### Live worker-code releases (no dashboard closure)

Install Node dependencies before source runs or packaging:
`cd app/vm_sources` then `npm ci --ignore-scripts --no-audit --no-fund`.

From the application source directory, stage **reviewed local** worker sources:
`python -m app.worker_updates stage C:/path/to/reviewed/vm_sources`.
Then click **Apply staged worker update**. This snapshots immutable code, checks
syntax/checksums and reuses the packaged dependency lock. Registry workers finish
their current cycle, commit their ledger and restart under supervision; hotel
mapping switches on the next ZIP. The dashboard stays open. Long bulk ingestion
can defer activation after 30 minutes; updates never force-kill a job. Previous
release files remain intact and abrupt restarts select the committed pointer.

Checksums are integrity checks, not publisher signatures. Only stage trusted,
reviewed local code; no remote code downloads or upload-to-execute endpoint exists.
This mechanism updates imported Node code only. Changes to Python scraping,
dashboard templates, dependencies, Node runtime or the frozen EXE still require
a desktop restart. A separate stable launcher/backend architecture is needed for
whole-application updates without closing the native window; it is not yet part
of this mechanism. This is not a zero-downtime scrape guarantee or a completed
72-hour unattended soak test.
