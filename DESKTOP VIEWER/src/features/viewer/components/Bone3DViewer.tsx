import { useEffect, useReducer, useRef, useState } from 'react'
import { Enums, eventTarget, getRenderingEngine, RenderingEngine, setVolumesForViewports, utilities, type Types } from '@cornerstonejs/core'
import {
  AngleTool,
  BidirectionalTool,
  CircleROITool,
  CobbAngleTool,
  EllipticalROITool,
  Enums as ToolEnums,
  LengthTool,
  PanTool,
  PlanarFreehandROITool,
  ProbeTool,
  RectangleROITool,
  StackScrollTool,
  ToolGroupManager,
  TrackballRotateTool,
  WindowLevelTool,
  ZoomTool,
} from '@cornerstonejs/tools'
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction'
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction'
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor'
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget'
import { Corners } from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget/Constants'
import { Blend } from 'lucide-react'
import type { SeriesSummary } from '../../dicomweb/types'
import { useAuthStore } from '../../auth/authStore'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { acquireSharedSeriesVolume, getDiagnosticVolumeOwnerId, releaseSharedSeriesVolume } from '../cornerstone/volumeCache'
import { useViewerStore } from '../viewerStore'
import { createHotkeyActions, isEditableEventTarget, toHotkey, type ViewportMenuAction } from './DicomViewport'

type Volume3DStatus = { loading: boolean; error: string }
type Bone3DPanelMode = 'closed' | 'menu' | 'options' | 'presets'
type Bone3DRenderMode = 'oblique' | 'bone'
type Bone3DDisplayMode = 'volume' | 'axial' | 'sagittal' | 'coronal' | 'reformat' | 'acquisition'
type Bone3DModifierGesture =
  | { type: 'zoom'; pointerId: number; startY: number; startZoom: number }
  | { type: 'pan'; pointerId: number; lastCanvasPoint: Types.Point2 }
type Bone3DLiveProbeValue = { canvasPoint: Types.Point2; value: number; unit: string }
type Bone3DCameraShortcut = 'A' | 'P' | 'R' | 'L'
type Bone3DCameraPreset = { viewPlaneNormal: Types.Point3; viewUp: Types.Point3 }
type Bone3DRendererLike = {
  computeVisiblePropBounds?: () => number[]
  resetCameraClippingRange?: (bounds?: number[]) => void
}
type Bone3DViewportInternals = Types.IVolumeViewport & {
  applyViewOrientation?: (orientation: Bone3DCameraPreset, resetCamera?: boolean) => void
  getRenderer?: () => Bone3DRendererLike
  setInitialCamera?: (camera: Types.ICamera) => void
}
type Bone3DViewerProps = {
  series: SeriesSummary
  viewportKey?: string
  mode?: Bone3DRenderMode
  onSelect?: () => void
  onToggleOverlay?: () => void
  onOpenTagBrowser?: () => void
  onToggleMpr?: () => void
  onToggle3d?: () => void
  onToggle3dBone?: () => void
  onOpenAmbientTest?: () => void
  onToggleViewportFullscreen?: () => void
}

const renderingPresets = [
  { id: 'ct-aaa', label: 'CT-AAA', quality: 0.72, shift: -70, shade: true, ambient: 0.16, diffuse: 0.82, specular: 0.2, colors: ['#c8c1a4', '#fff7c7'] },
  { id: 'ct-aaa2', label: 'CT-AAA2', quality: 0.78, shift: -30, shade: true, ambient: 0.2, diffuse: 0.88, specular: 0.25, colors: ['#cdbb72', '#fff2a8'] },
  { id: 'ct-bone', label: 'CT-Bone', quality: 0.7, shift: 0, shade: true, ambient: 0.12, diffuse: 0.9, specular: 0.28, colors: ['#6f4c39', '#f8f2df'] },
  { id: 'ct-bones', label: 'CT-Bones', quality: 0.64, shift: 80, shade: true, ambient: 0.14, diffuse: 0.82, specular: 0.22, colors: ['#d64b1f', '#fff0d7'] },
  { id: 'ct-cardiac', label: 'CT-Cardiac', quality: 0.62, shift: -160, shade: true, ambient: 0.22, diffuse: 0.78, specular: 0.22, colors: ['#8b4d2d', '#d22e2e'] },
  { id: 'ct-chest', label: 'CT-Chest-Contrast', quality: 0.66, shift: -90, shade: true, ambient: 0.18, diffuse: 0.86, specular: 0.2, colors: ['#b18c64', '#fbf3df'] },
  { id: 'ct-fat', label: 'CT-Fat', quality: 0.38, shift: -260, shade: false, ambient: 0.4, diffuse: 0.55, specular: 0.05, colors: ['#baff99', '#5ce26b'] },
  { id: 'ct-lung', label: 'CT-Lung', quality: 0.42, shift: -420, shade: true, ambient: 0.26, diffuse: 0.78, specular: 0.12, colors: ['#b6e9c2', '#82bd7d'] },
  { id: 'ct-mip', label: 'CT-MIP', quality: 1, shift: 120, shade: false, ambient: 0.35, diffuse: 0.65, specular: 0.12, colors: ['#c7f3ff', '#ecfdff'] },
  { id: 'ct-muscle', label: 'CT-Muscle', quality: 0.55, shift: -180, shade: true, ambient: 0.24, diffuse: 0.74, specular: 0.18, colors: ['#8b5b3d', '#d9a076'] },
  { id: 'ct-soft', label: 'CT-Soft-Tissue', quality: 0.5, shift: -220, shade: true, ambient: 0.3, diffuse: 0.7, specular: 0.1, colors: ['#c9c9c9', '#ffffff'] },
  { id: 'mr-default', label: 'MR-Default', quality: 0.58, shift: -120, shade: true, ambient: 0.24, diffuse: 0.78, specular: 0.16, colors: ['#8fb4c8', '#d7c19d'] },
] as const

