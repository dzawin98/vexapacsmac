# NEXIA Viewer Rebuild Plan

## Keputusan

Viewer di folder `public` adalah bundle OHIF yang sudah dibuild. Untuk redesign total, jangan lanjut dengan CSS override di bundle static karena hasilnya tidak stabil, sulit presisi, dan tetap terasa seperti OHIF.

Jalur yang benar adalah membuat viewer source baru dari OHIF, lalu mengubah komponen source sebelum build.

## Target UI

- Brand utama: NEXIA VIEWER.
- Header baru sepenuhnya, bukan header OHIF yang ditambal.
- Toolbar top horizontal dengan icon besar, label rapi, group tools jelas, dan active state monokrom.
- Panel Studies/Series custom dengan warna hitam/charcoal konsisten.
- Tidak ada warna navy/dongker OHIF.
- Tidak ada text Open Health Imaging Foundation.
- Viewer tetap memakai DICOMWeb endpoint `dicomweb-pacs`:
  - QIDO-RS: `/rs`
  - WADO-RS: `/rs`
  - WADO-URI: `/wadouri`

## Prinsip

- Jangan ubah DICOM loading dulu.
- Jangan ubah synchronizer, image loader, stack prefetch, atau tool behavior.
- Fokus tahap pertama hanya UI shell.
- Gunakan source OHIF, bukan patch CSS ke bundle static.

## Langkah Implementasi Source

1. Siapkan folder source viewer, misalnya:
   - `C:\NEXIOMINIO\buildpacs\nexia-viewer-source`

2. Ambil OHIF versi yang sesuai handover:
   - `3.13.0-beta.14`

3. Terapkan perubahan source:
   - `platform/app/public/config/default.js`
   - `platform/ui-next/src/tailwind.css`
   - `platform/ui-next/src/components/Header/Header.tsx`
   - `platform/ui-next/src/components/ToolButton/ToolButton.tsx`
   - `platform/ui-next/src/components/ToolButton/ToolButtonList.tsx`
   - `platform/ui-next/src/components/SidePanel/SidePanel.tsx`
   - `extensions/default/src/ViewerLayout/index.tsx`
   - `extensions/default/src/ViewerLayout/ViewerHeader.tsx`
   - `extensions/default/src/Toolbar/Toolbar.tsx`
   - `extensions/default/src/Toolbar/ToolButtonWrapper.tsx`
   - `extensions/default/src/Toolbar/ToolButtonListWrapper.tsx`
   - `modes/basic/src/index.tsx`
   - `modes/basic/src/toolbarButtons.ts`

4. Build hasil source viewer.

5. Copy hasil build viewer ke:
   - `C:\NEXIOMINIO\buildpacs\dicomweb-pacs\public`

6. Validasi:
   - `http://127.0.0.1:5001/viewer`
   - route study dari worklist
   - thumbnail/studies panel
   - window level, pan, zoom, stack scroll
   - DICOMWeb request tetap ke `/rs` dan `/wadouri`

## Status Saat Ini

- CSS override static disimpan sebagai arsip:
  - `public/nexia-viewer-overrides.css`
- File override tidak lagi diload oleh `public/index.html`.
- Viewer kembali memakai bundle OHIF bawaan supaya stabil.
