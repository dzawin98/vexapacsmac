#!/usr/bin/env bash
# mac/backup/restore.sh — restore dari backup yang dibuat mac/backup/backup.sh.
#
#   -BackupPath <folder>  (wajib)  folder backup berisi manifest.json
#   -ConfigPath <file>    backup.config.json
#   -SkipDatabase -SkipDicomData -SkipProgramData -NoStartServices
#   -ConfirmRestore       (wajib, pengaman)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/common.sh"

CONFIG_PATH="${VEXA_BACKUP_CONFIG_PATH:-${VEXA_PROGRAM_DATA_DIR}/backup.config.json}"
BACKUP_PATH=""
SKIP_DB=0; SKIP_DICOM=0; SKIP_PROGRAMDATA=0; NO_START=0; CONFIRM=0

while [ $# -gt 0 ]; do
  case "$1" in
    -BackupPath|--backup-path) BACKUP_PATH="${2:?}"; shift 2 ;;
    -ConfigPath|--config)      CONFIG_PATH="${2:?}"; shift 2 ;;
    -SkipDatabase|--skip-db)   SKIP_DB=1; shift ;;
    -SkipDicomData|--skip-dicom) SKIP_DICOM=1; shift ;;
    -SkipProgramData|--skip-pd)  SKIP_PROGRAMDATA=1; shift ;;
    -NoStartServices|--no-start) NO_START=1; shift ;;
    -ConfirmRestore|--confirm)  CONFIRM=1; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) warn "argumen tidak dikenal: $1"; shift ;;
  esac
done

[ "${CONFIRM}" -eq 1 ] || die "tambahkan -ConfirmRestore untuk melanjutkan"
[ -n "${BACKUP_PATH}" ] || die "-BackupPath wajib diisi"
[ -d "${BACKUP_PATH}" ] || die "folder backup tidak ada: ${BACKUP_PATH}"
[ -f "${BACKUP_PATH}/manifest.json" ] || die "manifest.json tidak ada di ${BACKUP_PATH}"

json_get() {
  local file="$1" expr="$2"
  if command -v jq >/dev/null; then jq -r "${expr} // empty" "${file}"; else
    "${PYTHON_BIN:-python3}" - "$file" "$expr" <<'PY'
import json,sys
cfg=json.load(open(sys.argv[1]))
cur=cfg
for k in sys.argv[2].lstrip('.').split('.'):
    if not isinstance(cur,dict): cur=None; break
    cur=cur.get(k)
print('' if cur is None else cur)
PY
  fi
}

if [ -f "${CONFIG_PATH}" ]; then
  DATA_PATH="$(json_get "${CONFIG_PATH}" '.dataPath')"
  PROGRAM_DATA="$(json_get "${CONFIG_PATH}" '.programDataPath')"
  DB_HOST_CFG="$(json_get "${CONFIG_PATH}" '.postgres.host')"
  DB_PORT_CFG="$(json_get "${CONFIG_PATH}" '.postgres.port')"
  DB_USER_CFG="$(json_get "${CONFIG_PATH}" '.postgres.user')"
  DB_PASS_CFG="$(json_get "${CONFIG_PATH}" '.postgres.password')"
fi
DATA_PATH="${DATA_PATH:-${DICOM_STORAGE_PATH:-${ROOT}/DATA}}"
PROGRAM_DATA="${PROGRAM_DATA:-${VEXA_PROGRAM_DATA_DIR}}"

PGHOST="${DB_HOST_CFG:-127.0.0.1}"; PGPORT="${DB_PORT_CFG:-5432}"
PGUSER="${DB_USER_CFG:-$(whoami)}";     PGPASSWORD="${DB_PASS_CFG:-}"
export PGHOST PGPORT PGUSER PGPASSWORD

warn "Restore akan MENIMPA data aktif:"
echo "  database : ${PGHOST}:${PGPORT} (user ${PGUSER})"
echo "  DICOM    : ${DATA_PATH}"
echo "  program  : ${PROGRAM_DATA}"
echo "  sumber   : ${BACKUP_PATH}"
echo

if [ "${SKIP_DB}" -eq 0 ]; then
  command -v pg_restore >/dev/null || die "pg_restore tidak ada"
  for f in "${BACKUP_PATH}"/db/*.dump; do
    [ -f "${f}" ] || continue
    base="$(basename "${f}" .dump)"
    db="${base}"
    log "restore database ${db} dari ${f}"
    if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${db}';" | grep -q 1; then
      createdb "${db}" || die "tidak bisa membuat database ${db}"
    fi
    pg_restore --clean --if-exists --no-owner -d "${db}" "${f}" || warn "pg_restore ${db} selesai dengan peringatan"
  done
fi

if [ "${SKIP_DICOM}" -eq 0 ] && [ -d "${BACKUP_PATH}/data" ]; then
  log "restore DICOM → ${DATA_PATH}"
  mkdir -p "${DATA_PATH}"
  if command -v rsync >/dev/null; then
    rsync -a --delete "${BACKUP_PATH}/data/" "${DATA_PATH%/}/"
  else
    rm -rf "${DATA_PATH%/}"/*; cp -R "${BACKUP_PATH}/data/." "${DATA_PATH%/}/"
  fi
fi

if [ "${SKIP_PROGRAMDATA}" -eq 0 ] && [ -d "${BACKUP_PATH}/programdata" ]; then
  log "restore programdata → ${PROGRAM_DATA}"
  mkdir -p "${PROGRAM_DATA}"
  if command -v rsync >/dev/null; then
    rsync -a "${BACKUP_PATH}/programdata/" "${PROGRAM_DATA%/}/"
  else
    cp -R "${BACKUP_PATH}/programdata/." "${PROGRAM_DATA%/}/"
  fi
fi

if [ "${NO_START}" -eq 0 ]; then
  log "menjalankan ulang service…"
  "${SCRIPT_DIR}/../start-all.sh" || warn "start-all.sh mengembalikan error; cek ./mac/status.sh"
fi

ok "Restore selesai."
