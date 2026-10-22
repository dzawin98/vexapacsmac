import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Enums,
  RenderingEngine,
  cache,
  getRenderingEngine,
  setVolumesForViewports,
  volumeLoader,
  type Types,
} from '@cornerstonejs/core'
import {
  AngleTool,
  BidirectionalTool,
  CircleROITool,
  CobbAngleTool,
  CrosshairsTool,
  EllipticalROITool,
  Enums as ToolEnums,
  LengthTool,
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
import type { SeriesSummary, StudySummary } from '../../dicomweb/types'
import { useViewerStore } from '../viewerStore'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import {
  createServerMprSession,
  waitForServerMprSession,
} from '../serverMpr/serverMprClient'
import { createProxyVolumeId } from '../serverMpr/proxyVolumeLoader'

type LocalProxyMprViewerProps = {
  series: SeriesSummary
  study?: StudySummary | null
  viewportKey?: string
  isSelected?: boolean
  onSelect?: () => void
  onToggleViewportFullscreen?: () => void
  initialWindowLevel?: { windowWidth: number; windowLevel: number }
}

type PaneDefinition = {
  id: string
  label: string
  orientation: keyof typeof Enums.OrientationAxis
}

type SliceInfo = {
  index: number
  count: number
}

const PROXY_VOLUME_MAX_EDGE = 192
const PROXY_VOLUME_MAX_DEPTH = 128
const PROXY_VOLUME_MAX_VOXELS = 4_000_000

const PANE_DEFINITIONS: readonly PaneDefinition[] = [
  { id: 'axial', label: 'A', orientation: 'AXIAL' },
  { id: 'sagittal', label: 'S', orientation: 'SAGITTAL' },
  { id: 'coronal', label: 'C', orientation: 'CORONAL' },
  { id: 'axial-compare', label: 'A', orientation: 'AXIAL' },
] as const

const TOOL_BY_STORE_ID: Record<string, string> = {
  WindowLevel: WindowLevelTool.toolName,
  Zoom: ZoomTool.toolName,
  Pan: PanTool.toolName,
  Scroll: StackScrollTool.toolName,
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
  ReferenceLines: ReferenceLinesTool.toolName,
}

const MANAGED_TOOL_NAMES = Array.from(new Set(Object.values(TOOL_BY_STORE_ID)))
const TRANSIENT_TOOL_IDS = new Set([
  'Length',
  'Angle',
  'CobbAngle',
  'Bidirectional',
  'CircleROI',
  'EllipticalROI',
  'RectangleROI',
  'PlanarFreehandROI',
])

export function LocalProxyMprViewer({
  series,
  viewportKey = '0',
  isSelected = true,
  onSelect,
  onToggleViewportFullscreen,
  initialWindowLevel,
}: LocalProxyMprViewerProps) {
  const safeViewportKey = viewportKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  const engineId = useMemo(() => `local-proxy-mpr-engine-${safeViewportKey}`, [safeViewportKey])
  const toolGroupId = useMemo(() => `local-proxy-mpr-tools-${safeViewportKey}`, [safeViewportKey])
  const viewportIds = useMemo(() => PANE_DEFINITIONS.map((pane) => `local-proxy-mpr-${safeViewportKey}-${pane.id}`), [safeViewportKey])
  const elementRefs = useRef<(HTMLDivElement | null)[]>([])
  const loadedVolumeIdRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('Preparing local MPR proxy...')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [activePaneId, setActivePaneId] = useState(viewportIds[0])
  const [sliceInfo, setSliceInfo] = useState<Record<string, SliceInfo>>({})
  const activeTool = useViewerStore((state) => state.activeTool)
  const referenceLinesEnabled = useViewerStore((state) => state.referenceLinesEnabled)
  const viewportCommand = useViewerStore((state) => state.viewportCommand)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const setMprVolumeId = useViewerStore((state) => state.setMprVolumeId)
  const setMprActiveViewportId = useViewerStore((state) => state.setMprActiveViewportId)
  const setMprSliceInfo = useViewerStore((state) => state.setMprSliceInfo)
  const setSelectedViewportKey = useViewerStore((state) => state.setSelectedViewportKey)

  useLayoutEffect(() => {
    initializeCornerstone()
    const controller = new AbortController()
    let cancelled = false
    const viewportEventEntries: { element: HTMLDivElement; cameraHandler: EventListener; voiHandler: EventListener }[] = []
    const renderingEngine = new RenderingEngine(engineId)
    let resizeObserver: ResizeObserver | null = null

    async function setupProxyMpr() {
      try {
        setLoading(true)
        setError('')
        setProgress(0)
        setStatus('Preparing server volume cache...')

        const viewportInputs = viewportIds.flatMap((viewportId, index): Types.PublicViewportInput[] => {
          const element = elementRefs.current[index]
          if (!element) return []

          return [{
            viewportId,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element,
            defaultOptions: {
              orientation: Enums.OrientationAxis[PANE_DEFINITIONS[index]?.orientation ?? 'AXIAL'],
              background: [0, 0, 0],
            },
          }]
        })

        if (viewportInputs.length !== viewportIds.length) {
          throw new Error('Local proxy MPR viewport elements are not ready.')
        }

        renderingEngine.setViewports(viewportInputs)
        renderingEngine.resize(true, false)

        viewportInputs.forEach((input, index) => {
          const element = elementRefs.current[index]
          if (!element) return
          const viewportId = String(input.viewportId)
          const cameraHandler = () => updateSliceInfo(viewportId)
          const voiHandler = () => updateWindowLevelOverlay(viewportId)
          element.addEventListener(Enums.Events.CAMERA_MODIFIED, cameraHandler)
          element.addEventListener(Enums.Events.VOI_MODIFIED, voiHandler)
          viewportEventEntries.push({ element, cameraHandler, voiHandler })
        })

        resizeObserver = new ResizeObserver(() => renderingEngine.resize(true, false))
        elementRefs.current.forEach((element) => element && resizeObserver?.observe(element))

        const created = await createServerMprSession(series.studyInstanceUid, series.seriesInstanceUid, controller.signal)
        const ready = await waitForServerMprSession(created, (next) => {
          setProgress(next.progress)
          setStatus(`Preparing server volume cache... ${Math.round(next.progress * 100)}%`)
        }, controller.signal)
        if (cancelled || controller.signal.aborted) return

        setStatus('Loading native Cornerstone proxy volume...')
        const volumeId = createProxyVolumeId(ready.volumeSessionId)
        loadedVolumeIdRef.current = volumeId
        setMprVolumeId(volumeId)

        await volumeLoader.createAndCacheVolume(volumeId, {
          sessionId: ready.volumeSessionId,
          maxEdge: PROXY_VOLUME_MAX_EDGE,
          maxDepth: PROXY_VOLUME_MAX_DEPTH,
          maxVoxels: PROXY_VOLUME_MAX_VOXELS,
        } as unknown as { imageIds: string[] })
        if (cancelled || controller.signal.aborted) return

        await setVolumesForViewports(renderingEngine, [{ volumeId }], viewportIds)
        if (cancelled || controller.signal.aborted) return

        viewportIds.forEach((viewportId, index) => {
          const viewport = renderingEngine.getViewport(viewportId) as Types.IVolumeViewport | undefined
          if (!viewport) return
          viewport.setOrientation?.(Enums.OrientationAxis[PANE_DEFINITIONS[index]?.orientation ?? 'AXIAL'])
          viewport.resetCamera()
          setMprSlabThickness(viewport, 1)
          setMprBlendMode(viewport)
          setMprVoiRange(viewport, windowLevelToVoiRange({
            windowWidth: initialWindowLevel?.windowWidth || ready.defaultWindowWidth || 400,
            windowLevel: initialWindowLevel?.windowLevel || ready.defaultWindowCenter || 40,
          }))
          resetViewportClippingRange(viewport)
          updateSliceInfo(viewportId)
        })

        createToolGroup()
        renderingEngine.renderViewports(viewportIds)
        setLoading(false)
        setStatus('')
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return
        setError(reason instanceof Error ? reason.message : 'Unable to prepare native proxy MPR')
        setLoading(false)
      }
    }

    function createToolGroup() {
      ToolGroupManager.destroyToolGroup(toolGroupId)
      const toolGroup = ToolGroupManager.createToolGroup(toolGroupId)
      if (!toolGroup) throw new Error('Unable to create native proxy MPR tool group')

      viewportIds.forEach((viewportId) => toolGroup.addViewport(viewportId, engineId))
      toolGroup.addTool(WindowLevelTool.toolName)
      toolGroup.addTool(PanTool.toolName)
      toolGroup.addTool(ZoomTool.toolName)
      toolGroup.addTool(StackScrollTool.toolName)
      toolGroup.addTool(CrosshairsTool.toolName, {
        viewportIndicators: false,
        disableOnPassive: true,
        autoPan: { enabled: false, panSize: 10 },
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
      toolGroup.addTool(ProbeTool.toolName)
      toolGroup.addTool(ReferenceLinesTool.toolName)
      const viewerState = useViewerStore.getState()
      applyActiveTool(
        toolGroup,
        viewerState.activeTool,
        viewerState.referenceLinesEnabled,
        viewerState.mprActiveViewportIds[viewportKey] || viewportIds[0],
      )
    }

    function updateSliceInfo(viewportId: string) {
      const viewport = renderingEngine.getViewport(viewportId) as Types.IVolumeViewport | undefined
      if (!viewport) return
      const info = getVolumeViewportSliceInfo(viewport)
      setSliceInfo((current) => ({ ...current, [viewportId]: info }))
      setMprSliceInfo(viewportId, info.index, info.count)
    }

    function updateWindowLevelOverlay(_viewportId: string) {
      // Store updates for the toolbar are handled by active command pathways in the main viewer.
    }

    void setupProxyMpr()

    return () => {
      cancelled = true
      controller.abort()
      viewportEventEntries.forEach(({ element, cameraHandler, voiHandler }) => {
        element.removeEventListener(Enums.Events.CAMERA_MODIFIED, cameraHandler)
        element.removeEventListener(Enums.Events.VOI_MODIFIED, voiHandler)
      })
      resizeObserver?.disconnect()
      ToolGroupManager.destroyToolGroup(toolGroupId)
      try {
        viewportIds.forEach((viewportId) => renderingEngine.disableElement(viewportId))
        renderingEngine.destroy()
      } catch {
        // Cornerstone may already have disposed the engine during route changes.
      }
      if (loadedVolumeIdRef.current) {
        decacheProxyVolume(loadedVolumeIdRef.current)
        loadedVolumeIdRef.current = null
      }
      setMprVolumeId(null)
    }
  }, [
    engineId,
    initialWindowLevel?.windowLevel,
    initialWindowLevel?.windowWidth,
    series.seriesInstanceUid,
    series.studyInstanceUid,
    setMprSliceInfo,
    setMprVolumeId,
    toolGroupId,
    viewportIds,
  ])

  useEffect(() => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId)
    if (!toolGroup || loading) return
    applyActiveTool(toolGroup, activeTool, referenceLinesEnabled, activePaneId)
    renderAllViewports(engineId, viewportIds)
  }, [activePaneId, activeTool, engineId, loading, referenceLinesEnabled, toolGroupId, viewportIds])

  useEffect(() => {
    if (!isSelected || !viewportCommand || viewportCommand.targetViewportKey !== viewportKey) return
    const viewportId = activePaneId || viewportIds[0]
    const viewport = getRenderingEngine(engineId)?.getViewport(viewportId) as Types.IVolumeViewport | undefined
    if (!viewport) return

    if (viewportCommand.type === 'reset') {
      viewport.resetCamera()
      resetViewportClippingRange(viewport)
      viewport.render()
      return
    }

    if (viewportCommand.type === 'zoom-in' || viewportCommand.type === 'zoom-out') {
      const factor = viewportCommand.type === 'zoom-in' ? 1.2 : 1 / 1.2
      viewport.setZoom(Math.max(0.05, viewport.getZoom() * factor))
      viewport.render()
      return
    }

    if (viewportCommand.type === 'set-window-level' && viewportCommand.windowLevel) {
      setMprVoiRange(viewport, windowLevelToVoiRange(viewportCommand.windowLevel))
      viewport.render()
      return
    }

    const preset = getWindowPreset(viewportCommand.type)
    if (preset) {
      setMprVoiRange(viewport, preset)
      viewport.render()
    }
  }, [activePaneId, engineId, isSelected, viewportCommand, viewportIds, viewportKey])

  useEffect(() => {
    function resetTransientProxyMprTool(event: Event) {
      if (!TRANSIENT_TOOL_IDS.has(activeTool)) return
      const expectedToolName = TOOL_BY_STORE_ID[activeTool]
      const completedToolName = (event as CustomEvent<{ annotation?: { metadata?: { toolName?: string } } }>).detail?.annotation?.metadata?.toolName
      if (completedToolName && completedToolName !== expectedToolName) return

      window.setTimeout(() => {
        if (useViewerStore.getState().activeTool === activeTool) {
          setActiveTool('WindowLevel')
        }
      }, 50)
    }

    document.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientProxyMprTool)
    return () => document.removeEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransientProxyMprTool)
  }, [activeTool, setActiveTool])

  function selectPane(viewportId: string) {
    onSelect?.()
    setActivePaneId(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
    setSelectedViewportKey(viewportKey)
  }

  return (
    <div className={`mpr-container local-proxy-mpr-container${loading ? ' loading' : ''}`} onPointerDown={onSelect}>
      <div className="mpr-grid">
        {PANE_DEFINITIONS.map((pane, index) => {
          const viewportId = viewportIds[index]
          const info = sliceInfo[viewportId]
          return (
            <div
              className={`mpr-viewport-tile local-proxy-mpr-tile${activePaneId === viewportId ? ' active' : ''}`}
              data-viewport-id={viewportId}
              key={viewportId}
              onDoubleClick={onToggleViewportFullscreen}
              onPointerDown={() => selectPane(viewportId)}
            >
              <div
                className="mpr-viewport-element local-proxy-mpr-cornerstone-element"
                ref={(element) => { elementRefs.current[index] = element }}
              />
              <div className="server-mpr-plane-label">{pane.label}</div>
              {info && <div className="server-mpr-slice-label">{info.index + 1} / {info.count}</div>}
              <span className="server-mpr-engine-badge local-proxy">LOCAL PROXY</span>
            </div>
          )
        })}
      </div>
      {loading && !error && (
        <div className="server-mpr-session-loading" role="status">
          <span className="viewer-loading-indicator" />
          <strong>{status}</strong>
          <small>{progress > 0 && progress < 1 ? `${Math.round(progress * 100)}%` : 'Native Cornerstone proxy volume. No manual canvas renderer.'}</small>
        </div>
      )}
      {error && <div className="server-mpr-session-error" role="alert">{error}</div>}
    </div>
  )
}

