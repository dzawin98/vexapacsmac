import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CalendarDays, CheckCircle2, ClipboardCheck, Clock3, Edit3, Radiation, Stethoscope } from "lucide-react";
import Worklist from "./Worklist";
import StudyDetailDialog from "@/components/StudyDetailDialog";
import type { WorklistItem } from "@/data/mockData";
import { mwlService, orderOutViewerLinkService, qualityControlService, radiologyReportService } from "@/lib/dicomService";
import { useToast } from "@/hooks/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";

type ReportStatus = "draft" | "final" | "";
type DatePreset = "today" | "yesterday" | "7days" | "1month" | "2months" | "range";
type DistributionQuickFilter = "ready" | "draft" | "cito" | "distributed" | "total" | null;

const trackToneClass = (tone: "idle" | "active" | "done") => {
  if (tone === "done") return "bg-emerald-600/90 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] dark:bg-emerald-500/55 dark:text-emerald-50";
  if (tone === "active") return "bg-amber-500/85 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] dark:bg-amber-500/45 dark:text-amber-50";
  return "bg-transparent text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-700/50";
};

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

const isCitoOrder = (value?: string | boolean | null) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toUpperCase();
  return ["1", "Y", "YES", "TRUE", "S", "E", "CITO", "EMERGENCY"].includes(normalized);
};

const CitoIndicator = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <div
        aria-label="CITO / Emergency patient"
        className="cito-breath-indicator h-3.5 w-3.5 rounded-full border-2 border-white bg-red-500 shadow-sm ring-2 ring-red-100 dark:border-slate-950 dark:ring-red-950"
      />
    </TooltipTrigger>
    <TooltipContent>CITO / Emergency patient</TooltipContent>
  </Tooltip>
);

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

const normalizeMatchKey = (value?: string | null) => String(value || "").trim().toLowerCase();
const DISTRIBUTION_SCHEDULED_ORDER_STATUSES: Array<"SENT_TO_MWL" | "COMPLETED"> = ["SENT_TO_MWL", "COMPLETED"];

