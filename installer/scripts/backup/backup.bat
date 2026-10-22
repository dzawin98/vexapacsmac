@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup.ps1" %*
exit /b %ERRORLEVEL%

