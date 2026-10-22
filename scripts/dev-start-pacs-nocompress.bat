@echo off
rem Dev helper: start dicomweb-pacs with storage compression DISABLED (writeTransfer unset).
rem Used to compare the C-STORE replace path against the compressed path.
setlocal
set "DICOMWEB_PACS_STORAGE_PATH=D:\VELOPACS-RIS\DATA"
set "DICOM_STORAGE_PATH=D:\VELOPACS-RIS\DATA"
set "PACS_DB_HOST=localhost"
set "PACS_DB_PORT=5432"
set "PACS_DB_USER=postgres"
set "PACS_DB_PASS=velo"
set "PACS_DB_NAME=velopacs_db"
set "DICOMWEB_DIMSE_STORAGE_COMPRESSION=false"
set "DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX=1.2.840.10008.1.2"
cd /d "D:\VELOPACS-RIS\PACS"
npm start > "D:\VELOPACS-RIS\PACS\bench-pacs-nocompress.out.log" 2>&1
