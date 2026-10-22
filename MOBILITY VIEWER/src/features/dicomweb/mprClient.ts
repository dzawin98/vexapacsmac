/**
 * MPR Engine API Client
 *
 * Client-side API for communicating with the MPR Engine
 * mounted on the viewer server at /api/mpr/*.
 *
 * The MPR Engine provides server-side rendered slices for instant
 * MPR viewing, with 2-stage progressive streaming:
 *   Stage 1: mprLoadPreview() — 3 slices rendered as JPEG (instant)
 * @module dicomweb/mprClient
 */

import { appUrl } from '../../config/appBase'

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MprSessionInfo = {
  sessionId: string
  dimensions: { width: number; height: number; depth: number }
  spacing: number[]
  sliceCounts: { axial: number; coronal: number; sagittal: number }
  pyramidLevels: Array<{ scale: number; width: number; height: number; depth: number }>
  currentPreset: { wc: number; ww: number }
  isFull?: boolean
  fillState?: { loaded: number; total: number; percent: number }
}

export type MprPresetInfo = {
  id: string
  label: string
  wc: number
  ww: number
}

export type MprSliceOptions = {
  plane?: 'axial' | 'coronal' | 'sagittal'
  sliceIndex?: number
  ww?: number
  wc?: number
  level?: number // 0=L0, 1=L1, 2=L2
}

export type MprPreviewUrls = {
  axial: string
  coronal: string
  sagittal: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// MPR API belongs to the viewer server, so it must follow the viewer base path
// (/viewer or /mobile behind Caddy), not the DICOMweb/PACS base URL.
const MPR_API_BASE = appUrl('/api/mpr')

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

/**
 * STAGE 1: Load a 3-slice preview (instant, <2 seconds).
 *
 * POST /api/mpr/load-preview
 */
export async function mprLoadPreview(studyUid: string, seriesUid: string) {
  const response = await fetch(`${MPR_API_BASE}/load-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studyUid, seriesUid }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `MPR preview load failed: ${response.status}`)
  }

  const data = await response.json()

  const previewUrls: MprPreviewUrls = {
    axial: toViewerApiUrl(data.previewUrls.axial),
    coronal: toViewerApiUrl(data.previewUrls.coronal),
    sagittal: toViewerApiUrl(data.previewUrls.sagittal),
  }

  return {
    sessionId: data.sessionId,
    previewUrls,
    info: data.info as MprSessionInfo,
    presets: data.presets as MprPresetInfo[],
  }
}

/**
 * STAGE 2: Start background progressive volume filling.
 */
export async function mprStartProgressive(sessionId: string) {
  const response = await fetch(`${MPR_API_BASE}/${sessionId}/progressive`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`MPR progressive start failed: ${response.status}`)
  }

  return response.json()
}

/**
 * Subscribe to progressive fill progress via SSE.
 */
export function mprSubscribeProgress(
  sessionId: string,
  onProgress: (state: { loaded: number; total: number; percent: number; isFull: boolean }) => void,
): () => void {
  const eventSource = new EventSource(`${MPR_API_BASE}/${sessionId}/stream`)

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      onProgress(data)
      if (data.isFull) {
        eventSource.close()
      }
    } catch { /* ignore */ }
  }

  eventSource.onerror = () => {
    eventSource.close()
  }

  return () => { eventSource.close() }
}

/**
 * Load a series into the MPR Engine (original, full-load method).
 */
export async function mprLoadSession(studyUid: string, seriesUid: string) {
  const response = await fetch(`${MPR_API_BASE}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studyUid, seriesUid }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `MPR load failed: ${response.status}`)
  }

  return response.json() as Promise<{
    sessionId: string
    info: MprSessionInfo
    presets: MprPresetInfo[]
  }>
}

/**
 * Get session info.
 */
export async function mprGetSessionInfo(sessionId: string) {
  const response = await fetch(`${MPR_API_BASE}/${sessionId}/info`)

  if (!response.ok) {
    if (response.status === 404) return null
    throw new Error(`MPR session info failed: ${response.status}`)
  }

  return response.json() as Promise<MprSessionInfo>
}

/**
 * Render a slice from the MPR Engine.
 */
export async function mprGetSlice(
  sessionId: string,
  options: MprSliceOptions = {},
): Promise<Blob | null> {
  const { plane = 'axial', sliceIndex = 0, ww = 400, wc = 40, level = 0 } = options

  const params = new URLSearchParams({ plane, slice: String(sliceIndex), ww: String(ww), wl: String(wc), level: String(level) })

  const response = await fetch(`${MPR_API_BASE}/${sessionId}/slice?${params}`)

  if (!response.ok) {
    if (response.status === 404) return null
    throw new Error(`MPR slice failed: ${response.status}`)
  }

  return response.blob()
}

/**
 * Release an MPR session.
 */
export async function mprReleaseSession(sessionId: string) {
  await fetch(`${MPR_API_BASE}/${sessionId}`, { method: 'DELETE' })
}

function toViewerApiUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  return appUrl(value)
}

/**
 * Get a slice as an object URL for use in <img> tags.
 */
export async function mprGetSliceUrl(
  sessionId: string,
  options: MprSliceOptions = {},
): Promise<string | null> {
  const blob = await mprGetSlice(sessionId, options)
  if (!blob) return null
  return URL.createObjectURL(blob)
}

/**
 * Load a slice into an HTMLImageElement.
 */
export async function mprLoadSliceIntoImage(
  img: HTMLImageElement,
  sessionId: string,
  options: MprSliceOptions = {},
): Promise<void> {
  const url = await mprGetSliceUrl(sessionId, options)
  if (!url) {
    img.src = ''
    return
  }

  return new Promise((resolve, reject) => {
    img.onload = () => { URL.revokeObjectURL(url); resolve() }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load MPR slice image')) }
    img.src = url
  })
}