const defaultRenderingPreset = renderingPresets.find((preset) => preset.id === 'ct-bones') ?? renderingPresets[3]
const reformatWindowPresets = [
  { id: 'preset-lung', label: 'Lung WW 1500 / WL -600' },
  { id: 'preset-bone', label: 'Bone WW 2000 / WL 500' },
  { id: 'preset-brain', label: 'Brain WW 80 / WL 40' },
  { id: 'preset-mediastinum', label: 'Mediastinum WW 350 / WL 50' },
  { id: 'preset-soft', label: 'Soft Tissue WW 400 / WL 40' },
] as const
const bone3dCameraPresets: Record<Bone3DCameraShortcut, Bone3DCameraPreset> = {
  A: { viewPlaneNormal: [0, -1, 0], viewUp: [0, 0, 1] },
  P: { viewPlaneNormal: [0, 1, 0], viewUp: [0, 0, 1] },
  R: { viewPlaneNormal: [-1, 0, 0], viewUp: [0, 0, 1] },
  L: { viewPlaneNormal: [1, 0, 0], viewUp: [0, 0, 1] },
}
const transientBone3dToolByStoreId: Record<string, string> = {
  Length: LengthTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  RectangleROI: RectangleROITool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  CircleROI: CircleROITool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
}

function statusReducer(_state: Volume3DStatus, action: { type: 'loading' } | { type: 'done' } | { type: 'error'; error: string }): Volume3DStatus {
  switch (action.type) {
    case 'loading': return { loading: true, error: '' }
    case 'done': return { loading: false, error: '' }
    case 'error': return { loading: false, error: action.error }
  }
}

export function Bone3DViewer(props: Bone3DViewerProps) {
  return <ClientVolume3DViewer {...props} />
}

