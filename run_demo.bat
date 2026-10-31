@echo off
rem Starts the API (:8000) and the website (:5173) in two windows and opens the Response screen.
rem run_demo.bat reset   -> also clears earlier dispatches, roles and TS-DB links (fresh rehearsal)
cd /d "%~dp0"
if not exist backend\.venv\Scripts\python.exe (echo Run setup_demo.bat first. & pause & exit /b 1)
if /i "%1"=="reset" (backend\.venv\Scripts\python scripts\preflight.py --reset) else (backend\.venv\Scripts\python scripts\preflight.py)
if errorlevel 1 (echo Fix the FAIL items above, then run again. & pause & exit /b 1)
rem stop an earlier demo still holding the ports (API :8000, website :5173)
for %%P in (8000 5173) do for /f "tokens=5" %%I in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do taskkill /F /PID %%I >nul 2>&1
timeout /t 1 /nobreak >nul
start "YATHARTH API :8000" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\python -m uvicorn app.main:app --port 8000"
start "YATHARTH web :5173" cmd /k "cd /d "%~dp0frontend" && npm run dev"
timeout /t 8 /nobreak >nul
start "" "http://localhost:5173/case/hero/replay"
