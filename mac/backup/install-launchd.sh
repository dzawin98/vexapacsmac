#!/usr/bin/env bash
# mac/backup/install-launchd.sh — jadwalkan backup harian otomatis lewat launchd (macOS).
#   ./mac/backup/install-launchd.sh            # pasang (default 23:00 tiap hari)
#   ./mac/backup/install-launchd.sh 02:30      # jam lain
#   ./mac/backup/install-launchd.sh --uninstall
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults

LABEL="id.vexapacs.backup"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "${PLIST}" 2>/dev/null || true
  rm -f "${PLIST}"
  ok "jadwal backup dihapus (${LABEL})"
  exit 0
fi

AT="${1:-23:00}"
HH="${AT%%:*}"
MM="${AT##*:}"
chmod +x "${MAC_DIR}/backup/backup.sh"

mkdir -p "${HOME}/Library/LaunchAgents"
cat >"${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${MAC_DIR}/backup/backup.sh</string>
    <string>-ConfigPath</string>
    <string>${VEXA_BACKUP_CONFIG_PATH}</string>
    <string>-NoStopServices</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${HH#0}</integer>
    <key>Minute</key><integer>${MM#0}</integer>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/backup-launchd.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/backup-launchd.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST

launchctl unload "${PLIST}" 2>/dev/null || true
launchctl load "${PLIST}"
ok "backup harian dijadwalkan pukul ${AT} (${LABEL})"
echo "  cek   : launchctl list | grep ${LABEL}"
echo "  hapus : ${MAC_DIR}/backup/install-launchd.sh --uninstall"
