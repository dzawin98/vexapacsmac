# SIMRS Integration API

Dokumentasi ini menjelaskan API yang digunakan SIMRS untuk mengirim order radiologi ke RIS/PACS dan mengambil hasil kembali dari `order_out`.

## Base URL

```text
http://localhost:8080/api
```

Sesuaikan host/port dengan environment server produksi.

## Authentication & Headers

Endpoint SIMRS wajib menggunakan API key melalui header `x-api-key`.

```http
Content-Type: application/json
x-api-key: 11110000test
```

Setting production paling mudah berada di:

```text
C:\Program Files\VEXAPACS-RIS\RIS\backend\settings.json
```

```json
{
  "simrsApi": {
    "apiKey": "GANTI_DENGAN_SECRET_KEY_PANJANG",
    "allowedIps": ["127.0.0.1", "192.168.1.10"],
    "username": "simrs-integration",
    "role": "administrator"
  }
}
```

Catatan:
- Gunakan URL `http://127.0.0.1:8080`, bukan `http://localhost:8080`, jika whitelist IP diset `127.0.0.1`.
- `username` dan `role` dipakai internal backend untuk permission/audit.
- Untuk produksi, ganti `SIMRS_API_KEY` dengan key panjang dan rahasia.
- Environment variable `SIMRS_API_KEY`, `SIMRS_ALLOWED_IPS`, `SIMRS_API_ROLE`, dan `SIMRS_API_USERNAME` tetap didukung sebagai override opsional.
- Setelah mengubah `settings.json`, restart `VexaRISBackend`.

## Integration Flow

```text
1. SIMRS membuat order radiologi
2. SIMRS POST /simrs/order-in
3. Sistem mengisi order_in, patients, dan mwl_orders
4. Technologist validasi/publish MWL bila workflow memakai approval manual
5. Modality query MWL dan melakukan pemeriksaan
6. Radiologist membuat/finalize report
7. Sistem membuat atau memperbarui order_out
8. SIMRS GET /simrs/order-out?update_ris=N
9. SIMRS menyimpan hasil ke database SIMRS
10. SIMRS PATCH /simrs/order-out/{no_rontgen}/ack
```

## Status `update_ris`

Field `update_ris` digunakan sebagai status sinkronisasi antar sistem.

| Value | Meaning |
|---|---|
| `N` | Belum diproses/ditarik SIMRS |
| `Y` | Sudah berhasil diproses SIMRS |
| `C` | Cancelled/canceled |

## Date Format

Gunakan format berikut:

```text
YYYY-MM-DD
YYYY-MM-DD HH:mm:ss
```

Contoh:

```text
2026-05-07
2026-05-07 14:30:00
```

## Error Format

Error response umum:

```json
{
  "error": "message"
}
```

Status code umum:

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created/processed |
| `400` | Invalid payload |
| `403` | Forbidden / role tidak punya permission |
| `404` | Data tidak ditemukan |
| `409` | Duplicate accession/no_rontgen |
| `500` | Internal server error |

---

# Order In API

`order_in` adalah data order masuk dari SIMRS. Setelah order masuk, sistem juga menyinkronkan data ke `patients` dan `mwl_orders` agar bisa masuk workflow MWL.

## 1. Create/Update Order In

```http
POST /api/simrs/order-in
```

Endpoint ini bersifat upsert berdasarkan `no_rontgen` / `accession_number`.

### Required Fields

| Field | Type | Description |
|---|---|---|
| `no_rm` | string | Nomor rekam medis pasien |
| `nama_pasien` | string | Nama pasien |
| `tanggal_lahir` | date | Tanggal lahir pasien |
| `modality` | string | Modality, contoh `CR`, `CT`, `MR`, `US` |
| `nama_pemeriksaan` | string | Nama pemeriksaan |
| `klinis` | string | Keterangan klinis |
| `no_rontgen` atau `accession_number` | string | Nomor order radiologi/accession, harus unik |

### Optional Fields

