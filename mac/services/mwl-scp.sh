#!/usr/bin/env bash
# MWL SCP (Modality Worklist, DICOM C-FIND dari modality) — port 5656, AET NEXIARIS
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
load_env_defaults
[ -x "${MWL_PYTHON}" ] || die "venv MWL belum ada (${MWL_PYTHON}). Jalankan ./mac/setup.sh dulu."
cd "${ROOT}/RIS/backend"
export PORT="${RIS_BACKEND_PORT}"
exec "${MWL_PYTHON}" "${ROOT}/RIS/backend/mwl_scp/vexa_mwl_scp.py"
