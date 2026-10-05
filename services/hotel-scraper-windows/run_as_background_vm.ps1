# Launches HusshOne Hotel Scraper in true background VM mode on Windows
$ErrorActionPreference = "Stop"

$appDir = $PSScriptRoot
Set-Location $appDir

$runtimeBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE ".husshone_hotel_scraper" }
$runtimeDir = Join-Path $runtimeBase "HusshOne-Hotel-Scraper"
$logsDir = Join-Path $runtimeDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$pidFile = Join-Path $runtimeDir "scraper_vm.pid"
$logFile = Join-Path $logsDir "scraper_vm.log"
$errFile = Join-Path $logsDir "scraper_vm_err.log"

# Check if already running
if (Test-Path $pidFile) {
    $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existingPid) {
        $existingProc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($existingProc) {
            Write-Host "Scraper background worker is ALREADY running with PID: $existingPid" -ForegroundColor Yellow
            Write-Host "Monitor with: .\status_background_vm.ps1" -ForegroundColor Cyan
            exit 0
        }
    }
}

Write-Host "=== Starting Scraper in Background VM Mode ===" -ForegroundColor Green

# Determine executable: prefer compiled EXE or python venv
$exePath = Join-Path $appDir "dist\HusshOne-Hotel-Scraper\HusshOne-Hotel-Scraper.exe"
$pythonPath = Join-Path $appDir "venv\Scripts\python.exe"

if (Test-Path $exePath) {
    Write-Host "Launching compiled binary in background..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath $exePath -ArgumentList "--headless" -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $errFile
} elseif (Test-Path $pythonPath) {
    Write-Host "Launching Python worker in background..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath $pythonPath -ArgumentList "desktop.py", "--headless" -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $errFile
} else {
    Write-Host "Error: No Python virtual environment or compiled EXE found. Run .\start.ps1 first." -ForegroundColor Red
    exit 1
}

# Save PID
Set-Content -Path $pidFile -Value $proc.Id

try {
    $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
} catch {
    Write-Host "Warning: Could not lower process priority: $_" -ForegroundColor Yellow
}

Start-Sleep -Seconds 2

Write-Host "Scraper is now running as a background VM worker!" -ForegroundColor Green
Write-Host "Process ID: $($proc.Id)" -ForegroundColor Green
Write-Host "Logs      : $logFile" -ForegroundColor Cyan
Write-Host "Web UI    : http://127.0.0.1:8080" -ForegroundColor Cyan
Write-Host "To check  : .\status_background_vm.ps1" -ForegroundColor Yellow
Write-Host "To stop   : .\stop_background_vm.ps1" -ForegroundColor Yellow