| Field | Description |
|---|---|
| `tanggal_order` | Tanggal order dibuat |
| `tanggal_aktivasi` | Tanggal order aktif |
| `kelamin` | `M`, `F`, atau format yang bisa dinormalisasi |
| `alamat` | Alamat pasien |
| `kecamatan` | Kecamatan |
| `kabupaten` | Kabupaten |
| `provinsi` | Provinsi |
| `kode_pos` | Kode pos |
| `no_hp` | Nomor HP pasien, dipakai untuk auto-fill WhatsApp Distribution |
| `no_register` | Nomor registrasi kunjungan |
| `diagnosa` | Diagnosa klinis |
| `kode_pemeriksaan` / `procedure_code` | Kode master pemeriksaan |
| `cito` | Flag cito |
| `polirawat` / `rawatinap` | Poli/rawat inap |
| `kode_ruangan` | Kode ruangan |
| `nama_ruangan` | Nama ruangan |
| `kode_dokter` | Kode dokter pengirim |
| `nama_dokter` | Nama dokter pengirim |
| `kode_dokter_radiolog` | Kode radiologist tujuan |
| `nama_radiolog` | Nama radiologist tujuan |
| `cara_bayar` | Cara bayar |
| `kode_asuransi` | Kode asuransi |
| `nama_asuransi` | Nama asuransi |
| `kode_instalasi_radiologi` | Kode instalasi radiologi |
| `nama_instalasi_radiologi` | Nama instalasi radiologi |
| `update_ris` | Default `N` |

### Example Request

```http
POST /api/simrs/order-in
Content-Type: application/json
x-api-key: 11110000test
```

```json
{
  "tanggal_order": "2026-05-07 09:15:00",
  "no_rm": "123456",
  "nama_pasien": "BUDI SANTOSO",
  "tanggal_lahir": "1980-01-20",
  "kelamin": "M",
  "no_hp": "628123456789",
  "no_register": "REG-20260507-001",
  "no_rontgen": "RAD-20260507-001",
  "klinis": "Nyeri dada",
  "diagnosa": "Chest pain",
  "kode_pemeriksaan": "XR-CHEST",
  "nama_pemeriksaan": "Thorax PA",
  "modality": "CR",
  "cito": "0",
  "kode_dokter": "D001",
  "nama_dokter": "dr. Pengirim",
  "update_ris": "N"
}
```

### Example Response

```json
{
  "message": "SIMRS order-in berhasil diproses",
  "source": "order_in",
  "order_in": {
    "id": 12,
    "no_rm": "123456",
    "no_rontgen": "RAD-20260507-001",
    "nama_pasien": "BUDI SANTOSO",
    "modality": "CR",
    "update_ris": "N"
  },
  "mwl_order": {
    "id": 44,
    "accession_number": "RAD-20260507-001",
    "status": "PENDING"
  }
}
```

## 2. List Order In

```http
GET /api/simrs/order-in
```

### Query Parameters

| Parameter | Description |
|---|---|
| `q` | Search by `no_rm`, `nama_pasien`, `no_register`, atau `no_rontgen` |
| `update_ris` | Filter `N`, `Y`, atau `C` |

### Example

```http
GET /api/simrs/order-in?q=BUDI&update_ris=N
```

### Response

```json
[
  {
    "id": 12,
    "no_rm": "123456",
    "nama_pasien": "BUDI SANTOSO",
    "no_rontgen": "RAD-20260507-001",
    "update_ris": "N"
  }
]
```

## 3. Get Order In Detail

```http
GET /api/simrs/order-in/{no_rontgen}
```

### Example

```http
GET /api/simrs/order-in/RAD-20260507-001
```

## 4. Update or Cancel Order In

```http
PATCH /api/simrs/order-in/{no_rontgen}
```

Endpoint ini dapat memperbarui data order. Jika order dibatalkan, sistem juga akan mengubah status `mwl_orders` menjadi `CANCELLED`.

### Update Example

```json
{
  "klinis": "Nyeri dada sejak pagi",
  "nama_pemeriksaan": "Thorax AP/PA",
  "modality": "CR",
  "update_ris": "N"
}
```

