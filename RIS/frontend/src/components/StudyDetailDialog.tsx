import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorklistItem } from "@/data/mockData";
import {
  ExternalLink,
  Pencil,
  Trash2,
  User,
  Calendar,
  FileImage,
  FileText,
  Layers,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  Printer,
  QrCode,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";
import { isViewerAllowedForModality, openViewerInNamedWindow } from "@/lib/viewerWindow";
import { getViewerButtonLabel } from "@/lib/viewerLabels";
import {
  dicomWebService,
  SeriesItem as DicomSeriesItem,
  ViewerConfig,
  radiologyReportService,
  expertiseService,
  RadiologyReport,
  RadiologyReportRevision,
  DEFAULT_EXPERTISE_TEMPLATE,
  publicShareService,
  patientContactService,
  whatsappService,
  mwlService,
  MwlDoctor,
  radiologistAssignmentService,
  RadiologistAssignment,
  StudyTimeline,
  studyTimelineService,
  ExpertisePrintTemplate,
  buildLetterheadHtml,
} from "@/lib/dicomService";
import { useAuth } from "@/contexts/AuthContext";

interface Props {
  item: WorklistItem | null;
  onClose: () => void;
  onMetadataUpdated?: (item: WorklistItem) => void;
  hideActionButtons?: boolean;
  showShareButton?: boolean;
  showTimelineTab?: boolean;
  layout?: "modern" | "legacy";
}

const FALLBACK_TEMPLATE_VALUE = "fallback-default";

const formatDicomDate = (value: string): string => {
  if (!value) return "";
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length >= 8) {
    const year = digits.slice(0, 4);
    const month = digits.slice(4, 6);
    const day = digits.slice(6, 8);
    return `${day}/${month}/${year}`;
  }
  if (digits.length === 10) {
    const year = digits.slice(0, 4);
    const month = digits.slice(4, 6);
    const day = digits.slice(6, 8);
    return `${day}/${month}/${year}`;
  }
  return value;
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

const calculateAgeLabel = (birthDate: string, referenceDate?: string) => {
  const digitsBirth = birthDate.replace(/[^0-9]/g, "");
  if (digitsBirth.length < 8) return "";
  const birthYear = Number(digitsBirth.slice(0, 4));
  const birthMonth = Number(digitsBirth.slice(4, 6));
  const birthDay = Number(digitsBirth.slice(6, 8));
  const reference =
    referenceDate && referenceDate.replace(/[^0-9]/g, "").length >= 8 ? referenceDate : "";
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

const formatReportDicomDate = (value?: string | null) => {
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
  const date = formatDicomDate(dateValue ?? "");
  if (!date) return "-";
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

const formatReportDate = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

const formatDuration = (start?: string | null, end?: string | null) => {
  if (!start || !end) return "-";
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return "-";
  const totalMinutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
  if (totalMinutes < 0) return "-";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const escapeLabelHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatLabelDateTime = (value: Date) =>
  value.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const normalizeDicomDateInput = (value: string): string => {
  if (!value) return "";
  const digits = value.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return digits.slice(0, 8);
};

const normalizeDicomTimeInput = (value: string): string => {
  if (!value) return "";
  const digits = value.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return digits.slice(0, 6);
};

const normalizeDicomSexInput = (value: string): string => {
  if (!value) return "";
  const upper = value.toUpperCase();
  if (upper.startsWith("M")) return "M";
  if (upper.startsWith("F")) return "F";
  if (upper.startsWith("O")) return "O";
  return "";
};

const getSopInstanceUid = (instance?: Record<string, unknown>): string => {
  const rawElement = instance?.["00080018"] as { Value?: unknown[] } | undefined;
  const value = Array.isArray(rawElement?.Value) ? rawElement.Value[0] : undefined;
  return (value as string | number | undefined)?.toString() ?? "";
};

interface ViewerContentProps {
  series: DicomSeriesItem[];
  activeSeriesIdForViewer: string | null;
  activeInstanceIndex: number | null;
  isLoadingActiveSeries: boolean;
  instancesBySeries: Record<string, Record<string, unknown>[]>;
  studyInstanceUid: string;
  onSelectSeries: (seriesId: string) => void;
  onChangeImageIndex: (seriesId: string, index: number) => void;
}

const ViewerContent = ({
  series,
  activeSeriesIdForViewer,
  activeInstanceIndex,
  isLoadingActiveSeries,
  instancesBySeries,
  studyInstanceUid,
  onSelectSeries,
  onChangeImageIndex,
}: ViewerContentProps) => {
  const instances =
    activeSeriesIdForViewer && instancesBySeries[activeSeriesIdForViewer]
      ? instancesBySeries[activeSeriesIdForViewer]
      : [];
  const total = instances.length;
  const currentIndex =
    activeInstanceIndex !== null && activeInstanceIndex >= 0 && activeInstanceIndex < total
      ? activeInstanceIndex
      : 0;
  const activeInstance = total ? (instances[currentIndex] as Record<string, unknown>) : undefined;
  const sopInstanceUID = getSopInstanceUid(activeInstance);
  const activeImageUrl =
    activeSeriesIdForViewer && sopInstanceUID
      ? dicomWebService.getInstanceThumbnailUrl(
          studyInstanceUid,
          activeSeriesIdForViewer,
          sopInstanceUID
        )
      : "";
  const activeSeries = series.find(
    item => item.SeriesInstanceUID === activeSeriesIdForViewer
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 bg-black p-4 text-white overflow-hidden">
      <div
        className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-white/10 bg-white/5"
        onWheel={event => {
          if (!activeSeriesIdForViewer || total === 0) return;
          const direction = event.deltaY > 0 ? 1 : -1;
          const nextIndex = Math.min(Math.max(currentIndex + direction, 0), total - 1);
          onChangeImageIndex(activeSeriesIdForViewer, nextIndex);
        }}
      >
        {!activeSeriesIdForViewer ? (
          <div className="text-sm text-slate-300">Select a series to view images.</div>
        ) : total === 0 && isLoadingActiveSeries ? (
          <div className="flex items-center gap-3 text-sm text-slate-300">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading image...
          </div>
        ) : total === 0 ? (
          <div className="text-sm text-slate-300">Image is not available.</div>
        ) : (
          <img
            src={activeImageUrl}
            alt={activeSeries?.SeriesDescription || "Image"}
            className="max-h-full max-w-full object-contain"
            decoding="async"
          />
        )}
      </div>

      {activeSeriesIdForViewer && (
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between text-xs text-slate-300">
          <span>
            Image {total === 0 ? 0 : currentIndex + 1} / {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 transition-colors hover:bg-white/10 disabled:opacity-40"
              disabled={currentIndex <= 0 || total === 0}
              onClick={() => {
                if (!activeSeriesIdForViewer) return;
                onChangeImageIndex(activeSeriesIdForViewer, Math.max(currentIndex - 1, 0));
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 transition-colors hover:bg-white/10 disabled:opacity-40"
              disabled={currentIndex >= Math.max(total - 1, 0) || total === 0}
              onClick={() => {
                if (!activeSeriesIdForViewer) return;
                onChangeImageIndex(
                  activeSeriesIdForViewer,
                  Math.min(currentIndex + 1, Math.max(total - 1, 0))
                );
              }}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {activeSeriesIdForViewer && total > 0 && (
        <input
          type="range"
          min={0}
          max={Math.max(total - 1, 0)}
          value={Math.min(Math.max(currentIndex, 0), total - 1)}
          onChange={event => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next) || !activeSeriesIdForViewer) return;
            onChangeImageIndex(activeSeriesIdForViewer, next);
          }}
          className="mx-auto h-8 w-full max-w-3xl accent-emerald-400 touch-pan-x"
        />
      )}

      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-3">
          {series.length === 0 && (
            <div className="text-sm text-slate-300">Series is not available.</div>
          )}
          {series.map(item => {
            const isActive = activeSeriesIdForViewer === item.SeriesInstanceUID;
            const thumbnailUrl = dicomWebService.getSeriesThumbnailUrl(
              studyInstanceUid,
              item.SeriesInstanceUID
            );

            return (
              <button
                key={item.SeriesInstanceUID}
                type="button"
                onClick={() => onSelectSeries(item.SeriesInstanceUID)}
                className={`w-[5.75rem] shrink-0 overflow-hidden rounded-xl border text-left transition ${
                  isActive
                    ? "border-emerald-400/60 bg-emerald-400/10"
                    : "border-white/10 hover:border-emerald-400/40"
                }`}
              >
                <div className="h-24 w-full overflow-hidden bg-black">
                  <img
                    src={thumbnailUrl}
                    alt={item.SeriesDescription || `Series ${item.SeriesNumber || ""}`}
                    className="h-full w-full object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div className="h-11 px-2 py-1.5 text-[10px] text-slate-300">
                  <div
                    className="line-clamp-2 leading-4"
                    title={item.SeriesDescription || `Series ${item.SeriesNumber || "-"}`}
                  >
                    {item.SeriesDescription || `Series ${item.SeriesNumber || "-"}`}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const StudyDetailDialog = ({
  item,
  onClose,
  onMetadataUpdated,
  hideActionButtons = false,
  showShareButton = false,
  showTimelineTab = false,
  layout = "modern",
}: Props) => {
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const { hasPermission, user } = useAuth();
  const [currentItem, setCurrentItem] = useState<WorklistItem | null>(item);
  const [assignedRadiologist, setAssignedRadiologist] = useState<RadiologistAssignment | null>(null);
  const [series, setSeries] = useState<DicomSeriesItem[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [expandedSeriesId, setExpandedSeriesId] = useState<string | null>(null);
  const [instancesBySeries, setInstancesBySeries] = useState<
    Record<string, Record<string, unknown>[]>
  >({});
  const [instancesLoadingSeriesId, setInstancesLoadingSeriesId] = useState<string | null>(null);
  const [activeSeriesIdForViewer, setActiveSeriesIdForViewer] = useState<string | null>(null);
  const [activeInstanceIndex, setActiveInstanceIndex] = useState<number | null>(null);
  const [thumbnailReadyBySeries, setThumbnailReadyBySeries] = useState<
    Record<string, boolean>
  >({});
  const [thumbnailSrcBySeries, setThumbnailSrcBySeries] = useState<
    Record<string, string>
  >({});
  const [thumbnailReadyByInstance, setThumbnailReadyByInstance] = useState<
    Record<string, boolean>
  >({});
  const [thumbnailErrorByInstance, setThumbnailErrorByInstance] = useState<
    Record<string, boolean>
  >({});
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [isSavingPatientTags, setIsSavingPatientTags] = useState(false);
  const [isSavingStudyTags, setIsSavingStudyTags] = useState(false);
  const [editPatientName, setEditPatientName] = useState("");
  const [editPatientId, setEditPatientId] = useState("");
  const [editOtherPatientIds, setEditOtherPatientIds] = useState("");
  const [editPatientBirthDate, setEditPatientBirthDate] = useState("");
  const [editPatientSex, setEditPatientSex] = useState("");
  const [editAccessionNumber, setEditAccessionNumber] = useState("");
  const [editInstitutionName, setEditInstitutionName] = useState("");
  const [editStudyDescription, setEditStudyDescription] = useState("");
  const [editReferringPhysician, setEditReferringPhysician] = useState("");
  const [editStudyDate, setEditStudyDate] = useState("");
  const [editStudyTime, setEditStudyTime] = useState("");
  const [editStudyId, setEditStudyId] = useState("");
  const [viewerConfigs, setViewerConfigs] = useState<ViewerConfig[]>([]);
  const [report, setReport] = useState<RadiologyReport | null>(null);
  const [reportRevisions, setReportRevisions] = useState<RadiologyReportRevision[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<StudyTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [headerImage, setHeaderImage] = useState<string | null>(null);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [templateHtml, setTemplateHtml] = useState<string | null>(null);
  const [printTemplates, setPrintTemplates] = useState<ExpertisePrintTemplate[]>([]);
  const [selectedPrintTemplateId, setSelectedPrintTemplateId] = useState<number | null>(null);
  const [selectedShareTemplateId, setSelectedShareTemplateId] = useState<number | null>(null);
  const [qrPosition, setQrPosition] = useState<"left" | "center" | "right">("right");
  const [reportSignatureImage, setReportSignatureImage] = useState<string | null>(null);
  const [isCreatingShare, setIsCreatingShare] = useState(false);
  const [activeTab, setActiveTab] = useState("info");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappMessage, setWhatsappMessage] = useState("");
  const [whatsappTouched, setWhatsappTouched] = useState(false);
  const [whatsappLink, setWhatsappLink] = useState("");
  const [isSendingWhatsapp, setIsSendingWhatsapp] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareExpiresInDays, setShareExpiresInDays] = useState("7");
  const [defaultShareExpiresInDays, setDefaultShareExpiresInDays] = useState("7");
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(null);
  const [qcOfficerDialogOpen, setQcOfficerDialogOpen] = useState(false);
  const [distributionWarningOpen, setDistributionWarningOpen] = useState(false);
  const [distributionWarnings, setDistributionWarnings] = useState<string[]>([]);
  const [allowIncompleteDistribution, setAllowIncompleteDistribution] = useState(false);
  const [qcOfficerOptions, setQcOfficerOptions] = useState<MwlDoctor[]>([]);
  const [qcOfficerLoading, setQcOfficerLoading] = useState(false);
  const [qcOfficerName, setQcOfficerName] = useState("");
  const [qcOfficerError, setQcOfficerError] = useState<string | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const canEdit = hasPermission("edit_metadata");
  const canDeleteStudy = hasPermission("delete_study");
  const canDeleteSeries = hasPermission("delete_series");
  const canDeleteInstance = hasPermission("delete_instance");
  const canDownload = hasPermission("download_study");
  const canShare = hasPermission("report_export");

  const applyCurrentItemUpdate = (nextItem: WorklistItem) => {
    setCurrentItem(nextItem);
    onMetadataUpdated?.(nextItem);
  };

  const persistShareExpiryDays = async (days: number) => {
    if (!Number.isFinite(days) || days <= 0) return;
    const normalizedDays = Math.floor(days);
    setDefaultShareExpiresInDays(String(normalizedDays));
    try {
      const currentSettings = await dicomWebService.fetchUiSettings();
      await dicomWebService.updateUiSettings({
        ...currentSettings,
        viewerAccessLinkDays: normalizedDays,
      });
    } catch (error) {
      void error;
    }
  };

  const downloadStudyZip = async () => {
    if (!currentItem || downloadLoading) return;
    setDownloadLoading(true);
    try {
      const blob = await dicomWebService.downloadStudyZip(currentItem.studyInstanceUid);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${currentItem.studyInstanceUid}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({
        title: "Download started",
        description: "The DICOM archive is downloading.",
      });
    } catch (error) {
      toast({
        title: "Download failed",
        description:
          error instanceof Error ? error.message : "Failed to download DICOM ZIP.",
        variant: "destructive",
      });
    } finally {
      setDownloadLoading(false);
    }
  };

  const ensureInstancesLoaded = async (seriesId: string) => {
    if (!currentItem) return [] as Record<string, unknown>[];
    const cached = instancesBySeries[seriesId];
    if (cached && cached.length > 0) return cached;
    try {
      setInstancesLoadingSeriesId(seriesId);
      const loaded = await dicomWebService.fetchInstances(
        currentItem.studyInstanceUid,
        seriesId
      );
      const normalized = Array.isArray(loaded)
        ? (loaded as Record<string, unknown>[])
        : [];
      setInstancesBySeries(prev => ({
        ...prev,
        [seriesId]: normalized,
      }));
      return normalized;
    } catch (error) {
      toast({
        title: "Failed to load images",
        description:
          error instanceof Error ? error.message : "An error occurred while fetching frames.",
        variant: "destructive",
      });
      return [];
    } finally {
      setInstancesLoadingSeriesId(prev => (prev === seriesId ? null : prev));
    }
  };

  const getSeriesThumbnailSrc = (seriesId: string) => {
    if (!currentItem) return "";
    return (
      thumbnailSrcBySeries[seriesId] ||
      dicomWebService.getSeriesThumbnailUrl(currentItem.studyInstanceUid, seriesId)
    );
  };

  const updateViewerIndex = (seriesId: string, targetIndex: number) => {
    if (!currentItem) return;
    const instances = instancesBySeries[seriesId] ?? [];
    if (instances.length === 0) {
      setActiveSeriesIdForViewer(seriesId);
      setActiveInstanceIndex(Math.max(0, targetIndex));
      return;
    }
    const clamped = Math.min(Math.max(targetIndex, 0), instances.length - 1);
    const sopInstanceUID = getSopInstanceUid(instances[clamped]);
    if (!sopInstanceUID) return;
    setActiveSeriesIdForViewer(seriesId);
    setActiveInstanceIndex(clamped);
  };

  const openViewerAtSeries = async (seriesId: string, targetIndex?: number) => {
    if (!currentItem) return;
    setActiveSeriesIdForViewer(seriesId);
    const fallbackIndex = Number.isFinite(targetIndex) ? Number(targetIndex) : 0;
    setActiveInstanceIndex(fallbackIndex);
    const instances = await ensureInstancesLoaded(seriesId);
    const index = Number.isFinite(targetIndex) ? Number(targetIndex) : 0;
    updateViewerIndex(seriesId, index);
  };

  useEffect(() => {
    setCurrentItem(item);
    setThumbnailSrcBySeries({});
    if (item) {
      setEditPatientName(item.patientName || "");
      setEditPatientId(item.patientId || "");
      setEditOtherPatientIds(item.otherPatientIds || "");
      setEditPatientBirthDate(item.birthDate || "");
      setEditPatientSex(item.sex || "");
      setEditAccessionNumber(item.accessionNumber || "");
      setEditInstitutionName(item.institutionName || "");
      setEditStudyDescription(item.studyDescription || "");
      setEditReferringPhysician(item.referringPhysician || "");
      setEditStudyDate(item.studyDate || "");
      setEditStudyTime(item.studyTime || "");
      setEditStudyId(item.studyId || "");
      setEditDialogOpen(false);
      setActiveTab("info");
      setWhatsappNumber("");
      setWhatsappMessage("");
      setWhatsappTouched(false);
      setWhatsappLink("");
      setIsSendingWhatsapp(false);
      setShareToken(null);
      setShareExpiresInDays(defaultShareExpiresInDays);
      setShareExpiresAt(null);
      setQcOfficerDialogOpen(false);
      setDistributionWarningOpen(false);
      setDistributionWarnings([]);
      setAllowIncompleteDistribution(false);
      setQcOfficerName("");
      setQcOfficerError(null);
    }
  }, [defaultShareExpiresInDays, item]);

  useEffect(() => {
    if (!currentItem || !canShare) return;
    let cancelled = false;
    const loadPatientPhone = async () => {
      try {
        const payload = await patientContactService.fetchPhone({
          patientId: currentItem.patientId,
          accessionNumber: currentItem.accessionNumber,
          studyInstanceUid: currentItem.studyInstanceUid,
        });
        if (cancelled) return;
        if (!payload.patient_phone) return;
        if (!whatsappNumber) {
          setWhatsappNumber(payload.patient_phone);
        }
      } catch (error) {
        void error;
      }
    };
    loadPatientPhone();
    return () => {
      cancelled = true;
    };
  }, [canShare, currentItem, whatsappNumber]);

  useEffect(() => {
    if (!currentItem || !canShare) return;
    let cancelled = false;
    const loadLatestShare = async () => {
      try {
        const payload = await publicShareService.fetchLatestShare(currentItem.studyInstanceUid);
        if (cancelled) return;
        if (!payload) {
          setWhatsappLink("");
          setShareToken(null);
          setShareExpiresAt(null);
          return;
        }
        if (payload.patient_phone) {
          setWhatsappNumber(payload.patient_phone);
        }
        setWhatsappLink(payload.url || "");
        setShareToken(payload.token || null);
        setShareExpiresAt(payload.expires_at ?? null);
        if (payload.template_id) setSelectedShareTemplateId(payload.template_id);
      } catch (error) {
        if (cancelled) return;
        setShareToken(null);
        setShareExpiresAt(null);
      }
    };
    loadLatestShare();
    return () => {
      cancelled = true;
    };
  }, [canShare, currentItem]);

  useEffect(() => {
    if (!qcOfficerDialogOpen) return;
    let cancelled = false;
    const loadQcOfficers = async () => {
      setQcOfficerLoading(true);
      setQcOfficerError(null);
      try {
        const users = await mwlService.fetchDoctors({ role: "ALL" });
        if (cancelled) return;
        const editors = users.filter(user => user.role === "ADMISSION" || user.role === "TECHNOLOGIST");
        setQcOfficerOptions(editors);
        if (!qcOfficerName && editors.length === 1) {
          const singleName = editors[0].nama_dokter || editors[0].kode_dokter;
          setQcOfficerName(singleName);
        }
      } catch (error) {
        if (!cancelled) {
          setQcOfficerOptions([]);
          setQcOfficerError("Failed to load QC staff.");
        }
      } finally {
        if (!cancelled) setQcOfficerLoading(false);
      }
    };
    loadQcOfficers();
    return () => {
      cancelled = true;
    };
  }, [qcOfficerDialogOpen, qcOfficerName]);

  useEffect(() => {
    const loadUiSettings = async () => {
      try {
        const settings = await dicomWebService.fetchUiSettings();
        const configs = settings.viewers;
        if (typeof settings.viewerAccessLinkDays === "number" && Number.isFinite(settings.viewerAccessLinkDays) && settings.viewerAccessLinkDays > 0) {
          const days = String(Math.floor(settings.viewerAccessLinkDays));
          setDefaultShareExpiresInDays(days);
          setShareExpiresInDays(days);
        }
        if (Array.isArray(configs) && configs.length > 0) {
          setViewerConfigs(configs);
        } else {
          setViewerConfigs([
            {
              id: "vexa-pacs",
              name: "Viewer",
              baseUrl: "http://127.0.0.1:5994",
              path: "/Viewer",
              queryParam: "launch",
              type: "vexa-ris-launch",
            },
          ]);
        }
      } catch (error) {
        setViewerConfigs([
          {
            id: "vexa-pacs",
            name: "Viewer",
            baseUrl: "http://127.0.0.1:5994",
            path: "/Viewer",
            queryParam: "launch",
            type: "vexa-ris-launch",
          },
        ]);
      }
    };
    loadUiSettings();
  }, []);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    const load = async () => {
      setSeriesLoading(true);
      setSeriesError(null);
      try {
        const data = await dicomWebService.fetchSeries(item.studyInstanceUid);
        if (!cancelled) setSeries(data);
      } catch (error) {
        if (!cancelled) {
          const description =
            error instanceof Error ? error.message : "Failed to load series for this study";
          setSeriesError(description);
          setSeries([]);
        }
      } finally {
        if (!cancelled) setSeriesLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [item]);

  useEffect(() => {
    if (!item?.studyInstanceUid) {
      setReport(null);
      setReportRevisions([]);
      setReportError(null);
      return;
    }
    let cancelled = false;
    const loadReport = async () => {
      setReportLoading(true);
      setReportError(null);
      try {
        const [reportData, revisions] = await Promise.all([
          radiologyReportService.fetchReport(item.studyInstanceUid),
          radiologyReportService.fetchRevisions(item.studyInstanceUid),
        ]);
        if (cancelled) return;
        setReport(reportData);
        setReportRevisions(revisions);
      } catch (error) {
        if (!cancelled) {
          setReportError(
            error instanceof Error ? error.message : "Failed to load report"
          );
          setReport(null);
          setReportRevisions([]);
        }
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    };
    loadReport();
    return () => {
      cancelled = true;
    };
  }, [item?.studyInstanceUid]);

  useEffect(() => {
    if (!showTimelineTab || !item?.studyInstanceUid) {
      setTimeline(null);
      setTimelineError(null);
      return;
    }
    let cancelled = false;
    const loadTimeline = async () => {
      setTimelineLoading(true);
      setTimelineError(null);
      try {
        const data = await studyTimelineService.fetchTimeline(item.studyInstanceUid);
        if (!cancelled) setTimeline(data);
      } catch (error) {
        if (!cancelled) {
          setTimeline(null);
          setTimelineError(error instanceof Error ? error.message : "Failed to load timeline");
        }
      } finally {
        if (!cancelled) setTimelineLoading(false);
      }
    };
    loadTimeline();
    return () => {
      cancelled = true;
    };
  }, [item?.studyInstanceUid, showTimelineTab]);

  useEffect(() => {
    if (!currentItem || series.length === 0) return;
    let cancelled = false;
    const warmSeriesThumbnails = async () => {
      for (const seriesItem of series) {
        if (cancelled) return;
        if (!seriesItem?.SeriesInstanceUID || thumbnailSrcBySeries[seriesItem.SeriesInstanceUID]) {
          continue;
        }
        try {
          const loaded = await dicomWebService.fetchInstances(
            currentItem.studyInstanceUid,
            seriesItem.SeriesInstanceUID
          );
          if (cancelled || !Array.isArray(loaded) || loaded.length === 0) continue;
          const sopInstanceUID = getSopInstanceUid(loaded[0] as Record<string, unknown>);
          if (!sopInstanceUID) continue;
          setInstancesBySeries(prev => (
            prev[seriesItem.SeriesInstanceUID]
              ? prev
              : {
                  ...prev,
                  [seriesItem.SeriesInstanceUID]: loaded as Record<string, unknown>[],
                }
          ));
          // Keep the calibrated series thumbnail selected by the backend.
        } catch {
          // Keep series thumbnail endpoint as fallback when instance preload fails.
        }
      }
    };
    warmSeriesThumbnails();
    return () => {
      cancelled = true;
    };
  }, [currentItem, series, thumbnailSrcBySeries]);

  useEffect(() => {
    if (!currentItem?.studyInstanceUid) {
      setAssignedRadiologist(null);
      return;
    }
    let cancelled = false;
    const loadAssignment = async () => {
      try {
        const assignments = await radiologistAssignmentService.fetchAssignments([
          currentItem.studyInstanceUid,
        ]);
        if (cancelled) return;
        setAssignedRadiologist(assignments[0] ?? null);
      } catch {
        if (!cancelled) setAssignedRadiologist(null);
      }
    };
    loadAssignment();
    return () => {
      cancelled = true;
    };
  }, [currentItem?.studyInstanceUid]);

  useEffect(() => {
    if (!user?.username) {
      setHeaderImage(null);
      setSignatureImage(null);
      return;
    }
    let cancelled = false;
    const loadAssets = async () => {
      try {
        const [assets, templates] = await Promise.all([
          expertiseService.fetchAssets(user.username),
          expertiseService.fetchPrintTemplates({ activeOnly: true }),
        ]);
        if (cancelled) return;
        setHeaderImage(assets.headerImage ?? null);
        setSignatureImage(assets.signatureImage ?? null);
        setTemplateHtml(assets.templateHtml ?? null);
        setPrintTemplates(templates);
        const defaultTemplate = templates.find(template => template.isDefault) || templates[0] || null;
        setSelectedPrintTemplateId(defaultTemplate?.id ?? null);
        setSelectedShareTemplateId(defaultTemplate?.id ?? null);
        if (assets.qrPosition === "left" || assets.qrPosition === "center" || assets.qrPosition === "right") {
          setQrPosition(assets.qrPosition);
        } else {
          setQrPosition("right");
        }
      } catch {
        if (!cancelled) {
          setHeaderImage(null);
          setSignatureImage(null);
          setTemplateHtml(null);
          setPrintTemplates([]);
          setSelectedPrintTemplateId(null);
          setSelectedShareTemplateId(null);
          setQrPosition("right");
        }
      }
    };
    loadAssets();
    return () => {
      cancelled = true;
    };
  }, [user?.username]);

  const finalRevision = reportRevisions
    .filter(rev => rev.status === "final")
    .reduce<RadiologyReportRevision | null>((latest, current) => {
      if (!latest) return current;
      const latestTime = new Date(latest.created_at).getTime();
      const currentTime = new Date(current.created_at).getTime();
      return currentTime > latestTime ? current : latest;
    }, null);
  const activeReport =
    finalRevision ?? (report?.status === "final" ? report : null);
  useEffect(() => {
    if (!activeReport?.radiologist_id) {
      setReportSignatureImage(null);
      return;
    }
    let cancelled = false;
    const loadSignature = async () => {
      try {
        const payload = await expertiseService.fetchSignature(activeReport.radiologist_id);
        if (!cancelled) {
          setReportSignatureImage(payload.signatureImage ?? null);
        }
      } catch {
        if (!cancelled) setReportSignatureImage(null);
      }
    };
    loadSignature();
    return () => {
      cancelled = true;
    };
  }, [activeReport?.radiologist_id]);
  const effectiveSignatureImage = reportSignatureImage ?? signatureImage;
  const findingsHtml =
    activeReport?.findings && activeReport.findings.trim()
      ? activeReport.findings
      : "<p>-</p>";
  const conclusionHtml =
    activeReport?.conclusion && activeReport.conclusion.trim()
      ? activeReport.conclusion
      : "<p>-</p>";
  const whatsappTemplate = useMemo(() => {
    if (!currentItem) return "";
    const radiologistName =
      assignedRadiologist?.radiologist_name ||
      activeReport?.radiologist_name ||
      user?.fullName ||
      "-";
    const studyDate = formatDicomDate(currentItem.studyDate || "");
    const urlToken = whatsappLink || "(urltoken)";
    return `Hello, here is the radiology examination result from RS NEXIA:\nName: ${currentItem.patientName || "-"}\nMedical Record No: ${currentItem.patientId || "-"}\nStudy: ${currentItem.studyDescription || "-"}\nStudy Date: ${studyDate || "-"}\nRadiology Doctor: ${radiologistName}\n\nThe result can be accessed here:\n${urlToken}\n\nThank you`;
  }, [
    activeReport?.radiologist_name,
    assignedRadiologist?.radiologist_name,
    currentItem,
    user?.fullName,
    whatsappLink,
  ]);

  useEffect(() => {
    if (!whatsappTouched) {
      setWhatsappMessage(whatsappTemplate);
    }
  }, [whatsappTemplate, whatsappTouched]);
  if (!currentItem) return null;
  const birthDateText = formatDicomDate(currentItem.birthDate);
  const birthAgeText = calculateAgeLabel(currentItem.birthDate, currentItem.studyDate);
  const genderLabel =
    currentItem.sex === "M"
      ? "Male"
      : currentItem.sex === "F"
      ? "Female"
      : currentItem.sex === "O"
      ? "Other"
      : "-";
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
  const getSelectedPrintTemplate = () => printTemplates.find(template => template.id === selectedPrintTemplateId) || null;

  const getSelectedPrintTemplateHtml = () => {
    const selectedTemplate = getSelectedPrintTemplate();
    return selectedTemplate?.templateHtml || templateHtml || DEFAULT_EXPERTISE_TEMPLATE;
  };

  const buildPrintHtml = (overrideTemplateHtml?: string | null) => {
    const logoUrl = `${window.location.origin}/logo.png`;
    const gender =
      currentItem.sex === "F"
        ? "Female"
        : currentItem.sex === "M"
        ? "Male"
        : currentItem.sex || "-";
    const effectiveHeaderImage = getSelectedPrintTemplate()?.headerImage || headerImage;
    const headerHtml = effectiveHeaderImage
      ? buildLetterheadHtml(effectiveHeaderImage)
      : `<div class="header-fallback"><img src="${logoUrl}" class="logo" /><div class="title">Radiology Report</div></div>`;
    const signatureHtml = effectiveSignatureImage
      ? `<img src="${effectiveSignatureImage}" class="signature-image" />`
      : "";
    const clinicalInfo = activeReport?.clinical_info ?? "";
    const findings = activeReport?.findings ?? "";
    const conclusion = activeReport?.conclusion ?? "";
    const radiologistName =
      assignedRadiologist?.radiologist_name ||
      activeReport?.radiologist_name ||
      user?.fullName ||
      "-";
    const reportDateRaw = activeReport
      ? activeReport.finalized_at ||
        ("updated_at" in activeReport ? activeReport.updated_at : null) ||
        activeReport.created_at ||
        ""
      : "";
    const reportDate = formatReportDate(reportDateRaw);
    const reportContent = `
      ${clinicalInfo || ""}
      ${clinicalInfo && (findings || conclusion) ? "<br/><br/>" : ""}
      ${findings || ""}
      ${(clinicalInfo || findings) && conclusion ? "<br/><br/>" : ""}
      ${conclusion || ""}
    `;
    const birthDateValue = formatReportDicomDate(currentItem.birthDate);
    const birthDateAge =
      birthDateValue !== "-"
        ? `${birthDateValue}${birthAgeText ? ` - ${birthAgeText}` : ""}`
        : birthAgeText || "-";
    const shareUrl = shareToken ? whatsappLink : "";
    const expDateText = shareExpiresAt
      ? new Date(shareExpiresAt).toLocaleString("id-ID", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "-";
    const qrAlign =
      qrPosition === "left"
        ? "flex-start"
        : qrPosition === "center"
          ? "center"
          : "flex-end";
    const qrImageTag = shareUrl
      ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(
          shareUrl
        )}" class="qr-image" style="display:block;width:140px;height:140px;object-fit:contain;margin:0 auto;" />`
      : "";
    const qrImageHtml = shareUrl
      ? `<div class="qr-slot" style="width:100%;display:flex;justify-content:${qrAlign};align-items:flex-end;text-align:center;">${qrImageTag}</div>`
      : "";
    const qrLabel = shareUrl ? "Scan for results" : "";
    const qrExpiry = shareUrl ? `EXP DATE: ${expDateText}` : "";
    const qrBlockHtml = shareUrl
      ? `<div class="qr-slot" style="width:100%;display:flex;justify-content:${qrAlign};align-items:flex-end;text-align:center;"><div class="qr-block" style="width:160px;display:inline-flex;flex-direction:column;align-items:center;text-align:center;line-height:1.2;">${qrImageTag}<div class="qr-label" style="width:100%;margin-top:6px;text-align:center;">${escapeHtml(qrLabel)}</div><div class="qr-exp" style="width:100%;margin-top:4px;text-align:center;white-space:nowrap;">${escapeHtml(qrExpiry)}</div></div></div>`
      : "";
    const ensureQrPlaceholder = (value: string) => {
      if (value.includes("{{qr_html}}") || value.includes("{{qr_image_html}}") || value.includes("{{qr_block_html}}")) return value;
      const footerMatch = value.match(/<div[^>]*class=["']footer["'][^>]*>/i);
      if (footerMatch) {
        return value.replace(footerMatch[0], `${footerMatch[0]}{{qr_image_html}}<div>{{qr_label}}</div><div>{{qr_expiry}}</div>`);
      }
      return value.replace("</body>", `<div class="footer footer-qr-only">{{qr_image_html}}<div>{{qr_label}}</div><div>{{qr_expiry}}</div></div></body>`);
    };
    const rawTemplate = overrideTemplateHtml && overrideTemplateHtml.trim() ? overrideTemplateHtml : getSelectedPrintTemplateHtml();
    const template = ensureQrPlaceholder(rawTemplate);
    return applyTemplate(template, {
      header_html: headerHtml,
      signature_html: signatureHtml,
      signature_name: escapeHtml(radiologistName),
      patient_name: escapeHtml(currentItem.patientName || "-"),
      patient_id: escapeHtml(currentItem.patientId || "-"),
      gender: escapeHtml(gender),
      birth_date: escapeHtml(birthDateValue || "-"),
      age: escapeHtml(birthAgeText || "-"),
      birth_date_age: escapeHtml(birthDateAge),
      study_description: escapeHtml(currentItem.studyDescription || "-"),
      study_date: escapeHtml(formatDicomDate(currentItem.studyDate || "") || "-"),
      study_time: escapeHtml(formatDicomTime(currentItem.studyTime || "") || "-"),
      study_datetime: escapeHtml(formatDicomDate(currentItem.studyDate || "") || "-"),
      referring_physician: escapeHtml(currentItem.referringPhysician || "-"),
      radiologist_name: escapeHtml(radiologistName),
      clinical_info: clinicalInfo || "",
      findings: findings || "",
      conclusion: conclusion || "",
      report_content: reportContent,
      report_date: escapeHtml(reportDate),
      qr_html: qrImageHtml,
      qr_image_html: qrImageHtml,
      qr_label: escapeHtml(qrLabel),
      qr_expiry: escapeHtml(qrExpiry),
      qr_block_html: qrBlockHtml,
    });
  };
  const openPrintWindow = () => {
    if (!activeReport) {
      toast({
        title: "Print failed",
        description: "No final report is available yet.",
        variant: "destructive",
      });
      return;
    }
    const html = buildPrintHtml();
    const printWindow = window.open("", "_blank", "width=900,height=1200");
    if (!printWindow) {
      toast({
        title: "Print failed",
        description: "Unable to open print window.",
        variant: "destructive",
      });
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

  const openQrLabelWindow = async () => {
    if (!currentItem) return;
    if (!canShare) {
      toast({
        title: "No access",
        description: "You do not have access to create patient links.",
        variant: "destructive",
      });
      return;
    }
    let labelShareUrl = whatsappLink;
    let labelShareExpiresAt = shareExpiresAt;
    if (!labelShareUrl) {
      try {
        setIsCreatingShare(true);
        const latest = await publicShareService.fetchLatestShare(currentItem.studyInstanceUid);
        if (latest?.url) {
          labelShareUrl = latest.url;
          labelShareExpiresAt = latest.expires_at ?? null;
          setWhatsappLink(latest.url);
          setShareToken(latest.token || null);
          setShareExpiresAt(latest.expires_at ?? null);
          if (latest.patient_phone) {
            setWhatsappNumber(latest.patient_phone);
          }
          if (latest.template_id) setSelectedShareTemplateId(latest.template_id);
        } else {
          const days = Number(shareExpiresInDays);
          if (!Number.isFinite(days) || days <= 0) {
            toast({
              title: "Invalid expiry period",
              description: "Enter a valid number of days for the expiry period.",
              variant: "destructive",
            });
            return;
          }
          const normalizedPhone = whatsappNumber.replace(/[^0-9]/g, "");
          const payload = await publicShareService.createShare(
            currentItem.studyInstanceUid,
            days,
            normalizedPhone || undefined,
            qcOfficerName || user?.fullName || user?.username || undefined,
            selectedShareTemplateId
          );
          await persistShareExpiryDays(days);
          labelShareUrl = payload.url || "";
          labelShareExpiresAt = payload.expires_at ?? null;
          setWhatsappLink(payload.url || "");
          setShareToken(payload.token || null);
          setShareExpiresAt(payload.expires_at ?? null);
        }
      } catch (error) {
        toast({
          title: "Failed to create QR label",
          description:
            error instanceof Error ? error.message : "Patient link could not be created.",
          variant: "destructive",
        });
        return;
      } finally {
        setIsCreatingShare(false);
      }
    }
    if (!labelShareUrl) {
      toast({
        title: "Patient link is not available",
        description: "Generate the patient link first.",
        variant: "destructive",
      });
      return;
    }
    const radiologistName =
      assignedRadiologist?.radiologist_name ||
      activeReport?.radiologist_name ||
      user?.fullName ||
      "-";
    const registerText =
      formatDicomDateTime(currentItem.studyDate || "", currentItem.studyTime) ||
      formatLabelDateTime(new Date());
    const qualityControlText = formatLabelDateTime(new Date());
    const expiredDate = new Date();
    expiredDate.setFullYear(expiredDate.getFullYear() + 5);
    const expiredText = labelShareExpiresAt
      ? formatLabelDateTime(new Date(labelShareExpiresAt))
      : expiredDate.toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(
      labelShareUrl
    )}`;
    const row = (label: string, value: string) => `
      <tr>
        <th>${escapeLabelHtml(label)}</th>
        <td>: ${escapeLabelHtml(value || "-")}</td>
      </tr>
    `;
    const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>QR Label</title>
    <style>
      @page { size: 80mm auto; margin: 2mm; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #e5e5e5;
        font-family: "Times New Roman", serif;
        color: #000;
      }
      .label {
        width: 76mm;
        min-height: 115mm;
        background: #fff;
        margin: 0 auto;
        padding: 2.5mm;
        border: 1px solid #000;
      }
      .qr-wrap {
        display: flex;
        justify-content: center;
        padding: 2mm 0 3mm;
        border-bottom: 1px solid #000;
      }
      .qr-wrap img {
        width: 64mm;
        height: 64mm;
        object-fit: contain;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 10.5px;
        line-height: 1.15;
      }
      th, td {
        border-bottom: 1px solid #000;
        vertical-align: top;
        padding: 1px 2px;
      }
      th {
        width: 25mm;
        text-align: left;
        font-weight: 700;
        white-space: nowrap;
      }
      .print-button {
        margin-top: 3mm;
        font-size: 11px;
      }
      @media print {
        body { background: #fff; }
        .label { border: none; margin: 0; width: 76mm; }
        .print-button { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="label">
      <div class="qr-wrap">
        <img src="${qrUrl}" alt="QR Code" />
      </div>
      <table>
        ${row("Date Register", registerText)}
        ${row("NO RM", currentItem.patientId)}
        ${row("Name", currentItem.patientName)}
        ${row("Accession No", currentItem.accessionNumber)}
        ${row("Date of Birth", formatReportDicomDate(currentItem.birthDate))}
        ${row("Exam", currentItem.studyDescription || currentItem.modalityCode)}
        ${row("Ref Physician", currentItem.referringPhysician)}
        ${row("Radiologist", radiologistName)}
        ${row("Distribution", qualityControlText)}
        ${row("Expired", expiredText)}
      </table>
      <button class="print-button" onclick="window.print()">Print</button>
    </div>
  </body>
</html>`;
    const printWindow = window.open("", "_blank", "width=380,height=700");
    if (!printWindow) {
      toast({
        title: "Failed to print QR",
        description: "Browser memblokir pop-up print label.",
        variant: "destructive",
      });
      return;
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
  };

  const handleGenerateShare = () => {
    if (!currentItem) return;
    if (!canShare) {
      toast({
        title: "No access",
        description: "You do not have access to create patient links.",
        variant: "destructive",
      });
      return;
    }
    if (reportLoading || seriesLoading) {
      toast({
        title: "Validation in progress",
        description: "Please wait while the radiology report and examination images are being verified.",
      });
      return;
    }
    const hasImages =
      Number(currentItem.imageCount || 0) > 0 ||
      series.some(item => Number(item.NumberOfSeriesRelatedInstances || 0) > 0);
    const hasFindings = Boolean(activeReport?.findings?.trim());
    const hasConclusion = Boolean(activeReport?.conclusion?.trim());
    if (!activeReport || !hasFindings || !hasConclusion || !hasImages) {
      const missing = [
        !activeReport ? "a finalized radiologist report" : null,
        activeReport && !hasFindings ? "Findings" : null,
        activeReport && !hasConclusion ? "Conclusion" : null,
        !hasImages ? "examination images" : null,
      ].filter(Boolean);
      setDistributionWarnings(missing as string[]);
      setAllowIncompleteDistribution(false);
      setDistributionWarningOpen(true);
      return;
    }
    setAllowIncompleteDistribution(false);
    setQcOfficerDialogOpen(true);
  };
  const handleConfirmGenerateShare = async () => {
    if (!currentItem) return;
    const days = Number(shareExpiresInDays);
    if (!Number.isFinite(days) || days <= 0) {
      toast({
        title: "Invalid expiry period",
        description: "Enter a valid number of days for the expiry period.",
        variant: "destructive",
      });
      return;
    }
    if (!qcOfficerName) {
      toast({
        title: "QC staff not selected",
        description: "Select the staff member who performs quality control.",
        variant: "destructive",
      });
      return;
    }
    try {
      setIsCreatingShare(true);
      const normalizedPhone = whatsappNumber.replace(/[^0-9]/g, "");
      const payload = await publicShareService.createShare(
        currentItem.studyInstanceUid,
        days,
        normalizedPhone || undefined,
        qcOfficerName,
        selectedShareTemplateId,
        allowIncompleteDistribution
      );
      await persistShareExpiryDays(days);
      setWhatsappLink(payload.url || "");
      setShareToken(payload.token || null);
      setShareExpiresAt(payload.expires_at ?? null);
      if (payload.template_id) setSelectedShareTemplateId(payload.template_id);
      setQcOfficerDialogOpen(false);
      setAllowIncompleteDistribution(false);
      toast({
        title: "Patient link created",
        description: payload.url
          ? "The link is ready to share over WhatsApp or a barcode."
          : "Link has been created.",
      });
    } catch (error) {
      toast({
        title: "Failed to create patient link",
        description:
          error instanceof Error ? error.message : "Something went wrong while creating the link.",
        variant: "destructive",
      });
    } finally {
      setIsCreatingShare(false);
    }
  };
  const handleSendWhatsapp = async () => {
    const number = whatsappNumber.replace(/[^0-9]/g, "");
    if (!number) {
      toast({
        title: "WhatsApp number is empty",
        description: "Enter the patient number first.",
        variant: "destructive",
      });
      return;
    }
    if (!whatsappLink) {
      toast({
        title: "Link has not been created",
        description: "Generate the patient link first.",
        variant: "destructive",
      });
      return;
    }
    if (!whatsappMessage.trim()) {
      toast({
        title: "Message is empty",
        description: "Enter the WhatsApp message first.",
        variant: "destructive",
      });
      return;
    }
    if (shareToken) {
      try {
        await publicShareService.updateSharePhone(shareToken, number);
      } catch (error) {
        void error;
      }
    }
    if (currentItem?.patientId) {
      try {
        await patientContactService.updatePhone(currentItem.patientId, number);
      } catch (error) {
        void error;
      }
    }
    setIsSendingWhatsapp(true);
    try {
      const result = await whatsappService.sendMessage({
        number,
        message: whatsappMessage,
        recipientType: "patient",
        patientId: currentItem?.patientId,
        studyInstanceUid: currentItem?.studyInstanceUid,
        accessionNumber: currentItem?.accessionNumber,
      });
      if (result.sent) {
        toast({
          title: "WhatsApp message sent",
          description: "Message has been sent through the WhatsApp API.",
        });
        return;
      }
      const fallbackUrl =
        result.fallbackUrl || `https://wa.me/${number}?text=${encodeURIComponent(whatsappMessage)}`;
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
      setIsSendingWhatsapp(false);
    }
  };
  const visibleViewerConfigs = viewerConfigs.filter(viewer =>
    isViewerAllowedForModality(viewer, currentItem.modalityCode)
  );
  const actionButtons = (
    <div className="flex gap-2 flex-wrap">
      {visibleViewerConfigs.map(viewer => (
        <Button
          key={viewer.id}
          className="rounded-xl gradient-medical border-0"
          onClick={async () => {
            try {
              if (!currentItem) return;
              await openViewerInNamedWindow(viewer, currentItem.studyInstanceUid, {
                accessionNumber: currentItem.accessionNumber,
                patientId: currentItem.patientId,
              });
              if (viewer.type === "inobitec-rpc") {
                toast({ title: "Inobitec command sent" });
              }
            } catch (error) {
              toast({
                title: "Failed to open viewer",
                description:
                  error instanceof Error
                    ? error.message
                    : "Viewer configuration is invalid.",
                variant: "destructive",
              });
            }
          }}
        >
          <ExternalLink className="w-4 h-4 mr-2" /> {getViewerButtonLabel(viewer)}
        </Button>
      ))}
      {!hideActionButtons && canEdit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="rounded-xl"
              onClick={async () => {
                if (!currentItem) return;
                setEditDialogOpen(true);
              }}
            >
              <Pencil className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
      )}
      {layout !== "legacy" && (showShareButton || !hideActionButtons) && canShare && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={shareExpiresInDays}
            onChange={event => setShareExpiresInDays(event.target.value)}
            className="w-[90px]"
            disabled={isCreatingShare}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="rounded-xl gap-2"
                disabled={isCreatingShare}
                onClick={handleGenerateShare}
              >
                <QrCode className="w-4 h-4" />
                Generate Token
              </Button>
            </TooltipTrigger>
            <TooltipContent>Generate Patient Link</TooltipContent>
          </Tooltip>
          {shareToken && (
            <Badge className="rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
              Active token
            </Badge>
          )}
        </div>
      )}
      {!hideActionButtons && canDownload && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="rounded-xl"
              onClick={downloadStudyZip}
              disabled={downloadLoading}
            >
              {downloadLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download DICOM .zip</TooltipContent>
        </Tooltip>
      )}
      {!hideActionButtons && canDeleteStudy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="destructive"
              size="icon"
              className="rounded-xl"
              onClick={async () => {
                const reason = await confirmDelete({
                  title: "Delete study?",
                  description: "This will delete the full DICOM study from the PACS.",
                  target: `${currentItem.patientName || currentItem.patientId} - ${currentItem.studyDescription || currentItem.studyInstanceUid}`,
                });
                if (!reason) return;
                try {
                  await dicomWebService.deleteStudy(
                    currentItem.patientId,
                    currentItem.studyInstanceUid,
                    { reason }
                  );
                  toast({
                    title: "Study deleted",
                    description: "Study deleted from server.",
                    variant: "destructive",
                  });
                  onClose();
                } catch (error) {
                  toast({
                    title: "Failed to delete study",
                    description:
                      error instanceof Error
                        ? error.message
                        : "An error occurred while deleting the study.",
                    variant: "destructive",
                  });
                }
              }}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete Study</TooltipContent>
        </Tooltip>
      )}
    </div>
  );

  if (layout === "legacy") {
    return (
      <>
      <Dialog open={!!item} onOpenChange={open => !open && onClose()}>
        <DialogContent className="max-w-4xl w-[92vw] rounded-2xl max-h-[92vh] overflow-hidden p-0">
          <div className="flex flex-col max-h-[92vh]">
            <div className="px-6 pt-6">
              <DialogHeader>
                <DialogTitle className="sr-only">Study details</DialogTitle>
                <DialogDescription className="sr-only">
                  Study details and series list with images.
                </DialogDescription>
              </DialogHeader>
            </div>

            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {currentItem.patientName || currentItem.patientId || "-"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {birthDateText || "-"}
                    {birthAgeText ? ` - ${birthAgeText}` : ""} · {genderLabel}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-background p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Calendar className="w-4 h-4 text-primary" />
                  Study Info
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-1">
                    <p className="text-muted-foreground">Accession #</p>
                    <p className="font-medium text-foreground">
                      {currentItem.accessionNumber || "-"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-1">
                    <p className="text-muted-foreground">Study Date</p>
                    <p className="font-medium text-foreground">
                      {formatDicomDate(currentItem.studyDate || "") || "-"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-1">
                    <p className="text-muted-foreground">Modality</p>
                    <div className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-foreground text-xs">
                      {currentItem.modalityCode || "-"}
                    </div>
                  </div>
                  <div className="col-span-2 rounded-xl border border-border bg-muted/30 p-3 space-y-1">
                    <p className="text-muted-foreground">Description</p>
                    <p className="font-medium text-foreground">
                      {currentItem.studyDescription || "-"}
                    </p>
                  </div>
                  <div className="col-span-2 rounded-xl border border-border bg-muted/30 p-3 space-y-1">
                    <p className="text-muted-foreground">Referring Physician</p>
                    <p className="font-medium text-foreground">
                      {currentItem.referringPhysician || "-"}
                    </p>
                  </div>
                  <div className="col-span-2 rounded-xl border border-border bg-muted/30 p-3 space-y-1">
                    <p className="text-muted-foreground">Reporting</p>
                    <p className="font-medium text-foreground">
                      {assignedRadiologist?.radiologist_name ||
                        activeReport?.radiologist_name ||
                        user?.fullName ||
                        "-"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-background p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
                  <Layers className="w-4 h-4 text-primary" />
                  Series ({series.length || currentItem.seriesCount})
                </div>
                {seriesLoading && (
                  <p className="text-sm text-muted-foreground">Loading series...</p>
                )}
                {seriesError && !seriesLoading && (
                  <p className="text-sm text-destructive">{seriesError}</p>
                )}
                {!seriesLoading && !seriesError && (
                  <div className="space-y-2">
                    {series.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        No series available for this study.
                      </p>
                    )}
                    {series.map(s => {
                      const instances = instancesBySeries[s.SeriesInstanceUID] ?? [];
                      const isExpanded = expandedSeriesId === s.SeriesInstanceUID;
                      const isThumbReady = Boolean(thumbnailReadyBySeries[s.SeriesInstanceUID]);
                      return (
                        <div
                          key={s.SeriesInstanceUID}
                          className="rounded-xl border border-border bg-muted/30 p-3 text-sm cursor-pointer"
                          onClick={async () => {
                            await openViewerAtSeries(s.SeriesInstanceUID);
                          }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                                {s.SeriesInstanceUID ? (
                                  <button
                                    type="button"
                                    onClick={async e => {
                                      e.stopPropagation();
                                      await openViewerAtSeries(s.SeriesInstanceUID);
                                    }}
                                    className="relative w-12 h-12 rounded-lg bg-muted flex items-center justify-center overflow-hidden"
                                  >
                                    <img
                                      src={getSeriesThumbnailSrc(s.SeriesInstanceUID)}
                                      alt="Series thumbnail"
                                      loading="lazy"
                                      decoding="async"
                                    className={`w-full h-full object-contain transition-opacity ${
                                        isThumbReady ? "opacity-100" : "opacity-0"
                                      }`}
                                      onLoad={() => {
                                        setThumbnailReadyBySeries(prev => ({
                                          ...prev,
                                          [s.SeriesInstanceUID]: true,
                                        }));
                                      }}
                                      onError={() => {
                                        setThumbnailReadyBySeries(prev => ({
                                          ...prev,
                                          [s.SeriesInstanceUID]: false,
                                        }));
                                      }}
                                    />
                                    {!isThumbReady && (
                                      <FileImage className="w-5 h-5 text-muted-foreground" />
                                    )}
                                  </button>
                                ) : (
                                  <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
                                    <FileImage className="w-5 h-5 text-muted-foreground" />
                                  </div>
                                )}
                              </div>
                              <div>
                                <p className="font-medium text-foreground">
                                  {s.SeriesNumber ? `Series ${s.SeriesNumber}` : "Series"}
                                  {s.SeriesDescription && ` · ${s.SeriesDescription}`}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {s.Modality && `${s.Modality} · `}
                                  {s.NumberOfSeriesRelatedInstances} images
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={async e => {
                                  e.stopPropagation();
                                  if (isExpanded) {
                                    setExpandedSeriesId(null);
                                    return;
                                  }
                                  setExpandedSeriesId(s.SeriesInstanceUID);
                                  if (!instancesBySeries[s.SeriesInstanceUID]) {
                                    try {
                                      setInstancesLoadingSeriesId(s.SeriesInstanceUID);
                                      const loaded = await dicomWebService.fetchInstances(
                                        currentItem.studyInstanceUid,
                                        s.SeriesInstanceUID
                                      );
                                      if (Array.isArray(loaded) && loaded.length > 0) {
                                        setInstancesBySeries(prev => ({
                                          ...prev,
                                          [s.SeriesInstanceUID]: loaded as Record<string, unknown>[],
                                        }));
                                      }
                                    } catch (error) {
                                      toast({
                                        title: "Failed to load images",
                                        description:
                                          error instanceof Error
                                            ? error.message
                                            : "An error occurred while fetching frames.",
                                        variant: "destructive",
                                      });
                                    } finally {
                                      setInstancesLoadingSeriesId(prev =>
                                        prev === s.SeriesInstanceUID ? null : prev
                                      );
                                    }
                                  }
                                }}
                              >
                                <ChevronDown
                                  className={`w-4 h-4 transition-transform ${
                                    isExpanded ? "rotate-180" : ""
                                  }`}
                                />
                              </button>
                              {canDeleteSeries && (
                                <button
                                  type="button"
                                  className="text-destructive hover:text-destructive/80"
                                  onClick={async e => {
                                    e.stopPropagation();
                                    const reason = await confirmDelete({
                                      title: "Delete series?",
                                      description: "This will delete this DICOM series from the study.",
                                      target: `${s.SeriesDescription || "Series"} (${s.SeriesInstanceUID})`,
                                    });
                                    if (!reason) return;
                                    try {
                                      await dicomWebService.deleteSeries(
                                        currentItem.patientId,
                                        currentItem.studyInstanceUid,
                                        s.SeriesInstanceUID,
                                        { reason }
                                      );
                                      setSeries(prev =>
                                        prev.filter(
                                          seriesItem =>
                                            seriesItem.SeriesInstanceUID !== s.SeriesInstanceUID
                                        )
                                      );
                                      setInstancesBySeries(prev => {
                                        const next = { ...prev };
                                        delete next[s.SeriesInstanceUID];
                                        return next;
                                      });
                                      if (expandedSeriesId === s.SeriesInstanceUID) {
                                        setExpandedSeriesId(null);
                                      }
                                      if (activeSeriesIdForViewer === s.SeriesInstanceUID) {
                                        setActiveSeriesIdForViewer(null);
                                        setActiveInstanceIndex(null);
                                      }
                                      toast({
                                        title: "Series deleted",
                                        description: "Series deleted from server.",
                                        variant: "destructive",
                                      });
                                    } catch (error) {
                                      toast({
                                        title: "Failed to delete series",
                                        description:
                                          error instanceof Error
                                            ? error.message
                                            : "An error occurred while deleting the series.",
                                        variant: "destructive",
                                      });
                                    }
                                  }}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="mt-3 space-y-3">
                              {instancesLoadingSeriesId === s.SeriesInstanceUID && (
                                <p className="text-xs text-muted-foreground">Loading images...</p>
                              )}
                              {instances.length === 0 && instancesLoadingSeriesId !== s.SeriesInstanceUID && (
                                <p className="text-xs text-muted-foreground">No images found.</p>
                              )}
                              {instances.length > 0 && (
                                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                                  {instances.map((instance, index) => {
                                    const rawElement = instance["00080018"] as
                                      | { Value?: unknown[] }
                                      | undefined;
                                    const value = Array.isArray(rawElement?.Value)
                                      ? rawElement.Value[0]
                                      : undefined;
                                    const sopInstanceUID =
                                      (value as string | number | undefined)?.toString() ?? "";
                                    const imageNumber = index + 1;
                                    const instanceKey = `${s.SeriesInstanceUID}-${sopInstanceUID}-${index}`;
                                    const thumbUrl =
                                      sopInstanceUID &&
                                      dicomWebService.getInstanceThumbnailUrl(
                                        currentItem.studyInstanceUid,
                                        s.SeriesInstanceUID,
                                        sopInstanceUID
                                      );
                                    const isInstanceThumbReady = Boolean(
                                      thumbnailReadyByInstance[instanceKey]
                                    );
                                    return (
                                      <div key={sopInstanceUID || index} className="space-y-1">
                                        <div className="relative">
                                          <button
                                            type="button"
                                            className="w-20 h-20 rounded-md bg-muted flex items-center justify-center overflow-hidden"
                                            onClick={async e => {
                                              e.stopPropagation();
                                              await openViewerAtSeries(s.SeriesInstanceUID, index);
                                            }}
                                          >
                                            {thumbUrl ? (
                                              <>
                                                <img
                                                  src={thumbUrl}
                                                  alt={`Image ${imageNumber}`}
                                                  loading="lazy"
                                                  decoding="async"
                                                  className={`w-full h-full object-cover transition-opacity ${
                                                    isInstanceThumbReady ? "opacity-100" : "opacity-0"
                                                  }`}
                                                  onLoad={() => {
                                                    setThumbnailReadyByInstance(prev => ({
                                                      ...prev,
                                                      [instanceKey]: true,
                                                    }));
                                                    setThumbnailErrorByInstance(prev => ({
                                                      ...prev,
                                                      [instanceKey]: false,
                                                    }));
                                                  }}
                                                  onError={() => {
                                                    setThumbnailReadyByInstance(prev => ({
                                                      ...prev,
                                                      [instanceKey]: false,
                                                    }));
                                                    setThumbnailErrorByInstance(prev => ({
                                                      ...prev,
                                                      [instanceKey]: true,
                                                    }));
                                                  }}
                                                />
                                                {!isInstanceThumbReady && (
                                                  <FileImage className="w-4 h-4 text-muted-foreground" />
                                                )}
                                              </>
                                            ) : (
                                              <FileImage className="w-4 h-4 text-muted-foreground" />
                                            )}
                                          </button>
                                          {canDeleteInstance && (
                                            <button
                                              type="button"
                                              className="absolute top-1 right-1 text-destructive hover:text-destructive/80"
                                              onClick={async e => {
                                                e.stopPropagation();
                                                if (!sopInstanceUID) {
                                                  toast({
                                                    title: "Failed to read SOPInstanceUID",
                                                    description: "Instance data is incomplete.",
                                                    variant: "destructive",
                                                  });
                                                  return;
                                                }
                                                const reason = await confirmDelete({
                                                  title: "Delete image?",
                                                  description: "This will delete this DICOM instance from the series.",
                                                  target: `Image ${imageNumber} (${sopInstanceUID})`,
                                                });
                                                if (!reason) return;
                                                try {
                                                  await dicomWebService.deleteInstance(
                                                    currentItem.patientId,
                                                    currentItem.studyInstanceUid,
                                                    s.SeriesInstanceUID,
                                                    sopInstanceUID,
                                                    { reason }
                                                  );
                                                  setInstancesBySeries(prev => {
                                                    const current =
                                                      prev[s.SeriesInstanceUID] ?? [];
                                                    const nextList = current.filter(
                                                      (_, i) => i !== index
                                                    );
                                                    return {
                                                      ...prev,
                                                      [s.SeriesInstanceUID]: nextList,
                                                    };
                                                  });
                                                  setSeries(prev =>
                                                    prev.map(seriesItem =>
                                                      seriesItem.SeriesInstanceUID ===
                                                      s.SeriesInstanceUID
                                                        ? {
                                                            ...seriesItem,
                                                            NumberOfSeriesRelatedInstances:
                                                              Math.max(
                                                                0,
                                                                seriesItem.NumberOfSeriesRelatedInstances -
                                                                  1
                                                              ),
                                                          }
                                                        : seriesItem
                                                    )
                                                  );
                                                  if (activeSeriesIdForViewer === s.SeriesInstanceUID) {
                                                    setActiveSeriesIdForViewer(null);
                                                    setActiveInstanceIndex(null);
                                                  }
                                                  toast({
                                                    title: "Image deleted",
                                                    description:
                                                      "Image deleted from server.",
                                                    variant: "destructive",
                                                  });
                                                } catch (error) {
                                                  toast({
                                                    title: "Failed to delete image",
                                                    description:
                                                      error instanceof Error
                                                        ? error.message
                                                        : "An error occurred while deleting the image.",
                                                    variant: "destructive",
                                                  });
                                                }
                                              }}
                                            >
                                              <Trash2 className="w-3 h-3" />
                                            </button>
                                          )}
                                        </div>
                                        <div className="text-[10px] text-center text-muted-foreground">
                                          Image {imageNumber}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-border bg-background/95 px-6 py-4">
              {actionButtons}
            </div>
          </div>
        </DialogContent>
        <Dialog
          open={Boolean(activeSeriesIdForViewer)}
          onOpenChange={open => {
            if (!open) {
              setActiveSeriesIdForViewer(null);
              setActiveInstanceIndex(null);
            }
          }}
        >
          <DialogContent className="h-[84vh] max-h-[84vh] w-[94vw] max-w-5xl overflow-hidden rounded-2xl border-0 bg-black p-0 text-white">
            <DialogHeader className="border-b border-white/10 px-4 py-3">
              <DialogTitle className="text-base font-semibold text-white">
                {series.find(entry => entry.SeriesInstanceUID === activeSeriesIdForViewer)?.SeriesDescription || "Series Viewer"}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Viewer for browsing and switching study series images.
              </DialogDescription>
            </DialogHeader>
            {currentItem && activeSeriesIdForViewer && (
              <ViewerContent
                series={series}
                activeSeriesIdForViewer={activeSeriesIdForViewer}
                activeInstanceIndex={activeInstanceIndex}
                isLoadingActiveSeries={instancesLoadingSeriesId === activeSeriesIdForViewer}
                instancesBySeries={instancesBySeries}
                studyInstanceUid={currentItem.studyInstanceUid}
                onSelectSeries={seriesId => {
                  openViewerAtSeries(seriesId);
                }}
                onChangeImageIndex={(seriesId, index) => {
                  updateViewerIndex(seriesId, index);
                }}
              />
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DialogContent className="max-w-2xl rounded-2xl">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-foreground">
                Edit DICOM Tags
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Update patient and study metadata for this worklist item.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-6">
              <div className="space-y-3">
                <h3 className="font-semibold text-foreground flex items-center gap-2">
                  <User className="w-4 h-4 text-primary" /> Patient Tags
                </h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Patient Name</p>
                    <Input value={editPatientName} onChange={e => setEditPatientName(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Patient ID</p>
                    <Input value={editPatientId} onChange={e => setEditPatientId(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Other Patient IDs</p>
                    <Input value={editOtherPatientIds} onChange={e => setEditOtherPatientIds(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Patient Birth Date</p>
                    <Input value={editPatientBirthDate} onChange={e => setEditPatientBirthDate(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Patient Sex</p>
                    <Input value={editPatientSex} onChange={e => setEditPatientSex(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button
                    className="rounded-xl"
                    disabled={isSavingPatientTags}
                    onClick={async () => {
                      if (!currentItem) return;
                      try {
                        setIsSavingPatientTags(true);
                        const normalizedBirthDate = normalizeDicomDateInput(editPatientBirthDate);
                        const normalizedSex = normalizeDicomSexInput(editPatientSex);
                        await dicomWebService.updateStudyMetadata(currentItem.studyInstanceUid, {
                          patientName: editPatientName,
                          patientId: editPatientId,
                          patientBirthDate: normalizedBirthDate,
                          patientSex: normalizedSex,
                          otherPatientIds: editOtherPatientIds,
                        });
                        const nextSex: WorklistItem["sex"] =
                          normalizedSex === "M" || normalizedSex === "F" || normalizedSex === "O"
                            ? normalizedSex
                            : "O";
                        applyCurrentItemUpdate({
                          ...currentItem,
                          patientName: editPatientName,
                          patientId: editPatientId,
                          otherPatientIds: editOtherPatientIds,
                          birthDate: normalizedBirthDate,
                          age: calculateAgeLabel(normalizedBirthDate, currentItem.studyDate),
                          sex: nextSex,
                        });
                        toast({
                          title: "Patient tags updated",
                          description: "Patient tags saved to dicomweb-pacs.",
                        });
                      } catch (error) {
                        toast({
                          title: "Failed to save patient tags",
                          description:
                            error instanceof Error
                              ? error.message
                              : "An error occurred while saving patient tags.",
                          variant: "destructive",
                        });
                      } finally {
                        setIsSavingPatientTags(false);
                      }
                    }}
                  >
                    Save Patient Tags
                  </Button>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <h3 className="font-semibold text-foreground flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-primary" /> Study Tags
                </h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Accession Number</p>
                    <Input value={editAccessionNumber} onChange={e => setEditAccessionNumber(e.target.value)} className="h-8 rounded-lg text-sm font-mono" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Institution Name</p>
                    <Input value={editInstitutionName} onChange={e => setEditInstitutionName(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <p className="text-xs text-muted-foreground">Study Description</p>
                    <Input value={editStudyDescription} onChange={e => setEditStudyDescription(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Referring Physician</p>
                    <Input value={editReferringPhysician} onChange={e => setEditReferringPhysician(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Study Date</p>
                    <Input value={editStudyDate} onChange={e => setEditStudyDate(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Study Time</p>
                    <Input value={editStudyTime} onChange={e => setEditStudyTime(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Study ID</p>
                    <Input value={editStudyId} onChange={e => setEditStudyId(e.target.value)} className="h-8 rounded-lg text-sm" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button
                    className="rounded-xl"
                    disabled={isSavingStudyTags}
                    onClick={async () => {
                      if (!currentItem) return;
                      try {
                        setIsSavingStudyTags(true);
                        const normalizedStudyDate = normalizeDicomDateInput(editStudyDate);
                        const normalizedStudyTime = normalizeDicomTimeInput(editStudyTime);
                        await dicomWebService.updateStudyMetadata(currentItem.studyInstanceUid, {
                          accessionNumber: editAccessionNumber,
                          institutionName: editInstitutionName,
                          studyDescription: editStudyDescription,
                          referringPhysician: editReferringPhysician,
                          studyDate: normalizedStudyDate,
                          studyTime: normalizedStudyTime,
                          studyId: editStudyId,
                        });
                        applyCurrentItemUpdate({
                          ...currentItem,
                          accessionNumber: editAccessionNumber,
                          institutionName: editInstitutionName,
                          studyDescription: editStudyDescription,
                          referringPhysician: editReferringPhysician,
                          studyDate: normalizedStudyDate,
                          studyTime: normalizedStudyTime,
                          studyId: editStudyId,
                          age: calculateAgeLabel(currentItem.birthDate, normalizedStudyDate),
                        });
                        toast({
                          title: "Study tags updated",
                          description: "Study tags saved to dicomweb-pacs.",
                        });
                      } catch (error) {
                        toast({
                          title: "Failed to save study tags",
                          description:
                            error instanceof Error
                              ? error.message
                              : "An error occurred while saving study tags.",
                          variant: "destructive",
                        });
                      } finally {
                        setIsSavingStudyTags(false);
                      }
                    }}
                  >
                    Save Study Tags
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </Dialog>
      {DeleteReasonDialog}
      </>
    );
  }

  return (
    <>
    <Dialog open={!!item} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-6xl w-[92vw] h-[92vh] rounded-2xl overflow-hidden p-0">
        <div className="flex flex-col max-h-[92vh]">
          <div className="border-b border-border bg-background/95 px-6 py-4">
            <DialogHeader className="space-y-1">
              <DialogTitle className="text-lg font-semibold text-foreground">
                Distribution
              </DialogTitle>
              <DialogDescription className="sr-only">
                Study details and series list with images.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
              <TabsList className={`grid w-full ${showTimelineTab ? "grid-cols-4" : "grid-cols-3"} rounded-xl bg-muted/40 p-1`}>
                <TabsTrigger
                  value="info"
                  className="rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  Info
                </TabsTrigger>
                <TabsTrigger
                  value="print"
                  className="rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  Print
                </TabsTrigger>
                <TabsTrigger
                  value="whatsapp"
                  className="rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  WhatsApp
                </TabsTrigger>
                {showTimelineTab && (
                  <TabsTrigger
                    value="timeline"
                    className="rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm"
                  >
                    Timeline
                  </TabsTrigger>
                )}
              </TabsList>
              <TabsContent
                value="info"
                className="space-y-6 transition-all duration-300 data-[state=inactive]:opacity-0 data-[state=inactive]:-translate-y-1 data-[state=inactive]:pointer-events-none"
              >
                <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
                  <div className="rounded-2xl border border-border bg-background p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <User className="w-4 h-4 text-primary" />
                      Patient
                    </div>
                    <div className="mt-4 grid gap-3 text-sm">
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Patient Name</span>
                        <span className="text-right font-medium text-foreground">
                          {currentItem.patientName || "-"}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Medical Record No</span>
                        <span className="text-right font-medium text-foreground">
                          {currentItem.patientId || "-"}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Sex</span>
                        <span className="text-right font-medium text-foreground">
                          {currentItem.sex === "M"
                            ? "Male"
                            : currentItem.sex === "F"
                              ? "Female"
                              : "Other"}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Birth Date</span>
                        <span className="text-right font-medium text-foreground">
                          {birthDateText}
                          {birthAgeText ? ` - ${birthAgeText}` : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border bg-background p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Calendar className="w-4 h-4 text-primary" />
                      Study
                    </div>
                    <div className="mt-4 grid gap-3 text-sm">
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Study Date</span>
                        <span className="text-right font-medium text-foreground">
                          {formatDicomDate(currentItem.studyDate || "") || "-"}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Modality</span>
                        <Badge className="rounded-full bg-muted text-foreground border-border">
                          {currentItem.modalityCode || "-"}
                        </Badge>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Study</span>
                        <span className="text-right font-medium text-foreground">
                          {currentItem.studyDescription || "-"}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Clinician</span>
                        <span className="text-right font-medium text-foreground">
                          {currentItem.referringPhysician || "-"}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">Radiology Doctor</span>
                        <span className="text-right font-medium text-foreground">
                          {assignedRadiologist?.radiologist_name ||
                            activeReport?.radiologist_name ||
                            user?.fullName ||
                            "-"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FileText className="w-4 h-4 text-primary" />
                    Finding & Conclusion
                  </div>
                  <div
                    className="mt-3 text-sm text-foreground leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: findingsHtml }}
                  />
                  <div
                    className="mt-4 text-sm text-foreground leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: conclusionHtml }}
                  />
                </div>

                <div className="rounded-2xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-foreground flex items-center gap-2">
                      <Layers className="w-4 h-4 text-primary" /> Series (
                      {series.length || currentItem.seriesCount})
                    </h3>
                  </div>
            {seriesLoading && (
              <p className="text-sm text-muted-foreground">Loading series...</p>
            )}
            {seriesError && !seriesLoading && (
              <p className="text-sm text-destructive">{seriesError}</p>
            )}
            {!seriesLoading && !seriesError && (
              <div className="space-y-2">
                {series.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No series available for this study.
                  </p>
                )}
                {series.map(s => {
                  const instances = instancesBySeries[s.SeriesInstanceUID] ?? [];
                  const isExpanded = expandedSeriesId === s.SeriesInstanceUID;
                  const isThumbReady = Boolean(thumbnailReadyBySeries[s.SeriesInstanceUID]);
                  return (
                    <div
                      key={s.SeriesInstanceUID}
                      className="rounded-xl border border-border/60 bg-muted/20 p-3 text-sm cursor-pointer transition-colors hover:bg-muted/30"
                      onClick={async () => {
                        await openViewerAtSeries(s.SeriesInstanceUID);
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                            {s.SeriesInstanceUID ? (
                              <button
                                type="button"
                                onClick={async e => {
                                  e.stopPropagation();
                                  await openViewerAtSeries(s.SeriesInstanceUID);
                                }}
                                className="relative w-12 h-12 rounded-lg bg-muted flex items-center justify-center overflow-hidden"
                              >
                                <img
                                  src={getSeriesThumbnailSrc(s.SeriesInstanceUID)}
                                  alt="Series thumbnail"
                                  loading="lazy"
                                  decoding="async"
                                  className={`w-full h-full object-contain transition-opacity ${
                                    isThumbReady ? "opacity-100" : "opacity-0"
                                  }`}
                                  onLoad={() => {
                                    setThumbnailReadyBySeries(prev => ({
                                      ...prev,
                                      [s.SeriesInstanceUID]: true,
                                    }));
                                  }}
                                  onError={e => {
                                    setThumbnailReadyBySeries(prev => ({
                                      ...prev,
                                      [s.SeriesInstanceUID]: false,
                                    }));
                                  }}
                                />
                                {!isThumbReady && (
                                  <FileImage className="w-5 h-5 text-muted-foreground" />
                                )}
                              </button>
                            ) : (
                              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
                                <FileImage className="w-5 h-5 text-muted-foreground" />
                              </div>
                            )}
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {s.SeriesNumber ? `Series ${s.SeriesNumber}` : "Series"}
                              {s.SeriesDescription && ` · ${s.SeriesDescription}`}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {s.Modality && `${s.Modality} · `}
                              {s.NumberOfSeriesRelatedInstances} images
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={async e => {
                              e.stopPropagation();
                              if (isExpanded) {
                                setExpandedSeriesId(null);
                                return;
                              }
                              setExpandedSeriesId(s.SeriesInstanceUID);
                              if (!instancesBySeries[s.SeriesInstanceUID]) {
                                try {
                                  setInstancesLoadingSeriesId(s.SeriesInstanceUID);
                                  const loaded = await dicomWebService.fetchInstances(
                                    currentItem.studyInstanceUid,
                                    s.SeriesInstanceUID
                                  );
                                  if (Array.isArray(loaded) && loaded.length > 0) {
                                    setInstancesBySeries(prev => ({
                                      ...prev,
                                      [s.SeriesInstanceUID]: loaded as Record<string, unknown>[],
                                    }));
                                  }
                                } catch (error) {
                                  toast({
                                    title: "Failed to load images",
                                    description:
                                      error instanceof Error
                                        ? error.message
                                        : "An error occurred while fetching frames.",
                                    variant: "destructive",
                                  });
                                } finally {
                                  setInstancesLoadingSeriesId(prev =>
                                    prev === s.SeriesInstanceUID ? null : prev
                                  );
                                }
                              }
                            }}
                          >
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                isExpanded ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                          {canDeleteSeries && (
                            <button
                              type="button"
                              className="text-destructive hover:text-destructive/80"
                              onClick={async e => {
                                e.stopPropagation();
                                const reason = await confirmDelete({
                                  title: "Delete series?",
                                  description: "This will delete this DICOM series from the study.",
                                  target: `${s.SeriesDescription || "Series"} (${s.SeriesInstanceUID})`,
                                });
                                if (!reason) return;
                                try {
                                  await dicomWebService.deleteSeries(
                                    item.patientId,
                                    item.studyInstanceUid,
                                    s.SeriesInstanceUID,
                                    { reason }
                                  );
                                  setSeries(prev =>
                                    prev.filter(
                                      seriesItem =>
                                        seriesItem.SeriesInstanceUID !== s.SeriesInstanceUID
                                    )
                                  );
                                  setInstancesBySeries(prev => {
                                    const next = { ...prev };
                                    delete next[s.SeriesInstanceUID];
                                    return next;
                                  });
                                  if (expandedSeriesId === s.SeriesInstanceUID) {
                                    setExpandedSeriesId(null);
                                  }
                                  if (activeSeriesIdForViewer === s.SeriesInstanceUID) {
                                    setActiveSeriesIdForViewer(null);
                                    setActiveInstanceIndex(null);
                                  }
                                  toast({
                                    title: "Series deleted",
                                    description: "Series deleted from server.",
                                    variant: "destructive",
                                  });
                                } catch (error) {
                                  toast({
                                    title: "Failed to delete series",
                                    description:
                                      error instanceof Error
                                        ? error.message
                                        : "An error occurred while deleting the series.",
                                    variant: "destructive",
                                  });
                                }
                              }}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      {expandedSeriesId === s.SeriesInstanceUID && (
                        <div className="mt-3 pl-16 max-h-48 overflow-y-auto">
                          {instancesLoadingSeriesId === s.SeriesInstanceUID &&
                            instances.length === 0 && (
                              <p className="text-xs text-muted-foreground">Loading images...</p>
                            )}
                          {instances.length > 0 && (
                            <div className="grid grid-cols-4 gap-2">
                              {instances.map((instance, index) => {
                                const inst = instance as Record<string, unknown>;
                                const numElement = inst["00200013"] as
                                  | { Value?: unknown[] }
                                  | undefined;
                                const numValue = Array.isArray(numElement?.Value)
                                  ? numElement.Value[0]
                                  : undefined;
                                const imageNumber =
                                  (numValue as string | number | undefined)?.toString() ??
                                  String(index + 1);
                                const sopElement = inst["00080018"] as
                                  | { Value?: unknown[] }
                                  | undefined;
                                const sopValue = Array.isArray(sopElement?.Value)
                                  ? sopElement.Value[0]
                                  : undefined;
                                const sopInstanceUID =
                                  (sopValue as string | number | undefined)?.toString() ?? "";
                                const instanceKey = `${s.SeriesInstanceUID}:${sopInstanceUID || index}`;
                                const isInstanceThumbReady = Boolean(
                                  thumbnailReadyByInstance[instanceKey]
                                );
                                const isInstanceThumbError = Boolean(
                                  thumbnailErrorByInstance[instanceKey]
                                );
                                const thumbUrl =
                                  sopInstanceUID &&
                                  dicomWebService.getInstanceThumbnailUrl(
                                    currentItem.studyInstanceUid,
                                    s.SeriesInstanceUID,
                                    sopInstanceUID
                                  );
                                return (
                                  <div key={sopInstanceUID || index} className="space-y-1">
                                    <div className="relative">
                                      <button
                                        type="button"
                                        className="w-20 h-20 rounded-md bg-muted flex items-center justify-center overflow-hidden"
                                        onClick={async e => {
                                          e.stopPropagation();
                                          await openViewerAtSeries(s.SeriesInstanceUID, index);
                                        }}
                                      >
                                        {thumbUrl ? (
                                          <>
                                            <img
                                              src={thumbUrl}
                                              alt={`Image ${imageNumber}`}
                                              loading="lazy"
                                              decoding="async"
                                              className={`w-full h-full object-cover transition-opacity ${
                                                isInstanceThumbReady ? "opacity-100" : "opacity-0"
                                              }`}
                                              onLoad={() => {
                                                setThumbnailReadyByInstance(prev => ({
                                                  ...prev,
                                                  [instanceKey]: true,
                                                }));
                                                setThumbnailErrorByInstance(prev => ({
                                                  ...prev,
                                                  [instanceKey]: false,
                                                }));
                                              }}
                                              onError={() => {
                                                setThumbnailReadyByInstance(prev => ({
                                                  ...prev,
                                                  [instanceKey]: false,
                                                }));
                                                setThumbnailErrorByInstance(prev => ({
                                                  ...prev,
                                                  [instanceKey]: true,
                                                }));
                                              }}
                                            />
                                            {!isInstanceThumbReady && !isInstanceThumbError && (
                                              <div className="absolute inset-0 flex items-center justify-center">
                                                <div className="w-6 h-6 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                                              </div>
                                            )}
                                            {isInstanceThumbError && (
                                              <div className="absolute inset-0 flex items-center justify-center">
                                                <FileImage className="w-5 h-5 text-muted-foreground" />
                                              </div>
                                            )}
                                          </>
                                        ) : (
                                          <FileImage className="w-5 h-5 text-muted-foreground" />
                                        )}
                                      </button>
                                      {canDeleteInstance && (
                                        <button
                                          type="button"
                                          className="absolute top-1 right-1 text-destructive hover:text-destructive/80"
                                          onClick={async e => {
                                            e.stopPropagation();
                                            if (!sopInstanceUID) {
                                              toast({
                                                title: "Failed to read SOPInstanceUID",
                                                description: "Instance data is incomplete.",
                                                variant: "destructive",
                                              });
                                              return;
                                            }
                                            const reason = await confirmDelete({
                                              title: "Delete image?",
                                              description: "This will delete this DICOM instance from the series.",
                                              target: `Image ${imageNumber} (${sopInstanceUID})`,
                                            });
                                            if (!reason) return;
                                            try {
                                              await dicomWebService.deleteInstance(
                                                currentItem.patientId,
                                                currentItem.studyInstanceUid,
                                                s.SeriesInstanceUID,
                                                sopInstanceUID,
                                                { reason }
                                              );
                                              setInstancesBySeries(prev => {
                                                const current =
                                                  prev[s.SeriesInstanceUID] ?? [];
                                                const nextList = current.filter(
                                                  (_, i) => i !== index
                                                );
                                                return {
                                                  ...prev,
                                                  [s.SeriesInstanceUID]: nextList,
                                                };
                                              });
                                              setSeries(prev =>
                                                prev.map(seriesItem =>
                                                  seriesItem.SeriesInstanceUID ===
                                                  s.SeriesInstanceUID
                                                    ? {
                                                        ...seriesItem,
                                                        NumberOfSeriesRelatedInstances:
                                                          Math.max(
                                                            0,
                                                            seriesItem.NumberOfSeriesRelatedInstances -
                                                              1
                                                          ),
                                                      }
                                                    : seriesItem
                                                )
                                              );
                                              if (activeSeriesIdForViewer === s.SeriesInstanceUID) {
                                                setActiveSeriesIdForViewer(null);
                                                setActiveInstanceIndex(null);
                                              }
                                              toast({
                                                title: "Image deleted",
                                                description:
                                                  "Image deleted from server.",
                                                variant: "destructive",
                                              });
                                            } catch (error) {
                                              toast({
                                                title: "Failed to delete image",
                                                description:
                                                  error instanceof Error
                                                    ? error.message
                                                    : "An error occurred while deleting the image.",
                                                variant: "destructive",
                                              });
                                            }
                                          }}
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                    <div className="text-[10px] text-center text-muted-foreground">
                                      Image {imageNumber}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
              </TabsContent>

              {showTimelineTab && (
                <TabsContent
                  value="timeline"
                  className="space-y-5 transition-all duration-300 data-[state=inactive]:opacity-0 data-[state=inactive]:-translate-y-1 data-[state=inactive]:pointer-events-none"
                >
                  {timelineLoading ? (
                    <div className="flex min-h-[220px] items-center justify-center gap-3 rounded-2xl border border-border bg-background text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading timeline...
                    </div>
                  ) : timelineError ? (
                    <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                      {timelineError}
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {[
                          {
                            label: "Patient Waiting",
                            value: formatDuration(
                              timeline?.timestamps.order_created_at,
                              timeline?.timestamps.technologist_started_at || timeline?.timestamps.mwl_published_at
                            ),
                          },
                          {
                            label: "Examination",
                            value: formatDuration(
                              timeline?.timestamps.technologist_started_at,
                              timeline?.timestamps.study_completed_at
                            ),
                          },
                          {
                            label: "Radiologist Reading",
                            value: formatDuration(
                              timeline?.timestamps.report_started_at,
                              timeline?.timestamps.report_finalized_at
                            ),
                          },
                          {
                            label: "Total Turnaround",
                            value: formatDuration(
                              timeline?.timestamps.order_created_at,
                              timeline?.timestamps.distributed_at ||
                                timeline?.timestamps.qc_completed_at ||
                                timeline?.timestamps.report_finalized_at
                            ),
                          },
                        ].map(metric => (
                          <div key={metric.label} className="rounded-2xl border border-border bg-background p-4">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                              {metric.label}
                            </div>
                            <div className="mt-2 text-2xl font-bold text-foreground">{metric.value}</div>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-2xl border border-border bg-background p-4">
                        <div className="space-y-4">
                          {[
                            { label: "Order Received", time: timeline?.timestamps.order_created_at, actor: timeline?.actors?.admin },
                            { label: "Order Activated", time: timeline?.timestamps.order_activated_at, actor: timeline?.actors?.admin },
                            { label: "MWL Published", time: timeline?.timestamps.mwl_published_at, actor: timeline?.actors?.admin },
                            { label: "Technologist Started", time: timeline?.timestamps.technologist_started_at, actor: timeline?.actors?.technologist },
                            { label: "Study Completed / PACS Ready", time: timeline?.timestamps.study_completed_at, actor: timeline?.actors?.technologist },
                            { label: "Radiologist Started", time: timeline?.timestamps.report_started_at, actor: timeline?.actors?.radiologist },
                            { label: "Report Finalized", time: timeline?.timestamps.report_finalized_at, actor: timeline?.actors?.radiologist },
                            { label: "Quality Control Finished", time: timeline?.timestamps.qc_completed_at, actor: timeline?.actors?.qc_processed_by },
                            { label: "Distributed / Share Link Created", time: timeline?.timestamps.distributed_at, actor: timeline?.actors?.distributed_by },
                          ].map((event, index, events) => {
                            const actor = String(event.actor || "").trim();
                            const hasDisplayableActor = actor && actor.toLowerCase() !== "postgres-audit";

                            return (
                              <div key={event.label} className="relative flex gap-4">
                                <div className="flex w-5 shrink-0 justify-center">
                                  <span className={`mt-1.5 h-3 w-3 rounded-full ${event.time ? "bg-primary" : "bg-muted-foreground/25"}`} />
                                  {index < events.length - 1 && (
                                    <span className="absolute left-[9px] top-5 h-[calc(100%+0.5rem)] w-px bg-border" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1 pb-1">
                                  <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-center">
                                    <span className="font-medium text-foreground">{event.label}</span>
                                    <span className="text-sm text-muted-foreground">{formatReportDate(event.time)}</span>
                                  </div>
                                  {event.time && hasDisplayableActor && (
                                    <div className="mt-1 text-xs text-muted-foreground">
                                      {actor}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </TabsContent>
              )}
              <TabsContent
                value="print"
                className="space-y-4 transition-all duration-300 data-[state=inactive]:opacity-0 data-[state=inactive]:-translate-y-1 data-[state=inactive]:pointer-events-none"
              >
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="min-w-[240px]">
                    <Select
                      value={selectedPrintTemplateId ? String(selectedPrintTemplateId) : FALLBACK_TEMPLATE_VALUE}
                      onValueChange={value => setSelectedPrintTemplateId(value === FALLBACK_TEMPLATE_VALUE ? null : Number(value))}
                    >
                      <SelectTrigger className="h-10 rounded-xl">
                        <SelectValue placeholder="Print Template" />
                      </SelectTrigger>
                      <SelectContent>
                        {printTemplates.length === 0 && (
                          <SelectItem value={FALLBACK_TEMPLATE_VALUE}>Default Template</SelectItem>
                        )}
                        {printTemplates.map(template => (
                          <SelectItem key={template.id} value={String(template.id)}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    onClick={openQrLabelWindow}
                    disabled={!currentItem || isCreatingShare}
                  >
                    {isCreatingShare ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <QrCode className="w-4 h-4 mr-2" />
                    )}
                    {isCreatingShare ? "Menyiapkan QR..." : "Print QR Label"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    onClick={openPrintWindow}
                    disabled={!activeReport || reportLoading}
                  >
                    <Printer className="w-4 h-4 mr-2" />
                    Print
                  </Button>
                </div>

                {reportLoading && (
                  <p className="text-sm text-muted-foreground">Loading report...</p>
                )}
                {reportError && !reportLoading && (
                  <p className="text-sm text-destructive">{reportError}</p>
                )}
                {!reportLoading && !reportError && !activeReport && (
                  <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                    No final report is available yet.
                  </div>
                )}

                {activeReport && (
                  <div className="rounded-2xl border border-border bg-background overflow-hidden">
                    <iframe
                      title="Radiology Report Preview"
                      className="w-full h-[70vh] bg-white"
                      srcDoc={buildPrintHtml()}
                    />
                  </div>
                )}
              </TabsContent>
              <TabsContent
                value="whatsapp"
                className="space-y-4 transition-all duration-300 data-[state=inactive]:opacity-0 data-[state=inactive]:-translate-y-1 data-[state=inactive]:pointer-events-none"
              >
                {!canShare && (
                  <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                    You do not have access to create patient links.
                  </div>
                )}
                <div className="rounded-2xl border border-border bg-background p-4 space-y-4">
                  <div className="grid gap-2">
                    <div className="text-sm font-semibold text-muted-foreground">
                      Patient WhatsApp Number
                    </div>
                    <Input
                      value={whatsappNumber}
                      onChange={event => setWhatsappNumber(event.target.value)}
                      placeholder="example: 628123456789"
                    />
                  </div>
                  <div className="grid gap-2">
                        <div className="text-sm font-semibold text-muted-foreground">
                          Report link
                        </div>
                    <div className="grid gap-2">
                      <div className="text-sm font-semibold text-muted-foreground">
                        Patient template
                      </div>
                      <Select
                        value={selectedShareTemplateId ? String(selectedShareTemplateId) : FALLBACK_TEMPLATE_VALUE}
                        onValueChange={value => setSelectedShareTemplateId(value === FALLBACK_TEMPLATE_VALUE ? null : Number(value))}
                      >
                        <SelectTrigger className="rounded-xl">
                          <SelectValue placeholder="Select a patient template" />
                        </SelectTrigger>
                        <SelectContent>
                          {printTemplates.length === 0 && (
                            <SelectItem value={FALLBACK_TEMPLATE_VALUE}>Default Template</SelectItem>
                          )}
                          {printTemplates.map(template => (
                            <SelectItem key={template.id} value={String(template.id)}>
                              {template.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        This template is saved to the new token when the link is generated.
                      </p>
                    </div>
                    <Input value={whatsappLink || "-"} readOnly />
                    {shareExpiresAt && (
                      <div className="text-xs text-muted-foreground">
                        Valid until{" "}
                        {new Date(shareExpiresAt).toLocaleString("id-ID", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                  <div className="grid gap-2">
                    <div className="text-sm font-semibold text-muted-foreground">
                      Message
                    </div>
                    <Textarea
                      value={whatsappMessage}
                      onChange={event => {
                        setWhatsappTouched(true);
                        setWhatsappMessage(event.target.value);
                      }}
                      className="min-h-[220px]"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-xl"
                      onClick={() => {
                        setWhatsappTouched(false);
                        setWhatsappMessage(whatsappTemplate);
                      }}
                    >
                      Reset Template
                    </Button>
                    <Button
                      type="button"
                      className="rounded-xl"
                      onClick={handleSendWhatsapp}
                      disabled={isSendingWhatsapp}
                    >
                      {isSendingWhatsapp && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Send via WhatsApp
                    </Button>
                  </div>
                </div>
              </TabsContent>
            </Tabs>

          <Dialog
            open={distributionWarningOpen}
            onOpenChange={open => {
              setDistributionWarningOpen(open);
              if (!open) setDistributionWarnings([]);
            }}
          >
            <DialogContent className="max-w-md rounded-2xl">
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold text-foreground">
                  Incomplete Data
                </DialogTitle>
                <DialogDescription className="text-sm text-muted-foreground">
                  {distributionWarnings.join(", ")} {distributionWarnings.length === 1 ? "is" : "are"} not available. Continue distribution?
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    onClick={() => setDistributionWarningOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="rounded-xl"
                    onClick={() => {
                      setAllowIncompleteDistribution(true);
                      setDistributionWarningOpen(false);
                      setQcOfficerDialogOpen(true);
                    }}
                  >
                    Continue
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog
            open={qcOfficerDialogOpen}
            onOpenChange={open => {
              if (!open) {
                setQcOfficerDialogOpen(false);
              }
            }}
          >
            <DialogContent className="max-w-md rounded-2xl">
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold text-foreground">
                  Quality Control Staff
                </DialogTitle>
                <DialogDescription className="text-sm text-muted-foreground">
                  Select the staff member who performs quality control. The list is taken from ADMISSION and TECHNOLOGIST roles.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <div className="text-sm font-semibold text-muted-foreground">Patient Template</div>
                  <Select
                    value={selectedShareTemplateId ? String(selectedShareTemplateId) : FALLBACK_TEMPLATE_VALUE}
                    onValueChange={value => setSelectedShareTemplateId(value === FALLBACK_TEMPLATE_VALUE ? null : Number(value))}
                  >
                    <SelectTrigger className="rounded-xl">
                      <SelectValue placeholder="Select patient template" />
                    </SelectTrigger>
                    <SelectContent>
                      {printTemplates.length === 0 && (
                        <SelectItem value={FALLBACK_TEMPLATE_VALUE}>Default Template</SelectItem>
                      )}
                      {printTemplates.map(template => (
                        <SelectItem key={template.id} value={String(template.id)}>
                          {template.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <div className="text-sm font-semibold text-muted-foreground">Staff</div>
                  <Select
                    value={qcOfficerName}
                    onValueChange={setQcOfficerName}
                    disabled={qcOfficerLoading}
                  >
                    <SelectTrigger className="rounded-xl">
                      <SelectValue placeholder="Select quality control staff" />
                    </SelectTrigger>
                    <SelectContent>
                      {qcOfficerOptions.map(option => {
                        const label = option.nama_dokter || option.kode_dokter;
                        return (
                          <SelectItem key={option.id} value={label}>
                            {label} ({option.role})
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {qcOfficerError && (
                    <div className="text-xs text-destructive">{qcOfficerError}</div>
                  )}
                  {!qcOfficerLoading && !qcOfficerError && qcOfficerOptions.length === 0 && (
                    <div className="text-xs text-muted-foreground">
                      No user with the Editor role is available.
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    onClick={() => setQcOfficerDialogOpen(false)}
                    disabled={isCreatingShare}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="rounded-xl"
                    onClick={handleConfirmGenerateShare}
                    disabled={isCreatingShare || qcOfficerLoading || !qcOfficerName}
                  >
                    {isCreatingShare && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Generate token
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
            <DialogContent className="max-w-2xl rounded-2xl">
              <DialogHeader>
                <DialogTitle className="text-lg font-bold text-foreground">
                  Edit DICOM Tags
                </DialogTitle>
                <DialogDescription className="text-sm text-muted-foreground">
                  Separate patient tag and study tag updates.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-6">
                <div className="space-y-3">
                  <h3 className="font-semibold text-foreground flex items-center gap-2">
                    <User className="w-4 h-4 text-primary" /> Patient Tags
                  </h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Patient Name</p>
                      <Input
                        value={editPatientName}
                        onChange={e => setEditPatientName(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Patient ID</p>
                      <Input
                        value={editPatientId}
                        onChange={e => setEditPatientId(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Other Patient IDs</p>
                      <Input
                        value={editOtherPatientIds}
                        onChange={e => setEditOtherPatientIds(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Patient Birth Date</p>
                      <Input
                        value={editPatientBirthDate}
                        onChange={e => setEditPatientBirthDate(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Patient Sex</p>
                      <Input
                        value={editPatientSex}
                        onChange={e => setEditPatientSex(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      className="rounded-xl"
                      disabled={isSavingPatientTags}
                      onClick={async () => {
                        if (!currentItem) return;
                        try {
                          setIsSavingPatientTags(true);
                          const normalizedBirthDate = normalizeDicomDateInput(
                            editPatientBirthDate
                          );
                          const normalizedSex = normalizeDicomSexInput(editPatientSex);
                          await dicomWebService.updateStudyMetadata(currentItem.studyInstanceUid, {
                            patientName: editPatientName,
                            patientId: editPatientId,
                            patientBirthDate: normalizedBirthDate,
                            patientSex: normalizedSex,
                            otherPatientIds: editOtherPatientIds,
                          });
                          const nextSex: WorklistItem["sex"] =
                            normalizedSex === "M" || normalizedSex === "F" || normalizedSex === "O"
                              ? normalizedSex
                              : "O";
                          applyCurrentItemUpdate({
                            ...currentItem,
                            patientName: editPatientName,
                            patientId: editPatientId,
                            otherPatientIds: editOtherPatientIds,
                            birthDate: normalizedBirthDate,
                            age: calculateAgeLabel(normalizedBirthDate, currentItem.studyDate),
                            sex: nextSex,
                          });
                          toast({
                            title: "Patient tags updated",
                            description: "Patient tags saved to dicomweb-pacs.",
                          });
                        } catch (error) {
                          toast({
                            title: "Failed to save patient tags",
                            description:
                              error instanceof Error
                                ? error.message
                                : "An error occurred while saving patient tags.",
                            variant: "destructive",
                          });
                        } finally {
                          setIsSavingPatientTags(false);
                        }
                      }}
                    >
                      Save Patient Tags
                    </Button>
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <h3 className="font-semibold text-foreground flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary" /> Study Tags
                  </h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Accession Number</p>
                      <Input
                        value={editAccessionNumber}
                        onChange={e => setEditAccessionNumber(e.target.value)}
                        className="h-8 rounded-lg text-sm font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Institution Name</p>
                      <Input
                        value={editInstitutionName}
                        onChange={e => setEditInstitutionName(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="col-span-2 space-y-1">
                      <p className="text-xs text-muted-foreground">Study Description</p>
                      <Input
                        value={editStudyDescription}
                        onChange={e => setEditStudyDescription(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Referring Physician</p>
                      <Input
                        value={editReferringPhysician}
                        onChange={e => setEditReferringPhysician(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Study Date</p>
                      <Input
                        value={editStudyDate}
                        onChange={e => setEditStudyDate(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Study Time</p>
                      <Input
                        value={editStudyTime}
                        onChange={e => setEditStudyTime(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Study ID</p>
                      <Input
                        value={editStudyId}
                        onChange={e => setEditStudyId(e.target.value)}
                        className="h-8 rounded-lg text-sm"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <p className="text-xs text-muted-foreground">Study Instance UID</p>
                      <div className="h-8 rounded-lg text-sm flex items-center px-3 bg-muted/50">
                        {currentItem.studyInstanceUid}
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      className="rounded-xl"
                      disabled={isSavingStudyTags}
                      onClick={async () => {
                        if (!currentItem) return;
                        try {
                          setIsSavingStudyTags(true);
                          const normalizedStudyDate = normalizeDicomDateInput(editStudyDate);
                          const normalizedStudyTime = normalizeDicomTimeInput(editStudyTime);
                          await dicomWebService.updateStudyMetadata(currentItem.studyInstanceUid, {
                            accessionNumber: editAccessionNumber,
                            institutionName: editInstitutionName,
                            studyDescription: editStudyDescription,
                            referringPhysician: editReferringPhysician,
                            studyDate: normalizedStudyDate,
                            studyTime: normalizedStudyTime,
                            studyId: editStudyId,
                          });
                          applyCurrentItemUpdate({
                            ...currentItem,
                            accessionNumber: editAccessionNumber,
                            institutionName: editInstitutionName,
                            studyDescription: editStudyDescription,
                            referringPhysician: editReferringPhysician,
                            studyDate: normalizedStudyDate,
                            studyTime: normalizedStudyTime,
                            studyId: editStudyId,
                            age: calculateAgeLabel(currentItem.birthDate, normalizedStudyDate),
                          });
                          toast({
                            title: "Study tags updated",
                            description: "Study tags saved to dicomweb-pacs.",
                          });
                        } catch (error) {
                          toast({
                            title: "Failed to save study tags",
                            description:
                              error instanceof Error
                                ? error.message
                                : "An error occurred while saving study tags.",
                            variant: "destructive",
                          });
                        } finally {
                          setIsSavingStudyTags(false);
                        }
                      }}
                    >
                      Save Study Tags
                    </Button>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          </div>

          <div className="sticky bottom-0 border-t border-border bg-background/95 px-6 py-4 backdrop-blur">
            {actionButtons}
          </div>
        </div>
      </DialogContent>
      <Dialog
        open={Boolean(activeSeriesIdForViewer)}
        onOpenChange={open => {
          if (!open) {
            setActiveSeriesIdForViewer(null);
            setActiveInstanceIndex(null);
          }
        }}
      >
        <DialogContent className="h-[84vh] max-h-[84vh] w-[94vw] max-w-5xl overflow-hidden rounded-2xl border-0 bg-black p-0 text-white">
          <DialogHeader className="border-b border-white/10 px-4 py-3">
            <DialogTitle className="text-base font-semibold text-white">
              {series.find(entry => entry.SeriesInstanceUID === activeSeriesIdForViewer)?.SeriesDescription || "Series Viewer"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Viewer for browsing and switching study series images.
            </DialogDescription>
          </DialogHeader>
          {currentItem && activeSeriesIdForViewer && (
            <ViewerContent
              series={series}
              activeSeriesIdForViewer={activeSeriesIdForViewer}
              activeInstanceIndex={activeInstanceIndex}
              isLoadingActiveSeries={instancesLoadingSeriesId === activeSeriesIdForViewer}
              instancesBySeries={instancesBySeries}
              studyInstanceUid={currentItem.studyInstanceUid}
              onSelectSeries={seriesId => {
                openViewerAtSeries(seriesId);
              }}
              onChangeImageIndex={(seriesId, index) => {
                updateViewerIndex(seriesId, index);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Dialog>
    {DeleteReasonDialog}
    </>
  );
};

export default StudyDetailDialog;
