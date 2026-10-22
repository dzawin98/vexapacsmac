#!/usr/bin/env bash
# RIS frontend (Vite dev server) — port 8080
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/RIS/frontend"
export VITE_DEV_BACKEND_TARGET="http://127.0.0.1:${RIS_BACKEND_PORT}"
export VITE_DEV_BACKUP_AGENT_TARGET="http://127.0.0.1:${BACKUP_AGENT_PORT}"
export VITE_DEV_DICOMWEB_TARGET="${DICOMWEB_PACS_ROOT}"
export VITE_DEV_MOBILE_VIEWER_TARGET="http://127.0.0.1:${MOBILITY_VIEWER_PORT}"
export VITE_DEV_ECG_VIEWER_TARGET="http://127.0.0.1:${ECG_VIEWER_PORT}"
exec npm run dev -- --host 0.0.0.0 --port "${RIS_FRONTEND_PORT}"
