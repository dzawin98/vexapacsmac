@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "ROOT=%CD%"

set "DESKTOP_DIR=%ROOT%\DESKTOP VIEWER"
set "DESKTOP_SSR_DIR=%ROOT%\DESKTOP VIEWER SSR"
set "MOBILITY_DIR=%ROOT%\MOBILITY VIEWER"
set "PACS_DIR=%ROOT%\PACS"
set "RIS_DIR=%ROOT%\RIS\frontend"
set "RIS_BACKEND_DIR=%ROOT%\RIS\backend"
set "BACKUP_AGENT_DIR=%ROOT%\tools\backup-agent"
set "SIMRS_BRIDGE_DIR=%ROOT%\tools\simrs-db-bridge"
set "ECG_DIR=%ROOT%\ECG VIEWER"
set "DICOM_DATA_DIR=%ROOT%\DATA"
set "MWL_VENV_PYTHON=%RIS_BACKEND_DIR%\mwl_scp\.venv\Scripts\python.exe"

if "%DB_HOST%"=="" set "DB_HOST=localhost"
if "%DB_PORT%"=="" set "DB_PORT=5432"
if "%DB_USER%"=="" set "DB_USER=postgres"
if "%DB_PASS%"=="" set "DB_PASS=velo"
if "%DB_NAME%"=="" set "DB_NAME=veloris_db"
if "%PACS_DB_HOST%"=="" set "PACS_DB_HOST=localhost"
if "%PACS_DB_PORT%"=="" set "PACS_DB_PORT=5432"
if "%PACS_DB_USER%"=="" set "PACS_DB_USER=postgres"
if "%PACS_DB_PASS%"=="" set "PACS_DB_PASS=velo"
if "%PACS_DB_NAME%"=="" set "PACS_DB_NAME=velopacs_db"
if "%DICOM_STORAGE_PATH%"=="" set "DICOM_STORAGE_PATH=%DICOM_DATA_DIR%"
if "%DICOMWEB_PACS_STORAGE_PATH%"=="" set "DICOMWEB_PACS_STORAGE_PATH=%DICOM_DATA_DIR%"
if "%DICOMWEB_PACS_ROOT%"=="" set "DICOMWEB_PACS_ROOT=http://127.0.0.1:5001"
if "%DICOMWEB_DIMSE_OUTBOUND_COMPRESSION%"=="" set "DICOMWEB_DIMSE_OUTBOUND_COMPRESSION=false"
if "%DICOMWEB_DIMSE_STORAGE_COMPRESSION%"=="" set "DICOMWEB_DIMSE_STORAGE_COMPRESSION=true"
if "%DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX%"=="" set "DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX=1.2.840.10008.1.2.4.90"
if "%DICOMWEB_RAW_CACHE_ENABLED%"=="" set "DICOMWEB_RAW_CACHE_ENABLED=true"
if "%DICOMWEB_FRAME_CACHE_MB%"=="" set "DICOMWEB_FRAME_CACHE_MB=512"
if "%VEXA_RIS_SHARED_SECRET%"=="" if not "%NEXIA_RIS_SHARED_SECRET%"=="" set "VEXA_RIS_SHARED_SECRET=%NEXIA_RIS_SHARED_SECRET%"
if "%VEXA_RIS_SHARED_SECRET%"=="" set "VEXA_RIS_SHARED_SECRET=Velodesktopview89287579@#VEXA@"
if "%NEXIA_RIS_SHARED_SECRET%"=="" set "NEXIA_RIS_SHARED_SECRET=%VEXA_RIS_SHARED_SECRET%"
if "%VEXA_MOBILE_RIS_SHARED_SECRET%"=="" if not "%NEXIA_MOBILE_RIS_SHARED_SECRET%"=="" set "VEXA_MOBILE_RIS_SHARED_SECRET=%NEXIA_MOBILE_RIS_SHARED_SECRET%"
if "%VEXA_MOBILE_RIS_SHARED_SECRET%"=="" set "VEXA_MOBILE_RIS_SHARED_SECRET=Velomobile987397497987#VEXA@"
if "%NEXIA_MOBILE_RIS_SHARED_SECRET%"=="" set "NEXIA_MOBILE_RIS_SHARED_SECRET=%VEXA_MOBILE_RIS_SHARED_SECRET%"
if "%VEXA_PROGRAM_DATA_DIR%"=="" set "VEXA_PROGRAM_DATA_DIR=%ROOT%\.programdata"
if "%VEXA_BACKUP_CONFIG_PATH%"=="" set "VEXA_BACKUP_CONFIG_PATH=%VEXA_PROGRAM_DATA_DIR%\backup.config.json"
if "%VEXA_BACKUP_SCRIPT_PATH%"=="" set "VEXA_BACKUP_SCRIPT_PATH=%ROOT%\installer\scripts\backup\backup.ps1"
if "%VEXA_RESTORE_SCRIPT_PATH%"=="" set "VEXA_RESTORE_SCRIPT_PATH=%ROOT%\installer\scripts\backup\restore.ps1"
if "%SIMRS_API_KEY%"=="" set "SIMRS_API_KEY=vexapacs-simrs-local-2026"
if "%SIMRS_DB_BRIDGE_ENABLED%"=="" set "SIMRS_DB_BRIDGE_ENABLED=true"
if "%SIMRS_DB_BRIDGE_POLL_MS%"=="" set "SIMRS_DB_BRIDGE_POLL_MS=5000"
if "%VIEWER_DEV_MODE%"=="" set "VIEWER_DEV_MODE=true"
if "%VIEWER_THIN_SSR_ENABLED%"=="" set "VIEWER_THIN_SSR_ENABLED=true"
if "%MOBILE_DICOMWEB_ROOT%"=="" (
  if /i "%VIEWER_THIN_SSR_ENABLED%"=="true" (
    set "MOBILE_DICOMWEB_ROOT=http://127.0.0.1:5994"
  ) else (
    set "MOBILE_DICOMWEB_ROOT=%DICOMWEB_PACS_ROOT%"
  )
)

