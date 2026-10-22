import { useEffect, useMemo, useRef, useState } from 'react'
import { Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { LoginPage, RequireAuth, RequireServiceAdmin, RequireViewerAccess, ServicePage } from './features/auth/AuthPages'
import { useAuthStore, useCurrentUser } from './features/auth/authStore'
import { filterAccessibleSeries, getEffectiveSeriesPolicy } from './features/auth/seriesPolicy'
import { filterRenderableImageSeries, generateFirstFrameThumbnail, getStudy, getStudyByAccession, hasRenderableImages, isImageSeriesCandidate, listSeries } from './features/dicomweb/client'
import type { SeriesSummary } from './features/dicomweb/types'
import { ViewerShell } from './features/viewer/ViewerShell'
import { useViewerStore, type ViewportLayout } from './features/viewer/viewerStore'
import { buildViewerUrl, type ViewerMode } from './utils/viewerUrl'
import { appUrl } from './config/appBase'

type AppSettings = {
  worklistEnabled: boolean
}

// Bounded automatic retry for a viewer study load that failed on a transient
// PACS/DICOMweb error. Beyond this the user gets an explicit Reload action
// instead of a permanently blank page.
const MAX_AUTO_RETRIES = 2

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
      {/* Alias: never let a lower-cased /viewer/Viewer fall into the catch-all.
          React Router v6 matching is case-sensitive, and this exact path is what
          the RIS launch URL produces on the server. */}
      <Route path="/viewer" element={<RisLaunchRedirect />} />
      <Route path="/viewer/Viewer" element={<RisLaunchRedirect />} />
      <Route path="/VIEWER/VIEWER" element={<RisLaunchRedirect />} />
      <Route path="/service" element={<RequireAuth><RequireServiceAdmin><ServicePage /></RequireServiceAdmin></RequireAuth>} />
      <Route path="/" element={<LaunchRequiredPage />} />
      <Route path="/view" element={<RequireAuth><RequireViewerAccess><ViewerLaunchGate /></RequireViewerAccess></RequireAuth>} />
      {/* The wildcard also catches /Viewer and /VIEWER: React Router treats
          these case variants as splats of /view/* , so they resolve to the same
          component instead of falling into the '*' catch-all. */}
      <Route path="/view/Viewer" element={<RequireAuth><RequireViewerAccess><ViewerLaunchGate /></RequireViewerAccess></RequireAuth>} />
      <Route path="/view/VIEWER" element={<RequireAuth><RequireViewerAccess><ViewerLaunchGate /></RequireViewerAccess></RequireAuth>} />
      <Route path="/view/*" element={<RequireAuth><RequireViewerAccess><ViewerLaunchGate /></RequireViewerAccess></RequireAuth>} />
      <Route path="/view/*/*" element={<RequireAuth><RequireViewerAccess><ViewerLaunchGate /></RequireViewerAccess></RequireAuth>} />
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
  const [retryTick, setRetryTick] = useState(0)
  const attempts = useRef(0)
  const retryTimer = useRef<number | null>(null)

  // A failed study load must never leave an unrecoverable blank page. Retry a
  // bounded number of times automatically, then offer an explicit Reload.
  function scheduleRetry(message: string) {
    setLoadingMessage(message)
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current)
    }
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null
      setRetryTick((value) => value + 1)
    }, Math.min(6000, 1500 * Math.max(1, attempts.current)))
  }

  useEffect(() => () => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current)
    }
  }, [])

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
        const queryAccession = query.get('accession') ?? query.get('accessionNumber') ?? ''
        const queryPatientId = query.get('patientId') ?? ''
        const queryMode = query.get('mode') as ViewerMode | null
        const queryRenderMode = query.get('renderMode') === 'server' ? 'server' : undefined
        const rawMprEngine = query.get('mprEngine')
        const queryMprEngine = rawMprEngine === 'server' || rawMprEngine === 'proxy' ? rawMprEngine : undefined
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
          // Distinguish "study has genuinely no series" from "the PACS/DICOMweb
          // lookup timed out". The first is terminal, the second is worth one
          // retry: a blank viewer that never recovers was the field complaint.
          let confirmedEmpty = false
          try {
            const probe = await getStudy(resolvedStudyUID)
            confirmedEmpty = Boolean(probe)
          } catch {
            confirmedEmpty = false
          }

          if (!confirmedEmpty && attempts.current < MAX_AUTO_RETRIES) {
            attempts.current += 1
            scheduleRetry(`Series list for this study did not load. Retrying (${attempts.current}/${MAX_AUTO_RETRIES})…`)
            return
          }

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
          mode: shouldUseMpr ? 'mpr' : 'stack',
          renderMode: queryRenderMode,
          mprEngine: queryMprEngine,
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
  // retryTick drives a bounded automatic retry of a failed study load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, pathStudyUID, pathSeriesUID, seriesPolicy, retryTick, launchSyncVersion])

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
  const currentUser = useCurrentUser()
  const initialized = useAuthStore((state) => state.initialized)
  const hydrate = useAuthStore((state) => state.hydrate)
  const login = useAuthStore((state) => state.login)

  useEffect(() => {
    if (!initialized) { void hydrate(); return }
  }, [hydrate, initialized])

  useEffect(() => {
    if (!initialized) return
    let cancelled = false

    async function ensureDevSession() {
      if (currentUser) return
      if (typeof window === 'undefined') return
      const host = window.location.hostname
      if (host !== 'localhost' && host !== '127.0.0.1') return
      // Dev bypass: directly set auth state without API call
      const store = useAuthStore.getState()
      if (!store.initialized) await store.hydrate()
      if (store.currentUser) return
      // Try login via API
      try {
        const res = await fetch(appUrl('/api/auth/login'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin123' }),
        })
        if (res.ok) {
          await store.hydrate()
        }
      } catch { /* ignore */ }
    }

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
      void ensureDevSession().then(() => {
        if (!cancelled) navigate('/login', { replace: true })
      })
      return
    }

    void ensureDevSession().then(() => consumeLaunch())

    return () => {
      cancelled = true
    }
  }, [launch, navigate, initialized, currentUser, login])

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
      <p>Use a RIS launch token to open the viewer.</p>
    </main>
  )
}
