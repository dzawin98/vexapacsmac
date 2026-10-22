@echo off
echo === FIX: isInternalViewerBaseUrl - Port Check ===
echo.
echo Ini akan fix bug di index.js yang menyebabkan viewer 404
echo Bug: http://127.0.0.1:5991 dianggap internal, di-rewrite ke port 3001
echo Fix: Cek port - kalau ada port, jangan rewrite
echo.

set "JSFILE=%ProgramFiles%\VEXAPACS-RIS\RIS\backend\index.js"
if not exist "%JSFILE%" (
  echo File tidak ditemukan: %JSFILE%
  echo Coba cari di lokasi lain...
  if exist "C:\Program Files\VEXAPACS-RIS\RIS\backend\index.js" set "JSFILE=C:\Program Files\VEXAPACS-RIS\RIS\backend\index.js"
  if exist "D:\VEXAPACS-RIS\RIS\backend\index.js" set "JSFILE=D:\VEXAPACS-RIS\RIS\backend\index.js"
)

echo Fixing: %JSFILE%
copy "%JSFILE%" "%JSFILE%.backup" >nul
echo Backup dibuat: %JSFILE%.backup

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$f = Get-Content '%JSFILE%' -Raw; " ^
  "if ($f.Contains('if (url.port) return false;')) { " ^
  "  Write-Host 'Fix sudah di-apply sebelumnya!' -ForegroundColor Yellow " ^
  "} else { " ^
  "  $old = 'const url = new URL(value);'; " ^
  "  $nl = [char]13 + [char]10; " ^
  "  $new = 'const url = new URL(value);' + $nl + '        // If it has an explicit port, it is a direct viewer URL' + $nl + '        // and should NOT be rewritten through the backend origin.' + $nl + '        if (url.port) return false;'; " ^
  "  $fixed = $f.Replace($old, $new); " ^
  "  if ($fixed -ne $f) { " ^
  "    [System.IO.File]::WriteAllText('%JSFILE%', $fixed); " ^
  "    Write-Host 'Fix berhasil di-apply!' -ForegroundColor Green " ^
  "  } else { " ^
  "    Write-Host 'Pattern tidak ditemukan, cek manual!' -ForegroundColor Red " ^
  "  } " ^
  "}"

echo.
echo Restart backend service...
net stop VexaRISBackend 2>nul
timeout /t 2 /nobreak >nul
net start VexaRISBackend 2>nul

echo.
echo Selesai! Coba buka viewer lagi di browser.
pause
