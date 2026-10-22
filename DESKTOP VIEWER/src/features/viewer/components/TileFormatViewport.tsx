import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { createRenderedImageUrl, isRenderableImageInstance, warmRenderedStackCache } from '../../dicomweb/client'
import type { DicomJsonDataset, InstanceSummary, SeriesSummary, StudySummary } from '../../dicomweb/types'
import { getTileFormatLabel, type TileFormat } from './tileFormat'

type TileFormatViewportProps = {
  instances: InstanceSummary[]
  study?: StudySummary | null
  series: SeriesSummary | null
  tileFormat: TileFormat
  activeSliceIndex: number
  windowLevel?: { windowWidth: number; windowLevel: number }
  showOverlay?: boolean
  isSelected?: boolean
  onSelect?: () => void
  onSelectSlice: (sliceIndex: number) => void
  onOpenSliceFullscreen?: (sliceIndex: number) => void
  onToggleViewportFullscreen?: () => void
}

const tileColumnsByCount: Record<number, number> = {
  1: 1,
  2: 2,
  4: 2,
  6: 3,
  9: 3,
  12: 4,
  20: 5,
}

const tilePreviewEdgeByCount: Record<number, number> = {
  1: 1024,
  2: 768,
  4: 512,
  6: 420,
  9: 360,
  12: 300,
  20: 240,
}