if /i "%~1"=="stop" goto :stop
if /i "%~1"=="status" goto :status
if not "%~1"=="" (
  echo Penggunaan:
echo   %~nx0
echo   %~nx0 status
echo   %~nx0 stop
  echo.
  echo Opsional:
  echo   set VIEWER_DEV_MODE=true  ^(pakai Vite dev server untuk hot reload^)
  exit /b 1
)

title VEXAPACS-RIS - All Development Apps

echo.
echo ============================================================
echo   VEXAPACS-RIS - ALL APPS DEVELOPMENT LAUNCHER
echo ============================================================
echo   RIS Frontend    http://127.0.0.1:8080
echo   RIS Backend     http://127.0.0.1:3001
echo   Backup Agent    http://127.0.0.1:3099
echo   SIMRS DB Bridge http://127.0.0.1:3109
echo   PACS DICOMweb   http://127.0.0.1:5001
echo   Legacy Viewer   http://127.0.0.1:5991
echo   Primary Viewer  http://127.0.0.1:5994/view
echo   Mobility Viewer http://127.0.0.1:5992
echo   ECG Viewer      http://127.0.0.1:7771/viewer
echo   PACS DIMSE      AET VEXA, port 8889 ^(internal VEXA_INT, 8890^)
echo   MWL Service     AET NEXIARIS, port 5656
echo   DICOM Storage   %DICOM_DATA_DIR%
echo   PACS Database   %PACS_DB_NAME%
echo   RIS Database    %DB_NAME%
echo ============================================================
echo.

call :require_command node Node.js
if errorlevel 1 exit /b 1
call :require_command npm npm
if errorlevel 1 exit /b 1
call :find_python
if errorlevel 1 exit /b 1
if "%DICOMWEB_JPEG2000_DECODER_PYTHON%"=="" (
  for /f "usebackq delims=" %%I in (`%PYTHON_CMD% -c "import sys; print(sys.executable)"`) do set "DICOMWEB_JPEG2000_DECODER_PYTHON=%%I"
)

if not exist "%DICOM_DATA_DIR%" mkdir "%DICOM_DATA_DIR%"
if not exist "%VEXA_PROGRAM_DATA_DIR%" mkdir "%VEXA_PROGRAM_DATA_DIR%"

call :clear_stale_services
call :check_ports
if errorlevel 1 (
  echo.
  echo [ERROR] Satu atau lebih port service sedang dipakai.
  echo Jalankan "%~nx0 stop" bila proses tersebut berasal dari launcher ini.
  exit /b 1
)

