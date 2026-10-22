# NEXIA MWL SCP

Service ini menerima DICOM Modality Worklist `C-FIND` dari modality dan mengekspos detail query ke RIS.

Service ini adalah jalur resmi MWL. PACS DIMSE/storage tetap berjalan terpisah, jadi jangan arahkan modality MWL ke port PACS.

## Konfigurasi

Konfigurasi dibaca dari `backend/.env`.

```env
MWL_SCP_AET=NEXIARIS
MWL_SCP_BIND=0.0.0.0
MWL_SCP_PORT=5656
MWL_SCP_MAX_RESULTS=100
MWL_SCP_CHARACTER_SET=ISO_IR 192
MWL_SCP_FILTER_BY_CALLING_AE=false
MWL_SCP_INTERNAL_KEY=nexia-mwl-scp-local
```

Endpoint yang dipakai:

- Worklist source: `DICOMWEB_PACS_ROOT/mwl/worklists`
- Query log sink: `RIS_BACKEND_ROOT/api/internal/mwl/query-log`

## Jalankan Development

Dari folder `RIS\frontend`:

```bat
run-mwl-scp.bat
```

Atau jalankan semua:

```bat
run-dev.bat
```

## Setting Modality

Gunakan konfigurasi terpisah dari PACS storage:

```text
Worklist AE Title : NEXIARIS
Worklist IP       : IP server RIS/PACS
Worklist Port     : 5656
```

Jika `5656` sudah dipakai aplikasi lain, misalnya viewer/tool DICOM yang sedang membuka listener lokal, `run-mwl-scp.bat` akan menampilkan PID dan nama proses pemilik port. Tutup proses tersebut atau ubah `MWL_SCP_PORT` di `backend/.env`, lalu arahkan modality ke port yang sama.

PACS storage tetap memakai service DIMSE PACS yang sudah ada, misalnya:

```text
Storage AE Title : NEXIA
Storage Port     : 5757
```

## Logging

Setiap query modality akan masuk ke tabel `mwl_query_logs` dan tampil di halaman MWL Status. Data yang dicatat:

- Calling AE Title
- Called AE Title
- Remote IP/port
- Patient ID/name filter
- Accession filter
- StudyInstanceUID filter
- Modality filter
- Scheduled station AE filter
- Scheduled date/time filter
- Return keys yang diminta modality
- Jumlah match
- Worklist ID yang dikembalikan
- Error jika query gagal