export function TileFormatViewport({
  instances,
  study,
  series,
  tileFormat,
  activeSliceIndex,
  windowLevel,
  showOverlay = true,
  isSelected = false,
  onSelect,
  onSelectSlice,
  onOpenSliceFullscreen,
  onToggleViewportFullscreen,
}: TileFormatViewportProps) {
  const tileCount = resolveTileCount(tileFormat, instances.length)
  const columns = tileColumnsByCount[tileCount] ?? 1
  const rows = Math.max(1, Math.ceil(tileCount / columns))
  const maxStartIndex = Math.max(0, instances.length - tileCount)
  const [manualStartIndex, setManualStartIndex] = useState(() => getCenteredTileStart(activeSliceIndex, tileCount, maxStartIndex))
  const [displayedStartIndex, setDisplayedStartIndex] = useState(() => getCenteredTileStart(activeSliceIndex, tileCount, maxStartIndex))
  const wheelDeltaRef = useRef(0)
  const tileTransitionGenerationRef = useRef(0)
  const clampedManualStart = clampIndex(manualStartIndex, maxStartIndex)
  const safeActiveSliceIndex = clampIndex(activeSliceIndex, Math.max(0, instances.length - 1))
  const startIndex = safeActiveSliceIndex >= clampedManualStart && safeActiveSliceIndex < clampedManualStart + tileCount
    ? clampedManualStart
    : getCenteredTileStart(safeActiveSliceIndex, tileCount, maxStartIndex)

  const moveFilm = useCallback((direction: -1 | 1) => {
    const nextStart = clampIndex(startIndex + direction * columns, maxStartIndex)
    if (nextStart === startIndex) return
    setManualStartIndex(nextStart)
    onSelectSlice(clampIndex(nextStart + Math.floor(tileCount / 2), Math.max(0, instances.length - 1)))
  }, [columns, instances.length, maxStartIndex, onSelectSlice, startIndex, tileCount])

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!instances.length || event.deltaY === 0) return
    event.preventDefault()
    wheelDeltaRef.current += event.deltaY
    if (Math.abs(wheelDeltaRef.current) < 28) return
    const direction: -1 | 1 = wheelDeltaRef.current > 0 ? 1 : -1
    wheelDeltaRef.current = 0
    moveFilm(direction)
  }

  const previewEdge = tilePreviewEdgeByCount[tileCount] ?? 320
  const total = instances.length
  const safeWindow = windowLevel && windowLevel.windowWidth > 0
    ? windowLevel
    : undefined
  const safeDisplayedStartIndex = clampIndex(displayedStartIndex, maxStartIndex)
  const endIndex = Math.min(total, safeDisplayedStartIndex + tileCount)

  useEffect(() => {
    const generation = tileTransitionGenerationRef.current + 1
    tileTransitionGenerationRef.current = generation
    const warmAbortController = new AbortController()
    const targetInstances = instances.slice(startIndex, startIndex + tileCount)
    if (!targetInstances.length) {
      setDisplayedStartIndex(startIndex)
      return
    }

    const displayedInstanceUids = new Set(
      instances
        .slice(safeDisplayedStartIndex, safeDisplayedStartIndex + tileCount)
        .map((instance) => instance.sopInstanceUid),
    )
    const newTargetUrls = targetInstances
      .filter((instance) => !displayedInstanceUids.has(instance.sopInstanceUid))
      .map((instance) => createTilePreviewUrl(instance, previewEdge, safeWindow))

    const transitionTimer = window.setTimeout(() => {
      const warmRadius = Math.min(32, Math.ceil(tileCount / 2) + columns)
      const warmMaxFrames = Math.min(48, tileCount + columns * 2)
      const targetCenterIndex = clampIndex(startIndex + Math.floor(tileCount / 2), Math.max(0, instances.length - 1))

      void warmRenderedStackCache(instances, targetCenterIndex, {
        radius: warmRadius,
        maxFrames: warmMaxFrames,
        rows: previewEdge,
        columns: previewEdge,
        quality: 72,
        ...(safeWindow
          ? { windowCenter: safeWindow.windowLevel, windowWidth: safeWindow.windowWidth }
          : {}),
      }, warmAbortController.signal)
        .then(() => Promise.all(newTargetUrls.map(preloadImageUrl)))
        .then(() => {
        if (tileTransitionGenerationRef.current !== generation) return
        setDisplayedStartIndex(startIndex)

        const movingForward = startIndex >= safeDisplayedStartIndex
        const prefetchStart = movingForward
          ? startIndex + tileCount
          : Math.max(0, startIndex - columns)
        instances
          .slice(prefetchStart, prefetchStart + columns)
          .map((instance) => createTilePreviewUrl(instance, previewEdge, safeWindow))
          .forEach((url) => { void preloadImageUrl(url) })
        })
    }, 45)

    return () => {
      window.clearTimeout(transitionTimer)
      warmAbortController.abort()
      if (tileTransitionGenerationRef.current === generation) {
        tileTransitionGenerationRef.current += 1
      }
    }
  }, [columns, instances, maxStartIndex, previewEdge, safeDisplayedStartIndex, safeWindow?.windowLevel, safeWindow?.windowWidth, startIndex, tileCount])

  const visibleTiles = useMemo(() => (
    Array.from({ length: Math.min(tileCount, Math.max(0, instances.length - safeDisplayedStartIndex)) }, (_, offset) => {
      const sliceIndex = safeDisplayedStartIndex + offset
      return { instance: instances[sliceIndex], sliceIndex, offset }
    })
  ), [instances, safeDisplayedStartIndex, tileCount])

  return (
    <div
      className={isSelected ? 'tile-format-viewport selected' : 'tile-format-viewport'}
      onDoubleClick={() => onToggleViewportFullscreen?.()}
      onPointerDown={() => onSelect?.()}
      onWheel={handleWheel}
      aria-label={`Tile format ${getTileFormatLabel(tileFormat)}`}
    >
      <div
        className="tile-format-grid"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {visibleTiles.map(({ instance, sliceIndex, offset }) => (
          <button
            className={sliceIndex === activeSliceIndex ? 'tile-format-frame active' : 'tile-format-frame'}
            type="button"
            key={`tile-position-${offset}`}
            onClick={(event) => {
              event.stopPropagation()
              onSelect?.()
              onSelectSlice(sliceIndex)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              onOpenSliceFullscreen?.(sliceIndex)
            }}
            title={`Image ${sliceIndex + 1} of ${total}`}
          >
            <TilePreview
              key={`${instance.sopInstanceUid}-${previewEdge}-${safeWindow?.windowWidth ?? 'auto'}-${safeWindow?.windowLevel ?? 'auto'}`}
              instance={instance}
              edge={previewEdge}
              windowLevel={safeWindow}
            />
            {showOverlay && (
              <TileOverlay
                instance={instance}
                study={study}
                series={series}
                imageIndex={sliceIndex + 1}
                imageCount={total}
                windowLevel={safeWindow}
                compact={tileCount >= 12}
              />
            )}
          </button>
        ))}
      </div>

      <div className="tile-format-navigator" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" title="Previous tile row" aria-label="Previous tile row" onClick={() => moveFilm(-1)} disabled={startIndex <= 0}>
          <ChevronLeft size={13} />
        </button>
        <span>{safeDisplayedStartIndex + 1}-{endIndex} / {total}</span>
        <button type="button" title="Next tile row" aria-label="Next tile row" onClick={() => moveFilm(1)} disabled={startIndex >= maxStartIndex}>
          <ChevronRight size={13} />
        </button>
      </div>

      {series?.seriesDescription && <span className="tile-format-series">{series.seriesDescription}</span>}
    </div>
  )
}

function TilePreview({
  instance,
  edge,
  windowLevel,
}: {
  instance: InstanceSummary
  edge: number
  windowLevel?: { windowWidth: number; windowLevel: number }
}) {
  const [failed, setFailed] = useState(false)
  const imageUrl = useMemo(() => createTilePreviewUrl(instance, edge, windowLevel), [edge, instance, windowLevel])

  if (failed || !isRenderableImageInstance(instance)) {
    return <span className="tile-format-unavailable">No image</span>
  }

  return <img src={imageUrl} alt="" draggable={false} onError={() => setFailed(true)} />
}

function createTilePreviewUrl(
  instance: InstanceSummary,
  edge: number,
  windowLevel?: { windowWidth: number; windowLevel: number },
) {
  return createRenderedImageUrl(instance, {
    rows: edge,
    columns: edge,
    quality: 72,
    ...(windowLevel ? { windowCenter: windowLevel.windowLevel, windowWidth: windowLevel.windowWidth } : {}),
  })
}

