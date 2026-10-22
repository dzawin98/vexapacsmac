# VEXA SIMRS DB Bridge

Service ini adalah opsi integrasi SIMRS selain REST API. SIMRS dapat menulis order ke database tengah, lalu VEXA membaca `test_orderin` dan mengirim hasil balik ke database tengah `test_orderout`.

Database internal medical record tidak memiliki satu standar vendor. Bridge mendukung PostgreSQL, MySQL, MariaDB, dan Microsoft SQL Server. Satu instalasi rumah sakit memilih satu adaptor database aktif, lalu datanya dinormalisasi ke API Order In yang sama agar pembuatan pasien, order RIS, MWL, deduplikasi, retry, dan audit tetap konsisten.

Standar interoperabilitas yang perlu dipakai di atas konektor database adalah HL7 v2/FHIR untuk pertukaran data klinis dan DICOM Modality Worklist untuk distribusi order ke modality. Konektor database adalah pilihan kompatibilitas untuk sistem lama atau staging vendor, bukan pengganti standar tersebut.

## Test Database

Default database testing:

- Database: `ris` (database tengah RIS)
- Order input table: `test_orderin`
- Order output table: `test_orderout`

Jalankan:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\VELOPACS-RIS\tools\simrs-db-bridge\scripts\setup-postgres-test-db.ps1" -Password "velo"
```

Jika PostgreSQL memakai password lain, ganti parameter `-Password`.

## Configuration

Konfigurasi berada di:

```text
D:\VELOPACS-RIS\RIS\backend\settings.json
```

Bagian:

```json
{
  "simrsDbBridge": {
    "enabled": false,
    "mode": "api-and-db",
    "pollIntervalMs": 15000,
    "batchSize": 50,
    "risApi": {
      "baseUrl": "http://127.0.0.1:3001/api",
      "apiKey": "GANTI_DENGAN_SECRET_KEY"
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

Konfigurasi lama `postgres` tetap didukung. Untuk instalasi baru atau beberapa sumber sekaligus, gunakan `connectors`:

```json
{
  "simrsDbBridge": {
    "enabled": true,
    "mode": "api-and-db",
    "pollIntervalMs": 5000,
    "batchSize": 50,
    "connectors": [
      {
        "id": "his-main",
        "name": "Hospital HIS",
        "enabled": true,
        "driver": "sqlserver",
        "orderIn": {
          "enabled": true,
          "table": "dbo.radiology_order",
          "db": {
            "host": "127.0.0.1",
            "port": 1433,
            "database": "HIS",
            "user": "vexa_bridge",
            "password": "SECRET",
            "encrypt": true,
            "trustServerCertificate": false
          },
          "columnMap": {
            "no_rm": "medical_record_no",
            "no_rontgen": "accession_no",
            "nama_pasien": "patient_name"
          }
        },
        "orderOut": {
          "enabled": false,
          "table": "dbo.radiology_result"
        }
      }
    ]
  }
}
```

Nilai `driver`: `postgresql`, `mysql`, `mariadb`, atau `sqlserver`. Gunakan akun database khusus dengan hak minimum: baca tabel staging Order In dan tulis tabel staging Order Out saja. Aktifkan TLS/enkripsi pada koneksi produksi.

`ackInternalAfterPush: false` berarti bridge hanya menyalin `order_out` RIS ke `ris.test_orderout`, tanpa otomatis mengubah status internal RIS menjadi `Y`. Ini cocok untuk database tengah karena SIMRS masih perlu membaca/menentukan ACK sendiri.

## Manual Test

Install dependency:

```powershell
cd "D:\VELOPACS-RIS\tools\simrs-db-bridge"
npm install --no-audit --no-fund
```

Jalankan satu kali:

```powershell
$env:SIMRS_DB_BRIDGE_ENABLED="true"
$env:SIMRS_API_KEY="vexapacs-simrs-local-2026"
node server.js --once
```

Jalankan service HTTP:

```powershell
node server.js
```

Endpoint lokal:

- `GET http://127.0.0.1:3109/health`
- `GET http://127.0.0.1:3109/status`
- `GET http://127.0.0.1:3109/drivers`
- `POST http://127.0.0.1:3109/test-connection`
- `POST http://127.0.0.1:3109/sync`

Endpoint `status` menyamarkan password, API key, dan connection string.

## Verify Data Masuk RIS Asli

Pastikan RIS backend aktif di `http://127.0.0.1:3001`, lalu jalankan sync satu kali:

```powershell
cd "D:\VELOPACS-RIS\tools\simrs-db-bridge"
$env:SIMRS_DB_BRIDGE_ENABLED="true"
$env:SIMRS_API_KEY="vexapacs-simrs-local-2026"
node server.js --once
```

Jika berhasil, output berisi:

```json
{
  "ok": true,
  "pulledOrderIn": 2,
  "pushedOrderOut": 0
}
```

Cek database tengah:

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:PGPASSWORD="velo"
& $psql -h 127.0.0.1 -p 5432 -U postgres -d ris -c "select no_rontgen,nama_pasien,modality,sync_status,sync_message from test_orderin order by id;"
```

Baris yang sukses akan berubah dari `sync_status = N` menjadi `Y`.

Cek database RIS asli:

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:PGPASSWORD="velo"
& $psql -h 127.0.0.1 -p 5432 -U postgres -d veloris_db -c "select no_rontgen,nama_pasien,modality,update_ris from order_in where no_rontgen in ('DB2DB-DX-001','DB2DB-CT-001') order by no_rontgen;"
& $psql -h 127.0.0.1 -p 5432 -U postgres -d veloris_db -c "select accession_number,modality,status from mwl_orders where accession_number in ('DB2DB-DX-001','DB2DB-CT-001') order by accession_number;"
```

Kalau dua query di `veloris_db` menampilkan data, berarti order dari database tengah sudah benar-benar masuk ke order RIS asli dan MWL.