call :ensure_project "%DESKTOP_DIR%" "Desktop Viewer"
if errorlevel 1 exit /b 1
if /i "%VIEWER_THIN_SSR_ENABLED%"=="true" (
  call :ensure_project "%DESKTOP_SSR_DIR%" "Diagnostic Viewer"
  if errorlevel 1 exit /b 1
)
call :ensure_project "%MOBILITY_DIR%" "Mobility Viewer"
if errorlevel 1 exit /b 1
call :ensure_project "%PACS_DIR%" "PACS"
if errorlevel 1 exit /b 1
call :ensure_project "%RIS_DIR%" "RIS Frontend"
if errorlevel 1 exit /b 1
call :ensure_project "%RIS_BACKEND_DIR%" "RIS Backend"
if errorlevel 1 exit /b 1
call :ensure_project "%BACKUP_AGENT_DIR%" "Backup Agent"
if errorlevel 1 exit /b 1
call :ensure_project "%SIMRS_BRIDGE_DIR%" "SIMRS DB Bridge"
if errorlevel 1 exit /b 1
call :ensure_project "%ECG_DIR%" "ECG Viewer"
if errorlevel 1 exit /b 1

echo [SETUP] Memastikan database PostgreSQL tersedia...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\installer\scripts\init-postgres.ps1" -DbHost "%DB_HOST%" -DbPort "%DB_PORT%" -DbUser "%DB_USER%" -DbPass "%DB_PASS%" -RisDbName "%DB_NAME%" -PacsDbName "%PACS_DB_NAME%"
if errorlevel 1 exit /b 1

%PYTHON_CMD% -c "import pynetdicom, pydicom, psycopg, openjpeg" >nul 2>&1
if errorlevel 1 (
  echo [SETUP] Memasang dependency Python PACS DIMSE...
  %PYTHON_CMD% -m pip install -r "%PACS_DIR%\requirements-mwl.txt"
  if errorlevel 1 exit /b 1
)

if not exist "%MWL_VENV_PYTHON%" (
  echo [SETUP] Membuat virtual environment MWL Service...
  %PYTHON_CMD% -m venv "%RIS_BACKEND_DIR%\mwl_scp\.venv"
  if errorlevel 1 exit /b 1
)

"%MWL_VENV_PYTHON%" -c "import pynetdicom, pydicom" >nul 2>&1
if errorlevel 1 (
  echo [SETUP] Memasang dependency Python MWL Service...
  "%MWL_VENV_PYTHON%" -m pip install -r "%RIS_BACKEND_DIR%\mwl_scp\requirements.txt"
  if errorlevel 1 exit /b 1
)

echo [START] PACS DICOMweb
start /b "" cmd /d /c "cd /d ""%PACS_DIR%"" && npm start"

echo [START] PACS DIMSE
start /b "" cmd /d /c "cd /d ""%PACS_DIR%"" && %PYTHON_CMD% scripts\mwl_unified_scp.py"

echo [START] RIS Backend
start /b "" cmd /d /c "cd /d ""%RIS_BACKEND_DIR%"" && set PORT=3001&& set VEXA_DIRECT_VIEWER_LAUNCH=true&& set VEXA_PROGRAM_DATA_DIR=%VEXA_PROGRAM_DATA_DIR%&& set VEXA_BACKUP_CONFIG_PATH=%VEXA_BACKUP_CONFIG_PATH%&& set VEXA_BACKUP_SCRIPT_PATH=%VEXA_BACKUP_SCRIPT_PATH%&& set VEXA_RESTORE_SCRIPT_PATH=%VEXA_RESTORE_SCRIPT_PATH%&& node index.js"

echo [START] Backup Agent
start /b "" cmd /d /c "cd /d ""%BACKUP_AGENT_DIR%"" && set BACKUP_AGENT_PORT=3099&& set VEXA_PROGRAM_DATA_DIR=%VEXA_PROGRAM_DATA_DIR%&& set VEXA_BACKUP_CONFIG_PATH=%VEXA_BACKUP_CONFIG_PATH%&& set VEXA_BACKUP_SCRIPT_PATH=%VEXA_BACKUP_SCRIPT_PATH%&& set VEXA_RESTORE_SCRIPT_PATH=%VEXA_RESTORE_SCRIPT_PATH%&& set DICOM_STORAGE_PATH=%DICOM_STORAGE_PATH%&& set DB_HOST=%DB_HOST%&& set DB_PORT=%DB_PORT%&& set DB_USER=%DB_USER%&& set DB_PASS=%DB_PASS%&& set DB_NAME=%DB_NAME%&& set PACS_DB_NAME=%PACS_DB_NAME%&& node server.js"

