# Launches visible Google Chrome session for husshpuppy5@gmail.com
$appDir = $PSScriptRoot
Set-Location $appDir
& ".\venv\Scripts\python.exe" "app\chrome_auth.py"
