import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { viteCommonjs } from '@originjs/vite-plugin-commonjs'
import type { IncomingMessage, ServerResponse } from 'node:http'

const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '')
for (const [key, value] of Object.entries(env)) {
  process.env[key] ??= value
}
const dicomwebPacsRoot = process.env.DICOMWEB_PACS_ROOT ?? 'http://127.0.0.1:5001'
process.env.VITE_APP_BASE_PATH ??= ''

// @ts-ignore - shared Node runtime helper used by the development server.
const { createCacheStore } = await import('../tools/runtime/cacheStore.mjs')
// @ts-ignore - Node ESM middleware is shared with the production server.
const { authorizeViewerRequest, handleAuthApi } = await import('./server/authApi.mjs')
// @ts-ignore - Node ESM middleware is shared with the production server.
const { getViewerExportRuntimeStatus, handleViewerExportApi } = await import('./server/exportRuntime.mjs')
const viteDicomwebProxyCache = createCacheStore({
  namespace: 'desktop-vite-dicomweb-proxy',
  maxBytes: Number(process.env.DICOMWEB_PROXY_CACHE_MAX_BYTES ?? 64 * 1024 * 1024),
  maxEntryBytes: Number(process.env.DICOMWEB_PROXY_CACHE_MAX_ENTRY_BYTES ?? 6 * 1024 * 1024),
  maxEntries: Number(process.env.DICOMWEB_PROXY_CACHE_MAX_ENTRIES ?? 2000),
})
const viteTelemetryMaxEvents = Math.max(25, Number(process.env.VEXA_VIEWER_TELEMETRY_MAX_EVENTS ?? 250))
const viteTelemetryEvents: Array<Record<string, unknown>> = []
const viteTelemetrySummary = {
  totalEvents: 0,
  eventCounts: {} as Record<string, number>,
  durations: {} as Record<string, { samples: number; totalMs: number; minMs: number; maxMs: number }>,
}

export default defineConfig({
  base: './',
  plugins: [viewerApiPlugin(handleAuthApi, dicomwebPacsRoot), react(), viteCommonjs()],
  // NOTE: splitting the vendors into separate chunks with manualChunks was tried
  // and REVERTED. Measured outcome at ~630 kbps / 150 ms RTT: 1438 KB of
  // compressed JS still took ~19 s, i.e. exactly what the single chunk cost, so
  // the split bought nothing on wall-clock. It also broke the app: separating
  // @kitware/vtk.js from @cornerstonejs/core splits their circular import and
  // throws "Cannot access 'i2' before initialization" before React mounts. Do
  // not reintroduce a split that isolates vtk from cornerstone.
  server: {
    host: '0.0.0.0',
    port: 5991,
    proxy: {
      '/rs': {
        target: dicomwebPacsRoot,
        changeOrigin: true,
      },
      '/wadouri': {
        target: dicomwebPacsRoot,
        changeOrigin: true,
      },
      '/api/mpr': {
        target: dicomwebPacsRoot,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es',
    rollupOptions: {
      external: ['@icr/polyseg-wasm'],
    },
  },
})

function viewerApiPlugin(
  handleAuthApi: (req: any, res: any) => Promise<boolean>,
  dicomwebPacsRoot: string,
) {
  return {
    name: 'vexa-viewer-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        if (isDicomwebMutation(req.method) && requestUrl.pathname.startsWith('/rs')) {
          // STOW-RS changes the study manifest and QIDO series list. Clear the
          // dev proxy cache before Vite forwards the write to PACS.
          viteDicomwebProxyCache.clear()
        }
        if (await handleAuthApi(req, res)) return
        if (await handleViewerExportApi(req, res)) return
        if (await handleViteRuntimeApi(req, res, dicomwebPacsRoot)) return
        if (await handleViteDicomwebProxyCache(req, res, dicomwebPacsRoot)) return
        next()
      })
    },
  }
}

