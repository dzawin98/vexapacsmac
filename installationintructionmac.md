# Instalasi VEXAPACS-RIS di macOS

Panduan ini untuk menjalankan seluruh aplikasi VEXA Clinical Platform di MacBook
(Apple Silicon maupun Intel), dari source code, tanpa Docker.

Repo: <https://github.com/dzawin98/vexapacsmac>

Dokumen ini menjelaskan: prasyarat, langkah instalasi, daftar aplikasi + port,
cara menjalankan/berhenti, konfigurasi, backup, dan pemecahan masalah khusus macOS.

---

## 0. Ringkasan cepat (TL;DR)

```bash
# 1. prasyarat (sekali saja)
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@20 python@3.12 postgresql@16 jq cmake
brew services start postgresql@16

# 2. dependency + database + .env
cd /path/ke/vexapacsmac
./mac/setup.sh

# 3. build bundle viewer (sekali, ulangi kalau UI berubah)
./mac/build-viewers.sh

# 4. jalankan semua
./mac/start-all.sh

# 5. cek
./mac/status.sh
```

Buka:

| Aplikasi | URL |
|---|---|
| RIS (frontend) | <http://127.0.0.1:8080> |
| PACS DICOMweb | <http://127.0.0.1:5001/rs/studies> |
| Desktop Viewer | <http://127.0.0.1:5991> |
| Diagnostic Viewer (SSR, lossless) | <http://127.0.0.1:5994/view> |
| Mobility Viewer | <http://127.0.0.1:5992> |
| ECG Viewer | <http://127.0.0.1:7771/viewer> |

Hentikan semuanya: `./mac/stop-all.sh`

---

## 1. Cakupan paket ini

### Aplikasi yang disertakan (lengkap, kecuali viewer lama)

| Folder | Peran | Port | Stack |
|---|---|---|---|
| `PACS/` | PACS DICOMweb (QIDO-RS, WADO-RS, STOW-RS) + DIMSE SCP/MWL | 5001 (HTTP), 8889 (DIMSE), 8890 (internal) | Node.js + TypeScript (`ts-node`) |
| `RIS/backend/` | REST API RIS (worklist, patient, dose, report, SIMRS) | 3001 | Node.js (Express) |
| `RIS/frontend/` | UI RIS (Vite dev server) | 8080 | React + TypeScript + Vite |
| `DESKTOP VIEWER/` | Viewer utama (frontend + server statis) | 5991 | React + Cornerstone3D + Node |
| `DESKTOP VIEWER SSR/` | Viewer diagnostik: MPR/SSR, render server-side, JPEG2000 lossless | 5994 | Node + Python (`openjpeg`) |
| `MOBILITY VIEWER/` | Viewer mobile/tablet (hybrid SSR) | 5992 | React + Cornerstone3D + Node |
| `ECG VIEWER/` | Viewer waveform ECG | 7771 | Node + JS |
| `RIS/backend/mwl_scp/` | Modality Worklist SCP (DICOM C-FIND dari modality) | 5656, AET `NEXIARIS` | Python + pynetdicom |
| `tools/backup-agent/` | Agent backup/restore untuk UI RIS | 3099 | Node.js |
| `tools/simrs-db-bridge/` | Jembatan polling order dari DB SIMRS | 3109 | Node.js |
| `tools/runtime/` | Cache store + job queue dipakai viewer SSR | – | Node.js (library) |
| `scripts/license/` | Verifikasi lisensi Ed25519 (`license-cli.js`) | – | Node.js |
| `deploy/` | Dockerfile + contoh Nginx/Coolify (opsional) | – | Docker |
| `installer/scripts/backup/` | Skrip backup/restore versi Windows (referensi; versi mac ada di `mac/backup/`) | – | PowerShell |

### Yang sengaja TIDAK disertakan

