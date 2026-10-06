@echo off
echo === Launching HusshOne Hotel Scraper Control App ===
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)
call venv\Scripts\activate.bat
echo Installing dependencies...
pip install -r requirements.txt
echo Starting server...
python run.py
pause