echo [START] SIMRS DB Bridge
start /b "" cmd /d /c "cd /d ""%SIMRS_BRIDGE_DIR%"" && set SIMRS_DB_BRIDGE_PORT=3109&& set SIMRS_DB_BRIDGE_ENABLED=%SIMRS_DB_BRIDGE_ENABLED%&& set SIMRS_DB_BRIDGE_POLL_MS=%SIMRS_DB_BRIDGE_POLL_MS%&& set SIMRS_API_KEY=%SIMRS_API_KEY%&& set VEXA_SETTINGS_PATH=%RIS_BACKEND_DIR%\settings.json&& node server.js"

echo [WAIT ] Menunggu service inti siap (3001, 3099, 3109, 5001)...
powershell -NoProfile -Command "$want=@(3001,3099,3109,5001); $start=Get-Date; $deadline=$start.AddSeconds(25); while((Get-Date) -lt $deadline){ $up=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $want -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique); if($up.Count -ge $want.Count){ Write-Host ('[WAIT ] Service inti siap dalam ' + [int]((Get-Date) - $start).TotalSeconds + ' s'); exit 0 }; Start-Sleep -Milliseconds 400 }; Write-Host '[WARN] Service inti belum semuanya listening - launcher lanjut, cek nanti dengan status.'"

echo [START] MWL Service
if exist "%MWL_VENV_PYTHON%" (
  start /b "" cmd /d /c "cd /d ""%RIS_DIR%"" && set PORT=3001&& ""%MWL_VENV_PYTHON%"" ""%RIS_BACKEND_DIR%\mwl_scp\vexa_mwl_scp.py"""
) else (
  start /b "" cmd /d /c "cd /d ""%RIS_DIR%"" && set PORT=3001&& %PYTHON_CMD% ""%RIS_BACKEND_DIR%\mwl_scp\vexa_mwl_scp.py"""
)

echo [START] RIS Frontend
start /b "" cmd /d /c "cd /d ""%RIS_DIR%"" && set VITE_DEV_BACKEND_TARGET=http://127.0.0.1:3001&& set VITE_DEV_BACKUP_AGENT_TARGET=http://127.0.0.1:3099&& set VITE_DEV_DICOMWEB_TARGET=http://127.0.0.1:5001&& npm run dev -- --host 0.0.0.0 --port 8080"

if /i "%VIEWER_DEV_MODE%"=="true" (
  echo [START] Desktop Viewer - Vite development server
  start /b "" cmd /d /c "cd /d ""%DESKTOP_DIR%"" && set VEXA_RIS_SHARED_SECRET=%VEXA_RIS_SHARED_SECRET%&& set NEXIA_RIS_SHARED_SECRET=%NEXIA_RIS_SHARED_SECRET%&& set DICOMWEB_PACS_ROOT=%DICOMWEB_PACS_ROOT%&& npm run dev -- --host 0.0.0.0 --port 5991 --strictPort"

  echo [START] Mobility Viewer - Vite development server
  start /b "" cmd /d /c "cd /d ""%MOBILITY_DIR%"" && set VEXA_RIS_SHARED_SECRET=%VEXA_MOBILE_RIS_SHARED_SECRET%&& set NEXIA_RIS_SHARED_SECRET=%NEXIA_MOBILE_RIS_SHARED_SECRET%&& set DICOMWEB_PACS_ROOT=%MOBILE_DICOMWEB_ROOT%&& set VITE_MOBILE_HYBRID_SSR=true&& npm run dev -- --host 0.0.0.0 --port 5992 --strictPort"
) else (
  call :ensure_viewer_dist "%DESKTOP_DIR%" "Desktop Viewer"
  if errorlevel 1 exit /b 1
  call :ensure_viewer_dist "%MOBILITY_DIR%" "Mobility Viewer"
  if errorlevel 1 exit /b 1

  echo [START] Desktop Viewer - optimized static server
  start /b "" cmd /d /c "cd /d ""%DESKTOP_DIR%"" && set PORT=5991&& set VEXA_RIS_SHARED_SECRET=%VEXA_RIS_SHARED_SECRET%&& set NEXIA_RIS_SHARED_SECRET=%NEXIA_RIS_SHARED_SECRET%&& set DICOMWEB_PACS_ROOT=%DICOMWEB_PACS_ROOT%&& node server/index.mjs"

  echo [START] Mobility Viewer - optimized static server
  start /b "" cmd /d /c "cd /d ""%MOBILITY_DIR%"" && set PORT=5992&& set VEXA_RIS_SHARED_SECRET=%VEXA_MOBILE_RIS_SHARED_SECRET%&& set NEXIA_RIS_SHARED_SECRET=%NEXIA_MOBILE_RIS_SHARED_SECRET%&& set DICOMWEB_PACS_ROOT=%MOBILE_DICOMWEB_ROOT%&& set VITE_MOBILE_HYBRID_SSR=true&& node server/index.mjs"
)

