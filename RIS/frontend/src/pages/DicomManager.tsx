import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  FolderSync,
  GitMerge,
  History,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";
import {
  dicomWebService,
  DicomManagerOperation,
  DicomManagerRestorePreflight,
  mwlService,
  MwlOrder,
  SeriesItem,
  WorklistItem,
} from "@/lib/dicomService";
import { useAuth } from "@/contexts/AuthContext";

type ExplorerSide = "left" | "right";
type ManagerLevel = "study" | "series" | "image";
type ManagerMode = "study" | "patient";
type DicomJsonElement = { Value?: unknown[] };
type DicomJsonObject = Record<string, DicomJsonElement>;

type InstanceItem = {
  SOPInstanceUID: string;
  InstanceNumber: string;
  Modality: string;
  ImageComments: string;
  ViewPosition: string;
  raw: DicomJsonObject;
};

type DragPayload = {
  side: ExplorerSide;
  level: ManagerLevel;
  study: WorklistItem;
  series?: SeriesItem;
  instance?: InstanceItem;
};

type DropProposal = {
  source: DragPayload;
  targetSide: ExplorerSide;
  targetStudy?: WorklistItem;
  targetSeries?: SeriesItem;
  targetPatient?: PatientGroup;
};

type PatientGroup = {
  key: string;
  patientId: string;
  patientName: string;
  patientBirthDate?: string;
  patientSex?: string;
  otherPatientIds?: string;
  studies: WorklistItem[];
};

type MetadataField = {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
};

type EditTarget =
  | { level: "study"; side: ExplorerSide; study: WorklistItem; fields: MetadataField[] }
  | { level: "series"; side: ExplorerSide; study: WorklistItem; series: SeriesItem; fields: MetadataField[] }
  | { level: "image"; side: ExplorerSide; study: WorklistItem; series: SeriesItem; instance: InstanceItem; fields: MetadataField[] };

type CreateTarget =
  | { level: "study"; side?: ExplorerSide; fields: MetadataField[] }
  | { level: "series"; side: ExplorerSide; study: WorklistItem; fields: MetadataField[] }
  | { level: "image"; side: ExplorerSide; study: WorklistItem; series: SeriesItem; fields: MetadataField[]; file?: File };

type MergeProgressState = {
  title: string;
  message: string;
  startedAt: number;
  status: "running" | "complete" | "cancelled" | "error";
};

type PaneState = {
  query: string;
  selectedStudyUid: string;
  selectedSeriesUid: string;
  series: SeriesItem[];
  instances: InstanceItem[];
  loadingSeries: boolean;
  loadingInstances: boolean;
  seriesError: string;
  instancesError: string;
};

const initialPaneState: PaneState = {
  query: "",
  selectedStudyUid: "",
  selectedSeriesUid: "",
  series: [],
  instances: [],
  loadingSeries: false,
  loadingInstances: false,
  seriesError: "",
  instancesError: "",
};

