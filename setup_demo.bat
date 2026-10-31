@echo off
rem One-time setup on Windows: Python venv + backend packages + frontend packages, then the pre-demo check.
cd /d "%~dp0"
set "PY="
py -3.12 -V >nul 2>&1 && set "PY=py -3.12"
if not defined PY py -3.11 -V >nul 2>&1 && set "PY=py -3.11"
if not defined PY set "PY=python"
echo Using %PY%
if not exist backend\.venv\Scripts\python.exe (
  %PY% -m venv backend\.venv || (echo Could not create the venv. Install Python 3.12 from python.org & pause & exit /b 1)
)
backend\.venv\Scripts\python -m pip install --upgrade pip
backend\.venv\Scripts\python -m pip install -r backend\requirements.txt -r backend\requirements-cv.txt || (echo pip install failed & pause & exit /b 1)
pushd frontend
call npm install || (echo npm install failed. Install Node 18+ from nodejs.org & popd & pause & exit /b 1)
popd
backend\.venv\Scripts\python scripts\preflight.py
pause
