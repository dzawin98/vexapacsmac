#!/usr/bin/env bash
# mac/setup.sh — persiapan sekali jalan untuk macOS.
#
#   ./mac/setup.sh              # cek prasyarat + install semua dependency + venv + .env
#   ./mac/setup.sh --deps-only  # hanya dependency (dipakai start-all.sh)
#   ./mac/setup.sh --check      # hanya cek prasyarat, tidak mengubah apa pun
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
load_env_defaults

MODE="full"
case "${1:-}" in
  --deps-only) MODE="deps" ;;
  --check)     MODE="check" ;;
  "")          MODE="full" ;;
  *)           die "opsi tidak dikenal: $1 (pakai --deps-only atau --check)" ;;
esac

FAILED=()

# --------------------------------------------------------------- 1. prasyarat
log "Memeriksa prasyarat…"

if ! require_cmd brew; then
  warn "Homebrew tidak ditemukan. Install dari https://brew.sh lalu ulangi."
  FAILED+=("homebrew")
fi

if require_cmd node; then
  ok "node $(node -v)"
else
  fail "node tidak ada  →  brew install node@20"
  FAILED+=("node")
fi

if require_cmd npm; then ok "npm $(npm -v)"; else fail "npm tidak ada"; FAILED+=("npm"); fi

if require_cmd "${PYTHON_BIN}"; then
  ok "${PYTHON_BIN} $("${PYTHON_BIN}" -V 2>&1 | awk '{print $2}')"
else
  fail "python3 tidak ada  →  brew install python@3.12"
  FAILED+=("python3")
fi

if require_cmd psql; then
  ok "psql $(psql --version | awk '{print $3}')"
else
  fail "psql tidak ada  →  brew install postgresql@16 && brew services start postgresql@16"
  FAILED+=("postgresql")
fi

if pg_isready -h "${DB_HOST}" -p "${DB_PORT}" >/dev/null 2>&1; then
  ok "PostgreSQL listening di ${DB_HOST}:${DB_PORT}"
else
  warn "PostgreSQL belum listening di ${DB_HOST}:${DB_PORT}  →  brew services start postgresql@16"
fi

# Perkakas opsional untuk build native (dicom-dimse-native / DCMTK).
for c in cmake make git; do
  if require_cmd "$c"; then ok "$c"; else warn "$c tidak ada (dibutuhkan hanya jika modul native harus dikompilasi) → brew install $c"; fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  fail "Prasyarat belum lengkap: ${FAILED[*]}"
  exit 1
fi
[ "${MODE}" = "check" ] && { ok "Prasyarat lengkap."; exit 0; }

# ---------------------------------------------------------- 2. dependency node
NODE_APPS=(
  "PACS"
  "RIS/backend"
  "RIS/frontend"
  "DESKTOP VIEWER"
  "DESKTOP VIEWER SSR"
  "MOBILITY VIEWER"
  "ECG VIEWER"
  "tools/backup-agent"
  "tools/simrs-db-bridge"
)

install_node_app() {
  local rel="$1" dir="${ROOT}/$1"
  [ -f "${dir}/package.json" ] || { warn "lewati ${rel} (tidak ada package.json)"; return 0; }
  if [ -d "${dir}/node_modules" ] && [ "${VEXA_FORCE_INSTALL:-0}" != "1" ]; then
    ok "dependency ${rel} sudah ada"
    return 0
  fi
  log "npm install ${rel}…"
  local logfile="${LOG_DIR}/npm-$(echo "${rel}" | tr ' /' '--').log"
  if ( cd "${dir}" && { [ -f package-lock.json ] && npm ci || npm install; } ) >"${logfile}" 2>&1; then
    ok "dependency ${rel} terpasang"
  else
    fail "npm install ${rel} gagal — lihat ${logfile}"
    if grep -qiE "dicom-dimse-native|node-gyp|cmake|dcmtk" "${logfile}"; then
      warn "Modul native dicom-dimse-native butuh toolchain: brew install cmake libiconv"
      warn "Lalu:  cd \"${dir}\" && npm rebuild dicom-dimse-native"
    fi
    NODE_FAILED+=("${rel}")
    return 1
  fi
}

NODE_FAILED=()
for app in "${NODE_APPS[@]}"; do
  install_node_app "${app}" || true
done
if [ "${#NODE_FAILED[@]}" -gt 0 ]; then
  fail "Dependency gagal: ${NODE_FAILED[*]}"
  warn "Perbaiki dulu lalu ulangi ./mac/setup.sh"
  exit 1
fi

# -------------------------------------------------------- 3. venv python PACS
ensure_venv() {
  local venv="$1" req="$2" label="$3" modules="$4"
  if [ ! -x "${venv}/bin/python" ]; then
    log "membuat venv ${label} (${venv})"
    "${PYTHON_BIN}" -m venv "${venv}" || die "gagal membuat venv ${label}"
  fi
  # shellcheck disable=SC2086
  if python_has "${venv}/bin/python" ${modules}; then
    ok "dependency python ${label} sudah ada"
    return 0
  fi
  log "pip install ${label}…"
  "${venv}/bin/python" -m pip install --upgrade pip >/dev/null 2>&1 || true
  "${venv}/bin/python" -m pip install -r "${req}" || die "pip install ${label} gagal"
  ok "dependency python ${label} terpasang"
}

ensure_venv "${PACS_VENV}" "${ROOT}/PACS/requirements-mwl.txt" "PACS/DIMSE+JPEG2000" "pynetdicom pydicom psycopg openjpeg"
ensure_venv "${MWL_VENV}"  "${ROOT}/RIS/backend/mwl_scp/requirements.txt" "MWL SCP" "pynetdicom pydicom"

if ! python_has "${PACS_PYTHON}" openjpeg; then
  warn "modul 'openjpeg' tidak ada di ${PACS_PYTHON}; JPEG2000 (J2K) akan gagal decode."
  warn "Coba: ${PACS_VENV}/bin/pip install --force-reinstall pylibjpeg-openjpeg"
fi

# --------------------------------------------------------------- 4. file .env
[ "${MODE}" = "full" ] || { ok "Dependency siap."; exit 0; }

for app in "DESKTOP VIEWER" "DESKTOP VIEWER SSR" "MOBILITY VIEWER" "RIS/frontend" "RIS/backend"; do
  ensure_app_env "${ROOT}/${app}"
done

mkdir -p "${DATA_DIR}" "${VEXA_PROGRAM_DATA_DIR}"
ok "direktori data: ${DATA_DIR}"

# Backup config awal (dipakai backup-agent + RIS).
if [ ! -f "${VEXA_BACKUP_CONFIG_PATH}" ] && [ -f "${ROOT}/installer/scripts/backup/backup.config.sample.json" ]; then
  cp "${ROOT}/installer/scripts/backup/backup.config.sample.json" "${VEXA_BACKUP_CONFIG_PATH}"
  ok "buat ${VEXA_BACKUP_CONFIG_PATH} dari sample"
fi

"${MAC_DIR}/init-postgres.sh" || warn "init database belum berhasil (bisa diulang: ./mac/init-postgres.sh)"

echo
ok "Setup selesai. Langkah berikutnya:"
echo "  ./mac/build-viewers.sh     # build bundle viewer (sekali, atau setiap UI berubah)"
echo "  ./mac/start-all.sh         # jalankan semua app"
echo
