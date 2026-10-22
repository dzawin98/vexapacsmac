import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import Worklist from "@/pages/Worklist";
import type { WorklistItem } from "@/data/mockData";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  MwlModalityStation,
  MwlOrder,
  MwlDoctor,
  dicomWebService,
  mwlService,
  qualityControlService,
  radiologyReportService,
  whatsappService,
} from "@/lib/dicomService";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Filter,
  Loader2,
  Radiation,
  Radio,
  Send,
  Stethoscope,
  MessageCircle,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ReportStatus = "draft" | "final" | "";
type DatePreset = "today" | "yesterday" | "7days" | "30days" | "1month" | "2months" | "range";
type TechnologistQuickFilter = "pending" | "scheduled" | "cito" | "completed" | "total" | null;

const DEFAULT_RADIOLOGIST_NOTIFICATION_TEMPLATE = [
  "Hello {{radiologist_name}},",
  "",
  "Please read the following study as soon as possible:",
  "Patient: {{patient_name}}",
  "MRN: {{patient_id}}",
  "Accession: {{accession_number}}",
  "Study: {{study_description}}",
  "Priority: {{priority}}",
  "",
  "Open the reporting page: {{reporting_link}}",
].join("\n");

const applyTextTemplate = (template: string, replacements: Record<string, string>) =>
  template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => replacements[key] ?? "");

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

const orderToWorklistStatus = (status: MwlOrder["status"]): WorklistItem["status"] => {
  if (status === "COMPLETED") return "completed";
  if (status === "SENT_TO_MWL") return "scheduled";
  return "scheduled";
};

const toDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
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
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

const formatRegisterDate = (value?: string | null): string => {
  const parsed = toDate(value);
  if (!parsed) return "-";
  return parsed.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatDetailDate = (value?: string | null): string => {
  const parsed = toDate(value);
  if (!parsed) return value || "-";
  return parsed.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
};

const displayValue = (value?: string | number | null): string => {
  if (value === null || typeof value === "undefined") return "-";
  const text = String(value).trim();
  return text || "-";
};

const getAssignedStaffNames = (order: MwlOrder): string => {
  try {
    const assigned = order.assigned_staff_json ? JSON.parse(order.assigned_staff_json) : [];
    const names = Array.isArray(assigned)
      ? assigned
        .map((item: { nama_dokter?: string } | null) => item?.nama_dokter)
        .filter((value: string | undefined): value is string => Boolean(value))
      : [];
    if (names.length > 0) return names.join(", ");
  } catch {
    // Keep the fallback below when legacy payload is not valid JSON.
  }
  return order.technologist_name || order.technologist_username || order.nama_radiolog || "-";
};

const DetailField = ({ label, value, className }: { label: string; value: ReactNode; className?: string }) => (
  <div className={cn("rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-950/70", className)}>
    <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</div>
    <div className="mt-1 break-words text-sm font-semibold text-slate-900 dark:text-slate-100">{value || "-"}</div>
  </div>
);

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
    const diff = todayStart.getTime() - dateOnly.getTime();
    const deltaDays = diff / (1000 * 60 * 60 * 24);
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
  if (preset === "range") {
    if (fromDate && toDateValue) return `Custom: ${fromDate} - ${toDateValue}`;
    if (fromDate) return `Custom: from ${fromDate}`;
    if (toDateValue) return `Custom: until ${toDateValue}`;
    return "Custom Range";
  }
  return "Today";
};

