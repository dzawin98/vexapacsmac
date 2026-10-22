import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Layers3 } from 'lucide-react'
import {
  Enums,
  RenderingEngine,
  cache,
  eventTarget,
  getRenderingEngine,
  type Types,
} from '@cornerstonejs/core'
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
  RectangleROITool,
  ToolGroupManager,
  WindowLevelTool,
  ZoomTool,
} from '@cornerstonejs/tools'
import type { SeriesSummary, StudySummary } from '../../dicomweb/types'
import { useViewerStore } from '../viewerStore'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { clearAllAnnotations, deleteSelectedAnnotations } from '../annotationActions'
import {
  createServerMprSession,
  deriveServerMprPlane,
  fetchServerMprPreview,
  probeServerMpr,
  waitForServerMprSession,
  type ServerMprOrientation,
  type ServerMprProjection,
  type ServerMprSession,
  type ServerMprVec3,
} from '../serverMpr/serverMprClient'
import { createServerMprImageId } from '../serverMpr/serverMprImageLoader'

type ServerMprViewerProps = {
  series: SeriesSummary
  study?: StudySummary | null
  viewportKey?: string
  isSelected?: boolean
  showOverlay?: boolean
  onSelect?: () => void
  onToggleViewportFullscreen?: () => void
  initialWindowLevel?: { windowWidth: number; windowLevel: number }
}

type PaneDefinition = {
  id: string
  label: string
  orientation: ServerMprOrientation
}

type LiveProbe = {
  paneId: string
  x: number
  y: number
  value: number
  unit: string
}

type PendingPreviewRequest = {
  paneId: string
  orientation: ServerMprOrientation
  index: number
  sequenceId: number
  windowCenter: number
  windowWidth: number
  projection: ServerMprProjection
  slabThickness: number
}

const SERVER_MPR_PREVIEW_THROTTLE_MS = 95
const SERVER_MPR_FINAL_DEBOUNCE_MS = 520
const SERVER_MPR_PREVIEW_MAX_EDGE = 256
const SERVER_MPR_PREVIEW_JPEG_QUALITY = 74
const SERVER_MPR_DIAGNOSTIC_MAX_EDGE = 512
const SERVER_MPR_CORNERSTONE_CACHE_BYTES = 512 * 1024 * 1024

const PANE_DEFINITIONS: readonly PaneDefinition[] = [
  { id: 'axial', label: 'A', orientation: 'axial' },
  { id: 'sagittal', label: 'S', orientation: 'sagittal' },
  { id: 'coronal', label: 'C', orientation: 'coronal' },
  { id: 'axial-compare', label: 'A', orientation: 'axial' },
] as const

const TOOL_NAMES = [
  WindowLevelTool.toolName,
  PanTool.toolName,
  ZoomTool.toolName,
  LengthTool.toolName,
  AngleTool.toolName,
  CobbAngleTool.toolName,
  BidirectionalTool.toolName,
  CircleROITool.toolName,
  EllipticalROITool.toolName,
  RectangleROITool.toolName,
  PlanarFreehandROITool.toolName,
  ArrowAnnotateTool.toolName,
  MagnifyTool.toolName,
] as const

const TOOL_BY_STORE_ID: Record<string, string> = {
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
  ArrowMarker: ArrowAnnotateTool.toolName,
  TextMarker: ArrowAnnotateTool.toolName,
  Magnify: MagnifyTool.toolName,
}

const TRANSIENT_TOOLS = new Set([
  'Length',
  'Angle',
  'CobbAngle',
  'Bidirectional',
  'CircleROI',
  'EllipticalROI',
  'RectangleROI',
  'PlanarFreehandROI',
  'ArrowMarker',
  'TextMarker',
])

