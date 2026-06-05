@echo off
cd /d "%~dp0backend"
echo Starting Lotto Analyzer API on http://127.0.0.1:8000
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
pause
