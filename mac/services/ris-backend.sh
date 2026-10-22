#!/usr/bin/env bash
# RIS backend (Express API) — port 3001
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/RIS/backend"
export PORT="${RIS_BACKEND_PORT}"
export VEXA_DIRECT_VIEWER_LAUNCH=true
exec node index.js
