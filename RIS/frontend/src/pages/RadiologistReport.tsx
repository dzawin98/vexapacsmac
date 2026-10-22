import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Editor } from "@tinymce/tinymce-react";
import type { Editor as TinyMCEEditor } from "tinymce";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import "tinymce/tinymce";
import "tinymce/icons/default";
import "tinymce/themes/silver";
import "tinymce/models/dom";
import "tinymce/plugins/table";
import "tinymce/plugins/lists";
import "tinymce/plugins/link";
import "tinymce/plugins/code";
import "tinymce/plugins/visualblocks";
import "tinymce/plugins/searchreplace";
import "tinymce/plugins/charmap";
import "tinymce/plugins/autoresize";
import "tinymce/skins/ui/oxide/skin.min.css";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { isViewerAllowedForModality, openViewerInNamedWindow } from "@/lib/viewerWindow";
import { getViewerButtonLabel } from "@/lib/viewerLabels";
import StudySeriesPreviewPanel from "@/components/StudySeriesPreviewPanel";
import {
  dicomWebService,
  expertiseService,
  mwlService,
  radiologyReportService,
  radiologistTemplateService,
  MwlOrder,
  WorklistItem as DicomWorklistItem,
  RadiologyReport,
  RadiologyReportRevision,
  RadiologistTemplate,
  SeriesItem,
  ViewerConfig,
  DEFAULT_EXPERTISE_TEMPLATE,
} from "@/lib/dicomService";
import type { WorklistItem as PreviewWorklistItem } from "@/data/mockData";
import { useAuth } from "@/contexts/AuthContext";
import {
  Printer,
  Save,
  CheckCircle2,
  ExternalLink,
  X,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Copy,
  History,
  Loader2,
  RotateCcw,
  Sun,
} from "lucide-react";

type ReportStatus = "none" | "draft" | "final";
type ReportPanelId = "patient" | "report" | "history" | "images";
type ResizablePanelId = "study" | ReportPanelId;
const MOBILE_REPORT_BREAKPOINT = 1180;
const TABLET_REPORT_BREAKPOINT = 1536;
const STACKED_REPORT_BREAKPOINT = 1536;
const REPORT_FOOTER_OFFSET = 180;
type ReportVisibilitySettings = {
  showStudyNavigator: boolean;
  showPatientInfo: boolean;
  showReportHistory: boolean;
  showImagePreview: boolean;
};

const createDefaultReportPanelSizes = (): Partial<Record<ResizablePanelId, { width?: number; height?: number }>> => {
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const studyHeight = Math.min(Math.max(Math.round(viewportHeight * 0.22), 150), 210);
  const mainPanelHeight = Math.min(Math.max(viewportHeight - studyHeight - 170, 340), 640);

  return {
    study: { height: studyHeight },
    patient: { width: Math.min(350, Math.max(300, Math.round(viewportWidth * 0.17))), height: mainPanelHeight },
    report: { width: Math.min(760, Math.max(560, Math.round(viewportWidth * 0.38))), height: mainPanelHeight },
    history: { width: Math.min(410, Math.max(320, Math.round(viewportWidth * 0.2))), height: mainPanelHeight },
    images: { width: Math.min(330, Math.max(220, Math.round(viewportWidth * 0.16))), height: mainPanelHeight },
  };
};

const clampLayoutPanelSizes = (
  sizes: Partial<Record<ResizablePanelId, { width?: number; height?: number }>> | undefined
): Partial<Record<ResizablePanelId, { width?: number; height?: number }>> => {
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const requestedStudyHeight = sizes?.study?.height ?? createDefaultReportPanelSizes().study?.height ?? 170;
  const maxStudyHeight = Math.max(118, Math.min(280, viewportHeight - 360));
  const studyHeight = Math.min(Math.max(requestedStudyHeight, 118), maxStudyHeight);
  const maxMainPanelHeight = Math.max(300, viewportHeight - studyHeight - 170);
  const maxPanelWidth = Math.max(320, viewportWidth - 160);

  return Object.entries(sizes ?? {}).reduce<Partial<Record<ResizablePanelId, { width?: number; height?: number }>>>((acc, [key, value]) => {
    const panel = key as ResizablePanelId;
    const minHeight = panel === "study" ? 118 : panel === "images" ? 96 : 220;
    const maxHeight = panel === "study" ? maxStudyHeight : Math.max(minHeight, maxMainPanelHeight);
    const minWidth = panel === "images" ? 120 : 260;

    acc[panel] = {
      width: value?.width ? Math.min(Math.max(value.width, minWidth), maxPanelWidth) : undefined,
      height: value?.height ? Math.min(Math.max(value.height, minHeight), maxHeight) : undefined,
    };
    return acc;
  }, {});
};


type SelectedSeriesImagePanel = {
  series: SeriesItem;
  instances: Record<string, unknown>[];
  loading: boolean;
} | null;

const getSopInstanceUid = (instance?: Record<string, unknown>): string => {
  const rawElement = instance?.["00080018"] as { Value?: unknown[] } | undefined;
  const value = Array.isArray(rawElement?.Value) ? rawElement.Value[0] : undefined;
  return (value as string | number | undefined)?.toString() ?? "";
};

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatDicomDate = (value?: string | null) => {
  if (!value) return "-";
  const raw = String(value).trim();
  if (!raw) return "-";
  if (/^\d{8}$/.test(raw)) {
    const year = raw.slice(0, 4);
    const month = raw.slice(4, 6);
    const day = raw.slice(6, 8);
    return `${day}/${month}/${year}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const day = String(parsed.getDate()).padStart(2, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const year = parsed.getFullYear();
  return `${day}/${month}/${year}`;
};

const formatStudyDateTime = (dateValue?: string | null, timeValue?: string | null) => {
  const date = formatDicomDate(dateValue);
  if (date === "-") return "-";
  if (!timeValue) return date;
  const raw = String(timeValue).trim();
  if (!raw) return date;
  if (/^\d{6}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    return `${date} ${hours}:${minutes}`;
  }
  if (/^\d{4}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    return `${date} ${hours}:${minutes}`;
  }
  return `${date} ${raw}`;
};

const formatAddress = (order?: MwlOrder | null) => {
  if (!order) return "-";
  const parts = [order.alamat, order.kecamatan, order.kabupaten, order.provinsi, order.kode_pos]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "-";
};

const formatOriginRoom = (order?: MwlOrder | null) => {
  if (!order?.nama_ruangan) return "-";
  const originRoom = String(order.nama_ruangan || "").trim();
  if (!originRoom) return "-";
  return originRoom;
};

const htmlToPlainText = (html?: string | null) => {
  if (!html) return "";
  if (typeof window === "undefined") {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const element = window.document.createElement("div");
  element.innerHTML = html;
  return (element.textContent || element.innerText || "").replace(/\s+/g, " ").trim();
};

const formatDicomTime = (timeValue?: string | null) => {
  if (!timeValue) return "-";
  const raw = String(timeValue).trim();
  if (!raw) return "-";
  if (/^\d{6}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    const seconds = raw.slice(4, 6);
    return seconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`;
  }
  if (/^\d{4}(\.\d+)?$/.test(raw)) {
    const hours = raw.slice(0, 2);
    const minutes = raw.slice(2, 4);
    return `${hours}:${minutes}`;
  }
  return raw;
};

const isBlankRichText = (value?: string | null) => {
  if (!value) return true;
  const normalized = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !normalized;
};

const cleanReportPatientName = (patientName?: string | null, patientId?: string | null) => {
  const name = String(patientName || "").trim();
  const id = String(patientId || "").trim();
  if (!name || !id) return name;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.replace(new RegExp(`\\s*[-â€“â€”/]?\\s*${escapedId}\\s*$`, "i"), "").trim() || name;
};

const calculateAgeLabel = (birthDate?: string | null, referenceDate?: string | null) => {
  if (!birthDate) return "";
  const digitsBirth = String(birthDate).replace(/[^0-9]/g, "");
  if (digitsBirth.length < 8) return "";
  const birthYear = Number(digitsBirth.slice(0, 4));
  const birthMonth = Number(digitsBirth.slice(4, 6));
  const birthDay = Number(digitsBirth.slice(6, 8));
  const reference =
    referenceDate && String(referenceDate).replace(/[^0-9]/g, "").length >= 8
      ? String(referenceDate)
      : "";
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
  let years = refYear - birthYear;
  let months = refMonth - birthMonth;
  if (refDay < birthDay) {
    months -= 1;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0 || !Number.isFinite(years) || !Number.isFinite(months)) return "";
  return `${years} y ${months} mo`;
};

const mapDicomStudyToPreviewItem = (item: DicomWorklistItem): PreviewWorklistItem => ({
  id: item.StudyInstanceUID || item.AccessionNumber || item.PatientID || "",
  patientId: item.PatientID || "",
  patientName: item.PatientName || "",
  otherPatientIds: item.OtherPatientIDs || "",
  accessionNumber: item.AccessionNumber || "",
  institutionName: item.InstitutionName || "",
  modalityCode: item.ModalityCode || "",
  studyDescription: item.StudyDescription || "",
  imageCount: item.NumberOfStudyRelatedInstances || 0,
  seriesCount: item.NumberOfStudyRelatedSeries || 0,
  referringPhysician: item.ReferringPhysicianName || "",
  studyDate: item.StudyDate || "",
  studyTime: item.StudyTime || "",
  studyId: item.StudyID || "",
  birthDate: item.PatientBirthDate || "",
  age: calculateAgeLabel(item.PatientBirthDate, item.StudyDate),
  sex: item.PatientSex === "F" ? "F" : item.PatientSex === "O" ? "O" : "M",
  studyInstanceUid: item.StudyInstanceUID || "",
  status: (item.NumberOfStudyRelatedInstances || 0) > 0 ? "completed" : "scheduled",
});

const TinyRichTextEditor = ({
  value,
  onChange,
  disabled,
  height = 260,
  autoResize = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  height?: number;
  autoResize?: boolean;
}) => {
  const editorRef = useRef<TinyMCEEditor | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.mode.set(disabled ? "readonly" : "design");
  }, [disabled]);

  return (
    <Editor
      licenseKey="gpl"
      onInit={(_evt, editor) => {
        editorRef.current = editor;
        editor.mode.set(disabled ? "readonly" : "design");
      }}
      value={value}
      onEditorChange={content => onChange(content)}
      disabled={disabled}
      init={{
        height,
        min_height: height,
        autoresize_bottom_margin: 16,
        menubar: false,
        branding: false,
        promotion: false,
        plugins: `table lists link code visualblocks searchreplace charmap${autoResize ? " autoresize" : ""}`,
        toolbar:
          "undo redo | blocks | bold italic underline | alignleft aligncenter alignright | bullist numlist | table | code",
        content_style:
          'body { font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; font-size: 12px; }',
      }}
    />
  );
};