| Path | Alasan |
|---|---|
| `OHIF/` | **Viewer lama** (OHIF v3, ~622 MB) — sesuai permintaan tidak diikutkan |
| `PACS/public/` | Bundle build OHIF lama (~209 MB) yang tadinya disajikan PACS di `/`. Diganti placeholder `index.html` agar `@fastify/static` tetap valid; DICOMweb tidak terpengaruh |
| `DATA/`, `PACS/data/`, `PACS/import/` | Data pasien / DICOM produksi — tidak boleh masuk repo publik |
| `PACS/frame-cache/`, `frame-cache/` | Cache frame runtime (regenerasi otomatis) |
| `node_modules/`, `dist/`, `build/`, `.venv/`, `__pycache__/` | Artefak dependency & build |
| `.env`, `settings.json`, `*.pem` (private), `*.lic` | Secret / kredensial lokal |
| `installer/payload/`, `installer/vendor/`, `installer/Output/` | Payload installer Windows (1–15 GB) |
| `server-hotfix/` | Hotfix produksi Windows (menyalin build viewer ke `C:\Program Files`, backup `ProgramData`) + payload duplikat `dist` — tidak relevan di macOS |
| `tools/service-monitor/*.exe` | Aplikasi WinForms Windows; source `.cs` tetap disertakan sebagai referensi |
| `RIS/backend/mwl_scp/.venv/`, `*/server/data/` | Venv Python & data runtime viewer |

> **Catatan penting:** `DESKTOP VIEWER` tetap ikut — walaupun di Windows ia
> dipanggil lewat port 5991, `DESKTOP VIEWER SSR` (5994) menyajikan bundle UI
> yang sama lewat `VIEWER_DIST_DIR`. Menghapusnya akan mematikan viewer utama.

---

## 2. Prasyarat

| Komponen | Versi | Cara pasang |
|---|---|---|
| macOS | 13 Ventura+ (disarankan 14+) | – |
| Xcode Command Line Tools | terbaru | `xcode-select --install` |
| Homebrew | terbaru | <https://brew.sh> |
| Node.js | **20 LTS atau 22** | `brew install node@20` |
| Python | **3.11 – 3.13** | `brew install python@3.12` |
| PostgreSQL | **14 – 16** | `brew install postgresql@16` |
| jq, cmake | terbaru | `brew install jq cmake` |
| RAM | ≥ 8 GB (16 GB nyaman untuk MPR/3D) | – |
| Disk | ≥ 10 GB (node_modules + DICOM) | – |

Cek cepat: `./mac/setup.sh --check`

### Apple Silicon vs Intel

- **Apple Silicon (M1–M4):** semua dependency punya prebuild arm64 (`sharp`,
  `cornerstone`, `pg`). `dicom-dimse-native` (modul native DCMTK) biasanya juga
  ada prebuild-nya; kalau tidak, ia dikompilasi dari source dan butuh `cmake`.
- **Intel:** sama, hanya beda arsitektur prebuild. Tidak perlu Rosetta kecuali
  memakai binary Windows.
- Jangan pakai Node hasil `nvm` yang versi lama (< 20) — Vite 5/7 dan
  Cornerstone 5 membutuhkannya.

---

## 3. Instalasi langkah demi langkah

### 3.1 Ambil source

```bash
git clone https://github.com/dzawin98/vexapacsmac.git
cd vexapacsmac
```

Bila file diunduh sebagai ZIP, lepaskan atribut karantina Gatekeeper:

```bash
xattr -dr com.apple.quarantine .
```

### 3.2 PostgreSQL

```bash
brew install postgresql@16
brew services start postgresql@16

# role default Homebrew = user macOS Anda, auth "trust" (tanpa password)
createuser -s "$(whoami)" 2>/dev/null || true
```

Database **tidak perlu** dibuat manual — `./mac/init-postgres.sh` (dipanggil
`setup.sh`) membuat:

- `veloris_db` — database RIS
- `velopacs_db` — database metadata PACS

Kalau PostgreSQL Anda memakai password (bukan trust), set sebelum setup:

```bash
export DB_USER=postgres DB_PASS=rahasia
```

### 3.3 Setup otomatis

```bash
chmod +x mac/*.sh mac/services/*.sh mac/backup/*.sh "Start VEXAPACS.command" "Stop VEXAPACS.command"
./mac/setup.sh
```

Yang dilakukan `setup.sh`:

1. memeriksa `brew`, `node`, `npm`, `python3`, `psql`, `cmake`;
2. `npm ci` (atau `npm install`) di 9 paket: PACS, RIS backend, RIS frontend,
   DESKTOP VIEWER, DESKTOP VIEWER SSR, MOBILITY VIEWER, ECG VIEWER,
   tools/backup-agent, tools/simrs-db-bridge;
