#!/usr/bin/env bash
# SIMRS DB bridge (polling order dari database SIMRS) — port 3109
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/tools/simrs-db-bridge"
export SIMRS_DB_BRIDGE_PORT="${SIMRS_DB_BRIDGE_PORT}"
export VEXA_SETTINGS_PATH="${ROOT}/RIS/backend/settings.json"
exec node server.js
