#!/usr/bin/env bash
# PACS DIMSE SCP (C-STORE/C-FIND/C-MOVE + MWL) — port 8889 (internal 8890)
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
[ -x "${PACS_PYTHON}" ] || die "venv PACS belum ada (${PACS_PYTHON}). Jalankan ./mac/setup.sh dulu."
cd "${ROOT}/PACS"
exec "${PACS_PYTHON}" scripts/mwl_unified_scp.py
