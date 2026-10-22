# NEXIA FULLPACSRIS

Repository gabungan untuk deployment **NEXIA FULLPACS/RIS** di Windows Server.

## Isi Paket

- `minipacsris` - aplikasi RIS, backend API, frontend dashboard, MWL, reporting, distribution, SIMRS API.
- `dicomweb-pacs` - DICOMweb PACS, DIMSE C-STORE, query/retrieve, QIDO/WADO.
- `nexia-viewer-source` - source viewer DICOM berbasis OHIF/NEXIA viewer.
- `INSTALLFULLPACS` - installer Windows, template reverse proxy, backup script, dan uninstall service.

## Dokumen Utama

Baca [AI_AGENT_INSTALL.md](AI_AGENT_INSTALL.md) untuk langkah install lengkap di Windows Server.

## Prinsip Deployment

- Backend RIS berjalan sebagai Windows Service.
- DICOMweb PACS berjalan sebagai Windows Service.
- Frontend RIS dan viewer dibuild menjadi static file, lalu disajikan oleh Caddy/Nginx.
- Public URL sebaiknya hanya expose `80/443`, port PACS DIMSE `5757`, dan port MWL `5656` khusus node/modality yang diizinkan.
- PACS DIMSE external memakai `NEXIA:5757` untuk C-ECHO, C-STORE, Study Root C-FIND, dan C-MOVE.
- MWL resmi memakai service terpisah `NEXIARIS:5656` agar query worklist dan query PACS tidak tercampur.
- File `.env` production dibuat otomatis oleh installer dan tidak disimpan di git.

## Catatan Ukuran Repo

Folder build/generated seperti `dicomweb-pacs/public`, `dicomweb-pacs/build`, `node_modules`, viewer `dist`, data DICOM, log, dan test screenshot tidak ikut dipush. Installer akan melakukan build ulang di server.
