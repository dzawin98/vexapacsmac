import { Enums, eventTarget, getEnabledElement, metaData, utilities as csUtilities, type Types } from '@cornerstonejs/core'
import { createPortal } from 'react-dom'
import {
  AngleTool,
  ArrowAnnotateTool,
  BidirectionalTool,
  BrushTool,
  CircleROITool,
  CobbAngleTool,
  EllipticalROITool,
  EraserTool,
  Enums as ToolEnums,
  LengthTool,
  MagnifyTool,
  PanTool,
  PlanarFreehandROITool,
  ProbeTool,
  RectangleROITool,
  ReferenceLinesTool,
  StackScrollTool,
  ToolGroupManager,
  WindowLevelTool,
  ZoomTool,
  annotation,
} from '@cornerstonejs/tools'
import { stackPrefetch } from '@cornerstonejs/tools/utilities'
import {
  Blend,
  Blinds,
  Box,
  Camera,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Circle,
  Compass,
  Contrast,
  Crosshair,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  HeartPulse,
  Lasso,
  Maximize2,
  Move,
  MoveUpLeft,
  Pause,
  PencilRuler,
  Play,
  RectangleHorizontal,
  Rotate3d,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Ruler,
  Save,
  ScanLine,
  ScanSearch,
  Search,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Target,
  TextSearch,
  Type,
  Magnet,
  PenTool,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DicomJsonDataset, InstanceSummary, SeriesSummary, StudySummary } from '../../dicomweb/types'
import { fetchRenderedPreviewDataUrl, getInstanceFrameForImageIndex, listInstances, listSeries, warmRenderedStackCache } from '../../dicomweb/client'
import { useAuthStore } from '../../auth/authStore'
import { getMenuItemPermission, type PermissionId } from '../../auth/permissions'
import { clearAllAnnotations, deleteSelectedAnnotations } from '../annotationActions'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { acquireStackRenderingEngine, releaseStackRenderingEngine, STACK_RENDERING_ENGINE_ID } from '../cornerstone/stackRenderingEngine'
import { watchRenderingEngineContexts } from '../cornerstone/webglContextWatch'
import { getStackInitialImageIndex, prewarmStackNeighbors, primeStackImagesForDisplay } from '../cornerstone/progressiveLoading'
import { discardPreparedMprSeriesVolume, getDiagnosticVolumeOwnerId, prepareMprSeriesVolume } from '../cornerstone/volumeCache'
import { useViewerStore } from '../viewerStore'
import { deleteSavedGspsOverlays, isSavedGspsSuppressed, loadSavedGspsOverlays, saveGspsPresentationState, type GraphicSaveObject, type SavedGspsAnnotation, type SavedGspsOverlay } from '../dicomSave'
import {
  ICH_DEFAULT_BRUSH_SIZE,
  ICH_DEFAULT_OPACITY,
  ICH_DEFAULT_THRESHOLD_MAX,
  ICH_DEFAULT_THRESHOLD_MIN,
  applyIchAdaptiveRegionGrowToStack,
  applyIchSmartDragToStackSlice,
  applyIchThresholdToStack,
  applyIchRegionGrowToStackSlice,
  applyIchLassoToStackSlice,
  captureIchStackSnapshot,
  clearIchSegment,
  ensureIchStackSegmentation,
  getIchStackSegmentStats,
  mergeIchAdaptiveHuModels,
  previewIchLassoPath,
  restoreIchStackSnapshot,
  setIchBrushSize,
  setIchBrushThreshold,
  setIchSegmentationOpacity,
  type IchAdaptiveStackGrowResult,
  type IchAdaptiveHuModel,
  type IchForbiddenRegion,
  type IchLassoOperation,
  type IchRegionGrowResult,
  type IchSmartDragResult,
  type IchStackSegmentStats,
  type IchStackSnapshot,
  type IchThresholdResult,
} from '../cornerstone/ichSegmentation'

type DicomViewportProps = {
  viewportKey?: string
  imageIds: string[]
  study?: StudySummary | null
  series?: SeriesSummary | null
  instances?: InstanceSummary[]
  modality?: string
  isSelected?: boolean
  referenceLinesEnabled?: boolean
  contextMenuEnabled?: boolean
  onToggleOverlay?: () => void
  onOpenTagBrowser?: () => void
  onOpenIchMprWorkspace?: () => void
  onToggleMpr?: () => void
  onToggle3d?: () => void
  onToggle3dBone?: () => void
  onOpenAmbientTest?: () => void
  onSelect?: () => void
  onToggleViewportFullscreen?: () => void
  onReady?: (viewportKey: string, seriesInstanceUid: string) => void
  disableBackgroundVolumePrepare?: boolean
  diagnosticOnly?: boolean
}

type IntelliLinkOption = 'scroll' | 'windowLevel' | 'pan' | 'zoom'

type LinkedCamera = {
  focalPoint?: number[]
  position?: number[]
  viewUp?: number[]
  parallelScale?: number
}

type LinkedCommandOptions = {
  sliceIndex?: number
  zoom?: number
  camera?: LinkedCamera
  windowLevel?: { windowWidth: number; windowLevel: number }
  sourceInstance?: InstanceSummary
}

type ViewportOrientationLabels = {
  top: string
  right: string
  bottom: string
  left: string
}

type ViewportScaleBar = {
  width: number
  label: string
}

type ViewportDisplayDecorations = {
  orientation: ViewportOrientationLabels
  scaleBar: ViewportScaleBar | null
}

type DiagnosticImageState = 'raw-ready' | 'raw-loading' | 'jpeg-preview'

type PreviewDraftToolId =
  | 'Length'
  | 'CircleROI'
  | 'RectangleROI'
  | 'EllipticalROI'
  | 'ArrowMarker'
  | 'CircleMarker'

type PreviewToolDraft = {
  tool: PreviewDraftToolId
  targetIndex: number
  pointerId: number
  startCanvasPoint: Types.Point2
  endCanvasPoint: Types.Point2
  viewportSize: { width: number; height: number }
}

type LiveProbeValue = {
  canvasPoint: Types.Point2
  value: number
  unit: string
  note: string
}

type CTRPointKey = 'A' | 'B' | 'C' | 'D'

type CTRAnnotation = {
  id: string
  points: Partial<Record<CTRPointKey, Types.Point3>>
  complete: boolean
  textWorldPosition?: Types.Point3
}

type CTRCanvasAnnotation = CTRAnnotation & {
  canvasPoints: Partial<Record<CTRPointKey, Types.Point2>>
  viewportSize: { width: number; height: number }
  result: CTRResult | null
  textCanvasPosition?: Types.Point2
  textBox?: { left: number; top: number; width: number; height: number }
}

type CTRResult = {
  ratio: number
  cardiacWidthMm: number
  thoraxWidthMm: number
}

type TextMarkerAnnotation = {
  id: string
  text: string
  worldPosition: Types.Point3
}

type TextMarkerDraft = {
  worldPosition: Types.Point3
  canvasPosition: Types.Point2
}

type ShapeMarkerAnnotation = {
  id: string
  type: 'arrow' | 'circle'
  startWorldPosition: Types.Point3
  endWorldPosition: Types.Point3
}

type ShapeMarkerDraft = {
  type: 'arrow' | 'circle'
  startWorldPosition: Types.Point3
  endWorldPosition: Types.Point3
}

type CustomMarkerHit =
  | { type: 'text'; id: string }
  | { type: 'shape'; id: string; edit: 'move' | 'start' | 'end' }

type CustomMarkerDrag = {
  marker: CustomMarkerHit
  pointerId: number
  lastWorldPosition: Types.Point3
}

type GspsOverlayGraphic =
  | { id: string; type: 'polyline'; points: Types.Point2[] }
  | { id: string; type: 'circle'; center: Types.Point2; edge: Types.Point2 }
  | { id: string; type: 'text'; point: Types.Point2; text: string }

type GspsOverlay = {
  id: string
  sourceSize: { width: number; height: number }
  graphics: GspsOverlayGraphic[]
}

type Stack3dCursorCanvas = {
  point: Types.Point2
  color: string
  inBounds: boolean
} | null

type ImagePlaneInfo = {
  origin: Types.Point3
  normal: Types.Point3
  frameOfReferenceUID?: string
}

type SavedAnnotationData = Record<string, unknown> & {
  handles?: {
    points?: Types.Point3[]
    textBox?: { worldPosition?: Types.Point3 }
  }
  contour?: { polyline?: Types.Point3[] }
}

type SavedAnnotationMetadata = Record<string, unknown> & {
  FrameOfReferenceUID?: string
  frameOfReferenceUID?: string
  referencedImageId?: string
  viewPlaneNormal?: Types.Point3
  viewplaneNormal?: Types.Point3
  viewUp?: Types.Point3
  toolName?: string
}

type AnnotationReferenceViewport = Types.IStackViewport & {
  getCurrentImageId?: () => string | undefined
  getCurrentImageIdIndex?: () => number
  getImageIds?: () => string[]
  getFrameOfReferenceUID?: () => string
  getCamera?: () => {
    viewPlaneNormal?: Types.Point3
    viewUp?: Types.Point3
  }
}

type ModifierGesture =
  | { type: 'zoom'; pointerId: number; startY: number; startZoom: number }
  | { type: 'pan'; pointerId: number; lastCanvasPoint: Types.Point2 }

export type ViewportMenuAction =
  | { type: 'tool'; tool: string }
  | { type: 'command'; command: string }
  | { type: 'reference-lines' }
  | { type: 'custom'; id: 'toggle-overlay' | 'tag-browser' | 'toggle-mpr' | 'toggle-3d' | 'toggle-3d-bone' | 'ambient-test' }
  | { type: 'close' }

export type ViewportMenuItem = {
  id: string
  label: string
  icon: LucideIcon
  hotkey?: string
  action: ViewportMenuAction
}

export type ViewportMenuSection = {
  title: string
  icon: LucideIcon
  items: ViewportMenuItem[]
}

const ctrPointOrder: CTRPointKey[] = ['A', 'B', 'C', 'D']
const ctrPointLabels: Record<CTRPointKey, string> = {
  A: 'left chest border',
  B: 'right chest border',
  C: 'left heart border',
  D: 'right heart border',
}

const interactionToolNames = [
  WindowLevelTool.toolName,
  PanTool.toolName,
  ZoomTool.toolName,
  MagnifyTool.toolName,
  LengthTool.toolName,
  ArrowAnnotateTool.toolName,
  CircleROITool.toolName,
  AngleTool.toolName,
  CobbAngleTool.toolName,
  BidirectionalTool.toolName,
  RectangleROITool.toolName,
  EllipticalROITool.toolName,
  PlanarFreehandROITool.toolName,
  BrushTool.toolName,
  EraserTool.toolName,
  ProbeTool.toolName,
]

const manipulationToolNames = [WindowLevelTool.toolName, PanTool.toolName, ZoomTool.toolName, MagnifyTool.toolName]
const annotationToolNames = [
  LengthTool.toolName,
  ArrowAnnotateTool.toolName,
  CircleROITool.toolName,
  AngleTool.toolName,
  CobbAngleTool.toolName,
  BidirectionalTool.toolName,
  RectangleROITool.toolName,
  EllipticalROITool.toolName,
  PlanarFreehandROITool.toolName,
  BrushTool.toolName,
  EraserTool.toolName,
  ProbeTool.toolName,
]
const movableRoiToolNames = [
  CircleROITool.toolName,
  RectangleROITool.toolName,
  EllipticalROITool.toolName,
  PlanarFreehandROITool.toolName,
] as const

const toolNameById: Record<string, string> = {
  WindowLevel: WindowLevelTool.toolName,
  Pan: PanTool.toolName,
  Zoom: ZoomTool.toolName,
  Magnify: MagnifyTool.toolName,
  Length: LengthTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  CircleROI: CircleROITool.toolName,
  RectangleROI: RectangleROITool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
  ICHSegment: BrushTool.toolName,
  ICHEraser: EraserTool.toolName,
  Probe: ProbeTool.toolName,
}

const customTransientToolIds = new Set(['TextMarker', 'ArrowMarker', 'CircleMarker', 'CTR4Point'])

export const viewportMenuSections: ViewportMenuSection[] = [
  {
    title: 'Image Navigation',
    icon: Move,
    items: [
      { id: 'pan', label: 'Pan', icon: Move, hotkey: 'T', action: { type: 'tool', tool: 'Pan' } },
      { id: 'scroll', label: 'Series Scroll', icon: Blinds, hotkey: 'S', action: { type: 'tool', tool: 'Scroll' } },
      { id: 'cine', label: 'Cine', icon: Play, hotkey: 'Space', action: { type: 'command', command: 'toggle-cine' } },
      { id: 'zoom', label: 'Zoom', icon: ZoomIn, hotkey: 'Z', action: { type: 'tool', tool: 'Zoom' } },
      { id: 'magnify', label: 'Magnify', icon: Search, hotkey: 'A', action: { type: 'tool', tool: 'Magnify' } },
      { id: 'zoom-in', label: 'Zoom In', icon: ZoomIn, hotkey: '+', action: { type: 'command', command: 'zoom-in' } },
      { id: 'zoom-out', label: 'Zoom Out', icon: ZoomOut, hotkey: '-', action: { type: 'command', command: 'zoom-out' } },
      { id: 'zoom-fit', label: 'Zoom to Fit', icon: Maximize2, hotkey: 'Shift+F', action: { type: 'command', command: 'spatial-zoom-fit' } },
      { id: 'zoom-1x', label: 'Zoom 1:1', icon: Search, hotkey: 'X', action: { type: 'command', command: 'spatial-zoom-1x' } },
    ],
  },
  {
    title: 'Image Display',
    icon: Eye,
    items: [
      { id: 'window-level', label: 'Window/Level', icon: Contrast, hotkey: 'W', action: { type: 'tool', tool: 'WindowLevel' } },
      { id: 'invert', label: 'Invert LUT', icon: Circle, hotkey: 'I', action: { type: 'command', command: 'invert' } },
      { id: 'overlay', label: 'Image Overlay', icon: Eye, hotkey: 'V', action: { type: 'custom', id: 'toggle-overlay' } },
    ],
  },
  {
    title: 'Window Presets',
    icon: Blend,
    items: [
      { id: 'lung', label: 'Lung', icon: Blend, hotkey: '1', action: { type: 'command', command: 'preset-lung' } },
      { id: 'bone', label: 'Bone', icon: Blend, hotkey: '2', action: { type: 'command', command: 'preset-bone' } },
      { id: 'brain', label: 'Brain', icon: Blend, hotkey: '3', action: { type: 'command', command: 'preset-brain' } },
      { id: 'mediastinum', label: 'Mediastinum', icon: Blend, hotkey: '4', action: { type: 'command', command: 'preset-mediastinum' } },
      { id: 'soft', label: 'Soft Tissue', icon: Blend, hotkey: '5', action: { type: 'command', command: 'preset-soft' } },
    ],
  },
  {
    title: 'Measurements',
    icon: Ruler,
    items: [
      { id: 'length', label: 'Length', icon: Ruler, hotkey: 'M', action: { type: 'tool', tool: 'Length' } },
      { id: 'probe', label: 'Probe', icon: Target, hotkey: 'P', action: { type: 'tool', tool: 'Probe' } },
      { id: 'angle', label: 'Angle', icon: Compass, hotkey: 'E', action: { type: 'tool', tool: 'Angle' } },
      { id: 'cobb', label: 'Cobb Angle', icon: Maximize2, hotkey: 'C', action: { type: 'tool', tool: 'CobbAngle' } },
      { id: 'ctr', label: 'CTR 4 Point', icon: HeartPulse, hotkey: 'K', action: { type: 'tool', tool: 'CTR4Point' } },
      { id: 'bidirectional', label: 'Bidirectional', icon: PencilRuler, hotkey: 'B', action: { type: 'tool', tool: 'Bidirectional' } },
      { id: 'circle-roi', label: 'Circle ROI', icon: Circle, hotkey: 'Shift+O', action: { type: 'tool', tool: 'CircleROI' } },
      { id: 'rectangle', label: 'Rectangle ROI', icon: RectangleHorizontal, hotkey: 'U', action: { type: 'tool', tool: 'RectangleROI' } },
      { id: 'ellipse', label: 'Ellipse ROI', icon: Circle, hotkey: 'O', action: { type: 'tool', tool: 'EllipticalROI' } },
      { id: 'freehand', label: 'Freehand ROI', icon: Lasso, hotkey: 'F', action: { type: 'tool', tool: 'PlanarFreehandROI' } },
      { id: 'ich-segment', label: 'ICH Segment', icon: ScanSearch, action: { type: 'tool', tool: 'ICHSegment' } },
    ],
  },
  {
    title: 'Annotations',
    icon: PencilRuler,
    items: [
      { id: 'text', label: 'Text Marker', icon: Type, hotkey: 'G', action: { type: 'tool', tool: 'TextMarker' } },
      { id: 'arrow', label: 'Arrow Marker', icon: MoveUpLeft, hotkey: 'Y', action: { type: 'tool', tool: 'ArrowMarker' } },
      { id: 'circle-marker', label: 'Circle Marker', icon: Circle, hotkey: 'J', action: { type: 'tool', tool: 'CircleMarker' } },
    ],
  },
  {
    title: 'Save',
    icon: Save,
    items: [
      { id: 'save-gsps', label: 'Save GSPS', icon: Save, hotkey: 'Ctrl+G', action: { type: 'command', command: 'save-gsps' } },
      { id: 'save-secondary-capture', label: 'Capture Viewport', icon: Camera, hotkey: 'Ctrl+Shift+S', action: { type: 'command', command: 'save-secondary-capture' } },
    ],
  },
  {
    title: 'Orientation',
    icon: RotateCw,
    items: [
      { id: 'rotate-cw', label: 'Rotate Clockwise', icon: RotateCw, hotkey: 'R', action: { type: 'command', command: 'spatial-rotate-cw' } },
      { id: 'rotate-ccw', label: 'Rotate Counter-clockwise', icon: RotateCcw, hotkey: 'Shift+R', action: { type: 'command', command: 'spatial-rotate-ccw' } },
      { id: 'rotate-180', label: 'Rotate 180', icon: RefreshCw, hotkey: 'Shift+0', action: { type: 'command', command: 'spatial-rotate-180' } },
      { id: 'flip-h', label: 'Flip Horizontal', icon: FlipHorizontal2, hotkey: 'Shift+H', action: { type: 'command', command: 'spatial-flip-horizontal' } },
      { id: 'flip-v', label: 'Flip Vertical', icon: FlipVertical2, hotkey: 'Shift+V', action: { type: 'command', command: 'spatial-flip-vertical' } },
    ],
  },
  {
    title: 'MPR/Reformat',
    icon: Rotate3d,
    items: [
      { id: 'mpr', label: 'MPR', icon: Box, hotkey: 'Alt+M', action: { type: 'custom', id: 'toggle-mpr' } },
      { id: 'oblique-3d', label: '3D Oblique', icon: Rotate3d, hotkey: 'Alt+3', action: { type: 'custom', id: 'toggle-3d' } },
      { id: 'bone-3d', label: '3D Bone', icon: Box, hotkey: 'Alt+B', action: { type: 'custom', id: 'toggle-3d-bone' } },
      { id: '3d-cursor', label: '3D Cursor', icon: Target, hotkey: 'D', action: { type: 'tool', tool: 'Stack3DCursor' } },
      { id: 'crosshair', label: 'Crosshair', icon: Crosshair, hotkey: 'H', action: { type: 'tool', tool: 'Crosshairs' } },
      { id: 'reference-lines', label: 'Reference Line', icon: ScanLine, hotkey: 'L', action: { type: 'reference-lines' } },
    ],
  },
  {
    title: 'DICOM Info',
    icon: TextSearch,
    items: [
      { id: 'tag-browser', label: 'DICOM Tag Browser', icon: TextSearch, hotkey: 'Q', action: { type: 'custom', id: 'tag-browser' } },
    ],
  },
]

export function getMenuItemHotkey(item: ViewportMenuItem, overrides: Record<string, string>) {
  return overrides[item.id] ?? item.hotkey ?? ''
}

const ctOnlyMenuSections = new Set(['Window Presets', 'MPR/Reformat'])

export function isMenuSectionAvailableForModality(sectionTitle: string, modality: string) {
  return !ctOnlyMenuSections.has(sectionTitle) || modality.toUpperCase() === 'CT'
}

export function isMenuItemAvailableForModality(itemId: string, modality: string) {
  const section = viewportMenuSections.find((menuSection) => menuSection.items.some((item) => item.id === itemId))
  return section ? isMenuSectionAvailableForModality(section.title, modality) : true
}

export function getPermittedMenuSections(hasPermission: (permission: PermissionId) => boolean, modality = '') {
  return viewportMenuSections
    .filter((section) => isMenuSectionAvailableForModality(section.title, modality))
    .map((section) => ({ ...section, items: section.items.filter((item) => hasPermission(getMenuItemPermission(item.id))) }))
    .filter((section) => section.items.length > 0)
}

export function createHotkeyActions(overrides: Record<string, string>, hasPermission: (permission: PermissionId) => boolean = () => true, modality = '') {
  return new Map(
    getPermittedMenuSections(hasPermission, modality).flatMap((section) => section.items.flatMap((item) => {
      const hotkey = getMenuItemHotkey(item, overrides)
      return hotkey && item.action.type !== 'close' ? [[hotkey.toLowerCase(), item.action] as const] : []
    })),
  )
}

const persistentTools = new Set([
  'WindowLevel',
  'Pan',
  'Zoom',
  'Scroll',
  'Magnify',
  'Stack3DCursor',
])

const renderedPreviewMaxEdge = 768
const renderedPreviewQuality = 48
const stackRawPrewarmRadius = 1
const stackRenderedWarmRadius = 3
const stackInitialRenderedWarmRadius = 4
const stackRenderedWarmMaxFrames = 8
const stackRenderedPreviewDelayMs = 110
const stackSliceCommitDebounceMs = 55
const stackAnimatedScrubFrameMs = 16
const stackAnimatedScrubMaxSteps = 24
const cineDoubleSpaceStopMs = 320
const mprBackgroundPrepareDelayMs = Math.min(
  1_000,
  Math.max(0, Number(import.meta.env.VITE_MPR_BACKGROUND_PREPARE_DELAY_MS ?? 150) || 150),
)
const previewDraftToolIds = new Set<PreviewDraftToolId>([
  'Length',
  'CircleROI',
  'RectangleROI',
  'EllipticalROI',
  'ArrowMarker',
  'CircleMarker',
])

function dispatchDiagnosticViewportTelemetry(event: string, detail: Record<string, unknown>) {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent(event, { detail }))
}

