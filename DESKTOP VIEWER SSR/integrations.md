# PACS Integration Guide

Dokumen ini berisi rekomendasi agar fitur viewer yang sudah dikembangkan bisa berjalan konsisten ketika diintegrasikan dengan PACS lain, misalnya Orthanc, dcm4chee, atau PACS vendor rumah sakit.

## Tujuan Integrasi

Viewer ini bergantung pada DICOMweb untuk mengambil image, menyimpan capture, dan menyimpan presentation state. Agar fitur seperti MPR, Save Capture Series, GSPS annotation, cine, multi-viewport compare, dan intellynk berjalan stabil, PACS tujuan sebaiknya menyediakan endpoint DICOMweb yang lengkap dan tidak mengembalikan HTML viewer untuk request DICOMweb.

Minimal endpoint yang dibutuhkan:

- QIDO-RS untuk study, series, dan instance listing.
- WADO-RS untuk metadata, frame, dan bulk pixel data.
- STOW-RS untuk menyimpan Secondary Capture dan GSPS/PR object.
- DELETE DICOM object jika ingin annotation/GSPS bisa dihapus permanen dari server.

## Environment Configuration

Konfigurasi utama ada di `.env` atau environment production:

```env
VITE_DICOMWEB_BASE_URL=https://pacs.domain.com/rs
VITE_DICOMWEB_AUTHORIZATION=Bearer replace-with-token
VITE_DICOMWEB_QIDO_PREFIX=
VITE_DICOMWEB_WADO_PREFIX=
VITE_DICOMWEB_STOW_PREFIX=
```

Gunakan `VITE_DICOMWEB_BASE_URL` sebagai base DICOMweb yang benar. Jangan arahkan ke URL aplikasi viewer, reverse proxy frontend, atau halaman web PACS biasa.

Contoh endpoint final yang harus valid:

```text
GET  /rs/studies
GET  /rs/studies/{StudyInstanceUID}/series
GET  /rs/studies/{StudyInstanceUID}/series/{SeriesInstanceUID}/instances
GET  /rs/studies/{StudyInstanceUID}/series/{SeriesInstanceUID}/metadata
GET  /rs/studies/{StudyInstanceUID}/series/{SeriesInstanceUID}/instances/{SOPInstanceUID}/frames/{frame}
POST /rs/studies
POST /rs/studies/{StudyInstanceUID}
```

Jika PACS memakai path berbeda untuk QIDO, WADO, dan STOW, gunakan prefix:

```env
VITE_DICOMWEB_BASE_URL=https://pacs.domain.com
VITE_DICOMWEB_QIDO_PREFIX=dicom-web
VITE_DICOMWEB_WADO_PREFIX=dicom-web
VITE_DICOMWEB_STOW_PREFIX=dicom-web
```

## Routing Checklist

Sebelum integrasi dianggap siap, test dengan curl/Postman/browser network:

- `GET /studies` harus mengembalikan `application/dicom+json` atau JSON DICOMweb, bukan HTML.
- `GET /series` harus menyertakan `Modality`, `SeriesInstanceUID`, `SeriesDescription`, dan jumlah instance jika tersedia.
- `GET /metadata` harus menyertakan metadata image yang cukup untuk Cornerstone, terutama rows, columns, spacing, orientation, position, window center/width, slope/intercept, dan transfer syntax.
- `GET /frames/{frame}` harus mengembalikan pixel data DICOMweb yang bisa dibaca Cornerstone.
- `POST /studies` atau `POST /studies/{StudyInstanceUID}` harus menerima `multipart/related; type="application/dicom"`.
- Response STOW tidak boleh berupa HTML meskipun HTTP status `200 OK`.

Masalah yang pernah muncul: endpoint STOW diarahkan ke aplikasi viewer, sehingga response `200 OK` tetapi body-nya `<!doctype html>`. Ini harus dianggap gagal routing, bukan sukses.

## Save Capture Series

Fitur Save Capture Series menyimpan viewport sebagai DICOM Secondary Capture. Target integrasi:

- Capture harus memakai StudyInstanceUID yang sama dengan study asal.
- SeriesInstanceUID dan SOPInstanceUID harus baru.
- Series Description diisi dari input user.
- Modality mengikuti modality sumber, misalnya CT tetap CT, bukan OT.
- Text overlay patient/study tidak ikut dicapture.
- Image viewport, measurement, annotation, marker, dan overlay non-text viewer ikut dicapture.
- Window level yang terlihat di viewport harus dipakai saat membangun pixel capture.

Rekomendasi PACS:

- PACS harus menerima Secondary Capture atau derived image dengan StudyInstanceUID existing.
- PACS tidak boleh mengubah StudyDescription dari object baru menjadi nama series capture.
- PACS harus melakukan re-index series baru tanpa perlu refresh study penuh jika memungkinkan.
- Jika PACS tidak langsung mengembalikan series baru di QIDO, viewer boleh append series baru di ujung kanan dan melakukan background refresh ringan.

