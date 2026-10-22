@echo off
cd /d "D:\VELOPACS-RIS\PACS"
start "PACS" /MIN cmd /c "npm start"
timeout /t 10 /nobreak >nul

cd /d "D:\VELOPACS-RIS\DESKTOP VIEWER"
set PORT=5991
set NEXIA_RIS_SHARED_SECRET=Velodesktopview89287579@#VEXA@
set DICOMWEB_PACS_ROOT=http://127.0.0.1:5001
start "DesktopViewer" /MIN cmd /c "node server/index.mjs"
timeout /t 6 /nobreak >nul
