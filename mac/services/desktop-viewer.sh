#!/usr/bin/env bash
# VEXA Desktop Viewer (primary/local viewer) — port 5991
# VIEWER_DEV_MODE=true  -> Vite dev server (hot reload)
# VIEWER_DEV_MODE=false -> static server dari "DESKTOP VIEWER/dist"
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/DESKTOP VIEWER"
export PORT="${DESKTOP_VIEWER_PORT}"
export DICOMWEB_PACS_ROOT="${DICOMWEB_PACS_ROOT}"
export DICOM_STORAGE_PATH="${DICOM_STORAGE_PATH}"
export DICOMWEB_JPEG2000_DECODER_PYTHON="${DICOMWEB_JPEG2000_DECODER_PYTHON}"
if [ "${VIEWER_DEV_MODE}" = "true" ]; then
  exec npm run dev -- --host 0.0.0.0 --port "${DESKTOP_VIEWER_PORT}" --strictPort
fi
[ -f "${ROOT}/DESKTOP VIEWER/dist/index.html" ] || die "dist viewer belum ada — jalankan ./mac/build-viewers.sh"
exec node server/index.mjs
