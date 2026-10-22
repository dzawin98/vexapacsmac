# Vexa System Utility

Portable Windows GUI untuk monitoring dan kontrol service VEXA di server.

## File

- `VexaServiceMonitor.exe`
- `logo.png`

## Fitur

- Melihat status semua service VEXA.
- Start, stop, restart service terpilih.
- Restart semua service VEXA.
- Auto refresh status.
- Buka folder log `C:\ProgramData\VEXAPACS\logs`.
- Buka file `.err.log` dan `.out.log` service terpilih.
- Tombol `Run as Admin` untuk relaunch dengan hak Administrator.
- Tab `DICOM Config` untuk mengatur PACS DIMSE AET/port, RIS MWL AET/port, dan
  racikan kompresi storage untuk DICOM yang baru diterima.
- Level 0 menyimpan Original, Level 1 memakai JPEG-LS Lossless untuk ingest
  lebih cepat, dan Level 2 memakai JPEG 2000 Lossless untuk penghematan storage
  yang direkomendasikan. Semua pilihan kompresi mempertahankan pixel diagnostik
  secara lossless.
- Simpan konfigurasi service dan restart service DICOM terkait.
- Membuka firewall Windows untuk port DIMSE/MWL.
- Tab `System Monitor` untuk melihat storage DATA, sisa storage, total backup, backup terakhir, ukuran database RIS/PACS, total study, dan total instance.
- Estimasi berapa lama storage akan bertahan berdasarkan rata-rata ukuran study dan pertumbuhan 30 hari terakhir.
- Rekomendasi kapan storage perlu ditambah dan perkiraan tambahan kapasitas yang disarankan.
- Password gate sebelum masuk aplikasi. Default password: `Vexa12@#`.
- Export `System Monitor` menjadi PDF report modern dengan brand `VEXA SYSTEM`, logo, nama rumah sakit, summary, rekomendasi, dan detail metric.
- Bagian `RIS & Facility > SIMRS Viewer Links` untuk menentukan `urllink1` sampai `urllink6`, label tombol, akun integrasi 5994/Mobile, serta menguji akun langsung ke Access Management viewer.
- `Public Domain / IP Address` menjadi sumber host untuk URL token yang ditulis ke `order_out`; kredensial viewer tidak ditempatkan di URL.
- Permission link SIMRS selalu mengikuti role akun integrasi pada Access Management viewer. ECG Viewer tidak memerlukan akun integrasi.
- WhatsApp Distribution mendukung `WAHA` dan `Custom REST API`. Mode custom menyediakan template endpoint, HTTP method, header JSON, body JSON/text, pemetaan respons sukses, dan timeout tanpa mengubah tombol WhatsApp pada UI RIS.
- Placeholder custom WhatsApp yang tersedia: `{{number}}`, `{{message}}`, `{{apiKey}}`, `{{session}}`, `{{chatId}}`, `{{numberUrl}}`, dan `{{messageUrl}}`.

## Catatan

Windows membutuhkan hak Administrator untuk start/stop/restart service. Jika aplikasi dibuka tanpa Administrator, monitoring tetap bisa berjalan, tetapi aksi service bisa gagal.
Informasi database membutuhkan `psql.exe` dari PostgreSQL. Utility akan membaca konfigurasi dari `C:\ProgramData\VEXAPACS\backup.config.json` atau environment service `VexaRISBackend`.