export function ServerMprViewer({
  series,
  viewportKey = '0',
  isSelected = true,
  onSelect,
  onToggleViewportFullscreen,
  initialWindowLevel,
}: ServerMprViewerProps) {
  const safeViewportKey = viewportKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  const engineId = useMemo(() => `server-mpr-engine-${safeViewportKey}`, [safeViewportKey])
  const toolGroupId = useMemo(() => `server-mpr-tools-${safeViewportKey}`, [safeViewportKey])
  const viewportIds = useMemo(
    () => PANE_DEFINITIONS.map((pane) => `server-mpr-${safeViewportKey}-${pane.id}`),
    [safeViewportKey],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const elementRefs = useRef<(HTMLDivElement | null)[]>([])
  const sessionAbortRef = useRef<AbortController | null>(null)
  const previewAbortRefs = useRef<Record<string, AbortController | undefined>>({})
  const previewTimersRef = useRef<Record<string, number | undefined>>({})
  const previewInFlightRefs = useRef<Record<string, boolean>>({})
  const pendingPreviewRefs = useRef<Record<string, PendingPreviewRequest | undefined>>({})
  const probeAbortRef = useRef<AbortController | null>(null)
  const previewUrlsRef = useRef<Record<string, string | undefined>>({})
  const sequenceRefs = useRef<Record<string, number>>({})
  const finalLoadedSequenceRefs = useRef<Record<string, number>>({})
  const loadedDiagnosticPlaneKeysRef = useRef(new Set<string>())
  const finalTimersRef = useRef<Record<string, number | undefined>>({})
  const finalQueuesRef = useRef<Record<string, Promise<void>>>({})
  const initialRenderRef = useRef(new Set<string>())
  const initialRequestSessionRef = useRef('')
  const paneIndexesRef = useRef<Record<string, number>>({})
  const requestPlaneRef = useRef<(paneId: string, index: number, options?: { preview?: boolean; immediate?: boolean }) => void>(() => undefined)
  const crosshairDragRef = useRef<{ pointerId: number; paneId: string } | null>(null)
  const scrollDragRef = useRef<{ pointerId: number; paneId: string; startY: number; startIndex: number } | null>(null)
  const probeDragRef = useRef<{ pointerId: number; paneId: string } | null>(null)
  const [session, setSession] = useState<ServerMprSession | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [engineReady, setEngineReady] = useState(false)
  const [activePaneId, setActivePaneId] = useState(viewportIds[0])
  const [paneIndexes, setPaneIndexes] = useState<Record<string, number>>({})
  const [previewUrls, setPreviewUrls] = useState<Record<string, string | undefined>>({})
  const [crosshairPoints, setCrosshairPoints] = useState<Record<string, Types.Point2 | null>>({})
  const [liveProbe, setLiveProbe] = useState<LiveProbe | null>(null)
  const [expandedControls, setExpandedControls] = useState<Record<string, boolean>>({})
  const [slabThickness, setSlabThickness] = useState<Record<string, number>>({})
  const [projections, setProjections] = useState<Record<string, ServerMprProjection>>({})
  const activeTool = useViewerStore((state) => state.activeTool)
  const viewportCommand = useViewerStore((state) => state.viewportCommand)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const setMprVolumeId = useViewerStore((state) => state.setMprVolumeId)
  const setMprActiveViewportId = useViewerStore((state) => state.setMprActiveViewportId)
  const setMprSliceInfo = useViewerStore((state) => state.setMprSliceInfo)

  useEffect(() => {
    const controller = new AbortController()
    sessionAbortRef.current?.abort()
    sessionAbortRef.current = controller
    setSession(null)
    setEngineReady(false)
    initialRequestSessionRef.current = ''
    setError('')
    setProgress(0)

    void createServerMprSession(series.studyInstanceUid, series.seriesInstanceUid, controller.signal)
      .then((created) => waitForServerMprSession(created, (next) => setProgress(next.progress), controller.signal))
      .then((ready) => {
        if (controller.signal.aborted) return
        const indexes = Object.fromEntries(PANE_DEFINITIONS.map((pane, index) => [viewportIds[index], ready.planes[pane.orientation].index]))
        paneIndexesRef.current = indexes
        setPaneIndexes(indexes)
        setSession(ready)
        setMprVolumeId(`server:${ready.volumeSessionId}`)
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(reason instanceof Error ? reason.message : 'Server MPR could not be prepared')
      })

    return () => controller.abort()
  }, [series.seriesInstanceUid, series.studyInstanceUid, setMprVolumeId, viewportIds])

  useEffect(() => {
    const previousMaxCacheSize = cache.getMaxCacheSize()
    if (previousMaxCacheSize > SERVER_MPR_CORNERSTONE_CACHE_BYTES) {
      cache.setMaxCacheSize(SERVER_MPR_CORNERSTONE_CACHE_BYTES)
    }
    return () => {
      if (cache.getMaxCacheSize() !== previousMaxCacheSize) {
        cache.setMaxCacheSize(previousMaxCacheSize)
      }
    }
  }, [])

  const getPane = useCallback((paneId: string) => {
    const index = viewportIds.indexOf(paneId)
    return index >= 0 ? PANE_DEFINITIONS[index] : undefined
  }, [viewportIds])

  const readViewportWindow = useCallback((paneId: string) => {
    const viewport = getRenderingEngine(engineId)?.getViewport(paneId) as Types.IStackViewport | undefined
    const range = viewport?.getProperties?.().voiRange
    const width = range && Number.isFinite(range.lower) && Number.isFinite(range.upper)
      ? range.upper - range.lower
      : 0
    if (width > 1) {
      return {
        windowWidth: width,
        windowLevel: (range.upper + range.lower) / 2,
      }
    }
    const initialWidth = Number(initialWindowLevel?.windowWidth)
    const initialLevel = Number(initialWindowLevel?.windowLevel)
    const sessionWidth = Number(session?.defaultWindowWidth)
    const sessionLevel = Number(session?.defaultWindowCenter)
    const fallbackWidth = Number.isFinite(sessionWidth) && sessionWidth > 1
      ? sessionWidth
      : Number.isFinite(initialWidth) && initialWidth > 1
        ? initialWidth
        : 400
    const fallbackLevel = Number.isFinite(sessionLevel)
      ? sessionLevel
      : Number.isFinite(initialLevel)
        ? initialLevel
        : 40
    return {
      windowWidth: fallbackWidth,
      windowLevel: fallbackLevel,
    }
  }, [engineId, initialWindowLevel?.windowLevel, initialWindowLevel?.windowWidth, session?.defaultWindowCenter, session?.defaultWindowWidth])

  const refreshCrosshairPoints = useCallback(() => {
    if (!session) return
    const axialIndex = paneIndexesRef.current[viewportIds[0]] ?? session.planes.axial.index
    const sagittalIndex = paneIndexesRef.current[viewportIds[1]] ?? session.planes.sagittal.index
    const coronalIndex = paneIndexesRef.current[viewportIds[2]] ?? session.planes.coronal.index
    const world = volumeIndexToWorld(session, [sagittalIndex, coronalIndex, axialIndex])
    const engine = getRenderingEngine(engineId)
    if (!engine) return
    const points: Record<string, Types.Point2 | null> = {}
    viewportIds.forEach((id) => {
      try {
        points[id] = (engine.getViewport(id) as Types.IStackViewport).worldToCanvas(world)
      } catch {
        points[id] = null
      }
    })
    setCrosshairPoints(points)
  }, [engineId, session, viewportIds])

  const loadFinalPlane = useCallback((paneId: string, index: number, sequenceId: number) => {
    if (!session) return
    const pane = getPane(paneId)
    if (!pane) return
    const previousQueue = finalQueuesRef.current[paneId] ?? Promise.resolve()
    finalQueuesRef.current[paneId] = previousQueue.catch(() => undefined).then(async () => {
      if (sequenceRefs.current[paneId] !== sequenceId) return
      const engine = getRenderingEngine(engineId)
      const viewport = engine?.getViewport(paneId) as Types.IStackViewport | undefined
      if (!viewport) return
      const windowLevel = readViewportWindow(paneId)
      const diagnosticCacheKey = buildClientDiagnosticPlaneKey({
        session,
        orientation: pane.orientation,
        index,
        projection: projections[paneId] ?? 'normal',
        slabThickness: slabThickness[paneId] ?? 1,
        windowCenter: windowLevel.windowLevel,
        windowWidth: windowLevel.windowWidth,
      })
      const clientCacheKnown = loadedDiagnosticPlaneKeysRef.current.has(diagnosticCacheKey)
      const diagnosticStartedAt = performance.now()
      const plane = deriveServerMprPlane(session, pane.orientation, index)
      const imageId = createServerMprImageId({
        volumeSessionId: session.volumeSessionId,
        request: {
          orientation: pane.orientation,
          index,
          quality: 'diagnostic',
          maxEdge: SERVER_MPR_DIAGNOSTIC_MAX_EDGE,
          projection: projections[paneId] ?? 'normal',
          slabThickness: slabThickness[paneId] ?? 1,
          sequenceId,
        },
        plane,
        frameOfReferenceUid: session.geometry.frameOfReferenceUid,
        windowCenter: windowLevel.windowLevel,
        windowWidth: windowLevel.windowWidth,
        sourceHash: session.sourceHash,
      })
      const camera = initialRenderRef.current.has(paneId) ? viewport.getCamera() : null
      const voiRange = {
        lower: windowLevel.windowLevel - windowLevel.windowWidth / 2,
        upper: windowLevel.windowLevel + windowLevel.windowWidth / 2,
      }
      viewport.setProperties({ invert: false, voiRange })
      await viewport.setStack([imageId], 0)
      if (sequenceRefs.current[paneId] !== sequenceId) return
      viewport.setProperties({ invert: false, voiRange })
      if (camera) {
        viewport.setCamera(camera)
      } else {
        viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
        initialRenderRef.current.add(paneId)
      }
      viewport.render()
      finalLoadedSequenceRefs.current[paneId] = sequenceId
      loadedDiagnosticPlaneKeysRef.current.add(diagnosticCacheKey)
      window.dispatchEvent(new CustomEvent('vexa-server-mpr-diagnostic-latency', {
        detail: {
          paneId,
          orientation: pane.orientation,
          index,
          cacheKnown: clientCacheKnown,
          latencyMs: Math.round((performance.now() - diagnosticStartedAt) * 10) / 10,
        },
      }))
      const url = previewUrlsRef.current[paneId]
      if (url) URL.revokeObjectURL(url)
      previewUrlsRef.current[paneId] = undefined
      setPreviewUrls((current) => ({ ...current, [paneId]: undefined }))
      setMprSliceInfo(paneId, index, plane.maxIndex + 1)
      window.requestAnimationFrame(refreshCrosshairPoints)
    }).catch((reason) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setError(reason instanceof Error ? reason.message : 'Diagnostic MPR plane failed')
    })
  }, [engineId, getPane, projections, readViewportWindow, refreshCrosshairPoints, session, setMprSliceInfo, slabThickness])

  const flushPreviewPlane = useCallback((paneId: string) => {
    if (!session || previewInFlightRefs.current[paneId]) return
    const pending = pendingPreviewRefs.current[paneId]
    if (!pending) return
    if (sequenceRefs.current[paneId] !== pending.sequenceId) {
      pendingPreviewRefs.current[paneId] = undefined
      return
    }
    pendingPreviewRefs.current[paneId] = undefined
    previewInFlightRefs.current[paneId] = true
    const previewController = new AbortController()
    previewAbortRefs.current[paneId] = previewController

    void fetchServerMprPreview(session.volumeSessionId, {
      orientation: pending.orientation,
      index: pending.index,
      maxEdge: SERVER_MPR_PREVIEW_MAX_EDGE,
      windowCenter: pending.windowCenter,
      windowWidth: pending.windowWidth,
      jpegQuality: SERVER_MPR_PREVIEW_JPEG_QUALITY,
      projection: pending.projection,
      slabThickness: pending.slabThickness,
      sequenceId: pending.sequenceId,
    }, previewController.signal).then(async (preview) => {
      const finalAlreadyLoaded = (finalLoadedSequenceRefs.current[paneId] ?? 0) >= preview.sequenceId
      if (sequenceRefs.current[paneId] !== preview.sequenceId || previewController.signal.aborted || finalAlreadyLoaded) {
        URL.revokeObjectURL(preview.url)
        return
      }
      await decodeImageUrl(preview.url)
      if (sequenceRefs.current[paneId] !== preview.sequenceId || previewController.signal.aborted) {
        URL.revokeObjectURL(preview.url)
        return
      }
      const previous = previewUrlsRef.current[paneId]
      if (previous) URL.revokeObjectURL(previous)
      previewUrlsRef.current[paneId] = preview.url
      setPreviewUrls((current) => ({ ...current, [paneId]: preview.url }))
    }).catch((reason) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
    }).finally(() => {
      if (previewAbortRefs.current[paneId] === previewController) {
        previewAbortRefs.current[paneId] = undefined
      }
      previewInFlightRefs.current[paneId] = false
      if (pendingPreviewRefs.current[paneId]) {
        const existingTimer = previewTimersRef.current[paneId]
        if (existingTimer) window.clearTimeout(existingTimer)
        previewTimersRef.current[paneId] = window.setTimeout(() => {
          previewTimersRef.current[paneId] = undefined
          flushPreviewPlane(paneId)
        }, SERVER_MPR_PREVIEW_THROTTLE_MS)
      }
    })
  }, [session])

  const schedulePreviewPlane = useCallback((
    paneId: string,
    pane: PaneDefinition,
    index: number,
    sequenceId: number,
    immediate = false,
  ) => {
    if (!session) return
    const windowLevel = readViewportWindow(paneId)
    pendingPreviewRefs.current[paneId] = {
      paneId,
      orientation: pane.orientation,
      index,
      sequenceId,
      windowCenter: windowLevel.windowLevel,
      windowWidth: windowLevel.windowWidth,
      projection: projections[paneId] ?? 'normal',
      slabThickness: slabThickness[paneId] ?? 1,
    }

    const existingTimer = previewTimersRef.current[paneId]
    if (existingTimer) window.clearTimeout(existingTimer)

    if (immediate && !previewInFlightRefs.current[paneId]) {
      previewTimersRef.current[paneId] = undefined
      flushPreviewPlane(paneId)
      return
    }

    if (!previewInFlightRefs.current[paneId]) {
      previewTimersRef.current[paneId] = window.setTimeout(() => {
        previewTimersRef.current[paneId] = undefined
        flushPreviewPlane(paneId)
      }, SERVER_MPR_PREVIEW_THROTTLE_MS)
    } else {
      previewTimersRef.current[paneId] = undefined
    }
  }, [flushPreviewPlane, projections, readViewportWindow, session, slabThickness])

  const requestPlane = useCallback((paneId: string, requestedIndex: number, options: { preview?: boolean; immediate?: boolean } = {}) => {
    if (!session) return
    const pane = getPane(paneId)
    if (!pane) return
    const maxIndex = session.planes[pane.orientation].maxIndex
    const index = Math.max(0, Math.min(maxIndex, Math.round(requestedIndex)))
    const sequenceId = (sequenceRefs.current[paneId] ?? 0) + 1
    sequenceRefs.current[paneId] = sequenceId
    paneIndexesRef.current[paneId] = index
    setPaneIndexes((current) => ({ ...current, [paneId]: index }))
    setMprSliceInfo(paneId, index, maxIndex + 1)
    if (pane.orientation === 'axial') {
      viewportIds.forEach((id, paneIndex) => {
        if (PANE_DEFINITIONS[paneIndex].orientation !== 'axial' || id === paneId) return
        paneIndexesRef.current[id] = index
        setPaneIndexes((current) => ({ ...current, [id]: index }))
      })
    }

    const existingTimer = finalTimersRef.current[paneId]
    if (existingTimer) window.clearTimeout(existingTimer)
    finalLoadedSequenceRefs.current[paneId] = Math.min(finalLoadedSequenceRefs.current[paneId] ?? 0, sequenceId - 1)
    const windowLevel = readViewportWindow(paneId)
    const diagnosticCacheKey = buildClientDiagnosticPlaneKey({
      session,
      orientation: pane.orientation,
      index,
      projection: projections[paneId] ?? 'normal',
      slabThickness: slabThickness[paneId] ?? 1,
      windowCenter: windowLevel.windowLevel,
      windowWidth: windowLevel.windowWidth,
    })
    const diagnosticAlreadyLoaded = loadedDiagnosticPlaneKeysRef.current.has(diagnosticCacheKey)

    if (options.preview !== false && !diagnosticAlreadyLoaded) {
      schedulePreviewPlane(paneId, pane, index, sequenceId, Boolean(options.immediate))
    }

    const startFinal = () => loadFinalPlane(paneId, index, sequenceId)
    if (options.immediate || diagnosticAlreadyLoaded) {
      startFinal()
    } else {
      finalTimersRef.current[paneId] = window.setTimeout(startFinal, SERVER_MPR_FINAL_DEBOUNCE_MS)
    }
  }, [getPane, loadFinalPlane, projections, readViewportWindow, schedulePreviewPlane, session, setMprSliceInfo, slabThickness, viewportIds])

  useEffect(() => {
    requestPlaneRef.current = requestPlane
  }, [requestPlane])

  useLayoutEffect(() => {
    if (!session) return
    initializeCornerstone()
    let cancelled = false
    let resizeObserver: ResizeObserver | null = null
    let engine: RenderingEngine | null = null
    let wheelCleanups: (() => void)[] = []

    async function mountEngine() {
      const elements = elementRefs.current.slice(0, PANE_DEFINITIONS.length)
      if (elements.some((element) => !element || element.clientWidth < 2 || element.clientHeight < 2)) {
        window.requestAnimationFrame(mountEngine)
        return
      }
      if (cancelled) return
      engine = new RenderingEngine(engineId)
      engine.setViewports(viewportIds.map((viewportId, index) => ({
        viewportId,
        element: elements[index]!,
        type: Enums.ViewportType.STACK,
      })))

      const toolGroup = ToolGroupManager.createToolGroup(toolGroupId)
      if (!toolGroup) throw new Error('Unable to create Server MPR tool group')
      TOOL_NAMES.forEach((toolName) => toolGroup.addTool(toolName))
      viewportIds.forEach((viewportId) => toolGroup.addViewport(viewportId, engineId))
      TOOL_NAMES.forEach((toolName) => toolGroup.setToolPassive(toolName, { removeAllBindings: true }))
      toolGroup.setToolActive(WindowLevelTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
      })
      toolGroup.setToolActive(ZoomTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Ctrl }],
      })
      toolGroup.setToolActive(PanTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Shift }],
      })

      elements.forEach((element, index) => {
        const paneId = viewportIds[index]
        const wheel = (event: WheelEvent) => {
          event.preventDefault()
          event.stopImmediatePropagation()
          const delta = event.deltaY === 0 ? event.deltaX : event.deltaY
          const current = paneIndexesRef.current[paneId] ?? 0
          requestPlaneRef.current(paneId, current + (delta > 0 ? 1 : -1), { preview: true })
        }
        element!.addEventListener('wheel', wheel, { passive: false, capture: true })
        wheelCleanups.push(() => element!.removeEventListener('wheel', wheel, { capture: true }))
      })

      resizeObserver = new ResizeObserver(() => {
        engine?.resize(true, false)
        window.requestAnimationFrame(refreshCrosshairPoints)
      })
      if (containerRef.current) resizeObserver.observe(containerRef.current)
      engine.resize(true, false)
      setEngineReady(true)
    }

    void mountEngine().catch((reason) => setError(reason instanceof Error ? reason.message : 'Server MPR viewport initialization failed'))

    return () => {
      cancelled = true
      wheelCleanups.forEach((cleanup) => cleanup())
      wheelCleanups = []
      resizeObserver?.disconnect()
      ToolGroupManager.destroyToolGroup(toolGroupId)
      const mountedEngine = getRenderingEngine(engineId)
      if (mountedEngine) {
        viewportIds.forEach((viewportId) => mountedEngine.disableElement(viewportId))
        mountedEngine.destroy()
      }
      setEngineReady(false)
    }
  }, [engineId, refreshCrosshairPoints, session, toolGroupId, viewportIds])

  useEffect(() => {
    if (!engineReady || !session || initialRequestSessionRef.current === session.volumeSessionId) return
    initialRequestSessionRef.current = session.volumeSessionId
    PANE_DEFINITIONS.forEach((pane, index) => {
      requestPlane(viewportIds[index], session.planes[pane.orientation].index, { preview: true, immediate: true })
    })
  }, [engineReady, requestPlane, session, viewportIds])

  useEffect(() => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId)
    if (!toolGroup || !engineReady) return
    TOOL_NAMES.forEach((toolName) => toolGroup.setToolPassive(toolName, { removeAllBindings: true }))
    if (activeTool === 'Crosshairs' || activeTool === 'Probe' || activeTool === 'Scroll' || activeTool === 'Stack3DCursor') {
      return
    }
    const toolName = TOOL_BY_STORE_ID[activeTool] ?? WindowLevelTool.toolName
    toolGroup.setToolActive(toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
    })
    toolGroup.setToolActive(ZoomTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Ctrl }],
    })
    toolGroup.setToolActive(PanTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary, modifierKey: ToolEnums.KeyboardBindings.Shift }],
    })
  }, [activeTool, engineReady, toolGroupId])

  useEffect(() => {
    function resetTransientTool(event: Event) {
      if (!TRANSIENT_TOOLS.has(activeTool)) return
      const completedName = (event as CustomEvent<{ annotation?: { metadata?: { toolName?: string } } }>).detail?.annotation?.metadata?.toolName
      const expectedName = TOOL_BY_STORE_ID[activeTool]
      if (completedName && expectedName && completedName !== expectedName) return
      window.setTimeout(() => {
        if (useViewerStore.getState().activeTool === activeTool) setActiveTool('WindowLevel')
      }, 0)
    }
    eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientTool)
    return () => eventTarget.removeEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientTool)
  }, [activeTool, setActiveTool])

  useEffect(() => {
    if (!viewportCommand || !isSelected || !engineReady) return
    const engine = getRenderingEngine(engineId)
    const viewport = engine?.getViewport(activePaneId) as Types.IStackViewport | undefined
    if (!viewport) return
    if (viewportCommand.type === 'reset') {
      clearAllAnnotations()
      viewportIds.forEach((id) => {
        const target = engine?.getViewport(id) as Types.IStackViewport | undefined
        target?.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
        target?.render()
      })
      return
    }
    if (viewportCommand.type === 'delete-annotation') {
      if (deleteSelectedAnnotations(true) > 0) engine?.render()
      return
    }
    if (viewportCommand.type === 'set-window-level' && viewportCommand.windowLevel) {
      const { windowWidth, windowLevel } = viewportCommand.windowLevel
      viewport.setProperties({ voiRange: { lower: windowLevel - windowWidth / 2, upper: windowLevel + windowWidth / 2 } })
      viewport.render()
      return
    }
    const preset = getPreset(viewportCommand.type)
    if (preset) {
      viewportIds.forEach((id) => {
        const target = engine?.getViewport(id) as Types.IStackViewport | undefined
        target?.setProperties({ voiRange: preset })
        target?.render()
      })
      return
    }
    if (viewportCommand.type === 'zoom-in' || viewportCommand.type === 'zoom-out' || viewportCommand.type === 'spatial-zoom-1x') {
      const zoom = viewportCommand.type === 'spatial-zoom-1x' ? 1 : viewport.getZoom() * (viewportCommand.type === 'zoom-in' ? 1.15 : 0.85)
      viewport.setZoom(Math.max(0.15, Math.min(12, zoom)))
      viewport.render()
      return
    }
    if (viewportCommand.type === 'spatial-zoom-fit') {
      viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
      viewport.render()
      return
    }
    if (viewportCommand.type === 'invert') {
      const properties = viewport.getProperties()
      viewport.setProperties({ invert: !properties.invert })
      viewport.render()
    }
  }, [activePaneId, engineId, engineReady, isSelected, viewportCommand, viewportIds])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isSelected || (event.key !== 'Delete' && event.key !== 'Backspace')) return
      if (deleteSelectedAnnotations(false) > 0) {
        event.preventDefault()
        getRenderingEngine(engineId)?.render()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [engineId, isSelected])

  useEffect(() => () => {
    sessionAbortRef.current?.abort()
    probeAbortRef.current?.abort()
    Object.values(previewAbortRefs.current).forEach((controller) => controller?.abort())
    Object.values(previewTimersRef.current).forEach((timer) => timer && window.clearTimeout(timer))
    Object.values(finalTimersRef.current).forEach((timer) => timer && window.clearTimeout(timer))
    pendingPreviewRefs.current = {}
    previewInFlightRefs.current = {}
    loadedDiagnosticPlaneKeysRef.current.clear()
    Object.values(previewUrlsRef.current).forEach((url) => url && URL.revokeObjectURL(url))
    setMprVolumeId(null)
  }, [setMprVolumeId])

  function selectPane(paneId: string) {
    setActivePaneId(paneId)
    setMprActiveViewportId(paneId, viewportKey)
    onSelect?.()
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>, paneId: string) {
    selectPane(paneId)
    if (event.button !== 0) return
    if (activeTool === 'Crosshairs') {
      event.preventDefault()
      event.stopPropagation()
      crosshairDragRef.current = { pointerId: event.pointerId, paneId }
      event.currentTarget.setPointerCapture(event.pointerId)
      updateCrosshairFromPointer(event, paneId)
    } else if (activeTool === 'Probe') {
      event.preventDefault()
      event.stopPropagation()
      probeDragRef.current = { pointerId: event.pointerId, paneId }
      event.currentTarget.setPointerCapture(event.pointerId)
      updateProbeFromPointer(event, paneId)
    } else if (activeTool === 'Scroll') {
      event.preventDefault()
      event.stopPropagation()
      scrollDragRef.current = {
        pointerId: event.pointerId,
        paneId,
        startY: event.clientY,
        startIndex: paneIndexesRef.current[paneId] ?? 0,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>, paneId: string) {
    if (crosshairDragRef.current?.pointerId === event.pointerId) {
      updateCrosshairFromPointer(event, paneId)
    } else if (probeDragRef.current?.pointerId === event.pointerId) {
      updateProbeFromPointer(event, paneId)
    } else if (scrollDragRef.current?.pointerId === event.pointerId) {
      const drag = scrollDragRef.current
      requestPlaneRef.current(drag.paneId, drag.startIndex + Math.round((event.clientY - drag.startY) / 7), { preview: true })
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (crosshairDragRef.current?.pointerId === event.pointerId) crosshairDragRef.current = null
    if (scrollDragRef.current?.pointerId === event.pointerId) scrollDragRef.current = null
    if (probeDragRef.current?.pointerId === event.pointerId) {
      probeDragRef.current = null
      probeAbortRef.current?.abort()
      setLiveProbe(null)
    }
  }

  function updateCrosshairFromPointer(event: React.PointerEvent<HTMLDivElement>, paneId: string) {
    if (!session) return
    const viewport = getRenderingEngine(engineId)?.getViewport(paneId) as Types.IStackViewport | undefined
    if (!viewport) return
    const rect = event.currentTarget.getBoundingClientRect()
    const world = viewport.canvasToWorld([event.clientX - rect.left, event.clientY - rect.top])
    const indexes = worldToVolumeIndex(session, world)
    const axial = Math.round(indexes[2])
    const sagittal = Math.round(indexes[0])
    const coronal = Math.round(indexes[1])
    viewportIds.forEach((id, index) => {
      const orientation = PANE_DEFINITIONS[index].orientation
      const target = orientation === 'axial' ? axial : orientation === 'sagittal' ? sagittal : coronal
      requestPlaneRef.current(id, target, { preview: true })
    })
    window.requestAnimationFrame(refreshCrosshairPoints)
  }

  function updateProbeFromPointer(event: React.PointerEvent<HTMLDivElement>, paneId: string) {
    if (!session) return
    const viewport = getRenderingEngine(engineId)?.getViewport(paneId) as Types.IStackViewport | undefined
    if (!viewport) return
    const rect = event.currentTarget.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const world = viewport.canvasToWorld(canvasPoint)
    const controller = new AbortController()
    probeAbortRef.current?.abort()
    probeAbortRef.current = controller
    void probeServerMpr(session.volumeSessionId, world as ServerMprVec3, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setLiveProbe({ paneId, x: canvasPoint[0], y: canvasPoint[1], value: result.value, unit: result.unit })
    }).catch(() => undefined)
  }

  function updatePaneRendering(paneId: string, projection: ServerMprProjection, thickness: number) {
    setProjections((current) => ({ ...current, [paneId]: projection }))
    setSlabThickness((current) => ({ ...current, [paneId]: thickness }))
    window.setTimeout(() => requestPlaneRef.current(paneId, paneIndexesRef.current[paneId] ?? 0, { preview: true, immediate: true }), 0)
  }

  const loading = !session || !engineReady

  return (
    <div className={`mpr-container server-mpr-container${loading ? ' loading' : ''}`} ref={containerRef} onPointerDown={onSelect}>
      <div className="mpr-grid">
        {viewportIds.map((paneId, index) => {
          const pane = PANE_DEFINITIONS[index]
          const plane = session?.planes[pane.orientation]
          const sliceIndex = paneIndexes[paneId] ?? plane?.index ?? 0
          const point = crosshairPoints[paneId]
          const controlsOpen = Boolean(expandedControls[paneId])
          return (
            <div
              className={`mpr-viewport-tile server-mpr-tile${activePaneId === paneId ? ' active' : ''}`}
              key={paneId}
              onClick={() => selectPane(paneId)}
            >
              <div
                className="mpr-viewport-element server-mpr-cornerstone-element"
                ref={(element) => { elementRefs.current[index] = element }}
                onPointerDown={(event) => handlePointerDown(event, paneId)}
                onPointerMove={(event) => handlePointerMove(event, paneId)}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onDoubleClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  selectPane(paneId)
                  onToggleViewportFullscreen?.()
                }}
              />
              {previewUrls[paneId] && (
                <img className="server-mpr-preview" src={previewUrls[paneId]} alt="" aria-hidden="true" />
              )}
              {activeTool === 'Crosshairs' && point && (
                <svg className="server-mpr-position-overlay" aria-hidden="true">
                  <line className="server-mpr-crosshair-horizontal" x1="0" x2="100%" y1={point[1]} y2={point[1]} />
                  <line className="server-mpr-crosshair-vertical" x1={point[0]} x2={point[0]} y1="0" y2="100%" />
                </svg>
              )}
              {liveProbe?.paneId === paneId && (
                <div className="server-mpr-live-probe" style={{ left: liveProbe.x + 12, top: liveProbe.y - 8 }}>
                  {liveProbe.value.toFixed(1)} {liveProbe.unit}
                </div>
              )}
              <div className="server-mpr-plane-label">{pane.label}</div>
              <div className="server-mpr-slice-label">{sliceIndex + 1} / {(plane?.maxIndex ?? 0) + 1}</div>
              <div className={`server-mpr-controls ${controlsOpen ? 'expanded' : 'collapsed'}`} onPointerDown={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="server-mpr-controls-toggle"
                  title={controlsOpen ? 'Hide plane controls' : 'Show plane controls'}
                  aria-expanded={controlsOpen}
                  onClick={() => setExpandedControls((current) => ({ ...current, [paneId]: !current[paneId] }))}
                >
                  {controlsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <div className="server-mpr-controls-body">
                  <span><strong>{pane.label}</strong>{pane.orientation}</span>
                  <label>
                    <Layers3 size={14} />
                    <select
                      aria-label="MPR slice thickness"
                      value={slabThickness[paneId] ?? 1}
                      onChange={(event) => updatePaneRendering(paneId, projections[paneId] ?? 'normal', Number(event.target.value))}
                    >
                      {[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value} mm</option>)}
                    </select>
                  </label>
                  <select
                    aria-label="MPR projection"
                    value={projections[paneId] ?? 'normal'}
                    onChange={(event) => updatePaneRendering(paneId, event.target.value as ServerMprProjection, slabThickness[paneId] ?? 1)}
                  >
                    <option value="normal">Normal</option>
                    <option value="mip">MIP</option>
                    <option value="minip">MinIP</option>
                    <option value="average">Average</option>
                  </select>
                </div>
              </div>
              <span className="server-mpr-engine-badge">SERVER MPR</span>
            </div>
          )
        })}
      </div>
      {loading && !error && (
        <div className="server-mpr-session-loading" role="status">
          <span className="viewer-loading-indicator" />
          <strong>Preparing diagnostic volume</strong>
          <small>{Math.round(progress * 100)}%</small>
        </div>
      )}
      {error && <div className="server-mpr-session-error" role="alert">{error}</div>}
    </div>
  )
}

