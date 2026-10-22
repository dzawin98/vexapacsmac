# GPT Handover - NEXIAMINIPACS / PATIENTGATE / RIS

Dokumen ini dibuat untuk handover cepat ke akun GPT lain agar langsung paham konteks proyek, status implementasi, dan area yang sedang dikerjakan.

## 1) Ringkasan Proyek
- Nama: `NEXIAMINIPACS - PATIENTGATE - RIS`
- Domain: RIS + Mini PACS + alur MWL (Modality Worklist) terintegrasi Orthanc
- Frontend: React + Vite + TypeScript + Tailwind + shadcn/ui
- Backend: Node.js + Express + MySQL (`backend/index.js`)
- Integrasi utama:
  - Orthanc REST (PACS + MWL plugin/OE2)
  - DICOMweb untuk Worklist/Study/Series/Instance

## 2) Struktur Folder Penting
- Frontend root: `src/`
  - Routing aplikasi: `src/App.tsx`
  - Sidebar/menu: `src/components/AppSidebar.tsx`
  - Service API: `src/lib/dicomService.ts`
  - MWL pages: `src/pages/mwl/`
- Backend:
  - API + migration runtime: `backend/index.js`
  - Env backend: `backend/.env`

## 3) Cara Menjalankan (Dev)
- Frontend:
  - `npm install`
  - `npm run dev`
  - default URL: `http://localhost:8080`
- Backend:
  - `cd backend`
  - `npm install`
  - `node index.js`
  - default API: `http://localhost:3001/api`

Script bantu:
- `run-dev.bat` (frontend)
- `run-backend.bat` (backend)

## 4) Environment yang Dipakai
### Frontend (`/.env`)
- `VITE_BACKEND_URL=http://localhost:3001/api`