export function DicomViewport({
  viewportKey = 'primary',
  imageIds,
  study = null,
  series = null,
  instances = [],
  modality = '',
  isSelected = false,
  referenceLinesEnabled = true,
  contextMenuEnabled = true,
  onToggleOverlay,
  onOpenTagBrowser,
  onOpenIchMprWorkspace,
  onToggleMpr,
  onToggle3d,
  onToggle3dBone,
  onOpenAmbientTest,
  onSelect,
  onToggleViewportFullscreen,
  onReady,
  disableBackgroundVolumePrepare = false,
  diagnosticOnly = false,
}: DicomViewportProps) {
  const elementRef = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const renderingEngineRef = useRef<ReturnType<typeof acquireStackRenderingEngine> | null>(null)
  const stackReadyRef = useRef(false)
  const modifierGestureRef = useRef<ModifierGesture | null>(null)
  const scrollGestureRef = useRef<{ pointerId: number; y: number; sliceIndex: number } | null>(null)
  const wheelDeltaRef = useRef(0)
  const applyingLinkedCommandRef = useRef(false)
  const cineBusyRef = useRef(false)
  const scheduledSliceIndexRef = useRef<number | null>(null)
  const targetSliceIndexRef = useRef<number | null>(null)
  const animatedSliceScrubRef = useRef(false)
  const sliceCommitFrameRef = useRef<number | null>(null)
  const sliceCommitTimerRef = useRef<number | null>(null)
  const activeStackImageIdsRef = useRef(imageIds)
  const instancesRef = useRef(instances)
  const previewRequestRef = useRef<AbortController | null>(null)
  const previewGenerationRef = useRef(0)
  const previewDelayTimerRef = useRef<number | null>(null)
  const previewRequestedAtRef = useRef<number | null>(null)
  const previewTargetIndexRef = useRef<number | null>(null)
  const diagnosticRenderTargetIndexRef = useRef<number | null>(null)
  const diagnosticImageStateRef = useRef<DiagnosticImageState>('raw-loading')
  const rawTargetStartedAtRef = useRef<number | null>(null)
  const previewToolDraftRef = useRef<PreviewToolDraft | null>(null)
  const deferredPreviewProbeRef = useRef<{ targetIndex: number; canvasPoint: Types.Point2 } | null>(null)
  const readLiveProbeAtCanvasRef = useRef<((canvasPoint: Types.Point2) => LiveProbeValue | null) | null>(null)
  const renderedWarmTimerRef = useRef<number | null>(null)
  const renderedWarmQueuedRef = useRef<{ targetIndex: number; radius: number } | null>(null)
  const renderedWarmLastRequestRef = useRef<{ key: string; at: number } | null>(null)
  const backgroundVolumeWarmTimerRef = useRef<number | null>(null)
  const backgroundVolumeWarmSeriesRef = useRef<{ series: SeriesSummary; ownerId: string } | null>(null)
  const processedViewportCommandIdRef = useRef<number | null>(null)
  const processedSaveCommandIdRef = useRef<number | null>(null)
  const suppressViewportPointerUntilRef = useRef(0)
  const ctrIdRef = useRef(0)
  const ctrAnnotationsRef = useRef<CTRAnnotation[]>([])
  const selectedCtrAnnotationIdRef = useRef<string | null>(null)
  const selectedCustomMarkerRef = useRef<CustomMarkerHit | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [diagnosticImageState, setDiagnosticImageState] = useState<DiagnosticImageState>('raw-loading')
  const [previewToolDraft, setPreviewToolDraft] = useState<PreviewToolDraft | null>(null)
  const [previewToolStatus, setPreviewToolStatus] = useState('')
  const [stackReadyTick, setStackReadyTick] = useState(0)
  const ctrTextDragRef = useRef<{ annotationId: string; pointerId: number } | null>(null)
  const customMarkerDragRef = useRef<CustomMarkerDrag | null>(null)
  const stack3dCursorDragRef = useRef<{ pointerId: number } | null>(null)
  const stack3dCursor = useViewerStore((state) => state.stack3dCursor)
  const hotkeyOverrides = useViewerStore((state) => state.hotkeyOverrides)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const permittedMenuSections = getPermittedMenuSections(hasPermission, modality)
  const stack3dCursorRef = useRef(stack3dCursor)
  const [, setCtrAnnotations] = useState<CTRAnnotation[]>([])
  const [ctrCanvasAnnotations, setCtrCanvasAnnotations] = useState<CTRCanvasAnnotation[]>([])
  const [stack3dCursorCanvas, setStack3dCursorCanvas] = useState<Stack3dCursorCanvas>(null)
  const [, setSelectedCtrAnnotationId] = useState<string | null>(null)
  const textMarkerIdRef = useRef(0)
  const textMarkersRef = useRef<TextMarkerAnnotation[]>([])
  const shapeMarkerIdRef = useRef(0)
  const shapeMarkersRef = useRef<ShapeMarkerAnnotation[]>([])
  const [textMarkers, setTextMarkers] = useState<Array<TextMarkerAnnotation & { canvasPosition: Types.Point2 }>>([])
  const [textMarkerDraft, setTextMarkerDraft] = useState<TextMarkerDraft | null>(null)
  const [shapeMarkers, setShapeMarkers] = useState<Array<ShapeMarkerAnnotation & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }>>([])
  const [shapeMarkerDraft, setShapeMarkerDraft] = useState<(ShapeMarkerDraft & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }) | null>(null)
  type IchSeedPoint = { canvasPoint: Types.Point2; imagePoint: Types.Point2; hu: number; sliceIndex: number; kind: 'center' | 'edge' }
  /** Titik lasso: x = kolom, y = baris pada bidang slice, canvas = posisi di layar. */
  type IchLassoUiPoint = { x: number; y: number; canvas: Types.Point2; sliceIndex: number }
  type IchSmartDragGesture = {
    pointerId: number
    segmentationId: string
    mode: 'add' | 'erase'
    seed: IchSeedPoint
    current: IchSeedPoint
  }
  type IchSmartDragPreview = {
    canvasPoint: Types.Point2
    radius: number
    mode: 'add' | 'erase'
  } | null
  const [liveProbeValue, setLiveProbeValue] = useState<LiveProbeValue | null>(null)
  const liveProbePointerIdRef = useRef<number | null>(null)
  const [ichSegmentationId, setIchSegmentationId] = useState<string | null>(null)
  const [ichBrushSize, setIchBrushSizeState] = useState(ICH_DEFAULT_BRUSH_SIZE)
  const [ichOpacity, setIchOpacity] = useState(ICH_DEFAULT_OPACITY)
  const [ichThresholdMin, setIchThresholdMin] = useState(ICH_DEFAULT_THRESHOLD_MIN)
  const [ichThresholdMax, setIchThresholdMax] = useState(ICH_DEFAULT_THRESHOLD_MAX)
  const [ichThresholdStatus, setIchThresholdStatus] = useState('')
  const [ichThresholdApplying, setIchThresholdApplying] = useState(false)
  const [ichSeedMode, setIchSeedMode] = useState(false)
  const [ichSeedPoints, setIchSeedPoints] = useState<IchSeedPoint[]>([])
  const [ichSmartDragEnabled, setIchSmartDragEnabled] = useState(true)
  // Lasso magnetik: 'off' | 'polygon' (klik titik, garis menempel tepi) | 'drag' (seret garis tepi)
  const [ichLassoMode, setIchLassoMode] = useState<'off' | 'polygon' | 'drag'>('off')
  const [ichLassoOperation, setIchLassoOperation] = useState<IchLassoOperation>('add')
  const [ichLassoMagnetism, setIchLassoMagnetism] = useState(6)
  const [ichLassoPoints, setIchLassoPoints] = useState<IchLassoUiPoint[]>([])
  const [ichLassoPreview, setIchLassoPreview] = useState<Types.Point2[] | null>(null)
  const [ichLassoStatus, setIchLassoStatus] = useState('')
  const [ichLassoBusy, setIchLassoBusy] = useState(false)
  const ichLassoDragRef = useRef<{ pointerId: number; points: IchLassoUiPoint[] } | null>(null)
  const ichLassoPreviewRunRef = useRef(0)
  const ichLassoPreviewBusyRef = useRef(false)
  const [ichSmartDragPreview, setIchSmartDragPreview] = useState<IchSmartDragPreview>(null)
  const [ichHistoryState, setIchHistoryState] = useState({ canUndo: false, canRedo: false })
  const ichOpacityTimerRef = useRef<number | null>(null)
  const ichThresholdRunRef = useRef(0)
  const ichSmartDragRef = useRef<IchSmartDragGesture | null>(null)
  const ichAdaptiveModelRef = useRef<IchAdaptiveHuModel | null>(null)
  const ichEraseConstraintsRef = useRef<IchForbiddenRegion[]>([])
  const ichUndoSnapshotRef = useRef<IchStackSnapshot | null>(null)
  const ichRedoSnapshotRef = useRef<IchStackSnapshot | null>(null)
  const fastSliceSliderDragRef = useRef<number | null>(null)
  const [gspsOverlays, setGspsOverlays] = useState<GspsOverlay[]>([])
  const restoredGspsAnnotationKeysRef = useRef<Set<string>>(new Set())
  const firstRenderedSeriesRef = useRef('')
  const [selectedCustomMarker, setSelectedCustomMarker] = useState<CustomMarkerHit | null>(null)
  const renderingEngineId = STACK_RENDERING_ENGINE_ID
  const viewportId = `nexia-stack-viewport-${viewportKey}`
  const toolGroupId = `nexia-stack-tools-${viewportKey}`
  const activeTool = useViewerStore((state) => state.activeTool)
  const viewportCommand = useViewerStore((state) => state.viewportCommands[viewportKey] ?? state.viewportCommand)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const viewportSliceIndex = useViewerStore((state) => state.viewportSliceIndexes[viewportKey] ?? 0)
  const cinePlaying = useViewerStore((state) => state.viewportCinePlaying[viewportKey] ?? false)
  const [cineFps, setCineFps] = useState(30)
  const [cineDirection, setCineDirection] = useState<1 | -1>(1)
  const [cineControlsVisible, setCineControlsVisible] = useState(false)
  const lastCineSpaceToggleAtRef = useRef(0)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const viewportLayout = useViewerStore((state) => state.viewportLayout)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const setReferenceLinesEnabled = useViewerStore((state) => state.setReferenceLinesEnabled)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const setViewportSliceIndex = useViewerStore((state) => state.setViewportSliceIndex)
  const setViewportCinePlaying = useViewerStore((state) => state.setViewportCinePlaying)
  const setViewportZoom = useViewerStore((state) => state.setViewportZoom)
  const setViewportWindowLevel = useViewerStore((state) => state.setViewportWindowLevel)
  const setStack3dCursor = useViewerStore((state) => state.setStack3dCursor)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [activeContextSection, setActiveContextSection] = useState(permittedMenuSections[0]?.title ?? '')
  const [sliceSliderHost, setSliceSliderHost] = useState<HTMLElement | null>(null)
  const [isSliceSliderExpanded, setIsSliceSliderExpanded] = useState(true)
  const [sliceSliderPreviewIndex, setSliceSliderPreviewIndex] = useState<number | null>(null)
  const [displayDecorations, setDisplayDecorations] = useState<ViewportDisplayDecorations | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const currentInstance = instances[Math.min(viewportSliceIndex, Math.max(instances.length - 1, 0))] ?? null
  const effectiveCineFps = Math.min(Math.max(cineFps, 1), 60)
  const displayedSliceIndex = Math.min(Math.max(viewportSliceIndex, 0), Math.max(imageIds.length - 1, 0))
  const showCineControls = imageIds.length > 1 && cineControlsVisible
  const showFastSliceSlider = imageIds.length > 1
  const fastSliceDirectionLabels = getStackSliceDirectionLabels(instances)
  const canUseIchThreshold = modality.toUpperCase() === 'CT'
  const isDiagnosticPreviewActive = !diagnosticOnly && diagnosticImageState !== 'raw-ready'
  const viewportClassName = [
    'dicom-viewport',
    isSelected ? 'selected' : '',
    showFastSliceSlider ? 'has-slice-scrollbar' : '',
    diagnosticImageState !== 'raw-ready' ? 'diagnostic-image-pending' : '',
  ].filter(Boolean).join(' ')

  useEffect(() => {
    if (
      sliceSliderPreviewIndex !== null &&
      fastSliceSliderDragRef.current === null &&
      displayedSliceIndex === sliceSliderPreviewIndex
    ) {
      setSliceSliderPreviewIndex(null)
    }
  }, [displayedSliceIndex, sliceSliderPreviewIndex])

  const replacePreviewToolDraft = useCallback((draft: PreviewToolDraft | null) => {
    previewToolDraftRef.current = draft
    setPreviewToolDraft(draft)
  }, [])

  const updateDiagnosticImageState = useCallback((nextState: DiagnosticImageState, targetIndex?: number) => {
    const previousState = diagnosticImageStateRef.current
    diagnosticImageStateRef.current = nextState
    setDiagnosticImageState(nextState)

    const element = elementRef.current
    if (element) {
      element.dataset.vexaDiagnosticState = nextState
    }

    if (nextState === 'raw-ready' && previousState !== 'raw-ready') {
      const startedAt = rawTargetStartedAtRef.current
      dispatchDiagnosticViewportTelemetry('vexa-viewer-raw-image-ready', {
        viewportKey,
        seriesKey: series ? `${series.studyInstanceUid}|${series.seriesInstanceUid}` : '',
        targetIndex,
        elapsedMs: startedAt === null ? undefined : Math.max(0, Math.round(performance.now() - startedAt)),
      })
      rawTargetStartedAtRef.current = null
    }
  }, [series, viewportKey])

  const clearPreviewToolDraft = useCallback((message = '') => {
    replacePreviewToolDraft(null)
    deferredPreviewProbeRef.current = null
    setPreviewToolStatus(message)
  }, [replacePreviewToolDraft])

  useEffect(() => {
    const element = elementRef.current
    if (element) {
      element.dataset.vexaDiagnosticState = diagnosticImageState
    }
  }, [diagnosticImageState])

  useLayoutEffect(() => {
    setSliceSliderHost(elementRef.current?.parentElement ?? null)
    return () => setSliceSliderHost(null)
  }, [viewportKey])

  useEffect(() => {
    activeStackImageIdsRef.current = imageIds
    scheduledSliceIndexRef.current = null
    targetSliceIndexRef.current = Math.min(useViewerStore.getState().viewportSliceIndexes[viewportKey] ?? 0, Math.max(imageIds.length - 1, 0))
  }, [imageIds, viewportKey])

  useEffect(() => {
    instancesRef.current = instances
  }, [instances])

  useEffect(() => {
    ichThresholdRunRef.current += 1
    setIchSegmentationId(null)
    setIchThresholdApplying(false)
    setIchThresholdStatus('')
    setIchSeedMode(false)
    setIchSeedPoints([])
    setIchSmartDragPreview(null)
    setIchThresholdMin(ICH_DEFAULT_THRESHOLD_MIN)
    setIchThresholdMax(ICH_DEFAULT_THRESHOLD_MAX)
    ichSmartDragRef.current = null
    ichAdaptiveModelRef.current = null
    ichEraseConstraintsRef.current = []
    ichUndoSnapshotRef.current = null
    ichRedoSnapshotRef.current = null
    setIchHistoryState({ canUndo: false, canRedo: false })
  }, [series?.seriesInstanceUid, viewportKey])

  useEffect(() => {
    if (!ichSegmentationId) return
    setIchBrushSize(toolGroupId, ichBrushSize)
  }, [ichBrushSize, ichSegmentationId, toolGroupId])

  useEffect(() => {
    if (!ichSegmentationId || !canUseIchThreshold) return
    setIchBrushThreshold(toolGroupId, ichThresholdMin, ichThresholdMax)
  }, [canUseIchThreshold, ichSegmentationId, ichThresholdMax, ichThresholdMin, toolGroupId])

  useEffect(() => {
    if (!ichSegmentationId) return

    if (ichOpacityTimerRef.current !== null) {
      window.clearTimeout(ichOpacityTimerRef.current)
    }
    ichOpacityTimerRef.current = window.setTimeout(() => {
      setIchSegmentationOpacity(ichSegmentationId, viewportId, ichOpacity)
      renderStackViewport()
      ichOpacityTimerRef.current = null
    }, 80)

    return () => {
      if (ichOpacityTimerRef.current !== null) {
        window.clearTimeout(ichOpacityTimerRef.current)
        ichOpacityTimerRef.current = null
      }
    }
  }, [ichOpacity, ichSegmentationId, viewportId])

  function ensureStackIchSegmentation() {
    const referencedImageIds = activeStackImageIdsRef.current
    if (!referencedImageIds.length || !stackReadyRef.current) {
      setErrorMessage('ICH segmentation is waiting for the CT/MR stack to finish loading.')
      return null
    }

    try {
      const sourceKey = `${viewportKey}-${series?.studyInstanceUid ?? 'study'}-${series?.seriesInstanceUid ?? referencedImageIds.length}`
      const nextState = ensureIchStackSegmentation({
        sourceKey,
        referencedImageIds,
        viewportId,
        toolGroupId,
        brushSize: ichBrushSize,
        opacity: ichOpacity,
      })
      setIchSegmentationId(nextState.segmentationId)
      renderStackViewport()
      return nextState
    } catch (error) {
      console.warn('Unable to initialize stack ICH segmentation.', error)
      setErrorMessage('Unable to initialize ICH segmentation for this stack.')
      return null
    }
  }

  function handleStackIchModeChange(tool: 'ICHSegment' | 'ICHEraser') {
    const state = ensureStackIchSegmentation()
    if (!state) {
      return
    }

    setIchSeedMode(false)
    setActiveTool(tool)
  }

  function handleStackIchSeedMode() {
    if (!canUseIchThreshold) {
      setErrorMessage('Smart ICH seeding is available for CT series only.')
      return
    }

    const state = ensureStackIchSegmentation()
    if (!state) {
      return
    }

    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId)
    toolGroup?.setToolDisabled(BrushTool.toolName)
    toolGroup?.setToolDisabled(EraserTool.toolName)
    setIchSeedPoints([])
    setIchSeedMode(true)
    setIchThresholdStatus('Seed: click the centre of the haemorrhage')
  }

  function handleStackIchClear() {
    const state = ensureStackIchSegmentation()
    if (!state) {
      return
    }

    captureIchUndoState(state.segmentationId)
    clearIchSegment(state.segmentationId)
    setIchSeedPoints([])
    setIchSeedMode(false)
    resetIchAdaptiveLearning()
    setIchThresholdStatus('')
    renderStackViewport()
  }

  function renderStackViewport() {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    viewport?.render()
  }

  function refreshIchHistoryState() {
    setIchHistoryState({
      canUndo: Boolean(ichUndoSnapshotRef.current),
      canRedo: Boolean(ichRedoSnapshotRef.current),
    })
  }

  function captureIchUndoState(segmentationId: string) {
    ichUndoSnapshotRef.current = captureIchStackSnapshot(segmentationId)
    ichRedoSnapshotRef.current = null
    refreshIchHistoryState()
  }

  function updateIchAdaptiveModel(nextModel: IchAdaptiveHuModel | null | undefined) {
    if (!nextModel) {
      return
    }

    ichAdaptiveModelRef.current = mergeIchAdaptiveHuModels(ichAdaptiveModelRef.current, nextModel)
  }

  function resetIchAdaptiveLearning() {
    ichAdaptiveModelRef.current = null
    ichEraseConstraintsRef.current = []
  }

  function recordIchEraseConstraint(seed: IchSeedPoint, radiusPx: number) {
    const nextConstraint: IchForbiddenRegion = {
      sliceIndex: seed.sliceIndex,
      center: seed.imagePoint,
      radiusPx: Math.max(5, Math.min(96, radiusPx)),
    }
    const nextConstraints = [...ichEraseConstraintsRef.current, nextConstraint]
    ichEraseConstraintsRef.current = nextConstraints.slice(Math.max(0, nextConstraints.length - 32))
  }

  function formatStackIchStatsStatus(prefix: string, stats: IchStackSegmentStats) {
    const voxelText = `${stats.voxelCount.toLocaleString('id-ID')} vox`
    const volumeText = stats.volumeMl !== null ? ` | ${formatVolumeMl(stats.volumeMl)} mL` : ''

    return `${prefix}: ${voxelText}${volumeText}`
  }

  function handleStackIchUndo() {
    if (!ichSegmentationId || !ichUndoSnapshotRef.current || ichThresholdApplying) {
      return
    }

    const currentSnapshot = captureIchStackSnapshot(ichSegmentationId)
    restoreIchStackSnapshot(ichSegmentationId, ichUndoSnapshotRef.current)
    ichRedoSnapshotRef.current = currentSnapshot
    ichUndoSnapshotRef.current = null
    refreshIchHistoryState()
    setIchThresholdStatus(formatStackIchStatsStatus('Undo', getIchStackSegmentStats(ichSegmentationId, activeStackImageIdsRef.current)))
    renderStackViewport()
  }

  function handleStackIchRedo() {
    if (!ichSegmentationId || !ichRedoSnapshotRef.current || ichThresholdApplying) {
      return
    }

    const currentSnapshot = captureIchStackSnapshot(ichSegmentationId)
    restoreIchStackSnapshot(ichSegmentationId, ichRedoSnapshotRef.current)
    ichUndoSnapshotRef.current = currentSnapshot
    ichRedoSnapshotRef.current = null
    refreshIchHistoryState()
    setIchThresholdStatus(formatStackIchStatsStatus('Redo', getIchStackSegmentStats(ichSegmentationId, activeStackImageIdsRef.current)))
    renderStackViewport()
  }

  function getStackIchThresholdRange() {
    const minimumHu = Number(ichThresholdMin)
    const maximumHu = Number(ichThresholdMax)
    if (!Number.isFinite(minimumHu) || !Number.isFinite(maximumHu) || minimumHu >= maximumHu) {
      setErrorMessage('The ICH HU threshold range is invalid.')
      return null
    }

    return { minimumHu, maximumHu }
  }

  function readStackHuSample(event: React.PointerEvent<HTMLDivElement>): IchSeedPoint | null {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !stackReadyRef.current) {
      return null
    }

    const imageData = viewport.getImageData()
    if (!imageData?.dimensions) {
      return null
    }

    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const worldPos = viewport.canvasToWorld(canvasPoint)
    const vtkImage = imageData.imageData as { worldToIndex?: (point: number[]) => number[] } | undefined
    const index = vtkImage?.worldToIndex?.([worldPos[0], worldPos[1], worldPos[2]])
    if (!index || !Number.isFinite(index[0]) || !Number.isFinite(index[1])) {
      return null
    }

    const col = Math.floor(index[0])
    const row = Math.floor(index[1])
    const cols = Math.floor(Number(imageData.dimensions[0] ?? 0))
    const rows = Math.floor(Number(imageData.dimensions[1] ?? 0))
    if (col < 0 || col >= cols || row < 0 || row >= rows) {
      return null
    }

    const pixelIndex = row * cols + col
    const voxelValue = imageData.voxelManager?.getAtIJKPoint?.([col, row, 0])
    const pixelValue = voxelValue ?? imageData.scalarData?.[pixelIndex]
    const rawValue = Number(Array.isArray(pixelValue) ? pixelValue[0] : pixelValue)
    if (!Number.isFinite(rawValue)) {
      return null
    }

    const scaling = imageData.scaling as { rescaleSlope?: number | string; rescaleIntercept?: number | string } | undefined
    const alreadyScaled = Boolean(imageData.preScale?.scaled)
    const slope = alreadyScaled ? 1 : Number(scaling?.rescaleSlope ?? 1) || 1
    const intercept = alreadyScaled ? 0 : Number(scaling?.rescaleIntercept ?? 0) || 0

    return {
      canvasPoint,
      imagePoint: [col, row],
      hu: rawValue * slope + intercept,
      sliceIndex: displayedSliceIndex,
      kind: ichSeedPoints.length === 0 ? 'center' : 'edge',
    }
  }

  function handleStackIchSeedClick(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()

    if (!canUseIchThreshold) {
      setErrorMessage('Smart ICH seeding is available for CT series only.')
      setIchSeedMode(false)
      return
    }

    const sample = readStackHuSample(event)
    if (!sample) {
      setErrorMessage('Unable to read the HU value at the seed point.')
      return
    }

    const nextSeeds = ichSeedPoints.length >= 2 ? [sample] : [...ichSeedPoints, sample]
    setIchSeedPoints(nextSeeds)

    if (nextSeeds.length === 1) {
      setIchThresholdStatus(`Seed A ${sample.hu.toFixed(1)} HU | click the margin`)
      return
    }

    const [centerSeed, edgeSeed] = nextSeeds
    const range = deriveIchThresholdFromSeeds(centerSeed.hu, edgeSeed.hu)
    setIchThresholdMin(range.minimumHu)
    setIchThresholdMax(range.maximumHu)
    setIchBrushThreshold(toolGroupId, range.minimumHu, range.maximumHu)
    setIchSeedMode(false)
    setIchThresholdStatus(`Seed OK | HU ${range.minimumHu}-${range.maximumHu}`)
    void handleStackIchGrowSlice(centerSeed, range)
  }

  async function handleStackIchGrowSlice(
    seed = ichSeedPoints[0],
    range = getStackIchThresholdRange(),
    mode: 'add' | 'erase' = 'add',
  ) {
    if (!seed || !range) {
      setErrorMessage('Place a seed in the centre and at the margin of the haemorrhage first.')
      return
    }

    const state = ensureStackIchSegmentation()
    if (!state) {
      return
    }

    captureIchUndoState(state.segmentationId)
    setIchThresholdApplying(true)
    setIchThresholdStatus(`Grow slice ${seed.sliceIndex + 1}...`)

    try {
      const result = await applyIchRegionGrowToStackSlice({
        segmentationId: state.segmentationId,
        referencedImageIds: activeStackImageIdsRef.current,
        sliceIndex: seed.sliceIndex,
        seedPoint: seed.imagePoint,
        minimumHu: range.minimumHu,
        maximumHu: range.maximumHu,
        mode,
      })

      setIchThresholdStatus(formatStackIchGrowStatus(result))
      renderStackViewport()
    } catch (error) {
      console.warn('Unable to apply ICH region grow.', error)
      setErrorMessage('Smart ICH region growing failed.')
      setIchThresholdStatus('Region growing failed')
    } finally {
      setIchThresholdApplying(false)
    }
  }

  /** Ubah titik gambar (kolom, baris) jadi posisi di layar, untuk menggambar jalur lasso. */
  function ichLassoCanvasPoint(col: number, row: number): Types.Point2 | null {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const imageData = viewport?.getImageData()
    const vtkImage = imageData?.imageData as { indexToWorld?: (point: number[]) => number[] } | undefined
    if (!viewport || !vtkImage?.indexToWorld) {
      return null
    }

    const world = vtkImage.indexToWorld([col, row, 0])
    if (!world || !Number.isFinite(world[0]) || !Number.isFinite(world[1])) {
      return null
    }

    return viewport.worldToCanvas([world[0], world[1], world[2] ?? 0] as Types.Point3) as Types.Point2
  }

  function readStackIchLassoPoint(event: React.PointerEvent<HTMLDivElement>): IchLassoUiPoint | null {
    const sample = readStackHuSample(event)
    if (!sample) {
      return null
    }

    return {
      x: sample.imagePoint[0],
      y: sample.imagePoint[1],
      canvas: sample.canvasPoint,
      sliceIndex: sample.sliceIndex,
    }
  }

  /**
   * Pratinjau jalur magnet: garis di layar menunjukkan hasil snap, bukan jalur kursor
   * mentah, supaya operator bisa menilai sebelum menekan Apply. Permintaan yang
   * bertumpuk dibuang lewat penanda run (yang terbaru menang).
   */
  async function refreshIchLassoPreview(mode: 'polygon' | 'drag', points: IchLassoUiPoint[]) {
    const segmentationId = ichSegmentationId
    const referencedImageIds = activeStackImageIdsRef.current
    if (!segmentationId || points.length < 2 || ichLassoPreviewBusyRef.current) {
      if (points.length < 2) {
        setIchLassoPreview(null)
      }
      return
    }

    const runId = ichLassoPreviewRunRef.current + 1
    ichLassoPreviewRunRef.current = runId
    ichLassoPreviewBusyRef.current = true
    try {
      const result = await previewIchLassoPath({
        segmentationId,
        referencedImageIds,
        sliceIndex: points[0].sliceIndex,
        points: points.map((point) => ({ x: point.x, y: point.y })),
        mode,
        magnetism: ichLassoMagnetism,
      })
      if (ichLassoPreviewRunRef.current !== runId || !result) {
        return
      }

      const canvasPath: Types.Point2[] = []
      for (const point of result.path) {
        const canvas = ichLassoCanvasPoint(point.x, point.y)
        if (canvas) {
          canvasPath.push(canvas)
        }
      }
      setIchLassoPreview(canvasPath.length >= 2 ? canvasPath : null)
    } catch (error) {
      console.warn('Unable to preview the magnetic lasso path.', error)
    } finally {
      ichLassoPreviewBusyRef.current = false
    }
  }

  /** Klik di mode poligon: tambah titik kontrol. */
  function handleStackIchLassoClick(event: React.PointerEvent<HTMLDivElement>) {
    if (!canUseIchThreshold) {
      setErrorMessage('The magnetic lasso is available for CT series only.')
      return
    }

    const point = readStackIchLassoPoint(event)
    if (!point) {
      setErrorMessage('Unable to read the image point for the lasso.')
      return
    }

    const sameSlice = ichLassoPoints.length ? ichLassoPoints[0].sliceIndex === point.sliceIndex : true
    const next = sameSlice ? [...ichLassoPoints, point] : [point]
    setIchLassoPoints(next)
    setIchLassoStatus(next.length < 3
      ? `Lasso: ${next.length} point${next.length === 1 ? '' : 's'} (minimum 3)`
      : `Lasso: ${next.length} points | Apply ${ichLassoOperation} or keep clicking`)
    void refreshIchLassoPreview('polygon', next)
  }

  /** Mode geser batas: tekan di dekat garis tepi, seret, lepas untuk menerapkan. */
  function startStackIchLassoDrag(event: React.PointerEvent<HTMLDivElement>): boolean {
    if (!canUseIchThreshold || ichThresholdApplying || !ichSegmentationId) {
      return false
    }

    const point = readStackIchLassoPoint(event)
    if (!point) {
      return false
    }

    const state = ensureStackIchSegmentation()
    if (!state) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    ichLassoDragRef.current = { pointerId: event.pointerId, points: [point] }
    setIchLassoPoints([point])
    setIchLassoStatus('Drag: pull the boundary outward or inward, release to apply')
    return true
  }

  function updateStackIchLassoDrag(event: React.PointerEvent<HTMLDivElement>): boolean {
    const drag = ichLassoDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return false
    }

    const point = readStackIchLassoPoint(event)
    if (!point) {
      return true
    }

    const last = drag.points[drag.points.length - 1]
    if (Math.hypot(point.canvas[0] - last.canvas[0], point.canvas[1] - last.canvas[1]) < 3) {
      return true
    }

    drag.points = [...drag.points, point]
    setIchLassoPoints(drag.points)
    void refreshIchLassoPreview('drag', drag.points)
    return true
  }

  async function applyStackIchLasso(mode: 'polygon' | 'drag', points: IchLassoUiPoint[]) {
    const referencedImageIds = activeStackImageIdsRef.current
    if (!points.length || !referencedImageIds.length) {
      return
    }

    const state = ensureStackIchSegmentation()
    if (!state) {
      return
    }

    captureIchUndoState(state.segmentationId)
    setIchLassoBusy(true)
    setIchThresholdStatus(mode === 'polygon' ? `Lasso ${ichLassoOperation}...` : 'Boundary drag...')
    try {
      const result = await applyIchLassoToStackSlice({
        segmentationId: state.segmentationId,
        referencedImageIds,
        sliceIndex: points[0].sliceIndex,
        points: points.map((point) => ({ x: point.x, y: point.y })),
        mode,
        operation: ichLassoOperation,
        magnetism: ichLassoMagnetism,
      })

      if (!result) {
        setIchThresholdStatus('Lasso: nothing to apply')
        return
      }

      const volumeLabel = result.volumeMl != null ? ` | ${result.volumeMl.toFixed(2)} mL` : ''
      setIchThresholdStatus(
        `${mode === 'polygon' ? `Lasso ${ichLassoOperation}` : 'Boundary drag'}: +${result.added} / -${result.removed} vox`
        + ` | edge ${result.pathGradient.toFixed(1)} HU/px${volumeLabel}`,
      )
      setIchLassoStatus(`Applied | +${result.added} / -${result.removed} vox`)
      setIchLassoPoints([])
      setIchLassoPreview(null)
      renderStackViewport()
    } catch (error) {
      console.warn('Unable to apply the magnetic lasso.', error)
      setErrorMessage('Magnetic lasso failed.')
      setIchThresholdStatus('Lasso failed')
    } finally {
      setIchLassoBusy(false)
    }
  }

  function finishStackIchLassoDrag(event: React.PointerEvent<HTMLDivElement>): boolean {
    const drag = ichLassoDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return false
    }

    ichLassoDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const points = drag.points
    if (points.length >= 2) {
      void applyStackIchLasso('drag', points)
    } else {
      setIchLassoPoints([])
      setIchLassoPreview(null)
      setIchLassoStatus('Drag: too short, nothing applied')
    }
    return true
  }

  function cancelStackIchLasso() {
    ichLassoDragRef.current = null
    ichLassoPreviewRunRef.current += 1
    setIchLassoPoints([])
    setIchLassoPreview(null)
    setIchLassoStatus('Lasso cleared')
  }

  function startStackIchSmartDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (
      !ichSmartDragEnabled
      || ichThresholdApplying
      || ichSeedMode
      || ichLassoMode !== 'off'
      || (activeTool !== 'ICHSegment' && activeTool !== 'ICHEraser')
    ) {
      return false
    }

    if (!canUseIchThreshold) {
      setErrorMessage('Smart Drag ICH is available for CT series only.')
      return false
    }

    const state = ensureStackIchSegmentation()
    if (!state) {
      return false
    }

    const seed = readStackHuSample(event)
    if (!seed) {
      setErrorMessage('Unable to read the HU value at the initial drag point.')
      return false
    }

    const mode = activeTool === 'ICHEraser' ? 'erase' : 'add'
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    ichSmartDragRef.current = {
      pointerId: event.pointerId,
      segmentationId: state.segmentationId,
      mode,
      seed,
      current: seed,
    }
    setIchSmartDragPreview({ canvasPoint: seed.canvasPoint, radius: 4, mode })
    setIchThresholdStatus(mode === 'erase' ? 'Smart clear: drag the correction area' : 'Smart add: drag the area boundary')

    return true
  }

  function updateStackIchSmartDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = ichSmartDragRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return false
    }

    const current = readStackHuSample(event) ?? gesture.current
    const radius = Math.max(
      4,
      Math.hypot(current.canvasPoint[0] - gesture.seed.canvasPoint[0], current.canvasPoint[1] - gesture.seed.canvasPoint[1]),
    )

    event.preventDefault()
    event.stopPropagation()
    ichSmartDragRef.current = { ...gesture, current }
    setIchSmartDragPreview({ canvasPoint: gesture.seed.canvasPoint, radius, mode: gesture.mode })

    return true
  }

  function stopStackIchSmartDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = ichSmartDragRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return false
    }

    const current = readStackHuSample(event) ?? gesture.current
    ichSmartDragRef.current = null
    setIchSmartDragPreview(null)
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    void commitStackIchSmartDrag(gesture, current)
    return true
  }

  async function commitStackIchSmartDrag(gesture: IchSmartDragGesture, current: IchSeedPoint) {
    if (ichThresholdApplying) {
      return
    }

    const range = getStackIchThresholdRange() ?? {
      minimumHu: ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: ICH_DEFAULT_THRESHOLD_MAX,
    }

    captureIchUndoState(gesture.segmentationId)
    setIchThresholdApplying(true)
    setIchThresholdStatus(gesture.mode === 'erase' ? 'Smart clear...' : 'Smart add...')

    try {
      const result = await applyIchSmartDragToStackSlice({
        segmentationId: gesture.segmentationId,
        referencedImageIds: activeStackImageIdsRef.current,
        sliceIndex: gesture.seed.sliceIndex,
        seedPoint: gesture.seed.imagePoint,
        dragPoint: current.imagePoint,
        mode: gesture.mode,
        minimumHu: range.minimumHu,
        maximumHu: range.maximumHu,
        adaptiveModel: ichAdaptiveModelRef.current,
        maxRadiusPx: Math.max(14, Math.min(48, Math.round(ichBrushSize * 1.8))),
        maxVoxels: gesture.mode === 'erase' ? 32000 : 14000,
      })

      if (gesture.mode === 'add' && result.seedAccepted) {
        updateIchAdaptiveModel(result.adaptiveModel)
        setIchSeedPoints([
          { ...gesture.seed, kind: 'center' },
          { ...current, kind: 'edge' },
        ])
        setIchThresholdMin(result.minimumHu)
        setIchThresholdMax(result.maximumHu)
        setIchBrushThreshold(toolGroupId, result.minimumHu, result.maximumHu)
      } else if (gesture.mode === 'erase' && result.seedAccepted && result.matchedVoxels > 0) {
        recordIchEraseConstraint(gesture.seed, result.radiusPx)
      }

      setIchThresholdStatus(formatStackIchSmartDragStatus(result, gesture.mode))
      renderStackViewport()
    } catch (error) {
      console.warn('Unable to apply smart ICH drag.', error)
      setErrorMessage('Smart Drag ICH processing failed.')
      setIchThresholdStatus('Smart Drag failed')
    } finally {
      setIchThresholdApplying(false)
    }
  }

  async function handleStackIchThresholdApply(scope: 'slice' | 'stack', refine = false) {
    if (ichThresholdApplying) {
      return
    }

    if (!canUseIchThreshold) {
      setErrorMessage('ICH HU thresholding is available for CT series only.')
      return
    }

    const range = getStackIchThresholdRange()
    if (!range) {
      return
    }

    const state = ensureStackIchSegmentation()
    if (!state) {
      return
    }

    const referencedImageIds = activeStackImageIdsRef.current
    if (!referencedImageIds.length) {
      setErrorMessage('No CT/MR slices are available for processing.')
      return
    }

    if (scope === 'stack' && !ichSeedPoints[0]) {
      setErrorMessage('Place a seed in the centre and at the margin of the haemorrhage first.')
      return
    }

    const runId = ichThresholdRunRef.current + 1
    ichThresholdRunRef.current = runId
    captureIchUndoState(state.segmentationId)
    setIchThresholdApplying(true)

    if (scope === 'stack') {
      const seed = ichSeedPoints[0]
      if (!seed) {
        setIchThresholdApplying(false)
        setErrorMessage('Place a seed in the centre and at the margin of the haemorrhage first.')
        return
      }

      const operationLabel = refine ? 'Refine' : 'Adaptive'
      setIchThresholdStatus(`${operationLabel} 0/${referencedImageIds.length}`)
      if (!refine) {
        resetIchAdaptiveLearning()
      }

      try {
        const result = await applyIchAdaptiveRegionGrowToStack({
          segmentationId: state.segmentationId,
          referencedImageIds,
          seedSliceIndex: seed.sliceIndex,
          seedPoint: seed.imagePoint,
          minimumHu: range.minimumHu,
          maximumHu: range.maximumHu,
          roiMargin: 20,
          localToleranceHu: 10,
          replaceExisting: !refine,
          adaptiveModel: refine ? ichAdaptiveModelRef.current : null,
          forbiddenRegions: refine ? ichEraseConstraintsRef.current : [],
          shouldCancel: () => ichThresholdRunRef.current !== runId,
          onProgress: ({ matchedVoxels, processedSlices, totalSlices }) => {
            if (ichThresholdRunRef.current !== runId) {
              return
            }

            const prefix = refine ? 'Refine' : 'Adaptive'
            const voxelPrefix = refine ? '+' : ''
            setIchThresholdStatus(`${prefix} ${processedSlices}/${totalSlices} | ${voxelPrefix}${matchedVoxels.toLocaleString('id-ID')} vox`)
          },
        })

        if (ichThresholdRunRef.current !== runId) {
          return
        }

        updateIchAdaptiveModel(result.adaptiveModel)
        setIchThresholdStatus(formatStackIchAdaptiveStatus(result, refine))
        renderStackViewport()
      } catch (error) {
        console.warn('Unable to apply adaptive ICH region grow.', error)
        if (ichThresholdRunRef.current === runId) {
          setErrorMessage(refine ? 'ICH stack refinement failed.' : 'Adaptive ICH stack processing failed.')
          setIchThresholdStatus(refine ? 'Refinement failed' : 'Adaptive processing failed')
        }
      } finally {
        if (ichThresholdRunRef.current === runId) {
          setIchThresholdApplying(false)
        }
      }

      return
    }

    const sliceIndexes = [displayedSliceIndex]
    setIchThresholdStatus(`Threshold 0/${sliceIndexes.length}`)

    try {
      const result = await applyIchThresholdToStack({
        segmentationId: state.segmentationId,
        referencedImageIds,
        sliceIndexes,
        minimumHu: range.minimumHu,
        maximumHu: range.maximumHu,
        replace: true,
        shouldCancel: () => ichThresholdRunRef.current !== runId,
        onProgress: ({ matchedVoxels, processedSlices, totalSlices }) => {
          if (ichThresholdRunRef.current !== runId) {
            return
          }

          setIchThresholdStatus(`Threshold ${processedSlices}/${totalSlices} | ${matchedVoxels.toLocaleString('id-ID')} vox`)
        },
      })

      if (ichThresholdRunRef.current !== runId) {
        return
      }

      setIchThresholdStatus(formatStackIchThresholdStatus(scope, result))
      renderStackViewport()
    } catch (error) {
      console.warn('Unable to apply ICH threshold.', error)
      if (ichThresholdRunRef.current === runId) {
        setErrorMessage('ICH threshold processing failed.')
        setIchThresholdStatus('Threshold processing failed')
      }
    } finally {
      if (ichThresholdRunRef.current === runId) {
        setIchThresholdApplying(false)
      }
    }
  }

  const clearRenderedPreviewOverlay = useCallback((abortRequest = true) => {
    previewGenerationRef.current += 1
    previewRequestedAtRef.current = null
    previewTargetIndexRef.current = null
    if (previewDelayTimerRef.current !== null) {
      window.clearTimeout(previewDelayTimerRef.current)
      previewDelayTimerRef.current = null
    }
    if (abortRequest) {
      previewRequestRef.current?.abort()
      previewRequestRef.current = null
    }
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
  }, [])

  const requestRenderedPreviewOverlay = useCallback((targetIndex: number) => {
    if (diagnosticOnly) {
      clearRenderedPreviewOverlay()
      return
    }
    if (
      import.meta.env.VITE_STACK_RENDERED_PREVIEW === 'false'
      || imageIds.length < 2
      || !instances.length
      || useViewerStore.getState().viewportCinePlaying[viewportKey]
    ) {
      return
    }

    const element = elementRef.current
    if (!element || !isRenderableViewportElement(element)) {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    // A viewport that has been zoomed beyond fit may not align with a plain
    // rendered image overlay. In that case raw remains the only display path.
    if (viewport && viewport.getZoom() > 1.02) {
      return
    }

    const generation = previewGenerationRef.current + 1

    previewGenerationRef.current = generation
    previewRequestedAtRef.current = performance.now()
    previewTargetIndexRef.current = targetIndex
    if (previewDelayTimerRef.current !== null) {
      window.clearTimeout(previewDelayTimerRef.current)
      previewDelayTimerRef.current = null
    }
    previewRequestRef.current?.abort()
    previewRequestRef.current = null
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })

    previewDelayTimerRef.current = window.setTimeout(() => {
      previewDelayTimerRef.current = null
      if (previewGenerationRef.current !== generation || targetSliceIndexRef.current !== targetIndex) {
        return
      }

      const activeElement = elementRef.current
      if (!activeElement || !isRenderableViewportElement(activeElement)) {
        return
      }

      const activeInstances = instancesRef.current
      const frameReference = getInstanceFrameForImageIndex(activeInstances, targetIndex)
      const previewInstance = frameReference?.instance
      if (!frameReference || !previewInstance || previewInstance.rows < 1 || previewInstance.columns < 1) {
        return
      }

      const dimensions = getRenderedPreviewDimensions(activeElement, previewInstance)
      const activeViewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
      const windowLevel = activeViewport ? getViewportWindowLevel(activeViewport) : null
      const controller = new AbortController()
      previewRequestRef.current = controller

      void fetchRenderedPreviewDataUrl(previewInstance, {
        frame: frameReference.frame,
        rows: dimensions.rows,
        columns: dimensions.columns,
        quality: renderedPreviewQuality,
        ...(windowLevel && windowLevel.windowWidth > 1
          ? { windowCenter: windowLevel.windowLevel, windowWidth: windowLevel.windowWidth }
          : {}),
      }, controller.signal)
        .then((url) => {
          if (
            controller.signal.aborted ||
            previewGenerationRef.current !== generation ||
            targetSliceIndexRef.current !== targetIndex ||
            diagnosticRenderTargetIndexRef.current !== targetIndex
          ) {
            if (url) URL.revokeObjectURL(url)
            return
          }

          if (!url) {
            return
          }

          setPreviewUrl((current) => {
            if (current && current !== url) URL.revokeObjectURL(current)
            return url
          })
          updateDiagnosticImageState('jpeg-preview', targetIndex)
          dispatchDiagnosticViewportTelemetry('vexa-viewer-jpeg-preview-rendered', {
            viewportKey,
            seriesKey: previewInstance ? `${previewInstance.studyInstanceUid}|${previewInstance.seriesInstanceUid}` : '',
            targetIndex,
            elapsedMs: previewRequestedAtRef.current === null
              ? undefined
              : Math.max(0, Math.round(performance.now() - previewRequestedAtRef.current)),
          })
        })
        .catch(() => undefined)
        .finally(() => {
          if (previewRequestRef.current === controller) {
            previewRequestRef.current = null
          }
        })
    }, stackRenderedPreviewDelayMs)
  }, [clearRenderedPreviewOverlay, diagnosticOnly, imageIds.length, instances.length, updateDiagnosticImageState, viewportId, viewportKey])

  const clearPreviewWhenDiagnosticSliceIsVisible = useCallback((sliceIndex?: number) => {
    const targetIndex = diagnosticRenderTargetIndexRef.current
    if (targetIndex === null) {
      return
    }

    if (typeof sliceIndex === 'number' && sliceIndex !== targetIndex) {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as AnnotationReferenceViewport | undefined
    const currentIndex = viewport?.getCurrentImageIdIndex?.()
    if (typeof currentIndex === 'number' && currentIndex !== targetIndex) {
      return
    }

    diagnosticRenderTargetIndexRef.current = null
    clearRenderedPreviewOverlay()
    updateDiagnosticImageState('raw-ready', targetIndex ?? currentIndex)
    window.requestAnimationFrame(() => {
      commitPreviewToolDraftIfReady()
      revealDeferredPreviewProbeIfReady()
    })
  }, [clearRenderedPreviewOverlay, updateDiagnosticImageState, viewportId])

  const warmRenderedStackAround = useCallback((targetIndex: number, radius = stackRenderedWarmRadius) => {
    if (
      diagnosticOnly ||
      import.meta.env.VITE_STACK_RENDERED_WARM === 'false' ||
      imageIds.length < 2 ||
      useViewerStore.getState().viewportCinePlaying[viewportKey]
    ) {
      return
    }

    renderedWarmQueuedRef.current = {
      targetIndex: Math.max(0, Math.floor(targetIndex)),
      radius: Math.max(0, Math.floor(radius)),
    }

    if (renderedWarmTimerRef.current !== null) {
      window.clearTimeout(renderedWarmTimerRef.current)
    }

    renderedWarmTimerRef.current = window.setTimeout(() => {
      renderedWarmTimerRef.current = null
      const queued = renderedWarmQueuedRef.current
      renderedWarmQueuedRef.current = null
      if (!queued || useViewerStore.getState().viewportCinePlaying[viewportKey]) {
        return
      }

      const currentInstances = instancesRef.current
      const frameReference = getInstanceFrameForImageIndex(currentInstances, queued.targetIndex)
      if (!frameReference) {
        return
      }

      const element = elementRef.current
      const dimensions = element && isRenderableViewportElement(element)
        ? getRenderedPreviewDimensions(element, frameReference.instance)
        : { rows: Math.min(frameReference.instance.rows || 512, renderedPreviewMaxEdge), columns: Math.min(frameReference.instance.columns || 512, renderedPreviewMaxEdge) }
      const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
      const windowLevel = viewport ? getViewportWindowLevel(viewport) : null
      const seriesKey = `${frameReference.instance.studyInstanceUid}|${frameReference.instance.seriesInstanceUid}`
      const warmKey = [
        seriesKey,
        queued.targetIndex,
        queued.radius,
        `${dimensions.rows}x${dimensions.columns}`,
        windowLevel?.windowLevel ?? 'auto',
        windowLevel?.windowWidth ?? 'auto',
      ].join('|')
      const now = Date.now()
      const lastWarm = renderedWarmLastRequestRef.current
      if (lastWarm?.key === warmKey && now - lastWarm.at < 5_000) {
        return
      }
      renderedWarmLastRequestRef.current = { key: warmKey, at: now }

      void warmRenderedStackCache(currentInstances, queued.targetIndex, {
        radius: queued.radius,
        maxFrames: Math.min(queued.radius * 2 + 1, stackRenderedWarmMaxFrames),
        rows: dimensions.rows,
        columns: dimensions.columns,
        quality: renderedPreviewQuality,
        ...(windowLevel && windowLevel.windowWidth > 1
          ? { windowCenter: windowLevel.windowLevel, windowWidth: windowLevel.windowWidth }
          : {}),
      }).then((result) => {
        if (!result) {
          return
        }

        window.dispatchEvent(new CustomEvent('vexa-viewer-render-cache-warm', {
          detail: {
            viewportKey,
            seriesKey,
            centerIndex: queued.targetIndex,
            warmed: result.warmed ?? 0,
            failed: result.failed ?? 0,
            requested: result.requested ?? 0,
            bytes: result.bytes ?? 0,
            elapsedMs: result.elapsedMs ?? 0,
          },
        }))
      }).catch(() => undefined)
    }, 220)
  }, [diagnosticOnly, imageIds.length, viewportId, viewportKey])

  useEffect(() => {
    if (backgroundVolumeWarmTimerRef.current !== null) {
      window.clearTimeout(backgroundVolumeWarmTimerRef.current)
      backgroundVolumeWarmTimerRef.current = null
    }

    const previousWarm = backgroundVolumeWarmSeriesRef.current
    if (previousWarm && (!series || previousWarm.series.seriesInstanceUid !== series.seriesInstanceUid)) {
      discardPreparedMprSeriesVolume(previousWarm.series, previousWarm.ownerId)
      backgroundVolumeWarmSeriesRef.current = null
    }

    if (
      disableBackgroundVolumePrepare
      ||
      import.meta.env.VITE_MPR_BACKGROUND_PREPARE === 'false'
      || !stackReadyTick
      || !series
      || !isSelected
      || imageIds.length < 24
      || !['CT', 'MR'].includes(modality.toUpperCase())
      || useViewerStore.getState().mprViewportKeys[viewportKey]
    ) {
      return
    }

    const ownerId = getDiagnosticVolumeOwnerId(viewportKey)
    backgroundVolumeWarmTimerRef.current = window.setTimeout(() => {
      backgroundVolumeWarmTimerRef.current = null
      backgroundVolumeWarmSeriesRef.current = { series, ownerId }
      void prepareMprSeriesVolume(series, ownerId).catch(() => {
        if (backgroundVolumeWarmSeriesRef.current?.series.seriesInstanceUid === series.seriesInstanceUid) {
          backgroundVolumeWarmSeriesRef.current = null
        }
      })
    }, mprBackgroundPrepareDelayMs)

    return () => {
      if (backgroundVolumeWarmTimerRef.current !== null) {
        window.clearTimeout(backgroundVolumeWarmTimerRef.current)
        backgroundVolumeWarmTimerRef.current = null
      }
    }
  }, [disableBackgroundVolumePrepare, imageIds.length, isSelected, modality, series, stackReadyTick, viewportKey])

  useEffect(() => () => {
    if (backgroundVolumeWarmTimerRef.current !== null) {
      window.clearTimeout(backgroundVolumeWarmTimerRef.current)
      backgroundVolumeWarmTimerRef.current = null
    }
    // Keep a prepared volume alive across the stack -> MPR component switch.
    // The shared-volume cache owns its TTL and the MPR viewer acquires the same
    // owner key immediately after this component unmounts. Discarding it here
    // made every MPR entry start the full series load again.
    backgroundVolumeWarmSeriesRef.current = null
  }, [])

  const commitScheduledSliceIndex = useCallback(() => {
    sliceCommitFrameRef.current = null
    if (cineBusyRef.current) {
      return
    }

    const activeImageIds = activeStackImageIdsRef.current
    const targetIndex = scheduledSliceIndexRef.current
    if (activeImageIds.length < 1) {
      return
    }
    if (targetIndex === null) {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!viewport || !stackReadyRef.current) {
      return
    }

    const currentImageIndex = getCurrentStackImageIndex(viewport, viewportKey)
    const committedTargetIndex = animatedSliceScrubRef.current
      ? getAnimatedScrubStepIndex(currentImageIndex, targetIndex)
      : targetIndex
    const shouldContinueScrub = committedTargetIndex !== targetIndex

    scheduledSliceIndexRef.current = shouldContinueScrub ? targetIndex : null
    cineBusyRef.current = true

    if (diagnosticRenderTargetIndexRef.current !== committedTargetIndex) {
      diagnosticRenderTargetIndexRef.current = committedTargetIndex
      rawTargetStartedAtRef.current = performance.now()
      updateDiagnosticImageState('raw-loading', committedTargetIndex)
    }
    void (viewport as Types.IStackViewport & { setImageIdIndex: (imageIdIndex: number) => Promise<string> })
      .setImageIdIndex(committedTargetIndex)
      .then(() => {
        if (targetSliceIndexRef.current !== committedTargetIndex && !shouldContinueScrub) {
          return
        }

        const state = useViewerStore.getState()
        setViewportSliceIndex(viewportKey, committedTargetIndex)
        prewarmStackNeighbors(activeImageIds, committedTargetIndex, { radius: stackRawPrewarmRadius, timeoutMs: 8_000 })
        warmRenderedStackAround(committedTargetIndex)
        scheduleReferenceLinesRefresh(viewportKey)
        if (!applyingLinkedCommandRef.current) {
          broadcastLinkedCommand(viewportKey, 'scroll', 'set-slice', {
            sliceIndex: committedTargetIndex,
            sourceInstance: state.viewportStacks[viewportKey]?.instances[committedTargetIndex],
          })
        }
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to render requested image.')
      })
      .finally(() => {
        cineBusyRef.current = false
        const latestTargetIndex = targetSliceIndexRef.current
        if (latestTargetIndex !== null && latestTargetIndex !== committedTargetIndex) {
          scheduledSliceIndexRef.current = latestTargetIndex
        }

        if (scheduledSliceIndexRef.current !== null) {
          const scheduleNext = () => {
            sliceCommitFrameRef.current = window.requestAnimationFrame(commitScheduledSliceIndex)
          }
          if (animatedSliceScrubRef.current) {
            window.setTimeout(scheduleNext, stackAnimatedScrubFrameMs)
          } else {
            scheduleNext()
          }
          return
        }

        animatedSliceScrubRef.current = false
        if (diagnosticImageStateRef.current === 'raw-ready') {
          clearRenderedPreviewOverlay()
        }
      })
  }, [clearRenderedPreviewOverlay, setErrorMessage, setViewportSliceIndex, updateDiagnosticImageState, viewportId, viewportKey, warmRenderedStackAround])

  const scheduleSliceCommit = useCallback((immediate = false) => {
    if (cineBusyRef.current) {
      return
    }

    if (sliceCommitTimerRef.current !== null) {
      window.clearTimeout(sliceCommitTimerRef.current)
    }

    const delay = immediate ? 0 : stackSliceCommitDebounceMs
    sliceCommitTimerRef.current = window.setTimeout(() => {
      sliceCommitTimerRef.current = null
      if (sliceCommitFrameRef.current === null) {
        sliceCommitFrameRef.current = window.requestAnimationFrame(commitScheduledSliceIndex)
      }
    }, delay)
  }, [commitScheduledSliceIndex])

  const jumpToSliceIndex = useCallback((sliceIndex: number, options: { animate?: boolean; immediate?: boolean } = {}) => {
    const activeImageIds = activeStackImageIdsRef.current
    if (activeImageIds.length < 1) {
      return
    }

    const targetIndex = Math.min(Math.max(sliceIndex, 0), activeImageIds.length - 1)
    if (previewToolDraftRef.current?.targetIndex !== targetIndex) {
      clearPreviewToolDraft()
    }
    targetSliceIndexRef.current = targetIndex
    scheduledSliceIndexRef.current = targetIndex
    animatedSliceScrubRef.current = Boolean(options.animate)
    // Animated scrubbing commits intermediate frames. Publishing the final
    // target here makes the slider jump forward, back to each committed frame,
    // then forward again. Keep the store tied to the frame actually displayed.
    if (!options.animate) {
      setViewportSliceIndex(viewportKey, targetIndex)
    }
    if (!options.animate) {
      diagnosticRenderTargetIndexRef.current = targetIndex
      rawTargetStartedAtRef.current = performance.now()
      updateDiagnosticImageState('raw-loading', targetIndex)
      requestRenderedPreviewOverlay(targetIndex)
    }
    scheduleSliceCommit(Boolean(options.immediate || options.animate))
  }, [clearPreviewToolDraft, requestRenderedPreviewOverlay, scheduleSliceCommit, setViewportSliceIndex, updateDiagnosticImageState, viewportKey])

  const handleViewportWheel = useCallback((event: WheelEvent) => {
    if (event.defaultPrevented) {
      return
    }

    const activeImageIds = activeStackImageIdsRef.current
    if (!stackReadyRef.current || activeImageIds.length < 2) {
      return
    }

    const dominantDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!dominantDelta) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    let steps = 0
    if (event.deltaMode === 0 && Math.abs(dominantDelta) >= 80) {
      steps = Math.sign(dominantDelta)
      wheelDeltaRef.current = 0
    } else {
      const threshold = event.deltaMode === 0 ? 32 : 1
      wheelDeltaRef.current += dominantDelta
      steps = Math.trunc(wheelDeltaRef.current / threshold)
      wheelDeltaRef.current -= steps * threshold
    }
    if (!steps) {
      return
    }

    const currentSliceIndex = useViewerStore.getState().viewportSliceIndexes[viewportKey] ?? 0
    setSliceSliderPreviewIndex(null)
    setViewportCinePlaying(viewportKey, false)
    void jumpToSliceIndex(currentSliceIndex + steps, { animate: Math.abs(steps) > 1, immediate: true })
  }, [jumpToSliceIndex, setViewportCinePlaying, viewportKey])

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) {
      return
    }

    const wheelListenerOptions: AddEventListenerOptions = { passive: false, capture: true }
    element.addEventListener('wheel', handleViewportWheel, wheelListenerOptions)
    return () => {
      element.removeEventListener('wheel', handleViewportWheel, wheelListenerOptions)
    }
  }, [handleViewportWheel])

  useEffect(() => () => {
    if (sliceCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(sliceCommitFrameRef.current)
      sliceCommitFrameRef.current = null
    }
    if (sliceCommitTimerRef.current !== null) {
      window.clearTimeout(sliceCommitTimerRef.current)
      sliceCommitTimerRef.current = null
    }
    if (renderedWarmTimerRef.current !== null) {
      window.clearTimeout(renderedWarmTimerRef.current)
      renderedWarmTimerRef.current = null
    }
    renderedWarmQueuedRef.current = null
    scheduledSliceIndexRef.current = null
    animatedSliceScrubRef.current = false
  }, [])

