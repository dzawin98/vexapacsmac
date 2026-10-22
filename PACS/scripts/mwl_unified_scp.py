import os
import copy
import subprocess
import sys
import traceback
import json
import re
import socket
import time
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pynetdicom import AE, evt
from pynetdicom.presentation import AllStoragePresentationContexts, StoragePresentationContexts, build_context
from pynetdicom.sop_class import (
    StudyRootQueryRetrieveInformationModelFind,
    StudyRootQueryRetrieveInformationModelGet,
    StudyRootQueryRetrieveInformationModelMove,
    Verification,
)
from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.pixels import get_encoder
from pydicom.uid import (
    DeflatedExplicitVRLittleEndian,
    ExplicitVRBigEndian,
    ExplicitVRLittleEndian,
    HEVCM10P51,
    HEVCMP51,
    HTJ2K,
    HTJ2KLossless,
    HTJ2KLosslessRPCL,
    ImplicitVRLittleEndian,
    JPEG2000,
    JPEG2000Lossless,
    JPEG2000MC,
    JPEG2000MCLossless,
    JPEGBaseline8Bit,
    JPEGExtended12Bit,
    JPEGLSLossless,
    JPEGLSNearLossless,
    JPEGLossless,
    JPEGLosslessSV1,
    MPEG2MPHL,
    MPEG2MPHLF,
    MPEG2MPML,
    MPEG2MPMLF,
    MPEG4HP41,
    MPEG4HP41BD,
    MPEG4HP41BDF,
    MPEG4HP41F,
    MPEG4HP422D,
    MPEG4HP422DF,
    MPEG4HP423D,
    MPEG4HP423DF,
    MPEG4HP42STEREO,
    MPEG4HP42STEREOF,
    RLELossless,
)


BASE_DIR = Path(__file__).resolve().parents[1]
WORKSPACE_DIR = BASE_DIR.parent
BACKEND_ENV_PATH = WORKSPACE_DIR / "RIS" / "backend" / ".env"
EXTERNAL_AET = os.environ.get("DICOMWEB_EXTERNAL_AET", "VEXA")
EXTERNAL_HOST = os.environ.get("DICOMWEB_EXTERNAL_HOST", "0.0.0.0")
EXTERNAL_PORT = int(os.environ.get("DICOMWEB_EXTERNAL_PORT", "8889"))
INTERNAL_AET = os.environ.get("DICOMWEB_INTERNAL_AET", "VEXA_INT")
INTERNAL_HOST = os.environ.get("DICOMWEB_INTERNAL_HOST", "127.0.0.1")
INTERNAL_PORT = int(os.environ.get("DICOMWEB_INTERNAL_PORT", "8890"))
REQUIRE_CALLED_AET = os.environ.get("DICOMWEB_REQUIRE_CALLED_AET", "true").strip().lower() not in {"0", "false", "no", "off"}
LOG_PATH = Path(os.environ.get("DICOMWEB_FRONT_LOG", BASE_DIR / "logs" / "front-scp.log"))
STORAGE_DIR = Path(os.environ.get("DICOMWEB_PACS_STORAGE_PATH", BASE_DIR / "data"))
RIS_BACKEND_ROOT = os.environ.get("RIS_BACKEND_ROOT", f"http://127.0.0.1:{os.environ.get('PORT', '3001')}").rstrip("/")
INTERNAL_LOG_KEY = os.environ.get("DICOM_TRAFFIC_INTERNAL_KEY", os.environ.get("MWL_SCP_INTERNAL_KEY", ""))
DIMSE_OUTBOUND_COMPRESSION = os.environ.get("DICOMWEB_DIMSE_OUTBOUND_COMPRESSION", "false").strip().lower() in {"1", "true", "yes", "on"}
DIMSE_STORAGE_COMPRESSION = os.environ.get("DICOMWEB_DIMSE_STORAGE_COMPRESSION", "true").strip().lower() in {"1", "true", "yes", "on"}
SUPPORTED_STORAGE_COMPRESSION_TRANSFER_SYNTAXES = {
    str(JPEG2000Lossless): "JPEG 2000 Lossless",
    str(JPEGLSLossless): "JPEG-LS Lossless",
}
DIMSE_STORAGE_TRANSFER_SYNTAX = os.environ.get(
    "DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX",
    str(JPEG2000Lossless),
).strip()
if DIMSE_STORAGE_TRANSFER_SYNTAX not in SUPPORTED_STORAGE_COMPRESSION_TRANSFER_SYNTAXES:
    DIMSE_STORAGE_TRANSFER_SYNTAX = str(JPEG2000Lossless)
DIMSE_OUTBOUND_TRANSFER_SYNTAXES = [JPEG2000Lossless, JPEGLosslessSV1, ExplicitVRLittleEndian]


def enforce_license(module: str) -> None:
    enforce = os.environ.get("VEXA_LICENSE_ENFORCE", os.environ.get("VELO_LICENSE_ENFORCE", "")).strip().lower()
    node_env = os.environ.get("NODE_ENV", "").strip().lower()
    if enforce in {"0", "false", "no", "off"}:
        return
    if enforce not in {"1", "true", "yes", "on"} and node_env != "production":
        print(f"[license] Enforcement belum aktif untuk modul {module}. Set VEXA_LICENSE_ENFORCE=true saat production.")
        return
    cli_path = WORKSPACE_DIR / "scripts" / "license" / "license-cli.js"
    try:
        subprocess.run(
            ["node", str(cli_path), "check", "--module", module],
            check=True,
            cwd=str(WORKSPACE_DIR),
        )
    except FileNotFoundError as exc:
        raise SystemExit("[license] Node.js tidak ditemukan untuk validasi license PACS.") from exc
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"[license] License invalid untuk modul {module}.") from exc