function applyActiveTool(
  toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>,
  activeTool: string,
  referenceLinesEnabled: boolean,
  activeViewportId: string,
) {
  MANAGED_TOOL_NAMES.forEach((toolName) => {
    toolGroup.setToolPassive(toolName, { removeAllBindings: true })
  })

  toolGroup.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
  })
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

  if (activeTool === 'ReferenceLines') {
    syncReferenceLinesTool(toolGroup, referenceLinesEnabled, activeViewportId)
    return
  }

  toolGroup.setToolDisabled(ReferenceLinesTool.toolName)

  if (activeTool === 'Crosshairs') {
    toolGroup.setToolActive(CrosshairsTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
    })
    return
  }

  toolGroup.setToolDisabled(CrosshairsTool.toolName)

  const toolName = TOOL_BY_STORE_ID[activeTool] ?? WindowLevelTool.toolName
  if (toolName === StackScrollTool.toolName) {
    toolGroup.setToolActive(StackScrollTool.toolName, {
      bindings: [
        { mouseButton: ToolEnums.MouseBindings.Primary },
        { mouseButton: ToolEnums.MouseBindings.Wheel },
      ],
    })
    return
  }

  if (toolName === ReferenceLinesTool.toolName) {
    syncReferenceLinesTool(toolGroup, referenceLinesEnabled, activeViewportId)
    return
  }

  toolGroup.setToolActive(toolName, {
    bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
  })
}

