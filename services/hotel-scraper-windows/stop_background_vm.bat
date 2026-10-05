@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_background_vm.ps1"
pause
