import { useMemo } from 'react'
import type { InstanceSummary, SeriesSummary, StudySummary } from '../../dicomweb/types'
import { createVexaSsrStackImageIds } from '../serverMpr/vexaSsrImageLoader'
import { getSeriesDefaultWindowLevel } from '../windowLevelDefaults'
import { DicomViewport } from './DicomViewport'

type ServerStackCornerstoneViewportProps = {
  viewportKey?: string
  study?: StudySummary | null
  series?: SeriesSummary | null
  instances?: InstanceSummary[]
  imageCount?: number
  requestedSopInstanceUid?: string
  isSelected?: boolean
  referenceLinesEnabled?: boolean
  contextMenuEnabled?: boolean
  onToggleOverlay?: () => void
  onOpenTagBrowser?: () => void
  onToggleMpr?: () => void
  onToggle3d?: () => void
  onToggle3dBone?: () => void
  onOpenAmbientTest?: () => void
  onSelect?: () => void
  onToggleViewportFullscreen?: () => void
  onReady?: (viewportKey: string, seriesInstanceUid: string) => void
}

export function ServerStackCornerstoneViewport({
  viewportKey = '0',
  study,
  series,
  instances = [],
  requestedSopInstanceUid = '',
  isSelected = false,
  referenceLinesEnabled = true,
  contextMenuEnabled = true,
  onToggleOverlay,
  onOpenTagBrowser,
  onToggleMpr,
  onToggle3d,
  onToggle3dBone,
  onOpenAmbientTest,
  onSelect,
  onToggleViewportFullscreen,
  onReady,
}: ServerStackCornerstoneViewportProps) {
  const imageIds = useMemo(() => (
    series
      ? createVexaSsrStackImageIds({
        study,
        series,
        instances,
        windowLevel: getSeriesDefaultWindowLevel(series, instances),
      })
      : []
  ), [instances, series, study])
  const initialImageIndex = useMemo(() => {
    if (!requestedSopInstanceUid) return undefined
    const index = instances.findIndex((instance) => instance.sopInstanceUid === requestedSopInstanceUid)
    return index >= 0 ? index : undefined
  }, [instances, requestedSopInstanceUid])

  return (
    <DicomViewport
      viewportKey={viewportKey}
      imageIds={imageIds}
      study={study}
      series={series}
      instances={instances}
      initialImageIndex={initialImageIndex}
      modality={series?.modality ?? ''}
      isSelected={isSelected}
      referenceLinesEnabled={referenceLinesEnabled}
      contextMenuEnabled={contextMenuEnabled}
      disableBackgroundVolumePrepare
      onReady={onReady}
      onToggleOverlay={onToggleOverlay}
      onOpenTagBrowser={onOpenTagBrowser}
      onToggleMpr={onToggleMpr}
      onToggle3d={onToggle3d}
      onToggle3dBone={onToggle3dBone}
      onOpenAmbientTest={onOpenAmbientTest}
      onSelect={onSelect}
      onToggleViewportFullscreen={onToggleViewportFullscreen}
    />
  )
}
