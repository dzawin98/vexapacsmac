import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { vec3 } from 'gl-matrix'
import { Brush, ChevronDown, ChevronRight, Download, Droplets, Eraser as EraserIcon, Film, Gauge, Layers3, Link2, LogOut, Maximize2, Minimize2, Play, Redo2, Save, ScanLine, Settings, Sparkles, Trash2, Undo2, X, type LucideIcon } from 'lucide-react'
import {
  cache,
  Enums,
  RenderingEngine,
  eventTarget,
  setVolumesForViewports,
  type Types,
  getRenderingEngine,
} from '@cornerstonejs/core'
import {
  ToolGroupManager,
  Enums as ToolEnums,
  AngleTool,
  BidirectionalTool,
  BrushTool,
  CircleROITool,
  CobbAngleTool,
  CrosshairsTool,
  EllipticalROITool,
  EraserTool,
  LengthTool,
  PanTool,
  PlanarFreehandROITool,
  ProbeTool,
  RectangleROITool,
  ReferenceLinesTool,
  StackScrollTool,
  TrackballRotateTool,
  WindowLevelTool,
  ZoomTool,
} from '@cornerstonejs/tools'
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction'
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction'
import type { SeriesSummary, StudySummary } from '../../dicomweb/types'
import { useAuthStore } from '../../auth/authStore'
import { clearAllAnnotations, deleteSelectedAnnotations } from '../annotationActions'
import { useViewerStore } from '../viewerStore'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { acquireSharedSeriesVolume, getDiagnosticVolumeOwnerId, releaseSharedSeriesVolume } from '../cornerstone/volumeCache'
import {
  hasActiveMenuItem,
  createHotkeyActions,
  getMenuItemHotkey,
  getPermittedMenuSections,
  isEditableEventTarget,
  toHotkey,
  type ViewportMenuAction,
} from './DicomViewport'
import {
  ICH_DEFAULT_BRUSH_SIZE,
  ICH_DEFAULT_OPACITY,
  ICH_DEFAULT_THRESHOLD_MAX,
  ICH_DEFAULT_THRESHOLD_MIN,
  applyIchVolumeSmartDrag,
  captureIchVolumeSnapshot,
  clearIchSegment,
  detachIchSegmentationFromViewports,
  ensureIchSegmentation,
  getIchVolumeSegmentStats,
  mergeIchAdaptiveHuModels,
  restoreIchVolumeSnapshot,
  setIchBrushSize,
  setIchSegmentationOpacity,
  setIchSegmentationVisibility,
  type IchAdaptiveHuModel,
  type IchVolumeForbiddenRegion,
  type IchVolumeSnapshot,
} from '../cornerstone/ichSegmentation'
import { renderSecondaryCaptureCanvas, saveViewportCaptureSeries, type ViewportCaptureSource } from '../dicomSave'
import { exportIchMovieFile, importIchSegmentationFromDicom, saveIchMovieAsDicom, type IchMovieFrames } from '../ichDicom'

const MPR_VIEWPORT_DEFS: readonly { id: string; label: string; orientation: keyof typeof Enums.OrientationAxis }[] = [
  { id: 'axial', label: 'A', orientation: 'AXIAL' },
  { id: 'sagittal', label: 'S', orientation: 'SAGITTAL' },
  { id: 'coronal', label: 'C', orientation: 'CORONAL' },
  { id: 'axial-compare', label: 'A', orientation: 'AXIAL' },
] as const
const MPR_ICH_3D_PANE_ID = 'axial-compare'
const MPR_ICH_3D_ACTOR_UID = 'mpr-ich-3d-mask-volume'
const MPR_ICH_3D_DEFAULT_WW = 60
const MPR_ICH_3D_DEFAULT_WL = 65
const MPR_ICH_HISTORY_LIMIT = 32
const MPR_ORIENTATION_OPTIONS = [
  { label: 'A', name: 'Axial', orientation: 'AXIAL' },
  { label: 'S', name: 'Sagittal', orientation: 'SAGITTAL' },
  { label: 'C', name: 'Coronal', orientation: 'CORONAL' },
] as const
const MPR_STANDARD_CAMERAS = {
  AXIAL: { label: 'A', normal: vec3.fromValues(0, 0, -1), viewUp: vec3.fromValues(0, -1, 0) },
  CORONAL: { label: 'C', normal: vec3.fromValues(0, -1, 0), viewUp: vec3.fromValues(0, 0, 1) },
  SAGITTAL: { label: 'S', normal: vec3.fromValues(-1, 0, 0), viewUp: vec3.fromValues(0, 0, 1) },
} as const
const MPR_BLEND_MODE_OPTIONS: readonly { id: MprBlendMode; code: string; label: string; title: string; icon: LucideIcon }[] = [
  { id: 'normal', code: 'N', label: 'Normal', title: 'Normal MPR', icon: ScanLine },
  { id: 'mip', code: 'MIP', label: 'MIP', title: 'Maximum Intensity Projection', icon: Maximize2 },
  { id: 'minip', code: 'MinIP', label: 'MinIP', title: 'Minimum Intensity Projection', icon: Minimize2 },
  { id: 'aip', code: 'AIP', label: 'AIP', title: 'Average Intensity Projection', icon: Layers3 },
] as const
const ORIENTATION_LABEL_TOLERANCE = 0.01

type MprStatus = { loading: boolean; error: string }
type MprBlendMode = 'normal' | 'mip' | 'minip' | 'aip'
type MprIntelliLinkOption = 'scroll' | 'windowLevel' | 'pan' | 'zoom'
type MprLinkedCommandType = 'set-mpr-slice' | 'set-zoom' | 'set-pan' | 'set-window-level' | 'preset-lung' | 'preset-bone' | 'preset-brain' | 'preset-mediastinum' | 'preset-soft'
type MprLinkedCommandOptions = {
  sliceIndex?: number
  zoom?: number
  camera?: Types.ICamera
  windowLevel?: { windowWidth: number; windowLevel: number }
}
type MprSliceDisplayInfo = { sliceIndex: number; sliceCount: number }
type MprModifierGesture =
  | { type: 'zoom'; pointerId: number; viewportId: string; startY: number; startZoom: number }
  | { type: 'pan'; pointerId: number; viewportId: string; lastCanvasPoint: Types.Point2 }
type MprLiveProbeValue = {
  viewportId: string
  canvasPoint: Types.Point2
  value: number
  unit: string
}
type MprViewportViewState = {
  camera: Types.ICamera
  zoom: number
}
type MprIchSmartDragPoint = {
  canvasPoint: Types.Point2
  worldPoint: Types.Point3
  ijkPoint: Types.Point3 | null
}
type MprIchSmartDragSession = {
  pointerId: number
  viewportId: string
  segmentationId: string
  element: HTMLDivElement
  mode: 'add' | 'erase'
  seedWorld: Types.Point3
  currentWorld: Types.Point3
  seedIJK: Types.Point3 | null
  currentIJK: Types.Point3 | null
  startCanvas: Types.Point2
  currentCanvas: Types.Point2
}
type MprIchSmartDragPreview = {
  viewportId: string
  mode: 'add' | 'erase'
  center: Types.Point2
  radiusPx: number
}
type MprIchDebugInfo = {
  viewportId: string
  phase: string
  ijkPoint: Types.Point3 | null
  matchedVoxels?: number
  message?: string
}
type MprIch3dVolumeActor = {
  getProperty?: () => {
    setScalarOpacity: (component: number, functionValue: unknown) => void
    setRGBTransferFunction: (component: number, functionValue: unknown) => void
    setScalarOpacityUnitDistance?: (component: number, distance: number) => void
    setShade?: (shade: boolean) => void
    setAmbient?: (ambient: number) => void
    setDiffuse?: (diffuse: number) => void
    setSpecular?: (specular: number) => void
    setSpecularPower?: (power: number) => void
    setInterpolationTypeToLinear?: () => void
  }
  getMapper?: () => {
    setSampleDistance?: (distance: number) => void
  }
}

type IchMovieDirection = 'right' | 'left' | 'up' | 'down'
type IchMovieConfig = {
  direction: IchMovieDirection
  fps: number
  durationSeconds: number
  resolution: number
}

const mprTransientToolByStoreId: Record<string, string> = {
  Length: LengthTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  CircleROI: CircleROITool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  RectangleROI: RectangleROITool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
}

function mprStatusReducer(_state: MprStatus, action: { type: 'loading' } | { type: 'done' } | { type: 'error'; error: string }): MprStatus {
  switch (action.type) {
    case 'loading': return { loading: true, error: '' }
    case 'done': return { loading: false, error: '' }
    case 'error': return { loading: false, error: action.error }
  }
}

type MprViewerProps = {
  series: SeriesSummary
  study?: StudySummary | null
  viewportKey?: string
  isSelected?: boolean
  showOverlay?: boolean
  contextMenuEnabled?: boolean
  onToggleOverlay?: () => void
  onOpenTagBrowser?: () => void
  onToggleMpr?: () => void
  onToggle3d?: () => void
  onToggle3dBone?: () => void
  onOpenAmbientTest?: () => void
  onSelect?: () => void
  onToggleViewportFullscreen?: () => void
  onExitIchWorkspace?: () => void
  initialIchSegmentation?: {
    arrayBuffer: ArrayBuffer
    sopInstanceUid: string
  } | null
  initialWindowLevel?: { windowWidth: number; windowLevel: number }
}

export function MprViewer(props: MprViewerProps) {
  return <LegacyMprViewer {...props} />
}

