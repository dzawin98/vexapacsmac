#!/usr/bin/env bash
# VEXA Diagnostic Viewer (SSR, lossless) — port 5994
# Wajib punya "DESKTOP VIEWER/dist" karena SSE ini menyajikan bundle UI yang sama.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
[ -f "${ROOT}/DESKTOP VIEWER/dist/index.html" ] || die "dist viewer belum ada — jalankan ./mac/build-viewers.sh"
cd "${ROOT}/DESKTOP VIEWER SSR"
export PORT="${DESKTOP_SSR_PORT}"
export VIEWER_DIST_DIR="${ROOT}/DESKTOP VIEWER/dist"
export DICOM_STORAGE_PATH="${DICOM_STORAGE_PATH}"
export DICOMWEB_PACS_ROOT="${DICOMWEB_PACS_ROOT}"
export DICOMWEB_JPEG2000_DECODER_PYTHON="${DICOMWEB_JPEG2000_DECODER_PYTHON}"
exec node server/index.mjs
