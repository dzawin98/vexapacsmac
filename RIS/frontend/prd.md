# Product Requirements Document (PRD)
## Fitur: Modality Worklist (MWL) Integration

### 1. Pendahuluan
Dokumen ini mendefinisikan persyaratan produk untuk pengembangan modul **Modality Worklist (MWL)** di dalam sistem NEXIAMINIPACS - PATIENTGATE - RIS. Modul ini bertujuan untuk memfasilitasi pendataan pasien, pembuatan pesanan pemeriksaan (Order/Study), dan integrasi otomatis dengan sistem Orthanc DICOM Server untuk mengirimkan *Worklist* ke mesin modalitas (Modality).

### 2. Tujuan (Objectives)
- Menyediakan alur end-to-end bagi resepsionis / staf untuk meregistrasi pasien dan mendaftarkan pemeriksaan.
- Menyediakan modul khusus bagi *Technologist* (Radiografer) untuk mengeksekusi orderan dan men-trigger pengiriman MWL.
- Mengirimkan data antrean (Worklist) secara *seamless* ke Orthanc DICOM Server agar dapat ditarik oleh modalitas radiologi (CT, MRI, X-Ray, dll) di lapangan.
- Melacak status aktif dari MWL.

---

### 3. Lingkup dan Fitur Utama Frontend (Halaman UI)

#### 3.1. Halaman: Register Pasien
Halaman untuk mendata pasien baru berdasarkan standar elemen data Modality Worklist.
- **Input Data Mandatory (Standar MWL)**:
  - Patient ID (MRN - Medical Record Number)
  - Nama Lengkap (Patient Name)
  - Tanggal Lahir (Date of Birth)
  - Jenis Kelamin (Sex)
- **Input Data Opsional**: Berat Badan, Tinggi Badan, Alamat, dll.
- **Action**: Tombol "Save/Register" yang menyimpan data ke sistem.

#### 3.2. Halaman: Order (Pemesanan Pemeriksaan)
Halaman untuk menjadwalkan/membuat studi (pemeriksaan) bagi pasien yang telah diregistrasi.
- **Pencarian Pasien**: Mencari pasien berdasarkan Patient ID atau Nama.
- **Input Form**: 
  - Accession Number (Auto-generate atau input manual).
  - Study Date & Time.
  - Modality Type (CR, DX, CT, MR, dll).
  - Requested Procedure Code / Description.
  - Referring Physician (Dokter Perujuk).
- **Action**: Tombol "Create Order" yang menyimpan entri pesanan dengan status awal `PENDING`.

#### 3.3. Halaman: Technologist (Eksekusi Order)
Halaman operasional (*dashboard*) untuk petugas radiografer / technologist guna melihat pesanan yang siap dan men-trigger pengiriman data ke Modalitas.
- **Daftar Order**: Datatable berisi daftar antrean order (kolom: Accession Number, Patient Name, Modality, Procedure).
- **Trigger Eksekusi**: Tombol "Send to Modality" pada setiap baris order.
- **Dialog Assignment (Saat di-trigger)**:
  - Memilih **Petugas (Technologist/Radiographer)** yang akan melaksanakan pemeriksaan dari daftar *dropdown*.
  - Menentukan spesifik ruangan / station / AE Title Modalitas tujuan (Opsional, tergantung konfigurasi lingkungan).
- **Action**: Ketika di-submit, backend akan memproses order ini dan mengintegrasikannya dengan backend Orthanc. Status order berubah menjadi `IN_MODALITY`.

#### 3.4. Halaman: MWL Status (Monitoring)
Halaman pemantauan sistem untuk melacak pengiriman MWL.
- **Daftar MWL**: Menampilkan data *worklist* yang sedang aktif / berada dalam daftar Orthanc.
- **Status Indicator**: Menampilkan status seperti `SENT_TO_ORTHANC`, `ACTIVE` (belum dieksekusi mesin), atau `COMPLETED` (jika dapat dilacak alirannya).

---

### 4. Kebutuhan Integrasi Backend & Orthanc

Modul backend perlu menjembatani interaksi antara MySQL database lokal dan Orthanc.