3. membuat dua virtualenv Python:
   - `.venv/pacs` → `pynetdicom`, `psycopg[binary]`, `Pillow`, `pylibjpeg`,
     `pylibjpeg-openjpeg` (menyediakan modul `openjpeg`) — dipakai PACS DIMSE
     **dan** dekoder JPEG2000 untuk viewer SSR;
   - `RIS/backend/mwl_scp/.venv` → `pynetdicom`, `pydicom` untuk MWL SCP;
4. menyalin `.env.example` → `.env` untuk viewer & RIS;
5. membuat `DATA/`, `.programdata/`, dan `backup.config.json` awal;
6. membuat database PostgreSQL.

Opsi lain:

```bash
./mac/setup.sh --check        # hanya cek prasyarat
./mac/setup.sh --deps-only    # hanya dependency (dipakai start-all.sh)
VEXA_FORCE_INSTALL=1 ./mac/setup.sh   # paksa npm install ulang
```

### 3.4 Build bundle viewer

Server statis (5991/5992) dan viewer SSR (5994) menyajikan hasil build, bukan
source. Build sekali:

```bash
./mac/build-viewers.sh          # hanya yang belum ada
./mac/build-viewers.sh --force  # build ulang semuanya
```

Kalau ingin mode hot-reload tanpa build: `VIEWER_DEV_MODE=true ./mac/start-all.sh`.

### 3.5 Jalankan

```bash
./mac/start-all.sh
```

Semua service jalan di background. Log: `logs/<service>.log`, PID: `logs/pids/`.

Alternatif tanpa terminal: klik dua kali **`Start VEXAPACS.command`** di Finder
(pertama kali: klik kanan → Open, karena belum ditandatangani).

### 3.6 Cek kesehatan

```bash
./mac/status.sh     # status port + probe HTTP
./mac/doctor.sh     # diagnosa lengkap (prasyarat, modul python, DB, watcher limit)
```

---

## 4. Menjalankan per aplikasi (mode pengembangan)

Setiap service bisa dijalankan sendiri di terminal terpisah:

```bash
./mac/services/pacs-web.sh
./mac/services/pacs-dimse.sh
./mac/services/ris-backend.sh
./mac/services/ris-frontend.sh
./mac/services/mwl-scp.sh
./mac/services/backup-agent.sh
./mac/services/simrs-bridge.sh
./mac/services/desktop-viewer.sh
./mac/services/desktop-ssr.sh
./mac/services/mobility-viewer.sh
./mac/services/ecg-viewer.sh
```

Lihat log berjalan:

```bash
tail -f logs/desktop-ssr.log
tail -f logs/pacs-web.log
```

Hentikan satu service: `./mac/stop-all.sh` (semua) atau `kill $(cat logs/pids/<service>.pid)`.

---

## 5. Konfigurasi

### 5.1 Satu tempat untuk semua environment

Semua variabel ada di **`mac/env.defaults.sh`** (padanan blok `set` di
`START-ALL-APPS.bat`). Nilai bisa ditimpa dari shell:

```bash
DB_PASS=rahasia RIS_FRONTEND_PORT=8090 ./mac/start-all.sh
```

### 5.2 Variabel yang paling sering diubah

| Variabel | Default | Arti |
|---|---|---|
| `DICOM_STORAGE_PATH` | `<repo>/DATA` | lokasi penyimpanan file DICOM |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` | `127.0.0.1` / `5432` / user macOS / kosong | koneksi PostgreSQL |
| `DB_NAME` / `PACS_DB_NAME` | `veloris_db` / `velopacs_db` | nama database |
| `DICOMWEB_PACS_ROOT` | `http://127.0.0.1:5001` | alamat DICOMweb untuk viewer/RIS |
| `VIEWER_DEV_MODE` | `false` | `true` = viewer pakai Vite dev server |
| `VIEWER_THIN_SSR_ENABLED` | `true` | aktifkan Diagnostic Viewer 5994 |
| `VEXA_LICENSE_ENFORCE` | `false` | `true` = wajib lisensi valid (produksi) |
| `MWL_SCP_PORT` / `MWL_SCP_AET` | `5656` / `NEXIARIS` | MWL SCP |
| `DICOMWEB_JPEG2000_DECODER_PYTHON` | `<repo>/.venv/pacs/bin/python` | interpreter yang punya `openjpeg` |
| `SIMRS_API_KEY` | `vexapacs-simrs-local-2026` | kunci integrasi SIMRS |