function removeProgressivePreview(element: HTMLElement | null) {
  if (!element) return
  const overlay = element.querySelector('canvas[data-vexa-progressive-preview]')
  if (overlay?.parentElement) {
    overlay.remove()
  }
}

function isRenderableViewportElement(element: HTMLElement | null) {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 1 && rect.height > 1
}

function waitForRenderableViewportElement(element: HTMLElement, timeoutMs = 1500) {
  if (isRenderableViewportElement(element)) {
    return Promise.resolve(true)
  }

  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ready: boolean) => {
      if (done) return
      done = true
      observer.disconnect()
      window.clearTimeout(timeoutId)
      resolve(ready)
    }

    const observer = new ResizeObserver(() => {
      if (isRenderableViewportElement(element)) {
        finish(true)
      }
    })
    const timeoutId = window.setTimeout(() => finish(isRenderableViewportElement(element)), timeoutMs)
    observer.observe(element)
    window.requestAnimationFrame(() => {
      if (isRenderableViewportElement(element)) {
        finish(true)
      }
    })
  })
}

  useEffect(() => {
    stack3dCursorRef.current = stack3dCursor
  }, [stack3dCursor])

  useEffect(() => {
    let cancelled = false

    async function loadGspsOverlays() {
      if (!study?.studyInstanceUid || !series?.seriesInstanceUid || !currentInstance?.sopInstanceUid) {
        setGspsOverlays([])
        return
      }

      if (isSavedGspsSuppressed(study.studyInstanceUid, series.seriesInstanceUid, currentInstance.sopInstanceUid)) {
        setGspsOverlays([])
        return
      }

      const persistedOverlays = loadSavedGspsOverlays(study.studyInstanceUid, series.seriesInstanceUid, currentInstance.sopInstanceUid)
      restoreSavedGspsAnnotations(persistedOverlays, elementRef.current, restoredGspsAnnotationKeysRef.current)
      const persistedDisplayOverlays = persistedOverlays
        .filter((overlay) => !overlay.annotations?.length)
        .map(savedGspsOverlayToViewportOverlay)

      try {
        const studySeries = await listSeries(study.studyInstanceUid)
        const presentationStateSeries = studySeries.filter((item) => item.modality?.toUpperCase() === 'PR')
        if (!presentationStateSeries.length) {
          if (!cancelled) setGspsOverlays(persistedDisplayOverlays)
          return
        }

        const overlayGroups = await Promise.all(
          presentationStateSeries.map(async (presentationSeries) => {
            const presentationInstances = await listInstances(presentationSeries)
            return presentationInstances
              .map((presentationInstance) => parseGspsOverlay(presentationInstance.metadata, series.seriesInstanceUid, currentInstance.sopInstanceUid))
              .filter((overlay): overlay is GspsOverlay => Boolean(overlay))
          }),
        )

        if (!cancelled) {
          setGspsOverlays(mergeGspsOverlays(persistedDisplayOverlays, overlayGroups.flat()))
        }
      } catch {
        if (!cancelled) setGspsOverlays(persistedDisplayOverlays)
      }
    }

    void loadGspsOverlays()

    return () => {
      cancelled = true
    }
  }, [currentInstance?.sopInstanceUid, series?.seriesInstanceUid, study?.studyInstanceUid])

  useEffect(() => {
    function handleSavedGspsOverlay(event: Event) {
      const overlay = (event as CustomEvent<SavedGspsOverlay>).detail
      if (
        overlay?.studyInstanceUid === study?.studyInstanceUid &&
        overlay.seriesInstanceUid === series?.seriesInstanceUid &&
        overlay.sopInstanceUid === currentInstance?.sopInstanceUid
      ) {
        restoreSavedGspsAnnotations([overlay], elementRef.current, restoredGspsAnnotationKeysRef.current)
        if (!overlay.annotations?.length) {
          setGspsOverlays((current) => mergeGspsOverlays(current, [savedGspsOverlayToViewportOverlay(overlay)]))
        }
      }
    }

    window.addEventListener('vexa-viewer-gsps-overlay-saved', handleSavedGspsOverlay)
    return () => window.removeEventListener('vexa-viewer-gsps-overlay-saved', handleSavedGspsOverlay)
  }, [currentInstance?.sopInstanceUid, series?.seriesInstanceUid, study?.studyInstanceUid])

  useEffect(() => {
    setCineControlsVisible(false)
  }, [imageIds.length, imageIds[0]])

  useEffect(() => {
    if (activeTool !== 'Stack3DCursor') {
      setStack3dCursorCanvas(null)
    }
  }, [activeTool])

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) {
      return
    }

    initializeCornerstone()

    const renderingEngine = acquireStackRenderingEngine(viewportId)
    renderingEngine.enableElement({
      viewportId,
      element,
      type: Enums.ViewportType.STACK,
    })
    renderingEngineRef.current = renderingEngine
    // Chrome evicts the oldest WebGL context once the per-renderer quota is
    // hit and never restores it, which leaves the tile silently empty. Watch
    // so the loss surfaces as a message instead of a blank image.
    watchRenderingEngineContexts([viewportId])
    const resizeObserver = new ResizeObserver(() => {
      resizeReadyStackViewport(renderingEngine, viewportId, stackReadyRef.current)
    })
    resizeObserver.observe(element)
    const layoutResizeHandler = () => {
      window.requestAnimationFrame(() => {
        resizeReadyStackViewport(renderingEngine, viewportId, stackReadyRef.current)
      })
    }
    window.addEventListener('vexa-viewer-layout-resized', layoutResizeHandler)
    const stackNewImageHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ imageIdIndex?: number }>).detail
      if (Number.isFinite(detail?.imageIdIndex)) {
        const sliceIndex = detail.imageIdIndex as number
        clearPreviewWhenDiagnosticSliceIsVisible(sliceIndex)
        setViewportSliceIndex(viewportKey, sliceIndex)
        scheduleReferenceLinesRefresh(viewportKey)
        if (!applyingLinkedCommandRef.current) {
          const state = useViewerStore.getState()
          broadcastLinkedCommand(viewportKey, 'scroll', 'set-slice', {
            sliceIndex,
            sourceInstance: state.viewportStacks[viewportKey]?.instances[sliceIndex],
          })
        }
      }
    }
    const updateWindowLevelInfo = (sync = false) => {
      const viewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport | undefined
      if (!viewport) {
        return
      }

      const windowLevel = getViewportWindowLevel(viewport)
      setViewportWindowLevel(viewportKey, windowLevel)
      if (sync && !applyingLinkedCommandRef.current) {
        broadcastLinkedCommand(viewportKey, 'windowLevel', 'set-window-level', { windowLevel })
      }
    }
    const imageRenderedHandler = () => {
      updateWindowLevelInfo(false)
      removeProgressivePreview(element)
      clearPreviewWhenDiagnosticSliceIsVisible()
      const renderedSeriesKey = series ? `${series.studyInstanceUid}|${series.seriesInstanceUid}` : ''
      if (renderedSeriesKey && firstRenderedSeriesRef.current !== renderedSeriesKey) {
        firstRenderedSeriesRef.current = renderedSeriesKey
        window.dispatchEvent(new CustomEvent('vexa-viewer-first-image-rendered', {
          detail: { viewportKey, seriesKey: renderedSeriesKey },
        }))
      }
    }
    const refreshViewportOverlays = () => {
      const activeViewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport | undefined
      setCtrCanvasAnnotations(buildCtrCanvasAnnotations(ctrAnnotationsRef.current, activeViewport))
      setTextMarkers(buildTextMarkerCanvasAnnotations(textMarkersRef.current, activeViewport))
      setShapeMarkers(buildShapeMarkerCanvasAnnotations(shapeMarkersRef.current, activeViewport))
      const nextDecorations = buildViewportDisplayDecorations(activeViewport, element)
      // Cornerstone can briefly expose incomplete camera geometry while a new
      // stack image is being committed. Preserve the last valid orientation
      // markers and ruler instead of clearing and recreating the overlay.
      if (nextDecorations) {
        setDisplayDecorations((current) => areViewportDisplayDecorationsEqual(current, nextDecorations) ? current : nextDecorations)
      }
    }
    const voiModifiedHandler = () => updateWindowLevelInfo(true)
    const updateCameraInfo = () => {
      const viewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport | undefined
      if (!viewport || applyingLinkedCommandRef.current) {
        return
      }

      const activeTool = useViewerStore.getState().activeTool
      if (activeTool === 'Zoom') {
        const zoom = viewport.getZoom()
        setViewportZoom(viewportKey, zoom)
        broadcastLinkedCommand(viewportKey, 'zoom', 'set-zoom', { zoom })
      }

      if (activeTool === 'Pan') {
        broadcastLinkedCommand(viewportKey, 'pan', 'set-pan', { camera: viewport.getCamera() as LinkedCamera })
      }
    }
    element.addEventListener(Enums.Events.STACK_NEW_IMAGE, stackNewImageHandler)
    element.addEventListener(Enums.Events.IMAGE_RENDERED, imageRenderedHandler)
    element.addEventListener(Enums.Events.IMAGE_RENDERED, refreshViewportOverlays)
    element.addEventListener(Enums.Events.VOI_MODIFIED, voiModifiedHandler)
    element.addEventListener(Enums.Events.CAMERA_MODIFIED, updateCameraInfo)
    element.addEventListener(Enums.Events.CAMERA_MODIFIED, refreshViewportOverlays)

    const toolGroup = ToolGroupManager.createToolGroup(toolGroupId)
    toolGroup?.addViewport(viewportId, renderingEngineId)
    interactionToolNames.forEach((toolName) => {
      if (toolName === ZoomTool.toolName) {
        toolGroup?.addTool(toolName, {
          configuration: {
            invert: true,
            pinchToZoom: true,
            pan: false,
          },
        })
        return
      }

      if ([RectangleROITool.toolName, CircleROITool.toolName, EllipticalROITool.toolName, PlanarFreehandROITool.toolName].includes(toolName)) {
        toolGroup?.addTool(toolName, {
          configuration: {
            getTextLines: createRoiTextLines(toolName, () => elementRef.current),
          },
        })
        return
      }

      toolGroup?.addTool(toolName)
    })
    toolGroup?.addTool(StackScrollTool.toolName)
    toolGroup?.addTool(ReferenceLinesTool.toolName)
    enableRoiInteriorMove(toolGroup)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('vexa-viewer-layout-resized', layoutResizeHandler)
      element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, stackNewImageHandler)
      element.removeEventListener(Enums.Events.IMAGE_RENDERED, imageRenderedHandler)
      element.removeEventListener(Enums.Events.IMAGE_RENDERED, refreshViewportOverlays)
      element.removeEventListener(Enums.Events.VOI_MODIFIED, voiModifiedHandler)
      element.removeEventListener(Enums.Events.CAMERA_MODIFIED, updateCameraInfo)
      element.removeEventListener(Enums.Events.CAMERA_MODIFIED, refreshViewportOverlays)
      stackPrefetch.disable(element)
      clearRenderedPreviewOverlay()
      ToolGroupManager.destroyToolGroup(toolGroupId)
      releaseStackRenderingEngine(viewportId)
      renderingEngineRef.current = null
    }
  }, [clearPreviewWhenDiagnosticSliceIsVisible, clearRenderedPreviewOverlay, renderingEngineId, setViewportSliceIndex, setViewportWindowLevel, toolGroupId, viewportId, viewportKey])

  useEffect(() => {
    const renderingEngine = renderingEngineRef.current
    if (!renderingEngine || !imageIds.length) {
      stackReadyRef.current = false
      return
    }

    const viewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport
    const element = elementRef.current
    const initialImageIndex = getStackInitialImageIndex(imageIds.length)
    setLoadingMessage('')
    setErrorMessage('')
    const initialImageId = imageIds[initialImageIndex]

    clearRenderedPreviewOverlay()
    if (element) {
      stackPrefetch.disable(element)
    }
    stackReadyRef.current = false
    diagnosticRenderTargetIndexRef.current = initialImageIndex
    rawTargetStartedAtRef.current = performance.now()
    updateDiagnosticImageState('raw-loading', initialImageIndex)

    let cancelled = false
    let cancelNeighborPrewarm: (() => void) | undefined

    const loadStack = async () => {
      if (element) {
        const hasSize = await waitForRenderableViewportElement(element)
        if (!hasSize || cancelled) {
          return
        }
      }

      requestRenderedPreviewOverlay(initialImageIndex)
      primeStackImagesForDisplay(imageIds, initialImageIndex)
      if (cancelled) {
        return
      }

      await viewport.setStack(imageIds, initialImageIndex)
      if (cancelled) {
        return
      }

      try {
        renderingEngine.resize(true, false)
      } catch {
        // Resize can race with layout changes; the ResizeObserver will retry.
      }

      if (!isRenderableViewportElement(element)) {
        const hasSize = element ? await waitForRenderableViewportElement(element) : false
        if (!hasSize || cancelled) {
          return
        }
      }

        applyDefaultImageProperties(viewport, initialImageId, modality)
        viewport.resetCamera()
        setViewportZoom(viewportKey, viewport.getZoom())
        setViewportWindowLevel(viewportKey, getViewportWindowLevel(viewport))
        viewport.render()
        setCtrAnnotations([])
        ctrAnnotationsRef.current = []
        setCtrCanvasAnnotations([])
        textMarkersRef.current = []
        shapeMarkersRef.current = []
        setTextMarkers([])
        setShapeMarkers([])
        setTextMarkerDraft(null)
        setShapeMarkerDraft(null)
        setViewportSliceIndex(viewportKey, initialImageIndex)
        targetSliceIndexRef.current = initialImageIndex
        scheduledSliceIndexRef.current = null
        stackReadyRef.current = true
        setStackReadyTick((tick) => tick + 1)
        resizeReadyStackViewport(renderingEngine, viewportId, true)
        if (series?.seriesInstanceUid) {
          onReadyRef.current?.(viewportKey, series.seriesInstanceUid)
        }

        if (element && imageIds.length > 1 && import.meta.env.VITE_STACK_PREFETCH_ENABLED === 'true') {
          stackPrefetch.setConfiguration({
            maxImagesToPrefetch: Math.min(imageIds.length - 1, 4),
            preserveExistingPool: false,
            order: 'closest',
          })
          stackPrefetch.enable(element)
        }
        cancelNeighborPrewarm = prewarmStackNeighbors(imageIds, initialImageIndex, { radius: stackRawPrewarmRadius, timeoutMs: 8_000 })
        warmRenderedStackAround(initialImageIndex, stackInitialRenderedWarmRadius)
    }

    void loadStack()
      .catch((error: unknown) => {
        setErrorMessage(formatRenderError(error, initialImageId))
        removeProgressivePreview(element)
      })
      .finally(() => {
        setLoadingMessage('')
      })

    return () => {
      cancelled = true
      cancelNeighborPrewarm?.()
    }
  }, [clearRenderedPreviewOverlay, imageIds, instances, modality, requestRenderedPreviewOverlay, setErrorMessage, setLoadingMessage, setViewportSliceIndex, setViewportWindowLevel, setViewportZoom, updateDiagnosticImageState, viewportId, viewportKey, warmRenderedStackAround])

  useEffect(() => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId)
    if (!toolGroup) {
      return
    }

    const renderingEngine = renderingEngineRef.current
    const viewport = renderingEngine?.getViewport(viewportId) as Types.IStackViewport | undefined

    if (activeTool === 'Reset') {
      if (viewport && stackReadyRef.current && imageIds.length && isRenderableViewportElement(elementRef.current)) {
        viewport.resetCamera()
        applyDefaultImageProperties(viewport, imageIds[0], modality)
        viewport.render()
      }
      setActiveTool('WindowLevel')
      return
    }

    if (!stackReadyRef.current || !isRenderableViewportElement(elementRef.current)) {
      return
    }

    manipulationToolNames.forEach((toolName) => toolGroup.setToolDisabled(toolName))
    annotationToolNames.forEach((toolName) => toolGroup.setToolPassive(toolName, { removeAllBindings: true }))
    if (activeTool === 'ICHSegment' || activeTool === 'ICHEraser') {
      toolGroup.setToolDisabled(BrushTool.toolName)
      toolGroup.setToolDisabled(EraserTool.toolName)
    // ProbeTool is handled via custom DOM events for press-and-hold live HU readout
    } else if (activeTool === 'Probe') {
      toolGroup.setToolDisabled(ProbeTool.toolName)
    } else {
      const activeToolName = toolNameById[activeTool]
      if (activeToolName) {
        toolGroup.setToolActive(activeToolName, {
          bindings: getToolBindings(activeToolName),
        })
      }
    }
    if (imageIds.length > 0) {
      toolGroup.setToolActive(StackScrollTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
      })
    } else {
      toolGroup.setToolDisabled(StackScrollTool.toolName)
    }

    if (activeTool === 'Stack3DCursor') {
      return
    }
  }, [activeTool, imageIds, modality, series?.seriesInstanceUid, setActiveTool, stackReadyTick, toolGroupId, viewportId])

  // Live Probe: press-and-hold to read HU value at cursor without placing annotation
  useEffect(() => {
    if (activeTool !== 'Probe') {
      setLiveProbeValue(null)
      liveProbePointerIdRef.current = null
      return
    }

    const element = elementRef.current
    if (!element || !stackReadyRef.current) {
      return
    }

    const readPixelAtCanvas = (canvasPoint: Types.Point2): LiveProbeValue | null => {
      const renderingEngine = renderingEngineRef.current
      const viewport = renderingEngine?.getViewport(viewportId) as Types.IStackViewport | undefined
      if (!viewport) return null

      const imageData = viewport.getImageData()
      if (!imageData?.dimensions) return null

      const worldPos = viewport.canvasToWorld(canvasPoint)
      const { imageData: vtkImage } = imageData
      if (!vtkImage) return null

      // Use vtkImageData.worldToIndex
      const index = (vtkImage as { worldToIndex?: (point: number[]) => number[] }).worldToIndex?.([worldPos[0], worldPos[1], worldPos[2]])
      if (!index || !Number.isFinite(index[0]) || !Number.isFinite(index[1])) return null

      const [col, row] = index
      const cols = imageData.dimensions[0]
      const rows = imageData.dimensions[1]
      if (col < 0 || col >= cols || row < 0 || row >= rows) return null

      const pointIJK: Types.Point3 = [Math.floor(col), Math.floor(row), 0]
      const pixelIndex = pointIJK[1] * cols + pointIJK[0]
      const voxelValue = imageData.voxelManager?.getAtIJKPoint(pointIJK)
      const pixelValue = voxelValue ?? imageData.scalarData?.[pixelIndex]
      const rawValue = Number(Array.isArray(pixelValue) ? pixelValue[0] : pixelValue)
      if (!Number.isFinite(rawValue)) return null

      // Cornerstone 5 may expose already-scaled voxels. Apply rescale only to
      // original stored values so CT numbers are not transformed twice.
      const scaling = imageData.scaling as { rescaleSlope?: number | string; rescaleIntercept?: number | string } | undefined
      const alreadyScaled = Boolean(imageData.preScale?.scaled)
      const slope = alreadyScaled ? 1 : Number(scaling?.rescaleSlope ?? 1) || 1
      const intercept = alreadyScaled ? 0 : Number(scaling?.rescaleIntercept ?? 0) || 0
      const modalityStr = modality?.toUpperCase() ?? ''

      let displayValue = rawValue * slope + intercept
      let unit = modalityStr
      let note = ''

      if (modalityStr === 'CT') {
        unit = 'HU'
      } else if (modalityStr === 'PT') {
        // SUV usually handled by cornerstone
        note = rawValue.toFixed(2)
        displayValue = rawValue
      }

      return {
        canvasPoint,
        value: displayValue,
        unit,
        note,
      }
    }

    readLiveProbeAtCanvasRef.current = readPixelAtCanvas

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      element.setPointerCapture(event.pointerId)
      liveProbePointerIdRef.current = event.pointerId

      const rect = element.getBoundingClientRect()
      const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
      setLiveProbeValue(readPixelAtCanvas(canvasPoint))
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (liveProbePointerIdRef.current !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()

      const rect = element.getBoundingClientRect()
      const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
      setLiveProbeValue(readPixelAtCanvas(canvasPoint))
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (liveProbePointerIdRef.current !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      liveProbePointerIdRef.current = null
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId)
      }
      setLiveProbeValue(null)
    }

    element.addEventListener('pointerdown', handlePointerDown)
    element.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      element.removeEventListener('pointerdown', handlePointerDown)
      element.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      liveProbePointerIdRef.current = null
      if (readLiveProbeAtCanvasRef.current === readPixelAtCanvas) {
        readLiveProbeAtCanvasRef.current = null
      }
    }
  }, [activeTool, imageIds, modality, stackReadyTick, toolGroupId, viewportId])

  useEffect(() => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId)
    if (!toolGroup) {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!stackReadyRef.current || !viewport || !isRenderableViewportElement(elementRef.current)) {
      return
    }

    if (!imageIds.length || viewportLayout === '1x1' || !referenceLinesEnabled) {
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
      viewport.render()
      return
    }

    try {
      toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
        sourceViewportId: `nexia-stack-viewport-${selectedViewportKey}`,
        enforceSameFrameOfReference: false,
        showFullDimension: true,
      })
      toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
      viewport.render()
    } catch {
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
    }
  }, [imageIds.length, referenceLinesEnabled, selectedViewportKey, stackReadyTick, toolGroupId, viewportId, viewportLayout])

  useEffect(() => {
    const renderingEngine = renderingEngineRef.current
    const viewport = renderingEngine?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!stack3dCursor || !viewport || !stackReadyRef.current || !imageIds.length) {
      return
    }

    const applyCursorToViewport = async () => {
      if (stack3dCursor.sourceViewportKey !== viewportKey) {
        const state = useViewerStore.getState()
        const targetStack = state.viewportStacks[viewportKey]
        const targetIndex = getNearestImageIndexForWorldPoint(targetStack?.instances ?? [], stack3dCursor.worldPoint)
        const currentIndex = state.viewportSliceIndexes[viewportKey] ?? 0

        if (typeof targetIndex === 'number' && targetIndex !== currentIndex) {
          applyingLinkedCommandRef.current = true
          await (viewport as Types.IStackViewport & { setImageIdIndex: (imageIdIndex: number) => Promise<string> }).setImageIdIndex(targetIndex)
          setViewportSliceIndex(viewportKey, targetIndex)
          applyingLinkedCommandRef.current = false
        }
      }

      setStack3dCursorCanvas(null)
      viewport.render()
    }

    void applyCursorToViewport().catch(() => {
      applyingLinkedCommandRef.current = false
      setStack3dCursorCanvas(null)
    })
  }, [imageIds.length, setViewportSliceIndex, stack3dCursor, viewportId, viewportKey])

  useEffect(() => {
    if (!isSelected) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return
      }

      const selectedCtrAnnotationId = selectedCtrAnnotationIdRef.current
      if (selectedCtrAnnotationId) {
        const nextCtrAnnotations = ctrAnnotationsRef.current.filter((annotation) => annotation.id !== selectedCtrAnnotationId)
        ctrAnnotationsRef.current = nextCtrAnnotations
        selectedCtrAnnotationIdRef.current = null
        setSelectedCtrAnnotationId(null)
        setCtrAnnotations(nextCtrAnnotations)
        setCtrCanvasAnnotations(buildCtrCanvasAnnotations(nextCtrAnnotations, renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined))
        event.preventDefault()
        return
      }

      if (deleteSelectedCustomMarker()) {
        deleteCurrentSavedGsps()
        event.preventDefault()
        return
      }

      const deleted = deleteSelectedAnnotations(false)
      if (deleted > 0) {
        deleteCurrentSavedGsps()
        event.preventDefault()
        renderingEngineRef.current?.getViewport(viewportId)?.render()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [currentInstance?.sopInstanceUid, isSelected, series?.seriesInstanceUid, study?.studyInstanceUid, viewportId])

  useEffect(() => {
    const renderingEngine = renderingEngineRef.current
    if (!renderingEngine || !viewportCommand || viewportCommand.targetViewportKey !== viewportKey) {
      return
    }

    const viewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport
    if (!stackReadyRef.current || !imageIds.length) {
      return
    }
    if (processedViewportCommandIdRef.current === viewportCommand.id) {
      return
    }
    processedViewportCommandIdRef.current = viewportCommand.id

    if (viewportCommand.type === 'reset') {
      clearAllAnnotations()
      deleteCurrentSavedGsps()
      viewport.resetCamera()
      applyDefaultImageProperties(viewport, imageIds[0], modality)
      setViewportZoom(viewportKey, viewport.getZoom())
      setViewportWindowLevel(viewportKey, getViewportWindowLevel(viewport))
      viewport.render()
      return
    }

    if (viewportCommand.type === 'set-slice') {
      const sliceIndex = viewportCommand.sliceIndex
      if (typeof sliceIndex === 'number') {
        applyingLinkedCommandRef.current = Boolean(viewportCommand.sourceViewportKey)
        void (viewport as Types.IStackViewport & { setImageIdIndex: (imageIdIndex: number) => Promise<string> })
          .setImageIdIndex(sliceIndex)
          .finally(() => scheduleReferenceLinesRefresh(viewportKey))
        setViewportSliceIndex(viewportKey, sliceIndex)
        window.setTimeout(() => { applyingLinkedCommandRef.current = false }, 0)
        if (!viewportCommand.sourceViewportKey) {
          broadcastLinkedCommand(viewportKey, 'scroll', 'set-slice', {
            sliceIndex,
            sourceInstance: useViewerStore.getState().viewportStacks[viewportKey]?.instances[sliceIndex],
          })
        }
      }
      return
    }

    if (viewportCommand.type === 'toggle-cine') {
      const canPlay = imageIds.length > 1
      const now = Date.now()
      const isDoubleSpaceStop = canPlay
        && cineControlsVisible
        && now - lastCineSpaceToggleAtRef.current <= cineDoubleSpaceStopMs
      lastCineSpaceToggleAtRef.current = now

      if (isDoubleSpaceStop) {
        setViewportCinePlaying(viewportKey, false)
        setCineControlsVisible(false)
        lastCineSpaceToggleAtRef.current = 0
        return
      }

      const currentlyPlaying = Boolean(useViewerStore.getState().viewportCinePlaying[viewportKey])
      setViewportCinePlaying(viewportKey, canPlay && !currentlyPlaying)
      setCineControlsVisible(canPlay)
      return
    }

    if (viewportCommand.type === 'set-zoom') {
      const nextZoom = viewportCommand.zoom
      if (typeof nextZoom === 'number') {
        applyingLinkedCommandRef.current = Boolean(viewportCommand.sourceViewportKey)
        viewport.setZoom(nextZoom)
        setViewportZoom(viewportKey, nextZoom)
        viewport.render()
        window.setTimeout(() => { applyingLinkedCommandRef.current = false }, 0)
        if (!viewportCommand.sourceViewportKey) {
          broadcastLinkedCommand(viewportKey, 'zoom', 'set-zoom', { zoom: nextZoom })
        }
      }
      return
    }

    if (viewportCommand.type === 'set-pan') {
      const camera = viewportCommand.camera
      if (camera) {
        applyingLinkedCommandRef.current = Boolean(viewportCommand.sourceViewportKey)
        viewport.setCamera(camera as Types.ICamera)
        viewport.render()
        window.setTimeout(() => { applyingLinkedCommandRef.current = false }, 0)
        if (!viewportCommand.sourceViewportKey) {
          broadcastLinkedCommand(viewportKey, 'pan', 'set-pan', { camera })
        }
      }
      return
    }

    if (viewportCommand.type === 'set-window-level') {
      const windowLevel = viewportCommand.windowLevel
      if (windowLevel) {
        applyingLinkedCommandRef.current = Boolean(viewportCommand.sourceViewportKey)
        viewport.setProperties({ voiRange: toVoiRange(windowLevel) })
        setViewportWindowLevel(viewportKey, windowLevel)
        viewport.render()
        window.setTimeout(() => { applyingLinkedCommandRef.current = false }, 0)
        if (!viewportCommand.sourceViewportKey) {
          broadcastLinkedCommand(viewportKey, 'windowLevel', 'set-window-level', { windowLevel })
        }
      }
      return
    }

    if (viewportCommand.type === 'delete-annotation') {
      const selectedCtrAnnotationId = selectedCtrAnnotationIdRef.current
      if (selectedCtrAnnotationId && window.confirm('Do You want to delete this annot?')) {
        const nextCtrAnnotations = ctrAnnotationsRef.current.filter((annotation) => annotation.id !== selectedCtrAnnotationId)
        ctrAnnotationsRef.current = nextCtrAnnotations
        selectedCtrAnnotationIdRef.current = null
        setSelectedCtrAnnotationId(null)
        setCtrAnnotations(nextCtrAnnotations)
        setCtrCanvasAnnotations(buildCtrCanvasAnnotations(nextCtrAnnotations, viewport))
        return
      }

      if (selectedCustomMarkerRef.current && window.confirm('Do You want to delete this annot?')) {
        deleteSelectedCustomMarker()
        deleteCurrentSavedGsps()
        return
      }

      if (deleteSelectedAnnotations(true) > 0) {
        deleteCurrentSavedGsps()
        viewport.render()
      }
      return
    }

    if (viewportCommand.type === 'invert') {
      const properties = viewport.getProperties() as { invert?: boolean }
      viewport.setProperties({ invert: !properties.invert })
      viewport.render()
      return
    }

    if (viewportCommand.type === 'spatial-flip-horizontal' || viewportCommand.type === 'spatial-flip-vertical') {
      const camera = viewport.getCamera() as Types.ICamera & { flipHorizontal?: boolean; flipVertical?: boolean }
      viewport.setCamera({
        flipHorizontal: viewportCommand.type === 'spatial-flip-horizontal' ? !camera.flipHorizontal : camera.flipHorizontal,
        flipVertical: viewportCommand.type === 'spatial-flip-vertical' ? !camera.flipVertical : camera.flipVertical,
      })
      viewport.render()
      return
    }

    if (viewportCommand.type === 'spatial-rotate-cw' || viewportCommand.type === 'spatial-rotate-ccw' || viewportCommand.type === 'spatial-rotate-180') {
      const delta = viewportCommand.type === 'spatial-rotate-cw' ? 90 : viewportCommand.type === 'spatial-rotate-ccw' ? -90 : 180
      const nextRotation = normalizeRotation((viewport.getRotation?.() ?? 0) + delta)
      ;(viewport as Types.IStackViewport & { setRotation?: (rotation: number) => void }).setRotation?.(nextRotation)
      viewport.render()
      return
    }

    if (viewportCommand.type === 'spatial-zoom-fit') {
      viewport.resetCamera()
      const nextZoom = viewport.getZoom()
      setViewportZoom(viewportKey, nextZoom)
      viewport.render()
      broadcastLinkedCommand(viewportKey, 'zoom', 'set-zoom', { zoom: nextZoom })
      return
    }

    if (viewportCommand.type === 'spatial-zoom-1x' || viewportCommand.type === 'spatial-zoom-input') {
      const scale = viewportCommand.type === 'spatial-zoom-input' && typeof viewportCommand.zoom === 'number'
        ? viewportCommand.zoom
        : 1
      const displayAreaViewport = viewport as Types.IStackViewport & {
        setDisplayArea?: (displayArea: { type: 'SCALE'; scale: number; storeAsInitialCamera?: boolean }) => void
      }

      displayAreaViewport.setDisplayArea?.({ type: 'SCALE', scale, storeAsInitialCamera: false })
      viewport.render()
      setViewportZoom(viewportKey, viewport.getZoom())
      return
    }

    if (viewportCommand.type === 'zoom-in' || viewportCommand.type === 'zoom-out') {
      const currentZoom = viewport.getZoom()
      const factor = viewportCommand.type === 'zoom-in' ? 1.25 : 0.8
      const nextZoom = Math.min(Math.max(currentZoom * factor, 0.1), 20)
      viewport.setZoom(nextZoom)
      setViewportZoom(viewportKey, nextZoom)
      viewport.render()
      broadcastLinkedCommand(viewportKey, 'zoom', 'set-zoom', { zoom: nextZoom })
      return
    }

    if (viewportCommand.type === 'save-secondary-capture') {
      if (processedSaveCommandIdRef.current === viewportCommand.id) {
        return
      }
      processedSaveCommandIdRef.current = viewportCommand.id
      window.dispatchEvent(new CustomEvent('vexa-viewer-open-viewport-capture', {
        detail: { viewportKey },
      }))
      return
    }

    if (viewportCommand.type === 'save-gsps') {
      if (processedSaveCommandIdRef.current === viewportCommand.id) {
        return
      }
      processedSaveCommandIdRef.current = viewportCommand.id
      const element = elementRef.current
      if (!element) return
      const graphics = collectSaveGraphics(viewport, element, {
        textMarkers: textMarkersRef.current,
        shapeMarkers: shapeMarkersRef.current,
      })
      const savedAnnotations = collectSavedAnnotationSnapshots(element)
      const saveContext = {
        study,
        series,
        instance: currentInstance,
        viewportSize: {
          width: Math.max(1, Math.round(element.clientWidth)),
          height: Math.max(1, Math.round(element.clientHeight)),
        },
        graphics,
        annotations: savedAnnotations,
      }
      setLoadingMessage('Saving GSPS annotations...')
      setErrorMessage('')
      void saveGspsPresentationState(saveContext)
        .then(() => setLoadingMessage('GSPS annotations saved.'))
        .catch((error: unknown) => setErrorMessage(error instanceof Error ? error.message : 'Unable to save DICOM object.'))
        .finally(() => window.setTimeout(() => setLoadingMessage(''), 1800))
      return
    }

    const preset = getWindowPreset(viewportCommand.type)
    if (preset) {
      viewport.setProperties({ voiRange: preset })
      const windowLevel = getViewportWindowLevel(viewport)
      setViewportWindowLevel(viewportKey, windowLevel)
      viewport.render()
      broadcastLinkedCommand(viewportKey, 'windowLevel', 'set-window-level', { windowLevel })
    }
  }, [cineControlsVisible, currentInstance, imageIds, modality, series, setErrorMessage, setLoadingMessage, setViewportCinePlaying, setViewportSliceIndex, setViewportWindowLevel, setViewportZoom, study, viewportCommand, viewportId, viewportKey])

  useEffect(() => {
    if (!cinePlaying || imageIds.length < 2) {
      if (cinePlaying && imageIds.length < 2) {
        setViewportCinePlaying(viewportKey, false)
      }
      return
    }

    const frameDelay = Math.max(16, Math.round(1000 / effectiveCineFps))
    const timer = window.setInterval(() => {
      const state = useViewerStore.getState()
      const currentIndex = state.viewportSliceIndexes[viewportKey] ?? 0
      const nextSliceIndex = (currentIndex + cineDirection + imageIds.length) % imageIds.length
      void jumpToSliceIndex(nextSliceIndex, { immediate: true })
    }, frameDelay)

    return () => {
      window.clearInterval(timer)
      cineBusyRef.current = false
    }
  }, [cineDirection, cinePlaying, effectiveCineFps, imageIds.length, jumpToSliceIndex, setViewportCinePlaying, viewportKey])

  useEffect(() => {
    function resetTransientToolAfterAnnotation(event: Event) {
      const element = elementRef.current
      if (element) {
        enhanceRoiCachedStats(element)
      }

      if (!isTransientTool(activeTool)) {
        return
      }

      const annotation = (event as CustomEvent<{ annotation?: { metadata?: { toolName?: string } } }>).detail?.annotation
      const completedToolName = annotation?.metadata?.toolName
      if (completedToolName && completedToolName !== toolNameById[activeTool]) {
        return
      }

      window.setTimeout(() => {
        if (useViewerStore.getState().activeTool === activeTool) {
          setActiveTool('WindowLevel')
        }
      }, 0)
    }

    eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientToolAfterAnnotation)

    return () => {
      eventTarget.removeEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientToolAfterAnnotation)
    }
  }, [activeTool, setActiveTool])

  useEffect(() => {
    function handleDocumentMouseDown(event: MouseEvent) {
      if (contextMenu && !contextMenuRef.current?.contains(event.target as Node)) {
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handleDocumentMouseDown)

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!isSelected) {
      return
    }

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (isEditableEventTarget(event.target)) {
        return
      }

      if (event.key === 'Escape' && contextMenu) {
        event.preventDefault()
        setContextMenu(null)
        return
      }

      const hotkey = toHotkey(event)
      const action = createHotkeyActions(hotkeyOverrides, hasPermission, modality).get(hotkey)
      if (!action) {
        return
      }

      event.preventDefault()
      runViewportMenuAction(action)
    }

    document.addEventListener('keydown', handleDocumentKeyDown)

    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown)
    }
  }, [contextMenu, hasPermission, hotkeyOverrides, isSelected, modality, onOpenAmbientTest, onOpenIchMprWorkspace, onOpenTagBrowser, onToggle3d, onToggle3dBone, onToggleMpr, onToggleOverlay, referenceLinesEnabled, sendViewportCommand, setActiveTool, setReferenceLinesEnabled, viewportKey])

  function runViewportMenuAction(action: ViewportMenuAction) {
    suppressViewportPointerUntilRef.current = Date.now() + 250

    if (action.type === 'tool') {
      if (action.tool === 'ICHSegment') {
        onSelect?.()
        const normalizedModality = modality.toUpperCase()
        if (normalizedModality !== 'CT' && normalizedModality !== 'MR') {
          setErrorMessage('ICH segmentation requires a CT or MR series.')
          setContextMenu(null)
          return
        }
        onOpenIchMprWorkspace?.()
        setContextMenu(null)
        return
      }

      setActiveTool(activeTool === action.tool ? 'WindowLevel' : action.tool)
      setContextMenu(null)
      return
    }

    if (action.type === 'command') {
      sendViewportCommand(action.command as Parameters<typeof sendViewportCommand>[0], viewportKey)
      setContextMenu(null)
      return
    }

    if (action.type === 'reference-lines') {
      setReferenceLinesEnabled(!referenceLinesEnabled)
      setContextMenu(null)
      return
    }

    if (action.type === 'custom') {
      onSelect?.()
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
      setContextMenu(null)
      return
    }

    setContextMenu(null)
  }

  function deleteCurrentSavedGsps() {
    if (!study?.studyInstanceUid || !series?.seriesInstanceUid || !currentInstance?.sopInstanceUid) {
      return false
    }

    restoredGspsAnnotationKeysRef.current.clear()
    setGspsOverlays([])
    return deleteSavedGspsOverlays(study.studyInstanceUid, series.seriesInstanceUid, currentInstance.sopInstanceUid)
  }

  function openViewportContextMenu(clientX: number, clientY: number) {
    const menuWidth = 474
    const menuHeight = 270
    const x = Math.min(Math.max(clientX, 8), Math.max(8, window.innerWidth - menuWidth - 8))
    const y = Math.min(Math.max(clientY, 8), Math.max(8, window.innerHeight - menuHeight - 8))
    setActiveContextSection(permittedMenuSections[0]?.title ?? '')
    setContextMenu({ x, y })
  }

  function startModifierGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (!event.ctrlKey && !event.shiftKey)) {
      return false
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !stackReadyRef.current || !imageIds.length) {
      return false
    }

    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)

    if (event.ctrlKey) {
      modifierGestureRef.current = {
        type: 'zoom',
        pointerId: event.pointerId,
        startY: event.clientY,
        startZoom: viewport.getZoom(),
      }
      return true
    }

    const rect = element.getBoundingClientRect()
    modifierGestureRef.current = {
      type: 'pan',
      pointerId: event.pointerId,
      lastCanvasPoint: [event.clientX - rect.left, event.clientY - rect.top],
    }
    return true
  }

  function updateModifierGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = modifierGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return false
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !stackReadyRef.current) {
      return true
    }

    event.stopPropagation()

    if (gesture.type === 'zoom') {
      const deltaY = gesture.startY - event.clientY
      const nextZoom = Math.min(Math.max(gesture.startZoom * Math.exp(deltaY * 0.012), 0.1), 20)
      viewport.setZoom(nextZoom)
      setViewportZoom(viewportKey, nextZoom)
      viewport.render()
      broadcastLinkedCommand(viewportKey, 'zoom', 'set-zoom', { zoom: nextZoom })
      return true
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
      ...(focalPoint ? { focalPoint: addWorldDelta(focalPoint, delta) } : {}),
      ...(position ? { position: addWorldDelta(position, delta) } : {}),
    })
    viewport.render()
    modifierGestureRef.current = { ...gesture, lastCanvasPoint: currentCanvasPoint }
    broadcastLinkedCommand(viewportKey, 'pan', 'set-pan', { camera: viewport.getCamera() as LinkedCamera })

    return true
  }

  function getPreviewCanvasPoint(event: { clientX: number; clientY: number }): Types.Point2 | null {
    const element = elementRef.current
    if (!element) {
      return null
    }

    const rect = element.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  function requestDiagnosticPixelsForTarget(targetIndex: number) {
    if (diagnosticRenderTargetIndexRef.current !== targetIndex) {
      diagnosticRenderTargetIndexRef.current = targetIndex
      rawTargetStartedAtRef.current = performance.now()
      updateDiagnosticImageState('raw-loading', targetIndex)
    }

    if (scheduledSliceIndexRef.current === null && targetSliceIndexRef.current === targetIndex) {
      scheduledSliceIndexRef.current = targetIndex
      scheduleSliceCommit(true)
    }
  }

  function handlePreviewPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onSelect?.()
    const targetIndex = targetSliceIndexRef.current ?? displayedSliceIndex
    const canvasPoint = getPreviewCanvasPoint(event)
    if (!canvasPoint) {
      return
    }

    requestDiagnosticPixelsForTarget(targetIndex)
    const tool = previewDraftToolIds.has(activeTool as PreviewDraftToolId)
      ? activeTool as PreviewDraftToolId
      : null
    if (!tool) {
      if (activeTool === 'Probe') {
        deferredPreviewProbeRef.current = { targetIndex, canvasPoint }
        setPreviewToolStatus('Preparing HU values...')
      } else {
        setPreviewToolStatus('Preparing diagnostic pixels...')
      }
      return
    }

    const element = elementRef.current
    const rect = element?.getBoundingClientRect()
    if (!rect) {
      return
    }

    const draft: PreviewToolDraft = {
      tool,
      targetIndex,
      pointerId: event.pointerId,
      startCanvasPoint: canvasPoint,
      endCanvasPoint: canvasPoint,
      viewportSize: { width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    replacePreviewToolDraft(draft)
    setPreviewToolStatus('Preparing measurement...')
  }

  function handlePreviewPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const draft = previewToolDraftRef.current
    if (!draft || draft.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const canvasPoint = getPreviewCanvasPoint(event)
    if (!canvasPoint) {
      return
    }

    replacePreviewToolDraft({ ...draft, endCanvasPoint: canvasPoint })
  }

  function handlePreviewPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const draft = previewToolDraftRef.current
    if (!draft || draft.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const canvasPoint = getPreviewCanvasPoint(event)
    if (canvasPoint) {
      replacePreviewToolDraft({ ...draft, endCanvasPoint: canvasPoint })
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function commitPreviewToolDraftIfReady() {
    const draft = previewToolDraftRef.current
    if (!draft || diagnosticImageStateRef.current !== 'raw-ready') {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const currentIndex = viewport ? getCurrentStackImageIndex(viewport, viewportKey) : -1
    if (!viewport || currentIndex !== draft.targetIndex) {
      clearPreviewToolDraft()
      return
    }

    const dx = draft.endCanvasPoint[0] - draft.startCanvasPoint[0]
    const dy = draft.endCanvasPoint[1] - draft.startCanvasPoint[1]
    if (Math.hypot(dx, dy) < 4) {
      clearPreviewToolDraft()
      return
    }

    const startWorld = viewport.canvasToWorld(draft.startCanvasPoint) as Types.Point3
    const endWorld = viewport.canvasToWorld(draft.endCanvasPoint) as Types.Point3
    try {
      if (draft.tool === 'Length') {
        LengthTool.hydrate(viewportId, [startWorld, endWorld])
      } else if (draft.tool === 'CircleROI') {
        CircleROITool.hydrate(viewportId, [startWorld, endWorld])
      } else if (draft.tool === 'RectangleROI') {
        RectangleROITool.hydrate(viewportId, [startWorld, endWorld])
      } else if (draft.tool === 'EllipticalROI') {
        EllipticalROITool.hydrate(viewportId, [startWorld, endWorld])
      } else {
        const markerType: ShapeMarkerAnnotation['type'] = draft.tool === 'ArrowMarker' ? 'arrow' : 'circle'
        const nextMarkers: ShapeMarkerAnnotation[] = [...shapeMarkersRef.current, {
          id: `${markerType}-marker-${shapeMarkerIdRef.current++}`,
          type: markerType,
          startWorldPosition: startWorld,
          endWorldPosition: endWorld,
        }]
        shapeMarkersRef.current = nextMarkers
        setShapeMarkers(buildShapeMarkerCanvasAnnotations(nextMarkers, viewport))
      }
      setActiveTool('WindowLevel')
      dispatchDiagnosticViewportTelemetry('vexa-viewer-preview-tool-committed', {
        viewportKey,
        seriesKey: series ? `${series.studyInstanceUid}|${series.seriesInstanceUid}` : '',
        targetIndex: draft.targetIndex,
      })
    } catch (error) {
      console.warn('Unable to commit preview measurement to diagnostic pixels.', error)
      setErrorMessage('The preview measurement could not be transferred to the diagnostic image.')
    } finally {
      clearPreviewToolDraft()
    }
  }

  function revealDeferredPreviewProbeIfReady() {
    const pendingProbe = deferredPreviewProbeRef.current
    if (!pendingProbe || diagnosticImageStateRef.current !== 'raw-ready') {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!viewport || getCurrentStackImageIndex(viewport, viewportKey) !== pendingProbe.targetIndex) {
      deferredPreviewProbeRef.current = null
      return
    }

    deferredPreviewProbeRef.current = null
    const probeValue = readLiveProbeAtCanvasRef.current?.(pendingProbe.canvasPoint) ?? null
    if (probeValue) {
      setLiveProbeValue(probeValue)
      window.setTimeout(() => setLiveProbeValue(null), 2_200)
    }
    setPreviewToolStatus('')
  }

  function handlePointerDownEvent(event: React.PointerEvent<HTMLDivElement>) {
    if (Date.now() < suppressViewportPointerUntilRef.current) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (event.button !== 0) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    onSelect?.()
    event.currentTarget.focus({ preventScroll: true })
    setContextMenu(null)

    if (diagnosticImageStateRef.current !== 'raw-ready') {
      event.preventDefault()
      event.stopPropagation()
      const targetIndex = targetSliceIndexRef.current ?? displayedSliceIndex
      requestDiagnosticPixelsForTarget(targetIndex)
      setPreviewToolStatus(activeTool === 'Probe' ? 'Preparing HU values...' : 'Preparing diagnostic pixels...')
      return
    }

    if ((activeTool === 'ICHSegment' || activeTool === 'ICHEraser') && !ichSegmentationId) {
      onOpenIchMprWorkspace?.()
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (startModifierGesture(event)) {
      return
    }

    if (ichSeedMode) {
      handleStackIchSeedClick(event)
      return
    }

    // Lasso magnetik: mode poligon menambah titik, mode geser menyeret garis tepi.
    if (ichLassoMode === 'polygon') {
      handleStackIchLassoClick(event)
      return
    }

    if (ichLassoMode === 'drag') {
      if (!startStackIchLassoDrag(event)) {
        setErrorMessage('Create the mask first (Grow Slice or Mask Stack), then drag its boundary.')
      }
      return
    }

    if (startStackIchSmartDrag(event)) {
      return
    }

    updateStack3dCursorScreenDot(event)
    const ctrHit = findCtrResultHit(event)
    if (ctrHit) {
      event.preventDefault()
      event.stopPropagation()
      selectedCtrAnnotationIdRef.current = ctrHit.id
      setSelectedCtrAnnotationId(ctrHit.id)
      ctrTextDragRef.current = { annotationId: ctrHit.id, pointerId: event.pointerId }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    const customMarkerHit = findCustomMarkerHit(event)
    if (customMarkerHit) {
      const worldPosition = getPointerWorldPosition(event)
      if (!worldPosition) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      selectedCustomMarkerRef.current = customMarkerHit
      setSelectedCustomMarker(customMarkerHit)
      customMarkerDragRef.current = { marker: customMarkerHit, pointerId: event.pointerId, lastWorldPosition: worldPosition }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    selectedCtrAnnotationIdRef.current = null
    setSelectedCtrAnnotationId(null)
    selectedCustomMarkerRef.current = null
    setSelectedCustomMarker(null)

    if (activeTool === 'CTR4Point') {
      addCtrPoint(event)
      return
    }

    if (activeTool === 'Stack3DCursor') {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      stack3dCursorDragRef.current = { pointerId: event.pointerId }
      placeStack3dCursor(event)
      return
    }

    if (activeTool === 'TextMarker') {
      addTextMarkerDraft(event)
      return
    }

    if (activeTool === 'ArrowMarker' || activeTool === 'CircleMarker') {
      startShapeMarker(event, activeTool === 'ArrowMarker' ? 'arrow' : 'circle')
      return
    }

    if (activeTool === 'Scroll') {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      scrollGestureRef.current = { pointerId: event.pointerId, y: event.clientY, sliceIndex: viewportSliceIndex }
    }
  }

  function handleViewportDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    onSelect?.()
    onToggleViewportFullscreen?.()
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (updateModifierGesture(event)) {
      return
    }

    if (updateStackIchLassoDrag(event)) {
      return
    }

    if (updateStackIchSmartDrag(event)) {
      return
    }

    updateStack3dCursorScreenDot(event)

    if (stack3dCursorDragRef.current?.pointerId === event.pointerId) {
      placeStack3dCursor(event)
      return
    }

    if (ctrTextDragRef.current?.pointerId === event.pointerId) {
      moveCtrResultText(event, ctrTextDragRef.current.annotationId)
      return
    }

    if (shapeMarkerDraft && (activeTool === 'ArrowMarker' || activeTool === 'CircleMarker')) {
      updateShapeMarkerDraft(event)
      return
    }

    if (customMarkerDragRef.current?.pointerId === event.pointerId) {
      moveCustomMarker(event)
      return
    }

    if (activeTool !== 'Scroll' || !scrollGestureRef.current || scrollGestureRef.current.pointerId !== event.pointerId) {
      return
    }

    if (!stackReadyRef.current || imageIds.length < 2) {
      return
    }

    event.preventDefault()
    const pixelsPerSlice = 18
    const deltaY = event.clientY - scrollGestureRef.current.y
    const deltaSlices = Math.trunc(deltaY / pixelsPerSlice)
    if (deltaSlices === 0) {
      return
    }

    const nextSliceIndex = Math.min(Math.max(scrollGestureRef.current.sliceIndex + deltaSlices, 0), imageIds.length - 1)
    if (nextSliceIndex === scrollGestureRef.current.sliceIndex) {
      scrollGestureRef.current = { ...scrollGestureRef.current, y: event.clientY }
      return
    }

    scrollGestureRef.current = { pointerId: event.pointerId, y: event.clientY, sliceIndex: nextSliceIndex }
    setViewportCinePlaying(viewportKey, false)
    void jumpToSliceIndex(nextSliceIndex, { animate: true, immediate: true })
  }

  function stopPointerInteraction(event: React.PointerEvent<HTMLDivElement>) {
    if (finishStackIchLassoDrag(event)) {
      return
    }

    if (stopStackIchSmartDrag(event)) {
      return
    }

    if (modifierGestureRef.current?.pointerId === event.pointerId) {
      modifierGestureRef.current = null
    }
    if (scrollGestureRef.current?.pointerId === event.pointerId) {
      scrollGestureRef.current = null
    }
    if (ctrTextDragRef.current?.pointerId === event.pointerId) {
      ctrTextDragRef.current = null
    }
    if (shapeMarkerDraft && (activeTool === 'ArrowMarker' || activeTool === 'CircleMarker')) {
      commitShapeMarkerDraft()
    }
    if (customMarkerDragRef.current?.pointerId === event.pointerId) {
      customMarkerDragRef.current = null
    }
    if (stack3dCursorDragRef.current?.pointerId === event.pointerId) {
      stack3dCursorDragRef.current = null
    }
    if (event.type === 'pointerleave' && !stack3dCursorDragRef.current) {
      setStack3dCursorCanvas(null)
    }
  }

  function updateStack3dCursorScreenDot(event: React.PointerEvent<HTMLDivElement>) {
    void event
    if (stack3dCursorCanvas) {
      setStack3dCursorCanvas(null)
    }
  }

  function handleContextMenu(event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (!contextMenuEnabled) {
      setContextMenu(null)
      return
    }
    onSelect?.()
    ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
    openViewportContextMenu(event.clientX, event.clientY)
  }

  function stopContextMenuPointerEvent(event: React.SyntheticEvent, preventDefault = false) {
    if (preventDefault) {
      event.preventDefault()
    }
    event.stopPropagation()
    const nativeEvent = event.nativeEvent as Event & { stopImmediatePropagation?: () => void }
    nativeEvent.stopImmediatePropagation?.()
  }

  function findCtrResultHit(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    return ctrCanvasAnnotations.find((annotation) => {
      const box = annotation.textBox

      return box && x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height
    })
  }

  function findCustomMarkerHit(event: React.PointerEvent<HTMLDivElement>): CustomMarkerHit | null {
    const rect = event.currentTarget.getBoundingClientRect()
    const point: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const textHit = textMarkers.find((marker) => isPointNearTextMarker(point, marker))
    if (textHit) {
      return { type: 'text', id: textHit.id }
    }

    for (const marker of shapeMarkers) {
      if (isPointNearPoint(point, marker.startCanvasPosition, 10)) {
        return { type: 'shape', id: marker.id, edit: 'start' }
      }
      if (isPointNearPoint(point, marker.endCanvasPosition, 10)) {
        return { type: 'shape', id: marker.id, edit: 'end' }
      }
    }

    const shapeHit = shapeMarkers.find((marker) => marker.type === 'arrow'
      ? isPointNearLine(point, marker.startCanvasPosition, marker.endCanvasPosition, 8)
      : isPointNearCircle(point, marker.startCanvasPosition, marker.endCanvasPosition, 8) || isPointInsideCircle(point, marker.startCanvasPosition, marker.endCanvasPosition))
    if (shapeHit) {
      return { type: 'shape', id: shapeHit.id, edit: 'move' }
    }

    return null
  }

  function getPointerWorldPosition(event: React.PointerEvent<HTMLDivElement>) {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element) {
      return null
    }

    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]

    return viewport.canvasToWorld(canvasPoint) as Types.Point3
  }

  function moveCustomMarker(event: React.PointerEvent<HTMLDivElement>) {
    const drag = customMarkerDragRef.current
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const nextWorldPosition = getPointerWorldPosition(event)
    if (!drag || !viewport || !nextWorldPosition) {
      return
    }

    event.preventDefault()
    const delta: Types.Point3 = [
      nextWorldPosition[0] - drag.lastWorldPosition[0],
      nextWorldPosition[1] - drag.lastWorldPosition[1],
      nextWorldPosition[2] - drag.lastWorldPosition[2],
    ]

    if (drag.marker.type === 'text') {
      const nextTextMarkers = textMarkersRef.current.map((marker) => marker.id === drag.marker.id
        ? { ...marker, worldPosition: addWorldDelta(marker.worldPosition, delta) }
        : marker)
      textMarkersRef.current = nextTextMarkers
      setTextMarkers(buildTextMarkerCanvasAnnotations(nextTextMarkers, viewport))
    } else {
      const nextShapeMarkers = shapeMarkersRef.current.map((marker) => marker.id === drag.marker.id
        ? drag.marker.type === 'shape' && drag.marker.edit === 'start'
          ? { ...marker, startWorldPosition: nextWorldPosition }
          : drag.marker.type === 'shape' && drag.marker.edit === 'end'
            ? { ...marker, endWorldPosition: nextWorldPosition }
            : {
                ...marker,
                startWorldPosition: addWorldDelta(marker.startWorldPosition, delta),
                endWorldPosition: addWorldDelta(marker.endWorldPosition, delta),
              }
        : marker)
      shapeMarkersRef.current = nextShapeMarkers
      setShapeMarkers(buildShapeMarkerCanvasAnnotations(nextShapeMarkers, viewport))
    }

    customMarkerDragRef.current = { ...drag, lastWorldPosition: nextWorldPosition }
  }

  function deleteSelectedCustomMarker() {
    const selectedMarker = selectedCustomMarkerRef.current
    if (!selectedMarker) {
      return false
    }

    if (selectedMarker.type === 'text') {
      const nextTextMarkers = textMarkersRef.current.filter((marker) => marker.id !== selectedMarker.id)
      textMarkersRef.current = nextTextMarkers
      setTextMarkers(buildTextMarkerCanvasAnnotations(nextTextMarkers, renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined))
    } else {
      const nextShapeMarkers = shapeMarkersRef.current.filter((marker) => marker.id !== selectedMarker.id)
      shapeMarkersRef.current = nextShapeMarkers
      setShapeMarkers(buildShapeMarkerCanvasAnnotations(nextShapeMarkers, renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined))
    }

    selectedCustomMarkerRef.current = null
    setSelectedCustomMarker(null)

    return true
  }

  function moveCtrResultText(event: React.PointerEvent<HTMLDivElement>, annotationId: string) {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element) {
      return
    }

    event.preventDefault()
    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const textWorldPosition = viewport.canvasToWorld(canvasPoint) as Types.Point3
    const nextAnnotations = ctrAnnotationsRef.current.map((annotation) => (
      annotation.id === annotationId ? { ...annotation, textWorldPosition } : annotation
    ))

    ctrAnnotationsRef.current = nextAnnotations
    setCtrAnnotations(nextAnnotations)
    setCtrCanvasAnnotations(buildCtrCanvasAnnotations(nextAnnotations, viewport))
  }

  function addCtrPoint(event: React.PointerEvent<HTMLDivElement>) {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !stackReadyRef.current) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const worldPoint = viewport.canvasToWorld(canvasPoint) as Types.Point3

    const nextAnnotations = [...ctrAnnotationsRef.current]
    const lastAnnotation = nextAnnotations[nextAnnotations.length - 1]
    const annotation = lastAnnotation && !lastAnnotation.complete
      ? { ...lastAnnotation, points: { ...lastAnnotation.points } }
      : { id: `ctr-4point-${ctrIdRef.current++}`, points: {}, complete: false }
    const pointIndex = ctrPointOrder.findIndex((pointKey) => !annotation.points[pointKey])
    const pointKey = ctrPointOrder[pointIndex]

    if (!pointKey) {
      return
    }

    annotation.points[pointKey] = worldPoint
    annotation.complete = pointIndex === ctrPointOrder.length - 1

    if (lastAnnotation && !lastAnnotation.complete) {
      nextAnnotations[nextAnnotations.length - 1] = annotation
    } else {
      nextAnnotations.push(annotation)
    }

    ctrAnnotationsRef.current = nextAnnotations
    setCtrAnnotations(nextAnnotations)
    setCtrCanvasAnnotations(buildCtrCanvasAnnotations(nextAnnotations, viewport))

    if (annotation.complete) {
      setActiveTool('WindowLevel')
    }
  }

  function placeStack3dCursor(event: React.PointerEvent<HTMLDivElement>) {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !stackReadyRef.current) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const worldPoint = viewport.canvasToWorld(canvasPoint) as Types.Point3
    const cursorPoint: [number, number, number] = [worldPoint[0], worldPoint[1], worldPoint[2]]

    setStack3dCursor(viewportKey, cursorPoint)
    updateStack3dCursorScreenDot(event)
  }

  function addTextMarkerDraft(event: React.PointerEvent<HTMLDivElement>) {
    if (event.detail > 1) {
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !stackReadyRef.current) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const rect = element.getBoundingClientRect()
    const canvasPosition: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const worldPosition = viewport.canvasToWorld(canvasPosition) as Types.Point3
    setTextMarkerDraft({ worldPosition, canvasPosition })
  }

  function commitTextMarker(text: string) {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!textMarkerDraft || !viewport) {
      setTextMarkerDraft(null)
      return
    }

    const trimmedText = text.trim()
    if (trimmedText) {
      const nextMarkers = [...textMarkersRef.current, {
        id: `text-marker-${textMarkerIdRef.current++}`,
        text: trimmedText,
        worldPosition: textMarkerDraft.worldPosition,
      }]
      textMarkersRef.current = nextMarkers
      setTextMarkers(buildTextMarkerCanvasAnnotations(nextMarkers, viewport))
    }
    setTextMarkerDraft(null)
    setActiveTool('WindowLevel')
  }

  function startShapeMarker(event: React.PointerEvent<HTMLDivElement>, type: 'arrow' | 'circle') {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !stackReadyRef.current) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = element.getBoundingClientRect()
    const canvasPosition: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const worldPosition = viewport.canvasToWorld(canvasPosition) as Types.Point3
    setShapeMarkerDraft({
      type,
      startWorldPosition: worldPosition,
      endWorldPosition: worldPosition,
      startCanvasPosition: canvasPosition,
      endCanvasPosition: canvasPosition,
    })
  }

  function updateShapeMarkerDraft(event: React.PointerEvent<HTMLDivElement>) {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element || !shapeMarkerDraft) {
      return
    }

    event.preventDefault()
    const rect = element.getBoundingClientRect()
    const canvasPosition: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const worldPosition = viewport.canvasToWorld(canvasPosition) as Types.Point3
    setShapeMarkerDraft({
      ...shapeMarkerDraft,
      endWorldPosition: worldPosition,
      endCanvasPosition: canvasPosition,
    })
  }

  function commitShapeMarkerDraft() {
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!viewport || !shapeMarkerDraft) {
      setShapeMarkerDraft(null)
      return
    }

    const dx = shapeMarkerDraft.endCanvasPosition[0] - shapeMarkerDraft.startCanvasPosition[0]
    const dy = shapeMarkerDraft.endCanvasPosition[1] - shapeMarkerDraft.startCanvasPosition[1]
    if (Math.hypot(dx, dy) >= 4) {
      const nextMarkers = [...shapeMarkersRef.current, {
        id: `${shapeMarkerDraft.type}-marker-${shapeMarkerIdRef.current++}`,
        type: shapeMarkerDraft.type,
        startWorldPosition: shapeMarkerDraft.startWorldPosition,
        endWorldPosition: shapeMarkerDraft.endWorldPosition,
      }]
      shapeMarkersRef.current = nextMarkers
      setShapeMarkers(buildShapeMarkerCanvasAnnotations(nextMarkers, viewport))
    }

    setShapeMarkerDraft(null)
    setActiveTool('WindowLevel')
  }

  function stopFastSliceSliderEvent(event: React.SyntheticEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()
    const nativeEvent = event.nativeEvent as Event & { stopImmediatePropagation?: () => void }
    nativeEvent.stopImmediatePropagation?.()
  }

  function getFastSliceIndexFromPointer(event: React.PointerEvent<HTMLElement>) {
    const track = event.currentTarget.querySelector<HTMLElement>('.viewport-slice-scrollbar-track')
    const rect = track?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect()
    const ratio = rect.height > 0
      ? Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)
      : 0

    return Math.round(ratio * Math.max(imageIds.length - 1, 0))
  }

  function seekFastSliceFromPointer(event: React.PointerEvent<HTMLElement>) {
    if (imageIds.length < 2) {
      return
    }

    const targetIndex = getFastSliceIndexFromPointer(event)
    setSliceSliderPreviewIndex(targetIndex)
    setViewportCinePlaying(viewportKey, false)
    void jumpToSliceIndex(targetIndex, { animate: true, immediate: true })
  }

  function handleFastSliceSliderPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    stopFastSliceSliderEvent(event)
    fastSliceSliderDragRef.current = event.pointerId
    event.currentTarget.dataset.dragging = 'true'
    event.currentTarget.setPointerCapture(event.pointerId)
    seekFastSliceFromPointer(event)
  }

  function handleFastSliceSliderPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (fastSliceSliderDragRef.current !== event.pointerId) {
      return
    }

    stopFastSliceSliderEvent(event)
    seekFastSliceFromPointer(event)
  }

  function stopFastSliceSliderDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (fastSliceSliderDragRef.current !== event.pointerId) {
      return
    }

    stopFastSliceSliderEvent(event)
    fastSliceSliderDragRef.current = null
    delete event.currentTarget.dataset.dragging
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleFastSliceSliderKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (imageIds.length < 2) {
      return
    }

    let nextIndex = displayedSliceIndex
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex -= 1
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex += 1
    else if (event.key === 'PageUp') nextIndex -= 10
    else if (event.key === 'PageDown') nextIndex += 10
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = imageIds.length - 1
    else return

    stopFastSliceSliderEvent(event)
    setViewportCinePlaying(viewportKey, false)
    void jumpToSliceIndex(nextIndex, { animate: true, immediate: true })
  }

  const fastSliceSliderIndex = sliceSliderPreviewIndex ?? displayedSliceIndex
  const fastSliceSliderPercent = imageIds.length > 1
    ? (fastSliceSliderIndex / Math.max(imageIds.length - 1, 1)) * 100
    : 0

  return (
    <>
      <div
        className={viewportClassName}
        data-active-tool={activeTool}
        ref={elementRef}
        role="button"
        tabIndex={0}
        onPointerDown={handlePointerDownEvent}
        onPointerMove={handlePointerMove}
        onPointerUp={stopPointerInteraction}
        onPointerCancel={stopPointerInteraction}
        onPointerLeave={stopPointerInteraction}
        onDoubleClick={handleViewportDoubleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => event.key === 'Enter' && onSelect?.()}
      >
        {previewUrl && isDiagnosticPreviewActive && (
          <div
            className="dicom-progressive-preview-layer"
            onPointerDown={handlePreviewPointerDown}
            onPointerMove={handlePreviewPointerMove}
            onPointerUp={handlePreviewPointerUp}
            onPointerCancel={handlePreviewPointerUp}
          >
            <img
              className="dicom-progressive-preview"
              src={previewUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            {previewToolDraft && <PreviewToolDraftOverlay draft={previewToolDraft} />}
          </div>
        )}
      {displayDecorations && <ViewportDisplayOverlay decorations={displayDecorations} />}
      {!isDiagnosticPreviewActive && <Stack3dCursorOverlay cursor={stack3dCursorCanvas} />}
      {!isDiagnosticPreviewActive && <CTROverlay annotations={ctrCanvasAnnotations} active={activeTool === 'CTR4Point'} />}
      {!isDiagnosticPreviewActive && <ShapeMarkerOverlay draft={shapeMarkerDraft} markers={shapeMarkers} selectedMarker={selectedCustomMarker?.type === 'shape' ? selectedCustomMarker.id : null} />}
      {!isDiagnosticPreviewActive && <TextMarkerOverlay draft={textMarkerDraft} markers={textMarkers} onCommit={commitTextMarker} onCancel={() => setTextMarkerDraft(null)} />}
      {!isDiagnosticPreviewActive && <GspsPresentationOverlay overlays={gspsOverlays} />}
      {!isDiagnosticPreviewActive && liveProbeValue && (
        <div
          className="live-probe-overlay"
          style={{ left: liveProbeValue.canvasPoint[0] + 16, top: liveProbeValue.canvasPoint[1] - 10 }}
        >
          <span className="live-probe-value">{liveProbeValue.value.toFixed(1)}</span>
          <span className="live-probe-unit">{liveProbeValue.unit}</span>
        </div>
      )}
      {isDiagnosticPreviewActive && (
        <div className="dicom-diagnostic-status" aria-live="polite">
          {previewToolStatus || 'Loading diagnostic DICOM pixels…'}
        </div>
      )}
      {(activeTool === 'ICHSegment' || activeTool === 'ICHEraser' || ichSegmentationId) && (
        <div
          className="ich-segmentation-panel stack-ich-segmentation-panel"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="ich-segmentation-title">
            <strong>ICH Segment</strong>
            <span>ICH #1</span>
          </div>
          <div className="ich-segmentation-modes" role="group" aria-label="ICH segmentation mode">
            <button
              className={ichSeedMode ? 'active' : ''}
              disabled={!canUseIchThreshold || !stackReadyRef.current || ichThresholdApplying}
              type="button"
              onClick={handleStackIchSeedMode}
            >
              Seed
            </button>
            <button
              className={!ichSeedMode && activeTool === 'ICHSegment' ? 'active' : ''}
              disabled={!stackReadyRef.current}
              type="button"
              onClick={() => handleStackIchModeChange('ICHSegment')}
            >
              Add
            </button>
            <button
              className={activeTool === 'ICHEraser' ? 'active' : ''}
              disabled={!stackReadyRef.current}
              type="button"
              onClick={() => handleStackIchModeChange('ICHEraser')}
            >
              Clear
            </button>
          </div>
          <label className="ich-smart-toggle">
            <input
              aria-label="Smart drag segmentation"
              checked={ichSmartDragEnabled}
              disabled={!canUseIchThreshold || ichThresholdApplying}
              type="checkbox"
              onChange={(event) => setIchSmartDragEnabled(event.currentTarget.checked)}
            />
            <span>Smart Drag</span>
          </label>
          <label>
            <span>Size</span>
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
          <label>
            <span>Opacity</span>
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
          <div className="ich-threshold-controls" aria-label="ICH HU threshold controls">
            <div className="ich-threshold-readout" aria-label="ICH threshold HU range">
              <span>HU</span>
              <strong>{Math.round(ichThresholdMin)} - {Math.round(ichThresholdMax)}</strong>
            </div>
            <div className="ich-threshold-actions">
              <button
                disabled={!canUseIchThreshold || !stackReadyRef.current || ichThresholdApplying || ichSeedPoints.length < 2}
                type="button"
                onClick={() => void handleStackIchGrowSlice()}
              >
                Grow Slice
              </button>
              <button
                disabled={!canUseIchThreshold || !stackReadyRef.current || ichThresholdApplying || ichSeedPoints.length < 2}
                type="button"
                onClick={() => void handleStackIchThresholdApply('stack')}
              >
                Mask Stack
              </button>
              <button
                disabled={!canUseIchThreshold || !stackReadyRef.current || ichThresholdApplying || ichSeedPoints.length < 2}
                type="button"
                onClick={() => void handleStackIchThresholdApply('stack', true)}
              >
                Refine Stack
              </button>
              <button
                className={ichLassoMode === 'polygon' ? 'active' : ''}
                aria-pressed={ichLassoMode === 'polygon'}
                disabled={!canUseIchThreshold || !stackReadyRef.current || ichThresholdApplying}
                title="Magnetic lasso: click points around the lesion, the line snaps to the anatomy edge"
                type="button"
                onClick={() => {
                  setIchLassoMode(ichLassoMode === 'polygon' ? 'off' : 'polygon')
                  cancelStackIchLasso()
                }}
              >
                <PenTool size={12} aria-hidden="true" />
                Lasso
              </button>
              <button
                className={ichLassoMode === 'drag' ? 'active' : ''}
                aria-pressed={ichLassoMode === 'drag'}
                disabled={!canUseIchThreshold || !stackReadyRef.current || ichThresholdApplying}
                title="Drag the boundary: press on the edge, pull it outward or inward, release to apply"
                type="button"
                onClick={() => {
                  setIchLassoMode(ichLassoMode === 'drag' ? 'off' : 'drag')
                  cancelStackIchLasso()
                }}
              >
                <Magnet size={12} aria-hidden="true" />
                Drag edge
              </button>
              <button disabled={ichLassoBusy || ichLassoPoints.length < 3} type="button" onClick={() => void applyStackIchLasso('polygon', ichLassoPoints)}>
                Apply lasso
              </button>
              <button disabled={ichLassoBusy || !ichLassoPoints.length} type="button" onClick={cancelStackIchLasso}>
                Cancel
              </button>
              <details className="ich-settings-menu">
                <summary title="Magnetic lasso settings" aria-label="Magnetic lasso settings">
                  <Magnet size={12} aria-hidden="true" />
                  <span>{ichLassoMagnetism}</span>
                </summary>
                <div className="ich-settings-popover">
                  <label className="ich-range-control" title="0 = follow the cursor exactly, higher = stick closer to the anatomy edge">
                    <Magnet size={12} aria-hidden="true" />
                    <input
                      aria-label="Lasso magnetism"
                      max={12}
                      min={0}
                      step={1}
                      type="range"
                      value={ichLassoMagnetism}
                      onChange={(event) => setIchLassoMagnetism(Number(event.currentTarget.value))}
                    />
                    <output>{ichLassoMagnetism}</output>
                  </label>
                  <label className="ich-lasso-operation">
                    <span>Lasso mode</span>
                    <select
                      aria-label="Lasso operation"
                      value={ichLassoOperation}
                      onChange={(event) => setIchLassoOperation(event.currentTarget.value as IchLassoOperation)}
                    >
                      <option value="add">Add</option>
                      <option value="subtract">Subtract</option>
                      <option value="replace">Replace</option>
                    </select>
                  </label>
                </div>
              </details>
              <span className="ich-lasso-state">{ichLassoStatus}</span>
            </div>
          </div>
          <div className="ich-history-actions" aria-label="ICH edit history">
            <button disabled={!ichHistoryState.canUndo || ichThresholdApplying} type="button" onClick={handleStackIchUndo}>
              Undo
            </button>
            <button disabled={!ichHistoryState.canRedo || ichThresholdApplying} type="button" onClick={handleStackIchRedo}>
              Redo
            </button>
            <button className="ich-segmentation-clear" disabled={!ichSegmentationId || ichThresholdApplying} type="button" onClick={handleStackIchClear}>
              Clear
            </button>
          </div>
          <span className="ich-segmentation-count">{ichThresholdStatus || (ichSegmentationId ? 'Labelmap active' : 'Ready')}</span>
        </div>
      )}
      {ichLassoPreview && ichLassoPreview.length >= 2 && (
        <svg className="ich-lasso-preview" aria-hidden="true">
          <polyline
            className="ich-lasso-preview-path"
            points={ichLassoPreview.map((point) => `${point[0]},${point[1]}`).join(' ')}
          />
        </svg>
      )}
      {ichLassoPoints
        .filter((point) => point.sliceIndex === displayedSliceIndex)
        .map((point, index) => (
          <span
            key={`lasso-${index}-${point.sliceIndex}`}
            className="ich-lasso-point"
            style={{ left: point.canvas[0], top: point.canvas[1] }}
            aria-hidden="true"
          />
        ))}
      {ichSeedPoints
        .filter((point) => point.sliceIndex === displayedSliceIndex)
        .map((point, index) => (
          <span
            key={`${point.kind}-${index}-${point.sliceIndex}`}
            className={`ich-seed-marker ${point.kind}`}
            style={{ left: point.canvasPoint[0], top: point.canvasPoint[1] }}
            aria-hidden="true"
          >
            {point.kind === 'center' ? 'A' : 'B'}
          </span>
        ))}
      {ichSmartDragPreview && (
        <span
          className={`ich-smart-drag-preview ${ichSmartDragPreview.mode}`}
          style={{
            left: ichSmartDragPreview.canvasPoint[0],
            top: ichSmartDragPreview.canvasPoint[1],
            width: ichSmartDragPreview.radius * 2,
            height: ichSmartDragPreview.radius * 2,
          }}
          aria-hidden="true"
        />
      )}
      {showCineControls && (
        <div
          className="cine-control-panel"
          aria-label="Cine controls"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <div className="cine-fps-row">
            <label className="cine-fps-label" htmlFor={`cine-fps-${viewportKey}`}>FPS</label>
            <input
              id={`cine-fps-${viewportKey}`}
              className="cine-fps-slider"
              type="range"
              min={1}
              max={60}
              value={effectiveCineFps}
              onChange={(event) => setCineFps(Number(event.currentTarget.value))}
            />
            <span className="cine-fps-value">{effectiveCineFps}</span>
          </div>
          <div className="cine-controls-row">
            <div className="cine-button-group">
              <button
                className="cine-control-button"
                type="button"
                title="First frame"
                onClick={() => {
                  setViewportCinePlaying(viewportKey, false)
                  void jumpToSliceIndex(0)
                }}
              >
                <SkipBack size={18} fill="currentColor" />
              </button>
              <button
                className="cine-control-button"
                type="button"
                title="Previous frame"
                onClick={() => {
                  setViewportCinePlaying(viewportKey, false)
                  void jumpToSliceIndex(displayedSliceIndex - 1)
                }}
              >
                <StepBack size={18} fill="currentColor" />
              </button>
            </div>
            <label className="cine-frame-field" aria-label="Current frame">
              <input
                type="number"
                min={1}
                max={imageIds.length}
                value={displayedSliceIndex + 1}
                onChange={(event) => {
                  const nextFrame = Number(event.currentTarget.value)
                  if (!Number.isFinite(nextFrame)) {
                    return
                  }
                  setViewportCinePlaying(viewportKey, false)
                  void jumpToSliceIndex(nextFrame - 1)
                }}
              />
            </label>
            <span className="cine-frame-count">/ {imageIds.length}</span>
            <div className="cine-button-group">
              <button
                className="cine-control-button"
                type="button"
                title="Next frame"
                onClick={() => {
                  setViewportCinePlaying(viewportKey, false)
                  void jumpToSliceIndex(displayedSliceIndex + 1)
                }}
              >
                <StepForward size={18} fill="currentColor" />
              </button>
              <button
                className="cine-control-button"
                type="button"
                title="Last frame"
                onClick={() => {
                  setViewportCinePlaying(viewportKey, false)
                  void jumpToSliceIndex(imageIds.length - 1)
                }}
              >
                <SkipForward size={18} fill="currentColor" />
              </button>
            </div>
            <div className="cine-button-group">
              <button
                className="cine-control-button large"
                type="button"
                title="Play reverse"
                onClick={() => {
                  setCineDirection(-1)
                  setViewportCinePlaying(viewportKey, true)
                }}
              >
                <Play className="cine-reverse-icon" size={20} fill="currentColor" />
              </button>
              <button
                className={cinePlaying ? 'cine-control-button large active' : 'cine-control-button large'}
                type="button"
                title={cinePlaying ? 'Pause cine' : 'Play cine'}
                onClick={() => setViewportCinePlaying(viewportKey, !cinePlaying)}
              >
                {cinePlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
              <button
                className="cine-control-button large"
                type="button"
                title="Play forward"
                onClick={() => {
                  setCineDirection(1)
                  setViewportCinePlaying(viewportKey, true)
                }}
              >
                <Play size={20} fill="currentColor" />
              </button>
            </div>
          </div>
        </div>
      )}
      {contextMenu && createPortal(
        <div
          className="viewport-context-menu"
          ref={contextMenuRef}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => stopContextMenuPointerEvent(event, true)}
          onContextMenu={(event) => stopContextMenuPointerEvent(event, true)}
          onMouseDownCapture={stopContextMenuPointerEvent}
          onMouseUpCapture={stopContextMenuPointerEvent}
          onPointerDownCapture={stopContextMenuPointerEvent}
          onPointerMoveCapture={stopContextMenuPointerEvent}
          onPointerUpCapture={stopContextMenuPointerEvent}
        >
          {permittedMenuSections.map((section) => (
            <div
              className={activeContextSection === section.title ? 'viewport-context-section open' : 'viewport-context-section'}
              key={section.title}
              onMouseEnter={() => setActiveContextSection(section.title)}
              onFocus={() => setActiveContextSection(section.title)}
            >
              <button
                className={hasActiveMenuItem(section, activeTool, referenceLinesEnabled) ? 'viewport-context-group active' : 'viewport-context-group'}
                role="menuitem"
                type="button"
              >
                <section.icon size={16} />
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
                      role="menuitem"
                      type="button"
                      onClick={(event) => {
                        stopContextMenuPointerEvent(event, true)
                        runViewportMenuAction(item.action)
                      }}
                    >
                      <Icon size={16} />
                      <span>{item.label}</span>
                      {getMenuItemHotkey(item, hotkeyOverrides) && <kbd>{getMenuItemHotkey(item, hotkeyOverrides)}</kbd>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
      </div>
      {showFastSliceSlider && sliceSliderHost && createPortal(
        <div
          className={isSliceSliderExpanded ? 'viewport-slice-scrollbar expanded' : 'viewport-slice-scrollbar collapsed'}
        >
          <button
            className="viewport-slice-scrollbar-cap"
            type="button"
            title={isSliceSliderExpanded ? 'Collapse slice scrollbar' : 'Expand slice scrollbar'}
            aria-label={isSliceSliderExpanded ? 'Collapse slice scrollbar' : 'Expand slice scrollbar'}
            aria-expanded={isSliceSliderExpanded}
            onClick={(event) => {
              stopFastSliceSliderEvent(event)
              setIsSliceSliderExpanded((current) => !current)
            }}
            onPointerDown={stopFastSliceSliderEvent}
          >
            {isSliceSliderExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {isSliceSliderExpanded && (
            <div
              className="viewport-slice-scrollbar-slider"
              role="slider"
              tabIndex={0}
              aria-label="Scroll slices"
              aria-orientation="vertical"
              aria-valuemin={1}
              aria-valuemax={imageIds.length}
              aria-valuenow={displayedSliceIndex + 1}
              aria-valuetext={`${displayedSliceIndex + 1} of ${imageIds.length}`}
              onClick={stopFastSliceSliderEvent}
              onContextMenu={stopFastSliceSliderEvent}
              onDoubleClick={stopFastSliceSliderEvent}
              onKeyDown={handleFastSliceSliderKeyDown}
              onPointerDown={handleFastSliceSliderPointerDown}
              onPointerMove={handleFastSliceSliderPointerMove}
              onPointerUp={stopFastSliceSliderDrag}
              onPointerCancel={stopFastSliceSliderDrag}
              onLostPointerCapture={(event) => {
                fastSliceSliderDragRef.current = null
                delete event.currentTarget.dataset.dragging
              }}
            >
              <span className="viewport-slice-scrollbar-direction top" aria-hidden="true">{fastSliceDirectionLabels.start}</span>
              <span className="viewport-slice-scrollbar-track">
                <span
                  className="viewport-slice-scrollbar-thumb"
                  style={{ top: `${fastSliceSliderPercent}%` }}
                />
              </span>
              <span className="viewport-slice-scrollbar-direction bottom" aria-hidden="true">{fastSliceDirectionLabels.end}</span>
            </div>
          )}
        </div>,
        sliceSliderHost,
      )}
    </>
  )
}

function ViewportDisplayOverlay({ decorations }: { decorations: ViewportDisplayDecorations }) {
  const { orientation, scaleBar } = decorations

  return (
    <div className="viewport-display-decorations" aria-hidden="true">
      <span className="viewport-anatomical-marker top">{orientation.top}</span>
      <span className="viewport-anatomical-marker right">{orientation.right}</span>
      <span className="viewport-anatomical-marker bottom">{orientation.bottom}</span>
      <span className="viewport-anatomical-marker left">{orientation.left}</span>
      {scaleBar && (
        <span className="viewport-scale-bar" style={{ width: scaleBar.width }}>
          <span className="viewport-scale-ruler">
            {Array.from({ length: 11 }, (_, index) => (
              <i className={index === 0 || index === 5 || index === 10 ? 'major' : ''} key={index} style={{ left: `${index * 10}%` }} />
            ))}
          </span>
          <span className="viewport-scale-label">{scaleBar.label}</span>
        </span>
      )}
    </div>
  )
}

function buildViewportDisplayDecorations(viewport: Types.IStackViewport | undefined, element: HTMLElement): ViewportDisplayDecorations | null {
  if (!viewport || element.clientWidth < 2 || element.clientHeight < 2) {
    return null
  }

  try {
    const width = element.clientWidth
    const height = element.clientHeight
    const center = toFinitePoint3(viewport.canvasToWorld([width / 2, height / 2] as Types.Point2))
    const left = toFinitePoint3(viewport.canvasToWorld([width * 0.2, height / 2] as Types.Point2))
    const right = toFinitePoint3(viewport.canvasToWorld([width * 0.8, height / 2] as Types.Point2))
    const top = toFinitePoint3(viewport.canvasToWorld([width / 2, height * 0.2] as Types.Point2))
    const bottom = toFinitePoint3(viewport.canvasToWorld([width / 2, height * 0.8] as Types.Point2))
    if (!center || !left || !right || !top || !bottom) {
      return null
    }

    const samplePixels = Math.min(Math.max(width * 0.16, 64), 160)
    const scaleSample = toFinitePoint3(viewport.canvasToWorld([width / 2 + samplePixels, height / 2] as Types.Point2))
    const millimetersPerPixel = scaleSample ? pointDistance(center, scaleSample) / samplePixels : 0
    const targetScaleMillimeters = millimetersPerPixel > 0 ? getNiceScaleLengthMillimeters(millimetersPerPixel * samplePixels) : 0
    const scaleWidth = targetScaleMillimeters > 0 ? targetScaleMillimeters / millimetersPerPixel : 0

    return {
      orientation: {
        left: getAnatomicalDirection(subtract(left, center)),
        right: getAnatomicalDirection(subtract(right, center)),
        top: getAnatomicalDirection(subtract(top, center)),
        bottom: getAnatomicalDirection(subtract(bottom, center)),
      },
      scaleBar: Number.isFinite(scaleWidth) && scaleWidth >= 28 && scaleWidth <= width * 0.42
        ? { width: scaleWidth, label: formatScaleLength(targetScaleMillimeters) }
        : null,
    }
  } catch {
    return null
  }
}

function areViewportDisplayDecorationsEqual(current: ViewportDisplayDecorations | null, next: ViewportDisplayDecorations | null) {
  if (!current || !next) return current === next
  const currentOrientation = current.orientation
  const nextOrientation = next.orientation
  const orientationMatches = currentOrientation.top === nextOrientation.top
    && currentOrientation.right === nextOrientation.right
    && currentOrientation.bottom === nextOrientation.bottom
    && currentOrientation.left === nextOrientation.left
  if (!orientationMatches) return false
  if (!current.scaleBar || !next.scaleBar) return current.scaleBar === next.scaleBar
  return current.scaleBar.label === next.scaleBar.label && Math.abs(current.scaleBar.width - next.scaleBar.width) < 1
}

function getStackSliceDirectionLabels(instances: InstanceSummary[]) {
  const first = instances.find((instance) => toFinitePoint3(instance.imagePositionPatient))
  const last = [...instances].reverse().find((instance) => toFinitePoint3(instance.imagePositionPatient))
  const start = toFinitePoint3(first?.imagePositionPatient)
  const end = toFinitePoint3(last?.imagePositionPatient)
  if (!start || !end || pointDistance(start, end) < 0.001) {
    return { start: 'F', end: 'H' }
  }

  const direction = subtract(end, start)
  return {
    start: getAnatomicalDirection(scalePoint(direction, -1)),
    end: getAnatomicalDirection(direction),
  }
}

function toFinitePoint3(value: ArrayLike<number> | undefined | null): Types.Point3 | null {
  if (!value || value.length < 3) return null
  const point: Types.Point3 = [Number(value[0]), Number(value[1]), Number(value[2])]
  return point.every(Number.isFinite) ? point : null
}

function pointDistance(first: Types.Point3, second: Types.Point3) {
  return Math.hypot(second[0] - first[0], second[1] - first[1], second[2] - first[2])
}

function scalePoint(point: Types.Point3, factor: number): Types.Point3 {
  return [point[0] * factor, point[1] * factor, point[2] * factor]
}

function getAnatomicalDirection(vector: Types.Point3) {
  const absolute = vector.map(Math.abs)
  const axis = absolute.indexOf(Math.max(...absolute))
  if (axis === 0) return vector[0] >= 0 ? 'L' : 'R'
  if (axis === 1) return vector[1] >= 0 ? 'P' : 'A'
  return vector[2] >= 0 ? 'H' : 'F'
}

function getNiceScaleLengthMillimeters(target: number) {
  if (!Number.isFinite(target) || target <= 0) return 0
  const power = Math.pow(10, Math.floor(Math.log10(target)))
  const candidates = [1, 2, 5, 10].map((multiplier) => multiplier * power)
  return candidates.reduce((closest, candidate) => Math.abs(candidate - target) < Math.abs(closest - target) ? candidate : closest)
}

function formatScaleLength(millimeters: number) {
  if (millimeters >= 10) {
    const centimeters = millimeters / 10
    return `${Number.isInteger(centimeters) ? centimeters : centimeters.toFixed(1)} cm`
  }
  return `${Math.round(millimeters)} mm`
}

export function toHotkey(event: KeyboardEvent) {
  const key = normalizeHotkeyKey(event)
  const prefix = [
    event.ctrlKey ? 'ctrl' : '',
    event.altKey ? 'alt' : '',
    event.shiftKey && key.length === 1 && key !== '+' ? 'shift' : '',
  ].filter(Boolean)

  return [...prefix, key].join('+')
}

export function hasActiveMenuItem(section: ViewportMenuSection, activeTool: string, referenceLinesEnabled: boolean) {
  return section.items.some((item) => (
    (item.action.type === 'tool' && item.action.tool === activeTool) ||
    (item.action.type === 'reference-lines' && referenceLinesEnabled)
  ))
}

function isTransientTool(tool: string) {
  return customTransientToolIds.has(tool) || (Boolean(toolNameById[tool]) && !persistentTools.has(tool))
}

function normalizeHotkeyKey(event: KeyboardEvent) {
  if (event.key === ' ') {
    return 'space'
  }
  if (event.key === '+' || event.key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd' || event.key.toLowerCase() === 'add') {
    return '+'
  }
  if (event.shiftKey && event.code === 'Digit0') {
    return '0'
  }

  return event.key.toLowerCase()
}

export function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function collectSaveGraphics(
  viewport: Types.IStackViewport,
  element: HTMLElement,
  custom: {
    textMarkers: TextMarkerAnnotation[]
    shapeMarkers: ShapeMarkerAnnotation[]
  },
): GraphicSaveObject[] {
  const graphics: GraphicSaveObject[] = []

  custom.textMarkers.forEach((marker) => {
    graphics.push({
      type: 'text',
      point: toDisplayPoint(viewport.worldToCanvas(marker.worldPosition) as Types.Point2),
      text: marker.text,
    })
  })

  custom.shapeMarkers.forEach((marker) => {
    const start = toDisplayPoint(viewport.worldToCanvas(marker.startWorldPosition) as Types.Point2)
    const end = toDisplayPoint(viewport.worldToCanvas(marker.endWorldPosition) as Types.Point2)
    graphics.push(marker.type === 'circle'
      ? { type: 'circle', points: [start, end] }
      : { type: 'polyline', points: [start, end] })
  })

  annotationToolNames.forEach((toolName) => {
    const toolAnnotations = annotation.state.getAnnotations(toolName, element as HTMLDivElement) as unknown as Array<{
      data?: {
        handles?: { points?: Types.Point3[] }
        contour?: { polyline?: Types.Point3[]; closed?: boolean }
        cachedStats?: Record<string, Record<string, unknown>>
      }
      metadata?: { toolName?: string }
    }>

    toolAnnotations.forEach((toolAnnotation) => {
      const tool = toolAnnotation.metadata?.toolName ?? toolName
      const canvasPoints = getSaveGraphicCanvasPoints(viewport, tool, toolAnnotation)
      if (canvasPoints.length === 1) {
        graphics.push({ type: 'text', point: canvasPoints[0], text: toolAnnotation.metadata?.toolName ?? 'Annotation' })
        return
      }
      if (canvasPoints.length < 2) return

      graphics.push({
        type: tool === CircleROITool.toolName ? 'circle' : 'polyline',
        points: canvasPoints,
      })

      const label = measurementLabel(tool, toolAnnotation)
      const labelPoint = canvasPoints[canvasPoints.length - 1]
      if (label && labelPoint) {
        graphics.push({ type: 'text', point: [labelPoint[0] + 8, labelPoint[1] - 8], text: label })
      }
    })
  })

  return graphics.filter((graphic) => {
    const points = graphic.type === 'text' ? [graphic.point] : graphic.points
    return points.some(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  })
}

function collectSavedAnnotationSnapshots(element: HTMLElement): SavedGspsAnnotation[] {
  return annotationToolNames.flatMap((toolName) => {
    const toolAnnotations = annotation.state.getAnnotations(toolName, element as HTMLDivElement) as unknown as Array<{
      annotationUID?: string
      metadata?: SavedAnnotationMetadata
      data?: SavedAnnotationData
    }>

    return toolAnnotations.map((toolAnnotation, index) => ({
      uid: toolAnnotation.annotationUID || `${toolName}-${index}`,
      toolName: String(toolAnnotation.metadata?.toolName ?? toolName),
      metadata: cloneSerializable(normalizeGspsAnnotationMetadata(
        element as HTMLDivElement,
        toolAnnotation.metadata,
        String(toolAnnotation.metadata?.toolName ?? toolName),
        toolAnnotation.data,
      )),
      data: cloneSerializable(toolAnnotation.data ?? {}),
    }))
  })
}

function normalizeGspsAnnotationMetadata(
  element: HTMLDivElement,
  metadata: SavedAnnotationMetadata | undefined,
  toolName: string,
  data?: SavedAnnotationData,
  overlay?: SavedGspsOverlay,
) {
  const sourceMetadata = metadata ?? {}
  const viewportReference = getGspsAnnotationViewportReference(element, sourceMetadata, data, overlay)
  const viewPlaneNormal = toPoint3Value(sourceMetadata.viewPlaneNormal)
    ?? toPoint3Value(sourceMetadata.viewplaneNormal)
    ?? viewportReference.viewPlaneNormal
  const viewUp = toPoint3Value(sourceMetadata.viewUp) ?? viewportReference.viewUp
  const frameOfReferenceUID = asNonEmptyString(sourceMetadata.FrameOfReferenceUID)
    ?? asNonEmptyString(sourceMetadata.frameOfReferenceUID)
    ?? viewportReference.FrameOfReferenceUID
  const referencedImageId = asNonEmptyString(sourceMetadata.referencedImageId)
    && viewportReference.imageIds.length > 0
    && !isViewportImageId(viewportReference.imageIds, String(sourceMetadata.referencedImageId))
      ? viewportReference.referencedImageId
      : asNonEmptyString(sourceMetadata.referencedImageId) ?? viewportReference.referencedImageId

  return {
    ...sourceMetadata,
    toolName,
    ...(frameOfReferenceUID ? { FrameOfReferenceUID: frameOfReferenceUID } : {}),
    ...(referencedImageId ? { referencedImageId } : {}),
    ...(viewPlaneNormal ? { viewPlaneNormal } : {}),
    ...(viewUp ? { viewUp } : {}),
  }
}

function getGspsAnnotationViewportReference(
  element: HTMLDivElement,
  metadata: SavedAnnotationMetadata,
  data?: SavedAnnotationData,
  overlay?: SavedGspsOverlay,
) {
  const enabledElement = getEnabledElement(element)
  const viewport = enabledElement?.viewport as AnnotationReferenceViewport | undefined
  const imageIds = getViewportImageIds(viewport)
  const annotationPoint = getSavedAnnotationWorldPoint(data)
  const imageIdFromPoint = annotationPoint ? getClosestStackImageId(viewport, annotationPoint) : undefined
  const imageIdFromOverlay = overlay?.sopInstanceUid ? findImageIdForSopInstance(imageIds, overlay.sopInstanceUid) : undefined
  const imageIdFromViewport = getCurrentViewportImageId(viewport)
  const referencedImageId = asNonEmptyString(metadata.referencedImageId)
    && (imageIds.length === 0 || isViewportImageId(imageIds, String(metadata.referencedImageId)))
      ? String(metadata.referencedImageId)
      : imageIdFromOverlay ?? imageIdFromPoint ?? imageIdFromViewport
  const imagePlaneReference = getImagePlaneReference(referencedImageId)
  const camera = viewport?.getCamera?.()
  const enabledFrameOfReferenceUID = asNonEmptyString((enabledElement as unknown as { FrameOfReferenceUID?: string } | undefined)?.FrameOfReferenceUID)
  const viewportFrameOfReferenceUID = asNonEmptyString(viewport?.getFrameOfReferenceUID?.())

  return {
    imageIds,
    referencedImageId,
    FrameOfReferenceUID: viewportFrameOfReferenceUID ?? enabledFrameOfReferenceUID ?? imagePlaneReference.FrameOfReferenceUID,
    viewPlaneNormal: toPoint3Value(camera?.viewPlaneNormal) ?? imagePlaneReference.viewPlaneNormal,
    viewUp: toPoint3Value(camera?.viewUp) ?? imagePlaneReference.viewUp,
  }
}

function getViewportImageIds(viewport: AnnotationReferenceViewport | undefined) {
  try {
    return viewport?.getImageIds?.() ?? []
  } catch {
    return []
  }
}

function getCurrentViewportImageId(viewport: AnnotationReferenceViewport | undefined) {
  try {
    const currentImageId = viewport?.getCurrentImageId?.()
    if (currentImageId) {
      return currentImageId
    }

    const imageIds = getViewportImageIds(viewport)
    const currentIndex = viewport?.getCurrentImageIdIndex?.()
    return typeof currentIndex === 'number' && currentIndex >= 0 ? imageIds[currentIndex] : imageIds[0]
  } catch {
    return undefined
  }
}

function getClosestStackImageId(viewport: AnnotationReferenceViewport | undefined, point: Types.Point3) {
  try {
    const imageIds = getViewportImageIds(viewport)
    if (!viewport || !imageIds.length) {
      return undefined
    }

    const closestIndex = csUtilities.getClosestStackImageIndexForPoint(point, viewport)
    return typeof closestIndex === 'number' && closestIndex >= 0 ? imageIds[closestIndex] : undefined
  } catch {
    return undefined
  }
}

function findImageIdForSopInstance(imageIds: string[], sopInstanceUid: string) {
  if (!sopInstanceUid) {
    return undefined
  }

  const encodedSopInstanceUid = encodeURIComponent(sopInstanceUid)
  return imageIds.find((imageId) => (
    imageId.includes(`/instances/${sopInstanceUid}/`)
    || imageId.includes(`/instances/${encodedSopInstanceUid}/`)
    || imageId.includes(`instances/${sopInstanceUid}`)
    || imageId.includes(`instances/${encodedSopInstanceUid}`)
  ))
}

function isViewportImageId(imageIds: string[], imageId: string) {
  if (!imageId) {
    return false
  }

  return imageIds.includes(imageId) || imageIds.some((candidate) => csUtilities.imageIdToURI(candidate) === csUtilities.imageIdToURI(imageId))
}

function getImagePlaneReference(imageId: string | undefined) {
  const imagePlaneModule = imageId ? metaData.get('imagePlaneModule', imageId) as {
    FrameOfReferenceUID?: string
    frameOfReferenceUID?: string
    imageOrientationPatient?: ArrayLike<number>
    rowCosines?: ArrayLike<number>
    columnCosines?: ArrayLike<number>
  } | undefined : undefined
  if (!imagePlaneModule) {
    return {}
  }

  const row = toPoint3Value(imagePlaneModule.rowCosines)
  const column = toPoint3Value(imagePlaneModule.columnCosines)
  const orientation = toNumberArray(imagePlaneModule.imageOrientationPatient)
  const rowCosines = row ?? (orientation.length >= 6 ? [orientation[0], orientation[1], orientation[2]] as Types.Point3 : undefined)
  const columnCosines = column ?? (orientation.length >= 6 ? [orientation[3], orientation[4], orientation[5]] as Types.Point3 : undefined)
  const viewPlaneNormal = rowCosines && columnCosines ? normalize(cross(rowCosines, columnCosines)) : undefined

  return {
    FrameOfReferenceUID: asNonEmptyString(imagePlaneModule.FrameOfReferenceUID) ?? asNonEmptyString(imagePlaneModule.frameOfReferenceUID),
    viewPlaneNormal,
    viewUp: columnCosines ? normalize(columnCosines) : undefined,
  }
}

function getSavedAnnotationWorldPoint(data?: SavedAnnotationData) {
  const handlePoint = data?.handles?.points?.find(isPoint3Value)
  if (handlePoint) {
    return handlePoint
  }

  const contourPoint = data?.contour?.polyline?.find(isPoint3Value)
  if (contourPoint) {
    return contourPoint
  }

  return isPoint3Value(data?.handles?.textBox?.worldPosition) ? data.handles.textBox.worldPosition : undefined
}

function toPoint3Value(value: unknown): Types.Point3 | undefined {
  const numbers = toNumberArray(value)
  return numbers.length >= 3 ? [numbers[0], numbers[1], numbers[2]] : undefined
}

function toNumberArray(value: unknown) {
  if (!value || typeof value === 'string') {
    return []
  }

  return Array.from(value as ArrayLike<unknown>).map(Number).filter(Number.isFinite)
}

function isPoint3Value(value: unknown): value is Types.Point3 {
  return Boolean(toPoint3Value(value))
}

function asNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toDisplayPoint(point: Types.Point2): [number, number] {
  return [Number(point[0].toFixed(2)), Number(point[1].toFixed(2))]
}

function resizeReadyStackViewport(
  renderingEngine: ReturnType<typeof acquireStackRenderingEngine>,
  viewportId: string,
  ready: boolean,
) {
  if (!ready || renderingEngine.hasBeenDestroyed) {
    return
  }

  try {
    const viewport = renderingEngine.getViewport(viewportId) as (Types.IStackViewport & { resize?: () => void }) | undefined
    if (!viewport) {
      return
    }

    const camera = viewport.getCamera()
    renderingEngine.resize(true, false)
    viewport.resize?.()
    viewport.setCamera(camera)
    viewport.render()
  } catch {
    // Layout changes can race with stack replacement; a later resize will retry.
  }
}

function getSaveGraphicCanvasPoints(
  viewport: Types.IStackViewport,
  toolName: string,
  toolAnnotation: {
    data?: {
      handles?: { points?: Types.Point3[] }
      contour?: { polyline?: Types.Point3[]; closed?: boolean }
    }
  },
) {
  const handlePoints = toolAnnotation.data?.handles?.points ?? []
  const contourPoints = toolAnnotation.data?.contour?.polyline ?? []

  if (toolName === PlanarFreehandROITool.toolName && contourPoints.length >= 2) {
    const points = contourPoints.map((point) => toDisplayPoint(viewport.worldToCanvas(point) as Types.Point2))
    return closeDisplayPolyline(points)
  }

  const canvasPoints = handlePoints.map((point) => toDisplayPoint(viewport.worldToCanvas(point) as Types.Point2))
  if (toolName === RectangleROITool.toolName && canvasPoints.length >= 2) {
    return rectangleToDisplayPolyline(canvasPoints)
  }

  if (toolName === EllipticalROITool.toolName && canvasPoints.length >= 2) {
    return ellipseToDisplayPolyline(canvasPoints)
  }

  return canvasPoints
}

function rectangleToDisplayPolyline(points: Types.Point2[]) {
  const bounds = getCanvasBounds(points)
  return closeDisplayPolyline([
    [bounds.left, bounds.top],
    [bounds.left + bounds.width, bounds.top],
    [bounds.left + bounds.width, bounds.top + bounds.height],
    [bounds.left, bounds.top + bounds.height],
  ].map(toDisplayPoint))
}

function ellipseToDisplayPolyline(points: Types.Point2[]) {
  const bounds = getCanvasBounds(points)
  const centerX = bounds.left + bounds.width / 2
  const centerY = bounds.top + bounds.height / 2
  const radiusX = Math.abs(bounds.width / 2)
  const radiusY = Math.abs(bounds.height / 2)
  const segments = 48
  const ellipsePoints = Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2
    return toDisplayPoint([centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY])
  })

  return closeDisplayPolyline(ellipsePoints)
}

function closeDisplayPolyline(points: Types.Point2[]) {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || (first[0] === last[0] && first[1] === last[1])) {
    return points
  }

  return [...points, first]
}

function measurementLabel(
  toolName: string,
  toolAnnotation: {
    data?: {
      cachedStats?: Record<string, Record<string, unknown>>
      handles?: { points?: Types.Point3[] }
      contour?: { polyline?: Types.Point3[]; closed?: boolean }
    }
    metadata?: { toolName?: string }
  },
) {
  const stats = Object.values(toolAnnotation.data?.cachedStats ?? {})[0]
  if (!stats) {
    return ''
  }

  const length = readStat(stats, ['length', 'lengthMm'])
  if (toolName === LengthTool.toolName && Number.isFinite(length)) {
    return `${formatMeasurement(length)} mm`
  }

  const angle = readStat(stats, ['angle'])
  if ((toolName === AngleTool.toolName || toolName === CobbAngleTool.toolName) && Number.isFinite(angle)) {
    return `${formatMeasurement(angle)} deg`
  }

  const width = readStat(stats, ['width'])
  const height = readStat(stats, ['height'])
  if (toolName === BidirectionalTool.toolName && Number.isFinite(width) && Number.isFinite(height)) {
    return `${formatMeasurement(width)} x ${formatMeasurement(height)} mm`
  }

  const area = readStat(stats, ['area', 'areaMm2'])
  const mean = readStat(stats, ['mean'])
  const perimeter = readStat(stats, ['perimeter', 'perimeterMm'])
  const fallbackPerimeter = calculateRoiPerimeterMm(toolName, toolAnnotation, stats)
  if ([RectangleROITool.toolName, EllipticalROITool.toolName, CircleROITool.toolName, PlanarFreehandROITool.toolName].includes(toolName)) {
    const parts = [
      Number.isFinite(area) ? `A ${formatMeasurement(area)} mm2` : '',
      Number.isFinite(perimeter) ? `P ${formatMeasurement(perimeter)} mm` : Number.isFinite(fallbackPerimeter) ? `P ${formatMeasurement(fallbackPerimeter)} mm` : '',
      Number.isFinite(mean) ? `M ${formatMeasurement(mean)}` : '',
    ].filter(Boolean)
    return parts.join(' / ')
  }

  const value = readStat(stats, ['value', 'storedValue', 'modalityValue'])
  if (toolName === ProbeTool.toolName && Number.isFinite(value)) {
    return formatMeasurement(value)
  }

  return ''
}

function enhanceRoiCachedStats(element: HTMLDivElement) {
  const roiTools = [RectangleROITool.toolName, CircleROITool.toolName, EllipticalROITool.toolName, PlanarFreehandROITool.toolName]
  roiTools.forEach((toolName) => {
    const toolAnnotations = annotation.state.getAnnotations(toolName, element) as unknown as Array<{
      data?: {
        cachedStats?: Record<string, Record<string, unknown>>
        handles?: { points?: Types.Point3[] }
        contour?: { polyline?: Types.Point3[]; closed?: boolean }
      }
      metadata?: { toolName?: string }
    }>

    toolAnnotations.forEach((toolAnnotation) => {
      Object.values(toolAnnotation.data?.cachedStats ?? {}).forEach((stats) => {
        stats.unit = normalizeLengthUnit(stats.unit)
        stats.areaUnit = normalizeAreaUnit(stats.areaUnit)
        stats.modalityUnit = normalizeModalityUnit(stats.modalityUnit)

        const perimeter = readStat(stats, ['perimeter', 'perimeterMm'])
        if (Number.isFinite(perimeter)) {
          return
        }

        const fallbackPerimeter = calculateRoiPerimeterMm(toolName, toolAnnotation, stats, element)
        if (Number.isFinite(fallbackPerimeter)) {
          stats.perimeter = fallbackPerimeter
          stats.perimeterMm = fallbackPerimeter
          stats.unit = normalizeLengthUnit(stats.unit)
        }
      })
    })
  })
}

function createRoiTextLines(toolName: string, getElement?: () => HTMLDivElement | null) {
  return (data: {
    cachedStats?: Record<string, Record<string, unknown>>
    handles?: { points?: Types.Point3[] }
    contour?: { polyline?: Types.Point3[]; closed?: boolean }
  }, targetId: string) => {
    const stats = data.cachedStats?.[targetId]
    if (!stats) {
      return []
    }

    const area = readStat(stats, ['area', 'areaMm2'])
    const mean = readStat(stats, ['mean'])
    const max = readStat(stats, ['max'])
    const stdDev = readStat(stats, ['stdDev', 'standardDeviation'])
    const perimeter = readStat(stats, ['perimeter', 'perimeterMm'])
    const fallbackPerimeter = calculateRoiPerimeterMm(toolName, { data }, stats, getElement?.() ?? undefined)
    const areaUnit = normalizeAreaUnit(stats.areaUnit)
    const modalityUnit = normalizeModalityUnit(stats.modalityUnit)
    const lengthUnit = normalizeLengthUnit(stats.unit)

    const lines = [
      Number.isFinite(area) ? `Area: ${formatMeasurement(area)} ${areaUnit}` : '',
      Number.isFinite(mean) ? `Mean: ${formatMeasurement(mean)} ${modalityUnit}` : '',
      Number.isFinite(max) ? `Max: ${formatMeasurement(max)} ${modalityUnit}` : '',
      Number.isFinite(stdDev) ? `Std Dev: ${formatMeasurement(stdDev)} ${modalityUnit}` : '',
      Number.isFinite(perimeter)
        ? `Perimeter: ${formatMeasurement(perimeter)} ${lengthUnit}`
        : Number.isFinite(fallbackPerimeter)
          ? `Perimeter: ${formatMeasurement(fallbackPerimeter)} ${lengthUnit}`
          : '',
    ].filter(Boolean)

    if (toolName === CircleROITool.toolName) {
      const radius = readStat(stats, ['radius', 'radiusMm'])
      if (Number.isFinite(radius)) {
        lines.unshift(`Radius: ${formatMeasurement(radius)} ${normalizeLengthUnit(stats.radiusUnit ?? stats.unit)}`)
      }
    }

    return lines
  }
}

function normalizeLengthUnit(unit: unknown) {
  const value = typeof unit === 'string' ? unit.trim() : ''
  return value && value !== 'undefined' && value !== 'null' ? value : 'mm'
}

function normalizeAreaUnit(unit: unknown) {
  const value = typeof unit === 'string' ? unit.trim() : ''
  return value && value !== 'undefined' && value !== 'null' ? value : 'mm2'
}

function normalizeModalityUnit(unit: unknown) {
  const value = typeof unit === 'string' ? unit.trim() : ''
  return value && value !== 'undefined' && value !== 'null' ? value : 'HU'
}

function calculateRoiPerimeterMm(
  toolName: string,
  toolAnnotation: {
    data?: {
      handles?: { points?: Types.Point3[] }
      contour?: { polyline?: Types.Point3[]; closed?: boolean }
    }
  },
  stats?: Record<string, unknown>,
  element?: HTMLDivElement,
) {
  const width = stats ? readStat(stats, ['width', 'widthMm']) : Number.NaN
  const height = stats ? readStat(stats, ['height', 'heightMm']) : Number.NaN
  const radius = stats ? readStat(stats, ['radius', 'radiusMm']) : Number.NaN

  if (toolName === RectangleROITool.toolName && Number.isFinite(width) && Number.isFinite(height)) {
    return 2 * (Math.abs(width) + Math.abs(height))
  }

  if (toolName === CircleROITool.toolName && Number.isFinite(radius)) {
    return 2 * Math.PI * Math.abs(radius)
  }

  if (toolName === EllipticalROITool.toolName && Number.isFinite(width) && Number.isFinite(height)) {
    const a = Math.abs(width) / 2
    const b = Math.abs(height) / 2
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
  }

  const handlePoints = toolAnnotation.data?.handles?.points ?? []
  if (toolName === CircleROITool.toolName && handlePoints.length >= 2) {
    return 2 * Math.PI * worldDistance(handlePoints[0], handlePoints[1])
  }

  if (toolName === RectangleROITool.toolName && handlePoints.length >= 2) {
    const indexedPerimeter = element ? rectanglePerimeterFromImageIndex(element, handlePoints[0], handlePoints[3] ?? handlePoints[1]) : Number.NaN
    if (Number.isFinite(indexedPerimeter)) {
      return indexedPerimeter
    }
    if (handlePoints.length >= 4) {
      return worldDistance(handlePoints[0], handlePoints[1]) + worldDistance(handlePoints[1], handlePoints[3]) + worldDistance(handlePoints[3], handlePoints[2]) + worldDistance(handlePoints[2], handlePoints[0])
    }
    const diagonal = worldDistance(handlePoints[0], handlePoints[1])
    return Number.isFinite(diagonal) ? 2 * Math.SQRT2 * diagonal : Number.NaN
  }

  if (toolName === EllipticalROITool.toolName && handlePoints.length >= 2) {
    const dimensions = element ? rectDimensionsFromImageIndex(element, handlePoints[0], handlePoints[3] ?? handlePoints[1]) : null
    if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
      const a = dimensions.width / 2
      const b = dimensions.height / 2
      return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
    }

    const diagonal = worldDistance(handlePoints[0], handlePoints[3] ?? handlePoints[1])
    return Number.isFinite(diagonal) ? Math.PI * Math.abs(diagonal) : Number.NaN
  }

  const contourPoints = toolAnnotation.data?.contour?.polyline ?? []
  if (toolName === PlanarFreehandROITool.toolName && contourPoints.length >= 2) {
    const indexedLength = element ? polylineLengthFromImageIndex(element, contourPoints, true) : Number.NaN
    return Number.isFinite(indexedLength) ? indexedLength : polylineWorldLength(contourPoints, true)
  }

  return Number.NaN
}

function rectanglePerimeterFromImageIndex(element: HTMLDivElement, first: Types.Point3 | undefined, second: Types.Point3 | undefined) {
  const dimensions = rectDimensionsFromImageIndex(element, first, second)
  return dimensions && dimensions.width > 0 && dimensions.height > 0
    ? 2 * (dimensions.width + dimensions.height)
    : Number.NaN
}

function rectDimensionsFromImageIndex(element: HTMLDivElement, first: Types.Point3 | undefined, second: Types.Point3 | undefined) {
  if (!first || !second) {
    return null
  }

  const viewport = getEnabledElement(element)?.viewport as Types.IStackViewport | undefined
  const imageData = viewport?.getImageData()
  const vtkImage = imageData?.imageData as { worldToIndex?: (point: number[]) => number[] } | undefined
  if (!vtkImage?.worldToIndex) {
    return null
  }

  const firstIndex = vtkImage.worldToIndex([first[0], first[1], first[2]])
  const secondIndex = vtkImage.worldToIndex([second[0], second[1], second[2]])
  const spacing = (imageData as { spacing?: number[] }).spacing ?? [1, 1, 1]
  const width = Math.abs((secondIndex?.[0] ?? 0) - (firstIndex?.[0] ?? 0)) * (Math.abs(Number(spacing[0] ?? 1)) || 1)
  const height = Math.abs((secondIndex?.[1] ?? 0) - (firstIndex?.[1] ?? 0)) * (Math.abs(Number(spacing[1] ?? 1)) || 1)

  return { width, height }
}

function polylineLengthFromImageIndex(element: HTMLDivElement, points: Types.Point3[], closed: boolean) {
  const viewport = getEnabledElement(element)?.viewport as Types.IStackViewport | undefined
  const imageData = viewport?.getImageData()
  const vtkImage = imageData?.imageData as { worldToIndex?: (point: number[]) => number[] } | undefined
  if (!vtkImage?.worldToIndex || points.length < 2) {
    return Number.NaN
  }

  const spacing = (imageData as { spacing?: number[] }).spacing ?? [1, 1, 1]
  const colSpacing = Math.abs(Number(spacing[0] ?? 1)) || 1
  const rowSpacing = Math.abs(Number(spacing[1] ?? 1)) || 1
  const sliceSpacing = Math.abs(Number(spacing[2] ?? 1)) || 1
  const indexes = points.map((point) => vtkImage.worldToIndex([point[0], point[1], point[2]]))
  let length = 0

  for (let index = 1; index < indexes.length; index += 1) {
    length += indexDistanceMm(indexes[index - 1], indexes[index], colSpacing, rowSpacing, sliceSpacing)
  }
  if (closed && indexes.length > 2) {
    length += indexDistanceMm(indexes[indexes.length - 1], indexes[0], colSpacing, rowSpacing, sliceSpacing)
  }

  return length
}

function indexDistanceMm(a: number[] | undefined, b: number[] | undefined, colSpacing: number, rowSpacing: number, sliceSpacing: number) {
  if (!a || !b) {
    return 0
  }

  return Math.hypot(
    ((b[0] ?? 0) - (a[0] ?? 0)) * colSpacing,
    ((b[1] ?? 0) - (a[1] ?? 0)) * rowSpacing,
    ((b[2] ?? 0) - (a[2] ?? 0)) * sliceSpacing,
  )
}

function polylineWorldLength(points: Types.Point3[], closed: boolean) {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    length += worldDistance(points[index - 1], points[index])
  }
  if (closed && points.length > 2) {
    length += worldDistance(points[points.length - 1], points[0])
  }

  return length
}

function worldDistance(a: Types.Point3 | undefined, b: Types.Point3 | undefined) {
  if (!a || !b) {
    return Number.NaN
  }

  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function readStat(stats: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = stats[key]
    const numberValue = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(numberValue)) {
      return numberValue
    }
  }

  return Number.NaN
}

function formatMeasurement(value: number) {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)
}

function buildCtrCanvasAnnotations(annotations: CTRAnnotation[], viewport: Types.IStackViewport | undefined): CTRCanvasAnnotation[] {
  if (!viewport) {
    return []
  }

  return annotations.map((annotation) => {
    const canvasPoints = Object.fromEntries(
      Object.entries(annotation.points).map(([key, point]) => [key, viewport.worldToCanvas(point as Types.Point3) as Types.Point2]),
    ) as Partial<Record<CTRPointKey, Types.Point2>>
    const result = annotation.complete ? calculateCtrResult(canvasPoints, viewport) : null
    const viewportSize = {
      width: viewport.element.clientWidth,
      height: viewport.element.clientHeight,
    }
    const textCanvasPosition = result ? getCtrTextCanvasPosition(annotation, canvasPoints, viewport, viewportSize) : undefined

    return {
      ...annotation,
      canvasPoints,
      viewportSize,
      result,
      textCanvasPosition,
      textBox: textCanvasPosition ? { left: textCanvasPosition[0] - 120, top: textCanvasPosition[1] - 22, width: 240, height: 78 } : undefined,
    }
  })
}

function getNearestImageIndexForWorldPoint(instances: InstanceSummary[], worldPoint: Types.Point3) {
  let best: { index: number; distance: number } | null = null

  instances.forEach((instance, index) => {
    const plane = getImagePlaneInfo(instance.metadata)
    if (!plane) {
      return
    }

    const distance = Math.abs(dot(subtract(worldPoint, plane.origin), plane.normal))
    if (!best || distance < best.distance) {
      best = { index, distance }
    }
  })

  return best?.index
}

function getNearestMetadataLinkedImageIndex(sourceInstance: InstanceSummary, targetInstances: InstanceSummary[]) {
  const sourcePlane = getImagePlaneInfo(sourceInstance.metadata)
  if (!sourcePlane) {
    return undefined
  }

  let best: { index: number; distance: number } | null = null

  targetInstances.forEach((targetInstance, index) => {
    const targetPlane = getImagePlaneInfo(targetInstance.metadata)
    if (!targetPlane || !isCompatibleImagePlane(sourcePlane, targetPlane)) {
      return
    }

    const distance = Math.abs(dot(subtract(sourcePlane.origin, targetPlane.origin), targetPlane.normal))
    if (!best || distance < best.distance) {
      best = { index, distance }
    }
  })

  return best?.index
}

function isCompatibleImagePlane(sourcePlane: ImagePlaneInfo, targetPlane: ImagePlaneInfo) {
  if (sourcePlane.frameOfReferenceUID && targetPlane.frameOfReferenceUID && sourcePlane.frameOfReferenceUID !== targetPlane.frameOfReferenceUID) {
    return false
  }

  return Math.abs(dot(sourcePlane.normal, targetPlane.normal)) > 0.92
}

function isSameSeries(sourceInstance: InstanceSummary | undefined, targetInstance: InstanceSummary | undefined) {
  return Boolean(sourceInstance && targetInstance
    && sourceInstance.studyInstanceUid === targetInstance.studyInstanceUid
    && sourceInstance.seriesInstanceUid === targetInstance.seriesInstanceUid)
}

function getImagePlaneInfo(metadata?: DicomJsonDataset): ImagePlaneInfo | null {
  if (!metadata) {
    return null
  }

  const origin = readDicomNumberValues(metadata, '00200032')
  const orientation = readDicomNumberValues(metadata, '00200037')
  const frameOfReferenceUID = readDicomStringValue(metadata, '00200052')
  if (origin.length < 3 || orientation.length < 6) {
    return null
  }

  const row: Types.Point3 = normalize([orientation[0], orientation[1], orientation[2]])
  const column: Types.Point3 = normalize([orientation[3], orientation[4], orientation[5]])
  const normal = normalize(cross(row, column))

  return {
    origin: [origin[0], origin[1], origin[2]],
    normal,
    frameOfReferenceUID,
  }
}

function readDicomStringValue(dataset: DicomJsonDataset, tag: string) {
  const value = dataset[tag]?.Value?.[0]

  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function readDicomNumberValues(dataset: DicomJsonDataset, tag: string) {
  const values = dataset[tag]?.Value
  if (!Array.isArray(values)) {
    return []
  }

  return values.map(Number).filter(Number.isFinite)
}

function subtract(a: Types.Point3, b: Types.Point3): Types.Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a: Types.Point3, b: Types.Point3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Types.Point3, b: Types.Point3): Types.Point3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function normalize(vector: Types.Point3): Types.Point3 {
  const length = Math.hypot(vector[0], vector[1], vector[2])
  if (!length) {
    return [0, 0, 0]
  }

  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

function buildTextMarkerCanvasAnnotations(annotations: TextMarkerAnnotation[], viewport: Types.IStackViewport | undefined) {
  if (!viewport) {
    return []
  }

  return annotations.map((annotation) => ({
    ...annotation,
    canvasPosition: viewport.worldToCanvas(annotation.worldPosition) as Types.Point2,
  }))
}

function buildShapeMarkerCanvasAnnotations(annotations: ShapeMarkerAnnotation[], viewport: Types.IStackViewport | undefined) {
  if (!viewport) {
    return []
  }

  return annotations.map((annotation) => ({
    ...annotation,
    startCanvasPosition: viewport.worldToCanvas(annotation.startWorldPosition) as Types.Point2,
    endCanvasPosition: viewport.worldToCanvas(annotation.endWorldPosition) as Types.Point2,
  }))
}

function isPointNearTextMarker(point: Types.Point2, marker: TextMarkerAnnotation & { canvasPosition: Types.Point2 }) {
  const width = Math.max(48, marker.text.length * 9)
  const height = 24

  return point[0] >= marker.canvasPosition[0] - 4 &&
    point[0] <= marker.canvasPosition[0] + width &&
    point[1] >= marker.canvasPosition[1] - height / 2 &&
    point[1] <= marker.canvasPosition[1] + height / 2
}

function isPointNearLine(point: Types.Point2, start: Types.Point2, end: Types.Point2, proximity: number) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]) <= proximity
  }

  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared))
  const projection: Types.Point2 = [start[0] + t * dx, start[1] + t * dy]

  return Math.hypot(point[0] - projection[0], point[1] - projection[1]) <= proximity
}