const formatDicomDate = (value?: string) => {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  if (digits.length < 8) return value || "-";
  return `${digits.slice(6, 8)}/${digits.slice(4, 6)}/${digits.slice(0, 4)}`;
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

const mapMwlOrderToStudy = (order: MwlOrder): WorklistItem => ({
  PatientID: order.no_rm || "",
  PatientName: order.nama_pasien || "",
  OtherPatientIDs: "",
  AccessionNumber: order.accession_number || "",
  InstitutionName: "",
  ModalityCode: order.modality || "",
  StudyDescription: order.procedure_desc || "",
  StudyTime: String(order.study_time || ""),
  NumberOfStudyRelatedInstances: 0,
  NumberOfStudyRelatedSeries: 0,
  ReferringPhysicianName: order.referring_doctor_name || order.referring_physician || "",
  StudyDate: toDicomDateLocal(order.study_date || order.tanggal_aktivasi || order.tanggal_order || order.created_at),
  StudyID: order.no_rontgen || "",
  PatientBirthDate: toDicomDateLocal(order.tanggal_lahir),
  PatientSex: order.kelamin || "O",
  StudyInstanceUID: order.actual_study_instance_uid || order.study_instance_uid || "",
});

const safeText = (value?: string | number | null) => {
  const text = String(value ?? "").trim();
  return text || "-";
};

const managerOperationLabels: Record<string, string> = {
  patient_correction: "Patient correction",
  study_merge: "Study merge",
  series_move: "Series move",
  instance_move: "Image move",
  restore: "Restore",
  study_reindex: "Study re-index",
};

// Live phase wording for operations that report progress (merges and re-indexes).
const managerProgressLabels: Record<string, string> = {
  queued: "Queued",
  inspecting: "Inspecting the source study",
  moving: "Moving images",
  "cleaning-metadata": "Cleaning metadata",
  reindexing: "Re-indexing in PACS",
  indexing: "Re-indexing in PACS",
  verifying: "Verifying indexed files",
  store: "Sending through C-STORE",
  "store-fallback": "Falling back to C-STORE",
  cancelled: "Stopped",
  done: "Finished",
  failed: "Failed",
};

// Live phase wording for a running merge. The server records progress_stage on the
// operation row; the page polls it so a long merge shows real movement instead of
// a static "Server is rewriting..." message.
const managerProgressStageLabels: Record<string, string> = {
  inspecting: "Inspecting the source and target studies",
  moving: "Moving and rewriting images",
  "cleaning-metadata": "Cleaning up the source study metadata",
  reindexing: "Refreshing the PACS index",
  done: "Finalising",
  failed: "Stopping after an error",
};

const describeManagerProgress = (stage?: string | null, done = 0, total = 0) => {
  const label = managerProgressStageLabels[String(stage || "")] || "Processing";
  if (!total) return `${label}...`;
  return `${label} (${Math.min(done, total)}/${total} images)...`;
};

const formatManagerTimestamp = (value?: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const managerStatusClass = (status: string) => {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (status === "restored") return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300";
  if (status === "failed" || status === "restore_failed") return "border-destructive/30 bg-destructive/5 text-destructive";
  return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300";
};

const studyKey = (study: WorklistItem) => study.StudyInstanceUID || `${study.PatientID}-${study.AccessionNumber}`;

const patientKey = (study: WorklistItem) => `${safeText(study.PatientID)}|${safeText(study.PatientName)}`;

const makePatientGroupFromStudy = (study: WorklistItem): PatientGroup => ({
  key: patientKey(study),
  patientId: study.PatientID || "",
  patientName: study.PatientName || "",
  patientBirthDate: study.PatientBirthDate,
  patientSex: study.PatientSex,
  otherPatientIds: study.OtherPatientIDs,
  studies: [study],
});

const getDicomString = (item: DicomJsonObject, tag: string) => {
  const value = Array.isArray(item?.[tag]?.Value) ? item[tag].Value?.[0] : undefined;
  if (value && typeof value === "object" && "Alphabetic" in value) {
    return String((value as { Alphabetic?: string }).Alphabetic || "").trim();
  }
  return String(value ?? "").trim();
};

const mapInstance = (item: DicomJsonObject): InstanceItem => ({
  SOPInstanceUID: getDicomString(item, "00080018"),
  InstanceNumber: getDicomString(item, "00200013"),
  Modality: getDicomString(item, "00080060"),
  ImageComments: getDicomString(item, "00204000"),
  ViewPosition: getDicomString(item, "00185101"),
  raw: item,
});

const getDropDescription = (proposal: DropProposal) => {
  const { source, targetStudy, targetSeries, targetPatient } = proposal;
  if (source.level === "study" && targetPatient) {
    return {
      title: "Move study to another patient",
      description: `Move study "${safeText(source.study.StudyDescription || source.study.AccessionNumber)}" from ${safeText(
        source.study.PatientName
      )} to patient ${safeText(targetPatient.patientName)}. StudyInstanceUID, accession, study date, series, and images stay intact; only patient identity metadata is rewritten.`,
      action: "Commit Patient Correction",
    };
  }

  if (!targetStudy) {
    return {
      title: "Prepare DICOM action",
      description: "Review source and target before committing the DICOM move.",
      action: "Commit Action",
    };
  }

  if (source.level === "image" && source.instance && source.series && targetSeries) {
    return {
      title: "Move image to another series",
      description: `Move image ${safeText(source.instance.InstanceNumber || source.instance.SOPInstanceUID)} from series "${safeText(
        source.series.SeriesDescription || source.series.SeriesNumber
      )}" to "${safeText(targetSeries.SeriesDescription || targetSeries.SeriesNumber)}". If the target is another study, the image DICOM metadata will adopt the target patient/study identity.`,
      action: "Commit Image Move",
    };
  }

  if (source.level === "series" && source.series) {
    return {
      title: "Move series to another study",
      description: `Move series "${safeText(source.series.SeriesDescription || source.series.SeriesNumber)}" from ${safeText(
        source.study.PatientName
      )} to ${safeText(targetStudy.PatientName)}. The series DICOM metadata will adopt the target patient/study identity.`,
      action: "Commit Series Move",
    };
  }

  return {
    title: "Bind or merge study",
    description: `Bind or merge study from ${safeText(source.study.PatientName)} to ${safeText(targetStudy.PatientName)}. All source DICOM files will adopt the target patient/study identity.`,
    action: "Commit Study Binding",
  };
};

const DicomManager = () => {
  const { toast } = useToast();
  const { user, hasPermission } = useAuth();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const [studies, setStudies] = useState<WorklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingStudies, setRefreshingStudies] = useState(false);
  const [studiesError, setStudiesError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [leftPane, setLeftPane] = useState<PaneState>(initialPaneState);
  const [rightPane, setRightPane] = useState<PaneState>(initialPaneState);
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [proposal, setProposal] = useState<DropProposal | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [creatingResource, setCreatingResource] = useState(false);
  const [pendingMutation, setPendingMutation] = useState("");
  const [committingMove, setCommittingMove] = useState(false);
  // Set while a cancellable operation is running so the dialog's Cancel button can
  // ask the server to stop it (it used to just hide the progress panel).
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelHandlerRef = useRef<(() => void) | null>(null);
  const [mergeProgress, setMergeProgress] = useState<MergeProgressState | null>(null);
  const [mergeElapsedSeconds, setMergeElapsedSeconds] = useState(0);
  const [metadataAdoptionConfirmed, setMetadataAdoptionConfirmed] = useState(false);
  const [managerMode, setManagerMode] = useState<ManagerMode>("study");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [managerOperations, setManagerOperations] = useState<DicomManagerOperation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [operationDetails, setOperationDetails] = useState<Record<string, DicomManagerOperation>>({});
  const [operationDetailState, setOperationDetailState] = useState<Record<string, "loading" | "error">>({});
  const [reindexLoadingStudy, setReindexLoadingStudy] = useState("");
  const [reindexOperationId, setReindexOperationId] = useState("");
  const [reindexStage, setReindexStage] = useState("");
  const [stoppingOperationId, setStoppingOperationId] = useState("");
  const [restorePreflight, setRestorePreflight] = useState<DicomManagerRestorePreflight | null>(null);
  const [preflightLoadingId, setPreflightLoadingId] = useState("");
  const [restoreReason, setRestoreReason] = useState("");
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoringOperation, setRestoringOperation] = useState(false);
  const studiesRequestId = useRef(0);
  const seriesRequestId = useRef<Record<ExplorerSide, number>>({ left: 0, right: 0 });
  const instancesRequestId = useRef<Record<ExplorerSide, number>>({ left: 0, right: 0 });
  const hierarchyStudyUid = useRef<Record<ExplorerSide, string>>({ left: "", right: "" });

  useEffect(() => {
    if (!mergeProgress) {
      setMergeElapsedSeconds(0);
      return;
    }
    const update = () => setMergeElapsedSeconds(Math.max(0, Math.floor((Date.now() - mergeProgress.startedAt) / 1000)));
    update();
    if (mergeProgress.status !== "running") return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [mergeProgress]);

  const setPane = (side: ExplorerSide, updater: (current: PaneState) => PaneState) => {
    if (side === "left") {
      setLeftPane(updater);
    } else {
      setRightPane(updater);
    }
  };

  const loadStudies = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    const requestId = ++studiesRequestId.current;
    setStudiesError("");
    if (silent) {
      setRefreshingStudies(true);
    } else {
      setLoading(true);
    }
    try {
      const [pacsStudies, scheduledOrders] = await Promise.all([
        dicomWebService.fetchStudies({ includeEmpty: "1", fresh: "1" }),
        mwlService.fetchOrders({ status: "SENT_TO_MWL", limit: 1000 }).catch(() => [] as MwlOrder[]),
      ]);
      const pacsStudyUids = new Set(pacsStudies.map(study => study.StudyInstanceUID).filter(Boolean));
      const pacsAccessions = new Set(pacsStudies.map(study => study.AccessionNumber).filter(Boolean));
      const mwlStudies = scheduledOrders
        .filter(order => {
          const studyUid = order.actual_study_instance_uid || order.study_instance_uid || "";
          const accession = order.accession_number || "";
          return studyUid && !pacsStudyUids.has(studyUid) && (!accession || !pacsAccessions.has(accession));
        })
        .map(mapMwlOrderToStudy);
      const result = [...pacsStudies, ...mwlStudies];
      if (requestId !== studiesRequestId.current) return result;
      setStudies(result);
      setLastUpdatedAt(new Date());
      setLeftPane(prev => ({
        ...prev,
        selectedStudyUid: result.some(item => item.StudyInstanceUID === prev.selectedStudyUid)
          ? prev.selectedStudyUid
          : result[0]?.StudyInstanceUID || "",
      }));
      setRightPane(prev => ({
        ...prev,
        selectedStudyUid: result.some(item => item.StudyInstanceUID === prev.selectedStudyUid)
          ? prev.selectedStudyUid
          : result[1]?.StudyInstanceUID || result[0]?.StudyInstanceUID || "",
      }));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load studies.";
      if (requestId === studiesRequestId.current) {
        setStudiesError(message);
        toast({
          title: "Failed to load DICOM studies",
          description: message,
          variant: "destructive",
        });
      }
      return [];
    } finally {
      if (requestId === studiesRequestId.current) {
        setLoading(false);
        setRefreshingStudies(false);
      }
    }
  }, [toast]);

  const canRestoreManagerOperation = user?.role === "administrator" || hasPermission("restore_dicom_manager_operation");

  const loadManagerHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      setManagerOperations(await dicomWebService.fetchManagerOperations({ limit: 100 }));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Unable to load DICOM Manager history.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (historyOpen) void loadManagerHistory();
  }, [historyOpen, loadManagerHistory]);

  const toggleOperationDetails = async (operation: DicomManagerOperation) => {
    if (operationDetails[operation.id]) {
      setOperationDetails(previous => {
        const next = { ...previous };
        delete next[operation.id];
        return next;
      });
      return;
    }
    setOperationDetailState(previous => ({ ...previous, [operation.id]: "loading" }));
    try {
      const full = await dicomWebService.fetchManagerOperation(operation.id);
      setOperationDetails(previous => ({ ...previous, [operation.id]: full }));
      setOperationDetailState(previous => {
        const next = { ...previous };
        delete next[operation.id];
        return next;
      });
    } catch (error) {
      setOperationDetailState(previous => ({ ...previous, [operation.id]: "error" }));
      toast({
        title: "Unable to load operation details",
        description: error instanceof Error ? error.message : "The operation manifest could not be read.",
        variant: "destructive",
      });
    }
  };

  const pollReindexOperation = async (operationId: string): Promise<DicomManagerOperation | null> => {
    const deadline = Date.now() + 30 * 60 * 1000;
    for (;;) {
      const operation = await dicomWebService.fetchManagerOperation(operationId).catch(() => null);
      if (operation) {
        const stage = managerProgressLabels[operation.progress?.stage || ""] || operation.progress?.stage || operation.status;
        const total = operation.progress?.total || 0;
        setReindexStage(total > 0 ? `${stage} ${operation.progress?.done || 0}/${total}` : String(stage));
        if (["completed", "cancelled", "failed"].includes(operation.status)) return operation;
      }
      if (Date.now() > deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  };

  const stopOperation = async (operationId: string, label = "operation") => {
    if (!operationId) return;
    setStoppingOperationId(operationId);
    try {
      await dicomWebService.cancelManagerOperation(operationId);
      toast({
        title: `Stopping ${label}`,
        description: "Work already finished is kept; whatever is left is reported in the history entry.",
      });
    } catch (error) {
      toast({
        title: `Unable to stop the ${label}`,
        description: error instanceof Error ? error.message : "Cancellation request failed.",
        variant: "destructive",
      });
    } finally {
      setStoppingOperationId("");
    }
  };

  const reindexManagerStudy = async (studyInstanceUid: string) => {
    if (!studyInstanceUid) return;
    setReindexLoadingStudy(studyInstanceUid);
    setReindexStage("Starting");
    try {
      const accepted = await dicomWebService.reindexStudy(studyInstanceUid, {
        reason: "Operator re-indexed the study from DICOM Manager history",
      });
      // Synchronous answer (small study or wait=1): report the result directly.
      if (!accepted.accepted || !accepted.operationId) {
        const status = accepted.refresh?.status || "unknown";
        const ok = accepted.ok === true;
        toast({
          title: ok ? "Study re-indexed" : "Re-index finished without a clean result",
          description: ok
            ? `PACS index: ${status}${typeof accepted.refresh?.indexed === "number" ? ` (${accepted.refresh.indexed} indexed, ${accepted.refresh.unchanged ?? 0} unchanged)` : ""}.`
            : `PACS index reported: ${status}${accepted.refresh?.reason ? ` - ${accepted.refresh.reason}` : ""}. Check the study in PACS.`,
          variant: ok ? "default" : "destructive",
        });
        return;
      }
      setReindexOperationId(accepted.operationId);
      const finished = await pollReindexOperation(accepted.operationId);
      if (!finished) {
        toast({
          title: "Re-index still running",
          description: "It keeps running in the background - follow its progress in the history list.",
        });
        return;
      }
      const detail = finished.details?.result ? finished : await dicomWebService.fetchManagerOperation(accepted.operationId).catch(() => finished);
      const result = detail.details?.result;
      const status = result?.pacsRefreshStatus || accepted.refresh?.status || "unknown";
      if (finished.status === "cancelled") {
        toast({
          title: "Re-index stopped",
          description: "The PACS index may be partially updated - run the re-index again to finish the study.",
        });
      } else if (finished.status === "failed") {
        toast({
          title: "Re-index failed",
          description: finished.errorMessage || `PACS index reported: ${status}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Study re-indexed",
          description: `PACS index: ${status}${result?.unindexedFiles ? ` - ${result.unindexedFiles} file(s) could not be indexed` : ""}.`,
        });
      }
    } catch (error) {
      toast({
        title: "Re-index failed",
        description: error instanceof Error ? error.message : "Unable to re-index the study.",
        variant: "destructive",
      });
    } finally {
      setReindexLoadingStudy("");
      setReindexOperationId("");
      setReindexStage("");
      await Promise.all([loadManagerHistory(), loadStudies()]);
    }
  };

  const openRestorePreflight = async (operation: DicomManagerOperation) => {
    setPreflightLoadingId(operation.id);
    try {
      const preflight = await dicomWebService.preflightManagerOperationRestore(operation.id);
      setRestorePreflight(preflight);
      setRestoreReason("");
      setRestoreConfirmation("");
    } catch (error) {
      toast({
        title: "Restore check failed",
        description: error instanceof Error ? error.message : "Unable to verify the operation snapshot.",
        variant: "destructive",
      });
    } finally {
      setPreflightLoadingId("");
    }
  };

  const confirmManagerRestore = async () => {
    if (!restorePreflight?.canRestore) return;
    setRestoringOperation(true);
    try {
      const result = await dicomWebService.restoreManagerOperation(restorePreflight.operation.id, {
        reason: restoreReason.trim(),
      });
      toast({
        title: "Restore completed",
        description: `${result.restoredObjectCount} DICOM object${result.restoredObjectCount === 1 ? "" : "s"} restored to the pre-operation state.`,
      });
      setRestorePreflight(null);
      setRestoreReason("");
      setRestoreConfirmation("");
      await Promise.all([loadStudies(), loadManagerHistory()]);
    } catch (error) {
      toast({
        title: "Restore failed",
        description: error instanceof Error ? error.message : "The DICOM operation could not be restored.",
        variant: "destructive",
      });
      const refreshed = await dicomWebService
        .preflightManagerOperationRestore(restorePreflight.operation.id)
        .catch(() => null);
      if (refreshed) setRestorePreflight(refreshed);
      await loadManagerHistory();
    } finally {
      setRestoringOperation(false);
    }
  };

  const ensureStudyPlaceholder = useCallback(async (study: WorklistItem) => {
    if ((study.NumberOfStudyRelatedInstances || 0) > 0 || (study.NumberOfStudyRelatedSeries || 0) > 0) return;
    await dicomWebService.createStudy({
      studyInstanceUid: study.StudyInstanceUID,
      patientId: study.PatientID,
      patientName: study.PatientName,
      patientBirthDate: study.PatientBirthDate,
      patientSex: study.PatientSex,
      accessionNumber: study.AccessionNumber,
      studyDate: study.StudyDate,
      studyTime: study.StudyTime,
      modality: study.ModalityCode,
      studyDescription: study.StudyDescription,
      studyId: study.StudyID,
      referringPhysician: study.ReferringPhysicianName,
    });
  }, []);

  useEffect(() => {
    loadStudies();
  }, [loadStudies]);

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
    if (!autoRefreshEnabled || dragPayload || proposal || editTarget || createTarget || historyOpen || restorePreflight) return;
    const id = window.setInterval(() => {
      loadStudies({ silent: true });
    }, 30000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, createTarget, dragPayload, editTarget, historyOpen, loadStudies, proposal, restorePreflight]);

  const filteredStudies = useCallback(
    (query: string) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return studies;
      return studies.filter(study =>
        [
          study.PatientName,
          study.PatientID,
          study.AccessionNumber,
          study.StudyDescription,
          study.ModalityCode,
          study.StudyInstanceUID,
        ]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(needle))
      );
    },
    [studies]
  );

  const patientGroups = useMemo(() => {
    const groups = new Map<string, PatientGroup>();
    for (const study of studies) {
      const key = patientKey(study);
      const existing = groups.get(key);
      if (existing) {
        existing.studies.push(study);
      } else {
        groups.set(key, makePatientGroupFromStudy(study));
      }
    }
    return Array.from(groups.values()).map(group => ({
      ...group,
      studies: [...group.studies].sort((a, b) => {
        const dateDiff = String(b.StudyDate || "").localeCompare(String(a.StudyDate || ""));
        if (dateDiff !== 0) return dateDiff;
        return String(b.StudyTime || "").localeCompare(String(a.StudyTime || ""));
      }),
    }));
  }, [studies]);

  const filteredPatientGroups = useCallback(
    (query: string) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return patientGroups;
      return patientGroups
        .map(group => {
          const patientMatch = [
            group.patientName,
            group.patientId,
            group.patientBirthDate,
            group.patientSex,
            group.otherPatientIds,
          ]
            .filter(Boolean)
            .some(value => String(value).toLowerCase().includes(needle));
          const matchedStudies = group.studies.filter(study =>
            [
              study.PatientName,
              study.PatientID,
              study.AccessionNumber,
              study.StudyDescription,
              study.ModalityCode,
              study.StudyInstanceUID,
            ]
              .filter(Boolean)
              .some(value => String(value).toLowerCase().includes(needle))
          );
          if (patientMatch) return group;
          if (matchedStudies.length) return { ...group, studies: matchedStudies };
          return null;
        })
        .filter(Boolean) as PatientGroup[];
    },
    [patientGroups]
  );

  const selectedStudies = useMemo(
    () => ({
      left: studies.find(study => study.StudyInstanceUID === leftPane.selectedStudyUid) || null,
      right: studies.find(study => study.StudyInstanceUID === rightPane.selectedStudyUid) || null,
    }),
    [leftPane.selectedStudyUid, rightPane.selectedStudyUid, studies]
  );

  const loadInstances = useCallback(
    async (side: ExplorerSide, study: WorklistItem, series: SeriesItem) => {
      const requestId = ++instancesRequestId.current[side];
      setPane(side, current => ({
        ...current,
        selectedSeriesUid: series.SeriesInstanceUID,
        loadingInstances: true,
        instancesError: "",
        instances: [],
      }));
      try {
        const raw = (await dicomWebService.fetchInstances(study.StudyInstanceUID, series.SeriesInstanceUID)) as DicomJsonObject[];
        const instances = raw.map(mapInstance).filter(instance => instance.SOPInstanceUID);
        if (requestId !== instancesRequestId.current[side]) return;
        setPane(side, current => ({
          ...current,
          selectedSeriesUid: series.SeriesInstanceUID,
          loadingInstances: false,
          instances,
        }));
      } catch (error) {
        if (requestId !== instancesRequestId.current[side]) return;
        const message = error instanceof Error ? error.message : "Unable to load images.";
        setPane(side, current => ({ ...current, loadingInstances: false, instancesError: message }));
        toast({
          title: "Failed to load images",
          description: message,
          variant: "destructive",
        });
      }
    },
    [toast]
  );

  const loadSeries = useCallback(
    async (side: ExplorerSide, study: WorklistItem) => {
      const requestId = ++seriesRequestId.current[side];
      ++instancesRequestId.current[side];
      setPane(side, current => ({
        ...current,
        selectedStudyUid: study.StudyInstanceUID,
        selectedSeriesUid: "",
        loadingSeries: true,
        loadingInstances: false,
        seriesError: "",
        instancesError: "",
        series: [],
        instances: [],
      }));
      try {
        const result = await dicomWebService.fetchSeries(study.StudyInstanceUID);
        if (requestId !== seriesRequestId.current[side]) return;
        const firstSeries = result[0];
        setPane(side, current => ({
          ...current,
          series: result,
          selectedSeriesUid: firstSeries?.SeriesInstanceUID || "",
          loadingSeries: false,
        }));
        if (firstSeries) {
          await loadInstances(side, study, firstSeries);
        }
      } catch (error) {
        if (requestId !== seriesRequestId.current[side]) return;
        const message = error instanceof Error ? error.message : "Unable to load series.";
        setPane(side, current => ({ ...current, loadingSeries: false, seriesError: message }));
        toast({
          title: "Failed to load series",
          description: message,
          variant: "destructive",
        });
      }
    },
    [loadInstances, toast]
  );

  useEffect(() => {
    const studyUid = selectedStudies.left?.StudyInstanceUID || "";
    if (!selectedStudies.left || !studyUid || hierarchyStudyUid.current.left === studyUid) return;
    hierarchyStudyUid.current.left = studyUid;
    loadSeries("left", selectedStudies.left);
  }, [loadSeries, selectedStudies.left]);

  useEffect(() => {
    const studyUid = selectedStudies.right?.StudyInstanceUID || "";
    if (!selectedStudies.right || !studyUid || hierarchyStudyUid.current.right === studyUid) return;
    hierarchyStudyUid.current.right = studyUid;
    loadSeries("right", selectedStudies.right);
  }, [loadSeries, selectedStudies.right]);

  const handleDropOnStudy = (targetSide: ExplorerSide, targetStudy: WorklistItem) => {
    if (!dragPayload) return;
    if (dragPayload.level === "image") {
      toast({
        title: "Drop image on a series",
        description: "Image level should be dropped to a target series so the DICOM hierarchy stays correct.",
      });
      setDragPayload(null);
      return;
    }
    if (dragPayload.study.StudyInstanceUID === targetStudy.StudyInstanceUID && dragPayload.level === "study") {
      setDragPayload(null);
      return;
    }
    setMetadataAdoptionConfirmed(false);
    setProposal({ source: dragPayload, targetSide, targetStudy });
    setDragPayload(null);
  };

  const handleDropOnPatient = (targetSide: ExplorerSide, targetPatient: PatientGroup) => {
    if (!dragPayload) return;
    if (dragPayload.level !== "study") {
      toast({
        title: "Drop a study on a patient",
        description: "Patient correction only accepts study-level moves. Series and images should be dropped on a study or series.",
      });
      setDragPayload(null);
      return;
    }
    if (patientKey(dragPayload.study) === targetPatient.key) {
      setDragPayload(null);
      return;
    }
    setMetadataAdoptionConfirmed(false);
    setProposal({ source: dragPayload, targetSide, targetPatient });
    setDragPayload(null);
  };

  const handleDropOnSeries = (targetSide: ExplorerSide, targetStudy: WorklistItem, targetSeries: SeriesItem) => {
    if (!dragPayload) return;
    if (dragPayload.level !== "image" || !dragPayload.instance || !dragPayload.series) {
      handleDropOnStudy(targetSide, targetStudy);
      return;
    }
    if (
      dragPayload.study.StudyInstanceUID === targetStudy.StudyInstanceUID &&
      dragPayload.series.SeriesInstanceUID === targetSeries.SeriesInstanceUID
    ) {
      setDragPayload(null);
      return;
    }
    setMetadataAdoptionConfirmed(false);
    setProposal({ source: dragPayload, targetSide, targetStudy, targetSeries });
    setDragPayload(null);
  };

  const refreshAfterMove = async (proposal: DropProposal) => {
    const freshStudies = await loadStudies();
    const sourceStudy = freshStudies.find(study => study.StudyInstanceUID === proposal.source.study.StudyInstanceUID) || null;
    const targetStudy = proposal.targetStudy
      ? freshStudies.find(study => study.StudyInstanceUID === proposal.targetStudy?.StudyInstanceUID) || null
      : null;
    if (sourceStudy?.StudyInstanceUID) {
      await loadSeries(proposal.source.side, sourceStudy).catch(() => undefined);
    }
    if (targetStudy?.StudyInstanceUID) {
      await loadSeries(proposal.targetSide, targetStudy).catch(() => undefined);
    }
  };

  const confirmProposal = async () => {
    if (!proposal) return;
    setCommittingMove(true);
    // Reported when the server moved the content but had to skip something:
    // the operator must not read a plain "success" while images are missing.
    let completionWarning = "";
    let completionStatus: MergeProgressState["status"] = "complete";
    const addWarning = (text: string) => {
      completionWarning = completionWarning ? `${completionWarning}; ${text}` : text;
    };
    // A study merge has no streaming response, so poll the operation the server
    // journals for this study and show its live phase/counter.
    const polledStudyUid = proposal.source.study.StudyInstanceUID;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let cancelRequestedLocally = false;
    let operationIdForCancel: string | null = null;
    const requestCancellation = async () => {
      if (!operationIdForCancel) return;
      setCancelRequested(true);
      try {
        const result = await dicomWebService.cancelManagerOperation(operationIdForCancel);
        if (!result?.requested) {
          setCancelRequested(false);
          toast({
            title: "Cannot stop this operation",
            description: "It already finished or is no longer cancellable.",
          });
        }
      } catch (error) {
        setCancelRequested(false);
        toast({
          title: "Stop request failed",
          description: error instanceof Error ? error.message : "Unable to request cancellation.",
          variant: "destructive",
        });
      }
    };
    const startProgressPolling = () => {
      progressTimer = setInterval(async () => {
        try {
          const operations = await dicomWebService.fetchManagerOperations({
            studyInstanceUid: polledStudyUid,
            limit: 5,
          });
          const running = operations.find(operation => operation.progress && operation.status === "prepared");
          if (!running?.progress) return;
          operationIdForCancel = running.id;
          if (cancelRequestedLocally && !running.cancelRequested) {
            void requestCancellation();
          }
          const { stage, done, total } = running.progress;
          setMergeProgress(current => (current && current.status === "running"
            ? {
              ...current,
              message: cancelRequestedLocally
                ? "Stopping after the series currently being moved..."
                : describeManagerProgress(stage, done, total),
            }
            : current));
        } catch {
          // Progress polling must never disturb the operation itself.
        }
      }, 1500);
    };
    const stopProgressPolling = () => {
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = null;
      setCancelRequested(false);
    };
    cancelHandlerRef.current = () => {
      cancelRequestedLocally = true;
      setCancelRequested(true);
      if (operationIdForCancel) {
        void requestCancellation();
      } else {
        setMergeProgress(current => (current && current.status === "running"
          ? { ...current, message: "Stopping as soon as the server registers the operation..." }
          : current));
      }
    };
    setMergeProgress({
      title: proposalCopy?.title || "DICOM Manager action",
      message: "Creating a restore snapshot and validating the requested operation...",
      startedAt: Date.now(),
      status: "running",
    });
    try {
      const reason = `DICOM Manager drag-and-drop by ${proposal.source.side} to ${proposal.targetSide}`;
      startProgressPolling();
      if (proposal.source.level === "study" && proposal.targetPatient) {
        setMergeProgress(current => current && {
          ...current,
          message: "Server is rewriting patient identity tags...",
        });
        await dicomWebService.updateStudyMetadata(proposal.source.study.StudyInstanceUID, {
          patientName: proposal.targetPatient.patientName,
          patientId: proposal.targetPatient.patientId,
          patientBirthDate: proposal.targetPatient.patientBirthDate || "",
          patientSex: proposal.targetPatient.patientSex || "",
          otherPatientIds: proposal.targetPatient.otherPatientIds || "",
          _managerOperation: {
            type: "patient_correction",
            reason,
            targetPatientId: proposal.targetPatient.patientId,
          },
        });
        toast({
          title: "Study moved to patient",
          description: "Patient metadata was corrected while keeping the study, accession, series, and images intact.",
        });
      } else if (proposal.source.level === "study" && proposal.targetStudy) {
        setMergeProgress(current => current && {
          ...current,
          message: "Verifying the target study...",
        });
        await ensureStudyPlaceholder(proposal.targetStudy);
        setMergeProgress(current => current && {
          ...current,
          message: "Server is rewriting and moving all source series and images...",
        });
        const moveResult = await dicomWebService.moveStudyToStudy(proposal.source.study.StudyInstanceUID, {
          targetStudyInstanceUid: proposal.targetStudy.StudyInstanceUID,
          reason,
        });
        if (moveResult?.cancelled) {
          const movedSeries = moveResult.movedSeriesCount ?? 0;
          const pendingSeries = moveResult.pendingSeriesUids?.length ?? 0;
          completionStatus = "cancelled";
          addWarning(`stopped after ${movedSeries} series; ${pendingSeries} series are still in the source study`);
          toast({
            title: "Merge stopped",
            description: `${movedSeries} series were moved into the target study. ${pendingSeries} series remain in the source study - run the merge again to continue.`,
          });
        }
        const skippedCount = moveResult?.skippedInstances?.length || 0;
        if (skippedCount) {
          addWarning(`${skippedCount} image(s) could not be moved and were reported in the audit log`);
        }
        const refreshStatus = moveResult?.targetRefresh?.status;
        if (refreshStatus && refreshStatus !== "refreshed") {
          addWarning(`PACS index refresh reported "${refreshStatus}"`);
        }
        toast({
          title: completionStatus === "cancelled"
            ? "Merge stopped"
            : completionWarning ? "Study bound with warnings" : "Study bound",
          description: completionWarning
            ? `Series/images were moved into the target study, but: ${completionWarning}. Check the DICOM Manager history for details.`
            : "All series/images were moved into the target study and metadata was rewritten.",
          ...(completionWarning ? { variant: "destructive" as const } : {}),
        });
      } else if (proposal.source.level === "series" && proposal.source.series && proposal.targetStudy) {
        setMergeProgress(current => current && {
          ...current,
          message: "Verifying the target study...",
        });
        await ensureStudyPlaceholder(proposal.targetStudy);
        setMergeProgress(current => current && {
          ...current,
          message: "Server is rewriting and moving the selected series...",
        });
        const seriesMoveResult = await dicomWebService.moveSeriesToStudy(
          proposal.source.study.StudyInstanceUID,
          proposal.source.series.SeriesInstanceUID,
          {
            targetStudyInstanceUid: proposal.targetStudy.StudyInstanceUID,
            reason,
          }
        );
        const seriesSkipped = seriesMoveResult?.skippedInstances?.length || 0;
        if (seriesSkipped) {
          completionWarning = `${seriesSkipped} image(s) could not be moved and were reported in the audit log`;
        }
        toast({
          title: seriesSkipped ? "Series moved with warnings" : "Series moved",
          description: seriesSkipped
            ? `The selected series was moved, but ${seriesSkipped} image(s) could not be moved. Check the DICOM Manager history for the affected SOP instances.`
            : "The selected series was moved into the target study.",
          ...(seriesSkipped ? { variant: "destructive" as const } : {}),
        });
      } else if (proposal.source.level === "image" && proposal.source.series && proposal.source.instance && proposal.targetSeries && proposal.targetStudy) {
        setMergeProgress(current => current && {
          ...current,
          message: "Server is rewriting and moving the selected image...",
        });
        await dicomWebService.moveInstanceToSeries(
          proposal.source.study.StudyInstanceUID,
          proposal.source.series.SeriesInstanceUID,
          proposal.source.instance.SOPInstanceUID,
          {
            targetStudyInstanceUid: proposal.targetStudy.StudyInstanceUID,
            targetSeriesInstanceUid: proposal.targetSeries.SeriesInstanceUID,
            reason,
          }
        );
        toast({
          title: "Image moved",
          description: "The selected image was moved into the target series.",
        });
      }
      const committedProposal = proposal;
      setMergeProgress(current => current && {
        ...current,
        message: "Reloading the PACS study and hierarchy indexes...",
      });
      await refreshAfterMove(committedProposal);
      await loadManagerHistory();
      setMergeProgress(current => current && {
        ...current,
        message: completionWarning
          ? `Operation finished with warnings: ${completionWarning}.`
          : "Operation completed and the visible hierarchy is up to date.",
        status: completionStatus,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to move DICOM content.";
      setMergeProgress(current => current && {
        ...current,
        message,
        status: "error",
      });
      toast({
        title: "Failed to commit manager action",
        description: message,
        variant: "destructive",
      });
    } finally {
      stopProgressPolling();
      cancelHandlerRef.current = null;
      setCommittingMove(false);
    }
  };

  const openStudyEditor = (side: ExplorerSide, study: WorklistItem) => {
    setEditTarget({
      level: "study",
      side,
      study,
      fields: [
        { key: "patientName", label: "Patient Name", value: study.PatientName || "" },
        { key: "patientId", label: "Patient ID", value: study.PatientID || "" },
        { key: "patientBirthDate", label: "Patient Birth Date", value: study.PatientBirthDate || "", placeholder: "YYYYMMDD" },
        { key: "patientSex", label: "Patient Sex", value: study.PatientSex || "", placeholder: "M / F / O" },
        { key: "otherPatientIds", label: "Other Patient IDs", value: study.OtherPatientIDs || "" },
        { key: "accessionNumber", label: "Accession Number", value: study.AccessionNumber || "" },
        { key: "institutionName", label: "Institution Name", value: study.InstitutionName || "" },
        { key: "studyDescription", label: "Study Description", value: study.StudyDescription || "" },
        { key: "referringPhysician", label: "Referring Physician", value: study.ReferringPhysicianName || "" },
        { key: "studyDate", label: "Study Date", value: study.StudyDate || "", placeholder: "YYYYMMDD" },
        { key: "studyTime", label: "Study Time", value: study.StudyTime || "", placeholder: "HHMMSS" },
        { key: "studyId", label: "Study ID", value: study.StudyID || "" },
      ],
    });
  };

  const openSeriesEditor = (side: ExplorerSide, study: WorklistItem, series: SeriesItem) => {
    setEditTarget({
      level: "series",
      side,
      study,
      series,
      fields: [
        { key: "modality", label: "Modality", value: series.Modality || "", placeholder: "CT / MR / CR / US" },
        { key: "seriesDescription", label: "Series Description", value: series.SeriesDescription || "" },
        { key: "seriesNumber", label: "Series Number", value: series.SeriesNumber || "" },
        { key: "bodyPartExamined", label: "Body Part Examined", value: series.BodyPartExamined || "" },
        { key: "protocolName", label: "Protocol Name", value: series.ProtocolName || "" },
        { key: "laterality", label: "Laterality", value: series.Laterality || "", placeholder: "R / L" },
      ],
    });
  };

  const openImageEditor = (
    side: ExplorerSide,
    study: WorklistItem,
    series: SeriesItem,
    instance: InstanceItem
  ) => {
    setEditTarget({
      level: "image",
      side,
      study,
      series,
      instance,
      fields: [
        { key: "instanceNumber", label: "Instance Number", value: instance.InstanceNumber || "" },
        { key: "viewPosition", label: "View Position", value: instance.ViewPosition || "" },
        { key: "imageComments", label: "Image Comments", value: instance.ImageComments || "" },
      ],
    });
  };

  const updateEditField = (key: string, value: string) => {
    setEditTarget(current =>
      current
        ? {
            ...current,
            fields: current.fields.map(field => (field.key === key ? { ...field, value } : field)),
          }
        : current
    );
  };

  const updateCreateField = (key: string, value: string) => {
    setCreateTarget(current =>
      current
        ? {
            ...current,
            fields: current.fields.map(field => (field.key === key ? { ...field, value } : field)),
          }
        : current
    );
  };

  const openStudyCreator = () => {
    const today = new Date();
    const ymd = today.toISOString().slice(0, 10).replace(/-/g, "");
    setCreateTarget({
      level: "study",
      fields: [
        { key: "patientId", label: "Patient ID", value: `MANUAL-${Date.now()}` },
        { key: "patientName", label: "Patient Name", value: "MANUAL^PATIENT" },
        { key: "patientBirthDate", label: "Patient Birth Date", value: "", placeholder: "YYYYMMDD" },
        { key: "patientSex", label: "Patient Sex", value: "O", placeholder: "M / F / O" },
        { key: "accessionNumber", label: "Accession Number", value: `MANUAL${Date.now()}` },
        { key: "studyDate", label: "Study Date", value: ymd, placeholder: "YYYYMMDD" },
        { key: "studyTime", label: "Study Time", value: "", placeholder: "HHMMSS" },
        { key: "modality", label: "Modality", value: "OT" },
        { key: "studyDescription", label: "Study Description", value: "Manual Study" },
        { key: "referringPhysician", label: "Referring Physician", value: "" },
      ],
    });
  };

  const openSeriesCreator = (side: ExplorerSide, study: WorklistItem) => {
    setCreateTarget({
      level: "series",
      side,
      study,
      fields: [
        { key: "modality", label: "Modality", value: study.ModalityCode || "OT" },
        { key: "seriesNumber", label: "Series Number", value: "1" },
        { key: "seriesDescription", label: "Series Description", value: "Manual Series" },
        { key: "bodyPartExamined", label: "Body Part Examined", value: "" },
        { key: "protocolName", label: "Protocol Name", value: "" },
      ],
    });
  };

  const openImageCreator = (side: ExplorerSide, study: WorklistItem, series: SeriesItem) => {
    setCreateTarget({
      level: "image",
      side,
      study,
      series,
      fields: [
        { key: "instanceNumber", label: "Instance Number", value: String((series.NumberOfSeriesRelatedInstances || 0) + 1) },
        { key: "imageComments", label: "Image Comments", value: "" },
      ],
    });
  };

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

  const saveCreateTarget = async () => {
    if (!createTarget) return;
    setCreatingResource(true);
    const payload = Object.fromEntries(createTarget.fields.map(field => [field.key, field.value]));
    try {
      if (createTarget.level === "study") {
        await dicomWebService.createStudy(payload);
        await loadStudies();
        toast({ title: "Study created", description: "Empty study placeholder is ready in DICOM Manager." });
      } else if (createTarget.level === "series") {
        await dicomWebService.createSeries(createTarget.study.StudyInstanceUID, payload);
        await loadSeries(createTarget.side, createTarget.study);
        toast({ title: "Series created", description: "Empty series is ready for image upload or drag-and-drop." });
      } else {
        if (!createTarget.file) throw new Error("Please choose a JPEG or PNG file");
        const base64 = await fileToBase64(createTarget.file);
        await dicomWebService.uploadImageToSeries(
          createTarget.study.StudyInstanceUID,
          createTarget.series.SeriesInstanceUID,
          {
            fileName: createTarget.file.name,
            mimeType: createTarget.file.type,
            base64,
            instanceNumber: String(payload.instanceNumber || ""),
            imageComments: String(payload.imageComments || ""),
          }
        );
        await loadSeries(createTarget.side, createTarget.study);
        await loadInstances(createTarget.side, createTarget.study, createTarget.series);
        toast({ title: "Image created", description: "Uploaded image was converted to DICOM Secondary Capture." });
      }
      setCreateTarget(null);
    } catch (error) {
      toast({
        title: "Failed to create DICOM resource",
        description: error instanceof Error ? error.message : "Unable to create resource.",
        variant: "destructive",
      });
    } finally {
      setCreatingResource(false);
    }
  };

  const saveMetadata = async () => {
    if (!editTarget) return;
    setSavingMetadata(true);
    const payload = Object.fromEntries(editTarget.fields.map(field => [field.key, field.value]));
    try {
      if (editTarget.level === "study") {
        await dicomWebService.updateStudyMetadata(editTarget.study.StudyInstanceUID, payload);
        await loadStudies();
      } else if (editTarget.level === "series") {
        await dicomWebService.updateSeriesMetadata(
          editTarget.study.StudyInstanceUID,
          editTarget.series.SeriesInstanceUID,
          payload
        );
        await loadSeries(editTarget.side, editTarget.study);
      } else {
        await dicomWebService.updateInstanceMetadata(
          editTarget.study.StudyInstanceUID,
          editTarget.series.SeriesInstanceUID,
          editTarget.instance.SOPInstanceUID,
          payload
        );
        await loadInstances(editTarget.side, editTarget.study, editTarget.series);
      }
      toast({
        title: "Metadata updated",
        description: "DICOM metadata has been rewritten and the PACS index was refreshed.",
      });
      setEditTarget(null);
    } catch (error) {
      toast({
        title: "Failed to update metadata",
        description: error instanceof Error ? error.message : "Unable to update metadata.",
        variant: "destructive",
      });
    } finally {
      setSavingMetadata(false);
    }
  };

  const handleDeleteStudy = async (study: WorklistItem) => {
    const reason = await confirmDelete({
      title: "Delete study",
      description: "Delete the selected study and all series/images under it.",
      target: `${safeText(study.PatientName)} / ${safeText(study.PatientID)} / ${safeText(study.AccessionNumber)}`,
    });
    if (!reason) return;
    const operationKey = `study:${study.StudyInstanceUID}`;
    setPendingMutation(operationKey);
    try {
      await dicomWebService.deleteStudy(study.PatientID, study.StudyInstanceUID, { reason });
      toast({ title: "Study deleted", description: "Study has been removed from PACS." });
      await loadStudies();
    } catch (error) {
      toast({
        title: "Failed to delete study",
        description: error instanceof Error ? error.message : "Unable to delete study.",
        variant: "destructive",
      });
    } finally {
      setPendingMutation(current => current === operationKey ? "" : current);
    }
  };

  const handleDeleteSeries = async (side: ExplorerSide, study: WorklistItem, series: SeriesItem) => {
    const reason = await confirmDelete({
      title: "Delete series",
      description: "Delete the selected DICOM series and every image inside it.",
      target: `${safeText(study.PatientName)} / ${safeText(series.SeriesDescription || series.SeriesNumber)}`,
    });
    if (!reason) return;
    const operationKey = `series:${series.SeriesInstanceUID}`;
    setPendingMutation(operationKey);
    try {
      await dicomWebService.deleteSeries(study.PatientID, study.StudyInstanceUID, series.SeriesInstanceUID, { reason });
      toast({ title: "Series deleted", description: "Series has been removed from PACS." });
      await loadSeries(side, study);
    } catch (error) {
      toast({
        title: "Failed to delete series",
        description: error instanceof Error ? error.message : "Unable to delete series.",
        variant: "destructive",
      });
    } finally {
      setPendingMutation(current => current === operationKey ? "" : current);
    }
  };

  const handleDeleteInstance = async (
    side: ExplorerSide,
    study: WorklistItem,
    series: SeriesItem,
    instance: InstanceItem
  ) => {
    const reason = await confirmDelete({
      title: "Delete image",
      description: "Delete only this DICOM image/instance from the selected series.",
      target: `${safeText(study.PatientName)} / ${safeText(series.SeriesDescription || series.SeriesNumber)} / Image ${safeText(
        instance.InstanceNumber || instance.SOPInstanceUID
      )}`,
    });
    if (!reason) return;
    const operationKey = `instance:${instance.SOPInstanceUID}`;
    setPendingMutation(operationKey);
    try {
      await dicomWebService.deleteInstance(
        study.PatientID,
        study.StudyInstanceUID,
        series.SeriesInstanceUID,
        instance.SOPInstanceUID,
        { reason }
      );
      toast({ title: "Image deleted", description: "DICOM image has been removed from PACS." });
      await loadInstances(side, study, series);
    } catch (error) {
      toast({
        title: "Failed to delete image",
        description: error instanceof Error ? error.message : "Unable to delete image.",
        variant: "destructive",
      });
    } finally {
      setPendingMutation(current => current === operationKey ? "" : current);
    }
  };

  const selectStudy = (side: ExplorerSide, study: WorklistItem) => {
    setPane(side, current =>
      current.selectedStudyUid === study.StudyInstanceUID
        ? current
        : { ...current, selectedStudyUid: study.StudyInstanceUID }
    );
  };

  const renderStudyCard = (side: ExplorerSide, pane: PaneState, study: WorklistItem, mode: ManagerMode) => {
    const selected = pane.selectedStudyUid === study.StudyInstanceUID;
    const sourceWorkspace = side === "left";
    const selectedClass = sourceWorkspace
      ? "bg-blue-500/[0.09] shadow-[inset_2px_0_0_rgb(59_130_246)]"
      : "bg-emerald-500/[0.09] shadow-[inset_2px_0_0_rgb(16_185_129)]";
    const dragClass = sourceWorkspace
      ? "bg-blue-500/[0.06] ring-1 ring-inset ring-blue-500/30"
      : "bg-emerald-500/[0.06] ring-1 ring-inset ring-emerald-500/30";

    return (
      <div
        key={studyKey(study)}
        data-testid={`${side}-study-${studyKey(study)}`}
        role="button"
        tabIndex={0}
        draggable
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") selectStudy(side, study);
        }}
        onDragStart={() => setDragPayload({ side, level: "study", study })}
        onDragEnd={() => setDragPayload(null)}
        onDragOver={event => event.preventDefault()}
        onDrop={() => handleDropOnStudy(side, study)}
        onClick={() => selectStudy(side, study)}
        aria-pressed={selected}
        className={`relative w-full rounded-md px-3 py-3 text-left transition-[background-color,box-shadow] duration-150 ${
          selected ? selectedClass : "bg-transparent hover:bg-muted/55"
        } ${dragPayload && dragPayload.level !== "image" ? dragClass : ""}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <p className="truncate text-sm font-semibold leading-5 text-foreground">
                {mode === "patient" ? safeText(study.StudyDescription || study.AccessionNumber) : safeText(study.PatientName)}
              </p>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground">
                {safeText(study.ModalityCode)}
              </span>
            </div>
            <p
              className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground"
              title={mode === "patient" ? study.StudyInstanceUID : study.StudyDescription}
            >
              {mode === "patient"
                ? safeText(study.StudyInstanceUID)
                : safeText(study.StudyDescription || "No study description")}
            </p>
            <p className="mt-1 truncate text-[10px] leading-4 text-muted-foreground/80">
              {mode === "patient"
                ? `ACC ${safeText(study.AccessionNumber)} · ${formatDicomDate(study.StudyDate)}`
                : `MRN ${safeText(study.PatientID)} · ${formatDicomDate(study.StudyDate)}`}
            </p>
          </div>

        </div>
      </div>
    );
  };

  const renderPane = (side: ExplorerSide) => {
    const pane = side === "left" ? leftPane : rightPane;
    const selectedStudy = side === "left" ? selectedStudies.left : selectedStudies.right;
    const selectedSeries = pane.series.find(series => series.SeriesInstanceUID === pane.selectedSeriesUid) || null;
    const studyList = filteredStudies(pane.query);
    const groups = filteredPatientGroups(pane.query);
    const patientMode = managerMode === "patient";
    const resultCount = patientMode ? groups.length : studyList.length;
    const sourceWorkspace = side === "left";

    return (
      <section
        className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border-t-2 bg-card shadow-[0_8px_30px_rgb(15_23_42/0.06)] ring-1 ring-black/[0.04] dark:shadow-[0_12px_36px_rgb(0_0_0/0.22)] dark:ring-white/[0.05] ${
          sourceWorkspace ? "border-t-blue-500" : "border-t-emerald-500"
        }`}
      >
        <div className="flex min-h-[54px] items-center justify-between gap-4 border-b border-border/40 bg-card/95 px-4 py-2.5">
          <div className="min-w-0">
            <p className={`text-[11px] font-medium ${sourceWorkspace ? "text-blue-500" : "text-emerald-500"}`}>
              {sourceWorkspace ? "Source workspace" : "Target workspace"}
            </p>
            <h2 className="mt-0.5 truncate text-sm font-semibold text-foreground">
              {selectedStudy
                ? patientMode
                  ? `${safeText(selectedStudy.PatientName)} · ${safeText(selectedStudy.PatientID)}`
                  : `${safeText(selectedStudy.PatientName)} · ${safeText(selectedStudy.StudyDescription || selectedStudy.AccessionNumber)}`
                : "Select a study"}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={!selectedStudy || Boolean(pendingMutation)}
              onClick={() => selectedStudy && openStudyEditor(side, selectedStudy)}
              title={selectedStudy ? "Edit selected study metadata" : "Select a study to edit metadata"}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit metadata
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={!selectedStudy || Boolean(pendingMutation)}
              onClick={() => selectedStudy && void handleDeleteStudy(selectedStudy)}
              title={selectedStudy ? "Delete selected study" : "Select a study to delete"}
            >
              {selectedStudy && pendingMutation === `study:${selectedStudy.StudyInstanceUID}` ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(250px,0.78fr)_minmax(350px,1.22fr)]">
          <div className="flex min-h-0 flex-col bg-muted/[0.16] lg:border-r lg:border-border/40">
            <div className="bg-card/35 p-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={pane.query}
                  onChange={event => setPane(side, current => ({ ...current, query: event.target.value }))}
                  placeholder="Patient, MRN, accession, UID..."
                  aria-label={`Search ${side} explorer`}
                  className="h-8 rounded-md border-transparent bg-muted/60 pl-8 pr-14 text-xs shadow-none transition-colors duration-150 focus-visible:border-primary/40 focus-visible:bg-background"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground">
                  {resultCount}
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <div className="space-y-0.5 p-2.5">
                {loading && studies.length === 0 ? (
                  <StudyListSkeleton />
                ) : studiesError && studies.length === 0 ? (
                  <InlineState
                    icon="error"
                    title="Study list unavailable"
                    description={studiesError}
                    actionLabel="Retry"
                    onAction={() => void loadStudies()}
                  />
                ) : resultCount === 0 ? (
                  <InlineState
                    icon="empty"
                    title={pane.query ? "No matching records" : "No studies available"}
                    description={
                      pane.query
                        ? "Try a patient name, MRN, accession, modality, or UID."
                        : "The PACS and scheduled worklist returned no studies."
                    }
                  />
                ) : patientMode ? (
                  groups.map(group => (
                    <div
                      key={group.key}
                      className={`mb-2 overflow-hidden rounded-md bg-muted/35 ${
                        sourceWorkspace
                          ? "shadow-[inset_2px_0_0_rgb(59_130_246)]"
                          : "shadow-[inset_2px_0_0_rgb(16_185_129)]"
                      }`}
                    >
                      <div
                        className="px-3 py-2.5"
                        onDragOver={event => event.preventDefault()}
                        onDrop={() => handleDropOnPatient(side, group)}
                        title="Drop a study here to move it to this patient without merging StudyInstanceUID"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-foreground">{safeText(group.patientName)}</p>
                            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">MRN {safeText(group.patientId)}</p>
                          </div>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {group.studies.length} {group.studies.length === 1 ? "study" : "studies"}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-0.5 bg-background/30 p-1.5 pl-3">
                        {group.studies.map(study => renderStudyCard(side, pane, study, "patient"))}
                      </div>
                    </div>
                  ))
                ) : (
                  studyList.map(study => renderStudyCard(side, pane, study, "study"))
                )}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background/35">
            {selectedStudy ? (
              <div
                key={selectedStudy.StudyInstanceUID}
                className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-2 bg-card/65 px-4 py-3 motion-safe:animate-[fade-in_200ms_ease-out] 2xl:grid-cols-5"
              >
                <Info label="Patient" value={selectedStudy.PatientName} />
                <Info label="MRN" value={selectedStudy.PatientID} />
                <Info label="Accession" value={selectedStudy.AccessionNumber} />
                <Info label="Study date" value={formatDicomDate(selectedStudy.StudyDate)} />
                <Info label="Description" value={selectedStudy.StudyDescription} />
              </div>
            ) : (
              <div className="bg-card/65 px-4 py-3 text-xs text-muted-foreground">No study metadata selected</div>
            )}

            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,0.92fr)_minmax(0,1.08fr)] gap-px overflow-hidden bg-border/35">
              <HierarchyPanel
                title="Series"
                subtitle={selectedStudy ? safeText(selectedStudy.StudyInstanceUID) : "Select a study to inspect its hierarchy"}
                count={pane.series.length}
                loading={pane.loadingSeries}
                error={pane.seriesError}
                emptyText={selectedStudy ? "No series in this study." : "No study selected."}
                onRetry={selectedStudy ? () => void loadSeries(side, selectedStudy) : undefined}
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded text-muted-foreground hover:text-foreground"
                    disabled={!selectedStudy}
                    onClick={() => selectedStudy && openSeriesCreator(side, selectedStudy)}
                    title="Create series"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                }
              >
                {pane.series.map(series => {
                  const selected = pane.selectedSeriesUid === series.SeriesInstanceUID;
                  const selectedSeriesClass = sourceWorkspace
                    ? "bg-blue-500/[0.09] shadow-[inset_2px_0_0_rgb(59_130_246),0_2px_10px_rgb(15_23_42/0.05)]"
                    : "bg-emerald-500/[0.09] shadow-[inset_2px_0_0_rgb(16_185_129),0_2px_10px_rgb(15_23_42/0.05)]";
                  const imageDropClass = sourceWorkspace
                    ? "bg-blue-500/[0.06] ring-1 ring-inset ring-blue-500/30"
                    : "bg-emerald-500/[0.06] ring-1 ring-inset ring-emerald-500/30";

                  return (
                    <div
                      key={series.SeriesInstanceUID}
                      data-testid={`${side}-series-${series.SeriesInstanceUID}`}
                      draggable
                      onDragStart={() =>
                        selectedStudy && setDragPayload({ side, level: "series", study: selectedStudy, series })
                      }
                      onDragEnd={() => setDragPayload(null)}
                      onDragOver={event => event.preventDefault()}
                      onDrop={() => selectedStudy && handleDropOnSeries(side, selectedStudy, series)}
                      onClick={() => selectedStudy && loadInstances(side, selectedStudy, series)}
                      className={`group flex cursor-grab items-center gap-3 rounded-md p-2.5 transition-[background-color,box-shadow] duration-150 active:cursor-grabbing ${
                        selected
                          ? selectedSeriesClass
                          : "bg-card/75 shadow-[0_1px_3px_rgb(15_23_42/0.05)] hover:bg-card"
                      } ${dragPayload?.level === "image" ? imageDropClass : ""}`}
                    >
                      <DicomThumbnail
                        src={
                          selectedStudy
                            ? dicomWebService.getSeriesThumbnailUrl(selectedStudy.StudyInstanceUID, series.SeriesInstanceUID)
                            : ""
                        }
                        alt={series.SeriesDescription || "Series thumbnail"}
                        className="h-[52px] w-[52px] rounded bg-black object-cover"
                        fit="cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {safeText(series.SeriesDescription || `Series ${series.SeriesNumber}`)}
                        </p>
                        <p className="mt-1 truncate text-[10px] text-muted-foreground">
                          {safeText(series.Modality)} · Series {safeText(series.SeriesNumber)} ·{" "}
                          {series.NumberOfSeriesRelatedInstances || 0} images
                        </p>
                      </div>
                      <div
                        className={`flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 ${
                          selected ? "opacity-100" : ""
                        }`}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded text-muted-foreground hover:text-primary"
                          onClick={event => {
                            event.stopPropagation();
                            if (selectedStudy) openSeriesEditor(side, selectedStudy, series);
                          }}
                          title="Edit series metadata"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded text-muted-foreground hover:text-destructive"
                          onClick={event => {
                            event.stopPropagation();
                            if (selectedStudy) void handleDeleteSeries(side, selectedStudy, series);
                          }}
                          disabled={Boolean(pendingMutation)}
                          title="Delete series"
                        >
                          {pendingMutation === `series:${series.SeriesInstanceUID}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </HierarchyPanel>

              <HierarchyPanel
                title="Images"
                subtitle={
                  selectedSeries
                    ? safeText(selectedSeries.SeriesDescription || `Series ${selectedSeries.SeriesNumber}`)
                    : "Select a series to load its instances"
                }
                count={pane.instances.length}
                loading={pane.loadingInstances}
                error={pane.instancesError}
                emptyText={selectedSeries ? "No images in this series." : "No series selected."}
                onRetry={
                  selectedStudy && selectedSeries
                    ? () => void loadInstances(side, selectedStudy, selectedSeries)
                    : undefined
                }
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded text-muted-foreground hover:text-foreground"
                    disabled={!selectedStudy || !selectedSeries}
                    onClick={() => selectedStudy && selectedSeries && openImageCreator(side, selectedStudy, selectedSeries)}
                    title="Upload image"
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </Button>
                }
              >
                <div className="grid grid-cols-2 gap-3 2xl:grid-cols-3">
                  {pane.instances.map(instance => (
                    <div
                      key={instance.SOPInstanceUID}
                      data-testid={`${side}-instance-${instance.SOPInstanceUID}`}
                      draggable
                      onDragStart={() =>
                        selectedStudy &&
                        selectedSeries &&
                        setDragPayload({
                          side,
                          level: "image",
                          study: selectedStudy,
                          series: selectedSeries,
                          instance,
                        })
                      }
                      onDragEnd={() => setDragPayload(null)}
                      className="group cursor-grab overflow-hidden rounded-md bg-card/80 shadow-[0_2px_10px_rgb(15_23_42/0.07)] transition-[background-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:bg-card hover:shadow-[0_5px_16px_rgb(15_23_42/0.1)] active:cursor-grabbing"
                    >
                      <div className="relative h-24 bg-black">
                        <DicomThumbnail
                          src={
                            selectedStudy && selectedSeries
                              ? dicomWebService.getInstanceThumbnailUrl(
                                  selectedStudy.StudyInstanceUID,
                                  selectedSeries.SeriesInstanceUID,
                                  instance.SOPInstanceUID
                                )
                              : ""
                          }
                          alt={`Image ${instance.InstanceNumber || instance.SOPInstanceUID}`}
                          className="h-full w-full object-contain"
                        />
                        <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 rounded bg-black/55 text-white hover:bg-black/75 hover:text-white"
                            onClick={event => {
                              event.stopPropagation();
                              if (selectedStudy && selectedSeries) {
                                openImageEditor(side, selectedStudy, selectedSeries, instance);
                              }
                            }}
                            title="Edit image metadata"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 rounded bg-black/55 text-white hover:bg-destructive hover:text-white"
                            onClick={event => {
                              event.stopPropagation();
                              if (selectedStudy && selectedSeries) {
                                void handleDeleteInstance(side, selectedStudy, selectedSeries, instance);
                              }
                            }}
                            disabled={Boolean(pendingMutation)}
                            title="Delete image"
                          >
                            {pendingMutation === `instance:${instance.SOPInstanceUID}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                      <div className="px-2.5 py-2">
                        <p className="truncate text-[11px] font-medium text-foreground" title={instance.SOPInstanceUID}>
                          Image {safeText(instance.InstanceNumber || instance.SOPInstanceUID)}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">
                          {safeText(instance.SOPInstanceUID)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </HierarchyPanel>
            </div>
          </div>
        </div>
      </section>
    );
  };

  const proposalCopy = proposal ? getDropDescription(proposal) : null;
  const proposalCrossStudy = Boolean(
    proposal?.targetStudy && proposal.source.study.StudyInstanceUID !== proposal.targetStudy.StudyInstanceUID
  );
  const proposalPatientCorrection = Boolean(
    proposal?.targetPatient && patientKey(proposal.source.study) !== proposal.targetPatient.key
  );

  return (
    <div className="dicom-manager flex h-screen flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b border-border/50 bg-background">
        <div className="flex min-h-[58px] flex-wrap items-stretch px-4 lg:px-5">
          <div className="flex min-w-[210px] items-center py-2 pr-6">
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-[-0.01em] text-foreground">DICOM Manager</h1>
              <p className="mt-0.5 hidden truncate text-[11px] text-muted-foreground xl:block">
                Study and patient administration
              </p>
            </div>
          </div>

          <nav
            className="order-3 flex h-10 w-full items-stretch gap-5 border-t border-border/50 md:order-none md:h-auto md:w-auto md:border-t-0"
            aria-label="Manager view"
          >
            <button
              type="button"
              aria-pressed={managerMode === "study"}
              className={`flex h-full items-center border-b-2 px-1 text-xs font-medium transition-colors duration-150 ${
                managerMode === "study"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setManagerMode("study")}
            >
              Study
            </button>
            <button
              type="button"
              aria-pressed={managerMode === "patient"}
              className={`flex h-full items-center border-b-2 px-1 text-xs font-medium transition-colors duration-150 ${
                managerMode === "patient"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setManagerMode("patient")}
            >
              Patient
            </button>
          </nav>

          <div className="ml-auto flex items-center gap-1.5 py-2 pl-4">
            <div className="mr-1 hidden items-center gap-3 border-r border-border/50 pr-4 md:flex">
              <div className="min-w-[70px]">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      studiesError
                        ? "bg-destructive"
                        : refreshingStudies || loading
                          ? "animate-pulse bg-amber-500"
                          : "bg-emerald-500"
                    }`}
                  />
                  {studiesError ? "Attention" : refreshingStudies || loading ? "Syncing" : "Connected"}
                </p>
                <p className="mt-0.5 text-[9px] text-muted-foreground">PACS</p>
              </div>
              <div className="min-w-[40px]">
                <p className="text-[11px] font-medium tabular-nums text-foreground">{studies.length}</p>
                <p className="mt-0.5 text-[9px] text-muted-foreground">Studies</p>
              </div>
              {lastUpdatedAt && (
                <div className="hidden min-w-[52px] lg:block">
                  <p className="text-[11px] font-medium tabular-nums text-foreground">
                    {lastUpdatedAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                  <p className="mt-0.5 text-[9px] text-muted-foreground">Last sync</p>
                </div>
              )}
            </div>

            <Button
              variant="ghost"
              className="h-8 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground"
              size="sm"
              onClick={() => setHistoryOpen(true)}
              title="View operation history and restore points"
            >
              <History className="mr-1.5 h-3.5 w-3.5" /> History
            </Button>
            <Button className="h-8 rounded-md px-3 text-xs" size="sm" onClick={openStudyCreator} title="Create study">
              <Plus className="mr-1.5 h-3.5 w-3.5" /> New study
            </Button>
            <Button
              variant="ghost"
              className="h-8 w-8 rounded-md p-0 text-muted-foreground hover:text-foreground"
              size="icon"
              aria-label="Refresh studies"
              onClick={() => void loadStudies()}
              disabled={loading || refreshingStudies}
              title="Refresh studies"
            >
              {loading || refreshingStudies ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      </header>

      {studiesError && studies.length > 0 && (
        <div className="flex items-center justify-between bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <span className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" />
            Latest synchronization failed. Existing study data remains available.
          </span>
          <Button variant="ghost" size="sm" className="h-6 rounded px-2 text-xs" onClick={() => void loadStudies()}>
            Retry
          </Button>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col gap-3 bg-muted/[0.22] p-3 xl:flex-row">
        {renderPane("left")}
        <div className="hidden w-4 shrink-0 items-center justify-center text-muted-foreground/50 xl:flex" aria-hidden="true">
          <ArrowRight className="h-4 w-4" />
        </div>
        {renderPane("right")}
      </main>

      <Dialog
        open={Boolean(proposal)}
        onOpenChange={open => {
          if (!open && !committingMove) {
            setProposal(null);
            setMergeProgress(null);
          }
        }}
      >
        <DialogContent className="max-w-xl rounded-lg">
          <DialogHeader>
            <DialogTitle>{proposalCopy?.title || "Prepare DICOM action"}</DialogTitle>
            <DialogDescription>{proposalCopy?.description || "Review source and target before committing the DICOM Manager action."}</DialogDescription>
          </DialogHeader>
          {proposal && (
            <div className="space-y-3">
              {proposalCrossStudy && (
                <label className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/30 dark:text-amber-100">
                  <input
                    type="checkbox"
                    checked={metadataAdoptionConfirmed}
                    onChange={event => setMetadataAdoptionConfirmed(event.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    I understand this is a cross-study merge. The moved DICOM files will be rewritten to use the target patient, accession, and StudyInstanceUID.
                  </span>
                </label>
              )}
              {proposalPatientCorrection && (
                <label className="flex items-start gap-3 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-700/70 dark:bg-sky-950/30 dark:text-sky-100">
                  <input
                    type="checkbox"
                    checked={metadataAdoptionConfirmed}
                    onChange={event => setMetadataAdoptionConfirmed(event.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    I understand this is a patient correction. The study will keep its StudyInstanceUID, accession, date, series, and images, but patient identity tags will be rewritten to the target patient.
                  </span>
                </label>
              )}
              {!proposalCrossStudy && !proposalPatientCorrection && (
                <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground">
                  {proposalCopy?.description}
                </p>
              )}
              {mergeProgress && (
                <div className={`space-y-3 rounded-md border p-3 ${mergeProgress.status === "error" ? "border-destructive/30 bg-destructive/5" : mergeProgress.status === "cancelled" ? "border-amber-500/40 bg-amber-500/5" : mergeProgress.status === "complete" ? "border-emerald-500/30 bg-emerald-500/5" : "border-primary/20 bg-primary/5"}`}>
                  <div className="flex items-start justify-between gap-3 text-sm">
                    <span className="flex items-start gap-2 font-semibold text-foreground">
                      {mergeProgress.status === "running" ? (
                        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                      ) : mergeProgress.status === "complete" ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      ) : mergeProgress.status === "cancelled" ? (
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      ) : (
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      )}
                      {mergeProgress.message}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{mergeElapsedSeconds}s</span>
                  </div>
                  {mergeProgress.status === "running" && (
                    <div className="h-1 overflow-hidden rounded-full bg-primary/15" role="progressbar" aria-label="DICOM operation in progress">
                      <div className="h-full w-full animate-pulse bg-primary" />
                    </div>
                  )}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {mergeProgress.status === "running"
                      ? cancelRequested
                        ? "The server stops between series, so the series currently being moved will finish first."
                        : "Live phase and image count come from the operation the server journals for this study."
                      : mergeProgress.status === "complete"
                        ? "The server confirmed the operation and the affected hierarchy has been reloaded."
                        : mergeProgress.status === "cancelled"
                          ? "Series already moved stay in the target study; the rest are untouched in the source study. Run the merge again to continue."
                          : "The server did not complete the operation. Review the message above, then retry or cancel."}
                  </p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-md"
              onClick={() => {
                // While the merge runs this asks the server to stop between series
                // instead of hiding the panel; a running request cannot be aborted
                // client-side anyway.
                if (mergeProgress?.status === "running" && cancelHandlerRef.current) {
                  cancelHandlerRef.current();
                  return;
                }
                setProposal(null);
                setMergeProgress(null);
              }}
              disabled={committingMove && mergeProgress?.status !== "running"}
            >
              {mergeProgress?.status === "running"
                ? cancelRequested ? "Stopping..." : "Stop merge"
                : mergeProgress?.status === "complete" ? "Close" : "Cancel"}
            </Button>
            {mergeProgress?.status !== "complete" && (
              <Button
                className="rounded-md"
                onClick={confirmProposal}
                disabled={committingMove || ((proposalCrossStudy || proposalPatientCorrection) && !metadataAdoptionConfirmed)}
              >
                {committingMove ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <GitMerge className="mr-2 h-4 w-4" />}
                {mergeProgress?.status === "error"
                  ? "Try again"
                  : mergeProgress?.status === "cancelled" ? "Continue merging" : "Commit"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editTarget)} onOpenChange={open => !open && !savingMetadata && setEditTarget(null)}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden rounded-lg p-0">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit {editTarget?.level === "image" ? "Image" : editTarget?.level === "series" ? "Series" : "Study"} Metadata
            </DialogTitle>
            <DialogDescription>
              Changes are written into DICOM files and then the PACS index is refreshed. UID fields are intentionally locked for safety.
            </DialogDescription>
          </DialogHeader>
          {editTarget && (
            <div className="grid min-h-0 gap-5 overflow-y-auto px-6 py-5 lg:grid-cols-[0.85fr_1.15fr]">
              <div className="rounded-md border border-border bg-muted/25 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Selected Resource</p>
                <div className="mt-4 space-y-3">
                  <Info label="Patient" value={editTarget.study.PatientName} />
                  <Info label="Patient ID" value={editTarget.study.PatientID} />
                  <Info label="Accession" value={editTarget.study.AccessionNumber} />
                  <Info label="Study UID" value={editTarget.study.StudyInstanceUID} />
                  {"series" in editTarget && <Info label="Series UID" value={editTarget.series.SeriesInstanceUID} />}
                  {"instance" in editTarget && <Info label="SOP Instance UID" value={editTarget.instance.SOPInstanceUID} />}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {editTarget.fields.map(field => (
                  <label key={field.key} className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      {field.label}
                    </span>
                    <Input
                      value={field.value}
                      placeholder={field.placeholder}
                      onChange={event => updateEditField(field.key, event.target.value)}
                      className="rounded-md"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" className="rounded-md" onClick={() => setEditTarget(null)} disabled={savingMetadata}>
              Cancel
            </Button>
            <Button className="rounded-md" onClick={saveMetadata} disabled={savingMetadata}>
              {savingMetadata ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Metadata
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(createTarget)} onOpenChange={open => !open && !creatingResource && setCreateTarget(null)}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-hidden rounded-lg p-0">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Create {createTarget?.level === "image" ? "Image" : createTarget?.level === "series" ? "Series" : "Study"}
            </DialogTitle>
            <DialogDescription>
              Create resources directly in the DICOM hierarchy. Uploaded JPEG/PNG files are converted to DICOM Secondary Capture.
            </DialogDescription>
          </DialogHeader>
          {createTarget && (
            <div className="grid gap-4 overflow-y-auto px-6 py-5 md:grid-cols-2">
              {createTarget.level !== "study" && (
                <div className="md:col-span-2 rounded-md border border-border bg-muted/25 p-4">
                  <Info label="Target Study" value={createTarget.study.PatientName} />
                  {"series" in createTarget && <Info label="Target Series" value={createTarget.series.SeriesDescription || createTarget.series.SeriesNumber} />}
                </div>
              )}
              {createTarget.level === "image" && (
                <label className="space-y-2 md:col-span-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">JPEG / PNG File</span>
                  <Input
                    type="file"
                    accept="image/png,image/jpeg"
                    className="rounded-md"
                    onChange={event => {
                      const file = event.target.files?.[0];
                      setCreateTarget(current => (current && current.level === "image" ? { ...current, file } : current));
                    }}
                  />
                </label>
              )}
              {createTarget.fields.map(field => (
                <label key={field.key} className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {field.label}
                  </span>
                  <Input
                    value={field.value}
                    placeholder={field.placeholder}
                    onChange={event => updateCreateField(field.key, event.target.value)}
                    className="rounded-md"
                  />
                </label>
              ))}
            </div>
          )}
          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" className="rounded-md" onClick={() => setCreateTarget(null)} disabled={creatingResource}>
              Cancel
            </Button>
            <Button className="rounded-md" onClick={saveCreateTarget} disabled={creatingResource}>
              {creatingResource ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-b border-border px-5 py-5 pr-12 text-left">
            <div className="flex items-start justify-between gap-3">
              <div>
                <SheetTitle className="flex items-center gap-2 text-base">
                  <History className="h-4 w-4" /> Operation history
                </SheetTitle>
                <SheetDescription className="mt-1 text-xs leading-relaxed">
                  PACS-backed restore points for patient corrections, study merges, and hierarchy moves.
                </SheetDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-md px-2.5 text-xs"
                onClick={() => void loadManagerHistory()}
                disabled={historyLoading}
              >
                {historyLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Refresh
              </Button>
            </div>
          </SheetHeader>

          <div className="border-b border-border bg-muted/25 px-5 py-3">
            <div className="flex items-start gap-2.5 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <p>
                Restore runs only after snapshot checksums and current PACS files pass conflict validation. History starts from operations recorded after this feature is enabled.
              </p>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-5">
              {historyLoading && managerOperations.length === 0 && (
                <div className="space-y-3" aria-label="Loading operation history">
                  {[0, 1, 2].map(item => (
                    <div key={item} className="animate-pulse rounded-lg border border-border p-4">
                      <div className="h-3 w-2/5 rounded bg-muted" />
                      <div className="mt-3 h-2.5 w-4/5 rounded bg-muted" />
                      <div className="mt-2 h-2.5 w-3/5 rounded bg-muted" />
                    </div>
                  ))}
                </div>
              )}

              {historyError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-semibold">History unavailable</p>
                      <p className="mt-1 text-xs opacity-90">{historyError}</p>
                    </div>
                  </div>
                </div>
              )}

              {!historyLoading && !historyError && managerOperations.length === 0 && (
                <div className="rounded-lg border border-dashed border-border px-5 py-12 text-center">
                  <History className="mx-auto h-6 w-6 text-muted-foreground" />
                  <p className="mt-3 text-sm font-semibold text-foreground">No recorded operations yet</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    The next patient correction, merge, or move will create a PACS restore point here.
                  </p>
                </div>
              )}

              {managerOperations.map(operation => {
                const targetStudyUid = operation.targetStudyUid || "";
                const sourceStudyUid = operation.sourceStudyUid || "";
                const targetLabel = operation.operationType === "patient_correction"
                  ? operation.targetPatientId
                  : operation.operationType === "restore"
                    ? operation.parentOperationId
                    : operation.targetStudyUid;
                return (
                  <article key={operation.id} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-foreground">
                            {managerOperationLabels[operation.operationType] || operation.operationType.replace(/_/g, " ")}
                          </h3>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${managerStatusClass(operation.status)}`}>
                            {operation.status.replace(/_/g, " ")}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {formatManagerTimestamp(operation.createdAt)} · {operation.username || "system"}
                        </p>
                        {operation.progress && operation.status === "prepared" ? (
                          <div className="mt-2 space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              <span>{managerProgressLabels[operation.progress.stage || ""] || operation.progress.stage || operation.status}</span>
                              {operation.progress.total ? (
                                <span className="tabular-nums">{operation.progress.done}/{operation.progress.total}</span>
                              ) : null}
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary transition-all"
                                style={{
                                  width: operation.progress.total
                                    ? `${Math.min(100, Math.max(4, Math.round((operation.progress.done / operation.progress.total) * 100)))}%`
                                    : "15%",
                                }}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="shrink-0 rounded-md border border-border bg-muted/25 px-2 py-1 text-right">
                        <p className="text-sm font-semibold tabular-nums text-foreground">{operation.objectCount}</p>
                        <p className="text-[9px] uppercase tracking-wide text-muted-foreground">objects</p>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
                      <div className="grid grid-cols-[64px_1fr] gap-2">
                        <span className="font-medium text-muted-foreground">Source</span>
                        <span className="truncate font-mono text-[10px] text-foreground" title={operation.sourceStudyUid || ""}>
                          {safeText(operation.sourceStudyUid)}
                        </span>
                      </div>
                      <div className="grid grid-cols-[64px_1fr] gap-2">
                        <span className="font-medium text-muted-foreground">
                          {operation.operationType === "patient_correction" ? "Patient" : operation.operationType === "restore" ? "Restores" : "Target"}
                        </span>
                        <span className="truncate font-mono text-[10px] text-foreground" title={targetLabel || ""}>
                          {safeText(targetLabel)}
                        </span>
                      </div>
                    </div>

                    {operation.reason && (
                      <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={operation.reason}>
                        {operation.reason}
                      </p>
                    )}
                    {operation.errorMessage && (
                      <p className="mt-3 rounded-md bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                        {operation.errorMessage}
                      </p>
                    )}

                    {operation.outcome && (operation.outcome.skippedInstanceCount || operation.outcome.pendingSeriesCount || operation.outcome.unindexedFiles || operation.outcome.recoveredFiles || operation.outcome.cancelled) ? (
                      <div className="mt-3 space-y-2 rounded-md border border-amber-300/70 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-100">
                        <p className="flex items-center gap-1.5 font-semibold">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Needs attention
                        </p>
                        <ul className="list-inside list-disc space-y-1 leading-relaxed">
                          {operation.outcome.skippedInstanceCount ? (
                            <li>{operation.outcome.skippedInstanceCount} image(s) could not be moved and stayed in the source study.</li>
                          ) : null}
                          {operation.outcome.pendingSeriesCount ? (
                            <li>{operation.outcome.pendingSeriesCount} series were left in the source study when the merge stopped.</li>
                          ) : null}
                          {operation.outcome.unindexedFiles ? (
                            <li>{operation.outcome.unindexedFiles} file(s) are on disk but not in the PACS index.</li>
                          ) : null}
                          {operation.outcome.recoveredFiles ? (
                            <li>{operation.outcome.recoveredFiles} file(s) had to be recovered from the snapshot after the PACS refresh.</li>
                          ) : null}
                          {operation.outcome.cancelled ? (
                            <li>Cancelled by the operator: series that already moved stay in the target, the rest can be merged again.</li>
                          ) : null}
                        </ul>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 rounded-md px-2.5 text-xs"
                            onClick={() => void toggleOperationDetails(operation)}
                          >
                            {operationDetails[operation.id] ? (
                              <ChevronUp className="mr-1.5 h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {operationDetails[operation.id] ? "Hide details" : "View details"}
                          </Button>
                          {targetStudyUid && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 rounded-md px-2.5 text-xs"
                              disabled={reindexLoadingStudy === targetStudyUid}
                              onClick={() => void reindexManagerStudy(targetStudyUid)}
                            >
                              {reindexLoadingStudy === targetStudyUid ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FolderSync className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {reindexLoadingStudy === targetStudyUid ? (reindexStage || "Re-indexing…") : "Re-index target study"}
                            </Button>
                          )}
                          {reindexOperationId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 rounded-md px-2.5 text-xs"
                              disabled={stoppingOperationId === reindexOperationId}
                              onClick={() => void stopOperation(reindexOperationId, "re-index")}
                            >
                              {stoppingOperationId === reindexOperationId ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Square className="mr-1.5 h-3 w-3" />
                              )}
                              Stop
                            </Button>
                          )}
                          {sourceStudyUid && operation.outcome.pendingSeriesCount ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 rounded-md px-2.5 text-xs"
                              disabled={reindexLoadingStudy === sourceStudyUid}
                              onClick={() => void reindexManagerStudy(sourceStudyUid)}
                            >
                              {reindexLoadingStudy === sourceStudyUid ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FolderSync className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {reindexLoadingStudy === sourceStudyUid ? (reindexStage || "Re-indexing…") : "Re-index source study"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {operationDetailState[operation.id] === "loading" && (
                      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading operation details…
                      </p>
                    )}
                    {operationDetailState[operation.id] === "error" && (
                      <p className="mt-3 text-[11px] text-destructive">Operation details are unavailable for this entry.</p>
                    )}
                    {operationDetails[operation.id]?.details?.result ? (() => {
                      const detail = operationDetails[operation.id].details!.result!;
                      const skipped = detail.skippedInstances || [];
                      const pending = detail.pendingSeriesUids || [];
                      return (
                        <div className="mt-3 space-y-2.5 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-xs">
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                            <span>Series moved <span className="font-semibold tabular-nums text-foreground">{detail.movedSeriesCount ?? 0}</span></span>
                            <span>Images moved <span className="font-semibold tabular-nums text-foreground">{detail.movedInstanceCount ?? 0}</span></span>
                            <span>PACS index <span className="font-semibold text-foreground">{detail.pacsRefreshStatus || "n/a"}</span></span>
                            {detail.waitForIndex ? (
                              <span>Index wait <span className="font-semibold tabular-nums text-foreground">{detail.waitForIndex.waitedMs} ms</span></span>
                            ) : null}
                          </div>
                          {skipped.length ? (
                            <div>
                              <p className="font-medium text-foreground">Images that could not be moved</p>
                              <ul className="mt-1 space-y-1">
                                {skipped.map(item => (
                                  <li key={`${item.sopInstanceUid || "unknown"}-${item.reason}`} className="break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                                    {safeText(item.sopInstanceUid)} - {item.reason}
                                  </li>
                                ))}
                              </ul>
                              {detail.skippedInstancesTruncated ? (
                                <p className="mt-1 text-[10px] text-muted-foreground">Only the first {skipped.length} are listed in this record.</p>
                              ) : null}
                            </div>
                          ) : null}
                          {pending.length ? (
                            <div>
                              <p className="font-medium text-foreground">Series that stayed in the source study</p>
                              <ul className="mt-1 space-y-1">
                                {pending.map(uid => (
                                  <li key={uid} className="break-all font-mono text-[10px] text-muted-foreground">{uid}</li>
                                ))}
                              </ul>
                              {detail.pendingSeriesTruncated ? (
                                <p className="mt-1 text-[10px] text-muted-foreground">Only the first {pending.length} are listed in this record.</p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })() : null}

                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                      <span className="text-[10px] text-muted-foreground">
                        {operation.snapshotAvailable ? "Snapshot verified on disk" : operation.operationType === "restore" ? "Compensating history entry" : operation.operationType === "study_reindex" ? "Index-only operation" : "No restorable snapshot"}
                      </span>
                      <div className="flex items-center gap-2">
                        {operation.status === "prepared" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-md px-2.5 text-xs"
                            disabled={stoppingOperationId === operation.id || operation.cancelRequested}
                            onClick={() => void stopOperation(operation.id, operation.operationType === "study_reindex" ? "re-index" : "operation")}
                          >
                            {stoppingOperationId === operation.id ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Square className="mr-1.5 h-3 w-3" />
                            )}
                            {operation.cancelRequested ? "Stopping..." : "Stop"}
                          </Button>
                        )}
                        {operation.canRestore && canRestoreManagerOperation && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 rounded-md px-2.5 text-xs"
                          disabled={Boolean(preflightLoadingId)}
                          onClick={() => void openRestorePreflight(operation)}
                        >
                          {preflightLoadingId === operation.id ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Restore
                        </Button>
                        )}
                        {operation.canRestore && !canRestoreManagerOperation && (
                          <span className="text-[10px] font-medium text-muted-foreground">Admin restore permission required</span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <Dialog
        open={Boolean(restorePreflight)}
        onOpenChange={open => {
          if (!open && !restoringOperation) {
            setRestorePreflight(null);
            setRestoreReason("");
            setRestoreConfirmation("");
          }
        }}
      >
        <DialogContent className="max-w-2xl rounded-lg p-0">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5" /> Restore pre-operation state
            </DialogTitle>
            <DialogDescription>
              This creates a compensating history entry and restores the original DICOM files from the PACS snapshot.
            </DialogDescription>
          </DialogHeader>

          {restorePreflight && (
            <div className="max-h-[65vh] space-y-4 overflow-y-auto px-6 py-5">
              <div className={`rounded-lg border p-4 ${restorePreflight.canRestore ? "border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-destructive/30 bg-destructive/5"}`}>
                <div className="flex items-start gap-3">
                  {restorePreflight.canRestore ? (
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                  )}
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {restorePreflight.canRestore ? "Snapshot and current files are consistent" : "Restore is blocked by conflicts"}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {restorePreflight.canRestore
                        ? "The source snapshots match their checksums and the current operation outputs have not changed."
                        : "No files have been changed. Resolve the conflicts below before attempting restore."}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:grid-cols-2">
                <Info label="Operation" value={managerOperationLabels[restorePreflight.operation.operationType] || restorePreflight.operation.operationType} />
                <Info label="Objects affected" value={restorePreflight.operation.objectCount} />
                <Info label="Source study" value={restorePreflight.operation.sourceStudyUid} />
                <Info label="Target study / patient" value={restorePreflight.operation.targetStudyUid || restorePreflight.operation.targetPatientId} />
                <Info label="Performed by" value={restorePreflight.operation.username} />
                <Info label="Performed at" value={formatManagerTimestamp(restorePreflight.operation.createdAt)} />
              </div>

              {restorePreflight.conflicts.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Conflicts</p>
                  {restorePreflight.conflicts.map((conflict, index) => (
                    <div key={`${conflict.code}-${conflict.sopInstanceUid || index}`} className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      <p className="font-semibold">{conflict.message}</p>
                      {conflict.sopInstanceUid && <p className="mt-1 truncate font-mono text-[10px] opacity-80">SOP {conflict.sopInstanceUid}</p>}
                    </div>
                  ))}
                </div>
              )}

              {restorePreflight.canRestore && (
                <div className="space-y-4">
                  <label className="block space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Restore reason</span>
                    <Textarea
                      value={restoreReason}
                      onChange={event => setRestoreReason(event.target.value)}
                      placeholder="Explain why this operation must be restored..."
                      className="min-h-20 resize-none rounded-md"
                      disabled={restoringOperation}
                    />
                  </label>
                  <label className="block space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Type RESTORE to confirm</span>
                    <Input
                      value={restoreConfirmation}
                      onChange={event => setRestoreConfirmation(event.target.value)}
                      placeholder="RESTORE"
                      className="rounded-md font-mono"
                      autoComplete="off"
                      disabled={restoringOperation}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" className="rounded-md" disabled={restoringOperation} onClick={() => setRestorePreflight(null)}>
              Cancel
            </Button>
            {restorePreflight?.canRestore && (
              <Button
                className="rounded-md"
                onClick={() => void confirmManagerRestore()}
                disabled={restoringOperation || restoreReason.trim().length < 3 || restoreConfirmation !== "RESTORE"}
              >
                {restoringOperation ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                Restore operation
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {DeleteReasonDialog}
    </div>
  );
};

const Info = ({ label, value }: { label: string; value?: string | number | null }) => (
  <div className="min-w-0">
    <p className="text-[9px] font-medium text-muted-foreground">{label}</p>
    <p
      className="mt-0.5 whitespace-normal break-words text-[11px] font-medium leading-4 text-foreground [overflow-wrap:anywhere]"
      title={String(value || "")}
    >
      {safeText(value)}
    </p>
  </div>
);

const StudyListSkeleton = () => (
  <div className="space-y-1" aria-label="Loading studies">
    {[0, 1, 2, 3, 4].map(index => (
      <div key={index} className="flex animate-pulse items-start gap-3 rounded-md px-3 py-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3 w-3/5 rounded bg-muted" />
          <div className="h-2.5 w-4/5 rounded bg-muted/80" />
          <div className="h-2.5 w-2/3 rounded bg-muted/65" />
        </div>
        <div className="h-4 w-7 rounded bg-muted/80" />
      </div>
    ))}
  </div>
);

const HierarchySkeleton = () => (
  <div className="space-y-2" aria-label="Loading hierarchy">
    {[0, 1, 2].map(index => (
      <div
        key={index}
        className="flex animate-pulse items-center gap-3 rounded-md bg-card/75 p-2.5 shadow-[0_1px_3px_rgb(15_23_42/0.05)]"
      >
        <div className="h-[52px] w-[52px] rounded bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-1/2 rounded bg-muted" />
          <div className="h-2.5 w-3/4 rounded bg-muted/70" />
        </div>
      </div>
    ))}
  </div>
);

const InlineState = ({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: "error" | "empty";
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) => (
  <div className="flex min-h-32 flex-col items-center justify-center px-4 py-6 text-center">
    <div className={`mb-2 flex h-8 w-8 items-center justify-center rounded-full ${icon === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
      {icon === "error" ? <AlertCircle className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
    </div>
    <p className="text-xs font-semibold text-foreground">{title}</p>
    <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-muted-foreground">{description}</p>
    {actionLabel && onAction && (
      <Button variant="outline" size="sm" className="mt-3 h-7 rounded px-2.5 text-xs" onClick={onAction}>
        <RefreshCw className="mr-1.5 h-3 w-3" /> {actionLabel}
      </Button>
    )}
  </div>
);

const DicomThumbnail = ({
  src,
  alt,
  className,
  fit = "contain",
}: {
  src: string;
  alt: string;
  className: string;
  fit?: "cover" | "contain";
}) => {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  return (
    <div className={`relative shrink-0 overflow-hidden ${className}`}>
      {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-muted" aria-label="Loading thumbnail" />}
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground" title="Thumbnail unavailable">
          <ImageIcon className="h-4 w-4" />
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          className={`h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"} transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
};

const HierarchyPanel = ({
  title,
  subtitle,
  count,
  loading,
  error,
  emptyText,
  onRetry,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  loading: boolean;
  error?: string;
  emptyText: string;
  onRetry?: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="flex min-h-0 flex-col bg-background/65">
    <div className="flex items-center justify-between gap-3 bg-card/70 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-semibold text-foreground">{title}</h3>
          <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
        </div>
        <p className="mt-0.5 truncate text-[9px] text-muted-foreground" title={subtitle}>
          {subtitle}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </div>
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2.5 p-3" aria-live="polite">
        {loading && count === 0 ? (
          <HierarchySkeleton />
        ) : error ? (
          <InlineState
            icon="error"
            title={`Unable to load ${title.toLowerCase()}`}
            description={error}
            actionLabel={onRetry ? "Retry" : undefined}
            onAction={onRetry}
          />
        ) : count ? (
          children
        ) : (
          <InlineState
            icon="empty"
            title={emptyText}
            description="There is no DICOM content to display in this level."
          />
        )}
      </div>
    </ScrollArea>
  </div>
);

export default DicomManager;
