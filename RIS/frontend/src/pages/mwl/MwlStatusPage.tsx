import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { MwlAssignedStaff, MwlPublishedItem, MwlQueryLog, MwlStatusLog, dicomWebService, mwlService } from "@/lib/dicomService";
import { MwlDataTable, MwlTableColumn } from "@/components/mwl/MwlDataTable";
import { CalendarDays, Filter, RefreshCw, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { DetailGrid, DetailHero, DetailItem, DetailSection } from "@/components/mwl/DetailDialogSections";

type DatePreset = "today" | "7days" | "1month" | "2months" | "range";

type MwlStatusRow = {
  id: string;
  status_indicator: string;
  publish_status: "ACTIVE" | "INACTIVE" | "NOT_PUBLISHED";
  query_status: "MATCHED" | "NO_MATCH" | "ERROR" | "NOT_QUERIED";
  sync_date: string;
  accession_number: string;
  no_rm: string;
  nama_pasien: string;
  modality: string;
  modality_station_room: string;
  modality_station_aet_master: string;
  orthanc_status: string;
  procedure_desc: string;
  assigned_staff_json?: string | null;
  study_instance_uid?: string | null;
  study_date?: string | null;
  study_time?: string | null;
  tanggal_order?: string | null;
  tanggal_aktivasi?: string | null;
  no_register?: string | null;
  no_rontgen?: string | null;
  klinis?: string | null;
  diagnosa?: string | null;
  nama_ruangan?: string | null;
  technologist_name?: string | null;
  technologist_username?: string | null;
  nama_admin?: string | null;
  nama_radiografer?: string | null;
  nama_radiolog?: string | null;
  referring_doctor_name?: string | null;
  radiologist_doctor_name?: string | null;
  orthanc_file_name?: string | null;
  last_query_at?: string | null;
  last_query_caller_ae?: string | null;
  last_query_called_ae?: string | null;
  last_query_remote?: string | null;
  last_query_reason?: string | null;
  last_query_error?: string | null;
  last_query_recommendation?: string | null;
  last_query_requested_keys?: string[];
  last_query_filters?: string[];
  last_query_returned_ids?: string[];
  query_count: number;
  matched_query_count: number;
  last_match_count: number;
  active_worklist_count?: number | null;
  published_id?: string | null;
  published_updated_at?: string | null;
  log_message?: string | null;
};

const indicatorToneClass = (status: string) => {
  if (status === "COMPLETED" || status === "QUERIED_MATCHED") return "status-badge-success";
  if (status === "ACTIVE" || status === "PUBLISHED") return "status-badge-warning";
  if (status === "QUERY_NO_MATCH") return "status-badge-warning";
  if (status === "QUERY_ERROR" || status === "FAILED" || status === "ERROR") return "status-badge-danger";
  return "status-badge-info";
};

const queryToneClass = (status: string) => {
  if (status === "MATCHED") return "status-badge-success";
  if (status === "NO_MATCH") return "status-badge-warning";
  if (status === "ERROR") return "status-badge-danger";
  return "status-badge-info";
};

const publishToneClass = (status: string) => {
  if (status === "ACTIVE") return "status-badge-success";
  if (status === "INACTIVE") return "status-badge-warning";
  return "status-badge-info";
};

const parseAssignedStaff = (value?: string | null): MwlAssignedStaff[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const formatAssignedStaff = (value?: string | null) => {
  const assigned = parseAssignedStaff(value);
  if (!assigned.length) return "-";
  return assigned.map(item => `${item.nama_dokter} (${item.role})`).join(", ");
};

const normalizeText = (value?: string | null) => String(value || "").trim().toLowerCase();

const toDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getFirstSps = (tags?: Record<string, unknown> | null) => {
  const sequence = tags?.ScheduledProcedureStepSequence;
  return Array.isArray(sequence) ? (sequence[0] as Record<string, unknown> | undefined) : undefined;
};

const getRequestedProcedureDescription = (published?: MwlPublishedItem | null) => {
  const tags = published?.tags_json || {};
  const sps = getFirstSps(tags);
  const value =
    published?.meta_json?.procedureDescription ||
    (typeof tags.RequestedProcedureDescription === "string" ? tags.RequestedProcedureDescription : "") ||
    (typeof sps?.ScheduledProcedureStepDescription === "string" ? sps.ScheduledProcedureStepDescription : "");
  return String(value || "").trim();
};

const getPublishedRoom = (published?: MwlPublishedItem | null) => {
  const tags = published?.tags_json || {};
  const value =
    (typeof tags.InstitutionName === "string" ? tags.InstitutionName : "") ||
    (typeof tags.RequestingService === "string" ? tags.RequestingService : "");
  return String(value || "").trim();
};

const matchesStatusDatePreset = (row: MwlStatusRow, preset: DatePreset, fromDate: string, toDateValue: string) => {
  const date = toDate(row.last_query_at || row.published_updated_at || row.tanggal_order || row.sync_date || row.study_date);
  if (!date) return false;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const today = new Date();
  const todayStart = startOf(today);
  const dateOnly = startOf(date);

  if (preset === "today") return dateOnly.getTime() === todayStart.getTime();
  if (preset === "7days") {
    const diff = todayStart.getTime() - dateOnly.getTime();
    const deltaDays = diff / (1000 * 60 * 60 * 24);
    return deltaDays >= 0 && deltaDays <= 7;
  }
  if (preset === "1month" || preset === "2months") {
    const from = new Date(todayStart);
    from.setMonth(from.getMonth() - (preset === "1month" ? 1 : 2));
    return date >= from && date <= endOf(today);
  }
  if (!fromDate || !toDateValue) return false;
  const from = toDate(fromDate);
  const to = toDate(toDateValue);
  if (from && date < startOf(from)) return false;
  if (to && date > endOf(to)) return false;
  return true;
};

const buildJoinKeys = (input: { accessionNumber?: string | null; studyInstanceUid?: string | null; patientId?: string | null }) => {
  const keys = [
    input.accessionNumber ? `acc:${normalizeText(input.accessionNumber)}` : "",
    input.studyInstanceUid ? `uid:${normalizeText(input.studyInstanceUid)}` : "",
    input.patientId ? `pid:${normalizeText(input.patientId)}` : "",
  ].filter(Boolean);
  return Array.from(new Set(keys));
};

const findFirstMapped = <T,>(map: Map<string, T>, keys: string[]) => {
  for (const key of keys) {
    const match = map.get(key);
    if (match) return match;
  }
  return undefined;
};

const findManyMapped = <T,>(map: Map<string, T[]>, keys: string[]) => {
  const found = new Set<T>();
  keys.forEach(key => {
    const items = map.get(key) || [];
    items.forEach(item => found.add(item));
  });
  return Array.from(found);
};

const readQueryPayload = (query?: MwlQueryLog | null) => {
  const payload = query?.query_json || {};
  const root = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const queryObject = typeof root.query === "object" && root.query !== null ? root.query as Record<string, unknown> : root;
  const spsSequence = queryObject.ScheduledProcedureStepSequence;
  const sps = Array.isArray(spsSequence) && typeof spsSequence[0] === "object" && spsSequence[0] !== null
    ? spsSequence[0] as Record<string, unknown>
    : {};
  const returnKeysRaw = Array.isArray(root.returnKeys) ? root.returnKeys : Array.isArray(queryObject._returnKeys) ? queryObject._returnKeys : [];
  const requestedKeys = returnKeysRaw.map(item => String(item || "").trim()).filter(Boolean);
  const filters = [
    queryObject.PatientName ? `PatientName: ${queryObject.PatientName}` : "",
    queryObject.PatientID ? `PatientID: ${queryObject.PatientID}` : "",
    queryObject.AccessionNumber ? `Accession: ${queryObject.AccessionNumber}` : "",
    queryObject.StudyInstanceUID ? `Study UID: ${queryObject.StudyInstanceUID}` : "",
    sps.Modality ? `Modality: ${sps.Modality}` : "",
    sps.ScheduledStationAETitle ? `Station AE: ${sps.ScheduledStationAETitle}` : "",
    sps.ScheduledProcedureStepStartDate ? `Scheduled Date: ${sps.ScheduledProcedureStepStartDate}` : "",
    sps.ScheduledProcedureStepStartTime ? `Scheduled Time: ${sps.ScheduledProcedureStepStartTime}` : "",
  ].filter(Boolean).map(String);
  return {
    requestedKeys,
    filters,
    returnedIds: (query?.matched_worklist_ids || []).map(item => String(item || "").trim()).filter(Boolean),
  };
};

const buildStatusRows = (logs: MwlStatusLog[], publishedItems: MwlPublishedItem[], queryLogs: MwlQueryLog[]): MwlStatusRow[] => {
  const logByKey = new Map<string, MwlStatusLog>();
  const queryByKey = new Map<string, MwlQueryLog[]>();

  logs.forEach(log => {
    buildJoinKeys({
      accessionNumber: log.accession_number,
      studyInstanceUid: log.study_instance_uid,
      patientId: log.no_rm,
    }).forEach(key => {
      if (!logByKey.has(key)) logByKey.set(key, log);
    });
  });

  queryLogs.forEach(query => {
    buildJoinKeys({
      accessionNumber: query.accession_number,
      studyInstanceUid: query.study_instance_uid,
      patientId: query.patient_id,
    }).forEach(key => {
      const list = queryByKey.get(key) || [];
      list.push(query);
      queryByKey.set(key, list);
    });
  });

  const rows: MwlStatusRow[] = publishedItems.map(published => {
    const keys = buildJoinKeys({
      accessionNumber: published.accession_number,
      studyInstanceUid: published.study_instance_uid,
      patientId: published.patient_id,
    });
    const log = findFirstMapped(logByKey, keys);
    const queries = findManyMapped(queryByKey, keys).sort((a, b) => {
      const left = toDate(b.created_at)?.getTime() || 0;
      const right = toDate(a.created_at)?.getTime() || 0;
      return left - right;
    });
    const lastQuery = queries[0];
    const lastQueryPayload = readQueryPayload(lastQuery);
    const queryStatus = lastQuery?.outcome === "MATCHED" || lastQuery?.outcome === "NO_MATCH" || lastQuery?.outcome === "ERROR"
      ? lastQuery.outcome
      : "NOT_QUERIED";
    const publishStatus = published.active ? "ACTIVE" : "INACTIVE";
    const statusIndicator =
      log?.order_status === "COMPLETED"
        ? "COMPLETED"
        : queryStatus === "ERROR"
          ? "QUERY_ERROR"
          : queryStatus === "NO_MATCH"
            ? "QUERY_NO_MATCH"
            : queryStatus === "MATCHED"
              ? "QUERIED_MATCHED"
              : published.active
                ? "ACTIVE"
                : "INACTIVE";

    return {
      id: published.id,
      status_indicator: statusIndicator,
      publish_status: publishStatus,
      query_status: queryStatus,
      sync_date: log?.sync_date || published.updated_at,
      accession_number: published.accession_number || log?.accession_number || "-",
      no_rm: published.patient_id || log?.no_rm || "-",
      nama_pasien: published.patient_name || log?.nama_pasien || "-",
      modality: published.modality || log?.modality || published.meta_json?.modality || "-",
      modality_station_room: log?.modality_station_room || getPublishedRoom(published) || "-",
      modality_station_aet_master: published.station_aet || published.meta_json?.stationAet || log?.modality_station_aet_master || "-",
      orthanc_status: log?.orthanc_status || (published.active ? "PUBLISHED" : "INACTIVE"),
      procedure_desc: log?.procedure_desc || getRequestedProcedureDescription(published) || "-",
      assigned_staff_json: log?.assigned_staff_json || null,
      study_instance_uid: published.study_instance_uid || log?.study_instance_uid || published.meta_json?.studyInstanceUid || null,
      study_date: published.scheduled_date || log?.study_date || null,
      study_time: published.scheduled_time || log?.study_time || null,
      tanggal_order: log?.tanggal_order || null,
      tanggal_aktivasi: log?.tanggal_aktivasi || null,
      no_register: log?.no_register || null,
      no_rontgen: log?.no_rontgen || null,
      klinis: log?.klinis || null,
      diagnosa: log?.diagnosa || null,
      nama_ruangan: log?.nama_ruangan || "-",
      technologist_name: log?.technologist_name || published.meta_json?.technologist?.name || null,
      technologist_username: log?.technologist_username || published.meta_json?.technologist?.username || null,
      nama_admin: log?.nama_admin || null,
      nama_radiografer: log?.nama_radiografer || null,
      nama_radiolog: log?.nama_radiolog || null,
      referring_doctor_name: log?.referring_doctor_name || null,
      radiologist_doctor_name: log?.radiologist_doctor_name || null,
      orthanc_file_name: log?.orthanc_file_name || null,
      last_query_at: lastQuery?.created_at || null,
      last_query_caller_ae: lastQuery?.calling_ae_title || null,
      last_query_called_ae: lastQuery?.called_ae_title || null,
      last_query_remote: lastQuery?.remote_address ? `${lastQuery.remote_address}${lastQuery.remote_port ? `:${lastQuery.remote_port}` : ""}` : null,
      last_query_reason: lastQuery?.reason_code || null,
      last_query_error: lastQuery?.error_message || null,
      last_query_recommendation: lastQuery?.recommendation || null,
      last_query_requested_keys: lastQueryPayload.requestedKeys,
      last_query_filters: lastQueryPayload.filters,
      last_query_returned_ids: lastQueryPayload.returnedIds,
      query_count: queries.length,
      matched_query_count: queries.filter(item => item.outcome === "MATCHED").length,
      last_match_count: Number(lastQuery?.match_count || 0),
      active_worklist_count: lastQuery?.active_worklist_count ?? null,
      published_id: published.id,
      published_updated_at: published.updated_at,
      log_message: log?.message || null,
    };
  });

  logs.forEach(log => {
    const keys = buildJoinKeys({
      accessionNumber: log.accession_number,
      studyInstanceUid: log.study_instance_uid,
      patientId: log.no_rm,
    });
    const alreadyPresent = rows.some(row => buildJoinKeys({
      accessionNumber: row.accession_number,
      studyInstanceUid: row.study_instance_uid,
      patientId: row.no_rm,
    }).some(key => keys.includes(key)));
    if (alreadyPresent) return;
    const queries = findManyMapped(queryByKey, keys).sort((a, b) => {
      const left = toDate(b.created_at)?.getTime() || 0;
      const right = toDate(a.created_at)?.getTime() || 0;
      return left - right;
    });
    const lastQuery = queries[0];
    const lastQueryPayload = readQueryPayload(lastQuery);
    const queryStatus = lastQuery?.outcome === "MATCHED" || lastQuery?.outcome === "NO_MATCH" || lastQuery?.outcome === "ERROR"
      ? lastQuery.outcome
      : "NOT_QUERIED";
    rows.push({
      id: `log-${log.id}`,
      status_indicator: log.status_indicator || "ACTIVE",
      publish_status: "NOT_PUBLISHED",
      query_status: queryStatus,
      sync_date: log.sync_date,
      accession_number: log.accession_number,
      no_rm: log.no_rm,
      nama_pasien: log.nama_pasien,
      modality: log.modality,
      modality_station_room: log.modality_station_room || "-",
      modality_station_aet_master: log.modality_station_aet_master || "-",
      orthanc_status: log.orthanc_status,
      procedure_desc: log.procedure_desc,
      assigned_staff_json: log.assigned_staff_json || null,
      study_instance_uid: log.study_instance_uid || null,
      study_date: log.study_date || null,
      study_time: log.study_time || null,
      tanggal_order: log.tanggal_order || null,
      tanggal_aktivasi: log.tanggal_aktivasi || null,
      no_register: log.no_register || null,
      no_rontgen: log.no_rontgen || null,
      klinis: log.klinis || null,
      diagnosa: log.diagnosa || null,
      nama_ruangan: log.nama_ruangan || "-",
      technologist_name: log.technologist_name || null,
      technologist_username: log.technologist_username || null,
      nama_admin: log.nama_admin || null,
      nama_radiografer: log.nama_radiografer || null,
      nama_radiolog: log.nama_radiolog || null,
      referring_doctor_name: log.referring_doctor_name || null,
      radiologist_doctor_name: log.radiologist_doctor_name || null,
      orthanc_file_name: log.orthanc_file_name || null,
      last_query_at: lastQuery?.created_at || null,
      last_query_caller_ae: lastQuery?.calling_ae_title || null,
      last_query_called_ae: lastQuery?.called_ae_title || null,
      last_query_remote: lastQuery?.remote_address ? `${lastQuery.remote_address}${lastQuery.remote_port ? `:${lastQuery.remote_port}` : ""}` : null,
      last_query_reason: lastQuery?.reason_code || null,
      last_query_error: lastQuery?.error_message || null,
      last_query_recommendation: lastQuery?.recommendation || null,
      last_query_requested_keys: lastQueryPayload.requestedKeys,
      last_query_filters: lastQueryPayload.filters,
      last_query_returned_ids: lastQueryPayload.returnedIds,
      query_count: queries.length,
      matched_query_count: queries.filter(item => item.outcome === "MATCHED").length,
      last_match_count: Number(lastQuery?.match_count || 0),
      active_worklist_count: lastQuery?.active_worklist_count ?? null,
      published_id: null,
      published_updated_at: null,
      log_message: log.message || null,
    });
  });

  return rows.sort((a, b) => {
    const left = toDate(b.last_query_at || b.published_updated_at || b.sync_date)?.getTime() || 0;
    const right = toDate(a.last_query_at || a.published_updated_at || a.sync_date)?.getTime() || 0;
    return left - right;
  });
};

const formatDateTime = (value?: string | null) => {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
};

const formatMwlRegistryStatus = (value?: string | null) => {
  const status = String(value || "").trim();
  if (!status) return "-";
  const labelMap: Record<string, string> = {
    SENT_TO_DICOMWEB_PACS: "Published to MWL Registry",
    REST_DICOMWEB_PACS_MWL: "Published to MWL Registry",
    SENT_TO_ORTHANC: "Published to Legacy MWL",
    PUBLISHED: "Published to MWL Registry",
    INACTIVE: "Inactive",
    FAILED: "Publish Failed",
  };
  return labelMap[status] || status.replace(/_/g, " ");
};

const formatListValue = (items?: string[] | null) => {
  const cleaned = (items || []).map(item => String(item || "").trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(", ") : "-";
};

const MwlStatusPage = () => {
  const { toast } = useToast();
  const [rows, setRows] = useState<MwlStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<MwlStatusRow | null>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDateValue, setToDateValue] = useState("");

  const loadStatus = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!silent) setLoading(true);
    try {
      const [logs, published, queryLogs] = await Promise.all([
        mwlService.fetchStatus(),
        mwlService.fetchPublished({ active: true }),
        mwlService.fetchQueryLogs({ limit: 500 }),
      ]);
      setRows(buildStatusRows(logs, published, queryLogs));
    } catch (error) {
      toast({ title: "Failed to load MWL status", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    let active = true;
    dicomWebService.fetchUiSettings()
      .then(settings => {
        if (active) setAutoRefreshEnabled(typeof settings.autoRefresh === "boolean" ? settings.autoRefresh : true);
      })
      .catch(() => {
        if (active) setAutoRefreshEnabled(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled || selectedRow) return;
    const id = window.setInterval(() => {
      loadStatus({ silent: true });
    }, 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, loadStatus, selectedRow]);

  const columns = useMemo<MwlTableColumn<MwlStatusRow>[]>(() => [
    { key: "sync_date", label: "Updated", render: row => formatDateTime(row.last_query_at || row.published_updated_at || row.sync_date), value: row => row.last_query_at || row.published_updated_at || row.sync_date },
    { key: "accession", label: "Accession", render: row => row.accession_number, value: row => row.accession_number },
    { key: "no_rm", label: "No RM", render: row => row.no_rm, value: row => row.no_rm },
    { key: "patient", label: "Patient", render: row => row.nama_pasien, value: row => row.nama_pasien },
    { key: "modality", label: "Modality", render: row => row.modality, value: row => row.modality },
    { key: "station", label: "Station AE", render: row => row.modality_station_aet_master || "-", value: row => row.modality_station_aet_master },
    {
      key: "publish_status",
      label: "Publish",
      render: row => (
        <Badge variant="outline" className={`status-badge ${publishToneClass(row.publish_status)}`}>
          {row.publish_status}
        </Badge>
      ),
      value: row => row.publish_status,
    },
    {
      key: "query_status",
      label: "Last Query",
      render: row => (
        <Badge variant="outline" className={`status-badge ${queryToneClass(row.query_status)}`}>
          {row.query_status}
        </Badge>
      ),
      value: row => row.query_status,
    },
    { key: "caller_ae", label: "Caller AE", render: row => row.last_query_caller_ae || "-", value: row => row.last_query_caller_ae || "" },
    { key: "query_count", label: "Query Count", render: row => String(row.query_count), value: row => String(row.query_count) },
    {
      key: "indicator",
      label: "Indicator",
      render: row => (
        <Badge variant="outline" className={`status-badge ${indicatorToneClass(row.status_indicator)}`}>
          {row.status_indicator}
        </Badge>
      ),
      value: row => row.status_indicator,
    },
    { key: "study", label: "Study Description", render: row => row.procedure_desc, value: row => row.procedure_desc },
    { key: "petugas", label: "MWL Staff", render: row => formatAssignedStaff(row.assigned_staff_json), value: row => formatAssignedStaff(row.assigned_staff_json) },
  ], []);

  const filteredRows = useMemo(
    () => rows.filter(row => matchesStatusDatePreset(row, datePreset, fromDate, toDateValue)),
    [rows, datePreset, fromDate, toDateValue]
  );

  const filterControls = (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" className="rounded-xl h-9 w-9" aria-label="Filter status">
            <Filter className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Filter status</TooltipContent>
      </Tooltip>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon" className="rounded-xl h-9 w-9" aria-label="Date filter">
                <CalendarDays className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Date filter</TooltipContent>
        </Tooltip>
        <PopoverContent className="w-72 p-3" align="end">
          <div className="space-y-3">
            <RadioGroup value={datePreset} onValueChange={value => setDatePreset(value as DatePreset)} className="grid gap-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="today" id="status-date-today" /><span>Today</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="7days" id="status-date-7days" /><span>7 days ago</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="1month" id="status-date-1month" /><span>1 Month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="2months" id="status-date-2months" /><span>2 Month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="range" id="status-date-range" /><span>Custom range</span></label>
            </RadioGroup>
            {datePreset === "range" && (
              <div className="space-y-2">
                <div className="grid grid-cols-[auto,1fr] items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">From</span>
                  <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8 rounded-md text-[11px]" />
                </div>
                <div className="grid grid-cols-[auto,1fr] items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">To</span>
                  <Input type="date" value={toDateValue} onChange={e => setToDateValue(e.target.value)} className="h-8 rounded-md text-[11px]" />
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" onClick={loadStatus} aria-label="Reload">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reload</TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <div className="mwl-command-page space-y-6 pb-10">
      <div className="mwl-command-header flex items-center justify-between gap-3">
        <div>
          <h1 className="page-title mwl-command-title">MWL Status</h1>
        </div>
        {filterControls}
      </div>

      <Card className="technologist-command-surface overflow-hidden border-0 bg-transparent shadow-none">
        <CardContent className="p-0">
          <MwlDataTable
            storageKey="mwl-status-table"
            columns={columns}
            rows={filteredRows}
            loading={loading}
            emptyMessage="No active MWL data yet."
            searchValue={search}
            searchPlaceholder="Search accession or Patient ID"
            onSearchChange={setSearch}
            toolbar={filterControls}
            getRowKey={row => row.id}
            onRowDoubleClick={row => setSelectedRow(row)}
          />
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedRow)} onOpenChange={open => !open && setSelectedRow(null)}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden border-0 bg-transparent p-0 shadow-none [&>button]:hidden">
          <DialogHeader><DialogTitle className="sr-only">Active MWL Detail</DialogTitle></DialogHeader>
          {selectedRow && (
            <div className="relative max-h-[88vh] overflow-hidden rounded-2xl border bg-background shadow-2xl">
              <div className="sticky top-0 z-20 flex justify-end border-b bg-background/95 px-4 py-3 backdrop-blur">
                <DialogClose asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full border bg-background shadow-sm" aria-label="Close detail">
                    <X className="h-4 w-4" />
                  </Button>
                </DialogClose>
              </div>
              <div className="max-h-[calc(88vh-65px)] overflow-y-auto p-4 pt-3">
              <div className="space-y-3">
                <DetailHero
                  title={selectedRow.nama_pasien || "-"}
                  subtitle={`${selectedRow.no_rm || "-"} - Accession ${selectedRow.accession_number || "-"}`}
                />

                <DetailSection title="Published MWL Order">
                  <DetailGrid>
                    <DetailItem label="Last Published" value={selectedRow.publish_status === "NOT_PUBLISHED" ? "-" : formatDateTime(selectedRow.published_updated_at)} />
                    <DetailItem label="No Register" value={selectedRow.no_register || "-"} />
                    <DetailItem label="Study UID" value={selectedRow.study_instance_uid || "-"} className="md:col-span-2" />
                    <DetailItem label="Order Date" value={formatDateTime(selectedRow.tanggal_order)} />
                    <DetailItem label="Study Date" value={selectedRow.study_date || "-"} />
                    <DetailItem label="Study Time" value={selectedRow.study_time || "-"} />
                    <DetailItem label="Modality" value={selectedRow.modality || "-"} />
                    <DetailItem label="AE Title" value={selectedRow.modality_station_aet_master || "-"} />
                    <DetailItem label="Modality Room" value={selectedRow.modality_station_room || "-"} />
                    <DetailItem label="Patient Origin Room" value={selectedRow.nama_ruangan || "-"} />
                    <DetailItem label="Registry Status" value={formatMwlRegistryStatus(selectedRow.orthanc_status)} />
                    <DetailItem label="Study Description" value={selectedRow.procedure_desc || "-"} className="md:col-span-2" />
                  </DetailGrid>
                </DetailSection>

                {selectedRow.query_status !== "NOT_QUERIED" && (
                <DetailSection title="Modality Query Activity">
                    <DetailGrid>
                      <DetailItem label="Last Query" value={selectedRow.query_status} />
                      <DetailItem label="Last Query Time" value={formatDateTime(selectedRow.last_query_at)} />
                      <DetailItem label="Caller AE" value={selectedRow.last_query_caller_ae || "-"} />
                      <DetailItem label="Called AE" value={selectedRow.last_query_called_ae || "-"} />
                      <DetailItem label="Remote Address" value={selectedRow.last_query_remote || "-"} />
                      <DetailItem label="Reason Code" value={selectedRow.last_query_reason || "-"} />
                      <DetailItem label="Active Worklist Count" value={selectedRow.active_worklist_count === null || selectedRow.active_worklist_count === undefined ? "-" : String(selectedRow.active_worklist_count)} />
                      <DetailItem label="Query Count" value={String(selectedRow.query_count)} />
                      <DetailItem label="Query Matched" value={String(selectedRow.matched_query_count)} />
                      <DetailItem label="Last Match Count" value={String(selectedRow.last_match_count)} />
                      <DetailItem label="Requested Return Keys" value={formatListValue(selectedRow.last_query_requested_keys)} className="md:col-span-2" />
                      <DetailItem label="Query Filters" value={formatListValue(selectedRow.last_query_filters)} className="md:col-span-2" />
                      <DetailItem label="Returned MWL ID" value={formatListValue(selectedRow.last_query_returned_ids)} className="md:col-span-2" />
                      <DetailItem label="Error Query" value={selectedRow.last_query_error || "-"} className="md:col-span-2" />
                      <DetailItem label="Recommendation" value={selectedRow.last_query_recommendation || "-"} className="md:col-span-2" />
                    </DetailGrid>
                  </DetailSection>
                )}

                <DetailSection title="Staff and Study">
                  <DetailGrid>
                    <DetailItem label="Technologist" value={selectedRow.technologist_name || selectedRow.technologist_username || "-"} />
                    <DetailItem label="Radiology Admin" value={selectedRow.nama_admin || "-"} />
                    <DetailItem label="Radiographer" value={selectedRow.nama_radiografer || "-"} />
                    <DetailItem label="Radiology Doctor" value={selectedRow.nama_radiolog || selectedRow.radiologist_doctor_name || "-"} />
                    <DetailItem label="Referring Doctor" value={selectedRow.referring_doctor_name || "-"} />
                    <DetailItem label="MWL Staff List" value={formatAssignedStaff(selectedRow.assigned_staff_json)} className="md:col-span-2" />
                    <DetailItem label="Clinical Notes" value={selectedRow.klinis || "-"} className="md:col-span-2" />
                    <DetailItem label="Diagnosis" value={selectedRow.diagnosa || "-"} className="md:col-span-2" />
                    <DetailItem label="Sync Message" value={selectedRow.log_message || "-"} className="md:col-span-2" />
                  </DetailGrid>
                </DetailSection>
              </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MwlStatusPage;
