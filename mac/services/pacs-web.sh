#!/usr/bin/env bash
# PACS DICOMweb (QIDO/WADO/STOW) — port 5001
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/PACS"
export PORT="${PACS_HTTP_PORT}"
exec npm start
