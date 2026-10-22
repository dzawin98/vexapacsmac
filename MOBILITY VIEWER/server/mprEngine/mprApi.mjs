/**
 * MPR API Routes — MPR Engine
 *
 * Mounted on the existing viewer server (port 5991/5992).
 * All endpoints are prefixed with /api/mpr/.
 *
 * Endpoints:
 *   POST   /api/mpr/load                    — Load series → create session (original)
 *   POST   /api/mpr/load-preview            — Load 3-slice preview → create lightweight session
 *   POST   /api/mpr/{sessionId}/progressive — Start background center-out volume filling
 *   GET    /api/mpr/{sessionId}/stream      — SSE for fill progress
 *   GET    /api/mpr/{sessionId}/info        — Get volume/session info
 *   GET    /api/mpr/{sessionId}/slice       — Render a slice (JPEG)
 *   GET    /api/mpr/{sessionId}/tile        — Render a tile (JPEG)
 *   POST   /api/mpr/{sessionId}/preset      — Set WL/WW preset
 *   DELETE /api/mpr/{sessionId}             — Release session
 *
 * @module mprEngine/mprApi
 */

import { buildVolume, buildVolumePreview, loadVolumeProgressive, fetchPixelData } from './volumeBuilder.mjs'
import {
  createPreviewSession,
  createSession,
  getSessionInfo,
  renderSlice,
  releaseSession,
  fillVolumeSlice,
  upgradeToFull,
  getSessionFillState,
  storeSessionInstances,
  getSessionInstances,
} from './sessionManager.mjs'
import { frameCache } from './cacheManager.mjs'
import { enqueuePrefetch } from './prefetch.mjs'
import { WL_PRESETS } from './resliceEngine.mjs'
import { extractTile, renderToJpeg } from './tileRenderer.mjs'

// ---------------------------------------------------------------------------
// Route regex patterns
// ---------------------------------------------------------------------------

const ROUTE_LOAD = /^\/api\/mpr\/load$/
const ROUTE_LOAD_PREVIEW = /^\/api\/mpr\/load-preview$/
const ROUTE_PROGRESSIVE = /^\/api\/mpr\/([a-f0-9-]+)\/progressive$/
const ROUTE_STREAM = /^\/api\/mpr\/([a-f0-9-]+)\/stream$/
const ROUTE_INFO = /^\/api\/mpr\/([a-f0-9-]+)\/info$/
const ROUTE_SLICE = /^\/api\/mpr\/([a-f0-9-]+)\/slice$/
const ROUTE_TILE = /^\/api\/mpr\/([a-f0-9-]+)\/tile$/
const ROUTE_PRESET = /^\/api\/mpr\/([a-f0-9-]+)\/preset$/
const ROUTE_RELEASE = /^\/api\/mpr\/([a-f0-9-]+)$/

/**
 * Handle MPR API requests.
 */