function preloadImageUrl(url: string) {
  return new Promise<void>((resolve) => {
    const image = new Image()
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = url
  })
}

function TileOverlay({
  instance,
  study,
  series,
  imageIndex,
  imageCount,
  windowLevel,
  compact,
}: {
  instance: InstanceSummary
  study?: StudySummary | null
  series: SeriesSummary | null
  imageIndex: number
  imageCount: number
  windowLevel?: { windowWidth: number; windowLevel: number }
  compact: boolean
}) {
  const metadata = instance.metadata
  const modality = (readDicomString(metadata, '00080060') || series?.modality || study?.modalities || '').toUpperCase()
  const patientName = readDicomString(metadata, '00100010') || study?.patientName || ''
  const patientId = readDicomString(metadata, '00100020') || study?.patientId || ''
  const studyDate = formatDicomDate(readDicomString(metadata, '00080020') || study?.studyDate || series?.studyDate || '')
  const studyDescription = readDicomString(metadata, '00081030') || study?.studyDescription || ''
  const seriesDescription = readDicomString(metadata, '0008103E') || series?.seriesDescription || ''
  const instanceNumber = readDicomString(metadata, '00200013') || String(imageIndex)
  const kvp = formatDicomNumber(readDicomString(metadata, '00180060'))
  const milliampere = formatDicomNumber(readDicomString(metadata, '00181151'))
  const sliceLocation = formatDicomNumber(readDicomString(metadata, '00201041'), 1)
  const sliceThickness = formatDicomNumber(readDicomString(metadata, '00180050'), 1)

  const topLeft = compactLines([patientName, compact ? undefined : patientId, compact ? undefined : studyDate])
  const topRight = compactLines([
    compactLine([modality, seriesDescription || studyDescription], ' - '),
    compact ? undefined : seriesDescription && studyDescription ? studyDescription : undefined,
  ])
  const bottomLeft = compactLines([
    compact ? undefined : compactLine([kvp && `KVP: ${kvp}`, milliampere && `mA: ${milliampere}`], ' '),
    `IM: ${instanceNumber} / ${imageCount}`,
  ])
  const bottomRight = compactLines([
    compact ? undefined : compactLine([sliceLocation && `LOC: ${sliceLocation}`, sliceThickness && `THK: ${sliceThickness}`], ' '),
    windowLevel ? `C: ${Math.round(windowLevel.windowLevel)} W: ${Math.round(windowLevel.windowWidth)}` : undefined,
  ])

  return (
    <div className={compact ? 'tile-format-overlay compact' : 'tile-format-overlay'}>
      <TileOverlayCorner className="top-left" lines={topLeft} />
      <TileOverlayCorner className="top-right" lines={topRight} />
      <TileOverlayCorner className="bottom-left" lines={bottomLeft} />
      <TileOverlayCorner className="bottom-right" lines={bottomRight} />
    </div>
  )
}

function TileOverlayCorner({ className, lines }: { className: string; lines: string[] }) {
  if (!lines.length) return null
  return <div className={`tile-format-overlay-corner ${className}`}>{lines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</div>
}

function resolveTileCount(format: TileFormat, imageCount: number) {
  if (format !== 'auto') return Number(format)
  if (imageCount >= 20) return 20
  if (imageCount >= 12) return 12
  if (imageCount >= 9) return 9
  if (imageCount >= 6) return 6
  if (imageCount >= 4) return 4
  if (imageCount >= 2) return 2
  return 1
}

function getCenteredTileStart(activeIndex: number, tileCount: number, maximum: number) {
  return clampIndex(activeIndex - Math.floor(tileCount / 2), maximum)
}

function clampIndex(value: number, maximum: number) {
  return Math.max(0, Math.min(Math.max(0, maximum), Math.floor(value) || 0))
}

function readDicomString(metadata: DicomJsonDataset | undefined, tag: string) {
  const value = metadata?.[tag]?.Value?.[0]
  if (value === undefined || value === null) return ''
  if (typeof value === 'object' && !Array.isArray(value)) {
    return 'Alphabetic' in value ? String(value.Alphabetic).replace(/\^/g, ' ').trim() : ''
  }
  return String(value).replace(/\^/g, ' ').trim()
}

function formatDicomDate(value: string) {
  const normalized = value.replace(/\D/g, '')
  return normalized.length === 8 ? `${normalized.slice(4, 6)}/${normalized.slice(6, 8)}/${normalized.slice(0, 4)}` : value
}

function formatDicomNumber(value: string, precision = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return precision ? number.toFixed(precision) : String(Math.round(number))
}

function compactLines(lines: Array<string | undefined>) {
  return lines.filter((line): line is string => Boolean(line?.trim()))
}

function compactLine(parts: Array<string | undefined>, separator: string) {
  return compactLines(parts).join(separator)
}
