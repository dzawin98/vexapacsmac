# VEXAPACS-RIS Installer

Folder ini berisi skeleton installer production berbasis Inno Setup.

Target installer:

- Pilih modul saat install.
- Copy aplikasi sesuai modul.
- Setup folder `C:\ProgramData\VEXAPACS`.
- Setup license path dan production environment.
- Setup Caddy reverse proxy sebagai entrypoint port publik.
- Generate `install-request.json`.
- Register Windows Service untuk modul yang dipilih.
- Setup backup/restore manager.
- Support dependency offline melalui folder `vendor`.

## Struktur

```text
installer\
  vexapacs-ris.iss            Inno Setup script
  prepare-payload.ps1         Build/copy payload dari workspace
  scripts\
    postinstall.ps1           Dipanggil installer setelah copy file
    install-services.ps1      Register Windows service
    uninstall-services.ps1    Unregister Windows service
    generate-install-request.ps1
    service-env.ps1
  vendor\
    README.md                 Tempat Node/PostgreSQL/Python/NSSM/WinSW offline
  payload\                    Hasil generated, tidak perlu diedit manual
```

## Dependency Installer

Untuk tahap awal, service registration memakai **NSSM** karena cepat dan stabil untuk testing.
Letakkan binary NSSM dan Caddy di:

```text
installer\vendor\nssm\nssm.exe
installer\vendor\caddy\caddy.exe
```

Dependency offline lain bisa ditaruh di:

```text
installer\vendor\node\
installer\vendor\postgresql\
installer\vendor\python\
installer\vendor\vcredist\
installer\vendor\caddy\
```

Script saat ini sudah menyiapkan hook-nya, tapi belum memaksa install dependency vendor. Untuk testing pertama di server Anda, pastikan Node.js dan Python tersedia, PostgreSQL sudah berjalan, serta NSSM dan Caddy tersedia di path di atas.

## Build Payload

Jalankan dari PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File D:\VELOPACS-RIS\installer\prepare-payload.ps1
```

Script ini akan:

- Build RIS frontend.
- Build PACS TypeScript.
- Build Desktop Viewer.
- Build Mobile Viewer.
- Copy modul ke `installer\payload\app`.
- Copy license scripts ke payload.
- Copy installer scripts ke payload.

## Compile Installer

Install Inno Setup, lalu compile:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" D:\VELOPACS-RIS\installer\vexapacs-ris.iss
```

Output default:

```text
installer\Output\VEXAPACS-RIS-Setup.exe
```

## Flow Install di Server

1. Jalankan installer sebagai Administrator.
2. Pilih modul.
3. Isi lokasi storage DICOM.
4. Isi akses lokal dan publik:
   - Local IP/host: IP server di LAN, atau kosongkan untuk listen semua IP lokal.
   - Local port: default `80`.
   - Public domain: domain publik, misalnya `ris.rscontoh.co.id`, atau kosongkan jika belum dipakai.
   - Public port: default `443` untuk HTTPS otomatis Caddy.
5. Installer copy app, configure Caddy, dan register service.
6. Installer generate:

```text
C:\ProgramData\VEXAPACS\install-request.json
```

7. Tim Anda generate `license.lic`.
8. Copy license ke:

```text
C:\ProgramData\VEXAPACS\license.lic
```

9. Start service dari Windows Services atau PowerShell.

## Akses Production Via Caddy

Installer membuat satu Caddy reverse proxy yang dapat melayani dua endpoint bersama-sama:

```text
http://IP-LOKAL/               akses LAN/by IP
https://DOMAIN-PUBLIK/         akses public by domain, jika public domain diisi dan port 443 terbuka
```

Default route pada kedua endpoint:

```text
http://IP-ATAU-DOMAIN/          RIS Frontend
http://IP-ATAU-DOMAIN/api       RIS Backend
http://IP-ATAU-DOMAIN/viewer    Primary Diagnostic Viewer
http://IP-ATAU-DOMAIN/mobile    Mobile Viewer
http://IP-ATAU-DOMAIN/ecg       ECG Viewer
http://IP-ATAU-DOMAIN/rs        PACS DICOMweb
```

Service internal tetap berjalan pada port masing-masing agar dapat di-debug dari jaringan jika diperlukan:

```text
RIS Backend     3001
RIS Frontend    8080
PACS DICOMweb   5001
Primary Viewer  5994
Mobile Viewer   5992
ECG Viewer      7771
DIMSE           5757
MWL             5656
```

Konfigurasi Caddy production berada di:

```text
C:\ProgramData\VEXAPACS\Caddyfile
```

Contoh hasil Caddyfile address:

```text
:80, ris.rscontoh.co.id {
  ...
}
```

Artinya akses lokal via `http://IP-SERVER/` tetap jalan, dan domain publik `https://ris.rscontoh.co.id/` juga jalan pada route yang sama.

## Environment Production

Service diset dengan environment:

```text
NODE_ENV=production
VEXA_LICENSE_ENFORCE=true
VEXA_LICENSE_FILE=C:\ProgramData\VEXAPACS\license.lic
VEXA_LICENSE_PUBLIC_KEY_PATH=C:\ProgramData\VEXAPACS\public.pem
```

Jika license belum dipasang, service akan gagal start. Ini memang perilaku production.

## Backup & Restore

Installer membuat config backup di:

```text
C:\ProgramData\VEXAPACS\backup.config.json
```

Shortcut Start Menu:

```text
Backup VEXAPACS
Restore VEXAPACS
Backup Config
```

Command manual:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\VEXAPACS-RIS\installer\scripts\backup\backup.ps1"
```

Restore wajib eksplisit:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\VEXAPACS-RIS\installer\scripts\backup\restore.ps1" -BackupPath "D:\VEXAPACS-Backup\2026-06-17_230000" -ConfirmRestore
```
