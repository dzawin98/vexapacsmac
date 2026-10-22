@echo off
setlocal

cd /d "%~dp0"
title NEXIA VIEWER development

set "OHIF_PORT=5001"
set "APP_CONFIG=config/default.js"
set "TEST_ENV="
set "COVERAGE="
set "WDS_SOCKET_HOST=localhost"
set "WDS_SOCKET_PORT=5001"

echo.
echo ========================================
echo   NEXIA VIEWER / dicomweb-pacs dev
echo ========================================
echo.
echo Folder: %CD%
echo Viewer: http://localhost:5001/viewer
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan di PATH.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm tidak ditemukan di PATH.
  pause
  exit /b 1
)

if not exist package.json (
  echo [ERROR] package.json tidak ditemukan. Jalankan file ini dari folder dicomweb-pacs.
  pause
  exit /b 1
)

if not exist node_modules (
  echo node_modules belum ada. Menjalankan npm install...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install gagal.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports = 5001; foreach ($port in $ports) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"

if exist "platform\app\dist" (
  rmdir /s /q "platform\app\dist"
)

echo Menjalankan dicomweb-pacs dengan viewer static NEXIA...
echo Tekan Ctrl+C untuk menghentikan server.
echo.

call npm start

echo.
echo Server berhenti.
pause
