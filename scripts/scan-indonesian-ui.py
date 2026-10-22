#!/usr/bin/env python3
"""Scan VELOPACS-RIS UI sources for Indonesian (non-English) user-facing text.

Heuristic: a line is flagged when it contains a distinctive Indonesian word
(function words are decisive; single medical nouns are corroborating). Output is a
TSV so the list can be reviewed and translated in batches.

Usage: python scratch/scan-id-ui.py [--out scratch/i18n-id-scan.tsv]
"""
import os
import re
import sys
import json
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = [
    "RIS/frontend/src",
    "RIS/frontend/index.html",
    "DESKTOP VIEWER/src",
    "DESKTOP VIEWER/index.html",
    "MOBILITY VIEWER/src",
    "MOBILITY VIEWER/index.html",
    "DESKTOP VIEWER SSR/src",
    "DESKTOP VIEWER SSR/server",
    "ECG VIEWER/src",
]
EXTS = (".ts", ".tsx", ".html", ".js", ".jsx", ".mjs", ".json")

# Decisive: Indonesian function words / verb forms that do not exist in English text.
STRONG = re.compile(
    r"\b("
    r"dan|atau|tidak|belum|sudah|dengan|untuk|yang|pada|jika|maka|harus|wajib|"
    r"gagal|berhasil|simpan|batal|hapus|ubah|tambah|cari|pilih|pasien|nama|tanggal|"
    r"jumlah|keterangan|catatan|laporan|dokter|ruang|pemeriksaan|gambar|berkas|"
    r"unggah|unduh|kirim|ambil|muat|sedang|selesai|silakan|mohon|tampilkan|masuk|"
    r"keluar|ulang|kosong|riwayat|nomor|alamat|telepon|lahir|jenis|kelamin|biaya|"
    r"hasil|kunjungan|obat|tindakan|penjamin|asuransi|rekam|rawat|poliklinik|"
    r"pendaftaran|antrean|antrian|jadwal|kasir|tagihan|radiologi|petugas|bangsal|"
    r"laboratorium|rekap|tarif|agama|pekerjaan|jabatan|instalasi|penunjang|farmasi|"
    r"bulan|tahun|minggu|menit|detik|terbilang|kwitansi|rujukan|diagnosa|diagnosis|"
    r"resep|kesimpulan|kembali|lanjut|tutup|kelola|pengaturan|pengguna|pemilihan|"
    r"panggil|kirimkan|dikirim|terkirim|diterima|diambil|dibuat|dihapus|diubah|"
    r"ditambah|tersimpan|diproses|berjalan|gagal|sukses|benar|salah|bagaimana|"
    r"apakah|siapa|kapan|dimana|tersedia|kembali|tersebut|sebelum|sesudah|kemudian|"
    r"setelah|selama|tanpa|hanya|juga|masih|perlu|boleh|dapat|dilakukan|dilaporkan|"
    r"ditampilkan|dipilih|dikirim|tersebut|berikut|melalui|terhadap|oleh|dari|pada"
    r")\b",
    re.IGNORECASE,
)
# Corroborating: Indonesian-labelled nouns that also exist in English are excluded.
MED = re.compile(
    r"\b(pasien|dokter|petugas|ruang|bangsal|poli|klinik|radiologi|laboratorium|"
    r"rekam medis|no\. rm|penjamin|antrean|jadwal|tagihan|pendaftaran)\b",
    re.IGNORECASE,
)


SKIP_DIRS = {
    "node_modules", "dist", "build", ".git", "vendor", "__pycache__",
    "payload",              # installer/server-hotfix build copies: regenerated, not edited
    "public.backup-20260423-010314",
    "OHIF",                 # third-party viewer source
    "logs", "DATA", "scratch", "frame-cache", "deploy", "VELOPACS-RIS.git",
}