export async function handleMprApi(req, res, dicomwebBase) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = normalizeMprPath(url.pathname)
  const method = req.method || 'GET'

  const parseBody = () =>
    new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch {
          reject(new Error('Invalid JSON body'))
        }
      })
      req.on('error', reject)
    })

  const json = (data, status = 200) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
  }

  const binary = (buffer, contentType = 'image/jpeg') => {
    res.statusCode = 200
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.end(buffer)
  }

  // -----------------------------------------------------------------------
  // POST /api/mpr/load-preview
  // -----------------------------------------------------------------------
  if (method === 'POST' && ROUTE_LOAD_PREVIEW.test(pathname)) {
    try {
      const body = await parseBody()
      const { studyUid, seriesUid } = body

      if (!studyUid || !seriesUid) {
        json({ error: 'studyUid and seriesUid are required' }, 400)
        return true
      }

      const preview = await buildVolumePreview(studyUid, seriesUid, dicomwebBase)
      const sessionId = createPreviewSession(preview.metadata)
      storeSessionInstances(sessionId, preview.instances)

      preview.previewSlices.forEach((z, i) => {
        fillVolumeSlice(sessionId, z, preview.previewPixelData[i])
      })

      const midSlice = Math.floor(preview.metadata.depth / 2)
      const previewUrls = {
        axial: `/api/mpr/${sessionId}/slice?plane=axial&slice=${midSlice}&ww=400&wl=40&level=0`,
        coronal: `/api/mpr/${sessionId}/slice?plane=coronal&slice=0&ww=400&wl=40&level=0`,
        sagittal: `/api/mpr/${sessionId}/slice?plane=sagittal&slice=0&ww=400&wl=40&level=0`,
      }

      json({
        sessionId,
        previewUrls,
        info: getSessionInfo(sessionId),
        presets: Object.entries(WL_PRESETS).map(([id, p]) => ({ id, label: p.label, wc: p.wc, ww: p.ww })),
      })
      return true
    } catch (error) {
      json({ error: `Failed to load MPR preview: ${error.message}` }, 500)
      return true
    }
  }

  // -----------------------------------------------------------------------
  // POST /api/mpr/{sessionId}/progressive
  // -----------------------------------------------------------------------
  const progressiveMatch = pathname.match(ROUTE_PROGRESSIVE)
  if (method === 'POST' && progressiveMatch) {
    const sessionId = progressiveMatch[1]
    startProgressiveFill(sessionId, dicomwebBase).catch((err) => {
      console.error(`Progressive fill failed for session ${sessionId}:`, err.message)
    })
    json({ status: 'started', sessionId })
    return true
  }

  // -----------------------------------------------------------------------
  // GET /api/mpr/{sessionId}/stream — SSE progress
  // -----------------------------------------------------------------------
  const streamMatch = pathname.match(ROUTE_STREAM)
  if (method === 'GET' && streamMatch) {
    const sessionId = streamMatch[1]

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const interval = setInterval(() => {
      const state = getSessionFillState(sessionId)
      const info = getSessionInfo(sessionId)
      res.write(`data: ${JSON.stringify({ ...state, isFull: info?.isFull ?? false })}\n\n`)
      if (info?.isFull) {
        clearInterval(interval)
        res.end()
      }
    }, 500)

    req.on('close', () => clearInterval(interval))
    return true
  }

  // -----------------------------------------------------------------------
  // POST /api/mpr/load (original, backward compatible)
  // -----------------------------------------------------------------------
  if (method === 'POST' && ROUTE_LOAD.test(pathname)) {
    try {
      const body = await parseBody()
      const { studyUid, seriesUid } = body

      if (!studyUid || !seriesUid) {
        json({ error: 'studyUid and seriesUid are required' }, 400)
        return true
      }

      const volume = await buildVolume(studyUid, seriesUid, dicomwebBase)
      const sessionId = createSession(volume)

      json({
        sessionId,
        info: getSessionInfo(sessionId),
        presets: Object.entries(WL_PRESETS).map(([id, p]) => ({ id, label: p.label, wc: p.wc, ww: p.ww })),
      })
      return true
    } catch (error) {
      json({ error: `Failed to load MPR volume: ${error.message}` }, 500)
      return true
    }
  }

  // -----------------------------------------------------------------------
  // GET /api/mpr/{sessionId}/info
  // -----------------------------------------------------------------------
  const infoMatch = pathname.match(ROUTE_INFO)
  if (method === 'GET' && infoMatch) {
    const sessionId = infoMatch[1]
    const info = getSessionInfo(sessionId)
    if (!info) { json({ error: 'Session not found' }, 404); return true }
    json(info)
    return true
  }

  // -----------------------------------------------------------------------
  // GET /api/mpr/{sessionId}/slice
  // -----------------------------------------------------------------------
  const sliceMatch = pathname.match(ROUTE_SLICE)
  if (method === 'GET' && sliceMatch) {
    const sessionId = sliceMatch[1]
    const plane = url.searchParams.get('plane') || 'axial'
    const sliceIndex = parseInt(url.searchParams.get('slice') || '0', 10)
    const ww = parseInt(url.searchParams.get('ww') || '400', 10)
    const wc = parseInt(url.searchParams.get('wl') || '40', 10)
    const level = parseInt(url.searchParams.get('level') || '0', 10)
    const zoom = parseFloat(url.searchParams.get('zoom') || '1')
    const pan = url.searchParams.get('pan') || '0,0'
    const thickness = parseFloat(url.searchParams.get('thickness') || '1')

    const cached = frameCache.get(sessionId, plane, sliceIndex, ww, wc, level, zoom, pan, thickness)
    if (cached) { binary(cached); enqueuePrefetch(sessionId, { plane, sliceIndex, ww, wc, level }); return true }

    try {
      const buffer = await renderSlice(sessionId, { plane, sliceIndex, ww, wc, level })
      if (!buffer) { json({ error: 'Session not found' }, 404); return true }
      frameCache.set(sessionId, plane, sliceIndex, ww, wc, level, buffer, zoom, pan, thickness)
      enqueuePrefetch(sessionId, { plane, sliceIndex, ww, wc, level })
      binary(buffer)
    } catch (error) {
      json({ error: `Failed to render slice: ${error.message}` }, 500)
    }
    return true
  }

  // -----------------------------------------------------------------------
  // GET /api/mpr/{sessionId}/tile
  // -----------------------------------------------------------------------
  const tileMatch = pathname.match(ROUTE_TILE)
  if (method === 'GET' && tileMatch) {
    const sessionId = tileMatch[1]
    const plane = url.searchParams.get('plane') || 'axial'
    const sliceIndex = parseInt(url.searchParams.get('slice') || '0', 10)
    const ww = parseInt(url.searchParams.get('ww') || '400', 10)
    const wc = parseInt(url.searchParams.get('wl') || '40', 10)
    const level = parseInt(url.searchParams.get('level') || '0', 10)

    try {
      let sliceBuffer = frameCache.get(sessionId, plane, sliceIndex, ww, wc, level)
      if (!sliceBuffer) {
        sliceBuffer = await renderSlice(sessionId, { plane, sliceIndex, ww, wc, level })
        if (sliceBuffer) frameCache.set(sessionId, plane, sliceIndex, ww, wc, level, sliceBuffer)
      }
      if (!sliceBuffer) { json({ error: 'Session not found' }, 404); return true }
      binary(sliceBuffer)
    } catch (error) {
      json({ error: `Failed to render tile: ${error.message}` }, 500)
    }
    return true
  }

  // -----------------------------------------------------------------------
  // POST /api/mpr/{sessionId}/preset
  // -----------------------------------------------------------------------
  const presetMatch = pathname.match(ROUTE_PRESET)
  if (method === 'POST' && presetMatch) {
    const sessionId = presetMatch[1]
    try {
      const body = await parseBody()
      const { preset } = body
      if (preset && WL_PRESETS[preset]) {
        json({ preset, ...WL_PRESETS[preset] })
      } else if (body.ww && body.wc) {
        json({ ww: body.ww, wc: body.wc })
      } else {
        json({ error: 'Provide preset name or ww/wc values' }, 400)
      }
    } catch (error) { json({ error: error.message }, 500) }
    return true
  }

  // -----------------------------------------------------------------------
  // DELETE /api/mpr/{sessionId}
  // -----------------------------------------------------------------------
  const releaseMatch = pathname.match(ROUTE_RELEASE)
  if (method === 'DELETE' && releaseMatch) {
    const sessionId = releaseMatch[1]
    frameCache.clearSession(sessionId)
    releaseSession(sessionId)
    json({ status: 'released' })
    return true
  }

  return false
}

