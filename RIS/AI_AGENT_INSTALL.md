# AI Agent Install Notes - NEXIA FULLPACSRIS

Dokumen ini dibuat agar AI agent/operator bisa memasang paket ini di Windows Server dengan alur yang konsisten.

## 1. Prasyarat Server

Install di Windows Server:

- Node.js LTS 20 atau lebih baru
- npm bawaan Node.js
- Yarn classic: `npm install -g yarn`
- Python 3
- MariaDB Server atau MySQL Server
- NSSM: contoh path `C:\nssm\win64\nssm.exe`
- Caddy atau Nginx for Windows sebagai reverse proxy
- Git for Windows

Pastikan PowerShell dijalankan sebagai Administrator ketika install service.

## 2. Clone Repository

```powershell
cd C:\NEXIA
git clone https://gitea.sitermid.my.id/dzawin/FULLPACSRIS.git FULLPACSRIS-SOURCE
cd C:\NEXIA\FULLPACSRIS-SOURCE\INSTALLFULLPACS
```

## 3. Edit Konfigurasi Installer

Edit `INSTALLFULLPACS\fullpacs.config.json`.

Field penting:

- `installRoot`: lokasi hasil install production, default `C:\NEXIA\FULLPACS`
- `domain`: domain/IP yang dipakai client
- `publicBaseUrl`: URL public aplikasi, contoh `https://pacs.rs.local`
- `ports.backend`: default `3001`
- `ports.dicomwebHttp`: default `5001`
- `ports.dicomDimse`: default `5757`, port external PACS untuk C-ECHO/C-STORE/C-FIND/C-MOVE
- `ports.mwlScp`: default `5656`, port external khusus MWL C-FIND
- `ports.dicomInternalDimse`: default `8889`, port internal DICOMweb PACS native
- `database`: host, port, user, password, nama database RIS dan PACS
- `storage.dicomPath`: folder storage DICOM
- `storage.logPath`: folder log service
- `simrs.apiKey`: API key SIMRS
- `simrs.allowedIps`: IP SIMRS yang boleh akses, pisahkan dengan koma bila lebih dari satu

Contoh SIMRS local:

```json
"simrs": {
  "apiKey": "11110000test",
  "allowedIps": "127.0.0.1",
  "apiRole": "administrator",
  "apiUsername": "simrs-integration"
}
```

