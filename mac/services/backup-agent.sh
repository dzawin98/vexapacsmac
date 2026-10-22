#!/usr/bin/env bash
# Backup agent (REST untuk backup/restore dipakai RIS UI) — port 3099
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
need_node
cd "${ROOT}/tools/backup-agent"
export BACKUP_AGENT_PORT="${BACKUP_AGENT_PORT}"
exec node server.js
