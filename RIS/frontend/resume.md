# Resume Aplikasi: NEXIAMINIPACS - PATIENTGATE - RIS

Aplikasi ini adalah sebuah sistem informasi manajemen radiologi atau **RIS (Radiology Information System)** yang terintegrasi dengan **Mini-PACS (Picture Archiving and Communication System)** serta dilengkapi portal akses untuk pasien (**Patient Portal**). Sistem ini dirancang untuk memanajemen alur kerja pasien, studi gambar medis (DICOM), pelaporan oleh radiolog, hingga quality control.

## 🛠️ Teknologi yang Digunakan

### Frontend (User Interface)
Aplikasi frontend dibangun menggunakan teknologi web modern berfokus pada kecepatan dan antarmuka pengguna yang interaktif.
- **Framework & Core**: React 18, TypeScript, dan Vite (untuk *fast build* dan mode development).
- **Styling & UI Library**: Tailwind CSS, shadcn/ui, dan Radix UI Primitives (untuk komponen UI interaktif yang *accessible*).
- **State Management & Data Fetching**: `@tanstack/react-query` untuk manajemen data asynchronous dan *caching*.
- **Routing**: `react-router-dom` untuk navigasi antar halaman (*Single Page Application*).
- **Form & Validasi**: `react-hook-form` dikombinasikan dengan `zod` untuk validasi struktur data.
- **Fitur Tambahan**: 
  - `tinymce-react`: Konfigurasi *Rich Text Editor* untuk pembuatan laporan radiolog.
  - `recharts`: Untuk visualisasi data dan statistik pada Dashboard.
  - `lucide-react`: Menyediakan aset ikon UI.
  - Dukungan mode Tema (Dark/Light Mode) dengan `next-themes`.

### Backend (Server API)
Backend melayani pemrosesan data medis dan API yang digunakan oleh frontend.
- **Framework**: Node.js dengan framework Express.js.
- **Database**: `mysql2` untuk komunikasi dengan database relasional MySQL.
- **Medical Imaging Parsing**: `dicom-parser` digunakan untuk membaca dan memproses metadata file gambar medis berstandar industri (DICOM).
- **Middleware & Utility**: `body-parser` (parsing request REST API), `cors` (pengaturan keamanan akses lintas domain), dan `morgan` untuk logging permintaan HTTP.

---

## 🎯 Fitur dan Fungsi Utama

Sistem ini didesain modul per modul dengan pendekatan **Role-Based Access Control (RBAC)** di mana akses fitur dibatasi oleh *permission* seperti admin, staff, atau radiolog. Berikut penjabaran fungsinya:

### 1. Autentikasi dan Manajemen Pengguna
- **Login Staff/Radiolog**: Autentikasi aman berbasis sesi/token untuk memasuki sistem.
- **User Management**: Mengelola akun pengguna dalam sistem (menambah user, mengatur kata sandi), beserta hak akses (*roles & permissions*) seperti `view_dashboard`, `view_radiologist`, dll.

### 2. Manajemen Worklist (Daftar Kerja)
- **Worklist Utama (Modul Staff)**: Menyediakan daftar antrean studi pasien yang akan atau sedang dijalani, mengelola metadata pasien, serta manajemen penjadwalan dengan kemampuan mendistribusikan/*assign* pemeriksaan ke radiolog terkait.
- **Radiologist Worklist**: Sebuah *dashboard* khusus yang hanya memuat daftar tugas atau studi-studi radiologi yang sudah dikhususkan/ditugaskan kepada dokter radiolog tertentu untuk dievaluasi.

### 3. Pelaporan Radiologi (Radiologist Report)
Menyediakan antar muka (*interface*) komprehensif bagi radiolog untuk:
- Mengakses detail studi menggunakan UID (`StudyInstanceUID`).
- Menulis, mengedit, dan mengesahkan laporan bacaan radiologi. Fitur ini didukung secara kuat oleh *Rich Text Editor* (TinyMCE) agar mudah di-format sesuai standar rumah sakit.

### 4. Patient Gate / Public Study Access (Portal Pasien)
- Terdapat fitur `Public Study` yang memungkinkan perujuk medis atau pasien mengakses hasil studi (image/laporan) dari luar sistem (eksternal) dengan aman melalui sebuah *token url unik* (misalnya: `/public/study/:token`).

### 5. Quality Control (QC)
- Memungkinkan staf penyetor mutu atau radiolog senior untuk melakukan *Quality Control* kepada laporan atau gambar medis yang dihasilkan sebelum dapat dirilis ke pasien secara final. Membantu menjaga keakuratan.

### 6. Dashboard & Analitik
- Memberikan visualisasi dan rekap data operasional radiologi harian, mingguan, atau bulanan kepada manajemen atau staf radiologi untuk melakukan pelacakan produktivitas dan statistik lainnya.

### 7. Konfigurasi Sistem (Settings)
- Mengatur konfigurasi instansi rumah sakit/klinik, pengaturan default sistem, dan perombakan parameter lain dalam sistem terpusat.
