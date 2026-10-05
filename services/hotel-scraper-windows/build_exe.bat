@echo off
echo === Compiling HusshOne Hotel Scraper to EXE ===
call venv\Scripts\activate.bat
pip install -r requirements.txt
pip install pyinstaller pywebview
python build_exe.py
pause
