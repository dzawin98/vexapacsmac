#!/usr/bin/env bash
# mac/env.defaults.sh — padanan bagian environment START-ALL-APPS.bat untuk macOS.
#
# Semua nilai di sini bisa ditimpa dari shell sebelum memanggil start-all.sh,
# contoh:  DB_USER=postgres DB_PASS=rahasia ./mac/start-all.sh
# Nilai yang sudah ada di environment TIDAK ditimpa (pakai pola ${VAR:-default}).

# ------------------------------------------------------------------- database
# Homebrew PostgreSQL memakai user macOS Anda dan auth "trust" (tanpa password).
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"
export DB_USER="${DB_USER:-$(whoami)}"
export DB_PASS="${DB_PASS:-}"
export DB_NAME="${DB_NAME:-veloris_db}"

export PACS_DB_HOST="${PACS_DB_HOST:-${DB_HOST}}"
export PACS_DB_PORT="${PACS_DB_PORT:-${DB_PORT}}"
export PACS_DB_USER="${PACS_DB_USER:-${DB_USER}}"
export PACS_DB_PASS="${PACS_DB_PASS:-${DB_PASS}}"
export PACS_DB_NAME="${PACS_DB_NAME:-velopacs_db}"

# --------------------------------------------------------------- direktori data
export VEXA_PROGRAM_DATA_DIR="${VEXA_PROGRAM_DATA_DIR:-${ROOT}/.programdata}"
export DICOM_STORAGE_PATH="${DICOM_STORAGE_PATH:-${ROOT}/DATA}"
export DICOMWEB_PACS_STORAGE_PATH="${DICOMWEB_PACS_STORAGE_PATH:-${DICOM_STORAGE_PATH}}"
mkdir -p "${VEXA_PROGRAM_DATA_DIR}" "${DICOM_STORAGE_PATH}"

# ------------------------------------------------------------------ jaringan
export DICOMWEB_PACS_ROOT="${DICOMWEB_PACS_ROOT:-http://127.0.0.1:5001}"
export DICOMWEB_PACS_RS_ROOT="${DICOMWEB_PACS_RS_ROOT:-http://127.0.0.1:5001/rs}"
export DICOMWEB_PACS_AET="${DICOMWEB_PACS_AET:-VEXA}"
export DICOMWEB_PACS_INTERNAL_AET="${DICOMWEB_PACS_INTERNAL_AET:-VEXA_INT}"
export DICOMWEB_PACS_DICOM_PORT="${DICOMWEB_PACS_DICOM_PORT:-8889}"
export DICOMWEB_PACS_INTERNAL_DICOM_PORT="${DICOMWEB_PACS_INTERNAL_DICOM_PORT:-8890}"
export MWL_PORT="${MWL_PORT:-5656}"
export MWL_SCP_PORT="${MWL_SCP_PORT:-${MWL_PORT}}"
export MWL_SCP_AET="${MWL_SCP_AET:-NEXIARIS}"
export MWL_SCP_BIND="${MWL_SCP_BIND:-0.0.0.0}"

# -------------------------------------------------------- perilaku PACS DIMSE
export DICOMWEB_DIMSE_OUTBOUND_COMPRESSION="${DICOMWEB_DIMSE_OUTBOUND_COMPRESSION:-false}"
export DICOMWEB_DIMSE_STORAGE_COMPRESSION="${DICOMWEB_DIMSE_STORAGE_COMPRESSION:-true}"
export DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX="${DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX:-1.2.840.10008.1.2.4.90}"
export DICOMWEB_RAW_CACHE_ENABLED="${DICOMWEB_RAW_CACHE_ENABLED:-true}"
export DICOMWEB_FRAME_CACHE_MB="${DICOMWEB_FRAME_CACHE_MB:-512}"

# --------------------------------------------------------------------- secret
# Ditulis dengan kutip tunggal eksplisit: nilai aslinya mengandung `#` dan `$`,
# jadi tidak boleh diekspansi oleh shell.
if [ -z "${VEXA_RIS_SHARED_SECRET:-}" ] && [ -z "${NEXIA_RIS_SHARED_SECRET:-}" ]; then
  VEXA_RIS_SHARED_SECRET='Velodesktopview89287579@#$$@'
  NEXIA_RIS_SHARED_SECRET='Velodesktopview89287579@#$$@'
fi
if [ -z "${VEXA_MOBILE_RIS_SHARED_SECRET:-}" ] && [ -z "${NEXIA_MOBILE_RIS_SHARED_SECRET:-}" ]; then
  VEXA_MOBILE_RIS_SHARED_SECRET='Velomobile987397497987#$@$'
  NEXIA_MOBILE_RIS_SHARED_SECRET='Velomobile987397497987#$@$'
