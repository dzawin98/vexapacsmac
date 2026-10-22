# VEXAPACS Core License System

Core ini memakai signed license berbasis Ed25519:

- `private.pem` hanya disimpan oleh tim Vexa/Nexia untuk generate license.
- `public.pem` boleh ikut aplikasi/installer untuk verifikasi license.
- `license.lic` berisi payload license + signature.
- Machine binding memakai fingerprint server dan menghasilkan `machineId`.

## Modul

Nama modul standar:

- `RIS`
- `PACS_DIMSE`
- `PACS_MWL`
- `DESKTOP_VIEWER`
- `MOBILE_VIEWER`
- `ECG_VIEWER`

## Generate Keypair

Jalankan sekali di mesin internal tim Anda, bukan di rumah sakit:

```powershell
node D:\VELOPACS-RIS\scripts\license\license-cli.js generate-keys --out D:\VELOPACS-RIS\scripts\license\keys
```

Penting: `private.pem` jangan ikut installer dan jangan dikirim ke customer.

## Buat Request Code di Server Rumah Sakit

Installer bisa menjalankan command ini setelah modul dipilih:

```powershell
node D:\VELOPACS-RIS\scripts\license\license-cli.js request --modules RIS,PACS_DIMSE,DESKTOP_VIEWER --out D:\install-request.json
```

File `install-request.json` dikirim ke tim Anda.

## Generate License

Di mesin internal tim Anda:

```powershell
node D:\VELOPACS-RIS\scripts\license\license-cli.js sign `
  --request D:\install-request.json `
  --private-key D:\VELOPACS-RIS\scripts\license\keys\private.pem `
  --customer "RS NEXIA DEMO" `
  --modules RIS,PACS_DIMSE,DESKTOP_VIEWER `
  --expires 2027-06-17 `
  --max-users 25 `
  --out D:\license.lic
```

Untuk lifetime license, hilangkan `--expires`.

## Verifikasi License

Di server customer:

```powershell
node D:\VELOPACS-RIS\scripts\license\license-cli.js verify `
  --license C:\ProgramData\VEXAPACS\license.lic `
  --public-key C:\ProgramData\VEXAPACS\public.pem `
  --module RIS
```

## Integrasi ke Service Node

Contoh guard saat service start:

```js
const { assertLicensed } = require('../scripts/license/licenseCore');

assertLicensed('RIS', {
  licensePath: process.env.VEXA_LICENSE_FILE || 'C:\\ProgramData\\VEXAPACS\\license.lic',
  publicKeyPath: process.env.VEXA_LICENSE_PUBLIC_KEY_PATH || 'C:\\ProgramData\\VEXAPACS\\public.pem',
});
```

Contoh Express middleware:

```js
const { createLicenseMiddleware } = require('../scripts/license/licenseCore');

app.use('/api', createLicenseMiddleware('RIS', {
  licensePath: process.env.VEXA_LICENSE_FILE,
  publicKeyPath: process.env.VEXA_LICENSE_PUBLIC_KEY_PATH,
}));
```

## Variabel Environment Production

```text
VEXA_LICENSE_ENFORCE=true
VEXA_LICENSE_FILE=C:\ProgramData\VEXAPACS\license.lic
VEXA_LICENSE_PUBLIC_KEY_PATH=C:\ProgramData\VEXAPACS\public.pem
```

Installer production sebaiknya menaruh file di:

```text
C:\ProgramData\VEXAPACS\license.lic
C:\ProgramData\VEXAPACS\public.pem
```

## Enforcement Yang Sudah Terpasang

Guard startup sudah dipasang ke:

- RIS Backend: modul `RIS`
- PACS DICOMweb/DIMSE: modul `PACS_DIMSE`
- PACS DIMSE Python SCP: modul `PACS_DIMSE`
- PACS/RIS MWL service: modul `PACS_MWL`
- Desktop Viewer: modul `DESKTOP_VIEWER`
- Mobile Viewer: modul `MOBILE_VIEWER`
- ECG Viewer: modul `ECG_VIEWER`

Perilaku runtime:

- Development default: enforcement mati, service tetap start.
- Production: set `VEXA_LICENSE_ENFORCE=true`.
- Jika `NODE_ENV=production`, enforcement juga otomatis aktif kecuali `VEXA_LICENSE_ENFORCE=false`.
- Jika license tidak valid, service berhenti saat startup atau route modul terkait mengembalikan HTTP 403.

Runtime check manual:

```powershell
node D:\VELOPACS-RIS\scripts\license\license-cli.js check --module RIS
```