function isPointNearPoint(point: Types.Point2, target: Types.Point2, proximity: number) {
  return Math.hypot(point[0] - target[0], point[1] - target[1]) <= proximity
}

function isPointNearCircle(point: Types.Point2, center: Types.Point2, edge: Types.Point2, proximity: number) {
  const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1])
  const distance = Math.hypot(point[0] - center[0], point[1] - center[1])

  return Math.abs(distance - radius) <= proximity
}

function isPointInsideCircle(point: Types.Point2, center: Types.Point2, edge: Types.Point2) {
  const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1])
  const distance = Math.hypot(point[0] - center[0], point[1] - center[1])

  return radius > 0 && distance < radius
}

function addWorldDelta(point: Types.Point3, delta: Types.Point3): Types.Point3 {
  return [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]]
}

function GspsPresentationOverlay({ overlays }: { overlays: GspsOverlay[] }) {
  if (!overlays.length) {
    return null
  }

  return (
    <>
      {overlays.map((overlay) => (
        <svg
          aria-hidden="true"
          className="gsps-presentation-overlay"
          key={overlay.id}
          preserveAspectRatio="none"
          viewBox={`0 0 ${overlay.sourceSize.width} ${overlay.sourceSize.height}`}
        >
          {overlay.graphics.map((graphic) => {
            if (graphic.type === 'text') {
              return <text className="gsps-presentation-text" key={graphic.id} x={graphic.point[0]} y={graphic.point[1]}>{graphic.text}</text>
            }
            if (graphic.type === 'circle') {
              return (
                <circle
                  className="gsps-presentation-graphic"
                  cx={graphic.center[0]}
                  cy={graphic.center[1]}
                  key={graphic.id}
                  r={Math.hypot(graphic.edge[0] - graphic.center[0], graphic.edge[1] - graphic.center[1])}
                />
              )
            }

            return (
              <polyline
                className="gsps-presentation-graphic"
                fill="none"
                key={graphic.id}
                points={graphic.points.map((point) => `${point[0]},${point[1]}`).join(' ')}
              />
            )
          })}
        </svg>
      ))}
    </>
  )
}

