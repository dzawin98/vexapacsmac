@echo off
cd /d "%~dp0..\backend"

echo Menjalankan backend Node (Express)...
node index.js

echo.
echo Backend dihentikan. Tekan tombol apa saja untuk keluar.
pause