### 5.3 Secret bersama (RIS ↔ viewer)

Nilai `VEXA_RIS_SHARED_SECRET` mengandung `#` dan `$`
(`Velodesktopview89287579@#$$@`). Di `mac/env.defaults.sh` nilai ini ditulis
dalam kutip tunggal supaya tidak diekspansi shell.

⚠️ **Jangan** `source` file `.env` viewer apa adanya di bash: baris
`VEXA_RIS_SHARED_SECRET=Velodesktopview89287579@#$$@` akan membuat `$$` berubah
menjadi PID. Pakai `.env` hanya lewat Vite/Node (yang membacanya sebagai teks),
atau tulis nilainya dalam kutip tunggal.

### 5.4 Lisensi

Mode development **tidak** menegakkan lisensi (`VEXA_LICENSE_ENFORCE=false`).
Untuk menguji enforcement:

```bash
mkdir -p .programdata/VEXAPACS
cp scripts/license/keys/public.pem .programdata/VEXAPACS/public.pem
# letakkan file lisensi hasil penerbitan:
#   .programdata/VEXAPACS/license.lic
VEXA_LICENSE_ENFORCE=true ./mac/start-all.sh
```

Kunci privat penandatangan lisensi **tidak** disertakan di repo ini (sengaja).

---

## 6. Penyesuaian yang dilakukan untuk macOS

Semua perubahan berikut hanya menyentuh jalur kode yang **tidak** dipakai
Windows, sehingga perilaku di Windows tidak berubah.

| File | Perubahan |
|---|---|
| `mac/` (baru) | Seluruh launcher bash: `setup.sh`, `start-all.sh`, `stop-all.sh`, `status.sh`, `doctor.sh`, `build-viewers.sh`, `init-postgres.sh`, `services/*.sh`, `backup/*.sh`, `env.defaults.sh`, `lib/common.sh` — menggantikan `START-ALL-APPS.bat`, `dev-*.ps1`, `*.bat`, `init-postgres.ps1` |
| `Start VEXAPACS.command`, `Stop VEXAPACS.command` | Pembungkus klik-dua-kali di Finder |
| `scripts/license/licenseCore.js` | `DEFAULT_LICENSE_PATH` menghormati `VEXA_PROGRAM_DATA_DIR`, lalu `ProgramData` (Windows), lalu `~/Library/Application Support/VEXAPACS` |
| `scripts/license/licenseRuntime.js` | Lokasi `public.pem` mengikuti aturan yang sama |
| `RIS/backend/index.js` | `PROGRAM_DATA_DIR` punya fallback macOS (`~/Library/Application Support/VEXAPACS`) |
| `RIS/backend/src/services/doseRules.js` | `dose-rules.json` mengikuti `VEXA_PROGRAM_DATA_DIR` / ProgramData / macOS |
| `tools/backup-agent/server.js` | Runner skrip dipilih per platform: `powershell.exe` di Windows, `/bin/bash` di macOS; status jadwal melaporkan `launchd` (bukan `schtasks.exe`) |
| `mac/backup/backup.sh` + `restore.sh` | Padanan `backup.ps1`/`restore.ps1` memakai `pg_dump`/`pg_restore`/`rsync`, tetap menerima argumen gaya PowerShell (`-ConfigPath`, `-SkipDicomData`, dst.) supaya agent tidak perlu diubah |
| `mac/backup/install-launchd.sh` | Menjadwalkan backup harian lewat `launchd` (pengganti Task Scheduler) |
| `PACS/public/index.html` | Placeholder agar root `@fastify/static` tetap valid tanpa bundle OHIF lama |
| `.gitattributes` | LF untuk `*.sh`/`*.command`/`*.js`; CRLF untuk `*.bat`/`*.ps1` agar skrip shell tidak rusak saat checkout di mac |
| `.gitignore` | Tambahan artefak macOS (`.DS_Store`, `._*`), `.run/`, `.venv/`, `*.pem` (kecuali public key) |

Catatan: `*.bat`, `*.ps1`, `*.cmd`, dan `installer/` (Inno Setup) tetap ada di
repo sebagai referensi Windows, tetapi **tidak dipakai** di macOS.

---

## 7. Backup & restore

Backup mencakup: `pg_dump -Fc` untuk dua database, salinan folder DICOM, dan
salinan programdata (settings, license). Konfigurasi ada di
`.programdata/backup.config.json`.

