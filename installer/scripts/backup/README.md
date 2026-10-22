# VEXAPACS Backup & Restore Manager

Backup manager ini membackup:

- PostgreSQL RIS DB: `veloris_db`
- PostgreSQL PACS DB: `velopacs_db`
- DICOM DATA folder
- `C:\ProgramData\VEXAPACS` termasuk license, Caddyfile, dan site customization

Config default dibuat di:

```text
C:\ProgramData\VEXAPACS\backup.config.json
```

## Backup

Jalankan sebagai Administrator:

```powershell
C:\Program Files\VEXAPACS-RIS\installer\scripts\backup\backup.bat
```

Atau langsung:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\VEXAPACS-RIS\installer\scripts\backup\backup.ps1"
```

Backup tersimpan ke `backupRoot` dari config, contoh:

```text
D:\VEXAPACS-Backup\2026-06-17_230000\
  manifest.json
  db\
    veloris_db.dump
    velopacs_db.dump
  data\
  programdata\
```

## Restore

Restore sengaja wajib memakai `-ConfirmRestore`.

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\VEXAPACS-RIS\installer\scripts\backup\restore.ps1" `
  -BackupPath "D:\VEXAPACS-Backup\2026-06-17_230000" `
  -ConfirmRestore
```

Restore akan:

1. Stop service VEXAPACS.
2. Restore database dengan `pg_restore`.
3. Restore DICOM DATA dengan `robocopy /MIR`.
4. Restore ProgramData.
5. Start kembali service yang sebelumnya running.

## Partial Restore

Restore DB saja:

```powershell
powershell -ExecutionPolicy Bypass -File restore.ps1 -BackupPath "D:\VEXAPACS-Backup\2026-06-17_230000" -ConfirmRestore -SkipDicomData -SkipProgramData
```

Restore DICOM DATA saja:

```powershell
powershell -ExecutionPolicy Bypass -File restore.ps1 -BackupPath "D:\VEXAPACS-Backup\2026-06-17_230000" -ConfirmRestore -SkipDatabase -SkipProgramData
```

## Catatan

- Gunakan `pg_dump`, `pg_restore`, dan `psql` dari PostgreSQL versi yang sama atau lebih baru.
- Jika PostgreSQL bin tidak ada di PATH, isi `postgres.binPath` di `backup.config.json`.
- Backup DICOM DATA bisa besar. Arahkan `backupRoot` ke NAS/drive berbeda dari DATA utama.
- Retention default menyimpan 7 backup terakhir.