function parseGspsOverlay(metadata: DicomJsonDataset | undefined, seriesInstanceUid: string, sopInstanceUid: string): GspsOverlay | null {
  if (!metadata || readDicomString(metadata, '00080060').toUpperCase() !== 'PR') {
    return null
  }
  if (!gspsReferencesImage(metadata, seriesInstanceUid, sopInstanceUid)) {
    return null
  }

  const graphics = readGspsGraphics(metadata)
  if (!graphics.length) {
    return null
  }
  const sourceSize = normalizeGspsSourceSize(readGspsDisplayedAreaSize(metadata), graphics)

  return {
    id: readDicomString(metadata, '00080018') || `gsps-${seriesInstanceUid}-${sopInstanceUid}`,
    sourceSize,
    graphics,
  }
}

function savedGspsOverlayToViewportOverlay(overlay: SavedGspsOverlay): GspsOverlay {
  return {
    id: overlay.id,
    sourceSize: overlay.sourceSize,
    graphics: overlay.graphics.map((graphic, index): GspsOverlayGraphic => {
      if (graphic.type === 'text') {
        return { id: `${overlay.id}-text-${index}`, type: 'text', point: graphic.point, text: graphic.text }
      }
      if (graphic.type === 'circle') {
        return { id: `${overlay.id}-circle-${index}`, type: 'circle', center: graphic.points[0], edge: graphic.points[1] }
      }
      return { id: `${overlay.id}-polyline-${index}`, type: 'polyline', points: graphic.points }
    }),
  }
}