if /i "%VIEWER_THIN_SSR_ENABLED%"=="true" (
  call :ensure_viewer_dist "%DESKTOP_SSR_DIR%" "Diagnostic Viewer"
  if errorlevel 1 exit /b 1
  echo [START] Diagnostic Viewer - lossless DICOM diagnostic rendering
  start /b "" cmd /d /c "cd /d ""%DESKTOP_SSR_DIR%"" && set PORT=5994&& set VIEWER_DIST_DIR=%DESKTOP_DIR%\dist&& set DICOM_STORAGE_PATH=%DICOM_STORAGE_PATH%&& set DICOMWEB_PACS_ROOT=%DICOMWEB_PACS_ROOT%&& set DICOMWEB_JPEG2000_DECODER_PYTHON=%DICOMWEB_JPEG2000_DECODER_PYTHON%&& set VEXA_RIS_SHARED_SECRET=%VEXA_RIS_SHARED_SECRET%&& set NEXIA_RIS_SHARED_SECRET=%NEXIA_RIS_SHARED_SECRET%&& node server/index.mjs"
)

echo [WAIT] Waiting for viewer servers to be ready...
powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { $d = Get-NetTCPConnection -State Listen -LocalPort 5991 -ErrorAction SilentlyContinue; $m = Get-NetTCPConnection -State Listen -LocalPort 5992 -ErrorAction SilentlyContinue; if ($d -and $m) { Write-Host 'Viewer servers ready'; exit 0 }; Start-Sleep -Seconds 1 }; Write-Host 'WARNING: Viewer servers may not be ready'"
if /i "%VIEWER_THIN_SSR_ENABLED%"=="true" powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { if (Get-NetTCPConnection -State Listen -LocalPort 5994 -ErrorAction SilentlyContinue) { Write-Host 'Diagnostic Viewer ready'; exit 0 }; Start-Sleep -Seconds 1 }; Write-Host 'WARNING: Diagnostic Viewer may not be ready'"

echo [START] ECG Viewer
start /b "" cmd /d /c "cd /d ""%ECG_DIR%"" && set ECG_VIEWER_PORT=7771&& set DICOM_STORAGE_PATH=%DICOM_DATA_DIR%&& set DICOMWEB_RS_ROOT=http://127.0.0.1:5001/rs&& node server.js"

echo.
echo ============================================================
echo Semua proses sudah diperintahkan untuk start dalam CMD ini.
echo Gunakan CMD baru untuk:
echo   %~nx0 status
echo   %~nx0 stop
echo ============================================================
echo.

:monitor
"%SystemRoot%\System32\timeout.exe" /t 3600 /nobreak >nul
goto :monitor

:find_python
where py >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_CMD=py -3"
  exit /b 0
)
where python >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_CMD=python"
  exit /b 0
)
echo [ERROR] Python tidak ditemukan di PATH.
exit /b 1

:require_command
where %~1 >nul 2>&1
if errorlevel 1 (
  echo [ERROR] %~2 tidak ditemukan di PATH.
  exit /b 1
)
exit /b 0

