$ErrorActionPreference = 'Stop'
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $serviceRoot

$gcloud = (Get-Command gcloud.cmd -ErrorAction SilentlyContinue).Source
if (-not $gcloud) { throw 'gcloud.cmd was not found on PATH. Use the Google Cloud SDK installer first.' }
$proxy = $env:CLOUD_SQL_PROXY_EXE
if (-not $proxy) { $proxy = 'C:\Hushh\bin\cloud-sql-proxy.exe' }
if (-not (Test-Path $proxy)) { throw "Cloud SQL Auth Proxy not found at $proxy" }

$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  Start-Process -FilePath $proxy -ArgumentList @('--gcloud-auth', '--address=127.0.0.1', '--port=5432', 'hushh-tech-prod:us-central1:hushh-directories-db') -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 1
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
  } while (-not $listener -and (Get-Date) -lt $deadline)
  if (-not $listener) { throw 'Cloud SQL Auth Proxy did not open 127.0.0.1:5432 within 30 seconds.' }
}

$env:PGHOST = '127.0.0.1'
$env:PGPORT = '5432'
$env:PGDATABASE = 'hotel_scraper'
$env:PGUSER = 'directories'
$env:PGPASSWORD = (& $gcloud secrets versions access latest --secret=directories-db-password --project=hushh-tech-prod).Trim()
if ([string]::IsNullOrWhiteSpace($env:PGPASSWORD)) { throw 'directories-db-password returned empty.' }

& node apply-schema.mjs
if (-not $env:PRIORITY_ZIP) { $env:PRIORITY_ZIP = '98033' }
if (-not $env:PRIORITY_CITY) { $env:PRIORITY_CITY = 'Kirkland' }
if (-not $env:PRIORITY_STATE) { $env:PRIORITY_STATE = 'WA' }
& node seed-priority.mjs
& node runner.mjs