export function LegacyMprViewer({
  series,
  study,
  viewportKey = '0',
  isSelected = true,
  showOverlay = true,
  contextMenuEnabled = true,
  onToggleOverlay,
  onOpenTagBrowser,
  onToggleMpr,
  onToggle3d,
  onToggle3dBone,
  onOpenAmbientTest,
  onSelect,
  onToggleViewportFullscreen,
  onExitIchWorkspace,
  initialIchSegmentation,
  initialWindowLevel,
}: MprViewerProps) {
  const safeViewportKey = viewportKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  const mprViewportIds = useMemo(() => MPR_VIEWPORT_DEFS.map((item) => `mpr-${safeViewportKey}-${item.id}`), [safeViewportKey])
  const mprPrimaryPlaneViewportIds = useMemo(() => mprViewportIds.filter((_, index) => MPR_VIEWPORT_DEFS[index]?.id !== MPR_ICH_3D_PANE_ID), [mprViewportIds])
  const mprCompareViewportId = useMemo(() => mprViewportIds.find((_, index) => MPR_VIEWPORT_DEFS[index]?.id === MPR_ICH_3D_PANE_ID) ?? '', [mprViewportIds])
  const containerRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const elementRefs = useRef<(HTMLDivElement | null)[]>([])
  const [{ loading }, dispatchStatus] = useReducer(mprStatusReducer, { loading: true, error: '' })
  const setMprVolumeId = useViewerStore((state) => state.setMprVolumeId)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const setMprActiveViewportId = useViewerStore((state) => state.setMprActiveViewportId)
  const setMprSliceInfo = useViewerStore((state) => state.setMprSliceInfo)
  const [activeViewport, setActiveViewport] = useState<string>(mprViewportIds[0])
  const [viewportOrientations, setViewportOrientations] = useState(() => MPR_VIEWPORT_DEFS.map((item) => getMprOrientationOptionIndex(item.orientation)))
  const viewportOrientationsRef = useRef(viewportOrientations)
  const [mprOrientationLabels, setMprOrientationLabels] = useState<Record<string, string>>(() => Object.fromEntries(mprViewportIds.map((id, index) => [id, MPR_VIEWPORT_DEFS[index]?.label ?? 'A'])))
  const [slabThicknesses, setSlabThicknesses] = useState<Record<string, number>>(() => Object.fromEntries(mprViewportIds.map((id) => [id, 1])))
  const [slabThicknessInputs, setSlabThicknessInputs] = useState<Record<string, string>>(() => Object.fromEntries(mprViewportIds.map((id) => [id, '1'])))
  const [blendModes, setBlendModes] = useState<Record<string, MprBlendMode>>(() => Object.fromEntries(mprViewportIds.map((id) => [id, 'normal' as MprBlendMode])))
  const [projectionSyncEnabled, setProjectionSyncEnabled] = useState(false)
  const [previewUrls, setPreviewUrls] = useState<Partial<Record<string, string>> | null>(null)
  const [volumeLoaded, setVolumeLoaded] = useState(false)
  const [loadedMprVolumeId, setLoadedMprVolumeId] = useState<string | null>(null)
  const [mprSliceDisplayInfo, setMprSliceDisplayInfo] = useState<Record<string, MprSliceDisplayInfo>>({})
  const [mprWindowLevels, setMprWindowLevels] = useState<Record<string, { windowWidth: number; windowLevel: number }>>({})
  const slabThicknessesRef = useRef(slabThicknesses)
  const engineIdRef = useRef(`mpr-rendering-engine-${safeViewportKey}`)
  const toolGroupId = useMemo(() => `mpr-tool-group-${safeViewportKey}`, [safeViewportKey])
  const compareToolGroupId = useMemo(() => `mpr-compare-tool-group-${safeViewportKey}`, [safeViewportKey])
  const ich3dToolGroupId = useMemo(() => `mpr-ich-3d-tool-group-${safeViewportKey}`, [safeViewportKey])
  const toolGroupRef = useRef<ReturnType<typeof ToolGroupManager.createToolGroup>>(null)
  const compareToolGroupRef = useRef<ReturnType<typeof ToolGroupManager.createToolGroup>>(null)
  const ich3dToolGroupRef = useRef<ReturnType<typeof ToolGroupManager.createToolGroup>>(null)
  const lastPointerDownRef = useRef<{ viewportId: string; time: number }>({ viewportId: '', time: 0 })
  const cameraStabilizeFrameRef = useRef<number | null>(null)
  const lockingMprOrientationRef = useRef(false)
  const applyingLinkedCommandRef = useRef(false)
  const activeTool = useViewerStore((state) => state.activeTool)
  const hotkeyOverrides = useViewerStore((state) => state.hotkeyOverrides)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const permittedMenuSections = getPermittedMenuSections(hasPermission, series.modality ?? '')
  const canSaveIchSegmentation = hasPermission('ich.segmentation.save')
  const canExportIchCine = hasPermission('ich.cine.export')
  const referenceLinesEnabled = useViewerStore((state) => state.referenceLinesEnabled)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const setReferenceLinesEnabled = useViewerStore((state) => state.setReferenceLinesEnabled)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const viewportCommand = useViewerStore((state) => state.viewportCommand)
  const [mprZooms, setMprZooms] = useState<Record<string, number>>(() => Object.fromEntries(mprViewportIds.map((id) => [id, 1])))
  const modifierGestureRef = useRef<MprModifierGesture | null>(null)
  const mprCursorDragRef = useRef<{ pointerId: number; viewportId: string } | null>(null)
  const mprCursorWorldRef = useRef<Types.Point3 | null>(null)
  const mprLiveProbePointerRef = useRef<{ pointerId: number; viewportId: string } | null>(null)
  const [mprCursorPoints, setMprCursorPoints] = useState<Record<string, Types.Point2 | null>>({})
  const [mprLiveProbeValue, setMprLiveProbeValue] = useState<MprLiveProbeValue | null>(null)
  const [expandedControlViewports, setExpandedControlViewports] = useState<Record<string, boolean>>({})
  const [maximizedMprViewportId, setMaximizedMprViewportId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [activeContextSection, setActiveContextSection] = useState(permittedMenuSections[0]?.title ?? '')
  const [ichSegmentationId, setIchSegmentationId] = useState<string | null>(null)
  const ichSegmentationIdRef = useRef<string | null>(null)
  const ichMprWorkspaceActive = useViewerStore((state) => Boolean(state.ichMprViewportKeys[viewportKey]))
  const setIchMprWorkspace = useViewerStore((state) => state.setIchMprWorkspace)
  const isIchToolActive = activeTool === 'ICHSegment' || activeTool === 'ICHEraser'
  const isIchWorkspaceActive = ichMprWorkspaceActive || isIchToolActive
  const isIchMprLayout = isIchWorkspaceActive
  const mprPlaneViewportIds = useMemo(() => (isIchMprLayout ? mprPrimaryPlaneViewportIds : mprViewportIds), [isIchMprLayout, mprPrimaryPlaneViewportIds, mprViewportIds])
  const ich3dViewportId = isIchMprLayout ? mprCompareViewportId : ''
  const [ichBrushSize, setIchBrushSizeState] = useState(ICH_DEFAULT_BRUSH_SIZE)
  const [ichOpacity, setIchOpacity] = useState(ICH_DEFAULT_OPACITY)
  const [ichSmartDragEnabled, setIchSmartDragEnabled] = useState(true)
  const [, setIchSmartStatus] = useState('')
  const [ichVolumeInfo, setIchVolumeInfo] = useState<{ voxelCount: number; volumeMl: number | null }>({ voxelCount: 0, volumeMl: null })
  const [ich3dWindowWidth, setIch3dWindowWidth] = useState(MPR_ICH_3D_DEFAULT_WW)
  const [ich3dWindowLevel, setIch3dWindowLevel] = useState(MPR_ICH_3D_DEFAULT_WL)
  const [showIch3dVolumeMl, setShowIch3dVolumeMl] = useState(true)
  const [ichHistoryState, setIchHistoryState] = useState({ canUndo: false, canRedo: false })
  const [ichSmartDragPreview, setIchSmartDragPreview] = useState<MprIchSmartDragPreview | null>(null)
  const [, setIchDebugInfo] = useState<MprIchDebugInfo | null>(null)
  const ichOpacityTimerRef = useRef<number | null>(null)
  const ichAdaptiveModelRef = useRef<IchAdaptiveHuModel | null>(null)
  const ichForbiddenRegionsRef = useRef<IchVolumeForbiddenRegion[]>([])
  const ichUndoSnapshotsRef = useRef<IchVolumeSnapshot[]>([])
  const ichRedoSnapshotsRef = useRef<IchVolumeSnapshot[]>([])
  const ichSmartDragRef = useRef<MprIchSmartDragSession | null>(null)
  const ichSmartDragWindowCleanupRef = useRef<(() => void) | null>(null)
  const ich3dWindowLevelDragRef = useRef<{ pointerId: number; startX: number; startY: number; windowWidth: number; windowLevel: number } | null>(null)
  const ich3dLabelmapVolumeIdRef = useRef<string | null>(null)
  const ich3dViewportModeRef = useRef<'plane' | 'ich3d'>('plane')
  const importedIchSopInstanceUidRef = useRef<string | null>(null)
  const [ichSaving, setIchSaving] = useState(false)
  const [ichMovieDialogOpen, setIchMovieDialogOpen] = useState(false)
  const [ichMovieConfig, setIchMovieConfig] = useState<IchMovieConfig>({
    direction: 'right',
    fps: 15,
    durationSeconds: 4,
    resolution: 384,
  })
  const [ichMovieBusy, setIchMovieBusy] = useState<'preview' | 'dicom' | 'local' | null>(null)
  const [ichMovieProgress, setIchMovieProgress] = useState(0)
  const [ichMovieStatus, setIchMovieStatus] = useState('')

  useEffect(() => {
    setMprActiveViewportId(mprViewportIds[0], viewportKey)
  }, [mprViewportIds, setMprActiveViewportId, viewportKey])

  useEffect(() => {
    if (!isIchWorkspaceActive) {
      setMaximizedMprViewportId(null)
    }
  }, [isIchWorkspaceActive])

  const mprToolNameByStoreId = useRef<Record<string, string>>({
    Scroll: StackScrollTool.toolName,
    WindowLevel: WindowLevelTool.toolName,
    Pan: PanTool.toolName,
    Zoom: ZoomTool.toolName,
    Length: LengthTool.toolName,
    Angle: AngleTool.toolName,
    CobbAngle: CobbAngleTool.toolName,
    Bidirectional: BidirectionalTool.toolName,
    CircleROI: CircleROITool.toolName,
    EllipticalROI: EllipticalROITool.toolName,
    RectangleROI: RectangleROITool.toolName,
    PlanarFreehandROI: PlanarFreehandROITool.toolName,
    Probe: ProbeTool.toolName,
    Crosshairs: CrosshairsTool.toolName,
    ICHSegment: BrushTool.toolName,
    ICHEraser: EraserTool.toolName,
  }).current
  const mprManagedToolNames = useRef(
    Array.from(new Set(Object.values(mprToolNameByStoreId))).filter((name) => name !== CrosshairsTool.toolName && name !== StackScrollTool.toolName)
  ).current

  useEffect(() => {
    slabThicknessesRef.current = slabThicknesses
  }, [slabThicknesses])

  useEffect(() => {
    viewportOrientationsRef.current = viewportOrientations
  }, [viewportOrientations])

  useEffect(() => () => {
    ichSmartDragWindowCleanupRef.current?.()
    ichSmartDragWindowCleanupRef.current = null
  }, [])

  useEffect(() => {
    const toolGroup = toolGroupRef.current
    if (!toolGroup || !ichSegmentationId) return

    setIchBrushSize(toolGroupId, ichBrushSize)
  }, [ichBrushSize, ichSegmentationId, toolGroupId])

  useEffect(() => {
    if (!ichSegmentationId) return

    if (ichOpacityTimerRef.current !== null) {
      window.clearTimeout(ichOpacityTimerRef.current)
    }
    ichOpacityTimerRef.current = window.setTimeout(() => {
      mprPlaneViewportIds.forEach((viewportId) => {
        setIchSegmentationOpacity(ichSegmentationId, viewportId, ichOpacity)
      })
      updateMprIch3dTransferFunction()
      renderMprViewports()
      ichOpacityTimerRef.current = null
    }, 80)

    return () => {
      if (ichOpacityTimerRef.current !== null) {
        window.clearTimeout(ichOpacityTimerRef.current)
        ichOpacityTimerRef.current = null
      }
    }
  }, [ichOpacity, ichSegmentationId, mprPlaneViewportIds])

  useEffect(() => {
    if (!ichSegmentationId) return

    const handleExportMaskVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ viewportKey?: string; visible?: boolean }>).detail
      if (detail?.viewportKey !== viewportKey) return
      const visible = detail.visible !== false
      mprPlaneViewportIds.forEach((viewportId) => {
        setIchSegmentationVisibility(ichSegmentationId, viewportId, visible, ichOpacity)
      })
      renderMprViewports()
    }

    window.addEventListener('vexa-viewer-export-mask-visibility', handleExportMaskVisibility)
    return () => window.removeEventListener('vexa-viewer-export-mask-visibility', handleExportMaskVisibility)
  }, [ichOpacity, ichSegmentationId, mprPlaneViewportIds, viewportKey])

  useEffect(() => {
    const handlePrepareViewportCapture = (event: Event) => {
      const detail = (event as CustomEvent<{
        viewportKey?: string
        captureViewportId?: string
        waitUntil?: (preparation: Promise<void>) => void
      }>).detail
      if (detail?.viewportKey !== viewportKey) return

      const prepare = async () => {
        if (ichSegmentationId && loadedMprVolumeId) {
          setIchVolumeInfo(getIchVolumeSegmentStats(ichSegmentationId, loadedMprVolumeId))
        }
        if (detail.captureViewportId === ich3dViewportId) {
          await refreshMprIch3dViewport()
        }
        const engine = getRenderingEngine(engineIdRef.current)
        const targetViewport = detail.captureViewportId
          ? engine?.getViewport(detail.captureViewportId) as Types.IVolumeViewport | undefined
          : undefined
        if (targetViewport) {
          resetViewportClippingRange(targetViewport)
          targetViewport.render()
        }
        renderMprViewports()
      }

      const preparation = prepare()
      detail.waitUntil?.(preparation)
    }

    window.addEventListener('vexa-viewer-prepare-viewport-capture', handlePrepareViewportCapture)
    return () => window.removeEventListener('vexa-viewer-prepare-viewport-capture', handlePrepareViewportCapture)
  }, [ich3dViewportId, ichSegmentationId, loadedMprVolumeId, viewportKey])

  useEffect(() => {
    if (!ichSegmentationId) {
      return
    }

    let frame: number | null = null
    const handleSegmentationDataModified = (event: Event) => {
      const detail = (event as CustomEvent<{ segmentationId?: string }>).detail
      if (detail?.segmentationId !== ichSegmentationId || frame !== null) {
        return
      }

      frame = window.requestAnimationFrame(() => {
        frame = null
        if (loadedMprVolumeId) {
          setIchVolumeInfo(getIchVolumeSegmentStats(ichSegmentationId, loadedMprVolumeId))
        }
        void refreshMprIch3dViewport()
        renderMprViewports()
      })
    }

    eventTarget.addEventListener(ToolEnums.Events.SEGMENTATION_DATA_MODIFIED, handleSegmentationDataModified)

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      eventTarget.removeEventListener(ToolEnums.Events.SEGMENTATION_DATA_MODIFIED, handleSegmentationDataModified)
    }
  }, [ichSegmentationId, loadedMprVolumeId])

  function ensureMprIchSegmentation() {
    if (!loadedMprVolumeId || !volumeLoaded || !cache.getVolume(loadedMprVolumeId)) {
      setErrorMessage('ICH segmentation is waiting for the MPR volume to finish loading.')
      return null
    }

    try {
      const nextState = ensureIchSegmentation({
        referencedVolumeId: loadedMprVolumeId,
        viewportIds: mprPlaneViewportIds,
        toolGroupId,
        brushSize: ichBrushSize,
        opacity: ichOpacity,
      })
      ichSegmentationIdRef.current = nextState.segmentationId
      setIchSegmentationId(nextState.segmentationId)
      setErrorMessage('')
      void refreshMprIch3dViewport(nextState.labelmapVolumeId)
      renderMprViewports()
      return nextState
    } catch (error) {
      console.warn('Unable to initialize ICH segmentation.', error)
      setErrorMessage('Unable to initialize ICH segmentation for this volume.')
      return null
    }
  }

  useEffect(() => {
    if (
      !initialIchSegmentation
      || !isIchWorkspaceActive
      || !volumeLoaded
      || !loadedMprVolumeId
      || importedIchSopInstanceUidRef.current === initialIchSegmentation.sopInstanceUid
    ) {
      return
    }

    let cancelled = false
    async function loadSavedSegmentation() {
      const state = ensureMprIchSegmentation()
      if (!state || !loadedMprVolumeId) {
        return
      }

      setLoadingMessage('Opening DICOM SEG ICH...')
      try {
        const stats = await importIchSegmentationFromDicom({
          arrayBuffer: initialIchSegmentation!.arrayBuffer,
          segmentationId: state.segmentationId,
          referencedVolumeId: loadedMprVolumeId,
        })
        if (cancelled) {
          return
        }
        importedIchSopInstanceUidRef.current = initialIchSegmentation!.sopInstanceUid
        setIchVolumeInfo(stats)
        resetMprIchHistoryState()
        void refreshMprIch3dViewport(state.labelmapVolumeId)
        renderMprViewports()
        setErrorMessage('')
      } catch (error) {
        if (!cancelled) {
          console.warn('Unable to import ICH DICOM SEG.', error)
          setErrorMessage(error instanceof Error ? error.message : 'Unable to open the ICH DICOM SEG object.')
        }
      } finally {
        if (!cancelled) {
          setLoadingMessage('')
        }
      }
    }

    void loadSavedSegmentation()
    return () => {
      cancelled = true
    }
  }, [initialIchSegmentation, isIchWorkspaceActive, loadedMprVolumeId, volumeLoaded])

  async function handleSaveIchDicom() {
    if (!canSaveIchSegmentation) {
      setErrorMessage('This role is not authorized to save ICH segmentation results to PACS.')
      return
    }
    if (!study || !loadedMprVolumeId || ichSaving) {
      if (!study) {
        setErrorMessage('Study metadata is not ready for saving the ICH segmentation.')
      }
      return
    }

    const state = ensureMprIchSegmentation()
    if (!state) {
      return
    }

    const requestedSeriesDescription = window.prompt('Enter a Series Description for the four-view ICH capture:')
    if (requestedSeriesDescription === null) {
      return
    }
    const seriesDescription = requestedSeriesDescription.trim()
    if (!seriesDescription) {
      setErrorMessage('Series Description is required.')
      return
    }
    if (seriesDescription.length > 64) {
      setErrorMessage('Series Description must not exceed 64 characters.')
      return
    }

    setIchSaving(true)
    setLoadingMessage('Preparing the four ICH viewports...')
    setErrorMessage('')
    try {
      await refreshMprIch3dViewport(state.labelmapVolumeId)
      renderMprViewports()
      await nextAnimationFrame()
      await nextAnimationFrame()

      const captureElements = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('.mpr-viewport-tile[data-capture-viewport-id]') ?? [])
      const captures: ViewportCaptureSource[] = []
      for (let index = 0; index < mprViewportIds.length; index += 1) {
        const viewportId = mprViewportIds[index]
        const element = captureElements.find((candidate) => candidate.dataset.captureViewportId === viewportId)
        if (!element || element.getBoundingClientRect().width <= 0 || element.getBoundingClientRect().height <= 0) {
          throw new Error('All four ICH viewports must be visible before saving the capture series.')
        }
        setLoadingMessage(`Capturing ICH viewport ${index + 1} of ${mprViewportIds.length}...`)
        const canvas = await renderSecondaryCaptureCanvas(element, undefined, {
          targetLongEdge: 1600,
          cropToContent: false,
          includeTextOverlay: true,
          includeAnnotations: true,
          includeMasks: true,
          anonymize: false,
        })
        captures.push({
          canvas,
          label: element.dataset.captureLabel?.trim() || `ICH Viewport ${index + 1}`,
          series,
          instance: null,
        })
      }

      setLoadingMessage('Saving four ICH images as one DICOM series...')
      await saveViewportCaptureSeries({ study, seriesDescription, captures })
    } catch (error) {
      console.warn('Unable to save the ICH viewport capture series.', error)
      setErrorMessage(error instanceof Error ? error.message : 'Unable to save the four-view ICH capture series.')
    } finally {
      setIchSaving(false)
      setLoadingMessage('')
    }
  }

  async function runIchMovieAction(action: 'preview' | 'dicom' | 'local') {
    if (!canExportIchCine) {
      setIchMovieStatus('This role is not authorized to use ICH 3D cine.')
      return
    }
    if (ichMovieBusy) return
    if (ichVolumeInfo.voxelCount <= 0) {
      setIchMovieStatus('The ICH segmentation mask is empty.')
      return
    }
    if ((action === 'dicom' || action === 'local') && ichMovieConfig.fps * ichMovieConfig.durationSeconds > 180) {
      setIchMovieStatus('The maximum is 180 frames. Reduce the frame rate or duration.')
      return
    }
    const estimatedBytes = ichMovieConfig.resolution ** 2 * 3 * ichMovieConfig.fps * ichMovieConfig.durationSeconds
    if ((action === 'dicom' || action === 'local') && estimatedBytes > 96 * 1024 * 1024) {
      setIchMovieStatus('The cine is too large. Reduce the resolution, frame rate, or duration.')
      return
    }

    setIchMovieBusy(action)
    setIchMovieProgress(0)
    setIchMovieStatus(action === 'preview' ? 'Previewing cine orbit...' : 'Capturing cine frames...')
    try {
      const movie = await captureIch3dMovieFrames(ichMovieConfig, action !== 'preview')
      if (action === 'dicom') {
        if (!study || !movie) throw new Error('The study metadata or cine frames are not ready.')
        setIchMovieStatus('Saving the DICOM cine to the study...')
        await saveIchMovieAsDicom({
          study,
          sourceSeries: series,
          movie,
          direction: ichMovieConfig.direction,
        })
        setIchMovieStatus('DICOM cine saved as a new series.')
      } else if (action === 'local') {
        if (!movie) throw new Error('The cine frames are not ready.')
        setIchMovieStatus('Encoding video...')
        const result = await exportIchMovieFile(movie)
        setIchMovieStatus(`${result.extension.toUpperCase()} video export completed.`)
      } else {
        setIchMovieStatus('Cine preview completed.')
      }
    } catch (error) {
      console.warn('Unable to create ICH cine.', error)
      setIchMovieStatus(error instanceof Error ? error.message : 'Unable to create the ICH cine.')
    } finally {
      setIchMovieBusy(null)
      setIchMovieProgress(0)
    }
  }

  async function captureIch3dMovieFrames(config: IchMovieConfig, captureFrames: boolean): Promise<IchMovieFrames | null> {
    const viewport = getMprIch3dViewport()
    const compareIndex = mprViewportIds.indexOf(ich3dViewportId)
    const element = elementRefs.current[compareIndex]
    const sourceCanvas = element?.querySelector('canvas:not([data-vexa-progressive-preview])') ?? element?.querySelector('canvas')
    if (!viewport || !(sourceCanvas instanceof HTMLCanvasElement)) {
      throw new Error('The 3D ICH viewport is not ready.')
    }

    const originalCamera = cloneMprCamera(viewport.getCamera())
    if (!originalCamera.position || !originalCamera.focalPoint || !originalCamera.viewUp || !originalCamera.viewPlaneNormal) {
      throw new Error('The 3D ICH camera is not ready.')
    }

    const frameCount = captureFrames ? Math.max(1, Math.round(config.fps * config.durationSeconds)) : 60
    const outputCanvas = captureFrames ? document.createElement('canvas') : null
    const outputContext = outputCanvas?.getContext('2d', { alpha: false }) ?? null
    if (outputCanvas) {
      outputCanvas.width = config.resolution
      outputCanvas.height = config.resolution
    }
    if (captureFrames && !outputContext) throw new Error('The capture canvas is unavailable.')

    const frames: Uint8Array[] = []
    try {
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const angle = (Math.PI * 2 * frameIndex) / frameCount
        viewport.setCamera(createIchOrbitCamera(originalCamera, config.direction, angle))
        resetViewportClippingRange(viewport)
        viewport.render()
        await nextAnimationFrame()

        if (outputCanvas && outputContext) {
          drawViewportCanvasContained(outputContext, sourceCanvas, element, outputCanvas.width, outputCanvas.height)
          frames.push(canvasToRgbFrame(outputContext, outputCanvas.width, outputCanvas.height))
        } else {
          await delayMs(1000 / 30)
        }
        setIchMovieProgress((frameIndex + 1) / frameCount)
      }
    } finally {
      viewport.setCamera(originalCamera)
      resetViewportClippingRange(viewport)
      viewport.render()
      configureMprIch3dInteractions()
    }

    return captureFrames ? {
      width: config.resolution,
      height: config.resolution,
      fps: config.fps,
      frames,
    } : null
  }

  function getMprIch3dViewport() {
    if (ich3dViewportModeRef.current !== 'ich3d') {
      return null
    }
    if (!ich3dViewportId || !isMprViewportRenderable(ich3dViewportId)) {
      return null
    }

    const engine = getRenderingEngine(engineIdRef.current)
    return (engine?.getViewport(ich3dViewportId) as Types.IVolumeViewport | undefined) ?? null
  }

  function configureMprIch3dInteractions() {
    const toolGroup = ich3dToolGroupRef.current
    if (!toolGroup) return

    ;[
      TrackballRotateTool.toolName,
      PanTool.toolName,
      ZoomTool.toolName,
      WindowLevelTool.toolName,
    ].forEach((toolName) => toolGroup.setToolPassive(toolName, { removeAllBindings: true }))

    const primaryToolName = activeTool === 'Pan'
      ? PanTool.toolName
      : activeTool === 'Zoom'
        ? ZoomTool.toolName
        : activeTool === 'WindowLevel'
          ? WindowLevelTool.toolName
          : TrackballRotateTool.toolName

    toolGroup.setToolActive(primaryToolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
    })
    toolGroup.setToolActive(PanTool.toolName, {
      bindings: [
        ...(primaryToolName === PanTool.toolName ? [{ mouseButton: ToolEnums.MouseBindings.Primary }] : []),
        { mouseButton: ToolEnums.MouseBindings.Secondary },
        { mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Shift },
      ],
    })
    toolGroup.setToolActive(ZoomTool.toolName, {
      bindings: [
        ...(primaryToolName === ZoomTool.toolName ? [{ mouseButton: ToolEnums.MouseBindings.Primary }] : []),
        { mouseButton: ToolEnums.MouseBindings.Wheel },
        { mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Ctrl },
      ],
    })
  }

  async function refreshMprIch3dViewport(labelmapVolumeId = ich3dLabelmapVolumeIdRef.current ?? undefined) {
    if (!labelmapVolumeId) {
      return
    }

    const viewport = getMprIch3dViewport()
    if (!viewport) {
      return
    }

    ich3dLabelmapVolumeIdRef.current = labelmapVolumeId
    const currentVolumeIds = (viewport as Types.IVolumeViewport & { getAllVolumeIds?: () => string[] }).getAllVolumeIds?.() ?? []
    if (!currentVolumeIds.includes(labelmapVolumeId)) {
      try {
        await viewport.setVolumes([{
          volumeId: labelmapVolumeId,
          actorUID: MPR_ICH_3D_ACTOR_UID,
          blendMode: Enums.BlendModes.COMPOSITE,
          callback: ({ volumeActor }) => {
            applyMprIch3dMaskActorTransfer(volumeActor, {
              opacity: ichOpacity,
              windowWidth: ich3dWindowWidth,
              windowLevel: ich3dWindowLevel,
            })
          },
        }], true, true)
        viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
      } catch (error) {
        console.warn('Unable to attach ICH 3D labelmap volume.', error)
        setErrorMessage('Unable to initialize the 3D ICH viewport.')
        return
      }
    } else {
      updateMprIch3dTransferFunction(false)
    }

    resetViewportClippingRange(viewport)
    viewport.render()
  }

  function updateMprIch3dTransferFunction(
    render = true,
    windowWidth = ich3dWindowWidth,
    windowLevel = ich3dWindowLevel,
    opacity = ichOpacity,
  ) {
    const viewport = getMprIch3dViewport()
    const actor = viewport?.getActor?.(MPR_ICH_3D_ACTOR_UID)?.actor
    if (!viewport || !actor) {
      return
    }

    applyMprIch3dMaskActorTransfer(actor, {
      opacity,
      windowWidth,
      windowLevel,
    })
    resetViewportClippingRange(viewport)
    if (render) {
      viewport.render()
    }
  }

  function applyIch3dWindowLevel(windowLevel: { windowWidth: number; windowLevel: number }, render = true) {
    const nextWindowWidth = Math.max(Math.round(windowLevel.windowWidth), 1)
    const nextWindowLevel = Math.round(windowLevel.windowLevel)
    setIch3dWindowWidth(nextWindowWidth)
    setIch3dWindowLevel(nextWindowLevel)
    updateMprIch3dTransferFunction(render, nextWindowWidth, nextWindowLevel)
  }

  async function activateMprIch3dViewport() {
    if (ich3dViewportModeRef.current === 'ich3d') {
      return
    }
    if (!loadedMprVolumeId || !cache.getVolume(loadedMprVolumeId) || !mprCompareViewportId) {
      return
    }

    const engine = getRenderingEngine(engineIdRef.current)
    const compareIndex = mprViewportIds.indexOf(mprCompareViewportId)
    const element = elementRefs.current[compareIndex]
    if (!engine || !element || !isMprViewportRenderable(mprCompareViewportId)) {
      return
    }

    toolGroupRef.current?.removeViewports(engineIdRef.current, mprCompareViewportId)
    compareToolGroupRef.current?.removeViewports(engineIdRef.current, mprCompareViewportId)
    ich3dToolGroupRef.current?.removeViewports(engineIdRef.current, mprCompareViewportId)
    try {
      engine.disableElement(mprCompareViewportId)
    } catch {
      // The viewport may already be disabled during a fast tool switch.
    }

    engine.enableElement({
      viewportId: mprCompareViewportId,
      type: Enums.ViewportType.VOLUME_3D,
      element,
      defaultOptions: {
        background: [0, 0, 0],
      },
    })
    ich3dViewportModeRef.current = 'ich3d'
    ich3dToolGroupRef.current?.addViewport(mprCompareViewportId, engineIdRef.current)
    configureMprIch3dInteractions()
    engine.resize(true, false)
    const planeViewStates = captureMprViewportViewStates(mprPrimaryPlaneViewportIds)
    await rebindMprPlaneViewportsForIch(planeViewStates)

    const state = ensureMprIchSegmentation()
    if (state) {
      await refreshMprIch3dViewport(state.labelmapVolumeId)
      renderMprViewports()
    }
  }

  async function rebindMprPlaneViewportsForIch(viewStates = captureMprViewportViewStates(mprPrimaryPlaneViewportIds)) {
    if (!loadedMprVolumeId || !cache.getVolume(loadedMprVolumeId)) {
      return
    }

    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) {
      return
    }

    const visiblePlaneViewportIds = mprPrimaryPlaneViewportIds.filter((viewportId) => isMprViewportRenderable(viewportId))
    if (visiblePlaneViewportIds.length === 0) {
      return
    }

    await setVolumesForViewports(
      engine,
      [{ volumeId: loadedMprVolumeId, blendMode: Enums.BlendModes.COMPOSITE, slabThickness: 1 }],
      visiblePlaneViewportIds,
    )

    visiblePlaneViewportIds.forEach((viewportId) => {
      const index = mprViewportIds.indexOf(viewportId)
      const viewport = engine.getViewport(viewportId) as (Types.IVolumeViewport & { setOrientation?: (orientation: string) => void }) | undefined
      if (!viewport) {
        return
      }

      const viewState = viewStates[viewportId]
      if (!viewState) {
        const orientation = Enums.OrientationAxis[MPR_VIEWPORT_DEFS[index]?.orientation ?? 'AXIAL']
        viewport.setOrientation?.(orientation)
      }
      setMprSlabThickness(viewport, slabThicknessesRef.current[viewportId] ?? 1)
      setMprBlendMode(viewport, blendModes[viewportId] ?? 'normal')
      if (isUsableWindowLevel(initialWindowLevel)) {
        setMprVoiRange(viewport, windowLevelToVoiRange(initialWindowLevel))
      }
      restoreMprViewportViewState(viewport, viewState)
      resetViewportClippingRange(viewport)
      updateMprOrientationLabel(viewportId, viewport)
      updateMprSliceInfo(viewportId, viewport)
      viewport.render()
    })
  }

  function captureMprViewportViewStates(viewportIds: string[]) {
    const engine = getRenderingEngine(engineIdRef.current)
    const states: Record<string, MprViewportViewState> = {}
    if (!engine) {
      return states
    }

    viewportIds.forEach((viewportId) => {
      const viewport = engine.getViewport(viewportId) as Types.IVolumeViewport | undefined
      if (!viewport || !isMprViewportRenderable(viewportId)) {
        return
      }

      states[viewportId] = {
        camera: cloneMprCamera(viewport.getCamera()),
        zoom: viewport.getZoom(),
      }
    })

    return states
  }

  function restoreMprViewportViewState(viewport: Types.IVolumeViewport, viewState?: MprViewportViewState) {
    if (!viewState) {
      return
    }

    viewport.setCamera(cloneMprCamera(viewState.camera))
    viewport.setZoom(viewState.zoom)
  }

  async function restoreMprCompareViewport() {
    if (ich3dViewportModeRef.current === 'plane') {
      return
    }
    if (!loadedMprVolumeId || !cache.getVolume(loadedMprVolumeId) || !mprCompareViewportId) {
      return
    }

    const engine = getRenderingEngine(engineIdRef.current)
    const compareIndex = mprViewportIds.indexOf(mprCompareViewportId)
    const element = elementRefs.current[compareIndex]
    if (!engine || !element || !isMprViewportRenderable(mprCompareViewportId)) {
      return
    }

    ich3dToolGroupRef.current?.removeViewports(engineIdRef.current, mprCompareViewportId)
    try {
      engine.disableElement(mprCompareViewportId)
    } catch {
      // The viewport may already be disabled during a fast tool switch.
    }

    engine.enableElement({
      viewportId: mprCompareViewportId,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element,
      defaultOptions: {
        orientation: Enums.OrientationAxis.AXIAL,
        background: [0, 0, 0],
      },
    })
    ich3dViewportModeRef.current = 'plane'
    await setVolumesForViewports(
      engine,
      [{ volumeId: loadedMprVolumeId, blendMode: Enums.BlendModes.COMPOSITE, slabThickness: slabThicknessesRef.current[mprCompareViewportId] ?? 1 }],
      [mprCompareViewportId],
    )

    const viewport = engine.getViewport(mprCompareViewportId) as (Types.IVolumeViewport & { setOrientation?: (orientation: string) => void }) | undefined
    if (viewport) {
      viewport.setOrientation?.(Enums.OrientationAxis.AXIAL)
      viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true })
      setMprBlendMode(viewport, blendModes[mprCompareViewportId] ?? 'normal')
      if (isUsableWindowLevel(initialWindowLevel)) {
        setMprVoiRange(viewport, windowLevelToVoiRange(initialWindowLevel))
      }
      resetViewportClippingRange(viewport)
      updateMprOrientationLabel(mprCompareViewportId, viewport)
      updateMprSliceInfo(mprCompareViewportId, viewport)
      setMprZooms((current) => ({ ...current, [mprCompareViewportId]: viewport.getZoom() }))
      viewport.render()
    }

    if (useViewerStore.getState().activeTool === 'Crosshairs') {
      moveMprCompareViewportToAuxiliaryToolGroup()
    } else {
      restoreMprCompareViewportToPrimaryToolGroup()
    }
    engine.resize(true, false)
    renderMprViewports()
  }

  useEffect(() => {
    if (!volumeLoaded || !loadedMprVolumeId || !cache.getVolume(loadedMprVolumeId)) {
      return
    }

    let cancelled = false
    const run = async () => {
      if (isIchMprLayout) {
        await activateMprIch3dViewport()
      } else {
        await restoreMprCompareViewport()
      }
      if (!cancelled) {
        renderMprViewports()
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [isIchMprLayout, loadedMprVolumeId, mprCompareViewportId, volumeLoaded])

  function handleIchModeChange(tool: 'ICHSegment' | 'ICHEraser') {
    if (!loadedMprVolumeId || !volumeLoaded) {
      setErrorMessage('ICH segmentation requires a fully loaded MPR volume.')
      return
    }

    setActiveTool(tool)
  }

  function resetMprIchLearningState() {
    ichAdaptiveModelRef.current = null
    ichForbiddenRegionsRef.current = []
    ichSmartDragRef.current = null
    ichSmartDragWindowCleanupRef.current?.()
    ichSmartDragWindowCleanupRef.current = null
    setIchSmartDragPreview(null)
    setIchDebugInfo(null)
  }

  function resetMprIchHistoryState() {
    ichUndoSnapshotsRef.current = []
    ichRedoSnapshotsRef.current = []
    setIchHistoryState({ canUndo: false, canRedo: false })
  }

  function updateMprIchHistoryState() {
    setIchHistoryState({
      canUndo: ichUndoSnapshotsRef.current.length > 0,
      canRedo: ichRedoSnapshotsRef.current.length > 0,
    })
  }

  function captureMprIchUndoSnapshot(segmentationId: string) {
    ichUndoSnapshotsRef.current = [
      ...ichUndoSnapshotsRef.current,
      captureIchVolumeSnapshot(segmentationId),
    ].slice(-MPR_ICH_HISTORY_LIMIT)
    ichRedoSnapshotsRef.current = []
    updateMprIchHistoryState()
  }

  function handleIchClear() {
    const state = ensureMprIchSegmentation()
    if (!state) {
      return
    }

    captureMprIchUndoSnapshot(state.segmentationId)
    clearIchSegment(state.segmentationId)
    resetMprIchLearningState()
    const stats = loadedMprVolumeId ? getIchVolumeSegmentStats(state.segmentationId, loadedMprVolumeId) : { voxelCount: 0, volumeMl: null }
    setIchVolumeInfo(stats)
    setIchSmartStatus('')
    void refreshMprIch3dViewport(state.labelmapVolumeId)
    renderMprViewports()
  }

  function handleMprIchUndo() {
    const state = ensureMprIchSegmentation()
    const snapshot = ichUndoSnapshotsRef.current[ichUndoSnapshotsRef.current.length - 1]
    if (!state || !snapshot || !loadedMprVolumeId) {
      return
    }

    ichRedoSnapshotsRef.current = [
      ...ichRedoSnapshotsRef.current,
      captureIchVolumeSnapshot(state.segmentationId),
    ].slice(-MPR_ICH_HISTORY_LIMIT)
    ichUndoSnapshotsRef.current = ichUndoSnapshotsRef.current.slice(0, -1)
    restoreIchVolumeSnapshot(state.segmentationId, snapshot)
    resetMprIchLearningState()
    updateMprIchHistoryState()
    const stats = getIchVolumeSegmentStats(state.segmentationId, loadedMprVolumeId)
    setIchVolumeInfo(stats)
    setIchSmartStatus('')
    void refreshMprIch3dViewport(state.labelmapVolumeId)
    renderMprViewports()
  }

  function handleMprIchRedo() {
    const state = ensureMprIchSegmentation()
    const snapshot = ichRedoSnapshotsRef.current[ichRedoSnapshotsRef.current.length - 1]
    if (!state || !snapshot || !loadedMprVolumeId) {
      return
    }

    ichUndoSnapshotsRef.current = [
      ...ichUndoSnapshotsRef.current,
      captureIchVolumeSnapshot(state.segmentationId),
    ].slice(-MPR_ICH_HISTORY_LIMIT)
    ichRedoSnapshotsRef.current = ichRedoSnapshotsRef.current.slice(0, -1)
    restoreIchVolumeSnapshot(state.segmentationId, snapshot)
    resetMprIchLearningState()
    updateMprIchHistoryState()
    const stats = getIchVolumeSegmentStats(state.segmentationId, loadedMprVolumeId)
    setIchVolumeInfo(stats)
    setIchSmartStatus('')
    void refreshMprIch3dViewport(state.labelmapVolumeId)
    renderMprViewports()
  }

  function detachMprIchRepresentations() {
    const segmentationId = ichSegmentationIdRef.current
    if (!segmentationId) {
      return
    }
    detachIchSegmentationFromViewports(mprViewportIds, segmentationId)
    renderMprViewports()
  }

  function handleExitIchWorkspace() {
    detachMprIchRepresentations()
    setIchMprWorkspace(viewportKey, false)
    setIchSmartStatus('')
    setIchDebugInfo(null)
    setIchSmartDragPreview(null)
    if (onExitIchWorkspace) {
      onExitIchWorkspace()
      return
    }
    if (activeTool === 'ICHSegment' || activeTool === 'ICHEraser') {
      setActiveTool('Crosshairs')
    }
  }

  useEffect(() => {
    function handleDocumentKeyDown(event: KeyboardEvent) {
      const viewerState = useViewerStore.getState()
      const activeMprViewportId = viewerState.mprActiveViewportIds[viewportKey] ?? viewerState.mprActiveViewportId
      const hotkeysTargetThisMpr = isSelected || viewerState.selectedViewportKey === viewportKey || mprViewportIds.includes(activeMprViewportId)
      if (!hotkeysTargetThisMpr) {
        return
      }
      if (isEditableEventTarget(event.target)) {
        return
      }

      if (event.key === 'Escape' && contextMenu) {
        event.preventDefault()
        setContextMenu(null)
        return
      }

      const isUndoRedoKey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'
      if (isIchWorkspaceActive && isUndoRedoKey) {
        event.preventDefault()
        if (event.shiftKey) {
          if (ichHistoryState.canRedo) {
            handleMprIchRedo()
          }
        } else if (ichHistoryState.canUndo) {
          handleMprIchUndo()
        }
        return
      }

      const action = createHotkeyActions(hotkeyOverrides, hasPermission, series.modality ?? '').get(toHotkey(event))
      if (!action) {
        return
      }
      if (action.type === 'command' && action.command === 'toggle-cine') {
        return
      }

      event.preventDefault()
      runMprMenuAction(action)
    }

    document.addEventListener('keydown', handleDocumentKeyDown)
    return () => document.removeEventListener('keydown', handleDocumentKeyDown)
  }, [contextMenu, hasPermission, hotkeyOverrides, ichHistoryState.canRedo, ichHistoryState.canUndo, isIchWorkspaceActive, isSelected, mprViewportIds, onOpenAmbientTest, onOpenTagBrowser, onToggle3d, onToggle3dBone, onToggleMpr, onToggleOverlay, referenceLinesEnabled, series.modality, viewportKey])

  useEffect(() => {
    initializeCornerstone()
    dispatchStatus({ type: 'loading' })
    setLoadingMessage('')
    setErrorMessage('')
    setVolumeLoaded(false)
    setLoadedMprVolumeId(null)
    setIchSegmentationId(null)
    ichSegmentationIdRef.current = null
    ich3dLabelmapVolumeIdRef.current = null
    resetMprIchLearningState()
    resetMprIchHistoryState()
    setIchSmartStatus('')
    setIchVolumeInfo({ voxelCount: 0, volumeMl: null })
    setPreviewUrls(null)

    let cancelled = false
    const engineId = engineIdRef.current
    const volumeOwnerId = getDiagnosticVolumeOwnerId(viewportKey)
    let renderingEngine: RenderingEngine | null = null
    let toolGroup: ReturnType<typeof ToolGroupManager.createToolGroup> = null
    let compareToolGroup: ReturnType<typeof ToolGroupManager.createToolGroup> = null
    let ich3dToolGroup: ReturnType<typeof ToolGroupManager.createToolGroup> = null
    const viewportEventEntries: { element: HTMLDivElement; cameraHandler: EventListener; voiHandler: EventListener }[] = []

    async function setupMpr() {
      try {
        const volumePromise = acquireSharedSeriesVolume(series, 'mpr', volumeOwnerId)

        // Create rendering engine + viewports IMMEDIATELY — no await on anything
        renderingEngine = new RenderingEngine(engineId)

        const viewportInputs = mprViewportIds.flatMap((viewportId, index): Types.PublicViewportInput[] => {
          const element = elementRefs.current[index]
          if (!element) {
            return []
          }

          return [{
            viewportId,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element,
            defaultOptions: {
              orientation: Enums.OrientationAxis[MPR_VIEWPORT_DEFS[index]?.orientation ?? 'AXIAL'],
              background: [0, 0, 0],
            },
          }]
        })
        const enabledMprViewportIds = viewportInputs.map((input) => input.viewportId)
        const enabledMprPlaneViewportIds = enabledMprViewportIds
        renderingEngine.setViewports(viewportInputs)

        renderingEngine.resize(true, false)

        // When volume is ready, set it on all viewports
        volumePromise.then(async ({ volumeId, instances, streamingComplete }) => {
          if (cancelled) { return }
          if (!instances.length) {
            setErrorMessage('No image instances found for this series')
            dispatchStatus({ type: 'error', error: 'No image instances found' })
            return
          }

          setMprVolumeId(volumeId)
          setLoadedMprVolumeId(volumeId)
          await setVolumesForViewports(
            renderingEngine!,
            [{ volumeId, blendMode: Enums.BlendModes.COMPOSITE, slabThickness: 1 }],
            enabledMprPlaneViewportIds,
          )
          if (cancelled) return

          enabledMprPlaneViewportIds.forEach((viewportId) => {
            const index = mprViewportIds.indexOf(viewportId)
            const viewport = renderingEngine!.getViewport(viewportId) as (Types.IVolumeViewport & { setOrientation?: (orientation: string) => void })
            if (!viewport) return

            viewport.setOrientation?.(Enums.OrientationAxis[MPR_VIEWPORT_DEFS[index]?.orientation ?? 'AXIAL'])
            viewport.resetCamera()
            setMprSlabThickness(viewport, 1)
            setMprBlendMode(viewport, 'normal')
            if (isUsableWindowLevel(initialWindowLevel)) {
              setMprVoiRange(viewport, windowLevelToVoiRange(initialWindowLevel))
            }
            setMprZooms((current) => ({ ...current, [viewportId]: viewport.getZoom() }))
            const windowLevel = getMprWindowLevel(viewport)
            if (windowLevel) {
              setMprWindowLevels((current) => ({ ...current, [viewportId]: windowLevel }))
            }
            updateMprSliceInfo(viewportId, viewport)
          })

          if (cancelled) return
          fixCameraClipping()
          scheduleCameraClippingStabilization()
          lockMprStandardOrientations()
          renderMprViewports()
          dispatchStatus({ type: 'done' })
          setLoadingMessage('')
          setVolumeLoaded(true)
          setPreviewUrls(null)

          await streamingComplete
          if (cancelled) return

          recomputeMprCrosshairsTool()
          renderMprViewports()

          // Trigger initial prefetch after volume is set
          enabledMprPlaneViewportIds.forEach((viewportId) => {
            const viewport = renderingEngine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
            if (viewport) {
              prefetchAdjacentSlices(viewport, viewportId, 3)
            }
          })
        }).catch(() => {
          if (!cancelled) {
            const msg = 'Unable to prepare MPR volume.'
            setErrorMessage(msg)
            dispatchStatus({ type: 'error', error: msg })
          }
        })

        // Phase 4: Setup event handlers and tool groups (non-blocking, no await)
        function fixCameraClipping(renderAfterReset = false) {
          const engine = getRenderingEngine(engineId)
          if (!engine) return
          mprViewportIds.forEach((id) => {
            try {
              const vp = engine.getViewport(id) as Types.IVolumeViewport | undefined
              if (!vp) return
              resetViewportClippingRange(vp)
              if (renderAfterReset) {
                vp.render()
              }
            } catch { /* vtk internals not accessible */ }
          })
        }

        function scheduleCameraClippingStabilization() {
          if (cameraStabilizeFrameRef.current !== null) {
            return
          }

          cameraStabilizeFrameRef.current = window.requestAnimationFrame(() => {
            cameraStabilizeFrameRef.current = null
            fixCameraClipping(true)
            window.requestAnimationFrame(() => fixCameraClipping(true))
          })
        }

        const handleMprCameraModified = (sourceViewportId: string) => {
          if (lockingMprOrientationRef.current) {
            return
          }
          fixCameraClipping()
          enabledMprPlaneViewportIds.forEach((viewportId) => {
            const viewport = renderingEngine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
            if (viewport) {
              updateMprOrientationLabel(viewportId, viewport)
              updateMprSliceInfo(viewportId, viewport)
              // Prefetch adjacent slices on camera change (scroll)
              if (viewportId === sourceViewportId) {
                prefetchAdjacentSlices(viewport, viewportId, 3)
              }
            }
          })
          scheduleCameraClippingStabilization()

          const sourceViewport = renderingEngine?.getViewport(sourceViewportId) as Types.IVolumeViewport | undefined
          if (!sourceViewport || applyingLinkedCommandRef.current || !isMprViewportRenderable(sourceViewportId)) {
            return
          }

          const sliceInfo = getMprSliceInfo(sourceViewportId, sourceViewport)
          const state = useViewerStore.getState()
          const camera = sourceViewport.getCamera()
          const zoom = sourceViewport.getZoom()
          if (state.intelliLink.pan) {
            broadcastLinkedMprCommand(sourceViewportId, 'pan', 'set-pan', {
              camera,
              zoom,
              sliceIndex: sliceInfo.sliceIndex,
            })
          } else {
            if (state.intelliLink.zoom) {
              broadcastLinkedMprCommand(sourceViewportId, 'zoom', 'set-zoom', { zoom })
            }
            if (state.intelliLink.scroll) {
              broadcastLinkedMprCommand(sourceViewportId, 'scroll', 'set-mpr-slice', { sliceIndex: sliceInfo.sliceIndex })
            }
          }
        }

        const handleMprVoiModified = (sourceViewportId: string) => {
          if (applyingLinkedCommandRef.current) {
            return
          }
          const viewport = renderingEngine?.getViewport(sourceViewportId) as Types.IVolumeViewport | undefined
          const windowLevel = viewport ? getMprWindowLevel(viewport) : null
          if (windowLevel) {
            setMprWindowLevels((current) => ({ ...current, [sourceViewportId]: windowLevel }))
            broadcastLinkedMprCommand(sourceViewportId, 'windowLevel', 'set-window-level', { windowLevel })
          }
        }

        toolGroup = ToolGroupManager.createToolGroup(toolGroupId)
        if (toolGroup) {
          enabledMprPlaneViewportIds.forEach((id) => toolGroup.addViewport(id, engineId))
          orderMprToolGroupViewportsForCrosshairs(toolGroup, viewportOrientationsRef.current)

          toolGroup.addTool(WindowLevelTool.toolName)
          toolGroup.addTool(PanTool.toolName)
          toolGroup.addTool(ZoomTool.toolName)
          toolGroup.addTool(StackScrollTool.toolName)

          toolGroup.addTool(CrosshairsTool.toolName, {
            viewportIndicators: false,
            referenceLinesCenterGapRadius: 20,
            viewportIndicatorsConfig: {
              circleRadius: 5,
              xOffset: 0.95,
              yOffset: 0.05,
            },
            disableOnPassive: true,
            autoPan: {
              enabled: false,
              panSize: 10,
            },
            getReferenceLineColor: (viewportId: string) => {
              if (viewportId.includes('axial')) return 'rgb(250, 204, 21)'
              if (viewportId.includes('sagittal')) return 'rgb(96, 165, 250)'
              if (viewportId.includes('coronal')) return 'rgb(34, 211, 238)'
              return 'rgb(245, 245, 245)'
            },
            getReferenceLineControllable: () => true,
            getReferenceLineDraggableRotatable: () => true,
            getReferenceLineSlabThicknessControlsOn: () => false,
          })
          toolGroup.addTool(LengthTool.toolName)
          toolGroup.addTool(AngleTool.toolName)
          toolGroup.addTool(CobbAngleTool.toolName)
          toolGroup.addTool(BidirectionalTool.toolName)
          toolGroup.addTool(CircleROITool.toolName)
          toolGroup.addTool(EllipticalROITool.toolName)
          toolGroup.addTool(RectangleROITool.toolName)
          toolGroup.addTool(PlanarFreehandROITool.toolName)
          toolGroup.addTool(BrushTool.toolName)
          toolGroup.addTool(EraserTool.toolName)
          toolGroup.addTool(ProbeTool.toolName)
          toolGroup.addTool(ReferenceLinesTool.toolName)

          toolGroup.setToolActive(StackScrollTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
          })

          toolGroup.setToolDisabled(CrosshairsTool.toolName)
          syncMprReferenceLinesTool(toolGroup, useViewerStore.getState().referenceLinesEnabled, activeViewport)

          mprManagedToolNames.forEach((name) => {
            toolGroup!.setToolPassive(name, { removeAllBindings: true })
          })
          toolGroup.setToolActive(WindowLevelTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
          })
          setMprWheelScrollActive(toolGroup)

          toolGroupRef.current = toolGroup
        }

        compareToolGroup = ToolGroupManager.createToolGroup(compareToolGroupId)
        if (compareToolGroup) {
          compareToolGroup.addTool(WindowLevelTool.toolName)
          compareToolGroup.addTool(PanTool.toolName)
          compareToolGroup.addTool(ZoomTool.toolName)
          compareToolGroup.addTool(StackScrollTool.toolName)
          compareToolGroup.setToolActive(StackScrollTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
          })
          compareToolGroup.setToolActive(WindowLevelTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
          })
          compareToolGroup.setToolActive(ZoomTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Ctrl }],
          })
          compareToolGroup.setToolActive(PanTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Shift }],
          })
          compareToolGroupRef.current = compareToolGroup
        }

        ich3dToolGroup = ToolGroupManager.createToolGroup(ich3dToolGroupId)
        if (ich3dToolGroup) {
          ich3dToolGroup.addTool(TrackballRotateTool.toolName)
          ich3dToolGroup.addTool(PanTool.toolName)
          ich3dToolGroup.addTool(ZoomTool.toolName)
          ich3dToolGroup.addTool(WindowLevelTool.toolName)
          ich3dToolGroup.setToolActive(TrackballRotateTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
          })
          ich3dToolGroup.setToolActive(PanTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }],
          })
          ich3dToolGroup.setToolActive(ZoomTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
          })
          ich3dToolGroup.setToolPassive(WindowLevelTool.toolName, { removeAllBindings: true })
          ich3dToolGroupRef.current = ich3dToolGroup
          configureMprIch3dInteractions()
        }

        renderingEngine.render()

        enabledMprPlaneViewportIds.forEach((viewportId) => {
          const index = mprViewportIds.indexOf(viewportId)
          const viewport = renderingEngine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
          if (viewport) {
            updateMprOrientationLabel(viewportId, viewport)
          }

          const element = elementRefs.current[index]
          if (element) {
            const viewportCameraHandler = () => handleMprCameraModified(viewportId)
            const viewportVoiHandler = () => handleMprVoiModified(viewportId)
            element.addEventListener(Enums.Events.CAMERA_MODIFIED, viewportCameraHandler)
            element.addEventListener(Enums.Events.VOI_MODIFIED, viewportVoiHandler)
            viewportEventEntries.push({ element, cameraHandler: viewportCameraHandler, voiHandler: viewportVoiHandler })
          }
        })

      } catch (err) {
        if (!cancelled) {
          const msg = 'Unable to prepare MPR volume.'
          setErrorMessage(msg)
          dispatchStatus({ type: 'error', error: msg })
        }
      }
    } // end setupMpr

    void setupMpr()

    const containerEl = containerRef.current
    let resizeObserver: ResizeObserver | null = null
    if (containerEl) {
      resizeObserver = new ResizeObserver(() => {
        if (renderingEngine) {
          renderingEngine.resize(true, false)
        }
      })
      resizeObserver.observe(containerEl)
    }

    return () => {
      cancelled = true
      detachMprIchRepresentations()
      toolGroupRef.current = null
      compareToolGroupRef.current = null
      ich3dToolGroupRef.current = null
      viewportEventEntries.forEach(({ element, cameraHandler, voiHandler }) => {
        element.removeEventListener(Enums.Events.CAMERA_MODIFIED, cameraHandler)
        element.removeEventListener(Enums.Events.VOI_MODIFIED, voiHandler)
      })
      if (cameraStabilizeFrameRef.current !== null) {
        window.cancelAnimationFrame(cameraStabilizeFrameRef.current)
        cameraStabilizeFrameRef.current = null
      }
      if (resizeObserver && containerEl) {
        resizeObserver.disconnect()
      }
      ToolGroupManager.destroyToolGroup(toolGroupId)
      ToolGroupManager.destroyToolGroup(compareToolGroupId)
      ToolGroupManager.destroyToolGroup(ich3dToolGroupId)
      const engine = getRenderingEngine(engineId)
      if (engine) {
        mprViewportIds.forEach((viewportId) => {
          engine.disableElement(viewportId)
        })
        engine.destroy()
      }
      releaseSharedSeriesVolume(series, 'mpr', volumeOwnerId)
      setMprVolumeId(null)
      setLoadedMprVolumeId(null)
      setIchSegmentationId(null)
      ichSegmentationIdRef.current = null
      ich3dLabelmapVolumeIdRef.current = null
      setLoadingMessage('')
      setErrorMessage('')
    }
  }, [compareToolGroupId, ich3dToolGroupId, initialWindowLevel?.windowLevel, initialWindowLevel?.windowWidth, mprViewportIds, series.studyInstanceUid, series.seriesInstanceUid, series.instanceCount, setMprVolumeId, setLoadingMessage, setErrorMessage, setMprSliceInfo, toolGroupId, viewportKey])

  useEffect(() => {
    const toolGroup = toolGroupRef.current
    if (!toolGroup) return
    if (!areMprElementsRenderable()) return

    if (activeTool === 'Reset') {
      sendViewportCommand('reset', activeViewport)
      setActiveTool('WindowLevel')
      return
    }

    if (activeTool === 'Crosshairs') {
      moveMprCompareViewportToAuxiliaryToolGroup()
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
      recomputeMprCrosshairsTool()
      toolGroup.setToolActive(CrosshairsTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
      })
      setMprWheelScrollActive(toolGroup)
      renderMprViewports()
      return
    }

    restoreMprCompareViewportToPrimaryToolGroup()

    if ((activeTool === 'ICHSegment' || activeTool === 'ICHEraser') && (!volumeLoaded || !loadedMprVolumeId)) {
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(CrosshairsTool.toolName)
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
      setMprWheelScrollActive(toolGroup)
      setErrorMessage('ICH segmentation is waiting for the MPR volume to finish loading.')
      return
    }

    if (!volumeLoaded) {
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(CrosshairsTool.toolName)
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
      setMprWheelScrollActive(toolGroup)
      return
    }

    if (activeTool === 'Stack3DCursor') {
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(CrosshairsTool.toolName)
      syncMprReferenceLinesTool(toolGroup, referenceLinesEnabled, activeViewport)
      setMprWheelScrollActive(toolGroup)
      renderMprViewports()
      return
    }

    if (activeTool === 'ReferenceLines') {
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(CrosshairsTool.toolName)
      if (!referenceLinesEnabled) {
        syncMprReferenceLinesTool(toolGroup, false, activeViewport)
        setMprWheelScrollActive(toolGroup)
        renderMprViewports()
        return
      }
      syncMprReferenceLinesTool(toolGroup, true, activeViewport)
      setMprWheelScrollActive(toolGroup)
      renderMprViewports()
      return
    }

    if (activeTool === 'Probe') {
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(ProbeTool.toolName)
      toolGroup.setToolDisabled(CrosshairsTool.toolName)
      syncMprReferenceLinesTool(toolGroup, referenceLinesEnabled, activeViewport)
      setMprWheelScrollActive(toolGroup)
      renderMprViewports()
      return
    }

    if (activeTool === 'ICHSegment' || activeTool === 'ICHEraser') {
      const toolName = mprToolNameByStoreId[activeTool]
      const state = ensureMprIchSegmentation()
      if (!state || !toolName) {
        return
      }

      if (ichSmartDragEnabled) {
        mprManagedToolNames.forEach((name) => {
          toolGroup.setToolPassive(name, { removeAllBindings: true })
        })
        toolGroup.setToolDisabled(CrosshairsTool.toolName)
        syncMprReferenceLinesTool(toolGroup, referenceLinesEnabled, activeViewport)
        setMprWheelScrollActive(toolGroup)
        renderMprViewports()
        return
      }

      mprManagedToolNames.forEach((name) => {
        if (name === toolName) return
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(CrosshairsTool.toolName)
      syncMprReferenceLinesTool(toolGroup, referenceLinesEnabled, activeViewport)
      toolGroup.setToolActive(toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
      })
      setMprWheelScrollActive(toolGroup)
      renderMprViewports()
      return
    }

    toolGroup.setToolDisabled(CrosshairsTool.toolName)
    syncMprReferenceLinesTool(toolGroup, referenceLinesEnabled, activeViewport)

    const toolName = mprToolNameByStoreId[activeTool]
    if (!toolName) {
      setActiveTool('WindowLevel')
      return
    }

    mprManagedToolNames.forEach((name) => {
      if (name === toolName) return
      toolGroup.setToolPassive(name, { removeAllBindings: true })
    })
    if (toolName === StackScrollTool.toolName) {
      setMprScrollToolActive(toolGroup)
    } else {
      toolGroup.setToolActive(toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
      })
      setMprWheelScrollActive(toolGroup)
    }
  }, [activeTool, activeViewport, ichSmartDragEnabled, loadedMprVolumeId, referenceLinesEnabled, sendViewportCommand, setActiveTool, toolGroupId, volumeLoaded])

  useEffect(() => {
    const toolGroup = toolGroupRef.current
    if (!toolGroup || !volumeLoaded || !areMprElementsRenderable()) return

    toolGroup.setToolActive(ZoomTool.toolName, {
      bindings: [{
        mouseButton: ToolEnums.MouseBindings.Primary,
        modifierKey: ToolEnums.KeyboardBindings.Ctrl,
      }],
    })
    toolGroup.setToolActive(PanTool.toolName, {
      bindings: [{
        mouseButton: ToolEnums.MouseBindings.Primary,
        modifierKey: ToolEnums.KeyboardBindings.Shift,
      }],
    })
  }, [activeTool, volumeLoaded])

  useEffect(() => {
    if (!isIchWorkspaceActive || !volumeLoaded) return
    configureMprIch3dInteractions()
  }, [activeTool, isIchWorkspaceActive, volumeLoaded])

  useEffect(() => {
    if (activeTool !== 'Stack3DCursor') {
      mprCursorDragRef.current = null
      mprCursorWorldRef.current = null
      setMprCursorPoints({})
    }
    if (activeTool !== 'Probe') {
      mprLiveProbePointerRef.current = null
      setMprLiveProbeValue(null)
    }
  }, [activeTool])

  useEffect(() => {
    function resetTransientMprTool(event: Event) {
      const expectedToolName = mprTransientToolByStoreId[activeTool]
      if (!expectedToolName) {
        return
      }

      const completedToolName = (event as CustomEvent<{ annotation?: { metadata?: { toolName?: string } } }>).detail?.annotation?.metadata?.toolName
      if (completedToolName && completedToolName !== expectedToolName) {
        return
      }

      window.setTimeout(() => {
        if (useViewerStore.getState().activeTool === activeTool) {
          setActiveTool('WindowLevel')
        }
      }, 0)
    }

    eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientMprTool)

    return () => {
      eventTarget.removeEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientMprTool)
    }
  }, [activeTool, setActiveTool])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const viewerState = useViewerStore.getState()
      const activeMprViewportId = viewerState.mprActiveViewportIds[viewportKey] ?? viewerState.mprActiveViewportId
      const hotkeysTargetThisMpr = isSelected || viewerState.selectedViewportKey === viewportKey || mprViewportIds.includes(activeMprViewportId)
      if (!hotkeysTargetThisMpr) {
        return
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return
      }

      if (deleteSelectedAnnotations(false) > 0) {
        event.preventDefault()
        renderMprViewports()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSelected, mprViewportIds, viewportKey])

  useEffect(() => {
    if (!viewportCommand) return
    const commandTargetsThisMpr = Boolean(viewportCommand.targetViewportKey && mprViewportIds.includes(viewportCommand.targetViewportKey))
    if (!isSelected && !commandTargetsThisMpr) return
    const isLinkedCommand = Boolean(viewportCommand.sourceViewportKey && viewportCommand.sourceViewportKey !== viewportKey)
    applyingLinkedCommandRef.current = isLinkedCommand

    try {
      if (viewportCommand.type === 'delete-annotation') {
        if (deleteSelectedAnnotations(true) > 0) {
          renderMprViewports()
        }
        return
      }

      if (viewportCommand.type === 'reset') {
        clearAllAnnotations()
        const engine = getRenderingEngine(engineIdRef.current)
        if (engine) {
          mprViewportIds.forEach((id) => {
            if (!isMprViewportRenderable(id)) return
            const viewport = engine.getViewport(id) as Types.IVolumeViewport | undefined
            viewport?.resetCamera()
            if (viewport) {
              setMprZooms((current) => ({ ...current, [id]: viewport.getZoom() }))
            }
            viewport?.render()
          })
        }
        return
      }

      if (viewportCommand.type === 'set-mpr-slice') {
        const targetViewportId = viewportCommand.targetViewportKey || activeViewport
        const sliceIndex = viewportCommand.sliceIndex
        if (typeof sliceIndex === 'number') {
          jumpMprViewportToSlice(targetViewportId, sliceIndex)
        }
        return
      }

      if (viewportCommand.type === 'reset-mpr-free-rotate') {
        resetMprSlabObliqueViewport(viewportCommand.targetViewportKey || activeViewport)
        return
      }

      if (viewportCommand.type === 'set-zoom' || viewportCommand.type === 'zoom-in' || viewportCommand.type === 'zoom-out' || viewportCommand.type === 'spatial-zoom-1x') {
        const viewportId = viewportCommand.targetViewportKey || activeViewport
        const engine = getRenderingEngine(engineIdRef.current)
        const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
        if (!viewport || !isMprViewportRenderable(viewportId)) return

        const zoom = viewportCommand.type === 'set-zoom' && typeof viewportCommand.zoom === 'number'
          ? viewportCommand.zoom
          : viewportCommand.type === 'spatial-zoom-1x'
            ? 1
            : Math.min(Math.max(viewport.getZoom() * (viewportCommand.type === 'zoom-in' ? 1.15 : 0.85), 0.2), 8)
        viewport.setZoom(zoom)
        viewport.render()
        setMprZooms((current) => ({ ...current, [viewportId]: zoom }))
        if (!isLinkedCommand) {
          broadcastLinkedMprCommand(viewportId, 'zoom', 'set-zoom', { zoom })
        }
        return
      }

      if (viewportCommand.type === 'set-pan') {
        const viewportId = viewportCommand.targetViewportKey || activeViewport
        const engine = getRenderingEngine(engineIdRef.current)
        const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
        if (!viewport || !isMprViewportRenderable(viewportId)) return

        if (viewportCommand.camera) {
          viewport.setCamera(viewportCommand.camera as Types.ICamera)
        }
        if (typeof viewportCommand.zoom === 'number') {
          viewport.setZoom(viewportCommand.zoom)
          setMprZooms((current) => ({ ...current, [viewportId]: viewportCommand.zoom ?? viewport.getZoom() }))
        }
        viewport.render()
        if (typeof viewportCommand.sliceIndex === 'number') {
          jumpMprViewportToSlice(viewportId, viewportCommand.sliceIndex)
        }
        return
      }

      if (viewportCommand.type === 'set-window-level') {
        const viewportId = viewportCommand.targetViewportKey || activeViewport
        if (viewportId === ich3dViewportId && viewportCommand.windowLevel) {
          applyIch3dWindowLevel(viewportCommand.windowLevel)
          return
        }
        const engine = getRenderingEngine(engineIdRef.current)
        const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
        if (!viewport || !isMprViewportRenderable(viewportId) || !viewportCommand.windowLevel) return

        setMprVoiRange(viewport, windowLevelToVoiRange(viewportCommand.windowLevel))
        setMprWindowLevels((current) => ({ ...current, [viewportId]: viewportCommand.windowLevel! }))
        viewport.render()
        return
      }

      if (viewportCommand.type === 'spatial-zoom-fit') {
        const viewportId = viewportCommand.targetViewportKey || activeViewport
        const engine = getRenderingEngine(engineIdRef.current)
        const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
        if (!viewport || !isMprViewportRenderable(viewportId)) return

        viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
        viewport.render()
        setMprZooms((current) => ({ ...current, [viewportId]: viewport.getZoom() }))
        return
      }

      if (viewportCommand.type === 'invert') {
        const viewportId = viewportCommand.targetViewportKey || activeViewport
        const engine = getRenderingEngine(engineIdRef.current)
        const viewport = engine?.getViewport(viewportId) as (Types.IVolumeViewport & {
          getProperties?: () => { invert?: boolean }
          setProperties?: (properties: { invert?: boolean }) => void
        }) | undefined
        if (!viewport || !isMprViewportRenderable(viewportId)) return

        viewport.setProperties?.({ invert: !viewport.getProperties?.().invert })
        viewport.render()
        return
      }

      if (
        viewportCommand.type === 'spatial-rotate-cw'
        || viewportCommand.type === 'spatial-rotate-ccw'
        || viewportCommand.type === 'spatial-rotate-180'
        || viewportCommand.type === 'spatial-flip-horizontal'
        || viewportCommand.type === 'spatial-flip-vertical'
      ) {
        const viewportId = viewportCommand.targetViewportKey || activeViewport
        const engine = getRenderingEngine(engineIdRef.current)
        const viewport = engine?.getViewport(viewportId) as (Types.IVolumeViewport & {
          flip?: (direction: { flipHorizontal?: boolean; flipVertical?: boolean }) => void
        }) | undefined
        if (!viewport || !isMprViewportRenderable(viewportId)) return

        if (viewportCommand.type === 'spatial-flip-horizontal') {
          viewport.flip?.({ flipHorizontal: true })
        } else if (viewportCommand.type === 'spatial-flip-vertical') {
          viewport.flip?.({ flipVertical: true })
        } else {
          const rotationDelta = viewportCommand.type === 'spatial-rotate-cw'
            ? 90
            : viewportCommand.type === 'spatial-rotate-ccw'
              ? -90
              : 180
          rotateMprViewportInPlane(viewport, rotationDelta)
        }
        viewport.render()
        return
      }

      const preset = getWindowPreset(viewportCommand.type)
      if (preset) {
        applyMprWindowPreset(preset, viewportCommand.targetViewportKey || activeViewport)
        const windowLevel = voiRangeToWindowLevel(preset)
        if (!isLinkedCommand) {
          broadcastLinkedMprCommand(viewportCommand.targetViewportKey || activeViewport, 'windowLevel', viewportCommand.type as MprLinkedCommandType, { windowLevel })
        }
      }
    } finally {
      applyingLinkedCommandRef.current = false
    }
  }, [activeViewport, isSelected, mprViewportIds, viewportCommand, viewportKey])

  function renderMprViewports() {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    mprViewportIds.forEach((id) => {
      if (!isMprViewportRenderable(id)) return
      engine.getViewport(id)?.render()
    })
  }

  // Volume prefetch: preload adjacent slices for smoother scrolling
  function prefetchAdjacentSlices(viewport: Types.IVolumeViewport, _viewportId: string, _range: number) {
    try {
      const sliceIndex = getMprSliceIndex(viewport)
      if (sliceIndex < 0) return
      // Trigger Cornerstone internal prefetch by re-setting properties
      const properties = (viewport as unknown as {
        getProperties?: () => { voiRange?: { lower: number; upper: number } }
      }).getProperties?.()
      if (properties?.voiRange) {
        viewport.setProperties({ voiRange: properties.voiRange } as never)
      }
    } catch {
      // Silently fail if prefetch is not supported
    }
  }

  function applyMprWindowPreset(voiRange: { lower: number; upper: number }, targetViewportId = activeViewport) {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    const windowLevel = voiRangeToWindowLevel(voiRange)
    if (targetViewportId === ich3dViewportId) {
      applyIch3dWindowLevel(windowLevel)
      return
    }

    mprPlaneViewportIds.forEach((id) => {
      if (!isMprViewportRenderable(id)) return
      const viewport = engine.getViewport(id) as Types.IVolumeViewport | undefined
      setMprVoiRange(viewport, voiRange)
      setMprWindowLevels((current) => ({ ...current, [id]: windowLevel }))
      viewport?.render()
    })
  }

  function isMprViewportRenderable(viewportId: string) {
    const index = mprViewportIds.indexOf(viewportId)
    const element = elementRefs.current[index]

    return Boolean(element && element.clientWidth > 2 && element.clientHeight > 2)
  }

  function areMprElementsRenderable() {
    return mprViewportIds.every((viewportId) => isMprViewportRenderable(viewportId))
  }

  function resizeMprWhenReady() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const engine = getRenderingEngine(engineIdRef.current)
        if (!engine || !areMprElementsRenderable()) return
        engine.resize(true, false)
        resetMprClippingRange()
        renderMprViewports()
      })
    })
  }

  function moveMprCompareViewportToAuxiliaryToolGroup() {
    const primaryToolGroup = toolGroupRef.current
    const auxiliaryToolGroup = compareToolGroupRef.current
    if (
      !primaryToolGroup
      || !auxiliaryToolGroup
      || !mprCompareViewportId
      || ich3dViewportModeRef.current === 'ich3d'
    ) {
      return
    }

    if (toolGroupContainsViewport(primaryToolGroup, mprCompareViewportId)) {
      primaryToolGroup.removeViewports(engineIdRef.current, mprCompareViewportId)
    }
    if (!toolGroupContainsViewport(auxiliaryToolGroup, mprCompareViewportId)) {
      auxiliaryToolGroup.addViewport(mprCompareViewportId, engineIdRef.current)
    }
  }

  function restoreMprCompareViewportToPrimaryToolGroup() {
    const primaryToolGroup = toolGroupRef.current
    const auxiliaryToolGroup = compareToolGroupRef.current
    if (!primaryToolGroup || !mprCompareViewportId || ich3dViewportModeRef.current === 'ich3d') {
      return
    }

    if (auxiliaryToolGroup && toolGroupContainsViewport(auxiliaryToolGroup, mprCompareViewportId)) {
      auxiliaryToolGroup.removeViewports(engineIdRef.current, mprCompareViewportId)
    }
    if (!toolGroupContainsViewport(primaryToolGroup, mprCompareViewportId)) {
      primaryToolGroup.addViewport(mprCompareViewportId, engineIdRef.current)
      orderMprToolGroupViewportsForCrosshairs(primaryToolGroup, viewportOrientationsRef.current)
    }
  }

  function setMprWheelScrollActive(toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>) {
    toolGroup.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
    })
  }

  function syncMprReferenceLinesTool(
    toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>,
    enabled: boolean,
    sourceViewportId: string,
  ) {
    try {
      if (!enabled) {
        toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
        return
      }

      const sourceId = mprPlaneViewportIds.includes(sourceViewportId) ? sourceViewportId : mprPlaneViewportIds[0]
      if (!sourceId) {
        toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
        return
      }

      toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
        sourceViewportId: sourceId,
        showFullDimension: true,
      })
      toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
    } catch {
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
    }
  }

  function setMprScrollToolActive(toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>) {
    toolGroup.setToolActive(StackScrollTool.toolName, {
      bindings: [
        { mouseButton: ToolEnums.MouseBindings.Primary },
        { mouseButton: ToolEnums.MouseBindings.Wheel },
      ],
    })
  }

  function stabilizeMprAfterOrientationChange(orientationIndexes = viewportOrientationsRef.current) {
    const run = () => {
      const engine = getRenderingEngine(engineIdRef.current)
      if (!engine || !areMprElementsRenderable()) return

      recomputeMprCrosshairsTool(orientationIndexes)
      engine.resize(true, false)
      mprPlaneViewportIds.forEach((id) => {
        const viewport = engine.getViewport(id) as Types.IVolumeViewport | undefined
        if (!viewport || !isMprViewportRenderable(id)) return
        setMprSlabThickness(viewport, slabThicknessesRef.current[id] ?? 1)
        setMprBlendMode(viewport, blendModes[id] ?? 'normal')
        resetViewportClippingRange(viewport)
        updateMprSliceInfo(id, viewport)
        viewport.render()
      })
    }

    requestAnimationFrame(() => {
      run()
      requestAnimationFrame(run)
    })
  }

  function recomputeMprCrosshairsTool(orientationIndexes = viewportOrientationsRef.current) {
    const toolGroup = toolGroupRef.current
    if (!toolGroup) return

    orderMprToolGroupViewportsForCrosshairs(toolGroup, orientationIndexes)

    const crosshairs = (toolGroup as unknown as {
      getToolInstance?: (toolName: string) => {
        computeToolCenter?: (viewportsInfo: unknown) => void
      }
      viewportsInfo?: unknown
    }).getToolInstance?.(CrosshairsTool.toolName)

    try {
      crosshairs?.computeToolCenter?.((toolGroup as unknown as { viewportsInfo?: unknown }).viewportsInfo)
    } catch {
      // Crosshairs may not be initialized yet while MPR is still mounting.
    }
  }

  function orderMprToolGroupViewportsForCrosshairs(
    toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>,
    orientationIndexes = viewportOrientationsRef.current
  ) {
    const group = toolGroup as unknown as { viewportsInfo?: Array<{ viewportId: string; renderingEngineId: string }> }
    const viewportsInfo = group.viewportsInfo
    if (!Array.isArray(viewportsInfo) || viewportsInfo.length < 3) return

    const axisByViewportId = new Map<string, string>()
    mprPlaneViewportIds.forEach((viewportId) => {
      const index = mprViewportIds.indexOf(viewportId)
      const option = MPR_ORIENTATION_OPTIONS[orientationIndexes[index]]
      if (option) {
        axisByViewportId.set(viewportId, option.orientation)
      }
    })

    const ordered: typeof viewportsInfo = []
    const usedViewportIds = new Set<string>()

    ;(['AXIAL', 'SAGITTAL', 'CORONAL'] as const).forEach((axis) => {
      const info = viewportsInfo.find((candidate) => !usedViewportIds.has(candidate.viewportId) && axisByViewportId.get(candidate.viewportId) === axis)
      if (info) {
        ordered.push(info)
        usedViewportIds.add(info.viewportId)
      }
    })

    if (ordered.length < 3) return

    viewportsInfo.forEach((info) => {
      if (!usedViewportIds.has(info.viewportId)) {
        ordered.push(info)
      }
    })

    viewportsInfo.splice(0, viewportsInfo.length, ...ordered)
  }

  function resetMprClippingRange() {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    mprViewportIds.forEach((id) => {
      const viewport = engine.getViewport(id) as Types.IVolumeViewport | undefined
      if (viewport) {
        resetViewportClippingRange(viewport)
      }
    })
  }

  function resetViewportClippingRange(viewport: Types.IVolumeViewport) {
    try {
      const clippingViewport = viewport as unknown as {
        updateCameraClippingPlanesAndRange?: () => void
        getRenderer?: () => { resetCameraClippingRange: () => void }
      }
      if (clippingViewport.updateCameraClippingPlanesAndRange) {
        clippingViewport.updateCameraClippingPlanesAndRange()
        return
      }
      const vtkRenderer = clippingViewport.getRenderer?.()
      vtkRenderer?.resetCameraClippingRange?.()
    } catch {
      // VTK internals are not always exposed by every viewport implementation.
    }
  }

  function lockMprStandardOrientations() {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    lockingMprOrientationRef.current = true
    try {
    mprPlaneViewportIds.forEach((viewportId) => {
      const index = mprViewportIds.indexOf(viewportId)
      const viewport = engine.getViewport(viewportId) as Types.IVolumeViewport | undefined
      if (!viewport || !isMprViewportRenderable(viewportId)) return

        const orientation = MPR_ORIENTATION_OPTIONS[viewportOrientationsRef.current[index] ?? 0]?.orientation ?? MPR_VIEWPORT_DEFS[index]?.orientation ?? 'AXIAL'
        const standardCamera = MPR_STANDARD_CAMERAS[orientation]
        const camera = viewport.getCamera()
        const normal = vec3.normalize(vec3.create(), camera.viewPlaneNormal)
        const viewUp = vec3.normalize(vec3.create(), camera.viewUp)
        const normalMatches = Math.abs(Math.abs(vec3.dot(normal, standardCamera.normal)) - 1) <= ORIENTATION_LABEL_TOLERANCE
        const viewUpMatches = Math.abs(Math.abs(vec3.dot(viewUp, standardCamera.viewUp)) - 1) <= ORIENTATION_LABEL_TOLERANCE

        if (normalMatches && viewUpMatches) {
          return
        }

        viewport.setCamera({
          ...camera,
          viewPlaneNormal: point3FromVec3(standardCamera.normal),
          viewUp: point3FromVec3(standardCamera.viewUp),
        })
        resetViewportClippingRange(viewport)
        updateMprOrientationLabel(viewportId, viewport)
        viewport.render()
      })
    } finally {
      lockingMprOrientationRef.current = false
    }
  }

  function resetMprSlabObliqueViewport(viewportId = activeViewport) {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return
    if (!mprPlaneViewportIds.includes(viewportId)) return

    const viewport = engine.getViewport(viewportId) as Types.IVolumeViewport | undefined
    if (!viewport) return

    const viewportIndex = mprViewportIds.indexOf(viewportId)
    const orientation = MPR_ORIENTATION_OPTIONS[viewportOrientationsRef.current[viewportIndex] ?? 0]?.orientation ?? 'SAGITTAL'
    const standardCamera = MPR_STANDARD_CAMERAS[orientation]
    const camera = viewport.getCamera()
    viewport.setCamera({
      ...camera,
      viewPlaneNormal: point3FromVec3(standardCamera.normal),
      viewUp: point3FromVec3(standardCamera.viewUp),
    })
    viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true })
    setMprSlabThickness(viewport, 1)
    setSlabThicknesses((current) => ({ ...current, [viewportId]: 1 }))
    setSlabThicknessInputs((current) => ({ ...current, [viewportId]: '1' }))
    slabThicknessesRef.current = { ...slabThicknessesRef.current, [viewportId]: 1 }
    resetViewportClippingRange(viewport)
    updateMprOrientationLabel(viewportId, viewport)
    updateMprSliceInfo(viewportId, viewport)
    setMprZooms((current) => ({ ...current, [viewportId]: viewport.getZoom() }))
    recomputeMprCrosshairsTool()
    viewport.render()
  }

  function rotateMprViewportInPlane(viewport: Types.IVolumeViewport, delta: number) {
    const currentRotation = viewport.getRotation()
    const nextRotation = ((currentRotation + delta) % 360 + 360) % 360

    lockingMprOrientationRef.current = true
    try {
      viewport.setViewPresentation({ rotation: nextRotation })
      resetViewportClippingRange(viewport)
    } finally {
      lockingMprOrientationRef.current = false
    }
  }

  function handleTileClick(viewportId: string) {
    onSelect?.()
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
  }

  function toggleMprInlineControls(event: React.MouseEvent<HTMLButtonElement>, viewportId: string) {
    event.preventDefault()
    event.stopPropagation()
    setExpandedControlViewports((current) => ({ ...current, [viewportId]: !current[viewportId] }))
  }

  function handleTileDoubleClick(viewportId: string) {
    onSelect?.()
    if (isIchWorkspaceActive) {
      setActiveViewport(viewportId)
      setMprActiveViewportId(viewportId, viewportKey)
      setMaximizedMprViewportId((current) => current === viewportId ? null : viewportId)
      window.requestAnimationFrame(() => {
        resizeMprWhenReady()
      })
      return
    }
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    onToggleViewportFullscreen?.()
    window.requestAnimationFrame(() => {
      resizeMprWhenReady()
    })
  }

  function handleOrientationCycle(event: React.PointerEvent<HTMLButtonElement>, viewportId: string, index: number) {
    event.preventDefault()
    event.stopPropagation()
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    cycleMprViewportPlane(viewportId, index)
  }

  function cycleMprViewportPlane(viewportId: string, knownIndex?: number) {
    const index = typeof knownIndex === 'number'
      ? knownIndex
      : mprViewportIds.indexOf(viewportId)
    if (index < 0) return
    if (!mprPlaneViewportIds.includes(viewportId)) return

    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    setViewportOrientations((current) => {
      const next = [...current]
      next[index] = (next[index] + 1) % MPR_ORIENTATION_OPTIONS.length
      viewportOrientationsRef.current = next
      const option = MPR_ORIENTATION_OPTIONS[next[index]]
      const engine = getRenderingEngine(engineIdRef.current)
      const viewport = engine?.getViewport(viewportId) as (Types.IVolumeViewport & { setOrientation?: (orientation: string) => void }) | undefined
      if (isMprViewportRenderable(viewportId)) {
        viewport?.setOrientation?.(Enums.OrientationAxis[option.orientation])
        viewport?.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true })
        if (viewport) {
          setMprSlabThickness(viewport, slabThicknesses[viewportId] ?? 1)
          setMprBlendMode(viewport, blendModes[viewportId] ?? 'normal')
          resetViewportClippingRange(viewport)
        }
        if (viewport) {
          setMprZooms((current) => ({ ...current, [viewportId]: viewport.getZoom() }))
        }
      }
      stabilizeMprAfterOrientationChange(next)
      return next
    })
  }

  function handleTilePointerDown(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    const now = Date.now()
    const hasModifierGesture = event.button === 0 && (event.ctrlKey || event.shiftKey)
    const isDoubleTap = !hasModifierGesture && lastPointerDownRef.current.viewportId === viewportId && now - lastPointerDownRef.current.time < 450
    onSelect?.()
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    if (viewportId === ich3dViewportId && isIchWorkspaceActive) {
      configureMprIch3dInteractions()
    }

    if (hasModifierGesture) {
      lastPointerDownRef.current = { viewportId: '', time: 0 }
      return
    }

    if (isDoubleTap) {
      lastPointerDownRef.current = { viewportId: '', time: 0 }
      handleTileDoubleClick(viewportId)
      return
    }

    lastPointerDownRef.current = { viewportId, time: now }
  }

  function startModifierGesture(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (event.button !== 0 || (!event.ctrlKey && !event.shiftKey)) {
      return
    }
    if (viewportId === ich3dViewportId) {
      return
    }

    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
    const element = event.currentTarget
    if (!viewport || !isMprViewportRenderable(viewportId)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    element.setPointerCapture(event.pointerId)
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)

    if (event.ctrlKey) {
      modifierGestureRef.current = {
        type: 'zoom',
        pointerId: event.pointerId,
        viewportId,
        startY: event.clientY,
        startZoom: viewport.getZoom(),
      }
      return
    }

    const rect = element.getBoundingClientRect()
    modifierGestureRef.current = {
      type: 'pan',
      pointerId: event.pointerId,
      viewportId,
      lastCanvasPoint: [event.clientX - rect.left, event.clientY - rect.top],
    }
  }

  function updateModifierGesture(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    const gesture = modifierGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.viewportId !== viewportId) {
      return
    }

    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
    const element = event.currentTarget
    if (!viewport || !isMprViewportRenderable(viewportId)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (gesture.type === 'zoom') {
      const deltaY = gesture.startY - event.clientY
      const nextZoom = Math.min(Math.max(gesture.startZoom * Math.exp(deltaY * 0.012), 0.1), 20)
      viewport.setZoom(nextZoom)
      resetViewportClippingRange(viewport)
      viewport.render()
      setMprZooms((current) => ({ ...current, [viewportId]: nextZoom }))
      broadcastLinkedMprCommand(viewportId, 'zoom', 'set-zoom', { zoom: nextZoom })
      return
    }

    const rect = element.getBoundingClientRect()
    const currentCanvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const lastWorld = viewport.canvasToWorld(gesture.lastCanvasPoint) as Types.Point3
    const currentWorld = viewport.canvasToWorld(currentCanvasPoint) as Types.Point3
    const delta: Types.Point3 = [
      lastWorld[0] - currentWorld[0],
      lastWorld[1] - currentWorld[1],
      lastWorld[2] - currentWorld[2],
    ]
    const camera = viewport.getCamera() as Types.ICamera
    const focalPoint = camera.focalPoint as Types.Point3 | undefined
    const position = camera.position as Types.Point3 | undefined
    viewport.setCamera({
      ...camera,
      ...(focalPoint ? { focalPoint: addPoint3(focalPoint, delta) } : {}),
      ...(position ? { position: addPoint3(position, delta) } : {}),
    })
    resetViewportClippingRange(viewport)
    updateMprSliceInfo(viewportId, viewport)
    viewport.render()
    modifierGestureRef.current = { ...gesture, lastCanvasPoint: currentCanvasPoint }
    broadcastLinkedMprCommand(viewportId, 'pan', 'set-pan', {
      camera: viewport.getCamera(),
      zoom: viewport.getZoom(),
      sliceIndex: getMprSliceInfo(viewportId, viewport).sliceIndex,
    })
  }

  function stopModifierGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (modifierGestureRef.current?.pointerId === event.pointerId) {
      modifierGestureRef.current = null
    }
  }

  function startIch3dWindowLevelGesture(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (viewportId !== ich3dViewportId || activeTool !== 'WindowLevel' || event.button !== 0) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    ich3dWindowLevelDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      windowWidth: ich3dWindowWidth,
      windowLevel: ich3dWindowLevel,
    }

    return true
  }

  function updateIch3dWindowLevelGesture(event: React.PointerEvent<HTMLDivElement>) {
    const drag = ich3dWindowLevelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    applyIch3dWindowLevel({
      windowWidth: drag.windowWidth + (event.clientX - drag.startX) * 0.32,
      windowLevel: drag.windowLevel + (drag.startY - event.clientY) * 0.32,
    })

    return true
  }

  function stopIch3dWindowLevelGesture(event: React.PointerEvent<HTMLDivElement>) {
    const drag = ich3dWindowLevelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    ich3dWindowLevelDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    return true
  }

  function handleTileContextMenu(event: React.MouseEvent, viewportId: string) {
    event.preventDefault()
    onSelect?.()
    if (!contextMenuEnabled) {
      setContextMenu(null)
      return
    }

    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    setActiveContextSection(permittedMenuSections[0]?.title ?? '')

    setContextMenu({
      x: Math.min(Math.max(event.clientX, 8), Math.max(8, window.innerWidth - 474 - 8)),
      y: Math.min(Math.max(event.clientY, 8), Math.max(8, window.innerHeight - 270 - 8)),
    })
  }

  function runMprMenuAction(action: ViewportMenuAction) {
    setContextMenu(null)

    if (action.type === 'tool') {
      setActiveTool(activeTool === action.tool ? 'WindowLevel' : action.tool)
      return
    }

    if (action.type === 'command') {
      if (action.command === 'save-secondary-capture') {
        window.dispatchEvent(new CustomEvent('vexa-viewer-open-viewport-capture', {
          detail: { viewportKey, captureViewportId: activeViewport },
        }))
        return
      }
      sendViewportCommand(action.command as Parameters<typeof sendViewportCommand>[0], activeViewport)
      return
    }

    if (action.type === 'reference-lines') {
      setReferenceLinesEnabled(!referenceLinesEnabled)
      return
    }

    if (action.type === 'custom') {
      if (action.id === 'toggle-overlay') {
        onToggleOverlay?.()
      }
      if (action.id === 'tag-browser') {
        onOpenTagBrowser?.()
      }
      if (action.id === 'toggle-mpr') {
        onToggleMpr?.()
      }
      if (action.id === 'toggle-3d') {
        onToggle3d?.()
      }
      if (action.id === 'toggle-3d-bone') {
        onToggle3dBone?.()
      }
      if (action.id === 'ambient-test') {
        onOpenAmbientTest?.()
      }
    }
  }

  function renderMprContextMenu() {
    if (!contextMenu) {
      return null
    }

    return createPortal(
      <div
        className="viewport-context-menu mpr-context-menu"
        ref={contextMenuRef}
        role="menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {permittedMenuSections.map((section) => {
          const SectionIcon = section.icon

          return (
            <div
              className={activeContextSection === section.title ? 'viewport-context-section open' : 'viewport-context-section'}
              key={section.title}
              onMouseEnter={() => setActiveContextSection(section.title)}
              onFocus={() => setActiveContextSection(section.title)}
            >
              <button
                className={hasActiveMenuItem(section, activeTool, referenceLinesEnabled) ? 'viewport-context-group active' : 'viewport-context-group'}
                type="button"
              >
                <SectionIcon size={16} />
                <span>{section.title}</span>
                <ChevronRight size={14} />
              </button>
              <div className="viewport-context-submenu" role="menu" onMouseEnter={() => setActiveContextSection(section.title)}>
                {section.items.map((item) => {
                  const Icon = item.icon
                  const isActive = item.action.type === 'tool' && activeTool === item.action.tool
                  const isReferenceActive = item.action.type === 'reference-lines' && referenceLinesEnabled

                  return (
                    <button
                      className={isActive || isReferenceActive ? 'viewport-context-item active' : 'viewport-context-item'}
                      key={item.id}
                      type="button"
                      onClick={() => runMprMenuAction(item.action)}
                    >
                      <Icon size={16} />
                      <span>{item.label}</span>
                      {getMenuItemHotkey(item, hotkeyOverrides) && <kbd>{getMenuItemHotkey(item, hotkeyOverrides)}</kbd>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>,
      document.body,
    )
  }

  function renderIchMovieComposer() {
    if (!ichMovieDialogOpen) return null

    const frameCount = Math.round(ichMovieConfig.fps * ichMovieConfig.durationSeconds)
    const estimatedMegabytes = (ichMovieConfig.resolution ** 2 * 3 * frameCount) / (1024 * 1024)
    return createPortal(
      <div
        className="ich-movie-backdrop"
        onPointerDown={(event) => {
          event.stopPropagation()
          if (event.target === event.currentTarget && !ichMovieBusy) setIchMovieDialogOpen(false)
        }}
      >
        <section className="ich-movie-dialog" role="dialog" aria-modal="true" aria-label="ICH 3D Cine Composer">
          <header>
            <div>
              <Film size={16} aria-hidden="true" />
              <span>3D Cine</span>
            </div>
            <button disabled={Boolean(ichMovieBusy)} type="button" aria-label="Close ICH cine composer" title="Close" onClick={() => setIchMovieDialogOpen(false)}>
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <div className="ich-movie-fields">
            <label>
              <span>Direction</span>
              <select
                aria-label="ICH cine direction"
                disabled={Boolean(ichMovieBusy)}
                value={ichMovieConfig.direction}
                onChange={(event) => setIchMovieConfig((current) => ({ ...current, direction: event.currentTarget.value as IchMovieDirection }))}
              >
                <option value="right">Rotate right</option>
                <option value="left">Rotate left</option>
                <option value="up">Rotate up</option>
                <option value="down">Rotate down</option>
              </select>
            </label>
            <label>
              <span>FPS</span>
              <select
                aria-label="ICH cine FPS"
                disabled={Boolean(ichMovieBusy)}
                value={ichMovieConfig.fps}
                onChange={(event) => setIchMovieConfig((current) => ({ ...current, fps: Number(event.currentTarget.value) }))}
              >
                {[10, 12, 15, 24, 30].map((fps) => <option key={fps} value={fps}>{fps}</option>)}
              </select>
            </label>
            <label>
              <span>Duration</span>
              <input
                aria-label="ICH cine duration in seconds"
                disabled={Boolean(ichMovieBusy)}
                max={10}
                min={2}
                step={1}
                type="number"
                value={ichMovieConfig.durationSeconds}
                onChange={(event) => setIchMovieConfig((current) => ({
                  ...current,
                  durationSeconds: Math.max(2, Math.min(10, Number(event.currentTarget.value) || 2)),
                }))}
              />
            </label>
            <label>
              <span>Resolution</span>
              <select
                aria-label="ICH cine resolution"
                disabled={Boolean(ichMovieBusy)}
                value={ichMovieConfig.resolution}
                onChange={(event) => setIchMovieConfig((current) => ({ ...current, resolution: Number(event.currentTarget.value) }))}
              >
                <option value={384}>384 x 384</option>
                <option value={512}>512 x 512</option>
              </select>
            </label>
          </div>
          <div className="ich-movie-summary">
            <span>{frameCount} frames</span>
            <span>{estimatedMegabytes.toFixed(1)} MB raw</span>
          </div>
          {ichMovieBusy && <progress max={1} value={ichMovieProgress} aria-label="ICH cine capture progress" />}
          <div className="ich-movie-status" aria-live="polite">{ichMovieStatus}</div>
          <footer>
            <button disabled={Boolean(ichMovieBusy)} type="button" onClick={() => void runIchMovieAction('preview')}>
              <Play size={14} aria-hidden="true" />
              Preview Cine
            </button>
            <button disabled={Boolean(ichMovieBusy)} type="button" onClick={() => void runIchMovieAction('local')}>
              <Download size={14} aria-hidden="true" />
              Video file
            </button>
            <button className="primary" disabled={Boolean(ichMovieBusy)} type="button" onClick={() => void runIchMovieAction('dicom')}>
              <Save size={14} aria-hidden="true" />
              Save DICOM Cine
            </button>
          </footer>
        </section>
      </div>,
      document.body,
    )
  }

  function handleMprCursorPointerDown(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (activeTool !== 'Stack3DCursor' || !mprPlaneViewportIds.includes(viewportId)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    mprCursorDragRef.current = { pointerId: event.pointerId, viewportId }
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    placeMpr3dCursor(event, viewportId)
  }

  function handleMprProbePointerDown(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (activeTool !== 'Probe' || event.button !== 0 || !mprPlaneViewportIds.includes(viewportId)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    mprLiveProbePointerRef.current = { pointerId: event.pointerId, viewportId }
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    setMprLiveProbeValue(readMprProbeValue(event, viewportId))
  }

  function handleMprProbePointerMove(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    const probe = mprLiveProbePointerRef.current
    if (activeTool !== 'Probe' || !probe || probe.pointerId !== event.pointerId || probe.viewportId !== viewportId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setMprLiveProbeValue(readMprProbeValue(event, viewportId))
  }

  function handleMprProbePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const probe = mprLiveProbePointerRef.current
    if (!probe || probe.pointerId !== event.pointerId) {
      return
    }

    mprLiveProbePointerRef.current = null
    setMprLiveProbeValue(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function readMprProbeValue(event: React.PointerEvent<HTMLDivElement>, viewportId: string): MprLiveProbeValue | null {
    const element = event.currentTarget
    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as (Types.IVolumeViewport & { getImageData?: () => unknown }) | undefined
    if (!viewport || !isMprViewportRenderable(viewportId) || !mprPlaneViewportIds.includes(viewportId)) {
      return null
    }

    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const imageData = viewport.getImageData?.() as unknown as {
      dimensions?: number[]
      imageData?: { worldToIndex?: (point: [number, number, number]) => number[] }
      voxelManager?: { getAtIJKPoint?: (point: [number, number, number]) => unknown }
      scaling?: { rescaleSlope?: number | string; rescaleIntercept?: number | string }
    } | undefined
    const dimensions = imageData?.dimensions
    const vtkImage = imageData?.imageData
    const voxelManager = imageData?.voxelManager
    if (!dimensions || !vtkImage?.worldToIndex || !voxelManager?.getAtIJKPoint) {
      return null
    }

    const world = viewport.canvasToWorld(canvasPoint) as Types.Point3
    const index = vtkImage.worldToIndex([world[0], world[1], world[2]])
    const cols = Math.floor(Number(dimensions[0] ?? 0))
    const rows = Math.floor(Number(dimensions[1] ?? 0))
    const slices = Math.max(1, Math.floor(Number(dimensions[2] ?? 1)))
    const col = Math.floor(index?.[0] ?? Number.NaN)
    const row = Math.floor(index?.[1] ?? Number.NaN)
    const slice = Math.floor(index?.[2] ?? 0)
    if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || col >= cols || row < 0 || row >= rows || slice < 0 || slice >= slices) {
      return null
    }

    const rawValue = Number(voxelManager.getAtIJKPoint([col, row, slice]))
    if (!Number.isFinite(rawValue)) {
      return null
    }

    const slope = Number(imageData.scaling?.rescaleSlope ?? 1) || 1
    const intercept = Number(imageData.scaling?.rescaleIntercept ?? 0) || 0

    return {
      viewportId,
      canvasPoint,
      value: rawValue * slope + intercept,
      unit: 'HU',
    }
  }

  function readMprIchSmartDragPoint(event: React.PointerEvent<HTMLDivElement>, viewportId: string): MprIchSmartDragPoint | null {
    return readMprIchSmartDragPointFromClient(event.currentTarget, viewportId, event.clientX, event.clientY)
  }

  function readMprIchSmartDragPointFromClient(
    element: HTMLDivElement,
    viewportId: string,
    clientX: number,
    clientY: number,
  ): MprIchSmartDragPoint | null {
    if (!mprPlaneViewportIds.includes(viewportId)) {
      return null
    }

    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as (Types.IVolumeViewport & { getImageData?: () => unknown }) | undefined
    if (!viewport || !isMprViewportRenderable(viewportId)) {
      return null
    }

    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [clientX - rect.left, clientY - rect.top]
    const worldPoint = viewport.canvasToWorld(canvasPoint) as Types.Point3
    const imageData = viewport.getImageData?.() as unknown as {
      dimensions?: number[]
      imageData?: { worldToIndex?: (point: [number, number, number]) => number[] }
    } | undefined
    const dimensions = imageData?.dimensions
    const index = imageData?.imageData?.worldToIndex?.([worldPoint[0], worldPoint[1], worldPoint[2]])
    let ijkPoint: Types.Point3 | null = null
    if (dimensions && index && index.length >= 3) {
      const candidate = [
        Math.round(Number(index[0])),
        Math.round(Number(index[1])),
        Math.round(Number(index[2])),
      ] as Types.Point3
      if (
        candidate[0] >= 0
        && candidate[0] < Number(dimensions[0] ?? 0)
        && candidate[1] >= 0
        && candidate[1] < Number(dimensions[1] ?? 0)
        && candidate[2] >= 0
        && candidate[2] < Number(dimensions[2] ?? 0)
      ) {
        ijkPoint = candidate
      }
    }

    return { canvasPoint, worldPoint, ijkPoint }
  }

  function bindMprIchWindowPointerEvents(pointerId: number) {
    ichSmartDragWindowCleanupRef.current?.()

    const handleWindowPointerMove = (event: PointerEvent) => {
      const drag = ichSmartDragRef.current
      if (!drag || drag.pointerId !== pointerId || event.pointerId !== pointerId) {
        return
      }

      const point = readMprIchSmartDragPointFromClient(drag.element, drag.viewportId, event.clientX, event.clientY)
      if (point) {
        event.preventDefault()
        updateMprIchSmartDragFromPoint(drag, point)
      }
    }

    const handleWindowPointerEnd = (event: PointerEvent) => {
      const drag = ichSmartDragRef.current
      if (!drag || drag.pointerId !== pointerId || event.pointerId !== pointerId) {
        return
      }

      const point = readMprIchSmartDragPointFromClient(drag.element, drag.viewportId, event.clientX, event.clientY)
      if (point) {
        updateMprIchSmartDragFromPoint(drag, point)
      }
      event.preventDefault()
      finishMprIchSmartDrag(pointerId)
    }

    window.addEventListener('pointermove', handleWindowPointerMove, true)
    window.addEventListener('pointerup', handleWindowPointerEnd, true)
    window.addEventListener('pointercancel', handleWindowPointerEnd, true)
    ichSmartDragWindowCleanupRef.current = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove, true)
      window.removeEventListener('pointerup', handleWindowPointerEnd, true)
      window.removeEventListener('pointercancel', handleWindowPointerEnd, true)
    }
  }

  function updateMprIchSmartDragFromPoint(drag: MprIchSmartDragSession, point: MprIchSmartDragPoint) {
    const radiusPx = Math.max(4, Math.hypot(point.canvasPoint[0] - drag.startCanvas[0], point.canvasPoint[1] - drag.startCanvas[1]))
    ichSmartDragRef.current = {
      ...drag,
      currentWorld: point.worldPoint,
      currentIJK: point.ijkPoint,
      currentCanvas: point.canvasPoint,
    }
    setIchSmartDragPreview({
      viewportId: drag.viewportId,
      mode: drag.mode,
      center: drag.startCanvas,
      radiusPx,
    })
    setIchDebugInfo({
      viewportId: drag.viewportId,
      phase: 'drag',
      ijkPoint: point.ijkPoint,
    })
  }

  function finishMprIchSmartDrag(pointerId: number) {
    const drag = ichSmartDragRef.current
    if (!drag || drag.pointerId !== pointerId) {
      return false
    }

    ichSmartDragRef.current = null
    ichSmartDragWindowCleanupRef.current?.()
    ichSmartDragWindowCleanupRef.current = null
    setIchSmartDragPreview({
      viewportId: drag.viewportId,
      mode: drag.mode,
      center: drag.currentCanvas,
      radiusPx: Math.max(4, ichBrushSize / 2),
    })
    if (drag.element.hasPointerCapture(pointerId)) {
      drag.element.releasePointerCapture(pointerId)
    }
    void commitMprIchSmartDrag(drag)

    return true
  }

  function startMprIchSmartDrag(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (viewportId === ich3dViewportId) {
      return false
    }
    if (!ichSmartDragEnabled || (activeTool !== 'ICHSegment' && activeTool !== 'ICHEraser') || event.button !== 0) {
      return false
    }

    const state = ensureMprIchSegmentation()
    const point = state ? readMprIchSmartDragPoint(event, viewportId) : null
    if (!state || !point) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    const mode = activeTool === 'ICHEraser' ? 'erase' : 'add'
    ichSmartDragRef.current = {
      pointerId: event.pointerId,
      viewportId,
      segmentationId: state.segmentationId,
      element: event.currentTarget,
      mode,
      seedWorld: point.worldPoint,
      currentWorld: point.worldPoint,
      seedIJK: point.ijkPoint,
      currentIJK: point.ijkPoint,
      startCanvas: point.canvasPoint,
      currentCanvas: point.canvasPoint,
    }
    setIchSmartDragPreview({
      viewportId,
      mode,
      center: point.canvasPoint,
      radiusPx: Math.max(8, ichBrushSize / 2),
    })
    setIchDebugInfo({
      viewportId,
      phase: 'down',
      ijkPoint: point.ijkPoint,
      message: state.labelmapVolumeId ?? 'labelmap active',
    })
    setIchSmartStatus(mode === 'erase' ? 'Smart erase siap' : 'Smart add siap')
    console.debug('[ICH MPR] pointerDown', {
      viewportId,
      segmentationId: state.segmentationId,
      labelmapVolumeId: state.labelmapVolumeId,
      ijkPoint: point.ijkPoint,
      worldPoint: point.worldPoint,
      mode,
    })
    bindMprIchWindowPointerEvents(event.pointerId)

    return true
  }

  function prepareMprIchNativeEdit(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (
      ichSmartDragEnabled
      || viewportId === ich3dViewportId
      || event.button !== 0
      || (activeTool !== 'ICHSegment' && activeTool !== 'ICHEraser')
    ) {
      return
    }

    const state = ensureMprIchSegmentation()
    if (state) {
      captureMprIchUndoSnapshot(state.segmentationId)
    }
  }

  function updateMprIchBrushCursor(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (
      viewportId === ich3dViewportId
      || (activeTool !== 'ICHSegment' && activeTool !== 'ICHEraser')
      || ichSmartDragRef.current
    ) {
      return
    }

    const point = readMprIchSmartDragPoint(event, viewportId)
    if (!point) {
      return
    }
    setIchSmartDragPreview({
      viewportId,
      mode: activeTool === 'ICHEraser' ? 'erase' : 'add',
      center: point.canvasPoint,
      radiusPx: Math.max(4, ichBrushSize / 2),
    })
  }

  function clearMprIchBrushCursor(viewportId: string) {
    if (!ichSmartDragRef.current) {
      setIchSmartDragPreview((current) => current?.viewportId === viewportId ? null : current)
    }
  }

  function updateMprIchSmartDrag(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    const drag = ichSmartDragRef.current
    if (!drag || drag.pointerId !== event.pointerId || drag.viewportId !== viewportId) {
      return false
    }

    const point = readMprIchSmartDragPoint(event, viewportId)
    if (!point) {
      return true
    }

    event.preventDefault()
    event.stopPropagation()
    updateMprIchSmartDragFromPoint(drag, point)

    return true
  }

  function stopMprIchSmartDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = ichSmartDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    finishMprIchSmartDrag(event.pointerId)

    return true
  }

  function handleMprIchLostPointerCapture(event: React.PointerEvent<HTMLDivElement>) {
    const drag = ichSmartDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return false
    }

    finishMprIchSmartDrag(event.pointerId)

    return true
  }

  function releaseMprIchForbiddenRegionsForAdd(seedIJK: Types.Point3, dragIJK: Types.Point3, releaseRadiusVoxels: number) {
    const currentRegions = ichForbiddenRegionsRef.current
    if (currentRegions.length === 0) {
      return currentRegions
    }

    const nextRegions = currentRegions.filter((region) => {
      const distanceToAction = getMprIchDistanceToSegment(region.centerIJK, seedIJK, dragIJK)
      return distanceToAction > region.radiusVoxels + releaseRadiusVoxels
    })

    if (nextRegions.length !== currentRegions.length) {
      ichForbiddenRegionsRef.current = nextRegions
    }

    return nextRegions
  }

  function getMprIchDistanceToSegment(point: Types.Point3, start: Types.Point3, end: Types.Point3) {
    const vx = end[0] - start[0]
    const vy = end[1] - start[1]
    const vz = end[2] - start[2]
    const wx = point[0] - start[0]
    const wy = point[1] - start[1]
    const wz = point[2] - start[2]
    const lengthSquared = vx * vx + vy * vy + vz * vz
    if (lengthSquared <= 0) {
      return Math.hypot(wx, wy, wz)
    }

    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / lengthSquared))
    const projectedX = start[0] + vx * t
    const projectedY = start[1] + vy * t
    const projectedZ = start[2] + vz * t

    return Math.hypot(point[0] - projectedX, point[1] - projectedY, point[2] - projectedZ)
  }

  async function commitMprIchSmartDrag(drag: MprIchSmartDragSession) {
    if (!loadedMprVolumeId) {
      return
    }

    captureMprIchUndoSnapshot(drag.segmentationId)
    setIchSmartStatus(drag.mode === 'erase' ? 'Erasing region...' : 'Computing smart region...')
    setIchDebugInfo({
      viewportId: drag.viewportId,
      phase: 'commit',
      ijkPoint: drag.currentIJK ?? drag.seedIJK,
    })
    console.debug('[ICH MPR] commit', {
      segmentationId: drag.segmentationId,
      referencedVolumeId: loadedMprVolumeId,
      seedIJK: drag.seedIJK,
      currentIJK: drag.currentIJK,
      mode: drag.mode,
    })
    try {
      const smartMaxRadiusVoxels = drag.mode === 'erase'
        ? Math.max(10, Math.min(34, Math.round(ichBrushSize * 1.25)))
        : Math.max(16, Math.min(42, Math.round(ichBrushSize * 1.65)))
      const smartMinRadiusVoxels = drag.mode === 'erase'
        ? Math.max(4, Math.min(12, Math.round(ichBrushSize * 0.45)))
        : Math.max(8, Math.min(22, Math.round(ichBrushSize * 0.85)))
      const smartMaxVoxels = drag.mode === 'erase' ? 32000 : 52000
      const forbiddenRegionsForRun = drag.mode === 'add'
        ? releaseMprIchForbiddenRegionsForAdd(
          drag.seedIJK,
          drag.currentIJK ?? drag.seedIJK,
          Math.max(smartMinRadiusVoxels, Math.round(ichBrushSize * 0.9)),
        )
        : ichForbiddenRegionsRef.current

      const result = await applyIchVolumeSmartDrag({
        segmentationId: drag.segmentationId,
        referencedVolumeId: loadedMprVolumeId,
        seedWorld: drag.seedWorld,
        dragWorld: drag.currentWorld,
        mode: drag.mode,
        minimumHu: ICH_DEFAULT_THRESHOLD_MIN,
        maximumHu: ICH_DEFAULT_THRESHOLD_MAX,
        adaptiveModel: ichAdaptiveModelRef.current,
        forbiddenRegions: forbiddenRegionsForRun,
        maxRadiusVoxels: smartMaxRadiusVoxels,
        minRadiusVoxels: smartMinRadiusVoxels,
        clearRadiusVoxels: Math.max(3, Math.min(14, Math.round(ichBrushSize * 0.42))),
        maxVoxels: smartMaxVoxels,
      })

      if (drag.mode === 'add' && result.adaptiveModel) {
        ichAdaptiveModelRef.current = mergeIchAdaptiveHuModels(ichAdaptiveModelRef.current, result.adaptiveModel)
      }
      if (drag.mode === 'erase' && result.matchedVoxels > 0) {
        const centerIJK = drag.currentIJK ?? drag.seedIJK
        if (centerIJK) {
          ichForbiddenRegionsRef.current = [
            ...ichForbiddenRegionsRef.current.slice(-23),
            {
              centerIJK,
              radiusVoxels: Math.max(3, Math.min(28, result.radiusVoxels * 0.85)),
            },
          ]
        }
      }

      setIchDebugInfo({
        viewportId: drag.viewportId,
        phase: result.matchedVoxels > 0 ? 'masked' : 'no-mask',
        ijkPoint: drag.currentIJK ?? drag.seedIJK,
        matchedVoxels: result.matchedVoxels,
        message: result.failureReason,
      })
      console.debug('[ICH MPR] result', result)
      setIchVolumeInfo({ voxelCount: result.totalVoxels, volumeMl: result.totalVolumeMl })
      setIchSmartStatus('')
      void refreshMprIch3dViewport()
      renderMprViewports()
    } catch (error) {
      console.warn('Unable to run MPR ICH smart drag.', error)
      setIchDebugInfo({
        viewportId: drag.viewportId,
        phase: 'error',
        ijkPoint: drag.currentIJK ?? drag.seedIJK,
        message: error instanceof Error ? error.message : 'unknown error',
      })
      setIchSmartStatus('')
      void refreshMprIch3dViewport()
      renderMprViewports()
    }
  }

  function handleMprCursorPointerMove(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    const drag = mprCursorDragRef.current
    if (activeTool !== 'Stack3DCursor' || !drag || drag.pointerId !== event.pointerId || drag.viewportId !== viewportId) {
      return
    }

    placeMpr3dCursor(event, viewportId)
  }

  function handleMprCursorPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const drag = mprCursorDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    mprCursorDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function placeMpr3dCursor(event: React.PointerEvent<HTMLDivElement>, sourceViewportId: string) {
    if (!mprPlaneViewportIds.includes(sourceViewportId)) {
      return
    }

    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(sourceViewportId) as Types.IVolumeViewport | undefined
    if (!viewport || !isMprViewportRenderable(sourceViewportId)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const worldPoint = viewport.canvasToWorld(canvasPoint) as Types.Point3
    applyMpr3dCursorWorldPoint(worldPoint, sourceViewportId)
  }

  function applyMpr3dCursorWorldPoint(worldPoint: Types.Point3, sourceViewportId: string) {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    mprCursorWorldRef.current = worldPoint
    const nextCursorPoints: Record<string, Types.Point2 | null> = {}

    mprPlaneViewportIds.forEach((viewportId) => {
      if (!isMprViewportRenderable(viewportId)) {
        nextCursorPoints[viewportId] = null
        return
      }

      const viewport = engine.getViewport(viewportId) as (Types.IVolumeViewport & { jumpToWorld?: (point: Types.Point3) => void }) | undefined
      if (!viewport) {
        nextCursorPoints[viewportId] = null
        return
      }

      if (viewportId !== sourceViewportId) {
        viewport.jumpToWorld?.(worldPoint)
      }
      nextCursorPoints[viewportId] = viewport.worldToCanvas(worldPoint) as Types.Point2
      updateMprSliceInfo(viewportId, viewport)
      viewport.render()
    })

    setMprCursorPoints(nextCursorPoints)
  }

  function handleMprZoomChange(event: React.ChangeEvent<HTMLInputElement>, viewportId: string) {
    event.stopPropagation()
    const nextZoom = Number(event.currentTarget.value)
    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as (Types.IVolumeViewport & { setZoom?: (zoom: number) => void }) | undefined
    if (!viewport || !isMprViewportRenderable(viewportId)) {
      return
    }

    viewport.setZoom?.(nextZoom)
    viewport.render()
    setMprZooms((current) => ({ ...current, [viewportId]: nextZoom }))
  }

  function handleSlabThicknessChange(viewportId: string, value: number) {
    const nextThickness = normalizeSlabThickness(value)
    const targetViewportIds = projectionSyncEnabled ? mprPlaneViewportIds : [viewportId].filter((id) => mprPlaneViewportIds.includes(id))
    const engine = getRenderingEngine(engineIdRef.current)
    let shouldRender = false

    targetViewportIds.forEach((targetViewportId) => {
      const viewport = engine?.getViewport(targetViewportId) as Types.IVolumeViewport | undefined
      if (!viewport || !isMprViewportRenderable(targetViewportId)) {
        return
      }

      setMprSlabThickness(viewport, nextThickness)
      viewport.render()
      updateMprSliceInfo(targetViewportId, viewport)
      shouldRender = true
    })

    setSlabThicknesses((current) => {
      const next = { ...current }
      targetViewportIds.forEach((targetViewportId) => {
        next[targetViewportId] = nextThickness
      })
      return next
    })
    setSlabThicknessInputs((current) => {
      const next = { ...current }
      targetViewportIds.forEach((targetViewportId) => {
        next[targetViewportId] = formatThicknessInput(nextThickness)
      })
      return next
    })
    slabThicknessesRef.current = {
      ...slabThicknessesRef.current,
      ...Object.fromEntries(targetViewportIds.map((targetViewportId) => [targetViewportId, nextThickness])),
    }

    if (shouldRender) {
      renderMprViewports()
    }
  }

  function handleSlabInputChange(event: React.ChangeEvent<HTMLInputElement>, viewportId: string) {
    const value = event.currentTarget.value
    setSlabThicknessInputs((current) => ({ ...current, [viewportId]: value }))
  }

  function handleSlabInputBlur(viewportId: string) {
    const value = slabThicknessInputs[viewportId]
    const numericValue = Number(value)
    if (!value?.trim() || !Number.isFinite(numericValue) || numericValue < 0.1) {
      setSlabThicknessInputs((current) => ({ ...current, [viewportId]: formatThicknessInput(slabThicknesses[viewportId] ?? 1) }))
    }
  }

  function handleBlendModeChange(viewportId: string, mode: MprBlendMode) {
    const engine = getRenderingEngine(engineIdRef.current)
    const targetViewportIds = projectionSyncEnabled ? mprPlaneViewportIds : [viewportId].filter((id) => mprPlaneViewportIds.includes(id))
    let shouldRender = false

    setBlendModes((current) => {
      const next = { ...current }
      targetViewportIds.forEach((targetViewportId) => {
        next[targetViewportId] = mode
      })
      return next
    })

    targetViewportIds.forEach((targetViewportId) => {
      const viewport = engine?.getViewport(targetViewportId) as Types.IVolumeViewport | undefined
      if (!viewport || !isMprViewportRenderable(targetViewportId)) {
        return
      }

      setMprBlendMode(viewport, mode)
      setMprSlabThickness(viewport, slabThicknessesRef.current[targetViewportId] ?? 1)
      viewport.render()
      shouldRender = true
    })

    if (shouldRender) {
      renderMprViewports()
    }
  }

  function applyManualSlabThickness(event: React.MouseEvent<HTMLButtonElement>, viewportId: string) {
    const value = slabThicknessInputs[viewportId]
    const numericValue = Number(value)
    if (value?.trim() && Number.isFinite(numericValue) && numericValue >= 0.1) {
      handleSlabThicknessChange(viewportId, numericValue)
      event.currentTarget.closest('details')?.removeAttribute('open')
    }
  }

  function updateMprSliceInfo(viewportId: string, viewport: Types.IVolumeViewport) {
    if (!mprPlaneViewportIds.includes(viewportId)) {
      return
    }

    const rawSliceIndex = getMprSliceIndex(viewport)
    const rawSliceCount = getMprSliceCount(viewport)
    const sliceStep = getEffectiveSliceStep(slabThicknessesRef.current[viewportId] ?? 1)
    if (rawSliceIndex >= 0 && rawSliceCount > 0) {
      const effectiveSliceCount = Math.max(1, Math.ceil(rawSliceCount / sliceStep))
      const effectiveSliceIndex = Math.min(Math.floor(rawSliceIndex / sliceStep), effectiveSliceCount - 1)
      setMprSliceDisplayInfo((current) => ({ ...current, [viewportId]: { sliceIndex: effectiveSliceIndex, sliceCount: effectiveSliceCount } }))
      setMprSliceInfo(viewportId, effectiveSliceIndex, effectiveSliceCount)
    }
  }

  function updateMprOrientationLabel(viewportId: string, viewport: Types.IVolumeViewport) {
    void viewport
    const viewportIndex = mprViewportIds.indexOf(viewportId)
    const orientationIndex = viewportOrientationsRef.current[viewportIndex] ?? getMprOrientationOptionIndex(MPR_VIEWPORT_DEFS[viewportIndex]?.orientation ?? 'AXIAL')
    const label = MPR_ORIENTATION_OPTIONS[orientationIndex]?.label ?? MPR_VIEWPORT_DEFS[viewportIndex]?.label ?? 'A'
    setMprOrientationLabels((current) => {
      if (current[viewportId] === label) {
        return current
      }

      return { ...current, [viewportId]: label }
    })
  }

  function jumpMprViewportToSlice(viewportId: string, sliceIndex: number) {
    if (!mprPlaneViewportIds.includes(viewportId)) {
      return
    }

    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as (Types.IVolumeViewport & { getSlicePlaneCoordinates?: () => Array<{ sliceIndex: number; point: Types.Point3 }> ; jumpToWorld?: (point: Types.Point3) => void }) | undefined
    if (!viewport || !isMprViewportRenderable(viewportId)) {
      return
    }

    const sliceStep = getEffectiveSliceStep(slabThicknessesRef.current[viewportId] ?? 1)
    const rawSliceIndex = sliceIndex * sliceStep
    const coordinates = viewport.getSlicePlaneCoordinates?.() ?? []
    const target = coordinates.find((item) => item.sliceIndex === rawSliceIndex)
      ?? coordinates.reduce<{ sliceIndex: number; point: Types.Point3 } | null>((closest, item) => {
        if (!closest || Math.abs(item.sliceIndex - rawSliceIndex) < Math.abs(closest.sliceIndex - rawSliceIndex)) {
          return item
        }
        return closest
      }, null)

    if (!target) {
      return
    }

    viewport.jumpToWorld?.(target.point)
    viewport.render()
    updateMprSliceInfo(viewportId, viewport)
    renderMprViewports()
  }

  function getMprSliceInfo(viewportId: string, viewport: Types.IVolumeViewport) {
    const rawSliceIndex = getMprSliceIndex(viewport)
    const rawSliceCount = getMprSliceCount(viewport)
    const sliceStep = getEffectiveSliceStep(slabThicknessesRef.current[viewportId] ?? 1)
    const sliceCount = rawSliceCount > 0 ? Math.max(1, Math.ceil(rawSliceCount / sliceStep)) : 0
    const sliceIndex = rawSliceIndex >= 0 && sliceCount > 0
      ? Math.min(Math.floor(rawSliceIndex / sliceStep), sliceCount - 1)
      : 0

    return { sliceIndex, sliceCount }
  }

  function broadcastLinkedMprCommand(sourceViewportId: string, option: MprIntelliLinkOption, type: MprLinkedCommandType, options: MprLinkedCommandOptions) {
    if (!mprPlaneViewportIds.includes(sourceViewportId)) {
      return
    }

    const state = useViewerStore.getState()
    if (!state.intelliLink[option]) {
      return
    }

    const paneId = getMprPaneId(sourceViewportId)
    if (!paneId) {
      return
    }

    getVisibleViewportKeys(state.viewportLayout).forEach((targetViewportKey) => {
      if (targetViewportKey === viewportKey || !state.mprViewportKeys[targetViewportKey]) {
        return
      }

      const targetViewportId = `mpr-${targetViewportKey.replace(/[^a-zA-Z0-9_-]/g, '_')}-${paneId}`
      state.sendViewportCommand(type, targetViewportId, {
        ...options,
        sourceViewportKey: viewportKey,
      })
    })
  }

  return (
    <div className={loading ? 'mpr-container loading' : 'mpr-container'} ref={containerRef} onPointerDown={onSelect}>
      {isIchWorkspaceActive && (
        <div
          className="ich-segmentation-panel"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="ich-segmentation-title" title="ICH Segment - Volume workspace" aria-label="ICH Segment volume workspace">
            <Droplets size={13} aria-hidden="true" />
          </div>
          <div className="ich-segmentation-modes" role="group" aria-label="ICH segmentation mode">
            <button
              className={activeTool === 'ICHSegment' ? 'active' : ''}
              disabled={!volumeLoaded}
              title="Add region"
              type="button"
              aria-label="Add ICH region"
              onClick={() => handleIchModeChange('ICHSegment')}
            >
              <Brush size={13} aria-hidden="true" />
            </button>
            <button
              className={activeTool === 'ICHEraser' ? 'active' : ''}
              disabled={!volumeLoaded}
              title="Clear region"
              type="button"
              aria-label="Clear ICH region"
              onClick={() => handleIchModeChange('ICHEraser')}
            >
              <EraserIcon size={13} aria-hidden="true" />
            </button>
          </div>
          <button
            className={`ich-smart-toggle${ichSmartDragEnabled ? ' active' : ''}`}
            type="button"
            aria-pressed={ichSmartDragEnabled}
            title="Smart region growing"
            onClick={() => setIchSmartDragEnabled((current) => !current)}
          >
            <Sparkles size={13} aria-hidden="true" />
          </button>
          <details className="ich-settings-menu">
            <summary title="ICH brush settings" aria-label="ICH brush settings">
              <Settings size={13} aria-hidden="true" />
            </summary>
            <div className="ich-settings-popover">
              <label className="ich-range-control" title={`Brush size ${Math.round(ichBrushSize)}`}>
                <Gauge size={13} aria-hidden="true" />
                <input
                  aria-label="ICH brush size"
                  max={60}
                  min={2}
                  step={1}
                  type="range"
                  value={ichBrushSize}
                  onChange={(event) => setIchBrushSizeState(Number(event.currentTarget.value))}
                />
                <output>{Math.round(ichBrushSize)}</output>
              </label>
              <label className="ich-range-control" title={`Overlay opacity ${Math.round(ichOpacity * 100)}%`}>
                <Droplets size={13} aria-hidden="true" />
                <input
                  aria-label="ICH overlay opacity"
                  max={0.75}
                  min={0.1}
                  step={0.05}
                  type="range"
                  value={ichOpacity}
                  onChange={(event) => setIchOpacity(Number(event.currentTarget.value))}
                />
                <output>{Math.round(ichOpacity * 100)}%</output>
              </label>
            </div>
          </details>
          <div className="ich-history-actions" aria-label="ICH segmentation history">
            <button disabled={!ichHistoryState.canUndo} title="Undo ICH edit (Ctrl+Z)" type="button" onClick={handleMprIchUndo}>
              <Undo2 size={13} aria-hidden="true" />
            </button>
            <button disabled={!ichHistoryState.canRedo} title="Redo ICH edit (Ctrl+Shift+Z)" type="button" onClick={handleMprIchRedo}>
              <Redo2 size={13} aria-hidden="true" />
            </button>
          </div>
          <button className="ich-segmentation-clear" disabled={!ichSegmentationId} title="Clear all ICH mask" type="button" aria-label="Clear all ICH mask" onClick={handleIchClear}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
          <button
            className="ich-segmentation-clear ich-save-button"
            disabled={!canSaveIchSegmentation || !ichSegmentationId || ichVolumeInfo.voxelCount <= 0 || ichSaving}
            title={canSaveIchSegmentation ? 'Save the four visible ICH viewports as one named DICOM series' : 'ICH save permission required'}
            type="button"
            aria-label="Save four-view ICH capture series"
            onClick={() => void handleSaveIchDicom()}
          >
            <Save size={13} aria-hidden="true" />
          </button>
          <button
            className="ich-segmentation-clear ich-movie-button"
            disabled={!canExportIchCine || !ichSegmentationId || ichVolumeInfo.voxelCount <= 0}
            title={canExportIchCine ? '3D Cine composer (orbit is used for cine only)' : 'ICH cine permission required'}
            type="button"
            aria-label="Open ICH 3D cine composer"
            onClick={() => {
              setIchMovieStatus('')
              setIchMovieDialogOpen(true)
            }}
          >
            <Film size={13} aria-hidden="true" />
          </button>
          <button className="ich-segmentation-clear ich-exit-button" title="Exit ICH workspace" type="button" aria-label="Exit ICH workspace" onClick={handleExitIchWorkspace}>
            <LogOut size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="mpr-grid">
        {mprViewportIds.map((viewportId, index) => {
          const isIch3dViewport = viewportId === ich3dViewportId
          const orientation = MPR_ORIENTATION_OPTIONS[viewportOrientations[index]]
          const orientationLabel = mprOrientationLabels[viewportId] ?? orientation.label
          const orientationName = getMprOrientationName(orientationLabel)
          const blendModeOption = getMprBlendModeOption(blendModes[viewportId] ?? 'normal')
          const BlendModeIcon = blendModeOption.icon
          const controlsExpanded = Boolean(expandedControlViewports[viewportId])
          const isMaximized = maximizedMprViewportId === viewportId
          const isHiddenByMaximize = Boolean(maximizedMprViewportId && !isMaximized)
          const overlayInfo = isIch3dViewport
            ? buildMprIch3dOverlayInfo({
              series,
              windowWidth: ich3dWindowWidth,
              windowLevel: ich3dWindowLevel,
            })
            : buildMprOverlayInfo({
              study,
              series,
              plane: orientationLabel,
              sliceInfo: mprSliceDisplayInfo[viewportId],
              windowLevel: mprWindowLevels[viewportId],
              zoom: mprZooms[viewportId] ?? 1,
              blendMode: blendModes[viewportId] ?? 'normal',
              slabThickness: slabThicknesses[viewportId] ?? 1,
            })
          return (
            <div
              key={viewportId}
              className={`mpr-viewport-tile${isIch3dViewport ? ' ich-3d-tile' : ''}${isIchToolActive && !isIch3dViewport ? ' ich-mask-cursor' : ''}${activeViewport === viewportId ? ' active' : ''}${isMaximized ? ' maximized' : ''}${isHiddenByMaximize ? ' hidden' : ''}`}
              data-capture-label={isIch3dViewport
                ? 'ICH 3D Volume'
                : viewportId === mprCompareViewportId
                  ? `${orientationName} Compare`
                  : orientationName}
              data-capture-viewport-id={viewportId}
              onClick={() => handleTileClick(viewportId)}
              onPointerDown={(event) => handleTilePointerDown(event, viewportId)}
              onContextMenu={(event) => handleTileContextMenu(event, viewportId)}
            >
              <div
                className="mpr-viewport-element"
                ref={(el) => { elementRefs.current[index] = el }}
                onPointerEnter={() => {
                  if (isIch3dViewport) configureMprIch3dInteractions()
                }}
                onPointerLeave={() => clearMprIchBrushCursor(viewportId)}
                onPointerDown={(event) => {
                  if (startIch3dWindowLevelGesture(event, viewportId)) {
                    return
                  }
                  startModifierGesture(event, viewportId)
                  if (!modifierGestureRef.current) {
                    prepareMprIchNativeEdit(event, viewportId)
                    if (startMprIchSmartDrag(event, viewportId)) {
                      return
                    }
                    handleMprProbePointerDown(event, viewportId)
                    handleMprCursorPointerDown(event, viewportId)
                  }
                }}
                onPointerMove={(event) => {
                  if (updateIch3dWindowLevelGesture(event)) {
                    return
                  }
                  updateModifierGesture(event, viewportId)
                  if (updateMprIchSmartDrag(event, viewportId)) {
                    return
                  }
                  if (!modifierGestureRef.current) {
                    updateMprIchBrushCursor(event, viewportId)
                    handleMprProbePointerMove(event, viewportId)
                    handleMprCursorPointerMove(event, viewportId)
                  }
                }}
                onPointerUp={(event) => {
                  if (stopIch3dWindowLevelGesture(event)) {
                    stopModifierGesture(event)
                    return
                  }
                  if (stopMprIchSmartDrag(event)) {
                    stopModifierGesture(event)
                    return
                  }
                  stopModifierGesture(event)
                  handleMprProbePointerUp(event)
                  handleMprCursorPointerUp(event)
                }}
                onPointerCancel={(event) => {
                  if (stopIch3dWindowLevelGesture(event)) {
                    stopModifierGesture(event)
                    return
                  }
                  if (stopMprIchSmartDrag(event)) {
                    stopModifierGesture(event)
                    return
                  }
                  stopModifierGesture(event)
                  handleMprProbePointerUp(event)
                  handleMprCursorPointerUp(event)
                }}
                onLostPointerCapture={(event) => {
                  if (stopIch3dWindowLevelGesture(event)) {
                    stopModifierGesture(event)
                    return
                  }
                  if (handleMprIchLostPointerCapture(event)) {
                    stopModifierGesture(event)
                    return
                  }
                  stopModifierGesture(event)
                }}
              />
              {previewUrls?.[viewportId] && !volumeLoaded && (
                <img
                  className="mpr-preview-overlay"
                  src={previewUrls[viewportId]}
                  alt="MPR preview"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    pointerEvents: 'none',
                    zIndex: 10,
                  }}
                />
              )}
              {ichSmartDragPreview?.viewportId === viewportId && (
                <div
                  className={ichSmartDragPreview.mode === 'erase' ? 'ich-smart-drag-preview erase' : 'ich-smart-drag-preview'}
                  style={{
                    left: ichSmartDragPreview.center[0],
                    top: ichSmartDragPreview.center[1],
                    width: ichSmartDragPreview.radiusPx * 2,
                    height: ichSmartDragPreview.radiusPx * 2,
                  }}
                />
              )}
              <Mpr3dCursorOverlay point={mprCursorPoints[viewportId]} />
              <MprReferenceLineOverlay
                enabled={false}
                engineId={engineIdRef.current}
                sourceViewportId={activeViewport}
                targetViewportId={viewportId}
              />
              {mprLiveProbeValue?.viewportId === viewportId && (
                <div
                  className="live-probe-overlay mpr-live-probe-overlay"
                  style={{ left: mprLiveProbeValue.canvasPoint[0] + 16, top: mprLiveProbeValue.canvasPoint[1] - 10 }}
                >
                  <span className="live-probe-value">{mprLiveProbeValue.value.toFixed(1)}</span>
                  <span className="live-probe-unit">{mprLiveProbeValue.unit}</span>
                </div>
              )}
              {showOverlay && (
                <>
                  <MprOverlayBlock className="top-left" lines={overlayInfo.topLeft} />
                  <MprOverlayBlock className="top-right" lines={overlayInfo.topRight} />
                  <MprOverlayBlock className="bottom-left" lines={overlayInfo.bottomLeft} />
                  <MprOverlayBlock className="bottom-right viewport-image-info" lines={overlayInfo.bottomRight} />
                </>
              )}
              {isIch3dViewport && showIch3dVolumeMl && ichVolumeInfo.volumeMl !== null && (
                <div className="ich-volume-badge three-dimensional" aria-live="polite">
                  {formatIchVolumeBadgeText(ichVolumeInfo.volumeMl)}
                </div>
              )}
              {!isIchWorkspaceActive && (
                <div
                  className={`mpr-inline-controls ${controlsExpanded ? 'expanded' : 'collapsed'}`}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                <button
                  className="mpr-controls-toggle"
                  type="button"
                  aria-expanded={controlsExpanded}
                  title={controlsExpanded ? 'Hide MPR controls' : 'Show MPR controls'}
                  onClick={(event) => toggleMprInlineControls(event, viewportId)}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  {controlsExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                </button>
                {controlsExpanded && (
                  isIch3dViewport ? (
                    <button
                      className={`mpr-ich3d-volume-toggle${showIch3dVolumeMl ? ' active' : ''}`}
                      type="button"
                      aria-pressed={showIch3dVolumeMl}
                      title={showIch3dVolumeMl ? 'Hide volume ml' : 'Show volume ml'}
                      onClick={(event) => {
                        event.stopPropagation()
                        setShowIch3dVolumeMl((current) => !current)
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      ml
                    </button>
                  ) : (
                    <>
                    <button
                      className="mpr-label mpr-control-trigger"
                      type="button"
                      title={`Plane ${orientationName}. Click to cycle orientation.`}
                      onPointerDown={(event) => handleOrientationCycle(event, viewportId, index)}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <span className="mpr-plane-symbol" aria-hidden="true">{orientationLabel}</span>
                      <span className="mpr-control-copy">
                        <small>Plane</small>
                        <strong>{orientationName}</strong>
                      </span>
                      <ChevronRight className="mpr-control-chevron" size={13} aria-hidden="true" />
                    </button>
                    <details className="mpr-thickness-menu">
                      <summary title="Slice thickness">
                        <Layers3 size={15} aria-hidden="true" />
                        <span className="mpr-control-copy">
                          <small>Thickness</small>
                          <strong>{formatThicknessLabel(slabThicknesses[viewportId] ?? 1)}</strong>
                        </span>
                        <ChevronDown className="mpr-control-chevron" size={12} aria-hidden="true" />
                      </summary>
                      <div className="mpr-thickness-popover">
                        <div className="mpr-popover-heading"><Layers3 size={14} />Slice thickness</div>
                        <div className="mpr-thickness-presets">
                        {[1, 2, 3, 5].map((value) => (
                          <button
                            className={slabThicknesses[viewportId] === value ? 'active' : ''}
                            key={value}
                            type="button"
                            onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); handleSlabThicknessChange(viewportId, value) }}
                          >
                            {value} mm
                          </button>
                        ))}
                        </div>
                        <label>
                          <span>Custom thickness</span>
                          <input
                            aria-label="Manual slice thickness in millimeters"
                            min={0.1}
                            step={0.5}
                            type="number"
                            value={slabThicknessInputs[viewportId] ?? ''}
                            onChange={(event) => handleSlabInputChange(event, viewportId)}
                            onBlur={() => handleSlabInputBlur(viewportId)}
                          />
                        </label>
                        <button className="manual-apply" type="button" onClick={(event) => applyManualSlabThickness(event, viewportId)}>
                          Apply
                        </button>
                      </div>
                    </details>
                    <details className="mpr-blend-menu">
                      <summary title={blendModeOption.title}>
                        <BlendModeIcon size={15} aria-hidden="true" />
                        <span className="mpr-control-copy">
                          <small>Projection</small>
                          <strong>{blendModeOption.label}</strong>
                        </span>
                        <ChevronDown className="mpr-control-chevron" size={12} aria-hidden="true" />
                      </summary>
                      <div className="mpr-blend-popover">
                        <div className="mpr-popover-heading"><ScanLine size={14} />Projection mode</div>
                        {MPR_BLEND_MODE_OPTIONS.map((mode) => (
                          <button
                            className={blendModes[viewportId] === mode.id ? 'active' : ''}
                            key={mode.id}
                            title={mode.title}
                            type="button"
                            onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); handleBlendModeChange(viewportId, mode.id) }}
                          >
                            <mode.icon size={15} aria-hidden="true" />
                            <span><strong>{mode.label}</strong><small>{mode.title}</small></span>
                          </button>
                        ))}
                      </div>
                    </details>
                    <button
                      aria-label={projectionSyncEnabled ? 'Disable synchronized projection and thickness' : 'Enable synchronized projection and thickness'}
                      aria-pressed={projectionSyncEnabled}
                      className={`mpr-projection-sync-toggle${projectionSyncEnabled ? ' active' : ''}`}
                      title={projectionSyncEnabled ? 'Projection sync on' : 'Projection sync off'}
                      type="button"
                      onClick={() => setProjectionSyncEnabled((current) => !current)}
                    >
                      <Link2 size={14} aria-hidden="true" />
                    </button>
                  </>
                  )
                )}
                </div>
              )}
              {activeTool === 'Zoom' && activeViewport === viewportId && (
                <div className="viewport-zoom-control" aria-label="MPR zoom control">
                  <input
                    aria-label="Zoom MPR image"
                    className="viewport-zoom-slider"
                    max={8}
                    min={0.2}
                    step={0.05}
                    type="range"
                    value={Math.min(Math.max(mprZooms[viewportId] ?? 1, 0.2), 8)}
                    onChange={(event) => handleMprZoomChange(event, viewportId)}
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
      {loading && <div className="viewer-loading-indicator" role="status" aria-label="Loading MPR viewports" />}
      {renderIchMovieComposer()}
      {renderMprContextMenu()}
    </div>
  )
}

function createIchOrbitCamera(camera: Types.ICamera, direction: IchMovieDirection, angle: number): Types.ICamera {
  const focalPoint = vec3.fromValues(...camera.focalPoint)
  const position = vec3.fromValues(...camera.position)
  const viewUp = vec3.fromValues(...camera.viewUp)
  const offset = vec3.subtract(vec3.create(), position, focalPoint)
  const horizontalAxis = vec3.normalize(vec3.create(), viewUp)
  const verticalAxis = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), offset, viewUp))
  const axis = direction === 'up' || direction === 'down' ? verticalAxis : horizontalAxis
  const signedAngle = direction === 'left' || direction === 'down' ? -angle : angle
  const rotatedOffset = rotateVectorAroundAxis(offset, axis, signedAngle)
  const rotatedPosition = vec3.add(vec3.create(), focalPoint, rotatedOffset)
  const rotatedViewUp = rotateVectorAroundAxis(viewUp, axis, signedAngle)
  const rotatedNormal = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), rotatedPosition, focalPoint))

  return {
    ...camera,
    position: Array.from(rotatedPosition) as Types.Point3,
    focalPoint: Array.from(focalPoint) as Types.Point3,
    viewUp: Array.from(rotatedViewUp) as Types.Point3,
    viewPlaneNormal: Array.from(rotatedNormal) as Types.Point3,
  }
}

