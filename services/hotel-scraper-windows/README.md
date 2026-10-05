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

## Compatibility limits with the VM crawler

This source import does not claim complete behavioral parity or a completed
72-hour soak test.

- The local advisory lock only coordinates copies of this Python worker.
  ZIP selection does not atomically claim shared work as the VM's
  `FOR UPDATE SKIP LOCKED`/`in_progress` protocol does. Do not operate both
  hotel crawl workers on the same pending queue until shared claiming and
  recovery ownership are aligned.
- Maps cards currently provide mainly name, coordinates, rating, CID, and URL.
  Address, Place ID, review count, price, phone, and website are often absent.
  A CID is not a Google Place ID.
- Browser-created hotels without a Place ID are not eligible for the existing
  VM's photo resolver. The local worker assumes `OPERATIONAL` when business
  status is missing; that is not independently verified.
- The VM's `hotels_found` is stored inventory by `query_zip`; this worker's
  value is the latest batch's valid-record count.
- Refresh is disabled by default here (`REFRESH_AFTER_DAYS=0`).
- Name normalization has Unicode edge differences from the VM implementation.
- SMTP alerts/report delivery are not implemented in this Python service.
  The VM deployment delegates scheduled reporting to the fleet roll-up.
- The separate `browser-directory-scraper` service stages observations for
  identity verification; this Python service writes validated hotels directly.

Production schema/IAM migrations and VM deployment are separate operator actions.
This service must not run `apply-schema` against the shared production database.

## Tests

```powershell
.\venv\Scripts\python.exe -m pytest tests -q
```

Tests use a temporary SQLite backend and mocked external services. They do not
require a production scrape or database mutation.
