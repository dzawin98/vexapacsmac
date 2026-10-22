import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { appUrl } from '../../config/appBase'
import { Enums } from '@cornerstonejs/core'
import {
  AlertTriangle,
  Blend,
  Blinds,
  Box,
  ChevronDown,
  ChevronUp,
  Circle,
  Compass,
  Contrast,
  Cog,
  Crosshair,
  Eye,
  FileOutput,
  FlipHorizontal2,
  FlipVertical2,
  Grid3X3,
  HeartPulse,
  Link2,
  Lasso,
  LayoutGrid,
  Loader2,
  Maximize2,
  Move,
  MoveUpLeft,
  PencilRuler,
  Plus,
  RectangleHorizontal,
  RefreshCw,
  Ruler,
  Rotate3d,
  RotateCcw,
  RotateCw,
  ScanLine,
  ScanSearch,
  Search,
  Shapes,
  Skull,
  Target,
  TextSearch,
  Type,
  X,
  ZoomIn,
} from 'lucide-react'
import { createWadoRsImageIds, getSeriesStructuredReport, getSeriesWaveform, isRenderableImageInstance, isSegmentationInstance, isVideoInstance, listInstances, listSeries, refreshInstances, registerWadoRsMetadata, retrieveDicomInstance } from '../dicomweb/client'
import type { DicomJsonDataset, InstanceSummary, SeriesSummary, StructuredReportSummary, StudySummary, WaveformSummary } from '../dicomweb/types'
import { useAuthStore, useCurrentUser } from '../auth/authStore'
import { getActiveToolPermission, getMenuItemPermission } from '../auth/permissions'
import type { PermissionId } from '../auth/permissions'
import { DicomViewport, getMenuItemHotkey, getPermittedMenuSections, isMenuItemAvailableForModality, toHotkey, viewportMenuSections, type ViewportMenuAction } from './components/DicomViewport'
import { DicomVideoViewport } from './components/DicomVideoViewport'
import { Bone3DViewer } from './components/Bone3DViewer'
import { EcgWaveformViewport } from './components/EcgWaveformViewport'
import { LocalProxyMprViewer } from './components/LocalProxyMprViewer'
import { MprViewer } from './components/MprViewer'
import { ServerMprViewer } from './components/ServerMprViewer'
import { StructuredReportViewport } from './components/StructuredReportViewport'
import { TileFormatViewport } from './components/TileFormatViewport'
import { getTileFormatLabel, isTileFormatActive, tileFormatOptions, type TileFormat } from './components/tileFormat'
import { onWebGlContextLost } from './cornerstone/webglContextWatch'
import { useViewerStore } from './viewerStore'
import type { ViewportLayout } from './viewerStore'
import { getViewerOverlayLayout, type ViewerOverlayConfig } from './overlayConfig'
import { StudyHeaderBrowser } from '../studies/StudyList'
import { getStackInitialImageIndex, prewarmStackNeighbors, primeStackImagesForDisplay } from './cornerstone/progressiveLoading'
import { readIchSegmentationDescriptor } from './ichDicom'
import { renderSecondaryCaptureCanvas, saveViewportCaptureSeries, type ViewportCaptureSource } from './dicomSave'
import { ExportCenterDialog } from './components/ExportCenterDialog'
import {
  canvasToBlob,
  copyCanvasToClipboard,
  createA4JpegCanvas,
  createPdfBlob,
  createPdfPreviewBlob,
  downloadBlob,
  exportStillImages,
  makeExportPreview,
  parseExportPageSelection,
  renderCanvasSequenceToVideo,
  sanitizeExportFileName,
  sendDicomPrint,
  transcodeVideo,
  type CanvasExportItem,
  type PdfTextOverlay,
  type ViewerExportRequest,
  type ViewerExportResult,
} from './exportCenter'
import { queueCaptureForReport } from './reportAttachments'

const measurementTools = [
  { id: 'Length', label: 'Length', icon: Ruler },
  { id: 'Probe', label: 'Probe', icon: Target },
  { id: 'TextMarker', label: 'Text', icon: Type },
  { id: 'ArrowMarker', label: 'Arrow', icon: MoveUpLeft },
  { id: 'CircleMarker', label: 'Circle', icon: Circle },
  { id: 'CTR4Point', label: 'CTR 4 Point', icon: HeartPulse },
  { id: 'Angle', label: 'Angle', icon: Compass },
  { id: 'CobbAngle', label: 'Cobb Angle', icon: Maximize2 },
  { id: 'Bidirectional', label: 'Bidirectional', icon: PencilRuler },
  { id: 'CircleROI', label: 'Circle ROI', icon: Circle },
  { id: 'RectangleROI', label: 'Rectangle ROI', icon: RectangleHorizontal },
  { id: 'EllipticalROI', label: 'Ellipse ROI', icon: Circle },
  { id: 'PlanarFreehandROI', label: 'Freehand ROI', icon: Lasso },
  { id: 'ICHSegment', label: 'ICH Segment', icon: ScanSearch },
]

function createDiagnosticStackImageIds(_series: SeriesSummary, instances: InstanceSummary[]) {
  return createWadoRsImageIds(instances)
}

const utilityTools = [
  { id: 'ReferenceLines', label: 'Reference Line', icon: ScanLine },
]

const utilityToolbarFavoriteOptions = [
  ...utilityTools.map((tool) => ({ ...tool, favoriteId: `utility-item:${tool.id}` })),
  { id: 'ImageOverlay', label: 'Image Overlay', icon: Eye, favoriteId: 'utility-item:ImageOverlay' },
  { id: 'Invert', label: 'Invert', icon: Circle, favoriteId: 'utility-item:Invert' },
  { id: 'TagBrowser', label: 'DICOM Tag Browser', icon: TextSearch, favoriteId: 'utility-item:TagBrowser' },
]

const toolbarGroupFavoriteOptions = [
  ...viewportMenuSections.map((section) => ({
    id: `context-group:${section.title}`,
    label: section.title,
    icon: section.icon,
  })),
  { id: 'intellilink', label: 'IntelliLink', icon: Link2 },
]

const toolbarItemFavoriteOptions = viewportMenuSections.flatMap((section) => section.items
  .filter((item) => item.action.type !== 'close')
  .map((item) => ({
    ...item,
    favoriteId: `context-item:${item.id}`,
    sectionTitle: section.title,
  })))

type ToolbarFavoriteId = string

const defaultToolbarFavorites: ToolbarFavoriteId[] = toolbarGroupFavoriteOptions.map((tool) => tool.id)
const toolbarFavoriteAliases = new Map([
  ['context-group:Left mouse actions', 'context-group:Image Navigation'],
  ['context-group:Zoom', 'context-group:Image Navigation'],
  ['context-group:Measure', 'context-group:Measurements'],
  ['context-group:Draw', 'context-group:Annotations'],
  ['context-group:Preset', 'context-group:Window Presets'],
])

type ViewerAppearance = {
  showToolbar: boolean
  contextMenuEnabled: boolean
  browserPosition: 'top' | 'below-toolbar' | 'bottom'
}

type ViewerPreferences = {
  toolbarFavorites?: ToolbarFavoriteId[]
  viewerAppearance?: Partial<ViewerAppearance>
  hotkeyOverrides?: Record<string, string>
  customWindowPresets?: CustomWindowPreset[]
}

type CustomWindowPreset = {
  id: string
  name: string
  windowWidth: number
  windowLevel: number
}

const defaultViewerAppearance: ViewerAppearance = {
  showToolbar: true,
  contextMenuEnabled: true,
  browserPosition: 'top',
}

const customWindowPresetStoragePrefix = 'vexa.viewer.customWindowPresets'

const spatialTools = [
  { id: 'spatial-flip-horizontal', label: 'Horizontal Flip', icon: FlipHorizontal2 },
  { id: 'spatial-flip-vertical', label: 'Vertical Flip', icon: FlipVertical2 },
  { id: 'spatial-rotate-cw', label: 'Rotate Clockwise 90', icon: RotateCw },
  { id: 'spatial-rotate-ccw', label: 'Rotate Counter-clockwise 90', icon: RotateCcw },
  { id: 'spatial-rotate-180', label: 'Rotate 180', icon: RefreshCw },
  { id: 'spatial-magnify', label: 'Magnifying Glass', icon: Search },
  { id: 'spatial-zoom-1x', label: 'Zoom to 1x', icon: ScanSearch },
  { id: 'spatial-zoom-fit', label: 'Zoom to Fit', icon: Maximize2, featured: true },
  { id: 'spatial-zoom-input', label: 'Zoom Input', icon: ZoomIn },
  { id: 'spatial-manual-shutter', label: 'Manual Shutter', icon: RectangleHorizontal, disabled: true },
  { id: 'spatial-horizontal-shutter', label: 'Horizontal Shutter', icon: RectangleHorizontal, disabled: true },
  { id: 'spatial-shutter-without-zoom', label: 'Shutter without Zoom', icon: RectangleHorizontal, disabled: true },
] as const

const measurementToolbarFavoriteOptions = measurementTools.map((tool) => ({
  ...tool,
  favoriteId: `measure-item:${tool.id}`,
}))

const spatialToolbarFavoriteOptions = spatialTools
  .filter((tool) => !('disabled' in tool && tool.disabled))
  .map((tool) => ({ ...tool, favoriteId: `spatial-item:${tool.id}` }))

const viewportKeysByLayout = {
  '1x1': ['0'],
  '1x2': ['0', '1'],
  '2x1': ['0', '1'],
  '1x3': ['0', '1', '2'],
  '3x1': ['0', '1', '2'],
  '2x2': ['0', '1', '2', '3'],
  '2x3': ['0', '1', '2', '3', '4', '5'],
  '3x2': ['0', '1', '2', '3', '4', '5'],
  '3x3': ['0', '1', '2', '3', '4', '5', '6', '7', '8'],
} as const

const layoutOptions: { id: ViewportLayout; label: string }[] = [
  { id: '1x1', label: '1 x 1' },
  { id: '1x2', label: '1 x 2' },
  { id: '2x1', label: '2 x 1' },
  { id: '1x3', label: '1 x 3' },
  { id: '3x1', label: '3 x 1' },
  { id: '2x2', label: '2 x 2' },
  { id: '2x3', label: '2 x 3' },
  { id: '3x2', label: '3 x 2' },
  { id: '3x3', label: '3 x 3' },
]

function getCustomWindowPresetStorageKey(user: { id?: string; username?: string } | null | undefined) {
  const userKey = user?.id || user?.username || 'anonymous'
  return `${customWindowPresetStoragePrefix}:${userKey}`
}

function loadCustomWindowPresets(storageKey: string): CustomWindowPreset[] {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return sanitizeCustomWindowPresets(parsed)
  } catch {
    return []
  }
}

function saveCustomWindowPresets(storageKey: string, presets: CustomWindowPreset[]) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(presets))
  } catch {
    // Viewer presets are a convenience feature; local storage failures should not block diagnosis.
  }
}

function serializeViewerPreferences(
  toolbarFavorites: ToolbarFavoriteId[],
  viewerAppearance: ViewerAppearance,
  hotkeyOverrides: Record<string, string>,
  customWindowPresets: CustomWindowPreset[],
) {
  return JSON.stringify({ toolbarFavorites, viewerAppearance, hotkeyOverrides, customWindowPresets })
}

