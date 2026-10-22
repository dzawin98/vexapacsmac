#!/usr/bin/env bash
# mac/start-all.sh — menjalankan semua app VEXAPACS-RIS (padanan START-ALL-APPS.bat).
#
#   ./mac/start-all.sh              # mode normal (static bundle viewer)
#   VIEWER_DEV_MODE=true ./mac/start-all.sh   # viewer pakai Vite dev server
#   ./mac/stop-all.sh               # hentikan semuanya
#   ./mac/status.sh                 # cek port
#
# Semua log ada di logs/<nama-service>.log dan PID di logs/pids/.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
load_env_defaults

need_node
require_cmd npm || die "npm tidak ditemukan."
need_python
need_postgres

SERVICES=("pacs-web" "pacs-dimse" "ris-backend" "backup-agent" "simrs-bridge" "mwl-scp" \
          "ris-frontend" "mobility-viewer" "desktop-ssr" "ecg-viewer")

echo
echo "============================================================"
echo "  VEXAPACS-RIS — ALL APPS (macOS)"
echo "============================================================"
printf '  RIS Frontend    http://127.0.0.1:%s\n' "${RIS_FRONTEND_PORT}"
printf '  RIS Backend     http://127.0.0.1:%s\n' "${RIS_BACKEND_PORT}"
printf '  Backup Agent    http://127.0.0.1:%s\n' "${BACKUP_AGENT_PORT}"
printf '  SIMRS DB Bridge http://127.0.0.1:%s\n' "${SIMRS_DB_BRIDGE_PORT}"
printf '  PACS DICOMweb   http://127.0.0.1:%s\n' "${PACS_HTTP_PORT}"
printf '  Primary Viewer  http://127.0.0.1:%s/view\n' "${DESKTOP_SSR_PORT}"
printf '  Mobility Viewer http://127.0.0.1:%s\n' "${MOBILITY_VIEWER_PORT}"
printf '  ECG Viewer      http://127.0.0.1:%s/viewer\n' "${ECG_VIEWER_PORT}"
printf '  PACS DIMSE      AET %s, port %s (internal %s)\n' "${DICOMWEB_PACS_AET}" "${DICOMWEB_PACS_DICOM_PORT}" "${DICOMWEB_PACS_INTERNAL_DICOM_PORT}"
printf '  MWL Service     AET %s, port %s\n' "${MWL_SCP_AET}" "${MWL_SCP_PORT}"
printf '  DICOM Storage   %s\n' "${DICOM_STORAGE_PATH}"
echo "============================================================"
echo

# ---------------------------------------------------------------- 1. bersihkan
log "Membersihkan proses dev yang tercatat dari run sebelumnya…"
for svc in "${SERVICES[@]}"; do stop_bg "${svc}"; done

busy=""
for p in ${VEXA_DEV_PORTS}; do port_busy "${p}" && busy="${busy} ${p}"; done
if [ -n "${busy}" ]; then
  warn "Port berikut masih dipakai proses lain:${busy}"
  warn "Hentikan dulu (atau jalankan ./mac/stop-all.sh) lalu ulangi."
  exit 1
fi

# ------------------------------------------------------------ 2. dependency
log "Memastikan dependency terpasang…"
"${MAC_DIR}/setup.sh" --deps-only

# -------------------------------------------------------------- 3. database
"${MAC_DIR}/init-postgres.sh"

# --------------------------------------------------- 4. service inti (backend)
start_bg "pacs-web"      "${ROOT}" "${MAC_DIR}/services/pacs-web.sh"
start_bg "pacs-dimse"    "${ROOT}" "${MAC_DIR}/services/pacs-dimse.sh"
start_bg "ris-backend"   "${ROOT}" "${MAC_DIR}/services/ris-backend.sh"
start_bg "backup-agent"  "${ROOT}" "${MAC_DIR}/services/backup-agent.sh"
start_bg "simrs-bridge"  "${ROOT}" "${MAC_DIR}/services/simrs-bridge.sh"

log "Menunggu service inti siap (3001, 3099, 3109, 5001)…"
for p in 3001 3099 3109 5001; do
  wait_port "${p}" 40 || warn "port ${p} belum listening setelah 40 s (cek logs/)"
done

# -------------------------------------------------------- 5. MWL + RIS front
start_bg "mwl-scp"       "${ROOT}" "${MAC_DIR}/services/mwl-scp.sh"
start_bg "ris-frontend"  "${ROOT}" "${MAC_DIR}/services/ris-frontend.sh"

# --------------------------------------------------------------- 6. viewer
if [ "${VIEWER_DEV_MODE}" != "true" ]; then
  "${MAC_DIR}/build-viewers.sh"
fi

start_bg "mobility-viewer" "${ROOT}" "${MAC_DIR}/services/mobility-viewer.sh"
if [ "${VIEWER_THIN_SSR_ENABLED}" = "true" ]; then
  start_bg "desktop-ssr" "${ROOT}" "${MAC_DIR}/services/desktop-ssr.sh"
fi
start_bg "ecg-viewer" "${ROOT}" "${MAC_DIR}/services/ecg-viewer.sh"

log "Menunggu viewer siap…"
wait_port "${MOBILITY_VIEWER_PORT}" 45 || warn "Mobility Viewer belum siap"
if [ "${VIEWER_THIN_SSR_ENABLED}" = "true" ]; then
  wait_port "${DESKTOP_SSR_PORT}" 45 || warn "Diagnostic Viewer (SSR) belum siap"
fi

echo
"${MAC_DIR}/status.sh" || true
echo
ok "Semua service sudah diperintahkan start."
echo "  Log    : ${LOG_DIR}/"
echo "  Stop   : ${MAC_DIR}/stop-all.sh"
echo "  Status : ${MAC_DIR}/status.sh"
echo
echo "Buka aplikasi:"
echo "  RIS  → http://127.0.0.1:${RIS_FRONTEND_PORT}"
echo "  PACS → http://127.0.0.1:${DESKTOP_SSR_PORT}/view?StudyInstanceUIDs=<uid>"
echo
