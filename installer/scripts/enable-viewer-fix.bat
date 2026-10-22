@echo off
echo === FIX: Enable Viewer di settings.json ===
set "SETTINGS=%ProgramFiles%\VEXAPACS-RIS\RIS\backend\settings.json"
if not exist "%SETTINGS%" (
  echo settings.json tidak ditemukan di %SETTINGS%
  echo Coba cari di lokasi lain...
  if exist "C:\Program Files\VEXAPACS-RIS\RIS\backend\settings.json" set "SETTINGS=C:\Program Files\VEXAPACS-RIS\RIS\backend\settings.json"
  if exist "D:\VEXAPACS-RIS\RIS\backend\settings.json" set "SETTINGS=D:\VEXAPACS-RIS\RIS\backend\settings.json"
)

echo Mengedit: %SETTINGS%
:: Backup dulu
copy "%SETTINGS%" "%SETTINGS%.backup" >nul
echo Backup dibuat: %SETTINGS%.backup

:: Baca dan update dengan PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = Get-Content '%SETTINGS%' -Raw | ConvertFrom-Json; " ^
  "$s.pacsViewerEnabled = $true; " ^
  "$s | ConvertTo-Json -Depth 20 | Set-Content '%SETTINGS%' -Encoding UTF8; " ^
  "Write-Host 'pacsViewerEnabled = true sudah diset!' -ForegroundColor Green"

echo.
echo Restart service backend...
net stop VexaRISBackend
net start VexaRISBackend
echo.
echo Selesai! Coba buka viewer lagi.
pause