function rotateVectorAroundAxis(vector: vec3, axis: vec3, angle: number) {
  const normalizedAxis = vec3.normalize(vec3.create(), axis)
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const first = vec3.scale(vec3.create(), vector, cosine)
  const second = vec3.scale(vec3.create(), vec3.cross(vec3.create(), normalizedAxis, vector), sine)
  const third = vec3.scale(vec3.create(), normalizedAxis, vec3.dot(normalizedAxis, vector) * (1 - cosine))
  return vec3.add(vec3.create(), vec3.add(vec3.create(), first, second), third)
}

function drawViewportCanvasContained(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  viewportElement: HTMLElement,
  width: number,
  height: number,
) {
  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  const canvasRect = source.getBoundingClientRect()
  const viewportRect = viewportElement.getBoundingClientRect()
  const canvasScaleX = source.width / Math.max(canvasRect.width, 1)
  const canvasScaleY = source.height / Math.max(canvasRect.height, 1)
  const sourceX = Math.max(0, Math.round((viewportRect.left - canvasRect.left) * canvasScaleX))
  const sourceY = Math.max(0, Math.round((viewportRect.top - canvasRect.top) * canvasScaleY))
  const sourceWidth = Math.max(1, Math.min(source.width - sourceX, Math.round(viewportRect.width * canvasScaleX)))
  const sourceHeight = Math.max(1, Math.min(source.height - sourceY, Math.round(viewportRect.height * canvasScaleY)))
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale))
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale))
  context.drawImage(
    source,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    Math.round((width - drawWidth) / 2),
    Math.round((height - drawHeight) / 2),
    drawWidth,
    drawHeight,
  )
}