const RadiologistReport = () => {
  const { studyInstanceUid } = useParams<{ studyInstanceUid: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, hasPermission } = useAuth();
  const [loading, setLoading] = useState(true);
  const [study, setStudy] = useState<DicomWorklistItem | null>(null);
  const [orderContext, setOrderContext] = useState<MwlOrder | null>(null);
  const [status, setStatus] = useState<ReportStatus>("none");
  const [clinicalInfo, setClinicalInfo] = useState("");
  const [findings, setFindings] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [isCritical, setIsCritical] = useState(false);
  const [radiologistName, setRadiologistName] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewerConfigs, setViewerConfigs] = useState<ViewerConfig[]>([]);
  const [revisions, setRevisions] = useState<RadiologyReportRevision[]>([]);
  const [activeTab, setActiveTab] = useState("report");
  const [headerImage, setHeaderImage] = useState<string | null>(null);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [templateHtml, setTemplateHtml] = useState<string | null>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateTitle, setTemplateTitle] = useState("");
  const [templateFindings, setTemplateFindings] = useState("");
  const [templateConclusion, setTemplateConclusion] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templates, setTemplates] = useState<RadiologistTemplate[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [patientHistory, setPatientHistory] = useState<DicomWorklistItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryStudyUid, setSelectedHistoryStudyUid] = useState("");
  const [selectedHistoryReport, setSelectedHistoryReport] = useState<RadiologyReport | null>(null);
  const [historyReportLoading, setHistoryReportLoading] = useState(false);
  const [showStudyNavigator, setShowStudyNavigator] = useState(true);
  const [showPatientInfo, setShowPatientInfo] = useState(true);
  const [showReportHistory, setShowReportHistory] = useState(true);
  const [showImagePreview, setShowImagePreview] = useState(true);
  const [selectedSeriesImagePanel, setSelectedSeriesImagePanel] = useState<SelectedSeriesImagePanel>(null);
  const [phoneImageIndex, setPhoneImageIndex] = useState(0);
  const [phoneImageScale, setPhoneImageScale] = useState(1);
  const [imageBrightness, setImageBrightness] = useState(1);
  const [imageContrast, setImageContrast] = useState(1);
  const [imageWindowDragging, setImageWindowDragging] = useState(false);
  const imageWindowDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startBrightness: number;
    startContrast: number;
    currentBrightness: number;
    currentContrast: number;
    viewportWidth: number;
    viewportHeight: number;
    moved: boolean;
  } | null>(null);
  const [phoneImageTouchCount, setPhoneImageTouchCount] = useState(0);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [showPhoneImageView, setShowPhoneImageView] = useState(true);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  const desktopCanvasScrollRef = useRef<HTMLDivElement | null>(null);
  const desktopCanvasPanRef = useRef({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });

  const canEdit = status !== "final" && hasPermission("report_edit");
  const canFinalize = status !== "final" && hasPermission("report_finalize");
  const canPrint = hasPermission("report_print");
  const canUseRevision = hasPermission("report_edit");

  const phoneMode = viewportSize.width < MOBILE_REPORT_BREAKPOINT;
  const tabletDesktopFitMode = viewportSize.width >= MOBILE_REPORT_BREAKPOINT && viewportSize.width < TABLET_REPORT_BREAKPOINT;
  const desktopCanvasMode = tabletDesktopFitMode;
  const tabletDesktopFitScale = tabletDesktopFitMode
    ? Math.min(Math.max((viewportSize.width - 8) / 1440, 0.1), 1)
    : 1;
  const tabletDesktopCanvasHeight = tabletDesktopFitMode
    ? Math.max((viewportSize.height + 160) / tabletDesktopFitScale, 980)
    : 900;
  const stackedDesktopLayout = !phoneMode && !tabletDesktopFitMode && viewportSize.width < STACKED_REPORT_BREAKPOINT;
  const panelSizes = useMemo(
    () => clampLayoutPanelSizes(createDefaultReportPanelSizes()),
    [viewportSize.height, viewportSize.width]
  );
  const reportVisibilityStorageKey = useMemo(
    () => `nexia-report-visibility:${user?.username || user?.fullName || "default"}`,
    [user?.fullName, user?.username]
  );

  useEffect(() => {
    const updateViewportSize = () => {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    };

    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);
    window.addEventListener("orientationchange", updateViewportSize);
    return () => {
      window.removeEventListener("resize", updateViewportSize);
      window.removeEventListener("orientationchange", updateViewportSize);
    };
  }, []);

  const beginDesktopCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!desktopCanvasMode || tabletDesktopFitMode || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea,select,[contenteditable='true'],iframe")) return;
    const container = desktopCanvasScrollRef.current;
    if (!container) return;
    desktopCanvasPanRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    };
    container.setPointerCapture(event.pointerId);
  };
  const moveDesktopCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = desktopCanvasPanRef.current;
    if (!desktopCanvasMode || tabletDesktopFitMode || !pan.active || pan.pointerId !== event.pointerId) return;
    const container = desktopCanvasScrollRef.current;
    if (!container) return;
    event.preventDefault();
    container.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    container.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  };
  const endDesktopCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = desktopCanvasPanRef.current;
    if (!pan.active || pan.pointerId !== event.pointerId) return;
    desktopCanvasPanRef.current.active = false;
    desktopCanvasScrollRef.current?.releasePointerCapture(event.pointerId);
  };
  const reportActionButtonClass = {
    revise:
      "rounded-2xl border border-violet-300/35 bg-gradient-to-br from-violet-500 via-indigo-600 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_16px_36px_rgba(79,70,229,0.24)] hover:from-violet-400 hover:via-indigo-500 hover:to-slate-800 hover:text-white",
    draft:
      "rounded-2xl border border-amber-200/40 bg-gradient-to-br from-amber-400 via-amber-500 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_16px_36px_rgba(245,158,11,0.22)] hover:from-amber-300 hover:via-amber-400 hover:to-slate-800 hover:text-white",
    save:
      "rounded-2xl border border-cyan-200/35 bg-gradient-to-br from-cyan-400 via-blue-500 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.30),0_18px_42px_rgba(37,99,235,0.28)] hover:from-cyan-300 hover:via-blue-400 hover:to-slate-800 hover:text-white",
    print:
      "rounded-2xl border border-emerald-200/40 bg-gradient-to-br from-emerald-400 via-teal-500 to-slate-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_16px_36px_rgba(16,185,129,0.22)] hover:from-emerald-300 hover:via-teal-400 hover:to-slate-800 hover:text-white",
    close:
      "rounded-2xl border border-slate-400/45 bg-gradient-to-br from-slate-500 via-slate-700 to-slate-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_14px_34px_rgba(15,23,42,0.24)] hover:from-slate-400 hover:via-slate-600 hover:to-slate-900 hover:text-white",
  };
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(reportVisibilityStorageKey);
      if (!saved) return;
      const visibility = JSON.parse(saved) as Partial<ReportVisibilitySettings>;
      setShowStudyNavigator(visibility.showStudyNavigator ?? true);
      setShowPatientInfo(visibility.showPatientInfo ?? true);
      setShowReportHistory(visibility.showReportHistory ?? true);
      setShowImagePreview(visibility.showImagePreview ?? true);
    } catch {
      window.localStorage.removeItem(reportVisibilityStorageKey);
    }
  }, [reportVisibilityStorageKey]);

  const resetReportLayout = useCallback(() => {
    window.localStorage.removeItem(reportVisibilityStorageKey);
    setShowStudyNavigator(true);
    setShowPatientInfo(true);
    setShowReportHistory(true);
    setShowImagePreview(true);
    toast({
      title: "Panel layout reset",
      description: "Panel visibility has been restored for this user.",
    });
  }, [reportVisibilityStorageKey, toast]);

  useEffect(() => {
    try {
      const visibility: ReportVisibilitySettings = {
        showStudyNavigator,
        showPatientInfo,
        showReportHistory,
        showImagePreview,
      };
      window.localStorage.setItem(reportVisibilityStorageKey, JSON.stringify(visibility));
    } catch {
      return;
    }
  }, [
    reportVisibilityStorageKey,
    showImagePreview,
    showPatientInfo,
    showReportHistory,
    showStudyNavigator,
  ]);

  const loadData = useCallback(async () => {
    if (!studyInstanceUid) return;
    setLoading(true);
    try {
      const studies = await dicomWebService.fetchStudies({ StudyInstanceUID: studyInstanceUid });
      const currentStudy = studies[0] ?? null;
      setStudy(currentStudy);
      let matchedOrder: MwlOrder | null = null;
      const normalizeKey = (value?: string | null) => String(value || "").trim().toLowerCase();
      const orders = await mwlService.fetchOrders({ status: "ALL", limit: 1000 });
      matchedOrder =
        orders.find(item => item.study_instance_uid === studyInstanceUid) ||
        orders.find(item => item.actual_study_instance_uid === studyInstanceUid) ||
        orders.find(item => normalizeKey(item.accession_number) === normalizeKey(currentStudy?.AccessionNumber)) ||
        orders.find(
          item =>
            normalizeKey(item.no_rm) === normalizeKey(currentStudy?.PatientID) &&
            normalizeKey(item.modality) === normalizeKey(currentStudy?.ModalityCode)
        ) ||
        null;
      setOrderContext(matchedOrder);
      const report = await radiologyReportService.fetchReport(studyInstanceUid);
      if (report) {
        setStatus(report.status);
        setClinicalInfo(report.clinical_info ?? matchedOrder?.klinis ?? "");
        setFindings(report.findings ?? "");
        setConclusion(report.conclusion ?? "");
        setIsCritical(report.kritis === "1");
        setRadiologistName(report.radiologist_name ?? null);
        setUpdatedAt(report.updated_at ?? null);
      } else {
        setStatus("none");
        setClinicalInfo(matchedOrder?.klinis ?? "");
        setFindings("");
        setConclusion("");
        setIsCritical(false);
        setRadiologistName(user?.fullName ?? null);
        setUpdatedAt(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load report";
      toast({
        title: "Failed to load report",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [studyInstanceUid, toast, user?.fullName]);

  const loadRevisions = useCallback(async () => {
    if (!studyInstanceUid) return;
    try {
      const data = await radiologyReportService.fetchRevisions(studyInstanceUid);
      setRevisions(data);
    } catch (err) {
      toast({
        title: "Failed to load revisions",
        description: err instanceof Error ? err.message : "Unable to load report revisions.",
        variant: "destructive",
      });
    }
  }, [studyInstanceUid, toast]);

  const currentTemplateContext = useMemo(
    () => ({
      modalityCode: String(orderContext?.modality || study?.ModalityCode || "").trim().toUpperCase(),
      procedureCode: String(orderContext?.procedure_code || orderContext?.kode_pemeriksaan || "").trim(),
      procedureDescription: String(
        orderContext?.procedure_desc || orderContext?.nama_pemeriksaan || study?.StudyDescription || ""
      ).trim(),
    }),
    [orderContext, study]
  );

  const loadTemplates = useCallback(async () => {
    if (!user?.username) {
      setTemplates([]);
      return;
    }
    setTemplateLoading(true);
    try {
      const data = await radiologistTemplateService.fetchTemplates(user.username, currentTemplateContext);
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      toast({
        title: "Failed to load templates",
        description: err instanceof Error ? err.message : "Unable to load templates.",
        variant: "destructive",
      });
    } finally {
      setTemplateLoading(false);
    }
  }, [currentTemplateContext, toast, user?.username]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!study?.PatientID) {
      setPatientHistory(study ? [study] : []);
      setSelectedHistoryStudyUid(study?.StudyInstanceUID || "");
      return;
    }

    let cancelled = false;
    const loadPatientHistory = async () => {
      setHistoryLoading(true);
      try {
        const studies = await dicomWebService.fetchStudies({ PatientID: study.PatientID });
        if (cancelled) return;
        const unique = new Map<string, DicomWorklistItem>();
        [...studies, study].forEach(item => {
          if (item?.StudyInstanceUID) unique.set(item.StudyInstanceUID, item);
        });
        const sorted = Array.from(unique.values()).sort((a, b) => {
          const left = `${a.StudyDate || ""}${a.StudyTime || ""}`;
          const right = `${b.StudyDate || ""}${b.StudyTime || ""}`;
          return right.localeCompare(left);
        });
        setPatientHistory(sorted);
        setSelectedHistoryStudyUid(current =>
          current && sorted.some(item => item.StudyInstanceUID === current)
            ? current
            : study.StudyInstanceUID || sorted[0]?.StudyInstanceUID || ""
        );
      } catch {
        if (!cancelled) {
          setPatientHistory([study]);
          setSelectedHistoryStudyUid(study.StudyInstanceUID || "");
        }
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    };

    loadPatientHistory();
    return () => {
      cancelled = true;
    };
  }, [study]);

  useEffect(() => {
    if (!selectedHistoryStudyUid) {
      setSelectedHistoryReport(null);
      return;
    }
    setSelectedSeriesImagePanel(null);

    let cancelled = false;
    const loadSelectedHistoryReport = async () => {
      setHistoryReportLoading(true);
      try {
        const report = await radiologyReportService.fetchReport(selectedHistoryStudyUid);
        if (!cancelled) setSelectedHistoryReport(report);
      } catch {
        if (!cancelled) setSelectedHistoryReport(null);
      } finally {
        if (!cancelled) setHistoryReportLoading(false);
      }
    };

    loadSelectedHistoryReport();
    return () => {
      cancelled = true;
    };
  }, [selectedHistoryStudyUid]);

  useEffect(() => {
    setPhoneImageIndex(0);
    setPhoneImageScale(1);
    setPhoneImageTouchCount(0);
  }, [selectedSeriesImagePanel?.series.SeriesInstanceUID]);

  useEffect(() => {
    setImageBrightness(1);
    setImageContrast(1);
    setImageWindowDragging(false);
    imageWindowDragRef.current = null;
  }, [phoneImageIndex, selectedSeriesImagePanel?.series.SeriesInstanceUID]);

  useEffect(() => {
    const loadAssets = async () => {
      if (!user?.username) return;
      try {
        const assets = await expertiseService.fetchAssets(user.username);
        setHeaderImage(assets.headerImage ?? null);
        setSignatureImage(assets.signatureImage ?? null);
        setTemplateHtml(assets.templateHtml ?? null);
      } catch {
        setHeaderImage(null);
        setSignatureImage(null);
        setTemplateHtml(null);
      }
    };
    loadAssets();
  }, [user?.username]);

  useEffect(() => {
    loadRevisions();
  }, [loadRevisions]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    if (!templatePickerOpen) return;
    loadTemplates();
  }, [templatePickerOpen, loadTemplates]);

  useEffect(() => {
    const loadUiSettings = async () => {
      try {
        const configs = await dicomWebService.fetchViewerConfigs();
        setViewerConfigs(configs);
      } catch {
        setViewerConfigs([]);
      }
    };
    loadUiSettings();
  }, []);

  useEffect(() => {
    if (!templateDialogOpen) return;
    setTemplateTitle("");
    setTemplateFindings(findings?.trim() ? findings : "");
    setTemplateConclusion(conclusion?.trim() ? conclusion : "");
  }, [templateDialogOpen, findings, conclusion]);

  const selectedTemplate = useMemo(
    () => templates.find(template => template.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId]
  );
  const isReportBlank = useMemo(
    () => isBlankRichText(findings) && isBlankRichText(conclusion),
    [findings, conclusion]
  );
  const selectedHistoryStudy = useMemo(
    () =>
      patientHistory.find(item => item.StudyInstanceUID === selectedHistoryStudyUid) ??
      study ??
      null,
    [patientHistory, selectedHistoryStudyUid, study]
  );
  const selectedPreviewItem = useMemo(
    () => (selectedHistoryStudy ? mapDicomStudyToPreviewItem(selectedHistoryStudy) : null),
    [selectedHistoryStudy]
  );
  const mobileHeaderViewerConfigs = useMemo(
    () =>
      viewerConfigs.filter(viewer =>
        isViewerAllowedForModality(viewer, selectedHistoryStudy?.ModalityCode)
      ),
    [selectedHistoryStudy?.ModalityCode, viewerConfigs]
  );

  const payload = useMemo(
    () => ({
      patientId: study?.PatientID,
      radiologistUsername: user?.username ?? "",
      clinicalInfo,
      findings,
      conclusion,
      kritis: isCritical ? "1" as const : "0" as const,
    }),
    [study?.PatientID, user?.username, clinicalInfo, findings, conclusion, isCritical]
  );

  const handleSaveDraft = async () => {
    if (!studyInstanceUid || !payload.radiologistUsername) return;
    if (isReportBlank) {
      toast({
        title: "Cannot save draft",
        description: "Findings and Conclusion are still empty.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const report = await radiologyReportService.saveDraft(studyInstanceUid, payload);
      setStatus(report.status);
      setRadiologistName(report.radiologist_name ?? null);
      setUpdatedAt(report.updated_at ?? null);
      loadRevisions();
      toast({ title: "Draft saved", description: "Report draft has been saved." });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Unable to save draft.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRevise = async () => {
    if (!studyInstanceUid) return;
    setSaving(true);
    try {
      const report = await radiologyReportService.reviseReport(studyInstanceUid);
      setStatus(report.status);
      setClinicalInfo(report.clinical_info ?? "");
      setFindings(report.findings ?? "");
      setConclusion(report.conclusion ?? "");
      setIsCritical(report.kritis === "1");
      setRadiologistName(report.radiologist_name ?? null);
      setUpdatedAt(report.updated_at ?? null);
      toast({ title: "Revision started", description: "Report is now editable." });
    } catch (err) {
      toast({
        title: "Revision failed",
        description: err instanceof Error ? err.message : "Unable to revise report.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleFinalize = async () => {
    if (!studyInstanceUid || !payload.radiologistUsername) return;
    if (isReportBlank) {
      toast({
        title: "Cannot save",
        description: "Findings and Conclusion are still empty.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const report = await radiologyReportService.finalizeReport(studyInstanceUid, payload);
      setStatus(report.status);
      setRadiologistName(report.radiologist_name ?? null);
      setUpdatedAt(report.updated_at ?? null);
      loadRevisions();
      toast({ title: "Report finalized", description: "Report is now locked for editing." });
    } catch (err) {
      toast({
        title: "Finalize failed",
        description: err instanceof Error ? err.message : "Unable to finalize report.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTemplate = async () => {
    if (!user?.username) {
      toast({
        title: "Save failed",
        description: "Radiologist account is missing.",
        variant: "destructive",
      });
      return;
    }
    if (!templateTitle.trim()) {
      toast({
        title: "Title required",
        description: "Please enter the template title.",
        variant: "destructive",
      });
      return;
    }
    setTemplateSaving(true);
    try {
      await radiologistTemplateService.createTemplate({
        radiologistUsername: user.username,
        title: templateTitle.trim(),
        findings: templateFindings,
        conclusion: templateConclusion,
        modalityCode: currentTemplateContext.modalityCode || null,
        procedureCode: currentTemplateContext.procedureCode || null,
        procedureDescription: currentTemplateContext.procedureDescription || null,
      });
      loadTemplates();
      setTemplateDialogOpen(false);
      toast({ title: "Template saved", description: "Radiologist template has been saved." });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Failed to save template.",
        variant: "destructive",
      });
    } finally {
      setTemplateSaving(false);
    }
  };

  const handleSelectTemplate = (template: RadiologistTemplate) => {
    setSelectedTemplateId(template.id);
    setFindings(template.findings ?? "");
    setConclusion(template.conclusion ?? "");
    setActiveTab("report");
    setTemplatePickerOpen(false);
    toast({ title: "Template applied", description: "Template loaded into the report." });
  };

  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const applyTemplate = (template: string, replacements: Record<string, string>) =>
    template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) =>
      Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : ""
    );
  const buildPrintHtml = () => {
    const logoUrl = `${window.location.origin}/logo.png`;
    const reportDate = updatedAt ? formatDate(updatedAt) : formatDate(new Date().toISOString());
    const gender =
      study?.PatientSex === "F"
        ? "Female"
        : study?.PatientSex === "M"
          ? "Male"
          : study?.PatientSex || "-";
    const birthAgeText = calculateAgeLabel(study?.PatientBirthDate, study?.StudyDate);
    const headerHtml = headerImage
      ? `<img src="${headerImage}" class="header-image" />`
      : `<div class="header-fallback"><img src="${logoUrl}" class="logo" /><div class="title">Radiology Report</div></div>`;
    const signatureHtml = signatureImage
      ? `<img src="${signatureImage}" class="signature-image" />`
      : '';
    const reportContent = `
      ${clinicalInfo || ""}
      ${clinicalInfo && (findings || conclusion) ? "<br/><br/>" : ""}
      ${findings || ""}
      ${(clinicalInfo || findings) && conclusion ? "<br/><br/>" : ""}
      ${conclusion || ""}
    `;
    const birthDateValue = formatDicomDate(study?.PatientBirthDate);
    const birthDateAge =
      birthDateValue !== "-"
        ? `${birthDateValue}${birthAgeText ? ` - ${birthAgeText}` : ""}`
        : birthAgeText || "-";
    const patientId = study?.PatientID || "-";
    const patientName = cleanReportPatientName(study?.PatientName, patientId) || "-";
    const template = templateHtml && templateHtml.trim() ? templateHtml : DEFAULT_EXPERTISE_TEMPLATE;
    return applyTemplate(template, {
      header_html: headerHtml,
      signature_html: signatureHtml,
      signature_name: escapeHtml(radiologistName || user?.fullName || "-"),
      patient_name: escapeHtml(patientName),
      patient_id: escapeHtml(patientId),
      gender: escapeHtml(gender),
      birth_date: escapeHtml(birthDateValue || "-"),
      age: escapeHtml(birthAgeText || "-"),
      birth_date_age: escapeHtml(birthDateAge),
      study_description: escapeHtml(study?.StudyDescription || "-"),
      study_date: escapeHtml(formatDicomDate(study?.StudyDate) || "-"),
      study_time: escapeHtml(formatDicomTime(study?.StudyTime) || "-"),
      study_datetime: escapeHtml(formatDicomDate(study?.StudyDate) || "-"),
      referring_physician: escapeHtml(study?.ReferringPhysicianName || "-"),
      radiologist_name: escapeHtml(radiologistName || user?.fullName || "-"),
      clinical_info: clinicalInfo || "",
      findings: findings || "",
      conclusion: conclusion || "",
      report_content: reportContent,
      report_date: escapeHtml(reportDate),
    });
  };

  const openPrintWindow = () => {
    const html = buildPrintHtml();
    const printWindow = window.open("", "_blank", "width=900,height=1200");
    if (!printWindow) {
      toast({ title: "Print failed", description: "Unable to open print window.", variant: "destructive" });
      return;
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 300);
  };

  const copyHistorySection = async (label: "Findings" | "Conclusion", html?: string | null) => {
    const text = htmlToPlainText(html);
    if (!text) {
      toast({
        title: "Nothing to copy",
        description: `${label} is empty.`,
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: "Copied",
        description: `${label} copied to clipboard.`,
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard access is not available in this browser.",
        variant: "destructive",
      });
    }
  };

  const handleUseRevision = (revision: RadiologyReportRevision) => {
    setClinicalInfo(revision.clinical_info ?? "");
    setFindings(revision.findings ?? "");
    setConclusion(revision.conclusion ?? "");
    setIsCritical(revision.kritis === "1");
    setStatus("draft");
    setUpdatedAt(null);
    setRadiologistName(user?.fullName ?? revision.radiologist_name ?? null);
    setActiveTab("report");
    toast({ title: "Revision loaded", description: "Revision content has been loaded." });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        Loading report...
      </div>
    );
  }

  const hasHiddenPanels = !showStudyNavigator || !showPatientInfo || !showReportHistory || !showImagePreview;
  const hiddenPanelButtonClass =
    "h-8 w-40 rounded-b-2xl border border-t-0 border-primary/25 bg-background/95 text-[11px] font-bold uppercase tracking-[0.18em] text-foreground shadow-xl ring-1 ring-primary/10 backdrop-blur transition-all duration-200 ease-out hover:h-12 hover:w-48 hover:bg-card hover:text-primary hover:shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
  const resizablePanelClass = "min-h-0 [scrollbar-gutter:stable]";
  const getPanelSizeStyle = (panel: ResizablePanelId) => {
    const size = panelSizes[panel];
    if (stackedDesktopLayout) {
      const stackedHeight =
        panel === "study"
          ? size?.height
          : panel === "report"
            ? Math.max(size?.height ?? 420, 420)
            : panel === "patient"
              ? Math.max(size?.height ?? 320, 320)
              : panel === "history"
                ? Math.max(size?.height ?? 300, 300)
            : panel === "images"
              ? Math.max(size?.height ?? 280, 280)
              : undefined;

      return {
        height: stackedHeight ? `${stackedHeight}px` : undefined,
      };
    }

    if (tabletDesktopFitMode && panel !== "study") {
      return {
        width: size?.width ? `${size.width}px` : undefined,
        flexBasis: size?.width ? `${size.width}px` : undefined,
        height: "100%",
      };
    }

    return {
      width: size?.width ? `${size.width}px` : undefined,
      flexBasis: size?.width ? `${size.width}px` : undefined,
      height: size?.height ? `${size.height}px` : undefined,
    };
  };
  const moveSelectedSeriesImage = (direction: number) => {
    setPhoneImageIndex(current => {
      const maxIndex = Math.max((selectedSeriesImagePanel?.instances.length ?? 1) - 1, 0);
      return Math.min(Math.max(current + direction, 0), maxIndex);
    });
  };
  const resetImageWindow = () => {
    imageWindowDragRef.current = null;
    setImageWindowDragging(false);
    setImageBrightness(1);
    setImageContrast(1);
  };
  const beginImageWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    imageWindowDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBrightness: imageBrightness,
      startContrast: imageContrast,
      currentBrightness: imageBrightness,
      currentContrast: imageContrast,
      viewportWidth: Math.max(bounds.width, 1),
      viewportHeight: Math.max(bounds.height, 1),
      moved: false,
    };
    setImageWindowDragging(true);
  };
  const moveImageWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = imageWindowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(deltaX) + Math.abs(deltaY) < 2) return;
    event.preventDefault();
    drag.moved = true;
    drag.currentContrast = Math.min(3, Math.max(0.25, drag.startContrast + (deltaX / drag.viewportWidth) * 2));
    drag.currentBrightness = Math.min(3, Math.max(0.25, drag.startBrightness - (deltaY / drag.viewportHeight) * 2));
    setImageContrast(drag.currentContrast);
    setImageBrightness(drag.currentBrightness);
  };
  const endImageWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = imageWindowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    imageWindowDragRef.current = null;
    setImageWindowDragging(false);
  };
  const imageWindowPreviewStyle = {
    filter: `brightness(${imageBrightness}) contrast(${imageContrast})`,
    willChange: "filter",
  };
  const imageAdjustmentDefault = Math.abs(imageBrightness - 1) < 0.001 && Math.abs(imageContrast - 1) < 0.001;
  const renderSeriesImageStack = (emptyClassName = "min-h-[260px]", zoomable = false) => (
    <div
      className="h-full w-full overflow-hidden"
      onWheel={event => {
        if (zoomable || !selectedSeriesImagePanel || selectedSeriesImagePanel.instances.length <= 1) return;
        event.preventDefault();
        moveSelectedSeriesImage(event.deltaY > 0 ? 1 : -1);
      }}
    >
      {!selectedSeriesImagePanel ? (
        <div className={`flex ${emptyClassName} w-full items-center justify-center bg-card text-center text-sm text-muted-foreground`}>
          Click a series above
        </div>
      ) : selectedSeriesImagePanel.loading && selectedSeriesImagePanel.instances.length === 0 ? (
        <div className={`flex ${emptyClassName} w-full items-center justify-center gap-3 bg-card text-sm text-muted-foreground`}>
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading...
        </div>
      ) : selectedSeriesImagePanel.instances.length === 0 ? (
        <div className={`flex ${emptyClassName} w-full items-center justify-center bg-card text-center text-sm text-muted-foreground`}>
          No image
        </div>
      ) : (() => {
        const index = Math.min(phoneImageIndex, selectedSeriesImagePanel.instances.length - 1);
        const instance = selectedSeriesImagePanel.instances[index];
            const sopInstanceUid = getSopInstanceUid(instance);
            const imageUrl =
              selectedHistoryStudy?.StudyInstanceUID &&
              selectedSeriesImagePanel.series.SeriesInstanceUID &&
              sopInstanceUid
                ? dicomWebService.getInstanceThumbnailUrl(
                    selectedHistoryStudy.StudyInstanceUID,
                    selectedSeriesImagePanel.series.SeriesInstanceUID,
                    sopInstanceUid
                  )
                : "";

            return (
        <div className="relative h-full min-h-full w-full bg-black">
              {imageUrl && (
                <div className="absolute left-2 top-2 z-30 flex h-8 items-center gap-1 overflow-hidden rounded-lg border border-white/10 bg-black/70 px-1 text-white/90 shadow-lg backdrop-blur">
                  <div
                    className="flex h-full w-7 items-center justify-center"
                    aria-label="Brightness and contrast: drag the image to adjust"
                    title="Drag over the image: horizontal for contrast, vertical for brightness"
                  >
                    <Sun className={cn("h-3.5 w-3.5 text-amber-300", imageWindowDragging && "animate-pulse text-amber-200")} />
                  </div>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md border-l border-white/10 text-white/55 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-35"
                    onClick={resetImageWindow}
                    disabled={imageAdjustmentDefault}
                    aria-label="Reset brightness and contrast"
                    title="Reset brightness and contrast"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>
              )}
              <div
                key={
                  zoomable
                    ? selectedSeriesImagePanel.series.SeriesInstanceUID
                    : sopInstanceUid || `${selectedSeriesImagePanel.series.SeriesInstanceUID}-${index}`
                }
                className={cn(
                  "relative flex h-full min-h-full w-full select-none items-center justify-center bg-black",
                  imageUrl && "cursor-crosshair",
                  !zoomable && selectedSeriesImagePanel.instances.length > 1 && "pb-12"
                )}
                data-testid="report-image-brightness-contrast-viewport"
                onPointerDown={beginImageWindowDrag}
                onPointerMove={moveImageWindowDrag}
                onPointerUp={endImageWindowDrag}
                onPointerCancel={endImageWindowDrag}
              >
                {imageUrl ? (
                  zoomable ? (
                    <>
                      <div className={cn("absolute inset-0", selectedSeriesImagePanel.instances.length > 1 && "bottom-14")}>
                        <TransformWrapper
                          key={sopInstanceUid || `phone-image-${index}`}
                          minScale={0.65}
                          maxScale={6}
                          initialScale={1}
                          centerOnInit
                          centerZoomedOut={false}
                          limitToBounds={false}
                          doubleClick={{ mode: "toggle" }}
                          pinch={{ step: 8, allowPanning: true }}
                          wheel={{ disabled: true }}
                          autoAlignment={{ disabled: true }}
                          velocityAnimation={{ disabled: true }}
                          panning={{ disabled: phoneImageTouchCount < 2, velocityDisabled: true }}
                          onTransformed={(_, state) => setPhoneImageScale(state.scale)}
                        >
                          {({ resetTransform }) => (
                            <div
                              className="relative h-full w-full"
                              style={{ touchAction: phoneImageTouchCount >= 2 ? "none" : "pan-y" }}
                              onTouchStart={event => setPhoneImageTouchCount(event.touches.length)}
                              onTouchMove={event => setPhoneImageTouchCount(event.touches.length)}
                              onTouchEnd={event => setPhoneImageTouchCount(event.touches.length)}
                              onTouchCancel={() => setPhoneImageTouchCount(0)}
                            >
                              <button
                                type="button"
                                className="absolute right-2 top-2 z-10 rounded-full bg-black/55 px-2 py-1 text-[10px] font-semibold text-white/80 backdrop-blur"
                                onClick={() => {
                                  resetTransform();
                                  setPhoneImageScale(1);
                                  setPhoneImageTouchCount(0);
                                }}
                              >
                                Reset
                              </button>
                              <TransformComponent
                                wrapperClass="!h-full !w-full"
                                contentClass="!h-full !w-full"
                              >
                                <img
                                  src={imageUrl}
                                  alt={`Image ${index + 1}`}
                                  className="h-full max-h-full w-full select-none object-contain"
                                  loading="lazy"
                                  draggable={false}
                                  style={imageWindowPreviewStyle}
                                />
                              </TransformComponent>
                            </div>
                          )}
                        </TransformWrapper>
                      </div>
                      {selectedSeriesImagePanel.instances.length > 1 && (
                        <div
                          className="absolute bottom-2 left-2 right-2 z-20 rounded-2xl bg-black/65 px-3 py-2 text-white/90 backdrop-blur"
                          style={{ touchAction: "none" }}
                          onMouseDown={event => event.stopPropagation()}
                          onPointerDown={event => event.stopPropagation()}
                          onTouchStart={event => event.stopPropagation()}
                          onClick={event => event.stopPropagation()}
                        >
                          <div className="mb-1 flex items-center justify-between text-[10px] font-semibold">
                            <span>Image {index + 1}</span>
                            <span>{selectedSeriesImagePanel.instances.length}</span>
                          </div>
                          <Slider
                            min={0}
                            max={Math.max(selectedSeriesImagePanel.instances.length - 1, 0)}
                            step={1}
                            value={[index]}
                            onValueChange={value => {
                              setPhoneImageScale(1);
                              setPhoneImageIndex(value[0] ?? 0);
                            }}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <img
                      src={imageUrl}
                      alt={`Image ${index + 1}`}
                      className="h-full max-h-full w-full object-contain"
                      loading="lazy"
                      draggable={false}
                      style={imageWindowPreviewStyle}
                    />
                  )
                ) : (
                  <div className="flex h-full min-h-24 items-center justify-center text-xs text-slate-300">
                    Image unavailable
                  </div>
                )}
              </div>
          {!zoomable && selectedSeriesImagePanel.instances.length > 1 && (
            <div className="absolute bottom-2 left-2 right-2 z-20 rounded-2xl bg-black/65 px-3 py-2 text-white/90 backdrop-blur">
              <div className="mb-1 flex items-center justify-between text-[10px] font-semibold">
                <span>Image {index + 1}</span>
                <span>{selectedSeriesImagePanel.instances.length}</span>
              </div>
              <Slider
                min={0}
                max={Math.max(selectedSeriesImagePanel.instances.length - 1, 0)}
                step={1}
                value={[index]}
                onValueChange={value => setPhoneImageIndex(value[0] ?? 0)}
              />
            </div>
          )}
        </div>
            );
      })()}
    </div>
  );

  const mobileHistoryDialog = (
    <Dialog open={mobileHistoryOpen} onOpenChange={setMobileHistoryOpen}>
      <DialogContent className="flex h-[92dvh] w-[calc(100vw-1rem)] max-w-[900px] flex-col overflow-hidden rounded-2xl p-0 sm:h-[88dvh] [&>button]:right-4 [&>button]:top-4">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle className="text-base">Patient History</DialogTitle>
          <DialogDescription className="text-xs">{study?.PatientName || "-"} - {study?.PatientID || "-"}</DialogDescription>
        </DialogHeader>
        <div className="report-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {historyLoading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading patient history...</div>
          ) : patientHistory.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No prior study found for this patient.</div>
          ) : (
            <div className="space-y-3">
              {patientHistory.map(item => {
                const isActive = selectedHistoryStudyUid === item.StudyInstanceUID;
                const isCurrentReport = item.StudyInstanceUID === study?.StudyInstanceUID;
                return (
                  <div key={item.StudyInstanceUID} className={cn("overflow-hidden rounded-2xl border bg-card transition", isActive ? "border-emerald-400 bg-emerald-500/10" : "border-border")}>
                    <button type="button" onClick={() => setSelectedHistoryStudyUid(isActive ? "" : item.StudyInstanceUID)} className="w-full p-3 text-left">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-foreground">{item.StudyDescription || "-"}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{formatStudyDateTime(item.StudyDate, item.StudyTime)}</span>
                            <span>Acc {item.AccessionNumber || "-"}</span>
                            {isCurrentReport && <Badge className="h-5 rounded-full px-2 text-[9px]">Current</Badge>}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant="outline" className="rounded-full">{item.ModalityCode || "-"}</Badge>
                          {isActive ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                        </div>
                      </div>
                    </button>
                    {isActive && (
                      <div className="space-y-3 border-t p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {viewerConfigs.filter(viewer => isViewerAllowedForModality(viewer, item.ModalityCode)).map(viewer => (
                            <Button key={viewer.id} type="button" size="sm" className="h-8 rounded-xl text-xs" onClick={() => openViewerInNamedWindow(viewer, item.StudyInstanceUID, { accessionNumber: item.AccessionNumber, patientId: item.PatientID })}>
                              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                              {getViewerButtonLabel(viewer)}
                            </Button>
                          ))}
                        </div>
                        {historyReportLoading ? (
                          <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading report history...</div>
                        ) : selectedHistoryReport ? (
                          <>
                            <section className="rounded-xl border bg-background/70 p-3">
                              <div className="flex items-center justify-between gap-2"><div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Findings</div><Button variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0" onClick={() => copyHistorySection("Findings", selectedHistoryReport.findings)}><Copy className="h-3.5 w-3.5" /></Button></div>
                              <div className="mt-2 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: selectedHistoryReport.findings || "-" }} />
                            </section>
                            <section className="rounded-xl border bg-background/70 p-3">
                              <div className="flex items-center justify-between gap-2"><div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Conclusion</div><Button variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0" onClick={() => copyHistorySection("Conclusion", selectedHistoryReport.conclusion)}><Copy className="h-3.5 w-3.5" /></Button></div>
                              <div className="mt-2 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: selectedHistoryReport.conclusion || "-" }} />
                            </section>
                          </>
                        ) : (
                          <div className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">No report history found for this study.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );

  if (phoneMode) {
    return (
      <div className="report-command-surface flex h-screen flex-col overflow-hidden text-foreground">
        <div className="shrink-0 border-b border-border/60 bg-background/95 px-2 py-1.5 backdrop-blur">
          <div className="mx-auto flex max-w-[430px] items-center justify-between gap-2 md:max-w-[900px]">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">{study?.PatientName || "-"}</div>
              <div className="truncate text-[10px] text-muted-foreground">
                {study?.StudyDescription || "-"} - {study?.ModalityCode || "-"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {mobileHeaderViewerConfigs.map(viewer => (
                <Button
                  key={viewer.id}
                  type="button"
                  size="sm"
                  className="h-7 rounded-full border border-cyan-200/35 bg-gradient-to-r from-cyan-500 to-blue-600 px-2 text-[10px] font-semibold text-white shadow-[0_8px_20px_rgba(14,165,233,0.22)] hover:from-cyan-400 hover:to-blue-500 hover:text-white"
                  onClick={async () => {
                    try {
                      if (!selectedHistoryStudy?.StudyInstanceUID) return;
                      await openViewerInNamedWindow(viewer, selectedHistoryStudy.StudyInstanceUID, {
                        accessionNumber: selectedHistoryStudy.AccessionNumber,
                        patientId: selectedHistoryStudy.PatientID,
                      });
                      if (viewer.type === "inobitec-rpc") {
                        toast({ title: "Inobitec command sent" });
                      }
                    } catch (error) {
                      toast({
                        title: "Failed to open Mobility",
                        description:
                          error instanceof Error ? error.message : "Mobility viewer configuration is invalid.",
                        variant: "destructive",
                      });
                    }
                  }}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  {getViewerButtonLabel(viewer)}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 rounded-full px-2 text-[10px] font-semibold"
                onClick={() => setMobileHistoryOpen(true)}
              >
                <History className="mr-1 h-3.5 w-3.5" />
                History
              </Button>
            </div>
          </div>
        </div>

        <main className="mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col gap-2 px-2 py-2 md:max-w-[900px] md:gap-3 md:px-3">
          <section className="shrink-0 overflow-hidden rounded-[1.35rem] border border-border bg-card shadow-sm">
            <div className="border-b border-border bg-background/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Series
            </div>
            <StudySeriesPreviewPanel
              item={selectedPreviewItem}
              compact
              micro
              enableViewerBrightnessContrast
              selectedSeriesId={selectedSeriesImagePanel?.series.SeriesInstanceUID}
              onSeriesSelect={payload => {
                setSelectedSeriesImagePanel(payload);
                setPhoneImageIndex(payload.imageIndex ?? 0);
                setShowPhoneImageView(true);
              }}
              className="h-[94px] rounded-none border-0 bg-transparent shadow-none"
            />
          </section>

          <section className="shrink-0 overflow-hidden rounded-[1.35rem] border border-border bg-card shadow-sm">
            <div className="border-b border-border bg-background/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Image View
            </div>
            <div
              className={cn(
                "relative overflow-hidden bg-black transition-[height,min-height,opacity] duration-300 ease-in-out",
                showPhoneImageView ? "h-[35dvh] min-h-[230px] opacity-100 md:h-[38dvh] md:min-h-[280px]" : "h-0 min-h-0 opacity-0"
              )}
            >
                {renderSeriesImageStack("min-h-[230px]", true)}
                <button
                  type="button"
                  className="absolute bottom-1.5 left-1/2 z-30 inline-flex h-7 w-7 -translate-x-1/2 items-center justify-center text-white/75 transition duration-200 hover:-translate-y-0.5 hover:text-white"
                  onClick={() => setShowPhoneImageView(false)}
                  title="Collapse image view"
                >
                  <ChevronUp className="h-4 w-4" />
                  <span className="sr-only">Collapse image view</span>
                </button>
            </div>
            {!showPhoneImageView && (
              <button
                type="button"
                className="flex w-full items-center justify-center px-3 py-1.5 text-muted-foreground transition duration-200 hover:translate-y-0.5 hover:text-foreground"
                onClick={() => setShowPhoneImageView(true)}
                title="Expand image view"
              >
                <ChevronDown className="h-4 w-4" />
                <span className="sr-only">Expand image view</span>
              </button>
            )}
          </section>

          <div className="report-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pb-20">
            <section className="rounded-[1.35rem] border border-border bg-card p-2.5 shadow-sm">
              <div className="flex items-center gap-2">
                <Popover open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="h-9 min-w-0 flex-1 justify-between rounded-xl px-3 text-xs"
                      disabled={!canEdit || templateLoading || templates.length === 0}
                    >
                      <span className="truncate">
                        {templateLoading
                          ? "Loading templates..."
                          : templates.length === 0
                            ? "No templates"
                            : selectedTemplate?.title ?? "Select Template"}
                      </span>
                      <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[min(360px,calc(100vw-2rem))] p-0" align="center">
                    <Command>
                      <CommandInput placeholder="Search template..." />
                      <CommandList>
                        <CommandEmpty>Template not found.</CommandEmpty>
                        <CommandGroup>
                          {templates.map(template => (
                            <CommandItem
                              key={template.id}
                              value={`${template.id}:${template.title}`}
                              onSelect={() => handleSelectTemplate(template)}
                            >
                              <Check
                                className={`mr-2 h-4 w-4 ${
                                  selectedTemplateId === template.id ? "opacity-100" : "opacity-0"
                                }`}
                              />
                              <span className="truncate">{template.title}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-xl"
                  onClick={() => setTemplateDialogOpen(true)}
                  disabled={!user?.username || templateSaving}
                  title="Save current report as template"
                >
                  <BookmarkPlus className="h-4 w-4" />
                </Button>
              </div>
            </section>

            <section className="rounded-[1.35rem] border border-border bg-card p-2.5 shadow-sm">
              <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Findings
              </label>
              <div className="mt-1.5 overflow-hidden rounded-xl bg-background">
                <TinyRichTextEditor value={findings} onChange={setFindings} disabled={!canEdit} height={220} autoResize />
              </div>
            </section>

            <section className="rounded-[1.35rem] border border-border bg-card p-2.5 shadow-sm">
              <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Conclusion
              </label>
              <div className="mt-1.5 overflow-hidden rounded-xl bg-background">
                <TinyRichTextEditor value={conclusion} onChange={setConclusion} disabled={!canEdit} height={220} autoResize />
              </div>
            </section>
          </div>
        </main>

        <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-cyan-300/15 bg-slate-950/84 px-3 py-2 shadow-[0_-18px_44px_rgba(8,47,73,0.24)] backdrop-blur-xl">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
          <div className="mx-auto flex max-w-[900px] items-center gap-2">
            <label className={cn(
              "flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-xl border px-3 text-xs font-black tracking-wide",
              isCritical ? "border-red-400/70 bg-red-500/20 text-red-100" : "border-slate-600/70 bg-slate-900/70 text-slate-300",
              !canEdit && "cursor-not-allowed opacity-70"
            )}>
              <Checkbox checked={isCritical} onCheckedChange={value => setIsCritical(Boolean(value))} disabled={!canEdit || saving} />
              KRITIS
            </label>
            <div className={cn("grid min-w-0 flex-1 gap-2", status === "final" ? "grid-cols-4" : "grid-cols-3")}>
            {status === "final" && (
              <Button
                className={cn("h-10 font-semibold", reportActionButtonClass.revise)}
                onClick={handleRevise}
                disabled={!canUseRevision || saving}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Revise
              </Button>
            )}
            <Button
              className={cn("h-10 font-semibold", reportActionButtonClass.draft)}
              onClick={handleSaveDraft}
              disabled={!canEdit || saving || isReportBlank}
            >
              <Save className="mr-2 h-4 w-4" />
              Draft
            </Button>
            <Button
              className={cn("h-10 font-semibold", reportActionButtonClass.save)}
              onClick={handleFinalize}
              disabled={!canFinalize || saving || isReportBlank}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Save
            </Button>
            <Button className={cn("h-10 font-semibold", reportActionButtonClass.close)} onClick={() => navigate("/reporting")}>
              <X className="mr-2 h-4 w-4" />
              Close
            </Button>
            </div>
          </div>
        </div>
        {mobileHistoryDialog}
      </div>
    );
  }

  return (
    <div
      ref={desktopCanvasScrollRef}
      onPointerDown={beginDesktopCanvasPan}
      onPointerMove={moveDesktopCanvasPan}
      onPointerUp={endDesktopCanvasPan}
      onPointerCancel={endDesktopCanvasPan}
      className={cn(
        "report-command-surface text-foreground",
        tabletDesktopFitMode
          ? "fixed inset-0 z-30 h-dvh w-dvw overflow-x-hidden overflow-y-auto pb-28"
          : desktopCanvasMode
          ? "fixed inset-0 z-30 h-dvh w-dvw cursor-grab overflow-scroll overscroll-contain active:cursor-grabbing [-webkit-overflow-scrolling:touch] [touch-action:none]"
          : "h-dvh overflow-x-hidden overflow-y-auto pb-28"
      )}
    >
      <div className="fixed bottom-[5.4rem] left-0 z-50 flex -translate-x-[2.55rem] items-center gap-1 rounded-tr-2xl border border-b-0 border-l-0 border-primary/20 bg-background/90 p-1.5 shadow-xl backdrop-blur transition-transform duration-200 hover:translate-x-0">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 rounded-xl border-primary/20 bg-transparent hover:bg-card"
          onClick={resetReportLayout}
          title="Reset panel visibility"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span className="sr-only">Reset panel visibility</span>
        </Button>
      </div>

      {hasHiddenPanels && (
        <div className="fixed left-1/2 top-0 z-50 flex -translate-x-1/2 items-start gap-1.5 px-3">
              {!showStudyNavigator && (
                <button
                  type="button"
                  className={hiddenPanelButtonClass}
                  onClick={() => setShowStudyNavigator(true)}
                >
                  Study
                </button>
              )}
              {!showPatientInfo && (
                <button
                  type="button"
                  className={hiddenPanelButtonClass}
                  onClick={() => setShowPatientInfo(true)}
                >
                  Patient
                </button>
              )}
              {!showReportHistory && (
                <button
                  type="button"
                  className={hiddenPanelButtonClass}
                  onClick={() => setShowReportHistory(true)}
                >
                  History
                </button>
              )}
              {!showImagePreview && (
                <button
                  type="button"
                  className={hiddenPanelButtonClass}
                  onClick={() => setShowImagePreview(true)}
                >
                  Images
                </button>
              )}
        </div>
      )}

      {false && (
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="flex flex-col gap-4 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-lg font-semibold">Reporting</h1>
              <p className="text-xs text-muted-foreground">
                {study?.PatientName || "-"} â€¢ {study?.StudyDescription || "-"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
            {viewerConfigs.filter(viewer => isViewerAllowedForModality(viewer, selectedHistoryStudy?.ModalityCode)).map(viewer => (
              <Button
                key={viewer.id}
                className="w-full rounded-xl gradient-medical border-0 sm:w-auto"
                onClick={async () => {
                  try {
                    if (!selectedHistoryStudy?.StudyInstanceUID) return;
                    await openViewerInNamedWindow(viewer, selectedHistoryStudy.StudyInstanceUID, {
                      accessionNumber: selectedHistoryStudy.AccessionNumber,
                      patientId: selectedHistoryStudy.PatientID,
                    });
                    if (viewer.type === "inobitec-rpc") {
                      toast({ title: "Inobitec command sent" });
                    }
                  } catch (error) {
                    toast({
                      title: "Failed to open viewer",
                      description:
                        error instanceof Error ? error.message : "Viewer configuration is invalid.",
                      variant: "destructive",
                    });
                  }
                }}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                {getViewerButtonLabel(viewer)}
              </Button>
            ))}
          </div>
        </div>
      </div>
      )}

      <div
        className={cn(tabletDesktopFitMode && "origin-top-left")}
        style={
          tabletDesktopFitMode
            ? {
                width: 1440,
                height: tabletDesktopCanvasHeight,
                transform: `scale(${tabletDesktopFitScale})`,
                transformOrigin: "top left",
              }
            : undefined
        }
      >
        <div
          className={cn(
            "relative flex min-h-[calc(100dvh-11rem)] flex-col gap-4 overflow-hidden p-4 pb-32",
            desktopCanvasMode && "h-auto min-h-[900px] w-[1440px] min-w-[1440px] overflow-visible p-6 pb-32"
          )}
          style={
            tabletDesktopFitMode
              ? {
                  height: Math.max(tabletDesktopCanvasHeight - REPORT_FOOTER_OFFSET, 812),
                  minHeight: Math.max(tabletDesktopCanvasHeight - REPORT_FOOTER_OFFSET, 812),
                }
              : undefined
          }
        >
        {showStudyNavigator && (
        <div
          className={cn(
            "report-glass-panel relative grid h-[170px] min-h-[118px] min-w-0 rounded-2xl border border-border shadow-sm",
            desktopCanvasMode ? "grid-cols-[360px_1fr]" : "xl:grid-cols-[360px_1fr]",
            resizablePanelClass
          )}
          style={getPanelSizeStyle("study")}
        >
          <section className="min-h-0 overflow-hidden border-b border-border bg-muted/20 xl:border-b-0 xl:border-r">
            <div className="grid grid-cols-[1fr_76px] border-b border-border bg-background/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Study History</span>
              <span className="text-right">Modality</span>
            </div>

            <div className="report-scrollbar h-[calc(100%-2.25rem)] min-h-[72px] overflow-y-auto">
              {patientHistory.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No prior study found for this patient.
                </div>
              ) : (
                patientHistory.map(item => {
                  const isActive = selectedHistoryStudyUid === item.StudyInstanceUID;
                  const isCurrentReport = item.StudyInstanceUID === study?.StudyInstanceUID;
                  return (
                    <button
                      key={item.StudyInstanceUID}
                      type="button"
                      onClick={() => setSelectedHistoryStudyUid(item.StudyInstanceUID)}
                      className={`grid w-full grid-cols-[1fr_76px] items-center gap-2 border-b border-border/70 px-3 py-2 text-left transition ${
                        isActive
                          ? "bg-emerald-500/15 text-foreground"
                          : "bg-transparent hover:bg-muted/40"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${isActive ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                          <div className="truncate text-xs font-semibold">
                            {item.StudyDescription || "-"}
                          </div>
                        </div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-2 pl-4 text-[11px] text-muted-foreground">
                          <span>{formatStudyDateTime(item.StudyDate, item.StudyTime)}</span>
                          <span className="truncate">Acc {item.AccessionNumber || "-"}</span>
                          {isCurrentReport && (
                            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 dark:text-emerald-200">Current</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-xs font-semibold text-muted-foreground">
                        {item.ModalityCode || "-"}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <section className="min-h-0 min-w-0 overflow-hidden bg-background/50">
            <div className="flex h-9 items-center justify-between gap-3 border-b border-border bg-background/70 px-3 text-xs">
              <div className="min-w-0 truncate font-semibold">
                {selectedHistoryStudy?.StudyDescription || "Select a study"}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
                <span>{selectedHistoryStudy?.ModalityCode || "-"} - {selectedHistoryStudy?.NumberOfStudyRelatedSeries || 0} series</span>
                {viewerConfigs.filter(viewer => isViewerAllowedForModality(viewer, selectedHistoryStudy?.ModalityCode)).map(viewer => (
                  <Button
                    key={viewer.id}
                    size="sm"
                    className="h-7 rounded-lg border-0 px-2 text-[11px] gradient-medical"
                    onClick={async () => {
                      try {
                        if (!selectedHistoryStudy?.StudyInstanceUID) return;
                        await openViewerInNamedWindow(viewer, selectedHistoryStudy.StudyInstanceUID, {
                          accessionNumber: selectedHistoryStudy.AccessionNumber,
                          patientId: selectedHistoryStudy.PatientID,
                        });
                        if (viewer.type === "inobitec-rpc") {
                          toast({ title: "Inobitec command sent" });
                        }
                      } catch (error) {
                        toast({
                          title: "Failed to open viewer",
                          description:
                            error instanceof Error ? error.message : "Viewer configuration is invalid.",
                          variant: "destructive",
                        });
                      }
                    }}
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    {getViewerButtonLabel(viewer)}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 rounded-lg p-0 text-muted-foreground"
                  onClick={() => setShowStudyNavigator(false)}
                  title="Hide study history and series"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <StudySeriesPreviewPanel
              item={selectedPreviewItem}
              compact
              enableViewerBrightnessContrast
              selectedSeriesId={selectedSeriesImagePanel?.series.SeriesInstanceUID}
              onSeriesSelect={payload => {
                setSelectedSeriesImagePanel(payload);
                setPhoneImageIndex(payload.imageIndex ?? 0);
              }}
              className="h-[calc(100%-2.25rem)] min-h-[72px] rounded-none border-0 bg-transparent shadow-none"
            />
          </section>
        </div>
        )}

        <div className={cn(
          "relative min-h-0 flex-1",
          stackedDesktopLayout ? "report-scrollbar overflow-y-auto overflow-x-hidden pb-4 pr-1" : "overflow-hidden"
        )}>
        <div
          className={cn(
            "relative flex h-full min-h-0 gap-4",
            stackedDesktopLayout ? "overflow-visible" : "overflow-hidden",
            desktopCanvasMode
              ? "flex-row items-start"
              : stackedDesktopLayout
                ? "flex-col"
                : "flex-col xl:flex-row xl:items-start"
          )}
        >
        {showPatientInfo && (
        <aside
          className={cn(
            "report-glass-panel relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border p-5 shadow-sm",
            desktopCanvasMode
              ? "h-full w-[320px] min-w-[260px] max-w-[760px]"
              : stackedDesktopLayout
                ? "w-full min-w-0 flex-none"
                : "w-full xl:h-full xl:w-[320px] xl:min-w-[260px] xl:max-w-[760px]",
            resizablePanelClass
          )}
          style={getPanelSizeStyle("patient")}
        >
          <div
            className="flex items-center justify-between"
            title="Patient information"
          >
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Patient Info
            </h2>
            <div className="flex items-center gap-2">
              <Badge className="rounded-full border-border bg-muted/50 text-foreground">
                {status === "final" ? "Final" : status === "draft" ? "Draft" : "New"}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-lg p-0 text-muted-foreground"
                onClick={() => setShowPatientInfo(false)}
                title="Hide patient info"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="report-scrollbar mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-2 pb-28 text-sm">
            {[
              ["Patient ID", study?.PatientID || "-"],
              ["Patient Name", study?.PatientName || "-"],
              ["DOB", formatDicomDate(study?.PatientBirthDate || orderContext?.tanggal_lahir)],
              ["Gender", study?.PatientSex || orderContext?.kelamin || "-"],
              ["Address", formatAddress(orderContext)],
              ["Accession", orderContext?.accession_number || study?.AccessionNumber || "-"],
              ["Modality", study?.ModalityCode || "-"],
              ["Study Description", study?.StudyDescription || "-"],
              ["Study Date", formatDicomDate(study?.StudyDate) || "-"],
              ["Referring Physician", study?.ReferringPhysicianName || orderContext?.nama_dokter || orderContext?.referring_doctor_name || "-"],
              ["Reporting", radiologistName || user?.fullName || "-"],
              ["Radiographer", orderContext?.nama_radiografer || orderContext?.technologist_name || "-"],
              ["Origin Room", formatOriginRoom(orderContext)],
              ["Last Updated", updatedAt ? formatDate(updatedAt) : "-"],
              ["Clinical Information", clinicalInfo || "-"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-3">
                <div className="text-muted-foreground">{label}</div>
                <div className="max-w-[58%] text-right font-medium text-foreground">{value}</div>
              </div>
            ))}
          </div>
        </aside>
        )}

        <div
          className={cn(
            "report-glass-panel relative flex min-h-[220px] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border p-5 shadow-sm",
            desktopCanvasMode
              ? "h-full basis-[760px] grow"
              : stackedDesktopLayout
                ? "w-full flex-none"
                : "xl:h-full xl:basis-[760px] xl:grow",
            resizablePanelClass
          )}
          style={getPanelSizeStyle("report")}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden">
            <div
              className="flex shrink-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"
              title="Report workspace"
            >
              <TabsList className="rounded-xl bg-muted/60 p-1">
                <TabsTrigger className="rounded-lg px-4" value="report">
                  Report
                </TabsTrigger>
                <TabsTrigger className="rounded-lg px-4" value="revisions">
                  Revisions ({revisions.length})
                </TabsTrigger>
              </TabsList>
              <div className="flex min-w-0 flex-wrap gap-2 xl:justify-end">
                <Popover open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="min-w-0 flex-1 justify-between rounded-xl xl:min-w-[220px] xl:flex-none xl:w-64"
                      disabled={!canEdit || templateLoading || templates.length === 0}
                    >
                      <span className="truncate">
                        {templateLoading
                          ? "Loading templates..."
                          : templates.length === 0
                            ? "No templates"
                            : selectedTemplate?.title ?? "Select Template"}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[280px] p-0" align="end">
                    <Command>
                      <CommandInput placeholder="Search template..." />
                      <CommandList>
                        <CommandEmpty>Template not found.</CommandEmpty>
                        <CommandGroup>
                          {templates.map(template => (
                            <CommandItem
                              key={template.id}
                              value={`${template.id}:${template.title}`}
                              onSelect={() => handleSelectTemplate(template)}
                            >
                              <Check
                                className={`mr-2 h-4 w-4 ${
                                  selectedTemplateId === template.id ? "opacity-100" : "opacity-0"
                                }`}
                              />
                              <span className="truncate">{template.title}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <Button
                  variant="outline"
                  className="shrink-0 rounded-xl"
                  onClick={() => setTemplateDialogOpen(true)}
                  disabled={!user?.username || templateSaving}
                >
                  <BookmarkPlus className="mr-2 h-4 w-4" />
                  Save Template
                </Button>
              </div>
            </div>
            <TabsContent value="report" className="mt-0 min-h-0 flex-1 overflow-hidden">
              <div className="report-scrollbar min-h-0 h-full space-y-6 overflow-y-auto pr-2 pb-36">
                <div className="report-scrollbar min-h-[120px] resize-y overflow-auto rounded-xl border border-border/60 bg-background p-4">
                  <label className="text-sm font-semibold text-muted-foreground">Findings</label>
                  <div className="mt-2">
                    <TinyRichTextEditor
                      value={findings}
                      onChange={setFindings}
                      disabled={!canEdit}
                    />
                  </div>
                </div>

                <div className="report-scrollbar min-h-[120px] resize-y overflow-auto rounded-xl border border-border/60 bg-background p-4">
                  <label className="text-sm font-semibold text-muted-foreground">
                    Conclusion / Impression
                  </label>
                  <div className="mt-2">
                    <TinyRichTextEditor
                      value={conclusion}
                      onChange={setConclusion}
                      disabled={!canEdit}
                    />
                  </div>
                </div>
              </div>

                <aside className="hidden rounded-xl border border-border/60 bg-background p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-foreground">Prior Expertise</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Based on selected study history
                      </div>
                    </div>
                    <Badge className="rounded-full border-border bg-muted/50 text-foreground">
                      {selectedHistoryReport?.status === "final"
                        ? "Final"
                        : selectedHistoryReport?.status === "draft"
                          ? "Draft"
                          : "No Report"}
                    </Badge>
                  </div>

                  <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-3">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {selectedHistoryStudy?.StudyDescription || "-"}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatStudyDateTime(selectedHistoryStudy?.StudyDate, selectedHistoryStudy?.StudyTime)}
                      {" Â· "}
                      {selectedHistoryStudy?.ModalityCode || "-"}
                    </div>
                  </div>

                  {historyReportLoading ? (
                    <div className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                      Loading expertise history...
                    </div>
                  ) : selectedHistoryReport ? (
                    <div className="mt-4 space-y-4">
                      <div className="grid grid-cols-1 gap-3 text-sm">
                        <div className="rounded-xl border border-border/60 bg-card/70 p-3">
                          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                            Radiologist
                          </div>
                          <div className="mt-1 font-semibold text-foreground">
                            {selectedHistoryReport.radiologist_name || "-"}
                          </div>
                        </div>
                        <div className="rounded-xl border border-border/60 bg-card/70 p-3">
                          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                            Report Date
                          </div>
                          <div className="mt-1 font-semibold text-foreground">
                            {formatDate(selectedHistoryReport.finalized_at || selectedHistoryReport.updated_at)}
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          Findings
                        </div>
                        <div
                          className="report-scrollbar mt-2 max-h-[280px] overflow-y-auto rounded-xl border border-border/60 bg-card/70 p-3 text-sm leading-relaxed text-foreground"
                          dangerouslySetInnerHTML={{
                            __html: selectedHistoryReport.findings || "-",
                          }}
                        />
                      </div>

                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          Conclusion
                        </div>
                        <div
                          className="report-scrollbar mt-2 max-h-[220px] overflow-y-auto rounded-xl border border-border/60 bg-card/70 p-3 text-sm leading-relaxed text-foreground"
                          dangerouslySetInnerHTML={{
                            __html: selectedHistoryReport.conclusion || "-",
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                      No previous expertise found for the selected study.
                    </div>
                  )}
                </aside>
            </TabsContent>
            <TabsContent value="revisions" className="mt-0 min-h-0 flex-1 overflow-hidden">
              {revisions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                  No revisions yet.
                </div>
              ) : (
                <div className="report-scrollbar h-full space-y-4 overflow-y-auto pr-2 pb-28">
                  {revisions.map(revision => (
                    <div
                      key={revision.id}
                      className="rounded-xl border border-border/70 bg-background p-4 space-y-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold">
                            {formatDate(revision.created_at)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {revision.radiologist_name || "Reporting"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className="border-border bg-muted/50 text-foreground">
                            {revision.status === "final" ? "Final" : "Draft"}
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-lg"
                            onClick={() => handleUseRevision(revision)}
                            disabled={!canUseRevision}
                          >
                            Use this revision
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-3 text-sm">
                        <div>
                          <div className="text-muted-foreground">Clinical Information</div>
                          <div className="mt-1 whitespace-pre-wrap">
                            {revision.clinical_info || "-"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Findings</div>
                          <div
                            className="mt-1 leading-relaxed"
                            dangerouslySetInnerHTML={{
                              __html: revision.findings || "-",
                            }}
                          />
                        </div>
                        <div>
                          <div className="text-muted-foreground">Conclusion / Impression</div>
                          <div
                            className="mt-1 leading-relaxed"
                            dangerouslySetInnerHTML={{
                              __html: revision.conclusion || "-",
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>

        {showReportHistory && (
        <aside
          className={cn(
            "report-glass-panel relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border p-5 shadow-sm",
            desktopCanvasMode
              ? "h-full w-[380px] min-w-[300px] max-w-[760px]"
              : stackedDesktopLayout
                ? "w-full min-w-0 flex-none"
                : "w-full xl:h-full xl:w-[380px] xl:min-w-[300px] xl:max-w-[760px]",
            resizablePanelClass
          )}
          style={getPanelSizeStyle("history")}
        >
          <div
            className="flex items-start justify-between gap-3"
            title="Report history"
          >
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                REPORT HISTORY
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-lg p-0 text-muted-foreground"
                onClick={() => setShowReportHistory(false)}
                title="Hide report history"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="report-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto pr-2 pb-28">
          {historyReportLoading ? (
            <div className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Loading report history...
            </div>
          ) : selectedHistoryReport ? (
            <div className="mt-5 space-y-5">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Study
                </div>
                <div className="mt-2 text-base font-semibold leading-relaxed text-foreground">
                  {selectedHistoryStudy?.StudyDescription || "-"} - {formatDicomDate(selectedHistoryStudy?.StudyDate)} - {selectedHistoryStudy?.ModalityCode || "-"} - {selectedHistoryReport.radiologist_name || "-"}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Findings
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 rounded-lg p-0"
                    onClick={() => copyHistorySection("Findings", selectedHistoryReport.findings)}
                    title="Copy findings"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div
                  className="report-scrollbar mt-3 max-h-[220px] overflow-y-auto text-sm leading-relaxed text-foreground"
                  dangerouslySetInnerHTML={{
                    __html: selectedHistoryReport.findings || "-",
                  }}
                />

                <div className="mt-5 flex items-center justify-between gap-2 border-t border-border/60 pt-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Conclusion
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 rounded-lg p-0"
                    onClick={() => copyHistorySection("Conclusion", selectedHistoryReport.conclusion)}
                    title="Copy conclusion"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div
                  className="report-scrollbar mt-3 max-h-[180px] overflow-y-auto text-sm leading-relaxed text-foreground"
                  dangerouslySetInnerHTML={{
                    __html: selectedHistoryReport.conclusion || "-",
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No report history found for the selected study.
            </div>
          )}
          </div>
        </aside>
        )}

        {showImagePreview && (
        <aside
          className={cn(
            "relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-black shadow-sm",
            desktopCanvasMode
              ? "h-full w-[320px] min-w-[120px] max-w-[920px]"
              : stackedDesktopLayout
                ? "w-full min-w-0 flex-none"
                : "w-full xl:h-full xl:w-[320px] xl:min-w-[120px] xl:max-w-[920px]"
          )}
          style={getPanelSizeStyle("images")}
        >
          <button
            type="button"
            className="absolute right-2 top-2 z-30 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white/80 backdrop-blur transition hover:bg-black/80 hover:text-white"
            onClick={() => setShowImagePreview(false)}
            title="Hide image preview"
          >
            <X className="h-4 w-4" />
          </button>
          {renderSeriesImageStack("h-full")}
        </aside>
        )}
      </div>
      </div>
      </div>
      </div>
      <div
        className={cn(
          "z-20 border-t border-cyan-300/15 bg-slate-950/84 px-6 py-4 shadow-[0_-18px_48px_rgba(8,47,73,0.24)] backdrop-blur-xl",
          tabletDesktopFitMode
            ? "fixed bottom-0 left-0 right-0"
            : desktopCanvasMode
            ? "sticky bottom-0 left-0 w-[1440px] min-w-[1440px]"
            : "fixed bottom-0 left-0 right-0"
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className={cn(
            "flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-xl border px-4 text-sm font-black tracking-wide transition-colors",
            isCritical
              ? "border-red-400/70 bg-red-500/20 text-red-100 shadow-[0_0_20px_rgba(239,68,68,0.18)]"
              : "border-slate-600/70 bg-slate-900/70 text-slate-300",
            !canEdit && "cursor-not-allowed opacity-70"
          )}>
            <Checkbox checked={isCritical} onCheckedChange={value => setIsCritical(Boolean(value))} disabled={!canEdit || saving} />
            KRITIS
          </label>
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          {status === "final" && (
            <Button
              className={cn("w-full font-semibold sm:w-auto", reportActionButtonClass.revise)}
              onClick={handleRevise}
              disabled={!canUseRevision || saving}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Revise
            </Button>
          )}
          <Button
            className={cn("w-full font-semibold sm:w-auto", reportActionButtonClass.draft)}
            onClick={handleSaveDraft}
            disabled={!canEdit || saving || isReportBlank}
          >
            <Save className="mr-2 h-4 w-4" />
            Draft
          </Button>
          <Button
            className={cn("w-full font-semibold sm:w-auto", reportActionButtonClass.save)}
            onClick={handleFinalize}
            disabled={!canFinalize || saving || isReportBlank}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Save
          </Button>
          {status !== "none" && (
            <Button
              className={cn("w-full font-semibold sm:w-auto", reportActionButtonClass.print)}
              onClick={openPrintWindow}
              disabled={!canPrint}
            >
              <Printer className="mr-2 h-4 w-4" />
              Print
            </Button>
          )}
          <Button
            className={cn("w-full font-semibold sm:w-auto", reportActionButtonClass.close)}
            onClick={() => navigate("/reporting")}
          >
            <X className="mr-2 h-4 w-4" />
            Close
          </Button>
          </div>
        </div>
      </div>

      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Save reporting template</DialogTitle>
            <DialogDescription>
              The template will capture the current Findings and Conclusion text.
            </DialogDescription>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="rounded-full border border-border px-2 py-0.5 font-semibold">
                {currentTemplateContext.modalityCode || "All modalities"}
              </span>
              <span className="truncate">
                {currentTemplateContext.procedureDescription || "All procedures"}
                {currentTemplateContext.procedureCode ? ` · ${currentTemplateContext.procedureCode}` : ""}
              </span>
            </div>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <label className="text-sm font-semibold text-muted-foreground">Template title</label>
              <Input
                value={templateTitle}
                onChange={event => setTemplateTitle(event.target.value)}
                placeholder="Example: Thorax Normal"
              />
            </div>
            <div className="rounded-xl border border-border/60 bg-background p-4">
              <label className="text-sm font-semibold text-muted-foreground">Findings</label>
              <div className="mt-2">
                <TinyRichTextEditor
                  value={templateFindings}
                  onChange={setTemplateFindings}
                  disabled={templateSaving}
                />
              </div>
            </div>
            <div className="rounded-xl border border-border/60 bg-background p-4">
              <label className="text-sm font-semibold text-muted-foreground">
                Conclusion / Impression
              </label>
              <div className="mt-2">
                <TinyRichTextEditor
                  value={templateConclusion}
                  onChange={setTemplateConclusion}
                  disabled={templateSaving}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => setTemplateDialogOpen(false)}
              disabled={templateSaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="rounded-xl bg-emerald-500 text-white hover:bg-emerald-400"
              onClick={handleSaveTemplate}
              disabled={templateSaving}
            >
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RadiologistReport;