## 4. Jalankan Installer

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-fullpacs.ps1
```

Jika database sudah dibuat manual:

```powershell
.\install-fullpacs.ps1 -SkipDatabaseCreate
```

Jika ingin tes generate config tanpa build:

```powershell
.\install-fullpacs.ps1 -SkipBuild -SkipServiceInstall
```

Installer akan:

- Menyalin `minipacsris`, `dicomweb-pacs`, dan `nexia-viewer-source` ke `installRoot`
- Membuat `.env` backend RIS production
- Membuat `settings.json` backend untuk public URL dan viewer token
- Membuat config production DICOMweb PACS
- Install dependency dan build aplikasi
- Register service Windows via NSSM

## 5. Service Windows

Default service name:

- `NexiaFullPacsBackend`
- `NexiaFullPacsDicomweb`
- `NexiaFullPacsDimse`
- `NexiaFullPacsMwlScp`

Command cek service:

```powershell
Get-Service NexiaFullPacsBackend,NexiaFullPacsDicomweb,NexiaFullPacsDimse,NexiaFullPacsMwlScp
```

Start/stop manual:

```powershell
Start-Service NexiaFullPacsBackend
Start-Service NexiaFullPacsDicomweb
Start-Service NexiaFullPacsDimse
Start-Service NexiaFullPacsMwlScp
Stop-Service NexiaFullPacsBackend
Stop-Service NexiaFullPacsDicomweb
Stop-Service NexiaFullPacsDimse
Stop-Service NexiaFullPacsMwlScp
```

Log default ada di `storage.logPath`.

Arsitektur DIMSE production:

- PACS modality/storage/query-retrieve mengarah ke AET `dicom.aeTitle`, default `NEXIA`, pada port `ports.dicomDimse`, default `5757`.
- Service `NexiaFullPacsDimse` menangani C-ECHO, C-STORE, Study Root C-FIND, dan C-MOVE.
- MWL modality mengarah ke AET `dicom.mwlAeTitle`, default `NEXIARIS`, pada port `ports.mwlScp`, default `5656`.
- Service `NexiaFullPacsMwlScp` hanya menangani MWL C-FIND.
- Service `NexiaFullPacsDicomweb` listen di port internal `8889` untuk menerima store internal dan indexing.

## 6. Reverse Proxy

Gunakan salah satu template:

- `INSTALLFULLPACS\reverse-proxy\Caddyfile.example`
- `INSTALLFULLPACS\reverse-proxy\nginx-fullpacs.example.conf`

Routing wajib:

- `/api/*` proxy ke backend RIS `127.0.0.1:3001`
- `/viewer/token/*` proxy ke backend RIS `127.0.0.1:3001`
- `/rs/*`, `/wado*`, `/wadouri*` proxy ke DICOMweb PACS `127.0.0.1:5001`
- `/viewer/*` static file dari `nexia-viewer-source\platform\app\dist`
- `/` static file dari `minipacsris\dist`

Catatan penting: `/viewer/token/*` harus dipasang sebelum `/viewer/*`, karena URL token viewer berasal dari backend, bukan static viewer.

## 7. Port Firewall

Buka hanya port yang diperlukan:

- `443` atau `80`: akses web client
- `5757`: PACS DIMSE dari modality/node terdaftar
- `5656`: MWL dari modality terdaftar

Jangan expose port internal `3001`, `5001`, dan `8889` ke jaringan umum bila sudah memakai reverse proxy.

## 8. Konfigurasi Setelah Install

File utama setelah install:

- `C:\NEXIA\FULLPACS\minipacsris\backend\.env`
- `C:\NEXIA\FULLPACS\minipacsris\backend\settings.json`
- `C:\NEXIA\FULLPACS\dicomweb-pacs\config\production.json`

Jika mengganti domain/IP public, update:

- `publicBaseUrl` di `fullpacs.config.json`, lalu rerun installer, atau
- edit `backend\settings.json` dan reverse proxy secara manual

Jika mengganti port internal, update `fullpacs.config.json`, reverse proxy, lalu reinstall/update service.

## 9. Tes Setelah Install

Tes backend:

```powershell
Invoke-WebRequest http://127.0.0.1:3001/api/health
```

Tes DICOMweb:

```powershell
Invoke-WebRequest http://127.0.0.1:5001/rs/studies
```

Tes service PACS DIMSE dan MWL:

```powershell
Get-Service NexiaFullPacsDimse,NexiaFullPacsMwlScp
Get-Content D:\NEXIA_STORAGE\logs\NexiaFullPacsDimse.err.log -Tail 50
Get-Content D:\NEXIA_STORAGE\logs\NexiaFullPacsDimse.out.log -Tail 50
Get-Content D:\NEXIA_STORAGE\logs\NexiaFullPacsMwlScp.err.log -Tail 50
Get-Content D:\NEXIA_STORAGE\logs\NexiaFullPacsMwlScp.out.log -Tail 50
```

Jika PACS C-ECHO berhasil tetapi query/retrieve gagal, pastikan calling AE sudah terdaftar dan enabled di Settings > Network > DICOM Nodes. Query/retrieve hanya menerima AE Title dan IP node yang sudah diizinkan.

Jika MWL query gagal, pastikan modality diarahkan ke `NEXIARIS:5656`, bukan ke `NEXIA:5757`.

Tes aplikasi:

```text
https://domain-atau-ip-server/
```

Tes viewer token harus membuka URL public seperti:

```text
https://domain-atau-ip-server/viewer/token/<token>
```

## 10. Backup

Jalankan:

```powershell
cd C:\NEXIA\FULLPACSRIS-SOURCE\INSTALLFULLPACS
.\backup-fullpacs.ps1
```

Backup script membuat dump database RIS dan PACS metadata. File DICOM tidak dizip otomatis; mirror folder `storage.dicomPath` ke NAS/backup storage dengan `robocopy` atau backup agent rumah sakit.

## 11. Uninstall Service

```powershell
cd C:\NEXIA\FULLPACSRIS-SOURCE\INSTALLFULLPACS
.\uninstall-fullpacs-services.ps1
```

Script ini hanya menghapus service NSSM, tidak menghapus database atau storage DICOM.

## 12. Update Existing Installation

Gunakan alur ini bila repository sudah pernah terpasang di server dan hanya perlu di-update.

1. Backup dahulu:
   - database RIS dan PACS metadata
   - folder storage DICOM
   - `minipacsris\backend\.env`
   - `minipacsris\backend\settings.json`
   - file reverse proxy aktif
2. Stop service:

```powershell
Stop-Service NexiaFullPacsBackend,NexiaFullPacsDicomweb,NexiaFullPacsDimse,NexiaFullPacsMwlScp
```

3. Pull source terbaru:

```powershell
cd C:\NEXIA\FULLPACSRIS-SOURCE
git pull origin main
```

4. Review `INSTALLFULLPACS\fullpacs.config.json` sebelum menjalankan update:
   - PACS DIMSE terbaru harus `NEXIA:5757`
   - MWL terbaru harus `NEXIARIS:5656`
   - `publicBaseUrl`, database, SIMRS API key, dan storage path harus sesuai server
5. Jalankan ulang installer dari source terbaru:

```powershell
cd C:\NEXIA\FULLPACSRIS-SOURCE\INSTALLFULLPACS
Set-ExecutionPolicy -Scope Process Bypass
.\install-fullpacs.ps1 -SkipDatabaseCreate
```

6. Setelah update selesai:
   - cek service sudah aktif
   - login aplikasi web
   - cek `/worklist`, `/mwl/status`, `/reporting`, `/distribution`, dan `/management/report`
   - tes C-ECHO/C-STORE/C-FIND/C-MOVE ke `NEXIA:5757`
   - tes MWL C-FIND ke `NEXIARIS:5656`
7. Jangan copy kembali source lama ke atas hasil update. Jika perlu mengembalikan setting lokal, hanya merge nilai `.env`, `settings.json`, reverse proxy, dan credential yang memang berbeda di server.

Perubahan yang perlu diperhatikan pada update terbaru:

- pembaruan UI halaman Worklist, Technologist, Distribution, Dashboard, dan Settings
- workspace laporan radiolog, panel history, preview image, dan mode mobile
- halaman Report dan Performance Report management
- notifikasi WhatsApp ke dokter radiolog dengan nomor telepon opsional di user
- PACS query/retrieve aktif di `NEXIA:5757`
- MWL resmi terpisah di `NEXIARIS:5656`
