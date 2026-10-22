import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ChevronDown, ChevronRight, Layers3, Maximize2, Minimize2, ScanLine, type LucideIcon } from 'lucide-react'
import type { InstanceSummary, SeriesSummary, StudySummary } from '../../dicomweb/types'
import { createVexaSsrMprImageIds, requestVexaSsrSyncPosition } from '../serverMpr/vexaSsrImageLoader'
import { useViewerStore } from '../viewerStore'
import { getSeriesDefaultWindowLevel } from '../windowLevelDefaults'
import { DicomViewport } from './DicomViewport'

type ServerMprCornerstoneViewportProps = {
  viewportKey?: string
  study?: StudySummary | null
  series?: SeriesSummary | null
  instances?: InstanceSummary[]
  isSelected?: boolean
  referenceLinesEnabled?: boolean
  initialWindowLevel?: { windowWidth: number; windowLevel: number }
  onReady?: (viewportKey: string, seriesInstanceUid: string) => void
  onSelect?: () => void
  onToggleViewportFullscreen?: () => void
}

type Orientation = 'axial' | 'sagittal' | 'coronal'
type Projection = 'normal' | 'mip' | 'minip'
type PlaneId = 'axial' | 'sagittal' | 'coronal' | 'axial-compare'
type NormalizedPoint = { x: number; y: number }

type PlaneDef = {
  id: PlaneId
  orientation: Orientation
  label: string
}

const PLANES: PlaneDef[] = [
  { id: 'axial', orientation: 'axial', label: 'A' },
  { id: 'sagittal', orientation: 'sagittal', label: 'S' },
  { id: 'coronal', orientation: 'coronal', label: 'C' },
  { id: 'axial-compare', orientation: 'axial', label: 'A' },
]

const ORIENTATION_OPTIONS: readonly { id: Orientation; label: string; name: string }[] = [
  { id: 'axial', label: 'A', name: 'Axial' },
  { id: 'sagittal', label: 'S', name: 'Sagittal' },
  { id: 'coronal', label: 'C', name: 'Coronal' },
] as const

const PROJECTION_OPTIONS: readonly { id: Projection; code: string; label: string; title: string; icon: LucideIcon }[] = [
  { id: 'normal', code: 'N', label: 'Normal', title: 'Normal MPR', icon: ScanLine },
  { id: 'mip', code: 'MIP', label: 'MIP', title: 'Maximum Intensity Projection', icon: Maximize2 },
  { id: 'minip', code: 'MinIP', label: 'MinIP', title: 'Minimum Intensity Projection', icon: Minimize2 },
] as const

const THICKNESS_PRESETS = [1, 2, 3, 5] as const

function defaultWindowLevel(
  series?: SeriesSummary | null,
  instances: InstanceSummary[] = [],
  initial?: { windowWidth: number; windowLevel: number },
) {
  if (initial && initial.windowWidth > 0) return initial
  return getSeriesDefaultWindowLevel(series, instances)
}

function initialOrientationState() {
  return Object.fromEntries(PLANES.map((plane) => [plane.id, plane.orientation])) as Record<PlaneId, Orientation>
}

function initialNumberState(value: number) {
  return Object.fromEntries(PLANES.map((plane) => [plane.id, value])) as Record<PlaneId, number>
}

function initialProjectionState() {
  return Object.fromEntries(PLANES.map((plane) => [plane.id, 'normal'])) as Record<PlaneId, Projection>
}

