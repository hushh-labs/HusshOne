$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path $PSScriptRoot -Parent
$releaseVersion = (Get-Content -LiteralPath (Join-Path $releaseRoot 'VERSION') -Raw).Trim()
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid VERSION file' }
$releaseExe = Join-Path $releaseRoot "releases\v$releaseVersion\HusshOne-Hotel-Scraper\HusshOne-Hotel-Scraper.exe"
if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) { throw "Release v$releaseVersion has not been built: $releaseExe" }
$runningScrapers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'HusshOne-Hotel-Scraper.exe' })
if ($runningScrapers.Count -gt 0) {
    Write-Host 'A scraper is already running. Stop it safely before switching releases.'
    Write-Host ($runningScrapers.ExecutablePath | Select-Object -Unique)
    Read-Host 'Press Enter to close'
    exit 1
}
Start-Process -FilePath $releaseExe -WorkingDirectory (Split-Path $releaseExe -Parent)
