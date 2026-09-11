$ErrorActionPreference = 'Stop'
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $serviceRoot

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required.' }
if (-not (Get-Command gcloud.cmd -ErrorAction SilentlyContinue)) { throw 'Google Cloud SDK (gcloud.cmd) is required.' }

New-Item -ItemType Directory -Force -Path 'C:\Hushh\bin' | Out-Null
npm.cmd install --omit=dev

$proxyUrl = 'https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.18.2/cloud-sql-proxy.x64.exe'
$proxyPath = 'C:\Hushh\bin\cloud-sql-proxy.exe'
if (-not (Test-Path $proxyPath)) {
  Invoke-WebRequest -Uri $proxyUrl -OutFile $proxyPath
}

$taskName = 'Hushh Browser Directory Scraper Fleet'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$serviceRoot\run-fleet.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description '24x7 Hushh browser directory scraper fleet' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started: $taskName"
