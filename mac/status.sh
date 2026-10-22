#!/usr/bin/env bash
# mac/status.sh — status port + ringkasan proses.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
load_env_defaults

printf '\n%-8s %-9s %s\n' "PORT" "STATE" "PROCESS"
for p in ${VEXA_DEV_PORTS}; do
  pid="$(port_pid "${p}")"
  if [ -n "${pid}" ]; then
    name="$(ps -o comm= -p "${pid}" 2>/dev/null | xargs 2>/dev/null)"
    printf '%-8s %-9s %s\n' "${p}" "UP" "pid ${pid} ${name}"
  else
    printf '%-8s %-9s %s\n' "${p}" "DOWN" "-"
  fi
done
echo

# Kesehatan cepat.
check_http() {
  local label="$1" url="$2"
  if curl -fsS -o /dev/null -m 3 "${url}" 2>/dev/null; then ok "${label} ${url}"; else warn "${label} ${url} (belum merespons)"; fi
}
check_http "PACS DICOMweb" "http://127.0.0.1:${PACS_HTTP_PORT}/rs/studies?limit=1"
check_http "RIS Backend  " "http://127.0.0.1:${RIS_BACKEND_PORT}/api/settings"
check_http "RIS Frontend " "http://127.0.0.1:${RIS_FRONTEND_PORT}/"
echo
