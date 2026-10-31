@echo off
rem Real SMS to the two case numbers (+91 7330619997 perpetrator, +91 8978777355 victim). Pick ONE provider:
rem   Twilio  : twilio.com free trial -> Phone Numbers > Verified Caller IDs -> verify BOTH numbers -> copy Account SID, Auth Token, Twilio number
rem   Fast2SMS: fast2sms.com -> Dev API -> copy API key (Quick SMS route, needs a small wallet balance)
cd /d "%~dp0"
if not exist backend\.env copy backend\.env.example backend\.env >nul
set PY=backend\.venv\Scripts\python
set /p PROV=Provider [twilio/fast2sms/test]: 
if /i "%PROV%"=="twilio" goto twilio
if /i "%PROV%"=="fast2sms" goto fast2sms
goto test
:twilio
set /p SID=Account SID: 
set /p TOK=Auth Token: 
set /p FROM=Twilio phone number e.g. +1xxxxxxxxxx: 
%PY% scripts\sms_setup.py twilio %SID% %TOK% %FROM%
goto done
:fast2sms
set /p KEY=Fast2SMS API key: 
%PY% scripts\sms_setup.py fast2sms %KEY%
goto done
:test
%PY% scripts\sms_setup.py test
:done
echo.
echo A test SMS was just sent to both numbers (see status above).
echo Now run reset_demo.bat so the backend picks up the settings.
pause