### Cancel Example

```json
{
  "status": "CANCELLED",
  "alasan": "Order dibatalkan dari SIMRS"
}
```

### Response

```json
{
  "message": "SIMRS order-in berhasil dibatalkan",
  "order_in": {
    "no_rontgen": "RAD-20260507-001",
    "update_ris": "C",
    "alasan": "Order dibatalkan dari SIMRS"
  },
  "mwl_order_id": 44
}
```

---

# Order Out API

`order_out` adalah data hasil yang bisa ditarik SIMRS setelah pemeriksaan/report selesai.

## 1. Generate/Refresh Order Out

```http
POST /api/simrs/order-out
```

Endpoint ini membuat atau memperbarui `order_out` berdasarkan `no_rontgen`. Data hasil disusun dari `mwl_orders`, `order_in`, `radiology_reports`, dan link viewer/share.

### Required Fields

| Field | Type | Description |
|---|---|---|
| `no_rontgen` | string | Nomor order radiologi/accession |

### Optional Fields

| Field | Description |
|---|---|
| `update_ris` | `N`, `Y`, atau `C`; default `N` |
| `alasan` | Alasan atau catatan |
| `kritis` | Flag kritis |
| `kode_user_admin` | Kode admin |
| `nama_user_admin` | Nama admin |
| `kode_radiografer` | Kode radiographer |
| `nama_radiografer` | Nama radiographer |
| `kode_radiolog` | Kode radiologist |
| `nama_radiolog` | Nama radiologist |
| `expertise_text_finding` | Override finding text |
| `expertise_text_conclusion` | Override conclusion text |
| `expertise_html_finding` | Override finding HTML |
| `expertise_html_conclusion` | Override conclusion HTML |
| `urllink3` - `urllink6` | Link tambahan |

### Example

```json
{
  "no_rontgen": "RAD-20260507-001",
  "update_ris": "N"
}
```

### Response

```json
{
  "message": "Order out berhasil diproses",
  "source": {
    "order_id": 44,
    "study_instance_uid": "1.2.826.0.1.3680043...",
    "report_status": "FINALIZED"
  },
  "order_out": {
    "no_rm": "123456",
    "no_rontgen": "RAD-20260507-001",
    "expertise_text_finding": "Tidak tampak infiltrat...",
    "expertise_text_conclusion": "Cor dan pulmo dalam batas normal.",
    "urllink1": "http://...",
    "urllink2": "http://...",
    "update_ris": "N"
  }
}
```

## 2. List/Pull Order Out

```http
GET /api/simrs/order-out
```

Endpoint ini dipakai SIMRS untuk menarik hasil, biasanya dengan filter `update_ris=N`.

### Query Parameters

| Parameter | Description |
|---|---|
| `q` | Search by `no_rm`, `no_register`, `no_rontgen`, `nama_radiolog`, atau `nama_radiografer` |
| `update_ris` | `N`, `Y`, `C`, atau `ALL` |
| `no_rontgen` | Filter nomor order tertentu |
| `no_rm` | Filter pasien tertentu |
| `date_from` / `from` | Filter `waktu_update_orderout >= value` |
| `date_to` / `to` | Filter `waktu_update_orderout <= value` |
| `page` | Default `1` |
| `limit` / `rows` | Default `100`, max `500` |

### Example

```http
GET /api/simrs/order-out?update_ris=N&page=1&limit=100
```

### Response

```json
{
  "rows": [
    {
      "id": 5,
      "no_rm": "123456",
      "no_rontgen": "RAD-20260507-001",
      "no_register": "REG-20260507-001",
      "nama_radiolog": "dr. Radiolog",
      "expertise_text_finding": "Tidak tampak infiltrat...",
      "expertise_text_conclusion": "Cor dan pulmo dalam batas normal.",
      "urllink1": "http://...",
      "urllink2": "http://...",
      "update_ris": "N",
      "waktu_update_orderout": "2026-05-07T10:15:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 100
}
```

