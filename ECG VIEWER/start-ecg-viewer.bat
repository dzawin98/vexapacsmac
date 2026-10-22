@echo off
setlocal
cd /d "%~dp0"
if "%ECG_VIEWER_PORT%"=="" set "ECG_VIEWER_PORT=7771"
if "%DICOM_STORAGE_PATH%"=="" set "DICOM_STORAGE_PATH=%~dp0..\DATA"
if "%DICOMWEB_RS_ROOT%"=="" set "DICOMWEB_RS_ROOT=http://127.0.0.1:5001/rs"
node server.js
