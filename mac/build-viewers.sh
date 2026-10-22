#!/usr/bin/env bash
# mac/build-viewers.sh — build bundle produksi viewer (dibutuhkan server statis 5992 & 5994).
#
#   ./mac/build-viewers.sh            # build yang belum ada
#   ./mac/build-viewers.sh --force    # build ulang semuanya
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
load_env_defaults
need_node

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

build_one() {
  local rel="$1" dir="${ROOT}/$1"
  if [ "${FORCE}" -eq 0 ] && [ -f "${dir}/dist/index.html" ]; then
    ok "${rel}: dist sudah ada (lewati)"
    return 0
  fi
  log "build ${rel}…"
  local logfile="${LOG_DIR}/build-$(echo "${rel}" | tr ' /' '--').log"
  if ( cd "${dir}" && npm run build ) >"${logfile}" 2>&1; then
    ok "${rel}: build selesai"
  else
    fail "${rel}: build gagal — lihat ${logfile}"
    tail -n 25 "${logfile}" || true
    return 1
  fi
}

rc=0
build_one "DESKTOP VIEWER SSR" || rc=1
build_one "MOBILITY VIEWER"    || rc=1
exit "${rc}"
