@echo off
setlocal

cd /d "%~dp0"
title dicomweb-pacs development

echo.
echo ========================================
echo   dicomweb-pacs development launcher
echo ========================================
echo.
echo Folder: %CD%
echo Web/OHIF default: http://127.0.0.1:5001/viewer
echo DICOM modality:   AET VEXA, port 8889
echo DICOM internal:   AET VEXA_INT, port 8890
echo.

if "%PACS_DB_HOST%"=="" set "PACS_DB_HOST=localhost"
if "%PACS_DB_PORT%"=="" set "PACS_DB_PORT=5432"
if "%PACS_DB_USER%"=="" set "PACS_DB_USER=postgres"
if "%PACS_DB_PASS%"=="" set "PACS_DB_PASS=velo"
if "%PACS_DB_NAME%"=="" set "PACS_DB_NAME=velopacs_db"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan di PATH.
  echo Install Node.js dulu, lalu jalankan ulang file ini.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm tidak ditemukan di PATH.
  echo Pastikan instalasi Node.js menyertakan npm.
  echo.
  pause
  exit /b 1
)

set "PYTHON_CMD=py -3"
%PYTHON_CMD% --version >nul 2>&1
if errorlevel 1 (
  set "PYTHON_CMD=python"
  %PYTHON_CMD% --version >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] Python tidak ditemukan.
    echo Install Python dulu, lalu jalankan ulang file ini.
    echo.
    pause
    exit /b 1
  )
)

if not exist package.json (
  echo [ERROR] package.json tidak ditemukan.
  echo File ini harus dijalankan dari folder dicomweb-pacs.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo node_modules belum ada. Menjalankan npm install...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install gagal.
    pause
    exit /b 1
  )
)

%PYTHON_CMD% -c "import pynetdicom, pydicom, psycopg, openjpeg" >nul 2>&1
if errorlevel 1 (
  echo Dependency MWL Python belum lengkap. Menjalankan %PYTHON_CMD% -m pip install -r requirements-mwl.txt...
  echo.
  %PYTHON_CMD% -m pip install -r requirements-mwl.txt
  if errorlevel 1 (
    echo.
    echo [ERROR] Instalasi dependency MWL gagal.
    pause
    exit /b 1
  )
)

if "%DICOMWEB_JPEG2000_DECODER_PYTHON%"=="" (
  for /f "usebackq delims=" %%I in (`%PYTHON_CMD% -c "import sys; print(sys.executable)"`) do set "DICOMWEB_JPEG2000_DECODER_PYTHON=%%I"
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8889 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Port 8889 sedang dipakai. Tutup proses DICOM front listener lama dulu, lalu jalankan ulang.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8890 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Port 8890 sedang dipakai. Tutup proses dicomweb-pacs internal lama dulu, lalu jalankan ulang.
  echo.
  pause
  exit /b 1
)

echo Menjalankan DICOM front listener untuk C-ECHO + C-STORE proxy di port 8889...
start "dicomweb-pacs CSTORE front SCP" cmd /k "cd /d ""%CD%"" && %PYTHON_CMD% scripts\mwl_unified_scp.py"
echo.
echo Menjalankan dicomweb-pacs...
echo Tekan Ctrl+C untuk menghentikan server.
echo.

call npm start

echo.
echo Server berhenti.
pause