const TechnologistPage = () => {
  const { toast } = useToast();
  const [orders, setOrders] = useState<MwlOrder[]>([]);
  const [staffOptions, setStaffOptions] = useState<MwlDoctor[]>([]);
  const [modalityStations, setModalityStations] = useState<MwlModalityStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [radiologistWhatsappTemplate, setRadiologistWhatsappTemplate] = useState(DEFAULT_RADIOLOGIST_NOTIFICATION_TEMPLATE);
  const [sending, setSending] = useState(false);
  const [directSendingOrderId, setDirectSendingOrderId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [whatsappDialogOpen, setWhatsappDialogOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<MwlOrder | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [detailOrder, setDetailOrder] = useState<MwlOrder | null>(null);
  const [selectedRadiologistId, setSelectedRadiologistId] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappMessage, setWhatsappMessage] = useState("");
  const [sendingWhatsapp, setSendingWhatsapp] = useState(false);
  const [selectedStaffIds, setSelectedStaffIds] = useState<number[]>([]);
  const [modalityStationId, setModalityStationId] = useState("");
  const [reportStatusMap, setReportStatusMap] = useState<Record<string, ReportStatus>>({});
  const [qcStatusMap, setQcStatusMap] = useState<Record<string, { processed_at?: string | null }>>({});
  const [showAllStatuses, setShowAllStatuses] = useState(false);
  const [quickFilter, setQuickFilter] = useState<TechnologistQuickFilter>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDateValue, setToDateValue] = useState("");

  const radiologistOptions = useMemo(
    () => staffOptions.filter(row => row.role === "RADIOLOGIST"),
    [staffOptions]
  );

  const buildReportingLink = useCallback((order: MwlOrder) => {
    const studyUid = order.actual_study_instance_uid || order.study_instance_uid || "";
    if (!studyUid) return "";
    return `${window.location.origin}/reporting/report/${studyUid}`;
  }, []);

  const buildWhatsappMessage = useCallback(
    (order: MwlOrder, radiologistName?: string) => {
      const reportLink = buildReportingLink(order);
      return applyTextTemplate(radiologistWhatsappTemplate || DEFAULT_RADIOLOGIST_NOTIFICATION_TEMPLATE, {
        radiologist_name: radiologistName || "Physician",
        patient_name: order.nama_pasien || "-",
        patient_id: order.no_rm || "-",
        accession_number: order.accession_number || "-",
        study_description: order.procedure_desc || "-",
        priority: isCitoOrder(order.cito) ? "CITO" : "Routine",
        reporting_link: reportLink,
        study_instance_uid: order.actual_study_instance_uid || order.study_instance_uid || "",
      });
    },
    [buildReportingLink, radiologistWhatsappTemplate]
  );

  const openWhatsappDialog = useCallback(
    (order: MwlOrder) => {
      const studyUid = order.actual_study_instance_uid || order.study_instance_uid || "";
      if (order.status !== "COMPLETED" || !studyUid) {
        toast({
          title: "Notification not available",
          description: "WhatsApp notification can only be sent after the study is completed and available in PACS.",
          variant: "destructive",
        });
        return;
      }
      const assignedRadiologist = radiologistOptions.find(item => item.nama_dokter === order.radiologist_doctor_name);
      setSelectedOrder(order);
      setSelectedRadiologistId(assignedRadiologist ? String(assignedRadiologist.id) : "");
      setWhatsappNumber(assignedRadiologist?.linked_phone_number || "");
      setWhatsappMessage(buildWhatsappMessage(order, assignedRadiologist?.nama_dokter || order.radiologist_doctor_name || ""));
      setWhatsappDialogOpen(true);
    },
    [buildWhatsappMessage, radiologistOptions, toast]
  );

  const openDetailDialog = useCallback((order: MwlOrder) => {
    setDetailOrder(order);
    setDetailDialogOpen(true);
  }, []);

  const handleRadiologistChange = useCallback(
    (value: string) => {
      setSelectedRadiologistId(value);
      if (!selectedOrder) return;
      const selectedRadiologist = radiologistOptions.find(item => String(item.id) === value);
      setWhatsappNumber(selectedRadiologist?.linked_phone_number || "");
      setWhatsappMessage(buildWhatsappMessage(selectedOrder, selectedRadiologist?.nama_dokter || ""));
    },
    [buildWhatsappMessage, radiologistOptions, selectedOrder]
  );

  const handleSendWhatsapp = useCallback(async () => {
    if (!selectedOrder) return;
    const number = whatsappNumber.replace(/[^0-9]/g, "");
    const studyUid = selectedOrder.actual_study_instance_uid || selectedOrder.study_instance_uid || "";
    if (!selectedRadiologistId) {
      toast({
        title: "Radiologist is required",
        description: "Choose the radiologist who should receive the notification.",
        variant: "destructive",
      });
      return;
    }
    if (!number) {
      toast({
        title: "WhatsApp number is empty",
        description: "Enter the radiologist WhatsApp number first.",
        variant: "destructive",
      });
      return;
    }
    if (!whatsappMessage.trim()) {
      toast({
        title: "Message is empty",
        description: "Write the WhatsApp message first.",
        variant: "destructive",
      });
      return;
    }
    setSendingWhatsapp(true);
    try {
      const result = await whatsappService.sendMessage({
        number,
        message: whatsappMessage,
        recipientType: "radiologist",
        patientId: selectedOrder.no_rm || undefined,
        studyInstanceUid: studyUid || undefined,
        accessionNumber: selectedOrder.accession_number || undefined,
      });
      if (result.sent) {
        toast({
          title: "WhatsApp sent",
          description: "Radiologist notification has been sent.",
        });
        setWhatsappDialogOpen(false);
        return;
      }
      const fallbackUrl = result.fallbackUrl || `https://wa.me/${number}?text=${encodeURIComponent(whatsappMessage)}`;
      window.open(fallbackUrl, "_blank", "noopener");
    } catch (error) {
      const fallbackUrl =
        (error as Error & { fallbackUrl?: string }).fallbackUrl ||
        `https://wa.me/${number}?text=${encodeURIComponent(whatsappMessage)}`;
      window.open(fallbackUrl, "_blank", "noopener");
      toast({
        title: "WhatsApp API is not available",
        description:
          error instanceof Error
            ? `${error.message}. Opened through WhatsApp Web as a fallback.`
            : "Opened through WhatsApp Web as a fallback.",
      });
    } finally {
      setSendingWhatsapp(false);
    }
  }, [selectedOrder, selectedRadiologistId, toast, whatsappMessage, whatsappNumber]);

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!silent) setLoading(true);
    try {
      const [orderRows, staffRows, modalityRows] = await Promise.all([
        mwlService.fetchOrders({ status: "ALL" }),
        mwlService.fetchDoctors({ role: "ALL" }),
        mwlService.fetchModalityStations(),
      ]);
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
          if (item.study_instance_uid) {
            nextQc[item.study_instance_uid] = { processed_at: item.processed_at ?? null };
          }
        });
        setReportStatusMap(nextReport);
        setQcStatusMap(nextQc);
      } else {
        setReportStatusMap({});
        setQcStatusMap({});
      }
      setOrders(orderRows);
      setStaffOptions(staffRows.filter(row => row.role === "RADIOLOGIST" || row.role === "TECHNOLOGIST"));
      setModalityStations(modalityRows);
    } catch (error) {
      toast({
        title: "Failed to load MWL staff data",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    let active = true;
    dicomWebService.fetchUiSettings()
      .then(settings => {
        if (active) setAutoRefreshEnabled(typeof settings.autoRefresh === "boolean" ? settings.autoRefresh : true);
        if (active && typeof settings.radiologistWhatsappNotification?.messageTemplate === "string") {
          setRadiologistWhatsappTemplate(settings.radiologistWhatsappNotification.messageTemplate || DEFAULT_RADIOLOGIST_NOTIFICATION_TEMPLATE);
        }
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
    return orders.map(order => ({
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

  const openSendDialog = useCallback((order: MwlOrder) => {
    setSelectedOrder(order);
    try {
      const assigned = order.assigned_staff_json ? JSON.parse(order.assigned_staff_json) : [];
      const nextIds = Array.isArray(assigned)
        ? assigned
          .map((item: { id?: number | string } | null) => Number(item?.id))
          .filter((value: number) => Number.isFinite(value) && value > 0)
          .slice(0, 7)
        : [];
      setSelectedStaffIds(nextIds);
    } catch {
      setSelectedStaffIds(order.technologist_id ? [order.technologist_id] : []);
    }
    setModalityStationId(order.modality_station_id ? String(order.modality_station_id) : "");
    setDialogOpen(true);
  }, []);

  const handleSend = async () => {
    if (!selectedOrder) return;
    if (selectedStaffIds.length === 0) {
      toast({ title: "Select staff", description: "Select at least one staff member before sending MWL.", variant: "destructive" });
      return;
    }
    if (selectedStaffIds.length > 7) {
      toast({ title: "Too many staff", description: "A maximum of 7 staff members can be assigned to one MWL.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      await mwlService.sendToModality(selectedOrder.id, {
        staffIds: selectedStaffIds,
        modalityStationId: modalityStationId ? Number(modalityStationId) : undefined,
      });
      toast({ title: "MWL sent", description: "Order has been sent to the modality." });
      setDialogOpen(false);
      await loadData();
    } catch (error) {
      toast({
        title: "Failed to send MWL",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const handleSendDirectToRadiologist = async (order: MwlOrder) => {
    if (order.status === "COMPLETED" || order.status === "CANCELLED") return;
    setDirectSendingOrderId(order.id);
    try {
      await mwlService.sendDirectToRadiologist(order.id);
      toast({
        title: "Sent direct to radiologist",
        description: "Technologist status has been completed and the order is ready for reporting.",
      });
      setDetailDialogOpen(false);
      setDialogOpen(false);
      await loadData();
    } catch (error) {
      toast({
        title: "Failed to send direct",
        description: error instanceof Error ? error.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setDirectSendingOrderId(null);
    }
  };

  const toggleStaffSelection = (staffId: number, checked: boolean) => {
    setSelectedStaffIds(prev => {
      if (checked) {
        if (prev.includes(staffId)) return prev;
        if (prev.length >= 7) {
          toast({
            title: "Staff limit reached",
            description: "A maximum of 7 staff members can be assigned to one MWL send.",
            variant: "destructive",
          });
          return prev;
        }
        return [...prev, staffId];
      }
      return prev.filter(id => id !== staffId);
    });
  };

  const extraColumns = useMemo(() => {
    return [
      {
        key: "statusTrack",
        label: "Status Track",
        width: 190,
        getValue: (row: WorklistItem) => `${row.id} ${isCitoOrder(row.cito) ? "CITO" : ""}`,
        renderCell: (row: WorklistItem) => {
          const order = orderMap.get(row.id);
          if (!order) return null;
          const studyUid = order.actual_study_instance_uid || order.study_instance_uid || "";
          const reportStatus = studyUid ? reportStatusMap[studyUid] || "" : "";
          const qcChecked = Boolean(studyUid && qcStatusMap[studyUid]?.processed_at);
          const technologistTone: "idle" | "active" | "done" =
            order.status === "COMPLETED"
              ? "done"
              : order.status === "SENT_TO_MWL"
                ? "active"
                : "idle";
          const radiologistTone: "idle" | "active" | "done" =
            reportStatus === "final"
              ? "done"
              : reportStatus === "draft"
                ? "active"
                : "idle";
          const qcTone: "idle" | "active" | "done" = qcChecked ? "done" : "idle";
          return (
            <div className="inline-flex items-center overflow-hidden rounded-md border border-slate-300/70 bg-slate-100/90 shadow-sm whitespace-nowrap dark:border-slate-700/70 dark:bg-slate-900/80">
              <StatusTrackIcon label="Technologist" tone={technologistTone} icon={<Radiation className="h-4 w-4" />} />
              <StatusTrackIcon label="Reporting" tone={radiologistTone} icon={<Stethoscope className="h-4 w-4" />} />
              <StatusTrackIcon label="Distribution" tone={qcTone} icon={<ClipboardCheck className="h-4 w-4" />} />
            </div>
          );
        },
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
          return <span>{getAssignedStaffNames(order)}</span>;
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
      {
        key: "sendAction",
        label: "Action",
        width: 124,
        getValue: () => "",
        renderCell: (row: WorklistItem) => {
          const order = orderMap.get(row.id);
          if (!order) return null;
          const sendDisabled = order.status === "COMPLETED" || order.status === "CANCELLED";
          const whatsappDisabled = order.status !== "COMPLETED";
          return (
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-lg"
                    disabled={sendDisabled}
                    onClick={event => {
                      event.stopPropagation();
                      openSendDialog(order);
                    }}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send to MWL</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-emerald-600 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200"
                    disabled={whatsappDisabled}
                    onClick={event => {
                      event.stopPropagation();
                      openWhatsappDialog(order);
                    }}
                  >
                    <MessageCircle className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {whatsappDisabled ? "Available after study completed" : "Notify radiologist via WhatsApp"}
                </TooltipContent>
              </Tooltip>
            </div>
          );
        },
      },
      {
        key: "registerDate",
        label: "Register Date",
        width: 170,
        getValue: (row: WorklistItem) =>
          orderMap.get(row.id)?.order_in_tanggal_aktivasi || orderMap.get(row.id)?.tanggal_aktivasi || "",
        renderCell: (row: WorklistItem) => (
          <span>
            {formatRegisterDate(
              orderMap.get(row.id)?.order_in_tanggal_aktivasi || orderMap.get(row.id)?.tanggal_aktivasi
            )}
          </span>
        ),
      },
    ];
  }, [orderMap, reportStatusMap, qcStatusMap, openSendDialog, openWhatsappDialog]);

  const matchesQuickFilter = useCallback(
    (order: MwlOrder) => {
      if (quickFilter === "pending") return order.status === "PENDING";
      if (quickFilter === "scheduled") return order.status === "SENT_TO_MWL";
      if (quickFilter === "cito") return isCitoOrder(order.cito);
      if (quickFilter === "completed") return order.status === "COMPLETED";
      if (quickFilter === "total") return true;
      return true;
    },
    [quickFilter]
  );

  const rowFilter = useCallback(
    (row: WorklistItem, context?: { search: string }) => {
      const order = orderMap.get(row.id);
      if (!order) return false;
      if (order.status === "CANCELLED") return false;
      if (context?.search?.trim()) return quickFilter !== null ? matchesQuickFilter(order) : true;
      if (!isOrderInPreset(order, datePreset, fromDate, toDateValue)) return false;
      if (quickFilter !== null) return matchesQuickFilter(order);
      if (!showAllStatuses && order.status === "COMPLETED") return false;
      return true;
    },
    [orderMap, showAllStatuses, datePreset, fromDate, toDateValue, quickFilter, matchesQuickFilter]
  );

  const handleOpenOrderDetail = useCallback(
    (row: WorklistItem) => {
      const order = orderMap.get(row.id);
      if (order) openDetailDialog(order);
    },
    [openDetailDialog, orderMap]
  );

  const activeDateFilterLabel = useMemo(
    () => formatActiveDateFilterLabel(datePreset, fromDate, toDateValue),
    [datePreset, fromDate, toDateValue]
  );

  const commandStats = useMemo(() => {
    const activeOrders = orders.filter(order =>
      order.status !== "CANCELLED" &&
      isOrderInPreset(order, datePreset, fromDate, toDateValue)
    );
    const citoOrders = activeOrders.filter(order => isCitoOrder(order.cito));
    const completedCitoOrders = citoOrders.filter(order => order.status === "COMPLETED");
    return {
      pending: activeOrders.filter(order => order.status === "PENDING").length,
      scheduled: activeOrders.filter(order => order.status === "SENT_TO_MWL").length,
      completed: activeOrders.filter(order => order.status === "COMPLETED").length,
      citoProgress: `${completedCitoOrders.length}/${citoOrders.length}`,
      total: activeOrders.length,
    };
  }, [orders, datePreset, fromDate, toDateValue]);

  const toggleQuickFilter = (next: Exclude<TechnologistQuickFilter, null>) => {
    setQuickFilter(current => (current === next ? null : next));
  };

  const filterActions = (
    <div className="page-toolbar">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={showAllStatuses ? "default" : "outline"}
            size="icon"
            className="rounded-xl h-9 w-9"
            onClick={() => setShowAllStatuses(prev => !prev)}
            disabled={quickFilter !== null}
          >
            <Filter className="w-4 h-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {quickFilter !== null ? "Disabled while a summary card filter is active" : showAllStatuses ? "Show pending only" : "Show all statuses"}
        </TooltipContent>
      </Tooltip>

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
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="today" id="mwl-date-today" /><span>Today</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="yesterday" id="mwl-date-yesterday" /><span>Yesterday</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="7days" id="mwl-date-7days" /><span>Last 7 days</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="30days" id="mwl-date-30days" /><span>Last 30 days</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="1month" id="mwl-date-1month" /><span>Last 1 month</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="2months" id="mwl-date-2months" /><span>Last 2 months</span></label>
              <label className="flex items-center gap-2 text-xs cursor-pointer"><RadioGroupItem value="range" id="mwl-date-range" /><span>Custom range</span></label>
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
        title="Technologist"
        headerContent={
          <div className="technologist-command-header relative overflow-hidden px-6 pt-5 pb-3 text-white">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(56,189,248,0.12),transparent_30%)]" />
            <div className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(148,163,184,.22)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.18)_1px,transparent_1px)] [background-size:34px_34px]" />
            <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-3xl">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-3xl font-black tracking-tight text-white md:text-4xl">Technologist</h1>
                </div>
              </div>
            </div>
            <div className="relative mt-5 grid grid-cols-5 gap-1.5 sm:gap-3">
              <CommandMetric label="Pending" compactLabel="PEND" value={commandStats.pending} tone="cyan" icon={<Clock3 className="h-4 w-4" />} active={quickFilter === "pending"} onClick={() => toggleQuickFilter("pending")} />
              <CommandMetric label="Scheduled" compactLabel="SCHD" value={commandStats.scheduled} tone="amber" icon={<Radio className="h-4 w-4" />} active={quickFilter === "scheduled"} onClick={() => toggleQuickFilter("scheduled")} />
              <CommandMetric label="CITO" compactLabel="CITO" value={commandStats.citoProgress} tone="red" icon={<AlertTriangle className="h-4 w-4" />} active={quickFilter === "cito"} onClick={() => toggleQuickFilter("cito")} />
              <CommandMetric label="Completed" compactLabel="DONE" value={commandStats.completed} tone="emerald" icon={<CheckCircle2 className="h-4 w-4" />} active={quickFilter === "completed"} onClick={() => toggleQuickFilter("completed")} />
              <CommandMetric label="Total Study" compactLabel="TOTAL" value={commandStats.total} tone="cyan" icon={<Activity className="h-4 w-4" />} active={quickFilter === "total"} onClick={() => toggleQuickFilter("total")} />
            </div>
          </div>
        }
        storageKey="mwl-technologist-v2"
        externalRows={mappedRows}
        externalLoading={loading}
        rowFilter={rowFilter}
        onOpenStudy={handleOpenOrderDetail}
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
        surfaceClassName="technologist-command-surface"
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
        defaultColumnOrder={[
          "statusTrack",
          "sendAction",
          "registerDate",
          "accessionNumber",
          "patientId",
          "patientName",
          "studyDescription",
          "modalityCode",
          "referringPhysician",
          "radiologistName",
          "studyDate",
          "technologistName",
          "modalityRoom",
          "aeTitle",
        ]}
        defaultVisibleColumns={[
          "statusTrack",
          "sendAction",
          "registerDate",
          "accessionNumber",
          "patientId",
          "patientName",
          "studyDescription",
          "modalityCode",
          "referringPhysician",
          "radiologistName",
          "technologistName",
          "modalityRoom",
          "aeTitle",
        ]}
        extraColumns={extraColumns}
      />

      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-hidden rounded-3xl border border-slate-200 bg-white p-0 shadow-[0_24px_80px_rgba(15,23,42,0.22)] sm:max-w-4xl dark:border-slate-800 dark:bg-slate-950">
          {detailOrder && (
            <>
              <div className="border-b border-slate-200 bg-slate-950 px-6 py-5 text-white dark:border-slate-800">
                <DialogHeader>
                  <div className="flex flex-col gap-4 pr-8 md:flex-row md:items-start md:justify-between">
                    <div>
                      <DialogTitle className="text-2xl font-black tracking-tight text-white">Order Detail</DialogTitle>
                    </div>
                    <div className={cn("w-fit rounded-full px-3 py-1 text-xs font-black uppercase tracking-[0.12em]", isCitoOrder(detailOrder.cito) ? "bg-red-500/20 text-red-100 ring-1 ring-red-300/30" : "bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-300/30")}>
                      {isCitoOrder(detailOrder.cito) ? "CITO" : "Routine"}
                    </div>
                  </div>
                </DialogHeader>
              </div>

              <div className="max-h-[62vh] space-y-5 overflow-y-auto bg-slate-50/80 p-6 dark:bg-slate-900/35">
                <section className="space-y-3">
                  <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Patient Information</div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <DetailField label="Patient Name" value={displayValue(detailOrder.nama_pasien)} />
                    <DetailField label="Patient ID" value={displayValue(detailOrder.no_rm)} />
                    <DetailField label="Sex" value={displayValue(detailOrder.kelamin)} />
                    <DetailField label="Birth Date" value={formatDetailDate(detailOrder.tanggal_lahir)} />
                    <DetailField label="Register No." value={displayValue(detailOrder.no_register)} />
                    <DetailField label="Payment" value={displayValue(detailOrder.nama_asuransi || detailOrder.cara_bayar)} />
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Study Information</div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <DetailField label="Accession Number" value={displayValue(detailOrder.accession_number)} />
                    <DetailField label="Radiology Number" value={displayValue(detailOrder.no_rontgen)} />
                    <DetailField label="Modality" value={displayValue(detailOrder.modality)} />
                    <DetailField label="Procedure" value={displayValue(detailOrder.procedure_desc || detailOrder.nama_pemeriksaan)} className="md:col-span-2" />
                    <DetailField label="Study Date" value={formatDetailDate(detailOrder.study_date)} />
                    <DetailField label="Study Time" value={displayValue(detailOrder.study_time)} />
                    <DetailField label="Status" value={displayValue(detailOrder.status)} />
                    <DetailField label="Study Instance UID" value={displayValue(detailOrder.actual_study_instance_uid || detailOrder.study_instance_uid)} className="md:col-span-3" />
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Assignment</div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <DetailField label="Referring Doctor" value={displayValue(detailOrder.referring_doctor_name || detailOrder.referring_physician || detailOrder.nama_dokter)} />
                    <DetailField label="Radiologist" value={displayValue(detailOrder.radiologist_doctor_name || detailOrder.nama_radiolog)} />
                    <DetailField label="MWL Staff" value={getAssignedStaffNames(detailOrder)} />
                    <DetailField label="Modality Room" value={displayValue(detailOrder.modality_station_room || detailOrder.nama_ruangan)} />
                    <DetailField label="AE Title" value={displayValue(detailOrder.modality_station_ae || detailOrder.modality_station_aet_master)} />
                    <DetailField label="Clinic / Unit" value={displayValue(detailOrder.polirawat || detailOrder.nama_instalasi_radiologi)} />
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Clinical Notes</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <DetailField label="Clinical Information" value={displayValue(detailOrder.klinis)} />
                    <DetailField label="Diagnosis" value={displayValue(detailOrder.diagnosa)} />
                  </div>
                </section>
              </div>

              <DialogFooter className="border-t border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-950">
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-2xl"
                    disabled={detailOrder.status === "COMPLETED" || detailOrder.status === "CANCELLED"}
                    onClick={() => {
                      setDetailDialogOpen(false);
                      openSendDialog(detailOrder);
                    }}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    Send to MWL
                  </Button>
                  <Button
                    type="button"
                    className="rounded-2xl bg-emerald-600 text-white hover:bg-emerald-500"
                    disabled={detailOrder.status !== "COMPLETED"}
                    onClick={() => {
                      setDetailDialogOpen(false);
                      openWhatsappDialog(detailOrder);
                    }}
                  >
                    <MessageCircle className="mr-2 h-4 w-4" />
                    Notify Radiologist
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-0 shadow-[0_24px_80px_rgba(15,23,42,0.22)] sm:max-w-2xl dark:border-slate-800 dark:bg-slate-950">
          <div className="border-b border-slate-200 bg-white px-6 py-5 dark:border-slate-800 dark:bg-slate-950">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3 text-xl font-black tracking-tight text-slate-950 dark:text-white">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-50 text-sky-600 ring-1 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20">
                  <Send className="h-5 w-5" />
                </span>
                Send MWL
              </DialogTitle>
              <DialogDescription className="pl-[52px] text-slate-500 dark:text-slate-400">
                {selectedOrder ? `${selectedOrder.accession_number} - ${selectedOrder.nama_pasien}` : "Select staff and modality room"}
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="space-y-5 bg-slate-50/70 p-6 dark:bg-slate-900/35">
            {selectedOrder && (
              <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-950/70 md:grid-cols-3">
                <div className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900">
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Modality</div>
                  <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">{selectedOrder.modality || "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900">
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Study</div>
                  <div className="mt-1 line-clamp-1 font-bold text-slate-900 dark:text-slate-100">{selectedOrder.procedure_desc || "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900">
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Priority</div>
                  <div className={cn("mt-1 inline-flex rounded-full px-2.5 py-0.5 text-xs font-black", isCitoOrder(selectedOrder.cito) ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300")}>
                    {isCitoOrder(selectedOrder.cito) ? "CITO" : "Routine"}
                  </div>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">Select Staff</Label>
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-slate-500 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:ring-slate-800">{selectedStaffIds.length}/7 selected</span>
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-950/70">
                {staffOptions.map(item => {
                  const checked = selectedStaffIds.includes(item.id);
                  return (
                    <label
                      key={item.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition-all",
                        checked
                          ? "border-sky-300 bg-sky-50 shadow-sm dark:border-sky-500/45 dark:bg-sky-500/10"
                          : "border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-800 dark:hover:bg-slate-900"
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={value => toggleStaffSelection(item.id, Boolean(value))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">{item.nama_dokter}</div>
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{item.kode_dokter}</div>
                      </div>
                      <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.08em]", item.role === "TECHNOLOGIST" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300")}>{item.role}</span>
                    </label>
                  );
                })}
                {staffOptions.length === 0 && (
                  <div className="text-sm text-muted-foreground">No RADIOLOGIST or TECHNOLOGIST staff available.</div>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">Modality Room</Label>
              <Select
                value={modalityStationId || "__none__"}
                onValueChange={value => setModalityStationId(value === "__none__" ? "" : value)}
              >
                <SelectTrigger className="h-11 rounded-2xl border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
                  <SelectValue placeholder="Select room" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No room</SelectItem>
                  {modalityStations.map(item => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {item.nama_ruangan} ({item.ae_title_station})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="border-t border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-950">
            <Button
              type="button"
              variant="outline"
              disabled={!selectedOrder || selectedOrder.status === "COMPLETED" || selectedOrder.status === "CANCELLED" || directSendingOrderId === selectedOrder.id}
              onClick={() => selectedOrder && void handleSendDirectToRadiologist(selectedOrder)}
              className="rounded-2xl border-violet-200 text-violet-700 hover:bg-violet-50 hover:text-violet-800 dark:border-violet-400/30 dark:text-violet-200 dark:hover:bg-violet-500/10"
            >
              {selectedOrder && directSendingOrderId === selectedOrder.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
              Send Direct to Radiologist
            </Button>
            <Button onClick={handleSend} disabled={sending} className="rounded-2xl bg-sky-600 px-5 text-white shadow-lg shadow-sky-600/20 hover:bg-sky-500">
              {sending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Send to MWL
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={whatsappDialogOpen} onOpenChange={setWhatsappDialogOpen}>
        <DialogContent className="overflow-hidden border-slate-200 bg-white p-0 shadow-2xl sm:max-w-2xl dark:border-white/10 dark:bg-slate-950">
          <div className="relative border-b border-slate-200 bg-slate-950 px-6 py-5 text-white dark:border-white/10">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(16,185,129,0.24),transparent_28%),radial-gradient(circle_at_90%_10%,rgba(34,197,94,0.18),transparent_26%)]" />
            <DialogHeader className="relative">
              <DialogTitle className="flex items-center gap-2 text-xl font-black tracking-tight text-white">
                <MessageCircle className="h-5 w-5 text-emerald-200" />
                Notify Radiologist
              </DialogTitle>
              <DialogDescription className="text-slate-300">
                {selectedOrder ? `${selectedOrder.accession_number} - ${selectedOrder.nama_pasien}` : "Send reporting reminder by WhatsApp"}
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-5 p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Radiologist</Label>
                <Select value={selectedRadiologistId} onValueChange={handleRadiologistChange}>
                  <SelectTrigger className="rounded-xl">
                    <SelectValue placeholder="Choose radiologist" />
                  </SelectTrigger>
                  <SelectContent>
                    {radiologistOptions.map(item => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {item.nama_dokter}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>WhatsApp Number</Label>
                <Input
                  value={whatsappNumber}
                  onChange={event => setWhatsappNumber(event.target.value)}
                  placeholder="e.g. 628123456789"
                  className="rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Message</Label>
              <textarea
                value={whatsappMessage}
                onChange={event => setWhatsappMessage(event.target.value)}
                rows={10}
                className="w-full rounded-2xl border border-input bg-background px-4 py-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
          </div>

          <DialogFooter className="border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-white/10 dark:bg-white/[0.03]">
            <Button variant="outline" onClick={() => setWhatsappDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSendWhatsapp} disabled={sendingWhatsapp}>
              {sendingWhatsapp ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-2 h-4 w-4" />}
              Send WhatsApp
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TechnologistPage;
