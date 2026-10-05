# PowerShell Build Script for HusshOne Hotel Scraper EXE
$ErrorActionPreference = "Stop"

Write-Host "=== Compiling HusshOne Hotel Scraper to EXE ===" -ForegroundColor Green

if (-Not (Test-Path "venv")) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Yellow
    python -m venv venv
}

Write-Host "Activating virtual environment..." -ForegroundColor Cyan
& ".\venv\Scripts\Activate.ps1"

Write-Host "Ensuring build dependencies are installed..." -ForegroundColor Cyan
pip install -r requirements.txt
pip install pyinstaller pywebview

Write-Host "Running build_exe.py..." -ForegroundColor Green
python build_exe.py
