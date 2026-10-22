import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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
  FlipHorizontal2,
  FlipVertical2,
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
import { createWadoRsImageIds, getSeriesStructuredReport, getSeriesWaveform, isRenderableImageInstance, isVideoInstance, listInstances, registerWadoRsMetadata } from '../dicomweb/client'
import type { DicomJsonDataset, InstanceSummary, SeriesSummary, StructuredReportSummary, StudySummary, WaveformSummary } from '../dicomweb/types'
import { useAuthStore, useCurrentUser } from '../auth/authStore'
import { getActiveToolPermission, getMenuItemPermission } from '../auth/permissions'
import type { PermissionId } from '../auth/permissions'
import { DicomViewport, getMenuItemHotkey, getPermittedMenuSections, isMenuItemAvailableForModality, toHotkey, viewportMenuSections, type ViewportMenuAction } from './components/DicomViewport'
import { DicomVideoViewport } from './components/DicomVideoViewport'
import { Bone3DViewer } from './components/Bone3DViewer'
import { EcgWaveformViewport } from './components/EcgWaveformViewport'
import { MprViewer } from './components/MprViewer'
import { ServerMprCornerstoneViewport } from './components/ServerMprCornerstoneViewport'
import { ServerStackCornerstoneViewport } from './components/ServerStackCornerstoneViewport'
import { StructuredReportViewport } from './components/StructuredReportViewport'
import { useViewerStore } from './viewerStore'
import type { ViewportLayout } from './viewerStore'
import { StudyHeaderBrowser } from '../studies/StudyList'
import { getStackInitialImageIndex, loadStackImageForDisplay, prewarmStackNeighbors } from './cornerstone/progressiveLoading'

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
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item): CustomWindowPreset | null => {
        const name = typeof item?.name === 'string' ? item.name.trim() : ''
        const windowWidth = Number(item?.windowWidth)
        const windowLevel = Number(item?.windowLevel)
        const id = typeof item?.id === 'string' && item.id ? item.id : `custom-${name.toLowerCase().replace(/\s+/g, '-')}`
        if (!name || !Number.isFinite(windowWidth) || !Number.isFinite(windowLevel) || windowWidth <= 0) return null
        return { id, name, windowWidth, windowLevel }
      })
      .filter((item): item is CustomWindowPreset => Boolean(item))
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
) {
  return JSON.stringify({ toolbarFavorites, viewerAppearance, hotkeyOverrides })
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

export function ViewerShell({ deepLinkMode = false }: { deepLinkMode?: boolean } = {}) {
  const [searchParams] = useSearchParams()
  const serverRenderMode = searchParams.get('renderMode') === 'server'
  const requestedSopInstanceUid = searchParams.get('sopUID') ?? searchParams.get('SOPInstanceUID') ?? ''
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
  const setViewportStack = useViewerStore((state) => state.setViewportStack)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const loadingMessage = useViewerStore((state) => state.loadingMessage)
  const errorMessage = useViewerStore((state) => state.errorMessage)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const currentUser = useCurrentUser()
  const mprMode = useViewerStore((state) => state.mprMode)
  const setMprMode = useViewerStore((state) => state.setMprMode)
  const intelliLink = useViewerStore((state) => state.intelliLink)
  const setIntelliLinkOption = useViewerStore((state) => state.setIntelliLinkOption)
  const setAllIntelliLinkOptions = useViewerStore((state) => state.setAllIntelliLinkOptions)
  const [viewportWaveforms, setViewportWaveforms] = useState<Record<string, ViewportWaveform>>({})
  const [viewportVideos, setViewportVideos] = useState<Record<string, ViewportVideo>>({})
  const [viewportReports, setViewportReports] = useState<Record<string, ViewportReport>>({})
  const [viewportSavedObjects, setViewportSavedObjects] = useState<Record<string, ViewportSavedObject>>({})
  const [isTagBrowserOpen, setIsTagBrowserOpen] = useState(false)
  const [isAmbientTestOpen, setIsAmbientTestOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [toolbarFavorites, setToolbarFavorites] = useState<ToolbarFavoriteId[]>(defaultToolbarFavorites)
  const [viewerAppearance, setViewerAppearance] = useState<ViewerAppearance>(loadViewerAppearance)
  const [showOverlay, setShowOverlay] = useState(true)
  const [volume3dViewport, setVolume3dViewport] = useState<{ key: string; series: SeriesSummary; mode: 'oblique' | 'bone' } | null>(null)
  const [fullscreenViewportKey, setFullscreenViewportKey] = useState<string | null>(null)
  const [seriesBrowserCollapsed, setSeriesBrowserCollapsed] = useState(false)
  const [, setReadyViewportSeries] = useState<Record<string, string>>({})
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [dropdownAnchor, setDropdownAnchor] = useState<{ left: number; top: number } | null>(null)
  const customPresetStorageKey = getCustomWindowPresetStorageKey(currentUser)
  const [customWindowPresets, setCustomWindowPresets] = useState<CustomWindowPreset[]>(() => loadCustomWindowPresets(customPresetStorageKey))
  const [customPresetName, setCustomPresetName] = useState('')
  const [customPresetWw, setCustomPresetWw] = useState('')
  const [customPresetWl, setCustomPresetWl] = useState('')
  const ribbonRef = useRef<HTMLDivElement>(null)
  const preferencesHydratedRef = useRef(false)
  const preferencesSnapshotRef = useRef('')
  const preferencesSaveTimerRef = useRef<number | null>(null)
  const viewportKeys = viewportKeysByLayout[viewportLayout]
  const selectedStack = viewportStacks[selectedViewportKey]
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

  useEffect(() => {
    if (!hasPermission(getActiveToolPermission(activeTool))) {
      setActiveTool(hasPermission('tool.window_level.use') ? 'WindowLevel' : 'Scroll')
    }
    if (mprMode && !hasPermission('mpr.open')) {
      setMprMode(false, selectedViewportKey)
    }
  }, [activeTool, hasPermission, mprMode, selectedViewportKey, setActiveTool, setMprMode])

  useEffect(() => {
    setCustomWindowPresets(loadCustomWindowPresets(customPresetStorageKey))
  }, [customPresetStorageKey])

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
    setCustomPresetName((value) => value || 'Custom')
  }, [openMenu, selectedViewportKey])

  useEffect(() => {
    let cancelled = false
    preferencesHydratedRef.current = false

    async function loadPreferences() {
      if (!currentUser) return
      try {
        const response = await fetch('/api/auth/preferences', { credentials: 'same-origin' })
        const preferences = await response.json() as ViewerPreferences
        if (cancelled) return
        const nextToolbarFavorites = sanitizeToolbarFavorites(preferences.toolbarFavorites)
        const nextViewerAppearance = normalizeViewerAppearance(preferences.viewerAppearance)
        const nextHotkeyOverrides = preferences.hotkeyOverrides ?? {}
        preferencesSnapshotRef.current = serializeViewerPreferences(nextToolbarFavorites, nextViewerAppearance, nextHotkeyOverrides)
        setToolbarFavorites(nextToolbarFavorites)
        setViewerAppearance(nextViewerAppearance)
        setHotkeyOverrides(nextHotkeyOverrides)
      } finally {
        if (!cancelled) {
          if (!preferencesSnapshotRef.current) {
            preferencesSnapshotRef.current = serializeViewerPreferences(toolbarFavorites, viewerAppearance, hotkeyOverrides)
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

    const nextSnapshot = serializeViewerPreferences(toolbarFavorites, viewerAppearance, hotkeyOverrides)
    if (nextSnapshot === preferencesSnapshotRef.current) {
      return
    }

    if (preferencesSaveTimerRef.current !== null) {
      window.clearTimeout(preferencesSaveTimerRef.current)
    }

    preferencesSaveTimerRef.current = window.setTimeout(() => {
      preferencesSaveTimerRef.current = null
      void fetch('/api/auth/preferences', {
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
  }, [currentUser, hotkeyOverrides, toolbarFavorites, viewerAppearance])

  useEffect(() => {
    setVolume3dViewport(null)
    setFullscreenViewportKey(null)
    setReadyViewportSeries({})
  }, [activeStudy?.studyInstanceUid])

  useEffect(() => {
    if (fullscreenViewportKey && !viewportKeys.some((key) => key === fullscreenViewportKey)) {
      setFullscreenViewportKey(null)
    }
  }, [fullscreenViewportKey, viewportKeys])

  useEffect(() => {
    if (!activeSeries) {
      setInstances([], [])
      setViewportWaveforms({})
      setViewportVideos({})
      setViewportReports({})
      setViewportSavedObjects({})
      return
    }

    const series = activeSeries
    let cancelled = false

    async function loadInstances() {
      setLoadingMessage(`Loading ${series.modality || 'DICOM'} series...`)
      setErrorMessage('')
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
                setErrorMessage('This series is not a renderable DICOM image series, an ECG waveform, or a readable Structured Report.')
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
              await loadStackImageForDisplay(imageIds[initialImageIndex])
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
      setErrorMessage('Invalid custom WW/WL preset.')
      return
    }

    applyWindowLevel(parsed.windowWidth, parsed.windowLevel)
  }

  function handleSaveCustomWindowPreset() {
    const parsed = parseWindowLevelInputs(customPresetWw, customPresetWl)
    const name = customPresetName.trim()
    if (!parsed || !name) {
      setErrorMessage('Enter a preset name and valid WW/WL values.')
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

    setCustomWindowPresets(nextPresets)
    saveCustomWindowPresets(customPresetStorageKey, nextPresets)
  }

  function handleDeleteCustomWindowPreset(presetId: string) {
    const nextPresets = customWindowPresets.filter((preset) => preset.id !== presetId)
    setCustomWindowPresets(nextPresets)
    saveCustomWindowPresets(customPresetStorageKey, nextPresets)
  }

  function runToolbarMenuAction(action: ViewportMenuAction) {
    setOpenMenu(null)

    if (action.type === 'tool') {
      activateTool(action.tool)
      return
    }

    if (action.type === 'command') {
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
              {openMenu === menuId && <div className="ribbon-dropdown" style={dropdownStyle}>
                {section.items.map((item) => {
                  const ItemIcon = item.icon
                  return (
                    <button className={isToolbarMenuActionActive(item.action) ? 'ribbon-option active' : 'ribbon-option'} key={item.id} type="button" onClick={() => runToolbarMenuAction(item.action)}>
                      <ItemIcon size={20} />
                      <span>{item.label}</span>
                      {getMenuItemHotkey(item, hotkeyOverrides) && <kbd>{getMenuItemHotkey(item, hotkeyOverrides)}</kbd>}
                    </button>
                  )
                })}
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
              <button className="ribbon-option" type="button" onClick={() => { sendViewportCommand('preset-lung'); setOpenMenu(null) }}>Lung WW 1500 / WL -600</button>
              <button className="ribbon-option" type="button" onClick={() => { sendViewportCommand('preset-bone'); setOpenMenu(null) }}>Bone WW 2000 / WL 500</button>
              <button className="ribbon-option" type="button" onClick={() => { sendViewportCommand('preset-brain'); setOpenMenu(null) }}>Brain WW 80 / WL 40</button>
              <button className="ribbon-option" type="button" onClick={() => { sendViewportCommand('preset-mediastinum'); setOpenMenu(null) }}>Mediastinum WW 350 / WL 50</button>
              <button className="ribbon-option" type="button" onClick={() => { sendViewportCommand('preset-soft'); setOpenMenu(null) }}>Soft Tissue WW 400 / WL 40</button>
              {customWindowPresets.length > 0 && (
                <div className="custom-preset-list">
                  {customWindowPresets.map((preset) => (
                    <div className="custom-preset-row" key={preset.id}>
                      <button type="button" onClick={() => applyWindowLevel(preset.windowWidth, preset.windowLevel)}>
                        <strong>{preset.name}</strong>
                        <span>WW {preset.windowWidth} / WL {preset.windowLevel}</span>
                      </button>
                      <button className="custom-preset-delete" type="button" title="Delete preset" aria-label={`Delete ${preset.name}`} onClick={() => handleDeleteCustomWindowPreset(preset.id)}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="custom-preset-editor" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                <label>
                  <span>WW</span>
                  <input inputMode="numeric" value={customPresetWw} onChange={(event) => setCustomPresetWw(event.currentTarget.value)} />
                </label>
                <label>
                  <span>WL</span>
                  <input inputMode="numeric" value={customPresetWl} onChange={(event) => setCustomPresetWl(event.currentTarget.value)} />
                </label>
                <label className="custom-preset-name">
                  <span>Name</span>
                  <input value={customPresetName} onChange={(event) => setCustomPresetName(event.currentTarget.value)} />
                </label>
                <div className="custom-preset-actions">
                  <button type="button" onClick={handleApplyCustomWindowPreset}>Apply</button>
                  <button type="button" onClick={handleSaveCustomWindowPreset}>Save</button>
                </div>
              </div>
            </div>}
          </div>
        )}
        </>}
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
              const overlayInfo = buildViewportOverlayInfo({
                study: activeStudy,
                series: viewportStack?.series ?? activeSeries,
                metadata,
                imageIndex,
                imageCount,
                windowLevel,
                zoom: viewportZooms[key] ?? 1,
              })
              const isVolume3dTile = volume3dViewport?.key === key
              const viewportModality = viewportStack?.series.modality?.toUpperCase()
              const isMprTile = Boolean(mprMode && useViewerStore.getState().mprViewportKeys[key] && (viewportModality === 'CT' || viewportModality === 'MR'))
              const isFullscreenTile = fullscreenViewportKey === key
              const useServerRenderedStack = serverRenderMode
                && hasImages
                && !isMprTile
                && !isVolume3dTile
                && ['CT', 'MR', 'CR', 'DX', 'DR', 'XA', 'MG'].includes(viewportModality ?? '')

              return (
                <div
                  className={`${selectedViewportKey === key ? 'viewport-tile selected' : 'viewport-tile'}${isVolume3dTile ? ' volume-3d' : ''}${isMprTile ? ' volume-mpr' : ''}${isFullscreenTile ? ' fullscreen' : ''}${fullscreenViewportKey && !isFullscreenTile ? ' fullscreen-hidden' : ''}`}
                  data-viewport-key={key}
                  key={key}
                  onDragOver={(event) => {
                    if (hasPermission('viewer.series.drag_drop') && event.dataTransfer.types.includes('application/nexia-series')) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'copy'
                    }
                  }}
                  onDrop={(event) => handleSeriesDrop(event, key)}
                >
                  {isMprTile && viewportStack ? (
                    serverRenderMode ? <ServerMprCornerstoneViewport
                      series={viewportStack.series}
                      study={activeStudy}
                      instances={viewportStack.instances}
                      viewportKey={key}
                      isSelected={selectedViewportKey === key}
                      referenceLinesEnabled={referenceLinesEnabled}
                      onReady={handleStackViewportReady}
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
                  ) : useServerRenderedStack ? (
                    <ServerStackCornerstoneViewport
                      viewportKey={key}
                      study={activeStudy}
                      series={viewportStack?.series ?? null}
                      instances={viewportStack?.instances ?? []}
                      requestedSopInstanceUid={requestedSopInstanceUid}
                      imageCount={viewportStack?.imageIds.length ?? 0}
                      isSelected={selectedViewportKey === key}
                      referenceLinesEnabled={referenceLinesEnabled}
                      contextMenuEnabled={viewerAppearance.contextMenuEnabled}
                      onReady={handleStackViewportReady}
                      onToggleOverlay={() => setShowOverlay((value) => !value)}
                      onOpenTagBrowser={() => setIsTagBrowserOpen(true)}
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
                      onReady={handleStackViewportReady}
                      onToggleOverlay={() => setShowOverlay((value) => !value)}
                      onOpenTagBrowser={() => setIsTagBrowserOpen(true)}
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
                  {showOverlay && !isMprTile && hasImages && (
                    <div className="viewport-overlay top-left">
                      {overlayInfo.topLeft.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                  )}
                  {showOverlay && !isMprTile && hasImages && !isVolume3dTile && (
                    <div className="viewport-overlay top-right">
                      {overlayInfo.topRight.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                  )}
                  {!isMprTile && viewportStudyColor && (
                    <span className="viewport-study-dot" style={{ backgroundColor: viewportStudyColor }} />
                  )}
                  {showOverlay && !isMprTile && hasImages && (
                    <>
                    <div className="viewport-overlay bottom-left">
                      {overlayInfo.bottomLeft.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                    <div className="viewport-overlay bottom-right viewport-image-info">
                      {overlayInfo.bottomRight.map((line, lineIndex) => <span key={`${line}-${lineIndex}`}>{line}</span>)}
                    </div>
                    </>
                  )}
                  {activeTool === 'Zoom' && selectedViewportKey === key && hasImages && (
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
          </div>
        )}
      </div>

      {browserPosition === 'bottom' && seriesBrowserPanel}

      {isTagBrowserOpen && <DicomTagBrowser metadata={getSelectedMetadata(selectedStack, viewportSliceIndexes[selectedViewportKey] ?? 0)} onClose={() => setIsTagBrowserOpen(false)} />}
      {isAmbientTestOpen && <AmbientLightTestModal onClose={() => setIsAmbientTestOpen(false)} />}
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
        Make sure every faint circle is still visible. If any is not visible, dim the room lighting or calibrate the display.
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
}

function buildViewportOverlayInfo({ study, series, metadata, imageIndex, imageCount, windowLevel, zoom }: ViewportOverlayInput) {
  const patientName = readOverlayString(metadata, '00100010') || study?.patientName
  const patientId = readOverlayString(metadata, '00100020') || study?.patientId
  const birthDate = readOverlayString(metadata, '00100030')
  const studyDate = readOverlayString(metadata, '00080020') || study?.studyDate || series?.studyDate
  const studyTime = readOverlayString(metadata, '00080030')
  const patientAge = readOverlayString(metadata, '00101010') || calculatePatientAge(birthDate, studyDate)
  const sex = readOverlayString(metadata, '00100040')
  const institutionName = readOverlayString(metadata, '00080080')
  const departmentName = readOverlayString(metadata, '00081040')
  const modality = (readOverlayString(metadata, '00080060') || series?.modality || study?.modalities || '').toUpperCase()
  const studyDescription = readOverlayString(metadata, '00081030') || study?.studyDescription
  const seriesDescription = readOverlayString(metadata, '0008103E') || series?.seriesDescription
  const protocolName = readOverlayString(metadata, '00181030')
  const accessionNumber = readOverlayString(metadata, '00080050') || study?.accessionNumber
  const bodyPart = readOverlayString(metadata, '00180015')
  const viewPosition = readOverlayString(metadata, '00185101')
  const patientPosition = readOverlayString(metadata, '00185100')
  const instanceNumber = readOverlayString(metadata, '00200013')
  const topRightExam = compactOverlayLine([modality, studyDescription], ' - ')
  const topRightSeries = compactOverlayLine([seriesDescription || protocolName, bodyPart, viewPosition || patientPosition], ' ')
  const formattedStudyDateTime = compactOverlayLine([formatOverlayDate(studyDate), formatOverlayTime(studyTime)], ', ')
  const modalityOverlay = buildModalityOverlay({ metadata, modality, imageIndex, imageCount, windowLevel, zoom, instanceNumber })

  return {
    topLeft: compactOverlayLines([
      patientName,
      patientId,
      formatOverlayDate(birthDate),
      patientAge,
      sex,
    ]),
    topRight: compactOverlayLines([
      institutionName,
      topRightExam,
      topRightSeries,
      formattedStudyDateTime,
      accessionNumber,
      '---',
    ]),
    bottomLeft: modalityOverlay.bottomLeft,
    bottomRight: compactOverlayLines([
      '---',
      departmentName,
      ...modalityOverlay.bottomRight,
    ]),
  }
}

type ModalityOverlayInput = {
  metadata?: DicomJsonDataset
  modality: string
  imageIndex: number
  imageCount: number
  windowLevel?: { windowWidth: number; windowLevel: number }
  zoom: number
  instanceNumber: string
}

function buildModalityOverlay({ metadata, modality, imageIndex, imageCount, windowLevel, zoom, instanceNumber }: ModalityOverlayInput) {
  const commonImageLines = buildCommonImageOverlay({ imageIndex, imageCount, windowLevel, zoom, instanceNumber })

  if (['CR', 'DX', 'PX', 'RF'].includes(modality)) {
    return {
      bottomLeft: buildProjectionXrayOverlay(metadata, imageIndex, imageCount),
      bottomRight: commonImageLines,
    }
  }

  if (modality === 'CT') {
    return {
      bottomLeft: compactOverlayLines([
        formatOverlayLabeledNumber('KVP', readOverlayNumber(metadata, '00180060')),
        formatOverlayLabeledNumber('mA', readOverlayNumber(metadata, '00181151')),
        formatOverlayLabeledNumber('ET', readOverlayNumber(metadata, '00181150')),
        formatOverlayLabeledNumber('CTDIvol', readOverlayNumber(metadata, '00189345'), 2),
        formatOverlayLabeledNumber('Pitch', readOverlayNumber(metadata, '00189311'), 2),
        formatOverlayOptionalLabel('Kernel', readOverlayString(metadata, '00181210')),
        imageCount ? `Page: ${imageIndex} of ${imageCount}` : undefined,
      ]),
      bottomRight: compactOverlayLines([
        formatOverlayLabeledNumber('LOC', readOverlayNumber(metadata, '00201041'), 2),
        formatOverlayLabeledNumber('THK', readOverlayNumber(metadata, '00180050'), 2),
        formatOverlayLabeledNumber('SP', readOverlayNumber(metadata, '00180088'), 2),
        formatOverlayLabeledNumber('DFOV', readOverlayNumber(metadata, '00181100'), 2),
        ...commonImageLines,
      ]),
    }
  }

  if (modality === 'MR') {
    return {
      bottomLeft: compactOverlayLines([
        formatOverlayOptionalLabel('Seq', readOverlayString(metadata, '00180024')),
        formatOverlayOptionalLabel('Type', readOverlayString(metadata, '00180023')),
        formatOverlayLabeledNumber('TR', readOverlayNumber(metadata, '00180080'), 1),
        formatOverlayLabeledNumber('TE', readOverlayNumber(metadata, '00180081'), 1),
        formatOverlayLabeledNumber('TI', readOverlayNumber(metadata, '00180082'), 1),
        formatOverlayLabeledNumber('FA', readOverlayNumber(metadata, '00181314'), 1),
        imageCount ? `Page: ${imageIndex} of ${imageCount}` : undefined,
      ]),
      bottomRight: compactOverlayLines([
        formatOverlayLabeledNumber('B', readOverlayNumber(metadata, '00180087'), 2),
        formatOverlayLabeledNumber('LOC', readOverlayNumber(metadata, '00201041'), 2),
        formatOverlayLabeledNumber('THK', readOverlayNumber(metadata, '00180050'), 2),
        formatOverlayLabeledNumber('SP', readOverlayNumber(metadata, '00180088'), 2),
        ...commonImageLines,
      ]),
    }
  }

  if (modality === 'MG') {
    return {
      bottomLeft: compactOverlayLines([
        formatOverlayOptionalLabel('Laterality', readOverlayString(metadata, '00200062') || readOverlayString(metadata, '00200060')),
        formatOverlayOptionalLabel('View', readOverlayString(metadata, '00185101')),
        formatOverlayLabeledNumber('KVP', readOverlayNumber(metadata, '00180060')),
        formatOverlayLabeledNumber('mAs', readOverlayNumber(metadata, '00181153') ? readOverlayNumber(metadata, '00181153')! / 1000 : undefined, 2),
        formatOverlayLabeledNumber('Force', readOverlayNumber(metadata, '001811A2'), 1),
        formatOverlayLabeledNumber('Thickness', readOverlayNumber(metadata, '001811A0'), 1),
        imageCount ? `Page: ${imageIndex} of ${imageCount}` : undefined,
      ]),
      bottomRight: compactOverlayLines([
        formatOverlayOptionalLabel('Target', readOverlayString(metadata, '00181191')),
        formatOverlayLabeledNumber('OrganDose', readOverlayNumber(metadata, '00400316'), 3),
        ...commonImageLines,
      ]),
    }
  }

  if (modality === 'US') {
    const region = readFirstOverlaySequenceItem(metadata, '00186011')
    return {
      bottomLeft: compactOverlayLines([
        formatOverlayOptionalLabel('Probe', readOverlayString(metadata, '00185010')),
        formatOverlayLabeledNumber('Freq', readOverlayNumber(region, '00186030') ?? readOverlayNumber(metadata, '00186030'), 2),
        formatOverlayLabeledNumber('Depth', readOverlayNumber(metadata, '00185050'), 1),
        formatOverlayLabeledNumber('Focus', readOverlayNumber(metadata, '00185012'), 1),
        formatOverlayLabeledNumber('MI', readOverlayNumber(metadata, '00185022'), 2),
        formatOverlayLabeledNumber('TI', readOverlayNumber(metadata, '00185024'), 2),
        imageCount ? `Frame: ${imageIndex} of ${imageCount}` : undefined,
      ]),
      bottomRight: compactOverlayLines([
        formatOverlayOptionalLabel('Preset', readOverlayString(metadata, '00181030')),
        `Z: ${formatOverlayDecimal(zoom, 2)}`,
        `IM: ${instanceNumber || imageIndex}`,
      ]),
    }
  }

  if (['XA', 'XRF'].includes(modality)) {
    return {
      bottomLeft: compactOverlayLines([
        formatOverlayOptionalLabel('Contrast', readOverlayString(metadata, '00180010')),
        formatOverlayLabeledNumber('KVP', readOverlayNumber(metadata, '00180060')),
        formatOverlayLabeledNumber('mA', readOverlayNumber(metadata, '00181151')),
        formatOverlayLabeledNumber('ET', readOverlayNumber(metadata, '00181150')),
        formatOverlayLabeledNumber('FrameTime', readOverlayNumber(metadata, '00181063'), 1),
        formatOverlayLabeledNumber('DAP', readOverlayNumber(metadata, '0018115E'), 2),
        imageCount ? `Frame: ${imageIndex} of ${imageCount}` : undefined,
      ]),
      bottomRight: compactOverlayLines([
        formatOverlayLabeledNumber('Primary', readOverlayNumber(metadata, '00181510'), 1),
        formatOverlayLabeledNumber('Secondary', readOverlayNumber(metadata, '00181511'), 1),
        ...commonImageLines,
      ]),
    }
  }

  if (['NM', 'PT'].includes(modality)) {
    return {
      bottomLeft: compactOverlayLines([
        formatOverlayOptionalLabel('Series', readOverlayString(metadata, '0008103E')),
        imageCount ? `Frame: ${imageIndex} of ${imageCount}` : undefined,
      ]),
      bottomRight: compactOverlayLines([
        `Z: ${formatOverlayDecimal(zoom, 2)}`,
        ...formatWindowLevelOverlay(windowLevel),
        `IM: ${instanceNumber || imageIndex}`,
      ]),
    }
  }

  return {
    bottomLeft: compactOverlayLines([
      formatOverlayOptionalLabel('Manufacturer', readOverlayString(metadata, '00080070')),
      formatOverlayOptionalLabel('Model', readOverlayString(metadata, '00081090')),
      imageCount ? `Page: ${imageIndex} of ${imageCount}` : undefined,
    ]),
    bottomRight: commonImageLines,
  }
}

function buildProjectionXrayOverlay(metadata: DicomJsonDataset | undefined, imageIndex: number, imageCount: number) {
  const exposureInMicroAs = readOverlayNumber(metadata, '00181153')

  return compactOverlayLines([
    formatOverlayLabeledNumber('mA', readOverlayNumber(metadata, '00181151')),
    formatOverlayLabeledNumber('KVP', readOverlayNumber(metadata, '00180060')),
    formatOverlayLabeledNumber('ET', readOverlayNumber(metadata, '00181150')),
    formatOverlayLabeledNumber('mAs', exposureInMicroAs ? exposureInMicroAs / 1000 : undefined, 2),
    formatOverlayLabeledNumber('EI', readOverlayNumber(metadata, '00181411')),
    formatOverlayLabeledNumber('TI', readOverlayNumber(metadata, '00181412')),
    formatOverlayLabeledNumber('DI', readOverlayNumber(metadata, '00181413'), 2),
    imageCount ? `Page: ${imageIndex} of ${imageCount}` : undefined,
  ])
}

function buildCommonImageOverlay({ imageIndex, imageCount, windowLevel, zoom, instanceNumber }: Pick<ModalityOverlayInput, 'imageIndex' | 'imageCount' | 'windowLevel' | 'zoom' | 'instanceNumber'>) {
  return compactOverlayLines([
    `Z: ${formatOverlayDecimal(zoom, 2)}`,
    ...formatWindowLevelOverlay(windowLevel),
    `IM: ${instanceNumber || imageIndex}${imageCount ? ` / ${imageCount}` : ''}`,
  ])
}

function formatWindowLevelOverlay(windowLevel?: { windowWidth: number; windowLevel: number }) {
  return windowLevel ? [
    `C: ${formatOverlayNumber(windowLevel.windowLevel)}`,
    `W: ${formatOverlayNumber(windowLevel.windowWidth)}`,
  ] : []
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
  const parsedValue = Number(rawValue)
  return Number.isFinite(parsedValue) ? parsedValue : undefined
}

function readFirstOverlaySequenceItem(metadata: DicomJsonDataset | undefined, tag: string) {
  const value = metadata?.[tag]?.Value?.[0]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DicomJsonDataset : undefined
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

function formatOverlayLabeledNumber(label: string, value?: number, fractionDigits = 0) {
  if (!Number.isFinite(value)) {
    return ''
  }

  return `${label}: ${formatOverlayDecimal(value as number, fractionDigits)}`
}

function formatOverlayOptionalLabel(label: string, value?: string) {
  return value ? `${label}: ${value}` : ''
}

function formatOverlayDecimal(value: number, fractionDigits = 0) {
  if (!Number.isFinite(value)) {
    return ''
  }

  const roundedValue = Number(value.toFixed(fractionDigits))
  return fractionDigits ? roundedValue.toFixed(fractionDigits) : String(roundedValue)
}

function formatOverlayNumber(value?: number) {
  if (!Number.isFinite(value)) {
    return '-'
  }

  return String(Math.round(value as number))
}
