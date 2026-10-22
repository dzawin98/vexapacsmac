import json
import os
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
from pydicom.tag import Tag
from pydicom.datadict import keyword_for_tag, tag_for_keyword
from pynetdicom import AE, evt
from pynetdicom.sop_class import ModalityWorklistInformationFind, Verification


BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = Path(__file__).resolve().parents[3]


def load_env() -> None:
    for candidate in (
        BACKEND_DIR / ".env",
        APP_DIR / ".env",
        APP_DIR.parent / ".env",
        REPO_DIR / ".env",
        Path.cwd() / ".env",
    ):
        if not candidate.exists():
            continue
        for raw_line in candidate.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


load_env()


def enforce_license(module: str) -> None:
    enforce = os.environ.get("VEXA_LICENSE_ENFORCE", os.environ.get("VELO_LICENSE_ENFORCE", "")).strip().lower()
    node_env = os.environ.get("NODE_ENV", "").strip().lower()
    if enforce in {"0", "false", "no", "off"}:
        return
    if enforce not in {"1", "true", "yes", "on"} and node_env != "production":
        print(f"[license] Enforcement belum aktif untuk modul {module}. Set VEXA_LICENSE_ENFORCE=true saat production.")
        return
    cli_path = REPO_DIR / "scripts" / "license" / "license-cli.js"
    try:
        subprocess.run(
            ["node", str(cli_path), "check", "--module", module],
            check=True,
            cwd=str(REPO_DIR),
        )
    except FileNotFoundError as exc:
        raise SystemExit("[license] Node.js tidak ditemukan untuk validasi license MWL.") from exc
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"[license] License invalid untuk modul {module}.") from exc


enforce_license("PACS_MWL")


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


MWL_AET = env("MWL_SCP_AET", "VEXARIS")[:16]
MWL_BIND = env("MWL_SCP_BIND", "0.0.0.0")
MWL_PORT = int(env("MWL_SCP_PORT", "8887"))
MWL_MAX_RESULTS = int(env("MWL_SCP_MAX_RESULTS", "100"))
MWL_SPECIFIC_CHARACTER_SET = env("MWL_SCP_CHARACTER_SET", "ISO_IR 192")
MWL_FILTER_BY_CALLING_AE = env("MWL_SCP_FILTER_BY_CALLING_AE", "false").lower() in {"1", "true", "yes"}
MWL_REQUIRE_CALLED_AET = env("MWL_SCP_REQUIRE_CALLED_AET", "true").lower() not in {"0", "false", "no", "off"}

DB_CONFIG = {
    "dicomweb_pacs_root": env("DICOMWEB_PACS_ROOT", "http://127.0.0.1:5001").rstrip("/"),
    "ris_backend_root": env("RIS_BACKEND_ROOT", f"http://127.0.0.1:{env('PORT', '3001')}").rstrip("/"),
    "internal_key": env("MWL_SCP_INTERNAL_KEY", ""),
}


def http_json(method: str, url: str, payload: Optional[Dict[str, Any]] = None) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if DB_CONFIG["internal_key"]:
        headers["X-NEXIA-MWL-SCP-Key"] = DB_CONFIG["internal_key"]
    request = Request(url, data=data, headers=headers, method=method)
    with urlopen(request, timeout=10) as response:
        raw = response.read().decode("utf-8", errors="ignore")
        return json.loads(raw) if raw else None


def value_to_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore").strip()
    return str(value).strip()


def assoc_text(value: Any) -> str:
    return value_to_str(value).strip()


def configure_called_aet_requirement(ae: AE, expected_aet: str) -> None:
    if not MWL_REQUIRE_CALLED_AET:
        print(f"[mwl] strict called AET disabled; AE={expected_aet}")
        return
    if not hasattr(ae, "require_called_aet"):
        print("[mwl] warning: pynetdicom does not expose require_called_aet; Called AET cannot be enforced")
        return
    try:
        ae.require_called_aet = True
        print(f"[mwl] strict called AET enabled; only Called AET={expected_aet} is accepted")
    except Exception as exc:
        print(f"[mwl] warning: failed to enable strict called AET for {expected_aet}: {exc}")