## GSPS Annotation Persistence

GSPS digunakan untuk menyimpan presentation state annotation/measurement sebagai DICOM PR object. Fungsinya bukan membuat image baru, tetapi menyimpan cara annotation ditampilkan pada image referensi.

Target perilaku:

- Measurement dan ROI yang dibuat di viewer bisa disimpan.
- Setelah refresh halaman dan membuka series/image yang sama, annotation muncul kembali.
- PR series tidak perlu tampil sebagai series klinis biasa di browser series karena membingungkan dokter.
- Jika annotation dihapus di viewer, annotation tidak boleh muncul kembali setelah refresh.
- Jika user save GSPS baru setelah delete, suppression lama harus dibuka dan annotation baru tampil lagi.

Rekomendasi PACS:

- Support SOP Class GSPS: `1.2.840.10008.5.1.4.1.1.11.1`.
- Simpan PR object dengan reference ke StudyInstanceUID, SeriesInstanceUID, dan SOPInstanceUID image sumber.
- QIDO/WADO metadata PR harus bisa diambil kembali agar viewer bisa membaca reference dan graphic layer.
- Jika memungkinkan, sediakan endpoint DELETE untuk menghapus PR object secara permanen.

Catatan penting: tanpa DELETE endpoint di PACS, viewer hanya bisa menyembunyikan GSPS yang sudah dihapus melalui local suppression. PR object lama masih ada di server, tetapi tidak dimuat lagi oleh viewer untuk image tersebut.

Endpoint DELETE yang direkomendasikan:

```text
DELETE /rs/studies/{StudyInstanceUID}/series/{SeriesInstanceUID}/instances/{SOPInstanceUID}
```

Jika vendor PACS tidak support DELETE DICOMweb, sediakan backend proxy internal yang menerjemahkan delete request ke API native PACS/vendor.

## MPR Multi-Viewport

MPR membutuhkan volume CT yang konsisten. Agar MPR berjalan di PACS lain:

- Series harus punya ImagePositionPatient, ImageOrientationPatient, PixelSpacing, SliceThickness, dan SpacingBetweenSlices jika tersedia.
- Instance harus bisa diurutkan dengan benar berdasarkan posisi slice, bukan hanya InstanceNumber.
- Semua image dalam volume sebaiknya punya FrameOfReferenceUID yang sama.
- Transfer syntax harus didukung decoder Cornerstone.
- MPR harus aktif per viewport, bukan global, agar dokter bisa compare MPR di lebih dari satu viewport.
- Layout MPR 2x2 harus tetap berada di viewport series yang sedang dipakai, bukan mengambil seluruh viewer.
- Double click pada area MPR harus fullscreen viewport MPR, bukan fullscreen tile kecil.

Untuk PACS dengan CT multi-frame, pastikan WADO-RS frame endpoint benar dan metadata `NumberOfFrames` tersedia.

## Cine

Cine harus berjalan untuk semua stack image yang memiliki lebih dari satu slice/frame, bukan hanya XA cathlab.

Checklist:

- CT multi-slice harus memiliki lebih dari satu renderable image/frame.
- Viewer harus membedakan antara single instance multi-frame dan multi instance stack.
- Cine tidak boleh auto-pause setelah satu slice kecuali sudah mencapai batas dan mode loop dimatikan.
- PACS harus mengembalikan seluruh instance stack, bukan hanya current instance.

Jika cine hanya berjalan satu slice, biasanya penyebabnya:

- QIDO/WADO hanya mengembalikan satu instance.
- Metadata `NumberOfFrames` tidak terbaca.
- Frame URL untuk multi-frame tidak valid.
- Sorting stack gagal karena posisi/instance number metadata tidak lengkap.

## Measurement and ROI Tooling

Untuk kompatibilitas annotation:

- Simpan annotation internal viewer sebagai snapshot Cornerstone agar ROI bisa dipulihkan dengan bentuk asli.
- Jangan hanya menyimpan SVG/capture untuk GSPS, karena itu tidak cukup untuk restore measurement yang bisa diedit.
- Rectangle ROI, Circle ROI, Elliptical ROI, dan Freehand ROI harus bisa move dan resize.
- Delete annotation harus menghapus state Cornerstone dan state GSPS yang tersimpan.
- Context menu tool selection tidak boleh langsung memulai measurement di posisi klik kanan.

Untuk integrasi PACS lain, GSPS DICOM standar tetap disimpan, tetapi viewer juga perlu local/native snapshot agar restore tool interaktif tetap akurat.

## Intellynk Antar MPR

Intellynk atau linked navigation harus bekerja antar viewport biasa dan antar MPR mode.

Rekomendasi:

