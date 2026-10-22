import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { WorklistItem } from "@/data/mockData";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Trash2, Columns3, ChevronLeft, ChevronRight, Loader2, Send, CalendarDays, UserPlus, ArrowDown, ArrowUp, ArrowUpDown, Database, Images, Layers3, MonitorDot, HeartPulse } from "lucide-react";
import StudyDetailDialog from "@/components/StudyDetailDialog";
import StudySeriesPreviewPanel from "@/components/StudySeriesPreviewPanel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import {
  dicomWebService,
  dicomForwardService,
  mwlService,
  mwlReconcileService,
  radiologistAssignmentService,
  usersService,
  WorklistItem as DicomWorklistItem,
  DicomNode,
  MwlOrder,
  MwlReconcileCandidate,
  RadiologistAssignment,
  ViewerConfig,
  User,
} from "@/lib/dicomService";
import { isViewerAllowedForModality, openViewerInNamedWindow } from "@/lib/viewerWindow";
import { getViewerButtonLabel } from "@/lib/viewerLabels";
import { useAuth } from "@/contexts/AuthContext";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";

const formatDicomDate = (value: string): string => {
  if (!value) return "";
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 8) return value;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  return `${day}/${month}/${year}`;
};

const formatDicomDateTime = (date: string, time?: string): string => {
  const datePart = formatDicomDate(date);
  if (!time) return datePart;
  const digits = time.replace(/[^0-9]/g, "");
  if (digits.length < 4) return datePart;
  const hour = digits.slice(0, 2);
  const minute = digits.slice(2, 4);
  const second = digits.length >= 6 ? digits.slice(4, 6) : "";
  const timePart = second ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
  return datePart ? `${datePart} ${timePart}` : timePart;
};

const calculateAge = (birthDate: string, studyDate?: string): string => {
  const digitsBirth = birthDate.replace(/[^0-9]/g, "");
  if (digitsBirth.length < 8) return "";
  const birthYear = Number(digitsBirth.slice(0, 4));
  const birthMonth = Number(digitsBirth.slice(4, 6));
  const birthDay = Number(digitsBirth.slice(6, 8));
  const reference = studyDate && studyDate.replace(/[^0-9]/g, "").length >= 8 ? studyDate : "";
  let refYear: number;
  let refMonth: number;
  let refDay: number;
  if (reference) {
    const digitsRef = reference.replace(/[^0-9]/g, "");
    refYear = Number(digitsRef.slice(0, 4));
    refMonth = Number(digitsRef.slice(4, 6));
    refDay = Number(digitsRef.slice(6, 8));
  } else {
    const now = new Date();
    refYear = now.getFullYear();
    refMonth = now.getMonth() + 1;
    refDay = now.getDate();
  }
  if (!Number.isFinite(birthYear) || !Number.isFinite(refYear)) return "";
  let age = refYear - birthYear;
  if (refMonth < birthMonth || (refMonth === birthMonth && refDay < birthDay)) {
    age -= 1;
  }
  return age >= 0 && Number.isFinite(age) ? String(age) : "";
};

type ColumnDefinition = {
  key: string;
  label: string;
  width?: number;
};

type ExtraColumn = {
  key: string;
  label: string;
  width?: number;
  renderCell: (row: WorklistItem) => ReactNode;
  getValue?: (row: WorklistItem) => string;
};

const EMPTY_EXTRA_COLUMNS: ExtraColumn[] = [];

const ALL_COLUMNS: ColumnDefinition[] = [
  { key: "patientId", label: "Patient ID" },
  { key: "patientName", label: "Patient Name" },
  { key: "accessionNumber", label: "Accession #" },
  { key: "modalityCode", label: "Modality" },
  { key: "studyDescription", label: "Study Description" },
  { key: "birthDate", label: "Birth Date" },
  { key: "age", label: "Age" },
  { key: "imageCount", label: "Images" },
  { key: "seriesCount", label: "Series" },
  { key: "referringPhysician", label: "Referring Physician" },
  { key: "studyDate", label: "Study Date" },
  { key: "status", label: "Status" },
] as const;

type ColumnKey = string;

const DEFAULT_COLUMN_ORDER: string[] = [
  "studyDate",
  "patientId",
  "patientName",
  "accessionNumber",
  "modalityCode",
  "studyDescription",
  "birthDate",
  "age",
  "imageCount",
  "seriesCount",
  "referringPhysician",
  "status",
];

const DEFAULT_VISIBLE_COLUMNS: string[] = DEFAULT_COLUMN_ORDER;

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 100;

const DEFAULT_COLUMN_WIDTH: Record<string, number> = {
  patientId: 140,
  patientName: 180,
  accessionNumber: 150,
  modalityCode: 110,
  studyDescription: 200,
  birthDate: 130,
  age: 90,
  imageCount: 110,
  seriesCount: 110,
  referringPhysician: 180,
  studyDate: 170,
  status: 120,
  radiologistName: 200,
  radiologistAction: 80,
};

const DEFAULT_MOBILE_COLUMNS: string[] = [
  "studyDate",
  "patientId",
  "patientName",
  "modalityCode",
  "studyDescription",
];

type DateFilterMode = "all" | "today" | "yesterday" | "7days" | "30days" | "1month" | "2months" | "range";

type WorklistProps = {
  onOpenStudy?: (row: WorklistItem) => void;
  enableDetailDialog?: boolean;
  extraColumns?: ExtraColumn[];
  onDataLoaded?: (rows: WorklistItem[]) => void;
  onProcessSelected?: (rows: WorklistItem[]) => void;
  processLabel?: string;
  title?: string;
  storageKey?: string;
  defaultColumnOrder?: string[];
  defaultVisibleColumns?: string[];
  headerActions?: ReactNode;
  rowFilter?: (row: WorklistItem, context?: { search: string }) => boolean;
  prioritySort?: (row: WorklistItem) => number;
  filterActions?: ReactNode;
  enableRadiologistAssignment?: boolean;
  showRadiologistAction?: boolean;
  externalRows?: WorklistItem[];
  externalLoading?: boolean;
  externalError?: string | null;
  initialDateFilterMode?: DateFilterMode;
  dateModeOptions?: DateFilterMode[];
  /** Kalau diisi, kontrol tanggal HALAMAN yang jadi acuan: rentang yang dipilih operator
   *  benar-benar dikirim ke PACS (QIDO StudyDate) dan RIS, bukan sekadar menyaring baris
   *  yang sudah termuat. Kontrol tanggal di header kolom StudyDate dimatikan supaya tidak
   *  ada dua sumber yang saling bertentangan. */
  dateMode?: DateFilterMode;
  onDateModeChange?: (mode: DateFilterMode) => void;
  rangeFrom?: string;
  rangeTo?: string;
  onRangeFromChange?: (value: string) => void;
  onRangeToChange?: (value: string) => void;
  /** Di mana kontrol tanggal berada:
   *  - 'column' (default): di header kolom StudyDate — dipakai halaman WORKLIST yang
   *    mengambil datanya sendiri.
   *  - 'page': halaman yang mengatur tanggal lewat filter di kanan atas (luar header tabel);
   *    sel header StudyDate tidak lagi menyediakan kontrol tandingan. Kalau halaman juga
   *    mengirim state tanggal (onDateModeChange), sel itu hanya menampilkan rentang aktif. */
  dateFilterPlacement?: "column" | "page";
  strictDefaultColumnOrder?: boolean;
  disableRowSelection?: boolean;
  lockedColumns?: string[];
  enableMwlReconcile?: boolean;
  enableInlinePreview?: boolean;
  headerContent?: ReactNode;
  surfaceClassName?: string;
  tableCardClassName?: string;
  toolbarClassName?: string;
  tableHeaderClassName?: string;
  tableFilterHeaderClassName?: string;
  tableFilterInputClassName?: string;
  rowClassName?: (row: WorklistItem) => string;
  disablePagination?: boolean;
  hideEmptyState?: boolean;
  scheduledOrderStatuses?: Array<"SENT_TO_MWL" | "COMPLETED" | "PENDING">;
};

