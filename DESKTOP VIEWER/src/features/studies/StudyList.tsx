import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AlertTriangle, ChevronDown, Layers3, Loader2, RotateCcw } from 'lucide-react'
import { canRenderSeriesThumbnail, filterRenderableImageSeries, generateFirstFrameThumbnail, generateSeriesThumbnail, getSeriesPresentationId, invalidateDicomWebCaches, isImageSeriesCandidate, listSeries, prefetchSeriesInstances, searchStudies } from '../dicomweb/client'
import type { SeriesSummary, StudySummary } from '../dicomweb/types'
import { useViewerStore, type ViewportLayout } from '../viewer/viewerStore'
import { appUrl } from '../../config/appBase'
import { useAuthStore, useCurrentUser } from '../auth/authStore'
import { filterAccessibleSeries, getEffectiveSeriesPolicy } from '../auth/seriesPolicy'

const THUMBNAIL_OBSERVER_OPTIONS = { rootMargin: '400px' }
let sharedThumbnailObserver: IntersectionObserver | null = null

function getThumbnailObserver(): IntersectionObserver {
  if (!sharedThumbnailObserver) {
    sharedThumbnailObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const element = entry.target as HTMLElement
          const callback = (element as unknown as Record<string, unknown>).__thumbnailObserveCb as (() => void) | undefined
          if (callback) {
            callback()
            sharedThumbnailObserver?.unobserve(element)
          }
        }
      }
    }, THUMBNAIL_OBSERVER_OPTIONS)
  }
  return sharedThumbnailObserver
}

const defaultStudyPanelWidth = 360

