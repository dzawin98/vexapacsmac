import { useEffect, useReducer, useRef, useState } from 'react'
import { Enums, getRenderingEngine, RenderingEngine, setVolumesForViewports, type Types } from '@cornerstonejs/core'
import { Enums as ToolEnums, PanTool, ToolGroupManager, TrackballRotateTool, WindowLevelTool, ZoomTool } from '@cornerstonejs/tools'
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction'
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction'
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor'
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget'
import { Corners } from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget/Constants'
import { Blend } from 'lucide-react'
import type { SeriesSummary } from '../../dicomweb/types'
import { initializeCornerstone } from '../cornerstone/initCornerstone'
import { acquireSharedSeriesVolume, releaseSharedSeriesVolume } from '../cornerstone/volumeCache'
import { useViewerStore } from '../viewerStore'

type Volume3DStatus = { loading: boolean; error: string }
type Bone3DPanelMode = 'closed' | 'menu' | 'options' | 'presets'
type Bone3DRenderMode = 'oblique' | 'bone'
type Bone3DDisplayMode = 'volume' | 'axial' | 'sagittal' | 'coronal' | 'reformat' | 'acquisition'

const renderingPresets = [
  { id: 'ct-aaa', label: 'CT-AAA', quality: 0.72, shift: -70, shade: true, ambient: 0.16, diffuse: 0.82, specular: 0.2, colors: ['#c8c1a4', '#fff7c7'] },
  { id: 'ct-aaa2', label: 'CT-AAA2', quality: 0.78, shift: -30, shade: true, ambient: 0.2, diffuse: 0.88, specular: 0.25, colors: ['#cdbb72', '#fff2a8'] },
  { id: 'ct-bone', label: 'CT-Bone', quality: 0.7, shift: 0, shade: true, ambient: 0.12, diffuse: 0.9, specular: 0.28, colors: ['#6f4c39', '#f8f2df'] },
  { id: 'ct-bones', label: 'CT-Bones', quality: 0.9, shift: 80, shade: true, ambient: 0.1, diffuse: 0.95, specular: 0.38, colors: ['#d64b1f', '#fff0d7'] },
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

function statusReducer(_state: Volume3DStatus, action: { type: 'loading' } | { type: 'done' } | { type: 'error'; error: string }): Volume3DStatus {
  switch (action.type) {
    case 'loading': return { loading: true, error: '' }
    case 'done': return { loading: false, error: '' }
    case 'error': return { loading: false, error: action.error }
  }
}

export function Bone3DViewer({ series, viewportKey = '0', mode = 'oblique', onSelect }: { series: SeriesSummary; viewportKey?: string; mode?: Bone3DRenderMode; onSelect?: () => void }) {
  const viewportId = `ct-bone-3d-viewport-${viewportKey}`
  const engineId = `ct-bone-3d-engine-${viewportKey}`
  const toolGroupId = `ct-bone-3d-tools-${viewportKey}`
  const elementRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<Types.IVolumeViewport | null>(null)
  const toolGroupRef = useRef<ReturnType<typeof ToolGroupManager.createToolGroup>>(null)
  const orientationWidgetRef = useRef<{ setEnabled: (enabled: boolean) => void; delete?: () => void } | null>(null)
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
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const activeTool = useViewerStore((state) => state.activeTool)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)

  useEffect(() => {
    setDisplayMode(mode === 'bone' ? 'volume' : 'axial')
    setPanelMode('closed')
  }, [mode, series.studyInstanceUid, series.seriesInstanceUid])

  useEffect(() => {
    const element = elementRef.current
    if (!element) {
      return
    }

    initializeCornerstone()
    dispatchStatus({ type: 'loading' })
    setLoadingMessage(mode === 'bone'
      ? `Loading 3D bone volume (${series.instanceCount} images)...`
      : `Loading 3D oblique volume (${series.instanceCount} images)...`)
    setErrorMessage('')

    let cancelled = false
    let renderingEngine: RenderingEngine | null = null

    async function setup3D() {
      try {
        const { volumeId, instances } = await acquireSharedSeriesVolume(series, 'bone3d', engineId)
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
            orientation: mode === 'bone' ? undefined : getReformatOrientationAxis(getReformatDisplayMode(displayMode)),
          },
        })

        await setVolumesForViewports(renderingEngine, [{ volumeId, blendMode: Enums.BlendModes.COMPOSITE }], [viewportId], true)
        const viewport = renderingEngine.getViewport(viewportId) as Types.IVolumeViewport
        viewportRef.current = viewport
        if (mode === 'bone') {
          applyBonePreset(viewport, { quality, shift, shade, ambient, diffuse, specular, colors: transferColors })
          viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true })
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
          toolGroup.setToolPassive(WindowLevelTool.toolName, { removeAllBindings: true })
          toolGroup.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
          toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] })
          toolGroup.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }] })
          toolGroupRef.current = toolGroup
        }

        dispatchStatus({ type: 'done' })
        setLoadingMessage('')
      } catch (setupError) {
        if (!cancelled) {
          const fallbackMessage = mode === 'bone' ? 'Failed to load 3D bone volume' : 'Failed to load 3D oblique volume'
          const message = setupError instanceof Error ? setupError.message : fallbackMessage
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
      releaseSharedSeriesVolume(series, 'bone3d', engineId)
      viewportRef.current = null
      setLoadingMessage('')
      setErrorMessage('')
    }
  }, [engineId, mode, series.studyInstanceUid, series.seriesInstanceUid, series.instanceCount, setErrorMessage, setLoadingMessage, toolGroupId, viewportId])

  useEffect(() => {
    setActiveTool('Rotate3D')
  }, [setActiveTool])

  useEffect(() => {
    if (mode === 'oblique' && activeTool === 'CycleOrthogonalPlanes' && displayMode !== 'reformat') {
      setDisplayMode('reformat')
      setActiveTool('Rotate3D')
    }
  }, [activeTool, displayMode, mode, setActiveTool])

  useEffect(() => {
    const toolGroup = toolGroupRef.current
    if (!toolGroup) return

    ;[WindowLevelTool.toolName, TrackballRotateTool.toolName, PanTool.toolName, ZoomTool.toolName].forEach((toolName) => {
      toolGroup.setToolPassive(toolName, { removeAllBindings: true })
    })

    if (activeTool === 'WindowLevel') {
      toolGroup.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Zoom') {
      toolGroup.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }, { mouseButton: ToolEnums.MouseBindings.Wheel }] })
    } else if (activeTool === 'Pan') {
      toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
    } else if (activeTool === 'Rotate3D') {
      toolGroup.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
      toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] })
      toolGroup.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }] })
    } else {
      toolGroup.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] })
      toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] })
      toolGroup.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }] })
    }
  }, [activeTool])

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
    if (viewport && mode === 'bone') {
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

  function resetCamera() {
    const viewport = viewportRef.current
    if (!viewport) return
    if (mode === 'bone' || displayMode === 'volume') {
      applyBonePreset(viewport, { quality, shift, shade, ambient, diffuse, specular, colors: transferColors })
      viewport.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true, resetRotation: true })
    } else {
      applyReformatPreset(viewport, reformatSlabThickness, displayMode)
    }
    viewport.render()
  }

  return (
    <div className="bone-3d-viewer" onPointerDownCapture={onSelect}>
      <div className="bone-3d-canvas" ref={elementRef} />
      <button className="bone-3d-options-button" type="button" onClick={() => setPanelMode((value) => value === 'closed' ? 'menu' : 'closed')} aria-label="Open 3D display options">
        <Blend size={14} />
      </button>
      {panelMode === 'menu' && (
        <div className="bone-3d-menu">
          {mode === 'bone' ? (
            <>
              <button type="button" onClick={() => setPanelMode('presets')}><span className="bone-3d-menu-icon" />Rendering Presets<span>&gt;</span></button>
              <button type="button" onClick={resetCamera}><span className="bone-3d-menu-icon" />Reset Camera<span /></button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setOrientationMode('axial')}><span className="bone-3d-menu-icon" />Axial{displayMode === 'axial' ? <span>*</span> : <span />}</button>
              <button type="button" onClick={() => setOrientationMode('sagittal')}><span className="bone-3d-menu-icon" />Sagittal{displayMode === 'sagittal' ? <span>*</span> : <span />}</button>
              <button type="button" onClick={() => setOrientationMode('coronal')}><span className="bone-3d-menu-icon" />Coronal{displayMode === 'coronal' ? <span>*</span> : <span />}</button>
              <button type="button" onClick={() => setOrientationMode('reformat')}><span className="bone-3d-menu-icon" />Reformat{displayMode === 'reformat' ? <span>*</span> : <span />}</button>
              <button type="button" onClick={() => setOrientationMode('acquisition')}><span className="bone-3d-menu-icon" />Acquisition{displayMode === 'acquisition' ? <span>*</span> : <span />}</button>
              <button type="button" onClick={() => setPanelMode('options')}>Options<span>&gt;</span></button>
            </>
          )}
        </div>
      )}
      {mode === 'oblique' && panelMode === 'options' && (
        <div className="bone-3d-panel">
          <button className="bone-3d-back" type="button" onClick={() => setPanelMode('menu')}>&lt; Back to Display Options</button>
          <strong>{getDisplayModeLabel(displayMode)}</strong>
          <label>Slab mm <input type="range" min="0.5" max="50" step="0.5" value={reformatSlabThickness} onChange={(event) => updateReformatSlabThickness(Number(event.currentTarget.value))} /></label>
          <label>Value <input type="number" min="0.5" max="50" step="0.5" value={reformatSlabThickness} onChange={(event) => updateReformatSlabThickness(Number(event.currentTarget.value))} /></label>
          <button type="button" onClick={resetCamera}>Reset Plane</button>
        </div>
      )}
      {mode === 'bone' && panelMode === 'presets' && (
        <>
          <button className="bone-3d-dismiss-layer" type="button" aria-label="Close rendering presets" onClick={() => setPanelMode('closed')} />
          <div className="bone-3d-preset-modal" role="dialog" aria-modal="true" aria-label="Rendering Presets">
            <div className="bone-3d-preset-header"><strong>Rendering Presets</strong><button type="button" onClick={() => setPanelMode('menu')}>x</button></div>
            <input className="bone-3d-preset-search" value={presetSearch} placeholder="Search all" onChange={(event) => setPresetSearch(event.currentTarget.value)} />
            <div className="bone-3d-preset-list">
              {renderingPresets.filter((preset) => preset.label.toLowerCase().includes(presetSearch.toLowerCase())).map((preset) => (
                <button className="bone-3d-preset-row" key={preset.id} type="button" onClick={() => applyPreset(preset)}>{preset.label}</button>
              ))}
            </div>
          </div>
        </>
      )}
      {(loading || error) && <div className={error ? 'bone-3d-status error' : 'bone-3d-status'}>{error || (mode === 'bone' ? 'Loading 3D Bone...' : 'Loading 3D Oblique...')}</div>}
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
  const actor = viewport.getDefaultActor()?.actor as { getProperty?: () => BoneVolumeProperty } | undefined
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