fi
export VEXA_RIS_SHARED_SECRET NEXIA_RIS_SHARED_SECRET
export VEXA_MOBILE_RIS_SHARED_SECRET NEXIA_MOBILE_RIS_SHARED_SECRET

# ----------------------------------------------------------------------- SIMRS
export SIMRS_API_KEY="${SIMRS_API_KEY:-vexapacs-simrs-local-2026}"
export SIMRS_DB_BRIDGE_ENABLED="${SIMRS_DB_BRIDGE_ENABLED:-true}"
export SIMRS_DB_BRIDGE_POLL_MS="${SIMRS_DB_BRIDGE_POLL_MS:-5000}"

# ------------------------------------------------------------------ mode viewer
export VIEWER_DEV_MODE="${VIEWER_DEV_MODE:-false}"
export VIEWER_THIN_SSR_ENABLED="${VIEWER_THIN_SSR_ENABLED:-true}"

if [ -z "${MOBILE_DICOMWEB_ROOT:-}" ]; then
  if [ "${VIEWER_THIN_SSR_ENABLED}" = "true" ]; then
    export MOBILE_DICOMWEB_ROOT="http://127.0.0.1:5994"
  else
    export MOBILE_DICOMWEB_ROOT="${DICOMWEB_PACS_ROOT}"
  fi
fi

# --------------------------------------------------------------------- lisensi
# Mode development tidak menegakkan lisensi. Set 1 (dan pasang license.lic +
# public.pem di $VEXA_PROGRAM_DATA_DIR/VEXAPACS) kalau ingin menguji enforcement.
export VEXA_LICENSE_ENFORCE="${VEXA_LICENSE_ENFORCE:-false}"
export VEXA_LICENSE_FILE="${VEXA_LICENSE_FILE:-${VEXA_PROGRAM_DATA_DIR}/VEXAPACS/license.lic}"
export VEXA_LICENSE_PUBLIC_KEY_PATH="${VEXA_LICENSE_PUBLIC_KEY_PATH:-${VEXA_PROGRAM_DATA_DIR}/VEXAPACS/public.pem}"
export VEXA_LICENSE_LOG_SKIPPED="${VEXA_LICENSE_LOG_SKIPPED:-0}"

# ----------------------------------------------------------------------- python
export PYTHON_BIN="${VEXA_PYTHON:-python3}"
export PACS_VENV="${PACS_VENV:-${ROOT}/.venv/pacs}"
export MWL_VENV="${MWL_VENV:-${ROOT}/RIS/backend/mwl_scp/.venv}"
export PACS_PYTHON="${PACS_PYTHON:-${PACS_VENV}/bin/python}"
export MWL_PYTHON="${MWL_PYTHON:-${MWL_VENV}/bin/python}"
# Dekoder JPEG2000 PACS + renderer SSR wajib memakai interpreter yang punya openjpeg.
export DICOMWEB_JPEG2000_DECODER_PYTHON="${DICOMWEB_JPEG2000_DECODER_PYTHON:-${PACS_PYTHON}}"

# ----------------------------------------------------------------------- backup
export VEXA_BACKUP_CONFIG_PATH="${VEXA_BACKUP_CONFIG_PATH:-${VEXA_PROGRAM_DATA_DIR}/backup.config.json}"
export VEXA_BACKUP_SCRIPT_PATH="${VEXA_BACKUP_SCRIPT_PATH:-${ROOT}/mac/backup/backup.sh}"
export VEXA_RESTORE_SCRIPT_PATH="${VEXA_RESTORE_SCRIPT_PATH:-${ROOT}/mac/backup/restore.sh}"

# ------------------------------------------------------------------------ port
export RIS_BACKEND_PORT="${RIS_BACKEND_PORT:-3001}"
export RIS_FRONTEND_PORT="${RIS_FRONTEND_PORT:-8080}"
export BACKUP_AGENT_PORT="${BACKUP_AGENT_PORT:-3099}"
export SIMRS_DB_BRIDGE_PORT="${SIMRS_DB_BRIDGE_PORT:-3109}"
export PACS_HTTP_PORT="${PACS_HTTP_PORT:-5001}"
export MOBILITY_VIEWER_PORT="${MOBILITY_VIEWER_PORT:-5992}"
export DESKTOP_SSR_PORT="${DESKTOP_SSR_PORT:-5994}"
export ECG_VIEWER_PORT="${ECG_VIEWER_PORT:-7771}"

# Viewer diagnostik (5994) menyajikan bundle UI hasil build-nya sendiri.
export VIEWER_DIST_DIR="${VIEWER_DIST_DIR:-${ROOT}/DESKTOP VIEWER SSR/dist}"

# Semua port yang dipakai start-all/stop-all/status.
export VEXA_DEV_PORTS="${VEXA_DEV_PORTS:-3001 3099 3109 5001 5656 5757 5992 5994 7771 8080 8889 8890}"