function restoreSavedGspsAnnotations(overlays: SavedGspsOverlay[], element: HTMLDivElement | null, restoredKeys: Set<string>) {
  if (!element) {
    return
  }

  let restored = false
  overlays.forEach((overlay) => {
    overlay.annotations?.forEach((savedAnnotation) => {
      const restoreKey = `${overlay.id}:${savedAnnotation.uid}`
      if (restoredKeys.has(restoreKey)) {
        return
      }

      annotation.state.addAnnotation({
        annotationUID: `gsps-${overlay.id}-${savedAnnotation.uid}`,
        highlighted: false,
        invalidated: true,
        metadata: normalizeGspsAnnotationMetadata(
          element,
          savedAnnotation.metadata as SavedAnnotationMetadata | undefined,
          savedAnnotation.toolName,
          savedAnnotation.data as SavedAnnotationData | undefined,
          overlay,
        ),
        data: savedAnnotation.data,
      } as never, element)
      restoredKeys.add(restoreKey)
      restored = true
    })
  })

  if (restored) {
    getEnabledElement(element)?.viewport.render()
  }
}

function mergeGspsOverlays(current: GspsOverlay[], incoming: GspsOverlay[]) {
  const seen = new Set<string>()
  return [...current, ...incoming].filter((overlay) => {
    if (seen.has(overlay.id)) {
      return false
    }
    seen.add(overlay.id)
    return true
  })
}

