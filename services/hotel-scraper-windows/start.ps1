# PowerShell Launcher for HusshOne Hotel Scraper App
$ErrorActionPreference = "Stop"

Write-Host "=== Launching HusshOne Hotel Scraper Control App ===" -ForegroundColor Green

if (-Not (Test-Path "venv")) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Yellow
    python -m venv venv
}

Write-Host "Activating virtual environment..." -ForegroundColor Cyan
& ".\venv\Scripts\Activate.ps1"

Write-Host "Checking / Installing dependencies..." -ForegroundColor Cyan
pip install -r requirements.txt

Write-Host "Starting server on http://127.0.0.1:8080..." -ForegroundColor Green
python run.py