function ClientVolume3DViewer({
  series,
  viewportKey = '0',
  mode = 'bone',
  onSelect,
  onToggleOverlay,
  onOpenTagBrowser,
  onToggleMpr,
  onToggle3d,
  onToggle3dBone,
  onOpenAmbientTest,
  onToggleViewportFullscreen,
}: Bone3DViewerProps) {
  const viewportId = `ct-bone-3d-viewport-${viewportKey}`
  const engineId = `ct-bone-3d-engine-${viewportKey}`
  const volumeOwnerId = getDiagnosticVolumeOwnerId(viewportKey)
  const toolGroupId = `ct-bone-3d-tools-${viewportKey}`
  const elementRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<Types.IVolumeViewport | null>(null)
  const toolGroupRef = useRef<ReturnType<typeof ToolGroupManager.createToolGroup>>(null)
  const orientationWidgetRef = useRef<{ setEnabled: (enabled: boolean) => void; delete?: () => void } | null>(null)
  const modifierGestureRef = useRef<Bone3DModifierGesture | null>(null)
  const liveProbePointerIdRef = useRef<number | null>(null)
  const [{ loading, error }, dispatchStatus] = useReducer(statusReducer, { loading: true, error: '' })
  const [quality, setQuality] = useState<number>(defaultRenderingPreset.quality)
  const [shift, setShift] = useState<number>(defaultRenderingPreset.shift)
  const [shade, setShade] = useState<boolean>(defaultRenderingPreset.shade)
  const [ambient, setAmbient] = useState<number>(defaultRenderingPreset.ambient)
  const [diffuse, setDiffuse] = useState<number>(defaultRenderingPreset.diffuse)
  const [specular, setSpecular] = useState<number>(defaultRenderingPreset.specular)
  const [transferColors, setTransferColors] = useState<readonly [string, string]>(defaultRenderingPreset.colors)
  const [displayMode, setDisplayMode] = useState<Bone3DDisplayMode>(mode === 'bone' ? 'volume' : 'axial')
  const [reformatSlabThickness, setReformatSlabThickness] = useState(1)
  const [panelMode, setPanelMode] = useState<Bone3DPanelMode>('closed')
  const [presetSearch, setPresetSearch] = useState('')
  const [liveProbeValue, setLiveProbeValue] = useState<Bone3DLiveProbeValue | null>(null)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const activeTool = useViewerStore((state) => state.activeTool)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const hotkeyOverrides = useViewerStore((state) => state.hotkeyOverrides)
  const referenceLinesEnabled = useViewerStore((state) => state.referenceLinesEnabled)
  const setReferenceLinesEnabled = useViewerStore((state) => state.setReferenceLinesEnabled)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const viewportCommand = useViewerStore((state) => state.viewportCommands[viewportKey] ?? state.viewportCommand)
  const processedViewportCommandIdRef = useRef<number | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) {
      return
    }

    initializeCornerstone()
    dispatchStatus({ type: 'loading' })
    setLoadingMessage('')
    setErrorMessage('')

    let cancelled = false
    let renderingEngine: RenderingEngine | null = null

    async function setup3D() {
      try {
        const { volumeId, instances } = await acquireSharedSeriesVolume(series, 'mpr', volumeOwnerId)
        if (cancelled) return
        if (!instances.length) {
          throw new Error('No renderable CT images found for 3D volume')
        }

        renderingEngine = new RenderingEngine(engineId)
        renderingEngine.enableElement({
          viewportId,
          type: mode === 'bone' ? Enums.ViewportType.VOLUME_3D : Enums.ViewportType.ORTHOGRAPHIC,
          element,
          defaultOptions: {
            background: [0, 0, 0],
            orientation: mode === 'bone' ? bone3dCameraPresets.A : getReformatOrientationAxis(getReformatDisplayMode(displayMode)),
          },
        })

        await setVolumesForViewports(renderingEngine, [{ volumeId, blendMode: Enums.BlendModes.COMPOSITE }], [viewportId], true)
        const viewport = renderingEngine.getViewport(viewportId) as Types.IVolumeViewport
        viewportRef.current = viewport
        if (mode === 'bone') {
          applyBonePreset(viewport, { quality, shift, shade, ambient, diffuse, specular, colors: transferColors })
          applyBone3DCameraPreset(viewport, bone3dCameraPresets.A)
        } else {
          applyReformatPreset(viewport, reformatSlabThickness, getReformatDisplayMode(displayMode))
        }
        orientationWidgetRef.current = addOrientationCube(viewport)
        renderingEngine.render()

        const toolGroup = ToolGroupManager.createToolGroup(toolGroupId)
        if (toolGroup) {
          toolGroup.addViewport(viewportId, engineId)
          toolGroup.addTool(WindowLevelTool.toolName)
          toolGroup.addTool(TrackballRotateTool.toolName)
          toolGroup.addTool(PanTool.toolName)
          toolGroup.addTool(ZoomTool.toolName)
          toolGroup.addTool(StackScrollTool.toolName)
          toolGroup.addTool(LengthTool.toolName)
          toolGroup.addTool(AngleTool.toolName)
          toolGroup.addTool(CobbAngleTool.toolName)
          toolGroup.addTool(BidirectionalTool.toolName)
          toolGroup.addTool(RectangleROITool.toolName)
          toolGroup.addTool(EllipticalROITool.toolName)
          toolGroup.addTool(CircleROITool.toolName)
          toolGroup.addTool(PlanarFreehandROITool.toolName)
          toolGroup.addTool(ProbeTool.toolName)
          toolGroup.setToolPassive(WindowLevelTool.toolName, { removeAllBindings: true })
          toolGroup.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
          toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] })
          toolGroupRef.current = toolGroup
        }

        dispatchStatus({ type: 'done' })
        setLoadingMessage('')
      } catch (setupError) {
        if (!cancelled) {
          const message = mode === 'bone' ? 'Unable to prepare 3D Bone volume.' : 'Unable to prepare 3D Oblique volume.'
          dispatchStatus({ type: 'error', error: message })
          setErrorMessage(message)
          setLoadingMessage('')
        }
      }
    }

    void setup3D()

    const resizeObserver = new ResizeObserver(() => {
      renderingEngine?.resize(true, false)
      viewportRef.current?.render()
    })
    resizeObserver.observe(element)

    return () => {
      cancelled = true
      toolGroupRef.current = null
      orientationWidgetRef.current?.setEnabled(false)
      orientationWidgetRef.current?.delete?.()
      orientationWidgetRef.current = null
      resizeObserver.disconnect()
      ToolGroupManager.destroyToolGroup(toolGroupId)
      const engine = getRenderingEngine(engineId)
      if (engine) {
        engine.disableElement(viewportId)
        engine.destroy()
      }
      releaseSharedSeriesVolume(series, 'mpr', volumeOwnerId)
      viewportRef.current = null
      setLoadingMessage('')
      setErrorMessage('')
    }
  }, [engineId, mode, series.studyInstanceUid, series.seriesInstanceUid, series.instanceCount, setErrorMessage, setLoadingMessage, toolGroupId, viewportId, volumeOwnerId])

  useEffect(() => {
    setActiveTool('Rotate3D')
  }, [setActiveTool])

  useEffect(() => {
    if (activeTool === 'CycleOrthogonalPlanes' && displayMode !== 'reformat') {
      setDisplayMode('reformat')
      setActiveTool('Rotate3D')
    }
  }, [activeTool, displayMode, setActiveTool])

  useEffect(() => {
    if (mode !== 'bone') {
      return
    }

    function handleBone3dCameraShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || isEditableKeyboardTarget(event.target)) {
        return
      }

      const key = event.key.toUpperCase()
      if (!isBone3DCameraShortcut(key)) {
        return
      }

      if (useViewerStore.getState().selectedViewportKey !== viewportKey) {
        return
      }

      const viewport = viewportRef.current
      if (!viewport) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      applyBone3DCameraPreset(viewport, bone3dCameraPresets[key])
    }

    window.addEventListener('keydown', handleBone3dCameraShortcut, true)
    return () => window.removeEventListener('keydown', handleBone3dCameraShortcut, true)
  }, [mode, viewportKey])

  useEffect(() => {
    function handleBone3dHotkey(event: KeyboardEvent) {
      if (selectedViewportKey !== viewportKey) {
        return
      }
      if (event.defaultPrevented || isEditableEventTarget(event.target)) {
        return
      }

      if (event.key === 'Escape' && panelMode !== 'closed') {
        event.preventDefault()
        setPanelMode('closed')
        return
      }

      const action = createHotkeyActions(hotkeyOverrides, hasPermission, series.modality ?? '').get(toHotkey(event))
      if (!action) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      runBone3DHotkeyAction(action)
    }

    document.addEventListener('keydown', handleBone3dHotkey)
    return () => document.removeEventListener('keydown', handleBone3dHotkey)
  }, [activeTool, hasPermission, hotkeyOverrides, onOpenAmbientTest, onOpenTagBrowser, onToggle3d, onToggle3dBone, onToggleMpr, onToggleOverlay, panelMode, referenceLinesEnabled, selectedViewportKey, series.modality, viewportKey])

  useEffect(() => {
    const toolGroup = toolGroupRef.current
    if (!toolGroup) return

    const controlledTools = [
      WindowLevelTool.toolName,
      TrackballRotateTool.toolName,
      PanTool.toolName,
      ZoomTool.toolName,
      StackScrollTool.toolName,
      LengthTool.toolName,
      AngleTool.toolName,
      CobbAngleTool.toolName,
      BidirectionalTool.toolName,
      RectangleROITool.toolName,
      EllipticalROITool.toolName,
      CircleROITool.toolName,
      PlanarFreehandROITool.toolName,
      ProbeTool.toolName,
    ]

    controlledTools.forEach((toolName) => {
      toolGroup.setToolPassive(toolName, { removeAllBindings: true })
    })

    if (activeTool === 'WindowLevel') {
      toolGroup.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Zoom') {
      toolGroup.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Pan') {
      toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Scroll') {
      toolGroup.setToolActive(StackScrollTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
      })
    } else if (activeTool === 'Rotate3D') {
      toolGroup.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
      toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] })
    } else if (activeTool === 'Length') {
      toolGroup.setToolActive(LengthTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Angle') {
      toolGroup.setToolActive(AngleTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'CobbAngle') {
      toolGroup.setToolActive(CobbAngleTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Bidirectional') {
      toolGroup.setToolActive(BidirectionalTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'RectangleROI') {
      toolGroup.setToolActive(RectangleROITool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'EllipticalROI') {
      toolGroup.setToolActive(EllipticalROITool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'CircleROI') {
      toolGroup.setToolActive(CircleROITool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'PlanarFreehandROI') {
      toolGroup.setToolActive(PlanarFreehandROITool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Probe') {
      toolGroup.setToolDisabled(ProbeTool.toolName)
    } else {
      toolGroup.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
      toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] })
    }
  }, [activeTool, displayMode, setActiveTool, setErrorMessage])

  useEffect(() => {
    if (activeTool !== 'Probe') {
      liveProbePointerIdRef.current = null
      setLiveProbeValue(null)
    }
  }, [activeTool])

  useEffect(() => {
    if (!viewportCommand || processedViewportCommandIdRef.current === viewportCommand.id) {
      return
    }
    processedViewportCommandIdRef.current = viewportCommand.id

    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    if (viewportCommand.type === 'reset') {
      resetCamera()
      return
    }

    if (viewportCommand.type === 'set-zoom' || viewportCommand.type === 'zoom-in' || viewportCommand.type === 'zoom-out' || viewportCommand.type === 'spatial-zoom-1x' || viewportCommand.type === 'spatial-zoom-fit') {
      if (viewportCommand.type === 'spatial-zoom-fit') {
        viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
        viewport.render()
        return
      }

      const currentZoom = viewport.getZoom()
      const nextZoom = viewportCommand.type === 'set-zoom' && typeof viewportCommand.zoom === 'number'
        ? viewportCommand.zoom
        : viewportCommand.type === 'spatial-zoom-1x'
          ? 1
          : Math.min(Math.max(currentZoom * (viewportCommand.type === 'zoom-in' ? 1.15 : 0.85), 0.08), 80)
      viewport.setZoom(nextZoom)
      viewport.render()
      return
    }

    if (viewportCommand.type === 'invert') {
      const invertViewport = viewport as Types.IVolumeViewport & {
        getProperties?: () => { invert?: boolean }
        setProperties?: (properties: { invert?: boolean }) => void
      }
      const currentInvert = Boolean(invertViewport.getProperties?.().invert)
      invertViewport.setProperties?.({ invert: !currentInvert })
      viewport.render()
      return
    }

    if (viewportCommand.type === 'set-window-level' && viewportCommand.windowLevel) {
      const reformatViewport = viewport as Types.IVolumeViewport & {
        setProperties?: (properties: { voiRange?: { lower: number; upper: number } }) => void
      }
      reformatViewport.setProperties?.({ voiRange: windowLevelToVoiRange(viewportCommand.windowLevel) })
      viewport.render()
      return
    }

    const preset = getReformatWindowPreset(viewportCommand.type)
    if (preset && displayMode !== 'volume') {
      const reformatViewport = viewport as Types.IVolumeViewport & {
        setProperties?: (properties: { voiRange?: { lower: number; upper: number } }) => void
      }
      reformatViewport.setProperties?.({ voiRange: preset })
      viewport.render()
    }
  }, [displayMode, viewportCommand])

  useEffect(() => {
    function resetTransient3dTool(event: Event) {
      const expectedToolName = transientBone3dToolByStoreId[activeTool]
      if (!expectedToolName) {
        return
      }

      const completedToolName = (event as CustomEvent<{ annotation?: { metadata?: { toolName?: string } } }>).detail?.annotation?.metadata?.toolName
      if (completedToolName && completedToolName !== expectedToolName) {
        return
      }

      window.setTimeout(() => {
        if (useViewerStore.getState().activeTool === activeTool) {
          setActiveTool('Rotate3D')
        }
      }, 0)
    }

    eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransient3dTool)

    return () => {
      eventTarget.removeEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, resetTransient3dTool)
    }
  }, [activeTool, setActiveTool])

  function update3dOptions(nextOptions: Partial<Bone3DOptions>) {
    const options = { quality, shift, shade, ambient, diffuse, specular, colors: transferColors, ...nextOptions }
    if (typeof nextOptions.quality === 'number') setQuality(nextOptions.quality)
    if (typeof nextOptions.shift === 'number') setShift(nextOptions.shift)
    if (typeof nextOptions.shade === 'boolean') setShade(nextOptions.shade)
    if (typeof nextOptions.ambient === 'number') setAmbient(nextOptions.ambient)
    if (typeof nextOptions.diffuse === 'number') setDiffuse(nextOptions.diffuse)
    if (typeof nextOptions.specular === 'number') setSpecular(nextOptions.specular)
    if (nextOptions.colors) setTransferColors(nextOptions.colors)

    const viewport = viewportRef.current
    if (viewport) {
      applyBonePreset(viewport, options)
      viewport.render()
    }
  }

  function updateReformatSlabThickness(value: number) {
    const nextValue = normalizeReformatSlabThickness(value)
    setReformatSlabThickness(nextValue)
    const viewport = viewportRef.current
    if (viewport) {
      setReformatSlabThicknessOnViewport(viewport, nextValue)
      viewport.render()
    }
  }

  function runBone3DHotkeyAction(action: ViewportMenuAction) {
    onSelect?.()
    setPanelMode('closed')

    if (action.type === 'tool') {
      const fallbackTool = mode === 'bone' ? 'Rotate3D' : 'WindowLevel'
      setActiveTool(activeTool === action.tool ? fallbackTool : action.tool)
      return
    }

    if (action.type === 'command') {
      sendViewportCommand(action.command as Parameters<typeof sendViewportCommand>[0], viewportKey)
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

  function setOrientationMode(mode: Bone3DDisplayMode) {
    setPanelMode('closed')
    setDisplayMode(mode)
    setActiveTool('Rotate3D')
    const viewport = viewportRef.current
    if (viewport) {
      if (mode === 'volume') {
        applyBonePreset(viewport, { quality, shift, shade, ambient, diffuse, specular, colors: transferColors })
      } else {
        applyReformatPreset(viewport, reformatSlabThickness, mode)
      }
      viewport.render()
    }
  }

  function applyPreset(preset: Bone3DOptions) {
    update3dOptions(preset)
    setPanelMode('closed')
  }

  function applyReformatWindowPreset(voiRange: { lower: number; upper: number }) {
    const viewport = viewportRef.current as (Types.IVolumeViewport & {
      setProperties?: (properties: { voiRange?: { lower: number; upper: number } }) => void
    }) | null
    if (!viewport) return

    viewport.setProperties?.({ voiRange })
    viewport.render()
    setPanelMode('closed')
  }

  function resetCamera() {
    const viewport = viewportRef.current
    if (!viewport) return
    if (displayMode === 'volume') {
      applyBonePreset(viewport, { quality, shift, shade, ambient, diffuse, specular, colors: transferColors })
      applyBone3DCameraPreset(viewport, bone3dCameraPresets.A)
    } else {
      applyReformatPreset(viewport, reformatSlabThickness, displayMode)
    }
    viewport.render()
  }

  function startModifierGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (!event.ctrlKey && !event.shiftKey)) {
      return
    }

    const viewport = viewportRef.current
    const element = elementRef.current
    if (!viewport || !element) {
      return
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
      return
    }

    const rect = element.getBoundingClientRect()
    modifierGestureRef.current = {
      type: 'pan',
      pointerId: event.pointerId,
      lastCanvasPoint: [event.clientX - rect.left, event.clientY - rect.top],
    }
  }

  function updateModifierGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = modifierGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return
    }

    const viewport = viewportRef.current
    const element = elementRef.current
    if (!viewport || !element) {
      return
    }

    event.stopPropagation()

    if (gesture.type === 'zoom') {
      const deltaY = gesture.startY - event.clientY
      const nextZoom = Math.min(Math.max(gesture.startZoom * Math.exp(deltaY * 0.012), 0.08), 80)
      viewport.setZoom(nextZoom)
      viewport.render()
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
      ...(focalPoint ? { focalPoint: addWorldDelta(focalPoint, delta) } : {}),
      ...(position ? { position: addWorldDelta(position, delta) } : {}),
    })
    viewport.render()
    modifierGestureRef.current = { ...gesture, lastCanvasPoint: currentCanvasPoint }
  }

  function stopModifierGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (modifierGestureRef.current?.pointerId === event.pointerId) {
      modifierGestureRef.current = null
    }
  }

  function handleLiveProbePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (activeTool !== 'Probe' || event.button !== 0) {
      return
    }

    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    liveProbePointerIdRef.current = event.pointerId
    setLiveProbeValue(readLiveProbeValue(event))
  }

  function handleLiveProbePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (activeTool !== 'Probe' || liveProbePointerIdRef.current !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setLiveProbeValue(readLiveProbeValue(event))
  }

  function handleLiveProbePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (liveProbePointerIdRef.current !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    liveProbePointerIdRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setLiveProbeValue(null)
  }

  function handleViewportDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    onSelect?.()
    onToggleViewportFullscreen?.()
    window.requestAnimationFrame(() => viewportRef.current?.render())
  }

  function handleViewportWheel(event: React.WheelEvent<HTMLDivElement>) {
    const viewport = viewportRef.current
    if (!viewport || event.deltaY === 0) {
      return
    }

    event.stopPropagation()
    const direction = event.deltaY > 0 ? 1 : -1

    if (mode === 'oblique' && displayMode !== 'volume') {
      const volumeId = (viewport as Types.IVolumeViewport & { getVolumeId?: () => string }).getVolumeId?.()
      utilities.scroll(viewport, { delta: direction, volumeId })
      return
    }

    const currentZoom = viewport.getZoom()
    const nextZoom = Math.min(Math.max(currentZoom * (direction > 0 ? 0.9 : 1.1), 0.08), 80)
    viewport.setZoom(nextZoom)
    viewport.render()
  }

  function readLiveProbeValue(event: React.PointerEvent<HTMLDivElement>): Bone3DLiveProbeValue | null {
    const viewport = viewportRef.current as (Types.IVolumeViewport & { getImageData?: () => unknown }) | null
    const element = elementRef.current
    if (!viewport || !element) {
      return null
    }

    const rect = element.getBoundingClientRect()
    const canvasPoint: Types.Point2 = [event.clientX - rect.left, event.clientY - rect.top]
    const imageData = viewport.getImageData?.() as {
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
      canvasPoint,
      value: rawValue * slope + intercept,
      unit: 'HU',
    }
  }

  return (
    <div
      className={loading ? 'bone-3d-viewer loading' : 'bone-3d-viewer'}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        onSelect?.()
        event.currentTarget.focus({ preventScroll: true })
      }}
    >
      <div
        className="bone-3d-canvas"
        ref={elementRef}
        onPointerDown={(event) => {
          startModifierGesture(event)
          handleLiveProbePointerDown(event)
        }}
        onPointerMove={(event) => {
          updateModifierGesture(event)
          handleLiveProbePointerMove(event)
        }}
        onPointerUp={(event) => {
          stopModifierGesture(event)
          handleLiveProbePointerUp(event)
        }}
        onPointerCancel={(event) => {
          stopModifierGesture(event)
          handleLiveProbePointerUp(event)
        }}
        onWheel={handleViewportWheel}
        onLostPointerCapture={(event) => {
          stopModifierGesture(event)
          handleLiveProbePointerUp(event)
        }}
        onDoubleClick={handleViewportDoubleClick}
      />
      {liveProbeValue && (
        <div
          className="live-probe-overlay bone-3d-live-probe-overlay"
          style={{ left: liveProbeValue.canvasPoint[0] + 16, top: liveProbeValue.canvasPoint[1] - 10 }}
        >
          <span className="live-probe-value">{liveProbeValue.value.toFixed(1)}</span>
          <span className="live-probe-unit">{liveProbeValue.unit}</span>
        </div>
      )}
      <button className="bone-3d-options-button" type="button" onClick={() => setPanelMode((value) => value === 'closed' ? 'menu' : 'closed')} aria-label="Open 3D display options">
        <Blend size={14} />
      </button>
      {panelMode === 'menu' && (
        <div className="bone-3d-menu">
          <button type="button" onClick={() => setPanelMode('presets')}><span className="bone-3d-menu-icon" />{mode === 'bone' ? 'Bone Presets' : 'Window Presets'}<span>&gt;</span></button>
          <button type="button" onClick={() => setOrientationMode('axial')}><span className="bone-3d-menu-icon" />Axial{displayMode === 'axial' ? <span>*</span> : <span />}</button>
          <button type="button" onClick={() => setOrientationMode('sagittal')}><span className="bone-3d-menu-icon" />Sagittal{displayMode === 'sagittal' ? <span>*</span> : <span />}</button>
          <button type="button" onClick={() => setOrientationMode('coronal')}><span className="bone-3d-menu-icon" />Coronal{displayMode === 'coronal' ? <span>*</span> : <span />}</button>
          <button type="button" onClick={() => setOrientationMode('reformat')}><span className="bone-3d-menu-icon" />Reformat{displayMode === 'reformat' ? <span>*</span> : <span />}</button>
          <button type="button" onClick={() => setOrientationMode('acquisition')}><span className="bone-3d-menu-icon" />Acquisition{displayMode === 'acquisition' ? <span>*</span> : <span />}</button>
          <button type="button" onClick={() => setPanelMode('options')}>Options<span>&gt;</span></button>
        </div>
      )}
      {panelMode === 'options' && (
        <div className="bone-3d-panel">
          <button className="bone-3d-back" type="button" onClick={() => setPanelMode('menu')}>&lt; Back to Display Options</button>
          <strong>{getDisplayModeLabel(displayMode)}</strong>
          <label>Slab mm <input type="range" min="0.5" max="50" step="0.5" value={reformatSlabThickness} onChange={(event) => updateReformatSlabThickness(Number(event.currentTarget.value))} /></label>
          <label>Value <input type="number" min="0.5" max="50" step="0.5" value={reformatSlabThickness} onChange={(event) => updateReformatSlabThickness(Number(event.currentTarget.value))} /></label>
          <button type="button" onClick={resetCamera}>Reset Plane</button>
        </div>
      )}
      {panelMode === 'presets' && (
        <>
          <button className="bone-3d-dismiss-layer" type="button" aria-label="Close rendering presets" onClick={() => setPanelMode('closed')} />
          <div className="bone-3d-preset-modal" role="dialog" aria-modal="true" aria-label="Rendering Presets">
            <div className="bone-3d-preset-header"><strong>{mode === 'bone' ? 'Rendering Presets' : 'Window Presets'}</strong><button type="button" onClick={() => setPanelMode('menu')}>x</button></div>
            {mode === 'bone' ? (
              <>
                <input className="bone-3d-preset-search" value={presetSearch} placeholder="Search all" onChange={(event) => setPresetSearch(event.currentTarget.value)} />
                <div className="bone-3d-preset-list">
                  {renderingPresets.filter((preset) => preset.label.toLowerCase().includes(presetSearch.toLowerCase())).map((preset) => (
                    <button className="bone-3d-preset-row" key={preset.id} type="button" onClick={() => applyPreset(preset)}>{preset.label}</button>
                  ))}
                </div>
              </>
            ) : (
              <div className="bone-3d-preset-list">
                {reformatWindowPresets.map((preset) => {
                  const voiRange = getReformatWindowPreset(preset.id)
                  return (
                    <button className="bone-3d-preset-row" key={preset.id} type="button" onClick={() => voiRange && applyReformatWindowPreset(voiRange)}>{preset.label}</button>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
      {loading && !error && <div className="viewer-loading-indicator" role="status" aria-label={mode === 'bone' ? 'Loading 3D Bone' : 'Loading 3D Oblique'} />}
      {error && <div className="bone-3d-status error">{error}</div>}
    </div>
  )
}

function addOrientationCube(viewport: Types.IVolumeViewport) {
  const renderWindow = (viewport as unknown as { getRenderWindow?: () => { getInteractor: () => unknown } }).getRenderWindow?.()
  const renderer = (viewport as unknown as { getRenderer?: () => unknown }).getRenderer?.()
  const interactor = renderWindow?.getInteractor?.()
  if (!renderer || !interactor) {
    return null
  }

  const cube = vtkAnnotatedCubeActor.newInstance()
  cube.setDefaultStyle({
    text: '',
    fontStyle: 'bold',
    fontFamily: 'Arial',
    fontColor: 'white',
    fontSizeScale: (resolution: number) => resolution / 3.5,
    faceColor: '#1a1a2e',
    edgeThickness: 0.08,
    edgeColor: 'white',
    resolution: 400,
  })
  cube.setXPlusFaceProperty({ text: 'L', faceColor: '#1565c0', fontColor: 'white' })
  cube.setXMinusFaceProperty({ text: 'R', faceColor: '#1565c0', fontColor: 'white' })
  cube.setYPlusFaceProperty({ text: 'P', faceColor: '#2e7d32', fontColor: 'white' })
  cube.setYMinusFaceProperty({ text: 'A', faceColor: '#2e7d32', fontColor: 'white' })
  cube.setZPlusFaceProperty({ text: 'S', faceColor: '#c62828', fontColor: 'white' })
  cube.setZMinusFaceProperty({ text: 'I', faceColor: '#c62828', fontColor: 'white' })

  const widget = vtkOrientationMarkerWidget.newInstance({
    actor: cube,
    interactor,
    parentRenderer: renderer,
    viewportCorner: Corners.BOTTOM_RIGHT,
    viewportSize: 0.18,
    minPixelSize: 72,
    maxPixelSize: 150,
    interactiveRenderer: true,
  } as never)
  widget.setEnabled(true)

  return widget
}

function applyBonePreset(viewport: Types.IVolumeViewport, options: Bone3DOptions) {
  const actor = viewport.getDefaultActor()?.actor as BoneVolumeActor | undefined
  const property = actor?.getProperty?.()
  if (!property) {
    return
  }

  const ofun = vtkPiecewiseFunction.newInstance()
  const shifted = (value: number) => value + options.shift
  ofun.addPoint(-1000, 0)
  ofun.addPoint(shifted(200), 0)
  ofun.addPoint(shifted(400), 0)
  ofun.addPoint(shifted(500), 0.15 * options.quality)
  ofun.addPoint(shifted(700), 0.85 * options.quality)
  ofun.addPoint(shifted(1000), 1 * options.quality)
  property.setScalarOpacity(0, ofun)
  property.setScalarOpacityUnitDistance?.(0, 2.5 - options.quality)

  const ctfun = vtkColorTransferFunction.newInstance()
  const [baseColor, peakColor] = options.colors?.map(hexToRgb) ?? [[0.62, 0.45, 0.32], [1, 1, 0.95]]
  ctfun.addRGBPoint(-1000, 0, 0, 0)
  ctfun.addRGBPoint(400, baseColor[0], baseColor[1], baseColor[2])
  ctfun.addRGBPoint(700, (baseColor[0] + peakColor[0]) / 2, (baseColor[1] + peakColor[1]) / 2, (baseColor[2] + peakColor[2]) / 2)
  ctfun.addRGBPoint(1000, peakColor[0], peakColor[1], peakColor[2])
  ctfun.addRGBPoint(1900, 1, 1, 1)
  property.setRGBTransferFunction(0, ctfun)

  property.setShade?.(options.shade)
  property.setAmbient?.(options.ambient)
  property.setDiffuse?.(options.diffuse)
  property.setSpecular?.(options.specular)
  property.setSpecularPower?.(15)
  property.setInterpolationTypeToLinear?.()
  actor?.getMapper?.()?.setSampleDistance?.(Math.max(0.8, 1.75 - options.quality))
}

function applyReformatPreset(viewport: Types.IVolumeViewport, slabThickness: number, displayMode: Exclude<Bone3DDisplayMode, 'volume'>) {
  const reformatViewport = viewport as Types.IVolumeViewport & {
    setProperties?: (properties: { voiRange?: { lower: number; upper: number }; slabThickness?: number }) => void
    setBlendMode?: (blendMode: number, filterActorUIDs?: string[], immediate?: boolean) => void
    setOrientation?: (orientation: Enums.OrientationAxis, immediate?: boolean) => void
  }
  reformatViewport.setOrientation?.(getReformatOrientationAxis(displayMode), false)
  viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true })
  reformatViewport.setProperties?.({
    voiRange: { lower: -160, upper: 240 },
    slabThickness: normalizeReformatSlabThickness(slabThickness),
  })
  reformatViewport.setBlendMode?.(Enums.BlendModes.COMPOSITE, [], true)
}

function getReformatOrientationAxis(displayMode: Exclude<Bone3DDisplayMode, 'volume'>) {
  if (displayMode === 'sagittal') return Enums.OrientationAxis.SAGITTAL
  if (displayMode === 'coronal') return Enums.OrientationAxis.CORONAL
  if (displayMode === 'acquisition') return Enums.OrientationAxis.ACQUISITION
  return Enums.OrientationAxis.AXIAL
}

function getReformatDisplayMode(displayMode: Bone3DDisplayMode): Exclude<Bone3DDisplayMode, 'volume'> {
  return displayMode === 'volume' ? 'axial' : displayMode
}

function getDisplayModeLabel(displayMode: Bone3DDisplayMode) {
  if (displayMode === 'axial') return 'Axial'
  if (displayMode === 'sagittal') return 'Sagittal'
  if (displayMode === 'coronal') return 'Coronal'
  if (displayMode === 'acquisition') return 'Acquisition'
  if (displayMode === 'reformat') return 'Reformat'
  return 'Volume Rendering'
}

function getReformatWindowPreset(type: string) {
  if (type === 'preset-lung') return { lower: -1350, upper: 150 }
  if (type === 'preset-bone') return { lower: -500, upper: 1500 }
  if (type === 'preset-brain') return { lower: 0, upper: 80 }
  if (type === 'preset-mediastinum') return { lower: -125, upper: 225 }
  if (type === 'preset-soft') return { lower: -160, upper: 240 }

  return null
}

function windowLevelToVoiRange(windowLevel: { windowWidth: number; windowLevel: number }) {
  const width = Math.max(1, windowLevel.windowWidth)
  return {
    lower: windowLevel.windowLevel - width / 2,
    upper: windowLevel.windowLevel + width / 2,
  }
}

function setReformatSlabThicknessOnViewport(viewport: Types.IVolumeViewport, slabThickness: number) {
  const reformatViewport = viewport as Types.IVolumeViewport & {
    setProperties?: (properties: { slabThickness?: number }) => void
  }
  reformatViewport.setProperties?.({ slabThickness: normalizeReformatSlabThickness(slabThickness) })
}

function normalizeReformatSlabThickness(value: number) {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.min(Math.max(value, 0.5), 50)
}

function addWorldDelta(point: Types.Point3, delta: Types.Point3): Types.Point3 {
  return [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]]
}

function isBone3DCameraShortcut(key: string): key is Bone3DCameraShortcut {
  return key === 'A' || key === 'P' || key === 'R' || key === 'L'
}

function applyBone3DCameraPreset(viewport: Types.IVolumeViewport, preset: Bone3DCameraPreset) {
  const internalViewport = viewport as Bone3DViewportInternals
  internalViewport.applyViewOrientation?.(preset, false)
  setBone3DCameraOrientation(viewport, preset)
  viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true })
  setBone3DCameraOrientation(viewport, preset, true)
  queueBone3DCameraOrientation(viewport, preset)
}

function setBone3DCameraOrientation(viewport: Types.IVolumeViewport, preset: Bone3DCameraPreset, storeAsInitialCamera = false) {
  const camera = viewport.getCamera() as Types.ICamera
  const focalPoint = camera.focalPoint ?? getBone3DBoundsCenter(viewport) ?? [0, 0, 0]
  const distance = getBone3DCameraDistance(viewport, camera, focalPoint)
  const cameraToSet: Types.ICamera = {
    ...camera,
    focalPoint,
    position: addWorldDelta(focalPoint, [
      preset.viewPlaneNormal[0] * distance,
      preset.viewPlaneNormal[1] * distance,
      preset.viewPlaneNormal[2] * distance,
    ]),
    viewPlaneNormal: [...preset.viewPlaneNormal] as Types.Point3,
    viewUp: [...preset.viewUp] as Types.Point3,
  }

  viewport.setCamera(cameraToSet, storeAsInitialCamera)
  if (storeAsInitialCamera) {
    ;(viewport as Bone3DViewportInternals).setInitialCamera?.(cameraToSet)
  }
  ;(viewport as Bone3DViewportInternals).getRenderer?.()?.resetCameraClippingRange?.()
  viewport.render()
}

function queueBone3DCameraOrientation(viewport: Types.IVolumeViewport, preset: Bone3DCameraPreset) {
  window.requestAnimationFrame(() => {
    setBone3DCameraOrientation(viewport, preset, true)
    window.requestAnimationFrame(() => setBone3DCameraOrientation(viewport, preset, true))
  })
}

function getBone3DCameraDistance(viewport: Types.IVolumeViewport, camera: Types.ICamera, focalPoint: Types.Point3) {
  const existingDistance = camera.position ? getWorldDistance(camera.position, focalPoint) : 0
  if (Number.isFinite(existingDistance) && existingDistance > 1) {
    return existingDistance
  }

  const bounds = getBone3DBounds(viewport)
  if (!bounds) {
    return 1000
  }

  return Math.max(getBone3DBoundsRadius(bounds) * 10, 100)
}

function getBone3DBoundsCenter(viewport: Types.IVolumeViewport): Types.Point3 | null {
  const bounds = getBone3DBounds(viewport)
  if (!bounds) {
    return null
  }

  return [
    (bounds[0] + bounds[1]) / 2,
    (bounds[2] + bounds[3]) / 2,
    (bounds[4] + bounds[5]) / 2,
  ]
}

function getBone3DBounds(viewport: Types.IVolumeViewport): [number, number, number, number, number, number] | null {
  const bounds = (viewport as Bone3DViewportInternals).getRenderer?.()?.computeVisiblePropBounds?.()
  if (!bounds || bounds.length < 6 || bounds.some((value) => !Number.isFinite(value))) {
    return null
  }

  return bounds.slice(0, 6) as [number, number, number, number, number, number]
}

function getBone3DBoundsRadius(bounds: [number, number, number, number, number, number]) {
  const width = Math.abs(bounds[1] - bounds[0])
  const height = Math.abs(bounds[3] - bounds[2])
  const depth = Math.abs(bounds[5] - bounds[4])
  return Math.sqrt(width * width + height * height + depth * depth) / 2
}

function getWorldDistance(first: Types.Point3, second: Types.Point3) {
  const dx = first[0] - second[0]
  const dy = first[1] - second[1]
  const dz = first[2] - second[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

type BoneVolumeProperty = {
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

type BoneVolumeMapper = {
  setSampleDistance?: (distance: number) => void
}

type BoneVolumeActor = {
  getProperty?: () => BoneVolumeProperty
  getMapper?: () => BoneVolumeMapper
}

type Bone3DOptions = {
  quality: number
  shift: number
  shade: boolean
  ambient: number
  diffuse: number
  specular: number
  colors?: readonly [string, string]
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255) as [number, number, number]
}