- Link berdasarkan StudyInstanceUID, FrameOfReferenceUID, dan posisi world coordinate jika tersedia.
- Untuk compare antar MPR, sinkronisasi slice sebaiknya memakai world point/plane, bukan index slice mentah.
- Untuk series berbeda tapi study sama, fallback bisa memakai nearest ImagePositionPatient.
- Jangan paksa link jika geometry tidak kompatibel, misalnya modality berbeda atau FrameOfReferenceUID berbeda tanpa mapping.

## Overlay Information

Overlay image harus tetap informatif tetapi tidak mengganggu capture:

- Patient name dan patient ID harus tampil di overlay viewport.
- Overlay MPR kiri atas harus memakai ukuran font yang sama dengan text overlay aktif.
- Informasi seperti orientation, slice thickness, slab mode, MIP/MinIP harus tersusun ringkas.
- Text overlay viewer tidak ikut Save Capture Series.
- Annotation dan measurement tetap ikut Save Capture Series.

## PACS Compatibility Matrix

Gunakan matrix ini saat testing PACS baru:

| Fitur | Requirement PACS | Status yang Diharapkan |
| --- | --- | --- |
| Study list | QIDO `GET /studies` | Study tampil tanpa error |
| Series list | QIDO `GET /studies/{uid}/series` | Series image tampil, PR disembunyikan dari list klinis |
| Image render | WADO-RS metadata + frames | CT/XA/CR/MR render normal |
| MPR | CT geometry lengkap | Axial/coronal/sagittal/MPR tile tampil |
| Cine CT | Multi instance atau multi-frame valid | Play loop lebih dari satu slice |
| Save Capture | STOW-RS POST | Series baru muncul di ujung list |
| GSPS save | STOW-RS + PR metadata | Annotation tampil setelah refresh |
| GSPS delete | DICOMweb DELETE atau local suppression | Annotation tidak muncul lagi setelah refresh |
| Intellynk | Geometry/FrameOfReferenceUID | Crosshair/slice sync antar viewport |

## Backend Proxy Recommendation

Untuk production, sebaiknya viewer tidak langsung memanggil PACS vendor jika ada masalah CORS, auth, atau path routing. Gunakan backend proxy:

- Menambahkan Authorization/token PACS secara server-side.
- Menormalkan prefix QIDO/WADO/STOW.
- Memastikan response DICOMweb tidak berubah menjadi HTML.
- Menyediakan DELETE endpoint untuk PR/GSPS jika PACS vendor tidak punya DICOMweb DELETE.
- Melakukan audit log untuk save capture, save GSPS, dan delete GSPS.
- Menyediakan cache invalidation ringan setelah STOW agar series baru muncul tanpa refresh study penuh.

## Validation Flow

Setelah integrasi ke PACS baru, jalankan skenario berikut:

1. Buka study CT dengan beberapa series.
2. Aktifkan MPR pada satu viewport, lalu aktifkan MPR lagi pada viewport lain.
3. Test intellynk antar MPR dan antar stack biasa.
4. Buat Length, Rectangle ROI, Ellipse ROI, Circle ROI, Freehand ROI, dan text/shape annotation.
5. Save GSPS, refresh halaman, buka image yang sama, pastikan annotation tampil kembali.
6. Delete annotation, refresh halaman, pastikan annotation tidak muncul kembali.
7. Save Capture Series dengan nama custom, pastikan modality mengikuti sumber dan image capture tidak terlalu kecil.
8. Buka capture series, pastikan window level dan annotation terlihat sesuai viewport asal.
9. Test cine pada CT multi-slice dan XA multi-frame.
10. Cek network tab untuk memastikan tidak ada response HTML pada endpoint DICOMweb.

## Known Limitations

- Tanpa endpoint DELETE PACS, delete GSPS hanya permanen di sisi viewer melalui suppression lokal.
- Restore annotation interaktif paling akurat memakai snapshot viewer; GSPS standar dari PACS vendor lain mungkin hanya bisa ditampilkan sebagai passive overlay jika format graphic-nya berbeda.
- Capture series adalah derived image; measurement yang ikut capture menjadi burned-in visual, bukan measurement interaktif.
- PACS tertentu bisa mengubah metadata series/study saat menerima STOW. Ini harus dicegah di backend/PACS config jika memengaruhi study list.

## Rekomendasi Implementasi Lanjutan

- Tambahkan DICOMweb DELETE client dan backend route untuk menghapus PR object permanen dari PACS.
- Simpan mapping GSPS yang dibuat viewer: source Study/Series/SOP ke PR Series/SOP agar delete server-side tepat sasaran.
- Buat integration test untuk Orthanc dan dcm4chee.
- Tambahkan health check DICOMweb yang memvalidasi QIDO/WADO/STOW sebelum viewer dipakai dokter.
- Tambahkan background append series setelah STOW agar UI tidak berkedip karena refresh study penuh.
- Tambahkan mode fallback untuk PACS yang tidak support GSPS penuh: simpan annotation snapshot ke backend aplikasi, tetapi tetap buat PR object jika STOW tersedia.