function canvasToRgbFrame(context: CanvasRenderingContext2D, width: number, height: number) {
  const rgba = context.getImageData(0, 0, width, height).data
  const rgb = new Uint8Array(width * height * 3)
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source]
    rgb[target + 1] = rgba[source + 1]
    rgb[target + 2] = rgba[source + 2]
  }
  return rgb
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
}

function delayMs(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}

function getMprSliceIndex(viewport: Types.IVolumeViewport) {
  const sliceIndex = (viewport as Types.IVolumeViewport & { getSliceIndex?: () => number }).getSliceIndex?.()
  return Number.isFinite(sliceIndex) ? Math.round(sliceIndex as number) : -1
}

function MprOverlayBlock({ className, lines }: { className: string; lines: string[] }) {
  if (!lines.length) {
    return null
  }

  return (
    <div className={`viewport-overlay mpr-overlay ${className}`}>
      {lines.map((line, index) => <span key={`${className}-${line}-${index}`}>{line}</span>)}
    </div>
  )
}

function buildMprOverlayInfo({
  study,
  series,
  plane,
  sliceInfo,
  windowLevel,
  zoom,
  blendMode,
  slabThickness,
}: {
  study?: StudySummary | null
  series: SeriesSummary
  plane: string
  sliceInfo?: MprSliceDisplayInfo
  windowLevel?: { windowWidth: number; windowLevel: number }
  zoom: number
  blendMode: MprBlendMode
  slabThickness: number
}) {
  const formattedStudyDate = formatMprDate(study?.studyDate || series.studyDate)
  const sliceText = sliceInfo?.sliceCount
    ? `Slice: ${sliceInfo.sliceIndex + 1} / ${sliceInfo.sliceCount}`
    : undefined
  const windowText = windowLevel
    ? `WW/WL: ${Math.round(windowLevel.windowWidth)} / ${Math.round(windowLevel.windowLevel)}`
    : undefined

  return {
    topLeft: compactMprOverlayLines([
      study?.patientName || 'Unknown Patient',
      study?.patientId ? `ID: ${study.patientId}` : undefined,
    ]),
    topRight: compactMprOverlayLines([
      compactMprLine([series.modality || study?.modalities, study?.studyDescription], ' - '),
      series.seriesDescription,
      formattedStudyDate,
      study?.accessionNumber ? `Acc: ${study.accessionNumber}` : undefined,
    ]),
    bottomLeft: compactMprOverlayLines([
      `MPR ${plane}`,
      sliceText,
      slabThickness > 1 ? `Slab: ${formatMprNumber(slabThickness)} mm` : undefined,
      getMprBlendModeLabel(blendMode),
    ]),
    bottomRight: compactMprOverlayLines([
      windowText,
      `Zoom: ${(zoom * 100).toFixed(0)}%`,
      series.seriesNumber ? `Series: ${series.seriesNumber}` : undefined,
    ]),
  }
}

