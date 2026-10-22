import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Blend,
  Blinds,
  Box,
  ChevronDown,
  Circle,
  Compass,
  Crosshair,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  HeartPulse,
  Link2,
  Lasso,
  Maximize2,
  Menu,
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
  SunMedium,
  Target,
  TextSearch,
  Type,
  X,
  ZoomIn,
} from 'lucide-react'
import { createWadoRsImageIds, fetchInitialViewportPreviewInstance, getSeriesStructuredReport, getSeriesWaveform, isRenderableImageInstance, listInstances, listSeries, prefetchRenderedPreview, RENDERED_VIEWPORT_PREVIEW_SIZE, registerWadoRsMetadata } from '../dicomweb/client'
import type { DicomJsonDataset, InstanceSummary, SeriesSummary, StructuredReportSummary, WaveformSummary } from '../dicomweb/types'
import { useAuthStore } from '../auth/authStore'
import { getActiveToolPermission, getMenuItemPermission } from '../auth/permissions'
import { filterAccessibleSeries, getEffectiveSeriesPolicy, getSeriesAccessDenyReason } from '../auth/seriesPolicy'
import { DicomViewport } from './components/DicomViewport'
import { Bone3DViewer } from './components/Bone3DViewer'
import { EcgWaveformViewport } from './components/EcgWaveformViewport'
import { MprViewer } from './components/MprViewer'
import { StructuredReportViewport } from './components/StructuredReportViewport'
import { useViewerStore } from './viewerStore'

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
  { id: 'RectangleROI', label: 'Rectangle ROI', icon: RectangleHorizontal },
  { id: 'EllipticalROI', label: 'Ellipse ROI', icon: Circle },
  { id: 'PlanarFreehandROI', label: 'Freehand ROI', icon: Lasso },
]

const utilityTools = [
  { id: 'ReferenceLines', label: 'Reference Line', icon: ScanLine },
  { id: 'Stack3DCursor', label: '3D Cursor', icon: Crosshair },
]

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

const viewportKeysByLayout = {
  '1x1': ['0'],
  '1x2': ['0', '1'],
  '2x1': ['0', '1'],
  '2x2': ['0', '1', '2', '3'],
} as const

type ViewportWaveform = {
  series: SeriesSummary
  waveform: WaveformSummary
}

type ViewportReport = {
  series: SeriesSummary
  report: StructuredReportSummary
}

type Volume3DMode = 'oblique' | 'bone'

