import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, AlertTriangle, CalendarDays, CheckCircle2, ClipboardCheck, Clock3, Edit3, Filter, Radiation, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import Worklist from "./Worklist";
import type { WorklistItem } from "@/data/mockData";
import {
  dicomWebService,
  mwlService,
  qualityControlService,
  radiologyReportService,
  radiologistAssignmentService,
  type RadiologistAssignment,
} from "@/lib/dicomService";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ReportStatus = "draft" | "final" | "";
type DatePreset = "today" | "yesterday" | "7days" | "1month" | "2months" | "range";
type ReportingQuickFilter = "pending" | "draft" | "cito" | "final" | null;
const REPORTING_SCHEDULED_ORDER_STATUSES: Array<"SENT_TO_MWL" | "COMPLETED"> = ["SENT_TO_MWL", "COMPLETED"];

const trackToneClass = (tone: "idle" | "active" | "done") => {
  if (tone === "done") return "bg-emerald-600/90 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] dark:bg-emerald-500/55 dark:text-emerald-50";
  if (tone === "active") return "bg-amber-500/85 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] dark:bg-amber-500/45 dark:text-amber-50";
  return "bg-transparent text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-700/50";
};

const isCitoOrder = (value?: string | boolean | null) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toUpperCase();
  return normalized === "Y" || normalized === "YES" || normalized === "TRUE" || normalized === "1" || normalized === "CITO";
};

const isReadyForReporting = (row: WorklistItem) =>
  (row.imageCount ?? 0) > 0 || row.status === "completed";

const CitoIndicator = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span
        aria-label="CITO patient"
        className="cito-breath-indicator h-3 w-3 rounded-full bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.18)]"
      />
    </TooltipTrigger>
    <TooltipContent>CITO / Emergency patient</TooltipContent>
  </Tooltip>
);