function syncReferenceLinesTool(
  toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>,
  enabled: boolean,
  sourceViewportId: string,
) {
  try {
    if (!enabled) {
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
      return
    }
    toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
      sourceViewportId,
      showFullDimension: true,
    })
    toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
  } catch {
    toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
  }
}

function getVolumeViewportSliceInfo(viewport: Types.IVolumeViewport): SliceInfo {
  const viewportWithSlice = viewport as Types.IVolumeViewport & {
    getSliceIndex?: () => number
    getNumberOfSlices?: () => number
  }
  const index = viewportWithSlice.getSliceIndex?.()
  const count = viewportWithSlice.getNumberOfSlices?.()
  return {
    index: Number.isFinite(index) ? Math.max(0, Math.round(index as number)) : 0,
    count: Number.isFinite(count) ? Math.max(1, Math.round(count as number)) : 1,
  }
}

function renderAllViewports(engineId: string, viewportIds: string[]) {
  const engine = getRenderingEngine(engineId)
  if (!engine) return
  engine.renderViewports(viewportIds)
}

function windowLevelToVoiRange(windowLevel: { windowWidth: number; windowLevel: number }) {
  const width = Math.max(1, windowLevel.windowWidth)
  return {
    lower: windowLevel.windowLevel - width / 2,
    upper: windowLevel.windowLevel + width / 2,
  }
}

