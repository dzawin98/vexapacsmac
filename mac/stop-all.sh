#!/usr/bin/env bash
# mac/stop-all.sh — hentikan semua service yang dijalankan mac/start-all.sh.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
load_env_defaults

SERVICES=("ecg-viewer" "desktop-ssr" "mobility-viewer" \
          "ris-frontend" "mwl-scp" "simrs-bridge" "backup-agent" \
          "ris-backend" "pacs-dimse" "pacs-web")

for svc in "${SERVICES[@]}"; do stop_bg "${svc}"; done

# Sisa proses yang masih memegang port (mis. anak proses yang lolos dari PID file).
for p in ${VEXA_DEV_PORTS}; do
  pid="$(port_pid "${p}")"
  if [ -n "${pid}" ]; then
    case "$(ps -o comm= -p "${pid}" 2>/dev/null || echo "")" in
      *node*|*python*|*npm*) kill_port "${p}" ;;
      *) warn "port ${p} dipakai proses lain ($(ps -o comm= -p "${pid}" 2>/dev/null)); dilewati" ;;
    esac
  fi
done

ok "Semua service VEXAPACS-RIS dihentikan."
