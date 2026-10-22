@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0scripts\dev-orchestrator.ps1" (
  echo [ERROR] scripts\dev-orchestrator.ps1 tidak ditemukan.
  echo Jalankan file ini dari folder frontend RIS yang benar.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-orchestrator.ps1"

echo.
echo Development launcher selesai.
pause
