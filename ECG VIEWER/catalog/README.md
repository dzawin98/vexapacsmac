# VEXA ECG — master terminology & interpretation store

Artefak di folder ini adalah fondasi penyimpanan kesimpulan EKG: katalog istilah
master, schema relasional, dan seed data.

## Isi folder

| File | Fungsi |
|---|---|
| `ecg-interpretation-terms.json` | Katalog master istilah. Dipakai aplikasi/engine dan sebagai sumber seed. |
| `ecg-viewer-mysql.sql` | Schema MySQL 8 + seed istilah (8 tabel, 32 istilah). |

## PENTING — kode internal, bukan kode standar

Semua kode `VEXA-ECG-*` adalah **kode internal aplikasi**. Itu bukan kode resmi
AHA, ACCF, HRS, SNOMED CT, LOINC, maupun DICOM. Jangan tampilkan atau laporkan
kode ini seolah kode standar. Field `terminology_reference` hanya mencatat bahwa
*struktur* kategori merujuk ke dokumen AHA/ACCF/HRS Part II
(DOI 10.1161/CIRCULATIONAHA.106.180201); pemetaan resmi ke SNOMED/LOINC belum ada
dan tidak boleh dikarang.

## Alur data yang didukung

```
ECG DICOM (modality/PACS)
  -> ekstraksi waveform + metadata          -> ecg_exam
  -> analisis waveform (versi tercatat)     -> ecg_algorithm_run
  -> pengukuran (HR, PR, QRS, QT/QTc, axis) -> ecg_measurement_set
  -> temuan berkode algoritma               -> ecg_finding  (+ interpretation_term)
  -> review dokter                          -> ecg_review, ecg_review_finding
  -> laporan final disahkan dokter          -> ecg_final_report
```

Pemisahan ini membuat interpretasi mesin tidak pernah otomatis menjadi diagnosis
final: `ecg_finding` menyimpan `source` (`device`/`algorithm`/`clinician`) dan
`verification_status` (`unconfirmed`/`reviewed`/`confirmed`/`amended`).

## Flag `algorithm_eligible`

`algorithm_eligible = true` hanya untuk istilah yang **benar-benar** dapat
dihasilkan engine analisis saat ini (10 istilah):

```
VEXA-ECG-TECH-001   Limited ECG acquisition      (akuisisi < 12 lead)
VEXA-ECG-RATE-001   Bradycardic rate             (HR < 50)
VEXA-ECG-RATE-002   Tachycardic rate             (HR > 100)
VEXA-ECG-RHYTHM-003 Irregular rhythm             (RR variabilitas tinggi)
VEXA-ECG-AXIS-002   Left axis deviation          (axis < -30°)
VEXA-ECG-AXIS-003   Right axis deviation         (axis > 90°)
VEXA-ECG-COND-001   Prolonged QRS duration       (QRS >= 120 ms)
VEXA-ECG-INT-001    Prolonged QTc interval       (QTcF >= 450 ms, tanpa koreksi jenis kelamin)
VEXA-ECG-STT-001    ST-segment elevation         (ambang per-lead, screening)
VEXA-ECG-STT-002    ST-segment depression        (ambang per-lead, screening)
```

Istilah lain (atrial fibrillation, bundle branch block, LVH, infarction pattern,
dan seterusnya) sengaja `algorithm_eligible = false`: tersedia untuk pemilihan
manual/verifikasi dokter, tetapi **tidak** dipicu heuristik yang belum
tervalidasi. Menyalakannya tanpa algoritma tervalidasi = klaim diagnosis palsu.

## Catatan implementasi

- Ambang di atas adalah ambang *screening*, bukan kriteria diagnosis. Setiap
  temuan tersimpan `unconfirmed` sampai dokter review.
- `VEXA-ECG-INT-001` belum memisahkan ambang pria/wanita (AHA: QTc >= 450 ms pria,
  >= 460 ms wanita). Tambahkan kolom jenis kelamin di `ecg_exam` sebelum
  mengklaim kepatuhan penuh terhadap pedoman.
- Kejadian ST yang sama pada beberapa lead dikelompokkan menjadi **satu** temuan;
  daftar lead disimpan di `evidence_payload` (`{"leads": [...], "deviationsUv": {...}}`).
- Database ini menyimpan referensi DICOM + hasil analisis. Ia **bukan** pengganti
  PACS/VNA sebagai penyimpanan waveform.
- `ecg_measurement_set.ecg_algorithm_run_id` unik: satu run menghasilkan satu set
  pengukuran; analisis ulang membuat run baru (jejak audit saat algoritma berubah).

## Verifikasi yang sudah dijalankan

- `npm test` (atau `node --test test/*.test.js`) → 8 test lulus, termasuk contract
  test: setiap kode yang di-emit engine wajib ada di katalog dan
  `algorithm_eligible`, dan salinan fallback di `ecg-viewer.js` wajib meng-emit
  set kode yang identik dengan modul `analysis-core.js`.
- Validasi artefak: 32 istilah, 32 seed row unik, 8 tabel, 10 istilah
  `algorithm_eligible`.
- Browser nyata pada ECG DICOM 12-lead: 4 coded finding tampil, status
  "Computer interpretation · Awaiting clinician verification", nol console error.

## Lokasi

Folder ini (`ECG VIEWER/catalog/`) sengaja dipisah dari `ECG VIEWER/data/`, yang
di-ignore git dan dipakai untuk data runtime DICOM.

