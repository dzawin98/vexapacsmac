@echo off
cd /d "%~dp0"

echo Menyalakan backend development di jendela terpisah...
start "ris-backend" cmd /k "cd /d ""%~dp0..\backend"" && node index.js"

echo Menyalakan DICOM MWL SCP di jendela terpisah...
start "nexia-mwl-scp" cmd /k "cd /d ""%~dp0"" && run-mwl-scp.bat"

echo Menunggu backend bootstrap sebentar...
timeout /t 3 /nobreak >nul

echo Menjalankan frontend Vite dalam mode development...
npm run dev

echo.
echo Frontend dihentikan. Tekan tombol apa saja untuk keluar.
pause
