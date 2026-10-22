# VELOPACS-RIS UI English Glossary

Reference for writing UI text in this product. The system is a RIS + PACS used in a
hospital, so terminology must match international PACS usage (DICOM/HL7 wording) rather
than literal translations of the Indonesian label.

## Rules

1. **Only user-visible text changes.** Button labels, headings, table headers, helper
   text, placeholders, toasts, dialog copy, validation and error messages, e-mail /
   WhatsApp / notification templates, and printed/PDF report text.
2. **Never rename identifiers.** Object keys, API request/response fields, DB columns,
   query parameters, env vars, Redux/Zustand keys, route paths, test ids and CSS class
   names stay exactly as they are - several of them (`kelamin`, `alamat`, `diagnosa`,
   `polirawat`, `nama_instalasi_radiologi`, `no_rm`) are part of the SIMRS contract.
   Translating them breaks the integration.
3. **Never touch data values that mirror DICOM/SIMRS content** (modality codes, UIDs,
   accession numbers, tag names in dose rules). Mock/fixture *display* strings may be
   translated when they are placeholder prose (e.g. `"dr. Radiologi Satu"` ->
   `"Dr. Radiology One"`), but real names are data, not UI.
4. **Keep placeholders intact**: `{{patient_name}}`, `{value}`, `%s`, `${var}` and
   ICU-style tokens must survive verbatim.
5. **Style**: sentence case for labels and buttons, no trailing period on buttons or
   short labels, sentence + period for sentences and error messages. No exclamation
   marks. Prefer "Select" over "Choose", "Study"/"Series"/"Instance" over "exam"/"scan"
   when the DICOM object is meant.
6. **Nothing else changes**: no reformatting, no reordering, no behaviour edits, no
   dependency changes. A translator's diff should be readable as "same code, English
   strings".

## Core actions

| Indonesian | English |
| --- | --- |
| Batal | Cancel |
| Simpan | Save |
| Hapus | Delete |
| Ubah / Edit | Edit |
| Tambah | Add |
| Cari | Search |
| Pilih | Select |
| Kirim | Send |
| Unduh | Download |
| Unggah | Upload |
| Cetak | Print |
| Pratinjau | Preview |
| Perbarui / Muat ulang | Refresh / Reload |
| Kembali | Back |
| Lanjut | Continue |
| Tutup | Close |
| Masuk | Sign in |
| Keluar | Sign out |
| Semua | All |
| Tidak ada / Belum ada | None / No ... yet |
| Tidak dipilih | Not selected |
| Wajib diisi | Required |
| Jumlah | Total |
| Keterangan / Catatan | Notes / Remarks |
| Ringkasan | Summary |
| Riwayat | History |
| Laporan | Report |
| Pengaturan | Settings |
| Pengguna | Users |
| Peran / Hak akses | Role / Access rights |
| Gagal | Failed / Could not |
| Berhasil | Successfully / Saved |
| Sedang diproses | In progress |
| Selesai | Completed |

## Clinical / PACS terminology

| Indonesian | English |
| --- | --- |
| Pasien | Patient |
| Nomor Rekam Medis / No. RM | Medical Record Number (MRN) |
| Pemeriksaan | Study |
| Pemeriksaan (tindakan) | Procedure |
| Gambar / Image | Image |
| Seri / Series | Series |
| Instansi / Poli | Clinic / Unit |
| Rawat Jalan | Outpatient |
| Rawat Inap | Inpatient |
| Dokter | Physician |
| Dokter pengirim | Referring physician |
| Radiolog | Radiologist |
| Expertise / Bacaan radiolog | Radiologist report |
| Petugas | Staff / Technologist |
| Fisikawan medis | Medical physicist |
| Diagnosa / Diagnosis | Diagnosis |
| Tindakan | Procedure |
| Temuan | Findings |
| Kesimpulan | Conclusion |
| Saran | Recommendation |
| Hasil | Result |
| Penjamin | Payer |
| Asuransi | Insurance |
| Biaya / Tarif | Cost / Rate |
| Antrean | Queue |
| Jadwal | Schedule |
| Tanggal awal / Tanggal akhir | Start date / End date |
| Tanggal lahir | Date of birth |
| Jenis kelamin | Sex |
| Alamat | Address |
| Umur | Age |
| Modalitas / Alat | Modality |
| Ruang pemeriksaan | Examination room |
| Bahan kontras | Contrast |
| Rujukan | Referral |
| Volume dosis | Dose |
| Paparan | Exposure |
| Pemeriksaan ulang | Repeat study |

## Phrase-level (already inventoried)

