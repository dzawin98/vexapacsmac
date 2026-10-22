#!/usr/bin/env bash
# ECG Viewer (waveform viewer + API ECG) — port 7771
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/ECG VIEWER"
export ECG_VIEWER_PORT="${ECG_VIEWER_PORT}"
export DICOM_STORAGE_PATH="${DICOM_STORAGE_PATH}"
export DICOMWEB_RS_ROOT="${DICOMWEB_PACS_ROOT}/rs"
exec node server.js
