@echo off
rem Starts the API and the website in their own windows, then opens the hero case. Close those windows to stop.
cd /d "%~dp0"
if not exist backend\.venv\Scripts\python.exe (
  echo Set up the backend first. See "Run it" in README.md.
  pause
  exit /b 1
)
if not exist frontend\node_modules (
  echo Installing website packages...
  pushd frontend
  call npm install
  popd
)
start "YATHARTH API" /d "%~dp0backend" cmd /k .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
start "YATHARTH website" /d "%~dp0frontend" cmd /k npm run dev -- --host 127.0.0.1
timeout /t 5 /nobreak >nul
start "" http://127.0.0.1:5173/case/hero
