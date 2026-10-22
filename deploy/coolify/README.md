# VEXA Coolify Test Stack

This directory contains the deployment assets for one Ubuntu VM running a
single Coolify project. The root `docker-compose.coolify.yml` is the source of
truth for the test stack.

## Included services

| Service | Role | Public exposure |
| --- | --- | --- |
| `ris-web` | RIS web application and same-origin reverse proxy | Coolify domain |
| `desktop-viewer` | Browser-based desktop viewer | Coolify domain |
| `mobile-viewer` | Browser-based mobile viewer | Coolify domain |
| `ecg-viewer` | ECG waveform viewer | Coolify domain |
| `pacs` | DICOMweb, DIMSE, QIDO/WADO, MWL | DIMSE host port only |
| `ris-api` | RIS API and workflow service | Internal only |
| `postgres` | RIS and PACS metadata databases | Internal only |

The four browser services receive their own Coolify domain. PACS HTTP stays
private: RIS and both viewers access it through the Compose network. Only the
DIMSE port is mapped to the VM for modalities.

## First Coolify deployment

1. Create a Coolify project named `VEXA Testing` and an environment named
   `testing`.
2. Connect the private GitHub repository through a GitHub App.
3. Add a new application, select **Docker Compose**, and choose
   `docker-compose.coolify.yml` from the repository root.
4. Set the project variable `VEXA_DATA_ROOT` to `/data/vexa-test` for the VM
   test disk. Coolify will create the bind-mount directories on first deploy.
5. Keep `VEXA_LICENSE_ENFORCE=false` for this isolated test only. Production
   must mount `license.lic` and `public.pem` under
   `${VEXA_DATA_ROOT}/license`, then enable enforcement.
6. Deploy. Coolify generates the PostgreSQL and viewer-launch secrets using
   `SERVICE_PASSWORD_*` variables.
7. Assign a domain to `ris-web`, `desktop-viewer`, `mobile-viewer`, and
   `ecg-viewer` from the Coolify service list. Coolify updates the generated
   service URLs used by RIS at the next deployment.
8. Configure the modality to send DIMSE C-STORE to the Ubuntu VM IP, port
   `5757`, and AE Title `VEXATEST` (or the values changed in Coolify).

## Persistent data

`VEXA_DATA_ROOT` is the Linux equivalent of a Windows data drive. For the
test VM it is a local disk path:

```text
/data/vexa-test/dicom         Original DICOM files and MWL mirror
/data/vexa-test/postgres      PostgreSQL database files
/data/vexa-test/ris           RIS application settings
/data/vexa-test/desktop-auth  Desktop viewer user/session store
/data/vexa-test/mobile-auth   Mobile viewer user/session store
/data/vexa-test/license       License and public key, production only
```

When a NAS is available later, mount it into the Ubuntu VM and change only
`VEXA_DATA_ROOT` to that mounted path. Coolify then maps the same folders into
the containers without changing the application code.

## Testing endpoints

After deployment, verify these from the Coolify health indicators or browser:

```text
RIS:             https://<ris-domain>/healthz
RIS API:         internal /api/system/health
Desktop Viewer:  https://<desktop-domain>/api/system/health
Mobile Viewer:   https://<mobile-domain>/api/system/health
ECG Viewer:      https://<ecg-domain>/health
```

Never commit DICOM data, PostgreSQL data, runtime logs, `.env` files, or
license keys. The root `.gitignore` and `.dockerignore` exclude these paths.
