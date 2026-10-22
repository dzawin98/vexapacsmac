#!/usr/bin/env bash
# VEXA Diagnostic Viewer (SSR, lossless) — port 5994
# Menyajikan bundle UI hasil build-nya sendiri: "DESKTOP VIEWER SSR/dist".
# (Sejak viewer 5991 dikeluarkan dari repo, SSR tidak lagi bergantung pada
#  "DESKTOP VIEWER/dist".)
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
[ -f "${ROOT}/DESKTOP VIEWER SSR/dist/index.html" ] || die "dist viewer SSR belum ada — jalankan ./mac/build-viewers.sh"
cd "${ROOT}/DESKTOP VIEWER SSR"
export PORT="${DESKTOP_SSR_PORT}"
export VIEWER_DIST_DIR="${VIEWER_DIST_DIR:-${ROOT}/DESKTOP VIEWER SSR/dist}"
export DICOM_STORAGE_PATH="${DICOM_STORAGE_PATH}"
export DICOMWEB_PACS_ROOT="${DICOMWEB_PACS_ROOT}"
export DICOMWEB_JPEG2000_DECODER_PYTHON="${DICOMWEB_JPEG2000_DECODER_PYTHON}"
exec node server/index.mjs
