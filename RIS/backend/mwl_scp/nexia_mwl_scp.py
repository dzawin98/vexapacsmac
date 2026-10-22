"""Kompatibilitas nama lama.

Berkas ini dulu bernama ``nexia_mwl_scp.py``. Konfigurasi yang masih menunjuk
path lama (mis. service Windows yang sudah terpasang lewat installer) tetap
jalan karena berkas ini hanya menjalankan implementasi barunya.
"""

import os
import runpy
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

if __name__ == "__main__":
    runpy.run_path(os.path.join(_HERE, "vexa_mwl_scp.py"), run_name="__main__")