def load_env_file(path):
    try:
        if not path.exists():
            return
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
    except Exception:
        pass


load_env_file(BACKEND_ENV_PATH)
enforce_license("PACS_DIMSE")


def configure_called_aet_requirement(ae, expected_aet):
    if not REQUIRE_CALLED_AET:
        log(f"[DICOM] strict called AET disabled; AE={expected_aet}")
        return
    if not hasattr(ae, "require_called_aet"):
        log("[DICOM] warning: pynetdicom does not expose require_called_aet; Called AET cannot be enforced")
        return
    try:
        ae.require_called_aet = True
        log(f"[DICOM] strict called AET enabled; only Called AET={expected_aet} is accepted")
    except Exception as exc:
        log(f"[DICOM] warning: failed to enable strict called AET for {expected_aet}: {exc}")

PACS_DB_CONFIG = {
    "host": os.environ.get("PACS_DB_HOST", "localhost"),
    "port": int(os.environ.get("PACS_DB_PORT", "5432")),
    "user": os.environ.get("PACS_DB_USER", "postgres"),
    "password": os.environ.get("PACS_DB_PASS", "velo"),
    "database": os.environ.get("PACS_DB_NAME", "velopacs_db"),
}
RIS_DB_CONFIG = {
    "host": os.environ.get("DB_HOST", "localhost"),
    "port": int(os.environ.get("DB_PORT", "5432")),
    "user": os.environ.get("DB_USER", "postgres"),
    "password": os.environ.get("DB_PASS", "velo"),
    "database": os.environ.get("DB_NAME", "veloris_db"),
}

SUPPORTED_STORAGE_TRANSFER_SYNTAXES = [
    ImplicitVRLittleEndian,
    ExplicitVRLittleEndian,
    DeflatedExplicitVRLittleEndian,
    ExplicitVRBigEndian,
    JPEGBaseline8Bit,
    JPEGExtended12Bit,
    JPEGLossless,
    JPEGLosslessSV1,
    JPEGLSLossless,
    JPEGLSNearLossless,
    JPEG2000Lossless,
    JPEG2000,
    JPEG2000MCLossless,
    JPEG2000MC,
    HTJ2KLossless,
    HTJ2KLosslessRPCL,
    HTJ2K,
    RLELossless,
    MPEG2MPML,
    MPEG2MPHL,
    MPEG2MPMLF,
    MPEG2MPHLF,
    MPEG4HP41,
    MPEG4HP41BD,
    MPEG4HP422D,
    MPEG4HP423D,
    MPEG4HP42STEREO,
    MPEG4HP41F,
    MPEG4HP41BDF,
    MPEG4HP422DF,
    MPEG4HP423DF,
    MPEG4HP42STEREOF,
    HEVCMP51,
    HEVCM10P51,
]


def log(message):
    text_line = str(message)
    print(text_line, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(text_line + "\n")
    except Exception:
        pass


def text(value):
    return "" if value is None else str(value).strip()


def dcm_text(ds, name):
    value = getattr(ds, name, None)
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return "\\".join(str(item) for item in value)
    return str(value)


def compact_json(value):
    try:
        return json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    except Exception:
        return text(value)


def http_json(method, url, payload=None):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if INTERNAL_LOG_KEY:
        headers["X-VEXA-DICOM-LOG-Key"] = INTERNAL_LOG_KEY
    request = Request(url, data=data, headers=headers, method=method)
    with urlopen(request, timeout=3) as response:
        raw = response.read().decode("utf-8", errors="ignore")
        return json.loads(raw) if raw else None


def write_dicom_traffic_log(event_type, outcome, event=None, dataset=None, status_code=None, message=None, error_message=None, details=None, destination_ae_title=None):
    try:
        payload = {
            "service": "PACS_DIMSE",
            "eventType": event_type,
            "outcome": outcome,
            "statusCode": status_code,
            "message": message,
            "errorMessage": error_message,
            "destinationAeTitle": destination_ae_title,
            "details": details or {},
        }
        if event is not None:
            payload.update({
                "callingAeTitle": assoc_value(event, "requestor", "ae_title"),
                "calledAeTitle": assoc_value(event, "acceptor", "ae_title") or EXTERNAL_AET,
                "remoteAddress": requestor_address(event),
                "remotePort": requestor_port(event),
            })
        if dataset is not None:
            payload.update({
                "patientId": dcm_text(dataset, "PatientID"),
                "patientName": dcm_text(dataset, "PatientName"),
                "accessionNumber": dcm_text(dataset, "AccessionNumber"),
                "studyInstanceUid": dcm_text(dataset, "StudyInstanceUID"),
                "seriesInstanceUid": dcm_text(dataset, "SeriesInstanceUID"),
                "sopInstanceUid": dcm_text(dataset, "SOPInstanceUID"),
                "sopClassUid": dcm_text(dataset, "SOPClassUID"),
                "modality": dcm_text(dataset, "Modality"),
            })
        try:
            transfer_syntax = getattr(getattr(event, "context", None), "transfer_syntax", None) if event is not None else None
            if transfer_syntax:
                payload["transferSyntax"] = text(transfer_syntax)
        except Exception:
            pass
        http_json("POST", f"{RIS_BACKEND_ROOT}/api/internal/dicom/traffic-log", payload)
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        log(f"[DICOM-LOG] failed to write traffic log: {error}")
    except Exception as error:
        log(f"[DICOM-LOG] failed to build traffic log: {error}")


def db_connect(config):
    import psycopg
    from psycopg.rows import dict_row

    params = dict(config)
    params["dbname"] = params.pop("database")
    return psycopg.connect(**params, row_factory=dict_row)


def assoc_value(event, owner_name, field_name, default=""):
    try:
        owner = getattr(event.assoc, owner_name, None)
        value = getattr(owner, field_name, default)
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="ignore").strip()
        return text(value)
    except Exception:
        return default