function normalizeMprPath(pathname) {
  return String(pathname || '/').replace(/^\/mobile(?=\/api\/mpr(?:\/|$))/i, '') || '/'
}

// ---------------------------------------------------------------------------
// Background Progressive Fill
// ---------------------------------------------------------------------------

async function startProgressiveFill(sessionId, dicomwebBase) {
  const instances = getSessionInstances(sessionId)
  const info = getSessionInfo(sessionId)
  if (!instances || !info) throw new Error('Session not found or no instances stored')

  const depth = info.dimensions.depth
  const order = centerOutOrder(depth)

  for (const z of order) {
    const state = getSessionFillState(sessionId)
    if (state.loaded >= state.total) break

    const instance = instances[z]
    if (!instance) continue

    const slicePixels = await fetchPixelData(instance, dicomwebBase, 30000)
    fillVolumeSlice(sessionId, z, slicePixels)
  }

  upgradeToFull(sessionId)
}

function centerOutOrder(depth) {
  const order = []
  let low = Math.floor((depth - 1) / 2)
  let high = Math.ceil((depth - 1) / 2)
  while (low >= 0 || high < depth) {
    if (low === high) { order.push(low); low--; high++ }
    else {
      if (high < depth) order.push(high)
      if (low >= 0) order.push(low)
      low--; high++
    }
  }
  return order
}