```bash
# backup manual
./mac/backup/backup.sh -ConfigPath .programdata/backup.config.json

# backup tanpa data DICOM (cepat)
./mac/backup/backup.sh -SkipDicomData

# restore (butuh kata kunci -ConfirmRestore)
./mac/backup/restore.sh -BackupPath /path/backup/2026-10-22_230000 -ConfirmRestore
```

Jadwal harian via launchd:

```bash
./mac/backup/install-launchd.sh 23:00
./mac/backup/install-launchd.sh --uninstall
```

Lewat UI RIS: menu backup memakai endpoint `http://127.0.0.1:3099`
(`/api/system/backup/run`, `/api/system/restore/run`) — di macOS agent
menjalankan `mac/backup/*.sh`.

Struktur hasil backup:

```
<backupRoot>/<nama>/db/veloris_db.dump
<backupRoot>/<nama>/db/velopacs_db.dump
<backupRoot>/<nama>/data/…            (DICOM)
<backupRoot>/<nama>/programdata/…     (settings, license, config)
<backupRoot>/<nama>/manifest.json
```

---

## 8. Verifikasi setelah instalasi

```bash
./mac/status.sh
```

Yang harus terlihat `UP`: 5001, 3001, 8080, 3099, 3109, 5991, 5992, 5994, 7771,
8889, 5656.

Uji manual:

```bash
# DICOMweb QIDO (harus balas JSON, boleh array kosong)
curl -s "http://127.0.0.1:5001/rs/studies?limit=1" | head -c 300

# RIS API
curl -s "http://127.0.0.1:3001/api/settings" | head -c 200

# Viewer SSR
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:5994/view"

# DIMSE C-ECHO ke PACS
# (dari host lain / modality) AET: VEXA, port 8889
```

Kirim studi DICOM uji (opsional):

```bash
# PACS membaca folder PACS/import (tidak ada flag CLI)
mkdir -p PACS/import
cp /path/ke/file-uji/*.dcm PACS/import/
cd PACS && npm run import
# atau langsung ke DICOMweb: STOW-RS ke http://127.0.0.1:5001/rs/studies
```

Buka viewer dengan StudyInstanceUID:

```
http://127.0.0.1:5994/view?StudyInstanceUIDs=<uid>
```

---

## 9. Pemecahan masalah (khusus macOS)

### `npm ci` gagal di `dicom-dimse-native` (node-gyp / cmake)

```bash
brew install cmake libiconv
export LDFLAGS="-L$(brew --prefix libiconv)/lib"
export CPPFLAGS="-I$(brew --prefix libiconv)/include"
cd PACS && npm rebuild dicom-dimse-native
```

Bila masih gagal, cek `logs/npm-PACS.log`. Tanpa modul ini PACS tetap bisa
melayani DICOMweb (5001), tetapi **DIMSE (8889/8890) tidak jalan**.

### Viewer diagnostik 5994 error 500 saat render, atau JPEG2000 hitam

`DICOMWEB_JPEG2000_DECODER_PYTHON` harus menunjuk interpreter yang bisa
`import openjpeg`:

```bash
./.venv/pacs/bin/python -c "import openjpeg; print('ok')"
# kalau gagal:
./.venv/pacs/bin/pip install --force-reinstall pylibjpeg-openjpeg
```

Jangan arahkan ke `python3` sistem kecuali modul `openjpeg` sudah terpasang di
sana.

### `EMFILE: too many open files` (Vite / watcher)

```bash
echo 'kern.maxfiles=65536'        | sudo tee -a /etc/sysctl.conf
echo 'kern.maxfilesperproc=65536' | sudo tee -a /etc/sysctl.conf
sudo sysctl -w kern.maxfiles=65536 kern.maxfilesperproc=65536
ulimit -n 65536
```

### `psql: FATAL: role "<user>" does not exist`

```bash
createuser -s "$(whoami)"
./mac/init-postgres.sh
```

### `could not connect to server` / port 5432 kosong

```bash
brew services start postgresql@16
pg_isready -h 127.0.0.1 -p 5432
```

### Port sudah dipakai

`./mac/start-all.sh` akan menolak jalan bila port inti terpakai. Cari pemakainya:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

Atau pindahkan port: `RIS_FRONTEND_PORT=8090 ./mac/start-all.sh`.