function worldToVolumeIndex(session: ServerMprSession, world: ServerMprVec3): ServerMprVec3 {
  const relative = subtract(world, session.geometry.origin)
  return [
    dot(relative, session.geometry.directionX) / session.geometry.spacing[0],
    dot(relative, session.geometry.directionY) / session.geometry.spacing[1],
    dot(relative, session.geometry.directionZ) / session.geometry.spacing[2],
  ]
}

function decodeImageUrl(url: string) {
  return new Promise<void>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = url
    if ('decode' in image) {
      image.decode().then(resolve).catch(resolve)
    }
  })
}

function buildClientDiagnosticPlaneKey(input: {
  session: ServerMprSession
  orientation: ServerMprOrientation
  index: number
  projection: ServerMprProjection
  slabThickness: number
  windowCenter: number
  windowWidth: number
}) {
  return [
    input.session.volumeSessionId,
    input.session.sourceHash,
    input.orientation,
    input.index,
    input.projection,
    stableMprNumber(input.slabThickness),
    stableMprNumber(input.windowCenter),
    stableMprNumber(input.windowWidth),
  ].join('|')
}

function stableMprNumber(value: number) {
  return String(Math.round(Number(value || 0) * 1000) / 1000)
}

function volumeIndexToWorld(session: ServerMprSession, index: ServerMprVec3): ServerMprVec3 {
  return add(
    add(
      add(session.geometry.origin, scale(session.geometry.directionX, index[0] * session.geometry.spacing[0])),
      scale(session.geometry.directionY, index[1] * session.geometry.spacing[1]),
    ),
    scale(session.geometry.directionZ, index[2] * session.geometry.spacing[2]),
  )
}

function getPreset(type: string) {
  if (type === 'preset-lung') return { lower: -1350, upper: 150 }
  if (type === 'preset-bone') return { lower: -400, upper: 1600 }
  if (type === 'preset-brain') return { lower: 0, upper: 80 }
  if (type === 'preset-mediastinum') return { lower: -125, upper: 225 }
  if (type === 'preset-soft') return { lower: -160, upper: 240 }
  return null
}

function dot(a: ServerMprVec3, b: ServerMprVec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function add(a: ServerMprVec3, b: ServerMprVec3): ServerMprVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function subtract(a: ServerMprVec3, b: ServerMprVec3): ServerMprVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function scale(value: ServerMprVec3, factor: number): ServerMprVec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor]
}
