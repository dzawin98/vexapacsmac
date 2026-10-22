import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Columns3,
  FileClock,
  ListTree,
  RefreshCw,
} from "lucide-react";
import { auditLogService, AuditLogEntry, MwlQueryLogEntry, MwlQueryLogFilters, preferencesService } from "@/lib/dicomService";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

const formatDateTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
};

const MwlOutcomeBadge = ({ outcome }: { outcome: string }) => {
  const normalized = String(outcome || "").toUpperCase();
  let className = "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-300";
  if (normalized === "MATCHED") {
    className = "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300";
  } else if (normalized === "NO_MATCH") {
    className = "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300";
  } else if (normalized === "ERROR" || normalized === "FAILURE" || normalized === "FAILED") {
    className = "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300";
  }
  return (
    <span className={`inline-flex max-w-[140px] items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}>
      <span className="truncate">{outcome || "-"}</span>
    </span>
  );
};

// ── MWL Column Definitions ──
interface MwlColumnDef {
  id: string;
  label: string;
  defaultVisible: boolean;
  mono?: boolean;
  truncate?: boolean;
  className?: string;
  render: (row: MwlQueryLogEntry) => ReactNode;
}

const ALL_MWL_COLUMNS: MwlColumnDef[] = [
  { id: "created_at", label: "Time", defaultVisible: true, render: row => formatDateTime(row.created_at) },
  { id: "calling_ae_title", label: "Calling AE", defaultVisible: true, mono: true, truncate: true, render: row => row.calling_ae_title || "-" },
  { id: "called_ae_title", label: "Called AE", defaultVisible: true, mono: true, truncate: true, render: row => row.called_ae_title || "-" },
  { id: "remote_address", label: "Remote", defaultVisible: true, mono: true, truncate: true, render: row => `${row.remote_address || "-"}:${row.remote_port || "-"}` },
  { id: "patient_name", label: "Patient Name", defaultVisible: true, render: row => row.patient_name || "-" },
  { id: "patient_id", label: "Patient ID", defaultVisible: true, mono: true, render: row => row.patient_id || "-" },
  { id: "accession_number", label: "Accession", defaultVisible: true, mono: true, render: row => row.accession_number || "-" },
  { id: "modality", label: "Modality", defaultVisible: true, render: row => row.modality || "-" },
  { id: "match_count", label: "Match", defaultVisible: true, className: "text-center", render: row => <span className="font-medium">{row.match_count}</span> },
  { id: "outcome", label: "Outcome", defaultVisible: true, render: row => <MwlOutcomeBadge outcome={row.outcome} /> },
  { id: "status_code", label: "Status", defaultVisible: true, mono: true, render: row => row.status_code || "-" },
  { id: "study_instance_uid", label: "Study UID", defaultVisible: false, mono: true, truncate: true, render: row => row.study_instance_uid || "-" },
  { id: "scheduled_station_ae_title", label: "Station AET", defaultVisible: false, mono: true, render: row => row.scheduled_station_ae_title || "-" },
  { id: "scheduled_date", label: "Scheduled Date", defaultVisible: false, render: row => row.scheduled_date || "-" },
  { id: "scheduled_time", label: "Scheduled Time", defaultVisible: false, render: row => row.scheduled_time || "-" },
  { id: "reason_code", label: "Reason Code", defaultVisible: false, mono: true, render: row => row.reason_code || "-" },
  { id: "error_message", label: "Error Message", defaultVisible: false, render: row => row.error_message || "-" },
  { id: "recommendation", label: "Recommendation", defaultVisible: false, render: row => row.recommendation || "-" },
  { id: "active_worklist_count", label: "Active WL Count", defaultVisible: false, render: row => row.active_worklist_count !== null && row.active_worklist_count !== undefined ? String(row.active_worklist_count) : "-" },
  { id: "matched_worklist_ids", label: "Matched Worklists", defaultVisible: false, render: row => (row.matched_worklist_ids?.length ? row.matched_worklist_ids.join(", ") : "-") },
  { id: "remote_port", label: "Remote Port", defaultVisible: false, render: row => row.remote_port !== null && row.remote_port !== undefined ? String(row.remote_port) : "-" },
  { id: "filter_summary_json", label: "Filter Summary", defaultVisible: false, truncate: true, render: row => row.filter_summary_json ? JSON.stringify(row.filter_summary_json).slice(0, 80) + "..." : "-" },
  { id: "query_json", label: "Raw Query", defaultVisible: false, truncate: true, render: row => row.query_json ? JSON.stringify(row.query_json).slice(0, 80) + "..." : "-" },
];

const MWL_COLUMNS_KEY = "mwlLogsVisibleColumns";
const DEFAULT_MWL_VISIBLE = ALL_MWL_COLUMNS.filter(c => c.defaultVisible).map(c => c.id);

const detailsToText = (entry: AuditLogEntry) => {
  const raw = entry.details_json;
  if (!raw) return "-";
  if (typeof raw === "string") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return JSON.stringify(raw, null, 2);
};

const parseDetails = (entry: AuditLogEntry): Record<string, unknown> | null => {
  const raw = entry.details_json;
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
};

const humanizeKey = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());

const metadataKeyMap: Record<string, { label: string; infoKey: string }> = {
  PatientName: { label: "Patient Name", infoKey: "patient_name" },
  patientName: { label: "Patient Name", infoKey: "patient_name" },
  PatientID: { label: "Patient ID", infoKey: "patient_id" },
  patientId: { label: "Patient ID", infoKey: "patient_id" },
  patientID: { label: "Patient ID", infoKey: "patient_id" },
  OtherPatientIDs: { label: "Other Patient IDs", infoKey: "other_patient_ids" },
  otherPatientIds: { label: "Other Patient IDs", infoKey: "other_patient_ids" },
  PatientBirthDate: { label: "Patient Birth Date", infoKey: "patient_birth_date" },
  patientBirthDate: { label: "Patient Birth Date", infoKey: "patient_birth_date" },
  PatientSex: { label: "Patient Sex", infoKey: "patient_sex" },
  patientSex: { label: "Patient Sex", infoKey: "patient_sex" },
  AccessionNumber: { label: "Accession", infoKey: "accession_number" },
  accessionNumber: { label: "Accession", infoKey: "accession_number" },
  InstitutionName: { label: "Institution", infoKey: "institution_name" },
  institutionName: { label: "Institution", infoKey: "institution_name" },
  StudyDescription: { label: "Study Description", infoKey: "study_description" },
  studyDescription: { label: "Study Description", infoKey: "study_description" },
  ReferringPhysicianName: { label: "Referring Physician", infoKey: "referring_physician" },
  referringPhysician: { label: "Referring Physician", infoKey: "referring_physician" },
  StudyDate: { label: "Study Date", infoKey: "study_date" },
  studyDate: { label: "Study Date", infoKey: "study_date" },
  StudyTime: { label: "Study Time", infoKey: "study_time" },
  studyTime: { label: "Study Time", infoKey: "study_time" },
  StudyID: { label: "Study ID", infoKey: "study_id" },
  studyId: { label: "Study ID", infoKey: "study_id" },
};

const valueFromObject = (source: unknown, key: string) => {
  if (!source || typeof source !== "object" || Array.isArray(source)) return "";
  const value = (source as Record<string, unknown>)[key];
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const getChangeRows = (entry: AuditLogEntry) => {
  const details = parseDetails(entry);
  const changes = details?.changes;
  if (changes && typeof changes === "object" && !Array.isArray(changes)) {
    return Object.entries(changes as Record<string, unknown>)
      .map(([keyword, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const change = value as Record<string, unknown>;
        return {
          keyword,
          label: String(change.label || humanizeKey(keyword)),
          from: change.from === undefined || change.from === null ? "" : String(change.from),
          to: change.to === undefined || change.to === null ? "" : String(change.to),
        };
      })
      .filter(Boolean) as { keyword: string; label: string; from: string; to: string }[];
  }

  const fields = Array.isArray(details?.fields) ? (details.fields as unknown[]) : [];
  const before = details?.before;
  const after = details?.after;
  if (!fields.length || !before || !after) return [];

  return fields.map(rawField => {
    const keyword = String(rawField);
    const mapped = metadataKeyMap[keyword] || { label: humanizeKey(keyword), infoKey: keyword };
    return {
      keyword,
      label: mapped.label,
      from: valueFromObject(before, mapped.infoKey),
      to: valueFromObject(after, mapped.infoKey),
    };
  });
};

const getDeleteReason = (entry: AuditLogEntry) => {
  const details = parseDetails(entry);
  const reason = details?.deleteReason || details?.reason;
  return reason === undefined || reason === null ? "" : String(reason);
};

type LogCategoryKey = "routing" | "troubleshooting" | "security" | "performance" | "compliance";

const logCategoryDefinitions: Record<LogCategoryKey, { label: string; description: string }> = {
  routing: {
    label: "DICOM Routing",
    description: "Scheduled and manual DICOM transfers, destinations, retries, verification, and delivery failures.",
  },
  troubleshooting: {
    label: "Troubleshooting & Debugging",
    description:
      "Error, crash, slow response, failed module, and technical diagnostic events for root-cause analysis.",
  },
  security: {
    label: "Security and Audit Trail",
    description:
      "Login, access source, user identity, IP address, and action trail for security investigation.",
  },
  performance: {
    label: "Performance Monitoring",
    description:
      "Response time, server activity, MWL/DICOM traffic, and bottleneck indicators.",
  },
  compliance: {
    label: "Compliance",
    description:
      "Stored evidence fields and user actions retained as proof for operational or regulatory audit.",
  },
};

const getLogCategory = (entry: AuditLogEntry): LogCategoryKey => {
  const event = String(entry.event_type || "").toLowerCase();
  const target = String(entry.target_type || "").toLowerCase();
  const details = detailsToText(entry).toLowerCase();
  const haystack = `${event} ${target} ${details}`;

  if (event.includes("dicom_routing")) return "routing";

  if (/(mwl|dicom|dimse|dicomweb|viewer|query|latency|performance|slow|timeout|server|memory|heap|rss|ping)/.test(haystack)) {
    return "performance";
  }

  if (/(login|logout|auth|password|permission|role|user|session|access)/.test(haystack)) {
    return "security";
  }

  if (
    entry.outcome === "failure" ||
    /(error|exception|failed|failure|crash|debug|troubleshoot|unavailable|invalid)/.test(haystack)
  ) {
    return "troubleshooting";
  }

  return "compliance";
};

const CategoryBadge = ({ category }: { category: LogCategoryKey }) => {
  const className =
    category === "routing"
      ? "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-300"
      : category === "troubleshooting"
      ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
      : category === "security"
        ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300"
        : category === "performance"
          ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300";

  return (
    <span className={`inline-flex max-w-[220px] items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}>
      <span className="truncate">{logCategoryDefinitions[category].label}</span>
    </span>
  );
};