function isDicomwebMutation(method = 'GET') {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

async function handleViteRuntimeApi(req: IncomingMessage, res: ServerResponse, pacsRoot: string) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = requestUrl.pathname

  if (isRenderedStackWarmPath(pathname)) {
    await handleRenderedStackWarmProxy(req, res, pacsRoot, pathname)
    return true
  }
  if (isProgressiveAuditPath(pathname)) {
    await handlePacsJsonProxy(req, res, pacsRoot, pathname)
    return true
  }

  if (pathname === '/api/system/telemetry') {
    if (req.method !== 'POST') {
      sendJson(res, req.method === 'OPTIONS' ? 204 : 405, req.method === 'OPTIONS' ? null : { error: 'Method not allowed' })
      return true
    }

    const payload = await readJsonRequestBody(req, 16 * 1024)
    const recorded = recordViewerTelemetry(payload)
    sendJson(res, recorded ? 202 : 400, recorded ? { ok: true } : { error: 'Invalid telemetry event' })
    return true
  }

  if (pathname === '/api/system/health') {
    sendJson(res, 200, {
      service: 'desktop-viewer-vite',
      status: 'ok',
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      dicomwebProxyOrigin: new URL(pacsRoot).origin,
      export: getViewerExportRuntimeStatus(),
    })
    return true
  }

  if (pathname === '/api/system/performance') {
    sendJson(res, 200, {
      service: 'desktop-viewer-vite',
      now: new Date().toISOString(),
      dicomwebProxyCache: viteDicomwebProxyCache.stats(),
      telemetry: getViewerTelemetryStats(),
    })
    return true
  }

  return false
}

function isRenderedStackWarmPath(pathname: string) {
  return pathname === '/api/rendered-stack/warm' || pathname === '/api/viewer/rendered-stack/warm'
}

function isProgressiveAuditPath(pathname: string) {
  return pathname === '/api/experimental/progressive/audit' || pathname === '/api/viewer/progressive/audit'
}

