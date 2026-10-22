import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import Worklist from "@/pages/Worklist";
import type { WorklistItem } from "@/data/mockData";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { dicomWebService, doseService, MwlDoctor, MwlOrder, mwlService, qualityControlService, radiologyReportService } from "@/lib/dicomService";
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  DatabaseZap,
  Loader2,
  Radiation,
  Save,
  ShieldCheck,
  Stethoscope,
} from "lucide-react";
import { doseFieldMap, type DoseModality, type DoseRecord, type DoseStudy } from "./doseMock";

type ReportStatus = "draft" | "final" | "";
type DatePreset = "today" | "yesterday" | "7days" | "30days" | "1month" | "2months" | "range";
type DoseQuickFilter = "pendingDose" | "captured" | "total" | null;

const supportedDoseModalities = Object.keys(doseFieldMap) as DoseModality[];

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

const StatusTrackIcon = ({ label, tone, icon }: { label: string; tone: "idle" | "active" | "done"; icon: ReactNode }) => (
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

const orderToWorklistStatus = (status: MwlOrder["status"]): WorklistItem["status"] => {
  if (status === "COMPLETED") return "completed";
  return "scheduled";
};

const toDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toDicomDateLocal = (value?: string | null): string => {
  if (!value) return "";
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return text;
  const ymd = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
  if (ymd) return `${ymd[1]}${ymd[2]}${ymd[3]}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return `${parsed.getFullYear()}${String(parsed.getMonth() + 1).padStart(2, "0")}${String(parsed.getDate()).padStart(2, "0")}`;
};

const formatRegisterDate = (value?: string | null): string => {
  const parsed = toDate(value);
  if (!parsed) return "-";
  return parsed.toLocaleString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

const isOrderInPreset = (order: MwlOrder, preset: DatePreset, fromDate: string, toDateValue: string): boolean => {
  const date = toDate(order.study_date || order.tanggal_aktivasi || order.tanggal_order || order.created_at);
  if (!date) return false;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const today = new Date();
  const todayStart = startOf(today);
  const dateOnly = startOf(date);
  if (preset === "today") return dateOnly.getTime() === todayStart.getTime();
  if (preset === "yesterday") {
    const y = new Date(todayStart);
    y.setDate(y.getDate() - 1);
    return dateOnly.getTime() === y.getTime();
  }
  if (preset === "7days" || preset === "30days") {
    const days = preset === "7days" ? 7 : 30;
    const deltaDays = (todayStart.getTime() - dateOnly.getTime()) / (1000 * 60 * 60 * 24);
    return deltaDays >= 0 && deltaDays <= days;
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
  if (preset === "30days") return "Last 30 Days";
  if (preset === "1month") return "Last 1 Month";
  if (preset === "2months") return "Last 2 Months";
  if (fromDate && toDateValue) return `Custom: ${fromDate} - ${toDateValue}`;
  if (fromDate) return `Custom: from ${fromDate}`;
  if (toDateValue) return `Custom: until ${toDateValue}`;
  return "Custom Range";
};

const normalizeDoseModality = (value?: string | null): DoseModality => {
  const normalized = String(value || "").trim().toUpperCase() as DoseModality;
  return supportedDoseModalities.includes(normalized) ? normalized : "DX";
};

const isDoseMonitorOrder = (order: MwlOrder) => String(order.modality || "").trim().toUpperCase() !== "US";
const NO_DOSE_STAFF_VALUE = "__none__";

const orderToDoseStudy = (order: MwlOrder): DoseStudy => ({
  id: String(order.id),
  patientId: order.no_rm || "",
  patientName: order.nama_pasien || "",
  accessionNumber: order.accession_number || "",
  modalityCode: normalizeDoseModality(order.modality),
  studyDescription: order.procedure_desc || "",
  studyDate: toDicomDateLocal(order.study_date),
  studyTime: String(order.study_time || ""),
  sex: order.kelamin === "F" ? "F" : "M",
  birthDate: toDicomDateLocal(order.tanggal_lahir),
  cito: isCitoOrder(order.cito),
  radiologist: order.radiologist_doctor_name || "",
  technologist: order.technologist_name || order.technologist_username || order.nama_radiolog || "",
  room: order.modality_station_room || "",
  aeTitle: order.modality_station_ae || order.modality_station_aet_master || "",
  studyInstanceUid: order.actual_study_instance_uid || order.study_instance_uid || "",
});

const DoseMonitorPage = () => {
  const { toast } = useToast();
  const { user } = useAuth();
  const [orders, setOrders] = useState<MwlOrder[]>([]);
  const [fismedStaff, setFismedStaff] = useState<MwlDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [reportStatusMap, setReportStatusMap] = useState<Record<string, ReportStatus>>({});
  const [qcStatusMap, setQcStatusMap] = useState<Record<string, { processed_at?: string | null }>>({});
  const [quickFilter, setQuickFilter] = useState<DoseQuickFilter>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDateValue, setToDateValue] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<MwlOrder | null>(null);
  const [doseValues, setDoseValues] = useState<Record<string, string>>({});
  const [selectedMedicalPhysicistId, setSelectedMedicalPhysicistId] = useState(NO_DOSE_STAFF_VALUE);
  const [captureMode, setCaptureMode] = useState<"auto" | "manual">("manual");
  const [records, setRecords] = useState<DoseRecord[]>([]);
  const [extractingDose, setExtractingDose] = useState(false);

  const savedMap = useMemo(() => new Map(records.map(record => [record.id, record])), [records]);

  const getDefaultMedicalPhysicistId = useCallback((existing?: DoseRecord) => {
    const existingName = existing?.medicalPhysicist?.trim().toLowerCase();
    if (existingName) {
      const matchedExisting = fismedStaff.find(staff => staff.nama_dokter.trim().toLowerCase() === existingName);
      if (matchedExisting) return String(matchedExisting.id);
    }
    const username = user?.username?.trim().toLowerCase();
    const fullName = user?.fullName?.trim().toLowerCase();
    const matchedUser = fismedStaff.find(staff => {
      const linkedUsername = staff.linked_username?.trim().toLowerCase();
      const linkedName = staff.linked_user_name?.trim().toLowerCase();
      const staffName = staff.nama_dokter.trim().toLowerCase();
      return Boolean((username && linkedUsername === username) || (fullName && (linkedName === fullName || staffName === fullName)));
    });
    return matchedUser ? String(matchedUser.id) : NO_DOSE_STAFF_VALUE;
  }, [fismedStaff, user?.fullName, user?.username]);

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!silent) setLoading(true);
    try {
      const [orderRows, doseRows] = await Promise.all([
        mwlService.fetchOrders({ status: "ALL" }),
        doseService.fetchReports(),
      ]);
      setRecords(doseRows as DoseRecord[]);
      const studyUids = Array.from(new Set(orderRows.map(row => row.actual_study_instance_uid || row.study_instance_uid || "").filter(Boolean)));
      if (studyUids.length > 0) {
        const [reportStatuses, qcStatuses] = await Promise.all([
          radiologyReportService.fetchStatuses(studyUids),
          qualityControlService.fetchStatuses(studyUids),
        ]);
        const nextReport: Record<string, ReportStatus> = {};
        reportStatuses.forEach(item => {
          if (item.study_instance_uid) nextReport[item.study_instance_uid] = item.status;
        });
        const nextQc: Record<string, { processed_at?: string | null }> = {};
        qcStatuses.forEach(item => {
          if (item.study_instance_uid) nextQc[item.study_instance_uid] = { processed_at: item.processed_at ?? null };
        });
        setReportStatusMap(nextReport);
        setQcStatusMap(nextQc);
      } else {
        setReportStatusMap({});
        setQcStatusMap({});
      }
      setOrders(orderRows);
    } catch (error) {
      toast({ title: "Failed to load MWL data", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  const loadFismedStaff = useCallback(async () => {
    try {
      const rows = await mwlService.fetchDoctors({ role: "FISMED" });
      setFismedStaff(rows);
    } catch (error) {
      toast({ title: "Failed to load FISMED staff", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => {
    loadData();
    loadFismedStaff();
  }, [loadData, loadFismedStaff]);

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
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(() => {
      loadData({ silent: true });
    }, 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, loadData]);

  const orderMap = useMemo(() => {
    const map = new Map<string, MwlOrder>();
    orders.forEach(order => map.set(String(order.id), order));
    return map;
  }, [orders]);

  const mappedRows = useMemo<WorklistItem[]>(() => {
    return orders.filter(isDoseMonitorOrder).map(order => ({
      id: String(order.id),
      patientId: order.no_rm || "",
      patientName: order.nama_pasien || "",
      accessionNumber: order.accession_number || "",
      modalityCode: order.modality || "",
      studyDescription: order.procedure_desc || "",
      imageCount: 0,
      seriesCount: 0,
      referringPhysician: order.referring_doctor_name || order.referring_physician || "",
      studyDate: toDicomDateLocal(order.study_date),
      birthDate: toDicomDateLocal(order.tanggal_lahir),
      studyTime: String(order.study_time || ""),
      sex: (order.kelamin || "O") as "M" | "F" | "O",
      studyInstanceUid: order.actual_study_instance_uid || order.study_instance_uid || "",
      status: orderToWorklistStatus(order.status),
      cito: order.cito || "",
    }));
  }, [orders]);

  const openDoseDialog = useCallback((order: MwlOrder) => {
    const existing = savedMap.get(String(order.id));
    setSelectedOrder(order);
    setDoseValues(existing?.values || {});
    setSelectedMedicalPhysicistId(getDefaultMedicalPhysicistId(existing));
    setCaptureMode(existing?.captureMode || "manual");
  }, [getDefaultMedicalPhysicistId, savedMap]);

  const handleGetDose = async () => {
    if (!selectedOrder) return;
    const studyInstanceUid = selectedOrder.actual_study_instance_uid || selectedOrder.study_instance_uid || "";
    if (!studyInstanceUid) {
      toast({ title: "Get Dose failed", description: "StudyInstanceUID is missing for this order.", variant: "destructive" });
      return;
    }
    setExtractingDose(true);
    setCaptureMode("auto");
    try {
      const result = await doseService.getDose(studyInstanceUid);
      const nextValues = Object.fromEntries(
        Object.entries(result.values || {}).filter(([, value]) => String(value ?? "").trim() !== "")
      );
      setDoseValues(prev => ({ ...prev, ...nextValues }));
      toast({
        title: "Dose extracted",
        description: result.source?.note || `${result.source?.seriesDescription || "Dose Report"} parsed from DICOM. Review values before saving.`,
      });
    } catch (error) {
      toast({ title: "Get Dose failed", description: error instanceof Error ? error.message : "Unable to extract DICOM dose report.", variant: "destructive" });
    } finally {
      setExtractingDose(false);
    }
  };

  const saveDose = async () => {
    if (!selectedOrder) return;
    const doseStudy = orderToDoseStudy(selectedOrder);
    const selectedMedicalPhysicist = fismedStaff.find(staff => String(staff.id) === selectedMedicalPhysicistId);
    const nextRecord: DoseRecord = {
      ...doseStudy,
      medicalPhysicist: selectedMedicalPhysicist?.nama_dokter || "",
      values: doseValues,
      captureMode,
      savedAt: new Date().toISOString(),
    };
    try {
      const saved = await doseService.saveReport(nextRecord);
      const next = [saved as DoseRecord, ...records.filter(record => record.id !== doseStudy.id)];
      setRecords(next);
      setSelectedOrder(null);
      toast({ title: "Dose saved", description: `${doseStudy.patientName || doseStudy.accessionNumber} dose data is now available in Dose Report.` });
    } catch (error) {
      toast({ title: "Failed to save dose", description: error instanceof Error ? error.message : "Something went wrong", variant: "destructive" });
    }
  };

  const extraColumns = useMemo(() => {
    return [
      {
        key: "statusTrack",
        label: "Status Track",
        width: 235,
        getValue: (row: WorklistItem) => `${row.id} ${isCitoOrder(row.cito) ? "CITO" : ""}`,
        renderCell: (row: WorklistItem) => {
          const order = orderMap.get(row.id);
          if (!order) return null;
          const studyUid = order.actual_study_instance_uid || order.study_instance_uid || "";
          const reportStatus = studyUid ? reportStatusMap[studyUid] || "" : "";
          const qcChecked = Boolean(studyUid && qcStatusMap[studyUid]?.processed_at);
          const doseCaptured = savedMap.has(row.id);
          const technologistTone: "idle" | "active" | "done" = order.status === "COMPLETED" ? "done" : order.status === "SENT_TO_MWL" ? "active" : "idle";
          const radiologistTone: "idle" | "active" | "done" = reportStatus === "final" ? "done" : reportStatus === "draft" ? "active" : "idle";
          const qcTone: "idle" | "active" | "done" = qcChecked ? "done" : "idle";
          return (
            <div className="inline-flex items-center overflow-hidden rounded-md border border-slate-300/70 bg-slate-100/90 shadow-sm whitespace-nowrap dark:border-slate-700/70 dark:bg-slate-900/80">
              <StatusTrackIcon label="Technologist" tone={technologistTone} icon={<Radiation className="h-4 w-4" />} />
              <StatusTrackIcon label="Dose" tone={doseCaptured ? "done" : order.status === "COMPLETED" ? "active" : "idle"} icon={<ShieldCheck className="h-4 w-4" />} />
              <StatusTrackIcon label="Reporting" tone={radiologistTone} icon={<Stethoscope className="h-4 w-4" />} />
              <StatusTrackIcon label="Distribution" tone={qcTone} icon={<ClipboardCheck className="h-4 w-4" />} />
            </div>
          );
        },
      },
      {
        key: "sendAction",
        label: "Action",
        width: 124,
        getValue: () => "",
        renderCell: (row: WorklistItem) => {
          const order = orderMap.get(row.id);
          if (!order) return null;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={event => { event.stopPropagation(); openDoseDialog(order); }}>
                  <DatabaseZap className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Get Dose</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        key: "registerDate",
        label: "Register Date",
        width: 170,
        getValue: (row: WorklistItem) => orderMap.get(row.id)?.order_in_tanggal_aktivasi || orderMap.get(row.id)?.tanggal_aktivasi || "",
        renderCell: (row: WorklistItem) => <span>{formatRegisterDate(orderMap.get(row.id)?.order_in_tanggal_aktivasi || orderMap.get(row.id)?.tanggal_aktivasi)}</span>,
      },
      {
        key: "radiologistName",
        label: "Radiology Doctor",
        width: 180,
        getValue: (row: WorklistItem) => orderMap.get(row.id)?.radiologist_doctor_name || "",
        renderCell: (row: WorklistItem) => <span>{orderMap.get(row.id)?.radiologist_doctor_name || "-"}</span>,
      },
      {
        key: "technologistName",
        label: "MWL Staff",
        width: 220,
        getValue: (row: WorklistItem) => orderMap.get(row.id)?.assigned_staff_json || orderMap.get(row.id)?.technologist_name || "",
        renderCell: (row: WorklistItem) => {
          const order = orderMap.get(row.id);
          if (!order) return <span>-</span>;
          try {
            const assigned = order.assigned_staff_json ? JSON.parse(order.assigned_staff_json) : [];
            const names = Array.isArray(assigned) ? assigned.map((item: { nama_dokter?: string } | null) => item?.nama_dokter).filter((value: string | undefined): value is string => Boolean(value)) : [];
            if (names.length > 0) return <span>{names.join(", ")}</span>;
          } catch {
            // Ignore malformed legacy staff payloads.
          }
          return <span>{order.technologist_name || order.technologist_username || order.nama_radiolog || "-"}</span>;
        },
      },
      {
        key: "modalityRoom",
        label: "Modality Room",
        width: 150,
        getValue: (row: WorklistItem) => orderMap.get(row.id)?.modality_station_room || "",
        renderCell: (row: WorklistItem) => <span>{orderMap.get(row.id)?.modality_station_room || "-"}</span>,
      },
      {
        key: "aeTitle",
        label: "AE Title",
        width: 150,
        getValue: (row: WorklistItem) => orderMap.get(row.id)?.modality_station_ae || orderMap.get(row.id)?.modality_station_aet_master || "",
        renderCell: (row: WorklistItem) => <span>{orderMap.get(row.id)?.modality_station_ae || orderMap.get(row.id)?.modality_station_aet_master || "-"}</span>,
      },
    ];
  }, [openDoseDialog, orderMap, qcStatusMap, reportStatusMap, savedMap]);

  const matchesQuickFilter = useCallback((order: MwlOrder) => {
    const record = savedMap.get(String(order.id));
    if (quickFilter === "pendingDose") return !record;
    if (quickFilter === "captured") return Boolean(record);
    if (quickFilter === "total") return true;
    return true;
  }, [quickFilter, savedMap]);

  const rowFilter = useCallback((row: WorklistItem, context?: { search: string }) => {
    const order = orderMap.get(row.id);
    if (!order) return false;
    if (order.status === "CANCELLED") return false;
    if (context?.search?.trim()) return quickFilter !== null ? matchesQuickFilter(order) : true;
    if (!isOrderInPreset(order, datePreset, fromDate, toDateValue)) return false;
    if (quickFilter !== null) return matchesQuickFilter(order);
    return true;
  }, [datePreset, fromDate, matchesQuickFilter, orderMap, quickFilter, toDateValue]);

  const commandStats = useMemo(() => {
    const activeOrders = orders.filter(order => isDoseMonitorOrder(order) && order.status !== "CANCELLED" && isOrderInPreset(order, datePreset, fromDate, toDateValue));
    const capturedCount = activeOrders.filter(order => savedMap.has(String(order.id))).length;
    return {
      pendingDose: activeOrders.filter(order => !savedMap.has(String(order.id))).length,
      captured: capturedCount,
      total: activeOrders.length,
      progress: `${capturedCount}/${activeOrders.length}`,
    };
  }, [datePreset, fromDate, orders, savedMap, toDateValue]);

  const toggleQuickFilter = (next: Exclude<DoseQuickFilter, null>) => setQuickFilter(current => (current === next ? null : next));
  const activeDateFilterLabel = useMemo(() => formatActiveDateFilterLabel(datePreset, fromDate, toDateValue), [datePreset, fromDate, toDateValue]);

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
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="today" id="dose-date-today" /><span>Today</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="yesterday" id="dose-date-yesterday" /><span>Yesterday</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="7days" id="dose-date-7days" /><span>Last 7 days</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="30days" id="dose-date-30days" /><span>Last 30 days</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="1month" id="dose-date-1month" /><span>Last 1 month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="2months" id="dose-date-2months" /><span>Last 2 months</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="range" id="dose-date-range" /><span>Custom range</span></label>
            </RadioGroup>
            {datePreset === "range" && (
              <div className="space-y-2">
                <div className="grid grid-cols-[auto,1fr] items-center gap-2"><span className="text-[11px] text-muted-foreground">From</span><Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8 rounded-md text-[11px]" /></div>
                <div className="grid grid-cols-[auto,1fr] items-center gap-2"><span className="text-[11px] text-muted-foreground">To</span><Input type="date" value={toDateValue} onChange={e => setToDateValue(e.target.value)} className="h-8 rounded-md text-[11px]" /></div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );

  const selectedDoseStudy = selectedOrder ? orderToDoseStudy(selectedOrder) : null;
  const selectedFields = selectedDoseStudy ? doseFieldMap[selectedDoseStudy.modalityCode] : [];

  return (
    <>
      <Worklist
        title="Dose Monitor"
        headerContent={
          <div className="technologist-command-header relative overflow-hidden px-6 pt-5 pb-3 text-white">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(56,189,248,0.12),transparent_30%)]" />
            <div className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(148,163,184,.22)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.18)_1px,transparent_1px)] [background-size:34px_34px]" />
            <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-3xl">
                <h1 className="text-3xl font-black tracking-tight text-white md:text-4xl">Dose Monitor</h1>
              </div>
            </div>
            <div className="relative mt-5 grid grid-cols-3 gap-1.5 sm:gap-3">
              <CommandMetric label="Pending" compactLabel="PEND" value={commandStats.pendingDose} tone="amber" icon={<Clock3 className="h-4 w-4" />} active={quickFilter === "pendingDose"} onClick={() => toggleQuickFilter("pendingDose")} />
              <CommandMetric label="Finished" compactLabel="DONE" value={commandStats.captured} tone="emerald" icon={<CheckCircle2 className="h-4 w-4" />} active={quickFilter === "captured"} onClick={() => toggleQuickFilter("captured")} />
              <CommandMetric label="Total" compactLabel="TOTAL" value={commandStats.progress} tone="cyan" icon={<Activity className="h-4 w-4" />} active={quickFilter === "total"} onClick={() => toggleQuickFilter("total")} />
            </div>
          </div>
        }
        storageKey="dose-monitor-v1"
        externalRows={mappedRows}
        externalLoading={loading}
        rowFilter={rowFilter}
        prioritySort={row => (isCitoOrder(row.cito) ? 1 : 0)}
        rowClassName={row => (isCitoOrder(row.cito) ? "technologist-cito-row" : "")}
        filterActions={filterActions}
        dateFilterPlacement="page"
        dateMode={datePreset}
        onDateModeChange={(mode) => setDatePreset(mode as DatePreset)}
        rangeFrom={fromDate}
        rangeTo={toDateValue}
        onRangeFromChange={setFromDate}
        onRangeToChange={setToDateValue}
        surfaceClassName="technologist-command-surface dose-monitor-flush"
        tableCardClassName="technologist-worklist-shell border-0 bg-transparent p-0 shadow-none overflow-visible"
        toolbarClassName="technologist-worklist-toolbar"
        tableHeaderClassName="radiology-tech-table-header"
        tableFilterHeaderClassName="radiology-tech-filter-header"
        tableFilterInputClassName="radiology-tech-filter-input"
        disablePagination
        hideEmptyState
        enableDetailDialog={false}
        strictDefaultColumnOrder
        disableRowSelection
        lockedColumns={["statusTrack", "sendAction"]}
        defaultColumnOrder={["statusTrack", "sendAction", "registerDate", "accessionNumber", "patientId", "patientName", "studyDescription", "modalityCode", "referringPhysician", "radiologistName", "studyDate", "technologistName", "modalityRoom", "aeTitle"]}
        defaultVisibleColumns={["statusTrack", "sendAction", "registerDate", "accessionNumber", "patientId", "patientName", "studyDescription", "modalityCode", "referringPhysician", "radiologistName", "technologistName", "modalityRoom", "aeTitle"]}
        extraColumns={extraColumns}
      />

      <Dialog open={Boolean(selectedOrder)} onOpenChange={open => !open && setSelectedOrder(null)}>
        <DialogContent className="max-w-4xl border-0 bg-transparent p-0 shadow-none">
          {selectedDoseStudy && (
            <div className="overflow-hidden rounded-3xl border border-slate-700/60 bg-slate-950 text-white shadow-2xl">
              <DialogHeader className="border-b border-white/10 px-6 py-5">
                <DialogTitle className="flex items-center gap-2 text-xl font-black"><DatabaseZap className="h-5 w-5 text-sky-300" />Dose Capture</DialogTitle>
                <div className="text-sm text-slate-300">{selectedDoseStudy.patientName} - {selectedDoseStudy.accessionNumber} - {selectedOrder?.modality || "-"}</div>
              </DialogHeader>
              <div className="grid gap-3 p-6 sm:grid-cols-2 lg:grid-cols-3">
                {selectedFields.map(field => (
                  <div key={field.key} className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-[0.16em] text-slate-300">{field.label}{field.unit ? ` (${field.unit})` : ""}</Label>
                    <Input value={doseValues[field.key] || ""} onChange={event => setDoseValues(prev => ({ ...prev, [field.key]: event.target.value }))} className="h-11 rounded-xl border-white/10 bg-white/10 text-white" />
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-4 border-t border-white/10 px-6 py-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="w-full space-y-2 sm:max-w-xs">
                  <Label className="text-xs font-bold uppercase tracking-[0.16em] text-slate-300">Medical Physicist</Label>
                  <Select value={selectedMedicalPhysicistId} onValueChange={setSelectedMedicalPhysicistId}>
                    <SelectTrigger className="h-11 rounded-xl border-white/10 bg-white/10 text-white">
                      <SelectValue placeholder="Select a medical physicist" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_DOSE_STAFF_VALUE}>Not selected</SelectItem>
                      {fismedStaff.map(staff => (
                        <SelectItem key={staff.id} value={String(staff.id)}>{staff.nama_dokter}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" className="rounded-xl bg-cyan-500 text-white hover:bg-cyan-400" onClick={handleGetDose} disabled={extractingDose}>
                    {extractingDose ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DatabaseZap className="mr-2 h-4 w-4" />}Get Dose
                  </Button>
                  <Button className="rounded-xl bg-sky-500 text-white hover:bg-sky-400" onClick={saveDose}><Save className="mr-2 h-4 w-4" />Save Dose</Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default DoseMonitorPage;
