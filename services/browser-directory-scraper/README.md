# Browser directory scraper

This is the physical-Windows 24/7 browser discovery lane for the four existing HusshOne
directory categories. It uses the already-running Chrome CDP workers on ports `9222`–`9225`,
claims ZIP tasks from Postgres, writes heartbeats and leases, and stores normalized public
observations in the same Cloud SQL instance.

It deliberately does not invent an NPI, insurance license number, CRD, or Google place ID from a
Google result. Observations are promoted into the existing canonical tables only after an official
source or identifier is verified. This keeps `healthcare.providers`, `insurance.producers`,
`ria.firms`/`ria.advisers`, and `hotel_scraper.hotels` trustworthy.

## Four lanes

| Worker | CDP | Lane | Canonical destination hint |
|---|---:|---|---|
| 01 | 9222 | healthcare | `healthcare.providers` |
| 02 | 9223 | insurance | `insurance.producers` |
| 03 | 9224 | advisory/RIA | `ria.firms`, `ria.advisers` |
| 04 | 9225 | all/retry | category selected by remaining queue |

## Windows runbook

Run from this directory in an authenticated Windows session:

```powershell
$env:PGHOST = "127.0.0.1"
$env:PGPORT = "5432"
$env:PGDATABASE = "hotel_scraper"
$env:PGUSER = "directories"
$env:PGPASSWORD = (gcloud secrets versions access latest --secret=directories-db-password --project=hushh-tech-prod)

node apply-schema.mjs
node seed-priority.mjs
node runner.mjs
```

The service needs a local Cloud SQL Auth Proxy on `127.0.0.1:5432`. The password is read into
the process environment and is never logged. Do not put it in a committed `.env` file.

For the first priority ZIP, seed `98033`:

```powershell
$env:PRIORITY_ZIP = "98033"
$env:PRIORITY_CITY = "Kirkland"
$env:PRIORITY_STATE = "WA"
node seed-priority.mjs
```

The runner is long-lived. Each worker sends a 15-second heartbeat, leases tasks for 10 minutes,
and requeues expired tasks. The runner restarts a worker process that exits. Put the runner behind
the existing Windows logon-start mechanism or a Scheduled Task with “restart on failure”.

The browser only reads public visible pages. It does not bypass CAPTCHA, login walls, or private
pages. If Google presents a guard page, the task is retried with backoff and the worker remains
alive.