export function ViewerShell() {
  const activeStudy = useViewerStore((state) => state.activeStudy)
  const activeSeries = useViewerStore((state) => state.activeSeries)
  const setActiveSeries = useViewerStore((state) => state.setActiveSeries)
  const setInstances = useViewerStore((state) => state.setInstances)
  const activeTool = useViewerStore((state) => state.activeTool)
  const setActiveTool = useViewerStore((state) => state.setActiveTool)
  const referenceLinesEnabled = useViewerStore((state) => state.referenceLinesEnabled)
  const setReferenceLinesEnabled = useViewerStore((state) => state.setReferenceLinesEnabled)
  const viewportLayout = useViewerStore((state) => state.viewportLayout)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const activeSeriesTargetViewportKey = useViewerStore((state) => state.activeSeriesTargetViewportKey)
  const setSelectedViewportKey = useViewerStore((state) => state.setSelectedViewportKey)
  const viewportStacks = useViewerStore((state) => state.viewportStacks)
  const viewportZooms = useViewerStore((state) => state.viewportZooms)
  const viewportSliceIndexes = useViewerStore((state) => state.viewportSliceIndexes)
  const viewportWindowLevels = useViewerStore((state) => state.viewportWindowLevels)
  const setViewportStack = useViewerStore((state) => state.setViewportStack)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const errorMessage = useViewerStore((state) => state.errorMessage)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const currentRoles = useAuthStore((state) => state.currentRoles)
  const seriesPolicy = useMemo(() => getEffectiveSeriesPolicy(currentRoles), [currentRoles])
  const mprMode = useViewerStore((state) => state.mprMode)
  const setMprMode = useViewerStore((state) => state.setMprMode)
  const intelliLink = useViewerStore((state) => state.intelliLink)
  const setIntelliLinkOption = useViewerStore((state) => state.setIntelliLinkOption)
  const setAllIntelliLinkOptions = useViewerStore((state) => state.setAllIntelliLinkOptions)
  const [seriesList, setSeriesList] = useState<SeriesSummary[]>([])
  const [viewportWaveforms, setViewportWaveforms] = useState<Record<string, ViewportWaveform>>({})
  const [viewportReports, setViewportReports] = useState<Record<string, ViewportReport>>({})
  const [viewportPreviewInstances, setViewportPreviewInstances] = useState<Record<string, InstanceSummary>>({})
  const [isSeriesOpen, setIsSeriesOpen] = useState(false)
  const [isTagBrowserOpen, setIsTagBrowserOpen] = useState(false)
  const [showOverlay, setShowOverlay] = useState(true)
  const [volume3dViewport, setVolume3dViewport] = useState<{ key: string; series: SeriesSummary; mode: Volume3DMode } | null>(null)
  const [openMenu, setOpenMenu] = useState<'measure' | 'tools' | 'spatial' | 'preset' | 'intellilink' | null>(null)
  const [dropdownAnchor, setDropdownAnchor] = useState<{ left: number; top: number } | null>(null)
  const ribbonRef = useRef<HTMLDivElement>(null)
  const viewportKeys = viewportKeysByLayout[viewportLayout]
  const selectedStack = viewportStacks[selectedViewportKey]
  const selectedWaveform = viewportWaveforms[selectedViewportKey]
  const selectedReport = viewportReports[selectedViewportKey]
  const selectedModality = selectedWaveform?.series.modality || selectedStack?.series.modality || activeSeries?.modality || ''
  const modalityUpper = selectedModality.toUpperCase()
  const showPreset = ['CT', 'MR'].includes(modalityUpper)
  const isCtSeries = modalityUpper === 'CT'
  const showMprButton = Boolean(activeSeries) && isCtSeries && hasPermission('mpr.open')
  const show3dButton = Boolean(activeSeries) && isCtSeries && hasPermission('mpr.bone_3d.open')
  const volume3dMode = Boolean(volume3dViewport)
  const selectedVolume3dMode = volume3dViewport?.key === selectedViewportKey ? volume3dViewport.mode : null
  const selected3dObliqueMode = selectedVolume3dMode === 'oblique'
  const activeMeasurementTool = measurementTools.find((tool) => tool.id === activeTool)
  const activeUtilityTool = activeTool === 'Stack3DCursor'
    ? utilityTools[1]
    : referenceLinesEnabled
      ? utilityTools[0]
      : utilityTools.find((tool) => tool.id === activeTool)
  const MeasurementIcon = activeMeasurementTool?.icon ?? Ruler
  const UtilityIcon = activeUtilityTool?.icon ?? Shapes
  const hasIntelliLink = Object.values(intelliLink).some(Boolean)
  const canUseIntelliLink = (selectedStack?.imageIds.length ?? 0) > 1

  useEffect(() => {
    if (!hasPermission(getActiveToolPermission(activeTool))) {
      setActiveTool(hasPermission('tool.window_level.use') ? 'WindowLevel' : 'Scroll')
    }
    if (mprMode && !hasPermission('mpr.open')) {
      setMprMode(false)
    }
  }, [activeTool, hasPermission, mprMode, setActiveTool, setMprMode])

  useEffect(() => {
    setVolume3dViewport(null)
  }, [activeStudy?.studyInstanceUid])

  useEffect(() => {
    if (!activeStudy) {
      return
    }

    const study = activeStudy
    let cancelled = false

    async function loadSeries() {
      try {
        const series = await listSeries(study.studyInstanceUid)
        if (!cancelled) {
          setSeriesList(filterAccessibleSeries(series, seriesPolicy).sort((a, b) => b.instanceCount - a.instanceCount))
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to load series')
        }
      }
    }

    void loadSeries()

    return () => {
      cancelled = true
    }
  }, [activeStudy, seriesPolicy, setErrorMessage])

  useEffect(() => {
    if (!activeSeries) {
      setInstances([], [])
      setViewportWaveforms({})
      setViewportReports({})
      setViewportPreviewInstances({})
      return
    }

    const series = activeSeries
    const targetViewportKey = activeSeriesTargetViewportKey
    let cancelled = false

    async function loadInstances() {
      setLoadingMessage(`Loading ${series.modality || 'DICOM'} series...`)
      setErrorMessage('')
      setViewportPreviewInstances((current) => {
        const next = { ...current }
        delete next[targetViewportKey]
        return next
      })
      setViewportStack(targetViewportKey, { series, instances: [], imageIds: [] })
      try {
        const deniedReason = getSeriesAccessDenyReason(series, seriesPolicy)
        if (deniedReason) {
          if (!cancelled) {
            setInstances([], [])
            setViewportStack(targetViewportKey, { series, instances: [], imageIds: [] })
            setViewportWaveforms((current) => {
              const next = { ...current }
              delete next[targetViewportKey]
              return next
            })
            setViewportReports((current) => {
              const next = { ...current }
              delete next[targetViewportKey]
              return next
            })
            setErrorMessage(deniedReason)
          }
          return
        }

        const previewTask = fetchInitialViewportPreviewInstance(series)
          .then(async (previewInstance) => {
            if (!previewInstance) return
            await prefetchRenderedPreview(previewInstance, {
              rows: RENDERED_VIEWPORT_PREVIEW_SIZE,
              columns: RENDERED_VIEWPORT_PREVIEW_SIZE,
              quality: 60,
            })
            if (!cancelled) {
              setViewportPreviewInstances((current) => ({ ...current, [targetViewportKey]: previewInstance }))
            }
          })
          .catch(() => undefined)

        // Give the small rendered preview a short head start before requesting full raw metadata.
        await Promise.race([
          previewTask,
          new Promise<void>((resolve) => window.setTimeout(resolve, 180)),
        ])

        const allInstances = await listInstances(series)
        const instances = allInstances.filter(isRenderableImageInstance)
        const imageIds = createWadoRsImageIds(instances)
        if (!cancelled) {
          if (!imageIds.length) {
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
              setViewportStack(targetViewportKey, { series, instances: [], imageIds: [] })
              setViewportReports((current) => ({ ...current, [targetViewportKey]: { series, report } }))
              setViewportWaveforms((current) => {
                const next = { ...current }
                delete next[targetViewportKey]

                return next
              })
              setIsSeriesOpen(false)
              return
            }

            setInstances([], [])
            setViewportStack(targetViewportKey, { series, instances: [], imageIds: [] })
            setViewportWaveforms((current) => ({ ...current, [targetViewportKey]: { series, waveform } }))
            setViewportReports((current) => {
              const next = { ...current }
              delete next[targetViewportKey]

              return next
            })
            setIsSeriesOpen(false)
            return
          }
          registerWadoRsMetadata(instances)
          setInstances(instances, imageIds)
          setViewportStack(targetViewportKey, { series, instances, imageIds })
          setViewportWaveforms((current) => {
            const next = { ...current }
            delete next[targetViewportKey]

            return next
          })
          setViewportReports((current) => {
            const next = { ...current }
            delete next[targetViewportKey]

            return next
          })
          setIsSeriesOpen(false)
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
  }, [activeSeries, activeSeriesTargetViewportKey, seriesPolicy, setErrorMessage, setInstances, setLoadingMessage, setViewportStack])

  useEffect(() => {
    function closeMenuOnOutsideClick(event: MouseEvent | TouchEvent) {
      if (!ribbonRef.current?.contains(event.target as Node)) {
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
    if (!hasPermission(getActiveToolPermission(toolId))) {
      return
    }

    if (toolId === 'ReferenceLines') {
      setReferenceLinesEnabled(!referenceLinesEnabled)
      setOpenMenu(null)
      return
    }

    setActiveTool(toolId)
    setOpenMenu(null)
  }

  function toggleMenu(menu: 'measure' | 'tools' | 'spatial' | 'preset' | 'intellilink', button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect()
    setDropdownAnchor({ left: rect.left + rect.width / 2, top: rect.bottom + 8 })
    setOpenMenu((value) => (value === menu ? null : menu))
  }

  const dropdownStyle = dropdownAnchor ? { left: dropdownAnchor.left, top: dropdownAnchor.top } : undefined

  function selectSpatialTool(toolId: string) {
    if (!hasPermission(getMenuItemPermission(toolId))) {
      return
    }

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

  function toggle3dMode(mode: Volume3DMode = 'oblique') {
    if (!hasPermission('mpr.bone_3d.open')) return
    const series = selectedStack?.series ?? activeSeries
    if (!series || series.modality?.toUpperCase() !== 'CT') {
      return
    }

    setMprMode(false)
    setVolume3dViewport((current) => current?.key === selectedViewportKey && current.mode === mode ? null : { key: selectedViewportKey, series, mode })
  }

  return (
    <section className="viewer-shell">
      <div className="patient-strip">
        <div>
          <p className="eyebrow">VEXA MOBILE</p>
          <strong>{activeStudy?.patientName ?? 'No study selected'}</strong>
        </div>
        <span>{activeSeries?.modality ?? 'DICOM'} · {activeSeries?.seriesDescription ?? 'Viewer'}</span>
      </div>

      <div className="viewer-tool-ribbon" aria-label="Viewer tools" ref={ribbonRef}>
          <button className={activeTool === 'Scroll' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" disabled={!hasPermission('tool.navigation.use')} onClick={() => selectTool('Scroll')}>
          <Blinds size={31} />
          <span>Scroll</span>
        </button>
        <button className={activeTool === 'WindowLevel' ? 'ribbon-tool featured active' : 'ribbon-tool featured'} type="button" disabled={!hasPermission('tool.window_level.use')} onClick={() => selectTool('WindowLevel')}>
          <SunMedium size={34} />
          <span>WW/WL</span>
        </button>
        <span className="ribbon-separator" />
        <button className={activeTool === 'Zoom' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" disabled={!hasPermission('tool.navigation.use')} onClick={() => selectTool('Zoom')}>
          <ZoomIn size={33} />
          <span>Zoom</span>
        </button>
        <button className={activeTool === 'Pan' ? 'ribbon-tool active' : 'ribbon-tool'} type="button" disabled={!hasPermission('tool.navigation.use')} onClick={() => selectTool('Pan')}>
          <Move size={31} />
          <span>Pan</span>
        </button>
        <div className="ribbon-menu spatial-ribbon">
          <button className={openMenu === 'spatial' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('spatial', event.currentTarget)}>
            <Maximize2 size={30} />
            <span>Spatial</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'spatial' && <div className="ribbon-dropdown spatial-dropdown" style={dropdownStyle}>
            {spatialTools.map((tool, index) => {
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
        </div>
        <div className="ribbon-menu measure-ribbon">
          <button className={activeMeasurementTool || openMenu === 'measure' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('measure', event.currentTarget)}>
            <MeasurementIcon size={30} />
            <span>{activeMeasurementTool?.label ?? 'Measure'}</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'measure' && <div className="ribbon-dropdown measure-dropdown" style={dropdownStyle}>
            {measurementTools.map((tool) => {
              const Icon = tool.icon
              return (
                <button className={activeTool === tool.id ? 'ribbon-option active' : 'ribbon-option'} key={tool.id} type="button" onClick={() => selectTool(tool.id)}>
                  <Icon size={25} />
                  {tool.label}
                </button>
              )
            })}
          </div>}
        </div>
        <div className="ribbon-context-group" aria-label="Context tools">
          <button
            aria-hidden={!showMprButton}
            className={`${mprMode ? 'ribbon-tool active' : 'ribbon-tool'} ${showMprButton ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!showMprButton}
            tabIndex={showMprButton ? 0 : -1}
            type="button"
            onClick={() => { if (!hasPermission('mpr.open')) return; setVolume3dViewport(null); setMprMode(!mprMode) }}
          >
            <Box size={30} />
            <span>MPR</span>
          </button>
          <button
            aria-hidden={!show3dButton}
            className={`${selectedVolume3dMode === 'oblique' ? 'ribbon-tool active' : 'ribbon-tool'} ${show3dButton ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!show3dButton}
            tabIndex={show3dButton ? 0 : -1}
            type="button"
            onClick={() => toggle3dMode('oblique')}
          >
            <Rotate3d size={30} />
            <span>3D Oblique</span>
          </button>
          <button
            aria-hidden={!show3dButton}
            className={`${selectedVolume3dMode === 'bone' ? 'ribbon-tool active' : 'ribbon-tool'} ${show3dButton ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!show3dButton}
            tabIndex={show3dButton ? 0 : -1}
            type="button"
            onClick={() => toggle3dMode('bone')}
          >
            <Skull size={30} />
            <span>3D Bone</span>
          </button>
          <button
            aria-hidden={!volume3dMode}
            className={`${activeTool === 'Rotate3D' ? 'ribbon-tool active' : 'ribbon-tool'} ${volume3dMode ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!volume3dMode}
            tabIndex={volume3dMode ? 0 : -1}
            type="button"
            onClick={() => selectTool('Rotate3D')}
          >
            <Rotate3d size={30} />
            <span>3D Rotate</span>
          </button>
          <button
            aria-hidden={!mprMode}
            className={`${activeTool === 'Crosshairs' ? 'ribbon-tool active' : 'ribbon-tool'} ${mprMode ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!mprMode}
            tabIndex={mprMode ? 0 : -1}
            type="button"
            onClick={() => selectTool(activeTool === 'Crosshairs' ? 'WindowLevel' : 'Crosshairs')}
          >
            <Plus size={30} />
            <span>Crosshair</span>
          </button>
          <button
            aria-hidden={!selected3dObliqueMode}
            className={`${activeTool === 'CycleOrthogonalPlanes' ? 'ribbon-tool active' : 'ribbon-tool'} ${selected3dObliqueMode ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!selected3dObliqueMode || !hasPermission('mpr.reformat_tools.use')}
            tabIndex={selected3dObliqueMode ? 0 : -1}
            type="button"
            onClick={() => selectTool('CycleOrthogonalPlanes')}
          >
            <Rotate3d size={30} />
            <span>Reformat</span>
          </button>
          <button
            aria-hidden={!mprMode}
            className={`ribbon-tool ${mprMode ? 'ribbon-context-visible' : 'ribbon-context-hidden'}`}
            disabled={!mprMode || !hasPermission('mpr.reformat_tools.use')}
            tabIndex={mprMode ? 0 : -1}
            type="button"
            onClick={() => sendViewportCommand('reset-mpr-free-rotate')}
          >
            <RefreshCw size={30} />
            <span>Reset Oblique</span>
          </button>
        </div>
        {canUseIntelliLink && <div className="ribbon-menu intellilink-ribbon">
          <button className={hasIntelliLink || openMenu === 'intellilink' ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('intellilink', event.currentTarget)}>
            <Link2 size={30} />
            <span>IntelliLink</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'intellilink' && <div className="ribbon-dropdown intellilink-dropdown" style={dropdownStyle}>
            <button className={hasIntelliLink ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => setAllIntelliLinkOptions(!hasIntelliLink)}><Link2 size={23} />All</button>
            <button className={intelliLink.scroll ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => setIntelliLinkOption('scroll', !intelliLink.scroll)}><Blinds size={23} />Scroll</button>
            <button className={intelliLink.windowLevel ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => setIntelliLinkOption('windowLevel', !intelliLink.windowLevel)}><SunMedium size={23} />WW/WL</button>
            <button className={intelliLink.pan ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => setIntelliLinkOption('pan', !intelliLink.pan)}><Move size={23} />Pan</button>
            <button className={intelliLink.zoom ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => setIntelliLinkOption('zoom', !intelliLink.zoom)}><ZoomIn size={23} />Zoom</button>
          </div>}
        </div>}
        <div className="ribbon-menu utility-ribbon">
          <button className={activeUtilityTool ? 'ribbon-tool active has-menu' : 'ribbon-tool has-menu'} type="button" onClick={(event) => toggleMenu('tools', event.currentTarget)}>
            <UtilityIcon size={30} />
            <span>{activeUtilityTool?.label ?? 'Tools'}</span>
            <ChevronDown className="ribbon-chevron" size={15} />
          </button>
          {openMenu === 'tools' && <div className="ribbon-dropdown utility-dropdown" style={dropdownStyle}>
            {utilityTools.map((tool) => {
              const Icon = tool.icon
              return (
                <button className={tool.id === 'ReferenceLines' && referenceLinesEnabled ? 'ribbon-option active' : activeTool === tool.id ? 'ribbon-option active' : 'ribbon-option'} key={tool.id} type="button" onClick={() => selectTool(tool.id)}>
                  <Icon size={25} />
                  {tool.label}
                </button>
              )
            })}
            <button className={showOverlay ? 'ribbon-option active' : 'ribbon-option'} type="button" onClick={() => { setShowOverlay((value) => !value); setOpenMenu(null) }}><Eye size={25} />Image Overlay</button>
            <button className="ribbon-option" type="button" onClick={() => { sendViewportCommand('invert'); setOpenMenu(null) }}><Circle size={25} />Invert</button>
            {hasPermission('dicom_tags.view') && <button className="ribbon-option" type="button" onClick={() => { setIsTagBrowserOpen(true); setOpenMenu(null) }}><TextSearch size={25} />DICOM Tag Browser</button>}
          </div>}
        </div>
        {showPreset && (
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
            </div>}
          </div>
        )}
      </div>

      <div className="viewer-stage">
        {mprMode && activeSeries && activeSeries.modality?.toUpperCase() === 'CT' ? (
          <MprViewer series={activeSeries} />
        ) : (
          <div className={`viewport-grid layout-${viewportLayout}`}>
            {viewportKeys.map((key, index) => {
              const viewportStack = viewportStacks[key]
              const viewportWaveform = viewportWaveforms[key]
              const viewportReport = viewportReports[key]
              const hasWaveform = Boolean(viewportWaveform)
              const hasReport = Boolean(viewportReport)
              const hasImages = !hasWaveform && !hasReport && Boolean(viewportStack?.imageIds.length)
              const imageCount = viewportStack?.imageIds.length ?? 0
              const imageIndex = Math.min((viewportSliceIndexes[key] ?? 0) + 1, imageCount)
              const windowLevel = viewportWindowLevels[key]
              const overlayStudyDescription = activeStudy?.studyDescription || viewportStack?.series.seriesDescription || activeSeries?.seriesDescription || ''
              const overlayModality = viewportStack?.series.modality || activeSeries?.modality || ''
              const isVolume3dTile = volume3dViewport?.key === key

              return (
                <div className={`${selectedViewportKey === key ? 'viewport-tile selected' : 'viewport-tile'}${isVolume3dTile ? ' volume-3d' : ''}`} data-viewport-key={key} key={key}>
                  {isVolume3dTile ? (
                    <Bone3DViewer series={volume3dViewport!.series} viewportKey={key} mode={volume3dViewport!.mode} onSelect={() => setSelectedViewportKey(key)} />
                  ) : hasReport && viewportReport ? (
                    <StructuredReportViewport
                      report={viewportReport.report}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                    />
                  ) : hasWaveform && viewportWaveform ? (
                    <EcgWaveformViewport
                      waveform={viewportWaveform.waveform}
                      isSelected={selectedViewportKey === key}
                      onSelect={() => setSelectedViewportKey(key)}
                    />
                  ) : (
                    <DicomViewport
                      viewportKey={key}
                      imageIds={viewportStack?.imageIds ?? []}
                      instances={viewportStack?.instances ?? []}
                      previewInstance={viewportPreviewInstances[key]}
                      modality={viewportStack?.series.modality ?? ''}
                      isSelected={selectedViewportKey === key}
                      referenceLinesEnabled={referenceLinesEnabled}
                      showEmptyState={index === 0}
                      onSelect={() => setSelectedViewportKey(key)}
                    />
                  )}
                  {showOverlay && !mprMode && hasImages && !isVolume3dTile && (
                    <div className="viewport-overlay top-right">
                      <span>{activeStudy?.patientId || '-'} - {activeStudy?.accessionNumber || '-'}</span>
                      <span>{activeStudy?.patientName || 'VEXA MOBILE'}</span>
                      <span>{formatOverlayStudyDate(activeStudy?.studyDate)}{overlayStudyDescription ? ` - ${overlayStudyDescription}` : ''}{overlayModality ? ` - ${overlayModality}` : ''}</span>
                    </div>
                  )}
                  {showOverlay && !mprMode && hasImages && (
                    <div className="viewport-overlay bottom-right viewport-image-info">
                      <span>W : {formatOverlayNumber(windowLevel?.windowWidth)} / L : {formatOverlayNumber(windowLevel?.windowLevel)}</span>
                      <span>{imageIndex} / {imageCount}</span>
                    </div>
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
        )}
        {errorMessage && (
          <div className="viewer-status error">
            <AlertTriangle size={18} />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      <aside className={isSeriesOpen ? 'series-drawer open' : 'series-drawer'}>
        <p className="eyebrow">Series</p>
        {(activeStudy ? seriesList : []).map((series) => (
          <button
            className={series.seriesInstanceUid === (selectedStack?.series.seriesInstanceUid ?? selectedWaveform?.series.seriesInstanceUid ?? selectedReport?.series.seriesInstanceUid) ? 'series-pill active' : 'series-pill'}
            key={series.seriesInstanceUid}
            type="button"
            onClick={() => setActiveSeries(series, selectedViewportKey)}
            onDoubleClick={() => setActiveSeries(series, selectedViewportKey)}
          >
            <span>{series.modality}</span>
            <strong>{series.seriesDescription}</strong>
          </button>
        ))}
      </aside>

      <div className="tool-strip" aria-label="Series tools">
        <button className="series-tool" type="button" aria-label="Open series" onClick={() => setIsSeriesOpen((value) => !value)}>
          <Menu size={18} />
          Series
        </button>
      </div>
      {isTagBrowserOpen && <DicomTagBrowser metadata={getSelectedMetadata(selectedStack, viewportSliceIndexes[selectedViewportKey] ?? 0)} onClose={() => setIsTagBrowserOpen(false)} />}
    </section>
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
  '00081030': 'Study Description',
  '0008103E': 'Series Description',
  '00100010': 'Patient Name',
  '00100020': 'Patient ID',
  '00100030': 'Patient Birth Date',
  '00100040': 'Patient Sex',
  '0020000D': 'Study Instance UID',
  '0020000E': 'Series Instance UID',
  '00200011': 'Series Number',
  '00200013': 'Instance Number',
  '00280002': 'Samples per Pixel',
  '00280004': 'Photometric Interpretation',
  '00280010': 'Rows',
  '00280011': 'Columns',
  '00280030': 'Pixel Spacing',
  '00281050': 'Window Center',
  '00281051': 'Window Width',
  '00281052': 'Rescale Intercept',
  '00281053': 'Rescale Slope',
  '0040A040': 'Value Type',
  '0040A043': 'Concept Name Code Sequence',
  '0040A160': 'Text Value',
  '0040A730': 'Content Sequence',
}

function formatOverlayStudyDate(studyDate?: string) {
  if (!studyDate) {
    return '-'
  }

  const normalizedDate = studyDate.replace(/\D/g, '')
  if (normalizedDate.length === 8) {
    return `${normalizedDate.slice(6, 8)}/${normalizedDate.slice(4, 6)}/${normalizedDate.slice(0, 4)}`
  }

  return studyDate
}

function formatOverlayNumber(value?: number) {
  if (!Number.isFinite(value)) {
    return '-'
  }

  return String(Math.round(value as number))
}