async function handlePacsJsonProxy(req: IncomingMessage, res: ServerResponse, pacsRoot: string, pathname: string) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null)
    return
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }

  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const payload = req.method === 'POST' ? await readJsonRequestBody(req, 128 * 1024) : null
  if (req.method === 'POST' && !payload) {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON request' })
    return
  }

  try {
    const response = await fetch(new URL(`${pathname}${requestUrl.search}`, pacsRoot), {
      method: req.method,
      headers: {
        Accept: 'application/json',
        ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(req.headers.authorization ? { Authorization: String(req.headers.authorization) } : {}),
        ...(req.headers.cookie ? { Cookie: String(req.headers.cookie) } : {}),
      },
      ...(req.method === 'POST' ? { body: JSON.stringify(payload) } : {}),
    })

    const text = await response.text()
    try {
      sendJson(res, response.status, text ? JSON.parse(text) : { ok: response.ok })
    } catch {
      sendJson(res, response.status, { ok: response.ok, upstreamStatus: response.status })
    }
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: `PACS JSON proxy failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

async function handleRenderedStackWarmProxy(req: IncomingMessage, res: ServerResponse, pacsRoot: string, pathname: string) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null)
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }

  const payload = await readJsonRequestBody(req, 128 * 1024)
  if (!payload) {
    sendJson(res, 400, { ok: false, error: 'Invalid warm request' })
    return
  }

  try {
    const response = await fetch(new URL(pathname, pacsRoot), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(req.headers.authorization ? { Authorization: String(req.headers.authorization) } : {}),
        ...(req.headers.cookie ? { Cookie: String(req.headers.cookie) } : {}),
      },
      body: JSON.stringify(payload),
    })

    if (response.status === 404) {
      sendJson(res, 200, { ok: false, enabled: false, reason: 'upstream-warm-route-not-found' })
      return
    }

    const text = await response.text()
    try {
      sendJson(res, response.ok ? 200 : response.status, text ? JSON.parse(text) : { ok: response.ok })
    } catch {
      sendJson(res, response.ok ? 200 : response.status, { ok: response.ok, upstreamStatus: response.status })
    }
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      enabled: false,
      reason: 'upstream-warm-proxy-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function handleViteDicomwebProxyCache(req: IncomingMessage, res: ServerResponse, pacsRoot: string) {
  if (req.method !== 'GET') return false
  if (req.headers.range) return false

  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const proxyPath = requestUrl.pathname
  if (!isCacheableDicomwebProxyRequest(proxyPath)) return false

  const targetUrl = new URL(`${proxyPath}${requestUrl.search}`, pacsRoot)
  const cacheKey = getDicomwebProxyCacheKey(req, targetUrl)
  const cachedResponse = viteDicomwebProxyCache.get(cacheKey) as CachedProxyResponse | null
  if (cachedResponse) {
    sendCachedProxyResponse(res, cachedResponse, 'HIT')
    return true
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: buildProxyHeaders(req),
    })
    const body = Buffer.from(await response.arrayBuffer())
    const headers = sanitizeProxyHeaders(Object.fromEntries(response.headers.entries()))
    sendProxyResponse(res, response.status, headers, body, 'MISS')

    if (shouldStoreDicomwebProxyResponse(proxyPath, response.status, headers, body)) {
      viteDicomwebProxyCache.set(cacheKey, {
        statusCode: response.status,
        headers,
        body,
      }, getDicomwebProxyCacheTtlMs(proxyPath))
    }
    return true
  } catch (error) {
    sendJson(res, 502, { error: `DICOMweb dev proxy failed: ${error instanceof Error ? error.message : String(error)}` })
    return true
  }
}

type CachedProxyResponse = {
  statusCode: number
  headers: Record<string, string | string[]>
  body: Buffer
}

function isCacheableDicomwebProxyRequest(proxyPath: string) {
  const lowerPath = proxyPath.toLowerCase()
  if (lowerPath.startsWith('/api/viewer/')) return lowerPath.endsWith('/manifest')
  if (!lowerPath.startsWith('/rs')) return false
  if (lowerPath.includes('/frames/')) return false

  // Metadata controls how Cornerstone decodes pixel buffers. A stale metadata
  // response can make the loader treat compressed HTJ2K frames as raw pixels,
  // causing WebGL texture upload failures and blank viewports.
  if (lowerPath.endsWith('/metadata')) return false

  return lowerPath === '/rs/studies'
    || lowerPath.endsWith('/series')
    || lowerPath.endsWith('/instances')
    || lowerPath.endsWith('/rendered')
}

function getDicomwebProxyCacheKey(req: IncomingMessage, targetUrl: URL) {
  return [
    req.method,
    targetUrl.href,
    String(req.headers.accept ?? ''),
    'identity',
    String(req.headers.authorization ?? ''),
    String(req.headers.cookie ?? ''),
  ].join('\n')
}

function buildProxyHeaders(req: IncomingMessage) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase()
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(lowerName)) continue
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item))
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  headers.set('accept-encoding', 'identity')
  return headers
}

function shouldStoreDicomwebProxyResponse(proxyPath: string, statusCode: number, headers: Record<string, string | string[]>, body: Buffer) {
  if (statusCode < 200 || statusCode >= 300) return false
  if (!body.length || body.length > Number(process.env.DICOMWEB_PROXY_CACHE_MAX_ENTRY_BYTES ?? 6 * 1024 * 1024)) return false

  const contentType = String(headers['content-type'] ?? '').toLowerCase()
  if (contentType.includes('text/html')) return false
  if (String(headers['cache-control'] ?? '').toLowerCase().includes('no-store')) return false

  const lowerPath = proxyPath.toLowerCase()
  if (lowerPath.endsWith('/metadata')) return false

  if (lowerPath.endsWith('/rendered')) {
    return contentType.startsWith('image/')
  }

  return contentType.includes('json') || contentType.includes('application/dicom')
}

function getDicomwebProxyCacheTtlMs(proxyPath: string) {
  const lowerPath = proxyPath.toLowerCase()
  if (lowerPath === '/rs/studies') return 15 * 1000
  if (lowerPath.endsWith('/rendered')) return 30 * 60 * 1000
  return 10 * 60 * 1000
}

function sanitizeProxyHeaders(headers: Record<string, string | string[]>) {
  const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])
  const sanitized: Record<string, string | string[]> = {}

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (
      hopByHopHeaders.has(lowerName)
      || lowerName === 'set-cookie'
      || lowerName === 'content-encoding'
      || lowerName === 'content-length'
      || value === undefined
    ) {
      continue
    }
    sanitized[name] = value
  }

  return sanitized
}

function sendCachedProxyResponse(res: ServerResponse, cachedResponse: CachedProxyResponse, cacheStatus: string) {
  sendProxyResponse(res, cachedResponse.statusCode, cachedResponse.headers, cachedResponse.body, cacheStatus)
}

function sendProxyResponse(res: ServerResponse, statusCode: number, headers: Record<string, string | string[]>, body: Buffer, cacheStatus: string) {
  res.statusCode = statusCode
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-length') continue
    res.setHeader(name, value)
  }
  res.setHeader('Content-Length', body.length)
  res.setHeader('X-VEXA-Proxy-Cache', cacheStatus)
  res.end(body)
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown> | null) {
  const body = payload === null ? '' : JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  if (body) {
    res.setHeader('Content-Length', Buffer.byteLength(body))
  }
  res.end(body)
}

async function readJsonRequestBody(req: IncomingMessage, maxBytes: number) {
  const raw = await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = false

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        resolve(null)
        return
      }
      resolve(Buffer.concat(chunks, bytes).toString('utf8'))
    })
    req.on('error', () => resolve(null))
  })

  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function recordViewerTelemetry(payload: Record<string, unknown> | null) {
  if (!payload || typeof payload !== 'object') return false

  const event = sanitizeTelemetryToken(payload.event, 64)
  if (!event) return false

  const elapsedMs = sanitizeTelemetryNumber(payload.elapsedMs, 10 * 60 * 1000)
  const entry = {
    event,
    at: new Date().toISOString(),
    elapsedMs,
    path: sanitizeTelemetryPath(payload.path),
    viewportKey: sanitizeTelemetryToken(payload.viewportKey, 64),
    viewportClass: sanitizeTelemetryToken(payload.viewportClass, 32),
    visibility: sanitizeTelemetryToken(payload.visibility, 32),
    viewportWidth: sanitizeTelemetryNumber(payload.viewportWidth, 100000),
    viewportHeight: sanitizeTelemetryNumber(payload.viewportHeight, 100000),
  }

  viteTelemetrySummary.totalEvents += 1
  viteTelemetrySummary.eventCounts[event] = (viteTelemetrySummary.eventCounts[event] ?? 0) + 1

  if (elapsedMs !== null) {
    const stats = viteTelemetrySummary.durations[event] ?? {
      samples: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
    }
    stats.samples += 1
    stats.totalMs += elapsedMs
    stats.minMs = Math.min(stats.minMs, elapsedMs)
    stats.maxMs = Math.max(stats.maxMs, elapsedMs)
    viteTelemetrySummary.durations[event] = stats
  }

  viteTelemetryEvents.push(entry)
  while (viteTelemetryEvents.length > viteTelemetryMaxEvents) {
    viteTelemetryEvents.shift()
  }

  return true
}

function getViewerTelemetryStats() {
  const durations: Record<string, Record<string, number>> = {}
  for (const [event, stats] of Object.entries(viteTelemetrySummary.durations)) {
    durations[event] = {
      samples: stats.samples,
      avgMs: stats.samples ? Math.round(stats.totalMs / stats.samples) : 0,
      minMs: Number.isFinite(stats.minMs) ? Math.round(stats.minMs) : 0,
      maxMs: Math.round(stats.maxMs),
    }
  }

  return {
    maxEvents: viteTelemetryMaxEvents,
    retainedEvents: viteTelemetryEvents.length,
    totalEvents: viteTelemetrySummary.totalEvents,
    eventCounts: viteTelemetrySummary.eventCounts,
    durations,
    latest: viteTelemetryEvents.slice(-10),
  }
}

function sanitizeTelemetryToken(value: unknown, maxLength: number) {
  const token = String(value ?? '').replace(/[^\w:.-]/g, '').slice(0, maxLength)
  return token || null
}

function sanitizeTelemetryPath(value: unknown) {
  const path = String(value ?? '').split(/[?#]/)[0]
  return path.startsWith('/') ? path.slice(0, 120) : null
}

function sanitizeTelemetryNumber(value: unknown, maxValue: number) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.min(Math.round(number), maxValue)
}