const SeriesThumbnail = memo(function SeriesThumbnail({
  series,
  active = false,
  draggable = false,
  onClick,
  onDragStart,
}: {
  series: SeriesSummary
  active?: boolean
  draggable?: boolean
  onClick: (event: React.MouseEvent) => void
  onDragStart?: (event: React.DragEvent) => void
}) {
  const seriesUid = getSeriesPresentationId(series)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [thumbnailVisible, setThumbnailVisible] = useState(false)
  const containerRef = useRef<HTMLButtonElement>(null)
  const canRenderThumbnail = canRenderSeriesThumbnail(series)

  useEffect(() => {
    let cancelled = false
    let observerUnsubscribed = false
    const container = containerRef.current
    const startThumbnailRender = () => {
      if (!canRenderThumbnail) return
      if (cancelled || observerUnsubscribed) return

      generateFirstFrameThumbnail(series).then((fastUrl) => {
        if (cancelled || !fastUrl) return
        setThumbnail(fastUrl)
        requestAnimationFrame(() => {
          if (!cancelled) setThumbnailVisible(true)
        })
      })

      if (import.meta.env.VITE_HEAVY_THUMBNAILS_ENABLED === 'true') {
        generateSeriesThumbnail(series, 160).then((fullUrl) => {
          if (cancelled || !fullUrl) return
          setThumbnail(fullUrl)
          requestAnimationFrame(() => {
            if (!cancelled) setThumbnailVisible(true)
          })
        })
      }
    }

    if (container) {
      const observer = getThumbnailObserver()
      ;(container as unknown as Record<string, unknown>).__thumbnailObserveCb = startThumbnailRender
      observer.observe(container)
    } else {
      startThumbnailRender()
    }

    return () => {
      cancelled = true
      observerUnsubscribed = true
      if (container) {
        sharedThumbnailObserver?.unobserve(container)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesUid])

  return (
    <button
      ref={containerRef}
      className={active ? 'series-thumb-card active' : 'series-thumb-card'}
      draggable={draggable}
      type="button"
      title={series.seriesDescription}
      onClick={onClick}
      onDragStart={onDragStart}
    >
      <div className="series-thumb-image">
        <span className="series-thumb-badge">{series.instanceCount}</span>
        {!thumbnailVisible ? (
          <div className="thumb-placeholder">
            <Layers3 size={18} />
          </div>
        ) : (
          <img src={thumbnail!} alt={series.seriesDescription} className="thumb-fade-in" />
        )}
      </div>
      <div className="series-thumb-info">
        <span className="series-thumb-desc">{series.seriesDescription}</span>
        <span className="series-thumb-count">{series.instanceCount} img</span>
      </div>
    </button>
  )
})

const studyColorPalette = ['#facc15', '#ef4444', '#3b82f6', '#22c55e', '#f97316', '#a855f7', '#06b6d4', '#f472b6']

function getStudyColor(index: number) {
  return studyColorPalette[index % studyColorPalette.length]
}

function assignStudyColors(currentColors: Record<string, string>, studyUids: string[]) {
  const nextColors = { ...currentColors }

  studyUids.forEach((studyUid) => {
    if (!nextColors[studyUid]) {
      const usedColors = new Set(Object.values(nextColors))
      const availableColor = studyColorPalette.find((color) => !usedColors.has(color))
      nextColors[studyUid] = availableColor ?? getStudyColor(Object.keys(nextColors).length)
    }
  })

  return nextColors
}

function decorateSeriesWithStudy(series: SeriesSummary, study: StudySummary, studyColor: string): SeriesSummary {
  return {
    ...series,
    studyColor: studyColor || undefined,
    studyDate: study.studyDate,
    studyModalities: study.modalities,
  }
}

function isVisibleImageSeries(series: SeriesSummary) {
  return series.modality?.toUpperCase() !== 'PR'
}

function isSupportedNonImageSeries(series: SeriesSummary) {
  return ['SR', 'PR', 'ECG', 'SEG'].includes(series.modality?.toUpperCase() ?? '')
}

function sortVisibleSeries(series: SeriesSummary[], policy = {}) {
  return filterAccessibleSeries(series.filter(isVisibleImageSeries), policy).sort((a, b) => b.instanceCount - a.instanceCount)
}

export function StudyList({ deepLinkMode = false, onCloseWorklist }: { deepLinkMode?: boolean; onCloseWorklist?: () => void }) {
  const activeStudy = useViewerStore((state) => state.activeStudy)
  const activeSeries = useViewerStore((state) => state.activeSeries)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const setActiveStudy = useViewerStore((state) => state.setActiveStudy)
  const setActiveSeries = useViewerStore((state) => state.setActiveSeries)
  const setActiveSeriesBatch = useViewerStore((state) => state.setActiveSeriesBatch)
  const setViewportLayout = useViewerStore((state) => state.setViewportLayout)
  const setViewerErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const currentRoles = useAuthStore((state) => state.currentRoles)
  const seriesPolicy = useMemo(() => getEffectiveSeriesPolicy(currentRoles), [currentRoles])
  const [selectedStudyUid, setSelectedStudyUid] = useState('')
  const [expandedStudyUid, setExpandedStudyUid] = useState('')
  const [studies, setStudies] = useState<StudySummary[]>([])
  const [seriesByStudy, setSeriesByStudy] = useState<Record<string, SeriesSummary[]>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    if (deepLinkMode) {
      return
    }

    let cancelled = false

    async function loadStudies() {
      setLoading(true)
      setError('')
      try {
        const result = await searchStudies()
        if (!cancelled) {
          setStudies(result)
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to load studies')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadStudies()

    return () => {
      cancelled = true
    }
  }, [deepLinkMode, refreshToken])

  useEffect(() => {
    function refreshStudies() {
      invalidateDicomWebCaches()
      setRefreshToken((token) => token + 1)
    }

    window.addEventListener('vexa-viewer-studies-refresh', refreshStudies)
    return () => window.removeEventListener('vexa-viewer-studies-refresh', refreshStudies)
  }, [])

  useEffect(() => {
    if (!deepLinkMode || !activeStudy) {
      return
    }

    let cancelled = false

    async function loadActiveStudySeries() {
      setLoading(true)
      setError('')
      setSelectedStudyUid(activeStudy.studyInstanceUid)
      setExpandedStudyUid(activeStudy.studyInstanceUid)

      try {
        const [series, allStudies] = await Promise.all([
          listSeries(activeStudy.studyInstanceUid).then((series) => sortVisibleSeries(series, seriesPolicy)),
          hasPermission('study.view_related_history') ? searchStudies().catch(() => [] as StudySummary[]) : Promise.resolve([] as StudySummary[]),
        ])
        if (!cancelled) {
          const relatedStudies = (hasPermission('study.view_related_history') ? allStudies : [])
            .filter((study) => isSamePatientStudy(study, activeStudy))
            .sort((a, b) => (b.studyDate || '').localeCompare(a.studyDate || ''))
          const mergedStudies = mergeStudies(activeStudy, relatedStudies)
          const relatedSeriesEntries = await Promise.all(
            mergedStudies.map(async (study) => {
              if (study.studyInstanceUid === activeStudy.studyInstanceUid) {
                return [study.studyInstanceUid, series] as const
              }

              try {
                const studySeries = sortVisibleSeries(await listSeries(study.studyInstanceUid), seriesPolicy)
                return [study.studyInstanceUid, studySeries] as const
              } catch {
                return [study.studyInstanceUid, []] as const
              }
            }),
          )
          const nextSeriesByStudy = Object.fromEntries(relatedSeriesEntries) as Record<string, SeriesSummary[]>
          setStudies(mergedStudies.filter((study) => nextSeriesByStudy[study.studyInstanceUid]?.length > 0))
          setSeriesByStudy({
            ...nextSeriesByStudy,
          })
          prefetchSeriesInstances(Object.values(nextSeriesByStudy).flat(), 2)
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to load study series')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadActiveStudySeries()

    return () => {
      cancelled = true
    }
  }, [activeStudy, deepLinkMode, hasPermission, seriesPolicy])

  async function toggleStudy(study: StudySummary) {
    setSelectedStudyUid(study.studyInstanceUid)
    setExpandedStudyUid((value) => (value === study.studyInstanceUid ? '' : study.studyInstanceUid))
    if (!seriesByStudy[study.studyInstanceUid]?.length) {
      const series = sortVisibleSeries(await listSeries(study.studyInstanceUid), seriesPolicy)
      setSeriesByStudy((value) => ({ ...value, [study.studyInstanceUid]: series }))
      prefetchSeriesInstances(series, 2)
    }
  }

  const lastSeriesClickRef = useRef<{ seriesInstanceUid: string; time: number }>({ seriesInstanceUid: '', time: 0 })

  function handleSeriesClick(event: React.MouseEvent, study: StudySummary, series: SeriesSummary) {
    event.stopPropagation()
    const now = Date.now()
    const presentationId = getSeriesPresentationId(series)
    const isSecondClick = lastSeriesClickRef.current.seriesInstanceUid === presentationId && now - lastSeriesClickRef.current.time < 650

    setSelectedStudyUid(study.studyInstanceUid)
    setExpandedStudyUid(study.studyInstanceUid)

    if (isSecondClick) {
      void openSeries(study, series)
      lastSeriesClickRef.current = { seriesInstanceUid: '', time: 0 }
      return
    }

    lastSeriesClickRef.current = { seriesInstanceUid: presentationId, time: now }
  }

  function isScoutSeries(series: SeriesSummary): boolean {
    const modality = (series.modality ?? '').toUpperCase()
    if (modality !== 'CT' && modality !== 'MR') return false

    const desc = (series.seriesDescription ?? '').toLowerCase()
    if (desc.includes('topo') || desc.includes('scano') || desc.includes('surview')) return true

    return series.instanceCount <= 3
  }

  function getLayoutForSeriesCount(count: number): ViewportLayout {
    if (count <= 1) return '1x1'
    if (count === 2) return '1x2'
    if (count <= 4) return '2x2'
    if (count <= 6) return '3x2'
    return '3x3'
  }

  async function openSeries(study: StudySummary, series: SeriesSummary) {
    setSelectedStudyUid(study.studyInstanceUid)
    setExpandedStudyUid(study.studyInstanceUid)
    if (activeStudy?.studyInstanceUid !== study.studyInstanceUid) {
      setActiveStudy(study)
    }

    if (!isImageSeriesCandidate(series)) {
      if (isSupportedNonImageSeries(series)) {
        setActiveSeries(series, selectedViewportKey)
        onCloseWorklist?.()
      } else {
        setViewerErrorMessage('This series contains no pixel data and cannot be displayed in a viewport.')
      }
      return
    }

    const visibleSeries = await filterRenderableImageSeries(seriesByStudy[study.studyInstanceUid] ?? [])
    if (visibleSeries.length >= 2) {
      openAllSeriesWithList(study, visibleSeries)
      return
    }

    if (!visibleSeries.some((item) => getSeriesPresentationId(item) === getSeriesPresentationId(series))) {
      setViewerErrorMessage('This series contains no pixel data and cannot be displayed in a viewport.')
      return
    }

    setActiveSeries(series, selectedViewportKey)
    onCloseWorklist?.()
  }

  async function openAllSeries(study: StudySummary) {
    const visibleSeries = await filterRenderableImageSeries(seriesByStudy[study.studyInstanceUid] ?? [])

    if (visibleSeries.length === 0) return

    if (visibleSeries.length <= 1) {
      await openSeries(study, visibleSeries[0])
      return
    }

    openAllSeriesWithList(study, visibleSeries)
  }

  function openAllSeriesWithList(study: StudySummary, visibleSeries: SeriesSummary[]) {
    setSelectedStudyUid(study.studyInstanceUid)
    setExpandedStudyUid(study.studyInstanceUid)
    setActiveStudy(study)

    const scouts = visibleSeries.filter((s) => isScoutSeries(s))
    const mainSeries = visibleSeries.filter((s) => !isScoutSeries(s))

    // Main series by instanceCount descending; scouts pushed to the end
    mainSeries.sort((a, b) => b.instanceCount - a.instanceCount)
    const ordered = [...mainSeries, ...scouts]

    const isCtMr = ordered.some((series) => {
      const modality = series.modality?.toUpperCase()
      return modality === 'CT' || modality === 'MR'
    })
    const maxViewports = isCtMr ? 4 : 9
    const layout = isCtMr ? '2x2' : getLayoutForSeriesCount(Math.min(ordered.length, maxViewports))
    const batch: Record<string, SeriesSummary> = {}
    for (let i = 0; i < ordered.length && i < maxViewports; i++) {
      batch[String(i)] = ordered[i]
    }

    setViewportLayout(layout)
    setActiveSeriesBatch(batch, layout)
    onCloseWorklist?.()
  }

  if (loading) {
    return <StatusMessage icon={<Loader2 className="spin" size={18} />} text="Loading studies" />
  }

  if (error) {
    return <StatusMessage icon={<AlertTriangle size={18} />} text={error} />
  }

  if (!studies.length) {
    if (deepLinkMode) {
      return <StatusMessage text="Loading study series..." />
    }

    return <StatusMessage text="Set VITE_DICOMWEB_BASE_URL to load PACS studies." />
  }

  return (
    <>
      <div className="filter-count">{deepLinkMode ? 'Patient Studies' : 'Number Filtered'}: <strong>{deepLinkMode ? studies.length : studies.length}</strong></div>
      {!deepLinkMode && (
        <div className="filter-row">
          <button type="button">Modality <ChevronDown size={18} /></button>
          <button type="button">Date <ChevronDown size={18} /></button>
          <button className="filter-refresh" type="button" aria-label="Refresh studies" onClick={() => setRefreshToken((token) => token + 1)}>
            <RotateCcw size={18} />
          </button>
        </div>
      )}
      <div className="study-list" role="list">
        {studies.map((study) => {
          const studySeries = (seriesByStudy[study.studyInstanceUid] ?? []).filter(isVisibleImageSeries)
          const isExpanded = expandedStudyUid === study.studyInstanceUid

          return (
          <div
            className={`study-card ${activeStudy?.studyInstanceUid === study.studyInstanceUid ? 'active' : ''} ${selectedStudyUid === study.studyInstanceUid ? 'selected' : ''} ${isExpanded ? 'expanded' : ''}`}
            key={study.studyInstanceUid}
            role="button"
            tabIndex={0}
            title="Click to expand · Double-click to open all series in multi-viewports"
            onKeyDown={(event) => event.key === 'Enter' && void toggleStudy(study)}
            onDoubleClick={(event) => {
              const target = event.target as HTMLElement
              if (target.closest('button') || target.closest('.series-thumb-card')) return
              void openAllSeries(study)
            }}
          >
            <button className="study-chevron" type="button" aria-label={isExpanded ? 'Collapse study' : 'Expand study'} onClick={(event) => { event.stopPropagation(); void toggleStudy(study) }}>
              <ChevronDown size={24} />
            </button>
            <span className="study-patient" title={study.patientName}>{study.patientName}</span>
            <span className="study-date">{formatDate(study.studyDate)}</span>
            <span className="study-id">ID: {study.patientId || '-'} Accession: {study.accessionNumber || '-'}</span>
            <span className="study-desc">({study.modalities || 'DICOM'}) {study.studyDescription}</span>
            <span className="study-ref">Referring Physician: -</span>
            {isExpanded && <span className="study-series-grid">
              {studySeries.length ? (
                studySeries.map((series) => (
                  <SeriesThumbnail
                    key={getSeriesPresentationId(series)}
                    series={series}
                    active={Boolean(activeSeries) && getSeriesPresentationId(activeSeries) === getSeriesPresentationId(series)}
                    onClick={(event) => handleSeriesClick(event, study, series)}
                  />
                ))
              ) : (
                <span className="series-mini muted">
                  <span className="series-thumb"><Layers3 size={18} /></span>
                  <span className="series-name">Loading series</span>
                </span>
              )}
            </span>}
          </div>
          )
        })}
      </div>
      <div className="date-format">nexia mobility 1.1</div>
    </>
  )
}

export function StudyHeaderBrowser({ deepLinkMode = false }: { deepLinkMode?: boolean }) {
  const browserRef = useRef<HTMLDivElement>(null)
  const currentUser = useCurrentUser()
  const activeStudy = useViewerStore((state) => state.activeStudy)
  const activeSeries = useViewerStore((state) => state.activeSeries)
  const viewportStacks = useViewerStore((state) => state.viewportStacks)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const setActiveStudy = useViewerStore((state) => state.setActiveStudy)
  const setActiveSeries = useViewerStore((state) => state.setActiveSeries)
  const setStudyColors = useViewerStore((state) => state.setStudyColors)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const currentRoles = useAuthStore((state) => state.currentRoles)
  const seriesPolicy = useMemo(() => getEffectiveSeriesPolicy(currentRoles), [currentRoles])
  const [selectedStudyUid, setSelectedStudyUid] = useState('')
  const [studies, setStudies] = useState<StudySummary[]>([])
  const [seriesByStudy, setSeriesByStudy] = useState<Record<string, SeriesSummary[]>>({})
  const pendingSavedSeriesByStudyRef = useRef<Record<string, SeriesSummary[]>>({})
  const [pinnedStudyUids, setPinnedStudyUids] = useState<string[]>([])
  const [studyColorByUid, setStudyColorByUid] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [studyPanelWidth, setStudyPanelWidth] = useState(defaultStudyPanelWidth)
  const [seriesRefreshToken, setSeriesRefreshToken] = useState(0)
  const [uploadedStudyUids, setUploadedStudyUids] = useState<string[]>([])
  const activeStudyUid = activeStudy?.studyInstanceUid ?? ''
  const activePatientKey = `${activeStudy?.patientId ?? ''}|${activeStudy?.patientName ?? ''}`

  useEffect(() => {
    let cancelled = false

    async function loadHeaderStudies() {
      if (deepLinkMode && !activeStudy) {
        setStudies([])
        setSeriesByStudy({})
        setPinnedStudyUids([])
        setSelectedStudyUid('')
        setLoading(false)
        return
      }

      setLoading(true)
      setError('')

      try {
        const allStudies = deepLinkMode && activeStudy && !hasPermission('study.view_related_history')
          ? []
          : await searchStudies().catch(() => [] as StudySummary[])
        const uploadedStudies = uploadedStudyUids
          .map((studyUid) => allStudies.find((study) => study.studyInstanceUid === studyUid))
          .filter((study): study is StudySummary => Boolean(study))
        const visibleStudies = deepLinkMode && activeStudy
          ? hasPermission('study.view_related_history')
            ? mergeStudies(activeStudy, [...allStudies.filter((study) => isSamePatientStudy(study, activeStudy)), ...uploadedStudies])
            : mergeStudies(activeStudy, uploadedStudies)
          : allStudies.sort((a, b) => (b.studyDate || '').localeCompare(a.studyDate || ''))

        const seededStudies = activeStudy ? mergeStudies(activeStudy, visibleStudies) : visibleStudies

        if (!cancelled) {
          setSeriesByStudy((current) => mergePendingSavedSeries(current, pendingSavedSeriesByStudyRef.current))
          setStudies(seededStudies)
          setPinnedStudyUids((current) => {
            const availableUids = new Set(seededStudies.map((study) => study.studyInstanceUid))
            const keptUids = current.filter((uid) => availableUids.has(uid))
            const seededUids = activeStudy?.studyInstanceUid && availableUids.has(activeStudy.studyInstanceUid)
              ? [activeStudy.studyInstanceUid, ...keptUids]
              : keptUids
            const uniqueUids = [...new Set(seededUids)]

            return uniqueUids.length ? uniqueUids : seededStudies[0] ? [seededStudies[0].studyInstanceUid] : []
          })
          setStudyColorByUid((current) => assignStudyColors(current, seededStudies.map((study) => study.studyInstanceUid)))
          setSelectedStudyUid((current) => {
            if (current && seededStudies.some((study) => study.studyInstanceUid === current)) {
              return current
            }

            return activeStudy?.studyInstanceUid ?? seededStudies[0]?.studyInstanceUid ?? ''
          })
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to load studies')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadHeaderStudies()

    return () => {
      cancelled = true
    }
  }, [activeStudyUid, activePatientKey, deepLinkMode, hasPermission, seriesRefreshToken, uploadedStudyUids])

  useEffect(() => {
    let cancelled = false
    const missingStudyUids = pinnedStudyUids.filter((studyUid) => !seriesByStudy[studyUid])
    if (!missingStudyUids.length) {
      return
    }

    async function loadPinnedSeries() {
      const seriesEntries = await Promise.all(
        missingStudyUids.map(async (studyUid) => {
          try {
            return [studyUid, sortVisibleSeries(await listSeries(studyUid), seriesPolicy)] as const
          } catch {
            return [studyUid, []] as const
          }
        }),
      )

      if (!cancelled) {
        prefetchSeriesInstances(seriesEntries.flatMap(([, series]) => series), 2)
        setSeriesByStudy((current) => mergePendingSavedSeries({
          ...current,
          ...Object.fromEntries(seriesEntries),
        }, pendingSavedSeriesByStudyRef.current))
      }
    }

    void loadPinnedSeries()

    return () => {
      cancelled = true
    }
  }, [pinnedStudyUids, seriesByStudy, seriesPolicy])

  useEffect(() => {
    function refreshSavedSeries(event: Event) {
      const detail = (event as CustomEvent<{ studyInstanceUid?: string; series?: SeriesSummary | SeriesSummary[] }>).detail
      if (!detail?.studyInstanceUid) return
      const incomingSeries = Array.isArray(detail.series) ? detail.series : [detail.series]
      const filtered = incomingSeries.filter((series): series is SeriesSummary => Boolean(
        series?.studyInstanceUid
        && series.seriesInstanceUid
        && isVisibleImageSeries(series),
      ))
      if (!filtered.length) return
      const nextPending = {
        ...pendingSavedSeriesByStudyRef.current,
        [detail.studyInstanceUid]: mergeSeries(pendingSavedSeriesByStudyRef.current[detail.studyInstanceUid] ?? [], filtered),
      }
      pendingSavedSeriesByStudyRef.current = nextPending
      setSeriesByStudy((current) => ({
        ...current,
        [detail.studyInstanceUid]: mergeSeries(current[detail.studyInstanceUid] ?? [], filtered),
      }))
    }

    window.addEventListener('vexa-viewer-series-saved', refreshSavedSeries)
    function refreshStudies(event: Event) {
      const detail = (event as CustomEvent<{ studyInstanceUids?: string[] }>).detail
      const uploadedUids = detail?.studyInstanceUids?.filter(Boolean) ?? []
      if (uploadedUids.length) {
        uploadedUids.forEach((studyUid) => invalidateDicomWebCaches(studyUid))
        setSeriesByStudy((current) => {
          const next = { ...current }
          uploadedUids.forEach((studyUid) => {
            delete next[studyUid]
          })
          return next
        })
      } else {
        invalidateDicomWebCaches()
        setSeriesByStudy({})
      }
      if (uploadedUids.length) {
        setUploadedStudyUids((current) => [...new Set([...uploadedUids, ...current])])
      }
      setSeriesRefreshToken((token) => token + 1)
    }

    window.addEventListener('vexa-viewer-studies-refresh', refreshStudies)
    return () => {
      window.removeEventListener('vexa-viewer-series-saved', refreshSavedSeries)
      window.removeEventListener('vexa-viewer-studies-refresh', refreshStudies)
    }
  }, [seriesPolicy])

  useEffect(() => {
    let cancelled = false

    async function loadLayoutPreferences() {
      if (!currentUser) return
      try {
        const response = await fetch(appUrl('/api/auth/preferences'), { credentials: 'same-origin' })
        const preferences = await response.json() as { layoutPreferences?: { studyPanelWidth?: number } }
        const nextWidth = Number(preferences.layoutPreferences?.studyPanelWidth)
        if (!cancelled && Number.isFinite(nextWidth)) {
          setStudyPanelWidth(Math.min(Math.max(nextWidth, 220), 720))
        }
      } catch {
        if (!cancelled) setStudyPanelWidth(defaultStudyPanelWidth)
      }
    }

    void loadLayoutPreferences()

    function resetLayoutPreferences() {
      setStudyPanelWidth(defaultStudyPanelWidth)
      void saveViewerLayoutPreferences({ studyPanelWidth: defaultStudyPanelWidth })
    }

    window.addEventListener('vexa-viewer-reset-preferences', resetLayoutPreferences)
    return () => {
      cancelled = true
      window.removeEventListener('vexa-viewer-reset-preferences', resetLayoutPreferences)
    }
  }, [currentUser])

  const selectedStudy = studies.find((study) => study.studyInstanceUid === selectedStudyUid) ?? activeStudy ?? studies[0]
  const pinnedStudies = pinnedStudyUids
    .map((uid) => studies.find((study) => study.studyInstanceUid === uid))
    .filter((study): study is StudySummary => Boolean(study))
  const showStudyColors = pinnedStudies.length > 1

  useEffect(() => {
    setStudyColors(studyColorByUid, showStudyColors)
  }, [setStudyColors, showStudyColors, studyColorByUid])

  function openSeries(study: StudySummary, series: SeriesSummary) {
    const nextPinnedStudyUids = pinnedStudyUids.includes(study.studyInstanceUid) ? pinnedStudyUids : [...pinnedStudyUids, study.studyInstanceUid]
    const shouldColorSeries = nextPinnedStudyUids.length > 1
    const nextStudyColorByUid = assignStudyColors(studyColorByUid, nextPinnedStudyUids)
    const studyColor = shouldColorSeries ? nextStudyColorByUid[study.studyInstanceUid] : ''
    setSelectedStudyUid(study.studyInstanceUid)
    setPinnedStudyUids(nextPinnedStudyUids)
    setStudyColorByUid(nextStudyColorByUid)
    if (activeStudy?.studyInstanceUid !== study.studyInstanceUid) {
      setActiveStudy(study)
    }
    setActiveSeries(decorateSeriesWithStudy(series, study, studyColor), selectedViewportKey)
  }

  function selectHeaderStudy(study: StudySummary) {
    setSelectedStudyUid(study.studyInstanceUid)
    setPinnedStudyUids((current) => {
      const nextPinnedStudyUids = current.includes(study.studyInstanceUid) ? current : [...current, study.studyInstanceUid]
      setStudyColorByUid((colors) => assignStudyColors(colors, nextPinnedStudyUids))

      return nextPinnedStudyUids
    })
  }

  function startStudyResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    const containerWidth = browserRef.current?.getBoundingClientRect().width ?? 0
    const startX = event.clientX
    const startWidth = studyPanelWidth
    let nextWidth = startWidth

    function handlePointerMove(moveEvent: PointerEvent) {
      const maxWidth = Math.max(260, containerWidth - 420)
      nextWidth = Math.min(Math.max(startWidth + moveEvent.clientX - startX, 220), maxWidth)
      setStudyPanelWidth(Math.min(Math.max(nextWidth, 220), maxWidth))
    }

    function handlePointerUp() {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      void saveViewerLayoutPreferences({ studyPanelWidth: nextWidth })
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
  }

  return (
    <div
      className="header-study-browser"
      ref={browserRef}
      style={{ gridTemplateColumns: `minmax(13rem, ${studyPanelWidth}px) 0.38rem minmax(0, 1fr)` }}
      aria-label="Study and series browser"
    >
      <section className="header-study-panel" aria-label="Patient studies">
        <div className="header-study-list">
          {loading ? (
            <div className="header-browser-status" role="status" aria-label="Loading studies"><Loader2 className="spin" size={16} /></div>
          ) : error ? (
            <div className="header-browser-status error"><AlertTriangle size={16} />{error}</div>
          ) : studies.length ? studies.map((study) => (
            <button
              className={`${selectedStudy?.studyInstanceUid === study.studyInstanceUid ? 'selected' : ''} ${activeStudy?.studyInstanceUid === study.studyInstanceUid ? 'active' : ''}`}
              key={study.studyInstanceUid}
              type="button"
              title={`${study.patientName} - ${study.studyDescription}`}
              onClick={() => selectHeaderStudy(study)}
            >
              <strong>{study.studyDescription || study.modalities || 'DICOM Study'}</strong>
              <small>
                <span>{formatDate(study.studyDate)}</span>
                <span>{study.accessionNumber || 'No accession'}</span>
              </small>
            </button>
          )) : (
            <div className="header-browser-status">No related studies</div>
          )}
        </div>
      </section>
      <button className="header-study-resizer" type="button" aria-label="Resize study list" onPointerDown={startStudyResize} />

      <section className="header-series-panel" aria-label="Study series">
        <div className="header-series-list">
          {pinnedStudies.length ? pinnedStudies.map((study, studyIndex) => {
            const studySeries = (seriesByStudy[study.studyInstanceUid] ?? []).filter(isVisibleImageSeries)
            const studyColor = showStudyColors ? studyColorByUid[study.studyInstanceUid] || getStudyColor(studyIndex) : ''

            return (
              <div className={showStudyColors ? 'header-series-study-group multi' : 'header-series-study-group'} key={study.studyInstanceUid}>
                {showStudyColors && (
                  <div className="header-series-study-divider" style={{ ['--study-accent' as string]: studyColor || '#6b7280' }}>
                    <strong>{study.modalities || 'DICOM'}</strong>
                    <span>{formatDate(study.studyDate)}</span>
                  </div>
                )}
                {studySeries.map((series) => {
                  const decoratedSeries = decorateSeriesWithStudy(series, study, studyColor)

                  return (
                    <SeriesThumbnail
                      key={getSeriesPresentationId(series)}
                      series={decoratedSeries}
                      active={(Boolean(activeSeries) && getSeriesPresentationId(activeSeries!) === getSeriesPresentationId(series)) || Object.values(viewportStacks).some((stack) => getSeriesPresentationId(stack.series) === getSeriesPresentationId(series))}
                      draggable={hasPermission('viewer.series.drag_drop')}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'copy'
                        event.dataTransfer.setData('application/nexia-series', JSON.stringify({ study, series: decoratedSeries }))
                        event.dataTransfer.setData('text/plain', `${series.modality} ${series.seriesDescription}`)
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        void openSeries(study, series)
                      }}
                    />
                  )
                })}
              </div>
            )
          }) : (
            <div className="header-browser-status">Select a study</div>
          )}
        </div>
      </section>
    </div>
  )
}

async function saveViewerLayoutPreferences(layoutPreferences: { headerHeight?: number; studyPanelWidth?: number }) {
  await fetch(appUrl('/api/auth/preferences'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layoutPreferences }),
  }).catch(() => undefined)
}

function formatDate(value: string) {
  if (!value || value.length !== 8) {
    return value || '-'
  }

  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function isSamePatientStudy(study: StudySummary, activeStudy: StudySummary) {
  const activePatientId = activeStudy.patientId?.trim().toLowerCase()
  const studyPatientId = study.patientId?.trim().toLowerCase()

  if (activePatientId && studyPatientId) {
    return activePatientId === studyPatientId
  }

  return study.patientName?.trim().toLowerCase() === activeStudy.patientName?.trim().toLowerCase()
}

function mergeStudies(activeStudy: StudySummary, relatedStudies: StudySummary[]) {
  const seen = new Set<string>()
  const studies = [activeStudy, ...relatedStudies].filter((study) => {
    if (seen.has(study.studyInstanceUid)) {
      return false
    }
    seen.add(study.studyInstanceUid)
    return true
  })

  return studies.sort((a, b) => {
    if (a.studyInstanceUid === activeStudy.studyInstanceUid) return -1
    if (b.studyInstanceUid === activeStudy.studyInstanceUid) return 1
    return (b.studyDate || '').localeCompare(a.studyDate || '')
  })
}

function mergePendingSavedSeries(seriesByStudy: Record<string, SeriesSummary[]>, pendingByStudy: Record<string, SeriesSummary[]>) {
  const merged = { ...seriesByStudy }
  Object.entries(pendingByStudy).forEach(([studyInstanceUid, pendingSeries]) => {
    merged[studyInstanceUid] = mergeSeries(merged[studyInstanceUid] ?? [], pendingSeries)
  })
  return merged
}

function mergeSeries(series: SeriesSummary[], pendingSeries: SeriesSummary[]) {
  const seen = new Set<string>()
  return [...series, ...pendingSeries].filter((item) => {
    const presentationId = getSeriesPresentationId(item)
    if (!isVisibleImageSeries(item) || !item.seriesInstanceUid || seen.has(presentationId)) {
      return false
    }
    seen.add(presentationId)
    return true
  })
}

function StatusMessage({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="status-message">
      {icon}
      <span>{text}</span>
    </div>
  )
}
