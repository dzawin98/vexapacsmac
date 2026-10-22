#!/usr/bin/env bash
# mac/backup/backup.sh — backup PostgreSQL + DATA DICOM + programdata (macOS).
#
# Menerima argumen gaya PowerShell yang dikirim tools/backup-agent, supaya agent
# tidak perlu diubah lagi:
#   -ConfigPath <file> -BackupName <nama> -SkipDicomData -SkipProgramData
#   -NoStopServices -NoRetention -JobLogId <id>
#
# Struktur hasil:
#   <backupRoot>/<nama>/db/{veloris_db.dump,velopacs_db.dump}
#   <backupRoot>/<nama>/data/...            (DICOM)
#   <backupRoot>/<nama>/programdata/...     (settings, license, config)
#   <backupRoot>/<nama>/manifest.json
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/common.sh"

CONFIG_PATH="${VEXA_BACKUP_CONFIG_PATH:-${VEXA_PROGRAM_DATA_DIR}/backup.config.json}"
BACKUP_NAME=""
SKIP_DICOM=0
SKIP_PROGRAMDATA=0
NO_RETENTION=0
NO_STOP_SERVICES=0

while [ $# -gt 0 ]; do
  case "$1" in
    -ConfigPath|--config)        CONFIG_PATH="${2:?}"; shift 2 ;;
    -BackupName|--name)          BACKUP_NAME="${2:?}"; shift 2 ;;
    -SkipDicomData|--skip-dicom) SKIP_DICOM=1; shift ;;
    -SkipProgramData|--skip-pd)  SKIP_PROGRAMDATA=1; shift ;;
    -NoRetention|--no-retention) NO_RETENTION=1; shift ;;
    -NoStopServices|--no-stop)   NO_STOP_SERVICES=1; shift ;;
    -JobLogId|--job-log-id)      shift 2 ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) warn "argumen tidak dikenal: $1"; shift ;;
  esac
done

[ -f "${CONFIG_PATH}" ] || die "config backup tidak ada: ${CONFIG_PATH}"
command -v pg_dump >/dev/null || die "pg_dump tidak ada (brew install postgresql@16)"
command -v jq >/dev/null || warn "jq tidak ada; memakai fallback python3 untuk membaca config"

json_get() {
  if command -v jq >/dev/null; then jq -r "$1 // empty" "${CONFIG_PATH}"; else
    "${PYTHON_BIN:-python3}" - "$CONFIG_PATH" "$1" <<'PY'
import json,sys
cfg=json.load(open(sys.argv[1]))
path=sys.argv[2].lstrip('.').split('.')
cur=cfg
for k in path:
    if not isinstance(cur,dict): cur=None; break
    cur=cur.get(k)
print('' if cur is None else cur)
PY
  fi
}

BACKUP_ROOT="$(json_get '.backupRoot')"
DATA_PATH="$(json_get '.dataPath')"
PROGRAM_DATA="$(json_get '.programDataPath')"
DB_HOST_CFG="$(json_get '.postgres.host')"
DB_PORT_CFG="$(json_get '.postgres.port')"
DB_USER_CFG="$(json_get '.postgres.user')"
DB_PASS_CFG="$(json_get '.postgres.password')"
RIS_DB_CFG="$(json_get '.postgres.risDb')"
PACS_DB_CFG="$(json_get '.postgres.pacsDb')"
KEEP_LAST="$(json_get '.retention.keepLast')"

[ -n "${BACKUP_ROOT}" ] || die "backupRoot wajib ada di ${CONFIG_PATH}"
: "${BACKUP_NAME:=$(date '+%Y-%m-%d_%H%M%S')}"
BACKUP_ROOT="${BACKUP_ROOT/#\~/${HOME}}"
BACKUP_PATH="${BACKUP_ROOT}/${BACKUP_NAME}"
DB_DIR="${BACKUP_PATH}/db"

mkdir -p "${DB_DIR}"