def dataset_to_plain(ds: Dataset) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for elem in ds:
        keyword = elem.keyword or str(elem.tag)
        if elem.VR == "SQ":
            result[keyword] = [dataset_to_plain(item) for item in elem.value]
        else:
            result[keyword] = value_to_str(elem.value)
    return result


def get_first_sps_from_plain(query: Dict[str, Any]) -> Dict[str, Any]:
    value = query.get("ScheduledProcedureStepSequence")
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return {}


def query_summary(query: Dict[str, Any]) -> Dict[str, str]:
    sps = get_first_sps_from_plain(query)
    return {
        "patient_id": value_to_str(query.get("PatientID")),
        "patient_name": value_to_str(query.get("PatientName")),
        "accession_number": value_to_str(query.get("AccessionNumber")),
        "study_instance_uid": value_to_str(query.get("StudyInstanceUID")),
        "modality": value_to_str(sps.get("Modality") or query.get("Modality")),
        "scheduled_station_ae_title": value_to_str(sps.get("ScheduledStationAETitle")),
        "scheduled_date": value_to_str(sps.get("ScheduledProcedureStepStartDate")),
        "scheduled_time": value_to_str(sps.get("ScheduledProcedureStepStartTime")),
    }


def requested_return_keys(ds: Dataset, prefix: str = "") -> List[str]:
    keys: List[str] = []
    for elem in ds:
        name = elem.keyword or str(elem.tag)
        path = f"{prefix}.{name}" if prefix else name
        if elem.VR == "SQ":
            keys.append(path)
            for item in elem.value:
                keys.extend(requested_return_keys(item, path))
        elif value_to_str(elem.value) == "":
            keys.append(path)
    return keys


def wildcard_match(actual: str, expected: str) -> bool:
    expected = value_to_str(expected)
    if not expected:
        return True
    actual = value_to_str(actual)
    if expected == "*":
        return True
    if "*" in expected:
        parts = [part.lower() for part in expected.split("*")]
        haystack = actual.lower()
        pos = 0
        for part in parts:
            if not part:
                continue
            found = haystack.find(part, pos)
            if found < 0:
                return False
            pos = found + len(part)
        return True
    return actual.lower() == expected.lower()


def date_match(actual: str, expected: str) -> bool:
    expected = value_to_str(expected)
    if not expected:
        return True
    actual = value_to_str(actual)
    if "-" in expected:
        start, end = expected.split("-", 1)
        if start and actual < start:
            return False
        if end and actual > end:
            return False
        return True
    return wildcard_match(actual, expected)


