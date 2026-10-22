# VEXA Clinical Platform — VEXAPACS-RIS (macOS)

Monorepo VEXAPACS-RIS: **PACS** (DICOMweb + DIMSE + MWL), **RIS** (backend +
frontend), **Desktop Viewer**, **Diagnostic Viewer (SSR)**, **Mobility Viewer**,
**ECG Viewer**, plus tools pendukung (backup agent, SIMRS DB bridge, license).

Versi ini disiapkan untuk dijalankan di **MacBook** (Apple Silicon & Intel):
semua launcher Windows diganti skrip bash di `mac/`.

➡️ **Panduan instalasi lengkap: [`installationintructionmac.md`](installationintructionmac.md)**

## Mulai cepat

```bash
brew install node@20 python@3.12 postgresql@16 jq cmake
brew services start postgresql@16

./mac/setup.sh            # dependency + venv python + database + .env
./mac/build-viewers.sh    # build bundle viewer
./mac/start-all.sh        # jalankan semua service
./mac/status.sh           # cek port & health
```

| Aplikasi | URL lokal |
|---|---|
| RIS | <http://127.0.0.1:8080> |
| PACS DICOMweb | <http://127.0.0.1:5001/rs> |
| Desktop Viewer | <http://127.0.0.1:5991> |
| Diagnostic Viewer (SSR) | <http://127.0.0.1:5994/view> |
| Mobility Viewer | <http://127.0.0.1:5992> |
| ECG Viewer | <http://127.0.0.1:7771/viewer> |

Hentikan: `./mac/stop-all.sh`

## Struktur

```
mac/                    launcher macOS (bash) — setup, start, stop, status, doctor
PACS/                   DICOMweb + DIMSE SCP + MWL (Node + Python)
RIS/backend/            REST API RIS (port 3001) + mwl_scp/ (Python, port 5656)
RIS/frontend/           UI RIS (Vite dev server, port 8080)
DESKTOP VIEWER/         viewer utama (port 5991) + bundle UI untuk SSR
DESKTOP VIEWER SSR/     viewer diagnostik MPR/SSR (port 5994)
MOBILITY VIEWER/        viewer mobile/tablet (port 5992)
ECG VIEWER/             viewer waveform ECG (port 7771)
tools/                  backup-agent, simrs-db-bridge, runtime (cache/job queue)
scripts/license/        verifikasi lisensi Ed25519
deploy/                 Dockerfile + Nginx/Coolify (opsional)
installer/              installer Windows (referensi, tidak dipakai di mac)
```

## Yang tidak disertakan

- **Viewer lama (OHIF)** — `OHIF/` dan bundle `PACS/public/` lama tidak diikutkan.
  Viewer yang dipakai: Desktop (5991), Diagnostic SSR (5994), Mobility (5992).
- **Data pasien / DICOM produksi**, database, `.env`, kunci privat lisensi,
  `node_modules/`, `dist/`, payload installer Windows.

Detail lengkap ada di [`installationintructionmac.md`](installationintructionmac.md) §1.

## Catatan

Repo ini hanya berisi source code dan aset deployment. Jangan commit data
DICOM, database, log, lisensi, atau konfigurasi lokal.