log "Backup → ${BACKUP_PATH}"

PGHOST="${DB_HOST_CFG:-127.0.0.1}"; PGPORT="${DB_PORT_CFG:-5432}"
PGUSER="${DB_USER_CFG:-$(whoami)}";     PGPASSWORD="${DB_PASS_CFG:-}"
export PGHOST PGPORT PGUSER PGPASSWORD

dump_db() {
  local db="$1" outfile="$2"
  [ -n "${db}" ] || return 0
  log "pg_dump ${db}"
  pg_dump -Fc -f "${outfile}" "${db}" || die "pg_dump gagal untuk ${db}"
}

dump_db "${RIS_DB_CFG:-${DB_NAME:-veloris_db}}"        "${DB_DIR}/veloris_db.dump"
dump_db "${PACS_DB_CFG:-${PACS_DB_NAME:-velopacs_db}}" "${DB_DIR}/velopacs_db.dump"

INCLUDE_DICOM=false
if [ "${SKIP_DICOM}" -eq 0 ] && [ -n "${DATA_PATH}" ] && [ -d "${DATA_PATH}" ]; then
  INCLUDE_DICOM=true
  log "copy DICOM ${DATA_PATH}"
  mkdir -p "${BACKUP_PATH}/data"
  if command -v rsync >/dev/null; then
    rsync -a --delete "${DATA_PATH%/}/" "${BACKUP_PATH}/data/"
  else
    cp -R "${DATA_PATH%/}/." "${BACKUP_PATH}/data/"
  fi
fi

INCLUDE_PROGRAMDATA=false
if [ "${SKIP_PROGRAMDATA}" -eq 0 ] && [ -n "${PROGRAM_DATA}" ] && [ -d "${PROGRAM_DATA}" ]; then
  INCLUDE_PROGRAMDATA=true
  log "copy programdata ${PROGRAM_DATA}"
  mkdir -p "${BACKUP_PATH}/programdata"
  if command -v rsync >/dev/null; then
    rsync -a --delete --exclude 'logs/' "${PROGRAM_DATA%/}/" "${BACKUP_PATH}/programdata/"
  else
    cp -R "${PROGRAM_DATA%/}/." "${BACKUP_PATH}/programdata/"
    rm -rf "${BACKUP_PATH}/programdata/logs"
  fi
fi

"${PYTHON_BIN:-python3}" - "${BACKUP_PATH}" "${BACKUP_NAME}" "${DATA_PATH}" "${PROGRAM_DATA}" \
  "${INCLUDE_DICOM}" "${INCLUDE_PROGRAMDATA}" "${RIS_DB_CFG}" "${PACS_DB_CFG}" <<'PY'
import json, os, sys, socket, datetime
bp, name, data_path, pd_path, inc_dicom, inc_pd, ris_db, pacs_db = sys.argv[1:9]
manifest = {
    "backupVersion": "1.0",
    "createdAt": datetime.datetime.now().astimezone().isoformat(),
    "backupName": name,
    "machineName": socket.gethostname(),
    "dataPath": data_path,
    "programDataPath": pd_path,
    "includeDicomData": inc_dicom == "true",
    "includeProgramData": inc_pd == "true",
    "databases": {"ris": ris_db, "pacs": pacs_db},
    "stoppedServices": [],
    "platform": sys.platform,
}
json.dump(manifest, open(os.path.join(bp, "manifest.json"), "w"), indent=2)
PY

# Retensi: simpan N backup terbaru.
if [ "${NO_RETENTION}" -eq 0 ]; then
  keep="${KEEP_LAST:-7}"
  case "${keep}" in ''|*[!0-9]*) keep=7 ;; esac
  count=0
  for d in $(ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null); do
    count=$((count + 1))
    if [ "${count}" -gt "${keep}" ]; then
      log "hapus backup lama: ${d}"
      rm -rf "${d}"
    fi
  done
fi

ok "Backup selesai: ${BACKUP_PATH}"