function setMprVoiRange(viewport: Types.IVolumeViewport | undefined, voiRange: { lower: number; upper: number }) {
  const volumeViewport = viewport as (Types.IVolumeViewport & {
    setProperties?: (properties: { voiRange?: { lower: number; upper: number } }) => void
  }) | undefined
  volumeViewport?.setProperties?.({ voiRange })
}

function setMprSlabThickness(viewport: Types.IVolumeViewport, thickness: number) {
  const volumeViewport = viewport as Types.IVolumeViewport & {
    setProperties?: (properties: { slabThickness?: number }) => void
    setSlabThickness?: (slabThickness: number) => void
  }
  if (volumeViewport.setProperties) {
    volumeViewport.setProperties({ slabThickness: thickness })
  } else {
    volumeViewport.setSlabThickness?.(thickness)
  }
}

function setMprBlendMode(viewport: Types.IVolumeViewport) {
  const blendViewport = viewport as Types.IVolumeViewport & {
    setBlendMode?: (blendMode: number, filterActorUIDs?: string[], immediate?: boolean) => void
  }
  blendViewport.setBlendMode?.(Enums.BlendModes.COMPOSITE, [], true)
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
    clippingViewport.getRenderer?.()?.resetCameraClippingRange?.()
  } catch {
    // VTK internals are not always exposed by every viewport implementation.
  }
}

function getWindowPreset(commandType: string) {
  if (commandType === 'preset-brain') return { lower: 0, upper: 80 }
  if (commandType === 'preset-bone') return { lower: 150, upper: 2500 }
  if (commandType === 'preset-lung') return { lower: -1400, upper: 200 }
  if (commandType === 'preset-mediastinum') return { lower: -160, upper: 240 }
  if (commandType === 'preset-soft') return { lower: -40, upper: 360 }
  return null
}

function decacheProxyVolume(volumeId: string) {
  try {
    const volume = cache.getVolume(volumeId) as Types.IImageVolume | undefined
    const imageIds = [...(volume?.imageIds ?? [])]
    cache.removeVolumeLoadObject(volumeId)
    imageIds.forEach((imageId) => {
      try {
        cache.removeImageLoadObject(imageId, { force: true })
      } catch {
        // Some images may already be evicted by Cornerstone cache pressure.
      }
    })
  } catch {
    // The volume may already be evicted during teardown.
  }
}
