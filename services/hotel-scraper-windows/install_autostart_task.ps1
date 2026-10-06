# Installs or removes a per-user Task Scheduler entry for the local worker.
# Run explicitly from an elevated or normal PowerShell session as appropriate:
#   .\install_autostart_task.ps1
#   .\install_autostart_task.ps1 -Uninstall
# This script is intentionally not invoked by the application itself.

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName = "HusshOne Hotel Scraper"
)

$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "run_as_background_vm.ps1"

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    } else {
        Write-Host "No scheduled task named '$TaskName' exists." -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Background launcher not found: $launcher"
}

$powershell = Join-Path $PSHOME "powershell.exe"
$quotedLauncher = '"' + $launcher.Replace('"', '""') + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedLauncher"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowDemandStart `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval "PT1M" `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit "PT0S" `
    -DisallowStartIfOnBatteries:$false `
    -StopIfGoingOnBatteries:$false
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description "Starts the HusshOne Hotel Scraper at sign-in and restarts it after a crash." `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "Installed '$TaskName': starts at sign-in and retries after a crash." -ForegroundColor Green
Write-Host "This cannot keep a powered-off machine running; the worker's wake lock prevents sleep only while Windows is on." -ForegroundColor Yellow