const getLogTopic = (entry: AuditLogEntry) => {
  const event = String(entry.event_type || "").toLowerCase();
  const target = String(entry.target_type || "").toLowerCase();
  const outcome = String(entry.outcome || "").toLowerCase();
  const details = detailsToText(entry).toLowerCase();
  const haystack = `${event} ${target} ${details}`;

  if (event.includes("dicom_routing_schedule")) return "DICOM Routing Schedule";
  if (event.includes("dicom_routing")) return outcome === "failure" ? "DICOM Routing Failed" : "DICOM Routing Success";

  if (haystack.includes("no_match") || haystack.includes("unmatch") || haystack.includes("no match")) {
    return "MWL Unmatch";
  }
  if (haystack.includes("matched") || haystack.includes("match")) {
    return "MWL Match";
  }
  if (event.includes("mwl") && event.includes("send")) {
    return outcome === "failure" ? "Send to MWL Failed" : "Send to MWL";
  }
  if (event.includes("mwl") && (event.includes("query") || target.includes("query"))) {
    return "MWL Query";
  }
  if (event.includes("login")) {
    return outcome === "failure" ? "Login Failed" : "Login";
  }
  if (event.includes("delete")) {
    return "Delete Action";
  }
  if (event.includes("update") || event.includes("edit")) {
    return "Update Action";
  }
  if (event.includes("create") || event.includes("add")) {
    return "Create Action";
  }
  if (event.includes("viewer") || event.includes("view")) {
    return "Viewer Access";
  }

  return humanizeKey(entry.event_type || entry.target_type || "System Event");
};

