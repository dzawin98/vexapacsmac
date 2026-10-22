import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { vec3 } from 'gl-matrix'
import { ChevronDown, ChevronRight, Layers3, Maximize2, Minimize2, ScanLine, type LucideIcon } from 'lucide-react'
import {
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
  CircleROITool,
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
import type { SeriesSummary, StudySummary } from '../../dicomweb/types'
import { useAuthStore } from '../../auth/authStore'
import { clearAllAnnotations, deleteSelectedAnnotations } from '../annotationActions'
import { useViewerStore } from '../viewerStore'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { releaseCornerstoneWebGlContexts } from '../cornerstone/stackRenderingEngine'
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

const MPR_VIEWPORT_DEFS: readonly { id: string; label: string; orientation: keyof typeof Enums.OrientationAxis }[] = [
  { id: 'axial', label: 'A', orientation: 'AXIAL' },
  { id: 'sagittal', label: 'S', orientation: 'SAGITTAL' },
  { id: 'coronal', label: 'C', orientation: 'CORONAL' },
  { id: 'axial-compare', label: 'A', orientation: 'AXIAL' },
] as const
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
] as const
const ORIENTATION_LABEL_TOLERANCE = 0.01

type MprStatus = { loading: boolean; error: string }
type MprBlendMode = 'normal' | 'mip' | 'minip'
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
  initialWindowLevel,
}: MprViewerProps) {
  const safeViewportKey = viewportKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  const mprViewportIds = useMemo(() => MPR_VIEWPORT_DEFS.map((item) => `mpr-${safeViewportKey}-${item.id}`), [safeViewportKey])
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
  const [previewUrls, setPreviewUrls] = useState<Partial<Record<string, string>> | null>(null)
  const [volumeLoaded, setVolumeLoaded] = useState(false)
  const [mprSliceDisplayInfo, setMprSliceDisplayInfo] = useState<Record<string, MprSliceDisplayInfo>>({})
  const [mprWindowLevels, setMprWindowLevels] = useState<Record<string, { windowWidth: number; windowLevel: number }>>({})
  const slabThicknessesRef = useRef(slabThicknesses)
  const engineIdRef = useRef(`mpr-rendering-engine-${safeViewportKey}`)
  const toolGroupRef = useRef<ReturnType<typeof ToolGroupManager.createToolGroup>>(null)
  const lastPointerDownRef = useRef<{ viewportId: string; time: number }>({ viewportId: '', time: 0 })
  const cameraStabilizeFrameRef = useRef<number | null>(null)
  const lockingMprOrientationRef = useRef(false)
  const applyingLinkedCommandRef = useRef(false)
  const activeTool = useViewerStore((state) => state.activeTool)
  const hotkeyOverrides = useViewerStore((state) => state.hotkeyOverrides)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const permittedMenuSections = getPermittedMenuSections(hasPermission, series.modality ?? '')
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [activeContextSection, setActiveContextSection] = useState(permittedMenuSections[0]?.title ?? '')

  useEffect(() => {
    setMprActiveViewportId(mprViewportIds[0], viewportKey)
  }, [mprViewportIds, setMprActiveViewportId, viewportKey])

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
  }, [contextMenu, hasPermission, hotkeyOverrides, isSelected, mprViewportIds, onOpenAmbientTest, onOpenTagBrowser, onToggle3d, onToggle3dBone, onToggleMpr, onToggleOverlay, referenceLinesEnabled, series.modality, viewportKey])

  useEffect(() => {
    initializeCornerstone()
    dispatchStatus({ type: 'loading' })
    setLoadingMessage('')
    setErrorMessage('')
    setVolumeLoaded(false)
    setPreviewUrls(null)

    let cancelled = false
    const engineId = engineIdRef.current
    const volumeOwnerId = getDiagnosticVolumeOwnerId(viewportKey)
    const toolGroupId = `mpr-tool-group-${safeViewportKey}`
    let renderingEngine: RenderingEngine | null = null
    let toolGroup: ReturnType<typeof ToolGroupManager.createToolGroup> = null
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
          await setVolumesForViewports(renderingEngine!, [{ volumeId }], enabledMprViewportIds)
          if (cancelled) return

          enabledMprViewportIds.forEach((viewportId) => {
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

          await streamingComplete
          if (cancelled) return

          recomputeMprCrosshairsTool()
          renderMprViewports()
          setVolumeLoaded(true)
          setPreviewUrls(null)

          // Trigger initial prefetch after volume is set
          mprViewportIds.forEach((viewportId) => {
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
          mprViewportIds.forEach((viewportId) => {
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
          mprViewportIds.forEach((id) => toolGroup.addViewport(id, engineId))
          orderMprToolGroupViewportsForCrosshairs(toolGroup, viewportOrientationsRef.current)

          toolGroup.addTool(WindowLevelTool.toolName)
          toolGroup.addTool(PanTool.toolName)
          toolGroup.addTool(ZoomTool.toolName)
          toolGroup.addTool(StackScrollTool.toolName)

          toolGroup.addTool(CrosshairsTool.toolName, {
            viewportIndicators: false,
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

        renderingEngine.render()

        mprViewportIds.forEach((viewportId, index) => {
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
      toolGroupRef.current = null
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
      const engine = getRenderingEngine(engineId)
      if (engine) {
        mprViewportIds.forEach((viewportId) => {
          try {
            engine.disableElement(viewportId)
          } catch {
            // MPR viewport may already be gone if setup was interrupted.
          }
        })
        elementRefs.current.forEach((element) => releaseCornerstoneWebGlContexts(element))
        engine.destroy()
      }
      releaseSharedSeriesVolume(series, 'mpr', volumeOwnerId)
      setMprVolumeId(null)
      setLoadingMessage('')
      setErrorMessage('')
    }
  }, [initialWindowLevel?.windowLevel, initialWindowLevel?.windowWidth, mprViewportIds, safeViewportKey, series.studyInstanceUid, series.seriesInstanceUid, series.instanceCount, setMprVolumeId, setLoadingMessage, setErrorMessage, setMprSliceInfo, viewportKey])

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
      setMprToolGroupViewportScope(toolGroup, false)
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

    if (!volumeLoaded) {
      mprManagedToolNames.forEach((name) => {
        toolGroup.setToolPassive(name, { removeAllBindings: true })
      })
      toolGroup.setToolDisabled(CrosshairsTool.toolName)
      toolGroup.setToolDisabled(ReferenceLinesTool.toolName)
      setMprWheelScrollActive(toolGroup)
      return
    }

    setMprToolGroupViewportScope(toolGroup, true)

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
  }, [activeTool, activeViewport, referenceLinesEnabled, sendViewportCommand, setActiveTool, volumeLoaded])

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
        applyMprWindowPreset(preset)
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

  function applyMprWindowPreset(voiRange: { lower: number; upper: number }) {
    const engine = getRenderingEngine(engineIdRef.current)
    if (!engine) return

    mprViewportIds.forEach((id) => {
      if (!isMprViewportRenderable(id)) return
      const viewport = engine.getViewport(id) as Types.IVolumeViewport | undefined
      setMprVoiRange(viewport, voiRange)
      setMprWindowLevels((current) => ({ ...current, [id]: voiRangeToWindowLevel(voiRange) }))
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

      toolGroup.setToolConfiguration(ReferenceLinesTool.toolName, {
        sourceViewportId,
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
      mprViewportIds.forEach((id) => {
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
    mprViewportIds.forEach((viewportId, index) => {
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

  function setMprToolGroupViewportScope(
    toolGroup: NonNullable<ReturnType<typeof ToolGroupManager.createToolGroup>>,
    includeCompareViewport: boolean,
  ) {
    const group = toolGroup as unknown as { viewportsInfo?: Array<{ viewportId: string; renderingEngineId: string }> }
    if (!Array.isArray(group.viewportsInfo)) {
      return
    }

    const scopedViewportIds = includeCompareViewport
      ? mprViewportIds
      : mprViewportIds.filter((viewportId) => !viewportId.includes('axial-compare'))
    group.viewportsInfo.splice(0, group.viewportsInfo.length, ...scopedViewportIds.map((viewportId) => ({
      viewportId,
      renderingEngineId: engineIdRef.current,
    })))

    if (!includeCompareViewport) {
      orderMprToolGroupViewportsForCrosshairs(toolGroup)
    }
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
      mprViewportIds.forEach((viewportId, index) => {
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
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)
  }

  function toggleMprInlineControls(event: React.MouseEvent<HTMLButtonElement>, viewportId: string) {
    event.preventDefault()
    event.stopPropagation()
    setExpandedControlViewports((current) => ({ ...current, [viewportId]: !current[viewportId] }))
  }

  function handleTileDoubleClick(viewportId: string) {
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
    setActiveViewport(viewportId)
    setMprActiveViewportId(viewportId, viewportKey)

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

  function handleTileContextMenu(event: React.MouseEvent, viewportId: string) {
    event.preventDefault()
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

  function handleMprCursorPointerDown(event: React.PointerEvent<HTMLDivElement>, viewportId: string) {
    if (activeTool !== 'Stack3DCursor') {
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
    if (activeTool !== 'Probe' || event.button !== 0) {
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
    if (!viewport || !isMprViewportRenderable(viewportId)) {
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

    mprViewportIds.forEach((viewportId) => {
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
      <div className="mpr-grid">
        {mprViewportIds.map((viewportId, index) => {
          const orientation = MPR_ORIENTATION_OPTIONS[viewportOrientations[index]]
          const orientationLabel = mprOrientationLabels[viewportId] ?? orientation.label
          const orientationName = getMprOrientationName(orientationLabel)
          const blendModeOption = getMprBlendModeOption(blendModes[viewportId] ?? 'normal')
          const BlendModeIcon = blendModeOption.icon
          const controlsExpanded = Boolean(expandedControlViewports[viewportId])
          const overlayInfo = buildMprOverlayInfo({
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
              className={`mpr-viewport-tile${activeViewport === viewportId ? ' active' : ''}`}
              onClick={() => handleTileClick(viewportId)}
              onPointerDown={(event) => handleTilePointerDown(event, viewportId)}
              onContextMenu={(event) => handleTileContextMenu(event, viewportId)}
            >
              <div
                className="mpr-viewport-element"
                ref={(el) => { elementRefs.current[index] = el }}
                onPointerDown={(event) => {
                  startModifierGesture(event, viewportId)
                  if (!modifierGestureRef.current) {
                    handleMprProbePointerDown(event, viewportId)
                    handleMprCursorPointerDown(event, viewportId)
                  }
                }}
                onPointerMove={(event) => {
                  updateModifierGesture(event, viewportId)
                  if (!modifierGestureRef.current) {
                    handleMprProbePointerMove(event, viewportId)
                    handleMprCursorPointerMove(event, viewportId)
                  }
                }}
                onPointerUp={(event) => {
                  stopModifierGesture(event)
                  handleMprProbePointerUp(event)
                  handleMprCursorPointerUp(event)
                }}
                onPointerCancel={(event) => {
                  stopModifierGesture(event)
                  handleMprProbePointerUp(event)
                  handleMprCursorPointerUp(event)
                }}
                onLostPointerCapture={stopModifierGesture}
                onDoubleClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleTileDoubleClick(viewportId)
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
                  </>
                )}
              </div>
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
      {renderMprContextMenu()}
    </div>
  )
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
  const blendMode = getCornerstoneBlendMode(mode)
  blendViewport.setBlendMode?.(blendMode, [], true)
}

function getCornerstoneBlendMode(mode: MprBlendMode) {
  if (mode === 'mip') {
    return Enums.BlendModes.MAXIMUM_INTENSITY_BLEND
  }
  if (mode === 'minip') {
    return Enums.BlendModes.MINIMUM_INTENSITY_BLEND
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