def requestor_address(event):
    for attr_name in ("address", "addr", "host"):
        value = assoc_value(event, "requestor", attr_name)
        if value:
            return value
    try:
        sock = getattr(event.assoc, "requestor", None)
        primitive = getattr(sock, "primitive", None)
        return text(getattr(primitive, "calling_presentation_address", ""))
    except Exception:
        return ""


def requestor_port(event):
    value = assoc_value(event, "requestor", "port")
    if not value:
        return None
    try:
        return int(value)
    except Exception:
        return None


def requestor_label(event):
    calling_ae = assoc_value(event, "requestor", "ae_title") or "UNKNOWN_AE"
    address = requestor_address(event) or "unknown-host"
    port = requestor_port(event)
    port_suffix = f":{port}" if port is not None else ""
    return f"{calling_ae} {address}{port_suffix}"


def summarize_presentation_contexts(contexts):
    summary = []
    for context in contexts or []:
        try:
            transfer_syntaxes = getattr(context, "transfer_syntax", None) or getattr(context, "transfer_syntaxes", None) or []
            if not isinstance(transfer_syntaxes, (list, tuple)):
                transfer_syntaxes = [transfer_syntaxes]
            item = {
                "id": getattr(context, "context_id", None),
                "abstractSyntax": text(getattr(context, "abstract_syntax", "")),
                "transferSyntaxes": [text(item) for item in transfer_syntaxes if text(item)],
            }
            result = getattr(context, "result", None)
            if result is not None:
                item["result"] = result
            as_scu = getattr(context, "as_scu", None)
            as_scp = getattr(context, "as_scp", None)
            if as_scu is not None:
                item["as_scu"] = bool(as_scu)
            if as_scp is not None:
                item["as_scp"] = bool(as_scp)
            summary.append(item)
        except Exception:
            continue
    return summary


