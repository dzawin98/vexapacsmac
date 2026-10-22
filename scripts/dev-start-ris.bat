@echo off
REM Dev helper: RIS backend on an alternate port for verification probes.
REM Usage: dev-start-ris.bat [port]   (default 8098)
setlocal
set RIS_DEV_PORT=%1
if "%RIS_DEV_PORT%"=="" set RIS_DEV_PORT=8098
cd /d D:\VELOPACS-RIS\RIS\backend
set PORT=%RIS_DEV_PORT%
echo [dev-start-ris] starting RIS backend on port %RIS_DEV_PORT%
node index.js
