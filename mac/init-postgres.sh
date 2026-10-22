#!/usr/bin/env bash
# mac/init-postgres.sh — membuat database RIS + PACS (padanan init-postgres.ps1).
# Aman dijalankan berulang: database yang sudah ada dilewati.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
load_env_defaults

need_postgres

psql_run() {
  # psql_run "<sql>"  -> stdout (mode -tA, berhenti pada error)
  PGPASSWORD="${DB_PASS:-}" psql \
    -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres \
    -v ON_ERROR_STOP=1 -tAc "$1"
}

ensure_db() {
  local name="$1"
  [ -n "${name}" ] || die "nama database kosong"
  local exists
  exists="$(psql_run "SELECT 1 FROM pg_database WHERE datname = '${name//\'/\'\'}';" 2>&1)" || {
    fail "tidak bisa terhubung ke PostgreSQL sebagai '${DB_USER}'@${DB_HOST}:${DB_PORT}"
    echo "        pesan: ${exists}"
    echo "        petunjuk:"
    echo "          brew services start postgresql@16"
    echo "          createdb  # atau buat role: createuser -s ${DB_USER}"
    exit 1
  }
  if [ "$(echo "${exists}" | tr -d '[:space:]')" = "1" ]; then
    ok "database sudah ada: ${name}"
    return 0
  fi
  psql_run "CREATE DATABASE \"${name}\" OWNER \"${DB_USER}\";" >/dev/null
  ok "database dibuat: ${name}"
}

log "PostgreSQL ${DB_HOST}:${DB_PORT} sebagai ${DB_USER}"
ensure_db "${DB_NAME}"
ensure_db "${PACS_DB_NAME}"

# Ekstensi yang dipakai RIS/PACS (abaikan bila role tidak berhak).
apply_extensions() {
  local db="$1"
  PGPASSWORD="${DB_PASS:-}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${db}" \
    -v ON_ERROR_STOP=0 -tAc "CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null 2>&1 \
    && ok "ekstensi pg_trgm siap di ${db}" || warn "pg_trgm tidak bisa dibuat di ${db} (opsional)"
}
apply_extensions "${DB_NAME}"
apply_extensions "${PACS_DB_NAME}"

ok "Inisialisasi database selesai."
