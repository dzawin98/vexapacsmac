import { appUrl } from '../config/appBase'

type TelemetryPayload = {
  event: string
  elapsedMs?: number
  viewportKey?: string | null
  seriesKey?: string | null
  requested?: number
  warmed?: number
  failed?: number
  bytes?: number
}

const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

let installed = false
let firstImageReported = false
const telemetryDedupeWindowMs = 2500
const recentTelemetryKeys = new Map<string, number>()

export function installViewerTelemetry() {
  if (installed || typeof window === 'undefined') return
  installed = true

  const reportShellLoaded = () => {
    reportViewerTelemetry({
      event: 'viewer-shell-loaded',
      elapsedMs: getElapsedMs(),
    })
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', reportShellLoaded, { once: true })
  } else {
    window.setTimeout(reportShellLoaded, 0)
  }

  window.addEventListener('vexa-viewer-first-image-rendered', (event) => {
    if (firstImageReported) return
    firstImageReported = true

    const detail = (event as CustomEvent<{ viewportKey?: unknown }>).detail
    reportViewerTelemetry({
      event: 'first-image-rendered',
      elapsedMs: getElapsedMs(),
      viewportKey: sanitizeToken(detail?.viewportKey),
    })
  })

  window.addEventListener('vexa-viewer-render-cache-warm', (event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {}
    reportViewerTelemetry({
      event: 'render-cache-warm',
      elapsedMs: sanitizeNumber(detail.elapsedMs),
      viewportKey: sanitizeToken(detail.viewportKey),
      seriesKey: sanitizeToken(detail.seriesKey),
      requested: sanitizeNumber(detail.requested),
      warmed: sanitizeNumber(detail.warmed),
      failed: sanitizeNumber(detail.failed),
      bytes: sanitizeNumber(detail.bytes),
    })
  })
}

function reportViewerTelemetry(payload: TelemetryPayload) {
  if (shouldSkipDuplicateTelemetry(payload)) {
    return
  }

  const body = JSON.stringify({
    ...payload,
    path: window.location.pathname,
    visibility: document.visibilityState,
    viewportClass: getViewportClass(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    timestamp: new Date().toISOString(),
  })
  const url = appUrl('/api/system/telemetry')

  try {
    if ('sendBeacon' in navigator) {
      const sent = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
      if (sent) return
    }
  } catch {
    // Telemetry should never affect viewer startup.
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined)
}

function shouldSkipDuplicateTelemetry(payload: TelemetryPayload) {
  if (payload.event !== 'render-cache-warm') {
    return false
  }

  const key = [
    payload.event,
    payload.viewportKey ?? '',
    payload.seriesKey ?? '',
    payload.requested ?? '',
    payload.warmed ?? '',
    payload.failed ?? '',
    payload.bytes ?? '',
  ].join('|')
  const now = Date.now()
  const lastSeen = recentTelemetryKeys.get(key)
  recentTelemetryKeys.set(key, now)

  for (const [entryKey, timestamp] of recentTelemetryKeys) {
    if (now - timestamp > telemetryDedupeWindowMs || recentTelemetryKeys.size > 80) {
      recentTelemetryKeys.delete(entryKey)
    }
  }

  return Boolean(lastSeen && now - lastSeen < telemetryDedupeWindowMs)
}

function getElapsedMs() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return Math.max(0, Math.round(now - startedAt))
}

function getViewportClass() {
  const width = window.innerWidth
  if (width < 640) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

function sanitizeToken(value: unknown) {
  const token = String(value ?? '').replace(/[^\w:.-]/g, '').slice(0, 64)
  return token || null
}

function sanitizeNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : undefined
}
