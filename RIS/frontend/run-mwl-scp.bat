@echo off
setlocal
cd /d "%~dp0"

set "BACKEND_DIR=%~dp0..\backend"
set "VENV_DIR=%BACKEND_DIR%\mwl_scp\.venv"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"
set "PYTHON_BOOTSTRAP=py -3"

echo Mengecek port MWL SCP...
powershell -NoProfile -ExecutionPolicy Bypass -File "%BACKEND_DIR%\mwl_scp\check_mwl_port.ps1" -EnvPath "%BACKEND_DIR%\.env" -DefaultPort 5656
if errorlevel 1 goto :port_busy

if not exist "%PYTHON_EXE%" (
  echo Menyiapkan virtual environment MWL SCP...
  %PYTHON_BOOTSTRAP% -m venv "%VENV_DIR%"
  if errorlevel 1 (
    set "PYTHON_BOOTSTRAP=python"
    python -m venv "%VENV_DIR%"
  )
  if errorlevel 1 goto :error
)

echo Memastikan dependency MWL SCP tersedia...
"%PYTHON_EXE%" -m pip install -r "%BACKEND_DIR%\mwl_scp\requirements.txt"
if errorlevel 1 goto :error

echo Menjalankan NEXIA MWL SCP...
"%PYTHON_EXE%" "%BACKEND_DIR%\mwl_scp\vexa_mwl_scp.py"
goto :eof

:error
echo.
echo Gagal menjalankan MWL SCP. Pastikan Python tersedia di PATH.
pause
exit /b 1

:port_busy
echo.
echo MWL SCP tidak dijalankan karena port sedang dipakai aplikasi lain.
pause
exit /b 2