| Indonesian | English |
| --- | --- |
| Scan untuk hasil | Scan for results |
| Link Hasil | Report link |
| Link siap dipakai untuk WhatsApp dan barcode. | The link is ready to share over WhatsApp or a barcode. |
| Kirim WhatsApp | Send via WhatsApp |
| WhatsApp terkirim | WhatsApp message sent |
| Template Pasien | Patient template |
| Pilih template pasien | Select a patient template |
| Simpan Template Reporting | Save reporting template |
| Isi template akan mengambil data Findings dan Conclusion saat ini. | The template will capture the current Findings and Conclusion text. |
| Belum ada revisi. | No revisions yet. |
| Belum ada expertise radiolog | No radiologist report yet |
| Series belum tersedia. | No series available yet. |
| Image belum tersedia. | No images available yet. |
| Unduh PDF | Download PDF |
| DICOM ZIP sedang diunduh. | The DICOM archive is downloading. |
| ${years} Th ${months} Bulan | ${years} y ${months} mo |
| Mohon segera membaca study berikut: | Please read the following study as soon as possible: |
| Pasien: {{patient_name}} | Patient: {{patient_name}} |
| No. RM: {{patient_id}} | MRN: {{patient_id}} |
| Pemeriksaan: {{study_description}} | Study: {{study_description}} |
| Nomor WhatsApp dan pesan wajib diisi | WhatsApp number and message are required |
| Pilih fisikawan medis | Select a medical physicist |
| Tidak dipilih | Not selected |
| Tampilkan daftar series dan preview saat study dipilih di Worklist dan Distribution. | Show the series list and previews when a study is selected in the Worklist and Distribution pages. |
| Sesi Anda berakhir karena tidak ada aktivitas. Silakan masuk kembali. | Your session ended because there was no activity. Please sign in again. |
| Sesi Anda sudah tidak berlaku di server. Silakan masuk kembali. | Your session is no longer valid on the server. Please sign in again. |
| StudyInstanceUID atau AccessionNumber wajib tersedia untuk membuka Viewer. | A StudyInstanceUID or Accession Number is required to open the Viewer. |
| Gagal membuka Viewer | Could not open the Viewer |
| Viewer tidak mengembalikan launchUrl | The Viewer did not return a launchUrl |
| Nama series wajib diisi. | Series description is required. |
| Ambil seed tengah dan tepi perdarahan terlebih dahulu. | Place a seed in the centre and at the margin of the haemorrhage first. |
| StudyUID atau accession tidak ditemukan di launch context. | StudyInstanceUID or Accession Number is missing from the launch context. |
| Akun ini belum memiliki izin untuk membuka study. | This account is not permitted to open studies. |
| Perubahan gagal disimpan. | Changes could not be saved. |
| User berhasil disimpan. | User saved. |
| Role berhasil disimpan. | Role saved. |
| Konfigurasi API key berhasil disimpan. | API key configuration saved. |
| Shared secret untuk endpoint launch viewer dari RIS. | Shared secret for the viewer launch endpoint called by the RIS. |
| Login gagal. | Sign-in failed. |
| Gagal memuat data service. | Failed to load service data. |
| Request gagal. | Request failed. |
| Role ini tidak diizinkan membuka modality X. | This role is not permitted to open modality X. |
| Role ini hanya boleh membuka series sampai N image. | This role may open up to N images per series. |
| Series ini bukan image DICOM yang bisa dirender, waveform ECG, atau SR Report yang bisa dibaca. | This series is not a renderable DICOM image series, an ECG waveform, or a readable Structured Report. |
| Series ini tidak memiliki pixel image dan tidak dimasukkan ke viewport. | This series has no pixel data and was not loaded into the viewport. |
| Gunakan launch token dari RIS untuk membuka viewer. | Open the viewer with a launch token from the RIS. |
| WW/WL custom preset tidak valid. | Invalid custom WW/WL preset. |
| Isi nama preset serta WW/WL yang valid. | Enter a preset name and valid WW/WL values. |
| Username atau password tidak sesuai. | Incorrect username or password. |
| RIS launch wajib menyertakan accession atau StudyInstanceUID. | A RIS launch must include an Accession Number or StudyInstanceUID. |
| Akun yang sedang digunakan tidak dapat dihapus. | The account currently in use cannot be deleted. |
| Role masih digunakan oleh user. | The role is still assigned to users. |
| Username sudah digunakan. | That username is already taken. |
| Password wajib diisi untuk user baru. | A password is required for a new user. |
| Nama role wajib diisi. | Role name is required. |
| Format video harus MP4, AVI, atau MPEG. | Video format must be MP4, AVI, or MPEG. |
| Video input kosong atau melebihi batas ekspor. | The video input is empty or exceeds the export limit. |
| DICOM Print gateway tidak dapat dihubungi | The DICOM print gateway could not be reached |
| FFmpeg tidak ditemukan di server viewer. | FFmpeg was not found on the viewer server. |
| FFmpeg tidak dapat dijalankan (binary tidak ditemukan). | FFmpeg could not be started (binary not found). |
