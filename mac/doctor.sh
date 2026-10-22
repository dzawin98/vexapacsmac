#!/usr/bin/env bash
# mac/doctor.sh — diagnosa cepat: prasyarat, dependency, port, data, log.
# Tidak mengubah apa pun; hanya membaca dan melaporkan.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
load_env_defaults

echo
echo "============================================================"
echo "  VEXAPACS-RIS — DIAGNOSA macOS"
echo "  $(sw_vers -productName 2>/dev/null || uname -s) $(sw_vers -productVersion 2>/dev/null) / $(uname -m)"
echo "============================================================"

section() { printf '\n%s── %s%s\n' "${C_CYA}" "$1" "${C_RESET}"; }

section "1. Prasyarat"
for c in brew node npm python3 psql pg_dump lsof curl rsync jq; do
  if require_cmd "$c"; then ok "$c → $(command -v "$c")"; else warn "$c TIDAK ADA"; fi
done
[ -x "${PACS_PYTHON}" ] && ok "venv PACS → ${PACS_PYTHON}" || warn "venv PACS belum ada (${PACS_PYTHON})"
[ -x "${MWL_PYTHON}" ]  && ok "venv MWL  → ${MWL_PYTHON}"  || warn "venv MWL belum ada (${MWL_PYTHON})"

section "2. Modul Python kritis"
if [ -x "${PACS_PYTHON}" ]; then
  for mod in pynetdicom pydicom psycopg openjpeg; do
    if "${PACS_PYTHON}" -c "import ${mod}" >/dev/null 2>&1; then ok "import ${mod}"; else fail "import ${mod} GAGAL (decode J2K / DIMSE bisa rusak)"; fi
  done
fi
if [ -x "${MWL_PYTHON}" ]; then
  for mod in pynetdicom pydicom; do
    if "${MWL_PYTHON}" -c "import ${mod}" >/dev/null 2>&1; then ok "import ${mod} (MWL)"; else fail "import ${mod} GAGAL (MWL)"; fi
  done
fi

section "3. PostgreSQL"
if pg_isready -h "${DB_HOST}" -p "${DB_PORT}" >/dev/null 2>&1; then
  ok "server hidup di ${DB_HOST}:${DB_PORT}"
  for db in "${DB_NAME}" "${PACS_DB_NAME}"; do
    if PGPASSWORD="${DB_PASS:-}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${db}" -tAc 'select 1' >/dev/null 2>&1; then
      ok "database ${db} bisa diakses user ${DB_USER}"
    else
      fail "database ${db} tidak bisa diakses (jalankan ./mac/init-postgres.sh)"
    fi
  done
else
  fail "PostgreSQL tidak merespons  →  brew services start postgresql@16"
fi

section "4. Dependency Node"
for app in "PACS" "RIS/backend" "RIS/frontend" "DESKTOP VIEWER" "DESKTOP VIEWER SSR" "MOBILITY VIEWER" "ECG VIEWER" "tools/backup-agent" "tools/simrs-db-bridge"; do
  if [ -d "${ROOT}/${app}/node_modules" ]; then ok "${app}"; else warn "${app} belum npm install"; fi
done
if [ -d "${ROOT}/PACS/node_modules/dicom-dimse-native" ]; then
  if [ -f "${ROOT}/PACS/node_modules/dicom-dimse-native/build/Release/dcmtk.node" ]; then
    ok "modul native dicom-dimse-native terkompilasi"
  else
    warn "dicom-dimse-native ada tapi build/Release/dcmtk.node tidak ditemukan → DIMSE tidak jalan"
  fi
fi

section "5. Bundle viewer"
for app in "DESKTOP VIEWER" "MOBILITY VIEWER"; do
  if [ -f "${ROOT}/${app}/dist/index.html" ]; then ok "${app}/dist"; else warn "${app}/dist belum dibuild (./mac/build-viewers.sh)"; fi
done

section "6. Port"
for p in ${VEXA_DEV_PORTS}; do
  if port_busy "${p}"; then
    pid="$(port_pid "${p}")"
    printf '  %-8s %sUP%s   pid %s %s\n' "${p}" "${C_GRN}" "${C_RESET}" "${pid}" "$(ps -o comm= -p "${pid}" 2>/dev/null | xargs 2>/dev/null)"
  else
    printf '  %-8s %sdown%s\n' "${p}" "${C_DIM}" "${C_RESET}"
  fi
done

section "7. Direktori & hak tulis"
for d in "${DATA_DIR}" "${VEXA_PROGRAM_DATA_DIR}" "${LOG_DIR}"; do
  if [ -w "${d}" ]; then ok "${d} (writable)"; else fail "${d} tidak writable"; fi
done

section "8. Konfigurasi"
printf '  VIEWER_DEV_MODE          %s\n' "${VIEWER_DEV_MODE}"
printf '  VIEWER_THIN_SSR_ENABLED  %s\n' "${VIEWER_THIN_SSR_ENABLED}"
printf '  VEXA_LICENSE_ENFORCE     %s\n' "${VEXA_LICENSE_ENFORCE}"
printf '  DICOM storage            %s\n' "${DICOM_STORAGE_PATH}"
printf '  JPEG2000 python          %s\n' "${DICOMWEB_JPEG2000_DECODER_PYTHON}"
printf '  MWL AET/port             %s / %s\n' "${MWL_SCP_AET}" "${MWL_SCP_PORT}"

section "9. Batas file watcher (penting untuk Vite/Metro)"
printf '  kern.maxfiles      %s\n' "$(sysctl -n kern.maxfiles 2>/dev/null || echo '?')"
printf '  kern.maxfilesperproc %s\n' "$(sysctl -n kern.maxfilesperproc 2>/dev/null || echo '?')"
printf '  ulimit -n          %s\n' "$(ulimit -n)"
warn "Bila muncul 'EMFILE: too many open files': naikkan dengan"
echo "        echo 'kern.maxfiles=65536' | sudo tee -a /etc/sysctl.conf"
echo "        echo 'kern.maxfilesperproc=65536' | sudo tee -a /etc/sysctl.conf"
echo "        ulimit -n 65536"

section "10. Log terbaru (5 baris per service)"
for f in "${LOG_DIR}"/*.log; do
  [ -f "$f" ] || continue
  printf '\n  %s%s%s\n' "${C_DIM}" "$(basename "$f")" "${C_RESET}"
  tail -n 5 "$f" | sed 's/^/    /'
done

echo
