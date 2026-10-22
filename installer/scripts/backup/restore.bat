@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1" %*
exit /b %ERRORLEVEL%

