import { useEffect, useReducer, useRef, useState } from 'react'
import { vec3 } from 'gl-matrix'
import {
  Enums,
  RenderingEngine,
  type Types,
  getRenderingEngine,
} from '@cornerstonejs/core'
import {
  ToolGroupManager,
  Enums as ToolEnums,
  AngleTool,
  BidirectionalTool,
  CobbAngleTool,
  CrosshairsTool,
  EllipticalROITool,
  LengthTool,
  PanTool,
  PlanarFreehandROITool,
  ProbeTool,
  RectangleROITool,
  ReferenceLinesTool,
  StackScrollTool,
  WindowLevelTool,
  ZoomTool,
} from '@cornerstonejs/tools'
import type { SeriesSummary } from '../../dicomweb/types'
import { clearAllAnnotations, deleteSelectedAnnotations } from '../annotationActions'
import { useViewerStore } from '../viewerStore'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { acquireSharedSeriesVolume, releaseSharedSeriesVolume } from '../cornerstone/volumeCache'
import {
  mprLoadPreview,
  mprStartProgressive,
  mprReleaseSession,
} from '../../dicomweb/mprClient'

const MPR_VIEWPORT_IDS = ['mpr-axial', 'mpr-sagittal', 'mpr-coronal', 'mpr-axial-2'] as const
const MPR_ORIENTATIONS: readonly (keyof typeof Enums.OrientationAxis)[] = ['AXIAL', 'SAGITTAL', 'CORONAL', 'AXIAL'] as const
const MPR_ORIENTATION_OPTIONS = [
  { label: 'A', orientation: 'AXIAL' },
  { label: 'S', orientation: 'SAGITTAL' },
  { label: 'C', orientation: 'CORONAL' },
] as const
const MPR_STANDARD_CAMERAS = {
  AXIAL: { label: 'A', normal: vec3.fromValues(0, 0, -1), viewUp: vec3.fromValues(0, -1, 0) },
  CORONAL: { label: 'C', normal: vec3.fromValues(0, -1, 0), viewUp: vec3.fromValues(0, 0, 1) },
  SAGITTAL: { label: 'S', normal: vec3.fromValues(-1, 0, 0), viewUp: vec3.fromValues(0, 0, 1) },
} as const
const ORIENTATION_LABEL_TOLERANCE = 0.01
const MPR_BLEND_MODE_OPTIONS = [
  { label: 'Normal', shortLabel: 'N', value: 'normal' },
  { label: 'MIP', shortLabel: 'MIP', value: 'mip' },
  { label: 'MinIP', shortLabel: 'MinIP', value: 'minip' },
] as const

type MprStatus = { loading: boolean; error: string }
type MprBlendMode = 'normal' | 'mip' | 'minip'

function mprStatusReducer(_state: MprStatus, action: { type: 'loading' } | { type: 'done' } | { type: 'error'; error: string }): MprStatus {
  switch (action.type) {
    case 'loading': return { loading: true, error: '' }
    case 'done': return { loading: false, error: '' }
    case 'error': return { loading: false, error: action.error }
  }
}