### Backend (`/backend/.env`)
- DB:
  - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`
- Server:
  - `PORT`
- Orthanc/PACS/MWL:
  - `ORTHANC_ROOT`
  - `ORTHANC_DICOMWEB_ROOT`
  - Optional auth: `ORTHANC_USERNAME`, `ORTHANC_PASSWORD`
  - Optional MWL endpoint override: `ORTHANC_MWL_ENDPOINT`
  - Optional UID root: `MWL_UID_ROOT`
  - Optional fallback AET: `DEFAULT_MODALITY_AET`
  - Optional debug outbox: `ORTHANC_MWL_DEBUG_DIR`
- Public share / settings:
  - `PUBLIC_SHARE_BASE_URL`
  - `DEFAULT_UI_SETTINGS_JSON`, `DEFAULT_EXPERTISE_SETTINGS_JSON`, `DEFAULT_USERS_JSON`, `DEFAULT_SIGNATURES_JSON`

## 5) Routing Frontend Saat Ini
Didefinisikan di `src/App.tsx`.

### Auth flow
- Jika belum login: redirect ke `/login`
- Jika sudah login dan buka `/login`: redirect ke `/worklist`
- Root `/` -> redirect ke `/worklist`

### Main pages
- `/dashboard`
- `/worklist`
- `/mwl/register`
- `/mwl/order`
- `/mwl/status`
- `/mwl/technologist`
- `/mwl/management-study`
- `/mwl/modality-management`
- `/mwl/doctor-management`
- `/radiologist`
- `/quality-control`
- `/users`
- `/settings`
- Public: `/public/study/:token`

## 6) Nav Menu (Sidebar)
Di `src/components/AppSidebar.tsx`:
- Urutan utama:
  - Dashboard
  - Worklist
  - Order (expandable)
    - MWL Register
    - MWL Order
    - MWL Status
  - MWL Technologist
  - Radiologist
  - Quality Control
  - Management (expandable)
    - Management Study
    - Modality Management
    - Doctor Management
    - User Management
  - Settings
- Expand behavior:
  - Hanya 1 grup expand aktif (`order` atau `management`)
  - Grup tidak otomatis tertutup saat klik child menu
  - Animasi expand smooth (`transition-[max-height,opacity,margin]`)

## 7) MWL - Database Schema Inti
Semua dibuat/di-maintain runtime dari `backend/index.js`.

### `patients` (standar terbaru yang diminta)
- `id` (PK, AI)
- `no_rm` (UNIQUE)
- `nama_pasien`
- `tanggal_lahir`
- `kelamin` (M/F/O)
- `alamat`, `kecamatan`, `kabupaten`, `provinsi`, `kode_pos`, `no_hp`
- `waktu_update_pasien` (auto update)
- `update_simrs` (default `N`)

Catatan kompatibilitas:
- Saat insert pasien, backend juga isi field legacy (`patient_id`, `patient_name`, `dob`, `sex`, `address`) jika kolom itu masih ada, supaya aman untuk schema lama.

### `mwl_orders`
Kolom utama + ekstensi standar Indonesia:
- Core: `patient_record_id`, `accession_number` (UNIQUE), `study_instance_uid` (UNIQUE), `study_date`, `study_time`, `modality`, `procedure_desc`, `status`
- Relasi: `study_master_id`, `referring_doctor_id`, `radiologist_doctor_id`, `modality_station_id`, `technologist_id`
- Field order-in Indonesia:
  - `tanggal_order`, `tanggal_aktivasi`, `no_register`, `no_rontgen` (UNIQUE)
  - `klinis`, `diagnosa`, `kode_pemeriksaan`, `nama_pemeriksaan`
  - `cito`, `polirawat`
  - `kode_ruangan`, `nama_ruangan`
  - `kode_dokter`, `nama_dokter`
  - `kode_admin`, `nama_admin`
  - `kode_dokter_radiolog`, `nama_radiolog`
  - `kode_radiografer`, `nama_radiografer`
  - `cara_bayar`, `kode_asuransi`, `nama_asuransi`
  - `kode_instalasi_radiologi`, `nama_instalasi_radiologi`
  - `waktu_update_orderin`, `update_ris`
- Status enum: `PENDING | SENT_TO_MWL | COMPLETED | CANCELLED`

### Tabel master pendukung
- `mwl_studies` (Procedure Code, Modality Code, Study Description)
- `mwl_doctors` (Kode dokter, Nama dokter, Role CLINICIAN/RADIOLOGIST, link ke user)
- `mwl_modalities` (Nama Ruangan, AE Title Station)
- `mwl_logs` (tracking pengiriman ke Orthanc, active flag)

## 8) MWL - API Endpoint Utama
Prefix: `/api/mwl`

### Master data
- `GET/POST/PUT/DELETE /studies`
- `GET/POST/PUT/DELETE /doctors`
- `GET/POST/PUT/DELETE /modalities`

### Patients
- `GET /patients`
- `POST /patients`

### Orders
- `GET /orders` (support query `status`, `q`)
- `POST /orders`
- `POST /orders/:id/send` -> kirim MWL ke Orthanc
- `PATCH /orders/:id/status`

### Monitoring
- `GET /status` (ambil MWL active logs)
- `GET /technologists` (user role admin/editor)

## 9) Integrasi MWL ke Orthanc (Poin Krusial)
Implementasi ada di `backend/index.js`.

### Alur `send to modality`
1. Ambil order + patient + modality station + technologist.
2. Build payload DICOM tags (`buildMwlDicomPayload`), termasuk:
   - Patient: Name/ID/BirthDate/Sex
   - Order: AccessionNumber, ProcedureDescription, StudyInstanceUID
   - SPS sequence: Modality, ScheduledStationAETitle, StartDate, StartTime, dst
3. Validasi mandatory DICOM format (`validateMwlPayloadForSend`):
   - tanggal `YYYYMMDD`, waktu `HHMMSS`, UID numeric, field wajib terisi.
4. Dispatch ke Orthanc (`dispatchMwlToOrthanc`) dengan fallback endpoint:
   - `ORTHANC_MWL_ENDPOINT` (jika diset)
   - `${ORTHANC_ROOT}/plugins/oe2/worklists`
   - `${ORTHANC_ROOT}/worklists/create`
5. Simpan/update `mwl_logs`, update `mwl_orders.status='SENT_TO_MWL'`.

### Cegah duplikasi worklist
- Untuk order yang sama, jika sebelumnya masih `SENT_TO_MWL` + ada active log:
  - sistem melakukan best-effort delete entry lama di Orthanc dulu,
  - lalu update log existing (bukan insert log aktif baru).
- Tujuan: tidak terjadi duplikat MWL aktif untuk order yang sama.

### Auto complete + cleanup worklist
- `syncCompletedMwlOrdersFromOrthanc()` mengecek order status `SENT_TO_MWL`.
- Jika `StudyInstanceUID` sudah ditemukan sebagai Study di Orthanc PACS:
  - order -> `COMPLETED`
  - log aktif -> `is_active=0`, `orthanc_status='COMPLETED'`
  - file/entry worklist aktif di Orthanc dihapus (best effort)
- Dipanggil pada endpoint monitoring terkait (mis. `/api/mwl/status`, juga saat fetch dokter).

## 10) Status Track Icon (MWL Technologist)
Di `src/pages/mwl/TechnologistPage.tsx`:
- Ikon Radiation:
  - Abu-abu: belum sent
  - Kuning: `SENT_TO_MWL` atau masih ada `has_active_mwl`
  - Hijau: `COMPLETED`
- Ikon Stethoscope (dokter/radiolog report):
  - Abu-abu: belum ada report
  - Kuning: draft
  - Hijau: final
- Ikon Checklist (QC):
  - Hijau jika `quality_control_status.processed_at` ada

## 11) Integrasi Doctor Management <-> User Management
- `mwl_doctors` punya `user_id` nullable, unique.
- User Management bisa mengaitkan akun ke data dokter.
- Tujuan: login dokter radiolog dapat difilter berdasarkan assignment dokter terkait.
- Terkait assignment ada pada alur `radiologist_assignments` berdasarkan `study_instance_uid`.

## 12) Kondisi UI MWL Terbaru
### Register & Order page
- Pola tampilan utama: tabel data.
- Form input berada di dialog tombol tambah (kanan atas).

### MWL Order dialog
- Sudah dipecah menjadi 3 tab:
  - Pemeriksaan
  - Administrasi
  - Dokter & Finalisasi
- Sudah ada search-select Study Description (combobox command).

### MWL Technologist
- Table memanfaatkan komponen Worklist (model QC-like), dengan:
  - filter tanggal preset (today default, yesterday, 7d, 30d, 1m, 2m, custom range)
  - default status view: pending saja (`showAllStatuses=false`)
  - action send hanya icon pesawat + tooltip `Send to MWL`
  - row selection dimatikan (`disableRowSelection`)
  - lock kolom `statusTrack` dan `sendAction`

## 13) Hal yang Perlu Diperhatikan Akun GPT Berikutnya
1. Project sedang dalam kondisi banyak perubahan lokal (working tree dirty), jadi jangan reset/revert sembarangan.
2. Perubahan dilakukan dominan di:
   - `backend/index.js`
   - `src/lib/dicomService.ts`
   - `src/pages/mwl/*`
   - `src/components/AppSidebar.tsx`
   - `src/App.tsx`
3. Jika ada bug MWL query modality, fokus cek:
   - payload yang dikirim endpoint OE2/worklists,
   - kecocokan AET + modality + format date/time,
   - duplicate overwrite behavior di `POST /api/mwl/orders/:id/send`.
4. Isu UX terakhir yang sempat diangkat user:
   - dialog MWL Order dinilai belum sempurna secara visual dan butuh perapihan lebih lanjut.

## 14) Quick Checklist Untuk Lanjutan
- Verifikasi semua flow ini setelah perubahan baru:
  1. Register pasien -> order -> send to modality
  2. Query dari modality berhasil
  3. Kirim image dari modality ke Orthanc
  4. Status radiation menjadi hijau (completed)
  5. Entry MWL aktif hilang dari MWL Status
  6. Status radiologist + QC sinkron
- Cek juga role permission untuk menu/aksi baru agar tidak hidden karena permission mismatch.

---
Dokumen ini adalah snapshot teknis kondisi implementasi saat ini agar handover ke akun GPT lain berjalan cepat.
