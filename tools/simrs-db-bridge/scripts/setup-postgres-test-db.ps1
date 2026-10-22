param(
  [string]$HostName = "127.0.0.1",
  [string]$Port = "5432",
  [string]$User = "postgres",
  [string]$Password = "velo",
  [string]$PostgresDatabase = "postgres",
  [string]$Database = "ris",
  [string]$OrderInTable = "test_orderin",
  [string]$OrderOutTable = "test_orderout",
  [string]$PsqlPath = ""
)

$ErrorActionPreference = 'Stop'

function Resolve-Psql {
  param([string]$Candidate)
  if ($Candidate -and (Test-Path $Candidate)) { return (Resolve-Path $Candidate).Path }
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  throw "psql.exe not found. Pass -PsqlPath or add PostgreSQL bin to PATH."
}

function Invoke-Psql {
  param(
    [string]$Database,
    [string]$Sql
  )
  $env:PGPASSWORD = $Password
  & $psql -h $HostName -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 -c $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed for database $Database with exit code $LASTEXITCODE"
  }
}

function Ensure-Database {
  param([string]$Database)
  $escaped = $Database.Replace("'", "''")
  $existsSql = "SELECT 1 FROM pg_database WHERE datname = '$escaped';"
  $env:PGPASSWORD = $Password
  $exists = & $psql -h $HostName -p $Port -U $User -d $PostgresDatabase -tAc $existsSql
  if (-not ($exists -match '1')) {
    Write-Host "[DB] Creating $Database"
    Invoke-Psql -Database $PostgresDatabase -Sql "CREATE DATABASE `"$Database`";"
  } else {
    Write-Host "[DB] $Database already exists"
  }
}

$psql = Resolve-Psql -Candidate $PsqlPath
Write-Host "[DB] Using psql: $psql"

Ensure-Database -Database $Database

function Quote-Ident {
  param([string]$Value)
  if ($Value -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "Invalid SQL identifier: $Value"
  }
  return '"' + $Value + '"'
}

$orderInTableSql = Quote-Ident -Value $OrderInTable
$orderOutTableSql = Quote-Ident -Value $OrderOutTable

$orderInSql = @"
CREATE TABLE IF NOT EXISTS $orderInTableSql (
  id BIGSERIAL PRIMARY KEY,
  tanggal_order TIMESTAMP NULL,
  tanggal_aktivasi TIMESTAMP NULL,
  no_rm VARCHAR(255),
  nama_pasien VARCHAR(255),
  tanggal_lahir DATE NULL,
  kelamin VARCHAR(1) NULL,
  alamat VARCHAR(150) NULL,
  kecamatan VARCHAR(150) NULL,
  kabupaten VARCHAR(150) NULL,
  provinsi VARCHAR(150) NULL,
  kode_pos VARCHAR(7) NULL,
  no_hp VARCHAR(20) NULL,
  no_register VARCHAR(255) NULL,
  no_rontgen VARCHAR(32) NOT NULL UNIQUE,
  klinis VARCHAR(255) NULL,
  diagnosa VARCHAR(255) NULL,
  kode_pemeriksaan VARCHAR(32) NULL,
  nama_pemeriksaan VARCHAR(100) NULL,
  modality VARCHAR(8) NULL,
  cito VARCHAR(1) NULL DEFAULT '0',
  polirawat VARCHAR(30) NULL,
  kode_ruangan VARCHAR(32) NULL,
  nama_ruangan VARCHAR(100) NULL,
  kode_dokter VARCHAR(32) NULL,
  nama_dokter VARCHAR(255) NULL,
  kode_admin VARCHAR(32) NULL,
  nama_admin VARCHAR(255) NULL,
  kode_dokter_radiolog VARCHAR(32) NULL,
  nama_radiolog VARCHAR(255) NULL,
  kode_radiografer VARCHAR(32) NULL,
  nama_radiografer VARCHAR(100) NULL,
  cara_bayar VARCHAR(30) NULL,
  kode_asuransi VARCHAR(32) NULL,
  nama_asuransi VARCHAR(255) NULL,
  kode_instalasi_radiologi VARCHAR(32) NULL,
  nama_instalasi_radiologi VARCHAR(100) NULL,
  alasan VARCHAR(255) NULL,
  waktu_update_orderin TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  update_ris VARCHAR(1) NOT NULL DEFAULT 'N',
  sync_status VARCHAR(1) NOT NULL DEFAULT 'N',
  sync_message TEXT NULL,
  synced_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_test_orderin_no_rm ON $orderInTableSql(no_rm);
CREATE INDEX IF NOT EXISTS idx_test_orderin_no_register ON $orderInTableSql(no_register);
CREATE INDEX IF NOT EXISTS idx_test_orderin_sync_status ON $orderInTableSql(sync_status);

DELETE FROM $orderInTableSql WHERE no_rontgen IN ('DB2DB-CR-001');

INSERT INTO $orderInTableSql (
  tanggal_order, tanggal_aktivasi, no_rm, nama_pasien, tanggal_lahir, kelamin, alamat,
  no_hp, no_register, no_rontgen, klinis, diagnosa, kode_pemeriksaan, nama_pemeriksaan,
  modality, cito, polirawat, kode_ruangan, nama_ruangan, kode_dokter, nama_dokter,
  kode_dokter_radiolog, nama_radiolog, kode_radiografer, nama_radiografer,
  cara_bayar, kode_instalasi_radiologi, nama_instalasi_radiologi, update_ris, sync_status
) VALUES
(
  '2026-06-18 08:30:00', '2026-06-18 08:35:00', 'MRN-DB2DB-001', 'PASIEN SIMRS CR TEST',
  '1988-02-14', 'M', 'Jl. Testing Integrasi No. 1', '628111111111',
  'REG-DB2DB-001', 'DB2DB-DX-001', 'Batuk dan demam', 'Bronchitis',
  '002', 'Thorax', 'DX', '0', 'RJ', 'RAD', 'Radiologi',
  '001', 'Dokter Pengirim', '002', 'Radiolog', '003', 'Radiografer',
  'UMUM', 'RAD', 'Instalasi Radiologi', 'N', 'N'
),
(
  '2026-06-18 09:00:00', '2026-06-18 09:05:00', 'MRN-DB2DB-002', 'PASIEN SIMRS CT TEST',
  '1979-11-03', 'F', 'Jl. Testing Integrasi No. 2', '628222222222',
  'REG-DB2DB-002', 'DB2DB-CT-001', 'Nyeri kepala hebat', 'Cephalgia',
  '001', 'CT Kepala Polos', 'CT', '1', 'IGD', 'ER', 'Emergency',
  '001', 'Dokter Pengirim', '002', 'Radiolog', '003', 'Radiografer',
  'BPJS', 'RAD', 'Instalasi Radiologi', 'N', 'N'
)
ON CONFLICT (no_rontgen) DO UPDATE SET
  nama_pasien = EXCLUDED.nama_pasien,
  kode_pemeriksaan = EXCLUDED.kode_pemeriksaan,
  nama_pemeriksaan = EXCLUDED.nama_pemeriksaan,
  modality = EXCLUDED.modality,
  kode_dokter = EXCLUDED.kode_dokter,
  nama_dokter = EXCLUDED.nama_dokter,
  kode_dokter_radiolog = EXCLUDED.kode_dokter_radiolog,
  nama_radiolog = EXCLUDED.nama_radiolog,
  kode_radiografer = EXCLUDED.kode_radiografer,
  nama_radiografer = EXCLUDED.nama_radiografer,
  waktu_update_orderin = CURRENT_TIMESTAMP,
  sync_status = 'N',
  sync_message = NULL;
"@

$orderOutSql = @"
CREATE TABLE IF NOT EXISTS $orderOutTableSql (
  id BIGSERIAL PRIMARY KEY,
  no_rm VARCHAR(255),
  no_rontgen VARCHAR(32) NOT NULL UNIQUE,
  no_register VARCHAR(255),
  kode_user_admin VARCHAR(32),
  nama_user_admin VARCHAR(100),
  admin_datetime_start TIMESTAMP NULL,
  admin_datetime_end TIMESTAMP NULL,
  kode_radiografer VARCHAR(32),
  nama_radiografer VARCHAR(100),
  radiografer_datetime_start TIMESTAMP NULL,
  radiografer_datetime_end TIMESTAMP NULL,
  kode_radiolog VARCHAR(32),
  nama_radiolog VARCHAR(100),
  radiolog_datetime_start TIMESTAMP NULL,
  radiolog_datetime_end TIMESTAMP NULL,
  klinis VARCHAR(255),
  cito VARCHAR(1),
  kritis VARCHAR(1) DEFAULT '0',
  expertise_text_finding TEXT NULL,
  expertise_text_conclusion TEXT NULL,
  expertise_html_finding TEXT NULL,
  expertise_html_conclusion TEXT NULL,
  urllink1 VARCHAR(500) NULL,
  urllink2 VARCHAR(500) NULL,
  urllink3 VARCHAR(500) NULL,
  urllink4 VARCHAR(500) NULL,
  urllink5 VARCHAR(500) NULL,
  urllink6 VARCHAR(500) NULL,
  alasan VARCHAR(255) NULL,
  waktu_update_orderout TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  update_ris VARCHAR(1) NOT NULL DEFAULT 'N',
  sync_status VARCHAR(1) NOT NULL DEFAULT 'N',
  sync_message TEXT NULL,
  synced_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_test_orderout_no_rm ON $orderOutTableSql(no_rm);
CREATE INDEX IF NOT EXISTS idx_test_orderout_no_register ON $orderOutTableSql(no_register);
CREATE INDEX IF NOT EXISTS idx_test_orderout_sync_status ON $orderOutTableSql(sync_status);

INSERT INTO $orderOutTableSql (
  no_rm, no_rontgen, no_register, kode_user_admin, nama_user_admin,
  kode_radiografer, nama_radiografer, kode_radiolog, nama_radiolog,
  klinis, cito, kritis, expertise_text_finding, expertise_text_conclusion,
  expertise_html_finding, expertise_html_conclusion, urllink1, urllink2, urllink3,
  update_ris, sync_status
) VALUES (
  'MRN-SAMPLE-OUT', 'DB2DB-RESULT-SAMPLE', 'REG-SAMPLE-OUT', 'ADM', 'Admin Sample',
  'T001', 'Radiografer Sample', 'R001', 'dr. Radiolog Sample',
  'Kontrol sample', '0', '0', 'Sample finding dari database tengah.',
  'Sample conclusion dari database tengah.',
  '<p>Sample finding dari database tengah.</p>', '<p>Sample conclusion dari database tengah.</p>',
  'http://localhost:8080/viewer/token/sample?viewer=vexa-pacs&role=clinician',
  'http://localhost:8080/viewer/token/sample?viewer=vexa-mobile&role=clinician',
  'http://localhost:8080/public/study/sample',
  'N', 'N'
)
ON CONFLICT (no_rontgen) DO UPDATE SET
  expertise_text_finding = EXCLUDED.expertise_text_finding,
  waktu_update_orderout = CURRENT_TIMESTAMP;
"@

Invoke-Psql -Database $Database -Sql $orderInSql
Invoke-Psql -Database $Database -Sql $orderOutSql

Write-Host "[DB] Test database is ready."
Write-Host "[DB] Database       : $Database"
Write-Host "[DB] Order in table : $OrderInTable"
Write-Host "[DB] Order out table: $OrderOutTable"