export function ServerMprCornerstoneViewport({
  viewportKey = '0',
  study,
  series,
  instances = [],
  isSelected = false,
  referenceLinesEnabled = true,
  initialWindowLevel,
  onReady,
  onSelect,
  onToggleViewportFullscreen,
}: ServerMprCornerstoneViewportProps) {
  const setMprActiveViewportId = useViewerStore((state) => state.setMprActiveViewportId)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const setStack3dCursor = useViewerStore((state) => state.setStack3dCursor)
  const activeTool = useViewerStore((state) => state.activeTool)
  const syncPositionSeqRef = useRef(0)
  const windowLevel = defaultWindowLevel(series, instances, initialWindowLevel)
  const [expandedControls, setExpandedControls] = useState<Record<PlaneId, boolean>>(() => ({
    axial: false,
    sagittal: true,
    coronal: false,
    'axial-compare': false,
  }))
  const [planeOrientations, setPlaneOrientations] = useState<Record<PlaneId, Orientation>>(initialOrientationState)
  const [slabThicknesses, setSlabThicknesses] = useState<Record<PlaneId, number>>(() => initialNumberState(1))
  const [slabInputs, setSlabInputs] = useState<Record<PlaneId, string>>(() => Object.fromEntries(PLANES.map((plane) => [plane.id, '1'])) as Record<PlaneId, string>)
  const [projections, setProjections] = useState<Record<PlaneId, Projection>>(initialProjectionState)
  const [mprToolPoint, setMprToolPoint] = useState<NormalizedPoint>({ x: 0.5, y: 0.5 })

  const planeImageIds = useMemo(() => {
    if (!series) return {}
    return Object.fromEntries(PLANES.map((plane) => {
      const orientation = planeOrientations[plane.id] ?? plane.orientation
      return [
        plane.id,
        createVexaSsrMprImageIds({
          study,
          series,
          instances,
          orientation,
          windowLevel,
          slabThickness: slabThicknesses[plane.id] ?? 1,
          projection: projections[plane.id] ?? 'normal',
        }),
      ]
    })) as Record<PlaneId, string[]>
  }, [
    instances,
    planeOrientations,
    projections,
    series,
    slabThicknesses,
    study,
    windowLevel.windowLevel,
    windowLevel.windowWidth,
  ])

  const mprReferenceLinesEnabled = referenceLinesEnabled || activeTool === 'Crosshairs' || activeTool === 'Stack3DCursor'
  const showCrosshairOverlay = false
  const show3dCursorOverlay = false

  const imageIdsByOrientation = useMemo(() => {
    const result: Record<Orientation, string[]> = {
      axial: [],
      sagittal: [],
      coronal: [],
    }
    PLANES.forEach((plane) => {
      const orientation = planeOrientations[plane.id] ?? plane.orientation
      if (result[orientation].length < 1) {
        result[orientation] = planeImageIds[plane.id] ?? []
      }
    })
    return result
  }, [planeImageIds, planeOrientations])

  const handleSsrMprSyncPosition = useCallback(async (
    worldPoint: [number, number, number],
    sourceViewportKey: string,
    sourceImageId?: string | null,
  ) => {
    const fallbackImageId = sourceImageId
      ?? imageIdsByOrientation.axial[0]
      ?? imageIdsByOrientation.sagittal[0]
      ?? imageIdsByOrientation.coronal[0]
    if (!fallbackImageId) return

    const sequence = ++syncPositionSeqRef.current
    try {
      const result = await requestVexaSsrSyncPosition({
        sourceImageId: fallbackImageId,
        worldPoint,
        imageIdsByOrientation,
        priority: 'high',
      })
      if (sequence !== syncPositionSeqRef.current) return

      PLANES.forEach((plane) => {
        const orientation = planeOrientations[plane.id] ?? plane.orientation
        const syncedPlane = result.planes[orientation]
        if (!syncedPlane) return
        sendViewportCommand('set-slice', `${viewportKey}-mpr-${plane.id}`, {
          sliceIndex: syncedPlane.imageIndex,
          sourceViewportKey,
        })
      })

      window.requestAnimationFrame(() => {
        if (sequence !== syncPositionSeqRef.current) return
        const confirmed = result.position
        setStack3dCursor(sourceViewportKey, [confirmed[0], confirmed[1], confirmed[2]])
      })
    } catch (error) {
      console.warn('[VEXA SSR MPR] sync position failed', error)
    }
  }, [imageIdsByOrientation, planeOrientations, sendViewportCommand, setStack3dCursor, viewportKey])

  return (
    <div
      className={`ssr-mpr-viewport ${isSelected ? 'selected' : ''}`}
      onDoubleClick={() => {
        onSelect?.()
        onToggleViewportFullscreen?.()
      }}
    >
      <div className="ssr-mpr-grid">
        {PLANES.map((plane) => {
          const childViewportKey = `${viewportKey}-mpr-${plane.id}`
          const orientation = planeOrientations[plane.id] ?? plane.orientation
          const orientationOption = getOrientationOption(orientation)
          const projection = projections[plane.id] ?? 'normal'
          const projectionOption = getProjectionOption(projection)
          const ProjectionIcon = projectionOption.icon
          const controlsExpanded = Boolean(expandedControls[plane.id])
          return (
            <div
              className="ssr-mpr-plane"
              key={plane.id}
              onPointerDownCapture={(event) => {
                setMprActiveViewportId(`nexia-stack-viewport-${childViewportKey}`, viewportKey)
                if (activeTool !== 'Crosshairs' && activeTool !== 'Stack3DCursor') return
                setMprToolPoint(readNormalizedPoint(event.currentTarget, event.clientX, event.clientY))
              }}
              onPointerMoveCapture={(event) => {
                if (activeTool !== 'Stack3DCursor' || event.buttons !== 1) return
                setMprToolPoint(readNormalizedPoint(event.currentTarget, event.clientX, event.clientY))
              }}
              onClick={() => {
                onSelect?.()
                setMprActiveViewportId(`nexia-stack-viewport-${childViewportKey}`, viewportKey)
              }}
            >
              <DicomViewport
                viewportKey={childViewportKey}
                imageIds={planeImageIds[plane.id] ?? []}
                study={study}
                series={series}
                instances={instances}
                modality={series?.modality ?? ''}
                isSelected={isSelected}
                referenceLinesEnabled={mprReferenceLinesEnabled}
                contextMenuEnabled
                onSelect={onSelect}
                onToggleViewportFullscreen={onToggleViewportFullscreen}
                onReady={onReady}
                disableBackgroundVolumePrepare
                ssrPrefetchProfile="mpr"
                onSsrMprSyncPosition={handleSsrMprSyncPosition}
                ssrSyncPositionManaged
              />
              {showCrosshairOverlay && <SsrMprCrosshairOverlay point={mprToolPoint} />}
              {show3dCursorOverlay && <SsrMpr3dCursorOverlay point={mprToolPoint} />}
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
                  onClick={(event) => {
                    event.stopPropagation()
                    setExpandedControls((current) => ({ ...current, [plane.id]: !current[plane.id] }))
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  {controlsExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                </button>
                {controlsExpanded && (
                  <>
                    <button
                      className="mpr-label mpr-control-trigger"
                      type="button"
                      title={`Plane ${orientationOption.name}. Click to cycle orientation.`}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        cycleOrientation(plane.id, setPlaneOrientations)
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <span className="mpr-plane-symbol" aria-hidden="true">{orientationOption.label}</span>
                      <span className="mpr-control-copy">
                        <small>Plane</small>
                        <strong>{orientationOption.name}</strong>
                      </span>
                      <ChevronRight className="mpr-control-chevron" size={13} aria-hidden="true" />
                    </button>
                    <details className="mpr-thickness-menu">
                      <summary title="Slice thickness">
                        <Layers3 size={15} aria-hidden="true" />
                        <span className="mpr-control-copy">
                          <small>Thickness</small>
                          <strong>{formatThicknessLabel(slabThicknesses[plane.id] ?? 1)}</strong>
                        </span>
                        <ChevronDown className="mpr-control-chevron" size={12} aria-hidden="true" />
                      </summary>
                      <div className="mpr-thickness-popover">
                        <div className="mpr-popover-heading"><Layers3 size={14} />Slice thickness</div>
                        <div className="mpr-thickness-presets">
                          {THICKNESS_PRESETS.map((value) => (
                            <button
                              className={slabThicknesses[plane.id] === value ? 'active' : ''}
                              key={value}
                              type="button"
                              onClick={(event) => {
                                event.currentTarget.closest('details')?.removeAttribute('open')
                                setThickness(plane.id, value, setSlabThicknesses, setSlabInputs)
                              }}
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
                            value={slabInputs[plane.id] ?? ''}
                            onChange={(event) => setSlabInputs((current) => ({ ...current, [plane.id]: event.target.value }))}
                            onBlur={() => setThicknessFromInput(plane.id, slabInputs[plane.id], setSlabThicknesses, setSlabInputs)}
                          />
                        </label>
                        <button
                          className="manual-apply"
                          type="button"
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open')
                            setThicknessFromInput(plane.id, slabInputs[plane.id], setSlabThicknesses, setSlabInputs)
                          }}
                        >
                          Apply
                        </button>
                      </div>
                    </details>
                    <details className="mpr-blend-menu">
                      <summary title={projectionOption.title}>
                        <ProjectionIcon size={15} aria-hidden="true" />
                        <span className="mpr-control-copy">
                          <small>Projection</small>
                          <strong>{projectionOption.label}</strong>
                        </span>
                        <ChevronDown className="mpr-control-chevron" size={12} aria-hidden="true" />
                      </summary>
                      <div className="mpr-blend-popover">
                        <div className="mpr-popover-heading"><ScanLine size={14} />Projection mode</div>
                        {PROJECTION_OPTIONS.map((option) => (
                          <button
                            className={projection === option.id ? 'active' : ''}
                            key={option.id}
                            title={option.title}
                            type="button"
                            onClick={(event) => {
                              event.currentTarget.closest('details')?.removeAttribute('open')
                              setProjections((current) => ({ ...current, [plane.id]: option.id }))
                            }}
                          >
                            <option.icon size={15} aria-hidden="true" />
                            <span><strong>{option.label}</strong><small>{option.title}</small></span>
                          </button>
                        ))}
                      </div>
                    </details>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function readNormalizedPoint(element: HTMLElement, clientX: number, clientY: number): NormalizedPoint {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 1 || rect.height <= 1) return { x: 0.5, y: 0.5 }
  return {
    x: Math.min(0.995, Math.max(0.005, (clientX - rect.left) / rect.width)),
    y: Math.min(0.995, Math.max(0.005, (clientY - rect.top) / rect.height)),
  }
}

function SsrMprCrosshairOverlay({ point }: { point: NormalizedPoint }) {
  const x = point.x * 100
  const y = point.y * 100
  return (
    <svg className="ssr-mpr-crosshair" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={y} x2="100" y2={y} />
      <line x1={x} y1="0" x2={x} y2="100" />
      <circle cx={x} cy={y} r="0.85" />
    </svg>
  )
}

function SsrMpr3dCursorOverlay({ point }: { point: NormalizedPoint }) {
  const x = point.x * 100
  const y = point.y * 100
  return (
    <svg className="mpr-3d-cursor-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line className="mpr-3d-cursor-line" x1={x - 2.2} y1={y} x2={x - 0.8} y2={y} />
      <line className="mpr-3d-cursor-line" x1={x + 0.8} y1={y} x2={x + 2.2} y2={y} />
      <line className="mpr-3d-cursor-line" x1={x} y1={y - 3.8} x2={x} y2={y - 1.4} />
      <line className="mpr-3d-cursor-line" x1={x} y1={y + 1.4} x2={x} y2={y + 3.8} />
      <circle className="mpr-3d-cursor-dot" cx={x} cy={y} r="0.75" />
    </svg>
  )
}

function getOrientationOption(orientation: Orientation) {
  return ORIENTATION_OPTIONS.find((option) => option.id === orientation) ?? ORIENTATION_OPTIONS[0]
}

function getProjectionOption(projection: Projection) {
  return PROJECTION_OPTIONS.find((option) => option.id === projection) ?? PROJECTION_OPTIONS[0]
}

function cycleOrientation(planeId: PlaneId, setPlaneOrientations: Dispatch<SetStateAction<Record<PlaneId, Orientation>>>) {
  setPlaneOrientations((current) => {
    const currentIndex = Math.max(0, ORIENTATION_OPTIONS.findIndex((option) => option.id === current[planeId]))
    const next = ORIENTATION_OPTIONS[(currentIndex + 1) % ORIENTATION_OPTIONS.length]
    return { ...current, [planeId]: next.id }
  })
}

function setThickness(
  planeId: PlaneId,
  value: number,
  setSlabThicknesses: Dispatch<SetStateAction<Record<PlaneId, number>>>,
  setSlabInputs: Dispatch<SetStateAction<Record<PlaneId, string>>>,
) {
  const thickness = normalizeThickness(value)
  setSlabThicknesses((current) => ({ ...current, [planeId]: thickness }))
  setSlabInputs((current) => ({ ...current, [planeId]: formatThicknessInput(thickness) }))
}

function setThicknessFromInput(
  planeId: PlaneId,
  value: string | undefined,
  setSlabThicknesses: Dispatch<SetStateAction<Record<PlaneId, number>>>,
  setSlabInputs: Dispatch<SetStateAction<Record<PlaneId, string>>>,
) {
  setThickness(planeId, Number(value), setSlabThicknesses, setSlabInputs)
}

function normalizeThickness(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(value, 0.1), 50) : 1
}

function formatThicknessLabel(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} mm`
}

function formatThicknessInput(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