const toDicomDateLocal = (value?: string | null): string => {
  if (!value) return "";
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return text;
  const ymd = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
  if (ymd) return `${ymd[1]}${ymd[2]}${ymd[3]}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

const nonDiagnosticStudyModalities = new Set(["SC", "SEG"]);

const formatWorklistModality = (value?: string | null): string => {
  const modalities = String(value || "")
    .split("\\")
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)
    .filter(modality => !nonDiagnosticStudyModalities.has(modality));

  return Array.from(new Set(modalities)).join("\\");
};

const mapMwlOrderToScheduledRow = (order: MwlOrder): WorklistItem => ({
  id: `mwl-order-${order.id}`,
  patientId: order.no_rm || "",
  patientName: order.nama_pasien || "",
  accessionNumber: order.accession_number || "",
  modalityCode: formatWorklistModality(order.modality),
  studyDescription: order.procedure_desc || "",
  imageCount: 0,
  seriesCount: 0,
  referringPhysician: order.referring_doctor_name || order.referring_physician || "",
  studyDate: toDicomDateLocal(order.study_date || order.tanggal_aktivasi || order.tanggal_order || order.created_at),
  studyId: order.no_rontgen || "",
  birthDate: toDicomDateLocal(order.tanggal_lahir),
  studyTime: String(order.study_time || ""),
  age: calculateAge(toDicomDateLocal(order.tanggal_lahir), toDicomDateLocal(order.study_date || order.tanggal_aktivasi || order.tanggal_order || order.created_at)),
  sex: (order.kelamin || "O") as "M" | "F" | "O",
  studyInstanceUid: order.actual_study_instance_uid || order.study_instance_uid || "",
  status: order.status === "COMPLETED" ? "completed" : "scheduled",
  cito: order.cito || "",
});

// "All dates" removed on purpose: it made the worklist scan the whole mwl_orders
// table through a 300-row page and then filter client-side, which is the slowest
// path in the app. Every remaining mode maps to a bounded server-side window, so
// the database can use idx_mwl_orders_deleted_created and honour LIMIT properly.
const DEFAULT_DATE_MODE_OPTIONS: DateFilterMode[] = [
  "today",
  "yesterday",
  "7days",
  "30days",
  "1month",
  "2months",
  "range",
];

// "PENDING" ikut disertakan: order yang sudah registrasi tapi belum dikirim ke modality
// ikut tampil di worklist. Sebelumnya order ini tidak pernah muncul sama sekali, sehingga
// terlihat seperti "data hilang" walaupun di database ada dan assignment-nya benar.
const DEFAULT_SCHEDULED_ORDER_STATUSES: Array<"SENT_TO_MWL" | "COMPLETED" | "PENDING"> = ["SENT_TO_MWL", "PENDING"];

// The worklist table is fed by PACS QIDO (/rs/studies), NOT by the RIS orders
// endpoint, so the date filter has to be sent to PACS as well. PACS accepts the
// DICOM StudyDate form: "20260918" for a single day, or "20260911-20260918" for
// a range (see sqlForFilter in PACS/src/dimse/metadataDb.ts).
const toStudyDateRange = (mode: DateFilterMode, from: string, to: string): string | undefined => {
  const iso = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");
  const daysAgo = (days: number) => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - days);
    return iso(start);
  };
  const today = iso(new Date());
  const asDicom = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replace(/-/g, "") : "");
  switch (mode) {
    case "today":
      return today;
    case "yesterday":
      return daysAgo(1);
    case "7days":
      return `${daysAgo(7)}-${today}`;
    case "30days":
      return `${daysAgo(30)}-${today}`;
    case "1month": {
      const start = new Date();
      start.setUTCMonth(start.getUTCMonth() - 1);
      return `${iso(start)}-${today}`;
    }
    case "2months": {
      const start = new Date();
      start.setUTCMonth(start.getUTCMonth() - 2);
      return `${iso(start)}-${today}`;
    }
    case "range": {
      const start = asDicom(from);
      const end = asDicom(to);
      if (start && end) return `${start}-${end}`;
      return start || end || undefined;
    }
    default:
      return undefined;
  }
};

// A custom range only means something once BOTH ends are set. While the user is
// still picking (or picked an inverted range) there is no window to ask for, and
// `toStudyDateRange` returning undefined made PACS answer with the whole archive
// the moment "Custom range" was selected. Callers must treat an incomplete range
// as "nothing to show yet", never as "no filter".
const isRangeComplete = (from: string, to: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

const DATE_MODE_LABELS: Record<DateFilterMode, string> = {
  all: "All dates (legacy)",
  today: "Today",
  yesterday: "Yesterday",
  "7days": "Last 7 days",
  "30days": "Last 30 days",
  "1month": "1 Month",
  "2months": "2 Month",
  range: "Custom range",
};

const SortIndicator = ({
  active,
  direction,
}: {
  active: boolean;
  direction: "asc" | "desc";
}) => {
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <Icon
      className={`h-3.5 w-3.5 stroke-[1.7] transition-colors ${
        active ? "text-foreground" : "text-muted-foreground/45"
      }`}
      aria-hidden="true"
    />
  );
};


const hasActiveTextSelection = () => {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
};

const Worklist = ({
  onOpenStudy,
  enableDetailDialog = true,
  extraColumns = EMPTY_EXTRA_COLUMNS,
  onDataLoaded,
  onProcessSelected,
  processLabel = "Process",
  title = "Worklist",
  storageKey,
  defaultColumnOrder,
  defaultVisibleColumns,
  headerActions,
  rowFilter,
  prioritySort,
  filterActions,
  enableRadiologistAssignment = false,
  showRadiologistAction = true,
  externalRows,
  externalLoading = false,
  externalError = null,
  initialDateFilterMode = "today",
  dateModeOptions = DEFAULT_DATE_MODE_OPTIONS,
  dateMode,
  onDateModeChange,
  rangeFrom,
  rangeTo,
  onRangeFromChange,
  onRangeToChange,
  dateFilterPlacement = "column",
  strictDefaultColumnOrder = false,
  disableRowSelection = false,
  lockedColumns = [],
  enableMwlReconcile = false,
  enableInlinePreview = false,
  headerContent,
  surfaceClassName = "",
  tableCardClassName = "",
  toolbarClassName = "",
  tableHeaderClassName = "",
  tableFilterHeaderClassName = "",
  tableFilterInputClassName = "",
  rowClassName,
  disablePagination = false,
  hideEmptyState = false,
  scheduledOrderStatuses = DEFAULT_SCHEDULED_ORDER_STATUSES,
}: WorklistProps) => {
  const { hasPermission, user } = useAuth();
  const isMobile = useIsMobile();
  const canAssignRadiologist = hasPermission("view_users");
  const [assignmentMap, setAssignmentMap] = useState<Record<string, RadiologistAssignment>>({});
  const [radiologistUsers, setRadiologistUsers] = useState<User[]>([]);
  const [radiologistLoading, setRadiologistLoading] = useState(false);
  const [assignmentDialogOpen, setAssignmentDialogOpen] = useState(false);
  const [assignmentStudy, setAssignmentStudy] = useState<WorklistItem | null>(null);
  const [selectedRadiologistId, setSelectedRadiologistId] = useState<string>("");
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const studiesRequestInFlightRef = useRef(false);
  const scheduledOrderStatusesKey = scheduledOrderStatuses.join("|");
  const lockedColumnSet = useMemo(() => new Set(lockedColumns), [lockedColumns]);
  const radiologistColumn = useMemo<ExtraColumn | null>(() => {
    if (!enableRadiologistAssignment) return null;
    return {
      key: "radiologistName",
      label: "Reporting",
      width: 200,
      getValue: row => {
        const assignment = assignmentMap[row.studyInstanceUid || row.id];
        return assignment?.radiologist_name || "";
      },
      renderCell: row => {
        const assignment = assignmentMap[row.studyInstanceUid || row.id];
        return (
          <span className="text-sm text-foreground">
            {assignment?.radiologist_name || "-"}
          </span>
        );
      },
    };
  }, [assignmentMap, enableRadiologistAssignment]);
  const assignmentColumn = useMemo<ExtraColumn | null>(() => {
    if (!enableRadiologistAssignment || !showRadiologistAction) return null;
    return {
      key: "radiologistAction",
      label: "Action",
      width: 80,
      getValue: () => "",
      renderCell: row => {
        const assignment = assignmentMap[row.studyInstanceUid || row.id];
        const isAssigned = Boolean(assignment?.radiologist_id);
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className={`h-8 w-8 p-0 rounded-lg ${
                  isAssigned
                    ? "bg-emerald-500 text-white border-white hover:bg-emerald-600 hover:text-white"
                    : "text-muted-foreground"
                }`}
                disabled={!canAssignRadiologist}
                aria-label="Set reporting"
                onClick={event => {
                  event.stopPropagation();
                  setAssignmentStudy(row);
                  const assignedId = assignment?.radiologist_id;
                  setSelectedRadiologistId(assignedId ? String(assignedId) : "");
                  setAssignmentDialogOpen(true);
                }}
              >
                <UserPlus className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Set Reporting</TooltipContent>
          </Tooltip>
        );
      },
    };
  }, [assignmentMap, canAssignRadiologist, enableRadiologistAssignment, showRadiologistAction]);
  const resolvedExtraColumns = useMemo(() => {
    const columns = [...extraColumns];
    if (radiologistColumn) columns.push(radiologistColumn);
    if (assignmentColumn) columns.push(assignmentColumn);
    return columns;
  }, [assignmentColumn, extraColumns, radiologistColumn]);
  const allColumns = useMemo<ColumnDefinition[]>(
    () => [
      ...ALL_COLUMNS,
      ...resolvedExtraColumns.map(col => ({
        key: col.key,
        label: col.label,
        width: col.width,
      })),
    ],
    [resolvedExtraColumns]
  );
  const allColumnKeys = useMemo(() => allColumns.map(col => col.key), [allColumns]);
  const extraColumnKeys = useMemo(() => resolvedExtraColumns.map(col => col.key), [resolvedExtraColumns]);
  const resolvedDefaultOrder = useMemo(() => {
    const desired = defaultColumnOrder?.length ? defaultColumnOrder : DEFAULT_COLUMN_ORDER;
    const filtered = desired.filter(key => allColumnKeys.includes(key));
    if (strictDefaultColumnOrder) return filtered;
    const missing = allColumnKeys.filter(key => !filtered.includes(key));
    return [...filtered, ...missing];
  }, [defaultColumnOrder, allColumnKeys, strictDefaultColumnOrder]);
  const resolvedDefaultVisibleColumns = useMemo(() => {
    const desired = defaultVisibleColumns?.length
      ? defaultVisibleColumns
      : isMobile
        ? DEFAULT_MOBILE_COLUMNS
        : DEFAULT_VISIBLE_COLUMNS;
    const filtered = desired.filter(key => allColumnKeys.includes(key));
    const missingExtras = extraColumnKeys.filter(key => !filtered.includes(key));
    return [...filtered, ...missingExtras];
  }, [allColumnKeys, defaultVisibleColumns, extraColumnKeys, isMobile]);
  const [search, setSearch] = useState("");
  const [searchParams] = useSearchParams();
  // Read "accession" from URL search params (e.g. when coming from a notification click)
  useEffect(() => {
    const accessionParam = searchParams.get('accession');
    if (accessionParam) {
      setSearch(accessionParam);
    }
  }, []); // only on mount
  const [dateFilterMode, setDateFilterMode] = useState<DateFilterMode>(initialDateFilterMode);
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() => new Set(resolvedDefaultOrder));
  const [hasCustomizedColumns, setHasCustomizedColumns] = useState(false);
  const [hasCustomizedOrder, setHasCustomizedOrder] = useState(false);
  const [storageReadyKey, setStorageReadyKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<ColumnKey>("studyDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [detailItem, setDetailItem] = useState<WorklistItem | null>(null);
  const [previewItem, setPreviewItem] = useState<WorklistItem | null>(null);
  const [data, setData] = useState<WorklistItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [columnOrder, setColumnOrder] = useState<ColumnKey[]>(() => resolvedDefaultOrder);
  const [draggingColumn, setDraggingColumn] = useState<ColumnKey | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [columnFilters, setColumnFilters] = useState<Record<ColumnKey, string>>(() =>
    Object.fromEntries(allColumnKeys.map(key => [key, ""])) as Record<ColumnKey, string>
  );
  const [columnWidths, setColumnWidths] = useState<Partial<Record<ColumnKey, number>>>({});
  const [showSeriesInformation, setShowSeriesInformation] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [resizingKey, setResizingKey] = useState<ColumnKey | null>(null);
  const resizingRef = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null);
  const selectionContainerRef = useRef<HTMLDivElement | null>(null);
  const canDelete = hasPermission("delete_study");
  const canForward = hasPermission("download_study");
  const [forwardDialogOpen, setForwardDialogOpen] = useState(false);
  const [forwardItems, setForwardItems] = useState<WorklistItem[]>([]);
  const [forwardResults, setForwardResults] = useState<
    Record<string, { status: "pending" | "ok" | "error"; message?: string }>
  >({});
  const [reconcileDialogOpen, setReconcileDialogOpen] = useState(false);
  const [reconcileStudy, setReconcileStudy] = useState<WorklistItem | null>(null);
  const [reconcileCandidates, setReconcileCandidates] = useState<MwlReconcileCandidate[]>([]);
  const [reconcileChecking, setReconcileChecking] = useState(false);
  const [reconcileSavingId, setReconcileSavingId] = useState<number | null>(null);
  const [nodes, setNodes] = useState<DicomNode[]>([]);
  const [viewerConfigs, setViewerConfigs] = useState<ViewerConfig[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [forwarding, setForwarding] = useState(false);
  const extraColumnMap = useMemo(
    () => new Map(resolvedExtraColumns.map(col => [col.key, col])),
    [resolvedExtraColumns]
  );
  const isDateControlled = Boolean(onDateModeChange);
  const effectiveDateMode = isDateControlled
    ? (dateMode && dateModeOptions.includes(dateMode) ? dateMode : dateModeOptions[0] || "today")
    : (dateModeOptions.includes(dateFilterMode) ? dateFilterMode : dateModeOptions[0] || "today");
  // Saat dikendalikan halaman, rentang diambil dari state halaman supaya label, query PACS,
  // dan query RIS memakai angka yang sama.
  const effectiveFromDate = isDateControlled ? rangeFrom ?? "" : fromDate;
  const effectiveToDate = isDateControlled ? rangeTo ?? "" : toDate;
  // True while "Custom range" is selected but From/To are not both filled (or From
  // is after To). In that state the table must stay empty and no request may be
  // sent: an unfiltered query is what made every study appear instantly.
  const customRangePending =
    effectiveDateMode === "range" && !isRangeComplete(effectiveFromDate, effectiveToDate);

  useEffect(() => {
    if (isDateControlled) return;
    if (dateFilterMode !== effectiveDateMode) {
      setDateFilterMode(effectiveDateMode);
    }
  }, [dateFilterMode, effectiveDateMode, isDateControlled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    setIsTouchDevice(coarsePointer || navigator.maxTouchPoints > 0);
  }, []);

  const loadAssignments = useCallback(
    async (rows: WorklistItem[]) => {
      if (!enableRadiologistAssignment) return;
      const studyUids = Array.from(
        new Set(rows.map(row => row.studyInstanceUid).filter(Boolean))
      );
      if (studyUids.length === 0) {
        setAssignmentMap({});
        return;
      }
      try {
        const assignments = await radiologistAssignmentService.fetchAssignments(studyUids);
        const nextMap: Record<string, RadiologistAssignment> = {};
        assignments.forEach(item => {
          if (item.study_instance_uid) {
            nextMap[item.study_instance_uid] = item;
          }
        });
        setAssignmentMap(nextMap);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load assignments";
        toast({
          title: "Failed to load assignments",
          description: message,
          variant: "destructive",
        });
      }
    },
    [enableRadiologistAssignment, toast]
  );

  const loadStudies = useCallback(async (options?: { silent?: boolean; fresh?: boolean }) => {
    if (externalRows) return;
    if (customRangePending) {
      // Placeholder state: ask neither PACS nor the RIS for anything until the user
      // has picked both ends of the range. Without this the request went out with no
      // date filter at all and the whole archive came back. Clearing the rows also
      // stops the previous window's studies from looking like the new filter's result.
      setData([]);
      setLoadError(null);
      setIsLoading(false);
      setIsInitialLoad(false);
      setSelectedRows(new Set());
      setSelectionAnchorId(null);
      return;
    }
    if (studiesRequestInFlightRef.current) return;
    studiesRequestInFlightRef.current = true;
    const silent = Boolean(options?.silent);
    if (!silent) setIsLoading(true);
    setLoadError(null);
    try {
      const normalizedScheduledStatuses = scheduledOrderStatusesKey
        .split("|")
        .filter((status): status is "SENT_TO_MWL" | "COMPLETED" | "PENDING" =>
          status === "SENT_TO_MWL" || status === "COMPLETED" || status === "PENDING");
      const orderStatusRequests = normalizedScheduledStatuses.length
        ? normalizedScheduledStatuses
        : (["SENT_TO_MWL", "PENDING"] as Array<"SENT_TO_MWL" | "COMPLETED" | "PENDING">);
      const [studies, scheduledOrderGroups] = await Promise.all([
        dicomWebService.fetchStudies({
          PatientName: search || undefined,
          // The date filter must reach PACS: the table is sourced from QIDO, so a
          // RIS-only filter left every PACS row visible regardless of the mode.
          StudyDate: search ? undefined : toStudyDateRange(effectiveDateMode, effectiveFromDate, effectiveToDate),
          ...(options?.fresh ? { nocache: "1" } : {}),
        }),
        Promise.all(
          orderStatusRequests.map(status =>
            mwlService.fetchOrders({
              q: search || undefined,
              status,
              limit: 1000,
              // Filtering happens in the database. Passing the window here is
              // what makes LIMIT meaningful: previously the server always sent
              // the newest rows regardless of the selected date range.
              dateMode: effectiveDateMode,
              dateFrom: effectiveDateMode === "range" ? effectiveFromDate : undefined,
              dateTo: effectiveDateMode === "range" ? effectiveToDate : undefined,
            }).catch(() => [] as MwlOrder[])
          )
        ),
      ]);

      const mapped: WorklistItem[] = studies.map((item: DicomWorklistItem, index: number) => {
        const studyDateRaw = item.StudyDate || "";
        const birthDateRaw = item.PatientBirthDate || "";
        const imageCount = item.NumberOfStudyRelatedInstances || 0;
        const seriesCount = item.NumberOfStudyRelatedSeries || 0;
        return {
          id: item.StudyInstanceUID || `study-${index}`,
          patientId: item.PatientID || "",
          patientName: item.PatientName || "",
          otherPatientIds: item.OtherPatientIDs || "",
          accessionNumber: item.AccessionNumber || "",
          institutionName: item.InstitutionName || "",
          modalityCode: formatWorklistModality(item.ModalityCode),
          studyDescription: item.StudyDescription || "",
          imageCount,
          seriesCount,
          referringPhysician: item.ReferringPhysicianName || "",
          studyDate: studyDateRaw,
          studyId: item.StudyID || "",
          birthDate: birthDateRaw,
          studyTime: item.StudyTime || "",
          age: calculateAge(birthDateRaw, studyDateRaw),
          sex: (item.PatientSex || "O") as "M" | "F" | "O",
          studyInstanceUid: item.StudyInstanceUID || "",
          status: imageCount > 0 ? "completed" : seriesCount > 0 ? "in-progress" : "scheduled",
        };
      });

      const pacsStudyUids = new Set(mapped.map(item => item.studyInstanceUid).filter(Boolean));
      const pacsAccessions = new Set(mapped.map(item => item.accessionNumber).filter(Boolean));
      const scheduledOrders = scheduledOrderGroups.flat();
      const mwlScheduledRows = scheduledOrders
        .filter(order => {
          const orderStudyUid = order.actual_study_instance_uid || order.study_instance_uid || "";
          const accession = order.accession_number || "";
          return (!orderStudyUid || !pacsStudyUids.has(orderStudyUid)) && (!accession || !pacsAccessions.has(accession));
        })
        .map(mapMwlOrderToScheduledRow);
      const merged = [...mapped, ...mwlScheduledRows];

      setData(merged);
      if (onDataLoaded) {
        await onDataLoaded(merged);
      }
      if (enableRadiologistAssignment) {
        await loadAssignments(merged);
      }
      setSelectedRows(prev => {
        if (prev.size === 0) return prev;
        const availableIds = new Set(merged.map(item => item.id));
        const next = new Set(Array.from(prev).filter(id => availableIds.has(id)));
        return next;
      });
      setSelectionAnchorId(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load studies from DICOMweb";
      setLoadError(message);
      toast({
        title: "Failed to load worklist",
        description: message,
        variant: "destructive",
      });
    } finally {
      studiesRequestInFlightRef.current = false;
      if (!silent) setIsLoading(false);
      setIsInitialLoad(false);
    }
  // effectiveDateMode / fromDate / toDate are read inside, so they belong in the
  // dependency list: without them, switching the date filter only re-filtered the
  // rows already in memory and never asked the server for the new window.
  }, [search, toast, onDataLoaded, enableRadiologistAssignment, loadAssignments, externalRows, scheduledOrderStatusesKey, effectiveDateMode, effectiveFromDate, effectiveToDate, customRangePending]);

  const handleMetadataUpdated = useCallback(
    (updatedItem: WorklistItem) => {
      const key = updatedItem.studyInstanceUid || updatedItem.id;
      setDetailItem(updatedItem);
      setPreviewItem(current => {
        if (!current) return current;
        const currentKey = current.studyInstanceUid || current.id;
        return currentKey === key ? updatedItem : current;
      });
      setData(prev => {
        const next = prev.map(row =>
          (row.studyInstanceUid || row.id) === key ? { ...row, ...updatedItem } : row
        );
        onDataLoaded?.(next);
        return next;
      });
    },
    [onDataLoaded]
  );

  useEffect(() => {
    if (!enableInlinePreview || !showSeriesInformation || !previewItem) return;
    const previewKey = previewItem.studyInstanceUid || previewItem.id;
    const nextPreview = data.find(row => (row.studyInstanceUid || row.id) === previewKey) ?? null;
    if (!nextPreview) {
      setPreviewItem(null);
      return;
    }
    if (nextPreview !== previewItem) {
      setPreviewItem(nextPreview);
    }
  }, [data, enableInlinePreview, previewItem, showSeriesInformation]);

  useEffect(() => {
    if (!externalRows) return;
    setData(externalRows);
    setLoadError(externalError);
    setIsLoading(current => (externalLoading && data.length === 0 ? true : externalLoading ? current : false));
    setIsInitialLoad(false);
    if (onDataLoaded) {
      onDataLoaded(externalRows);
    }
    if (enableRadiologistAssignment) {
      loadAssignments(externalRows);
    }
  }, [externalRows, externalError, externalLoading, onDataLoaded, enableRadiologistAssignment, loadAssignments, data.length]);

  useEffect(() => {
    if (!enableRadiologistAssignment || !assignmentDialogOpen || !canAssignRadiologist) return;
    let active = true;
    const loadRadiologists = async () => {
      setRadiologistLoading(true);
      try {
        const users = await usersService.fetchUsers();
        if (!active) return;
        const radiologists = users.filter(user => user.role === "radiologist");
        setRadiologistUsers(radiologists);
        if (!selectedRadiologistId && radiologists.length > 0) {
          setSelectedRadiologistId(String(radiologists[0].id));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load reporting users";
        toast({
          title: "Failed to load reporting users",
          description: message,
          variant: "destructive",
        });
      } finally {
        if (active) {
          setRadiologistLoading(false);
        }
      }
    };
    loadRadiologists();
    return () => {
      active = false;
    };
  }, [assignmentDialogOpen, canAssignRadiologist, enableRadiologistAssignment, selectedRadiologistId, toast]);

  const handleAssignRadiologist = async () => {
    if (!assignmentStudy?.studyInstanceUid) return;
    const radiologistId = Number(selectedRadiologistId);
    if (!Number.isFinite(radiologistId) || radiologistId <= 0) {
      toast({
        title: "Reporting user not selected",
        description: "Please select the target reporting user.",
        variant: "destructive",
      });
      return;
    }
    setAssignmentSaving(true);
    try {
      const assignment = await radiologistAssignmentService.assignRadiologist({
        studyInstanceUid: assignmentStudy.studyInstanceUid,
        radiologistId,
        assignedBy: user?.username,
      });
      setAssignmentMap(prev => ({
        ...prev,
        [assignment.study_instance_uid]: assignment,
      }));
      toast({
        title: "Reporting user assigned",
        description: `${assignmentStudy.patientName || assignmentStudy.patientId} has been routed to reporting.`,
      });
      setAssignmentDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to set reporting user";
      toast({
        title: "Failed to set reporting user",
        description: message,
        variant: "destructive",
      });
    } finally {
      setAssignmentSaving(false);
    }
  };

  useEffect(() => {
    if (externalRows) return;
    loadStudies();
  }, [loadStudies, externalRows]);

  useEffect(() => {
    let active = true;
    const loadUiSettings = async () => {
      try {
        const settings = await dicomWebService.fetchUiSettings();
        if (!active) return;
        if (typeof settings.autoRefresh === "boolean") {
          setAutoRefreshEnabled(settings.autoRefresh);
        } else {
          setAutoRefreshEnabled(true);
        }
        if (enableInlinePreview) {
          setShowSeriesInformation(settings.worklistSeriesPreviewEnabled !== false);
        }
      } catch {
        if (active) {
          setAutoRefreshEnabled(true);
          setShowSeriesInformation(false);
        }
      }
    };
    loadUiSettings();
    return () => {
      active = false;
    };
  }, [enableInlinePreview]);

  useEffect(() => {
    if (enableInlinePreview) return;
    setShowSeriesInformation(false);
    setPreviewItem(null);
  }, [enableInlinePreview]);

  useEffect(() => {
    if (externalRows) return;
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(() => {
      loadStudies({ silent: true });
    }, 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, loadStudies, externalRows]);

  useEffect(() => {
    setPage(prev => (prev > 0 ? 0 : prev));
  }, [pageSize]);

  useEffect(() => {
    setSelectedRows(new Set());
    setSelectionAnchorId(null);
  }, [page]);

  const baseKey = user?.username ? `worklist:${user.username}` : "worklist:guest";
  const storageKeyBase = storageKey ? `${baseKey}:${storageKey}` : baseKey;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const isLegacyDefaultOrder = (keys: ColumnKey[]) =>
      keys.length === allColumnKeys.length && keys.every((key, index) => key === allColumnKeys[index]);
    const isLegacyDefaultVisible = (keys: ColumnKey[]) =>
      keys.length === allColumnKeys.length && allColumnKeys.every(key => keys.includes(key));
    const storedOrder = window.localStorage.getItem(`${storageKeyBase}:columnOrder`);
    if (storedOrder) {
      const parsed = JSON.parse(storedOrder) as ColumnKey[];
      const allKeys = allColumnKeys;
      const filtered = parsed.filter(key => allKeys.includes(key));
      const missing = allKeys.filter(key => !filtered.includes(key));
      if (filtered.length > 0 && !isLegacyDefaultOrder(filtered)) {
        setColumnOrder([...filtered, ...missing]);
        setHasCustomizedOrder(true);
      } else {
        setColumnOrder(resolvedDefaultOrder);
        setHasCustomizedOrder(false);
      }
    } else {
      setColumnOrder(resolvedDefaultOrder);
      setHasCustomizedOrder(false);
    }

    const storedVisible = window.localStorage.getItem(`${storageKeyBase}:visibleColumns`);
    if (storedVisible) {
      const parsed = JSON.parse(storedVisible) as ColumnKey[];
      const allKeys = allColumnKeys;
      const filtered = parsed.filter(key => allKeys.includes(key));
      const merged = filtered.length && !isLegacyDefaultVisible(filtered)
        ? [...filtered, ...extraColumnKeys.filter(key => !filtered.includes(key))]
        : resolvedDefaultVisibleColumns;
      setVisibleColumns(new Set(merged));
      setHasCustomizedColumns(filtered.length > 0 && !isLegacyDefaultVisible(filtered));
    } else {
      setVisibleColumns(new Set(resolvedDefaultVisibleColumns));
      setHasCustomizedColumns(false);
    }

    const storedWidths = window.localStorage.getItem(`${storageKeyBase}:columnWidths`);
    if (storedWidths) {
      const parsed = JSON.parse(storedWidths) as Partial<Record<ColumnKey, number>>;
      setColumnWidths(parsed);
    } else {
      setColumnWidths({});
    }
    setStorageReadyKey(storageKeyBase);
  }, [storageKeyBase, allColumnKeys, extraColumnKeys, resolvedDefaultOrder, resolvedDefaultVisibleColumns]);

  useEffect(() => {
    setColumnFilters(prev => {
      const next: Record<ColumnKey, string> = { ...prev };
      allColumnKeys.forEach(key => {
        if (!(key in next)) {
          next[key] = "";
        }
      });
      Object.keys(next).forEach(key => {
        if (!allColumnKeys.includes(key)) {
          delete next[key];
        }
      });
      return next;
    });
  }, [allColumnKeys]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (storageReadyKey !== storageKeyBase) return;
    if (!hasCustomizedOrder) {
      window.localStorage.removeItem(`${storageKeyBase}:columnOrder`);
      return;
    }
    window.localStorage.setItem(`${storageKeyBase}:columnOrder`, JSON.stringify(columnOrder));
  }, [columnOrder, storageKeyBase, storageReadyKey, hasCustomizedOrder]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (storageReadyKey !== storageKeyBase) return;
    if (!hasCustomizedColumns) {
      window.localStorage.removeItem(`${storageKeyBase}:visibleColumns`);
      return;
    }
    window.localStorage.setItem(`${storageKeyBase}:visibleColumns`, JSON.stringify(Array.from(visibleColumns)));
  }, [visibleColumns, storageKeyBase, hasCustomizedColumns, storageReadyKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (storageReadyKey !== storageKeyBase) return;
    window.localStorage.setItem(`${storageKeyBase}:columnWidths`, JSON.stringify(columnWidths));
  }, [columnWidths, storageKeyBase, storageReadyKey]);

  useEffect(() => {
    if (!resizingKey) return;
    const handleMove = (event: MouseEvent) => {
      const current = resizingRef.current;
      if (!current) return;
      const delta = event.clientX - current.startX;
      const nextWidth = Math.max(80, current.startWidth + delta);
      setColumnWidths(prev => ({ ...prev, [current.key]: nextWidth }));
    };
    const handleUp = () => {
      setResizingKey(null);
      resizingRef.current = null;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [resizingKey]);

  useEffect(() => {
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const container = selectionContainerRef.current;
      if (!container) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (!container.contains(target)) {
        setSelectedRows(prev => {
          if (prev.size === 0) return prev;
          return new Set();
        });
        setSelectionAnchorId(null);
      }
    };
    document.addEventListener("mousedown", handleDocumentMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
    };
  }, []);

  useEffect(() => {
    if (!canForward) return;
    let active = true;
    const loadNodes = async () => {
      setNodesLoading(true);
      try {
        const fetched = await dicomForwardService.fetchDestinations();
        if (!active) return;
        setNodes(fetched);
        if (fetched.length && !selectedNodeId) {
          setSelectedNodeId(String(fetched[0].id));
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load DICOM nodes";
        toast({
          title: "Failed to load DICOM nodes",
          description: message,
          variant: "destructive",
        });
      } finally {
        if (active) {
          setNodesLoading(false);
        }
      }
    };
    loadNodes();
    return () => {
      active = false;
    };
  }, [canForward, selectedNodeId, toast]);

  const handleResizeStart = (key: ColumnKey, event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const width = getColumnWidth(key);
    resizingRef.current = { key, startX: event.clientX, startWidth: width };
    setResizingKey(key);
  };

  const openForwardDialog = () => {
    if (!canForward) return;
    const ids = Array.from(selectedRows);
    if (!ids.length) {
      toast({
        title: "No studies selected",
        description: "Select one or more studies to forward.",
        variant: "destructive",
      });
      return;
    }
    const selectedItems = data.filter(item => ids.includes(item.id));
    if (!selectedItems.length) {
      toast({
        title: "Selection not available",
        description: "Could not resolve selected studies from current list.",
        variant: "destructive",
      });
      return;
    }
    setForwardItems(selectedItems);
    setForwardResults({});
    setForwardDialogOpen(true);
  };

  const handleForwardConfirm = async () => {
    if (!canForward || forwarding) return;
    const nodeIdNumber = Number(selectedNodeId);
    if (!Number.isFinite(nodeIdNumber) || nodeIdNumber <= 0) {
      toast({
        title: "Destination not selected",
        description: "Please choose a DICOM node destination first.",
        variant: "destructive",
      });
      return;
    }
    const uniqueStudyUids = Array.from(
      new Set(
        forwardItems
          .map(item => item.studyInstanceUid)
          .filter(Boolean),
      ),
    );
    if (!uniqueStudyUids.length) {
      toast({
        title: "Missing identifiers",
        description: "Could not resolve StudyInstanceUIDs for selected rows.",
        variant: "destructive",
      });
      return;
    }

    const pendingResults: typeof forwardResults = { ...forwardResults };
    for (const uid of uniqueStudyUids) {
      pendingResults[uid] = { status: "pending" };
    }
    setForwardResults(pendingResults);

    setForwarding(true);
    let successCount = 0;
    let failCount = 0;
    let firstErrorMessage: string | undefined;
    let nodeName = "";

    try {
      for (const uid of uniqueStudyUids) {
        try {
          const result = await dicomForwardService.forwardStudies({
            studyInstanceUids: [uid],
            nodeId: nodeIdNumber,
          });
          if (!nodeName && result.node?.name) {
            nodeName = result.node.name;
          }
          const responseResult = result.results[0];
          if (responseResult && responseResult.studyInstanceUid) {
            const studyUid = responseResult.studyInstanceUid;
            const status = responseResult.status;
            const message = responseResult.message;
            setForwardResults(prev => ({
              ...prev,
              [studyUid]: {
                status,
                message,
              },
            }));
            if (status === "ok") {
              successCount += 1;
            } else {
              failCount += 1;
              if (!firstErrorMessage && message) {
                firstErrorMessage = message;
              }
            }
          } else {
            failCount += 1;
            if (!firstErrorMessage) {
              firstErrorMessage = "No result returned from server";
            }
            setForwardResults(prev => ({
              ...prev,
              [uid]: {
                status: "error",
                message: "No result returned from server",
              },
            }));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to forward study";
          failCount += 1;
          if (!firstErrorMessage) {
            firstErrorMessage = message;
          }
          setForwardResults(prev => ({
            ...prev,
            [uid]: {
              status: "error",
              message,
            },
          }));
        }
      }

      const total = uniqueStudyUids.length;
      if (total > 0) {
        const targetLabel = nodeName || "destination";
        const baseDescription = `Sent ${successCount} of ${total} study(ies) to ${targetLabel}${
          failCount ? `, ${failCount} failed` : ""
        }.`;
        const description =
          failCount && firstErrorMessage
            ? `${baseDescription} (${firstErrorMessage})`
            : baseDescription;

        toast({
          title: failCount ? `Send to ${targetLabel} failed` : `Send to ${targetLabel} success`,
          description,
          variant: failCount ? "destructive" : "default",
        });
      }
    } finally {
      setForwarding(false);
    }
  };

  const getColumnValue = useCallback((key: ColumnKey, row: WorklistItem) => {
    if (key === "patientId") return row.patientId || "";
    if (key === "patientName") return row.patientName || "";
    if (key === "accessionNumber") return row.accessionNumber || "";
    if (key === "modalityCode") return row.modalityCode || "";
    if (key === "studyDescription") return row.studyDescription || "";
    if (key === "birthDate") return formatDicomDate(row.birthDate);
    if (key === "age") return calculateAge(row.birthDate, row.studyDate);
    if (key === "imageCount") return String(row.imageCount ?? "");
    if (key === "seriesCount") return String(row.seriesCount ?? "");
    if (key === "referringPhysician") return row.referringPhysician || "";
    if (key === "studyDate") return formatDicomDateTime(row.studyDate, row.studyTime);
    if (key === "status") return row.status || "";
    const extra = extraColumnMap.get(key);
    if (extra?.getValue) return extra.getValue(row) || "";
    return "";
  }, [extraColumnMap]);

  const getColumnSortValue = useCallback(
    (key: ColumnKey, row: WorklistItem) => {
      if (key === "imageCount") return row.imageCount ?? 0;
      if (key === "seriesCount") return row.seriesCount ?? 0;
      if (key === "age") return Number(calculateAge(row.birthDate, row.studyDate) || 0);
      if (key === "studyDate") return formatDicomDateTime(row.studyDate, row.studyTime);
      const extra = extraColumnMap.get(key);
      if (extra?.getValue) return extra.getValue(row) || "";
      return getColumnValue(key, row);
    },
    [extraColumnMap, getColumnValue]
  );

  const filtered = useMemo(() => {
    // Custom range still being picked: show nothing (the load path sent no request
    // at all), so the table reads as a placeholder rather than as "all studies".
    if (customRangePending) return [];
    let result = data;
    if (rowFilter) {
      result = result.filter(row => rowFilter(row, { search }));
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r =>
        r.patientName.toLowerCase().includes(q) ||
        r.patientId.toLowerCase().includes(q) ||
        r.accessionNumber.toLowerCase().includes(q) ||
        r.studyDescription.toLowerCase().includes(q)
      );
    }
    // Safety net: the date range is applied by PACS (QIDO StudyDate) and by RIS
    // (created_at). If the PACS metadata index is unavailable the query falls back
    // to C-FIND, which may not honour the range, so drop the rows that carry no
    // usable date at all rather than showing them under a bounded filter.
    if (!search.trim() && effectiveDateMode !== "all") {
      result = result.filter(r => {
        const digits = String(r.studyDate || "").replace(/[^0-9]/g, "");
        return digits.length >= 8;
      });
    }
    const activeFilters = Object.entries(columnFilters).filter(([, value]) => value.trim() !== "");
    if (activeFilters.length > 0) {
      result = result.filter(row => {
        return activeFilters.every(([key, value]) => {
          const k = key as ColumnKey;
          const text = getColumnValue(k, row).toLowerCase();
          return text.includes(value.trim().toLowerCase());
        });
      });
    }
    result = [...result].sort((a, b) => {
      if (prioritySort) {
        const priorityDelta = prioritySort(b) - prioritySort(a);
        if (priorityDelta !== 0) return priorityDelta;
      }
      const aVal = getColumnSortValue(sortKey, a);
      const bVal = getColumnSortValue(sortKey, b);
      if (typeof aVal === "number" && typeof bVal === "number") return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      return sortDir === "asc" ? String(aVal).localeCompare(String(bVal)) : String(bVal).localeCompare(String(aVal));
    });
    return result;
  }, [data, rowFilter, search, sortKey, sortDir, columnFilters, getColumnValue, getColumnSortValue, prioritySort, effectiveDateMode, customRangePending]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageData = disablePagination ? filtered : filtered.slice(page * pageSize, (page + 1) * pageSize);
  const useDefaultCommandTheme =
    !headerContent &&
    !surfaceClassName &&
    !tableCardClassName &&
    !toolbarClassName &&
    !tableHeaderClassName &&
    !tableFilterHeaderClassName &&
    !tableFilterInputClassName;
  const worklistMetrics = useMemo(() => {
    const imageTotal = filtered.reduce((sum, row) => sum + (Number(row.imageCount) || 0), 0);
    const seriesTotal = filtered.reduce((sum, row) => sum + (Number(row.seriesCount) || 0), 0);
    const modalityTotal = new Set(filtered.map(row => row.modalityCode).filter(Boolean)).size;
    return {
      studies: filtered.length,
      images: imageTotal,
      series: seriesTotal,
      modalities: modalityTotal,
    };
  }, [filtered]);
  const resolvedSurfaceClassName = cn(useDefaultCommandTheme && "worklist-command-surface", surfaceClassName);
  const resolvedTableCardClassName = cn(
    useDefaultCommandTheme && "worklist-command-shell technologist-worklist-shell border-0 bg-transparent p-0 shadow-none overflow-visible",
    tableCardClassName
  );
  const resolvedToolbarClassName = cn(useDefaultCommandTheme && "technologist-worklist-toolbar worklist-command-toolbar", toolbarClassName);
  const resolvedTableHeaderClassName = cn(useDefaultCommandTheme && "radiology-tech-table-header", tableHeaderClassName);
  const resolvedTableFilterHeaderClassName = cn(useDefaultCommandTheme && "radiology-tech-filter-header", tableFilterHeaderClassName);
  const resolvedTableFilterInputClassName = cn(useDefaultCommandTheme && "radiology-tech-filter-input", tableFilterInputClassName);
  const shouldShowPagination = !disablePagination && !useDefaultCommandTheme;
  const visibleKeys = useMemo(() => {
    const keys = [
      ...columnOrder.filter(key => visibleColumns.has(key)),
      ...allColumnKeys.filter(key => visibleColumns.has(key) && !columnOrder.includes(key)),
    ];
    const lockedVisible = lockedColumns.filter(key => keys.includes(key));
    const unlocked = keys.filter(key => !lockedColumnSet.has(key));
    return [...lockedVisible, ...unlocked];
  }, [allColumnKeys, columnOrder, visibleColumns, lockedColumns, lockedColumnSet]);

  useEffect(() => {
    if (storageReadyKey !== storageKeyBase) return;
    if (hasCustomizedColumns || hasCustomizedOrder) return;
    setVisibleColumns(new Set(resolvedDefaultVisibleColumns));
    setColumnOrder(resolvedDefaultOrder);
  }, [hasCustomizedColumns, hasCustomizedOrder, resolvedDefaultOrder, resolvedDefaultVisibleColumns, storageReadyKey, storageKeyBase]);

  const selectedItems = useMemo(
    () => data.filter(item => selectedRows.has(item.id)),
    [data, selectedRows]
  );

  const selectedEcgViewer = useMemo(() => {
    if (selectedItems.length !== 1) return null;
    const item = selectedItems[0];
    return viewerConfigs.find(viewer =>
      viewer.id === "ecg-viewer" && isViewerAllowedForModality(viewer, item.modalityCode)
    ) || null;
  }, [selectedItems, viewerConfigs]);

  useEffect(() => {
    let active = true;
    const loadViewerConfigs = async () => {
      try {
        const configs = await dicomWebService.fetchViewerConfigs();
        if (active) setViewerConfigs(configs);
      } catch {
        if (active) setViewerConfigs([]);
      }
    };
    loadViewerConfigs();
    return () => {
      active = false;
    };
  }, []);

  const openSelectedEcgViewer = async () => {
    const selectedItem = selectedItems[0];
    if (!selectedItem?.studyInstanceUid || !selectedEcgViewer) return;
    try {
      await openViewerInNamedWindow(selectedEcgViewer, selectedItem.studyInstanceUid, {
        accessionNumber: selectedItem.accessionNumber,
        patientId: selectedItem.patientId,
      });
    } catch (error) {
      toast({
        title: "Failed to open VEXA ECG",
        description: error instanceof Error ? error.message : "Viewer configuration is invalid.",
        variant: "destructive",
      });
    }
  };

  const continueOpenStudy = useCallback(
    (row: WorklistItem) => {
      if (onOpenStudy) {
        onOpenStudy(row);
      } else if (enableDetailDialog) {
        setDetailItem(row);
      }
    },
    [enableDetailDialog, onOpenStudy]
  );

  const checkReconcileBeforeOpen = useCallback(
    async (row: WorklistItem) => {
      if (!enableMwlReconcile) {
        continueOpenStudy(row);
        return;
      }
      if (!row.studyInstanceUid || (!row.accessionNumber && !row.patientId)) {
        continueOpenStudy(row);
        return;
      }
      setReconcileChecking(true);
      try {
        const result = await mwlReconcileService.fetchCandidates({
          studyInstanceUid: row.studyInstanceUid,
          accessionNumber: row.accessionNumber,
          patientId: row.patientId,
          patientName: row.patientName,
          modality: row.modalityCode,
          studyDescription: row.studyDescription,
          studyDate: row.studyDate,
        });
        if (result.exact) {
          continueOpenStudy(row);
          return;
        }
        if (result.candidates.length > 0) {
          setReconcileStudy(row);
          setReconcileCandidates(result.candidates);
          setReconcileDialogOpen(true);
          return;
        }
        continueOpenStudy(row);
      } catch (error) {
        continueOpenStudy(row);
      } finally {
        setReconcileChecking(false);
      }
    },
    [continueOpenStudy, enableMwlReconcile, toast]
  );

  const confirmReconcileCandidate = async (candidate: MwlReconcileCandidate) => {
    if (!reconcileStudy?.studyInstanceUid) return;
    setReconcileSavingId(candidate.orderId);
    try {
      await mwlReconcileService.confirm({
        orderId: candidate.orderId,
        studyInstanceUid: reconcileStudy.studyInstanceUid,
        method: candidate.matchReason || "manual_confirmed",
        reason: "Confirmed by user from PACS worklist",
      });
      toast({
        title: "Study linked to MWL",
        description: `${reconcileStudy.patientName || reconcileStudy.patientId} has been linked to order ${candidate.accessionNumber}.`,
      });
      setReconcileDialogOpen(false);
      setReconcileCandidates([]);
      const study = reconcileStudy;
      setReconcileStudy(null);
      continueOpenStudy(study);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to link study to MWL order";
      toast({
        title: "MWL reconciliation failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setReconcileSavingId(null);
    }
  };

  const handleRowClick = (row: WorklistItem, index: number, event: ReactMouseEvent<HTMLTableRowElement>) => {
    if (disableRowSelection) return;
    if (event.shiftKey) {
      event.preventDefault();
      window.getSelection?.()?.removeAllRanges();
    } else if (hasActiveTextSelection()) {
      return;
    }
    if (isTouchDevice) {
      setSelectedRows(new Set([row.id]));
      setSelectionAnchorId(row.id);
      void checkReconcileBeforeOpen(row);
      return;
    }
    const isMulti = event.ctrlKey || event.metaKey;
    const anchorIndex = selectionAnchorId ? pageData.findIndex(item => item.id === selectionAnchorId) : -1;
    if (event.shiftKey && anchorIndex >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      const rangeIds = pageData.slice(start, end + 1).map(r => r.id);
      setSelectedRows(prev => {
        const next = new Set(prev);
        rangeIds.forEach(id => next.add(id));
        return next;
      });
      setSelectionAnchorId(row.id);
      if (enableInlinePreview && showSeriesInformation) setPreviewItem(row);
      return;
    }
    if (isMulti) {
      setSelectedRows(prev => {
        const next = new Set(prev);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      setSelectionAnchorId(row.id);
      if (enableInlinePreview && showSeriesInformation) setPreviewItem(row);
      return;
    }
    setSelectedRows(new Set([row.id]));
    setSelectionAnchorId(row.id);
    if (enableInlinePreview && showSeriesInformation) setPreviewItem(row);
  };

  const handleDelete = async () => {
    if (!canDelete) {
      toast({
        title: "Access denied",
        description: "This account does not have permission to delete studies.",
        variant: "destructive",
      });
      return;
    }
    if (selectedRows.size === 0) return;
    const toDelete = data.filter(r => selectedRows.has(r.id));
    if (toDelete.length === 0) {
      setSelectedRows(new Set());
      return;
    }
    const reason = await confirmDelete({
      title: `Delete ${toDelete.length} study(s)?`,
      description: "This will delete selected DICOM studies from the PACS.",
      target: toDelete.map(item => item.patientName || item.patientId || item.studyInstanceUid).join(", "),
    });
    if (!reason) return;
    try {
      for (const item of toDelete) {
        await dicomWebService.deleteStudy(item.patientId, item.studyInstanceUid, { reason });
      }
      setData(prev => prev.filter(r => !selectedRows.has(r.id)));
      toast({ title: `${toDelete.length} study(s) deleted from server` });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to delete study from server";
      toast({
        title: "Failed to delete study",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSelectedRows(new Set());
    }
  };

  const handleSort = (key: ColumnKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const getColumnWidth = useCallback(
    (key: ColumnKey) =>
      columnWidths[key] || extraColumnMap.get(key)?.width || DEFAULT_COLUMN_WIDTH[key] || 160,
    [columnWidths, extraColumnMap]
  );

  const handleColumnDrop = (target: ColumnKey) => {
    if (lockedColumnSet.has(target)) return;
    if (!draggingColumn || draggingColumn === target) return;
    if (lockedColumnSet.has(draggingColumn)) return;
    setColumnOrder(prev => {
      const next = [...prev];
      const fromIndex = next.indexOf(draggingColumn);
      const toIndex = next.indexOf(target);
      if (fromIndex === -1 || toIndex === -1) return prev;
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, draggingColumn);
      return next;
    });
    setHasCustomizedOrder(true);
    setDraggingColumn(null);
  };

  const renderCellContent = (key: ColumnKey, row: WorklistItem) => {
    if (key === "patientId") return row.patientId;
    if (key === "patientName") return <span className="text-foreground">{row.patientName}</span>;
    if (key === "accessionNumber") return row.accessionNumber;
    if (key === "modalityCode") return row.modalityCode;
    if (key === "studyDescription") {
      return (
        <span className="block max-w-[200px] truncate">{row.studyDescription}</span>
      );
    }
    if (key === "birthDate") {
      return (
        <span className="whitespace-nowrap">{formatDicomDate(row.birthDate)}</span>
      );
    }
    if (key === "age") {
      return (
        <span className="block text-center">{calculateAge(row.birthDate, row.studyDate)}</span>
      );
    }
    if (key === "imageCount") {
      return (
        <span className="block text-center">{row.imageCount}</span>
      );
    }
    if (key === "seriesCount") {
      return (
        <span className="block text-center">{row.seriesCount}</span>
      );
    }
    if (key === "referringPhysician") {
      return row.referringPhysician;
    }
    if (key === "studyDate") {
      return (
        <span className="whitespace-nowrap">{formatDicomDateTime(row.studyDate, row.studyTime)}</span>
      );
    }
    if (key === "status") {
      return (
        statusBadge(row.status)
      );
    }
    const extra = extraColumnMap.get(key);
    if (extra) {
      return extra.renderCell(row);
    }
    return null;
  };

  const statusBadge = (status: string) => {
    const label = status === "completed" ? "Completed" : status === "in-progress" ? "In Progress" : "Scheduled";
    const toneClass =
      status === "completed"
        ? "status-badge-success"
        : status === "in-progress"
          ? "status-badge-warning"
          : "status-badge-neutral";
    return <Badge variant="outline" className={`status-badge ${toneClass}`}>{label}</Badge>;
  };

  const modalities = [
    ...new Set(
      data
        .map(w => w.modalityCode)
        .filter(m => m && m.trim() !== "")
    ),
  ];

  const renderTableColGroup = () => (
    <colgroup>
      {visibleKeys.map(key => {
        const width = getColumnWidth(key);
        return <col key={`col-${key}`} style={{ width, minWidth: width }} />;
      })}
    </colgroup>
  );

  const renderTableHeader = () => (
    <thead className="sticky top-0 z-20">
      <tr className={`border-b border-border bg-card ${resolvedTableHeaderClassName}`}>
        {visibleKeys.map((key, index) => {
          const col = allColumns.find(c => c.key === key);
          const width = getColumnWidth(key);
          const isLast = index === visibleKeys.length - 1;
          return (
            <th
              key={key}
              className={`bg-card px-2 py-2 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap relative ${isLast ? "" : "border-r border-border"}`}
              onClick={() => handleSort(key)}
              draggable={!lockedColumnSet.has(key)}
              onDragStart={() => {
                if (!lockedColumnSet.has(key)) setDraggingColumn(key);
              }}
              onDragOver={event => {
                event.preventDefault();
              }}
              onDrop={() => handleColumnDrop(key)}
              style={{ width, minWidth: width }}
            >
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span className="truncate">{col?.label ?? key}</span>
                <SortIndicator active={sortKey === key} direction={sortDir} />
              </span>
              <div
                className="absolute right-0 top-0 h-full w-2 cursor-col-resize"
                onMouseDown={event => handleResizeStart(key, event)}
              />
            </th>
          );
        })}
      </tr>
      <tr className={`border-b border-border bg-card/95 ${resolvedTableFilterHeaderClassName}`}>
        {visibleKeys.map(key => {
          const width = getColumnWidth(key);
          if (key === "studyDate") {
            const label =
              effectiveDateMode === "range"
                ? effectiveFromDate && effectiveToDate
                  ? `${effectiveFromDate} -> ${effectiveToDate}`
                  : DATE_MODE_LABELS.range
                : DATE_MODE_LABELS[effectiveDateMode];
            // Konsep: kontrol tanggal di header kolom HANYA untuk halaman worklist (yang
            // mengambil datanya sendiri). Halaman lain memakai filter di kanan atas, di luar
            // header tabel — di sini sel itu berhenti menjadi kontrol supaya tidak ada dua
            // kontrol dengan label sama yang saling bertentangan.
            const headerOwnsDate = dateFilterPlacement === "column" && !isDateControlled;
            if (!headerOwnsDate) {
              if (!isDateControlled) {
                return (
                  <th
                    key={`${key}-filter`}
                    className="bg-card/95 px-2 py-1.5"
                    style={{ width, minWidth: width }}
                  />
                );
              }
              return (
                <th
                  key={`${key}-filter`}
                  className="bg-card/95 px-2 py-1.5"
                  style={{ width, minWidth: width }}
                >
                  <span
                    className="flex h-7 items-center truncate rounded-md px-2 text-[11px] text-muted-foreground"
                    title="Tanggal diatur dari filter halaman (kanan atas)"
                  >
                    {label}
                  </span>
                </th>
              );
            }
            return (
              <th
                key={`${key}-filter`}
                className="bg-card/95 px-2 py-1.5"
                style={{ width, minWidth: width }}
              >
                <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={`w-full h-7 rounded-md px-2 text-[11px] justify-between ${resolvedTableFilterInputClassName}`}
                    >
                      <span className="truncate">{label}</span>
                      <CalendarDays className="w-3 h-3 ml-1 text-muted-foreground" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-3" align="start">
                    <div className="space-y-3">
                      <RadioGroup
                        value={effectiveDateMode}
                        onValueChange={value => {
                          setDateFilterMode(value as DateFilterMode);
                          setPage(0);
                        }}
                        className="grid gap-2"
                      >
                        {dateModeOptions.map(mode => (
                          <label key={mode} className="flex items-center gap-2 text-xs cursor-pointer">
                            <RadioGroupItem value={mode} id={`date-mode-${mode}`} />
                            <span>{DATE_MODE_LABELS[mode]}</span>
                          </label>
                        ))}
                      </RadioGroup>
                      {effectiveDateMode === "range" && (
                        <div className="space-y-2">
                          <div className="grid grid-cols-[auto,1fr] items-center gap-2">
                            <span className="text-[11px] text-muted-foreground">From</span>
                            <Input
                              type="date"
                              value={fromDate}
                              onChange={e => {
                                setFromDate(e.target.value);
                                setPage(0);
                              }}
                              className="h-8 rounded-md text-[11px]"
                            />
                          </div>
                          <div className="grid grid-cols-[auto,1fr] items-center gap-2">
                            <span className="text-[11px] text-muted-foreground">To</span>
                            <Input
                              type="date"
                              value={toDate}
                              onChange={e => {
                                setToDate(e.target.value);
                                setPage(0);
                              }}
                              className="h-8 rounded-md text-[11px]"
                            />
                          </div>
                          {customRangePending && (
                            <p className="text-[11px] text-muted-foreground">
                              Pick both dates to load studies.
                            </p>
                          )}
                        </div>
                      )}
                      <div className="flex justify-between pt-1">
                        <Button
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => {
                            // Reset to the default window. There is no "all dates"
                            // mode any more, so clearing must pick a bounded mode.
                            setDateFilterMode(dateModeOptions[0] || "today");
                            setFromDate("");
                            setToDate("");
                            setPage(0);
                          }}
                        >
                          Clear
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </th>
            );
          }
          return (
            <th
              key={`${key}-filter`}
              className="bg-card/95 px-2 py-1.5"
              style={{ width, minWidth: width }}
            >
              <Input
                value={columnFilters[key]}
                onChange={event => {
                  const value = event.target.value;
                  setColumnFilters(prev => ({ ...prev, [key]: value }));
                  setPage(0);
                }}
                placeholder=""
                className={`h-7 rounded-md text-xs ${resolvedTableFilterInputClassName}`}
              />
            </th>
          );
        })}
      </tr>
    </thead>
  );

  const showInlineSeriesPanel = enableInlinePreview && showSeriesInformation;
  const useSplitLayout = showInlineSeriesPanel && !isMobile;

  return (
    <div
      ref={selectionContainerRef}
      className={`animate-fade-in ${useSplitLayout ? "flex h-[calc(100dvh-6.5rem)] min-h-0 flex-col gap-4 overflow-hidden" : "space-y-4"} ${resolvedSurfaceClassName}`}
    >
      {headerContent ? (
        headerContent
      ) : useDefaultCommandTheme ? (
        <div className="worklist-command-hero technologist-command-header">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-4xl font-black tracking-tight">{title}</h1>
                </div>
              </div>
              {headerActions ? <div className="flex items-center gap-2">{headerActions}</div> : null}
            </div>

            <div className="grid grid-cols-4 gap-2 sm:gap-3">
              <div data-tone="cyan" className="technologist-metric min-w-0 rounded-2xl border px-2 py-2 backdrop-blur-xl sm:px-4 sm:py-3">
                <div className="flex items-center justify-between gap-1 sm:gap-3">
                  <div className="truncate text-[8px] font-semibold uppercase tracking-[0.12em] sm:text-[10px] sm:tracking-[0.22em]">Studies</div>
                  <div className="hidden rounded-xl border p-2 sm:block"><Database className="h-4 w-4" /></div>
                </div>
                <div className="mt-1 text-lg font-black tracking-tight sm:mt-2 sm:text-2xl">{worklistMetrics.studies}</div>
              </div>
              <div data-tone="cyan" className="technologist-metric min-w-0 rounded-2xl border px-2 py-2 backdrop-blur-xl sm:px-4 sm:py-3">
                <div className="flex items-center justify-between gap-1 sm:gap-3">
                  <div className="truncate text-[8px] font-semibold uppercase tracking-[0.12em] sm:text-[10px] sm:tracking-[0.22em]">Images</div>
                  <div className="hidden rounded-xl border p-2 sm:block"><Images className="h-4 w-4" /></div>
                </div>
                <div className="mt-1 text-lg font-black tracking-tight sm:mt-2 sm:text-2xl">{worklistMetrics.images}</div>
              </div>
              <div data-tone="cyan" className="technologist-metric min-w-0 rounded-2xl border px-2 py-2 backdrop-blur-xl sm:px-4 sm:py-3">
                <div className="flex items-center justify-between gap-1 sm:gap-3">
                  <div className="truncate text-[8px] font-semibold uppercase tracking-[0.12em] sm:text-[10px] sm:tracking-[0.22em]">Series</div>
                  <div className="hidden rounded-xl border p-2 sm:block"><Layers3 className="h-4 w-4" /></div>
                </div>
                <div className="mt-1 text-lg font-black tracking-tight sm:mt-2 sm:text-2xl">{worklistMetrics.series}</div>
              </div>
              <div data-tone="cyan" className="technologist-metric min-w-0 rounded-2xl border px-2 py-2 backdrop-blur-xl sm:px-4 sm:py-3">
                <div className="flex items-center justify-between gap-1 sm:gap-3">
                  <div className="truncate text-[8px] font-semibold uppercase tracking-[0.12em] sm:text-[10px] sm:tracking-[0.22em]">Modalities</div>
                  <div className="hidden rounded-xl border p-2 sm:block"><MonitorDot className="h-4 w-4" /></div>
                </div>
                <div className="mt-1 text-lg font-black tracking-tight sm:mt-2 sm:text-2xl">{worklistMetrics.modalities}</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="page-title">{title}</h1>
          </div>
          {headerActions ? <div className="flex items-center gap-2">{headerActions}</div> : null}
        </div>
      )}

      {/* Table */}
      <div className={`medical-card p-0 overflow-hidden ${useSplitLayout ? "flex min-h-0 flex-1 flex-col" : ""} ${resolvedTableCardClassName}`}>
        <div className={`worklist-table-toolbar flex flex-nowrap items-center gap-2 px-4 py-3 border-b border-border bg-muted/20 ${resolvedToolbarClassName}`}>
          <div className="worklist-toolbar-search relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search patients, ID, or study..."
              value={search}
              onChange={e => {
                setSearch(e.target.value);
                setPage(0);
              }}
              className="pl-10 rounded-xl h-9"
            />
          </div>

          <div className="worklist-toolbar-actions flex min-w-0 flex-none items-center justify-end gap-1.5 sm:gap-2">
            {!disableRowSelection && selectedRows.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">({selectedRows.size})</span>
                {onProcessSelected && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className="rounded-xl h-9 px-3"
                        onClick={() => onProcessSelected(selectedItems)}
                        disabled={selectedItems.length === 0}
                      >
                        {processLabel}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{processLabel}</TooltipContent>
                  </Tooltip>
                )}
                {selectedEcgViewer && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="rounded-xl h-9 w-9"
                        onClick={openSelectedEcgViewer}
                        aria-label={`Open ${getViewerButtonLabel(selectedEcgViewer)}`}
                      >
                        <HeartPulse className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Open {getViewerButtonLabel(selectedEcgViewer)}</TooltipContent>
                  </Tooltip>
                )}
                {canForward && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="rounded-xl h-9 w-9"
                        onClick={openForwardDialog}
                        disabled={forwarding || nodes.length === 0}
                        aria-label="Forward studies"
                      >
                        {forwarding ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Forward {selectedRows.size} study{selectedRows.size > 1 ? "ies" : ""} to DICOM node
                    </TooltipContent>
                  </Tooltip>
                )}
                {canDelete && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        size="icon"
                        className="rounded-xl h-9 w-9"
                        onClick={handleDelete}
                        aria-label={`Delete (${selectedRows.size})`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete ({selectedRows.size})</TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
            {filterActions}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="rounded-xl h-9 w-9">
                      <Columns3 className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Columns</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-48">
                {allColumns.map(col => (
                  <DropdownMenuCheckboxItem
                    key={col.key}
                    checked={visibleColumns.has(col.key)}
                    disabled={lockedColumnSet.has(col.key)}
                    onCheckedChange={checked => {
                      if (lockedColumnSet.has(col.key)) return;
                      setHasCustomizedColumns(true);
                      const next = new Set(visibleColumns);
                      if (checked) {
                        next.add(col.key);
                        setColumnOrder(current => current.includes(col.key) ? current : [...current, col.key]);
                      } else {
                        next.delete(col.key);
                      }
                      setVisibleColumns(next);
                    }}
                  >
                    {col.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className={useSplitLayout ? "min-h-0 flex-1 overflow-hidden" : ""}>
          <div
            className={cn("worklist-table-scroll overflow-auto [scrollbar-gutter:stable]", useSplitLayout ? "h-full" : "")}
            onScroll={() => setDatePopoverOpen(false)}
            onPointerDown={event => {
              if (datePopoverOpen && event.pointerType === "touch") {
                setDatePopoverOpen(false);
              }
            }}
          >
            <table className="w-full min-w-max table-fixed text-sm select-text">
              {renderTableColGroup()}
              {renderTableHeader()}
              <tbody>
                {isLoading && data.length === 0 ? null : loadError ? (
                  <tr>
                    <td colSpan={visibleKeys.length} className="p-12 text-center text-destructive">
                      {loadError}
                    </td>
                  </tr>
                ) : pageData.length === 0 ? (
                  hideEmptyState ? null : (
                  <tr>
                    <td colSpan={visibleKeys.length} className="p-12 text-center text-muted-foreground">
                      {customRangePending
                        ? "Select both From and To dates to load studies"
                        : "No studies found"}
                    </td>
                  </tr>
                  )
                ) : pageData.map((row, index) => {
                  const isSelected = selectedRows.has(row.id);
                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        "border-b border-border last:border-0 transition-colors",
                        rowClassName?.(row),
                        disableRowSelection
                          ? "hover:bg-muted/20"
                          : isSelected
                            ? "cursor-pointer border-sky-400/40 bg-sky-500/20 text-foreground ring-2 ring-inset ring-sky-400/70 shadow-[inset_4px_0_0_rgba(56,189,248,0.95)] hover:bg-sky-500/25"
                            : "cursor-pointer hover:bg-muted/30"
                      )}
                      onClick={event => handleRowClick(row, index, event)}
                      onDoubleClick={() => {
                        if (disableRowSelection && !onOpenStudy) return;
                        void checkReconcileBeforeOpen(row);
                      }}
                    >
                      {visibleKeys.map(key => {
                        const width = getColumnWidth(key);
                        return (
                          <td
                            key={key}
                            className={`px-2 py-1.5 whitespace-nowrap ${key === "studyDescription" ? "truncate" : ""}`}
                            style={{ width, minWidth: width }}
                          >
                            {renderCellContent(key, row)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {shouldShowPagination && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <p className="text-sm text-muted-foreground">
              {filtered.length} total
            </p>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Rows</span>
                <Select value={String(pageSize)} onValueChange={value => setPageSize(Number(value))}>
                  <SelectTrigger className="w-[90px] h-8 rounded-lg text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map(size => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="text-xs text-muted-foreground">
                Page {page + 1} / {totalPages}
              </span>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" className="rounded-xl" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="rounded-xl" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {showInlineSeriesPanel && (
        <div className={useSplitLayout ? "flex-none" : ""}>
          <StudySeriesPreviewPanel
            item={previewItem}
            className={cn(useSplitLayout ? "max-h-[245px]" : "", useDefaultCommandTheme && "worklist-series-command-panel")}
          />
        </div>
      )}

      <Dialog open={assignmentDialogOpen} onOpenChange={open => setAssignmentDialogOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
          <DialogTitle>Set Reporting</DialogTitle>
            <DialogDescription>
              {assignmentStudy?.patientName || assignmentStudy?.patientId || "Selected study"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Select
              value={selectedRadiologistId}
              onValueChange={value => setSelectedRadiologistId(value)}
              disabled={radiologistLoading || radiologistUsers.length === 0}
            >
              <SelectTrigger className="h-10 rounded-xl">
                    <SelectValue placeholder={radiologistLoading ? "Loading reporting users..." : "Select reporting user"} />
              </SelectTrigger>
              <SelectContent>
                {radiologistUsers.map(user => (
                  <SelectItem key={user.id} value={String(user.id)}>
                    {user.name || user.username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              className="rounded-xl"
              onClick={handleAssignRadiologist}
              disabled={assignmentSaving || radiologistUsers.length === 0}
            >
              {assignmentSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Forward Dialog */}
      <Dialog open={forwardDialogOpen} onOpenChange={open => setForwardDialogOpen(open)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>DICOM Transfer - to DICOM Destination</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] gap-4">
            <div className="space-y-3">
              <p className="text-sm font-medium">Selected Items</p>
              <div className="border rounded-lg bg-muted/30">
                <ScrollArea className="h-64">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="text-left px-2 py-1.5 w-[40%]">Patient Name</th>
                        <th className="text-left px-2 py-1.5 w-[40%]">Study Description</th>
                        <th className="text-left px-2 py-1.5 w-[20%]">Study Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forwardItems.map(item => (
                        <tr key={item.id} className="border-b last:border-0 border-border">
                          <td className="px-2 py-1.5">{item.patientName || item.patientId}</td>
                          <td className="px-2 py-1.5">{item.studyDescription}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {formatDicomDate(item.studyDate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>
              </div>

              <p className="mt-4 text-sm font-medium">Transfer Status</p>
              <div className="border rounded-lg bg-muted/30">
                <ScrollArea className="h-64">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="text-left px-2 py-1.5 w-[30%]">Patient Name</th>
                        <th className="text-left px-2 py-1.5 w-[30%]">Description</th>
                        <th className="text-left px-2 py-1.5 w-[20%]">Destination</th>
                        <th className="text-left px-2 py-1.5 w-[20%]">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forwardItems
                        .filter(item => {
                          const key = item.studyInstanceUid || item.id;
                          return Boolean(forwardResults[key]);
                        })
                        .map(item => {
                          const key = item.studyInstanceUid || item.id;
                          const result = forwardResults[key];
                          if (!result) return null;
                          const status = result.status;
                          const message = result.message;
                          const label =
                            status === "ok"
                              ? "Completed"
                              : status === "error"
                                ? "Failed"
                                : "Pending";
                          const variant =
                            status === "ok"
                              ? "default"
                              : status === "error"
                                ? "destructive"
                                : "outline";
                          return (
                            <tr key={key} className="border-b last:border-0 border-border">
                              <td className="px-2 py-1.5">{item.patientName || item.patientId}</td>
                              <td className="px-2 py-1.5">{item.studyDescription}</td>
                              <td className="px-2 py-1.5">
                                {nodes.find(n => String(n.id) === selectedNodeId)?.name ?? "-"}
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex flex-col gap-1">
                                  <Badge variant={variant} className="w-fit rounded-lg text-xs">
                                    {label}
                                  </Badge>
                                  {message && (
                                    <span className="text-[11px] text-muted-foreground line-clamp-2">
                                      {message}
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </ScrollArea>
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Destination</p>
                <Select
                  value={selectedNodeId}
                  onValueChange={value => setSelectedNodeId(value)}
                  disabled={nodesLoading || nodes.length === 0}
                >
                  <SelectTrigger className="w-full h-10 rounded-xl text-sm">
                    <SelectValue
                      placeholder={nodesLoading ? "Loading nodes..." : "Select DICOM node"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes.map(node => (
                      <SelectItem key={node.id} value={String(node.id)}>
                        {node.name} ({node.aet})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  className="rounded-xl"
                  disabled={forwarding || nodes.length === 0}
                  onClick={handleForwardConfirm}
                >
                  {forwarding && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Start Transfer
                </Button>
              </DialogFooter>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reconcileDialogOpen}
        onOpenChange={open => {
          setReconcileDialogOpen(open);
          if (!open) {
            setReconcileStudy(null);
            setReconcileCandidates([]);
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Potential MWL Match</DialogTitle>
            <DialogDescription>
              This PACS study is similar to an existing MWL order. Link it only when the staff is sure.
            </DialogDescription>
          </DialogHeader>
          {reconcileStudy && (
            <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
              <div className="font-semibold text-foreground">
                {reconcileStudy.patientName || "-"} Â· {reconcileStudy.patientId || "-"}
              </div>
              <div className="text-muted-foreground">
                Accession {reconcileStudy.accessionNumber || "-"} Â· {reconcileStudy.modalityCode || "-"} Â· {reconcileStudy.studyDescription || "-"}
              </div>
            </div>
          )}
          <ScrollArea className="max-h-[360px] pr-3">
            <div className="space-y-3">
              {reconcileCandidates.map(candidate => (
                <div
                  key={candidate.orderId}
                  className="rounded-xl border border-border bg-background p-3"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">
                        {candidate.patientName || "-"} Â· {candidate.patientId || "-"}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Accession {candidate.accessionNumber || "-"} Â· {candidate.modality || "-"} Â· {candidate.studyDescription || "-"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Candidate reason: {candidate.matchReason || "candidate"} Â· Status {candidate.status || "-"}
                      </div>
                    </div>
                    <Button
                      type="button"
                      className="rounded-xl"
                      onClick={() => void confirmReconcileCandidate(candidate)}
                      disabled={reconcileSavingId !== null}
                    >
                      {reconcileSavingId === candidate.orderId ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Yes, link
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => {
                const study = reconcileStudy;
                setReconcileDialogOpen(false);
                setReconcileStudy(null);
                setReconcileCandidates([]);
                if (study) continueOpenStudy(study);
              }}
            >
              Not now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Study Detail Dialog */}
      {enableDetailDialog && (
        <StudyDetailDialog
          item={detailItem}
          onClose={() => setDetailItem(null)}
          onMetadataUpdated={handleMetadataUpdated}
          layout="legacy"
        />
      )}
      {DeleteReasonDialog}
    </div>
  );
};

export default Worklist;

