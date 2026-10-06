# Dedicated Google account for the local worker

This setup dedicates the Google account `husshpuppy5@gmail.com` to the local
HusshOne scraper without changing the normal Google account used elsewhere on
the PC. It is a **separate gcloud user-credential store**, not a Google Cloud
service account. The difference matters:

- The identity is still the Google user `husshpuppy5@gmail.com`; Cloud Audit Logs
  and IAM show that user, not a `...gserviceaccount.com` principal.
- The account's refresh token is local to this Windows user profile and can be
  revoked or require interactive sign-in again. The worker fails closed if it
  cannot authenticate.
- This is suitable when that Gmail account is intentionally dedicated to this
  task. A true non-human unattended identity still requires an approved Google
  Cloud service account and a least-privilege database role.

## What the setup script does

Run from the repository in an interactive PowerShell window:

```powershell
.\setup_dedicated_gcloud_account.ps1
```

The script opens the normal Google sign-in window for
`husshpuppy5@gmail.com`, then places the resulting gcloud credentials under:

```text
%LOCALAPPDATA%\HusshOne-Hotel-Scraper\gcloud
```

Within that private directory it creates and activates the named configuration
`husshone-scraper`, pins it to project `hushh-tech-prod`, and verifies the
Cloud SQL instance metadata for `hushh-directories-db`. The verification is a
read-only `gcloud sql instances describe` call. It does not launch a proxy,
connect to PostgreSQL, fetch a Secret Manager value, or write any Cloud SQL
data. It proves that the dedicated account can read instance metadata; it does
not by itself prove Cloud SQL Client, Secret Manager, PostgreSQL-password, or
schema compatibility access.

After successful login, the script stores these **worker-specific** current
user environment variables so a future app/Task Scheduler process can select
the private configuration:

```text
GCP_GCLOUD_CONFIG_DIR=%LOCALAPPDATA%\HusshOne-Hotel-Scraper\gcloud
GCP_GCLOUD_CONFIG_NAME=husshone-scraper
GCP_GCLOUD_ACCOUNT=husshpuppy5@gmail.com
```

It intentionally does **not** set `CLOUDSDK_CONFIG` as a permanent user
variable. That would redirect normal, unrelated `gcloud` work into the
scraper's configuration. The scraper uses these three worker-specific values
to set `CLOUDSDK_CONFIG` and select the named configuration only for its Cloud
SQL Auth Proxy and Secret Manager gcloud subprocesses.

Before the browser flow, the script removes inherited gcloud access-token,
credential-file, impersonation, account, project, and configuration overrides.
It also clears the corresponding authentication properties inside the private
configuration. Those higher-precedence settings could otherwise make a command
silently use a personal token instead of `husshpuppy5@gmail.com`.

It also intentionally does **not** create Application Default Credentials
(ADC), set `GOOGLE_APPLICATION_CREDENTIALS` or
`GCP_APPLICATION_CREDENTIALS`, download a service-account key, or alter IAM.
The Cloud SQL Auth Proxy uses its `--gcloud-auth` path with the isolated gcloud
store; ADC is both unnecessary for this flow and not configuration-specific on
Windows.

## Reauthentication and checks

To force a fresh browser sign-in after a token expiry or account-security
event:

```powershell
.\setup_dedicated_gcloud_account.ps1 -Reauthenticate
```

The script fails before saving worker settings if the signed-in account or
project is not exactly the expected one. It fails its post-login metadata check
if the account cannot read the target Cloud SQL instance metadata. No write is
attempted in either case.

If initial setup is intentionally offline, `-SkipCloudSqlCheck` skips only the
post-login remote metadata read; it does not make the worker safe to run until
the later end-to-end read-only preflight succeeds.
`-DoNotPersistWorkerSettings` is useful for a one-off local test; it keeps the
three values in the current PowerShell process instead of the Windows user
environment.

After a successful setup, restart any currently running worker. A new Task
Scheduler launch receives the saved worker-specific environment variables.

## End-to-end read-only preflight

After the browser sign-in, run this from the repository before allowing any
scrape writes:

```powershell
.\venv\Scripts\python.exe .\preflight_cloud_sql.py
```

The preflight starts only the app-owned proxy, retrieves the configured
database secret without printing it, runs `SELECT 1`, and performs the
`information_schema` contract check. It does not scrape, enqueue ZIPs, or
write/delete/alter Cloud SQL data. Success requires both `database_connected`
and `schema_compatible` to be `true`.

Never start a separate manual proxy on port 5432 while the managed default is
enabled. The app refuses unknown listeners rather than assuming they use the
dedicated account. After an abrupt shutdown it records an ownership marker and
can replace only a strongly validated stale child whose original app parent is
definitely gone; any other listener remains blocked for review.

## Required access and boundaries

The dedicated Google user needs only the cloud permissions required by the
existing worker. For the Auth Proxy, that is normally Cloud SQL Client on the
target instance/project. The application's existing secret lookup and database
login also need their separately approved permissions and credentials.

This isolated login does not itself grant access and does not replace the
reviewed least-privilege PostgreSQL writer role. In particular, it does not
prevent a broadly privileged database login from changing data; the database
role is still the production enforcement boundary.

Keep the Windows account protected. The gcloud directory contains a refresh
credential and should never be copied, emailed, committed, or backed up into a
shared location.

## Rollback

Rollback does not affect Cloud SQL data, IAM policies, or the operator's normal
gcloud configuration.

1. Stop the worker and disable its scheduled task if it is installed.
2. In a PowerShell session, scope gcloud to the private directory and revoke
   the dedicated login:

   ```powershell
   $env:CLOUDSDK_CONFIG = Join-Path $env:LOCALAPPDATA "HusshOne-Hotel-Scraper\gcloud"
   gcloud.cmd auth revoke husshpuppy5@gmail.com
   ```

3. Remove the three worker-only user variables:

   ```powershell
   [Environment]::SetEnvironmentVariable("GCP_GCLOUD_CONFIG_DIR", $null, "User")
   [Environment]::SetEnvironmentVariable("GCP_GCLOUD_CONFIG_NAME", $null, "User")
   [Environment]::SetEnvironmentVariable("GCP_GCLOUD_ACCOUNT", $null, "User")
   ```

4. After confirming the worker is stopped and the credential has been revoked,
   delete exactly `%LOCALAPPDATA%\HusshOne-Hotel-Scraper\gcloud` if it is no
   longer needed. Do not delete the broader `HusshOne-Hotel-Scraper` folder:
   it also holds recovery outbox and run-journal evidence.

If there is any concern that the credential was exposed, revoke it in Google
Account security as well, then run the script with `-Reauthenticate` only
after access has been reviewed.
