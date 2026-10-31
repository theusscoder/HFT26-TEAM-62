@echo off
rem One click: stop the demo servers, install the plate readers, read the hero plates, restart the demo fresh.
rem Plate locator: colour finder + YOLO plate detector; readers: EasyOCR (line-aware) with TrOCR fallback.
cd /d "%~dp0"
echo Stopping running demo servers (they lock files the installer needs)...
for %%P in (8000 5173) do for /f "tokens=5" %%I in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do taskkill /F /PID %%I >nul 2>&1
echo Stopping any earlier plate-reading run...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*read_plates.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 2 /nobreak >nul
echo Installing the plate readers (first time: a few minutes)...
backend\.venv\Scripts\python -m pip install transformers huggingface_hub sentencepiece protobuf scikit-image python-bidi pyclipper ninja shapely > data\cases\hero\anpr_install_log.txt 2>&1
rem easyocr without its own OpenCV build (the project already has OpenCV)
backend\.venv\Scripts\python -m pip install --no-deps easyocr >> data\cases\hero\anpr_install_log.txt 2>&1
echo Reading plates (first time also downloads the models)...
backend\.venv\Scripts\python scripts\read_plates.py hero --apply
echo.
echo Report saved: data\cases\hero\plate_reading_report.txt
echo Starting the demo...
call "%~dp0run_demo.bat" reset