export function MprViewer({ series }: { series: SeriesSummary }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const elementRefs = useRef<(HTMLDivElement | null)[]>([])
  const [, dispatchStatus] = useReducer(mprStatusReducer, { loading: true, error: '' })
  const setMprVolumeId = useViewerStore((state) => state.setMprVolumeId)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const setMprActiveViewportId = useViewerStore((state) => state.setMprActiveViewportId)
  const setMprSliceInfo = useViewerStore((state) => state.setMprSliceInfo)
  const [activeViewport, setActiveViewport] = useState<string>('mpr-axial')
  const [maximizedViewport, setMaximizedViewport] = useState<string | null>(null)
  const [viewportOrientations, setViewportOrientations] = useState(() => MPR_ORIENTATIONS.map((orientation) => getMprOrientationOptionIndex(orientation)))
  const viewportOrientationsRef = useRef(viewportOrientations)
  const [mprOrientationLabels, setMprOrientationLabels] = useState<Record<string, string>>({
    'mpr-axial': 'A',
    'mpr-sagittal': 'S',
    'mpr-coronal': 'C',
    'mpr-axial-2': 'A',
  })
  const [slabThicknesses, setSlabThicknesses] = useState<Record<string, number>>({
    'mpr-axial': 1,
    'mpr-sagittal': 1,
    'mpr-coronal': 1,
    'mpr-axial-2': 1,
  })
  const [slabThicknessInputs, setSlabThicknessInputs] = useState<Record<string, string>>({
    'mpr-axial': '1',
    'mpr-sagittal': '1',
    'mpr-coronal': '1',
    'mpr-axial-2': '1',
  })
  const [blendModes, setBlendModes] = useState<Record<string, MprBlendMode>>({
    'mpr-axial': 'normal',
    'mpr-sagittal': 'normal',
    'mpr-coronal': 'normal',
    'mpr-axial-2': 'normal',
  })
  const [previewUrls, setPreviewUrls] = useState<Record<string, string> | null>(null)
  const [volumeLoaded, setVolumeLoaded] = useState(false)
  const previewRefs = useRef<Record<string, HTMLImageElement | null>>({})
  const mprSessionIdRef = useRef<string | null>(null)
  const unsubscribeProgressRef = useRef<(() => void) | null>(null)
  const slabThicknessesRef = useRef(slabThicknesses)
  const engineIdRef = useRef('mpr-rendering-engine')
  const toolGroupRef = useRef<ReturnType<typeof ToolGroupManager.createToolGroup>>(null)
  const lastPointerDownRef = useRef<{ viewportId: string; time: number }>({ viewportId: '', time: 0 })
  const cameraStabilizeFrameRef = useRef<number | null>(null)
  const activeTool = useViewerStore((state) => state.activeTool)
  const referenceLinesEnabled = useViewerStore((state) => state.referenceLinesEnabled)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const viewportCommand = useViewerStore((state) => state.viewportCommand)
  const [mprZooms, setMprZooms] = useState<Record<string, number>>({
    'mpr-axial': 1,
    'mpr-sagittal': 1,
    'mpr-coronal': 1,
    'mpr-axial-2': 1,
  })

  const mprToolNameByStoreId = useRef<Record<string, string>>({
    Scroll: StackScrollTool.toolName,
    WindowLevel: WindowLevelTool.toolName,
    Pan: PanTool.toolName,
    Zoom: ZoomTool.toolName,
    Length: LengthTool.toolName,
    Angle: AngleTool.toolName,
    CobbAngle: CobbAngleTool.toolName,
    Bidirectional: BidirectionalTool.toolName,
    EllipticalROI: EllipticalROITool.toolName,
    RectangleROI: RectangleROITool.toolName,
    PlanarFreehandROI: PlanarFreehandROITool.toolName,
    Probe: ProbeTool.toolName,
    Crosshairs: CrosshairsTool.toolName,
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

  useEffect(() => {
    initializeCornerstone()
    dispatchStatus({ type: 'loading' })
    setLoadingMessage('')
    setErrorMessage('')
    setVolumeLoaded(false)
    setPreviewUrls(null)

    let cancelled = false
    const engineId = 'mpr-rendering-engine'
    const toolGroupId = 'mpr-tool-group'
    let renderingEngine: RenderingEngine | null = null
    let toolGroup: ReturnType<typeof ToolGroupManager.createToolGroup> = null
    let currentVolumeId = ''
    const cameraEventElements: HTMLDivElement[] = []
    let cameraHandler: EventListener | undefined

    async function setupMpr() {
      try {
        // Fire volume + preview in parallel (non-blocking)
        const revealVolumeAfterFrames = (total: number) => Math.max(1, Math.min(8, Math.ceil(total * 0.08)))
        const volumePromise = acquireSharedSeriesVolume(series, 'mpr', engineId, (progress) => {
          if (cancelled) return
          const total = progress.totalNumFrames || series.instanceCount || 1
          if (progress.framesLoaded >= revealVolumeAfterFrames(total)) {
            setVolumeLoaded(true)
            setPreviewUrls(null)
          }
        })

        // Create rendering engine + viewports IMMEDIATELY — no await on anything
        renderingEngine = new RenderingEngine(engineId)

        MPR_VIEWPORT_IDS.forEach((viewportId, index) => {
          const element = elementRefs.current[index]
          if (!element) { return }

          renderingEngine!.enableElement({
            viewportId,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element,
            defaultOptions: {
              orientation: Enums.OrientationAxis[MPR_ORIENTATIONS[index]],
              background: [0, 0, 0],
            },
          })
        })

        renderingEngine.resize(true, false)
        renderingEngine.render() // renders black viewports

        // Fire server-side preview in background (optional fallback)
        if (series.studyInstanceUid && series.seriesInstanceUid) {
          mprLoadPreview(series.studyInstanceUid, series.seriesInstanceUid)
            .then((result) => {
              if (cancelled) {
                mprReleaseSession(result.sessionId)
                return null
              }
              mprSessionIdRef.current = result.sessionId
              setPreviewUrls({
                'mpr-axial': result.previewUrls.axial,
                'mpr-sagittal': result.previewUrls.sagittal,
                'mpr-coronal': result.previewUrls.coronal,
                'mpr-axial-2': result.previewUrls.axial,
              })
              dispatchStatus({ type: 'done' })
              setLoadingMessage('')
              mprStartProgressive(result.sessionId).catch(() => {})
              return result
            })
            .catch(() => {
              console.warn('MPR preview load failed (non-fatal)')
            })
        }

        // When full volume is ready, set it on all viewports + hide overlays
        volumePromise.then(({ volumeId, instances }) => {
          if (cancelled) {
            releaseSharedSeriesVolume(series, 'mpr', engineId)
            return
          }
          if (!instances.length) {
            setErrorMessage('No image instances found for this series')
            dispatchStatus({ type: 'error', error: 'No image instances found' })
            return
          }

          currentVolumeId = volumeId
          setMprVolumeId(volumeId)
          setVolumeLoaded(true)
          setPreviewUrls(null)

          MPR_VIEWPORT_IDS.forEach((viewportId) => {
            const viewport = renderingEngine!.getViewport(viewportId) as Types.IVolumeViewport
            if (viewport) {
              viewport.setVolumes([{ volumeId }])
              viewport.resetCamera()
              setMprSlabThickness(viewport, 1)
              setMprBlendMode(viewport, 'normal')
              setMprZooms((current) => ({ ...current, [viewportId]: viewport.getZoom() }))
              updateMprSliceInfo(viewportId, viewport)
              viewport.render()
            }
          })

          dispatchStatus({ type: 'done' })
          setLoadingMessage('')

          fixCameraClipping()
          scheduleCameraClippingStabilization()
          recomputeMprCrosshairsTool()
          renderMprViewports()
        }).catch(() => {
          if (!cancelled) {
            const msg = 'Unable to prepare MPR volume.'
            setErrorMessage(msg)
            dispatchStatus({ type: 'error', error: msg })
          }
        })

        // Setup event handlers and tool groups (non-blocking, no await)
        function fixCameraClipping(renderAfterReset = false) {
          const engine = getRenderingEngine(engineId)
          if (!engine) return
          MPR_VIEWPORT_IDS.forEach((id) => {
            try {
              const vp = engine.getViewport(id) as Types.IVolumeViewport | undefined
              if (!vp) return
              resetViewportClippingRange(vp)
              if (renderAfterReset) { vp.render() }
            } catch { /* vtk internals not accessible */ }
          })
        }

        function scheduleCameraClippingStabilization() {
          if (cameraStabilizeFrameRef.current !== null) { return }
          cameraStabilizeFrameRef.current = window.requestAnimationFrame(() => {
            cameraStabilizeFrameRef.current = null
            fixCameraClipping(true)
            window.requestAnimationFrame(() => fixCameraClipping(true))
          })
        }

        cameraHandler = () => {
          fixCameraClipping()
          MPR_VIEWPORT_IDS.forEach((viewportId) => {
            const viewport = renderingEngine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
            if (viewport) {
              updateMprOrientationLabel(viewportId, viewport)
              updateMprSliceInfo(viewportId, viewport)
            }
          })
          if (useViewerStore.getState().activeTool === 'Crosshairs') {
            scheduleCameraClippingStabilization()
          }
        }

        toolGroup = ToolGroupManager.createToolGroup(toolGroupId)
        if (toolGroup) {
          MPR_VIEWPORT_IDS.forEach((id) => toolGroup.addViewport(id, engineId))
          orderMprToolGroupViewportsForCrosshairs(toolGroup, viewportOrientationsRef.current)

          toolGroup.addTool(WindowLevelTool.toolName)
          toolGroup.addTool(PanTool.toolName)
          toolGroup.addTool(ZoomTool.toolName)
          toolGroup.addTool(StackScrollTool.toolName)

          toolGroup.addTool(CrosshairsTool.toolName, {
            getReferenceLineColor: (viewportId: string) => {
              if (viewportId.includes('axial')) return 'rgb(200, 0, 0)'
              if (viewportId.includes('sagittal')) return 'rgb(198, 134, 25)'
              if (viewportId.includes('coronal')) return 'rgb(0, 173, 239)'
              return 'white'
            },
            getReferenceLineControllable: () => true,
            getReferenceLineDraggableRotatable: () => true,
            getReferenceLineSlabThicknessControlsOn: () => true,
          })
          toolGroup.addTool(LengthTool.toolName)
          toolGroup.addTool(AngleTool.toolName)
          toolGroup.addTool(CobbAngleTool.toolName)
          toolGroup.addTool(BidirectionalTool.toolName)
          toolGroup.addTool(EllipticalROITool.toolName)
          toolGroup.addTool(RectangleROITool.toolName)
          toolGroup.addTool(PlanarFreehandROITool.toolName)
          toolGroup.addTool(ProbeTool.toolName)
          toolGroup.addTool(ReferenceLinesTool.toolName, {
            sourceViewportId: activeViewport,
            enforceSameFrameOfReference: true,
            showFullDimension: true,
          })

          toolGroup.setToolActive(StackScrollTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
          })

          toolGroup.setToolDisabled(CrosshairsTool.toolName)
          if (useViewerStore.getState().referenceLinesEnabled) {
            toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
              sourceViewportId: activeViewport,
              enforceSameFrameOfReference: true,
              showFullDimension: true,
            })
            toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
          } else {
            toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
          }

          const initialToolName = mprToolNameByStoreId[activeTool] || WindowLevelTool.toolName
          mprManagedToolNames.forEach((name) => {
            toolGroup!.setToolPassive(name, { removeAllBindings: true })
          })
          if (activeTool === 'Crosshairs') {
            configureMprCrosshairsTool(toolGroup)
            toolGroup.setToolActive(CrosshairsTool.toolName, {
              bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
            })
            setMprWheelScrollActive(toolGroup)
          } else if (initialToolName === StackScrollTool.toolName) {
            setMprScrollToolActive(toolGroup)
          } else {
            toolGroup.setToolActive(initialToolName, {
              bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
            })
            setMprWheelScrollActive(toolGroup)
          }

          toolGroupRef.current = toolGroup
        }

        renderingEngine.render()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

        MPR_VIEWPORT_IDS.forEach((viewportId, index) => {
          const viewport = renderingEngine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
          if (viewport) {
            updateMprOrientationLabel(viewportId, viewport)
          }

          const element = elementRefs.current[index]
          if (element) {
            element.addEventListener(Enums.Events.CAMERA_MODIFIED, cameraHandler!)
            cameraEventElements.push(element)
          }
        })

      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to load MPR volume'
          setErrorMessage(msg)
          dispatchStatus({ type: 'error', error: msg })
        }
      }
    }

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
      // Cleanup MPR session
      if (unsubscribeProgressRef.current) {
        unsubscribeProgressRef.current()
        unsubscribeProgressRef.current = null
      }
      if (mprSessionIdRef.current) {
        mprReleaseSession(mprSessionIdRef.current).catch(() => {})
        mprSessionIdRef.current = null
      }
      toolGroupRef.current = null
      cameraEventElements.forEach((el) => {
        el.removeEventListener(Enums.Events.CAMERA_MODIFIED, cameraHandler)
      })
      if (cameraStabilizeFrameRef.current !== null) {
        window.cancelAnimationFrame(cameraStabilizeFrameRef.current)
        cameraStabilizeFrameRef.current = null
      }
      if (resizeObserver && containerEl) {
        resizeObserver.disconnect()
      }
      ToolGroupManager.destroyToolGroup(toolGroupId)
      const engine = getRenderingEngine(engineId)
      if (engine) {
        MPR_VIEWPORT_IDS.forEach((viewportId) => {
          engine.disableElement(viewportId)
        })
        engine.destroy()
      }
      if (currentVolumeId) {
        releaseSharedSeriesVolume(series, 'mpr', engineId)
      }
      setMprVolumeId(null)
      setLoadingMessage('')
      setErrorMessage('')
    }
  }, [series, setMprVolumeId, setLoadingMessage, setErrorMessage, setMprSliceInfo])

  useEffect(() => {
    const toolGroup = toolGroupRef.current
    if (!toolGroup) return
    if (!areMprElementsRenderable()) return

    if (activeTool === 'Crosshairs') {
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
      recomputeMprCrosshairsTool()
      configureMprCrosshairsTool(toolGroup)
      toolGroup.setToolActive(CrosshairsTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
      })
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
        toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
        setMprWheelScrollActive(toolGroup)
        renderMprViewports()
        return
      }
      toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
        sourceViewportId: activeViewport,
        enforceSameFrameOfReference: true,
        showFullDimension: true,
      })
      toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
      setMprWheelScrollActive(toolGroup)
      renderMprViewports()
      return
    }

    toolGroup.setToolDisabled(CrosshairsTool.toolName)
    if (referenceLinesEnabled) {
      toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
        sourceViewportId: activeViewport,
        enforceSameFrameOfReference: true,
        showFullDimension: true,
      })
      toolGroup.setToolEnabled(ReferenceLinesTool.toolName)
    } else {
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
    }

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
  }, [activeTool, activeViewport, referenceLinesEnabled, setActiveTool])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
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
  }, [])

  useEffect(() => {
    if (!viewportCommand) return

    const targetViewportId = resolveMprViewportId(viewportCommand.targetViewportKey, activeViewport)

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
        MPR_VIEWPORT_IDS.forEach((id) => {
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
      const sliceIndex = viewportCommand.sliceIndex
      if (typeof sliceIndex === 'number') {
        jumpMprViewportToSlice(targetViewportId, sliceIndex)
      }
      return
    }

    if (viewportCommand.type === 'reset-mpr-free-rotate') {
      resetMprSlabObliqueViewport(targetViewportId)
      return
    }

    if (viewportCommand.type === 'set-zoom' || viewportCommand.type === 'zoom-in' || viewportCommand.type === 'zoom-out' || viewportCommand.type === 'spatial-zoom-1x' || viewportCommand.type === 'spatial-zoom-input') {
      const engine = getRenderingEngine(engineIdRef.current)
      const viewport = engine?.getViewport(targetViewportId) as Types.IVolumeViewport | undefined
      if (!viewport || !isMprViewportRenderable(targetViewportId)) return

      const zoom = (viewportCommand.type === 'set-zoom' || viewportCommand.type === 'spatial-zoom-input') && typeof viewportCommand.zoom === 'number'
        ? viewportCommand.zoom
        : viewportCommand.type === 'spatial-zoom-1x'
          ? 1
          : Math.min(Math.max(viewport.getZoom() * (viewportCommand.type === 'zoom-in' ? 1.15 : 0.85), 0.2), 8)
      viewport.setZoom(zoom)
      resetViewportClippingRange(viewport)
      viewport.render()
      setMprZooms((current) => ({ ...current, [targetViewportId]: zoom }))
      return
    }

    if (viewportCommand.type === 'spatial-zoom-fit') {
      const engine = getRenderingEngine(engineIdRef.current)
      const viewport = engine?.getViewport(targetViewportId) as Types.IVolumeViewport | undefined
      if (!viewport || !isMprViewportRenderable(targetViewportId)) return

      viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
      resetViewportClippingRange(viewport)
      viewport.render()
      setMprZooms((current) => ({ ...current, [targetViewportId]: viewport.getZoom() }))
      return
    }

    if (viewportCommand.type === 'set-window-level') {
      const engine = getRenderingEngine(engineIdRef.current)
      const viewport = engine?.getViewport(targetViewportId) as Types.IVolumeViewport | undefined
      if (!viewport || !isMprViewportRenderable(targetViewportId) || !viewportCommand.windowLevel) return

      setMprVoiRange(viewport, windowLevelToVoiRange(viewportCommand.windowLevel))
      viewport.render()
      return
    }

    if (viewportCommand.type === 'invert') {
      const engine = getRenderingEngine(engineIdRef.current)
      const viewport = engine?.getViewport(targetViewportId) as (Types.IVolumeViewport & {
        getProperties?: () => { invert?: boolean }
        setProperties?: (properties: { invert?: boolean }) => void
      }) | undefined
      if (!viewport || !isMprViewportRenderable(targetViewportId)) return

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
      const engine = getRenderingEngine(engineIdRef.current)
      const viewport = engine?.getViewport(targetViewportId) as (Types.IVolumeViewport & {
        flip?: (direction: { flipHorizontal?: boolean; flipVertical?: boolean }) => void
      }) | undefined
      if (!viewport || !isMprViewportRenderable(targetViewportId)) return

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
      applyMprWindowPreset(preset)
    }
  }, [activeViewport, viewportCommand])

  function renderMprViewports() {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    MPR_VIEWPORT_IDS.forEach((id) => {
      if (!isMprViewportRenderable(id)) return
      engine.getViewport(id)?.render()
    })
  }

  function configureMprCrosshairsTool(toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>) {
    toolGroup.setToolConfiguration(CrosshairsTool.toolName, {
      viewportIndicators: true,
      viewportIndicatorsConfig: {
        circleRadius: 5,
        xOffset: 0.95,
        yOffset: 0.05,
      },
      autoPan: {
        enabled: false,
        panSize: 10,
      },
      getReferenceLineColor: (viewportId: string) => {
        if (viewportId.includes('axial')) return 'rgb(200, 0, 0)'
        if (viewportId.includes('sagittal')) return 'rgb(198, 134, 25)'
        if (viewportId.includes('coronal')) return 'rgb(0, 173, 239)'
        return '#0c0'
      },
      getReferenceLineControllable: () => true,
      getReferenceLineDraggableRotatable: () => true,
      getReferenceLineSlabThicknessControlsOn: () => true,
    })
  }

  function applyMprWindowPreset(voiRange: { lower: number; upper: number }) {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    MPR_VIEWPORT_IDS.forEach((id) => {
      if (!isMprViewportRenderable(id)) return
      const viewport = engine.getViewport(id) as Types.IVolumeViewport | undefined
      setMprVoiRange(viewport, voiRange)
      viewport?.render()
    })
  }

  function isMprViewportRenderable(viewportId: string) {
    const index = MPR_VIEWPORT_IDS.indexOf(viewportId as (typeof MPR_VIEWPORT_IDS)[number])
    const element = elementRefs.current[index]

    return Boolean(element && element.clientWidth > 2 && element.clientHeight > 2)
  }

  function areMprElementsRenderable() {
    return MPR_VIEWPORT_IDS.every((viewportId) => isMprViewportRenderable(viewportId))
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

  function setMprWheelScrollActive(toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>) {
    toolGroup.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
    })
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
      MPR_VIEWPORT_IDS.forEach((id) => {
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
    MPR_VIEWPORT_IDS.forEach((viewportId, index) => {
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

    MPR_VIEWPORT_IDS.forEach((id) => {
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

  function rotateMprViewportInPlane(viewport: Types.IVolumeViewport, delta: number) {
    const rotationViewport = viewport as Types.IVolumeViewport & {
      getRotation?: () => number
      setViewPresentation?: (presentation: { rotation?: number }) => void
    }
    const currentRotation = rotationViewport.getRotation?.() ?? 0
    const nextRotation = ((currentRotation + delta) % 360 + 360) % 360

    rotationViewport.setViewPresentation?.({ rotation: nextRotation })
    resetViewportClippingRange(viewport)
  }

  function resetMprSlabObliqueViewport(viewportId = activeViewport) {
    const index = MPR_VIEWPORT_IDS.indexOf(viewportId as (typeof MPR_VIEWPORT_IDS)[number])
    const orientationOption = MPR_ORIENTATION_OPTIONS[viewportOrientationsRef.current[index] ?? 0]
    const standard = MPR_STANDARD_CAMERAS[orientationOption.orientation]
    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
    if (!viewport || !isMprViewportRenderable(viewportId)) return

    viewport.setCamera({
      viewPlaneNormal: point3FromVec3(standard.normal),
      viewUp: point3FromVec3(standard.viewUp),
    })
    viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true })
    setMprSlabThickness(viewport, 1)
    setSlabThicknesses((current) => ({ ...current, [viewportId]: 1 }))
    setSlabThicknessInputs((current) => ({ ...current, [viewportId]: '1' }))
    slabThicknessesRef.current = { ...slabThicknessesRef.current, [viewportId]: 1 }
    resetViewportClippingRange(viewport)
    viewport.render()
    updateMprOrientationLabel(viewportId, viewport)
    updateMprSliceInfo(viewportId, viewport)
    setMprZooms((current) => ({ ...current, [viewportId]: viewport.getZoom() }))
    recomputeMprCrosshairsTool()
  }

  function handleTileClick(viewportId: string) {
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId)
  }

  function handleTileDoubleClick(viewportId: string) {
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId)
    setMaximizedViewport((prev) => {
      const newVal = prev === viewportId ? null : viewportId
      resizeMprWhenReady()
      return newVal
    })
  }

  function handleOrientationCycle(event: React.PointerEvent<HTMLButtonElement>, viewportId: string, index: number) {
    event.preventDefault()
    event.stopPropagation()
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId)
    cycleMprViewportPlane(viewportId, index)
  }

  function cycleMprViewportPlane(viewportId: string, knownIndex?: number) {
    const index = typeof knownIndex === 'number'
      ? knownIndex
      : MPR_VIEWPORT_IDS.indexOf(viewportId as (typeof MPR_VIEWPORT_IDS)[number])
    if (index < 0) return

    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId)
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

  function handleTilePointerDown(viewportId: string) {
    const now = Date.now()
    const isDoubleTap = lastPointerDownRef.current.viewportId === viewportId && now - lastPointerDownRef.current.time < 450
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId)

    if (isDoubleTap) {
      lastPointerDownRef.current = { viewportId: '', time: 0 }
      handleTileDoubleClick(viewportId)
      return
    }

    lastPointerDownRef.current = { viewportId, time: now }
  }

  function handleTileContextMenu(event: React.MouseEvent) {
    event.preventDefault()
    if (deleteSelectedAnnotations(true) > 0) {
      renderMprViewports()
    }
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
    const engine = getRenderingEngine(engineIdRef.current)
    const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
    if (!viewport || !isMprViewportRenderable(viewportId)) {
      setSlabThicknesses((current) => ({ ...current, [viewportId]: nextThickness }))
      setSlabThicknessInputs((current) => ({ ...current, [viewportId]: formatThicknessInput(nextThickness) }))
      return
    }

    setMprSlabThickness(viewport, nextThickness)
    viewport.render()
    setSlabThicknesses((current) => ({ ...current, [viewportId]: nextThickness }))
    setSlabThicknessInputs((current) => ({ ...current, [viewportId]: formatThicknessInput(nextThickness) }))
    slabThicknessesRef.current = { ...slabThicknessesRef.current, [viewportId]: nextThickness }
    updateMprSliceInfo(viewportId, viewport)
    renderMprViewports()
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
    const viewport = engine?.getViewport(viewportId) as Types.IVolumeViewport | undefined
    setBlendModes((current) => ({ ...current, [viewportId]: mode }))

    if (!viewport || !isMprViewportRenderable(viewportId)) {
      return
    }

    setMprBlendMode(viewport, mode)
    setMprSlabThickness(viewport, slabThicknessesRef.current[viewportId] ?? 1)
    viewport.render()
    renderMprViewports()
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
    const rawSliceIndex = getMprSliceIndex(viewport)
    const rawSliceCount = getMprSliceCount(viewport)
    const sliceStep = getEffectiveSliceStep(slabThicknessesRef.current[viewportId] ?? 1)
    if (rawSliceIndex >= 0 && rawSliceCount > 0) {
      const effectiveSliceCount = Math.max(1, Math.ceil(rawSliceCount / sliceStep))
      const effectiveSliceIndex = Math.min(Math.floor(rawSliceIndex / sliceStep), effectiveSliceCount - 1)
      setMprSliceInfo(viewportId, effectiveSliceIndex, effectiveSliceCount)
    }
  }

  function updateMprOrientationLabel(viewportId: string, viewport: Types.IVolumeViewport) {
    const label = getMprOrientationLabel(viewport.getCamera().viewPlaneNormal)
    setMprOrientationLabels((current) => {
      if (current[viewportId] === label) {
        return current
      }

      return { ...current, [viewportId]: label }
    })
  }

  function jumpMprViewportToSlice(viewportId: string, sliceIndex: number) {
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

    if (target) {
      viewport.jumpToWorld?.(target.point)
    }
  }

  return (
    <div className="mpr-container" ref={containerRef}>
      <div className={`mpr-grid ${maximizedViewport ? 'mpr-maximized' : ''}`}>
        {MPR_VIEWPORT_IDS.map((viewportId, index) => {
          const isMaximized = maximizedViewport === viewportId
          const isHidden = maximizedViewport !== null && !isMaximized
          const orientation = MPR_ORIENTATION_OPTIONS[viewportOrientations[index]]
          const orientationLabel = mprOrientationLabels[viewportId] ?? orientation.label

          return (
            <div
              key={viewportId}
              className={`mpr-viewport-tile${activeViewport === viewportId && !maximizedViewport ? ' active' : ''}${isMaximized ? ' maximized' : ''}${isHidden ? ' hidden' : ''}`}
              onClick={() => handleTileClick(viewportId)}
              onPointerDown={() => handleTilePointerDown(viewportId)}
              onContextMenu={handleTileContextMenu}
            >
              <div
                className="mpr-viewport-element"
                ref={(el) => { elementRefs.current[index] = el }}
              />
              {previewUrls && !volumeLoaded && (
                <img
                  className="mpr-preview-overlay"
                  ref={(el) => { previewRefs.current[viewportId] = el }}
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
              <button
                className="mpr-label"
                type="button"
                title="Tap to change plane"
                onPointerDown={(event) => handleOrientationCycle(event, viewportId, index)}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {orientationLabel}
              </button>
              <details className="mpr-thickness-menu" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <summary>{formatThicknessLabel(slabThicknesses[viewportId] ?? 1)}</summary>
                <div className="mpr-thickness-popover">
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
                  <label>
                    Manual mm
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
              <details className="mpr-blend-menu" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <summary>{getMprBlendModeShortLabel(blendModes[viewportId] ?? 'normal')}</summary>
                <div className="mpr-blend-popover">
                  {MPR_BLEND_MODE_OPTIONS.map((option) => (
                    <button
                      className={blendModes[viewportId] === option.value ? 'active' : ''}
                      key={option.value}
                      type="button"
                      onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); handleBlendModeChange(viewportId, option.value) }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </details>
              {activeTool === 'Zoom' && activeViewport === viewportId && !isHidden && (
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
    </div>
  )
}

function getMprSliceIndex(viewport: Types.IVolumeViewport) {
  const sliceIndex = (viewport as Types.IVolumeViewport & { getSliceIndex?: () => number }).getSliceIndex?.()
  return Number.isFinite(sliceIndex) ? Math.round(sliceIndex as number) : -1
}

function getMprSliceCount(viewport: Types.IVolumeViewport) {
  const sliceCount = (viewport as Types.IVolumeViewport & { getNumberOfSlices?: () => number }).getNumberOfSlices?.()
  return Number.isFinite(sliceCount) ? Math.round(sliceCount as number) : 0
}

function resolveMprViewportId(targetViewportKey: string | undefined, fallbackViewportId: string) {
  return MPR_VIEWPORT_IDS.includes(targetViewportKey as (typeof MPR_VIEWPORT_IDS)[number])
    ? targetViewportKey as (typeof MPR_VIEWPORT_IDS)[number]
    : fallbackViewportId
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

function setMprVoiRange(viewport: Types.IVolumeViewport | undefined, voiRange: { lower: number; upper: number }) {
  const volumeViewport = viewport as (Types.IVolumeViewport & {
    setProperties?: (properties: { voiRange?: { lower: number; upper: number } }) => void
  }) | undefined

  volumeViewport?.setProperties?.({ voiRange })
}

function setMprBlendMode(viewport: Types.IVolumeViewport, mode: MprBlendMode) {
  const blendViewport = viewport as Types.IVolumeViewport & { setBlendMode?: (blendMode: number, filterActorUIDs?: string[], immediate?: boolean) => void }
  const blendMode = mode === 'mip'
    ? Enums.BlendModes.MAXIMUM_INTENSITY_BLEND
    : mode === 'minip'
      ? Enums.BlendModes.MINIMUM_INTENSITY_BLEND
      : Enums.BlendModes.COMPOSITE
  blendViewport.setBlendMode?.(blendMode, [], true)
}

function windowLevelToVoiRange(windowLevel: { windowWidth: number; windowLevel: number }) {
  const width = Math.max(1, windowLevel.windowWidth)
  return {
    lower: windowLevel.windowLevel - width / 2,
    upper: windowLevel.windowLevel + width / 2,
  }
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

function getMprOrientationLabel(viewPlaneNormal: Types.Point3) {
  const normal = vec3.normalize(vec3.create(), viewPlaneNormal)
  const matchingStandard = Object.values(MPR_STANDARD_CAMERAS).find((standard) => (
    Math.abs(Math.abs(vec3.dot(normal, standard.normal)) - 1) <= ORIENTATION_LABEL_TOLERANCE
  ))

  return matchingStandard?.label ?? 'oblique'
}

function getMprBlendModeShortLabel(mode: MprBlendMode) {
  return MPR_BLEND_MODE_OPTIONS.find((option) => option.value === mode)?.shortLabel ?? 'N'
}

function point3FromVec3(value: vec3): Types.Point3 {
  return [value[0], value[1], value[2]]
}

function formatThicknessLabel(value: number) {
  return `T ${Number.isInteger(value) ? value : value.toFixed(1)}mm`
}

function formatThicknessInput(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function getMprOrientationOptionIndex(orientation: keyof typeof Enums.OrientationAxis) {
  return Math.max(0, MPR_ORIENTATION_OPTIONS.findIndex((option) => option.orientation === orientation))
}
