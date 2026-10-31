@echo off
rem Telegram alerts to the two case phones (+91 7330619997 perpetrator, +91 8978777355 victim).
rem 1) In Telegram: @BotFather -> /newbot -> copy the token.   2) Run this and paste it (one time).
rem 3) On EACH phone: open the bot link printed below, press START, tap "Share my phone number".
cd /d "%~dp0"
set "PY=python"
if exist backend\.venv\Scripts\python.exe set "PY=backend\.venv\Scripts\python"
if not exist backend\.env copy backend\.env.example backend\.env >nul
set /p TOKEN=Paste the bot token from @BotFather: 
%PY% scripts\telegram_setup.py %TOKEN% --save
if errorlevel 1 (pause & exit /b 1)
echo.
echo Restarting the demo so the bot starts listening...
call run_demo.bat reset
