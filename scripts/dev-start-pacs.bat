@echo off
rem Dev helper: start dicomweb-pacs with the same env START-ALL-APPS.bat uses.
rem Detached via "start", so it survives agent/session restarts.
setlocal
set "DICOMWEB_PACS_STORAGE_PATH=D:\VELOPACS-RIS\DATA"
set "DICOM_STORAGE_PATH=D:\VELOPACS-RIS\DATA"
set "PACS_DB_HOST=localhost"
set "PACS_DB_PORT=5432"
set "PACS_DB_USER=postgres"
set "PACS_DB_PASS=velo"
set "PACS_DB_NAME=velopacs_db"
set "DICOMWEB_DIMSE_STORAGE_COMPRESSION=true"

rem JPEG 2000 decode needs a python that can "import openjpeg". Without it every
rem compressed frame fails to decode and the viewer gets 500s, so a dev restart has to
rem derive the interpreter the same way START-ALL-APPS.bat does (:find_python).
if "%DICOMWEB_JPEG2000_DECODER_PYTHON%"=="" (
  for /f "usebackq delims=" %%I in (`py -3 -c "import openjpeg,sys;print(sys.executable)" 2^>nul`) do set "DICOMWEB_JPEG2000_DECODER_PYTHON=%%I"
)
if "%DICOMWEB_JPEG2000_DECODER_PYTHON%"=="" (
  for /f "usebackq delims=" %%I in (`python -c "import openjpeg,sys;print(sys.executable)" 2^>nul`) do set "DICOMWEB_JPEG2000_DECODER_PYTHON=%%I"
)
if "%DICOMWEB_JPEG2000_DECODER_PYTHON%"=="" (
  echo [WARN] python dengan modul openjpeg tidak ditemukan - frame JPEG 2000 akan gagal dirender.
) else (
  echo [dev-start-pacs] JPEG 2000 decoder python: %DICOMWEB_JPEG2000_DECODER_PYTHON%
)

cd /d "D:\VELOPACS-RIS\PACS"
npm start > "%LOCALAPPDATA%\Temp\pacs-dev.log" 2>&1
