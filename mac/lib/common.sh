#!/usr/bin/env bash
# mac/lib/common.sh — helper bersama untuk semua skrip launcher macOS.
# Dipakai dengan:  source "$(dirname "$0")/lib/common.sh"
# Tidak ada ketergantungan selain bash 3.2 (bawaan macOS), lsof, curl, psql.

set -o pipefail

# ---------------------------------------------------------------- lokasi repo
_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${_COMMON_DIR}/../.." && pwd)"
export VEXA_ROOT="${ROOT}"

MAC_DIR="${ROOT}/mac"
LOG_DIR="${ROOT}/logs"
PID_DIR="${LOG_DIR}/pids"
RUN_DIR="${ROOT}/.run"
DATA_DIR="${ROOT}/DATA"
PROGRAM_DATA_DIR="${VEXA_PROGRAM_DATA_DIR:-${ROOT}/.programdata}"

mkdir -p "${LOG_DIR}" "${PID_DIR}" "${RUN_DIR}" "${DATA_DIR}" "${PROGRAM_DATA_DIR}"

# ------------------------------------------------------------------- tampilan
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_CYA=$'\033[36m'
else
  C_RESET=''; C_DIM=''; C_RED=''; C_GRN=''; C_YEL=''; C_CYA=''
fi

log()   { printf '%s[%s]%s %s\n' "${C_CYA}" "$(date '+%H:%M:%S')" "${C_RESET}" "$*"; }
ok()    { printf '%s[ OK ]%s %s\n' "${C_GRN}" "${C_RESET}" "$*"; }
warn()  { printf '%s[WARN]%s %s\n' "${C_YEL}" "${C_RESET}" "$*"; }
fail()  { printf '%s[FAIL]%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; }
die()   { fail "$*"; exit 1; }

# ------------------------------------------------------------------ port util
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

port_pid() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

wait_port() {
  local port="$1" timeout="${2:-40}" i=0
  while [ "$i" -lt "$((timeout * 2))" ]; do
    if port_busy "$port"; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

kill_port() {
  local port="$1" pid
  pid="$(port_pid "$port")"
  [ -z "${pid}" ] && return 0
  log "stop port ${port} (pid ${pid})"
  kill "${pid}" 2>/dev/null || true
  local i=0
  while [ "$i" -lt 20 ] && kill -0 "${pid}" 2>/dev/null; do sleep 0.25; i=$((i + 1)); done
  kill -9 "${pid}" 2>/dev/null || true
  return 0
}

# ------------------------------------------------------------- background proc
# start_bg <name> <workdir> <command...>
# - stdout/stderr  -> logs/<name>.log
# - pid            -> logs/pids/<name>.pid
start_bg() {
  local name="$1" workdir="$2"; shift 2
  local logfile="${LOG_DIR}/${name}.log"
  local pidfile="${PID_DIR}/${name}.pid"

  if [ ! -d "${workdir}" ]; then
    fail "${name}: direktori tidak ada: ${workdir}"
    return 1
  fi

  printf '\n===== start %s (%s) =====\n' "${name}" "$(date '+%Y-%m-%d %H:%M:%S')" >>"${logfile}"
  (
    cd "${workdir}" || exit 1
    # `exec` supaya $! adalah PID proses sebenarnya, bukan subshell.
    exec "$@" >>"${logfile}" 2>&1
  ) &
  local pid=$!
  echo "${pid}" >"${pidfile}"
  log "start ${name} → pid ${pid} (log: logs/${name}.log)"
  return 0
}

stop_bg() {
  local name="$1"
  local pidfile="${PID_DIR}/${name}.pid"
  [ -f "${pidfile}" ] || return 0
  local pid
  pid="$(cat "${pidfile}" 2>/dev/null)"
  if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
    log "stop ${name} (pid ${pid})"
    kill "${pid}" 2>/dev/null || true
    local i=0
    while [ "$i" -lt 24 ] && kill -0 "${pid}" 2>/dev/null; do sleep 0.25; i=$((i + 1)); done
    kill -9 "${pid}" 2>/dev/null || true
  fi
  rm -f "${pidfile}"
}

# ---------------------------------------------------------------- environment
load_env_defaults() {
  # shellcheck source=/dev/null
  . "${MAC_DIR}/env.defaults.sh"
}

# Tulis app/.env dari app/.env.example tanpa merusak nilai yang berisi `$`, `#`, `@`.
ensure_app_env() {
  local appdir="$1" example="${appdir}/.env.example" target="${appdir}/.env"
  [ -f "${target}" ] && return 0
  [ -f "${example}" ] || return 0
  cp "${example}" "${target}"
  ok "buat ${appdir#"${ROOT}"/}/.env dari .env.example"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

need_node() {
  require_cmd node || die "node tidak ditemukan. Install Node.js 20+ (brew install node@20) lalu ulangi."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major}" -ge 20 ] || die "Node.js $(node -v) terlalu lama; butuh >= 20."
}

need_python() {
  export PYTHON_BIN="${VEXA_PYTHON:-python3}"
  require_cmd "${PYTHON_BIN}" || die "python3 tidak ditemukan (xcode-select --install atau brew install python@3.12)."
}

need_postgres() {
  require_cmd psql || die "psql tidak ditemukan. brew install postgresql@16 && brew services start postgresql@16"
  pg_isready -h "${DB_HOST}" -p "${DB_PORT}" >/dev/null 2>&1 \
    || die "PostgreSQL tidak merespons di ${DB_HOST}:${DB_PORT}. Jalankan: brew services start postgresql@16"
}

python_has() {
  # python_has <python> <modul...>
  local py="$1"; shift
  "${py}" - "$@" <<'PY' >/dev/null 2>&1
import importlib, sys
for name in sys.argv[1:]:
    importlib.import_module(name)
PY
}