def prepare_dataset_for_direct_storage(ds):
    if not DIMSE_STORAGE_COMPRESSION or "PixelData" not in ds:
        return ds

    current_transfer_syntax = text(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", ""))
    if current_transfer_syntax == DIMSE_STORAGE_TRANSFER_SYNTAX:
        return ds

    started = time.perf_counter()
    candidate = copy.deepcopy(ds)
    try:
        transfer_syntax = getattr(getattr(candidate, "file_meta", None), "TransferSyntaxUID", ImplicitVRLittleEndian)
        if getattr(transfer_syntax, "is_compressed", False):
            candidate.decompress()
        candidate.compress(DIMSE_STORAGE_TRANSFER_SYNTAX, generate_instance_uid=False)
        log(
            f"[STORE] direct fallback transcoded TS={current_transfer_syntax or 'unknown'}->{DIMSE_STORAGE_TRANSFER_SYNTAX} "
            f"profile={SUPPORTED_STORAGE_COMPRESSION_TRANSFER_SYNTAXES[DIMSE_STORAGE_TRANSFER_SYNTAX]} "
            f"elapsedMs={(time.perf_counter() - started) * 1000:.1f}"
        )
        return candidate
    except Exception as exc:
        log(
            f"[STORE] direct fallback compression unavailable for TS={DIMSE_STORAGE_TRANSFER_SYNTAX}; "
            f"preserving received DICOM: {exc}"
        )
        return ds


def direct_store_to_dicomweb_pacs(ds):
    study_uid = dcm_text(ds, "StudyInstanceUID")
    series_uid = dcm_text(ds, "SeriesInstanceUID")
    sop_uid = dcm_text(ds, "SOPInstanceUID")
    if not study_uid or not series_uid or not sop_uid:
        raise ValueError("Missing StudyInstanceUID, SeriesInstanceUID, or SOPInstanceUID")
    study_dir = STORAGE_DIR / study_uid
    study_dir.mkdir(parents=True, exist_ok=True)
    storage_path = study_dir / sop_uid
    stored_dataset = prepare_dataset_for_direct_storage(ds)
    stored_dataset.save_as(str(storage_path), write_like_original=False)
    log(f"[STORE] direct stored SOPInstanceUID={sop_uid} path={storage_path}")


def log_archived_instance(ds, incoming_transfer_syntax, incoming_pixel_bytes, started):
    study_uid = dcm_text(ds, "StudyInstanceUID")
    sop_uid = dcm_text(ds, "SOPInstanceUID")
    storage_path = STORAGE_DIR / study_uid / sop_uid
    try:
        stored_transfer_syntax = text(dcmread(storage_path, stop_before_pixels=True).file_meta.TransferSyntaxUID)
        stored_file_bytes = storage_path.stat().st_size
        log(
            f"[STORE] archived SOPInstanceUID={sop_uid} TS={text(incoming_transfer_syntax)}->{stored_transfer_syntax} "
            f"incomingPixelBytes={incoming_pixel_bytes} storedFileBytes={stored_file_bytes} "
            f"elapsedMs={(time.perf_counter() - started) * 1000:.1f}"
        )
    except Exception as exc:
        log(f"[STORE] archived SOPInstanceUID={sop_uid}; metrics unavailable: {exc}")


def wildcard_match(value, pattern):
    candidate = text(value)
    query = text(pattern)
    if not query:
        return True
    regex = "^" + re.escape(query).replace(r"\*", ".*").replace(r"\?", ".") + "$"
    return re.match(regex, candidate, flags=re.IGNORECASE) is not None


def query_level(identifier):
    return text(getattr(identifier, "QueryRetrieveLevel", "STUDY")).upper() or "STUDY"


def study_matches(row, identifier):
    return all(
        [
            wildcard_match(row.get("patient_name"), dcm_text(identifier, "PatientName")),
            wildcard_match(row.get("patient_id"), dcm_text(identifier, "PatientID")),
            wildcard_match(row.get("accession_number"), dcm_text(identifier, "AccessionNumber")),
            wildcard_match(row.get("study_instance_uid"), dcm_text(identifier, "StudyInstanceUID")),
            wildcard_match(row.get("study_date"), dcm_text(identifier, "StudyDate")),
        ]
    )


def series_matches(row, identifier):
    return all(
        [
            wildcard_match(row.get("study_instance_uid"), dcm_text(identifier, "StudyInstanceUID")),
            wildcard_match(row.get("series_instance_uid"), dcm_text(identifier, "SeriesInstanceUID")),
            wildcard_match(row.get("modality"), dcm_text(identifier, "Modality")),
        ]
    )


def instance_matches(row, identifier):
    return all(
        [
            wildcard_match(row.get("study_instance_uid"), dcm_text(identifier, "StudyInstanceUID")),
            wildcard_match(row.get("series_instance_uid"), dcm_text(identifier, "SeriesInstanceUID")),
            wildcard_match(row.get("sop_instance_uid"), dcm_text(identifier, "SOPInstanceUID")),
        ]
    )


def response_dataset(row, level):
    ds = Dataset()
    ds.QueryRetrieveLevel = level
    if level == "STUDY":
        ds.PatientName = row.get("patient_name") or ""
        ds.PatientID = row.get("patient_id") or ""
        ds.StudyInstanceUID = row.get("study_instance_uid") or ""
        ds.AccessionNumber = row.get("accession_number") or ""
        ds.StudyDate = row.get("study_date") or ""
        ds.StudyTime = row.get("study_time") or ""
        ds.ModalitiesInStudy = row.get("modality_list") or ""
        ds.StudyDescription = row.get("study_description") or ""
        ds.NumberOfStudyRelatedSeries = int(row.get("series_count") or 0)
        ds.NumberOfStudyRelatedInstances = int(row.get("instance_count") or 0)
    elif level == "SERIES":
        ds.StudyInstanceUID = row.get("study_instance_uid") or ""
        ds.SeriesInstanceUID = row.get("series_instance_uid") or ""
        ds.Modality = row.get("modality") or ""
        ds.SeriesNumber = row.get("series_number") or ""
        ds.SeriesDescription = row.get("series_description") or ""
        ds.NumberOfSeriesRelatedInstances = int(row.get("instance_count") or 0)
    elif level == "IMAGE":
        ds.StudyInstanceUID = row.get("study_instance_uid") or ""
        ds.SeriesInstanceUID = row.get("series_instance_uid") or ""
        ds.SOPInstanceUID = row.get("sop_instance_uid") or ""
        ds.SOPClassUID = row.get("sop_class_uid") or ""
        ds.InstanceNumber = row.get("instance_number") or ""
    return ds


def find_rows(level, identifier):
    table_by_level = {
        "STUDY": "pacs_studies",
        "SERIES": "pacs_series",
        "IMAGE": "pacs_instances",
    }
    table = table_by_level.get(level)
    if not table:
        return []
    with db_connect(PACS_DB_CONFIG) as connection:
        with connection.cursor() as cursor:
            cursor.execute(f"SELECT * FROM {table}")
            rows = cursor.fetchall()
    matcher = {
        "STUDY": study_matches,
        "SERIES": series_matches,
        "IMAGE": instance_matches,
    }[level]
    return [row for row in rows if matcher(row, identifier)]


def destination_for_aet(aet):
    requested_aet = text(aet)
    if not requested_aet:
        return None
    with db_connect(RIS_DB_CONFIG) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT aet, host, port
                FROM dicom_nodes
                WHERE enabled = 1 AND UPPER(aet) = UPPER(%s)
                LIMIT 1
                """,
                (requested_aet,),
            )
            return cursor.fetchone()


def registered_requestor_node(event):
    calling_aet = assoc_value(event, "requestor", "ae_title")
    remote_ip = requestor_address(event)
    if not calling_aet or not remote_ip:
        return None
    with db_connect(RIS_DB_CONFIG) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, name, aet, host, port
                FROM dicom_nodes
                WHERE enabled = 1
                  AND UPPER(aet) = UPPER(%s)
                """,
                (calling_aet,),
            )
            rows = cursor.fetchall()
    for row in rows:
        configured_host = text(row.get("host"))
        if configured_host == remote_ip:
            return row
        try:
            if socket.gethostbyname(configured_host) == remote_ip:
                return row
        except Exception:
            continue
    return None