const getLogMessage = (entry: AuditLogEntry) => {
  const parts = [
    `Event: ${entry.event_type || "-"}`,
    `Outcome: ${entry.outcome || "-"}`,
    entry.username ? `User: ${entry.username}${entry.role ? ` (${entry.role})` : ""}` : "",
    entry.ip_address ? `IP: ${entry.ip_address}` : "",
    entry.target_type || entry.target_id ? `Target: ${[entry.target_type, entry.target_id].filter(Boolean).join(" / ")}` : "",
    entry.study_info?.patient_id || entry.study_info?.patient_name
      ? `Patient: ${[entry.study_info?.patient_id, entry.study_info?.patient_name].filter(Boolean).join(" - ")}`
      : "",
    entry.study_info?.accession_number ? `Accession: ${entry.study_info.accession_number}` : "",
    entry.study_info?.study_description ? `Study: ${entry.study_info.study_description}` : "",
    entry.study_info?.modality ? `Modality: ${entry.study_info.modality}` : "",
  ].filter(Boolean);

  const details = detailsToText(entry);
  if (details && details !== "-") {
    parts.push(`Details: ${details.replace(/\s+/g, " ").trim()}`);
  }

  return parts.join(" | ");
};

const DetailItem = ({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) => (
  <div className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
    <div className="text-muted-foreground">{label}</div>
    <div
      className={
        mono
          ? "min-w-0 break-all font-mono text-xs leading-5 text-foreground"
          : "min-w-0 break-words text-foreground [overflow-wrap:anywhere]"
      }
    >
      {value || "-"}
    </div>
  </div>
);

const DetailSection = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="min-w-0 rounded-lg border border-border bg-card">
    <div className="border-b border-border px-4 py-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    </div>
    <div className="min-w-0 divide-y divide-border px-4 py-1">{children}</div>
  </div>
);

const formatMwlJson = (value: unknown): string => {
  if (!value) return "-";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }
  return JSON.stringify(value, null, 2);
};