function buildMprIch3dOverlayInfo({
  series,
  windowWidth,
  windowLevel,
}: {
  series: SeriesSummary
  windowWidth: number
  windowLevel: number
}) {
  return {
    topLeft: ['3D', 'ICH Volume'],
    topRight: compactMprOverlayLines([
      series.seriesDescription,
      series.seriesNumber ? `Series: ${series.seriesNumber}` : undefined,
    ]),
    bottomLeft: ['ICH mask'],
    bottomRight: [
      `WW/WL: ${windowWidth} / ${windowLevel}`,
    ],
  }
}

function compactMprOverlayLines(lines: Array<string | undefined | null | false>) {
  return lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
}

function compactMprLine(parts: Array<string | undefined | null>, separator: string) {
  return parts.map((part) => part?.trim()).filter(Boolean).join(separator)
}

function formatMprDate(value?: string) {
  if (!value) {
    return ''
  }
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(4, 6)}/${value.slice(6, 8)}/${value.slice(0, 4)}`
  }

  return value
}

function formatMprNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatIchVolumeBadgeText(volumeMl: number | null) {
  if (!Number.isFinite(volumeMl ?? Number.NaN)) {
    return 'Volume: 0.0 mL'
  }

  return `Volume: ${(volumeMl ?? 0).toFixed(1)} mL`
}

function getMprSliceCount(viewport: Types.IVolumeViewport) {
  const sliceCount = (viewport as Types.IVolumeViewport & { getNumberOfSlices?: () => number }).getNumberOfSlices?.()
  return Number.isFinite(sliceCount) ? Math.round(sliceCount as number) : 0
}

function normalizeSlabThickness(value: number) {
  if (!Number.isFinite(value)) {
    return 1
  }

  return Math.min(Math.max(value, 0.1), 100)
}

function getEffectiveSliceStep(thickness: number) {
  return Math.max(1, Math.round(normalizeSlabThickness(thickness)))
}

function getVisibleViewportKeys(layout: string) {
  const [rows = 1, columns = 1] = layout.split('x').map(Number)
  const visibleCount = rows * columns

  return Array.from({ length: visibleCount }, (_, index) => String(index))
}

function getMprPaneId(viewportId: string) {
  const sortedDefs = [...MPR_VIEWPORT_DEFS].sort((a, b) => b.id.length - a.id.length)
  return sortedDefs.find((item) => viewportId.endsWith(`-${item.id}`))?.id ?? null
}

function toolGroupContainsViewport(
  toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>,
  viewportId: string,
) {
  const group = toolGroup as unknown as { viewportsInfo?: Array<{ viewportId: string }> }
  return Boolean(group.viewportsInfo?.some((viewport) => viewport.viewportId === viewportId))
}

function getMprWindowLevel(viewport: Types.IVolumeViewport) {
  const properties = (viewport as Types.IVolumeViewport & {
    getProperties?: () => { voiRange?: { lower: number; upper: number } }
  }).getProperties?.()
  const voiRange = properties?.voiRange
  if (!voiRange || !Number.isFinite(voiRange.lower) || !Number.isFinite(voiRange.upper)) {
    return null
  }

  return {
    windowWidth: voiRange.upper - voiRange.lower,
    windowLevel: (voiRange.upper + voiRange.lower) / 2,
  }
}

function windowLevelToVoiRange(windowLevel: { windowWidth: number; windowLevel: number }) {
  const width = Math.max(1, windowLevel.windowWidth)
  return {
    lower: windowLevel.windowLevel - width / 2,
    upper: windowLevel.windowLevel + width / 2,
  }
}

function isUsableWindowLevel(windowLevel?: { windowWidth: number; windowLevel: number }): windowLevel is { windowWidth: number; windowLevel: number } {
  return Boolean(
    windowLevel
    && Number.isFinite(windowLevel.windowWidth)
    && windowLevel.windowWidth > 1
    && Number.isFinite(windowLevel.windowLevel),
  )
}

function voiRangeToWindowLevel(voiRange: { lower: number; upper: number }) {
  return {
    windowWidth: voiRange.upper - voiRange.lower,
    windowLevel: (voiRange.upper + voiRange.lower) / 2,
  }
}

function setMprSlabThickness(viewport: Types.IVolumeViewport, thickness: number) {
  const volumeViewport = viewport as Types.IVolumeViewport & {
    setProperties?: (properties: { slabThickness?: number }) => void
    setSlabThickness?: (slabThickness: number, filterActorUIDs?: string[]) => void
  }

  if (volumeViewport.setSlabThickness) {
    volumeViewport.setSlabThickness(thickness, [])
  } else {
    volumeViewport.setProperties?.({ slabThickness: thickness })
  }
}

function setMprVoiRange(viewport: Types.IVolumeViewport | undefined, voiRange: { lower: number; upper: number }) {
  const volumeViewport = viewport as (Types.IVolumeViewport & {
    setProperties?: (properties: { voiRange?: { lower: number; upper: number } }) => void
  }) | undefined

  volumeViewport?.setProperties?.({ voiRange })
}

function setMprBlendMode(viewport: Types.IVolumeViewport, mode: MprBlendMode) {
  const blendViewport = viewport as Types.IVolumeViewport & { setBlendMode?: (blendMode: Enums.BlendModes, filterActorUIDs?: string[], immediate?: boolean) => void }
  const blendMode = getCornerstoneBlendMode(mode)
  blendViewport.setBlendMode?.(blendMode, [], true)
}

function applyMprIch3dMaskActorTransfer(
  volumeActor: unknown,
  options: { opacity: number; windowWidth: number; windowLevel: number },
) {
  const actor = volumeActor as MprIch3dVolumeActor | undefined
  const property = actor?.getProperty?.()
  if (!property) {
    return
  }

  const opacity = Math.min(Math.max(options.opacity, 0.05), 0.95)
  const windowWidth = Math.min(Math.max(options.windowWidth, 5), 100) / 100
  const windowLevel = Math.min(Math.max(options.windowLevel, 0), 100) / 100
  const lower = Math.max(0.001, windowLevel - windowWidth / 2)
  const upper = Math.min(1, Math.max(lower + 0.001, windowLevel + windowWidth / 2))

  const ofun = vtkPiecewiseFunction.newInstance()
  ofun.addPoint(0, 0)
  ofun.addPoint(Math.max(0, lower - 0.02), 0)
  ofun.addPoint(lower, opacity * 0.18)
  ofun.addPoint(upper, opacity)
  ofun.addPoint(1, opacity)
  property.setScalarOpacity(0, ofun)
  property.setScalarOpacityUnitDistance?.(0, 0.65)

  const cfun = vtkColorTransferFunction.newInstance()
  cfun.addRGBPoint(0, 0, 0, 0)
  cfun.addRGBPoint(lower, 0.46, 0.02, 0.04)
  cfun.addRGBPoint(upper, 0.92, 0.05, 0.08)
  cfun.addRGBPoint(1, 1, 0.2, 0.22)
  property.setRGBTransferFunction(0, cfun)

  property.setShade?.(true)
  property.setAmbient?.(0.28)
  property.setDiffuse?.(0.74)
  property.setSpecular?.(0.18)
  property.setSpecularPower?.(12)
  property.setInterpolationTypeToLinear?.()
  actor?.getMapper?.()?.setSampleDistance?.(0.75)
}

function getCornerstoneBlendMode(mode: MprBlendMode): Enums.BlendModes {
  if (mode === 'mip') {
    return Enums.BlendModes.MAXIMUM_INTENSITY_BLEND
  }
  if (mode === 'minip') {
    return Enums.BlendModes.MINIMUM_INTENSITY_BLEND
  }
  if (mode === 'aip') {
    return Enums.BlendModes.AVERAGE_INTENSITY_BLEND
  }
  return Enums.BlendModes.COMPOSITE
}

function getMprBlendModeLabel(mode: MprBlendMode) {
  return getMprBlendModeOption(mode).code
}

function getMprBlendModeOption(mode: MprBlendMode) {
  return MPR_BLEND_MODE_OPTIONS.find((item) => item.id === mode) ?? MPR_BLEND_MODE_OPTIONS[0]
}

function getMprOrientationName(label: string) {
  return MPR_ORIENTATION_OPTIONS.find((option) => option.label === label)?.name ?? label
}

function Mpr3dCursorOverlay({ point }: { point?: Types.Point2 | null }) {
  if (!point) {
    return null
  }

  return (
    <svg className="mpr-3d-cursor-overlay" aria-hidden="true">
      <line className="mpr-3d-cursor-line" x1={point[0] - 9} y1={point[1]} x2={point[0] + 9} y2={point[1]} />
      <line className="mpr-3d-cursor-line" x1={point[0]} y1={point[1] - 9} x2={point[0]} y2={point[1] + 9} />
      <circle className="mpr-3d-cursor-dot" cx={point[0]} cy={point[1]} r="3.25" />
    </svg>
  )
}

function MprReferenceLineOverlay({
  enabled,
  engineId,
  sourceViewportId,
  targetViewportId,
}: {
  enabled: boolean
  engineId: string
  sourceViewportId: string
  targetViewportId: string
}) {
  if (!enabled || sourceViewportId === targetViewportId) {
    return null
  }

  const engine = getRenderingEngine(engineId)
  const source = engine?.getViewport(sourceViewportId) as Types.IVolumeViewport | undefined
  const target = engine?.getViewport(targetViewportId) as Types.IVolumeViewport | undefined
  if (!source || !target) {
    return null
  }

  const sourceCamera = source.getCamera()
  const targetCamera = target.getCamera()
  const sourceNormal = vec3.normalize(vec3.create(), sourceCamera.viewPlaneNormal)
  const targetNormal = vec3.normalize(vec3.create(), targetCamera.viewPlaneNormal)
  const direction = vec3.cross(vec3.create(), sourceNormal, targetNormal)
  const denominator = vec3.squaredLength(direction)
  if (denominator < 1e-8) {
    return null
  }

  const sourceDistance = vec3.dot(sourceNormal, sourceCamera.focalPoint)
  const targetDistance = vec3.dot(targetNormal, targetCamera.focalPoint)
  const sourceTerm = vec3.scale(vec3.create(), vec3.cross(vec3.create(), targetNormal, direction), sourceDistance)
  const targetTerm = vec3.scale(vec3.create(), vec3.cross(vec3.create(), direction, sourceNormal), targetDistance)
  const linePoint = vec3.scale(vec3.create(), vec3.add(vec3.create(), sourceTerm, targetTerm), 1 / denominator)
  const lineDirection = vec3.normalize(vec3.create(), direction)
  const lineStart = vec3.scaleAndAdd(vec3.create(), linePoint, lineDirection, -10_000)
  const lineEnd = vec3.scaleAndAdd(vec3.create(), linePoint, lineDirection, 10_000)
  const start = target.worldToCanvas(point3FromVec3(lineStart))
  const end = target.worldToCanvas(point3FromVec3(lineEnd))
  if (![...start, ...end].every(Number.isFinite)) {
    return null
  }

  return (
    <svg className="mpr-reference-line-overlay" aria-hidden="true">
      <line x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} />
    </svg>
  )
}

function getWindowPreset(type: string) {
  if (type === 'preset-lung') {
    return { lower: -1350, upper: 150 }
  }
  if (type === 'preset-bone') {
    return { lower: -500, upper: 1500 }
  }
  if (type === 'preset-brain') {
    return { lower: 0, upper: 80 }
  }
  if (type === 'preset-mediastinum') {
    return { lower: -125, upper: 225 }
  }
  if (type === 'preset-soft') {
    return { lower: -160, upper: 240 }
  }

  return null
}

function point3FromVec3(value: vec3): Types.Point3 {
  return [value[0], value[1], value[2]]
}

function cloneMprPoint3(point?: Types.Point3): Types.Point3 | undefined {
  return point ? [point[0], point[1], point[2]] : undefined
}

function cloneMprCamera(camera: Types.ICamera): Types.ICamera {
  return {
    ...camera,
    focalPoint: cloneMprPoint3(camera.focalPoint) ?? camera.focalPoint,
    position: cloneMprPoint3(camera.position) ?? camera.position,
    viewPlaneNormal: cloneMprPoint3(camera.viewPlaneNormal) ?? camera.viewPlaneNormal,
    viewUp: cloneMprPoint3(camera.viewUp) ?? camera.viewUp,
  }
}

function addPoint3(point: Types.Point3, delta: Types.Point3): Types.Point3 {
  return [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]]
}

function formatThicknessLabel(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} mm`
}

function formatThicknessInput(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function getMprOrientationOptionIndex(orientation: keyof typeof Enums.OrientationAxis) {
  return Math.max(0, MPR_ORIENTATION_OPTIONS.findIndex((option) => option.orientation === orientation))
}
