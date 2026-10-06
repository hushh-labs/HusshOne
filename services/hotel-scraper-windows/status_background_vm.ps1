# Displays background scraper process status, metrics, and live logs
$runtimeBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE ".husshone_hotel_scraper" }
$runtimeDir = Join-Path $runtimeBase "HusshOne-Hotel-Scraper"
$pidFile = Join-Path $runtimeDir "scraper_vm.pid"
$logFile = Join-Path $runtimeDir "logs\scraper_vm.log"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "HusshOne Hotel Scraper - Local VM Worker Status" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

$isRunning = $false

if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($procId) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            $isRunning = $true
            $memMb = [math]::Round($proc.WorkingSet64 / 1MB, 2)
            Write-Host "Process State : RUNNING (Background Daemon)" -ForegroundColor Green
            Write-Host "Process ID    : $procId" -ForegroundColor White
            Write-Host "Memory Usage  : $memMb MB" -ForegroundColor White
            Write-Host "Start Time    : $($proc.StartTime)" -ForegroundColor White
        }
    }
}

if (-Not $isRunning) {
    Write-Host "Process State : STOPPED / IDLE" -ForegroundColor Yellow
}

# Check API health
try {
    $api = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/status" -TimeoutSec 2
    Write-Host "API Endpoint  : ONLINE (http://127.0.0.1:8080)" -ForegroundColor Green
    Write-Host "Worker Status : $(if ($api.is_running) { 'ACTIVE (CRAWLING)' } else { 'IDLE' })" -ForegroundColor White
    Write-Host "Current Action: $($api.stats.current_action)" -ForegroundColor Cyan
    Write-Host "ZIPs Processed: $($api.stats.zips_processed)" -ForegroundColor White
    Write-Host "Hotels Found  : $($api.stats.hotels_found)" -ForegroundColor White
} catch {
    Write-Host "API Endpoint  : OFFLINE" -ForegroundColor DarkGray
}

Write-Host "`n--- Recent Log Output ---" -ForegroundColor DarkGray
if (Test-Path $logFile) {
    Get-Content $logFile -Tail 15
} else {
    Write-Host "No log file found at $logFile" -ForegroundColor DarkGray
}
Write-Host "==================================================" -ForegroundColor Cyan
