import {
  Cog,
  Menu,
  RefreshCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { eventTarget } from '@cornerstonejs/core'
import { annotation, Enums as ToolEnums } from '@cornerstonejs/tools'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { LoginPage, RequireAuth, RequireServiceAdmin, RequireViewerAccess, ServicePage } from './features/auth/AuthPages'
import { useAuthStore } from './features/auth/authStore'
import { filterAccessibleSeries, getEffectiveSeriesPolicy } from './features/auth/seriesPolicy'
import { StudyList } from './features/studies/StudyList'
import { getStudy, getStudyByAccession, listSeries, generateFirstFrameThumbnail } from './features/dicomweb/client'
import { ViewerShell } from './features/viewer/ViewerShell'
import { useViewerStore } from './features/viewer/viewerStore'
import { buildViewerUrl, type ViewerMode } from './utils/viewerUrl'
import { appUrl } from './config/appBase'

type AppSettings = {
  worklistEnabled: boolean
}

const defaultSettings: AppSettings = {
  worklistEnabled: false,
}

export default function App() {
  useEffect(() => {
    function updateViewportHeight() {
      document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`)
    }

    updateViewportHeight()
    window.addEventListener('resize', updateViewportHeight)
    window.addEventListener('orientationchange', updateViewportHeight)

    return () => {
      window.removeEventListener('resize', updateViewportHeight)
      window.removeEventListener('orientationchange', updateViewportHeight)
    }
  }, [])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/Viewer" element={<RisLaunchRedirect />} />
      {/* Alias: keeps a differently-cased launch path out of the catch-all. */}
      <Route path="/viewer" element={<RisLaunchRedirect />} />
      <Route path="/viewer/Viewer" element={<RisLaunchRedirect />} />
      <Route path="/VIEWER/VIEWER" element={<RisLaunchRedirect />} />
      <Route path="/service" element={<RequireAuth><RequireServiceAdmin><ServicePage /></RequireServiceAdmin></RequireAuth>} />
      <Route path="/" element={<RequireAuth><RequireViewerAccess><ViewerLayout /></RequireViewerAccess></RequireAuth>} />
      <Route path="/view" element={<RequireAuth><RequireViewerAccess><ViewerLayout deepLink /></RequireViewerAccess></RequireAuth>} />
      <Route path="/view/:studyUID" element={<RequireAuth><RequireViewerAccess><ViewerLayout deepLink /></RequireViewerAccess></RequireAuth>} />
      <Route path="/view/:studyUID/series/:seriesUID" element={<RequireAuth><RequireViewerAccess><ViewerLayout deepLink /></RequireViewerAccess></RequireAuth>} />
      <Route path="/study/:studyUID" element={<RequireAuth><RequireViewerAccess><StudyRedirect /></RequireViewerAccess></RequireAuth>} />
      <Route path="/mobile" element={<Navigate to="/view" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

function ViewerLayout({ deepLink = false }: { deepLink?: boolean }) {
  const activeStudy = useViewerStore((state) => state.activeStudy)
  const activeLayout = useViewerStore((state) => state.viewportLayout)
  const setActiveLayout = useViewerStore((state) => state.setViewportLayout)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const setAnnotationCount = useViewerStore((state) => state.setAnnotationCount)
  const [isWorklistOpen, setIsWorklistOpen] = useState(false)
  const [isQaMenuOpen, setIsQaMenuOpen] = useState(false)
  const [isAmbientTestOpen, setIsAmbientTestOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)

  useEffect(() => {
    let cancelled = false

    async function loadSettings() {
      try {
        const response = await fetch(appUrl('/settings.json'), { cache: 'no-store' })
        if (!response.ok) return
        const nextSettings = (await response.json()) as Partial<AppSettings>
        if (!cancelled) {
          setSettings({ ...defaultSettings, ...nextSettings })
        }
      } catch {
        if (!cancelled) {
          setSettings(defaultSettings)
        }
      }
    }

    void loadSettings()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeStudy) return

    sendViewerPresence('active')
    const timer = window.setInterval(() => {
      sendViewerPresence('active')
    }, 10000)

    function markViewerClosed() {
      sendViewerPresence('closed')
    }

    window.addEventListener('pagehide', markViewerClosed)
    window.addEventListener('beforeunload', markViewerClosed)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pagehide', markViewerClosed)
      window.removeEventListener('beforeunload', markViewerClosed)
      sendViewerPresence('closed')
    }
  }, [activeStudy])

  useEffect(() => {
    function updateAnnotationCount() {
      setAnnotationCount(countAnnotations())
    }

    updateAnnotationCount()
    eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_ADDED, updateAnnotationCount)
    eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, updateAnnotationCount)
    eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_REMOVED, updateAnnotationCount)

    return () => {
      eventTarget.removeEventListener(ToolEnums.Events.ANNOTATION_ADDED, updateAnnotationCount)
      eventTarget.removeEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, updateAnnotationCount)
      eventTarget.removeEventListener(ToolEnums.Events.ANNOTATION_REMOVED, updateAnnotationCount)
    }
  }, [setAnnotationCount])

  const canOpenPanel = deepLink || settings.worklistEnabled

  if (!deepLink && !settings.worklistEnabled) {
    return <WorklistDisabledPage />
  }

  return (
    <main className={`app-shell ${isWorklistOpen ? 'worklist-open' : ''}`}>
      {deepLink && <ViewerDeepLinkLoader />}
      <header className="top-bar" aria-label="Diagnostic toolbar">
        <button className="worklist-toggle" type="button" onClick={() => canOpenPanel && setIsWorklistOpen((value) => !value)} aria-label="Toggle worklist" disabled={!canOpenPanel}>
          <Menu size={18} />
        </button>
        <img className="app-logo" src={appUrl('/vexa.png')} alt="VEXA MOBILE" />
        <div className="header-actions" aria-label="Viewer actions">
          {activeStudy && (
            <button className="header-action" type="button" onClick={() => sendViewportCommand('delete-annotation')} aria-label="Delete annotation">
              <Trash2 size={18} />
            </button>
          )}
          <button className="header-action" type="button" onClick={() => sendViewportCommand('reset')} aria-label="Reset view">
            <RefreshCcw size={18} />
          </button>
          <div className="header-menu">
            <button className={isQaMenuOpen ? 'header-action active' : 'header-action'} type="button" onClick={() => setIsQaMenuOpen((value) => !value)} aria-label="Open QA tools">
              <Cog size={18} />
            </button>
            {isQaMenuOpen && (
              <div className="header-dropdown qa-dropdown">
                <span className="qa-menu-label">Tools / QA</span>
                <button
                  type="button"
                  onClick={() => {
                    setIsAmbientTestOpen(true)
                    setIsQaMenuOpen(false)
                  }}
                >
                  Ambient Light Test
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className="workspace">
        <aside className="study-rail" aria-label="Study browser">
          <div className="rail-header">
            <div>
              <p className="eyebrow">PACS</p>
              <h2>{deepLink ? 'Series' : 'Studies'}</h2>
            </div>
            <Search size={18} />
          </div>
          <StudyList deepLinkMode={deepLink} onCloseWorklist={() => setIsWorklistOpen(false)} />
        </aside>
        <button className="drawer-backdrop" type="button" aria-label="Close worklist" onClick={() => setIsWorklistOpen(false)} />

        <ViewerShell />
      </section>

      <footer className="mobile-bottom-controls" aria-label="Mobile viewer controls">
        <MobileSliceSlider />
        <nav className="mobile-dock layout-dock" aria-label="Viewport layout">
          <button className={activeLayout === '1x1' ? 'dock-item active' : 'dock-item'} type="button" onClick={() => setActiveLayout('1x1')}>
            <span className="layout-icon layout-1x1"><i /></span>
            1x1
          </button>
          <button className={activeLayout === '1x2' ? 'dock-item active' : 'dock-item'} type="button" onClick={() => setActiveLayout('1x2')}>
            <span className="layout-icon layout-1x2"><i /><i /></span>
            1x2
          </button>
          <button className={activeLayout === '2x1' ? 'dock-item active' : 'dock-item'} type="button" onClick={() => setActiveLayout('2x1')}>
            <span className="layout-icon layout-2x1"><i /><i /></span>
            2x1
          </button>
          <button className={activeLayout === '2x2' ? 'dock-item active' : 'dock-item'} type="button" onClick={() => setActiveLayout('2x2')}>
            <span className="layout-icon layout-2x2"><i /><i /><i /><i /></span>
            2x2
          </button>
        </nav>
      </footer>

      {!activeStudy && <div className="clinical-status">Ready for DICOMweb configuration</div>}
      {isAmbientTestOpen && <AmbientLightTestModal onClose={() => setIsAmbientTestOpen(false)} />}
    </main>
  )
}

function sendViewerPresence(state: 'active' | 'closed') {
  const payload = JSON.stringify({ state })
  if (navigator.sendBeacon) {
    navigator.sendBeacon(appUrl('/api/auth/viewer-presence'), new Blob([payload], { type: 'application/json' }))
    return
  }

  void fetch(appUrl('/api/auth/viewer-presence'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined)
}

function countAnnotations() {
  const allAnnotations = annotation.state.getAllAnnotations()

  return Object.values(allAnnotations).reduce((total, value) => {
    if (Array.isArray(value)) {
      return total + value.length
    }

    if (value && typeof value === 'object') {
      return total + Object.values(value).reduce((nestedTotal, nestedValue) => nestedTotal + (Array.isArray(nestedValue) ? nestedValue.length : 0), 0)
    }

    return total
  }, 0)
}

function AmbientLightTestModal({ onClose }: { onClose: () => void }) {
  const tileValues = [
    10, 35, 70, 160,
    25, 80, 140, 205,
    55, 125, 190, 230,
    105, 175, 215, 245,
  ]

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="ambient-test" role="dialog" aria-modal="true" aria-labelledby="ambient-test-title">
      <div className="ambient-test-header">
        <strong id="ambient-test-title">Ambient Light Test - TG18 style</strong>
        <button type="button" onClick={onClose} aria-label="Close ambient light test">
          <X size={18} />
          Close
        </button>
      </div>

      <div className="ambient-test-grid" aria-label="TG18 contrast visibility pattern">
        {tileValues.map((value) => {
          const delta = value < 128 ? 8 : -8
          const circleValue = Math.max(0, Math.min(255, value + delta))

          return (
            <div
              className="ambient-test-tile"
              key={value}
              style={{ backgroundColor: `rgb(${value}, ${value}, ${value})` }}
            >
              <span
                className="ambient-test-circle"
                style={{ backgroundColor: `rgb(${circleValue}, ${circleValue}, ${circleValue})` }}
              />
            </div>
          )
        })}
      </div>

      <p className="ambient-test-note">
        Make sure every faint circle is still visible. If any is not visible, dim the room lighting or calibrate the display.
      </p>
    </div>
  )
}

function MobileSliceSlider() {
  const mprMode = useViewerStore((state) => state.mprMode)
  const selectedViewportKey = useViewerStore((state) => state.selectedViewportKey)
  const mprActiveViewportId = useViewerStore((state) => state.mprActiveViewportId)
  const viewportStack = useViewerStore((state) => state.viewportStacks[state.selectedViewportKey])
  const sliceIndex = useViewerStore((state) => state.viewportSliceIndexes[state.selectedViewportKey] ?? 0)
  const mprSliceIndex = useViewerStore((state) => state.mprSliceIndexes[state.mprActiveViewportId] ?? 0)
  const mprSliceCount = useViewerStore((state) => state.mprSliceCounts[state.mprActiveViewportId] ?? 0)
  const sendViewportCommand = useViewerStore((state) => state.sendViewportCommand)
  const sliceCount = viewportStack?.imageIds.length ?? 0

  if (mprMode) {
    if (mprSliceCount < 2) {
      return null
    }

    const clampedMprSliceIndex = Math.min(Math.max(mprSliceIndex, 0), mprSliceCount - 1)

    return (
      <div className="mobile-slice-control">
        <div className="slice-control-header">
          <span>Slice</span>
          <strong>{clampedMprSliceIndex + 1} / {mprSliceCount}</strong>
        </div>
        <input
          aria-label="Scroll MPR slices"
          className="slice-slider"
          max={mprSliceCount - 1}
          min={0}
          type="range"
          value={clampedMprSliceIndex}
          onChange={(event) => sendViewportCommand('set-mpr-slice', mprActiveViewportId, { sliceIndex: Number(event.currentTarget.value) })}
        />
      </div>
    )
  }

  if (sliceCount < 2) {
    return null
  }

  const clampedSliceIndex = Math.min(Math.max(sliceIndex, 0), sliceCount - 1)

  return (
    <div className="mobile-slice-control">
      <div className="slice-control-header">
        <span>Slice</span>
        <strong>{clampedSliceIndex + 1} / {sliceCount}</strong>
      </div>
      <input
        aria-label="Scroll slices"
        className="slice-slider"
        max={sliceCount - 1}
        min={0}
        type="range"
        value={clampedSliceIndex}
        onChange={(event) => sendViewportCommand('set-slice', selectedViewportKey, { sliceIndex: Number(event.currentTarget.value) })}
      />
    </div>
  )
}

function ViewerDeepLinkLoader() {
  const { studyUID: pathStudyUID, seriesUID: pathSeriesUID } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const setActiveStudy = useViewerStore((state) => state.setActiveStudy)
  const setActiveSeries = useViewerStore((state) => state.setActiveSeries)
  const setMprMode = useViewerStore((state) => state.setMprMode)
  const setLoadingMessage = useViewerStore((state) => state.setLoadingMessage)
  const setErrorMessage = useViewerStore((state) => state.setErrorMessage)
  const hasPermission = useAuthStore((state) => state.hasPermission)
  const currentRoles = useAuthStore((state) => state.currentRoles)
  const seriesPolicy = useMemo(() => getEffectiveSeriesPolicy(currentRoles), [currentRoles])
  const search = searchParams.toString()
  const [launchSyncVersion, setLaunchSyncVersion] = useState(0)

  useEffect(() => {
    const channel = createViewerLaunchChannel()
    if (!channel) return

    channel.onmessage = (event) => {
      if (event.data?.type === 'viewer-launch-updated') {
        setLaunchSyncVersion((value) => value + 1)
      }
    }

    return () => {
      channel.close()
    }
  }, [])

  useEffect(() => {
    const query = new URLSearchParams(search)
    const sessionOnlyRoute = !search && !pathStudyUID && !pathSeriesUID

    let cancelled = false

    async function loadViewerFromUrl() {
      setErrorMessage('')
      if (sessionOnlyRoute) {
        setActiveStudy(null)
        setActiveSeries(null)
      }

      try {
        const serverLaunch = await loadServerViewerLaunch()
        const studyUID = pathStudyUID ?? query.get('studyUID') ?? query.get('StudyInstanceUIDs') ?? query.get('StudyInstanceUID') ?? serverLaunch?.studyUID ?? ''
        const seriesUID = pathSeriesUID ?? query.get('seriesUID') ?? query.get('SeriesInstanceUID') ?? serverLaunch?.seriesUID ?? ''
        const accession = query.get('accession') ?? query.get('accessionNumber') ?? serverLaunch?.accession ?? ''
        const patientId = query.get('patientId') ?? serverLaunch?.patientId ?? ''
        const mode = ((query.get('mode') as ViewerMode | null) ?? serverLaunch?.mode ?? 'stack')
        const shouldHideLaunchUrl = Boolean(serverLaunch && sessionOnlyRoute)

        if (!studyUID && !accession) {
          setErrorMessage('StudyInstanceUID or Accession Number is missing from the launch context.')
          return
        }

        setLoadingMessage(studyUID ? `Loading study ${studyUID}...` : `Loading accession ${accession}...`)
        const resolvedStudy = studyUID ? await getStudy(studyUID) : await getStudyByAccession(accession)
        const resolvedStudyUID = studyUID || resolvedStudy?.studyInstanceUid || ''

        if (!resolvedStudyUID) {
          throw new Error('Requested study was not found.')
        }

        const [studyResult, series] = await Promise.all([
          resolvedStudy ? Promise.resolve(resolvedStudy) : getStudy(resolvedStudyUID),
          listSeries(resolvedStudyUID),
        ])

        if (cancelled) return

        const sortedSeries = filterAccessibleSeries(series, seriesPolicy).sort((a, b) => b.instanceCount - a.instanceCount)
        window.dispatchEvent(new CustomEvent('vexa-viewer-series-saved', { detail: { studyInstanceUid: resolvedStudyUID, series: sortedSeries } }))

        if (import.meta.env.VITE_MOBILE_THUMBNAIL_PREFETCH_ENABLED === 'true') {
          sortedSeries.slice(0, 2).forEach((s) => generateFirstFrameThumbnail(s).catch(() => undefined))
        }

        if (!sortedSeries.length) {
          throw new Error('No image series was found for the requested study or this role is restricted.')
        }

        const requestedSeries = seriesUID
          ? sortedSeries.find((item) => item.seriesInstanceUid === seriesUID)
          : null
        const targetSeries = requestedSeries ?? selectInitialImageSeries(sortedSeries)

        if (!targetSeries) {
          throw new Error('The requested image series was not found or is restricted for this role.')
        }

        setActiveStudy(studyResult ?? {
          studyInstanceUid: resolvedStudyUID,
          patientName: patientId || 'Unknown Patient',
          patientId,
          studyDate: '',
          studyDescription: 'DICOMweb Study',
          modalities: targetSeries.modality,
          accessionNumber: accession,
        })
        setActiveSeries(targetSeries)

        const shouldUseMpr = mode === 'mpr' && hasPermission('mpr.open')
        setMprMode(shouldUseMpr)
        if (launchSyncVersion === 0) {
          notifyViewerLaunchUpdated()
        }

        navigate(shouldHideLaunchUrl ? '/view' : buildViewerUrl({
          studyUID: resolvedStudyUID,
          seriesUID: targetSeries.seriesInstanceUid,
          mode: shouldUseMpr ? 'mpr' : 'stack',
          accession: accession || undefined,
          patientId: patientId || undefined,
        }), { replace: true })
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to load viewer URL')
        }
      } finally {
        if (!cancelled) {
          setLoadingMessage('')
        }
      }
    }

    void loadViewerFromUrl()

    return () => {
      cancelled = true
    }
  }, [hasPermission, launchSyncVersion, navigate, pathSeriesUID, pathStudyUID, search, seriesPolicy, setActiveSeries, setActiveStudy, setErrorMessage, setLoadingMessage, setMprMode])

  return null
}

const viewerLaunchChannelName = 'vexa-viewer-launch'

function createViewerLaunchChannel() {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(viewerLaunchChannelName)
}

function notifyViewerLaunchUpdated() {
  const channel = createViewerLaunchChannel()
  if (!channel) return

  channel.postMessage({ type: 'viewer-launch-updated', at: Date.now() })
  channel.close()
}

type ViewerLaunchContext = {
  studyUID?: string
  seriesUID?: string
  accession?: string
  patientId?: string
  mode?: ViewerMode
}

async function loadServerViewerLaunch() {
  const response = await fetch(appUrl('/api/auth/viewer-launch'), { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) {
    return null
  }

  const payload = await response.json().catch(() => ({})) as { viewerContext?: ViewerLaunchContext | null }
  return payload.viewerContext ?? null
}

function RisLaunchRedirect() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const launch = searchParams.get('launch') ?? ''

  useEffect(() => {
    let cancelled = false

    async function consumeLaunch() {
      try {
        const response = await fetch(appUrl('/api/auth/ris/consume-json'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: launch }),
        })
        if (!response.ok) {
          throw new Error('Invalid launch token')
        }

        notifyViewerLaunchUpdated()
        if (cancelled) return

        navigate('/view', { replace: true })
      } catch {
        if (!cancelled) {
          navigate('/login', { replace: true })
        }
      }
    }

    if (!launch) {
      navigate('/login', { replace: true })
      return
    }

    void consumeLaunch()

    return () => {
      cancelled = true
    }
  }, [launch, navigate])

  return <main className="launch-blank-page" aria-label="Opening viewer" />
}

function selectInitialImageSeries(series: Awaited<ReturnType<typeof listSeries>>) {
  const imageModalities = new Set(['CT', 'MR', 'CR', 'DX', 'MG', 'US', 'XA', 'RF', 'NM', 'PT', 'OT'])
  return series.find((item) => imageModalities.has(item.modality.toUpperCase()) && item.instanceCount > 0) ?? series[0]
}

function StudyRedirect() {
  const { studyUID } = useParams()

  return <Navigate to={studyUID ? `/view/${studyUID}` : '/view'} replace />
}

function WorklistDisabledPage() {
  return (
    <main className="not-found-page">
      <img className="not-found-logo" src="/vexa.png" alt="VEXA MOBILE" />
      <h1>Worklist Disabled</h1>
      <p>You Can Access it from RIS.</p>
    </main>
  )
}

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <img className="not-found-logo" src="/vexa.png" alt="VEXA MOBILE" />
      <h1>Page Not Found</h1>
      <p>Use a RIS launch token to open the mobile viewer.</p>
    </main>
  )
}
