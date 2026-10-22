import { Enums, metaData, type Types } from '@cornerstonejs/core'
import {
  AngleTool,
  ArrowAnnotateTool,
  BidirectionalTool,
  CircleROITool,
  CobbAngleTool,
  EllipticalROITool,
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
} from '@cornerstonejs/tools'
import { stackPrefetch } from '@cornerstonejs/tools/utilities'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DicomJsonDataset, InstanceSummary } from '../../dicomweb/types'
import { clearAllAnnotations, deleteSelectedAnnotations } from '../annotationActions'
import { fetchRenderedPreviewDataUrl, RENDERED_VIEWPORT_PREVIEW_SIZE } from '../../dicomweb/client'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import {
  getStackInitialImageIndex,
  prewarmStackNeighbors,
  primeStackImagesForDisplay,
  requestStackImageForDisplay,
} from '../cornerstone/progressiveLoading'
import { acquireStackRenderingEngine, releaseStackRenderingEngine, STACK_RENDERING_ENGINE_ID } from '../cornerstone/stackRenderingEngine'
import { useViewerStore } from '../viewerStore'

type DicomViewportProps = {
  viewportKey?: string
  imageIds: string[]
  instances?: InstanceSummary[]
  previewInstance?: InstanceSummary
  modality?: string
  isSelected?: boolean
  referenceLinesEnabled?: boolean
  showEmptyState?: boolean
  onSelect?: () => void
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

type Stack3dCursorCanvas = {
  point: Types.Point2
  color: string
  inBounds: boolean
} | null

type ImagePlaneInfo = {
  origin: Types.Point3
  normal: Types.Point3
}

type LiveProbeValue = {
  canvasPoint: Types.Point2
  value: number
  unit: string
}

function removeProgressivePreview(element: HTMLElement | null) {
  if (!element) return
  const overlay = element.querySelector('canvas[data-vexa-progressive-preview]')
  if (overlay?.parentElement) {
    overlay.remove()
  }
}

type DiagnosticImageState = 'jpeg-preview' | 'raw-loading' | 'raw-ready'

function updateDiagnosticImageState(element: HTMLElement | null, state: DiagnosticImageState, imageIndex?: number) {
  if (!element) return
  const now = performance.now()
  if (state === 'raw-loading') {
    element.dataset.vexaRawStartedAt = String(now)
  }
  element.dataset.vexaDiagnosticState = state
  const rawStartedAt = Number(element.dataset.vexaRawStartedAt)
  window.dispatchEvent(new CustomEvent('vexa-mobile-viewer-diagnostic-state', {
    detail: {
      state,
      imageIndex,
      viewportKey: element.dataset.vexaViewportKey,
      elapsedMs: state === 'raw-ready' && Number.isFinite(rawStartedAt) ? Math.max(0, Math.round(now - rawStartedAt)) : undefined,
      timestamp: now,
    },
  }))
}

function isRenderableViewportElement(element: HTMLElement | null) {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 1 && rect.height > 1
}

function getInstanceFrameForImageIndex(instances: InstanceSummary[], imageIndex: number) {
  let remaining = Math.max(0, Math.floor(imageIndex))
  for (const instance of instances) {
    const frameCount = Math.max(1, instance.numberOfFrames || 1)
    if (remaining < frameCount) return { instance, frame: remaining + 1 }
    remaining -= frameCount
  }
  return null
}

function getServerPreviewDimensions(element: HTMLElement, instance: InstanceSummary) {
  const rect = element.getBoundingClientRect()
  const deviceScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const viewportMaxEdge = Math.ceil(Math.max(rect.width, rect.height) * deviceScale)
  const maxEdge = Math.min(1024, Math.max(RENDERED_VIEWPORT_PREVIEW_SIZE, viewportMaxEdge))
  const rows = Math.max(1, instance.rows || RENDERED_VIEWPORT_PREVIEW_SIZE)
  const columns = Math.max(1, instance.columns || RENDERED_VIEWPORT_PREVIEW_SIZE)
  if (columns >= rows) return { columns: maxEdge, rows: Math.max(1, Math.round(maxEdge * rows / columns)) }
  return { rows: maxEdge, columns: Math.max(1, Math.round(maxEdge * columns / rows)) }
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
  ProbeTool.toolName,
]

const toolNameById: Record<string, string> = {
  WindowLevel: WindowLevelTool.toolName,
  Pan: PanTool.toolName,
  Zoom: ZoomTool.toolName,
  Magnify: MagnifyTool.toolName,
  Length: LengthTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  RectangleROI: RectangleROITool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
  Probe: ProbeTool.toolName,
}

export function DicomViewport({ viewportKey = 'primary', imageIds, instances = [], previewInstance, modality = '', isSelected = false, referenceLinesEnabled = true, showEmptyState = true, onSelect }: DicomViewportProps) {
  const fallbackPreviewIndex = imageIds.length > 20 ? Math.floor(imageIds.length / 2) : 0
  const renderedPreviewInstance = previewInstance ?? instances[Math.min(fallbackPreviewIndex, instances.length - 1)]
  const renderedPreviewIndex = previewInstance
    ? Math.max(0, (previewInstance.instanceNumber || 1) - 1)
    : fallbackPreviewIndex
  const elementRef = useRef<HTMLDivElement>(null)
  const renderingEngineRef = useRef<ReturnType<typeof acquireStackRenderingEngine> | null>(null)
  const stackReadyRef = useRef(false)
  const scrollGestureRef = useRef<{ pointerId: number; y: number; sliceIndex: number } | null>(null)
  const queuedSliceIndexRef = useRef<number | null>(null)
  const sliceCommitFrameRef = useRef<number | null>(null)
  const sliceCommitBusyRef = useRef(false)
  const cancelSlicePrewarmRef = useRef<(() => void) | null>(null)
  const applyingLinkedCommandRef = useRef(false)
  const ctrIdRef = useRef(0)
  const ctrAnnotationsRef = useRef<CTRAnnotation[]>([])
  const selectedCtrAnnotationIdRef = useRef<string | null>(null)
  const selectedCustomMarkerRef = useRef<{ type: 'text' | 'shape'; id: string } | null>(null)
  const ctrTextDragRef = useRef<{ annotationId: string; pointerId: number } | null>(null)
  const customMarkerDragRef = useRef<{ marker: { type: 'text' | 'shape'; id: string }; pointerId: number; lastWorldPosition: Types.Point3 } | null>(null)
  const stack3dCursorDragRef = useRef<{ pointerId: number } | null>(null)
  const stack3dCursor = useViewerStore((state) => state.stack3dCursor)
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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const previewRequestRef = useRef<AbortController | null>(null)
  const previewGenerationRef = useRef(0)
  const previewTargetIndexRef = useRef<number | null>(null)
  const rawReadyIndexRef = useRef<number | null>(null)
  const [liveProbeValue, setLiveProbeValue] = useState<LiveProbeValue | null>(null)
  const liveProbePointerIdRef = useRef<number | null>(null)
  const [stackReadyTick, setStackReadyTick] = useState(0)
  const [shapeMarkers, setShapeMarkers] = useState<Array<ShapeMarkerAnnotation & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }>>([])
  const [shapeMarkerDraft, setShapeMarkerDraft] = useState<(ShapeMarkerDraft & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }) | null>(null)
  const [, setSelectedCustomMarker] = useState<{ type: 'text' | 'shape'; id: string } | null>(null)
  const renderingEngineId = STACK_RENDERING_ENGINE_ID
  const viewportId = `nexia-stack-viewport-${viewportKey}`
  const toolGroupId = `nexia-stack-tools-${viewportKey}`
  const hasActiveSelection = useViewerStore((state) => Boolean(state.activeStudy || state.activeSeries))
  const activeTool = useViewerStore((state) => state.activeTool)
  const viewportCommand = useViewerStore((state) => state.viewportCommand)
  const viewportSliceIndex = useViewerStore((state) => state.viewportSliceIndexes[viewportKey] ?? 0)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const viewportLayout = useViewerStore((state) => state.viewportLayout)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const setViewportSliceIndex = useViewerStore((state) => state.setViewportSliceIndex)
  const setViewportZoom = useViewerStore((state) => state.setViewportZoom)
  const setViewportWindowLevel = useViewerStore((state) => state.setViewportWindowLevel)
  const setStack3dCursor = useViewerStore((state) => state.setStack3dCursor)

  const clearServerRenderedPreview = useCallback(() => {
    previewGenerationRef.current += 1
    previewTargetIndexRef.current = null
    previewRequestRef.current?.abort()
    previewRequestRef.current = null
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
  }, [])

  const requestServerRenderedSlice = useCallback((targetIndex: number) => {
    if (import.meta.env.VITE_MOBILE_HYBRID_SSR === 'false' || useViewerStore.getState().activeTool !== 'Scroll') {
      return
    }
    const frameReference = getInstanceFrameForImageIndex(instances, targetIndex)
    const element = elementRef.current
    if (!frameReference || !element || !isRenderableViewportElement(element)) return

    const generation = previewGenerationRef.current + 1
    const controller = new AbortController()
    previewGenerationRef.current = generation
    previewTargetIndexRef.current = targetIndex
    previewRequestRef.current?.abort()
    previewRequestRef.current = controller

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const windowLevel = viewport ? getViewportWindowLevel(viewport) : null
    const dimensions = getServerPreviewDimensions(element, frameReference.instance)
    void fetchRenderedPreviewDataUrl(frameReference.instance, {
      frame: frameReference.frame,
      rows: dimensions.rows,
      columns: dimensions.columns,
      quality: 72,
      ...(windowLevel && windowLevel.windowWidth > 1
        ? { windowCenter: windowLevel.windowLevel, windowWidth: windowLevel.windowWidth }
        : {}),
    }, controller.signal).then((url) => {
      if (
        !url
        || controller.signal.aborted
        || previewGenerationRef.current !== generation
        || previewTargetIndexRef.current !== targetIndex
        || rawReadyIndexRef.current === targetIndex
      ) {
        if (url) URL.revokeObjectURL(url)
        return
      }
      updateDiagnosticImageState(element, 'jpeg-preview', targetIndex)
      setPreviewUrl((current) => {
        if (current && current !== url) URL.revokeObjectURL(current)
        return url
      })
    }).catch(() => undefined).finally(() => {
      if (previewRequestRef.current === controller) previewRequestRef.current = null
    })
  }, [instances, viewportId])

  useEffect(() => {
    stack3dCursorRef.current = stack3dCursor
  }, [stack3dCursor])

  useEffect(() => {
    if (activeTool !== 'Stack3DCursor') {
      setStack3dCursorCanvas(null)
    }
  }, [activeTool])

  useEffect(() => {
    const element = elementRef.current
    if (!element) {
      return
    }

    initializeCornerstone()

    const renderingEngine = acquireStackRenderingEngine()
    renderingEngine.enableElement({
      viewportId,
      element,
      type: Enums.ViewportType.STACK,
    })
    element.dataset.vexaViewportKey = viewportKey
    renderingEngineRef.current = renderingEngine
    const resizeObserver = new ResizeObserver(() => {
      renderingEngine.resize(true, false)
    })
    resizeObserver.observe(element)
    const stackNewImageHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ imageIdIndex?: number }>).detail
      if (Number.isFinite(detail?.imageIdIndex)) {
        const sliceIndex = detail.imageIdIndex as number
        setViewportSliceIndex(viewportKey, sliceIndex)
        scheduleReferenceLinesRefresh(viewportKey)
        if (!applyingLinkedCommandRef.current) {
          broadcastLinkedCommand(viewportKey, 'scroll', 'set-slice', { sliceIndex })
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
      const activeViewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport | undefined
      const renderedIndex = activeViewport?.getCurrentImageIdIndex?.()
      rawReadyIndexRef.current = typeof renderedIndex === 'number' ? renderedIndex : null
      const previewTargetIndex = previewTargetIndexRef.current
      if (previewTargetIndex !== null && renderedIndex !== previewTargetIndex) return
      updateDiagnosticImageState(element, 'raw-ready')
      removeProgressivePreview(element)
      clearServerRenderedPreview()
    }
    const refreshViewportOverlays = () => {
      const activeViewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport | undefined
      setCtrCanvasAnnotations(buildCtrCanvasAnnotations(ctrAnnotationsRef.current, activeViewport))
      setTextMarkers(buildTextMarkerCanvasAnnotations(textMarkersRef.current, activeViewport))
      setShapeMarkers(buildShapeMarkerCanvasAnnotations(shapeMarkersRef.current, activeViewport))
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

      toolGroup?.addTool(toolName)
    })
    toolGroup?.addTool(StackScrollTool.toolName)
    toolGroup?.addTool(ReferenceLinesTool.toolName)

    return () => {
      resizeObserver.disconnect()
      element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, stackNewImageHandler)
      element.removeEventListener(Enums.Events.IMAGE_RENDERED, imageRenderedHandler)
      element.removeEventListener(Enums.Events.IMAGE_RENDERED, refreshViewportOverlays)
      element.removeEventListener(Enums.Events.VOI_MODIFIED, voiModifiedHandler)
      element.removeEventListener(Enums.Events.CAMERA_MODIFIED, updateCameraInfo)
      element.removeEventListener(Enums.Events.CAMERA_MODIFIED, refreshViewportOverlays)
      stackPrefetch.disable(element)
      if (sliceCommitFrameRef.current !== null) {
        window.cancelAnimationFrame(sliceCommitFrameRef.current)
        sliceCommitFrameRef.current = null
      }
      cancelSlicePrewarmRef.current?.()
      cancelSlicePrewarmRef.current = null
      clearServerRenderedPreview()
      ToolGroupManager.destroyToolGroup(toolGroupId)
      releaseStackRenderingEngine(viewportId)
      renderingEngineRef.current = null
    }
  }, [clearServerRenderedPreview, renderingEngineId, setViewportSliceIndex, setViewportWindowLevel, toolGroupId, viewportId, viewportKey])

  useEffect(() => {
    if (activeTool !== 'Scroll' && previewTargetIndexRef.current !== null) clearServerRenderedPreview()
  }, [activeTool, clearServerRenderedPreview])

  // Progressive first paint can arrive before full stack metadata is available.
  useEffect(() => {
    const element = elementRef.current
    if (!element || !renderedPreviewInstance?.sopInstanceUid) {
      return
    }

    let cancelled = false
    let objectUrl: string | null = null

    const doPaint = async () => {
      if (cancelled) return
      const url = await fetchRenderedPreviewDataUrl(renderedPreviewInstance, {
        rows: RENDERED_VIEWPORT_PREVIEW_SIZE,
        columns: RENDERED_VIEWPORT_PREVIEW_SIZE,
        quality: 60,
      })
      if (cancelled || !url || element.dataset.vexaDiagnosticState === 'raw-ready') {
        if (url) URL.revokeObjectURL(url)
        return
      }
      objectUrl = url
      updateDiagnosticImageState(element, 'jpeg-preview', renderedPreviewIndex)
      setPreviewUrl((current) => {
        if (current && current !== url) URL.revokeObjectURL(current)
        return url
      })
    }

    void doPaint()

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [previewInstance, renderedPreviewIndex, renderedPreviewInstance])

  useEffect(() => {
    const renderingEngine = renderingEngineRef.current
    if (!renderingEngine || !imageIds.length) {
      stackReadyRef.current = false
      return
    }

    const viewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport
    const element = elementRef.current
    const initialImageIndex = getStackInitialImageIndex(imageIds.length)
    setLoadingMessage(`Rendering ${imageIds.length} image${imageIds.length > 1 ? 's' : ''}...`)
    setErrorMessage('')
    const initialImageId = imageIds[initialImageIndex]

    if (element) {
      stackPrefetch.disable(element)
    }
    stackReadyRef.current = false
    rawReadyIndexRef.current = null
    queuedSliceIndexRef.current = null
    cancelSlicePrewarmRef.current?.()
    cancelSlicePrewarmRef.current = null
    updateDiagnosticImageState(element, 'raw-loading', initialImageIndex)

    let cancelled = false
    let cancelNeighborPrewarm: (() => void) | undefined

    const loadStack = async () => {
      if (element) {
        const hasSize = await waitForRenderableViewportElement(element)
        if (!hasSize || cancelled) {
          return
        }
      }

      primeStackImagesForDisplay(imageIds, initialImageIndex)
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
        stackReadyRef.current = true
        setStackReadyTick((tick) => tick + 1)

        if (element && imageIds.length > 1 && import.meta.env.VITE_STACK_PREFETCH_ENABLED === 'true') {
          stackPrefetch.setConfiguration({
            maxImagesToPrefetch: Math.min(imageIds.length - 1, 2),
            preserveExistingPool: false,
            order: 'closest',
          })
          stackPrefetch.enable(element)
        }
        cancelNeighborPrewarm = prewarmStackNeighbors(imageIds, initialImageIndex, { radius: 2, timeoutMs: 8_000 })
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
  }, [imageIds, modality, setErrorMessage, setLoadingMessage, setViewportSliceIndex, setViewportWindowLevel, setViewportZoom, viewportId, viewportKey])

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
    if (activeTool !== 'Probe') {
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
  }, [activeTool, imageIds, setActiveTool, stackReadyTick, toolGroupId, viewportId])

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
      if (!imageData?.scalarData || !imageData.dimensions) return null

      const worldPoint = viewport.canvasToWorld(canvasPoint)
      const vtkImage = imageData.imageData
      const index = (vtkImage as { worldToIndex?: (point: number[]) => number[] } | undefined)?.worldToIndex?.([
        worldPoint[0],
        worldPoint[1],
        worldPoint[2],
      ])
      if (!index || !Number.isFinite(index[0]) || !Number.isFinite(index[1])) return null

      const col = Math.floor(index[0])
      const row = Math.floor(index[1])
      const columns = imageData.dimensions[0]
      const rows = imageData.dimensions[1]
      if (col < 0 || col >= columns || row < 0 || row >= rows) return null

      const pixelIndex = row * columns + col
      const rawValue = Number(imageData.scalarData[pixelIndex])
      if (!Number.isFinite(rawValue)) return null

      const scaling = imageData.scaling as { rescaleSlope?: number | string; rescaleIntercept?: number | string } | undefined
      const slope = Number(scaling?.rescaleSlope ?? 1) || 1
      const intercept = Number(scaling?.rescaleIntercept ?? 0) || 0
      const modalityCode = modality?.toUpperCase() ?? ''

      return {
        canvasPoint,
        value: rawValue * slope + intercept,
        unit: modalityCode === 'CT' ? 'HU' : modalityCode || 'VAL',
      }
    }

    const updateProbe = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
      setLiveProbeValue(readPixelAtCanvas(canvasPoint))
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      element.setPointerCapture(event.pointerId)
      liveProbePointerIdRef.current = event.pointerId
      updateProbe(event)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (liveProbePointerIdRef.current !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      updateProbe(event)
    }

    const stopLiveProbe = (event: PointerEvent) => {
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
    window.addEventListener('pointerup', stopLiveProbe)
    window.addEventListener('pointercancel', stopLiveProbe)

    return () => {
      element.removeEventListener('pointerdown', handlePointerDown)
      element.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopLiveProbe)
      window.removeEventListener('pointercancel', stopLiveProbe)
      liveProbePointerIdRef.current = null
      setLiveProbeValue(null)
    }
  }, [activeTool, imageIds, modality, stackReadyTick, viewportId])

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
        enforceSameFrameOfReference: true,
        showFullDimension: true,
      })
      toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
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

      if (stack3dCursor.sourceViewportKey !== viewportKey) {
        setStack3dCursorCanvas(buildProjectedStack3dCursorCanvas(stack3dCursor.worldPoint, viewport))
      }
      viewport.render()
    }

    void applyCursorToViewport().catch(() => {
      applyingLinkedCommandRef.current = false
      if (stack3dCursor.sourceViewportKey !== viewportKey) {
        setStack3dCursorCanvas(buildProjectedStack3dCursorCanvas(stack3dCursor.worldPoint, viewport))
      }
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
        event.preventDefault()
        return
      }

      const deleted = deleteSelectedAnnotations(false)
      if (deleted > 0) {
        event.preventDefault()
        renderingEngineRef.current?.getViewport(viewportId)?.render()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSelected, viewportId])

  useEffect(() => {
    const renderingEngine = renderingEngineRef.current
    if (!renderingEngine || !viewportCommand || viewportCommand.targetViewportKey !== viewportKey) {
      return
    }

    const viewport = renderingEngine.getViewport(viewportId) as Types.IStackViewport
    if (!stackReadyRef.current || !imageIds.length) {
      return
    }

    if (viewportCommand.type === 'reset') {
      clearAllAnnotations()
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
        const safeSliceIndex = Math.min(Math.max(sliceIndex, 0), imageIds.length - 1)
        applyingLinkedCommandRef.current = Boolean(viewportCommand.sourceViewportKey)
        requestStackImageForDisplay(imageIds, safeSliceIndex)
        requestServerRenderedSlice(safeSliceIndex)
        updateDiagnosticImageState(elementRef.current, 'raw-loading', safeSliceIndex)
        void (viewport as Types.IStackViewport & { setImageIdIndex: (imageIdIndex: number) => Promise<string> })
          .setImageIdIndex(safeSliceIndex)
          .then(() => {
            cancelSlicePrewarmRef.current?.()
            cancelSlicePrewarmRef.current = prewarmStackNeighbors(imageIds, safeSliceIndex, { radius: 2, timeoutMs: 8_000 })
          })
          .finally(() => {
            applyingLinkedCommandRef.current = false
            scheduleReferenceLinesRefresh(viewportKey)
          })
        setViewportSliceIndex(viewportKey, safeSliceIndex)
        if (!viewportCommand.sourceViewportKey) {
          broadcastLinkedCommand(viewportKey, 'scroll', 'set-slice', { sliceIndex: safeSliceIndex })
        }
      }
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
        return
      }

      if (deleteSelectedAnnotations(true) > 0) {
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

    const preset = getWindowPreset(viewportCommand.type)
    if (preset) {
      viewport.setProperties({ voiRange: preset })
      const windowLevel = getViewportWindowLevel(viewport)
      setViewportWindowLevel(viewportKey, windowLevel)
      viewport.render()
      broadcastLinkedCommand(viewportKey, 'windowLevel', 'set-window-level', { windowLevel })
    }
  }, [imageIds, modality, requestServerRenderedSlice, setViewportSliceIndex, setViewportWindowLevel, setViewportZoom, viewportCommand, viewportId, viewportKey])

  function queueTouchSliceIndex(nextSliceIndex: number) {
    const safeSliceIndex = Math.min(Math.max(nextSliceIndex, 0), imageIds.length - 1)
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!viewport || !stackReadyRef.current || imageIds.length < 2) return

    queuedSliceIndexRef.current = safeSliceIndex
    requestStackImageForDisplay(imageIds, safeSliceIndex)
    requestServerRenderedSlice(safeSliceIndex)
    updateDiagnosticImageState(elementRef.current, 'raw-loading', safeSliceIndex)
    setViewportSliceIndex(viewportKey, safeSliceIndex)

    if (sliceCommitBusyRef.current || sliceCommitFrameRef.current !== null) return
    sliceCommitFrameRef.current = window.requestAnimationFrame(commitQueuedTouchSlice)
  }

  function commitQueuedTouchSlice() {
    sliceCommitFrameRef.current = null
    if (sliceCommitBusyRef.current) return

    const targetIndex = queuedSliceIndexRef.current
    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (targetIndex === null || !viewport || !stackReadyRef.current) return

    queuedSliceIndexRef.current = null
    sliceCommitBusyRef.current = true
    void (viewport as Types.IStackViewport & { setImageIdIndex: (imageIdIndex: number) => Promise<string> })
      .setImageIdIndex(targetIndex)
      .then(() => {
        cancelSlicePrewarmRef.current?.()
        cancelSlicePrewarmRef.current = prewarmStackNeighbors(imageIds, targetIndex, { radius: 2, timeoutMs: 8_000 })
        scheduleReferenceLinesRefresh(viewportKey)
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to render requested image.')
      })
      .finally(() => {
        sliceCommitBusyRef.current = false
        if (queuedSliceIndexRef.current !== null) {
          queueTouchSliceIndex(queuedSliceIndexRef.current)
        }
      })
  }

  function handlePointerDownEvent(event: React.PointerEvent<HTMLDivElement>) {
    onSelect?.()
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

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
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

    const renderingEngine = renderingEngineRef.current
    const viewport = renderingEngine?.getViewport(viewportId) as Types.IStackViewport | undefined
    if (!viewport || !stackReadyRef.current || imageIds.length < 2) {
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
    queueTouchSliceIndex(nextSliceIndex)
  }

  function stopPointerInteraction(event: React.PointerEvent<HTMLDivElement>) {
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
    if (activeTool !== 'Stack3DCursor') {
      if (stack3dCursorCanvas) {
        setStack3dCursorCanvas(null)
      }
      return
    }

    const viewport = renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined
    const element = elementRef.current
    if (!viewport || !element) {
      return
    }

    const rect = element.getBoundingClientRect()
    setStack3dCursorCanvas({
      point: [event.clientX - rect.left, event.clientY - rect.top],
      color: getStack3dCursorColor(viewport),
      inBounds: true,
    })
  }

  function handleContextMenu(event: React.MouseEvent) {
    event.preventDefault()
    if (activeTool === 'CTR4Point') {
      setCtrAnnotations((annotations) => {
        const nextAnnotations = annotations.slice(0, -1)
        ctrAnnotationsRef.current = nextAnnotations
        setCtrCanvasAnnotations(buildCtrCanvasAnnotations(nextAnnotations, renderingEngineRef.current?.getViewport(viewportId) as Types.IStackViewport | undefined))
        return nextAnnotations
      })
      return
    }

    if (deleteSelectedAnnotations(true) > 0) {
      renderingEngineRef.current?.getViewport(viewportId)?.render()
    }
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

  function findCustomMarkerHit(event: React.PointerEvent<HTMLDivElement>): { type: 'text' | 'shape'; id: string } | null {
    const rect = event.currentTarget.getBoundingClientRect()
    const point: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const textHit = textMarkers.find((marker) => isPointNearTextMarker(point, marker))
    if (textHit) {
      return { type: 'text', id: textHit.id }
    }

    const shapeHit = shapeMarkers.find((marker) => marker.type === 'arrow'
      ? isPointNearLine(point, marker.startCanvasPosition, marker.endCanvasPosition, 8)
      : isPointNearCircle(point, marker.startCanvasPosition, marker.endCanvasPosition, 8))
    if (shapeHit) {
      return { type: 'shape', id: shapeHit.id }
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
        ? {
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

  return (
    <div
      className={isSelected ? 'dicom-viewport selected' : 'dicom-viewport'}
      ref={elementRef}
      role="button"
      tabIndex={0}
      onPointerDown={handlePointerDownEvent}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPointerInteraction}
      onPointerCancel={stopPointerInteraction}
      onPointerLeave={stopPointerInteraction}
      onContextMenu={handleContextMenu}
      onKeyDown={(event) => event.key === 'Enter' && onSelect?.()}
    >
      {previewUrl && (
        <img
          className="dicom-progressive-preview"
          src={previewUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      <Stack3dCursorOverlay cursor={stack3dCursorCanvas} />
      <CTROverlay annotations={ctrCanvasAnnotations} active={activeTool === 'CTR4Point'} />
      <ShapeMarkerOverlay draft={shapeMarkerDraft} markers={shapeMarkers} />
      <TextMarkerOverlay draft={textMarkerDraft} markers={textMarkers} onCommit={commitTextMarker} onCancel={() => setTextMarkerDraft(null)} />
      {liveProbeValue && (
        <div
          className="live-probe-overlay"
          style={{ left: liveProbeValue.canvasPoint[0] + 16, top: liveProbeValue.canvasPoint[1] - 10 }}
        >
          <span className="live-probe-value">{liveProbeValue.value.toFixed(1)}</span>
          <span className="live-probe-unit">{liveProbeValue.unit}</span>
        </div>
      )}
      {showEmptyState && !hasActiveSelection && !imageIds.length && (
        <div className="empty-viewport">
          <span className="scan-ring" />
          <strong>VEXA MOBILE</strong>
          <p>Select a DICOMweb study to start reading.</p>
        </div>
      )}
    </div>
  )
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

function buildProjectedStack3dCursorCanvas(worldPoint: Types.Point3, viewport: Types.IStackViewport): Stack3dCursorCanvas {
  const point = viewport.worldToCanvas(worldPoint) as Types.Point2
  const width = viewport.element.clientWidth
  const height = viewport.element.clientHeight
  const margin = Math.max(width, height) * 0.2

  return {
    point,
    color: getStack3dCursorColor(viewport),
    inBounds: point[0] >= -margin && point[0] <= width + margin && point[1] >= -margin && point[1] <= height + margin,
  }
}

function getImagePlaneInfo(metadata?: DicomJsonDataset): ImagePlaneInfo | null {
  if (!metadata) {
    return null
  }

  const origin = readDicomNumberValues(metadata, '00200032')
  const orientation = readDicomNumberValues(metadata, '00200037')
  if (origin.length < 3 || orientation.length < 6) {
    return null
  }

  const row: Types.Point3 = normalize([orientation[0], orientation[1], orientation[2]])
  const column: Types.Point3 = normalize([orientation[3], orientation[4], orientation[5]])
  const normal = normalize(cross(row, column))

  return {
    origin: [origin[0], origin[1], origin[2]],
    normal,
  }
}

function readDicomNumberValues(dataset: DicomJsonDataset, tag: string) {
  const values = dataset[tag]?.Value
  if (!Array.isArray(values)) {
    return []
  }

  return values.map(Number).filter(Number.isFinite)
}

function getStack3dCursorColor(viewport: Types.IStackViewport) {
  const normal = normalize(viewport.getCamera().viewPlaneNormal as Types.Point3)
  const absNormal = normal.map(Math.abs)
  const dominantAxis = absNormal.indexOf(Math.max(...absNormal))

  if (dominantAxis === 0) {
    return '#3b82f6'
  }
  if (dominantAxis === 1) {
    return '#22c55e'
  }
  return '#f59e0b'
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

function isPointNearCircle(point: Types.Point2, center: Types.Point2, edge: Types.Point2, proximity: number) {
  const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1])
  const distance = Math.hypot(point[0] - center[0], point[1] - center[1])

  return Math.abs(distance - radius) <= proximity
}

function addWorldDelta(point: Types.Point3, delta: Types.Point3): Types.Point3 {
  return [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]]
}

function Stack3dCursorOverlay({ cursor }: { cursor: Stack3dCursorCanvas }) {
  if (!cursor?.inBounds) {
    return null
  }

  const [x, y] = cursor.point

  return (
    <svg className="stack-3d-cursor-overlay" aria-hidden="true">
      <circle className="stack-3d-cursor-dot" cx={x} cy={y} r="2.75" />
    </svg>
  )
}

function ShapeMarkerOverlay({ draft, markers }: {
  draft: (ShapeMarkerDraft & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }) | null
  markers: Array<ShapeMarkerAnnotation & { startCanvasPosition: Types.Point2; endCanvasPosition: Types.Point2 }>
}) {
  const allMarkers = draft ? [...markers, { id: 'shape-marker-draft', ...draft }] : markers

  return (
    <svg className="shape-marker-overlay" aria-hidden="true">
      <defs>
        <marker id="shape-marker-arrow-head" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
          <path d="M0,0 L7,3.5 L0,7 Z" />
        </marker>
      </defs>
      {allMarkers.map((marker) => marker.type === 'arrow' ? (
        <line
          className="shape-marker-arrow"
          key={marker.id}
          x1={marker.startCanvasPosition[0]}
          y1={marker.startCanvasPosition[1]}
          x2={marker.endCanvasPosition[0]}
          y2={marker.endCanvasPosition[1]}
        />
      ) : (
        <circle
          className="shape-marker-circle"
          cx={marker.startCanvasPosition[0]}
          cy={marker.startCanvasPosition[1]}
          key={marker.id}
          r={Math.hypot(marker.endCanvasPosition[0] - marker.startCanvasPosition[0], marker.endCanvasPosition[1] - marker.startCanvasPosition[1])}
        />
      ))}
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
    const sliceIndex = typeof options.sliceIndex === 'number'
      ? Math.min(Math.max(options.sliceIndex, 0), Math.max(0, (targetStack?.imageIds.length ?? 1) - 1))
      : undefined

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
  if (layout === '2x2') {
    return ['0', '1', '2', '3']
  }

  if (layout === '1x2' || layout === '2x1') {
    return ['0', '1']
  }

  return ['0']
}

function scheduleReferenceLinesRefresh(sourceViewportKey: string) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => refreshReferenceLines(sourceViewportKey))
  })
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
        enforceSameFrameOfReference: true,
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
  const hasWindow = !displayRange && shouldApplyDiagnosticWindow(modality) && Number.isFinite(windowCenter) && Number.isFinite(windowWidth) && (windowWidth as number) > 1
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

function shouldApplyDiagnosticWindow(modality: string) {
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
  } | undefined,
  imagePixelModule: { rescaleSlope?: number; rescaleIntercept?: number; bitsStored?: number; pixelRepresentation?: number } | undefined,
  modality: string,
) {
  if (!isProjectionModality(modality)) {
    return null
  }

  const alreadyScaled = Boolean(image?.isPreScaled || image?.preScale?.scaled)
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
  } | undefined,
  imagePixelModule: { rescaleSlope?: number; rescaleIntercept?: number } | undefined,
  modality: string,
) {
  if (!shouldUseAutoVoiRange(modality) || !image) {
    return null
  }

  const pixelData = image.getPixelData?.()
  const alreadyScaled = Boolean(image.isPreScaled || image.preScale?.scaled)
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