function sanitizeCustomWindowPresets(value: unknown): CustomWindowPreset[] {
  if (!Array.isArray(value)) {
    return []
  }

  const presets = value
    .map((item): CustomWindowPreset | null => {
      const preset = item as Partial<CustomWindowPreset> | null | undefined
      const name = typeof preset?.name === 'string' ? preset.name.trim().slice(0, 48) : ''
      const windowWidth = Math.round(Number(preset?.windowWidth))
      const windowLevel = Math.round(Number(preset?.windowLevel))
      const fallbackId = name ? `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''
      const id = typeof preset?.id === 'string' && preset.id ? preset.id.slice(0, 80) : fallbackId
      if (!id || !name || !Number.isFinite(windowWidth) || !Number.isFinite(windowLevel) || windowWidth <= 0) return null
      return { id, name, windowWidth, windowLevel }
    })
    .filter((item): item is CustomWindowPreset => Boolean(item))

  return Array.from(new Map(presets.map((preset) => [preset.name.toLowerCase(), preset])).values())
    .slice(0, 40)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function parseWindowLevelInputs(windowWidthValue: string, windowLevelValue: string) {
  const windowWidth = Number(windowWidthValue)
  const windowLevel = Number(windowLevelValue)
  if (!Number.isFinite(windowWidth) || !Number.isFinite(windowLevel) || windowWidth <= 0) {
    return null
  }
  return { windowWidth, windowLevel }
}

type ViewportWaveform = {
  series: SeriesSummary
  waveform: WaveformSummary
}

type ViewportVideo = {
  series: SeriesSummary
  instance: InstanceSummary
}

type ViewportReport = {
  series: SeriesSummary
  report: StructuredReportSummary
}

type ViewportSavedObject = {
  series: SeriesSummary
  title: string
  description: string
  status: string
}

type ViewportIchSegmentation = {
  series: SeriesSummary
  instance: InstanceSummary
  arrayBuffer: ArrayBuffer
}

type ViewportCaptureTarget = {
  id: string
  viewportKey: string
  label: string
  element: HTMLElement
  series: SeriesSummary | null
  instance: InstanceSummary | null
  imageCount: number
}

type ViewerExportDialogMode = 'export' | 'capture'

export function ViewerShell({ deepLinkMode = false }: { deepLinkMode?: boolean } = {}) {
  const [searchParams] = useSearchParams()
  const serverRenderMode = searchParams.get('renderMode') === 'server'
  const diagnosticViewerMode = serverRenderMode
    || document.querySelector<HTMLMetaElement>('meta[name="vexa-viewer-mode"]')?.content === 'diagnostic'
  const mprEngineMode = searchParams.get('mprEngine')
  const serverMprMode = mprEngineMode === 'server'
  const proxyMprMode = mprEngineMode === 'proxy'
  const activeStudy = useViewerStore((state) => state.activeStudy)
  const activeSeries = useViewerStore((state) => state.activeSeries)
  const setActiveStudy = useViewerStore((state) => state.setActiveStudy)
  const setActiveSeries = useViewerStore((state) => state.setActiveSeries)
  const setInstances = useViewerStore((state) => state.setInstances)
  const activeTool = useViewerStore((state) => state.activeTool)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const hotkeyOverrides = useViewerStore((state) => state.hotkeyOverrides)
  const setHotkeyOverrides = useViewerStore((state) => state.setHotkeyOverrides)
  const referenceLinesEnabled = useViewerStore((state) => state.referenceLinesEnabled)
  const setReferenceLinesEnabled = useViewerStore((state) => state.setReferenceLinesEnabled)
  const viewportLayout = useViewerStore((state) => state.viewportLayout)
  const setViewportLayout = useViewerStore((state) => state.setViewportLayout)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const activeSeriesTargetViewportKey = useViewerStore((state) => state.activeSeriesTargetViewportKey)
  const activeSeriesBatch = useViewerStore((state) => state.activeSeriesBatch)
  const setSelectedViewportKey = useViewerStore((state) => state.setSelectedViewportKey)
  const viewportStacks = useViewerStore((state) => state.viewportStacks)
  const viewportZooms = useViewerStore((state) => state.viewportZooms)
  const viewportSliceIndexes = useViewerStore((state) => state.viewportSliceIndexes)
  const viewportWindowLevels = useViewerStore((state) => state.viewportWindowLevels)
  const mprViewportKeys = useViewerStore((state) => state.mprViewportKeys)
  const setViewportStack = useViewerStore((state) => state.setViewportStack)
  const refreshViewportStackInstances = useViewerStore((state) => state.refreshViewportStackInstances)
  const setViewportSliceIndex = useViewerStore((state) => state.setViewportSliceIndex)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const loadingMessage = useViewerStore((state) => state.loadingMessage)
  const errorMessage = useViewerStore((state) => state.errorMessage)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const viewerOverlayConfig = useAuthStore((state) => state.viewerOverlayConfig)
  const currentUser = useCurrentUser()
  const mprMode = useViewerStore((state) => state.mprMode)
  const setMprMode = useViewerStore((state) => state.setMprMode)
  const ichMprViewportKeys = useViewerStore((state) => state.ichMprViewportKeys)
  const setIchMprWorkspace = useViewerStore((state) => state.setIchMprWorkspace)
  const intelliLink = useViewerStore((state) => state.intelliLink)
  const setIntelliLinkOption = useViewerStore((state) => state.setIntelliLinkOption)
  const setAllIntelliLinkOptions = useViewerStore((state) => state.setAllIntelliLinkOptions)
  const [viewportWaveforms, setViewportWaveforms] = useState<Record<string, ViewportWaveform>>({})
  const [viewportVideos, setViewportVideos] = useState<Record<string, ViewportVideo>>({})
  const [viewportReports, setViewportReports] = useState<Record<string, ViewportReport>>({})
  const [viewportSavedObjects, setViewportSavedObjects] = useState<Record<string, ViewportSavedObject>>({})
  const [viewportIchSegmentations, setViewportIchSegmentations] = useState<Record<string, ViewportIchSegmentation>>({})
  const [isTagBrowserOpen, setIsTagBrowserOpen] = useState(false)
  const [isAmbientTestOpen, setIsAmbientTestOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [toolbarFavorites, setToolbarFavorites] = useState<ToolbarFavoriteId[]>(defaultToolbarFavorites)
  const [viewerAppearance, setViewerAppearance] = useState<ViewerAppearance>(loadViewerAppearance)
  const [showOverlay, setShowOverlay] = useState(true)
  const [tileFormatsByViewport, setTileFormatsByViewport] = useState<Record<string, TileFormat>>({})
  const [volume3dViewport, setVolume3dViewport] = useState<{ key: string; series: SeriesSummary; mode: 'oblique' | 'bone' } | null>(null)
  const [fullscreenViewportKey, setFullscreenViewportKey] = useState<string | null>(null)
  const [seriesBrowserCollapsed, setSeriesBrowserCollapsed] = useState(false)
  const [, setReadyViewportSeries] = useState<Record<string, string>>({})
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [dropdownAnchor, setDropdownAnchor] = useState<{ left: number; top: number } | null>(null)
  const customPresetStorageKey = getCustomWindowPresetStorageKey(currentUser)
  const [customWindowPresets, setCustomWindowPresets] = useState<CustomWindowPreset[]>(() => loadCustomWindowPresets(customPresetStorageKey))
  const [customPresetName, setCustomPresetName] = useState('')
  const [customPresetSaveDialogOpen, setCustomPresetSaveDialogOpen] = useState(false)
  const [customPresetWw, setCustomPresetWw] = useState('')
  const [customPresetWl, setCustomPresetWl] = useState('')
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [exportTargets, setExportTargets] = useState<ViewportCaptureTarget[]>([])
  const [exportPreferredTargetId, setExportPreferredTargetId] = useState('')
  const [exportInitialTargetIds, setExportInitialTargetIds] = useState<string[]>([])
  const [printSelectedViewportKeys, setPrintSelectedViewportKeys] = useState<string[]>(() => [selectedViewportKey])
  const [exportDialogMode, setExportDialogMode] = useState<ViewerExportDialogMode>('export')
  const [exportDialogSession, setExportDialogSession] = useState(0)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportStatus, setExportStatus] = useState<{ type: 'idle' | 'error' | 'success'; message: string }>({ type: 'idle', message: '' })
  const ribbonRef = useRef<HTMLDivElement>(null)
  const preferencesHydratedRef = useRef(false)
  const preferencesSnapshotRef = useRef('')
  const preferencesSaveTimerRef = useRef<number | null>(null)
  const transientErrorTimerRef = useRef<number | null>(null)
  const technicalMetadataRefreshesRef = useRef(new Set<string>())
  const exportPreviewGenerationRef = useRef(0)
  const exportCaptureQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const exportPreviewCaptureCacheRef = useRef(new Map<string, Array<ViewportCaptureSource & { textOverlay?: PdfTextOverlay }>>())
  const viewportSelectionPointerRef = useRef<{ viewportKey: string; clientX: number; clientY: number; additive: boolean } | null>(null)
  const viewportKeys = viewportKeysByLayout[viewportLayout]
  const selectedStack = viewportStacks[selectedViewportKey]
  const selectedTileFormat = tileFormatsByViewport[selectedViewportKey] ?? '1'
  const selectedWaveform = viewportWaveforms[selectedViewportKey]
  const selectedVideo = viewportVideos[selectedViewportKey]
  const selectedReport = viewportReports[selectedViewportKey]
  const selectedModality = selectedWaveform?.series.modality || selectedVideo?.series.modality || selectedReport?.series.modality || selectedStack?.series.modality || activeSeries?.modality || ''
  const modalityUpper = selectedModality.toUpperCase()
  const showPreset = modalityUpper === 'CT'
  const isCtSeries = modalityUpper === 'CT'
  const isMprSeries = isCtSeries || modalityUpper === 'MR'
  const showMprButton = Boolean(activeSeries) && isMprSeries
  const show3dButton = Boolean(activeSeries) && isCtSeries
  const volume3dMode = Boolean(volume3dViewport)
  const hasIntelliLink = Object.values(intelliLink).some(Boolean)
  const canUseIntelliLink = (selectedStack?.imageIds.length ?? 0) > 1
  const canUseTileFormat = Boolean(
    selectedStack?.instances.length && selectedStack.instances.length > 1
    && !mprViewportKeys[selectedViewportKey]
    && volume3dViewport?.key !== selectedViewportKey,
  )
  const isToolbarFavorite = (toolId: ToolbarFavoriteId) => toolbarFavorites.includes(toolId)
  const permittedMenuSections = getPermittedMenuSections(hasPermission, modalityUpper)
  const favoriteToolbarItems = toolbarItemFavoriteOptions.filter((tool) => (
    isToolbarFavorite(tool.favoriteId)
    && hasPermission(getMenuItemPermission(tool.id))
    && isMenuItemAvailableForModality(tool.id, modalityUpper)
  ))
  const groupedToolbarSections = permittedMenuSections.map((section) => ({
    ...section,
    items: section.items.filter((item) => !isToolbarFavorite(`context-item:${item.id}`)),
  }))
  const activeUtilityTool = referenceLinesEnabled
      ? utilityTools[0]
      : utilityTools.find((tool) => tool.id === activeTool)
  const UtilityIcon = activeUtilityTool?.icon ?? Shapes
  const favoriteMeasurementTools = measurementToolbarFavoriteOptions.filter((tool) => isToolbarFavorite(tool.favoriteId))
  const groupedMeasurementTools = measurementTools.filter((tool) => !isToolbarFavorite(`measure-item:${tool.id}`))
  const groupedActiveMeasurementTool = groupedMeasurementTools.find((tool) => tool.id === activeTool)
  const favoriteSpatialTools = spatialToolbarFavoriteOptions.filter((tool) => isToolbarFavorite(tool.favoriteId))
  const groupedSpatialTools = spatialTools.filter((tool) => !isToolbarFavorite(`spatial-item:${tool.id}`))
  const favoriteUtilityTools = utilityToolbarFavoriteOptions.filter((tool) => isToolbarFavorite(tool.favoriteId))
  const groupedUtilityTools = utilityToolbarFavoriteOptions.filter((tool) => !isToolbarFavorite(tool.favoriteId))
  const MeasurementIcon = groupedActiveMeasurementTool?.icon ?? Ruler

  const clearTransientErrorTimer = useCallback(() => {
    if (transientErrorTimerRef.current !== null) {
      window.clearTimeout(transientErrorTimerRef.current)
      transientErrorTimerRef.current = null
    }
  }, [])

  const showTransientError = useCallback((message: string) => {
    clearTransientErrorTimer()
    setErrorMessage(message)
    transientErrorTimerRef.current = window.setTimeout(() => {
      transientErrorTimerRef.current = null
      setErrorMessage('')
    }, 3_500)
  }, [clearTransientErrorTimer, setErrorMessage])

  // A dropped WebGL context cannot be restored in place — Chrome does not fire
  // webglcontextrestored for an evicted context, so the tile keeps reporting a
  // successful render while showing nothing. Surface it instead of going blank.
  useEffect(() => onWebGlContextLost((info) => {
    clearTransientErrorTimer()
    // Only losses on an actual RenderingEngine canvas reach this listener; the
    // context budget is reported so the message does not blame "other viewer
    // tabs" when the page's own engine pools are what filled the quota.
    const budget = info.requestedContexts > 0
      ? ` This viewer requests ${info.requestedContexts} of the browser's ~${info.contextQuota} GPU contexts (${info.engineCount} engines x ${info.contextsPerEngine}).`
      : ''
    setErrorMessage(info.reason === 'gpu-quota'
      ? `The browser dropped a viewport's graphics context: the page hit its GPU context limit.${budget} Reload to restore the image tiles.`
      : `A viewport lost its graphics context. Reload to restore the image tiles.`)
  }), [clearTransientErrorTimer, setErrorMessage])

  const openExportCenter = useCallback((
    preferredViewportKey = selectedViewportKey,
    mode: ViewerExportDialogMode = 'export',
    preferredCaptureViewportId?: string,
  ) => {
    exportPreviewGenerationRef.current += 1
    exportPreviewCaptureCacheRef.current.clear()
    if (mode === 'export' && !hasPermission('viewer.export.use')) {
      showTransientError('This role is not authorized to export viewer content.')
      return
    }

    const viewportTiles = Array.from(document.querySelectorAll<HTMLElement>('.viewport-tile[data-viewport-key]'))
    const targets: ViewportCaptureTarget[] = []

    viewportKeys.forEach((viewportKey, viewportIndex) => {
      const tile = viewportTiles.find((item) => item.dataset.viewportKey === viewportKey)
      if (!tile || !isCaptureElementVisible(tile)) {
        return
      }

      const stack = viewportStacks[viewportKey]
      const sourceIndex = clampIndex(viewportSliceIndexes[viewportKey] ?? 0, stack?.instances.length ?? 0)
      const sourceInstance = stack?.instances[sourceIndex] ?? stack?.instances[0] ?? null
      const mprTargets = Array.from(tile.querySelectorAll<HTMLElement>('.mpr-viewport-tile[data-capture-viewport-id]'))
        .filter((element) => isCaptureElementVisible(element) && hasCaptureCanvas(element))
      const elements = mprTargets.length > 0 ? mprTargets : (hasCaptureCanvas(tile) ? [tile] : [])

      elements.forEach((element, elementIndex) => {
        const planeLabel = element.dataset.captureLabel?.trim()
        const sourceLabel = stack?.series.seriesDescription?.trim() || stack?.series.modality || 'DICOM'
        const label = mprTargets.length > 0
          ? `Viewport ${viewportIndex + 1} - ${planeLabel || `MPR ${elementIndex + 1}`}`
          : `Viewport ${viewportIndex + 1} - ${sourceLabel}`
        targets.push({
          id: mprTargets.length > 0
            ? `${viewportKey}:${element.dataset.captureViewportId || elementIndex}`
            : viewportKey,
          viewportKey,
          label,
          element,
          series: stack?.series ?? null,
          instance: sourceInstance,
          imageCount: mprTargets.length > 0 ? 1 : stack?.instances.length ?? 0,
        })
      })
    })

    if (!targets.length) {
      showTransientError('No image viewport is ready for export.')
      return
    }

    const activeMprViewportId = preferredCaptureViewportId
      || useViewerStore.getState().mprActiveViewportIds[preferredViewportKey]
    const exactPreferredTargetId = activeMprViewportId
      ? `${preferredViewportKey}:${activeMprViewportId}`
      : preferredViewportKey
    let preferredIndex = targets.findIndex((target) => target.id === exactPreferredTargetId)
    if (preferredIndex < 0) {
      preferredIndex = targets.findIndex((target) => target.viewportKey === preferredViewportKey)
    }
    if (preferredIndex > 0) {
      targets.unshift(targets.splice(preferredIndex, 1)[0])
    }
    const canvasSelectedTargetIds = mode === 'export'
      ? printSelectedViewportKeys.flatMap((viewportKey) => targets
        .filter((target) => target.viewportKey === viewportKey)
        .map((target) => target.id))
      : []
    const initialTargetIds = canvasSelectedTargetIds.length > 0
      ? canvasSelectedTargetIds
      : targets[0]?.id ? [targets[0].id] : []
    setExportPreferredTargetId(initialTargetIds[0] ?? targets[0]?.id ?? '')
    setExportInitialTargetIds(initialTargetIds)
    setExportTargets(targets)
    setExportDialogMode(mode)
    setExportStatus({ type: 'idle', message: '' })
    setExportDialogSession((session) => session + 1)
    setExportDialogOpen(true)
    setOpenMenu(null)
  }, [hasPermission, printSelectedViewportKeys, selectedViewportKey, showTransientError, viewportKeys, viewportSliceIndexes, viewportStacks])

  useEffect(() => {
    const handleOpenCapture = (event: Event) => {
      const detail = (event as CustomEvent<{ viewportKey?: string; captureViewportId?: string }>).detail
      openExportCenter(detail?.viewportKey || selectedViewportKey, 'capture', detail?.captureViewportId)
    }
    window.addEventListener('vexa-viewer-open-viewport-capture', handleOpenCapture)
    return () => window.removeEventListener('vexa-viewer-open-viewport-capture', handleOpenCapture)
  }, [openExportCenter, selectedViewportKey])

  async function executeViewerExport(request: ViewerExportRequest): Promise<ViewerExportResult> {
    if (exportBusy) return { message: '' }
    const previewGeneration = ++exportPreviewGenerationRef.current
    if (exportDialogMode === 'export' && !hasPermission('viewer.export.use')) {
      const message = 'This role is not authorized to export viewer content.'
      setExportStatus({ type: 'error', message })
      return { message }
    }
    const selectedTargets = request.targetIds
      .map((targetId) => exportTargets.find((target) => target.id === targetId))
      .filter((target): target is ViewportCaptureTarget => Boolean(target))
    const targets = request.scope === 'viewports' || request.scope === 'custom' ? selectedTargets : selectedTargets.slice(0, 1)
    if (!targets.length) {
      const message = 'Select at least one viewport.'
      setExportStatus({ type: 'error', message })
      return { message }
    }
    if (request.format === 'dicom' && !activeStudy?.studyInstanceUid) {
      const message = 'The active study is not ready to receive DICOM Secondary Capture objects.'
      setExportStatus({ type: 'error', message })
      return { message }
    }

    if (!request.livePreview) {
      setExportBusy(true)
      setExportStatus({
        type: 'idle',
        message: request.format === 'dicom-print' ? 'Preparing DICOM Print...' : 'Preparing export...',
      })
      setErrorMessage('')
    }
    try {
      const safeName = sanitizeExportFileName(request.fileName)
      const captureBatch = async (batchRequest: ViewerExportRequest) => {
        const captureTask = exportCaptureQueueRef.current
          .catch(() => undefined)
          .then(() => captureViewportExports(
            batchRequest,
            targets,
            () => Boolean(batchRequest.livePreview && previewGeneration !== exportPreviewGenerationRef.current),
          ))
        exportCaptureQueueRef.current = captureTask
        return captureTask
      }
      const captureWithPreviewCache = async (batchRequest: ViewerExportRequest) => {
        if (!batchRequest.livePreview || (batchRequest.format !== 'pdf' && batchRequest.format !== 'dicom-print')) {
          return captureBatch(batchRequest)
        }
        const cacheKey = JSON.stringify({
          format: batchRequest.format,
          scope: batchRequest.scope,
          targetIds: batchRequest.targetIds,
          selectedPages: batchRequest.selectedPages,
          targetPageSelections: batchRequest.targetPageSelections,
          previewItemOffset: batchRequest.previewItemOffset,
          previewItemLimit: batchRequest.previewItemLimit,
          render: batchRequest.render,
        })
        const cache = exportPreviewCaptureCacheRef.current
        const cached = cache.get(cacheKey)
        if (cached) {
          cache.delete(cacheKey)
          cache.set(cacheKey, cached)
          return cached
        }
        const captures = await captureBatch(batchRequest)
        if (previewGeneration === exportPreviewGenerationRef.current && captures.length > 0) {
          cache.set(cacheKey, captures)
          while (cache.size > 2) cache.delete(cache.keys().next().value as string)
        }
        return captures
      }

      if (request.format === 'dicom-print' && request.intent === 'export') {
        if (!request.dicomPrint?.printerId || !request.dicomPrint.filmSizeId) throw new Error('Select a printer and film size.')
        const totalItems = Math.max(0, Math.floor(request.selectedItemCount || 0))
        const filmCapacity = Math.max(1, Math.floor(request.dicomPrint.filmCapacity || 1))
        const filmCount = Math.ceil(totalItems / filmCapacity)
        if (filmCount === 0) throw new Error('No images are selected for DICOM Print.')

        const jobIds: string[] = []
        for (let filmIndex = 0; filmIndex < filmCount; filmIndex += 1) {
          const preparingMessage = `Preparing film ${filmIndex + 1} of ${filmCount}...`
          setLoadingMessage(preparingMessage)
          setExportStatus({ type: 'idle', message: preparingMessage })
          const filmCaptures = await captureBatch({
            ...request,
            previewItemOffset: filmIndex * filmCapacity,
            previewItemLimit: filmCapacity,
          })
          const filmItems: CanvasExportItem[] = filmCaptures.map((capture) => ({
            canvas: capture.canvas,
            label: capture.label,
            textOverlay: capture.textOverlay,
          }))
          const filmImage = await createPdfPreviewBlob(filmItems, {
            orientation: request.orientation,
            tileLayout: request.tileLayout,
            identity: request.dicomPrint.includeFooter === false ? undefined : request.dicomPrint.identity,
            filmSizeId: request.dicomPrint.filmSizeId,
            imageScalePercent: request.dicomPrint.imageScalePercent,
            imageTransforms: request.dicomPrint.imageTransforms,
            itemIndexOffset: filmIndex * filmCapacity,
            includeTextOverlay: request.render.includeTextOverlay,
          })
          const sendingMessage = `Sending film ${filmIndex + 1} of ${filmCount} to printer...`
          setLoadingMessage(sendingMessage)
          setExportStatus({ type: 'idle', message: sendingMessage })
          try {
            const job = await sendDicomPrint(filmImage.blob, `${safeName}-film-${filmIndex + 1}`, request.dicomPrint, request.orientation)
            if (job.jobId) jobIds.push(job.jobId)
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'Unknown printer error.'
            throw new Error(`Film ${filmIndex + 1} of ${filmCount} failed. ${filmIndex} film${filmIndex === 1 ? '' : 's'} had already been submitted. ${reason}`)
          }
        }

        const message = `${filmCount} DICOM film${filmCount === 1 ? '' : 's'} submitted successfully${jobIds.length ? ` (${jobIds.length} job ID${jobIds.length === 1 ? '' : 's'})` : ''}.`
        setExportStatus({ type: 'success', message })
        return { message }
      }

      const captures = await captureWithPreviewCache(request)
      if (request.livePreview && previewGeneration !== exportPreviewGenerationRef.current) {
        return { message: '' }
      }
      const items: CanvasExportItem[] = captures.map((capture) => ({
        canvas: capture.canvas,
        label: capture.label,
        textOverlay: capture.textOverlay,
      }))

      if (request.format === 'dicom') {
        setLoadingMessage(`Sending ${captures.length} DICOM capture${captures.length > 1 ? 's' : ''} to PACS...`)
        const savedSeries = await saveViewportCaptureSeries({
          study: activeStudy,
          seriesDescription: request.seriesName,
          captures,
        })
        if (request.sendToReport) {
          queueCaptureForReport({
            studyInstanceUid: activeStudy!.studyInstanceUid,
            seriesInstanceUid: savedSeries.seriesInstanceUid,
            sourceSeriesInstanceUid: captures[0]?.series?.seriesInstanceUid || '',
            title: request.seriesName.trim(),
            instanceCount: captures.length,
          })
        }
        const message = `${captures.length} capture${captures.length === 1 ? '' : 's'} saved as series ${request.seriesName.trim()}${request.sendToReport ? ' and added to the reporting queue.' : '.'}`
        setExportStatus({ type: 'success', message })
        return { message }
      }

      if (request.format === 'png' || request.format === 'jpeg') {
        if (request.intent === 'preview') {
          if (!items.length) throw new Error('No images are available for preview.')
          const mimeType = request.format === 'png' ? 'image/png' : 'image/jpeg'
          const previewImage = await canvasToBlob(items[0].canvas, mimeType, request.quality)
          const message = items.length > 1
            ? `${request.format.toUpperCase()} preview ready (showing the first of ${items.length} pages).`
            : `${request.format.toUpperCase()} preview ready.`
          if (!request.livePreview) setExportStatus({ type: 'success', message })
          const totalItems = Math.max(items.length, request.previewTotalItems ?? items.length)
          const pageIndex = Math.max(0, request.previewPageIndex ?? 0)
          const pageCount = Math.max(1, request.previewPageCount ?? totalItems)
          const caption = totalItems > 1
            ? `${request.format.toUpperCase()} Preview · Image ${pageIndex + 1} of ${totalItems}`
            : `${request.format.toUpperCase()} Preview · 1 image`
          return { message, preview: makeExportPreview(previewImage, 'image', caption, pageIndex, pageCount) }
        }
        if (request.intent === 'copy') {
          if (items.length !== 1) throw new Error('Copy to Clipboard is available for one current image only.')
          await copyCanvasToClipboard(items[0].canvas)
          const message = 'Viewport image copied to the clipboard.'
          setExportStatus({ type: 'success', message })
          return { message }
        }
        const result = await exportStillImages(items, request.format, safeName, request.quality)
        const message = result.archive
          ? `${result.count} images exported in a ZIP archive.`
          : `${request.format.toUpperCase()} image exported.`
        setExportStatus({ type: 'success', message })
        return { message }
      }

      if (request.format === 'pdf' || request.format === 'dicom-print') {
        const pdf = request.format === 'pdf' ? await createPdfBlob(items, {
          orientation: request.orientation,
          tileLayout: request.tileLayout,
          quality: request.quality,
          imageTransforms: request.pdfImages,
        }) : null
        if (request.format === 'dicom-print') {
          if (request.intent === 'preview') {
            const previewOptions = {
              orientation: request.orientation,
              tileLayout: request.tileLayout,
              identity: request.dicomPrint?.includeFooter === false ? undefined : request.dicomPrint?.identity,
              filmSizeId: request.dicomPrint?.filmSizeId,
              imageScalePercent: request.dicomPrint?.imageScalePercent,
              imageTransforms: request.dicomPrint?.imageTransforms,
              itemIndexOffset: request.previewItemOffset,
              includeTextOverlay: request.render.includeTextOverlay,
            }
            const [previewImage, alternateFooterPreviewImage] = await Promise.all([
              createPdfPreviewBlob(items, previewOptions),
              request.dicomPrint?.identity
                ? createPdfPreviewBlob(items, {
                  ...previewOptions,
                  identity: request.dicomPrint.includeFooter === false ? request.dicomPrint.identity : undefined,
                })
                : Promise.resolve(null),
            ])
            const totalItems = Math.max(items.length, request.previewTotalItems ?? items.length)
            const pageIndex = Math.max(0, request.previewPageIndex ?? 0)
            const pageCount = Math.max(1, request.previewPageCount ?? 1)
            const caption = `Film Preview · Film ${pageIndex + 1} of ${pageCount} · ${totalItems} image${totalItems === 1 ? '' : 's'}`
            const preview = makeExportPreview(previewImage.blob, 'image', caption, pageIndex, pageCount, {
              columns: previewImage.layout.columns,
              rows: previewImage.layout.rows,
              itemOffset: request.previewItemOffset ?? 0,
              itemCount: items.length,
            })
            const alternatePreview = alternateFooterPreviewImage
              ? makeExportPreview(alternateFooterPreviewImage.blob, 'image', caption, pageIndex, pageCount, {
                  columns: alternateFooterPreviewImage.layout.columns,
                  rows: alternateFooterPreviewImage.layout.rows,
                  itemOffset: request.previewItemOffset ?? 0,
                  itemCount: items.length,
                })
              : undefined
            const previewVariants = alternatePreview
              ? request.dicomPrint?.includeFooter === false
                ? { filmFooterOn: alternatePreview, filmFooterOff: preview }
                : { filmFooterOn: preview, filmFooterOff: alternatePreview }
              : undefined
            const message = 'Film preview ready.'
            if (!request.livePreview) setExportStatus({ type: 'success', message })
            return { message, preview, previewVariants }
          }
          throw new Error('Unsupported DICOM Print action.')
        }
        if (request.intent === 'export') {
          downloadBlob(pdf!, `${safeName}.pdf`)
          const message = 'PDF document exported.'
          setExportStatus({ type: 'success', message })
          return { message }
        }
        const previewImage = await createPdfPreviewBlob(items, {
          orientation: request.orientation,
          tileLayout: request.tileLayout,
          imageTransforms: request.pdfImages,
          itemIndexOffset: request.previewItemOffset,
        })
        const totalItems = Math.max(items.length, request.previewTotalItems ?? items.length)
        const pageCount = Math.max(1, request.previewPageCount ?? 1)
        const pageIndex = Math.max(0, request.previewPageIndex ?? 0)
        const caption = `PDF Preview · Page ${pageIndex + 1} of ${pageCount} · ${totalItems} image${totalItems === 1 ? '' : 's'}`
        const preview = makeExportPreview(previewImage.blob, 'image', caption, pageIndex, pageCount, {
          columns: previewImage.layout.columns,
          rows: previewImage.layout.rows,
          itemOffset: request.previewItemOffset ?? 0,
          itemCount: items.length,
        })
        const message = request.intent === 'print' ? 'PDF is ready to print from the preview.' : 'PDF preview ready.'
        setExportStatus({ type: 'success', message })
        return { message, preview }
      }

      const sourceVideo = await renderCanvasSequenceToVideo(items, request.fps)
      if (request.intent === 'preview') {
        const message = 'Movie preview ready.'
        setExportStatus({ type: 'success', message })
        return { message, preview: makeExportPreview(sourceVideo, 'video') }
      }
      const output = await transcodeVideo(sourceVideo, request.format, safeName, request.fps)
      downloadBlob(output, `${safeName}.${request.format}`)
      const message = `${request.format.toUpperCase()} cine exported.`
      setExportStatus({ type: 'success', message })
      return { message }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to complete the export.'
      if (!request.livePreview) setExportStatus({ type: 'error', message })
      return { message }
    } finally {
      if (!request.livePreview) {
        setLoadingMessage('')
        setExportBusy(false)
      }
    }
  }

  async function captureViewportExports(request: ViewerExportRequest, targets: ViewportCaptureTarget[], isCancelled: () => boolean = () => false) {
    const captures: Array<ViewportCaptureSource & { textOverlay?: PdfTextOverlay }> = []
    const showViewerProgress = !request.livePreview
    const isSeriesScope = request.scope === 'selected' || request.scope === 'series'
    const isCustomScope = request.scope === 'custom'
    const usePageImageFrame = (request.format === 'png' || request.format === 'jpeg') && !request.render.trueSize
    let remainingItems = Number.isFinite(request.previewItemLimit)
      ? Math.max(1, Math.floor(request.previewItemLimit || 1))
      : Number.POSITIVE_INFINITY
    let remainingOffset = Number.isFinite(request.previewItemOffset)
      ? Math.max(0, Math.floor(request.previewItemOffset || 0))
      : 0
    const relocateViewportTextOverlay = !request.render.anonymize && (
      (request.format === 'pdf' || usePageImageFrame) && request.render.includeTextOverlay
      || request.format === 'dicom-print'
    )
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      if (isCancelled() || remainingItems <= 0) break
      const target = targets[targetIndex]
      const stack = viewportStacks[target.viewportKey]
      const isMprSubview = Boolean(target.element.dataset.captureViewportId)
      if ((isSeriesScope || (isCustomScope && !isMprSubview)) && !stack) {
        throw new Error('Per-viewport image selection is available only for standard stack viewports.')
      }

      const currentIndex = clampIndex(viewportSliceIndexes[target.viewportKey] ?? 0, stack?.instances.length ?? 0)
      const targetPageSelection = request.targetPageSelections?.[target.id]
      const requestedImageIndexes = targetPageSelection !== undefined && !isMprSubview
        ? parseExportPageSelection(targetPageSelection, stack?.instances.length ?? 0)
        : request.scope === 'series' || (isCustomScope && !isMprSubview)
        ? Array.from({ length: stack?.instances.length ?? 0 }, (_, index) => index)
        : request.scope === 'selected'
          ? parseExportPageSelection(request.selectedPages, stack?.instances.length ?? 0)
          : [currentIndex]
      if (!requestedImageIndexes.length) {
        throw new Error('No valid images are available for export.')
      }
      if (remainingOffset >= requestedImageIndexes.length) {
        remainingOffset -= requestedImageIndexes.length
        continue
      }
      const imageIndexes = requestedImageIndexes.slice(remainingOffset, remainingOffset + remainingItems)
      remainingOffset = 0
      if (!imageIndexes.length) break
      remainingItems -= imageIndexes.length

      const requiresSliceNavigation = isSeriesScope
        || (isCustomScope && !isMprSubview && imageIndexes.some((imageIndex) => imageIndex !== currentIndex))

      let releaseViewportFreeze: (() => void) | null = null
      try {
        if (requiresSliceNavigation) {
          releaseViewportFreeze = await freezeViewportForExport(target.element, request.render)
        }
        if (!request.render.includeMasks && isMprSubview) {
          window.dispatchEvent(new CustomEvent('vexa-viewer-export-mask-visibility', {
            detail: { viewportKey: target.viewportKey, visible: false },
          }))
          await waitForViewportRender(target.element)
        }
        for (let imagePosition = 0; imagePosition < imageIndexes.length; imagePosition += 1) {
          if (isCancelled()) break
          const imageIndex = imageIndexes[imagePosition]
          if (requiresSliceNavigation) {
            if (showViewerProgress) {
              const progressMessage = `Rendering image ${imagePosition + 1} of ${imageIndexes.length}...`
              setLoadingMessage(progressMessage)
              setExportStatus({ type: 'idle', message: progressMessage })
            }
            sendViewportCommand('set-slice', target.viewportKey, {
              sliceIndex: imageIndex,
              sourceViewportKey: 'export-preview',
            })
            await waitForViewportRender(target.element)
          } else {
            if (showViewerProgress) {
              const progressMessage = `Capturing viewport ${targetIndex + 1} of ${targets.length}...`
              setLoadingMessage(progressMessage)
              setExportStatus({ type: 'idle', message: progressMessage })
            }
            const capturePreparations: Promise<void>[] = []
            window.dispatchEvent(new CustomEvent('vexa-viewer-prepare-viewport-capture', {
              detail: {
                viewportKey: target.viewportKey,
                captureViewportId: target.element.dataset.captureViewportId,
                waitUntil: (preparation: Promise<void>) => capturePreparations.push(preparation),
              },
            }))
            if (capturePreparations.length > 0) {
              await Promise.allSettled(capturePreparations)
            }
            await waitForViewportRender(target.element)
          }
          const instance = stack?.instances[imageIndex] ?? target.instance
          const textOverlay = relocateViewportTextOverlay
            ? collectPdfTextOverlay(target.element)
            : undefined
          const capturedCanvas = await renderSecondaryCaptureCanvas(target.element, undefined, {
            targetLongEdge: request.render.targetLongEdge,
            cropToContent: false,
            includeTextOverlay: request.render.includeTextOverlay,
            relocateViewportTextOverlay,
            includeAnnotations: request.render.includeAnnotations,
            includeMasks: request.render.includeMasks,
            anonymize: request.render.anonymize,
            trueSize: request.render.trueSize,
            nativeImage: request.render.trueSize && !isMprSubview
              ? getNativeExportImageDimensions(instance)
              : null,
          })
          const canvas = usePageImageFrame
            ? createA4JpegCanvas(capturedCanvas, textOverlay, request.render.targetLongEdge, request.orientation)
            : capturedCanvas
          captures.push({
            canvas,
            label: requiresSliceNavigation ? `${target.label} - Image ${imageIndex + 1}` : target.label,
            series: target.series,
            instance,
            textOverlay,
          })
        }
      } finally {
        if (!request.render.includeMasks && isMprSubview) {
          window.dispatchEvent(new CustomEvent('vexa-viewer-export-mask-visibility', {
            detail: { viewportKey: target.viewportKey, visible: true },
          }))
        }
        if (requiresSliceNavigation) {
          sendViewportCommand('set-slice', target.viewportKey, {
            sliceIndex: currentIndex,
            sourceViewportKey: 'export-preview',
          })
          await waitForViewportRender(target.element)
        }
        releaseViewportFreeze?.()
      }
    }
    return captures
  }

  useEffect(() => () => {
    clearTransientErrorTimer()
  }, [clearTransientErrorTimer])

  useEffect(() => {
    if (!hasPermission(getActiveToolPermission(activeTool))) {
      setActiveTool(hasPermission('tool.window_level.use') ? 'WindowLevel' : 'Scroll')
    }
    if (mprMode && !hasPermission('mpr.open')) {
      setMprMode(false, selectedViewportKey)
    }
  }, [activeTool, hasPermission, mprMode, selectedViewportKey, setActiveTool, setMprMode])

  useEffect(() => {
    if (!currentUser) {
      setCustomWindowPresets(loadCustomWindowPresets(customPresetStorageKey))
    }
  }, [currentUser, customPresetStorageKey])

  useEffect(() => {
    if (openMenu !== 'preset') {
      return
    }

    const selectedWindowLevel = viewportWindowLevels[selectedViewportKey]
    if (selectedWindowLevel && Number.isFinite(selectedWindowLevel.windowWidth) && Number.isFinite(selectedWindowLevel.windowLevel)) {
      setCustomPresetWw(String(Math.round(selectedWindowLevel.windowWidth)))
      setCustomPresetWl(String(Math.round(selectedWindowLevel.windowLevel)))
    } else {
      setCustomPresetWw((value) => value || '80')
      setCustomPresetWl((value) => value || '40')
    }
  }, [openMenu, selectedViewportKey])

  useEffect(() => {
    let cancelled = false
    preferencesHydratedRef.current = false

    async function loadPreferences() {
      if (!currentUser) return
      try {
        const response = await fetch(appUrl('/api/auth/preferences'), { credentials: 'same-origin' })
        const preferences = await response.json() as ViewerPreferences
        if (cancelled) return
        const nextToolbarFavorites = sanitizeToolbarFavorites(preferences.toolbarFavorites)
        const nextViewerAppearance = normalizeViewerAppearance(preferences.viewerAppearance)
        const nextHotkeyOverrides = preferences.hotkeyOverrides ?? {}
        const nextCustomWindowPresets = sanitizeCustomWindowPresets(preferences.customWindowPresets)
        preferencesSnapshotRef.current = serializeViewerPreferences(nextToolbarFavorites, nextViewerAppearance, nextHotkeyOverrides, nextCustomWindowPresets)
        setToolbarFavorites(nextToolbarFavorites)
        setViewerAppearance(nextViewerAppearance)
        setHotkeyOverrides(nextHotkeyOverrides)
        setCustomWindowPresets(nextCustomWindowPresets)
      } finally {
        if (!cancelled) {
          if (!preferencesSnapshotRef.current) {
            preferencesSnapshotRef.current = serializeViewerPreferences(toolbarFavorites, viewerAppearance, hotkeyOverrides, customWindowPresets)
          }
          preferencesHydratedRef.current = true
        }
      }
    }

    void loadPreferences()

    return () => {
      cancelled = true
    }
  }, [currentUser, setHotkeyOverrides])

  useEffect(() => {
    if (!currentUser || !preferencesHydratedRef.current) {
      return
    }

    const nextSnapshot = serializeViewerPreferences(toolbarFavorites, viewerAppearance, hotkeyOverrides, customWindowPresets)
    if (nextSnapshot === preferencesSnapshotRef.current) {
      return
    }

    if (preferencesSaveTimerRef.current !== null) {
      window.clearTimeout(preferencesSaveTimerRef.current)
    }

    preferencesSaveTimerRef.current = window.setTimeout(() => {
      preferencesSaveTimerRef.current = null
      void fetch(appUrl('/api/auth/preferences'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: nextSnapshot,
      }).then((response) => {
        if (response.ok) {
          preferencesSnapshotRef.current = nextSnapshot
        }
      }).catch(() => undefined)
    }, 600)

    return () => {
      if (preferencesSaveTimerRef.current !== null) {
        window.clearTimeout(preferencesSaveTimerRef.current)
        preferencesSaveTimerRef.current = null
      }
    }
  }, [currentUser, customWindowPresets, hotkeyOverrides, toolbarFavorites, viewerAppearance])

  useEffect(() => {
    setVolume3dViewport(null)
    setFullscreenViewportKey(null)
    setReadyViewportSeries({})
    technicalMetadataRefreshesRef.current.clear()
  }, [activeStudy?.studyInstanceUid])

  useEffect(() => {
    const studyInstanceUid = activeStudy?.studyInstanceUid
    if (!studyInstanceUid) return

    const stack = Object.values(viewportStacks).find(needsCtTechnicalMetadataRefresh)
    if (!stack) return

    const cacheKey = `${stack.series.studyInstanceUid}|${stack.series.seriesInstanceUid}`
    if (technicalMetadataRefreshesRef.current.has(cacheKey)) return
    technicalMetadataRefreshesRef.current.add(cacheKey)

    let cancelled = false
    void refreshInstances(stack.series)
      .then((instances) => {
        if (cancelled || useViewerStore.getState().activeStudy?.studyInstanceUid !== studyInstanceUid) return

        Object.entries(useViewerStore.getState().viewportStacks).forEach(([viewportKey, currentStack]) => {
          if (currentStack.series.studyInstanceUid === stack.series.studyInstanceUid
            && currentStack.series.seriesInstanceUid === stack.series.seriesInstanceUid) {
            refreshViewportStackInstances(viewportKey, instances)
          }
        })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [activeStudy?.studyInstanceUid, refreshViewportStackInstances, viewportStacks])

  useEffect(() => {
    if (fullscreenViewportKey && !viewportKeys.some((key) => key === fullscreenViewportKey)) {
      setFullscreenViewportKey(null)
    }
  }, [fullscreenViewportKey, viewportKeys])

  useEffect(() => {
    const visibleViewportKeys = new Set<string>(viewportKeys)
    setPrintSelectedViewportKeys((current) => {
      const visible = current.filter((key) => visibleViewportKeys.has(key))
      if (visible.length > 0) return visible
      return visibleViewportKeys.has(selectedViewportKey) ? [selectedViewportKey] : viewportKeys.slice(0, 1)
    })
  }, [selectedViewportKey, viewportKeys])

  useEffect(() => {
    if (!activeSeries) {
      setInstances([], [])
      setViewportWaveforms({})
      setViewportVideos({})
      setViewportReports({})
      setViewportSavedObjects({})
      setViewportIchSegmentations({})
      return
    }

    const series = activeSeries
    let cancelled = false

    async function loadInstances() {
      setLoadingMessage(`Loading ${series.modality || 'DICOM'} series...`)
      setErrorMessage('')
      setViewportIchSegmentations((current) => {
        const next = { ...current }
        delete next[activeSeriesTargetViewportKey]
        return next
      })
      try {
        const modality = series.modality?.toUpperCase() ?? ''
        if (modality === 'PR') {
          if (!cancelled) {
            setInstances([], [])
            setViewportStack(activeSeriesTargetViewportKey, { series, instances: [], imageIds: [] })
            setViewportSavedObjects((current) => ({
              ...current,
              [activeSeriesTargetViewportKey]: {
                series,
                title: series.seriesDescription || 'GSPS Presentation State',
                description: 'This series stores visual annotation presentation state and references the source image.',
                status: 'Saved as DICOM PR / GSPS. Image display for PR objects is not applied automatically yet.',
              },
            }))
            setViewportWaveforms((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setViewportReports((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
          }
          return
        }

        const allInstances = await listInstances(series)
        const segmentationInstance = allInstances.find(isSegmentationInstance)
          ?? (modality === 'SEG' ? allInstances[0] : undefined)
        if (segmentationInstance) {
          const arrayBuffer = await retrieveDicomInstance(segmentationInstance)
          const descriptor = await readIchSegmentationDescriptor(arrayBuffer)
          const studySeries = await listSeries(series.studyInstanceUid)
          const sourceSeries = studySeries.find((candidate) => candidate.seriesInstanceUid === descriptor.referencedSeriesInstanceUid)
          if (!sourceSeries) {
            throw new Error('The source series referenced by the DICOM SEG object was not found in this study.')
          }

          const sourceInstances = (await listInstances(sourceSeries)).filter(isRenderableImageInstance)
          const sourceImageIds = createDiagnosticStackImageIds(sourceSeries, sourceInstances)
          if (!sourceImageIds.length) {
            throw new Error('The DICOM SEG source image cannot be rendered.')
          }

          if (!cancelled) {
            registerWadoRsMetadata(sourceInstances)
            setInstances(sourceInstances, sourceImageIds)
            setViewportStack(activeSeriesTargetViewportKey, { series: sourceSeries, instances: sourceInstances, imageIds: sourceImageIds })
            setViewportIchSegmentations((current) => ({
              ...current,
              [activeSeriesTargetViewportKey]: { series, instance: segmentationInstance, arrayBuffer },
            }))
            setViewportSavedObjects((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setViewportVideos((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setViewportWaveforms((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setViewportReports((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setSelectedViewportKey(activeSeriesTargetViewportKey)
            setVolume3dViewport((current) => current?.key === activeSeriesTargetViewportKey ? null : current)
            setFullscreenViewportKey(activeSeriesTargetViewportKey)
            setIchMprWorkspace(activeSeriesTargetViewportKey, true)
            setMprMode(true, activeSeriesTargetViewportKey)
            setActiveTool('Crosshairs')
          }
          return
        }
        const videoInstance = allInstances.find(isVideoInstance)
        if (videoInstance) {
          if (!cancelled) {
            setInstances([videoInstance], [])
            setViewportStack(activeSeriesTargetViewportKey, { series, instances: [videoInstance], imageIds: [] })
            setViewportVideos((current) => ({ ...current, [activeSeriesTargetViewportKey]: { series, instance: videoInstance } }))
            setViewportSavedObjects((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setViewportWaveforms((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setViewportReports((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
          }
          return
        }

        const instances = allInstances.filter(isRenderableImageInstance)
        const imageIds = createDiagnosticStackImageIds(series, instances)
        if (!cancelled) {
          if (!imageIds.length) {
            if (modality === 'OT' && series.seriesDescription?.toLowerCase().includes('secondary capture')) {
              setInstances([], [])
              setViewportStack(activeSeriesTargetViewportKey, { series, instances: [], imageIds: [] })
              setViewportSavedObjects((current) => ({
                ...current,
                [activeSeriesTargetViewportKey]: {
                  series,
                  title: series.seriesDescription || 'Secondary Capture',
                  description: 'The Secondary Capture was stored, but PACS has not returned renderable image metadata for it yet.',
                  status: 'Waiting for PACS indexing. Try opening this series again in a few seconds.',
                },
              }))
              setViewportWaveforms((current) => {
                const next = { ...current }
                delete next[activeSeriesTargetViewportKey]
                return next
              })
              setViewportVideos((current) => {
                const next = { ...current }
                delete next[activeSeriesTargetViewportKey]
                return next
              })
              setViewportReports((current) => {
                const next = { ...current }
                delete next[activeSeriesTargetViewportKey]
                return next
              })
              return
            }

            const waveform = await getSeriesWaveform(series)
            if (cancelled) {
              return
            }

            if (!waveform) {
              const report = await getSeriesStructuredReport(series)
              if (!report) {
                setErrorMessage('This series is not a renderable DICOM image, ECG waveform, or readable SR report.')
                return
              }

              setInstances([], [])
              setViewportStack(activeSeriesTargetViewportKey, { series, instances: [], imageIds: [] })
              setViewportReports((current) => ({ ...current, [activeSeriesTargetViewportKey]: { series, report } }))
              setViewportSavedObjects((current) => {
                const next = { ...current }
                delete next[activeSeriesTargetViewportKey]
                return next
              })
              setViewportVideos((current) => {
                const next = { ...current }
                delete next[activeSeriesTargetViewportKey]
                return next
              })
              setViewportWaveforms((current) => {
                const next = { ...current }
                delete next[activeSeriesTargetViewportKey]

                return next
              })
              return
            }

            setInstances([], [])
            setViewportStack(activeSeriesTargetViewportKey, { series, instances: [], imageIds: [] })
            setViewportWaveforms((current) => ({ ...current, [activeSeriesTargetViewportKey]: { series, waveform } }))
            setViewportSavedObjects((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]
              return next
            })
            setViewportVideos((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]

              return next
            })
            setViewportReports((current) => {
              const next = { ...current }
              delete next[activeSeriesTargetViewportKey]

              return next
            })
            return
          }
          registerWadoRsMetadata(instances)
          setInstances(instances, imageIds)
          setViewportStack(activeSeriesTargetViewportKey, { series, instances, imageIds })

          setViewportSavedObjects((current) => {
            const next = { ...current }
            delete next[activeSeriesTargetViewportKey]
            return next
          })
          setViewportWaveforms((current) => {
            const next = { ...current }
            delete next[activeSeriesTargetViewportKey]

            return next
          })
          setViewportVideos((current) => {
            const next = { ...current }
            delete next[activeSeriesTargetViewportKey]

            return next
          })
          setViewportReports((current) => {
            const next = { ...current }
            delete next[activeSeriesTargetViewportKey]

            return next
          })
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to load images')
        }
      } finally {
        if (!cancelled) {
          setLoadingMessage('')
        }
      }
    }

    void loadInstances()

    return () => {
      cancelled = true
    }
  }, [activeSeries, activeSeriesTargetViewportKey, setErrorMessage, setInstances, setLoadingMessage, setViewportStack])

  // ── Batch series loader (auto-launched from App.tsx) ──
  useEffect(() => {
    const batch = activeSeriesBatch
    const keys = Object.keys(batch)
    if (keys.length === 0) return

    let cancelled = false

    async function loadBatchSeries() {
      setErrorMessage('')
      setLoadingMessage('Loading series...')

      const loadedSeries = await Promise.all(keys.map(async (viewportKey) => {
        if (cancelled) return
        const series = batch[viewportKey]
        if (!series) return

        try {
          const allInstances = await listInstances(series)
          if (cancelled) return

          const videoInstance = allInstances.find(isVideoInstance)
          if (videoInstance) {
            return { kind: 'video' as const, viewportKey, series, instance: videoInstance }
          }

          const instances = allInstances.filter(isRenderableImageInstance)
          const imageIds = createDiagnosticStackImageIds(series, instances)

          if (!cancelled && imageIds.length > 0) {
            registerWadoRsMetadata(instances)
            const initialImageIndex = getStackInitialImageIndex(imageIds.length)
            if (!serverRenderMode) {
              primeStackImagesForDisplay(imageIds, initialImageIndex)
              void prewarmStackNeighbors(imageIds, initialImageIndex, { radius: 1, timeoutMs: 6_000 })
            }
            return { kind: 'stack' as const, viewportKey, series, instances, imageIds }
          }
        } catch (error) {
          if (!cancelled) {
            setErrorMessage(error instanceof Error ? error.message : 'Unable to load series')
          }
        }
      }))

      if (!cancelled) {
        loadedSeries.forEach((item) => {
          if (!item) return
          setViewportWaveforms((current) => {
            const next = { ...current }
            delete next[item.viewportKey]
            return next
          })
          setViewportReports((current) => {
            const next = { ...current }
            delete next[item.viewportKey]
            return next
          })
          setViewportSavedObjects((current) => {
            const next = { ...current }
            delete next[item.viewportKey]
            return next
          })
          if (item.kind === 'video') {
            setInstances([item.instance], [])
            setViewportStack(item.viewportKey, {
              series: item.series,
              instances: [item.instance],
              imageIds: [],
            })
            setViewportVideos((current) => ({ ...current, [item.viewportKey]: { series: item.series, instance: item.instance } }))
            return
          }

          setInstances(item.instances, item.imageIds)
          setViewportStack(item.viewportKey, {
            series: item.series,
            instances: item.instances,
            imageIds: item.imageIds,
          })
          setViewportVideos((current) => {
            const next = { ...current }
            delete next[item.viewportKey]
            return next
          })
        })
        setLoadingMessage('')
      }
    }

    void loadBatchSeries()

    return () => {
      cancelled = true
    }
  }, [activeSeriesBatch, serverRenderMode, setErrorMessage, setInstances, setLoadingMessage, setViewportStack])

  useEffect(() => {
    function closeMenuOnOutsideClick(event: MouseEvent | TouchEvent) {
      const target = event.target
      const clickedMenu = target instanceof Element ? target.closest('.ribbon-menu') : null
      const clickedActiveMenu = clickedMenu?.querySelector('.ribbon-dropdown')

      if (!clickedActiveMenu) {
        setOpenMenu(null)
      }
    }

    document.addEventListener('mousedown', closeMenuOnOutsideClick)
    document.addEventListener('touchstart', closeMenuOnOutsideClick)

    return () => {
      document.removeEventListener('mousedown', closeMenuOnOutsideClick)
      document.removeEventListener('touchstart', closeMenuOnOutsideClick)
    }
  }, [])

  function selectTool(toolId: string) {
    if (toolId === 'ReferenceLines') {
      setReferenceLinesEnabled(!referenceLinesEnabled)
      setOpenMenu(null)
      return
    }

    activateTool(toolId)
    setOpenMenu(null)
  }

  function activateTool(toolId: string) {
    if (toolId === 'ICHSegment') {
      openIchMprWorkspace()
      return
    }

    setActiveTool(activeTool === toolId ? 'WindowLevel' : toolId)
  }

  function handleStackViewportReady(viewportKey: string, seriesInstanceUid: string) {
    setReadyViewportSeries((current) => (
      current[viewportKey] === seriesInstanceUid
        ? current
        : { ...current, [viewportKey]: seriesInstanceUid }
    ))
  }

  function selectUtilityTool(toolId: string) {
    if (toolId === 'ReferenceLines') {
      selectTool(toolId)
      return
    }
    if (toolId === 'ImageOverlay') {
      setShowOverlay((value) => !value)
    }
    if (toolId === 'Invert') {
      sendViewportCommand('invert')
    }
    if (toolId === 'TagBrowser') {
      setIsTagBrowserOpen(true)
    }
    setOpenMenu(null)
  }

  function isUtilityToolActive(toolId: string) {
    return toolId === 'ReferenceLines' ? referenceLinesEnabled : toolId === 'ImageOverlay' && showOverlay
  }

  function applyWindowLevel(windowWidth: number, windowLevel: number, closeMenu = true) {
    sendViewportCommand('set-window-level', selectedViewportKey, { windowLevel: { windowWidth, windowLevel } })
    if (closeMenu) {
      setOpenMenu(null)
    }
  }

  function handleApplyCustomWindowPreset() {
    const parsed = parseWindowLevelInputs(customPresetWw, customPresetWl)
    if (!parsed) {
      showTransientError('The custom WW/WL preset is invalid.')
      return
    }

    applyWindowLevel(parsed.windowWidth, parsed.windowLevel)
  }

  function handleSaveCustomWindowPreset() {
    const parsed = parseWindowLevelInputs(customPresetWw, customPresetWl)
    if (!parsed) {
      showTransientError('Enter valid WW/WL values for the custom preset.')
      return
    }

    setCustomPresetName((value) => value || `WW ${Math.round(parsed.windowWidth)} / WL ${Math.round(parsed.windowLevel)}`)
    setCustomPresetSaveDialogOpen(true)
  }

  function handleConfirmSaveCustomWindowPreset() {
    const parsed = parseWindowLevelInputs(customPresetWw, customPresetWl)
    const name = customPresetName.trim()
    if (!parsed || !name) {
      showTransientError('Enter a preset name and valid WW/WL values.')
      return
    }

    const nextPreset: CustomWindowPreset = {
      id: `custom-${Date.now()}`,
      name,
      windowWidth: parsed.windowWidth,
      windowLevel: parsed.windowLevel,
    }
    const nextPresets = [
      ...customWindowPresets.filter((preset) => preset.name.toLowerCase() !== name.toLowerCase()),
      nextPreset,
    ].sort((left, right) => left.name.localeCompare(right.name))
    const sanitizedPresets = sanitizeCustomWindowPresets(nextPresets)

    setCustomWindowPresets(sanitizedPresets)
    saveCustomWindowPresets(customPresetStorageKey, sanitizedPresets)
    setCustomPresetSaveDialogOpen(false)
  }

  function updateCustomPresetWw(value: string) {
    setCustomPresetWw(value)
    if (errorMessage) setErrorMessage('')
    clearTransientErrorTimer()
  }

  function updateCustomPresetWl(value: string) {
    setCustomPresetWl(value)
    if (errorMessage) setErrorMessage('')
    clearTransientErrorTimer()
  }

  function updateCustomPresetName(value: string) {
    setCustomPresetName(value)
    if (errorMessage) setErrorMessage('')
    clearTransientErrorTimer()
  }

  function handleDeleteCustomWindowPreset(presetId: string) {
    const nextPresets = sanitizeCustomWindowPresets(customWindowPresets.filter((preset) => preset.id !== presetId))
    setCustomWindowPresets(nextPresets)
    saveCustomWindowPresets(customPresetStorageKey, nextPresets)
  }

  function renderBuiltinWindowPreset(label: string, windowWidth: number, windowLevel: number, command: Parameters<typeof sendViewportCommand>[0]) {
    return (
      <button className="ribbon-option preset-inline-option" type="button" onClick={() => { sendViewportCommand(command); setOpenMenu(null) }}>
        <span>{label}</span>
        <small>WW {windowWidth} / WL {windowLevel}</small>
      </button>
    )
  }

  function renderCustomWindowPreset(preset: CustomWindowPreset) {
    return (
      <div className="custom-preset-row" key={preset.id}>
        <button className="ribbon-option preset-inline-option" type="button" onClick={() => applyWindowLevel(preset.windowWidth, preset.windowLevel)}>
          <span>{preset.name}</span>
          <small>WW {preset.windowWidth} / WL {preset.windowLevel}</small>
        </button>
        <button className="custom-preset-delete" type="button" title="Delete preset" aria-label={`Delete ${preset.name}`} onClick={() => handleDeleteCustomWindowPreset(preset.id)}>
          <X size={14} />
        </button>
      </div>
    )
  }

  function runToolbarMenuAction(action: ViewportMenuAction) {
    setOpenMenu(null)

    if (action.type === 'tool') {
      activateTool(action.tool)
      return
    }

    if (action.type === 'command') {
      if (action.command === 'save-secondary-capture') {
        openExportCenter(selectedViewportKey, 'capture')
        return
      }
      sendViewportCommand(action.command as Parameters<typeof sendViewportCommand>[0], selectedViewportKey)
      return
    }

    if (action.type === 'reference-lines') {
      setReferenceLinesEnabled(!referenceLinesEnabled)
      return
    }

    if (action.type === 'custom') {
      if (action.id === 'toggle-overlay') {
        setShowOverlay((value) => !value)
      }
      if (action.id === 'tag-browser') {
        setIsTagBrowserOpen(true)
      }
      if (action.id === 'toggle-mpr') {
        toggleMprMode()
      }
      if (action.id === 'toggle-3d') {
        toggle3dMode()
      }
      if (action.id === 'toggle-3d-bone') {
        toggle3dMode(selectedViewportKey, 'bone')
      }
      if (action.id === 'ambient-test') {
        setIsAmbientTestOpen(true)
      }
    }
  }

  function isToolbarMenuActionActive(action: ViewportMenuAction) {
    return (action.type === 'tool' && action.tool === activeTool)
      || (action.type === 'reference-lines' && referenceLinesEnabled)
      || (action.type === 'custom' && action.id === 'toggle-overlay' && showOverlay)
      || (action.type === 'custom' && action.id === 'toggle-mpr' && mprMode)
      || (action.type === 'custom' && action.id === 'toggle-3d' && volume3dViewport?.key === selectedViewportKey && volume3dViewport.mode === 'oblique')
      || (action.type === 'custom' && action.id === 'toggle-3d-bone' && volume3dViewport?.key === selectedViewportKey && volume3dViewport.mode === 'bone')
  }

  function toggleMprMode(targetViewportKey = selectedViewportKey) {
    if (!hasPermission('mpr.open')) return
    const targetStack = viewportStacks[targetViewportKey]
    const series = targetStack?.series ?? activeSeries
    const modality = series?.modality?.toUpperCase()
    if (!series || (modality !== 'CT' && modality !== 'MR')) return
    const nextMprMode = !useViewerStore.getState().mprViewportKeys[targetViewportKey]
    setSelectedViewportKey(targetViewportKey)
    setVolume3dViewport((current) => current?.key === targetViewportKey ? null : current)
    if (nextMprMode) {
      setActiveTool('Crosshairs')
    } else if (activeTool === 'Crosshairs' || activeTool === 'Stack3DCursor') {
      setActiveTool('WindowLevel')
    }
    setMprMode(nextMprMode, targetViewportKey)
  }

  function openIchMprWorkspace(targetViewportKey = selectedViewportKey) {
    const targetStack = viewportStacks[targetViewportKey]
    const targetSeries = targetStack?.series ?? activeSeries
    const modality = targetSeries?.modality?.toUpperCase()

    if (!targetSeries || (modality !== 'CT' && modality !== 'MR')) {
      showTransientError('ICH segmentation requires a CT or MR series.')
      return
    }

    if (!hasPermission('ich.segmentation.use')) {
      showTransientError('This role is not authorized to use ICH segmentation.')
      return
    }

    if (!hasPermission('mpr.open') || !hasPermission('mpr.crosshair.use')) {
      showTransientError('ICH segmentation requires MPR and Crosshair permissions.')
      return
    }

    setSelectedViewportKey(targetViewportKey)
    setVolume3dViewport((current) => current?.key === targetViewportKey ? null : current)
    setFullscreenViewportKey(targetViewportKey)
    setIchMprWorkspace(targetViewportKey, true)
    setMprMode(true, targetViewportKey)
    setActiveTool('Crosshairs')
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
    })
  }

  function toggleMenu(menu: string, button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect()
    setDropdownAnchor({ left: rect.left + rect.width / 2, top: rect.bottom + 8 })
    setOpenMenu((value) => (value === menu ? null : menu))
  }

  const dropdownStyle = dropdownAnchor ? { left: dropdownAnchor.left, top: dropdownAnchor.top } : undefined

  function selectSpatialTool(toolId: string) {
    if (toolId === 'spatial-magnify') {
      setActiveTool('Magnify')
      setOpenMenu(null)
      return
    }

    if (toolId === 'spatial-zoom-1x') {
      sendViewportCommand('spatial-zoom-1x', selectedViewportKey)
      setOpenMenu(null)
      return
    }

    if (toolId === 'spatial-zoom-input') {
      const value = window.prompt('Zoom value (example: 1, 1.5, 2)', String(viewportZooms[selectedViewportKey] ?? 1))
      const zoom = Number(value)
      if (Number.isFinite(zoom) && zoom > 0) {
        sendViewportCommand('spatial-zoom-input', selectedViewportKey, { zoom })
      }
      setOpenMenu(null)
      return
    }

    sendViewportCommand(toolId as Parameters<typeof sendViewportCommand>[0], selectedViewportKey)
    setOpenMenu(null)
  }

  function toggle3dMode(targetViewportKey = selectedViewportKey, mode: 'oblique' | 'bone' = 'oblique') {
    if (!hasPermission('mpr.bone_3d.open')) return
    const targetStack = viewportStacks[targetViewportKey]
    const series = targetStack?.series ?? selectedStack?.series ?? activeSeries
    if (!series || series.modality?.toUpperCase() !== 'CT') {
      return
    }

    setMprMode(false, targetViewportKey)
    setVolume3dViewport((current) => current?.key === targetViewportKey && current.mode === mode ? null : { key: targetViewportKey, series, mode })
  }

  function handleSeriesDrop(event: React.DragEvent<HTMLDivElement>, viewportKey: string) {
    event.preventDefault()
    if (!hasPermission('viewer.series.drag_drop')) return
    const payload = readDroppedSeries(event.dataTransfer)
    if (!payload) {
      return
    }

    setSelectedViewportKey(viewportKey)
    setVolume3dViewport((current) => current?.key === viewportKey ? null : current)
    if (activeStudy?.studyInstanceUid !== payload.study.studyInstanceUid) {
      setActiveStudy(payload.study)
    }
    setActiveSeries(payload.series, viewportKey)
  }

  function renderViewportCaptureDialog() {
    /* Legacy DICOM capture dialog retained below temporarily as a migration reference.
    if (!captureDialogOpen) return null

    const selectedTargets = captureTargets.filter((target) => selectedCaptureTargetIds.includes(target.id))
    const estimatedBytes = selectedTargets.reduce((total, target) => {
      const size = getCaptureOutputSize(target.element, captureLongEdge)
      return total + size.width * size.height * 3
    }, 0)
    const hasSaved = captureStatus.type === 'success'

    return createPortal(
      <div
        className="viewport-capture-backdrop"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && !captureBusy) {
            setCaptureDialogOpen(false)
          }
        }}
      >
        <section className="viewport-capture-dialog" role="dialog" aria-modal="true" aria-label="Capture viewports to PACS">
          <header>
            <div className="viewport-capture-heading">
              <Camera size={18} aria-hidden="true" />
              <div>
                <strong>Capture Viewports</strong>
                <span>DICOM Secondary Capture</span>
              </div>
            </div>
            <button disabled={captureBusy} type="button" title="Close" aria-label="Close capture dialog" onClick={() => setCaptureDialogOpen(false)}>
              <X size={16} aria-hidden="true" />
            </button>
          </header>

          <div className="viewport-capture-form">
            <label className="viewport-capture-series-name">
              <span>Series name</span>
              <input
                autoFocus
                disabled={captureBusy || hasSaved}
                maxLength={64}
                placeholder="Enter series name"
                value={captureSeriesName}
                onChange={(event) => {
                  setCaptureSeriesName(event.currentTarget.value)
                  setCaptureStatus({ type: 'idle', message: '' })
                }}
              />
              <small>{captureSeriesName.length}/64</small>
            </label>

            <fieldset className="viewport-capture-resolution" disabled={captureBusy || hasSaved}>
              <legend>Resolution</legend>
              {[2048, 3072, 3840].map((longEdge) => (
                <button
                  className={captureLongEdge === longEdge ? 'active' : ''}
                  key={longEdge}
                  type="button"
                  aria-pressed={captureLongEdge === longEdge}
                  onClick={() => {
                    setCaptureLongEdge(longEdge)
                    setCaptureStatus({ type: 'idle', message: '' })
                  }}
                >
                  {longEdge === 2048 ? '2K' : longEdge === 3072 ? '3K' : '4K'}
                </button>
              ))}
            </fieldset>
          </div>

          <div className="viewport-capture-selection-header">
            <span>Viewports</span>
            <div>
              <button
                disabled={captureBusy || hasSaved}
                type="button"
                onClick={() => {
                  setSelectedCaptureTargetIds(captureTargets.map((target) => target.id))
                  setCaptureStatus({ type: 'idle', message: '' })
                }}
              >
                Select all
              </button>
              <button
                disabled={captureBusy || hasSaved}
                type="button"
                onClick={() => {
                  setSelectedCaptureTargetIds([])
                  setCaptureStatus({ type: 'idle', message: '' })
                }}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="viewport-capture-targets">
            {captureTargets.map((target) => {
              const selected = selectedCaptureTargetIds.includes(target.id)
              const outputSize = getCaptureOutputSize(target.element, captureLongEdge)
              return (
                <button
                  className={selected ? 'viewport-capture-target selected' : 'viewport-capture-target'}
                  disabled={captureBusy || hasSaved}
                  key={target.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleCaptureTarget(target.id)}
                >
                  <span className="viewport-capture-check" aria-hidden="true">{selected && <Check size={13} />}</span>
                  <span className="viewport-capture-target-copy">
                    <strong>{target.label}</strong>
                    <small>{target.series?.modality || 'SC'} · {outputSize.width} x {outputSize.height}</small>
                  </span>
                </button>
              )
            })}
          </div>

          <div className="viewport-capture-summary">
            <span>{selectedTargets.length} instance{selectedTargets.length === 1 ? '' : 's'}</span>
            <span>{captureLongEdge === 2048 ? '2K' : captureLongEdge === 3072 ? '3K' : '4K'}</span>
            <span>{formatCaptureBytes(estimatedBytes)} raw</span>
          </div>
          {captureBusy && <progress aria-label="Capture progress" />}
          {captureStatus.message && (
            <div className={`viewport-capture-status ${captureStatus.type}`} aria-live="polite">
              {captureStatus.type === 'success' && <Check size={14} aria-hidden="true" />}
              {captureStatus.type === 'error' && <AlertTriangle size={14} aria-hidden="true" />}
              <span>{captureStatus.message}</span>
            </div>
          )}

          <footer>
            <button disabled={captureBusy} type="button" onClick={() => setCaptureDialogOpen(false)}>
              {hasSaved ? 'Close' : 'Cancel'}
            </button>
            {!hasSaved && (
              <button
                className="primary"
                disabled={captureBusy || !captureSeriesName.trim() || selectedTargets.length === 0}
                type="button"
                onClick={() => void handleSaveViewportCaptures()}
              >
                {captureBusy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Camera size={15} aria-hidden="true" />}
                Save to PACS
              </button>
            )}
          </footer>
        </section>
      </div>,
      document.body,
    )
    */
    const preferredTargetId = exportTargets.some((target) => target.id === exportPreferredTargetId)
      ? exportPreferredTargetId
      : exportTargets[0]?.id ?? ''
    const preferredTarget = exportTargets.find((target) => target.id === preferredTargetId) ?? exportTargets[0]
    const initialExportFileName = buildExportFileName(activeStudy, preferredTarget?.instance?.metadata, preferredTarget?.series)
    return (
      <ExportCenterDialog
        key={exportDialogSession}
        open={exportDialogOpen}
        targets={exportTargets.map((target) => ({
          id: target.id,
          label: target.label,
          modality: target.series?.modality || 'SC',
          size: `${Math.round(target.element.getBoundingClientRect().width)} x ${Math.round(target.element.getBoundingClientRect().height)}`,
          supportsSeries: !target.element.dataset.captureViewportId && (viewportStacks[target.viewportKey]?.instances.length ?? 0) > 1,
          imageCount: target.imageCount,
          currentImageNumber: (viewportSliceIndexes[target.viewportKey] ?? 0) + 1,
        }))}
        preferredTargetId={preferredTargetId}
        initialFileName={initialExportFileName}
        initialTargetIds={exportInitialTargetIds}
        mode={exportDialogMode}
        busy={exportBusy}
        status={exportStatus}
        onClose={() => {
          exportPreviewGenerationRef.current += 1
          setExportDialogOpen(false)
          setLoadingMessage('')
        }}
        onClearStatus={() => setExportStatus({ type: 'idle', message: '' })}
        onExecute={executeViewerExport}
      />
    )
  }

  const browserPosition = viewerAppearance.browserPosition
  const BrowserCollapseIcon = browserPosition === 'bottom' ? ChevronDown : ChevronUp
  const BrowserExpandIcon = browserPosition === 'bottom' ? ChevronUp : ChevronDown
  const seriesBrowserPanel = (
    <div className={seriesBrowserCollapsed ? `viewer-browser-panel ${browserPosition} collapsed` : `viewer-browser-panel ${browserPosition}`}>
      {seriesBrowserCollapsed ? (
        <button
          className={`viewer-browser-toggle expand ${browserPosition}`}
          type="button"
          title="Show series list"
          aria-label="Show series list"
          onClick={() => setSeriesBrowserCollapsed(false)}
        >
          <BrowserExpandIcon size={17} />
        </button>
      ) : (
        <>
          <button
            className="viewer-browser-toggle collapse"
            type="button"
            title="Hide series list"
            aria-label="Hide series list"
            onClick={() => setSeriesBrowserCollapsed(true)}
          >
            <BrowserCollapseIcon size={17} />
          </button>
          <div className="viewer-browser-panel-content">
            <StudyHeaderBrowser deepLinkMode={deepLinkMode} />
          </div>
        </>
      )}
    </div>
  )

  return (
    <section className={`viewer-shell browser-${browserPosition}`}>
      <div className="patient-strip">
        <div>
          <p className="eyebrow">VELO Viewer</p>
          <strong>{activeStudy?.patientName ?? 'No study selected'}</strong>
        </div>
        <span>{activeSeries?.modality ?? 'DICOM'} · {activeSeries?.seriesDescription ?? 'Viewer'}</span>
      </div>

      {browserPosition === 'top' && seriesBrowserPanel}

      <div className={viewerAppearance.showToolbar ? 'viewer-tool-ribbon' : 'viewer-tool-ribbon toolbar-hidden'} aria-label="Viewer tools" ref={ribbonRef}>
        <div className="ribbon-menu layout-ribbon">
          <button className={openMenu === 'layout' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} disabled={!hasPermission('viewer.layout.change')} type="button" title="Viewport Layout" aria-label="Viewport Layout" onClick={(event) => hasPermission('viewer.layout.change') && toggleMenu('layout', event.currentTarget)}>
            <LayoutGrid size={30} />
            <span>{viewportLayout}</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'layout' && <div className="ribbon-dropdown layout-dropdown" style={dropdownStyle}>
            {layoutOptions.map((layout) => (
              <button
                className={viewportLayout === layout.id ? 'ribbon-option active layout-option' : 'ribbon-option layout-option'}
                key={layout.id}
                type="button"
                onClick={() => {
                  setTileFormatsByViewport({})
                  setViewportLayout(layout.id)
                  setOpenMenu(null)
                }}
              >
                <span className={`layout-option-icon layout-option-${layout.id}`}>
                  {Array.from({ length: Number(layout.id[0]) * Number(layout.id[2]) }, (_, index) => <i key={index} />)}
                </span>
                {layout.label}
              </button>
            ))}
          </div>}
        </div>
        <div className="ribbon-menu tile-format-ribbon">
          <button
            className={openMenu === 'tile-format' || isTileFormatActive(selectedTileFormat) ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'}
            disabled={!hasPermission('viewer.layout.change') || !canUseTileFormat}
            type="button"
            title="Tile Format"
            aria-label="Tile Format"
            onClick={(event) => hasPermission('viewer.layout.change') && canUseTileFormat && toggleMenu('tile-format', event.currentTarget)}
          >
            <Grid3X3 size={30} />
            <span>{getTileFormatLabel(selectedTileFormat)}</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'tile-format' && <div className="ribbon-dropdown tile-format-dropdown" style={dropdownStyle}>
            {tileFormatOptions.map((format) => (
              <button
                className={selectedTileFormat === format.id ? 'ribbon-option active tile-format-option' : 'ribbon-option tile-format-option'}
                key={format.id}
                type="button"
                onClick={() => {
                  setTileFormatsByViewport((current) => ({ ...current, [selectedViewportKey]: format.id }))
                  setOpenMenu(null)
                }}
              >
                <span className={`tile-format-option-icon tile-format-option-${format.id}`} aria-hidden="true">
                  {Array.from({ length: format.id === 'auto' ? 6 : Number(format.id) }, (_, index) => <i key={index} />)}
                </span>
                <span>{format.label}</span>
              </button>
            ))}
          </div>}
        </div>
        {viewerAppearance.showToolbar && <div className="ribbon-center-tools">
        {favoriteToolbarItems.map((tool) => {
          const Icon = tool.icon
          return (
            <button
              className={isToolbarMenuActionActive(tool.action) ? 'ribbon-tool active' : 'ribbon-tool'}
              key={tool.favoriteId}
              type="button"
              title={tool.label}
              aria-label={tool.label}
              onClick={() => runToolbarMenuAction(tool.action)}
            >
              <Icon size={30} />
              <span>{tool.label}</span>
            </button>
          )
        })}
        {groupedToolbarSections.map((section) => {
          const Icon = section.icon
          const menuId = `context:${section.title}`
          const hasActiveItem = section.items.some((item) => isToolbarMenuActionActive(item.action))

          return isToolbarFavorite(`context-group:${section.title}`) && section.items.length > 0 ? (
            <div className="ribbon-menu" key={section.title}>
              <button className={hasActiveItem || openMenu === menuId ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" title={section.title} aria-label={section.title} onClick={(event) => toggleMenu(menuId, event.currentTarget)}>
                <Icon size={30} />
                <span>{section.title}</span>
                <ChevronDown className="ribbon-chevron" size={15} />
              </button>
              {openMenu === menuId && <div className={section.title === 'Window Presets' ? 'ribbon-dropdown preset-dropdown' : 'ribbon-dropdown'} style={dropdownStyle}>
                {section.items.map((item) => {
                  const ItemIcon = item.icon
                  const presetMeta = item.id === 'lung'
                    ? { ww: 1500, wl: -600 }
                    : item.id === 'bone'
                      ? { ww: 2000, wl: 500 }
                      : item.id === 'brain'
                        ? { ww: 80, wl: 40 }
                        : item.id === 'mediastinum'
                          ? { ww: 350, wl: 50 }
                          : item.id === 'soft'
                            ? { ww: 400, wl: 40 }
                            : null
                  return (
                    <button className={`${isToolbarMenuActionActive(item.action) ? 'ribbon-option active' : 'ribbon-option'} ${presetMeta ? 'preset-inline-option' : ''}`} key={item.id} type="button" onClick={() => runToolbarMenuAction(item.action)}>
                      {!presetMeta && <ItemIcon size={20} />}
                      <span>{item.label}</span>
                      {presetMeta ? <small>WW {presetMeta.ww} / WL {presetMeta.wl}</small> : getMenuItemHotkey(item, hotkeyOverrides) && <kbd>{getMenuItemHotkey(item, hotkeyOverrides)}</kbd>}
                    </button>
                  )
                })}
                {section.title === 'Window Presets' && (
                  <>
                    {customWindowPresets.map(renderCustomWindowPreset)}
                    <div className="custom-preset-editor" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                      <div className="preset-section-label custom-preset-editor-title">Custom WW/WL</div>
                      <label>
                        <span>WW</span>
                        <input inputMode="numeric" aria-label="Custom window width" value={customPresetWw} onChange={(event) => updateCustomPresetWw(event.currentTarget.value)} />
                      </label>
                      <label>
                        <span>WL</span>
                        <input inputMode="numeric" aria-label="Custom window level" value={customPresetWl} onChange={(event) => updateCustomPresetWl(event.currentTarget.value)} />
                      </label>
                      <div className="custom-preset-actions">
                        <button type="button" onClick={handleApplyCustomWindowPreset}>Apply</button>
                        <button type="button" onClick={handleSaveCustomWindowPreset}>Save Preset</button>
                      </div>
                      {customPresetSaveDialogOpen && (
                        <div className="custom-preset-save-dialog">
                          <label>
                            <span>Preset name</span>
                            <input autoFocus aria-label="Preset name" value={customPresetName} onChange={(event) => updateCustomPresetName(event.currentTarget.value)} />
                          </label>
                          <div className="custom-preset-save-actions">
                            <button type="button" onClick={() => setCustomPresetSaveDialogOpen(false)}>Cancel</button>
                            <button type="button" onClick={handleConfirmSaveCustomWindowPreset}>Save</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>}
            </div>
          ) : null
        })}
        {hasPermission('viewer.intellilink.use') && isToolbarFavorite('intellilink') && canUseIntelliLink && <div className="ribbon-menu intellilink-ribbon">
          <button className={hasIntelliLink || openMenu === 'intellilink' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('intellilink', event.currentTarget)}>
            <Link2 size={30} />
            <span>IntelliLink</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'intellilink' && <div className="ribbon-dropdown intellilink-dropdown" style={dropdownStyle}>
            <button className={hasIntelliLink ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setAllIntelliLinkOptions(!hasIntelliLink); setOpenMenu(null) }}><Link2 size={23} />All</button>
            <button className={intelliLink.scroll ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('scroll', !intelliLink.scroll); setOpenMenu(null) }}><Blinds size={23} />Scroll</button>
            <button className={intelliLink.windowLevel ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('windowLevel', !intelliLink.windowLevel); setOpenMenu(null) }}><Contrast size={23} />WW/WL</button>
            <button className={intelliLink.pan ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('pan', !intelliLink.pan); setOpenMenu(null) }}><Move size={23} />Pan</button>
            <button className={intelliLink.zoom ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('zoom', !intelliLink.zoom); setOpenMenu(null) }}><ZoomIn size={23} />Zoom</button>
          </div>}
        </div>}
        {volume3dMode && <button className={activeTool === 'Rotate3D' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" title="3D Rotate" aria-label="3D Rotate" onClick={() => activateTool('Rotate3D')}>
          <Rotate3d size={30} />
          <span>3D Rotate</span>
        </button>}
        </div>}
        {false && viewerAppearance.showToolbar && <>
        {isToolbarFavorite('scroll') && <button className={activeTool === 'Scroll' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" title="Scroll" aria-label="Scroll" onClick={() => activateTool('Scroll')}>
          <Blinds size={31} />
          <span>Scroll</span>
        </button>}
        {isToolbarFavorite('window-level') && <button className={activeTool === 'WindowLevel' ? 'ribbon-tool featured active' : 'ribbon-tool featured'} type="button" title="Window Level" aria-label="Window Level" onClick={() => activateTool('WindowLevel')}>
          <Contrast size={34} />
          <span>WW/WL</span>
        </button>}
        <span className="ribbon-separator" />
        {isToolbarFavorite('zoom') && <button className={activeTool === 'Zoom' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" title="Zoom" aria-label="Zoom" onClick={() => activateTool('Zoom')}>
          <ZoomIn size={33} />
          <span>Zoom</span>
        </button>}
        {isToolbarFavorite('pan') && <button className={activeTool === 'Pan' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" title="Pan" aria-label="Pan" onClick={() => activateTool('Pan')}>
          <Move size={31} />
          <span>Pan</span>
        </button>}
        {favoriteMeasurementTools.map((tool) => {
          const Icon = tool.icon
          return (
            <button className={activeTool === tool.id ? 'ribbon-tool active' : 'ribbon-tool'} key={tool.favoriteId} type="button" title={tool.label} aria-label={tool.label} onClick={() => activateTool(tool.id)}>
              <Icon size={30} />
              <span>{tool.label}</span>
            </button>
          )
        })}
        {favoriteSpatialTools.map((tool) => {
          const Icon = tool.icon
          return (
            <button className="ribbon-tool" key={tool.favoriteId} type="button" title={tool.label} aria-label={tool.label} onClick={() => selectSpatialTool(tool.id)}>
              <Icon size={30} />
              <span>{tool.label}</span>
            </button>
          )
        })}
        {favoriteUtilityTools.map((tool) => {
          const Icon = tool.icon
          return (
            <button className={isUtilityToolActive(tool.id) ? 'ribbon-tool active' : 'ribbon-tool'} key={tool.favoriteId} type="button" title={tool.label} aria-label={tool.label} onClick={() => selectUtilityTool(tool.id)}>
              <Icon size={30} />
              <span>{tool.label}</span>
            </button>
          )
        })}
        {isToolbarFavorite('layout') && <div className="ribbon-menu layout-ribbon">
          <button className={openMenu === 'layout' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('layout', event.currentTarget)}>
            <LayoutGrid size={30} />
            <span>{viewportLayout}</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'layout' && <div className="ribbon-dropdown layout-dropdown" style={dropdownStyle}>
            {layoutOptions.map((layout) => (
              <button
                className={viewportLayout === layout.id ? 'ribbon-option active layout-option' : 'ribbon-option layout-option'}
                key={layout.id}
                type="button"
                onClick={() => {
                  setTileFormatsByViewport({})
                  setViewportLayout(layout.id)
                  setOpenMenu(null)
                }}
              >
                <span className={`layout-option-icon layout-option-${layout.id}`}>
                  {Array.from({ length: Number(layout.id[0]) * Number(layout.id[2]) }, (_, index) => <i key={index} />)}
                </span>
                {layout.label}
              </button>
            ))}
          </div>}
        </div>}
        {isToolbarFavorite('spatial') && groupedSpatialTools.length > 0 && <div className="ribbon-menu spatial-ribbon">
          <button className={openMenu === 'spatial' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('spatial', event.currentTarget)}>
            <Maximize2 size={30} />
            <span>Spatial</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'spatial' && <div className="ribbon-dropdown spatial-dropdown" style={dropdownStyle}>
            {groupedSpatialTools.map((tool, index) => {
              const Icon = tool.icon
              return (
                <button
                  className={`${'featured' in tool && tool.featured ? 'ribbon-option featured' : 'ribbon-option'} ${index === 5 || index === 9 ? 'section-start' : ''}`}
                  disabled={'disabled' in tool && tool.disabled}
                  key={tool.id}
                  type="button"
                  onClick={() => selectSpatialTool(tool.id)}
                >
                  <Icon size={20} />
                  <span>{tool.label}</span>
                </button>
              )
            })}
          </div>}
        </div>}
        {isToolbarFavorite('measure') && groupedMeasurementTools.length > 0 && <div className="ribbon-menu measure-ribbon">
          <button className={groupedActiveMeasurementTool || openMenu === 'measure' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('measure', event.currentTarget)}>
            <MeasurementIcon size={30} />
            <span>{groupedActiveMeasurementTool?.label ?? 'Measure'}</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'measure' && <div className="ribbon-dropdown measure-dropdown" style={dropdownStyle}>
            {groupedMeasurementTools.map((tool) => {
              const Icon = tool.icon
              return (
                <button className={activeTool === tool.id ? 'ribbon-option active' : 'ribbon-option'} key={tool.id} type="button" onClick={() => selectTool(tool.id)}>
                  <Icon size={25} />
                  {tool.label}
                </button>
              )
            })}
          </div>}
        </div>}
        <div className="ribbon-context-group" aria-label="Context tools">
          {isToolbarFavorite('mpr') && <button
            aria-hidden={!showMprButton}
            className={`${mprMode ? 'ribbon-tool active' : 'ribbon-tool'} ${showMprButton ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!showMprButton}
            tabIndex={showMprButton ? 0 : -1}
            type="button"
            title="MPR"
            aria-label="MPR"
            onClick={() => toggleMprMode()}
          >
            <Box size={30} />
            <span>MPR</span>
          </button>}
          {isToolbarFavorite('3d-cursor') && <button
            aria-hidden={!mprMode}
            className={`${activeTool === 'Stack3DCursor' ? 'ribbon-tool active' : 'ribbon-tool'} ${mprMode ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!mprMode}
            tabIndex={mprMode ? 0 : -1}
            type="button"
            title="3D Cursor"
            aria-label="3D Cursor"
            onClick={() => activateTool('Stack3DCursor')}
          >
            <Crosshair size={30} />
            <span>3D Cursor</span>
          </button>}
          {isToolbarFavorite('3d') && <button
            aria-hidden={!show3dButton}
            className={`${volume3dViewport?.key === selectedViewportKey ? 'ribbon-tool active' : 'ribbon-tool'} ${show3dButton ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!show3dButton}
            tabIndex={show3dButton ? 0 : -1}
            type="button"
            title="3D"
            aria-label="3D"
            onClick={() => toggle3dMode()}
          >
            <Skull size={30} />
          <span>3D Oblique</span>
          </button>}
          <button
            aria-hidden={!volume3dMode}
            className={`${activeTool === 'Rotate3D' ? 'ribbon-tool active' : 'ribbon-tool'} ${volume3dMode ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!volume3dMode}
            tabIndex={volume3dMode ? 0 : -1}
            type="button"
            title="3D Rotate"
            aria-label="3D Rotate"
            onClick={() => activateTool('Rotate3D')}
          >
            <Rotate3d size={30} />
            <span>3D Rotate</span>
          </button>
          {isToolbarFavorite('crosshair') && <button
            aria-hidden={!mprMode}
            className={`${activeTool === 'Crosshairs' ? 'ribbon-tool active' : 'ribbon-tool'} ${mprMode ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!mprMode}
            tabIndex={mprMode ? 0 : -1}
            type="button"
            title="Crosshair"
            aria-label="Crosshair"
            onClick={() => activateTool('Crosshairs')}
          >
            <Plus size={30} />
            <span>Crosshair</span>
          </button>}
        </div>
        {isToolbarFavorite('intellilink') && canUseIntelliLink && <div className="ribbon-menu intellilink-ribbon">
          <button className={hasIntelliLink || openMenu === 'intellilink' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('intellilink', event.currentTarget)}>
            <Link2 size={30} />
            <span>IntelliLink</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'intellilink' && <div className="ribbon-dropdown intellilink-dropdown" style={dropdownStyle}>
            <button className={hasIntelliLink ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setAllIntelliLinkOptions(!hasIntelliLink); setOpenMenu(null) }}><Link2 size={23} />All</button>
            <button className={intelliLink.scroll ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('scroll', !intelliLink.scroll); setOpenMenu(null) }}><Blinds size={23} />Scroll</button>
            <button className={intelliLink.windowLevel ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('windowLevel', !intelliLink.windowLevel); setOpenMenu(null) }}><Contrast size={23} />WW/WL</button>
            <button className={intelliLink.pan ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('pan', !intelliLink.pan); setOpenMenu(null) }}><Move size={23} />Pan</button>
            <button className={intelliLink.zoom ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setIntelliLinkOption('zoom', !intelliLink.zoom); setOpenMenu(null) }}><ZoomIn size={23} />Zoom</button>
          </div>}
        </div>}
        {isToolbarFavorite('tools') && groupedUtilityTools.length > 0 && <div className="ribbon-menu utility-ribbon">
          <button className={activeUtilityTool ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('tools', event.currentTarget)}>
            <UtilityIcon size={30} />
            <span>{activeUtilityTool?.label ?? 'Tools'}</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'tools' && <div className="ribbon-dropdown utility-dropdown" style={dropdownStyle}>
            {groupedUtilityTools.map((tool) => {
              const Icon = tool.icon
              return (
                <button className={isUtilityToolActive(tool.id) ? 'ribbon-option active' : 'ribbon-option'} key={tool.id} type="button" onClick={() => selectUtilityTool(tool.id)}>
                  <Icon size={25} />
                  {tool.label}
                </button>
              )
            })}
          </div>}
        </div>}
        {isToolbarFavorite('preset') && showPreset && (
          <div className="ribbon-menu preset-ribbon">
            <button className={openMenu === 'preset' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" onClick={(event) => toggleMenu('preset', event.currentTarget)}>
              <Blend size={30} />
              <span>Preset</span>
              <ChevronDown className="ribbon-chevron" size={15} />
            </button>
            {openMenu === 'preset' && <div className="ribbon-dropdown preset-dropdown" style={dropdownStyle}>
              {renderBuiltinWindowPreset('Lung', 1500, -600, 'preset-lung')}
              {renderBuiltinWindowPreset('Bone', 2000, 500, 'preset-bone')}
              {renderBuiltinWindowPreset('Brain', 80, 40, 'preset-brain')}
              {renderBuiltinWindowPreset('Mediastinum', 350, 50, 'preset-mediastinum')}
              {renderBuiltinWindowPreset('Soft Tissue', 400, 40, 'preset-soft')}
              {customWindowPresets.map(renderCustomWindowPreset)}
              <div className="custom-preset-editor" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                <div className="preset-section-label custom-preset-editor-title">Custom WW/WL</div>
                <label>
                  <span>WW</span>
                  <input inputMode="numeric" aria-label="Custom window width" value={customPresetWw} onChange={(event) => updateCustomPresetWw(event.currentTarget.value)} />
                </label>
                <label>
                  <span>WL</span>
                  <input inputMode="numeric" aria-label="Custom window level" value={customPresetWl} onChange={(event) => updateCustomPresetWl(event.currentTarget.value)} />
                </label>
                <div className="custom-preset-actions">
                  <button type="button" onClick={handleApplyCustomWindowPreset}>Apply</button>
                  <button type="button" onClick={handleSaveCustomWindowPreset}>Save Preset</button>
                </div>
                {customPresetSaveDialogOpen && (
                  <div className="custom-preset-save-dialog">
                    <label>
                      <span>Preset name</span>
                      <input autoFocus aria-label="Preset name" value={customPresetName} onChange={(event) => updateCustomPresetName(event.currentTarget.value)} />
                    </label>
                    <div className="custom-preset-save-actions">
                      <button type="button" onClick={() => setCustomPresetSaveDialogOpen(false)}>Cancel</button>
                      <button type="button" onClick={handleConfirmSaveCustomWindowPreset}>Save</button>
                    </div>
                  </div>
                )}
              </div>
            </div>}
          </div>
        )}
        </>}
        {hasPermission('viewer.export.use') && (
          <button
            className={exportDialogOpen ? 'ribbon-tool active' : 'ribbon-tool'}
            disabled={!activeStudy}
            type="button"
            title="Export"
            aria-label="Export"
            onClick={() => openExportCenter()}
          >
            <FileOutput size={30} />
            <span>Export</span>
          </button>
        )}
        <div className="ribbon-menu settings-ribbon">
          {(hasPermission('settings.toolbar.customize') || hasPermission('settings.appearance.customize') || hasPermission('settings.hotkeys.customize')) && <button className={isSettingsOpen ? 'ribbon-tool active' : 'ribbon-tool'} type="button" title="Settings" aria-label="Settings" onClick={() => { setOpenMenu(null); setIsSettingsOpen(true) }}>
            <Cog size={30} />
            <span>Settings</span>
          </button>}
        </div>
      </div>

      {browserPosition === 'below-toolbar' && seriesBrowserPanel}

      <div className="viewer-stage">
          <div className={`viewport-grid layout-${viewportLayout}${fullscreenViewportKey ? ' viewport-grid-fullscreen' : ''}`}>
            {viewportKeys.map((key) => {
              const viewportStack = viewportStacks[key]
              const viewportWaveform = viewportWaveforms[key]
              const viewportVideo = viewportVideos[key]
              const viewportReport = viewportReports[key]
              const viewportSavedObject = viewportSavedObjects[key]
              const viewportIchSegmentation = viewportIchSegmentations[key]
              const hasWaveform = Boolean(viewportWaveform)
              const hasVideo = Boolean(viewportVideo)
              const hasReport = Boolean(viewportReport)
              const hasSavedObject = Boolean(viewportSavedObject)
              const hasImages = !hasWaveform && !hasVideo && !hasReport && !hasSavedObject && Boolean(viewportStack?.imageIds.length)
              const viewportStudyColor = viewportStack?.series.studyColor ?? viewportWaveform?.series.studyColor ?? viewportVideo?.series.studyColor ?? viewportReport?.series.studyColor
              const imageCount = viewportStack?.imageIds.length ?? 0
              const imageIndex = Math.min((viewportSliceIndexes[key] ?? 0) + 1, imageCount)
              const windowLevel = viewportWindowLevels[key]
              const metadata = getSelectedMetadata(viewportStack, viewportSliceIndexes[key] ?? 0)
              const inferredSliceSpacing = getInferredSliceSpacing(viewportStack?.instances, viewportSliceIndexes[key] ?? 0)
              const overlayInfo = buildViewportOverlayInfo({
                study: activeStudy,
                series: viewportStack?.series ?? activeSeries,
                metadata,
                imageIndex,
                imageCount,
                windowLevel,
                zoom: viewportZooms[key] ?? 1,
                inferredSliceSpacing,
                overlayConfig: viewerOverlayConfig,
              })
              const isVolume3dTile = volume3dViewport?.key === key
              const viewportModality = viewportStack?.series.modality?.toUpperCase()
              const suppressViewerOverlay = viewportModality === 'SC'
              const isMprTile = Boolean(mprMode && useViewerStore.getState().mprViewportKeys[key] && (viewportModality === 'CT' || viewportModality === 'MR'))
              const isIchMprWorkspaceTile = Boolean(ichMprViewportKeys[key])
              const isFullscreenTile = fullscreenViewportKey === key
              const tileFormat = tileFormatsByViewport[key] ?? '1'
              const isTileFormat = hasImages
                && isTileFormatActive(tileFormat)
                && !isMprTile
                && !isVolume3dTile
              const useServerRenderedStack = serverRenderMode
                && hasImages
                && !isMprTile
                && !isVolume3dTile
                && ['CT', 'MR', 'CR', 'DX', 'DR', 'XA', 'MG'].includes(viewportModality ?? '')
              const isPrintSelected = printSelectedViewportKeys.includes(key)

              return (
                <div
                  className={`${selectedViewportKey === key || isPrintSelected ? 'viewport-tile selected' : 'viewport-tile'}${isVolume3dTile ? ' volume-3d' : ''}${isMprTile ? ' volume-mpr' : ''}${isFullscreenTile ? ' fullscreen' : ''}${fullscreenViewportKey && !isFullscreenTile ? ' fullscreen-hidden' : ''}`}
                  data-viewport-key={key}
                  key={key}
                  onPointerDownCapture={(event) => {
                    if (event.button !== 0) return
                    const eventTarget = event.target
                    if (eventTarget instanceof Element && eventTarget.closest('button, input, select, textarea, a, .cine-control-panel, .viewport-context-menu, .ich-segmentation-panel')) return
                    const additive = event.ctrlKey || event.metaKey
                    if (!additive) {
                      setPrintSelectedViewportKeys([key])
                      viewportSelectionPointerRef.current = null
                      return
                    }
                    viewportSelectionPointerRef.current = {
                      viewportKey: key,
                      clientX: event.clientX,
                      clientY: event.clientY,
                      additive,
                    }
                  }}
                  onPointerUpCapture={(event) => {
                    const start = viewportSelectionPointerRef.current
                    viewportSelectionPointerRef.current = null
                    if (!start?.additive || start.viewportKey !== key) return
                    if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 6) return
                    setPrintSelectedViewportKeys((current) => current.includes(key)
                      ? current.length > 1 ? current.filter((viewportKey) => viewportKey !== key) : current
                      : [...current, key])
                  }}
                  onPointerCancelCapture={() => {
                    viewportSelectionPointerRef.current = null
                  }}
                  onDragOver={(event) => {
                    if (hasPermission('viewer.series.drag_drop') && event.dataTransfer.types.includes('application/nexia-series')) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'copy'
                    }
                  }}
                  onDrop={(event) => handleSeriesDrop(event, key)}
                >
                  {isMprTile && viewportStack ? (
                    proxyMprMode && !isIchMprWorkspaceTile ? <LocalProxyMprViewer
                      series={viewportStack.series}
                      study={activeStudy}
                      viewportKey={key}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                      onToggleViewportFullscreen={() => {
                        setSelectedViewportKey(key)
                        setFullscreenViewportKey((current) => current === key ? null : key)
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                      initialWindowLevel={windowLevel}
                    /> : serverMprMode && !isIchMprWorkspaceTile ? <ServerMprViewer
                      series={viewportStack.series}
                      study={activeStudy}
                      viewportKey={key}
                      isSelected={selectedViewportKey === key}
                      showOverlay={false}
                      onSelect={() => setSelectedViewportKey(key)}
                      onToggleViewportFullscreen={() => {
                        setSelectedViewportKey(key)
                        setFullscreenViewportKey((current) => current === key ? null : key)
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                      initialWindowLevel={windowLevel}
                    /> : <MprViewer
                      series={viewportStack.series}
                      study={activeStudy}
                      viewportKey={key}
                      isSelected={selectedViewportKey === key}
                      showOverlay={false}
                      contextMenuEnabled={viewerAppearance.contextMenuEnabled}
                      onToggleOverlay={() => setShowOverlay((value) => !value)}
                      onOpenTagBrowser={() => setIsTagBrowserOpen(true)}
                      onToggleMpr={() => toggleMprMode(key)}
                      onToggle3d={() => toggle3dMode(key)}
                      onToggle3dBone={() => toggle3dMode(key, 'bone')}
                      onOpenAmbientTest={() => setIsAmbientTestOpen(true)}
                      onSelect={() => setSelectedViewportKey(key)}
                      onToggleViewportFullscreen={() => {
                        setSelectedViewportKey(key)
                        setFullscreenViewportKey((current) => current === key ? null : key)
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                      onExitIchWorkspace={() => {
                        setIchMprWorkspace(key, false)
                        setMprMode(false, key)
                        setFullscreenViewportKey((current) => current === key ? null : current)
                        setActiveTool('WindowLevel')
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                      initialIchSegmentation={viewportIchSegmentation ? {
                        arrayBuffer: viewportIchSegmentation.arrayBuffer,
                        sopInstanceUid: viewportIchSegmentation.instance.sopInstanceUid,
                      } : null}
                      initialWindowLevel={windowLevel}
                    />
                  ) : isVolume3dTile ? (
                    <Bone3DViewer
                      series={volume3dViewport!.series}
                      viewportKey={key}
                      mode={volume3dViewport!.mode}
                      onSelect={() => setSelectedViewportKey(key)}
                      onToggleOverlay={() => setShowOverlay((value) => !value)}
                      onOpenTagBrowser={() => setIsTagBrowserOpen(true)}
                      onToggleMpr={() => toggleMprMode(key)}
                      onToggle3d={() => toggle3dMode(key)}
                      onToggle3dBone={() => toggle3dMode(key, 'bone')}
                      onOpenAmbientTest={() => setIsAmbientTestOpen(true)}
                      onToggleViewportFullscreen={() => {
                        setSelectedViewportKey(key)
                        setFullscreenViewportKey((current) => current === key ? null : key)
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                    />
                  ) : hasSavedObject && viewportSavedObject ? (
                    <SavedDicomObjectViewport
                      item={viewportSavedObject}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                    />
                  ) : hasReport && viewportReport ? (
                    <StructuredReportViewport
                      report={viewportReport.report}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                    />
                  ) : hasVideo && viewportVideo ? (
                    <DicomVideoViewport
                      viewportKey={key}
                      study={activeStudy}
                      series={viewportVideo.series}
                      instance={viewportVideo.instance}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                    />
                  ) : hasWaveform && viewportWaveform ? (
                    <EcgWaveformViewport
                      waveform={viewportWaveform.waveform}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                    />
                  ) : isTileFormat && viewportStack ? (
                    <TileFormatViewport
                      instances={viewportStack.instances}
                      study={activeStudy}
                      series={viewportStack.series}
                      tileFormat={tileFormat}
                      activeSliceIndex={viewportSliceIndexes[key] ?? 0}
                      windowLevel={windowLevel}
                      showOverlay={showOverlay && !suppressViewerOverlay}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                      onSelectSlice={(sliceIndex) => {
                        setSelectedViewportKey(key)
                        setViewportSliceIndex(key, sliceIndex)
                      }}
                      onOpenSliceFullscreen={(sliceIndex) => {
                        setSelectedViewportKey(key)
                        setViewportSliceIndex(key, sliceIndex)
                        setTileFormatsByViewport((current) => ({ ...current, [key]: '1' }))
                        setFullscreenViewportKey(key)
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                      onToggleViewportFullscreen={() => {
                        setSelectedViewportKey(key)
                        setFullscreenViewportKey((current) => current === key ? null : key)
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                    />
                  ) : (
                    <DicomViewport
                      viewportKey={key}
                      imageIds={viewportStack?.imageIds ?? []}
                      study={activeStudy}
                      series={viewportStack?.series ?? null}
                      instances={viewportStack?.instances ?? []}
                      modality={viewportStack?.series.modality ?? ''}
                      isSelected={selectedViewportKey === key}
                      referenceLinesEnabled={referenceLinesEnabled}
                      contextMenuEnabled={viewerAppearance.contextMenuEnabled}
                      disableBackgroundVolumePrepare={useServerRenderedStack}
                      diagnosticOnly={diagnosticViewerMode}
                      onReady={handleStackViewportReady}
                      onToggleOverlay={() => setShowOverlay((value) => !value)}
                      onOpenTagBrowser={() => setIsTagBrowserOpen(true)}
                      onOpenIchMprWorkspace={() => openIchMprWorkspace(key)}
                      onToggleMpr={() => {
                        toggleMprMode(key)
                      }}
                      onToggle3d={() => {
                        setSelectedViewportKey(key)
                        toggle3dMode(key)
                      }}
                      onToggle3dBone={() => {
                        setSelectedViewportKey(key)
                        toggle3dMode(key, 'bone')
                      }}
                      onOpenAmbientTest={() => setIsAmbientTestOpen(true)}
                      onSelect={() => setSelectedViewportKey(key)}
                      onToggleViewportFullscreen={() => {
                        setSelectedViewportKey(key)
                        setFullscreenViewportKey((current) => current === key ? null : key)
                        window.requestAnimationFrame(() => {
                          window.dispatchEvent(new CustomEvent('vexa-viewer-layout-resized'))
                        })
                      }}
                    />
                  )}
                  {showOverlay && !suppressViewerOverlay && !isMprTile && !isTileFormat && hasImages && (
                    <div className="viewport-overlay top-left">
                      {overlayInfo.topLeft.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                  )}
                  {showOverlay && !suppressViewerOverlay && !isMprTile && !isTileFormat && hasImages && !isVolume3dTile && (
                    <div className="viewport-overlay top-right">
                      {overlayInfo.topRight.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                  )}
                  {!suppressViewerOverlay && !isMprTile && !isTileFormat && viewportStudyColor && (
                    <span className="viewport-study-dot" style={{ backgroundColor: viewportStudyColor }} />
                  )}
                  {showOverlay && !suppressViewerOverlay && !isMprTile && !isTileFormat && hasImages && (
                    <>
                    <div className="viewport-overlay bottom-left">
                      {overlayInfo.bottomLeft.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                    <div className="viewport-overlay bottom-right viewport-image-info">
                      {overlayInfo.bottomRight.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                    </>
                  )}
                  {activeTool === 'Zoom' && selectedViewportKey === key && !isTileFormat && hasImages && (
                    <div className="viewport-zoom-control" aria-label="Zoom control">
                      <input
                        aria-label="Zoom image"
                        className="viewport-zoom-slider"
                        max={8}
                        min={0.2}
                        step={0.05}
                        type="range"
                        value={Math.min(Math.max(viewportZooms[key] ?? 1, 0.2), 8)}
                        onChange={(event) => sendViewportCommand('set-zoom', key, { zoom: Number(event.currentTarget.value) })}
                        onContextMenu={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onPointerUp={(event) => event.stopPropagation()}
                        onTouchStart={(event) => event.stopPropagation()}
                      />
                      <span className="viewport-zoom-icon minus" aria-hidden="true">-</span>
                      <span className="viewport-zoom-icon plus" aria-hidden="true">+</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        {(loadingMessage || errorMessage) && (
          <div className={errorMessage ? 'viewer-status error' : 'viewer-status'}>
            {errorMessage ? <AlertTriangle size={18} /> : <Loader2 className="spin" size={18} />}
            <span>{errorMessage || loadingMessage}</span>
            {errorMessage && (
              <>
                <button className="viewer-status-retry" type="button" onClick={() => window.location.reload()}>
                  <RefreshCw size={14} />
                  <span>Reload</span>
                </button>
                <button className="viewer-status-close" type="button" aria-label="Dismiss message" onClick={() => { clearTransientErrorTimer(); setErrorMessage('') }}>
                  <X size={14} />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {browserPosition === 'bottom' && seriesBrowserPanel}

      {isTagBrowserOpen && <DicomTagBrowser metadata={getSelectedMetadata(selectedStack, viewportSliceIndexes[selectedViewportKey] ?? 0)} onClose={() => setIsTagBrowserOpen(false)} />}
      {isAmbientTestOpen && <AmbientLightTestModal onClose={() => setIsAmbientTestOpen(false)} />}
      {renderViewportCaptureDialog()}
      {isSettingsOpen && (
        <ViewerSettingsDialog
          favorites={toolbarFavorites}
          appearance={viewerAppearance}
          hotkeyOverrides={hotkeyOverrides}
          hasPermission={hasPermission}
          onChange={setToolbarFavorites}
          onAppearanceChange={setViewerAppearance}
          onHotkeyOverridesChange={setHotkeyOverrides}
          onResetDefaults={() => window.dispatchEvent(new CustomEvent('vexa-viewer-reset-preferences'))}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </section>
  )
}

function isCaptureElementVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return rect.width > 1
    && rect.height > 1
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity || 1) > 0
}

function hasCaptureCanvas(element: HTMLElement) {
  return element.querySelector('canvas:not([data-vexa-progressive-preview]), canvas') instanceof HTMLCanvasElement
}

async function freezeViewportForExport(element: HTMLElement, render: ViewerExportRequest['render']) {
  const freezeFrame = await renderSecondaryCaptureCanvas(element, undefined, {
    targetLongEdge: 1024,
    cropToContent: false,
    includeTextOverlay: render.includeTextOverlay,
    includeAnnotations: render.includeAnnotations,
    includeMasks: render.includeMasks,
    anonymize: render.anonymize,
    trueSize: false,
    nativeImage: null,
  })
  freezeFrame.className = 'viewport-export-freeze'
  freezeFrame.setAttribute('aria-hidden', 'true')
  element.append(freezeFrame)

  return () => freezeFrame.remove()
}

function collectPdfTextOverlay(sourceElement: HTMLElement): PdfTextOverlay {
  const overlay: PdfTextOverlay = {
    topLeft: [],
    topRight: [],
    bottomLeft: [],
    bottomRight: [],
  }
  const sourceRect = sourceElement.getBoundingClientRect()
  const labels = Array.from(sourceElement.querySelectorAll<HTMLElement>('.viewport-overlay span, .mpr-overlay span'))

  labels.forEach((label) => {
    const text = label.textContent?.trim()
    const style = window.getComputedStyle(label)
    const rect = label.getBoundingClientRect()
    if (!text || rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') {
      return
    }

    const block = label.closest<HTMLElement>('.viewport-overlay')
    if (block?.classList.contains('top-left')) {
      overlay.topLeft.push(text)
    } else if (block?.classList.contains('top-right')) {
      overlay.topRight.push(text)
    } else if (block?.classList.contains('bottom-left')) {
      overlay.bottomLeft.push(text)
    } else if (block?.classList.contains('bottom-right')) {
      overlay.bottomRight.push(text)
    } else {
      const horizontal = rect.left + rect.width / 2 < sourceRect.left + sourceRect.width / 2 ? 'Left' : 'Right'
      const vertical = rect.top + rect.height / 2 < sourceRect.top + sourceRect.height / 2 ? 'top' : 'bottom'
      overlay[`${vertical}${horizontal}` as keyof PdfTextOverlay].push(text)
    }
  })

  return overlay
}

function clampIndex(index: number, itemCount: number) {
  if (itemCount <= 0) return 0
  return Math.min(Math.max(Math.round(index), 0), itemCount - 1)
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
}

async function waitForViewportRender(element?: HTMLElement) {
  if (!element) {
    await nextAnimationFrame()
    await nextAnimationFrame()
    return
  }
  await Promise.race([
    new Promise<void>((resolve) => element.addEventListener(Enums.Events.IMAGE_RENDERED, () => resolve(), { once: true })),
    new Promise<void>((resolve) => window.setTimeout(resolve, 90)),
  ])
  await nextAnimationFrame()
}

function loadViewerAppearance(): ViewerAppearance {
  return normalizeViewerAppearance()
}

type LegacyViewerAppearance = Partial<ViewerAppearance> & {
  browserPlacement?: ViewerAppearance['browserPosition']
}

function normalizeViewerAppearance(appearance?: LegacyViewerAppearance): ViewerAppearance {
  const browserPosition = appearance?.browserPosition ?? appearance?.browserPlacement
  const validBrowserPosition = browserPosition === 'top' || browserPosition === 'below-toolbar' || browserPosition === 'bottom'

  return {
    showToolbar: typeof appearance?.showToolbar === 'boolean' ? appearance.showToolbar : defaultViewerAppearance.showToolbar,
    contextMenuEnabled: typeof appearance?.contextMenuEnabled === 'boolean' ? appearance.contextMenuEnabled : defaultViewerAppearance.contextMenuEnabled,
    browserPosition: validBrowserPosition ? browserPosition : defaultViewerAppearance.browserPosition,
  }
}

function sanitizeToolbarFavorites(favorites?: ToolbarFavoriteId[]) {
  if (!favorites) return defaultToolbarFavorites
  const stored = [...new Set(favorites.map((id) => toolbarFavoriteAliases.get(id) ?? id))]
  const validIds = new Set<ToolbarFavoriteId>([
    ...toolbarGroupFavoriteOptions.map((tool) => tool.id),
    ...toolbarItemFavoriteOptions.map((tool) => tool.favoriteId),
    ...measurementToolbarFavoriteOptions.map((tool) => tool.favoriteId),
    ...spatialToolbarFavoriteOptions.map((tool) => tool.favoriteId),
    ...utilityToolbarFavoriteOptions.map((tool) => tool.favoriteId),
  ])
  const validFavorites = stored.filter((id): id is ToolbarFavoriteId => validIds.has(id as ToolbarFavoriteId))
  const usesCurrentGrouping = validFavorites.some((id) => id.startsWith('context-group:') || id.startsWith('context-item:'))
  return usesCurrentGrouping ? validFavorites : defaultToolbarFavorites
}

function ViewerSettingsDialog({
  favorites,
  appearance,
  hotkeyOverrides,
  hasPermission,
  onChange,
  onAppearanceChange,
  onHotkeyOverridesChange,
  onResetDefaults,
  onClose,
}: {
  favorites: ToolbarFavoriteId[]
  appearance: ViewerAppearance
  hotkeyOverrides: Record<string, string>
  hasPermission: (permission: PermissionId) => boolean
  onChange: (favorites: ToolbarFavoriteId[]) => void
  onAppearanceChange: (appearance: ViewerAppearance) => void
  onHotkeyOverridesChange: (overrides: Record<string, string>) => void
  onResetDefaults: () => void
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<'toolbar' | 'appearance' | 'hotkeys'>(() => {
    if (hasPermission('settings.toolbar.customize')) return 'toolbar'
    if (hasPermission('settings.hotkeys.customize')) return 'hotkeys'
    return 'appearance'
  })
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function toggleFavorite(toolId: ToolbarFavoriteId) {
    onChange(favorites.includes(toolId)
      ? favorites.filter((favorite) => favorite !== toolId)
      : [...favorites, toolId])
  }

  function setToolHotkey(toolId: string, hotkey: string) {
    const nextOverrides = { ...hotkeyOverrides }

    viewportMenuSections.forEach((section) => {
      section.items.forEach((item) => {
        if (item.id !== toolId && getMenuItemHotkey(item, nextOverrides).toLowerCase() === hotkey.toLowerCase()) {
          nextOverrides[item.id] = ''
        }
      })
    })

    nextOverrides[toolId] = hotkey
    onHotkeyOverridesChange(nextOverrides)
  }

  function captureToolHotkey(event: React.KeyboardEvent<HTMLInputElement>, toolId: string) {
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      event.currentTarget.blur()
      return
    }

    if (event.key === 'Backspace') {
      setToolHotkey(toolId, '')
      return
    }

    if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) {
      return
    }

    setToolHotkey(toolId, toHotkey(event.nativeEvent))
  }

  function resetDefaults() {
    onChange(defaultToolbarFavorites)
    onAppearanceChange(defaultViewerAppearance)
    onHotkeyOverridesChange({})
    onResetDefaults()
  }

  return (
    <div className="viewer-settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="viewer-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="viewer-settings-title">
        <header className="viewer-settings-header">
          <div>
            <h2 id="viewer-settings-title">Settings</h2>
          </div>
          <button className="viewer-settings-close" type="button" aria-label="Close settings" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <nav className="viewer-settings-tabs" aria-label="Settings sections">
          {hasPermission('settings.toolbar.customize') && <button className={activeTab === 'toolbar' ? 'active' : ''} type="button" onClick={() => setActiveTab('toolbar')}>Toolbar</button>}
          {hasPermission('settings.hotkeys.customize') && <button className={activeTab === 'hotkeys' ? 'active' : ''} type="button" onClick={() => setActiveTab('hotkeys')}>Hotkeys</button>}
          {hasPermission('settings.appearance.customize') && <button className={activeTab === 'appearance' ? 'active' : ''} type="button" onClick={() => setActiveTab('appearance')}>Appearance</button>}
        </nav>
        {activeTab === 'toolbar' ? <div className="viewer-settings-content">
          <h3 className="viewer-settings-section-title">Toolbar Groups</h3>
          <div className="viewer-settings-toolbar-grid">
            {toolbarGroupFavoriteOptions.filter((tool) => tool.id === 'intellilink' ? hasPermission('viewer.intellilink.use') : getPermittedMenuSections(hasPermission, 'CT').some((section) => `context-group:${section.title}` === tool.id)).map((tool) => {
              const Icon = tool.icon
              return (
                <label className="viewer-settings-toolbar-item" key={tool.id}>
                  <input checked={favorites.includes(tool.id)} type="checkbox" onChange={() => toggleFavorite(tool.id)} />
                  <Icon size={18} />
                  <span>{tool.label}</span>
                </label>
              )
            })}
          </div>
          <h3 className="viewer-settings-section-title">Tool Items</h3>
          <div className="viewer-settings-toolbar-grid">
            {toolbarItemFavoriteOptions.filter((tool) => hasPermission(getMenuItemPermission(tool.id))).map((tool) => {
              const Icon = tool.icon
              return (
                <label className="viewer-settings-toolbar-item" key={tool.favoriteId}>
                  <input checked={favorites.includes(tool.favoriteId)} type="checkbox" onChange={() => toggleFavorite(tool.favoriteId)} />
                  <Icon size={18} />
                  <span>{tool.label}<small>{tool.sectionTitle}</small></span>
                </label>
              )
            })}
          </div>
        </div> : activeTab === 'hotkeys' ? <div className="viewer-settings-content viewer-settings-hotkeys">
          {getPermittedMenuSections(hasPermission, 'CT').map((section) => (
            <section className="viewer-hotkey-section" key={section.title}>
              <h3 className="viewer-settings-section-title">{section.title}</h3>
              <div className="viewer-hotkey-list">
                {section.items.map((item) => {
                  const Icon = item.icon
                  return (
                    <label className="viewer-hotkey-item" key={item.id}>
                      <Icon size={17} />
                      <span>{item.label}</span>
                      <input
                        aria-label={`${item.label} hotkey`}
                        placeholder="Unassigned"
                        readOnly
                        value={getMenuItemHotkey(item, hotkeyOverrides)}
                        onKeyDown={(event) => captureToolHotkey(event, item.id)}
                      />
                      <button type="button" title={`Clear ${item.label} hotkey`} aria-label={`Clear ${item.label} hotkey`} onClick={() => setToolHotkey(item.id, '')}>
                        <X size={14} />
                      </button>
                    </label>
                  )
                })}
              </div>
            </section>
          ))}
        </div> : <div className="viewer-settings-content">
          <h3 className="viewer-settings-section-title">Viewer Controls</h3>
          <div className="viewer-settings-appearance-list">
            <label className="viewer-settings-appearance-item">
              <input
                checked={appearance.showToolbar}
                disabled={!appearance.contextMenuEnabled}
                type="checkbox"
                onChange={(event) => onAppearanceChange({ ...appearance, showToolbar: event.currentTarget.checked })}
              />
              <span>
                <strong>Show Toolbar</strong>
                <small>Display favorite tools in the header.</small>
              </span>
            </label>
            <label className="viewer-settings-appearance-item">
              <input
                checked={appearance.contextMenuEnabled}
                disabled={!appearance.showToolbar}
                type="checkbox"
                onChange={(event) => onAppearanceChange({ ...appearance, contextMenuEnabled: event.currentTarget.checked })}
              />
              <span>
                <strong>Enable Right-click Menu</strong>
                <small>Open viewport tools from the context menu.</small>
              </span>
            </label>
          </div>
          <h3 className="viewer-settings-section-title">Series List Placement</h3>
          <div className="viewer-settings-segmented three">
            <button
              className={appearance.browserPosition === 'top' ? 'active' : ''}
              type="button"
              onClick={() => onAppearanceChange({ ...appearance, browserPosition: 'top' })}
            >
              Series Above Toolbar
            </button>
            <button
              className={appearance.browserPosition === 'below-toolbar' ? 'active' : ''}
              type="button"
              onClick={() => onAppearanceChange({ ...appearance, browserPosition: 'below-toolbar' })}
            >
              Toolbar Above Series
            </button>
            <button
              className={appearance.browserPosition === 'bottom' ? 'active' : ''}
              type="button"
              onClick={() => onAppearanceChange({ ...appearance, browserPosition: 'bottom' })}
            >
              Series Below Viewer
            </button>
          </div>
          <h3 className="viewer-settings-section-title">Defaults</h3>
          <div className="viewer-settings-reset-panel">
            <div>
              <strong>Reset current user preferences</strong>
              <small>Restore toolbar, hotkeys, appearance, and panel sizing to factory defaults.</small>
            </div>
            <button type="button" onClick={resetDefaults}>Reset to Default</button>
          </div>
        </div>}
        <footer className="viewer-settings-footer">
          <button type="button" onClick={resetDefaults}>Reset Default</button>
          <button className="primary" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  )
}

function SavedDicomObjectViewport({
  item,
  isSelected,
  onSelect,
}: {
  item: ViewportSavedObject
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button className={isSelected ? 'sr-viewport selected' : 'sr-viewport'} type="button" onClick={onSelect}>
      <div className="sr-panel saved-object-panel">
        <div className="sr-header">
          <span>{item.series.modality || 'DICOM'} Object</span>
          <strong>{item.title}</strong>
        </div>
        <div className="sr-content saved-object-content">
          <p>{item.description}</p>
          <strong>{item.status}</strong>
        </div>
      </div>
    </button>
  )
}

function readDroppedSeries(dataTransfer: DataTransfer): { study: StudySummary; series: SeriesSummary } | null {
  const rawPayload = dataTransfer.getData('application/nexia-series')
  if (!rawPayload) {
    return null
  }

  try {
    const payload = JSON.parse(rawPayload) as { study?: StudySummary; series?: SeriesSummary }
    if (!payload.study?.studyInstanceUid || !payload.series?.seriesInstanceUid) {
      return null
    }

    return { study: payload.study, series: payload.series }
  } catch {
    return null
  }
}

function AmbientLightTestModal({ onClose }: { onClose: () => void }) {
  const tileValues = [
    10, 35, 70, 160,
    25, 80, 140, 205,
    55, 125, 190, 230,
    105, 175, 215, 245,
  ]

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="ambient-test" role="dialog" aria-modal="true" aria-labelledby="ambient-test-title">
      <div className="ambient-test-header">
        <strong id="ambient-test-title">Ambient Light Test - TG18 style</strong>
        <button type="button" onClick={onClose} aria-label="Close ambient light test">
          <X size={18} />
          Close
        </button>
      </div>

      <div className="ambient-test-grid" aria-label="TG18 contrast visibility pattern">
        {tileValues.map((value) => {
          const delta = value < 128 ? 8 : -8
          const circleValue = Math.max(0, Math.min(255, value + delta))

          return (
            <div
              className="ambient-test-tile"
              key={value}
              style={{ backgroundColor: `rgb(${value}, ${value}, ${value})` }}
            >
              <span
                className="ambient-test-circle"
                style={{ backgroundColor: `rgb(${circleValue}, ${circleValue}, ${circleValue})` }}
              />
            </div>
          )
        })}
      </div>

      <p className="ambient-test-note">
        Confirm that all faint circles remain visible. If they are not visible, reduce ambient light or calibrate the display.
      </p>
    </div>
  )
}

function DicomTagBrowser({ metadata, onClose }: { metadata?: DicomJsonDataset; onClose: () => void }) {
  const [filter, setFilter] = useState('')
  const rows = flattenDicomTags(metadata)
  const normalizedFilter = filter.trim().toLowerCase()
  const visibleRows = normalizedFilter
    ? rows.filter((row) => `${row.tag} ${row.name} ${row.vr} ${row.value}`.toLowerCase().includes(normalizedFilter))
    : rows

  return (
    <div className="dicom-tag-browser" role="dialog" aria-modal="true" aria-label="DICOM Tag Browser">
      <div className="dicom-tag-panel">
        <div className="dicom-tag-header">
          <div>
            <span>DICOM Tag Browser</span>
            <strong>{rows.length ? `${rows.length} tags` : 'No metadata'}</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="Close DICOM tag browser"><X size={18} />Close</button>
        </div>
        <input className="dicom-tag-search" value={filter} placeholder="Search tag, name, VR, value..." onChange={(event) => setFilter(event.currentTarget.value)} />
        <div className="dicom-tag-table">
          <div className="dicom-tag-row head"><span>Tag</span><span>Name</span><span>VR</span><span>Value</span></div>
          {visibleRows.length ? visibleRows.map((row) => (
            <div className="dicom-tag-row" key={`${row.path}-${row.tag}`}>
              <span>{row.tag}</span>
              <span>{row.name}</span>
              <span>{row.vr}</span>
              <span>{row.value}</span>
            </div>
          )) : <div className="dicom-tag-empty">No matching tags.</div>}
        </div>
      </div>
    </div>
  )
}

function getSelectedMetadata(stack: { instances: { metadata?: DicomJsonDataset }[] } | undefined, imageIndex: number) {
  if (!stack?.instances.length) {
    return undefined
  }

  const instanceIndex = Math.min(Math.max(imageIndex, 0), stack.instances.length - 1)

  return stack.instances[instanceIndex]?.metadata ?? stack.instances[0]?.metadata
}

function needsCtTechnicalMetadataRefresh(stack: { series: SeriesSummary; instances: InstanceSummary[] }) {
  if (stack.series.modality?.toUpperCase() !== 'CT' || !stack.instances.length) {
    return false
  }

  return !stack.instances[0]?.metadata?.['00180060']?.Value?.length
}

function getInferredSliceSpacing(instances: InstanceSummary[] | undefined, imageIndex: number) {
  if (!instances || instances.length < 2) return undefined
  const currentIndex = Math.min(Math.max(imageIndex, 0), instances.length - 1)
  const current = instances[currentIndex]?.imagePositionPatient
  if (!isValidImagePosition(current)) return undefined

  const adjacentIndexes = [currentIndex - 1, currentIndex + 1]
  for (const adjacentIndex of adjacentIndexes) {
    const adjacent = instances[adjacentIndex]?.imagePositionPatient
    if (!isValidImagePosition(adjacent)) continue
    const spacing = Math.hypot(
      current[0] - adjacent[0],
      current[1] - adjacent[1],
      current[2] - adjacent[2],
    )
    if (Number.isFinite(spacing) && spacing > 0.001) return spacing
  }

  return undefined
}

function isValidImagePosition(value: number[] | undefined): value is [number, number, number] {
  return Boolean(value && value.length === 3 && value.every(Number.isFinite))
}

function getNativeExportImageDimensions(instance: InstanceSummary | null) {
  const columns = Math.round(Number(instance?.columns))
  const rows = Math.round(Number(instance?.rows))
  if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns < 1 || rows < 1) {
    return null
  }

  const pixelSpacing = readExportPixelSpacing(instance?.metadata, '00280030')
    ?? readExportPixelSpacing(instance?.metadata, '00181164')
  return {
    columns,
    rows,
    rowPixelSpacing: pixelSpacing?.[0],
    columnPixelSpacing: pixelSpacing?.[1],
  }
}

function readExportPixelSpacing(metadata: DicomJsonDataset | undefined, tag: string) {
  const values = metadata?.[tag]?.Value ?? []
  const flattened = values.flatMap((value) => String(value ?? '').split('\\'))
  const numeric = flattened
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  return numeric.length >= 2 ? [numeric[0], numeric[1]] as const : null
}

function flattenDicomTags(metadata?: DicomJsonDataset) {
  if (!metadata) {
    return []
  }

  return flattenDataset(metadata).sort((a, b) => a.path.localeCompare(b.path))
}

function flattenDataset(dataset: DicomJsonDataset, prefix = ''): { path: string; tag: string; name: string; vr: string; value: string }[] {
  return Object.entries(dataset).flatMap(([tag, element]) => {
    const path = prefix ? `${prefix}.${tag}` : tag
    const value = formatDicomElementValue(element)
    const currentRow = { path, tag: formatDicomTag(tag), name: dicomTagNames[tag] ?? '', vr: element.vr, value }
    const sequenceRows = element.Value?.flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return []
      }

      return flattenDataset(item as DicomJsonDataset, `${path}[${index + 1}]`)
    }) ?? []

    return [currentRow, ...sequenceRows]
  })
}

function formatDicomElementValue(element: DicomJsonDataset[string]) {
  if (element.InlineBinary) {
    return `[InlineBinary ${element.InlineBinary.length} chars]`
  }

  if (element.BulkDataURI) {
    return `[BulkData] ${element.BulkDataURI}`
  }

  if (!element.Value?.length) {
    return ''
  }

  return element.Value.map((value) => {
    if (value && typeof value === 'object') {
      if ('Alphabetic' in value) {
        return String(value.Alphabetic)
      }

      return '[Sequence Item]'
    }

    return String(value)
  }).join(' \\ ')
}

function formatDicomTag(tag: string) {
  return tag.length === 8 ? `(${tag.slice(0, 4)},${tag.slice(4)})` : tag
}

const dicomTagNames: Record<string, string> = {
  '00080005': 'Specific Character Set',
  '00080008': 'Image Type',
  '00080016': 'SOP Class UID',
  '00080018': 'SOP Instance UID',
  '00080020': 'Study Date',
  '00080030': 'Study Time',
  '00080050': 'Accession Number',
  '00080060': 'Modality',
  '00080061': 'Modalities in Study',
  '00080070': 'Manufacturer',
  '00080080': 'Institution Name',
  '00081010': 'Station Name',
  '00081030': 'Study Description',
  '00081040': 'Institutional Department Name',
  '0008103E': 'Series Description',
  '00081090': 'Manufacturer Model Name',
  '00100010': 'Patient Name',
  '00100020': 'Patient ID',
  '00100030': 'Patient Birth Date',
  '00100040': 'Patient Sex',
  '00101010': 'Patient Age',
  '00180015': 'Body Part Examined',
  '00180022': 'Scan Options',
  '00180023': 'MR Acquisition Type',
  '00180024': 'Sequence Name',
  '00180050': 'Slice Thickness',
  '00180060': 'KVP',
  '00180080': 'Repetition Time',
  '00180081': 'Echo Time',
  '00180082': 'Inversion Time',
  '00180087': 'Magnetic Field Strength',
  '00180088': 'Spacing Between Slices',
  '00180090': 'Data Collection Diameter',
  '00180010': 'Contrast/Bolus Agent',
  '00181030': 'Protocol Name',
  '00181063': 'Frame Time',
  '00181100': 'Reconstruction Diameter',
  '00181110': 'Distance Source to Detector',
  '00181150': 'Exposure Time',
  '00181151': 'X-Ray Tube Current',
  '00181152': 'Exposure',
  '00181153': 'Exposure in uAs',
  '0018115E': 'Image and Fluoroscopy Area Dose Product',
  '001811A0': 'Body Part Thickness',
  '001811A2': 'Compression Force',
  '001811A4': 'Paddle Description',
  '00181191': 'Anode Target Material',
  '00181210': 'Convolution Kernel',
  '00181314': 'Flip Angle',
  '00181411': 'Exposure Index',
  '00181412': 'Target Exposure Index',
  '00181413': 'Deviation Index',
  '00181510': 'Positioner Primary Angle',
  '00181511': 'Positioner Secondary Angle',
  '00185010': 'Transducer Data',
  '00185012': 'Focus Depth',
  '00185022': 'Mechanical Index',
  '00185024': 'Bone Thermal Index',
  '00185050': 'Depth of Scan Field',
  '00186011': 'Sequence of Ultrasound Regions',
  '00186030': 'Transducer Frequency',
  '00189311': 'Spiral Pitch Factor',
  '00189345': 'CTDIvol',
  '00185100': 'Patient Position',
  '00185101': 'View Position',
  '00200060': 'Laterality',
  '00200062': 'Image Laterality',
  '0020000D': 'Study Instance UID',
  '0020000E': 'Series Instance UID',
  '00200011': 'Series Number',
  '00200013': 'Instance Number',
  '00201041': 'Slice Location',
  '00280002': 'Samples per Pixel',
  '00280004': 'Photometric Interpretation',
  '00280010': 'Rows',
  '00280011': 'Columns',
  '00280030': 'Pixel Spacing',
  '00281050': 'Window Center',
  '00281051': 'Window Width',
  '00281052': 'Rescale Intercept',
  '00281053': 'Rescale Slope',
  '00400316': 'Organ Dose',
  '0040A040': 'Value Type',
  '0040A043': 'Concept Name Code Sequence',
  '0040A160': 'Text Value',
  '0040A730': 'Content Sequence',
}

type ViewportOverlayInput = {
  study: StudySummary | null
  series?: SeriesSummary | null
  metadata?: DicomJsonDataset
  imageIndex: number
  imageCount: number
  windowLevel?: { windowWidth: number; windowLevel: number }
  zoom: number
  inferredSliceSpacing?: number
  overlayConfig: ViewerOverlayConfig
}

function buildViewportOverlayInfo({ study, series, metadata, imageIndex, imageCount, windowLevel, zoom, inferredSliceSpacing, overlayConfig }: ViewportOverlayInput) {
  const patientName = readOverlayString(metadata, '00100010') || study?.patientName
  const patientId = readOverlayString(metadata, '00100020') || study?.patientId
  const birthDate = readOverlayString(metadata, '00100030')
  const studyDate = readOverlayString(metadata, '00080020') || study?.studyDate || series?.studyDate
  const studyTime = readOverlayString(metadata, '00080030')
  const patientAge = readOverlayString(metadata, '00101010') || calculatePatientAge(birthDate, studyDate)
  const sex = readOverlayString(metadata, '00100040')
  const patientSize = readOverlayNumber(metadata, '00101020')
  const institutionName = readOverlayString(metadata, '00080080')
  const modality = (readOverlayString(metadata, '00080060') || series?.modality || study?.modalities || '').toUpperCase()
  const studyDescription = readOverlayString(metadata, '00081030') || study?.studyDescription
  const seriesDescription = readOverlayString(metadata, '0008103E') || series?.seriesDescription
  const seriesDate = readOverlayString(metadata, '00080021')
  const seriesTime = readOverlayString(metadata, '00080031')
  const protocolName = readOverlayString(metadata, '00181030')
  const accessionNumber = readOverlayString(metadata, '00080050') || study?.accessionNumber
  const bodyPart = readOverlayString(metadata, '00180015')
  const laterality = readOverlayString(metadata, '00200060')
  const viewPosition = readOverlayString(metadata, '00185101')
  const patientPosition = readOverlayString(metadata, '00185100')
  const instanceNumber = readOverlayString(metadata, '00200013')
  const imageType = readOverlayValues(metadata, '00080008').join('\\')
  const topRightExam = compactOverlayLine([modality, studyDescription], ' - ')
  const topRightSeries = compactOverlayLine([seriesDescription || protocolName, bodyPart, viewPosition || patientPosition], ' ')
  const formattedStudyDateTime = compactOverlayLine([formatOverlayDate(studyDate), formatOverlayTime(studyTime)], ', ')
  const pixelSpacing = readOverlayValues(metadata, '00280030')
  const imagePosition = readOverlayValues(metadata, '00200032')
  const imageOrientation = readOverlayValues(metadata, '00200037')
  const acquisitionMatrix = readOverlayValues(metadata, '00181310').filter((value) => value !== '0')
  const activeWindowCenter = Number.isFinite(windowLevel?.windowLevel) ? windowLevel?.windowLevel : readOverlayNumber(metadata, '00281050')
  const activeWindowWidth = Number.isFinite(windowLevel?.windowWidth) ? windowLevel?.windowWidth : readOverlayNumber(metadata, '00281051')
  const overlayValues: Record<string, string | undefined> = {
    patientName,
    patientId,
    birthDate: formatOverlayOptionalLabel('DOB', formatOverlayDate(birthDate)),
    sex: formatOverlayOptionalLabel('Sex', sex),
    age: formatOverlayOptionalLabel('Age', patientAge),
    weight: formatOverlayLabeledNumber('Weight', readOverlayNumber(metadata, '00101030'), 1, ' kg'),
    patientSize: formatOverlayLabeledNumber('Height', patientSize, 2, ' m'),
    patientPosition: formatOverlayOptionalLabel('Position', patientPosition),

    modalityStudy: topRightExam,
    studyDateTime: formattedStudyDateTime,
    studyDescription: formatOverlayOptionalLabel('Study', studyDescription),
    accessionNumber: formatOverlayOptionalLabel('ACC', accessionNumber),
    studyId: formatOverlayOptionalLabel('Study ID', readOverlayString(metadata, '00200010')),
    referringPhysician: formatOverlayOptionalLabel('Ref', readOverlayString(metadata, '00080090')),
    institutionName,
    modalitiesInStudy: formatOverlayOptionalLabel('Modalities', readOverlayString(metadata, '00080061') || study?.modalities),
    studyUid: formatOverlayOptionalLabel('Study UID', readOverlayString(metadata, '0020000D') || study?.studyInstanceUid),

    seriesInfo: topRightSeries,
    seriesNumber: formatOverlayOptionalLabel('Series', readOverlayString(metadata, '00200011') || series?.seriesNumber),
    seriesDateTime: formatOverlayOptionalLabel('Series', compactOverlayLine([formatOverlayDate(seriesDate), formatOverlayTime(seriesTime)], ', ')),
    protocolName: formatOverlayOptionalLabel('Protocol', protocolName),
    bodyPart: formatOverlayOptionalLabel('Body Part', bodyPart),
    laterality: formatOverlayOptionalLabel('Laterality', laterality),
    viewPosition: formatOverlayOptionalLabel('View', viewPosition),
    imageType: formatOverlayOptionalLabel('Type', imageType),
    manufacturer: formatOverlayOptionalLabel('Manufacturer', readOverlayString(metadata, '00080070')),
    modelName: formatOverlayOptionalLabel('Model', readOverlayString(metadata, '00081090')),
    stationName: formatOverlayOptionalLabel('Station', readOverlayString(metadata, '00081010')),
    operatorName: formatOverlayOptionalLabel('Operator', readOverlayString(metadata, '00081070')),
    seriesUid: formatOverlayOptionalLabel('Series UID', readOverlayString(metadata, '0020000E') || series?.seriesInstanceUid),

    kvp: formatOverlayLabeledNumber('KVP', readOverlayNumber(metadata, '00180060')),
    tubeCurrent: formatOverlayLabeledNumber('mA', readOverlayNumber(metadata, '00181151')),
    exposureTime: formatOverlayLabeledNumber('ET', readOverlayNumber(metadata, '00181150')),
    exposure: formatOverlayLabeledNumber('Exposure', readOverlayNumber(metadata, '00181152')),
    ctdiVol: formatOverlayLabeledNumber('CTDIvol', readOverlayNumber(metadata, '00189345'), 2),
    pitch: formatOverlayLabeledNumber('Pitch', readOverlayNumber(metadata, '00189311'), 2),
    kernel: formatOverlayOptionalLabel('Kernel', readOverlayString(metadata, '00181210')),
    gantryTilt: formatOverlayLabeledNumber('Tilt', readOverlayNumber(metadata, '00181120'), 1, ' deg'),
    rotationTime: formatOverlayLabeledNumber('Rotation', readOverlayNumber(metadata, '00189305'), 2, ' s'),
    totalCollimationWidth: formatOverlayLabeledNumber('Collimation', readOverlayNumber(metadata, '00189307'), 1, ' mm'),
    tableFeedPerRotation: formatOverlayLabeledNumber('Table feed', readOverlayNumber(metadata, '00189310'), 1, ' mm'),
    dataCollectionDiameter: formatOverlayLabeledNumber('Collection', readOverlayNumber(metadata, '00180090'), 1, ' mm'),
    filterType: formatOverlayOptionalLabel('Filter', readOverlayString(metadata, '00181160')),
    contrastAgent: formatOverlayOptionalLabel('Contrast', readOverlayString(metadata, '00180010')),
    scanOptions: formatOverlayOptionalLabel('Scan', readOverlayString(metadata, '00180022')),
    acquisitionNumber: formatOverlayOptionalLabel('Acq', readOverlayString(metadata, '00200012')),
    tr: formatOverlayLabeledNumber('TR', readOverlayNumber(metadata, '00180080'), 1),
    te: formatOverlayLabeledNumber('TE', readOverlayNumber(metadata, '00180081'), 1),
    ti: formatOverlayLabeledNumber('TI', readOverlayNumber(metadata, '00180082'), 1),
    flipAngle: formatOverlayLabeledNumber('FA', readOverlayNumber(metadata, '00181314'), 1),
    fieldStrength: formatOverlayLabeledNumber('B', readOverlayNumber(metadata, '00180087'), 2, ' T'),
    scanningSequence: formatOverlayOptionalLabel('Sequence', readOverlayValues(metadata, '00180020').join('\\')),
    sequenceVariant: formatOverlayOptionalLabel('Variant', readOverlayValues(metadata, '00180021').join('\\')),
    mrAcquisitionType: formatOverlayOptionalLabel('MR Acq', readOverlayString(metadata, '00180023')),
    sequenceName: formatOverlayOptionalLabel('Name', readOverlayString(metadata, '00180024')),
    echoNumber: formatOverlayLabeledNumber('Echo', readOverlayNumber(metadata, '00180086')),
    echoTrainLength: formatOverlayLabeledNumber('ETL', readOverlayNumber(metadata, '00180091')),
    imagingFrequency: formatOverlayLabeledNumber('Freq', readOverlayNumber(metadata, '00180084'), 2, ' MHz'),
    imagedNucleus: formatOverlayOptionalLabel('Nucleus', readOverlayString(metadata, '00180085')),
    phaseEncodingDirection: formatOverlayOptionalLabel('Phase', readOverlayString(metadata, '00181312')),
    acquisitionMatrix: acquisitionMatrix.length ? `Acq matrix: ${acquisitionMatrix.join(' x ')}` : undefined,
    triggerTime: formatOverlayLabeledNumber('Trigger', readOverlayNumber(metadata, '00181060'), 1, ' ms'),

    detectorType: formatOverlayOptionalLabel('Detector', readOverlayString(metadata, '00187004')),
    exposureIndex: formatOverlayLabeledNumber('EI', readOverlayNumber(metadata, '00181411'), 1),
    targetExposureIndex: formatOverlayLabeledNumber('Target EI', readOverlayNumber(metadata, '00181412'), 1),
    deviationIndex: formatOverlayLabeledNumber('DI', readOverlayNumber(metadata, '00181413'), 1),
    primaryAngle: formatOverlayLabeledNumber('Primary', readOverlayNumber(metadata, '00181510'), 1, ' deg'),
    secondaryAngle: formatOverlayLabeledNumber('Secondary', readOverlayNumber(metadata, '00181511'), 1, ' deg'),
    sourceToDetectorDistance: formatOverlayLabeledNumber('SID', readOverlayNumber(metadata, '00181110'), 1, ' mm'),
    sourceToPatientDistance: formatOverlayLabeledNumber('SPD', readOverlayNumber(metadata, '00181111'), 1, ' mm'),
    tableHeight: formatOverlayLabeledNumber('Table', readOverlayNumber(metadata, '00181130'), 1, ' mm'),

    transducerData: formatOverlayOptionalLabel('Probe', readOverlayString(metadata, '00185010')),
    transducerFrequency: formatOverlayLabeledNumber('Probe', readOverlayNumber(metadata, '00186030'), 2, ' MHz'),
    scanFieldDepth: formatOverlayLabeledNumber('Depth', readOverlayNumber(metadata, '00185050'), 1, ' mm'),
    mechanicalIndex: formatOverlayLabeledNumber('MI', readOverlayNumber(metadata, '00185022'), 2),
    boneThermalIndex: formatOverlayLabeledNumber('TIB', readOverlayNumber(metadata, '00185024'), 2),

    radiopharmaceutical: formatOverlayOptionalLabel('Drug', readOverlaySequenceString(metadata, '00540016', '00180031')),
    radionuclide: formatOverlayOptionalLabel('Nuclide', readOverlaySequenceString(metadata, '00540016', '00180030')),
    radionuclideTotalDose: formatOverlayLabeledNumber('Dose', readOverlaySequenceNumber(metadata, '00540016', '00181074'), 1, ' Bq'),
    radionuclideHalfLife: formatOverlayLabeledNumber('Half-life', readOverlaySequenceNumber(metadata, '00540016', '00181075'), 1, ' s'),
    radiopharmaceuticalStartTime: formatOverlayOptionalLabel('Start', formatOverlayTime(readOverlaySequenceString(metadata, '00540016', '00181072'))),
    petUnits: formatOverlayOptionalLabel('Units', readOverlayString(metadata, '00541001')),
    decayCorrection: formatOverlayOptionalLabel('Decay', readOverlayString(metadata, '00541101')),
    suvType: formatOverlayOptionalLabel('SUV', readOverlayString(metadata, '00541006')),
    waveformSamplingFrequency: formatOverlayLabeledNumber('Sample', readOverlayNumber(metadata, '003A001A'), 0, ' Hz'),

    sliceLocation: formatOverlayLabeledNumber('LOC', readOverlayNumber(metadata, '00201041'), 2),
    sliceThickness: formatOverlayLabeledNumber('THK', readOverlayNumber(metadata, '00180050'), 2),
    sliceSpacing: formatOverlayLabeledNumber('SP', readOverlayNumber(metadata, '00180088') ?? inferredSliceSpacing, 2),
    reconDiameter: formatOverlayLabeledNumber('DFOV', readOverlayNumber(metadata, '00181100'), 2),
    imagePosition: imagePosition.length ? `IPP: ${imagePosition.join('\\')}` : undefined,
    imageOrientation: imageOrientation.length ? `IOP: ${imageOrientation.join('\\')}` : undefined,
    pixelSpacing: pixelSpacing.length >= 2 ? `Pixel: ${pixelSpacing.slice(0, 2).join(' x ')} mm` : undefined,
    matrix: formatOverlayDimensions(readOverlayNumber(metadata, '00280011'), readOverlayNumber(metadata, '00280010')),
    bitsStored: formatOverlayLabeledNumber('Bits', readOverlayNumber(metadata, '00280101')),
    photometric: formatOverlayOptionalLabel('Photo', readOverlayString(metadata, '00280004')),
    presentationIntent: formatOverlayOptionalLabel('Intent', readOverlayString(metadata, '00080068')),
    rescaleIntercept: formatOverlayLabeledNumber('Intercept', readOverlayNumber(metadata, '00281052'), 2),
    rescaleSlope: formatOverlayLabeledNumber('Slope', readOverlayNumber(metadata, '00281053'), 2),
    windowCenter: formatOverlayLabeledNumber('C', activeWindowCenter),
    windowWidth: formatOverlayLabeledNumber('W', activeWindowWidth),
    zoom: `Z: ${formatOverlayDecimal(zoom, 2)}`,
    page: imageCount ? `${modality === 'US' || ['XA', 'XRF', 'NM', 'PT'].includes(modality) ? 'Frame' : 'Page'}: ${imageIndex} of ${imageCount}` : undefined,
    imageNumber: `IM: ${instanceNumber || imageIndex}${imageCount ? ` / ${imageCount}` : ''}`,
    sopInstanceUid: formatOverlayOptionalLabel('SOP', readOverlayString(metadata, '00080018')),
    frameOfReferenceUid: formatOverlayOptionalLabel('FoR', readOverlayString(metadata, '00200052')),
  }
  const layout = getViewerOverlayLayout(overlayConfig, modality)

  return {
    topLeft: compactOverlayLines(layout.topLeft.map((fieldId) => overlayValues[fieldId])),
    topRight: compactOverlayLines(layout.topRight.map((fieldId) => overlayValues[fieldId])),
    bottomLeft: compactOverlayLines(layout.bottomLeft.map((fieldId) => overlayValues[fieldId])),
    bottomRight: compactOverlayLines(layout.bottomRight.map((fieldId) => overlayValues[fieldId])),
  }
}

function readOverlayString(metadata: DicomJsonDataset | undefined, tag: string) {
  const value = metadata?.[tag]?.Value?.[0]
  if (value === undefined || value === null) {
    return ''
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('Alphabetic' in value) {
      return String(value.Alphabetic).replace(/\^/g, ' ').trim()
    }

    return ''
  }

  return String(value).replace(/\^/g, ' ').trim()
}

function readOverlayNumber(metadata: DicomJsonDataset | undefined, tag: string) {
  const rawValue = readOverlayString(metadata, tag)
  if (!rawValue) {
    return undefined
  }
  const parsedValue = Number(rawValue)
  return Number.isFinite(parsedValue) ? parsedValue : undefined
}

function buildExportFileName(
  study: StudySummary | null,
  metadata?: DicomJsonDataset,
  series?: SeriesSummary | null,
) {
  const patientName = cleanExportFileNamePart(readOverlayString(metadata, '00100010') || study?.patientName, 'Unknown Patient')
  const patientId = cleanExportFileNamePart(readOverlayString(metadata, '00100020') || study?.patientId, 'Unknown ID')
  const sex = cleanExportFileNamePart(readOverlayString(metadata, '00100040'), 'Unknown Sex').toUpperCase()
  const studyDescription = cleanExportFileNamePart(
    readOverlayString(metadata, '00081030') || study?.studyDescription || series?.seriesDescription,
    'Study',
  )
  const studyDate = formatExportStudyDate(readOverlayString(metadata, '00080020') || study?.studyDate || series?.studyDate)
  const studyTime = formatExportStudyTime(readOverlayString(metadata, '00080030'))
  return `${patientName} - ${patientId} - ${sex} - ${studyDescription} - ${studyDate} ${studyTime}`
}

function cleanExportFileNamePart(value: string | undefined, fallback: string) {
  const cleaned = String(value || '')
    .replace(/\^/g, ' ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

function formatExportStudyDate(value: string | undefined) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.length >= 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  return cleanExportFileNamePart(value, 'Unknown Date')
}

function formatExportStudyTime(value: string | undefined) {
  const digits = String(value || '').split('.')[0].replace(/\D/g, '')
  if (digits.length >= 6) return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`
  if (digits.length >= 4) return `${digits.slice(0, 2)}-${digits.slice(2, 4)}`
  return cleanExportFileNamePart(value, 'Unknown Time')
}

function readOverlayValues(metadata: DicomJsonDataset | undefined, tag: string) {
  return (metadata?.[tag]?.Value ?? [])
    .flatMap((value) => String(value ?? '').split('\\'))
    .map((value) => value.trim())
    .filter(Boolean)
}

function readOverlaySequenceString(metadata: DicomJsonDataset | undefined, sequenceTag: string, tag: string) {
  const item = metadata?.[sequenceTag]?.Value?.find((value) => value && typeof value === 'object' && !Array.isArray(value))
  return item ? readOverlayString(item as DicomJsonDataset, tag) : ''
}

function readOverlaySequenceNumber(metadata: DicomJsonDataset | undefined, sequenceTag: string, tag: string) {
  const item = metadata?.[sequenceTag]?.Value?.find((value) => value && typeof value === 'object' && !Array.isArray(value))
  return item ? readOverlayNumber(item as DicomJsonDataset, tag) : undefined
}

function compactOverlayLines(lines: Array<string | undefined | null | false>) {
  return lines.map((line) => typeof line === 'string' ? line.trim() : '').filter(Boolean)
}

function compactOverlayLine(parts: Array<string | undefined | null | false>, separator: string) {
  return compactOverlayLines(parts).join(separator)
}

function formatOverlayDate(value?: string) {
  if (!value) {
    return ''
  }

  const normalizedDate = value.replace(/\D/g, '')
  if (normalizedDate.length === 8) {
    return `${normalizedDate.slice(4, 6)}/${normalizedDate.slice(6, 8)}/${normalizedDate.slice(0, 4)}`
  }

  return value
}

function formatOverlayTime(value?: string) {
  if (!value) {
    return ''
  }

  const normalizedTime = value.replace(/[^\d.]/g, '')
  if (normalizedTime.length >= 6) {
    return `${normalizedTime.slice(0, 2)}:${normalizedTime.slice(2, 4)}:${normalizedTime.slice(4, 6)}`
  }

  return value
}

function calculatePatientAge(birthDate?: string, studyDate?: string) {
  const birth = birthDate?.replace(/\D/g, '')
  const study = studyDate?.replace(/\D/g, '')
  if (birth?.length !== 8 || study?.length !== 8) {
    return ''
  }

  const birthYear = Number(birth.slice(0, 4))
  const birthMonthDay = Number(birth.slice(4, 8))
  const studyYear = Number(study.slice(0, 4))
  const studyMonthDay = Number(study.slice(4, 8))
  if (!Number.isFinite(birthYear) || !Number.isFinite(studyYear)) {
    return ''
  }

  const age = studyYear - birthYear - (studyMonthDay < birthMonthDay ? 1 : 0)
  return age >= 0 ? `${age}Y` : ''
}

function formatOverlayLabeledNumber(label: string, value?: number, fractionDigits = 0, suffix = '') {
  if (!Number.isFinite(value)) {
    return ''
  }

  return `${label}: ${formatOverlayDecimal(value as number, fractionDigits)}${suffix}`
}

function formatOverlayOptionalLabel(label: string, value?: string) {
  return value ? `${label}: ${value}` : ''
}

function formatOverlayDimensions(columns?: number, rows?: number) {
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) {
    return ''
  }

  return `Matrix: ${formatOverlayDecimal(columns as number)} x ${formatOverlayDecimal(rows as number)}`
}

function formatOverlayDecimal(value: number, fractionDigits = 0) {
  if (!Number.isFinite(value)) {
    return ''
  }

  const roundedValue = Number(value.toFixed(fractionDigits))
  return fractionDigits ? roundedValue.toFixed(fractionDigits) : String(roundedValue)
}
