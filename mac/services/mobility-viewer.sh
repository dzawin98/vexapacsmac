#!/usr/bin/env bash
# VEXA Mobility Viewer (mobile/hybrid SSR) — port 5992
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/MOBILITY VIEWER"
export PORT="${MOBILITY_VIEWER_PORT}"
export VITE_MOBILE_HYBRID_SSR=true
export DICOMWEB_PACS_ROOT="${MOBILE_DICOMWEB_ROOT}"
export VITE_DICOMWEB_BASE_URL="${VITE_DICOMWEB_BASE_URL:-/rs}"
export DICOMWEB_JPEG2000_DECODER_PYTHON="${DICOMWEB_JPEG2000_DECODER_PYTHON}"
if [ "${VIEWER_DEV_MODE}" = "true" ]; then
  exec npm run dev -- --host 0.0.0.0 --port "${MOBILITY_VIEWER_PORT}" --strictPort
fi
[ -f "${ROOT}/MOBILITY VIEWER/dist/index.html" ] || die "dist mobility viewer belum ada — jalankan ./mac/build-viewers.sh"
exec node server/index.mjs