1. **Pembuatan File `.wl` atau via REST API Orthanc**:
   - Jika menggunakan **Orthanc MWL Plugin**, plugin ini akan mengeksekusi file yang ditaruh pada _Worklists Directory_ milik Orthanc. 
   - **Mekanisme**: Ketika Radiografer menekan "Send to Modality", Node.js Backend akan men-generate representasi DICOM (menggunakan tool seperti `dcmtk` command-line `dump2dcm` atau *dicom builders* di Node) dan meletakkannya ke direktori kerja (worklist) eksternal Orthanc untuk dibaca oleh alat modalitas.
   - Alternatif lain: Jika ada custom HTTP plugin dari orthanc (cth. db custom), API express backend akan POST request ke Orthanc API endpoint.
2. **Kesesuaian Atribut DICOM**: 
   Backend **harus** mengonversi isian form menjadi *DICOM tags*:
   - (0010,0010) Patient's Name
   - (0010,0020) Patient ID
   - (0008,0050) Accession Number
   - (0040,0100) Scheduled Procedure Step Sequence (mengandung modalitas, AET, dsb).

---

### 5. Desain Database (MySQL Schema)

Kita memerlukan tabel baru (atau modifikasi tabel eksekusi pada db/modul eksternal yang sudah ada) di sistem yang mengakomodasi arsitektur kerja ini.

#### 5.1 Tabel `patients`
*(Tabel induk untuk menyimpan data standard DICOM pasien)*
- `id` (INT, PK, Auto Increment)
- `patient_id` (VARCHAR 64, UNIQUE) -> *DICOM Tag (0010,0020)*
- `patient_name` (VARCHAR 255) -> *DICOM Tag (0010,0010)*
- `dob` (DATE) -> *DICOM Tag (0010,0030)*
- `sex` (ENUM('M','F','O')) -> *DICOM Tag (0010,0040)*
- `created_at`, `updated_at` (TIMESTAMP)

#### 5.2 Tabel `orders` (Atau `mwl_orders`)
*(Menyimpan daftar pemeriksaan - dipicu di Halaman Order)*
- `id` (INT, PK)
- `patient_id` (INT, FK merujuk ke tabel patients)
- `accession_number` (VARCHAR 64, UNIQUE) -> *DICOM Tag (0008,0050)*
- `study_date` (DATE)
- `modality` (VARCHAR 16) -> (Misal: CR, CT, MR)
- `procedure_desc` (VARCHAR 255)
- `referring_physician` (VARCHAR 255)
- `technologist_id` (INT, FK merujuk ke id users/petugas) -> *Diisi ketika radiografer men-assign nama petugas di halaman Technologist.*
- `status` (ENUM('PENDING', 'SENT_TO_MWL', 'COMPLETED', 'CANCELLED')) -> *Status tracking di MWL Status.*
- `created_at`, `updated_at`

#### 5.3 Tabel `mwl_logs` (Opsional untuk halaman MWL Status tracker)
*(Merekam jejak komunikasi file/data ke Orthanc)*
- `id` (INT, PK)
- `order_id` (INT, FK)
- `orthanc_file_name` (VARCHAR 255) -> *Nama file .wl yang digenerate.*
- `is_active` (BOOLEAN) -> *Penanda apakah masih di dalam antrean folder MWL Orthanc.*
- `sync_date` (TIMESTAMP)

---

### 6. Rencana Fase Implementasi (Next Steps)
1. **Fase 1 (Database & Backend API)**: Menyiapkan schema MySQL dan Endpoints (CRUD Patient, CRUD Order).
2. **Fase 2 (UI/Frontend)**: Membangun *React views* dan komponen-form untuk Registrasi, Order, dan dashboard Technologist, beserta routingnya.
3. **Fase 3 (Integrasi Orthanc)**: Membangun mekanisme Node.js *worker* atau utilitas endpoint yang mengonversikan data order menjadi ekstensi *worklist* yang ditangkap oleh Orthanc.
4. **Fase 4 (Testing)**: End-to-end testing dari mendaftarkan pasien hingga modalitas berhasil me-retrieve antrean secara riil.

---
**Status Dokumen**: *Draft*
**Tanggal Pembuatan**: Sesuai timestamp percakapan ini.