def iter_files(apps=APPS):
    for app in apps:
        absolute = os.path.join(ROOT, app)
        if os.path.isfile(absolute):
            yield app, absolute
            continue
        if not os.path.isdir(absolute):
            continue
        for base, dirs, files in os.walk(absolute):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                if not name.endswith(EXTS):
                    continue
                path = os.path.join(base, name)
                yield app, path


def classify_kind(line, match):
    """Tell UI text apart from identifiers that merely carry Indonesian names."""
    start, end = match.span()
    before = line[max(0, start - 32):start]
    after = line[end:end + 8]
    # A field/property/variable reference carries an Indonesian *name*, not prose:
    # `diagnosa:`, `row.kelamin || ...`, `{ kelamin }`, `entry.alamat,`.
    if re.match(r"\s*\??\s*:", after):
        return "identifier"
    if re.match(r"\s*(?:\|\||&&|\?\?|[),;\].}])", after) and re.search(r"[.{\[(,]\s*$", before):
        return "identifier"
    # Inside a quoted string or JSX text -> user-visible.
    if re.search(r"[\"'`][^\"'`]*$", before) or re.search(r"^[^\"'`]*[\"'`]", after):
        return "text"
    if re.search(r">[^<>{}]*$", before) or re.match(r"^[^<>{}]*<", after):
        return "text"
    return "other"


def main():
    out_path = None
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]
    extra = []
    if "--dirs" in sys.argv:
        extra = [entry for entry in sys.argv[sys.argv.index("--dirs") + 1].split(",") if entry]
    # With --dirs the caller wants exactly those paths (verification mode), otherwise
    # scan the product UI sources by default.
    apps = extra if extra else APPS
    rows = []
    per_file = Counter()
    per_app = Counter()
    # English words that share their spelling with an Indonesian keyword are not
    # Indonesian text: keep the verifier from reporting them as leftovers.
    english_false_positives = re.compile(
        r"\b(diagnosis|unit|status|data|total|code|resume|detail|report|dose)\b",
        re.IGNORECASE,
    )
    for app, path in iter_files(apps):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                lines = handle.readlines()
        except OSError:
            continue
        for index, line in enumerate(lines, start=1):
            strong = STRONG.search(line)
            med = MED.search(line)
            if not strong and not med:
                continue
            # A line whose only Indonesian-ish token is an English word is skipped.
            if strong and english_false_positives.search(line):
                stripped = english_false_positives.sub(" ", line)
                if not STRONG.search(stripped) and not MED.search(stripped):
                    continue
            comment_only = bool(re.match(r"^\s*(?:\*|//|/\*|<!--)", line))
            if not comment_only and "//" in line:
                code_part, _, comment_part = line.partition("//")
                if (STRONG.search(comment_part) or MED.search(comment_part)) and not STRONG.search(code_part) and not MED.search(code_part):
                    comment_only = True
            kind = "comment" if comment_only else classify_kind(line, strong or med)
            rows.append({
                "app": app,
                "file": os.path.relpath(path, ROOT).replace("\\", "/"),
                "line": index,
                "weight": kind,
                "text": line.strip()[:240],
            })
            per_file[os.path.relpath(path, ROOT).replace("\\", "/")] += 1
            per_app[app] += 1

    if out_path:
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write("app\tfile\tline\tweight\ttext\n")
            for row in rows:
                handle.write(f"{row['app']}\t{row['file']}\t{row['line']}\t{row['weight']}\t{row['text']}\n")

    by_kind = Counter(row["weight"] for row in rows)
    print(f"TOTAL flagged lines: {len(rows)} across {len(per_file)} files")
    print(f"  user-visible text : {by_kind['text']}")
    print(f"  identifiers/names : {by_kind['identifier']}")
    print(f"  code comments     : {by_kind['comment']}")
    print(f"  other             : {by_kind['other']}")
    for app, count in per_app.most_common():
        print(f"  {app:28} {count}")
    print("--- top files ---")
    for name, count in per_file.most_common(30):
        print(f"  {count:4}  {name}")


if __name__ == "__main__":
    main()
