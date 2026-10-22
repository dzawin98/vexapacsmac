import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Layers3, Loader2, RotateCcw } from 'lucide-react'
import { generateFirstFrameThumbnail, generateSeriesThumbnail, invalidateDicomWebCaches, listSeries, searchStudies } from '../dicomweb/client'
import type { SeriesSummary, StudySummary } from '../dicomweb/types'
import { useAuthStore } from '../auth/authStore'
import { filterAccessibleSeries, getEffectiveSeriesPolicy } from '../auth/seriesPolicy'
import { useViewerStore } from '../viewer/viewerStore'

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

const SeriesThumbnail = memo(function SeriesThumbnail({ series, onClick }: { series: SeriesSummary; onClick: (event: React.MouseEvent) => void }) {
  const seriesUid = series.seriesInstanceUid
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [thumbnailVisible, setThumbnailVisible] = useState(false)
  const containerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false

    generateFirstFrameThumbnail(series).then((fastUrl) => {
      if (!cancelled && fastUrl) {
        setThumbnail(fastUrl)
        requestAnimationFrame(() => {
          if (!cancelled) setThumbnailVisible(true)
        })
      }
    })

    let observerUnsubscribed = false
    const container = containerRef.current
    const startHeavyRender = () => {
      if (import.meta.env.VITE_HEAVY_THUMBNAILS_ENABLED !== 'true') return
      if (cancelled || observerUnsubscribed) return
      generateSeriesThumbnail(series, 60).then((fullUrl) => {
        if (!cancelled && fullUrl) {
          setThumbnail(fullUrl)
          requestAnimationFrame(() => {
            if (!cancelled) setThumbnailVisible(true)
          })
        }
      })
    }

    if (container) {
      const observer = getThumbnailObserver()
      ;(container as unknown as Record<string, unknown>).__thumbnailObserveCb = startHeavyRender
      observer.observe(container)
    } else {
      startHeavyRender()
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
    <button ref={containerRef} className="series-thumb-card" type="button" title={`${series.modality} - ${series.seriesDescription}`} onClick={onClick}>
      <div className="series-thumb-image">
        {!thumbnailVisible ? (
          <div className="thumb-placeholder">
            <Layers3 size={18} />
          </div>
        ) : (
          <img src={thumbnail!} alt={series.seriesDescription} className="thumb-fade-in" />
        )}
      </div>
      <div className="series-thumb-info">
        <span className="series-thumb-modality">{series.modality}</span>
        <span className="series-thumb-desc">{series.seriesDescription}</span>
        <span className="series-thumb-count">{series.instanceCount} img</span>
      </div>
    </button>
  )
})

function isVisibleImageSeries(series: SeriesSummary) {
  return series.modality?.toUpperCase() !== 'PR'
}

function sortVisibleSeries(series: SeriesSummary[], policy = {}) {
  return filterAccessibleSeries(series.filter(isVisibleImageSeries), policy).sort((a, b) => b.instanceCount - a.instanceCount)
}

export function StudyList({ deepLinkMode = false, onCloseWorklist }: { deepLinkMode?: boolean; onCloseWorklist?: () => void }) {
  const activeStudy = useViewerStore((state) => state.activeStudy)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const setActiveStudy = useViewerStore((state) => state.setActiveStudy)
  const setActiveSeries = useViewerStore((state) => state.setActiveSeries)
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
      setSeriesByStudy({})
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
          listSeries(activeStudy.studyInstanceUid).then((result) => sortVisibleSeries(result, seriesPolicy)),
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
                const studySeries = await listSeries(study.studyInstanceUid)
                return [study.studyInstanceUid, sortVisibleSeries(studySeries, seriesPolicy)] as const
              } catch {
                return [study.studyInstanceUid, []] as const
              }
            }),
          )
          const nextSeriesByStudy = Object.fromEntries(relatedSeriesEntries)
          setStudies(mergedStudies.filter((study) => nextSeriesByStudy[study.studyInstanceUid]?.length > 0))
          setSeriesByStudy({
            ...nextSeriesByStudy,
          })
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
    }
  }

  const lastSeriesClickRef = useRef<{ seriesInstanceUid: string; time: number }>({ seriesInstanceUid: '', time: 0 })

  function handleSeriesClick(event: React.MouseEvent, study: StudySummary, series: SeriesSummary) {
    event.stopPropagation()
    const now = Date.now()
    const isSecondClick = lastSeriesClickRef.current.seriesInstanceUid === series.seriesInstanceUid && now - lastSeriesClickRef.current.time < 650

    setSelectedStudyUid(study.studyInstanceUid)
    setExpandedStudyUid(study.studyInstanceUid)

    if (isSecondClick) {
      openSeries(study, series)
      lastSeriesClickRef.current = { seriesInstanceUid: '', time: 0 }
      return
    }

    lastSeriesClickRef.current = { seriesInstanceUid: series.seriesInstanceUid, time: now }
  }

  function openSeries(study: StudySummary, series: SeriesSummary) {
    setSelectedStudyUid(study.studyInstanceUid)
    setActiveStudy(study)
    setExpandedStudyUid(study.studyInstanceUid)
    setActiveSeries(series, selectedViewportKey)
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
          <button className="filter-refresh" type="button" aria-label="Refresh studies" onClick={() => {
            invalidateDicomWebCaches()
            setSeriesByStudy({})
            setRefreshToken((token) => token + 1)
          }}>
            <RotateCcw size={18} />
          </button>
        </div>
      )}
      <div className="study-list" role="list">
        {studies.map((study) => {
          const studySeries = seriesByStudy[study.studyInstanceUid] ?? []
          const isExpanded = expandedStudyUid === study.studyInstanceUid

          return (
          <div
            className={`study-card ${activeStudy?.studyInstanceUid === study.studyInstanceUid ? 'active' : ''} ${selectedStudyUid === study.studyInstanceUid ? 'selected' : ''} ${isExpanded ? 'expanded' : ''}`}
            key={study.studyInstanceUid}
            role="button"
            tabIndex={0}
            title="Use arrow to expand series"
            onKeyDown={(event) => event.key === 'Enter' && void toggleStudy(study)}
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
                    key={series.seriesInstanceUid}
                    series={series}
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

function StatusMessage({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="status-message">
      {icon}
      <span>{text}</span>
    </div>
  )
}
