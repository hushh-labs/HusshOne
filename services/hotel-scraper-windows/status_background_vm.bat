@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0status_background_vm.ps1"
pause