def parse_json(raw: Optional[str], fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback


def load_active_worklists(query: Dict[str, Any], calling_ae: str) -> List[Dict[str, Any]]:
    summary = query_summary(query)
    if MWL_FILTER_BY_CALLING_AE and calling_ae:
        station_filter = summary["scheduled_station_ae_title"] or calling_ae
    else:
        station_filter = summary["scheduled_station_ae_title"]
    params = {"active": "true"}
    if summary["accession_number"] and "*" not in summary["accession_number"]:
        params["AccessionNumber"] = summary["accession_number"]
    if summary["patient_id"] and "*" not in summary["patient_id"]:
        params["PatientID"] = summary["patient_id"]
    if summary["study_instance_uid"] and "*" not in summary["study_instance_uid"]:
        params["StudyInstanceUID"] = summary["study_instance_uid"]
    if summary["modality"] and "*" not in summary["modality"]:
        params["Modality"] = summary["modality"]
    if station_filter and "*" not in station_filter:
        params["ScheduledStationAETitle"] = station_filter
    if summary["scheduled_date"] and "-" not in summary["scheduled_date"] and "*" not in summary["scheduled_date"]:
        params["ScheduledProcedureStepStartDate"] = summary["scheduled_date"]
    url = f"{DB_CONFIG['dicomweb_pacs_root']}/mwl/worklists?{urlencode(params)}"
    rows = http_json("GET", url) or []
    normalized_rows = [normalize_rest_worklist(row) for row in rows[:MWL_MAX_RESULTS]]
    return [row for row in normalized_rows if record_matches_query(row, query)]


def load_all_active_worklists() -> List[Dict[str, Any]]:
    rows = http_json("GET", f"{DB_CONFIG['dicomweb_pacs_root']}/mwl/worklists?active=true") or []
    return [normalize_rest_worklist(row) for row in rows[:MWL_MAX_RESULTS]]


def no_match_diagnostics(query: Dict[str, Any], calling_ae: str) -> Dict[str, Any]:
    summary = query_summary(query)
    try:
        active_rows = load_all_active_worklists()
    except Exception as error:
        return {
            "reasonCode": "WORKLIST_SOURCE_ERROR",
            "errorMessage": f"Failed to read active worklists: {error}",
            "recommendation": "Check that VexaPacsDicomweb is running, DICOMWEB_PACS_ROOT points to the correct local service, and the MWL registry endpoint /mwl/worklists is reachable.",
            "activeWorklistCount": 0,
            "filterSummary": summary,
        }
    active_count = len(active_rows)
    if active_count == 0:
        return {
            "reasonCode": "NO_ACTIVE_WORKLIST",
            "errorMessage": "No active MWL worklist is available. Check order status/SENT_TO_MWL and active worklist publication.",
            "recommendation": "Send the order to modality again from RIS, then verify the order appears as SENT_TO_MWL and active in MWL Status.",
            "activeWorklistCount": active_count,
            "filterSummary": summary,
        }
    checks = [
        ("ACCESSION_MISMATCH", "accession_number", summary["accession_number"], wildcard_match),
        ("PATIENT_ID_MISMATCH", "patient_id", summary["patient_id"], wildcard_match),
        ("PATIENT_NAME_MISMATCH", "patient_name", summary["patient_name"], wildcard_match),
        ("STUDY_UID_MISMATCH", "study_instance_uid", summary["study_instance_uid"], wildcard_match),
        ("MODALITY_MISMATCH", "modality", summary["modality"], wildcard_match),
        ("STATION_AET_MISMATCH", "station_aet", summary["scheduled_station_ae_title"], wildcard_match),
        ("DATE_MISMATCH", "scheduled_date", summary["scheduled_date"], date_match),
        ("TIME_MISMATCH", "scheduled_time", summary["scheduled_time"], wildcard_match),
    ]
    remaining = active_rows
    for reason, field, expected, matcher in checks:
        if not value_to_str(expected):
            continue
        next_rows = [row for row in remaining if matcher(row.get(field), expected)]
        if not next_rows:
            return {
                "reasonCode": reason,
                "errorMessage": (
                    f"MWL query filter did not match active worklists at {field}. "
                    f"Expected '{expected}'. Calling AE='{calling_ae or '-'}'."
                ),
                "recommendation": recommendation_for_no_match(reason, field, expected, calling_ae),
                "activeWorklistCount": active_count,
                "filterSummary": summary,
                "availableSamples": [
                    {
                        "id": row.get("id"),
                        "accession": row.get("accession_number"),
                        "patientId": row.get("patient_id"),
                        "modality": row.get("modality"),
                        "stationAet": row.get("station_aet"),
                        "date": row.get("scheduled_date"),
                    }
                    for row in active_rows[:8]
                ],
            }
        remaining = next_rows
    if MWL_FILTER_BY_CALLING_AE and calling_ae and not summary["scheduled_station_ae_title"]:
        return {
            "reasonCode": "CALLING_AE_FILTER_NO_MATCH",
            "errorMessage": f"Calling AE filter is enabled but no active station AET matches calling AE '{calling_ae}'.",
            "recommendation": "Set the modality AE Title in RIS Modality Management to the exact Calling AE used by the modality, or disable MWL_FILTER_BY_CALLING_AE if station filtering is not required.",
            "activeWorklistCount": active_count,
            "filterSummary": summary,
        }
    return {
        "reasonCode": "NO_MATCH_AFTER_FILTER",
        "errorMessage": "No active worklist matched the modality query filters.",
        "recommendation": "Compare the modality query filters with the active order in MWL Status. Usually this is caused by accession, Patient ID, date, modality, or station AE mismatch.",
        "activeWorklistCount": active_count,
        "filterSummary": summary,
    }


def recommendation_for_no_match(reason: str, field: str, expected: Any, calling_ae: str) -> str:
    expected_text = value_to_str(expected) or "-"
    if reason == "ACCESSION_MISMATCH":
        return f"Check the modality worklist search accession. It asked for '{expected_text}', but no active order uses that accession."
    if reason == "PATIENT_ID_MISMATCH":
        return f"Check Patient ID/MRN mapping from SIMRS/RIS. The modality asked for Patient ID '{expected_text}'."
    if reason == "PATIENT_NAME_MISMATCH":
        return f"Check patient-name search behavior on the modality. Use wildcard or empty PatientName if the modality sends partial names differently."
    if reason == "STUDY_UID_MISMATCH":
        return "Avoid filtering MWL query by StudyInstanceUID unless the modality and RIS share the exact same generated UID."
    if reason == "MODALITY_MISMATCH":
        return f"Check Procedure/Study master modality code. The modality asked for '{expected_text}', so active orders must use the same modality code."
    if reason == "STATION_AET_MISMATCH":
        return f"Check RIS Modality Management AE Title. The order station AE must match '{expected_text}' or the modality Calling AE '{calling_ae or '-'}'."
    if reason == "DATE_MISMATCH":
        return f"Check Study Date/Activation Date. The modality asked for DICOM date '{expected_text}', but active orders are scheduled on a different date."
    if reason == "TIME_MISMATCH":
        return "Check if the modality sends an exact scheduled time filter. If not required, configure the modality to query by date/patient/accession only."
    return f"Check MWL field '{field}' with expected value '{expected_text}'."


def normalize_rest_worklist(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "accession_number": row.get("accessionNumber") or row.get("accession_number"),
        "study_instance_uid": row.get("studyInstanceUid") or row.get("study_instance_uid"),
        "patient_id": row.get("patientId") or row.get("patient_id"),
        "patient_name": row.get("patientName") or row.get("patient_name"),
        "modality": row.get("modality"),
        "station_aet": row.get("stationAet") or row.get("station_aet"),
        "scheduled_date": row.get("scheduledDate") or row.get("scheduled_date"),
        "scheduled_time": row.get("scheduledTime") or row.get("scheduled_time"),
        "tags_json": json.dumps(row.get("tags") or {}, ensure_ascii=False),
    }


def record_matches_query(row: Dict[str, Any], query: Dict[str, Any]) -> bool:
    summary = query_summary(query)
    if not wildcard_match(row.get("accession_number"), summary["accession_number"]):
        return False
    if not wildcard_match(row.get("patient_id"), summary["patient_id"]):
        return False
    if not wildcard_match(row.get("patient_name"), summary["patient_name"]):
        return False
    if not wildcard_match(row.get("study_instance_uid"), summary["study_instance_uid"]):
        return False
    if not wildcard_match(row.get("modality"), summary["modality"]):
        return False
    if not wildcard_match(row.get("station_aet"), summary["scheduled_station_ae_title"]):
        return False
    if not date_match(row.get("scheduled_date"), summary["scheduled_date"]):
        return False
    if not wildcard_match(row.get("scheduled_time"), summary["scheduled_time"]):
        return False
    return True


def set_element(ds: Dataset, keyword: str, value: Any) -> None:
    if value is None:
        return
    if not keyword:
        return
    try:
        setattr(ds, keyword, value)
    except Exception:
        tag_value = tag_for_keyword(keyword)
        if tag_value:
            ds.add_new(Tag(tag_value), "LO", value_to_str(value))


def dataset_from_tags(tags: Dict[str, Any]) -> Dataset:
    ds = Dataset()
    ds.SpecificCharacterSet = MWL_SPECIFIC_CHARACTER_SET
    for key, value in tags.items():
        if key == "ScheduledProcedureStepSequence":
            sequence = Sequence()
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        sequence.append(dataset_from_tags(item))
            ds.ScheduledProcedureStepSequence = sequence
            continue
        if "," in key:
            try:
                tag = Tag(int(key.replace(",", ""), 16))
                keyword = keyword_for_tag(tag)
                if keyword:
                    set_element(ds, keyword, value)
            except Exception:
                continue
        else:
            set_element(ds, key, value)
    return ds


def response_dataset(row: Dict[str, Any]) -> Dataset:
    tags = parse_json(row.get("tags_json"), {})
    if not isinstance(tags, dict):
        tags = {}
    ds = dataset_from_tags(tags)
    if not getattr(ds, "AccessionNumber", None):
        ds.AccessionNumber = value_to_str(row.get("accession_number"))
    if not getattr(ds, "PatientID", None):
        ds.PatientID = value_to_str(row.get("patient_id"))
    if not getattr(ds, "PatientName", None):
        ds.PatientName = value_to_str(row.get("patient_name"))
    if not getattr(ds, "StudyInstanceUID", None):
        ds.StudyInstanceUID = value_to_str(row.get("study_instance_uid"))
    if not getattr(ds, "ScheduledProcedureStepSequence", None):
        item = Dataset()
        item.Modality = value_to_str(row.get("modality"))
        item.ScheduledStationAETitle = value_to_str(row.get("station_aet"))
        item.ScheduledProcedureStepStartDate = value_to_str(row.get("scheduled_date"))
        item.ScheduledProcedureStepStartTime = value_to_str(row.get("scheduled_time"))
        item.ScheduledProcedureStepID = value_to_str(row.get("accession_number"))[:16] or "SPS"
        ds.ScheduledProcedureStepSequence = Sequence([item])
    for item in getattr(ds, "ScheduledProcedureStepSequence", []) or []:
        if getattr(item, "ScheduledProcedureStepID", None):
            item.ScheduledProcedureStepID = value_to_str(item.ScheduledProcedureStepID)[:16]
        if getattr(item, "ScheduledStationAETitle", None):
            item.ScheduledStationAETitle = value_to_str(item.ScheduledStationAETitle)[:16]
    return ds


def write_query_log(
    *,
    calling_ae: str,
    called_ae: str,
    remote_address: str,
    remote_port: Optional[int],
    query: Dict[str, Any],
    match_count: int,
    outcome: str,
    status_code: str,
    matched_ids: Iterable[str],
    error_message: Optional[str] = None,
    reason_code: Optional[str] = None,
    recommendation: Optional[str] = None,
    active_worklist_count: Optional[int] = None,
    filter_summary: Optional[Dict[str, Any]] = None,
) -> None:
    summary = query_summary(query)
    query_payload = {
        "query": query,
        "returnKeys": query.get("_returnKeys", []),
        "receivedAt": datetime.utcnow().isoformat() + "Z",
    }
    payload = {
        "callingAeTitle": calling_ae,
        "calledAeTitle": called_ae,
        "remoteAddress": remote_address,
        "remotePort": remote_port,
        "patientId": summary["patient_id"] or None,
        "patientName": summary["patient_name"] or None,
        "accessionNumber": summary["accession_number"] or None,
        "studyInstanceUid": summary["study_instance_uid"] or None,
        "modality": summary["modality"] or None,
        "scheduledStationAeTitle": summary["scheduled_station_ae_title"] or None,
        "scheduledDate": summary["scheduled_date"] or None,
        "scheduledTime": summary["scheduled_time"] or None,
        "matchCount": match_count,
        "outcome": outcome,
        "statusCode": status_code,
        "reasonCode": reason_code,
        "errorMessage": error_message,
        "recommendation": recommendation,
        "matchedWorklistIds": list(matched_ids),
        "activeWorklistCount": active_worklist_count,
        "filterSummary": filter_summary or summary,
        "query": query_payload,
    }
    try:
        http_json("POST", f"{DB_CONFIG['ris_backend_root']}/api/internal/mwl/query-log", payload)
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        print(f"[mwl] failed to write query log: {error}", file=sys.stderr)


def handle_find(event):
    requestor = event.assoc.requestor
    acceptor = event.assoc.acceptor
    calling_ae = assoc_text(requestor.ae_title)
    called_ae = assoc_text(acceptor.ae_title) or MWL_AET
    remote_address = assoc_text(getattr(requestor, "address", ""))
    remote_port = getattr(requestor, "port", None)
    query = dataset_to_plain(event.identifier)
    query["_returnKeys"] = requested_return_keys(event.identifier)
    try:
        matches = load_active_worklists(query, calling_ae)
        outcome = "MATCHED" if matches else "NO_MATCH"
        diagnostics = {} if matches else no_match_diagnostics(query, calling_ae)
        write_query_log(
            calling_ae=calling_ae,
            called_ae=called_ae,
            remote_address=remote_address,
            remote_port=remote_port,
            query=query,
            match_count=len(matches),
            outcome=outcome,
            status_code="0xFF00" if matches else "0x0000",
            matched_ids=[value_to_str(row.get("id")) for row in matches],
            error_message=diagnostics.get("errorMessage"),
            reason_code=diagnostics.get("reasonCode"),
            recommendation=diagnostics.get("recommendation"),
            active_worklist_count=diagnostics.get("activeWorklistCount"),
            filter_summary=diagnostics.get("filterSummary"),
        )
        for row in matches:
            yield 0xFF00, response_dataset(row)
    except Exception as error:
        traceback.print_exc()
        try:
            write_query_log(
                calling_ae=calling_ae,
                called_ae=called_ae,
                remote_address=remote_address,
                remote_port=remote_port,
                query=query,
                match_count=0,
                outcome="ERROR",
                status_code="0xC000",
                matched_ids=[],
                error_message=str(error),
                reason_code="MWL_SCP_EXCEPTION",
                recommendation="Review the MWL SCP error log, then verify database connection, DICOMweb PACS MWL endpoint, and malformed DICOM query tags from the modality.",
                filter_summary=query_summary(query),
            )
        except Exception:
            traceback.print_exc()
        yield 0xC000, None


def handle_echo(event):
    requestor = event.assoc.requestor
    calling_ae = assoc_text(requestor.ae_title)
    remote_address = assoc_text(getattr(requestor, "address", ""))
    print(f"[mwl] C-ECHO from AE={calling_ae or '-'} {remote_address or '-'}")
    return 0x0000


def main() -> int:
    ae = AE(ae_title=MWL_AET)
    configure_called_aet_requirement(ae, MWL_AET)
    ae.add_supported_context(ModalityWorklistInformationFind)
    ae.add_supported_context(Verification)
    handlers = [(evt.EVT_C_FIND, handle_find), (evt.EVT_C_ECHO, handle_echo)]
    print(f"VEXA MWL SCP listening on {MWL_BIND}:{MWL_PORT} AE={MWL_AET} strict-called-aet={MWL_REQUIRE_CALLED_AET}")
    print(f"Worklist REST: {DB_CONFIG['dicomweb_pacs_root']}/mwl/worklists")
    print(f"Query log REST: {DB_CONFIG['ris_backend_root']}/api/internal/mwl/query-log")
    ae.start_server((MWL_BIND, MWL_PORT), block=True, evt_handlers=handlers)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("VEXA MWL SCP stopped")
        raise SystemExit(0)
    except Exception as exc:
        print(f"VEXA MWL SCP failed: {exc}", file=sys.stderr)
        traceback.print_exc()
        raise SystemExit(1)
