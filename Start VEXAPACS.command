#!/usr/bin/env bash
# Klik dua kali file ini di Finder untuk menjalankan semua app VEXAPACS-RIS.
cd "$(dirname "$0")" || exit 1
./mac/start-all.sh
echo
read -r -p "Tekan Enter untuk menutup jendela ini…" _