const StatusTrackIcon = ({
  label,
  tone,
  icon,
}: {
  label: string;
  tone: "idle" | "active" | "done";
  icon: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <div
        aria-label={label}
        className={cn(
          "flex h-9 w-11 items-center justify-center border-r border-white/10 transition-colors last:border-r-0 dark:border-white/10",
          trackToneClass(tone)
        )}
      >
        {icon}
      </div>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

const CommandMetric = ({
  label,
  compactLabel,
  value,
  tone,
  icon,
  active = false,
  onClick,
}: {
  label: string;
  compactLabel?: string;
  value: number | string;
  tone: "cyan" | "amber" | "red" | "emerald";
  icon: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) => {
  const toneClass = {
    cyan: "border-slate-300/70 bg-slate-100/80 text-slate-700 dark:border-sky-300/20 dark:bg-sky-400/10 dark:text-sky-100",
    amber: "border-amber-300/70 bg-amber-50/90 text-amber-800 dark:border-amber-300/25 dark:bg-amber-400/10 dark:text-amber-100",
    red: "border-red-300/70 bg-red-50/90 text-red-800 dark:border-red-300/25 dark:bg-red-400/10 dark:text-red-100",
    emerald: "border-emerald-300/70 bg-emerald-50/90 text-emerald-800 dark:border-emerald-300/25 dark:bg-emerald-400/10 dark:text-emerald-100",
  }[tone];

  return (
    <button
      type="button"
      data-tone={tone}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "technologist-metric min-w-0 rounded-[18px] border px-1.5 py-2.5 text-center backdrop-blur-xl transition sm:rounded-2xl sm:px-4 sm:py-3 sm:text-left",
        "hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70",
        active && "ring-2 ring-sky-400/70 shadow-[0_0_0_1px_rgba(56,189,248,0.22),0_16px_30px_rgba(15,23,42,0.16)]",
        toneClass
      )}
    >
      <div className="flex flex-col items-center justify-center gap-1 sm:flex-row sm:justify-between sm:gap-3">
        <div className="whitespace-nowrap text-[7px] font-black uppercase tracking-[0.12em] sm:text-[11px] sm:tracking-[0.24em]">
          <span className="sm:hidden">{compactLabel || label}</span>
          <span className="hidden sm:inline">{label}</span>
        </div>
        <div className="hidden h-8 w-8 items-center justify-center rounded-xl border border-current/15 bg-white/25 dark:bg-white/10 sm:flex">
          {icon}
        </div>
      </div>
      <div className="mt-1.5 text-[20px] font-black leading-none sm:mt-4 sm:text-3xl">{value}</div>
    </button>
  );
};

const toDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length >= 8) {
    const year = Number(digits.slice(0, 4));
    const month = Number(digits.slice(4, 6));
    const day = Number(digits.slice(6, 8));
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      return new Date(year, month - 1, day);
    }
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isRowInPreset = (row: WorklistItem, preset: DatePreset, fromDate: string, toDateValue: string): boolean => {
  const date = toDate(row.studyDate);
  // Baris tanpa tanggal studi tidak boleh HILANG diam-diam. Daftar ini digerakkan oleh
  // assignment + kesiapan baca (isReadyForReporting), bukan oleh tanggal; dulu baris
  // seperti ini dibuang di SEMUA preset tanggal sehingga tampak "data tidak masuk"
  // padahal study sudah ditugaskan dan radiolognya benar.
  if (!date) return true;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const today = new Date();
  const todayStart = startOf(today);
  const dateOnly = startOf(date);

  if (preset === "today") return dateOnly.getTime() === todayStart.getTime();
  if (preset === "yesterday") {
    const yesterday = new Date(todayStart);
    yesterday.setDate(yesterday.getDate() - 1);
    return dateOnly.getTime() === yesterday.getTime();
  }
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

const formatActiveDateFilterLabel = (preset: DatePreset, fromDate: string, toDateValue: string) => {
  if (preset === "today") return "Today";
  if (preset === "yesterday") return "Yesterday";
  if (preset === "7days") return "Last 7 Days";
  if (preset === "1month") return "Last 1 Month";
  if (preset === "2months") return "Last 2 Months";
  if (preset === "range") {
    if (fromDate && toDateValue) return `Custom: ${fromDate} - ${toDateValue}`;
    if (fromDate) return `Custom: from ${fromDate}`;
    if (toDateValue) return `Custom: until ${toDateValue}`;
    return "Custom Range";
  }
  return "Today";
};

const getFilterStorageKey = (username?: string | null) =>
  `radiologist:filters:${username || "guest"}`;

const normalizeMatchKey = (value?: string | null) => String(value || "").trim().toLowerCase();

const RadiologistWorklist = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const [showAll, setShowAll] = useState(false);
  const [quickFilter, setQuickFilter] = useState<ReportingQuickFilter>(null);
  const [reportStatusMap, setReportStatusMap] = useState<Record<string, ReportStatus>>({});
  const [qcStatusMap, setQcStatusMap] = useState<
    Record<string, { processed_by?: string | null; processed_at?: string | null }>
  >({});
  const [assignmentMap, setAssignmentMap] = useState<Record<string, RadiologistAssignment>>({});
  const [assignedStudyUids, setAssignedStudyUids] = useState<Set<string>>(new Set());
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [radiologistCompetitionEnabled, setRadiologistCompetitionEnabled] = useState(false);
  const [takeoverStudy, setTakeoverStudy] = useState<WorklistItem | null>(null);
  const [takeoverSaving, setTakeoverSaving] = useState(false);
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDateValue, setToDateValue] = useState("");
  const [loadedRows, setLoadedRows] = useState<WorklistItem[]>([]);
  const [risOrderKeys, setRisOrderKeys] = useState<Set<string>>(new Set());
  const [citoOrderKeys, setCitoOrderKeys] = useState<Set<string>>(new Set());
  const [risOrdersLoading, setRisOrdersLoading] = useState(true);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);

  const loadRisOrderKeys = useCallback(async (options?: { silent?: boolean }) => {
      const silent = Boolean(options?.silent);
      if (!silent) setRisOrdersLoading(true);
      try {
        const orders = await mwlService.fetchOrders({ status: "ALL", limit: 1000 });
        const keys = new Set<string>();
        const citoKeys = new Set<string>();
        orders
          .filter(order => order.status !== "CANCELLED")
          .forEach(order => {
            [
              order.study_instance_uid,
              order.actual_study_instance_uid,
              order.accession_number,
              order.no_rontgen,
            ].forEach(value => {
              const key = normalizeMatchKey(value);
              if (key) {
                keys.add(key);
                if (isCitoOrder(order.cito)) citoKeys.add(key);
              }
            });
          });
        setRisOrderKeys(keys);
        setCitoOrderKeys(citoKeys);
      } catch (error) {
        if (!silent) {
          setRisOrderKeys(new Set());
          setCitoOrderKeys(new Set());
          toast({
            title: "Failed to load RIS orders",
            description: error instanceof Error ? error.message : "Reporting will hide non-order studies.",
            variant: "destructive",
          });
        }
      } finally {
        if (!silent) setRisOrdersLoading(false);
      }
  }, [toast]);

  useEffect(() => {
    loadRisOrderKeys();
  }, [loadRisOrderKeys]);

  const isRisOrderStudy = useCallback(
    (row: WorklistItem) =>
      [
        row.studyInstanceUid,
        row.accessionNumber,
        row.id,
      ].some(value => risOrderKeys.has(normalizeMatchKey(value))),
    [risOrderKeys]
  );
  const isCitoStudy = useCallback(
    (row: WorklistItem) =>
      [
        row.studyInstanceUid,
        row.accessionNumber,
        row.id,
      ].some(value => citoOrderKeys.has(normalizeMatchKey(value))),
    [citoOrderKeys]
  );

  useEffect(() => {
    const loadUiSettings = async () => {
      try {
        const settings = await dicomWebService.fetchUiSettings();
        setRadiologistCompetitionEnabled(Boolean(settings?.radiologistCompetitionEnabled));
        setAutoRefreshEnabled(typeof settings.autoRefresh === "boolean" ? settings.autoRefresh : true);
      } catch {
        setRadiologistCompetitionEnabled(false);
        setAutoRefreshEnabled(true);
      }
    };
    loadUiSettings();
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(() => {
      loadRisOrderKeys({ silent: true });
    }, 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, loadRisOrderKeys]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(getFilterStorageKey(user?.username));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        showAll?: boolean;
        datePreset?: DatePreset;
        fromDate?: string;
        toDateValue?: string;
      };
      if (typeof parsed.showAll === "boolean") setShowAll(parsed.showAll);
      if (parsed.datePreset) setDatePreset(parsed.datePreset);
      if (typeof parsed.fromDate === "string") setFromDate(parsed.fromDate);
      if (typeof parsed.toDateValue === "string") setToDateValue(parsed.toDateValue);
    } catch {
      // ignore invalid stored filters
    }
  }, [user?.username]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      getFilterStorageKey(user?.username),
      JSON.stringify({
        showAll,
        datePreset,
        fromDate,
        toDateValue,
      })
    );
  }, [user?.username, showAll, datePreset, fromDate, toDateValue]);

  const handleDataLoaded = useCallback(
    async (rows: WorklistItem[]) => {
      setLoadedRows(rows);
      const studyUids = Array.from(
        new Set(rows.map(row => row.studyInstanceUid).filter(Boolean))
      );
      if (studyUids.length === 0) {
        setReportStatusMap({});
        setQcStatusMap({});
        setAssignmentMap({});
        setAssignedStudyUids(new Set());
        return;
      }
      try {
        const [reportStatuses, qcStatuses, assignments] = await Promise.all([
          radiologyReportService.fetchStatuses(studyUids),
          qualityControlService.fetchStatuses(studyUids),
          radiologistAssignmentService.fetchAssignments(studyUids),
        ]);
        const nextReport: Record<string, ReportStatus> = {};
        reportStatuses.forEach(item => {
          if (item.study_instance_uid) {
            nextReport[item.study_instance_uid] = item.status;
          }
        });
        setReportStatusMap(nextReport);
        const nextQc: Record<string, { processed_by?: string | null; processed_at?: string | null }> = {};
        qcStatuses.forEach(item => {
          if (item.study_instance_uid) {
            nextQc[item.study_instance_uid] = {
              processed_by: item.processed_by ?? null,
              processed_at: item.processed_at ?? null,
            };
          }
        });
        setQcStatusMap(nextQc);
        const nextAssignments: Record<string, RadiologistAssignment> = {};
        assignments.forEach(item => {
          if (item.study_instance_uid) {
            nextAssignments[item.study_instance_uid] = item;
          }
        });
        setAssignmentMap(nextAssignments);
        if (user?.username) {
          setAssignmentLoading(true);
          try {
            const assigned = new Set(
              assignments
                .filter(
                  item =>
                    String(item.radiologist_username || "").trim().toLowerCase() ===
                    user.username.toLowerCase()
                )
                .map(item => item.study_instance_uid)
                .filter((uid): uid is string => typeof uid === "string" && uid.trim().length > 0)
            );
            setAssignedStudyUids(assigned);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to load assignments";
            toast({
              title: "Failed to load assignments",
              description: message,
              variant: "destructive",
            });
            setAssignedStudyUids(new Set());
          } finally {
            setAssignmentLoading(false);
          }
        } else {
          setAssignedStudyUids(new Set());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load report status";
        toast({
          title: "Failed to load status",
          description: message,
          variant: "destructive",
        });
      }
    },
    [toast, user?.username]
  );

  const handleConfirmTakeover = useCallback(async () => {
    if (!takeoverStudy?.studyInstanceUid || !user?.username) return;
    setTakeoverSaving(true);
    try {
      const assignment = await radiologistAssignmentService.assignRadiologist({
        studyInstanceUid: takeoverStudy.studyInstanceUid,
        radiologistUsername: user.username,
        assignedBy: user.username,
      });
      setAssignmentMap(prev => ({
        ...prev,
        [takeoverStudy.studyInstanceUid]: assignment,
      }));
      setAssignedStudyUids(prev => {
        const next = new Set(prev);
        next.add(takeoverStudy.studyInstanceUid);
        return next;
      });
      toast({
        title: "Reporting reassigned",
        description: "This study has been moved to your reporting account.",
      });
      const targetStudyUid = takeoverStudy.studyInstanceUid;
      setTakeoverStudy(null);
      navigate(`/reporting/report/${encodeURIComponent(targetStudyUid)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to takeover study";
      toast({
        title: "Failed to reassign reporting",
        description: message,
        variant: "destructive",
      });
    } finally {
      setTakeoverSaving(false);
    }
  }, [navigate, takeoverStudy, toast, user?.username]);

  const extraColumns = useMemo(
    () => [
      {
        key: "statusTrack",
        label: "Status Track",
        width: 190,
        getValue: (row: WorklistItem) => {
          const key = row.studyInstanceUid || row.id;
          const reportStatus = reportStatusMap[key] || "";
          const checked = qcStatusMap[key]?.processed_at ? "checked" : "";
          const ready = isReadyForReporting(row) ? "ready" : "";
          const cito = isCitoStudy(row) ? "CITO" : "";
          return [cito, ready, reportStatus, checked].filter(Boolean).join(" ");
        },
        renderCell: (row: WorklistItem) => {
          const key = row.studyInstanceUid || row.id;
          const hasImages = (row.imageCount ?? 0) > 0;
          const isDirectCompleted = row.status === "completed" && !hasImages;
          const hasScheduledPlaceholder = row.status === "scheduled" && !hasImages;
          const reportStatus = reportStatusMap[key] || "";
          const checked = Boolean(qcStatusMap[key]?.processed_at);
          const technologistTone: "idle" | "active" | "done" = hasImages || isDirectCompleted ? "done" : hasScheduledPlaceholder ? "active" : "idle";
          const radiologistTone: "idle" | "active" | "done" =
            reportStatus === "final"
              ? "done"
              : reportStatus === "draft"
                ? "active"
                : "idle";
          const qcTone: "idle" | "active" | "done" = checked ? "done" : "idle";
          return (
            <div className="inline-flex items-center overflow-hidden rounded-md border border-slate-300/70 bg-slate-100/90 shadow-sm whitespace-nowrap dark:border-slate-700/70 dark:bg-slate-900/80">
              <StatusTrackIcon label="Technologist" tone={technologistTone} icon={<Radiation className="h-4 w-4" />} />
              <StatusTrackIcon label="Reporting" tone={radiologistTone} icon={<Stethoscope className="h-4 w-4" />} />
              <StatusTrackIcon label="Distribution" tone={qcTone} icon={<ClipboardCheck className="h-4 w-4" />} />
            </div>
          );
        },
      },
    ],
    [isCitoStudy, qcStatusMap, reportStatusMap]
  );
  const activeDateFilterLabel = useMemo(
    () => formatActiveDateFilterLabel(datePreset, fromDate, toDateValue),
    [datePreset, fromDate, toDateValue]
  );

  const reportingStats = useMemo(() => {
    const reportingRows = loadedRows.filter(row => {
      if (risOrdersLoading || !isRisOrderStudy(row)) return false;
      if (!isReadyForReporting(row)) return false;
      if (!isRowInPreset(row, datePreset, fromDate, toDateValue)) return false;
      if (!radiologistCompetitionEnabled) {
        const uid = row.studyInstanceUid || row.id;
        if (!assignedStudyUids.has(uid)) return false;
      }
      return true;
    });
    const citoRows = reportingRows.filter(row => isCitoStudy(row));
    const finalRows = reportingRows.filter(row => reportStatusMap[row.studyInstanceUid || row.id] === "final");
    const draftRows = reportingRows.filter(row => reportStatusMap[row.studyInstanceUid || row.id] === "draft");
    const pendingRows = reportingRows.filter(row => {
      const status = reportStatusMap[row.studyInstanceUid || row.id] || "";
      return status !== "draft" && status !== "final";
    });
    const finalCitoRows = citoRows.filter(row => reportStatusMap[row.studyInstanceUid || row.id] === "final");

    return {
      pending: pendingRows.length,
      draft: draftRows.length,
      final: finalRows.length,
      citoProgress: `${finalCitoRows.length}/${citoRows.length}`,
      total: reportingRows.length,
    };
  }, [
    assignedStudyUids,
    datePreset,
    fromDate,
    isCitoStudy,
    isRisOrderStudy,
    loadedRows,
    radiologistCompetitionEnabled,
    reportStatusMap,
    risOrdersLoading,
    toDateValue,
  ]);

  const toggleQuickFilter = (next: Exclude<ReportingQuickFilter, null>) => {
    setQuickFilter(current => (current === next ? null : next));
  };

  const matchesQuickFilter = useCallback(
    (row: WorklistItem) => {
      const uid = row.studyInstanceUid || row.id;
      const status = reportStatusMap[uid] || "";
      if (quickFilter === "pending") return status !== "draft" && status !== "final";
      if (quickFilter === "draft") return status === "draft";
      if (quickFilter === "cito") return isCitoStudy(row);
      if (quickFilter === "final") return status === "final";
      return true;
    },
    [isCitoStudy, quickFilter, reportStatusMap]
  );

  return (
    <>
      <Worklist
      title="Reporting"
      headerContent={
        <div className="technologist-command-header relative overflow-hidden px-6 pt-5 pb-3 text-white">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(56,189,248,0.12),transparent_30%)]" />
          <div className="relative flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-black tracking-tight text-white md:text-4xl">Reporting</h1>
            </div>
          </div>
          <div className="relative mt-5 grid grid-cols-5 gap-1.5 sm:gap-3">
            <CommandMetric
              label="Pending"
              compactLabel="PEND"
              value={reportingStats.pending}
              tone="cyan"
              icon={<Clock3 className="h-4 w-4" />}
              active={quickFilter === "pending"}
              onClick={() => toggleQuickFilter("pending")}
            />
            <CommandMetric
              label="Draft"
              compactLabel="DRAFT"
              value={reportingStats.draft}
              tone="amber"
              icon={<Edit3 className="h-4 w-4" />}
              active={quickFilter === "draft"}
              onClick={() => toggleQuickFilter("draft")}
            />
            <CommandMetric
              label="CITO"
              compactLabel="CITO"
              value={reportingStats.citoProgress}
              tone="red"
              icon={<AlertTriangle className="h-4 w-4" />}
              active={quickFilter === "cito"}
              onClick={() => toggleQuickFilter("cito")}
            />
            <CommandMetric
              label="Final"
              compactLabel="FINAL"
              value={reportingStats.final}
              tone="emerald"
              icon={<CheckCircle2 className="h-4 w-4" />}
              active={quickFilter === "final"}
              onClick={() => toggleQuickFilter("final")}
            />
            <CommandMetric
              label="Total Study"
              compactLabel="TOTAL"
              value={reportingStats.total}
              tone="cyan"
              icon={<Activity className="h-4 w-4" />}
              active={quickFilter === null}
              onClick={() => setQuickFilter(null)}
            />
          </div>
        </div>
      }
      storageKey="reporting"
      defaultColumnOrder={[
        "statusTrack",
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
        "studyDate",
        "status",
      ]}
      extraColumns={extraColumns}
      onDataLoaded={handleDataLoaded}
      filterActions={
        <div className="page-toolbar">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showAll ? "default" : "outline"}
                size="icon"
                className="rounded-xl h-9 w-9"
                onClick={() => setShowAll(prev => !prev)}
                disabled={quickFilter !== null}
                aria-label="Filter studi"
              >
                <Filter className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {quickFilter !== null ? "Disabled while a summary card filter is active" : showAll ? "Show all" : "Pending reports only"}
            </TooltipContent>
          </Tooltip>

          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="rounded-xl h-9 gap-2 px-3"
                    aria-label="Date filter"
                  >
                    <CalendarDays className="w-4 h-4" />
                    <span className="max-w-[180px] truncate text-xs">{activeDateFilterLabel}</span>
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Date filter</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-72 p-3" align="end">
              <div className="space-y-3">
                <RadioGroup value={datePreset} onValueChange={value => setDatePreset(value as DatePreset)} className="grid gap-2">
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="today" id="radio-date-today" /><span>Today</span></label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="yesterday" id="radio-date-yesterday" /><span>Yesterday</span></label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="7days" id="radio-date-7days" /><span>7 days ago</span></label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="1month" id="radio-date-1month" /><span>1 Month</span></label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="2months" id="radio-date-2months" /><span>2 Month</span></label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="range" id="radio-date-range" /><span>Custom range</span></label>
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
        </div>
      }
      rowFilter={(row, context) => {
        if (risOrdersLoading || !isRisOrderStudy(row)) return false;
        if (!isReadyForReporting(row)) return false;
        if (!user?.username || assignmentLoading) return false;
        const uid = row.studyInstanceUid || row.id;
        if (!context?.search?.trim() && !isRowInPreset(row, datePreset, fromDate, toDateValue)) return false;
        if (!radiologistCompetitionEnabled && !assignedStudyUids.has(uid)) return false;
        if (quickFilter !== null) return matchesQuickFilter(row);
        if (showAll) return true;
        return reportStatusMap[uid] !== "final";
      }}
      prioritySort={row => (isCitoStudy(row) ? 1 : 0)}
      rowClassName={row => (isCitoStudy(row) ? "technologist-cito-row" : "")}
      surfaceClassName="technologist-command-surface"
      tableCardClassName="technologist-worklist-shell border-0 bg-transparent p-0 shadow-none overflow-visible"
      toolbarClassName="technologist-worklist-toolbar"
      tableHeaderClassName="radiology-tech-table-header"
      tableFilterHeaderClassName="radiology-tech-filter-header"
      tableFilterInputClassName="radiology-tech-filter-input"
      disablePagination
      hideEmptyState
      enableDetailDialog={false}
      enableMwlReconcile={false}
      scheduledOrderStatuses={REPORTING_SCHEDULED_ORDER_STATUSES}
      dateFilterPlacement="page"
      dateMode={datePreset}
      onDateModeChange={(mode) => setDatePreset(mode as DatePreset)}
      rangeFrom={fromDate}
      rangeTo={toDateValue}
      onRangeFromChange={setFromDate}
      onRangeToChange={setToDateValue}
      onOpenStudy={row => {
        const studyInstanceUid = String(row.studyInstanceUid || "").trim();
        if (!studyInstanceUid) return;
        if (!radiologistCompetitionEnabled || !user?.username) {
          navigate(`/reporting/report/${encodeURIComponent(studyInstanceUid)}`);
          return;
        }
        const assignment = assignmentMap[studyInstanceUid];
        const assignedUsername = String(assignment?.radiologist_username || "").trim().toLowerCase();
        if (!assignedUsername || assignedUsername === user.username.toLowerCase()) {
          navigate(`/reporting/report/${encodeURIComponent(studyInstanceUid)}`);
          return;
        }
        setTakeoverStudy(row);
      }}
      />
      <AlertDialog
        open={Boolean(takeoverStudy)}
        onOpenChange={open => !open && !takeoverSaving && setTakeoverStudy(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reassign reporting?</AlertDialogTitle>
            <AlertDialogDescription>
              This study is currently assigned to{" "}
              <span className="font-medium text-foreground">
                {assignmentMap[takeoverStudy?.studyInstanceUid || ""]?.radiologist_name ||
                  assignmentMap[takeoverStudy?.studyInstanceUid || ""]?.radiologist_username ||
                  "another reporting user"}
              </span>
              . If you continue opening this study, reporting responsibility will
              be reassigned to your account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={takeoverSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={takeoverSaving}
              onClick={event => {
                event.preventDefault();
                handleConfirmTakeover();
              }}
            >
              {takeoverSaving ? "Reassigning..." : "Yes, reassign to me"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default RadiologistWorklist;
