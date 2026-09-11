$ErrorActionPreference = 'Stop'
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $serviceRoot
$logRoot = 'C:\Hushh\logs'
$logPath = Join-Path $logRoot 'browser-directory-scraper.log'
$proxyLogPath = Join-Path $logRoot 'cloud-sql-proxy.log'
$proxyErrorLogPath = Join-Path $logRoot 'cloud-sql-proxy.error.log'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$gcloud = (Get-Command gcloud.cmd -ErrorAction SilentlyContinue).Source
if (-not $gcloud) {
  $fallbackGcloud = 'C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
  if (Test-Path $fallbackGcloud) { $gcloud = $fallbackGcloud }
}
if (-not $gcloud) { throw 'gcloud.cmd was not found on PATH or at the standard Google Cloud SDK path.' }
$proxy = $env:CLOUD_SQL_PROXY_EXE
if (-not $proxy) { $proxy = 'C:\Hushh\bin\cloud-sql-proxy.exe' }
if (-not (Test-Path $proxy)) { throw "Cloud SQL Auth Proxy not found at $proxy" }

function Ensure-CloudSqlProxy {
  $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
  if ($listener) { return }

  Add-Content -Path $logPath -Value ("[{0}] Cloud SQL proxy is not listening; starting it." -f (Get-Date -Format o))
  Start-Process -FilePath $proxy `
    -ArgumentList @('--address=127.0.0.1', '--port=5432', 'hushh-tech-prod:us-central1:hushh-directories-db') `
    -WindowStyle Hidden -RedirectStandardOutput $proxyLogPath -RedirectStandardError $proxyErrorLogPath | Out-Null
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

Ensure-CloudSqlProxy

function Invoke-NodeScript([string] $scriptName) {
  & node.exe $scriptName >> $logPath 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Node script failed: $scriptName (exit $LASTEXITCODE)" }
}

Invoke-NodeScript 'apply-schema.mjs'
if (-not $env:PRIORITY_ZIP) { $env:PRIORITY_ZIP = '98033' }
if (-not $env:PRIORITY_CITY) { $env:PRIORITY_CITY = 'Kirkland' }
if (-not $env:PRIORITY_STATE) { $env:PRIORITY_STATE = 'WA' }
Invoke-NodeScript 'seed-priority.mjs'

# Keep one supervisor process alive for the lifetime of the Windows scheduled task.
# It restarts the Node runner and re-establishes the proxy if either disappears.
while ($true) {
  Ensure-CloudSqlProxy
  $runner = Start-Process -FilePath 'node.exe' -ArgumentList @('runner.mjs') -WorkingDirectory $serviceRoot `
    -RedirectStandardOutput $logPath -RedirectStandardError ($logPath + '.error') -PassThru
  while (-not $runner.HasExited) {
    Start-Sleep -Seconds 10
    Ensure-CloudSqlProxy
  }
  Add-Content -Path $logPath -Value ("[{0}] runner exited with code {1}; restarting in 5 seconds." -f (Get-Date -Format o), $runner.ExitCode)
  Start-Sleep -Seconds 5
}
