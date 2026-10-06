# Stops the background scraper process
$runtimeBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE ".husshone_hotel_scraper" }
$runtimeDir = Join-Path $runtimeBase "HusshOne-Hotel-Scraper"
$pidFile = Join-Path $runtimeDir "scraper_vm.pid"

if (-Not (Test-Path $pidFile)) {
    Write-Host "No active scraper_vm.pid file found." -ForegroundColor Yellow
    exit 0
}

$procId = Get-Content $pidFile -ErrorAction SilentlyContinue

if ($procId) {
    try {
        # Graceful API stop first
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/control/stop" -Method Post -TimeoutSec 2 | Out-Null
        } catch {}

        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Stopping scraper background worker (PID: $procId)..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force
            Write-Host "Scraper background worker stopped successfully." -ForegroundColor Green
        } else {
            Write-Host "Process $procId is not running." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Could not stop process ${procId}: $_" -ForegroundColor Red
    }
}

Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