## 3. Get Order Out Detail

```http
GET /api/simrs/order-out/{no_rontgen}
```

### Example

```http
GET /api/simrs/order-out/RAD-20260507-001
```

## 4. Acknowledge Order Out

```http
PATCH /api/simrs/order-out/{no_rontgen}/ack
```

Dipakai setelah SIMRS berhasil menyimpan hasil. Biasanya set `update_ris` menjadi `Y`.

### Example Request

```json
{
  "update_ris": "Y",
  "alasan": "Hasil sudah masuk SIMRS"
}
```

### Example Response

```json
{
  "message": "SIMRS order-out acknowledgement berhasil disimpan",
  "order_out": {
    "no_rontgen": "RAD-20260507-001",
    "update_ris": "Y",
    "alasan": "Hasil sudah masuk SIMRS"
  }
}
```

---

# Recommended SIMRS Polling Logic

SIMRS disarankan melakukan polling hasil seperti ini:

```text
1. GET /api/simrs/order-out?update_ris=N&page=1&limit=100
2. Simpan setiap row ke database SIMRS
3. Jika sukses per row:
   PATCH /api/simrs/order-out/{no_rontgen}/ack
4. Jika gagal:
   Jangan ACK dulu, agar hasil tetap muncul di pull berikutnya
```

## Important Notes

- `no_rontgen` adalah identifier utama antara SIMRS, RIS, MWL, dan `order_out`.
- `no_rontgen` juga dipakai sebagai `accession_number`.
- Jika `kode_pemeriksaan` dikirim, backend akan memvalidasi ke master study.
- Jika `kode_dokter` atau `kode_dokter_radiolog` dikirim, backend akan memvalidasi ke master doctor.
- Field `no_hp` dari `order_in` digunakan untuk auto-fill Patient WhatsApp Number pada dialog Distribution.
- Order yang dikirim ke `order_in` belum tentu langsung tampil di modality jika workflow rumah sakit memakai validasi/publish manual oleh Technologist.

## Order Out Link Mapping

`urllink1` sampai `urllink6` dikonfigurasi melalui **Vexa System Utility > System Settings > RIS & Facility > SIMRS Viewer Links**. File konfigurasi berikut tetap menjadi sumber konfigurasi backend dan tidak perlu diedit manual:

```text
C:\Program Files\VEXAPACS-RIS\RIS\backend\settings.json
```

Bagian konfigurasi:

```json
{
  "orderOutLinks": {
    "urllink1": {
      "enabled": true,
      "type": "viewer",
      "viewerId": "vexa-pacs",
      "role": "clinician",
      "label": "Desktop Viewer Clinician",
      "launchUser": {
        "externalUserId": "simrs",
        "username": "simrs",
        "password": "simrs",
        "fullName": "SIMRS Clinician",
        "role": "clinician"
      }
    },
    "urllink2": {
      "enabled": true,
      "type": "viewer",
      "viewerId": "vexa-mobile",
      "role": "clinician",
      "label": "Mobile Viewer Clinician",
      "launchUser": {
        "externalUserId": "simrs",
        "username": "simrs",
        "password": "simrs",
        "fullName": "SIMRS Clinician",
        "role": "clinician"
      }
    },
    "urllink3": {
      "enabled": true,
      "type": "publicStudy",
      "label": "Patient Public Study"
    },
    "urllink4": {
      "enabled": true,
      "type": "viewer",
      "viewerId": "ecg-viewer",
      "role": "clinician",
      "label": "ECG Viewer Clinician",
      "onlyForModalities": ["ECG"]
    },
    "urllink5": { "enabled": false, "type": "none" },
    "urllink6": { "enabled": false, "type": "none" }
  }
}
```

Default production mapping:

| Field | Isi |
|---|---|
| `urllink1` | Desktop Viewer dengan role `clinician` |
| `urllink2` | Mobile Viewer dengan role `clinician` |
| `urllink3` | Public Study untuk pasien |
| `urllink4` | ECG Viewer dengan role `clinician`, default hanya modality `ECG` |
| `urllink5` | Off |
| `urllink6` | Off |

