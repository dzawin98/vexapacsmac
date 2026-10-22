import { lazy, ReactNode, Suspense, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Cog, Loader2, Save, RadioTower, Edit2, Trash2, Activity, Wifi, Search, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  dicomWebService,
  dicomNodeService,
  DicomNode,
  ViewerConfig,
  expertiseService,
  usersService,
  User,
  DEFAULT_EXPERTISE_TEMPLATE,
  ExpertisePrintTemplate,
  LETTERHEAD_IMAGE_GUIDANCE,
  LETTERHEAD_PRINT_HEIGHT_MM,
} from "@/lib/dicomService";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDeleteReasonDialog } from "@/components/DeleteReasonDialog";

const TinyTemplateEditor = lazy(() => import("./settings/TinyTemplateEditor"));
const DicomRoutingSettings = lazy(() => import("./settings/DicomRoutingSettings"));

const SettingsShell = ({
  icon,
  title,
  description,
  children,
  actions,
  className = "",
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) => (
  <section
    className={`rounded-[28px] border border-border bg-card shadow-[0_18px_50px_-30px_rgba(15,23,42,0.18)] ${className}`}
  >
    <div className="flex flex-col gap-4 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-muted/40 text-foreground">
          {icon}
        </div>
        <div className="flex min-h-[44px] flex-col justify-center space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
          {description ? <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
    <div className="px-6 py-6">{children}</div>
  </section>
);

const SettingsFieldRow = ({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: ReactNode;
}) => (
  <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-muted/30 px-4 py-4">
    <div className="space-y-1">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? <p className="max-w-xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
    </div>
    <div className="pt-1">{control}</div>
  </div>
);

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

const SettingsPage = () => {
  const { toast } = useToast();
  const { confirmDelete, DeleteReasonDialog } = useDeleteReasonDialog();
  const { hasPermission } = useAuth();
  const canEditSettings = hasPermission("edit_settings");
  const [loading, setLoading] = useState(true);
  const [systemSaving, setSystemSaving] = useState(false);
  const [expertiseSaving, setExpertiseSaving] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [worklistSeriesPreviewEnabled, setWorklistSeriesPreviewEnabled] = useState(true);
  const [radiologistCompetitionEnabled, setRadiologistCompetitionEnabled] = useState(false);
  const [radiologistWhatsappMode, setRadiologistWhatsappMode] = useState<"manual" | "auto">("manual");
  const [radiologistWhatsappScope, setRadiologistWhatsappScope] = useState<"all" | "cito">("all");
  const [radiologistWhatsappTemplate, setRadiologistWhatsappTemplate] = useState(DEFAULT_RADIOLOGIST_NOTIFICATION_TEMPLATE);
  const [viewerAccessLinkDays, setViewerAccessLinkDays] = useState("7");
  const [patientPortalMaxImagesPerSeries, setPatientPortalMaxImagesPerSeries] = useState("100");
  const [viewerConfigs, setViewerConfigs] = useState<ViewerConfig[]>([]);
  const [headerImage, setHeaderImage] = useState<string | null>(null);
  const [headerPreview, setHeaderPreview] = useState<string | null>(null);
  const [templateHtml, setTemplateHtml] = useState("");
  const [printTemplates, setPrintTemplates] = useState<ExpertisePrintTemplate[]>([]);
  const [selectedPrintTemplateId, setSelectedPrintTemplateId] = useState<number | null>(null);
  const [printTemplateName, setPrintTemplateName] = useState("Default Template");
  const [printTemplateActive, setPrintTemplateActive] = useState(true);
  const [printTemplateDefault, setPrintTemplateDefault] = useState(true);
  const [qrPosition, setQrPosition] = useState<"left" | "center" | "right">("right");
  const [radiologistUsers, setRadiologistUsers] = useState<User[]>([]);
  const [selectedRadiologistId, setSelectedRadiologistId] = useState<number | null>(null);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [signaturePreview, setSignaturePreview] = useState<string | null>(null);
  const [signatureLoading, setSignatureLoading] = useState(false);
  const [nodes, setNodes] = useState<DicomNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  const [nodeSaving, setNodeSaving] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [echoTestingNodeId, setEchoTestingNodeId] = useState<number | null>(null);
  const [pingTestingNodeId, setPingTestingNodeId] = useState<number | null>(null);
  const [queryTestingNodeId, setQueryTestingNodeId] = useState<number | null>(null);
  const [nodeForm, setNodeForm] = useState<{
    name: string;
    aet: string;
    host: string;
    port: string;
    description: string;
    enabled: boolean;
  }>({
    name: "",
    aet: "",
    host: "",
    port: "",
    description: "",
    enabled: true,
  });

  useEffect(() => {
    const load = async () => {
      try {
        const [uiSettings, expertise, fetchedTemplates, fetchedUsers, fetchedNodes] = await Promise.all([
          dicomWebService.fetchUiSettings(),
          expertiseService.fetchSettings(),
          expertiseService.fetchPrintTemplates(),
          usersService.fetchUsers(),
          dicomNodeService.fetchNodes(),
        ]);
        if (typeof uiSettings.autoRefresh === "boolean") {
          setAutoRefresh(uiSettings.autoRefresh);
        }
        if (typeof uiSettings.worklistSeriesPreviewEnabled === "boolean") {
          setWorklistSeriesPreviewEnabled(uiSettings.worklistSeriesPreviewEnabled);
        }
        if (typeof uiSettings.radiologistCompetitionEnabled === "boolean") {
          setRadiologistCompetitionEnabled(uiSettings.radiologistCompetitionEnabled);
        }
        if (uiSettings.radiologistWhatsappNotification?.mode === "auto" || uiSettings.radiologistWhatsappNotification?.mode === "manual") {
          setRadiologistWhatsappMode(uiSettings.radiologistWhatsappNotification.mode);
        }
        if (uiSettings.radiologistWhatsappNotification?.scope === "all" || uiSettings.radiologistWhatsappNotification?.scope === "cito") {
          setRadiologistWhatsappScope(uiSettings.radiologistWhatsappNotification.scope);
        }
        if (typeof uiSettings.radiologistWhatsappNotification?.messageTemplate === "string") {
          setRadiologistWhatsappTemplate(uiSettings.radiologistWhatsappNotification.messageTemplate || DEFAULT_RADIOLOGIST_NOTIFICATION_TEMPLATE);
        }
        if (typeof uiSettings.viewerAccessLinkDays === "number" && Number.isFinite(uiSettings.viewerAccessLinkDays)) {
          setViewerAccessLinkDays(String(uiSettings.viewerAccessLinkDays));
        }
        if (
          typeof uiSettings.patientPortalMaxImagesPerSeries === "number" &&
          Number.isFinite(uiSettings.patientPortalMaxImagesPerSeries)
        ) {
          setPatientPortalMaxImagesPerSeries(String(uiSettings.patientPortalMaxImagesPerSeries));
        }
        if (Array.isArray(uiSettings.viewers) && uiSettings.viewers.length > 0) {
          setViewerConfigs(uiSettings.viewers);
        } else {
          setViewerConfigs([
            {
              id: "vexa-pacs",
              name: "Default Viewer",
              baseUrl: uiSettings.viewerUrl || "http://127.0.0.1:5994",
              path: uiSettings.viewerPath || "/Viewer",
              queryParam: "launch",
              type: "vexa-ris-launch",
            },
          ]);
        }
        setHeaderImage(expertise.headerImage ?? null);
        setHeaderPreview(expertise.headerImage ?? null);
        setTemplateHtml(expertise.templateHtml ?? DEFAULT_EXPERTISE_TEMPLATE);
        setPrintTemplates(fetchedTemplates);
        const defaultTemplate = fetchedTemplates.find(template => template.isDefault) || fetchedTemplates[0];
        if (defaultTemplate) {
          setSelectedPrintTemplateId(defaultTemplate.id);
          setPrintTemplateName(defaultTemplate.name || "Default Template");
          setPrintTemplateActive(defaultTemplate.isActive);
          setPrintTemplateDefault(defaultTemplate.isDefault);
          setHeaderImage(defaultTemplate.headerImage ?? expertise.headerImage ?? null);
          setHeaderPreview(defaultTemplate.headerImage ?? expertise.headerImage ?? null);
          setTemplateHtml(defaultTemplate.templateHtml ?? expertise.templateHtml ?? DEFAULT_EXPERTISE_TEMPLATE);
        }
        if (expertise.qrPosition === "left" || expertise.qrPosition === "center" || expertise.qrPosition === "right") {
          setQrPosition(expertise.qrPosition);
        } else {
          setQrPosition("right");
        }
        const radiologists = fetchedUsers.filter(user => user.role === "radiologist");
        setRadiologistUsers(radiologists);
        if (radiologists.length > 0) {
          setSelectedRadiologistId(radiologists[0].id);
        }
        setNodes(fetchedNodes);
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to load settings",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
        setNodesLoading(false);
      }
    };
    load();
  }, [toast]);

  const handleSaveSystem = async () => {
    setSystemSaving(true);
    try {
      const nextViewers =
        viewerConfigs.length > 0
          ? viewerConfigs.map((v, index) => ({
            ...v,
            id: v.id || `viewer-${index + 1}`,
          }))
          : [
            {
              id: "vexa-pacs",
              name: "Default Viewer",
              baseUrl: "http://127.0.0.1:5994",
              path: "/Viewer",
              queryParam: "launch",
              type: "vexa-ris-launch",
            },
          ];
      const primaryViewer = nextViewers[0];
      const parsedViewerAccessLinkDays = Number(viewerAccessLinkDays);
      const parsedPatientPortalMaxImagesPerSeries = Number(patientPortalMaxImagesPerSeries);
      await dicomWebService.updateUiSettings({
        viewerUrl: primaryViewer.baseUrl,
        viewerPath: primaryViewer.path,
        autoRefresh,
        worklistSeriesPreviewEnabled,
        radiologistCompetitionEnabled,
        radiologistWhatsappNotification: {
          mode: radiologistWhatsappMode,
          scope: radiologistWhatsappScope,
          messageTemplate: radiologistWhatsappTemplate,
        },
        viewerAccessLinkDays:
          Number.isFinite(parsedViewerAccessLinkDays) && parsedViewerAccessLinkDays >= 0
            ? Math.floor(parsedViewerAccessLinkDays)
            : 7,
        patientPortalMaxImagesPerSeries:
          Number.isFinite(parsedPatientPortalMaxImagesPerSeries) && parsedPatientPortalMaxImagesPerSeries >= 0
            ? Math.floor(parsedPatientPortalMaxImagesPerSeries)
            : 100,
        viewers: nextViewers,
      });
      toast({ title: "System saved", description: "System preferences updated successfully." });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to save system settings",
        variant: "destructive",
      });
    } finally {
      setSystemSaving(false);
    }
  };

  const handleSaveExpertise = async () => {
    setExpertiseSaving(true);
    try {
      let savedTemplate: ExpertisePrintTemplate | null = null;
      const templatePayload = {
        name: printTemplateName.trim() || "Print Template",
        headerImage,
        templateHtml: templateHtml.trim() ? templateHtml : null,
        isActive: printTemplateActive,
        isDefault: printTemplateDefault,
      };
      if (selectedPrintTemplateId) {
        savedTemplate = await expertiseService.updatePrintTemplate(selectedPrintTemplateId, templatePayload);
      } else {
        savedTemplate = await expertiseService.createPrintTemplate(templatePayload);
      }
      await expertiseService.updateSettings({
        headerImage,
        templateHtml: templateHtml.trim() ? templateHtml : null,
        qrPosition,
      });
      if (selectedRadiologistId !== null) {
        await expertiseService.updateSignature({
          userId: selectedRadiologistId,
          signatureImage,
        });
      }
      const fetchedTemplates = await expertiseService.fetchPrintTemplates();
      setPrintTemplates(fetchedTemplates);
      if (savedTemplate) {
        setSelectedPrintTemplateId(savedTemplate.id);
        setPrintTemplateName(savedTemplate.name);
        setPrintTemplateActive(savedTemplate.isActive);
        setPrintTemplateDefault(savedTemplate.isDefault);
      }
      toast({ title: "Ekspertise saved", description: "Ekspertise configuration updated successfully." });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to save ekspertise settings",
        variant: "destructive",
      });
    } finally {
      setExpertiseSaving(false);
    }
  };

  const handleSelectPrintTemplate = (id: number | null) => {
    if (id === null) {
      setSelectedPrintTemplateId(null);
    setPrintTemplateName("New Template");
    setPrintTemplateActive(true);
    setPrintTemplateDefault(printTemplates.length === 0);
    setHeaderImage(null);
    setHeaderPreview(null);
    setTemplateHtml(DEFAULT_EXPERTISE_TEMPLATE);
      return;
    }
    const template = printTemplates.find(item => item.id === id);
    if (!template) return;
    setSelectedPrintTemplateId(template.id);
    setPrintTemplateName(template.name);
    setPrintTemplateActive(template.isActive);
    setPrintTemplateDefault(template.isDefault);
    setHeaderImage(template.headerImage ?? null);
    setHeaderPreview(template.headerImage ?? null);
    setTemplateHtml(template.templateHtml ?? DEFAULT_EXPERTISE_TEMPLATE);
  };

  const handleDeletePrintTemplate = async () => {
    if (!canEditSettings || !selectedPrintTemplateId) return;
    const template = printTemplates.find(item => item.id === selectedPrintTemplateId);
    const reason = await confirmDelete({
      title: "Delete print template?",
      description: "This removes the template from future print and patient-token choices.",
      target: template?.name || `Template ID ${selectedPrintTemplateId}`,
    });
    if (!reason) return;
    setExpertiseSaving(true);
    try {
      await expertiseService.deletePrintTemplate(selectedPrintTemplateId);
      const fetchedTemplates = await expertiseService.fetchPrintTemplates();
      setPrintTemplates(fetchedTemplates);
      const nextTemplate = fetchedTemplates.find(item => item.isDefault) || fetchedTemplates[0] || null;
      if (nextTemplate) {
        setSelectedPrintTemplateId(nextTemplate.id);
        setPrintTemplateName(nextTemplate.name);
        setPrintTemplateActive(nextTemplate.isActive);
        setPrintTemplateDefault(nextTemplate.isDefault);
        setHeaderImage(nextTemplate.headerImage ?? null);
        setHeaderPreview(nextTemplate.headerImage ?? null);
        setTemplateHtml(nextTemplate.templateHtml ?? DEFAULT_EXPERTISE_TEMPLATE);
      } else {
        setSelectedPrintTemplateId(null);
        setPrintTemplateName("New Template");
        setPrintTemplateActive(true);
        setPrintTemplateDefault(true);
        setHeaderImage(null);
        setHeaderPreview(null);
        setTemplateHtml(DEFAULT_EXPERTISE_TEMPLATE);
      }
      toast({ title: "Template deleted", description: "Print template removed." });
    } catch (error) {
      toast({ title: "Error", description: "Failed to delete print template", variant: "destructive" });
    } finally {
      setExpertiseSaving(false);
    }
  };

  useEffect(() => {
    const loadSignature = async () => {
      if (selectedRadiologistId === null) {
        setSignatureImage(null);
        setSignaturePreview(null);
        return;
      }
      setSignatureLoading(true);
      try {
        const payload = await expertiseService.fetchSignature(selectedRadiologistId);
        setSignatureImage(payload.signatureImage ?? null);
        setSignaturePreview(payload.signatureImage ?? null);
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to load radiologist signature",
          variant: "destructive",
        });
      } finally {
        setSignatureLoading(false);
      }
    };
    loadSignature();
  }, [selectedRadiologistId, toast]);

  const readFileAsDataUrl = (file: File, onLoad: (value: string) => void) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        onLoad(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const resetNodeForm = () => {
    setEditingNodeId(null);
    setNodeForm({
      name: "",
      aet: "",
      host: "",
      port: "",
      description: "",
      enabled: true,
    });
  };

  const handleEditNode = (node: DicomNode) => {
    setEditingNodeId(node.id);
    setNodeForm({
      name: node.name,
      aet: node.aet,
      host: node.host,
      port: String(node.port),
      description: node.description || "",
      enabled: node.enabled,
    });
  };

  const handleDeleteNode = async (id: number) => {
    if (!canEditSettings) return;
    const node = nodes.find(item => item.id === id);
    const reason = await confirmDelete({
      title: "Delete DICOM node?",
      description: "This will remove the DICOM destination configuration.",
      target: node ? `${node.name} (${node.aet} @ ${node.host}:${node.port})` : `Node ID ${id}`,
    });
    if (!reason) return;
    try {
      await dicomNodeService.deleteNode(id, { reason });
      setNodes(prev => prev.filter(n => n.id !== id));
      if (editingNodeId === id) {
        resetNodeForm();
      }
      toast({
        title: "DICOM node removed",
        description: "Destination has been deleted.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete DICOM node",
        variant: "destructive",
      });
    }
  };

  const handleEchoTest = async (node: DicomNode) => {
    if (!canEditSettings) return;
    setEchoTestingNodeId(node.id);
    try {
      const message = await dicomNodeService.echoNode(node.id);
      const description =
        message ||
        `Echo test to ${node.name} (${node.aet} @ ${node.host}:${node.port}) succeeded.`;
      toast({
        title: "Echo Test",
        description,
      });
    } catch (error) {
      toast({
        title: "Echo Test failed",
        description:
          error instanceof Error ? error.message : `Echo test to ${node.name} failed.`,
        variant: "destructive",
      });
    } finally {
      setEchoTestingNodeId(null);
    }
  };

  const handlePingTest = async (node: DicomNode) => {
    if (!canEditSettings) return;
    setPingTestingNodeId(node.id);
    try {
      const message = await dicomNodeService.pingNode(node.id);
      const description =
        message || `Ping to ${node.host}:${node.port} (${node.name}) succeeded.`;
      toast({
        title: "Ping Test",
        description,
      });
    } catch (error) {
      toast({
        title: "Ping Test failed",
        description:
          error instanceof Error ? error.message : `Ping test to ${node.name} failed.`,
        variant: "destructive",
      });
    } finally {
      setPingTestingNodeId(null);
    }
  };

  const handleQueryTest = async (node: DicomNode) => {
    if (!canEditSettings) return;
    setQueryTestingNodeId(node.id);
    try {
      const result = await dicomNodeService.queryNode(node.id);
      toast({
        title: "Query Test",
        description:
          result.message ||
          `C-FIND query to ${node.name} (${node.aet} @ ${node.host}:${node.port}) succeeded.`,
      });
    } catch (error) {
      toast({
        title: "Query Test failed",
        description:
          error instanceof Error ? error.message : `C-FIND query test to ${node.name} failed.`,
        variant: "destructive",
      });
    } finally {
      setQueryTestingNodeId(null);
    }
  };

  const handleSubmitNode = async () => {
    if (!canEditSettings) return;
    const trimmed = {
      name: nodeForm.name.trim(),
      aet: nodeForm.aet.trim(),
      host: nodeForm.host.trim(),
      port: nodeForm.port.trim(),
      description: nodeForm.description.trim(),
    };
    if (!trimmed.name || !trimmed.aet || !trimmed.host || !trimmed.port) {
      toast({
        title: "Incomplete",
        description: "Name, AE Title, Host, and Port are required.",
        variant: "destructive",
      });
      return;
    }
    const parsedPort = Number(trimmed.port);
    if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
      toast({
        title: "Invalid port",
        description: "Port must be a positive number.",
        variant: "destructive",
      });
      return;
    }

    setNodeSaving(true);
    try {
      if (editingNodeId === null) {
        const created = await dicomNodeService.createNode({
          name: trimmed.name,
          aet: trimmed.aet,
          host: trimmed.host,
          port: parsedPort,
          description: trimmed.description || undefined,
          enabled: nodeForm.enabled,
        });
        setNodes(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        toast({
          title: "DICOM node added",
          description: "New destination has been created.",
        });
      } else {
        const updated = await dicomNodeService.updateNode(editingNodeId, {
          name: trimmed.name,
          aet: trimmed.aet,
          host: trimmed.host,
          port: parsedPort,
          description: trimmed.description || undefined,
          enabled: nodeForm.enabled,
        });
        setNodes(prev =>
          prev
            .map(n => (n.id === updated.id ? updated : n))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
        toast({
          title: "DICOM node updated",
          description: "Destination has been updated.",
        });
      }
      resetNodeForm();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to save DICOM node",
        variant: "destructive",
      });
    } finally {
      setNodeSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="admin-command-page mx-auto max-w-6xl space-y-6 pb-10 text-foreground" aria-busy="true">
        <div className="flex flex-col gap-2 border-b border-border pb-4">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Settings</h1>
        </div>
        <div className="h-12 w-full animate-pulse rounded-2xl border border-border bg-muted/40" />
        <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
          <div className="h-80 animate-pulse rounded-[28px] border border-border bg-card" />
          <div className="h-80 animate-pulse rounded-[28px] border border-border bg-card" />
        </div>
      </div>
    );
  }

  return (
    <div className="admin-command-page mx-auto w-full min-w-0 max-w-6xl space-y-6 pb-10 text-foreground">
      <div className="flex flex-col gap-2 border-b border-border pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Settings</h1>
          </div>
        </div>
      </div>

      <Tabs defaultValue="system" className="min-w-0 space-y-5 overflow-x-hidden">
        <TabsList className="h-auto w-full justify-start gap-2 overflow-x-auto rounded-[24px] border border-border bg-muted/40 p-2">
          <TabsTrigger
            value="system"
            className="shrink-0 rounded-2xl px-4 py-2.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            System
          </TabsTrigger>
          <TabsTrigger
            value="patient-portal"
            className="shrink-0 rounded-2xl px-4 py-2.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            Patient Portal
          </TabsTrigger>
          <TabsTrigger
            value="ekspertise"
            className="shrink-0 rounded-2xl px-4 py-2.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            Template
          </TabsTrigger>
          <TabsTrigger
            value="notification"
            className="shrink-0 rounded-2xl px-4 py-2.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            Notification
          </TabsTrigger>
          <TabsTrigger
            value="dicom-nodes"
            className="shrink-0 rounded-2xl px-4 py-2.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            Network
          </TabsTrigger>
          <TabsTrigger
            value="dicom-routing"
            className="shrink-0 rounded-2xl px-4 py-2.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            DICOM Routing
          </TabsTrigger>
        </TabsList>

        <TabsContent value="system">
          <div className="space-y-5">
            <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
            <SettingsShell
              icon={<Cog className="h-5 w-5" />}
              title="System Preferences"
            >
              <div className="space-y-4">
                <SettingsFieldRow
                  title="Auto-refresh Worklist"
                  control={<Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} disabled={!canEditSettings} />}
                />
                <SettingsFieldRow
                  title="Series & Preview Worklist"
                  description="Show the series list and previews when a study is selected in the Worklist and Distribution pages."
                  control={
                    <Switch
                      checked={worklistSeriesPreviewEnabled}
                      onCheckedChange={setWorklistSeriesPreviewEnabled}
                      disabled={!canEditSettings}
                    />
                  }
                />
                <SettingsFieldRow
                  title="Radiologists Unlock"
                  control={
                    <Switch
                      checked={radiologistCompetitionEnabled}
                      onCheckedChange={setRadiologistCompetitionEnabled}
                      disabled={!canEditSettings}
                    />
                  }
                />
              </div>
            </SettingsShell>

            <SettingsShell
              icon={<Save className="h-5 w-5" />}
              title="Viewer Token"
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-border bg-muted/30 p-4">
                  <Label htmlFor="viewer-access-link-days" className="text-sm font-semibold text-foreground">
                    Viewer Token Expiry (days)
                  </Label>
                  <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <Input
                      id="viewer-access-link-days"
                      type="number"
                      min={0}
                      step={1}
                      value={viewerAccessLinkDays}
                      onChange={event => setViewerAccessLinkDays(event.target.value)}
                      disabled={!canEditSettings}
                      className="h-11 max-w-[220px] rounded-2xl border-border bg-background"
                    />
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  </p>
                </div>
              </div>
            </SettingsShell>
          </div>
            <div className="flex justify-end">
              <Button
                className="h-10 rounded-2xl px-4 text-sm"
                onClick={handleSaveSystem}
                disabled={systemSaving || !canEditSettings}
              >
                {systemSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="patient-portal">
          <div className="space-y-5">
            <SettingsShell
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Patient Portal"
              description="Control what image data is exposed through public patient study links."
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-border bg-muted/30 p-4">
                  <Label htmlFor="patient-portal-max-images" className="text-sm font-semibold text-foreground">
                    Maximum Images Per Series
                  </Label>
                  <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <Input
                      id="patient-portal-max-images"
                      type="number"
                      min={0}
                      step={1}
                      value={patientPortalMaxImagesPerSeries}
                      onChange={event => setPatientPortalMaxImagesPerSeries(event.target.value)}
                      disabled={!canEditSettings}
                      className="h-11 max-w-[220px] rounded-2xl border-border bg-background"
                    />
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Public study links will hide series with more images than this value. Use 0 to disable the limit.
                  </p>
                </div>
              </div>
            </SettingsShell>
            <div className="flex justify-end">
              <Button
                className="h-10 rounded-2xl px-4 text-sm"
                onClick={handleSaveSystem}
                disabled={systemSaving || !canEditSettings}
              >
                {systemSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="notification">
          <div className="space-y-5">
            <SettingsShell
              icon={<Activity className="h-5 w-5" />}
              title="Radiologist WhatsApp Notification"
            >
              <div className="space-y-5">
                <SettingsFieldRow
                  title="Auto Send When Technologist Completed"
                  control={
                    <Switch
                      checked={radiologistWhatsappMode === "auto"}
                      onCheckedChange={checked => setRadiologistWhatsappMode(checked ? "auto" : "manual")}
                      disabled={!canEditSettings}
                    />
                  }
                />
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-foreground">Auto Send Scope</Label>
                  <select
                    className="w-full rounded-2xl border border-border bg-background px-3 py-2.5 text-sm text-foreground"
                    value={radiologistWhatsappScope}
                    onChange={event => setRadiologistWhatsappScope(event.target.value === "cito" ? "cito" : "all")}
                    disabled={!canEditSettings}
                  >
                    <option value="all">All Study</option>
                    <option value="cito">CITO</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-foreground">Message Template</Label>
                  <textarea
                    className="min-h-[260px] w-full rounded-2xl border border-border bg-background p-3 text-sm text-foreground outline-none focus:border-ring"
                    value={radiologistWhatsappTemplate}
                    onChange={event => setRadiologistWhatsappTemplate(event.target.value)}
                    disabled={!canEditSettings}
                  />
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Available placeholders</div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                    {[
                      "{{radiologist_name}}",
                      "{{patient_name}}",
                      "{{patient_id}}",
                      "{{accession_number}}",
                      "{{study_description}}",
                      "{{priority}}",
                      "{{reporting_link}}",
                      "{{study_instance_uid}}",
                    ].map(item => (
                      <button
                        key={item}
                        type="button"
                        className="rounded-xl border border-border bg-muted/30 px-2 py-1.5 font-mono text-left hover:bg-muted"
                        onClick={() => setRadiologistWhatsappTemplate(prev => `${prev}${prev.endsWith("\n") || !prev ? "" : "\n"}${item}`)}
                        disabled={!canEditSettings}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-2xl border-border bg-background"
                    onClick={() => setRadiologistWhatsappTemplate(DEFAULT_RADIOLOGIST_NOTIFICATION_TEMPLATE)}
                    disabled={!canEditSettings}
                  >
                    Reset Template
                  </Button>
                  <Button
                    className="h-10 rounded-2xl px-4 text-sm"
                    onClick={handleSaveSystem}
                    disabled={systemSaving || !canEditSettings}
                  >
                    {systemSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save Notification
                  </Button>
                </div>
              </div>
            </SettingsShell>
          </div>
        </TabsContent>

        <TabsContent value="ekspertise" className="min-w-0 overflow-x-hidden">
          <div className="min-w-0 space-y-6">
            <SettingsShell
              icon={<Edit2 className="h-5 w-5" />}
              title="Template Library"
            >
              <div className="grid gap-4 rounded-2xl border border-border bg-muted/20 p-4 lg:grid-cols-[minmax(260px,1fr)_minmax(260px,1fr)]">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-foreground">Template</Label>
                  <select
                    className="w-full rounded-2xl border border-border bg-background px-3 py-2.5 text-sm text-foreground"
                    value={selectedPrintTemplateId ?? "new"}
                    onChange={event => {
                      const value = event.target.value;
                      handleSelectPrintTemplate(value === "new" ? null : Number(value));
                    }}
                    disabled={!canEditSettings}
                  >
                    {printTemplates.map(template => (
                      <option key={template.id} value={template.id}>
                        {template.name}{template.isDefault ? " (Default)" : ""}{!template.isActive ? " (Inactive)" : ""}
                      </option>
                    ))}
                    <option value="new">+ New Template</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-foreground">Template Name</Label>
                  <Input
                    value={printTemplateName}
                    onChange={event => setPrintTemplateName(event.target.value)}
                    disabled={!canEditSettings}
                    className="rounded-2xl border-border bg-background"
                    placeholder="TEMPLATE ID / TEMPLATE ENGLISH / TEMPLATE ECG"
                  />
                </div>
                <div className="grid gap-3 lg:col-span-2 md:grid-cols-2">
                  <SettingsFieldRow
                    title="Active"
                    description="Available for Distribution and patient access links."
                    control={<Switch checked={printTemplateActive} onCheckedChange={setPrintTemplateActive} disabled={!canEditSettings} />}
                  />
                  <SettingsFieldRow
                    title="Default"
                    description="Used when no specific template is selected."
                    control={<Switch checked={printTemplateDefault} onCheckedChange={setPrintTemplateDefault} disabled={!canEditSettings} />}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 lg:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-2xl border-border bg-background"
                    onClick={() => handleSelectPrintTemplate(null)}
                    disabled={!canEditSettings}
                  >
                    New Template
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-2xl border-border bg-background text-destructive hover:text-destructive"
                    onClick={handleDeletePrintTemplate}
                    disabled={!canEditSettings || !selectedPrintTemplateId || expertiseSaving}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete Template
                  </Button>
                </div>
              </div>
            </SettingsShell>

            <SettingsShell
              icon={<Edit2 className="h-5 w-5" />}
              title="Letterhead"
            >
              <div className="space-y-3">
                <Input
                  type="file"
                  accept="image/*"
                  className="rounded-2xl border-border bg-background"
                  disabled={!canEditSettings}
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (file) {
                      readFileAsDataUrl(file, value => {
                        setHeaderImage(value);
                        setHeaderPreview(value);
                      });
                    }
                  }}
                />
                <div className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  The letterhead automatically fits the full A4 page width. Recommended file: {LETTERHEAD_IMAGE_GUIDANCE}
                </div>
                {headerPreview ? (
                  <div className="rounded-2xl border border-border bg-muted/30 p-4">
                    <div className="mx-auto w-full max-w-[840px] overflow-hidden bg-background" style={{ height: `${LETTERHEAD_PRINT_HEIGHT_MM}mm` }}>
                      <img src={headerPreview} alt="Letterhead" className="h-full w-full object-fill" />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                    No letterhead yet.
                  </div>
                )}
              </div>
            </SettingsShell>

            <SettingsShell
              icon={<Edit2 className="h-5 w-5" />}
              title="Print Layout"
            >
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-foreground">QR Position</Label>
                    <select
                      className="w-full rounded-2xl border border-border bg-background px-3 py-2.5 text-sm text-foreground"
                      value={qrPosition}
                      onChange={event => {
                        const nextValue = event.target.value as "left" | "center" | "right";
                        setQrPosition(nextValue);
                      }}
                      disabled={!canEditSettings}
                    >
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                </div>
                <Tabs defaultValue="wysiwyg" className="space-y-4">
                  <TabsList className="rounded-2xl border border-border bg-muted/40 p-1">
                    <TabsTrigger value="wysiwyg" className="rounded-xl data-[state=active]:bg-background data-[state=active]:shadow-sm">Editor</TabsTrigger>
                    <TabsTrigger value="html" className="rounded-xl data-[state=active]:bg-background data-[state=active]:shadow-sm">HTML</TabsTrigger>
                  </TabsList>
                  <TabsContent value="wysiwyg">
                    <Suspense
                      fallback={
                        <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-border bg-muted/30 text-sm text-muted-foreground">
                          Preparing template editor...
                        </div>
                      }
                    >
                      <TinyTemplateEditor
                        value={templateHtml}
                        onChange={setTemplateHtml}
                        disabled={!canEditSettings}
                      />
                    </Suspense>
                  </TabsContent>
                  <TabsContent value="html">
                    <Label className="text-sm font-semibold text-foreground">Template HTML</Label>
                    <textarea
                      className="min-h-[260px] w-full rounded-2xl border border-border bg-background p-3 text-xs text-foreground outline-none focus:border-ring"
                      value={templateHtml}
                      onChange={event => setTemplateHtml(event.target.value)}
                      disabled={!canEditSettings}
                    />
                    <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Available placeholders</div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                      {[
                        "{{header_html}}",
                        "{{patient_name}}",
                        "{{patient_id}}",
                        "{{gender}}",
                        "{{birth_date}}",
                        "{{age}}",
                        "{{birth_date_age}}",
                        "{{study_description}}",
                        "{{study_date}}",
                        "{{study_time}}",
                        "{{study_datetime}}",
                        "{{report_date}}",
                        "{{referring_physician}}",
                        "{{radiologist_name}}",
                        "{{clinical_info}}",
                        "{{findings}}",
                        "{{conclusion}}",
                        "{{report_content}}",
                        "{{qr_html}}",
                        "{{qr_image_html}}",
                        "{{qr_label}}",
                        "{{qr_expiry}}",
                        "{{qr_block_html}}",
                        "{{signature_html}}",
                        "{{signature_name}}",
                      ].map(item => (
                        <div key={item} className="rounded-xl border border-border bg-muted/30 px-2 py-1.5 font-mono">
                          {item}
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                </Tabs>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-2xl border-border bg-background"
                    onClick={() => setTemplateHtml(DEFAULT_EXPERTISE_TEMPLATE)}
                    disabled={!canEditSettings}
                  >
                    Reset to Default
                  </Button>
                </div>
              </div>
            </SettingsShell>

            <SettingsShell
              icon={<Edit2 className="h-5 w-5" />}
              title="Doctor Signature"
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-foreground">Doctor User</Label>
                  <select
                    className="w-full rounded-2xl border border-border bg-background px-3 py-2.5 text-sm text-foreground"
                    value={selectedRadiologistId ?? ""}
                    onChange={event => {
                      const nextValue = event.target.value;
                      setSelectedRadiologistId(nextValue ? Number(nextValue) : null);
                    }}
                    disabled={!canEditSettings}
                  >
                    <option value="">Select reporting user</option>
                    {radiologistUsers.map(user => (
                      <option key={user.id} value={user.id}>
                        {user.name || user.username}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-3">
                  <Label className="text-sm font-semibold text-foreground">Upload Signature</Label>
                  <Input
                    type="file"
                    accept="image/*"
                    className="rounded-2xl border-border bg-background"
                    disabled={!canEditSettings || selectedRadiologistId === null}
                    onChange={event => {
                      const file = event.target.files?.[0];
                      if (file) {
                        readFileAsDataUrl(file, value => {
                          setSignatureImage(value);
                          setSignaturePreview(value);
                        });
                      }
                    }}
                  />
                  {signatureLoading ? (
                    <div className="rounded-2xl border border-border p-6 text-sm text-muted-foreground">
                      Loading signature...
                    </div>
                  ) : signaturePreview ? (
                    <div className="rounded-2xl border border-border bg-muted/30 p-4">
                      <img
                        src={signaturePreview}
                        alt="Signature"
                        className="max-h-28 w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                      No signature yet.
                    </div>
                  )}
                </div>
              </div>
            </SettingsShell>
            <div className="flex justify-end">
              <Button
                className="h-10 rounded-2xl px-4 text-sm"
                onClick={handleSaveExpertise}
                disabled={expertiseSaving || !canEditSettings}
              >
                {expertiseSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="dicom-nodes">
          <div className="space-y-5">
            <SettingsShell
              icon={<RadioTower className="h-5 w-5" />}
              title="DICOM Nodes"
            >
              <div className="space-y-5">
              <div className="rounded-2xl border border-border bg-muted/30 p-4">
                <div className="space-y-4">
                  <div className="space-y-1 border-b border-border pb-4">
                    <p className="text-sm font-semibold text-foreground">
                      {editingNodeId === null ? "Add New Destination" : "Change Destination"}
                    </p>
                  </div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Name</Label>
                        <Input
                          value={nodeForm.name}
                          onChange={e => setNodeForm(prev => ({ ...prev, name: e.target.value }))}
                          className="h-10 rounded-2xl border-border bg-background text-sm"
                          placeholder="e.g. Remote PACS"
                          disabled={!canEditSettings}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">AE Title</Label>
                        <Input
                          value={nodeForm.aet}
                          onChange={e => setNodeForm(prev => ({ ...prev, aet: e.target.value }))}
                          className="h-10 rounded-2xl border-border bg-background text-sm"
                          placeholder="REMOTE_AE"
                          disabled={!canEditSettings}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Host / IP</Label>
                        <Input
                          value={nodeForm.host}
                          onChange={e => setNodeForm(prev => ({ ...prev, host: e.target.value }))}
                          className="h-10 rounded-2xl border-border bg-background text-sm"
                          placeholder="192.168.1.10"
                          disabled={!canEditSettings}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Port</Label>
                        <Input
                          value={nodeForm.port}
                          onChange={e => setNodeForm(prev => ({ ...prev, port: e.target.value }))}
                          className="h-10 rounded-2xl border-border bg-background text-sm"
                          placeholder="104"
                          disabled={!canEditSettings}
                        />
                      </div>
                      <div className="space-y-1.5 lg:col-span-2">
                        <Label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Description (optional)</Label>
                        <Input
                          value={nodeForm.description}
                          onChange={e => setNodeForm(prev => ({ ...prev, description: e.target.value }))}
                          className="h-10 rounded-2xl border-border bg-background text-sm"
                          disabled={!canEditSettings}
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={nodeForm.enabled}
                          onCheckedChange={value => setNodeForm(prev => ({ ...prev, enabled: value }))}
                          disabled={!canEditSettings}
                        />
                        <span className="text-sm text-muted-foreground">Enabled</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {editingNodeId !== null && (
                          <Button
                            variant="outline"
                            className="h-10 rounded-2xl border-border bg-background px-4 text-xs"
                            onClick={resetNodeForm}
                            disabled={nodeSaving || !canEditSettings}
                          >
                            Cancel
                          </Button>
                        )}
                        <Button
                          className="h-10 rounded-2xl px-4 text-xs"
                          onClick={handleSubmitNode}
                          disabled={nodeSaving || !canEditSettings}
                        >
                          {nodeSaving ? (
                            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                          ) : (
                            <RadioTower className="mr-2 h-3 w-3" />
                          )}
                          {editingNodeId === null ? "Add Node" : "Save Changes"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-border">
                <div className="border-b border-border bg-muted/30 px-4 py-3">
                  <p className="text-sm font-semibold text-foreground">Registered Nodes</p>
                </div>
                <div className="p-0">
                  {nodesLoading ? (
                    <p className="px-4 py-5 text-sm text-muted-foreground">Loading...</p>
                  ) : nodes.length === 0 ? (
                    <p className="px-4 py-5 text-sm text-muted-foreground">No DICOM nodes configured.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border bg-muted/20">
                            <th className="px-4 py-3 text-left font-semibold uppercase tracking-[0.14em] text-muted-foreground">Name</th>
                            <th className="px-4 py-3 text-left font-semibold uppercase tracking-[0.14em] text-muted-foreground">AE Title</th>
                            <th className="px-4 py-3 text-left font-semibold uppercase tracking-[0.14em] text-muted-foreground">Host</th>
                            <th className="px-4 py-3 text-left font-semibold uppercase tracking-[0.14em] text-muted-foreground">Port</th>
                            <th className="px-4 py-3 text-left font-semibold uppercase tracking-[0.14em] text-muted-foreground">Status</th>
                            <th className="px-4 py-3 w-36 text-right font-semibold uppercase tracking-[0.14em] text-muted-foreground">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nodes.map(node => (
                            <tr key={node.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                              <td className="px-4 py-3 text-sm font-medium text-foreground">{node.name}</td>
                              <td className="px-4 py-3 font-mono text-[11px] text-foreground">{node.aet}</td>
                              <td className="px-4 py-3 text-sm text-foreground">{node.host}</td>
                              <td className="px-4 py-3 text-sm text-foreground">{node.port}</td>
                              <td className="px-4 py-3">
                                <span
                                  className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold ${node.enabled
                                    ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                    : "border border-border bg-muted text-muted-foreground"
                                    }`}
                                >
                                  <span
                                    className={`mr-1.5 h-1.5 w-1.5 rounded-full ${node.enabled ? "bg-emerald-500" : "bg-muted-foreground"
                                      }`}
                                  />
                                  {node.enabled ? "Enabled" : "Disabled"}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-1.5">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                                        onClick={() => handleEchoTest(node)}
                                        disabled={!canEditSettings || echoTestingNodeId === node.id}
                                      >
                                        {echoTestingNodeId === node.id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Activity className="h-3 w-3" />
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Echo Test</TooltipContent>
                                  </Tooltip>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                                        onClick={() => handlePingTest(node)}
                                        disabled={!canEditSettings || pingTestingNodeId === node.id}
                                      >
                                        {pingTestingNodeId === node.id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Wifi className="h-3 w-3" />
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Ping Test</TooltipContent>
                                  </Tooltip>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                                        onClick={() => handleQueryTest(node)}
                                        disabled={!canEditSettings || queryTestingNodeId === node.id}
                                      >
                                        {queryTestingNodeId === node.id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Search className="h-3 w-3" />
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>C-FIND Query Test</TooltipContent>
                                  </Tooltip>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                                        onClick={() => handleEditNode(node)}
                                        disabled={!canEditSettings}
                                      >
                                        <Edit2 className="h-3 w-3" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Edit node</TooltipContent>
                                  </Tooltip>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-muted hover:text-destructive"
                                        onClick={() => handleDeleteNode(node.id)}
                                        disabled={!canEditSettings}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Delete node</TooltipContent>
                                  </Tooltip>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
              </div>
            </SettingsShell>
            <div className="flex justify-end">
            </div>
          </div>
        </TabsContent>

        <TabsContent value="dicom-routing">
          <Suspense fallback={<div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
            <DicomRoutingSettings nodes={nodes} canEdit={canEditSettings} />
          </Suspense>
        </TabsContent>
      </Tabs>
      {DeleteReasonDialog}
    </div>
  );
};

export default SettingsPage;
