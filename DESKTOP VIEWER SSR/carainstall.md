# Cara Install VEXA Desktop Viewer SSR

Dokumen ini untuk memasang viewer Desktop SSR React + Vite ini ke server production.

## Prasyarat

- Node.js 20 LTS atau lebih baru.
- npm tersedia.
- Web server static seperti Nginx/Apache/Caddy.
- Akses ke DICOMweb/PACS QIDO-RS dan WADO-RS.
- HTTPS direkomendasikan untuk production.

## Clone Repository

```bash
git clone https://gitea.sitermid.my.id/dzawin/MOBILITY.git
cd MOBILITY
```

## Install Dependency

```bash
npm ci
```

Jika `npm ci` gagal karena lockfile tidak cocok, gunakan:

```bash
npm install
```

## Konfigurasi Environment

Buat file `.env` di root project.

Contoh:

```env
VITE_DICOMWEB_BASE_URL=https://pacs.example.com/dicom-web
VITE_DICOMWEB_QIDO_PREFIX=
VITE_DICOMWEB_WADO_PREFIX=
VITE_DICOMWEB_AUTHORIZATION=
```

Keterangan:

- `VITE_DICOMWEB_BASE_URL`: base URL DICOMweb server.
- `VITE_DICOMWEB_QIDO_PREFIX`: prefix QIDO jika PACS membutuhkan path tambahan.
- `VITE_DICOMWEB_WADO_PREFIX`: prefix WADO jika PACS membutuhkan path tambahan.
- `VITE_DICOMWEB_AUTHORIZATION`: optional header Authorization, contoh `Bearer xxx` atau `Basic xxx`.

Jika PACS dan viewer beda domain, pastikan CORS di PACS/proxy mengizinkan domain viewer.

## Runtime Settings

File runtime berada di:

```text
public/settings.json
```

Default:

```json
{
  "worklistEnabled": false
}
```

Keterangan:

- `worklistEnabled: false`: root `/` menampilkan pesan `You Can Access it from RIS.`
- `worklistEnabled: true`: root `/` menampilkan worklist global.
- Deep link RIS `/mobile?studyUID=...` tetap bisa dipakai walaupun worklist disabled.

Setelah build, file ini akan menjadi:

```text
dist/settings.json
```

File ini boleh diedit langsung di server tanpa rebuild.

## Build Production

```bash
npm run build
```

Output production ada di folder:

```text
dist/
```

## Test Preview Lokal

```bash
npm run preview -- --host 0.0.0.0 --port 6094
```

Buka:

```text
http://SERVER_IP:6094/view?StudyInstanceUIDs=STUDY_UID
```

## Deploy Nginx

Copy isi folder `dist/` ke web root, contoh:

```bash
sudo mkdir -p /var/www/mobility
sudo rsync -av --delete dist/ /var/www/mobility/
```

Contoh konfigurasi Nginx:

```nginx
server {
    listen 80;
    server_name mobility.example.com;

    root /var/www/mobility;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location = /settings.json {
        add_header Cache-Control "no-store";
        try_files $uri =404;
    }
}
```

Reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## URL Deep Link RIS

Gunakan endpoint `/mobile`.

Contoh query string:

```text
https://mobility.example.com/mobile?studyUID=1.2.3.4
```

Contoh path param:

```text
https://mobility.example.com/mobile/1.2.3.4
```

Membuka MPR langsung:

```text
https://mobility.example.com/mobile?studyUID=1.2.3.4&mode=mpr
```

Default deep link adalah stack mode. MPR hanya aktif jika user klik tombol MPR atau URL memakai `mode=mpr`.

## Security Production

Jangan expose viewer dan PACS secara bebas di internet tanpa kontrol akses.

Rekomendasi:

- Pakai HTTPS.
- RIS membuat signed URL/token short-lived.
- Backend/proxy validasi token sebelum akses DICOMweb.
- PACS/DICOMweb jangan dibuka publik langsung ke browser tanpa auth.
- Simpan audit log akses study.

Flow aman yang disarankan:

```text
RIS -> signed URL -> viewer -> backend/proxy validasi token -> DICOMweb/PACS
```

## Verifikasi Setelah Deploy

1. Buka `/`.
2. Jika `worklistEnabled=false`, harus tampil `You Can Access it from RIS.`
3. Buka `/mobile?studyUID=STUDY_UID`.
4. Pastikan study terbuka dalam stack mode.
5. Klik MPR untuk CT/MR dan pastikan MPR tampil.
6. Test layout `1x1`, `1x2`, `2x1`, `2x2`.
7. Test slider slice bawah.
8. Test tools WW/WL, Pan, Zoom, Probe, measurement, Delete, Reset.

## Troubleshooting

- Jika route `/mobile/...` 404 saat refresh, pastikan Nginx punya `try_files $uri $uri/ /index.html;`.
- Jika image tidak tampil, cek `VITE_DICOMWEB_BASE_URL`, CORS, dan Authorization.
- Jika build menampilkan warning chunk besar atau `fs/path externalized`, itu warning dari codec Cornerstone dan bukan blocker.
- Jika MPR lambat, pastikan server dan browser memiliki WebGL aktif.
