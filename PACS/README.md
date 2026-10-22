# dicomweb-pacs

An easy to use PACS with DICOMWEB and DIMSE service support.

## Description

- A Node.js PACS service with DICOMWEB (QIDO-RS and WADO-RS) and DIMSE support.
- Comes preinstalled with the popular [OHIF DICOM Web Viewer](https://github.com/OHIF/Viewers) (version 3.10.1).
- Supports OHIF MPR (vtk.js) for volumetric datasets.
- Uses a TypeScript codebase and a modular structure similar to `dicomweb-proxy`.

No need for a server, try the [standalone desktop edition](https://github.com/knopkem/pacsnode).

## Prerequisite

- A modern Node.js runtime.

## Setup Instructions - npm

- Install in an empty directory:
  ```bash
  npm init -y
  npm install dicomweb-pacs
  ```
- Update the config file in `./node_modules/dicomweb-pacs/config/default.json`.
- Start the PACS:
  ```bash
  npx dicomweb-pacs
  ```

## Setup Instructions - source

- Clone the repository and install dependencies:
  ```bash
  npm install
  ```
- Update `./config/default.json`.
- Start the development server:
  ```bash
  npm start
  ```
- Build the production bundle:
  ```bash
  npm run build
  node build/app.js
  ```
- Import DICOM images with any C-STORE-SCU to the internal store-SCP:
  ```text
  AET: DICOMWEB_PACS   port: 8888
  ```
- Or, while the PACS is running, put DICOM files into `./import` and run:
  ```bash
  npm run import
  ```
  This sends the files through the local store-SCP so they are indexed for DIMSE C-FIND as well.
- The external PACS AE can expose combined DIMSE services on one listener when started through the local launcher:
  ```text
  AET: NEXIA   port: 5757
  ```
  This front AE supports `C-ECHO`, `C-STORE`, Study Root `C-FIND`, Study Root `C-MOVE`, and Study Root `C-GET`.
  Query/retrieve callers must match an enabled DICOM Node by calling AE Title and remote IP address.
  `C-MOVE` destinations are resolved from the enabled DICOM Nodes configured in the RIS database.
- Open the viewer at `http://localhost:5001`.

## What to modify

- Change the PACS AET or DIMSE port in `config/default.json`:
  ```json
  {
    "source": {
      "aet": "OUR_AET",
      "ip": "OUR_IP",
      "port": "OUR_PORT"
    }
  }
  ```
- Add peers:
  ```json
  {
    "peers": [
      {
        "aet": "PEER_AET",
        "ip": "PEER_IP",
        "port": "PEER_PORT"
      }
    ]
  }
  ```
- Update the HTTP listener:
  ```json
  {
    "httpPort": 5001,
    "httpIp": "0.0.0.0"
  }
  ```

## DIMSE outbound compression test mode

The external DIMSE listener can transcode retrieval responses without changing
the archived DICOM files. The mode is disabled by default.

```bat
set DICOMWEB_DIMSE_OUTBOUND_COMPRESSION=true
START-ALL-APPS.bat
```

When enabled, C-MOVE and C-GET prefer these transfer syntaxes in order:

1. JPEG 2000 Lossless (`1.2.840.10008.1.2.4.90`)
2. JPEG Lossless Process 14 SV1 (`1.2.840.10008.1.2.4.70`) when the source can
   be passed through without transcoding
3. Explicit VR Little Endian (`1.2.840.10008.1.2.1`)

Set the flag to `false` and restart the PACS services to disable the test mode.
The DIMSE log records the negotiated syntax, pixel byte counts, compression
ratio, and preparation time for each outbound instance.

## DIMSE storage compression

New C-STORE instances are archived as JPEG 2000 Lossless by default:

```bat
set DICOMWEB_DIMSE_STORAGE_COMPRESSION=true
set DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX=1.2.840.10008.1.2.4.90
```

This changes only newly received instances. Existing studies are not migrated
automatically. Disable it with `false` to store the transfer syntax received
from the modality. If the internal transcoding C-STORE fails, the external
listener attempts the same lossless recipe for direct storage and safely falls
back to the received original instance when the selected codec is unavailable.

Supported storage recipes:

- JPEG 2000 Lossless (`1.2.840.10008.1.2.4.90`) - recommended balance between
  storage size and ingest cost.
- JPEG-LS Lossless (`1.2.840.10008.1.2.4.80`) - lower ingest CPU cost where
  faster incoming C-STORE is preferred.
- Compression disabled - preserve the transfer syntax received from the
  modality.

Both compression recipes are lossless. Decoded pixel values remain identical;
no lossy quality level is exposed for diagnostic archive storage.

## License

MIT

## Frame cache (L1 memori + L2 disk, dibagi ke semua client)

Cache frame menyimpan respons `frames/:frame`, `raw`, `thumb`, dan `rendered` supaya
pembukaan gambar TIDAK mengulang baca file + decode + re-encode JPEG2000 setiap kali.

- **L1** = memori proses (`memorySizeMb`, default dari `DICOMWEB_FRAME_CACHE_MB`).
- **L2** = disk, **bertahan lintas restart** dan dipakai bersama semua client/device.
  Inilah yang membuat dokter lain di device lain (atau pasien yang sama dibuka
  beberapa hari kemudian) tetap cepat: cukup 1x dihitung, sesudahnya dibaca dari disk.
- Invalidasi otomatis bila file sumber berubah (ukuran/mtime berbeda).

| Env | Default | Arti |
| --- | --- | --- |
| `DICOMWEB_FRAME_CACHE_MB` | 256 | ukuran cache L1 (memori) |
| `DICOMWEB_FRAME_DISK_CACHE_ENABLED` | true | aktif/nonaktif L2 |
| `DICOMWEB_FRAME_DISK_CACHE_DIR` | `<storage>/../frame-cache` | lokasi L2 |
| `DICOMWEB_FRAME_DISK_CACHE_MB` | 8192 | batas ukuran L2 (LRU) |
| `DICOMWEB_FRAME_DISK_CACHE_DAYS` | 14 | umur maksimum entry L2 (hari) |
| `DICOMWEB_FRAME_DISK_CACHE_MAX_ENTRY_MB` | 64 | entry lebih besar dari ini tidak ditulis ke L2 |
| `DICOMWEB_FRAME_STATS_INTERVAL_S` | 900 | interval ringkasan log hit/miss (0 = mati) |
| `DICOMWEB_FRAME_WARM_ENABLED` | true | warm otomatis saat studi baru masuk |
| `DICOMWEB_FRAME_WARM_QUIET_MS` | 6000 | tunggu transfer selesai sebelum warm |
| `DICOMWEB_FRAME_WARM_MAX_INSTANCES` | 24 | instance per studi yang di-warm |
| `DICOMWEB_FRAME_WARM_PREVIEW_ROWS` / `_COLUMNS` | 512 | ukuran preview yang di-warm |
| `DICOMWEB_FRAME_WARM_PREVIEW_QUALITY` | 70 | kualitas JPEG preview |
| `DICOMWEB_FRAME_WARM_THUMBNAIL` | true | warm thumbnail (filmstrip) |
| `DICOMWEB_FRAME_WARM_RAW` | false | ikut warm frame raw (butuh disk lebih besar) |
| `DICOMWEB_FRAME_WARM_WATCH` | true | pantau folder storage untuk studi baru |

### Warm saat studi baru masuk

Setiap file baru di folder storage memicu warm otomatis (thumbnail + preview) setelah
transfer tenang selama `DICOMWEB_FRAME_WARM_QUIET_MS`. Jadi pembukaan pertama oleh
radiolog - perangkat mana pun - sudah hangat, tanpa menunggu ada yang membuka duluan.

### Warm massal untuk studi yang sudah ada

```bash
npm run warm-cache -- --days=14 --limit=0 --max-instances=24
```

Jalankan sekali saat pertama kali mengaktifkan cache, supaya studi yang sudah masuk ikut hangat.

### Melihat statistik

`GET /api/system/performance` -> `wadoRs.frameResponseCache` (L1), `wadoRs.frameDiskCache` (L2: bytes,
l1Hits, l2Hits, misses, promotions, hitRate, evictions, expired), dan `frameWarm` (jumlah yang di-warm).

### Catatan operasional

- L2 hanya menyimpan frame yang **pernah dibuka** atau **di-warm** - bukan seluruh arsip.
  Perkiraan: thumbnail ~7 KB + preview ~17 KB per instance; `WARM_RAW=true` = perlu ruang sebesar
  volume studi yang di-warm (rata-rata ~76 MB/studi pada data uji).
- Decode JPEG2000 di sisi server memakai Python (`openjpeg`). Bila modul itu tidak tersedia,
  permintaan `rendered` mengembalikan HTTP 500 (server tetap hidup) - pastikan environment PACS memilikinya.