function normalizeGspsSourceSize(sourceSize: { width: number; height: number }, graphics: GspsOverlayGraphic[]) {
  if (sourceSize.width > 1 && sourceSize.height > 1) {
    return sourceSize
  }

  const points = graphics.flatMap((graphic) => {
    if (graphic.type === 'text') return [graphic.point]
    if (graphic.type === 'circle') return [graphic.center, graphic.edge]
    return graphic.points
  })
  const maxX = Math.max(...points.map((point) => point[0]).filter(Number.isFinite), 1)
  const maxY = Math.max(...points.map((point) => point[1]).filter(Number.isFinite), 1)

  return {
    width: Math.ceil(maxX + 24),
    height: Math.ceil(maxY + 24),
  }
}

function gspsReferencesImage(metadata: DicomJsonDataset, seriesInstanceUid: string, sopInstanceUid: string) {
  const referencedSeries = readDicomSequence(metadata, '00081115')
  const topLevelReferenceMatches = referencedSeries.some((seriesItem) => {
    const referencedSeriesUid = readDicomString(seriesItem, '0020000E')
    if (referencedSeriesUid && referencedSeriesUid !== seriesInstanceUid) {
      return false
    }
    const referencedImages = readDicomSequence(seriesItem, '00081140')
    return !referencedImages.length || referencedImages.some((imageItem) => readDicomString(imageItem, '00081155') === sopInstanceUid)
  })
  if (topLevelReferenceMatches) {
    return true
  }

  const annotationReferenceMatches = readDicomSequence(metadata, '00700001').some((annotationItem) => (
    readDicomSequence(annotationItem, '00081140')
      .some((imageItem) => readDicomString(imageItem, '00081155') === sopInstanceUid)
  ))
  if (annotationReferenceMatches) {
    return true
  }

  return readDicomString(metadata, '00700080') === 'VEXA_ANN' && !referencedSeries.length
}

function readGspsDisplayedAreaSize(metadata: DicomJsonDataset) {
  const displayedArea = readDicomSequence(metadata, '0070005A')[0]
  const bottomRight = displayedArea ? readDicomNumberArray(displayedArea, '00700053') : []
  const width = Number(bottomRight[0])
  const height = Number(bottomRight[1])

  return {
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1,
  }
}

function readGspsGraphics(metadata: DicomJsonDataset): GspsOverlayGraphic[] {
  const annotations = readDicomSequence(metadata, '00700001')

  return annotations.flatMap((annotationItem, annotationIndex) => {
    const objects = readDicomSequence(annotationItem, '00700009').flatMap((objectItem, objectIndex): GspsOverlayGraphic[] => {
      const graphicType = readDicomString(objectItem, '00700023').toUpperCase()
      const points = toDisplayPoints(readDicomNumberArray(objectItem, '00700022'))
      if (graphicType === 'CIRCLE' && points.length >= 2) {
        return [{ id: `gsps-circle-${annotationIndex}-${objectIndex}`, type: 'circle', center: points[0], edge: points[1] }]
      }
      if (points.length >= 2) {
        return [{ id: `gsps-polyline-${annotationIndex}-${objectIndex}`, type: 'polyline', points }]
      }
      return []
    })

    const texts = readDicomSequence(annotationItem, '00700008').flatMap((textItem, textIndex): GspsOverlayGraphic[] => {
      const text = readDicomString(textItem, '00700006')
      const anchorPoint = readDicomNumberArray(textItem, '00700014')
      const boxPoint = readDicomNumberArray(textItem, '00700010')
      const point: Types.Point2 = [
        Number(anchorPoint[0] ?? boxPoint[0] ?? 0),
        Number(anchorPoint[1] ?? boxPoint[1] ?? 0),
      ]
      return text ? [{ id: `gsps-text-${annotationIndex}-${textIndex}`, type: 'text', point, text }] : []
    })

    return [...objects, ...texts]
  })
}

function toDisplayPoints(values: number[]) {
  const points: Types.Point2[] = []
  for (let index = 0; index + 1 < values.length; index += 2) {
    points.push([values[index], values[index + 1]])
  }
  return points
}

function readDicomSequence(dataset: DicomJsonDataset, tag: string): DicomJsonDataset[] {
  return (dataset[tag]?.Value ?? []).filter((item): item is DicomJsonDataset => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
}

function readDicomNumberArray(dataset: DicomJsonDataset, tag: string) {
  return (dataset[tag]?.Value ?? []).map(Number).filter(Number.isFinite)
}

function readDicomString(dataset: DicomJsonDataset, tag: string) {
  const value = dataset[tag]?.Value?.[0]
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'Alphabetic' in value) return String((value as { Alphabetic?: string }).Alphabetic ?? '')
  return ''
}

function Stack3dCursorOverlay({ cursor }: { cursor: Stack3dCursorCanvas }) {
  if (!cursor?.inBounds) {
    return null
  }

  const [x, y] = cursor.point

  return (
    <svg className="stack-3d-cursor-overlay" aria-hidden="true">
      <line className="stack-3d-cursor-line" x1={x - 13} y1={y} x2={x - 5} y2={y} />
      <line className="stack-3d-cursor-line" x1={x + 5} y1={y} x2={x + 13} y2={y} />
      <line className="stack-3d-cursor-line" x1={x} y1={y - 13} x2={x} y2={y - 5} />
      <line className="stack-3d-cursor-line" x1={x} y1={y + 5} x2={x} y2={y + 13} />
      <circle className="stack-3d-cursor-ring" cx={x} cy={y} r="5.25" />
      <circle className="stack-3d-cursor-core" cx={x} cy={y} r="1.8" />
    </svg>
  )
}