### Viewer blank / 404 setelah `git pull`

Bundle UI belum dibuild ulang:

```bash
./mac/build-viewers.sh --force
```

### Gatekeeper menolak `.command`

Klik kanan → **Open** → **Open** sekali, atau:

```bash
xattr -dr com.apple.quarantine "Start VEXAPACS.command" "Stop VEXAPACS.command"
```

### `sh: ./mac/start-all.sh: /bin/bash^M: bad interpreter`

File ter-checkout dengan CRLF. `.gitattributes` sudah mengatur LF, tapi kalau
masih terjadi:

```bash
perl -pi -e 's/\r$//' mac/*.sh mac/*/*.sh
```

### Safari vs Chrome

Cornerstone3D + WebGL lebih stabil di Chrome/Edge. Untuk viewer MPR/3D,
gunakan Chrome terbaru. Bila WebGL context hilang, muat ulang tab (viewer punya
`webglContextWatch`).

### MWL tidak terhubung dari modality

- AET yang diharapkan: `NEXIARIS` (port `5656`), PACS DIMSE: `VEXA` (port `8889`).
- Pastikan firewall macOS mengizinkan koneksi masuk:
  **System Settings → Network → Firewall → Options**, izinkan `node`/`python3`.
- Cek service: `tail -f logs/mwl-scp.log`.

### Data DICOM tersimpan di mana?

Default `DATA/` di root repo. Ubah dengan `DICOM_STORAGE_PATH`
(harus sama untuk PACS, viewer SSR, dan ECG viewer).

---

## 10. Perintah harian

| Kebutuhan | Perintah |
|---|---|
| Jalankan semua | `./mac/start-all.sh` |
| Hentikan semua | `./mac/stop-all.sh` |
| Status port | `./mac/status.sh` |
| Diagnosa lengkap | `./mac/doctor.sh` |
| Rebuild viewer | `./mac/build-viewers.sh --force` |
| Install dependency baru | `VEXA_FORCE_INSTALL=1 ./mac/setup.sh --deps-only` |
| Backup manual | `./mac/backup/backup.sh` |
| Log service | `tail -f logs/<service>.log` |
| Mode dev viewer (hot reload) | `VIEWER_DEV_MODE=true ./mac/start-all.sh` |

---

## 11. Struktur folder setelah instalasi

```
vexapacsmac/
├── DATA/                       # file DICOM (dibuat otomatis, tidak masuk git)
├── .programdata/               # backup.config.json, license, dose-rules
├── .venv/pacs/                 # venv Python PACS + JPEG2000
├── logs/                       # log + PID semua service
├── mac/                        # launcher macOS (bash)
│   ├── env.defaults.sh
│   ├── lib/common.sh
│   ├── services/*.sh
│   └── backup/*.sh
├── PACS/                       # DICOMweb + DIMSE (Python) + public/ placeholder
├── RIS/
│   ├── backend/                # API + mwl_scp/
│   └── frontend/               # UI RIS
├── DESKTOP VIEWER/             # viewer utama + server statis
├── DESKTOP VIEWER SSR/         # viewer diagnostik (MPR/SSR)
├── MOBILITY VIEWER/            # viewer mobile
├── ECG VIEWER/                 # viewer ECG
├── tools/                      # backup-agent, simrs-db-bridge, runtime
├── scripts/license/            # verifikasi lisensi
├── deploy/                     # Docker/Nginx (opsional)
└── installationintructionmac.md
```

---

## 12. Catatan keamanan

- Repo ini **tidak** memuat data pasien, `.env`, `settings.json`, kunci privat
  lisensi, maupun database. Semua dibuat ulang secara lokal saat instalasi.
- `DATA/` wajib di-backup rutin dan tidak boleh di-commit.
- Untuk pemakaian klinis, jalankan di belakang reverse proxy (Nginx/Caddy) dengan
  TLS, dan set `VEXA_LICENSE_ENFORCE=true` beserta lisensi yang sah.
- Default secret di `mac/env.defaults.sh` adalah nilai development —
  ganti sebelum produksi.

---

Dokumen ini ditulis untuk repo <https://github.com/dzawin98/vexapacsmac>.
Kalau ada langkah yang gagal di mesin Anda, jalankan `./mac/doctor.sh` dan
lampirkan output-nya — sebagian besar masalah bisa dilacak dari sana.