:ensure_project
if not exist "%~1\package.json" (
  echo [ERROR] package.json %~2 tidak ditemukan: %~1
  exit /b 1
)
if not exist "%~1\node_modules" (
  echo [SETUP] Memasang dependency %~2...
  pushd "%~1"
  call npm install
  set "INSTALL_EXIT=!ERRORLEVEL!"
  popd
  if not "!INSTALL_EXIT!"=="0" exit /b !INSTALL_EXIT!
)
exit /b 0

:ensure_viewer_dist
if exist "%~1\dist\index.html" exit /b 0
echo [BUILD] %~2 optimized bundle belum ada, build sekali dulu...
pushd "%~1"
call npm run build
set "BUILD_EXIT=!ERRORLEVEL!"
popd
if not "!BUILD_EXIT!"=="0" (
  echo [ERROR] Build %~2 gagal.
  exit /b !BUILD_EXIT!
)
exit /b 0

:clear_stale_services
set "VEXA_DEV_PORTS=3001,3099,3109,5001,5656,5757,5991,5992,5994,7771,8080,8889,8890"
if not "%~1"=="" set "VEXA_DEV_PORTS=%~1"
if /i "%VEXA_SKIP_CLEANUP%"=="1" (
  echo [CHECK] Pembersihan layanan lama dilewati ^(VEXA_SKIP_CLEANUP=1^).
  exit /b 0
)
echo [CHECK] Membersihkan layanan dev VEXAPACS-RIS yang masih berjalan...
powershell -NoProfile -Command "$ports=@(%VEXA_DEV_PORTS%); $c=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }); if(-not $c){ Write-Host '[CLEAN] tidak ada layanan lama'; exit 0 }; $ids=@($c | Select-Object -ExpandProperty OwningProcess -Unique); $procs=@{}; Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.Id]=$_.ProcessName }; $killed=@(); foreach($x in $c){ $owner=[int]$x.OwningProcess; if($owner -eq 0 -or $owner -eq 4){ continue }; $name=''; if($procs.ContainsKey($owner)){ $name=$procs[$owner] }; if($name -notmatch '^(node|python|py)$'){ Write-Host ('[SKIP ] Port ' + $x.LocalPort + ' PID ' + $owner + ' (' + $name + ') bukan layanan dev'); continue }; if($killed -contains $owner){ continue }; $killed+=$owner; Write-Host ('[CLEAN] Port ' + $x.LocalPort + ' PID ' + $owner + ' ' + $name); taskkill.exe /PID $owner /T /F | Out-Null }"
"%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul
exit /b 0

:check_ports
powershell -NoProfile -Command "$ports=@(3001,3099,3109,5001,5656,5757,5991,5992,5994,7771,8080,8889,8890); $busy=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object); if($busy.Count -gt 0){ Write-Host ('[BUSY ] Port ' + ($busy -join ', ') + ' sedang dipakai.'); exit 1 }"
if errorlevel 1 exit /b 1
exit /b 0

:status
echo.
echo VEXAPACS-RIS service port status:
echo.
powershell -NoProfile -Command "$ports=@(3001,3099,3109,5001,5656,5757,5991,5992,5994,7771,8080,8889,8890); $c=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }); $ids=@($c | Select-Object -ExpandProperty OwningProcess -Unique); $procs=@{}; Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.Id]=$_.ProcessName }; foreach($p in $ports){ $hit=@($c | Where-Object { $_.LocalPort -eq $p }); if($hit.Count -gt 0){ $o=[int]$hit[0].OwningProcess; $n=''; if($procs.ContainsKey($o)){ $n=$procs[$o] }; Write-Host ('[UP  ] ' + $p + '  PID ' + $o + '  ' + $n) } else { Write-Host ('[DOWN] ' + $p) } }"
exit /b 0

:stop
echo.
echo Menghentikan proses yang listen pada port VEXAPACS-RIS...
powershell -NoProfile -Command "$ports=@(3001,3099,3109,5001,5656,5757,5991,5992,5994,7771,8080,8889,8890); $c=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }); $done=@(); foreach($x in $c){ $o=[int]$x.OwningProcess; if($done -contains $o){ continue }; $done+=$o; Write-Host ('[STOP] Port ' + $x.LocalPort + ' PID ' + $o); taskkill.exe /PID $o /T /F | Out-Null }"
echo Selesai.
exit /b 0