def move_instance_rows(level, identifier):
    study_uid = dcm_text(identifier, "StudyInstanceUID")
    series_uid = dcm_text(identifier, "SeriesInstanceUID")
    sop_uid = dcm_text(identifier, "SOPInstanceUID")
    if level == "STUDY":
        where_clause = "study_instance_uid = %s"
        params = (study_uid,)
    elif level == "SERIES":
        where_clause = "study_instance_uid = %s AND series_instance_uid = %s"
        params = (study_uid, series_uid)
    elif level == "IMAGE":
        where_clause = "study_instance_uid = %s AND series_instance_uid = %s AND sop_instance_uid = %s"
        params = (study_uid, series_uid, sop_uid)
    else:
        return []
    if any(not item for item in params):
        return []
    with db_connect(PACS_DB_CONFIG) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT sop_instance_uid, sop_class_uid, file_path
                FROM pacs_instances
                WHERE {where_clause}
                ORDER BY series_instance_uid ASC, instance_number ASC, sop_instance_uid ASC
                """,
                params,
            )
            return cursor.fetchall()


def encoder_available(transfer_syntax):
    if transfer_syntax == ExplicitVRLittleEndian:
        return True
    try:
        return bool(get_encoder(transfer_syntax).is_available)
    except Exception:
        return False


def outbound_transfer_syntaxes():
    if not DIMSE_OUTBOUND_COMPRESSION:
        return [ExplicitVRLittleEndian]
    # JPEG Lossless Process 14 SV1 can still be sent without an encoder when
    # the archived instance already uses that syntax (safe pass-through).
    return list(DIMSE_OUTBOUND_TRANSFER_SYNTAXES)


def context_transfer_syntax(context):
    value = getattr(context, "transfer_syntax", "")
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return text(value)


def move_destination_contexts(rows, transfer_syntaxes=None):
    sop_classes = sorted({text(row.get("sop_class_uid")) for row in rows if text(row.get("sop_class_uid"))})
    syntaxes = transfer_syntaxes or outbound_transfer_syntaxes()
    return [build_context(sop_class_uid, syntaxes) for sop_class_uid in sop_classes]


def negotiate_move_transfer_syntaxes(destination, rows):
    syntaxes = outbound_transfer_syntaxes()
    ae = AE(ae_title=EXTERNAL_AET)
    sop_classes = sorted({text(row.get("sop_class_uid")) for row in rows if text(row.get("sop_class_uid"))})
    for sop_class in sop_classes:
        for syntax in syntaxes:
            ae.add_requested_context(sop_class, [syntax])
    assoc = ae.associate(destination["host"], int(destination["port"]), ae_title=destination["aet"])
    if not assoc.is_established:
        raise RuntimeError(f"destination association rejected by {destination['aet']}")
    try:
        accepted = {}
        for context in assoc.accepted_contexts:
            accepted.setdefault(text(context.abstract_syntax), []).append(context_transfer_syntax(context))
    finally:
        assoc.release()
    selected = {}
    for sop_class in sop_classes:
        class_rows = [row for row in rows if text(row.get("sop_class_uid")) == sop_class]
        source_syntaxes = {
            text(getattr(getattr(dcmread(row["file_path"], stop_before_pixels=True), "file_meta", None), "TransferSyntaxUID", ImplicitVRLittleEndian))
            for row in class_rows
        }
        for syntax in syntaxes:
            syntax_text = text(syntax)
            can_prepare = encoder_available(syntax) or source_syntaxes == {syntax_text}
            if syntax_text in accepted.get(sop_class, []) and can_prepare:
                selected[sop_class] = syntax_text
                break
    missing = sorted(set(sop_classes) - set(selected))
    if missing:
        raise RuntimeError(f"destination rejected storage context(s): {missing}")
    log(f"[MOVE] negotiated destination={destination['aet']} transferSyntaxes={compact_json(selected)}")
    return selected


def handle_echo(event):
    log(f"[DICOM] echo from {requestor_label(event)}")
    write_dicom_traffic_log("C_ECHO", "SUCCESS", event=event, status_code="0x0000", message="C-ECHO succeeded")
    return 0x0000


def handle_accepted(event):
    log(f"[DICOM] association accepted from {requestor_label(event)} to {assoc_value(event, 'acceptor', 'ae_title') or EXTERNAL_AET}")
    try:
        accepted = summarize_presentation_contexts(getattr(event.assoc, "accepted_contexts", []) or [])
        rejected = summarize_presentation_contexts(getattr(event.assoc, "rejected_contexts", []) or [])
        if accepted:
            log(f"[DICOM] accepted contexts for {requestor_label(event)}: {compact_json(accepted)}")
        if rejected:
            log(f"[DICOM] rejected contexts for {requestor_label(event)}: {compact_json(rejected)}")
        write_dicom_traffic_log(
            "ASSOCIATION_ACCEPTED",
            "SUCCESS",
            event=event,
            message="DICOM association accepted",
            details={"acceptedContexts": accepted, "rejectedContexts": rejected},
        )
    except Exception as exc:
        log(f"[DICOM] failed to summarize contexts for {requestor_label(event)}: {exc}")
        write_dicom_traffic_log("ASSOCIATION_ACCEPTED", "WARNING", event=event, message="Association accepted but context summary failed", error_message=str(exc))


def handle_released(event):
    log(f"[DICOM] association released from {requestor_label(event)}")
    write_dicom_traffic_log("ASSOCIATION_RELEASED", "SUCCESS", event=event, message="DICOM association released")


def handle_aborted(event):
    log(f"[DICOM] association aborted from {requestor_label(event)}")
    write_dicom_traffic_log("ASSOCIATION_ABORTED", "FAILED", event=event, message="DICOM association aborted", error_message="Association aborted by peer or network")


def handle_store(event):
    started = time.perf_counter()
    try:
        ds = event.dataset
        ds.file_meta = event.file_meta
        incoming_transfer_syntax = context_transfer_syntax(event.context)
        incoming_pixel_bytes = len(ds.PixelData) if "PixelData" in ds else 0
        transfer_syntaxes = list(
            dict.fromkeys(
                [
                    str(item)
                    for item in [
                        incoming_transfer_syntax,
                        ImplicitVRLittleEndian,
                        ExplicitVRLittleEndian,
                        ExplicitVRBigEndian,
                    ]
                    if item
                ]
            )
        )
        log(
            f"[STORE] received SOPInstanceUID={getattr(ds, 'SOPInstanceUID', '')} "
            f"SOPClassUID={getattr(ds, 'SOPClassUID', '')} TS={incoming_transfer_syntax}"
        )
        write_dicom_traffic_log("C_STORE_RECEIVED", "RECEIVED", event=event, dataset=ds, message="C-STORE request received")

        ae = AE(ae_title=EXTERNAL_AET)
        ae.add_requested_context(ds.SOPClassUID, transfer_syntaxes)
        assoc = ae.associate(INTERNAL_HOST, INTERNAL_PORT, ae_title=INTERNAL_AET)
        if not assoc.is_established:
            log(
                f"[STORE] failed to connect internal dicomweb-pacs store SCP "
                f"for SOPClassUID={getattr(ds, 'SOPClassUID', '')} TS={incoming_transfer_syntax}; using direct storage"
            )
            direct_store_to_dicomweb_pacs(ds)
            log_archived_instance(ds, incoming_transfer_syntax, incoming_pixel_bytes, started)
            write_dicom_traffic_log(
                "C_STORE",
                "SUCCESS",
                event=event,
                dataset=ds,
                status_code="0x0000",
                message="Internal store unavailable; direct storage fallback succeeded",
                error_message="Internal DICOMweb PACS SCP association failed",
            )
            return 0x0000
        try:
            try:
                status = assoc.send_c_store(ds)
                code = int(getattr(status, "Status", 0xC000))
                log(
                    f"[STORE] forwarded SOPInstanceUID={getattr(ds, 'SOPInstanceUID', '')} "
                    f"SOPClassUID={getattr(ds, 'SOPClassUID', '')} TS={event.context.transfer_syntax} "
                    f"status=0x{code:04X}"
                )
                if code == 0x0000:
                    log_archived_instance(ds, incoming_transfer_syntax, incoming_pixel_bytes, started)
                    write_dicom_traffic_log("C_STORE", "SUCCESS", event=event, dataset=ds, status_code="0x0000", message="C-STORE forwarded to internal PACS")
                    return code
                log(f"[STORE] internal C-STORE non-success status=0x{code:04X}; using direct storage")
            except Exception as exc:
                log(f"[STORE] internal C-STORE exception; using direct storage: {exc}")
                log(traceback.format_exc())
            direct_store_to_dicomweb_pacs(ds)
            log_archived_instance(ds, incoming_transfer_syntax, incoming_pixel_bytes, started)
            write_dicom_traffic_log("C_STORE", "SUCCESS", event=event, dataset=ds, status_code="0x0000", message="Direct storage fallback succeeded after internal C-STORE failure")
            return 0x0000
        finally:
            assoc.release()
    except Exception as exc:
        log(f"[STORE] exception: {exc}")
        log(traceback.format_exc())
        write_dicom_traffic_log("C_STORE", "FAILED", event=event if 'event' in locals() else None, status_code="0xC000", error_message=str(exc))
        return 0xC000


def handle_find(event):
    identifier = event.identifier
    level = query_level(identifier)
    requestor_node = registered_requestor_node(event)
    if not requestor_node:
        log(
            f"[FIND] rejected unregistered caller={requestor_label(event)} "
            f"reason=calling AE and remote IP must match an enabled DICOM node"
        )
        write_dicom_traffic_log("C_FIND", "FAILED", event=event, dataset=identifier, status_code="0xC000", error_message="Calling AE and remote IP must match an enabled DICOM node")
        yield 0xC000, None
        return
    if level not in {"STUDY", "SERIES", "IMAGE"}:
        log(f"[FIND] unsupported level={level} from {requestor_label(event)}")
        write_dicom_traffic_log("C_FIND", "FAILED", event=event, dataset=identifier, status_code="0xC000", error_message=f"Unsupported query level {level}")
        yield 0xC000, None
        return
    try:
        rows = find_rows(level, identifier)
        log(
            f"[FIND] caller={requestor_label(event)} node={requestor_node['name']} level={level} "
            f"matches={len(rows)} patient={dcm_text(identifier, 'PatientName') or ''} "
            f"patientId={dcm_text(identifier, 'PatientID') or ''} "
            f"accession={dcm_text(identifier, 'AccessionNumber') or ''} "
            f"studyUid={dcm_text(identifier, 'StudyInstanceUID') or ''}"
        )
        write_dicom_traffic_log(
            "C_FIND",
            "SUCCESS" if rows else "NO_MATCH",
            event=event,
            dataset=identifier,
            status_code="0xFF00" if rows else "0x0000",
            message=f"C-FIND {level} returned {len(rows)} match(es)",
            details={"queryLevel": level, "matchCount": len(rows), "node": requestor_node.get("name")},
        )
        for row in rows:
            yield 0xFF00, response_dataset(row, level)
        yield 0x0000, None
    except Exception as exc:
        log(f"[FIND] exception: {exc}")
        log(traceback.format_exc())
        write_dicom_traffic_log("C_FIND", "FAILED", event=event, dataset=identifier, status_code="0xC000", error_message=str(exc))
        yield 0xC000, None


def prepare_dataset_for_retrieval(ds, requested_transfer_syntax):
    started = time.perf_counter()
    original_character_set = getattr(ds, "original_character_set", None) or "iso8859"
    input_bytes = len(ds.PixelData) if "PixelData" in ds else 0
    source_transfer_syntax = getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", None)
    original_transfer_syntax = text(source_transfer_syntax) or text(ImplicitVRLittleEndian)
    requested_transfer_syntax = text(requested_transfer_syntax)

    if original_transfer_syntax == requested_transfer_syntax:
        output_bytes = len(ds.PixelData) if "PixelData" in ds else 0
        return ds, original_transfer_syntax, input_bytes, output_bytes, time.perf_counter() - started

    if getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", ImplicitVRLittleEndian).is_compressed:
        ds.decompress()

    if requested_transfer_syntax == text(ExplicitVRLittleEndian):
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.is_implicit_VR = False
        ds.is_little_endian = True
    else:
        ds.compress(requested_transfer_syntax, generate_instance_uid=False)
    # pynetdicom also inspects the dataset's original encoding when choosing
    # a presentation context. Files read as Implicit VR must be marked as
    # Explicit VR after transcoding, otherwise C-STORE incorrectly asks for
    # the original Implicit VR context despite the updated file meta.
    # Materialize any lazy RawDataElements before changing the original VR;
    # otherwise pydicom may try to write an implicit-VR raw element as if its
    # raw VR were explicit (the VR is None), which makes DIMSE encoding fail.
    ds.decode()
    ds.set_original_encoding(False, True, original_character_set)

    output_bytes = len(ds.PixelData) if "PixelData" in ds else 0
    return ds, original_transfer_syntax, input_bytes, output_bytes, time.perf_counter() - started


def negotiated_get_transfer_syntaxes(event):
    accepted = {}
    allowed = {text(item) for item in outbound_transfer_syntaxes()}
    for context in getattr(event.assoc, "accepted_contexts", []) or []:
        abstract = text(getattr(context, "abstract_syntax", ""))
        syntax = context_transfer_syntax(context)
        if abstract and syntax in allowed:
            accepted.setdefault(abstract, []).append(syntax)
    return accepted


def select_get_transfer_syntax(row, accepted):
    sop_class = text(row.get("sop_class_uid"))
    choices = accepted.get(sop_class, [])
    source = dcmread(row["file_path"], stop_before_pixels=True)
    source_syntax = text(getattr(getattr(source, "file_meta", None), "TransferSyntaxUID", ImplicitVRLittleEndian))
    for syntax in outbound_transfer_syntaxes():
        syntax_text = text(syntax)
        if syntax_text in choices and (encoder_available(syntax) or source_syntax == syntax_text):
            return syntax_text
    raise RuntimeError(f"no usable accepted transfer syntax for SOP Class {sop_class}")


def retrieval_dataset(row, transfer_syntax, operation):
    ds = dcmread(row["file_path"])
    prepared, original_ts, input_bytes, output_bytes, elapsed = prepare_dataset_for_retrieval(ds, transfer_syntax)
    ratio = (output_bytes / input_bytes) if input_bytes else 1.0
    log(
        f"[{operation}] outbound SOPInstanceUID={row.get('sop_instance_uid')} "
        f"TS={original_ts}->{transfer_syntax} bytes={input_bytes}->{output_bytes} "
        f"ratio={ratio:.3f} prepareMs={elapsed * 1000:.1f}"
    )
    return prepared


def handle_move(event):
    identifier = event.identifier
    level = query_level(identifier)
    destination_aet = text(event.move_destination)
    requestor_node = registered_requestor_node(event)
    if not requestor_node:
        log(
            f"[MOVE] rejected unregistered caller={requestor_label(event)} "
            f"reason=calling AE and remote IP must match an enabled DICOM node"
        )
        write_dicom_traffic_log("C_MOVE", "FAILED", event=event, dataset=identifier, status_code="0xC000", destination_ae_title=destination_aet, error_message="Calling AE and remote IP must match an enabled DICOM node")
        yield None, None
        return
    if level not in {"STUDY", "SERIES", "IMAGE"}:
        log(f"[MOVE] unsupported level={level} from {requestor_label(event)}")
        write_dicom_traffic_log("C_MOVE", "FAILED", event=event, dataset=identifier, status_code="0xC000", destination_ae_title=destination_aet, error_message=f"Unsupported query level {level}")
        yield None, None
        return

    destination = destination_for_aet(destination_aet)
    if not destination:
        log(f"[MOVE] unknown destination AE={destination_aet} from {requestor_label(event)}")
        write_dicom_traffic_log("C_MOVE", "FAILED", event=event, dataset=identifier, status_code="0xC000", destination_ae_title=destination_aet, error_message="Unknown destination AE")
        yield None, None
        return

    rows = move_instance_rows(level, identifier)
    log(
        f"[MOVE] caller={requestor_label(event)} node={requestor_node['name']} destination={destination_aet} "
        f"level={level} studyUid={dcm_text(identifier, 'StudyInstanceUID') or ''} "
        f"seriesUid={dcm_text(identifier, 'SeriesInstanceUID') or ''} "
        f"sopUid={dcm_text(identifier, 'SOPInstanceUID') or ''} instances={len(rows)}"
    )
    write_dicom_traffic_log(
        "C_MOVE",
        "SUCCESS" if rows else "NO_MATCH",
        event=event,
        dataset=identifier,
        status_code="0xFF00" if rows else "0x0000",
        destination_ae_title=destination_aet,
        message=f"C-MOVE {level} prepared {len(rows)} instance(s)",
        details={"queryLevel": level, "instanceCount": len(rows), "destination": destination},
    )
    try:
        selected_syntaxes = negotiate_move_transfer_syntaxes(destination, rows)
    except Exception as exc:
        log(f"[MOVE] destination negotiation failed: {exc}")
        yield None, None
        return
    selected_contexts = [build_context(sop_class, [syntax]) for sop_class, syntax in selected_syntaxes.items()]
    yield destination["host"], int(destination["port"]), {"contexts": selected_contexts}
    yield len(rows)
    for row in rows:
        try:
            syntax = selected_syntaxes[text(row.get("sop_class_uid"))]
            ds = retrieval_dataset(row, syntax, "MOVE")
            yield 0xFF00, ds
        except Exception as exc:
            log(
                f"[MOVE] failed to prepare SOPInstanceUID={row.get('sop_instance_uid')} "
                f"path={row.get('file_path')}: {exc}"
            )
            yield 0xC000, None


def handle_get(event):
    identifier = event.identifier
    level = query_level(identifier)
    requestor_node = registered_requestor_node(event)
    if not requestor_node or level not in {"STUDY", "SERIES", "IMAGE"}:
        yield 0
        yield 0xC000, None
        return

    rows = move_instance_rows(level, identifier)
    accepted = negotiated_get_transfer_syntaxes(event)
    log(f"[GET] caller={requestor_label(event)} level={level} instances={len(rows)} acceptedTS={compact_json(accepted)}")
    yield len(rows)
    for row in rows:
        try:
            syntax = select_get_transfer_syntax(row, accepted)
            yield 0xFF00, retrieval_dataset(row, syntax, "GET")
        except Exception as exc:
            log(f"[GET] failed SOPInstanceUID={row.get('sop_instance_uid')}: {exc}")
            yield 0xC000, None


def main():
    ae = AE(ae_title=EXTERNAL_AET)
    configure_called_aet_requirement(ae, EXTERNAL_AET)
    ae.add_supported_context(Verification)
    ae.add_supported_context(StudyRootQueryRetrieveInformationModelFind)
    ae.add_supported_context(StudyRootQueryRetrieveInformationModelMove)
    ae.add_supported_context(StudyRootQueryRetrieveInformationModelGet)
    for context in AllStoragePresentationContexts:
        ae.add_supported_context(context.abstract_syntax, SUPPORTED_STORAGE_TRANSFER_SYNTAXES, scu_role=True, scp_role=True)
    for context in StoragePresentationContexts:
        ae.add_requested_context(context.abstract_syntax, SUPPORTED_STORAGE_TRANSFER_SYNTAXES)

    handlers = [
        (evt.EVT_ACCEPTED, handle_accepted),
        (evt.EVT_RELEASED, handle_released),
        (evt.EVT_ABORTED, handle_aborted),
        (evt.EVT_C_ECHO, handle_echo),
        (evt.EVT_C_STORE, handle_store),
        (evt.EVT_C_FIND, handle_find),
        (evt.EVT_C_MOVE, handle_move),
        (evt.EVT_C_GET, handle_get),
    ]
    log(
        f"[DICOM] external AE={EXTERNAL_AET} {EXTERNAL_HOST}:{EXTERNAL_PORT} "
        f"storage+query-retrieve internal-store={INTERNAL_AET}@{INTERNAL_HOST}:{INTERNAL_PORT} "
        f"strict-called-aet={REQUIRE_CALLED_AET} outbound-compression={DIMSE_OUTBOUND_COMPRESSION} "
        f"outbound-ts={[text(item) for item in outbound_transfer_syntaxes()]} "
        f"storage-compression={DIMSE_STORAGE_COMPRESSION} "
        f"storage-ts={DIMSE_STORAGE_TRANSFER_SYNTAX if DIMSE_STORAGE_COMPRESSION else 'original'} "
        f"storage-profile={SUPPORTED_STORAGE_COMPRESSION_TRANSFER_SYNTAXES[DIMSE_STORAGE_TRANSFER_SYNTAX] if DIMSE_STORAGE_COMPRESSION else 'Original'}",
    )
    ae.start_server((EXTERNAL_HOST, EXTERNAL_PORT), block=True, evt_handlers=handlers)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
