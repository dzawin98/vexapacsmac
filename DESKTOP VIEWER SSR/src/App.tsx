import { useEffect, useMemo, useState } from 'react'
import { Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { LoginPage, RequireAuth, RequireServiceAdmin, RequireViewerAccess, ServicePage } from './features/auth/AuthPages'
import { useAuthStore } from './features/auth/authStore'
import { filterAccessibleSeries, getEffectiveSeriesPolicy } from './features/auth/seriesPolicy'
import { filterRenderableImageSeries, generateFirstFrameThumbnail, getStudy, getStudyByAccession, hasRenderableImages, isImageSeriesCandidate, listSeries } from './features/dicomweb/client'
import type { SeriesSummary } from './features/dicomweb/types'
import { ViewerShell } from './features/viewer/ViewerShell'
import { ThinClientViewer } from './features/viewer/thin-client/ThinClientViewer'
import { useViewerStore, type ViewportLayout } from './features/viewer/viewerStore'
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
      <Route path="/service" element={<RequireAuth><RequireServiceAdmin><ServicePage /></RequireServiceAdmin></RequireAuth>} />
      <Route path="/" element={<LaunchRequiredPage />} />
      <Route path="/view" element={<RequireAuth><RequireViewerAccess><ViewerLaunchGate /></RequireViewerAccess></RequireAuth>} />
      <Route path="/thin-client" element={<RequireAuth><ThinClientViewer /></RequireAuth>} />
      <Route path="/mobile" element={<LaunchRequiredPage />} />
      <Route path="/mobile/:studyUID" element={<LaunchRequiredPage />} />
      <Route path="/mobile/:studyUID/series/:seriesUID" element={<LaunchRequiredPage />} />
      <Route path="/study/:studyUID" element={<LaunchRequiredPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

function ViewerLaunchGate() {
  const location = useLocation()
  const hasDirectViewerContext = useMemo(() => {
    const query = new URLSearchParams(location.search)
    return Boolean(
      query.get('studyUID')
      || query.get('StudyInstanceUIDs')
      || query.get('StudyInstanceUID')
      || query.get('accession')
      || query.get('accessionNumber')
    )
  }, [location.search])
  const [launchState, setLaunchState] = useState<'checking' | 'ready' | 'missing'>(hasDirectViewerContext ? 'ready' : 'checking')

  useEffect(() => {
    if (hasDirectViewerContext) {
      setLaunchState('ready')
      return
    }

    let cancelled = false

    async function checkLaunchContext() {
      const context = await loadServerViewerLaunch()
      if (!cancelled) {
        setLaunchState(context?.accession || context?.studyUID ? 'ready' : 'missing')
      }
    }

    void checkLaunchContext()

    return () => {
      cancelled = true
    }
  }, [hasDirectViewerContext])

  if (launchState === 'checking') {
    return <main className="launch-blank-page" aria-label="Checking viewer launch" />
  }

  return launchState === 'ready' ? <ViewerLayout deepLink /> : <LaunchRequiredPage />
}

function ViewerLayout({ deepLink = false }: { deepLink?: boolean }) {
  const activeStudy = useViewerStore((state) => state.activeStudy)
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

  if (!deepLink && !settings.worklistEnabled) {
    return <WorklistDisabledPage />
  }

  return (
    <main className="app-shell">
      {deepLink && <ViewerDeepLinkLoader />}
      <section className="workspace">
        <ViewerShell deepLinkMode={deepLink} />
      </section>
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

function isScoutLikeSeries(s: Awaited<ReturnType<typeof listSeries>>[number]) {
  const desc = (s.seriesDescription ?? '').toLowerCase()
  const isCtMr = s.modality?.toUpperCase() === 'CT' || s.modality?.toUpperCase() === 'MR'
  if (isCtMr) {
    if (/\b(topogram|scanogram|surview|scout|localizer)\b/i.test(desc)) return true
    if (s.instanceCount <= 3) return true
  }
  return false
}

function getLayoutForCount(count: number): ViewportLayout {
  if (count <= 1) return '1x1'
  if (count === 2) return '1x2'
  if (count <= 4) return '2x2'
  if (count <= 6) return '3x2'
  return '3x3'
}

function ViewerDeepLinkLoader() {
  const { studyUID: pathStudyUID, seriesUID: pathSeriesUID } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const setActiveStudy = useViewerStore((state) => state.setActiveStudy)
  const setActiveSeries = useViewerStore((state) => state.setActiveSeries)
  const setActiveSeriesBatch = useViewerStore((state) => state.setActiveSeriesBatch)
  const setViewportLayout = useViewerStore((state) => state.setViewportLayout)
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
        const queryStudyUID = pathStudyUID ?? query.get('studyUID') ?? query.get('StudyInstanceUIDs') ?? query.get('StudyInstanceUID') ?? ''
        const querySeriesUID = pathSeriesUID ?? query.get('seriesUID') ?? query.get('SeriesInstanceUID') ?? ''
        const querySopUID = query.get('sopUID') ?? query.get('SOPInstanceUID') ?? ''
        const queryAccession = query.get('accession') ?? query.get('accessionNumber') ?? ''
        const queryPatientId = query.get('patientId') ?? ''
        const queryMode = query.get('mode') as ViewerMode | null
        const queryRenderMode = query.get('renderMode') === 'server' ? 'server' : undefined
        const rawMprEngine = query.get('mprEngine')
        const queryMprEngine = rawMprEngine === 'server' || rawMprEngine === 'proxy' ? rawMprEngine : undefined
        const rawCompressedMode = query.get('compressedMode') ?? query.get('dicomTransfer')
        const normalizedCompressedMode = String(rawCompressedMode || '').trim().toLowerCase()
        const queryCompressedMode = normalizedCompressedMode === 'jls' || normalizedCompressedMode === 'jpeg-ls' || normalizedCompressedMode === 'jpegls'
          ? 'jls'
          : undefined
        const hasUrlLaunchContext = Boolean(queryStudyUID || queryAccession)
        const serverLaunch = hasUrlLaunchContext ? null : await loadServerViewerLaunch()
        const studyUID = queryStudyUID || serverLaunch?.studyUID || ''
        const seriesUID = querySeriesUID || serverLaunch?.seriesUID || ''
        const accession = queryAccession || serverLaunch?.accession || ''
        const patientId = queryPatientId || serverLaunch?.patientId || ''
        const mode = (queryMode ?? serverLaunch?.mode ?? 'stack')
        const shouldHideLaunchUrl = Boolean(serverLaunch && sessionOnlyRoute)

        if (!studyUID && !accession) {
          setErrorMessage('Viewer launch context is incomplete.')
          return
        }

        setLoadingMessage('')
        const resolvedStudy = studyUID ? null : await getStudyByAccession(accession)
        const resolvedStudyUID = studyUID || resolvedStudy?.studyInstanceUid || ''

        if (!resolvedStudyUID) {
          throw new Error('Requested study was not found.')
        }

        if (resolvedStudy && !cancelled) {
          setActiveStudy(resolvedStudy)
        }

        const [studyResult, series] = await Promise.all([
          resolvedStudy ? Promise.resolve(resolvedStudy) : getStudy(resolvedStudyUID),
          listSeries(resolvedStudyUID),
        ])

        if (cancelled) return

        if (!series.length) {
          throw new Error('No image series was found for the requested study.')
        }

        const sortedSeries = filterAccessibleSeries(series, seriesPolicy).sort((a, b) => b.instanceCount - a.instanceCount)
        window.dispatchEvent(new CustomEvent('vexa-viewer-series-saved', { detail: { studyInstanceUid: resolvedStudyUID, series: sortedSeries } }))

        if (import.meta.env.VITE_DESKTOP_THUMBNAIL_PREFETCH_ENABLED === 'true') {
          sortedSeries.slice(0, 2).forEach((s) => generateFirstFrameThumbnail(s).catch(() => undefined))
        }

        const requestedSeriesCandidate = seriesUID
          ? sortedSeries.find((item) => item.seriesInstanceUid === seriesUID)
          : null
        const requestedSeries = requestedSeriesCandidate && await isOpenableViewerSeries(requestedSeriesCandidate)
          ? requestedSeriesCandidate
          : null
        const targetSeries = requestedSeries ?? await findFirstRenderableSeries(sortedSeries)

        if (!targetSeries) {
          throw new Error('The requested image series was not found or is restricted for this role.')
        }

        setActiveStudy(studyResult ?? resolvedStudy ?? {
          studyInstanceUid: resolvedStudyUID,
          patientName: patientId || 'Unknown Patient',
          patientId,
          studyDate: '',
          studyDescription: 'DICOMweb Study',
          modalities: targetSeries.modality,
          accessionNumber: accession,
        })

        let isBatched = false
        if (!requestedSeries) {
          // Auto multi-viewport: batch only renderable image series (skip SR/PR/DOC/KO/OT).
          // Direct series launch should not scan every series in the study before first paint.
          const imageSeries = await filterRenderableImageSeries(sortedSeries)
          const scouts = imageSeries.filter((s) => isScoutLikeSeries(s))
          const mainSeries = imageSeries.filter((s) => !isScoutLikeSeries(s))
          const ordered = [...mainSeries, ...scouts]
          if (imageSeries.length >= 2) {
            // CT/MR: fixed 2x2 layout with exactly 4 viewports
            const isCtMr = targetSeries.modality?.toUpperCase() === 'CT' || targetSeries.modality?.toUpperCase() === 'MR'
            const maxViewports = isCtMr ? 4 : 9
            const layout = isCtMr ? '2x2' : getLayoutForCount(Math.min(ordered.length, maxViewports))
            const batch: Record<string, SeriesSummary> = {}
            for (let i = 0; i < ordered.length && i < maxViewports; i++) {
              batch[String(i)] = ordered[i]
            }
            setViewportLayout(layout)
            setActiveSeriesBatch(batch, layout)
            isBatched = true
          }
        }
        if (!isBatched) {
          setViewportLayout('1x1')
          setActiveSeries(targetSeries)
        }

        const shouldUseMpr = mode === 'mpr' && hasPermission('mpr.open')
        setMprMode(shouldUseMpr, shouldUseMpr ? '0' : null)
        if (launchSyncVersion === 0) {
          notifyViewerLaunchUpdated()
        }

        navigate(shouldHideLaunchUrl ? '/view' : accession ? buildAccessionViewerUrl({
          accession,
          mode: shouldUseMpr ? 'mpr' : 'stack',
          patientId: patientId || undefined,
        }) : buildViewerUrl({
          studyUID: resolvedStudyUID,
          seriesUID: isBatched ? undefined : targetSeries.seriesInstanceUid,
          sopUID: isBatched ? undefined : querySopUID || undefined,
          mode: shouldUseMpr ? 'mpr' : 'stack',
          renderMode: queryRenderMode,
          mprEngine: queryMprEngine,
          compressedMode: queryCompressedMode,
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

function buildAccessionViewerUrl({ accession, mode, patientId }: { accession: string; mode: ViewerMode; patientId?: string }) {
  const params = new URLSearchParams()
  params.set('accession', accession)
  if (mode !== 'auto') params.set('mode', mode)
  if (patientId) params.set('patientId', patientId)

  return `/mobile?${params.toString()}`
}

async function findFirstRenderableSeries(series: Awaited<ReturnType<typeof listSeries>>) {
  const [firstImageSeries] = await filterRenderableImageSeries(series)
  return firstImageSeries
    ?? series.find((item) => item.modality?.toUpperCase() === 'SR')
    ?? null
}

async function isOpenableViewerSeries(series: SeriesSummary) {
  if (isImageSeriesCandidate(series)) {
    return hasRenderableImages(series).catch(() => false)
  }

  return ['SR', 'PR', 'ECG'].includes(series.modality?.toUpperCase() ?? '')
}

function WorklistDisabledPage() {
  return (
    <main className="not-found-page">
      <img className="not-found-logo" src="/vexa.png" alt="Viewer" />
      <h1>Worklist Disabled</h1>
      <p>You Can Access it from RIS.</p>
    </main>
  )
}

function LaunchRequiredPage() {
  return (
    <main className="not-found-page">
      <img className="not-found-logo" src="/vexa.png" alt="Viewer" />
      <h1>Viewer</h1>
      <p>Viewer can only be used with an integrated system.</p>
    </main>
  )
}

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <img className="not-found-logo" src="/vexa.png" alt="Viewer" />
      <h1>Page Not Found</h1>
      <p>Open the viewer with a launch token from the RIS.</p>
    </main>
  )
}