const QualityControl = () => {
  const { toast } = useToast();
  const [reportStatusMap, setReportStatusMap] = useState<Record<string, ReportStatus>>({});
  const [qcStatusMap, setQcStatusMap] = useState<
    Record<string, { processed_by?: string | null; processed_at?: string | null }>
  >({});
  const [detailItem, setDetailItem] = useState<WorklistItem | null>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDateValue, setToDateValue] = useState("");
  const [quickFilter, setQuickFilter] = useState<DistributionQuickFilter>(null);
  const [loadedRows, setLoadedRows] = useState<WorklistItem[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [risOrderKeys, setRisOrderKeys] = useState<Set<string>>(new Set());
  const [citoOrderKeys, setCitoOrderKeys] = useState<Set<string>>(new Set());
  const [risOrdersLoading, setRisOrdersLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const loadRisOrderKeys = async () => {
      setRisOrdersLoading(true);
      try {
        const orders = await mwlService.fetchOrders({ status: "ALL", limit: 1000 });
        if (cancelled) return;
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
        if (!cancelled) {
          setRisOrderKeys(new Set());
          setCitoOrderKeys(new Set());
          toast({
            title: "Failed to load RIS orders",
            description: error instanceof Error ? error.message : "Distribution will hide non-order studies.",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setRisOrdersLoading(false);
      }
    };
    loadRisOrderKeys();
    return () => {
      cancelled = true;
    };
  }, [toast]);

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

  const handleDataLoaded = useCallback(
    async (rows: WorklistItem[]) => {
      setLoadedRows(rows);
      const studyUids = Array.from(
        new Set(rows.map(row => row.studyInstanceUid).filter(Boolean))
      );
      if (studyUids.length === 0) {
        setReportStatusMap({});
        setQcStatusMap({});
        return;
      }
      try {
        const [reportStatuses, qcStatuses] = await Promise.all([
          radiologyReportService.fetchStatuses(studyUids),
          qualityControlService.fetchStatuses(studyUids),
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load QC status";
        toast({
          title: "Failed to load status",
          description: message,
          variant: "destructive",
        });
      }
    },
    [toast]
  );

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
          const image = (row.imageCount ?? 0) > 0 ? "image" : "";
          const cito = isCitoStudy(row) ? "CITO" : "";
          return [image, reportStatus, checked, cito].filter(Boolean).join(" ");
        },
        renderCell: (row: WorklistItem) => {
          const key = row.studyInstanceUid || row.id;
          const hasImages = (row.imageCount ?? 0) > 0;
          const hasScheduledPlaceholder = row.status === "scheduled" && !hasImages;
          const reportStatus = reportStatusMap[key] || "";
          const checked = Boolean(qcStatusMap[key]?.processed_at);
          const technologistTone: "idle" | "active" | "done" = hasImages ? "done" : hasScheduledPlaceholder ? "active" : "idle";
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

  const distributionStats = useMemo(() => {
    const distributionRows = loadedRows.filter(row => {
      if (risOrdersLoading || !isRisOrderStudy(row)) return false;
      return isRowInPreset(row, datePreset, fromDate, toDateValue);
    });
    const citoRows = distributionRows.filter(row => isCitoStudy(row));
    const distributedRows = distributionRows.filter(row => Boolean(qcStatusMap[row.studyInstanceUid || row.id]?.processed_at));
    const finalRows = distributionRows.filter(row => reportStatusMap[row.studyInstanceUid || row.id] === "final");
    const draftRows = distributionRows.filter(row => reportStatusMap[row.studyInstanceUid || row.id] === "draft");
    const readyRows = finalRows.filter(row => !qcStatusMap[row.studyInstanceUid || row.id]?.processed_at);
    const distributedCitoRows = citoRows.filter(row => Boolean(qcStatusMap[row.studyInstanceUid || row.id]?.processed_at));

    return {
      ready: readyRows.length,
      draft: draftRows.length,
      distributed: distributedRows.length,
      citoProgress: `${distributedCitoRows.length}/${citoRows.length}`,
      total: distributionRows.length,
    };
  }, [
    datePreset,
    fromDate,
    isCitoStudy,
    isRisOrderStudy,
    loadedRows,
    qcStatusMap,
    reportStatusMap,
    risOrdersLoading,
    toDateValue,
  ]);

  const toggleQuickFilter = (next: Exclude<DistributionQuickFilter, null>) => {
    setQuickFilter(current => (current === next ? null : next));
  };

  const matchesQuickFilter = useCallback(
    (row: WorklistItem) => {
      const uid = row.studyInstanceUid || row.id;
      const reportStatus = reportStatusMap[uid] || "";
      const distributed = Boolean(qcStatusMap[uid]?.processed_at);
      if (quickFilter === "ready") return reportStatus === "final" && !distributed;
      if (quickFilter === "draft") return reportStatus === "draft";
      if (quickFilter === "cito") return isCitoStudy(row);
      if (quickFilter === "distributed") return distributed;
      if (quickFilter === "total") return true;
      return true;
    },
    [isCitoStudy, qcStatusMap, quickFilter, reportStatusMap]
  );

  const handleRetrySelected = useCallback(
    async (rows: WorklistItem[]) => {
      const accessionNumbers = Array.from(
        new Set(
          rows
            .map(row => String(row.accessionNumber || "").trim())
            .filter(Boolean)
        )
      );

      if (accessionNumbers.length === 0) {
        toast({
          title: "No accession selected",
          description: "Selected studies do not have accession numbers yet.",
          variant: "destructive",
        });
        return;
      }

      setRetrying(true);
      try {
        const result = await orderOutViewerLinkService.retry(accessionNumbers);
        toast({
          title: "Retry completed",
          description: `${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed.`,
        });
      } catch (error) {
        toast({
          title: "Retry failed",
          description: error instanceof Error ? error.message : "Failed to retry order out viewer links.",
          variant: "destructive",
        });
      } finally {
        setRetrying(false);
      }
    },
    [toast]
  );

  const filterActions = (
    <div className="page-toolbar">
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="outline" className="rounded-xl h-9 gap-2 px-3" aria-label="Date filter">
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
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="today" id="qc-date-today" /><span>Today</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="yesterday" id="qc-date-yesterday" /><span>Yesterday</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="7days" id="qc-date-7days" /><span>7 days ago</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="1month" id="qc-date-1month" /><span>1 Month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="2months" id="qc-date-2months" /><span>2 Month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="range" id="qc-date-range" /><span>Custom range</span></label>
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
  );

  return (
    <>
      <Worklist
        title="Distribution"
        headerContent={
          <div className="technologist-command-header relative overflow-hidden px-6 pt-5 pb-3 text-white">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(56,189,248,0.12),transparent_30%)]" />
            <div className="relative flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-black tracking-tight text-white md:text-4xl">Distribution</h1>
              </div>
            </div>
            <div className="relative mt-5 grid grid-cols-5 gap-1.5 sm:gap-3">
              <CommandMetric label="Ready" compactLabel="READY" value={distributionStats.ready} tone="cyan" icon={<Clock3 className="h-4 w-4" />} active={quickFilter === "ready"} onClick={() => toggleQuickFilter("ready")} />
              <CommandMetric label="Draft" compactLabel="DRAFT" value={distributionStats.draft} tone="amber" icon={<Edit3 className="h-4 w-4" />} active={quickFilter === "draft"} onClick={() => toggleQuickFilter("draft")} />
              <CommandMetric label="CITO" compactLabel="CITO" value={distributionStats.citoProgress} tone="red" icon={<AlertTriangle className="h-4 w-4" />} active={quickFilter === "cito"} onClick={() => toggleQuickFilter("cito")} />
              <CommandMetric label="Distributed" compactLabel="DIST" value={distributionStats.distributed} tone="emerald" icon={<CheckCircle2 className="h-4 w-4" />} active={quickFilter === "distributed"} onClick={() => toggleQuickFilter("distributed")} />
              <CommandMetric label="Total Study" compactLabel="TOTAL" value={distributionStats.total} tone="cyan" icon={<Activity className="h-4 w-4" />} active={quickFilter === "total"} onClick={() => toggleQuickFilter("total")} />
            </div>
          </div>
        }
        storageKey="distribution"
        dateFilterPlacement="page"
        dateMode={datePreset}
        onDateModeChange={(mode) => setDatePreset(mode as DatePreset)}
        rangeFrom={fromDate}
        rangeTo={toDateValue}
        onRangeFromChange={setFromDate}
        onRangeToChange={setToDateValue}
        defaultColumnOrder={[
          "statusTrack",
          "patientId",
          "patientName",
          "radiologistName",
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
        enableRadiologistAssignment
        showRadiologistAction={false}
        onDataLoaded={handleDataLoaded}
        filterActions={filterActions}
        rowFilter={(row, context) => {
          if (risOrdersLoading || !isRisOrderStudy(row)) return false;
          if (context?.search?.trim()) return quickFilter !== null ? matchesQuickFilter(row) : true;
          if (!isRowInPreset(row, datePreset, fromDate, toDateValue)) return false;
          return quickFilter !== null ? matchesQuickFilter(row) : true;
        }}
        scheduledOrderStatuses={DISTRIBUTION_SCHEDULED_ORDER_STATUSES}
        enableDetailDialog={false}
        enableMwlReconcile={false}
        onOpenStudy={row => setDetailItem(row)}
        onProcessSelected={handleRetrySelected}
        processLabel={retrying ? "Retrying..." : "Retry"}
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
      />
      <StudyDetailDialog
        item={detailItem}
        onClose={() => setDetailItem(null)}
        hideActionButtons
        showShareButton
        showTimelineTab
      />
    </>
  );
};

export default QualityControl;