const AuditLogPage = () => {
  // System Logs state
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | LogCategoryKey>("all");
  const [rowsPerPage, setRowsPerPage] = useState("25");
  const [page, setPage] = useState(1);

  // MWL Logs state
  const [mwlLogs, setMwlLogs] = useState<MwlQueryLogEntry[]>([]);
  const [mwlLoading, setMwlLoading] = useState(false);
  const [mwlError, setMwlError] = useState("");
  const [selectedMwlLog, setSelectedMwlLog] = useState<MwlQueryLogEntry | null>(null);
  const [mwlOutcomeFilter, setMwlOutcomeFilter] = useState<string>("all");
  const [mwlDateFrom, setMwlDateFrom] = useState("");
  const [mwlDateTo, setMwlDateTo] = useState("");
  const [mwlSearchAe, setMwlSearchAe] = useState("");
  const [mwlRowsPerPage, setMwlRowsPerPage] = useState("25");
  const [mwlPage, setMwlPage] = useState(1);
  const [activeTab, setActiveTab] = useState("system-logs");
  const [mwlVisibleColumns, setMwlVisibleColumns] = useState<string[]>(DEFAULT_MWL_VISIBLE);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const filters = useMemo(
    () => ({
      limit: 500,
    }),
    []
  );

  const loadLogs = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await auditLogService.fetchLogs(filters);
      setLogs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit logs");
    } finally {
      setLoading(false);
    }
  };

  const loadMwlLogs = async () => {
    setMwlLoading(true);
    setMwlError("");
    try {
      const mwlFilters: MwlQueryLogFilters = { limit: 500 };
      if (mwlSearchAe.trim()) mwlFilters.callingAe = mwlSearchAe.trim();
      if (mwlOutcomeFilter !== "all") mwlFilters.outcome = mwlOutcomeFilter;
      const data = await auditLogService.fetchMwlQueryLogs(mwlFilters);
      setMwlLogs(data);
    } catch (err) {
      setMwlError(err instanceof Error ? err.message : "Failed to load MWL query logs");
    } finally {
      setMwlLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

  useEffect(() => {
    if (activeTab === "mwl-logs") {
      loadMwlLogs();
    }
  }, [activeTab]);

  // Save column visibility to user preferences when changed
  const toggleMwlColumn = (columnId: string) => {
    setMwlVisibleColumns(prev => {
      const next = prev.includes(columnId)
        ? prev.filter(id => id !== columnId)
        : [...prev, columnId];
      // Debounce save
      preferencesService.save({ [MWL_COLUMNS_KEY]: next }).catch(() => {});
      return next;
    });
  };

  // Load user preferences for MWL columns
  useEffect(() => {
    (async () => {
      try {
        const prefs = await preferencesService.fetch();
        const saved = prefs[MWL_COLUMNS_KEY];
        if (Array.isArray(saved) && saved.length > 0) {
          setMwlVisibleColumns(saved);
        }
      } catch {
        // silently use defaults
      } finally {
        setPrefsLoaded(true);
      }
    })();
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter(entry => {
      if (categoryFilter !== "all" && getLogCategory(entry) !== categoryFilter) {
        return false;
      }

      const createdAt = entry.created_at ? new Date(entry.created_at) : null;
      if (!createdAt || Number.isNaN(createdAt.getTime())) return true;

      if (dateFrom) {
        const fromDate = new Date(`${dateFrom}T00:00:00`);
        if (createdAt < fromDate) return false;
      }

      if (dateTo) {
        const toDate = new Date(`${dateTo}T23:59:59`);
        if (createdAt > toDate) return false;
      }

      return true;
    });
  }, [categoryFilter, dateFrom, dateTo, logs]);

  const normalizedRowsPerPage = useMemo(() => {
    const parsed = Number(rowsPerPage);
    return parsed === 50 || parsed === 100 ? parsed : 25;
  }, [rowsPerPage]);

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / normalizedRowsPerPage));

  useEffect(() => {
    setPage(1);
  }, [categoryFilter, dateFrom, dateTo, rowsPerPage]);

  useEffect(() => {
    setPage(current => Math.min(current, totalPages));
  }, [totalPages]);

  const paginatedLogs = useMemo(() => {
    const start = (page - 1) * normalizedRowsPerPage;
    return filteredLogs.slice(start, start + normalizedRowsPerPage);
  }, [filteredLogs, normalizedRowsPerPage, page]);

  // MWL computed state
  const filteredMwlLogs = useMemo(() => {
    return mwlLogs.filter(entry => {
      const createdAt = entry.created_at ? new Date(entry.created_at) : null;
      if (!createdAt || Number.isNaN(createdAt.getTime())) return true;
      if (mwlDateFrom) {
        const fromDate = new Date(`${mwlDateFrom}T00:00:00`);
        if (createdAt < fromDate) return false;
      }
      if (mwlDateTo) {
        const toDate = new Date(`${mwlDateTo}T23:59:59`);
        if (createdAt > toDate) return false;
      }
      return true;
    });
  }, [mwlLogs, mwlDateFrom, mwlDateTo]);

  const normalizedMwlRowsPerPage = useMemo(() => {
    const parsed = Number(mwlRowsPerPage);
    return parsed === 50 || parsed === 100 ? parsed : 25;
  }, [mwlRowsPerPage]);

  const mwlTotalPages = Math.max(1, Math.ceil(filteredMwlLogs.length / normalizedMwlRowsPerPage));

  useEffect(() => {
    setMwlPage(1);
  }, [mwlOutcomeFilter, mwlDateFrom, mwlDateTo, mwlSearchAe, mwlRowsPerPage]);

  useEffect(() => {
    setMwlPage(current => Math.min(current, mwlTotalPages));
  }, [mwlTotalPages]);

  const paginatedMwlLogs = useMemo(() => {
    const start = (mwlPage - 1) * normalizedMwlRowsPerPage;
    return filteredMwlLogs.slice(start, start + normalizedMwlRowsPerPage);
  }, [filteredMwlLogs, normalizedMwlRowsPerPage, mwlPage]);

  return (
    <div className="admin-command-page min-h-screen bg-background p-6">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileClock className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">System Log</h1>
              </div>
            </div>
            <TabsList>
              <TabsTrigger value="system-logs" className="gap-2">
                <FileClock className="h-4 w-4" />
                System Log
              </TabsTrigger>
              <TabsTrigger value="mwl-logs" className="gap-2">
                <ListTree className="h-4 w-4" />
                MWL Logs
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="system-logs" className="mt-0 space-y-5">
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}

            <div className="rounded-lg border border-border bg-card shadow-sm">
              <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Log Detail</h2>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
                  <Select value={categoryFilter} onValueChange={value => setCategoryFilter(value as "all" | LogCategoryKey)}>
                    <SelectTrigger className="h-9 w-[260px]">
                      <SelectValue placeholder="Log Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {Object.entries(logCategoryDefinitions).map(([key, category]) => (
                        <SelectItem key={key} value={key}>
                          {category.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(dateFrom || dateTo) && (
                    <Badge variant="outline" className="h-9 rounded-lg px-3 font-normal">
                      {dateFrom || "..."} to {dateTo || "..."}
                    </Badge>
                  )}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-9 w-9"
                        title={
                          dateFrom || dateTo
                            ? `Date filter: ${dateFrom || "-"} to ${dateTo || "-"}`
                            : "Date filter"
                        }
                      >
                        <CalendarDays className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-[260px] space-y-3">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Start date</div>
                        <Input
                          type="date"
                          value={dateFrom}
                          onChange={event => setDateFrom(event.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">End date</div>
                        <Input
                          type="date"
                          value={dateTo}
                          onChange={event => setDateTo(event.target.value)}
                        />
                      </div>
                      <div className="flex justify-between gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDateFrom("");
                            setDateTo("");
                          }}
                        >
                          Reset
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button type="button" variant="outline" size="icon" onClick={loadLogs} disabled={loading} title="Refresh logs">
                    <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                  </Button>
                </div>
              </div>
              <div className="px-5 pb-5 pt-4">
                <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="w-[72px]">No.</TableHead>
                      <TableHead className="min-w-[170px]">Time</TableHead>
                      <TableHead className="min-w-[220px]">Category</TableHead>
                      <TableHead className="min-w-[180px]">Topics</TableHead>
                      <TableHead className="min-w-[520px]">Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-28 text-center text-muted-foreground">
                          Loading audit logs...
                        </TableCell>
                      </TableRow>
                    ) : paginatedLogs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-28 text-center text-muted-foreground">
                          No audit logs found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedLogs.map((entry, index) => (
                        <TableRow
                          key={entry.id}
                          onDoubleClick={() => setSelectedLog(entry)}
                          className="cursor-pointer transition-colors hover:bg-muted/35"
                        >
                          <TableCell className="whitespace-nowrap font-medium text-muted-foreground">
                            {(page - 1) * normalizedRowsPerPage + index + 1}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{formatDateTime(entry.created_at)}</TableCell>
                          <TableCell>
                            <CategoryBadge category={getLogCategory(entry)} />
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="rounded-full px-2.5 py-1 font-normal">
                              {getLogTopic(entry)}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className="max-w-[720px] whitespace-normal break-words text-sm leading-5 text-foreground [overflow-wrap:anywhere]"
                            title={getLogMessage(entry)}
                          >
                            {getLogMessage(entry)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                </div>

                <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-muted-foreground">
                    Showing {paginatedLogs.length} of {filteredLogs.length} logs
                    {categoryFilter !== "all" ? ` in ${logCategoryDefinitions[categoryFilter].label}` : ""}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span>Rows</span>
                      <Select value={rowsPerPage} onValueChange={setRowsPerPage}>
                        <SelectTrigger className="w-[88px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="25">25</SelectItem>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <span>
                      Page {page} / {totalPages}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setPage(current => Math.max(current - 1, 1))}
                        disabled={page <= 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setPage(current => Math.min(current + 1, totalPages))}
                        disabled={page >= totalPages}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="mwl-logs" className="mt-0 space-y-5">
            {mwlError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                <span>{mwlError}</span>
              </div>
            )}

            <div className="rounded-lg border border-border bg-card shadow-sm">
              <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-semibold text-foreground">MWL Query Logs</h2>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" size="sm" className="h-8 gap-2 text-xs">
                        <Columns3 className="h-3.5 w-3.5" />
                        Columns
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-[200px]">
                      <DropdownMenuLabel>Show/Hide Columns</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {ALL_MWL_COLUMNS.map(col => (
                        <DropdownMenuCheckboxItem
                          key={col.id}
                          checked={mwlVisibleColumns.includes(col.id)}
                          onCheckedChange={() => toggleMwlColumn(col.id)}
                          onSelect={e => e.preventDefault()}
                        >
                          {col.label}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
                  <div className="relative">
                    <Input
                      type="text"
                      placeholder="Calling AE..."
                      value={mwlSearchAe}
                      onChange={e => setMwlSearchAe(e.target.value)}
                      className="h-9 w-[160px]"
                      onKeyDown={e => { if (e.key === 'Enter') loadMwlLogs(); }}
                    />
                  </div>
                  <Select value={mwlOutcomeFilter} onValueChange={setMwlOutcomeFilter}>
                    <SelectTrigger className="h-9 w-[150px]">
                      <SelectValue placeholder="Outcome" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Outcomes</SelectItem>
                      <SelectItem value="MATCHED">Matched</SelectItem>
                      <SelectItem value="NO_MATCH">No Match</SelectItem>
                      <SelectItem value="ERROR">Error</SelectItem>
                    </SelectContent>
                  </Select>
                  {(mwlDateFrom || mwlDateTo) && (
                    <Badge variant="outline" className="h-9 rounded-lg px-3 font-normal">
                      {mwlDateFrom || "..."} to {mwlDateTo || "..."}
                    </Badge>
                  )}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-9 w-9"
                        title={mwlDateFrom || mwlDateTo ? `Date filter: ${mwlDateFrom || "-"} to ${mwlDateTo || "-"}` : "Date filter"}
                      >
                        <CalendarDays className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-[260px] space-y-3">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Start date</div>
                        <Input
                          type="date"
                          value={mwlDateFrom}
                          onChange={event => setMwlDateFrom(event.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">End date</div>
                        <Input
                          type="date"
                          value={mwlDateTo}
                          onChange={event => setMwlDateTo(event.target.value)}
                        />
                      </div>
                      <div className="flex justify-between gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => { setMwlDateFrom(""); setMwlDateTo(""); }}
                        >
                          Reset
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button type="button" variant="outline" size="icon" onClick={loadMwlLogs} disabled={mwlLoading} title="Refresh MWL logs">
                    <RefreshCw className={mwlLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                  </Button>
                </div>
              </div>
              <div className="px-5 pb-5 pt-4">
                <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="w-[60px]">No.</TableHead>
                      {ALL_MWL_COLUMNS.filter(c => mwlVisibleColumns.includes(c.id)).map(col => (
                        <TableHead key={col.id} className={col.id === "match_count" ? "w-[64px] text-center" : col.id === "outcome" ? "w-[110px]" : "min-w-[90px]"}>
                          {col.label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mwlLoading ? (
                      <TableRow>
                        <TableCell colSpan={mwlVisibleColumns.length + 1} className="h-28 text-center text-muted-foreground">
                          Loading MWL query logs...
                        </TableCell>
                      </TableRow>
                    ) : filteredMwlLogs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={mwlVisibleColumns.length + 1} className="h-28 text-center text-muted-foreground">
                          No MWL query logs found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedMwlLogs.map((entry, index) => {
                        const visibleCols = ALL_MWL_COLUMNS.filter(c => mwlVisibleColumns.includes(c.id));
                        return (
                          <TableRow
                            key={entry.id}
                            onDoubleClick={() => setSelectedMwlLog(entry)}
                            className="cursor-pointer transition-colors hover:bg-muted/35"
                          >
                            <TableCell className="whitespace-nowrap font-medium text-muted-foreground">
                              {(mwlPage - 1) * normalizedMwlRowsPerPage + index + 1}
                            </TableCell>
                            {visibleCols.map(col => {
                              const rendered = col.render(entry);
                              const className = [
                                "whitespace-nowrap",
                                col.mono ? "font-mono text-xs" : "text-sm",
                                col.truncate ? "max-w-[140px] truncate" : "",
                                col.className || "",
                              ].filter(Boolean).join(" ");
                              const title = typeof rendered === "string" ? rendered : undefined;
                              return (
                                <TableCell key={col.id} className={className} title={title}>
                                  {rendered}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
                </div>

                <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-muted-foreground">
                    Showing {paginatedMwlLogs.length} of {filteredMwlLogs.length} MWL logs
                    {mwlOutcomeFilter !== "all" ? ` (${mwlOutcomeFilter})` : ""}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span>Rows</span>
                      <Select value={mwlRowsPerPage} onValueChange={setMwlRowsPerPage}>
                        <SelectTrigger className="w-[88px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="25">25</SelectItem>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <span>
                      Page {mwlPage} / {mwlTotalPages}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setMwlPage(current => Math.max(current - 1, 1))}
                        disabled={mwlPage <= 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setMwlPage(current => Math.min(current + 1, mwlTotalPages))}
                        disabled={mwlPage >= mwlTotalPages}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <Dialog open={Boolean(selectedLog)} onOpenChange={open => !open && setSelectedLog(null)}>
          <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden rounded-lg p-0">
            <DialogHeader>
              <div className="border-b border-border px-6 py-4">
                <DialogTitle className="text-lg font-semibold">System Log Detail</DialogTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedLog ? `${getLogTopic(selectedLog)} - ${logCategoryDefinitions[getLogCategory(selectedLog)].label}` : ""}
                </p>
              </div>
            </DialogHeader>
            {selectedLog && (
              <div className="max-h-[calc(88vh-86px)] min-w-0 space-y-4 overflow-y-auto px-6 pb-6 pt-4">
                <DetailSection title="Log Summary">
                  <DetailItem label="Time" value={formatDateTime(selectedLog.created_at)} />
                  <div className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
                    <div className="text-muted-foreground">Category</div>
                    <div>
                      <CategoryBadge category={getLogCategory(selectedLog)} />
                    </div>
                  </div>
                  <DetailItem label="Topics" value={getLogTopic(selectedLog)} />
                  <DetailItem label="Message" value={getLogMessage(selectedLog)} />
                </DetailSection>

                <DetailSection title="Structured Evidence">
                  <DetailItem label="Event Type" value={selectedLog.event_type} />
                  <div className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
                    <div className="text-muted-foreground">Outcome</div>
                    <div>
                      <Badge variant={selectedLog.outcome === "success" ? "secondary" : "destructive"}>
                        {selectedLog.outcome}
                      </Badge>
                    </div>
                  </div>
                  <DetailItem label="Username" value={selectedLog.username} />
                  <DetailItem label="Role" value={selectedLog.role} />
                  <DetailItem label="IP Address" value={selectedLog.ip_address} />
                  <DetailItem label="Target Type" value={selectedLog.target_type} />
                  <DetailItem label="Target ID" value={selectedLog.target_id} mono />
                  {getDeleteReason(selectedLog) && (
                    <DetailItem label="Delete Reason" value={getDeleteReason(selectedLog)} />
                  )}
                </DetailSection>

                {(selectedLog.study_info?.patient_id ||
                  selectedLog.study_info?.patient_name ||
                  selectedLog.study_info?.accession_number ||
                  selectedLog.study_info?.study_description ||
                  selectedLog.study_info?.modality) && (
                  <DetailSection title="Study Context">
                    <DetailItem label="Patient ID" value={selectedLog.study_info?.patient_id} />
                    <DetailItem label="Patient Name" value={selectedLog.study_info?.patient_name} />
                    <DetailItem label="Birth Date" value={selectedLog.study_info?.patient_birth_date} />
                    <DetailItem label="Sex" value={selectedLog.study_info?.patient_sex} />
                    <DetailItem label="Accession" value={selectedLog.study_info?.accession_number} />
                    <DetailItem label="Institution" value={selectedLog.study_info?.institution_name} />
                    <DetailItem label="Study" value={selectedLog.study_info?.study_description} />
                    <DetailItem label="Referring" value={selectedLog.study_info?.referring_physician} />
                    <DetailItem label="Modality" value={selectedLog.study_info?.modality} />
                    <DetailItem label="Study Date" value={selectedLog.study_info?.study_date} />
                    <DetailItem label="Study Time" value={selectedLog.study_info?.study_time} />
                  </DetailSection>
                )}

                {getChangeRows(selectedLog).length > 0 && (
                  <DetailSection title="Metadata Changes">
                    <div className="grid min-w-0 grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)] gap-3 py-2 text-xs font-semibold text-muted-foreground md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)]">
                      <div>Field</div>
                      <div>Before</div>
                      <div>After</div>
                    </div>
                    {getChangeRows(selectedLog).map(change => (
                      <div
                        key={change.keyword}
                        className="grid min-w-0 grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)] gap-3 py-2 text-sm md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)]"
                      >
                        <div className="min-w-0 break-words text-muted-foreground [overflow-wrap:anywhere]">
                          {change.label}
                        </div>
                        <div className="min-w-0 break-words text-foreground [overflow-wrap:anywhere]">
                          {change.from || "-"}
                        </div>
                        <div className="min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                          {change.to || "-"}
                        </div>
                      </div>
                    ))}
                  </DetailSection>
                )}

                {(selectedLog.study_instance_uid ||
                  selectedLog.series_instance_uid ||
                  selectedLog.sop_instance_uid ||
                  selectedLog.user_agent) && (
                  <DetailSection title="Technical Context">
                    <DetailItem label="Study UID" value={selectedLog.study_instance_uid} mono />
                    <DetailItem label="Series UID" value={selectedLog.series_instance_uid} mono />
                    <DetailItem label="SOP UID" value={selectedLog.sop_instance_uid} mono />
                    <DetailItem label="User Agent" value={selectedLog.user_agent} />
                  </DetailSection>
                )}

                <DetailSection title="Raw Evidence">
                  <div className="min-w-0 overflow-x-auto py-3">
                    <pre className="whitespace-pre text-xs leading-5 text-muted-foreground">
                      {detailsToText(selectedLog)}
                    </pre>
                  </div>
                </DetailSection>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(selectedMwlLog)} onOpenChange={open => !open && setSelectedMwlLog(null)}>
          <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden rounded-lg p-0">
            <DialogHeader>
              <div className="border-b border-border px-6 py-4">
                <DialogTitle className="text-lg font-semibold">MWL Query Log Detail</DialogTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedMwlLog ? `${selectedMwlLog.outcome} - ${selectedMwlLog.calling_ae_title || "Unknown AE"} / ${selectedMwlLog.called_ae_title || "Unknown"}` : ""}
                </p>
              </div>
            </DialogHeader>
            {selectedMwlLog && (
              <div className="max-h-[calc(88vh-86px)] min-w-0 space-y-4 overflow-y-auto px-6 pb-6 pt-4">
                <DetailSection title="General">
                  <DetailItem label="Time" value={formatDateTime(selectedMwlLog.created_at)} />
                  <DetailItem label="Calling AE" value={selectedMwlLog.calling_ae_title} mono />
                  <DetailItem label="Called AE" value={selectedMwlLog.called_ae_title} mono />
                  <DetailItem label="Remote Address" value={selectedMwlLog.remote_address ? `${selectedMwlLog.remote_address}:${selectedMwlLog.remote_port || ""}` : "-"} mono />
                </DetailSection>

                {(selectedMwlLog.patient_id || selectedMwlLog.patient_name || selectedMwlLog.accession_number || selectedMwlLog.study_instance_uid || selectedMwlLog.modality || selectedMwlLog.scheduled_station_ae_title || selectedMwlLog.scheduled_date) && (
                  <DetailSection title="Query Info">
                    <DetailItem label="Patient ID" value={selectedMwlLog.patient_id} mono />
                    <DetailItem label="Patient Name" value={selectedMwlLog.patient_name} />
                    <DetailItem label="Accession" value={selectedMwlLog.accession_number} mono />
                    <DetailItem label="Study UID" value={selectedMwlLog.study_instance_uid} mono />
                    <DetailItem label="Modality" value={selectedMwlLog.modality} />
                    <DetailItem label="Station AET" value={selectedMwlLog.scheduled_station_ae_title} mono />
                    <DetailItem label="Scheduled Date" value={selectedMwlLog.scheduled_date} />
                    <DetailItem label="Scheduled Time" value={selectedMwlLog.scheduled_time} />
                  </DetailSection>
                )}

                <DetailSection title="Result">
                  <div className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
                    <div className="text-muted-foreground">Outcome</div>
                    <div>
                      <MwlOutcomeBadge outcome={selectedMwlLog.outcome} />
                    </div>
                  </div>
                  <DetailItem label="Match Count" value={String(selectedMwlLog.match_count)} />
                  <DetailItem label="Status Code" value={selectedMwlLog.status_code} mono />
                  <DetailItem label="Reason Code" value={selectedMwlLog.reason_code} mono />
                  <DetailItem label="Error Message" value={selectedMwlLog.error_message} />
                  <DetailItem label="Recommendation" value={selectedMwlLog.recommendation} />
                  <DetailItem label="Active Worklists" value={selectedMwlLog.active_worklist_count !== null && selectedMwlLog.active_worklist_count !== undefined ? String(selectedMwlLog.active_worklist_count) : null} />
                </DetailSection>

                {selectedMwlLog.matched_worklist_ids && selectedMwlLog.matched_worklist_ids.length > 0 && (
                  <DetailSection title="Matched Worklists">
                    <DetailItem label="Worklist IDs" value={selectedMwlLog.matched_worklist_ids.join(", ")} />
                  </DetailSection>
                )}

                {selectedMwlLog.filter_summary_json && (
                  <DetailSection title="Filter Summary">
                    <div className="min-w-0 overflow-x-auto py-3">
                      <pre className="whitespace-pre text-xs leading-5 text-muted-foreground">
                        {formatMwlJson(selectedMwlLog.filter_summary_json)}
                      </pre>
                    </div>
                  </DetailSection>
                )}

                {selectedMwlLog.query_json && (
                  <DetailSection title="Raw Query JSON">
                    <div className="min-w-0 overflow-x-auto py-3">
                      <pre className="whitespace-pre text-xs leading-5 text-muted-foreground">
                        {formatMwlJson(selectedMwlLog.query_json)}
                      </pre>
                    </div>
                  </DetailSection>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default AuditLogPage;