Contoh hasil link viewer:

```text
http://server/viewer/token/<token>?viewer=vexa-pacs&role=clinician
http://server/viewer/token/<token>?viewer=vexa-mobile&role=clinician
```

Untuk `type: "viewer"`, akun pada **Integration Username** dan **Integration Password** menentukan akun yang dipakai saat link dibuka dari SIMRS. Akun yang sama wajib dibuat dan diaktifkan melalui Access Management pada viewer tujuan. Role dan seluruh permission diambil dari akun lokal viewer tersebut; nilai role pada payload integrasi tidak dapat menaikkan permission viewer.

Domain atau IP pada seluruh link berasal dari **Public Domain / IP Address** di Utility. Contohnya `https://pacs.rumahsakit.id`. Username dan password tidak pernah dimasukkan ke `urllink`; link hanya membawa token akses acak dengan masa berlaku terbatas.

Setelah menekan **Apply + Restart** di Utility, service backend terkait akan dijalankan ulang otomatis. Jika konfigurasi diubah manual, restart service:

```powershell
Restart-Service VexaRISBackend
```

## Quick Curl Examples

Create order-in:

```bash
curl -X POST "http://SERVER-IP/api/simrs/order-in" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_SECRET_KEY" \
  -d "{\"no_rm\":\"123456\",\"nama_pasien\":\"BUDI SANTOSO\",\"tanggal_lahir\":\"1980-01-20\",\"kelamin\":\"M\",\"no_register\":\"REG-001\",\"no_rontgen\":\"RAD-001\",\"klinis\":\"Nyeri dada\",\"diagnosa\":\"Chest pain\",\"kode_pemeriksaan\":\"XR-CHEST\",\"nama_pemeriksaan\":\"Thorax PA\",\"modality\":\"CR\",\"kode_dokter\":\"D001\",\"nama_dokter\":\"dr. Pengirim\"}"
```

Pull hasil order-out yang belum diambil SIMRS:

```bash
curl "http://SERVER-IP/api/simrs/order-out?update_ris=N&page=1&limit=100" \
  -H "x-api-key: YOUR_SECRET_KEY"
```

ACK hasil setelah sukses disimpan SIMRS:

```bash
curl -X PATCH "http://SERVER-IP/api/simrs/order-out/RAD-001/ack" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_SECRET_KEY" \
  -d "{\"update_ris\":\"Y\",\"alasan\":\"Hasil sudah diterima SIMRS\"}"
```

---

# DB-to-DB Integration Option

Selain REST API, sistem juga mendukung pola integrasi database tengah melalui service `Vexa SIMRS DB Bridge`.

Pilihan integrasi:

| Method | Kapan dipakai |
|---|---|
| REST API | SIMRS bisa HTTP POST/GET/PATCH langsung ke VEXA |
| DB-to-DB Bridge | SIMRS hanya bisa CRUD ke database tengah |

Pada mode DB-to-DB, SIMRS tidak menulis langsung ke database internal RIS. SIMRS menulis ke database tengah, lalu bridge akan melakukan sinkronisasi ke API internal VEXA. Ini lebih aman karena validasi, workflow MWL, order out link, dan audit tetap lewat sistem VEXA.

## PostgreSQL Test Databases

Default database testing:

```text
Database: ris
Order input table: test_orderin
Order output table: test_orderout
```