function ShapeMarkerOverlay({ draft, markers, selectedMarker }: {
  draft: (ShapeMarkerDraft & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }) | null
  markers: Array<ShapeMarkerAnnotation & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }>
  selectedMarker: string | null
}) {
  const allMarkers = draft ? [...markers, { id: 'shape-marker-draft', ...draft }] : markers

  return (
    <svg className="shape-marker-overlay" aria-hidden="true">
      <defs>
        <marker id="shape-marker-arrow-head" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
          <path d="M0,0 L7,3.5 L0,7 Z" />
        </marker>
      </defs>
      {allMarkers.map((marker) => {
        const showHandles = marker.id === 'shape-marker-draft' || marker.id === selectedMarker

        return marker.type === 'arrow' ? (
        <g className={showHandles ? 'shape-marker selected' : 'shape-marker'} key={marker.id}>
          <line
            className="shape-marker-arrow"
            x1={marker.startCanvasPosition[0]}
            y1={marker.startCanvasPosition[1]}
            x2={marker.endCanvasPosition[0]}
            y2={marker.endCanvasPosition[1]}
          />
          {showHandles && (
            <>
              <circle className="shape-marker-handle" cx={marker.startCanvasPosition[0]} cy={marker.startCanvasPosition[1]} r={4} />
              <circle className="shape-marker-handle" cx={marker.endCanvasPosition[0]} cy={marker.endCanvasPosition[1]} r={4} />
            </>
          )}
        </g>
      ) : (
        <g className={showHandles ? 'shape-marker selected' : 'shape-marker'} key={marker.id}>
          <circle
            className="shape-marker-circle"
            cx={marker.startCanvasPosition[0]}
            cy={marker.startCanvasPosition[1]}
            r={Math.hypot(marker.endCanvasPosition[0] - marker.startCanvasPosition[0], marker.endCanvasPosition[1] - marker.startCanvasPosition[1])}
          />
          {showHandles && (
            <>
              <circle className="shape-marker-handle" cx={marker.startCanvasPosition[0]} cy={marker.startCanvasPosition[1]} r={4} />
              <circle className="shape-marker-handle" cx={marker.endCanvasPosition[0]} cy={marker.endCanvasPosition[1]} r={4} />
            </>
          )}
        </g>
      )
      })}
    </svg>
  )
}

function PreviewToolDraftOverlay({ draft }: { draft: PreviewToolDraft }) {
  const [startX, startY] = draft.startCanvasPoint
  const [endX, endY] = draft.endCanvasPoint
  const left = Math.min(startX, endX)
  const top = Math.min(startY, endY)
  const width = Math.abs(endX - startX)
  const height = Math.abs(endY - startY)
  const isLine = draft.tool === 'Length' || draft.tool === 'ArrowMarker'
  const isEllipse = draft.tool === 'CircleROI' || draft.tool === 'EllipticalROI' || draft.tool === 'CircleMarker'

  return (
    <svg
      className="dicom-preview-draft"
      aria-hidden="true"
      viewBox={`0 0 ${draft.viewportSize.width} ${draft.viewportSize.height}`}
      preserveAspectRatio="none"
    >
      {draft.tool === 'ArrowMarker' && (
        <defs>
          <marker id="preview-draft-arrow-head" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
            <path d="M0,0 L7,3.5 L0,7 Z" />
          </marker>
        </defs>
      )}
      {isLine && (
        <line
          className={draft.tool === 'ArrowMarker' ? 'dicom-preview-draft-line arrow' : 'dicom-preview-draft-line'}
          x1={startX}
          y1={startY}
          x2={endX}
          y2={endY}
        />
      )}
      {draft.tool === 'RectangleROI' && (
        <rect className="dicom-preview-draft-shape" x={left} y={top} width={width} height={height} />
      )}
      {isEllipse && (
        <ellipse
          className="dicom-preview-draft-shape"
          cx={left + width / 2}
          cy={top + height / 2}
          rx={width / 2}
          ry={height / 2}
        />
      )}
    </svg>
  )
}

function TextMarkerOverlay({ draft, markers, onCommit, onCancel }: {
  draft: TextMarkerDraft | null
  markers: Array<TextMarkerAnnotation & { canvasPosition: Types.Point2 }>
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [draft])

  return (
    <div className="text-marker-overlay" aria-hidden={!draft}>
      {markers.map((marker) => (
        <span className="text-marker-label" key={marker.id} style={{ left: marker.canvasPosition[0], top: marker.canvasPosition[1] }}>{marker.text}</span>
      ))}
      {draft && (
        <input
          className="text-marker-input"
          ref={inputRef}
          autoFocus
          style={{ left: draft.canvasPosition[0], top: draft.canvasPosition[1] }}
          onBlur={(event) => onCommit(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              onCommit(event.currentTarget.value)
            }
            if (event.key === 'Escape') {
              onCancel()
            }
          }}
        />
      )}
    </div>
  )
}

function getCtrTextCanvasPosition(annotation: CTRAnnotation, points: Partial<Record<CTRPointKey, Types.Point2>>, viewport: Types.IStackViewport, viewportSize: { width: number; height: number }): Types.Point2 {
  if (annotation.textWorldPosition) {
    return viewport.worldToCanvas(annotation.textWorldPosition) as Types.Point2
  }

  const { A, B, C, D } = points
  const chestY = A && B ? Math.max(A[1], B[1]) : 0
  const heartY = C && D ? Math.max(C[1], D[1]) : 0
  const measureCenterX = A && B ? (A[0] + B[0]) / 2 : viewportSize.width / 2
  const lowerMeasureY = Math.max(chestY, heartY)
  const textY = Math.min(viewportSize.height - 72, lowerMeasureY + 38)

  return [measureCenterX, textY]
}

function calculateCtrResult(points: Partial<Record<CTRPointKey, Types.Point2>>, viewport: Types.IStackViewport): CTRResult | null {
  const { A, B, C, D } = points
  if (!A || !B || !C || !D) {
    return null
  }

  const chestY = Math.max(A[1], B[1])
  const heartY = Math.max(C[1], D[1])
  const thoraxWidthMm = measureCanvasHorizontalDistance(viewport, A[0], B[0], chestY)
  const cardiacWidthMm = measureCanvasHorizontalDistance(viewport, C[0], D[0], heartY)
  if (thoraxWidthMm <= 0) {
    return null
  }

  return {
    ratio: cardiacWidthMm / thoraxWidthMm,
    cardiacWidthMm,
    thoraxWidthMm,
  }
}

function measureCanvasHorizontalDistance(viewport: Types.IStackViewport, x1: number, x2: number, y: number) {
  const worldPoint1 = viewport.canvasToWorld([x1, y])
  const worldPoint2 = viewport.canvasToWorld([x2, y])
  const dx = worldPoint2[0] - worldPoint1[0]
  const dy = worldPoint2[1] - worldPoint1[1]
  const dz = worldPoint2[2] - worldPoint1[2]

  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function CTROverlay({ annotations, active }: { annotations: CTRCanvasAnnotation[]; active: boolean }) {
  const drawingAnnotations = annotations.filter((annotation) => Object.keys(annotation.canvasPoints).length > 0)
  const activeAnnotation = drawingAnnotations.find((annotation) => !annotation.complete)
  const nextPoint = activeAnnotation
    ? ctrPointOrder.find((pointKey) => !activeAnnotation.points[pointKey])
    : 'A'

  return (
    <div className="ctr-overlay" aria-hidden="true">
      <svg className="ctr-svg">
        {drawingAnnotations.map((annotation) => (
          <CTRAnnotationSvg annotation={annotation} key={annotation.id} />
        ))}
      </svg>
      {active && (
        <div className="ctr-instructions">
          CTR 4 Point: click {nextPoint ? ctrPointLabels[nextPoint] : 'next point'}
        </div>
      )}
    </div>
  )
}

function CTRAnnotationSvg({ annotation }: { annotation: CTRCanvasAnnotation }) {
  const { A, B, C, D } = annotation.canvasPoints
  const chestY = A && B ? Math.max(A[1], B[1]) : null
  const heartY = C && D ? Math.max(C[1], D[1]) : null

  return (
    <g>
      {ctrPointOrder.map((pointKey) => {
        const point = annotation.canvasPoints[pointKey]
        if (!point) {
          return null
        }

        return <line className="ctr-line ctr-guide-line" key={pointKey} x1={point[0]} y1="0" x2={point[0]} y2={annotation.viewportSize.height} />
      })}
      {A && B && chestY !== null && <line className="ctr-line ctr-measure-line" x1={A[0]} y1={chestY} x2={B[0]} y2={chestY} />}
      {C && D && heartY !== null && <line className="ctr-line ctr-measure-line" x1={C[0]} y1={heartY} x2={D[0]} y2={heartY} />}
      {annotation.result && C && D && annotation.textCanvasPosition && (
        <g className="ctr-result-group" transform={`translate(${annotation.textCanvasPosition[0]} ${annotation.textCanvasPosition[1]})`}>
          <text className="ctr-result-text" x="0" y="0">Heart: {annotation.result.cardiacWidthMm.toFixed(2)} *mm</text>
          <text className="ctr-result-text" x="0" y="24">Chest: {annotation.result.thoraxWidthMm.toFixed(2)} *mm</text>
          <text className="ctr-result-text" x="0" y="48">CTR: {(annotation.result.ratio * 100).toFixed(2)} %</text>
        </g>
      )}
    </g>
  )
}

function broadcastLinkedCommand(sourceViewportKey: string, option: IntelliLinkOption, type: 'set-slice' | 'set-zoom' | 'set-pan' | 'set-window-level', options: LinkedCommandOptions) {
  const state = useViewerStore.getState()
  if (!state.intelliLink[option]) {
    return
  }

  const targetViewportKeys = getLinkedTargetViewportKeys(sourceViewportKey)
  targetViewportKeys.forEach((targetViewportKey) => {
    const targetStack = state.viewportStacks[targetViewportKey]
    let sliceIndex = typeof options.sliceIndex === 'number'
      ? Math.min(Math.max(options.sliceIndex, 0), Math.max(0, (targetStack?.imageIds.length ?? 1) - 1))
      : undefined

    if (type === 'set-slice' && targetStack && options.sourceInstance) {
      const metadataSliceIndex = getNearestMetadataLinkedImageIndex(options.sourceInstance, targetStack.instances)
      if (typeof metadataSliceIndex === 'number') {
        sliceIndex = Math.min(Math.max(metadataSliceIndex, 0), Math.max(0, targetStack.imageIds.length - 1))
      } else if (!isSameSeries(options.sourceInstance, targetStack.instances[0])) {
        return
      }
    }

    state.sendViewportCommand(type, targetViewportKey, {
      ...options,
      sliceIndex,
      sourceViewportKey,
    })
  })
}

function getLinkedTargetViewportKeys(sourceViewportKey: string) {
  const state = useViewerStore.getState()
  const visibleKeys = getVisibleViewportKeys(state.viewportLayout)

  return visibleKeys.filter((viewportKey) => (
    viewportKey !== sourceViewportKey && Boolean(state.viewportStacks[viewportKey]?.imageIds.length)
  ))
}

function getVisibleViewportKeys(layout: string) {
  const [rows = 1, columns = 1] = layout.split('x').map(Number)
  const visibleCount = rows * columns

  return Array.from({ length: visibleCount }, (_, index) => String(index))
}

function scheduleReferenceLinesRefresh(sourceViewportKey: string) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => refreshReferenceLines(sourceViewportKey))
  })
}

function getCurrentStackImageIndex(viewport: Types.IStackViewport, viewportKey: string) {
  const currentIndex = (viewport as Types.IStackViewport & { getCurrentImageIdIndex?: () => number }).getCurrentImageIdIndex?.()
  if (Number.isFinite(currentIndex)) {
    return Math.round(currentIndex as number)
  }

  return Math.round(useViewerStore.getState().viewportSliceIndexes[viewportKey] ?? 0)
}

function getAnimatedScrubStepIndex(currentIndex: number, targetIndex: number) {
  const distance = targetIndex - currentIndex
  if (!distance) {
    return targetIndex
  }

  const magnitude = Math.abs(distance)
  const step = Math.max(1, Math.ceil(magnitude / stackAnimatedScrubMaxSteps))
  return currentIndex + Math.sign(distance) * step
}

function getRenderedPreviewDimensions(element: HTMLElement, instance: InstanceSummary) {
  const rect = element.getBoundingClientRect()
  const viewportWidth = Math.max(1, Math.round(rect.width || element.clientWidth || instance.columns || 512))
  const viewportHeight = Math.max(1, Math.round(rect.height || element.clientHeight || instance.rows || 512))
  const sourceColumns = Math.max(1, instance.columns || 512)
  const sourceRows = Math.max(1, instance.rows || 512)
  const pixelSpacing = instance.metadata ? readDicomNumberValues(instance.metadata, '00280030') : []
  const rowSpacing = Number.isFinite(pixelSpacing[0]) && pixelSpacing[0] > 0 ? pixelSpacing[0] : 1
  const columnSpacing = Number.isFinite(pixelSpacing[1]) && pixelSpacing[1] > 0 ? pixelSpacing[1] : 1
  const physicalWidth = sourceColumns * columnSpacing
  const physicalHeight = sourceRows * rowSpacing
  const targetMaxEdge = Math.min(renderedPreviewMaxEdge, Math.max(viewportWidth, viewportHeight))
  const physicalScale = targetMaxEdge / Math.max(physicalWidth, physicalHeight)

  return {
    columns: Math.max(64, Math.round(physicalWidth * physicalScale)),
    rows: Math.max(64, Math.round(physicalHeight * physicalScale)),
  }
}

function refreshReferenceLines(sourceViewportKey: string) {
  const state = useViewerStore.getState()
  if (!state.referenceLinesEnabled) {
    return
  }

  const visibleKeys = getVisibleViewportKeys(state.viewportLayout)
  const sourceViewportId = `nexia-stack-viewport-${sourceViewportKey}`

  visibleKeys.forEach((viewportKey) => {
    const toolGroup = ToolGroupManager.getToolGroup(`nexia-stack-tools-${viewportKey}`)
    if (!toolGroup || !state.viewportStacks[viewportKey]?.imageIds.length) {
      return
    }

    try {
      toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
        sourceViewportId,
        enforceSameFrameOfReference: false,
        showFullDimension: true,
      })
      toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
    } catch {
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
    }
  })
}

function toVoiRange(windowLevel: { windowWidth: number; windowLevel: number }) {
  const lower = windowLevel.windowLevel - windowLevel.windowWidth / 2
  const upper = windowLevel.windowLevel + windowLevel.windowWidth / 2

  return { lower, upper }
}

function normalizeRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360
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

function getViewportWindowLevel(viewport: Types.IStackViewport) {
  const properties = viewport.getProperties() as { voiRange?: { lower: number; upper: number } }
  const lower = properties.voiRange?.lower ?? 0
  const upper = properties.voiRange?.upper ?? 0
  const windowWidth = upper - lower
  const windowLevel = lower + windowWidth / 2

  return {
    windowWidth,
    windowLevel,
  }
}

type RoiToolInstance = {
  isPointNearTool?: (element: HTMLDivElement, annotation: unknown, canvasCoords: Types.Point2, proximity: number, interactionType?: string) => boolean
  __nexiaInteriorMovePatched?: boolean
}

function enableRoiInteriorMove(toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>> | null | undefined) {
  if (!toolGroup) {
    return
  }

  movableRoiToolNames.forEach((toolName) => {
    const tool = toolGroup.getToolInstance(toolName) as RoiToolInstance | undefined
    if (!tool?.isPointNearTool || tool.__nexiaInteriorMovePatched) {
      return
    }

    const originalIsPointNearTool = tool.isPointNearTool.bind(tool)
    tool.isPointNearTool = (element, annotationItem, canvasCoords, proximity, interactionType) => (
      originalIsPointNearTool(element, annotationItem, canvasCoords, proximity, interactionType)
      || isPointInsideMovableRoi(toolName, element, annotationItem, canvasCoords)
    )
    tool.__nexiaInteriorMovePatched = true
  })
}

function isPointInsideMovableRoi(toolName: string, element: HTMLDivElement, annotationItem: unknown, canvasCoords: Types.Point2) {
  const canvasPoints = getAnnotationCanvasPoints(element, annotationItem)
  if (canvasPoints.length < 2) {
    return false
  }

  if (toolName === CircleROITool.toolName) {
    const [center, edge] = canvasPoints
    const radius = getDistance(center, edge)
    return radius > 0 && getDistance(center, canvasCoords) < radius
  }

  if (toolName === RectangleROITool.toolName) {
    const bounds = getCanvasBounds(canvasPoints)
    return isPointInsideBounds(canvasCoords, bounds)
  }

  if (toolName === EllipticalROITool.toolName) {
    const bounds = getCanvasBounds(canvasPoints)
    const radiusX = bounds.width / 2
    const radiusY = bounds.height / 2
    if (radiusX <= 0 || radiusY <= 0) {
      return false
    }
    const centerX = bounds.left + radiusX
    const centerY = bounds.top + radiusY
    const normalizedX = (canvasCoords[0] - centerX) / radiusX
    const normalizedY = (canvasCoords[1] - centerY) / radiusY
    return normalizedX * normalizedX + normalizedY * normalizedY < 1
  }

  if (toolName === PlanarFreehandROITool.toolName) {
    if (canvasPoints.length < 3 || !canvasPoints.every(isFiniteCanvasPoint)) {
      return false
    }
    return isPointInsidePolygon(canvasCoords, canvasPoints)
  }

  return false
}

function getAnnotationCanvasPoints(element: HTMLDivElement, annotationItem: unknown): Types.Point2[] {
  const enabledElement = getEnabledElement(element)
  const viewport = enabledElement?.viewport
  if (!viewport) {
    return []
  }

  const annotationData = annotationItem as {
    data?: {
      handles?: { points?: Types.Point3[] }
      contour?: { polyline?: Types.Point3[] }
    }
  }
  const handlePoints = annotationData.data?.handles?.points ?? []
  const contourPoints = annotationData.data?.contour?.polyline ?? []
  const worldPoints = contourPoints.length >= 2 ? contourPoints : handlePoints

  return worldPoints
    .filter((point): point is Types.Point3 => Array.isArray(point) && point.length >= 3)
    .map((point) => viewport.worldToCanvas(point) as Types.Point2)
    .filter(isFiniteCanvasPoint)
}

function isFiniteCanvasPoint(point: Types.Point2 | undefined): point is Types.Point2 {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
}

function getCanvasBounds(points: Types.Point2[]) {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  }
}

function isPointInsideBounds(point: Types.Point2, bounds: { left: number; top: number; width: number; height: number }) {
  return point[0] > bounds.left
    && point[0] < bounds.left + bounds.width
    && point[1] > bounds.top
    && point[1] < bounds.top + bounds.height
}

function isPointInsidePolygon(point: Types.Point2, polygon: Types.Point2[]) {
  let inside = false

  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
    const current = polygon[index]
    const previous = polygon[previousIndex]
    const intersects = ((current[1] > point[1]) !== (previous[1] > point[1]))
      && point[0] < ((previous[0] - current[0]) * (point[1] - current[1])) / ((previous[1] - current[1]) || Number.EPSILON) + current[0]
    if (intersects) {
      inside = !inside
    }
  }

  return inside
}

function getDistance(pointA: Types.Point2, pointB: Types.Point2) {
  return Math.hypot(pointA[0] - pointB[0], pointA[1] - pointB[1])
}

function getToolBindings(toolName: string) {
  if (toolName === ZoomTool.toolName) {
    return [
      { mouseButton: ToolEnums.MouseBindings.Primary },
      { numTouchPoints: 1 },
      { numTouchPoints: 2 },
    ]
  }

  if (toolName === PanTool.toolName || toolName === WindowLevelTool.toolName) {
    return [
      { mouseButton: ToolEnums.MouseBindings.Primary },
      { numTouchPoints: 1 },
    ]
  }

  return [
    { mouseButton: ToolEnums.MouseBindings.Primary },
    { numTouchPoints: 1 },
  ]
}

function formatRenderError(error: unknown, _imageId: string) {
  const message = error instanceof Error ? error.message : 'Cornerstone failed to render image'
  const sanitizedMessage = message
    .replace(/\b\d+(?:\.\d+){3,}\b/g, '[identifier hidden]')
    .replace(/https?:\/\/\S+/gi, '[request hidden]')

  return `Unable to render diagnostic image. ${sanitizedMessage}`
}

function applyDefaultImageProperties(viewport: Types.IStackViewport, imageId: string, modality: string) {
  const image = viewport.getCornerstoneImage?.() as
    | {
        getPixelData?: () => ArrayLike<number>
        slope?: number
        intercept?: number
        bitsStored?: number
        pixelRepresentation?: number
        minPixelValue?: number
        maxPixelValue?: number
        invert?: boolean
        isPreScaled?: boolean
        preScale?: { scaled?: boolean }
        imageFrame?: { preScale?: { scaled?: boolean } }
      }
    | undefined
  const voiLutModule = metaData.get('voiLutModule', imageId) as
    | { windowCenter?: number[]; windowWidth?: number[] }
    | undefined
  const imagePixelModule = metaData.get('imagePixelModule', imageId) as
    | { photometricInterpretation?: string; samplesPerPixel?: number; rescaleSlope?: number; rescaleIntercept?: number; bitsStored?: number; pixelRepresentation?: number }
    | undefined
  const windowCenter = voiLutModule?.windowCenter?.[0]
  const windowWidth = voiLutModule?.windowWidth?.[0]
  const photometricInterpretation = imagePixelModule?.photometricInterpretation?.toUpperCase()
  const isRgbImage = photometricInterpretation === 'RGB' || Number(imagePixelModule?.samplesPerPixel) === 3
  const displayRange = isRgbImage
    ? { lower: 0, upper: 255 }
    : getProjectionDefaultVoiRange(image, imagePixelModule, modality)
  const hasWindow = !displayRange && shouldApplyDicomWindow(modality) && Number.isFinite(windowCenter) && Number.isFinite(windowWidth) && (windowWidth as number) > 1
  const fallbackRange = displayRange ?? (hasWindow ? null : getAutoVoiRange(image, imagePixelModule, modality))

  viewport.setProperties({
    ...(hasWindow
      ? {
          voiRange: {
            lower: (windowCenter as number) - (windowWidth as number) / 2,
            upper: (windowCenter as number) + (windowWidth as number) / 2,
          },
        }
      : fallbackRange
        ? { voiRange: fallbackRange }
        : {}),
    invert: !isRgbImage && (Boolean(image?.invert) || photometricInterpretation === 'MONOCHROME1'),
  })
}

function formatStackIchThresholdStatus(scope: 'slice' | 'stack', result: IchThresholdResult) {
  const scopeLabel = scope === 'slice' ? 'Slice' : 'Stack'
  const voxelText = `${result.matchedVoxels.toLocaleString('id-ID')} vox`
  const volumeText = result.volumeMl !== null ? ` | ${formatVolumeMl(result.volumeMl)} mL` : ''
  const skippedText = result.skippedSlices > 0 ? ` | skip ${result.skippedSlices}` : ''
  const canceledText = result.canceled ? ' | canceled' : ''

  return `${scopeLabel}: ${voxelText}${volumeText}${skippedText}${canceledText}`
}

function formatStackIchSmartDragStatus(result: IchSmartDragResult, mode: 'add' | 'erase') {
  if (!result.seedAccepted) {
    return 'Smart Drag: seed di luar target HU'
  }

  const prefix = mode === 'erase' ? 'Smart clear' : 'Smart add'
  const sign = mode === 'erase' ? '-' : '+'
  const voxelText = `${sign}${result.matchedVoxels.toLocaleString('id-ID')} vox`
  const volumeText = result.volumeMl !== null ? ` | ${sign}${formatVolumeMl(result.volumeMl)} mL` : ''
  const totalText = result.totalVolumeMl !== null ? ` | total ${formatVolumeMl(result.totalVolumeMl)} mL` : ''
  const rangeText = ` | HU ${Math.round(result.minimumHu)}-${Math.round(result.maximumHu)}`
  const limitText = result.reachedLimit ? ' | limited' : ''

  return `${prefix}: ${voxelText}${volumeText}${totalText}${rangeText}${limitText}`
}

function formatStackIchAdaptiveStatus(result: IchAdaptiveStackGrowResult, refine = false) {
  if (result.matchedVoxels === 0) {
    if (result.canceled) {
      return refine ? 'Refine canceled' : 'Adaptive canceled'
    }

    const totalText = result.totalVolumeMl !== null ? ` | total ${formatVolumeMl(result.totalVolumeMl)} mL` : ''
    return refine ? `Refinement: no additional voxels${totalText}` : 'Adaptive segmentation: the seed did not grow'
  }

  const voxelPrefix = refine ? '+' : ''
  const voxelText = `${voxelPrefix}${result.matchedVoxels.toLocaleString('id-ID')} vox`
  const volumeText = result.volumeMl !== null ? ` | ${refine ? '+' : ''}${formatVolumeMl(result.volumeMl)} mL` : ''
  const totalText = result.totalVolumeMl !== null ? ` | total ${formatVolumeMl(result.totalVolumeMl)} mL` : ''
  const skippedText = result.skippedSlices > 0 ? ` | stop ${result.skippedSlices}` : ''
  const leakageText = result.stoppedByLeakage ? ' | boundary stop' : ''
  const canceledText = result.canceled ? ' | canceled' : ''
  const label = refine ? 'Refine' : 'Adaptive'

  return `${label}: ${voxelText}${volumeText}${totalText}${skippedText}${leakageText}${canceledText}`
}

function formatStackIchGrowStatus(result: IchRegionGrowResult) {
  if (!result.seedAccepted) {
    return 'Grow: seed di luar HU'
  }

  const voxelText = `${result.matchedVoxels.toLocaleString('id-ID')} vox`
  const volumeText = result.volumeMl !== null ? ` | ${formatVolumeMl(result.volumeMl)} mL` : ''
  const limitText = result.reachedLimit ? ' | limited' : ''

  return `Grow: ${voxelText}${volumeText}${limitText}`
}

function deriveIchThresholdFromSeeds(centerHu: number, edgeHu: number) {
  const lowerSeed = Math.min(centerHu, edgeHu)
  const upperSeed = Math.max(centerHu, edgeHu)
  const spread = Math.max(10, Math.abs(centerHu - edgeHu) * 0.35)

  return {
    minimumHu: Math.floor(Math.max(-1000, lowerSeed - spread)),
    maximumHu: Math.ceil(Math.min(3000, upperSeed + spread)),
  }
}

function formatVolumeMl(volumeMl: number) {
  if (volumeMl >= 10) {
    return volumeMl.toFixed(1)
  }

  return volumeMl.toFixed(2)
}

function shouldApplyDicomWindow(modality: string) {
  return ['CT', 'MR', 'PT', 'XA', 'XRF', 'RF', 'DX', 'CR', 'PX', 'MG'].includes(modality.toUpperCase())
}

function shouldUseAutoVoiRange(modality: string) {
  return ['XA', 'XRF', 'RF', 'DX', 'CR', 'PX', 'MG'].includes(modality.toUpperCase())
}

function isProjectionModality(modality: string) {
  return ['XA', 'XRF', 'RF'].includes(modality.toUpperCase())
}

function getProjectionDefaultVoiRange(
  image: {
    slope?: number
    intercept?: number
    bitsStored?: number
    pixelRepresentation?: number
    minPixelValue?: number
    maxPixelValue?: number
    isPreScaled?: boolean
    preScale?: { scaled?: boolean }
    imageFrame?: { preScale?: { scaled?: boolean } }
  } | undefined,
  imagePixelModule: { rescaleSlope?: number; rescaleIntercept?: number; bitsStored?: number; pixelRepresentation?: number } | undefined,
  modality: string,
) {
  if (!isProjectionModality(modality)) {
    return null
  }

  const alreadyScaled = isImagePixelDataScaled(image)
  const slope = alreadyScaled ? 1 : Number(image?.slope ?? imagePixelModule?.rescaleSlope ?? 1) || 1
  const intercept = alreadyScaled ? 0 : Number(image?.intercept ?? imagePixelModule?.rescaleIntercept ?? 0) || 0
  const bitsStored = Number(image?.bitsStored ?? imagePixelModule?.bitsStored)
  const pixelRepresentation = Number(image?.pixelRepresentation ?? imagePixelModule?.pixelRepresentation ?? 0)

  if (Number.isFinite(bitsStored) && bitsStored > 0 && bitsStored <= 16) {
    const storedLower = pixelRepresentation === 1 ? -Math.pow(2, bitsStored - 1) : 0
    const storedUpper = pixelRepresentation === 1 ? Math.pow(2, bitsStored - 1) : Math.pow(2, bitsStored)
    return {
      lower: storedLower * slope + intercept,
      upper: storedUpper * slope + intercept,
    }
  }

  const minPixel = Number(image?.minPixelValue)
  const maxPixel = Number(image?.maxPixelValue)
  if (Number.isFinite(minPixel) && Number.isFinite(maxPixel) && maxPixel > minPixel) {
    return {
      lower: minPixel * slope + intercept,
      upper: (Number.isInteger(maxPixel) ? maxPixel + 1 : maxPixel) * slope + intercept,
    }
  }

  return null
}

function getAutoVoiRange(
  image: {
    getPixelData?: () => ArrayLike<number>
    slope?: number
    intercept?: number
    bitsStored?: number
    pixelRepresentation?: number
    minPixelValue?: number
    maxPixelValue?: number
    invert?: boolean
    isPreScaled?: boolean
    preScale?: { scaled?: boolean }
    imageFrame?: { preScale?: { scaled?: boolean } }
  } | undefined,
  imagePixelModule: { rescaleSlope?: number; rescaleIntercept?: number } | undefined,
  modality: string,
) {
  if (!shouldUseAutoVoiRange(modality) || !image) {
    return null
  }

  const pixelData = image.getPixelData?.()
  const alreadyScaled = isImagePixelDataScaled(image)
  const slope = alreadyScaled ? 1 : Number(image.slope ?? imagePixelModule?.rescaleSlope ?? 1) || 1
  const intercept = alreadyScaled ? 0 : Number(image.intercept ?? imagePixelModule?.rescaleIntercept ?? 0) || 0

  if (pixelData?.length) {
    const range = getPixelPercentileRange(pixelData, slope, intercept)
    if (range) {
      return range
    }
  }

  const minPixel = Number(image.minPixelValue)
  const maxPixel = Number(image.maxPixelValue)
  if (Number.isFinite(minPixel) && Number.isFinite(maxPixel) && maxPixel > minPixel) {
    return {
      lower: minPixel * slope + intercept,
      upper: maxPixel * slope + intercept,
    }
  }

  return null
}

function isImagePixelDataScaled(
  image:
    | {
        isPreScaled?: boolean
        preScale?: { scaled?: boolean }
        imageFrame?: { preScale?: { scaled?: boolean } }
      }
    | undefined,
) {
  return Boolean(image?.isPreScaled || image?.preScale?.scaled || image?.imageFrame?.preScale?.scaled)
}

function getPixelPercentileRange(pixelData: ArrayLike<number>, slope: number, intercept: number) {
  const length = pixelData.length
  if (!length) {
    return null
  }

  const sampleCount = Math.min(length, 120000)
  const stride = Math.max(1, Math.floor(length / sampleCount))
  const values: number[] = []
  for (let index = 0; index < length; index += stride) {
    const value = Number(pixelData[index]) * slope + intercept
    if (Number.isFinite(value)) {
      values.push(value)
    }
  }
  if (values.length < 2) {
    return null
  }

  values.sort((a, b) => a - b)
  const lower = values[Math.floor(values.length * 0.005)]
  const upper = values[Math.max(0, Math.ceil(values.length * 0.995) - 1)]
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
    return null
  }

  return { lower, upper }
}