Setup database dan sample data:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\VELOPACS-RIS\tools\simrs-db-bridge\scripts\setup-postgres-test-db.ps1" -Password "velo"
```

## Bridge Configuration

Konfigurasi ada di:

```text
D:\VELOPACS-RIS\RIS\backend\settings.json
```

Bagian konfigurasi:

```json
{
  "simrsDbBridge": {
    "enabled": false,
    "mode": "api-and-db",
    "pollIntervalMs": 15000,
    "batchSize": 50,
    "risApi": {
      "baseUrl": "http://127.0.0.1:3001/api",
      "apiKey": "SAMA_DENGAN_simrsApi.apiKey"
    },
    "postgres": {
      "orderIn": {
        "enabled": true,
        "table": "test_orderin",
        "db": {
          "host": "127.0.0.1",
          "port": 5432,
          "database": "ris",
          "user": "postgres",
          "password": "velo"
        }
      },
      "orderOut": {
        "enabled": true,
        "table": "test_orderout",
        "updateRisFilter": "N",
        "ackInternalAfterPush": false,
        "db": {
          "host": "127.0.0.1",
          "port": 5432,
          "database": "ris",
          "user": "postgres",
          "password": "velo"
        }
      }
    }
  }
}
```

Untuk mengaktifkan:

1. Isi `simrsApi.apiKey`.
2. Isi `simrsDbBridge.risApi.apiKey` dengan key yang sama.
3. Set `simrsDbBridge.enabled` menjadi `true`.
4. Jalankan bridge.

Manual test:

```powershell
cd "D:\VELOPACS-RIS\tools\simrs-db-bridge"
npm install --no-audit --no-fund
$env:SIMRS_DB_BRIDGE_ENABLED="true"
$env:SIMRS_API_KEY="vexapacs-simrs-local-2026"
node server.js --once
```

Service mode:

```powershell
node server.js
```

Endpoint status bridge:

```text
GET  http://127.0.0.1:3109/health
GET  http://127.0.0.1:3109/status
POST http://127.0.0.1:3109/sync
```

## DB-to-DB Flow

```text
SIMRS insert/update ris.test_orderin
Bridge membaca test_orderin dengan sync_status = N atau U
Bridge POST ke /api/simrs/order-in
Jika sukses, bridge set test_orderin.sync_status = Y
Jika gagal, bridge set test_orderin.sync_status = E dan isi sync_message

VEXA membuat order_out saat report/hasil siap
Bridge GET /api/simrs/order-out?update_ris=N
Bridge upsert ke ris.test_orderout
SIMRS membaca ris.test_orderout
```

Default `ackInternalAfterPush` adalah `false`, jadi bridge tidak otomatis mengubah `veloris_db.order_out.update_ris` menjadi `Y`. Ini membuat `ris.test_orderout` tetap mengikuti perubahan terbaru dari RIS sampai ada mekanisme ACK SIMRS yang memang diaktifkan.

## Verify DB-to-DB Order In Masuk Ke RIS Asli

1. Pastikan RIS backend berjalan di `http://127.0.0.1:3001`.
2. Pastikan `SIMRS_API_KEY` sama dengan API key backend.
3. Jalankan bridge satu kali:

```powershell
cd "D:\VELOPACS-RIS\tools\simrs-db-bridge"
$env:SIMRS_DB_BRIDGE_ENABLED="true"
$env:SIMRS_API_KEY="vexapacs-simrs-local-2026"
node server.js --once
```

Jika sukses, output kira-kira:

```json
{
  "ok": true,
  "pulledOrderIn": 2,
  "pushedOrderOut": 0
}
```

Cek status database tengah:

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:PGPASSWORD="velo"
& $psql -h 127.0.0.1 -p 5432 -U postgres -d ris -c "select no_rontgen,nama_pasien,modality,sync_status,sync_message from test_orderin order by id;"
```

Cek database RIS asli:

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:PGPASSWORD="velo"
& $psql -h 127.0.0.1 -p 5432 -U postgres -d veloris_db -c "select no_rontgen,nama_pasien,modality,update_ris from order_in where no_rontgen in ('DB2DB-DX-001','DB2DB-CT-001') order by no_rontgen;"
& $psql -h 127.0.0.1 -p 5432 -U postgres -d veloris_db -c "select accession_number,modality,status from mwl_orders where accession_number in ('DB2DB-DX-001','DB2DB-CT-001') order by accession_number;"
```

Jika data muncul di `veloris_db.order_in` dan `veloris_db.mwl_orders`, maka data dari database tengah sudah masuk ke RIS asli.
