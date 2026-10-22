import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, normalize } from 'node:path'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'

await loadEnvFile()
const require = createRequire(import.meta.url)
const { enforceLicenseAtStartup } = require('../../scripts/license/licenseRuntime')
enforceLicenseAtStartup('DESKTOP_VIEWER')
const { createCacheStore } = await import('../../tools/runtime/cacheStore.mjs')
const { createJobQueue } = await import('../../tools/runtime/jobQueue.mjs')
const { authorizeViewerRequest, handleAuthApi } = await import('./authApi.mjs')
const { getViewerExportRuntimeStatus, handleViewerExportApi } = await import('./exportRuntime.mjs')
const port = Number(process.env.PORT ?? 5991)
const dicomwebPacsRoot = new URL(process.env.DICOMWEB_PACS_ROOT ?? 'http://127.0.0.1:5001')
const distDir = join(process.cwd(), 'dist')
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}
const compressedStaticExtensions = new Set(['.html', '.js', '.css', '.json', '.svg', '.wasm'])
const dicomwebProxyCacheMaxBytes = Number(process.env.DICOMWEB_PROXY_CACHE_MAX_BYTES ?? 64 * 1024 * 1024)
const dicomwebProxyCacheMaxEntryBytes = Number(process.env.DICOMWEB_PROXY_CACHE_MAX_ENTRY_BYTES ?? 6 * 1024 * 1024)
const dicomwebProxyCache = createCacheStore({
  namespace: 'desktop-dicomweb-proxy',
  maxBytes: dicomwebProxyCacheMaxBytes,
  maxEntryBytes: dicomwebProxyCacheMaxEntryBytes,
  maxEntries: Number(process.env.DICOMWEB_PROXY_CACHE_MAX_ENTRIES ?? 2000),
})
const viewerJobQueue = createJobQueue({
  name: 'desktop-viewer-runtime',
  concurrency: Number(process.env.VEXA_VIEWER_JOB_CONCURRENCY ?? 2),
})
const dicomwebWarmupEnabled = String(process.env.VEXA_DICOMWEB_WARMUP_ENABLED ?? 'true').toLowerCase() !== 'false'
const dicomwebWarmupMaxStudies = Math.max(0, Number(process.env.VEXA_DICOMWEB_WARMUP_MAX_STUDIES ?? 2))
const dicomwebWarmupMaxSeries = Math.max(0, Number(process.env.VEXA_DICOMWEB_WARMUP_MAX_SERIES ?? 4))
const viewerTelemetryMaxEvents = Math.max(25, Number(process.env.VEXA_VIEWER_TELEMETRY_MAX_EVENTS ?? 250))
const viewerTelemetryEvents = []
const viewerTelemetrySummary = {
  totalEvents: 0,
  eventCounts: {},
  durations: {},
}
const staleClientCleanupScript = `
(async function () {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn('Viewer cache cleanup failed', error);
  }
  const marker = 'vexa_viewer_cache_reset';
  try {
    if (!sessionStorage.getItem(marker)) {
      sessionStorage.setItem(marker, '1');
      window.location.reload();
    }
  } catch {
    window.location.reload();
  }
})();
`

const viewerServer = createServer(async (req, res) => {
  if (await handleAuthApi(req, res)) return
  if (await handleRuntimeApi(req, res)) return
  if (await proxyDicomwebRequest(req, res)) return

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const requestedPath = getClientAssetPath(url.pathname)
    if (sendWellKnownClientFile(requestedPath, res)) return

    const assetPath = requestedPath === '/' ? join(distDir, 'index.html') : join(distDir, requestedPath)
    const target = await getStaticFilePath(assetPath)
    const body = await readFile(target)
    sendStaticBody(req, res, body, extname(target), target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable')
  } catch {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const requestedPath = getClientAssetPath(url.pathname)
    const extension = extname(requestedPath)
    if (sendMissingAssetResponse(extension, res)) return

    try {
      const body = await readFile(join(distDir, 'index.html'))
      sendStaticBody(req, res, body, '.html', 'no-store')
    } catch {
      res.statusCode = 404
      res.end('Not found. Run npm run build first.')
    }
  }
})

viewerServer.listen(port, () => {
  console.log(`VEXA Desktop Viewer server listening on http://localhost:${port}`)
  console.log(`DICOMweb proxy forwarding /rs and /wadouri to ${dicomwebPacsRoot.origin}`)
})

viewerJobQueue.register('cache-sweep', () => {
  dicomwebProxyCache.sweepExpired()
  return dicomwebProxyCache.stats()
})

viewerJobQueue.register('dicomweb-warmup', async (job) => {
  return warmDicomwebProxyRequest(job.data)
})

setInterval(() => {
  viewerJobQueue.add('cache-sweep', {}, { attempts: 1 })
}, Math.max(15000, Number(process.env.VEXA_CACHE_SWEEP_INTERVAL_MS ?? 60000))).unref?.()

function getClientAssetPath(pathname) {
  const decoded = decodeURIComponent(pathname || '/')
  const stripped = decoded.replace(/^\/viewer(?=\/|$)/i, '') || '/'
  return normalize(stripped).replace(/^(\.\.[/\\])+/, '')
}

function sendStaticBody(req, res, body, extension, cacheControl) {
  const contentType = mimeTypes[extension] ?? 'application/octet-stream'
  const compressed = compressStaticBody(req, body, extension)

  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', cacheControl)
  if (compressed.encoding) {
    res.setHeader('Content-Encoding', compressed.encoding)
    res.setHeader('Vary', 'Accept-Encoding')
  }
  res.setHeader('Content-Length', compressed.body.length)
  res.end(compressed.body)
}

function compressStaticBody(req, body, extension) {
  if (body.length < 1024 || !compressedStaticExtensions.has(extension)) {
    return { body, encoding: '' }
  }

  const acceptEncoding = String(req.headers['accept-encoding'] ?? '')
  try {
    if (acceptEncoding.includes('br')) {
      return {
        body: brotliCompressSync(body, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          },
        }),
        encoding: 'br',
      }
    }

    if (acceptEncoding.includes('gzip')) {
      return { body: gzipSync(body, { level: 6 }), encoding: 'gzip' }
    }
  } catch {
    return { body, encoding: '' }
  }

  return { body, encoding: '' }
}

async function handleRuntimeApi(req, res) {
  if (await handleViewerExportApi(req, res)) return true
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = getClientAssetPath(requestUrl.pathname)
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
      service: 'desktop-viewer',
      status: 'ok',
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      dicomwebProxyOrigin: dicomwebPacsRoot.origin,
      export: getViewerExportRuntimeStatus(),
    })
    return true
  }

  if (pathname !== '/api/system/performance') {
    return false
  }

  sendJson(res, 200, {
    service: 'desktop-viewer',
    now: new Date().toISOString(),
    dicomwebProxyCache: dicomwebProxyCache.stats(),
    jobs: viewerJobQueue.stats(),
    telemetry: getViewerTelemetryStats(),
  })
  return true
}

function sendJson(res, statusCode, payload) {
  const body = payload === null ? '' : JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  if (body) {
    res.setHeader('Content-Length', Buffer.byteLength(body))
  }
  res.end(body)
}

async function readJsonRequestBody(req, maxBytes) {
  const raw = await new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    let tooLarge = false

    req.on('data', (chunk) => {
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
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function recordViewerTelemetry(payload) {
  if (!payload || typeof payload !== 'object') return false

  const event = sanitizeTelemetryToken(payload.event, 64)
  if (!event) return false

  const elapsedMs = sanitizeTelemetryNumber(payload.elapsedMs, 10 * 60 * 1000)
  const viewportWidth = sanitizeTelemetryNumber(payload.viewportWidth, 100000)
  const viewportHeight = sanitizeTelemetryNumber(payload.viewportHeight, 100000)
  const entry = {
    event,
    at: new Date().toISOString(),
    elapsedMs,
    path: sanitizeTelemetryPath(payload.path),
    viewportKey: sanitizeTelemetryToken(payload.viewportKey, 64),
    viewportClass: sanitizeTelemetryToken(payload.viewportClass, 32),
    visibility: sanitizeTelemetryToken(payload.visibility, 32),
    viewportWidth,
    viewportHeight,
  }

  viewerTelemetrySummary.totalEvents += 1
  viewerTelemetrySummary.eventCounts[event] = (viewerTelemetrySummary.eventCounts[event] ?? 0) + 1

  if (elapsedMs !== null) {
    const stats = viewerTelemetrySummary.durations[event] ?? {
      samples: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
    }
    stats.samples += 1
    stats.totalMs += elapsedMs
    stats.minMs = Math.min(stats.minMs, elapsedMs)
    stats.maxMs = Math.max(stats.maxMs, elapsedMs)
    viewerTelemetrySummary.durations[event] = stats
  }

  viewerTelemetryEvents.push(entry)
  while (viewerTelemetryEvents.length > viewerTelemetryMaxEvents) {
    viewerTelemetryEvents.shift()
  }

  return true
}

function getViewerTelemetryStats() {
  const durations = {}
  for (const [event, stats] of Object.entries(viewerTelemetrySummary.durations)) {
    durations[event] = {
      samples: stats.samples,
      avgMs: stats.samples ? Math.round(stats.totalMs / stats.samples) : 0,
      minMs: Number.isFinite(stats.minMs) ? Math.round(stats.minMs) : 0,
      maxMs: Math.round(stats.maxMs),
    }
  }

  return {
    maxEvents: viewerTelemetryMaxEvents,
    retainedEvents: viewerTelemetryEvents.length,
    totalEvents: viewerTelemetrySummary.totalEvents,
    eventCounts: viewerTelemetrySummary.eventCounts,
    durations,
    latest: viewerTelemetryEvents.slice(-10),
  }
}

function sanitizeTelemetryToken(value, maxLength) {
  const token = String(value ?? '').replace(/[^\w:.-]/g, '').slice(0, maxLength)
  return token || null
}

function sanitizeTelemetryPath(value) {
  const path = String(value ?? '').split(/[?#]/)[0]
  return path.startsWith('/') ? path.slice(0, 120) : null
}

function sanitizeTelemetryNumber(value, maxValue) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.min(Math.round(number), maxValue)
}

async function proxyDicomwebRequest(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const proxyPath = getClientAssetPath(requestUrl.pathname)
  if (isRenderedStackWarmPath(proxyPath)) {
    await proxyRenderedStackWarmRequest(req, res, proxyPath)
    return true
  }
  if (!proxyPath.startsWith('/rs') && !proxyPath.startsWith('/api/viewer') && !isProgressiveAuditPath(proxyPath) && proxyPath !== '/wadouri') {
    return false
  }

  const targetUrl = new URL(`${proxyPath}${requestUrl.search}`, dicomwebPacsRoot)
  if (isDicomwebMutation(req.method)) {
    clearDicomwebProxyCache()
  }

  const cacheable = isCacheableDicomwebProxyRequest(req, proxyPath)
  const cacheKey = cacheable ? getDicomwebProxyCacheKey(req, targetUrl) : ''
  const cachedResponse = cacheKey ? getDicomwebProxyCache(cacheKey) : null
  if (cachedResponse) {
    sendCachedDicomwebProxyResponse(req, res, cachedResponse)
    return true
  }

  const requestFn = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = { ...req.headers, host: targetUrl.host }
  delete headers.origin

  await new Promise((resolve) => {
    const proxyRequest = requestFn(targetUrl, {
      method: req.method,
      headers,
    }, (proxyResponse) => {
      if (cacheable && req.method === 'GET') {
        const chunks = []
        let bodyBytes = 0

        proxyResponse.on('data', (chunk) => {
          chunks.push(chunk)
          bodyBytes += chunk.length
        })
        proxyResponse.on('end', () => {
          const body = Buffer.concat(chunks, bodyBytes)
          const headers = sanitizeProxyHeaders(proxyResponse.headers)
          res.statusCode = proxyResponse.statusCode ?? 502
          for (const [name, value] of Object.entries(headers)) {
            if (value !== undefined) res.setHeader(name, value)
          }
          res.setHeader('Content-Length', body.length)
          res.setHeader('X-VEXA-Proxy-Cache', 'MISS')
          res.end(body)

          if (shouldStoreDicomwebProxyResponse(proxyPath, proxyResponse, body)) {
            setDicomwebProxyCache(cacheKey, {
              statusCode: proxyResponse.statusCode ?? 200,
              headers,
              body,
              expiresAt: Date.now() + getDicomwebProxyCacheTtlMs(proxyPath),
            })
            scheduleDicomwebWarmup(proxyPath, targetUrl, req.headers, body)
          }
          resolve()
        })
        proxyResponse.on('error', resolve)
        return
      }

      res.statusCode = proxyResponse.statusCode ?? 502
      for (const [name, value] of Object.entries(proxyResponse.headers)) {
        if (value !== undefined) res.setHeader(name, value)
      }
      proxyResponse.pipe(res)
      proxyResponse.on('end', resolve)
    })

    proxyRequest.on('error', (error) => {
      if (!res.headersSent) {
        res.statusCode = 502
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      res.end(JSON.stringify({ error: `DICOMweb proxy failed: ${error.message}` }))
      resolve()
    })

    req.pipe(proxyRequest)
  })

  return true
}

function isRenderedStackWarmPath(proxyPath) {
  return proxyPath === '/api/rendered-stack/warm' || proxyPath === '/api/viewer/rendered-stack/warm'
}

function isProgressiveAuditPath(proxyPath) {
  return proxyPath === '/api/experimental/progressive/audit' || proxyPath === '/api/viewer/progressive/audit'
}

async function proxyRenderedStackWarmRequest(req, res, proxyPath) {
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
    const response = await fetch(new URL(proxyPath, dicomwebPacsRoot), {
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

function isDicomwebMutation(method = 'GET') {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

function isCacheableDicomwebProxyRequest(req, proxyPath) {
  if (req.method !== 'GET') return false
  if (req.headers.range) return false

  const lowerPath = proxyPath.toLowerCase()
  if (lowerPath.startsWith('/api/viewer/')) return lowerPath.endsWith('/manifest')
  if (!lowerPath.startsWith('/rs')) return false
  if (lowerPath.includes('/frames/')) return false

  // Metadata must stay in lockstep with frame transfer syntax. Do not cache it:
  // stale metadata can make Cornerstone decode compressed frames as raw pixels.
  if (lowerPath.endsWith('/metadata')) return false

  return lowerPath === '/rs/studies'
    || lowerPath.endsWith('/series')
    || lowerPath.endsWith('/instances')
    || lowerPath.endsWith('/rendered')
}

function getDicomwebProxyCacheKey(req, targetUrl) {
  const acceptEncoding = targetUrl.pathname.toLowerCase().endsWith('/rendered')
    ? ''
    : String(req.headers['accept-encoding'] ?? '')

  return [
    req.method,
    targetUrl.href,
    String(req.headers.accept ?? ''),
    acceptEncoding,
    String(req.headers.authorization ?? ''),
    String(req.headers.cookie ?? ''),
  ].join('\n')
}

function getDicomwebProxyCache(cacheKey) {
  return dicomwebProxyCache.get(cacheKey)
}

function setDicomwebProxyCache(cacheKey, entry) {
  if (!cacheKey || entry.body.length > dicomwebProxyCacheMaxEntryBytes) return false
  return dicomwebProxyCache.set(cacheKey, entry, Math.max(1, entry.expiresAt - Date.now()))
}

function deleteDicomwebProxyCacheEntry(cacheKey) {
  dicomwebProxyCache.delete(cacheKey)
}

function clearDicomwebProxyCache() {
  dicomwebProxyCache.clear()
}

function getDicomwebProxyCacheTtlMs(proxyPath) {
  const lowerPath = proxyPath.toLowerCase()
  if (lowerPath === '/rs/studies') return 15 * 1000
  if (lowerPath.endsWith('/rendered')) return 30 * 60 * 1000
  return 10 * 60 * 1000
}

function shouldStoreDicomwebProxyResponse(proxyPath, proxyResponse, body) {
  const statusCode = proxyResponse.statusCode ?? 0
  if (statusCode < 200 || statusCode >= 300) return false
  if (!body.length || body.length > dicomwebProxyCacheMaxEntryBytes) return false

  const contentType = String(proxyResponse.headers['content-type'] ?? '').toLowerCase()
  if (contentType.includes('text/html')) return false
  if (String(proxyResponse.headers['cache-control'] ?? '').toLowerCase().includes('no-store')) return false

  const lowerPath = proxyPath.toLowerCase()
  if (lowerPath.endsWith('/metadata')) return false

  if (lowerPath.endsWith('/rendered')) {
    return contentType.startsWith('image/')
  }

  return contentType.includes('json') || contentType.includes('application/dicom')
}

function scheduleDicomwebWarmup(proxyPath, targetUrl, sourceHeaders, body) {
  if (!dicomwebWarmupEnabled || !body?.length) return
  const contentType = String(sourceHeaders.accept ?? '')
  if (!contentType.includes('json') && !contentType.includes('dicom') && !contentType.includes('*/*')) {
    return
  }

  const lowerPath = proxyPath.toLowerCase()
  const datasets = parseDicomJsonArray(body)
  if (!datasets.length) return

  if (lowerPath === '/rs/studies' && dicomwebWarmupMaxStudies > 0) {
    datasets
      .map((dataset) => getDicomJsonValue(dataset, '0020000D'))
      .filter(Boolean)
      .slice(0, dicomwebWarmupMaxStudies)
      .forEach((studyUid) => {
        const warmupUrl = new URL(`/rs/studies/${encodeURIComponent(studyUid)}/series`, dicomwebPacsRoot)
        queueDicomwebWarmup(warmupUrl, sourceHeaders)
      })
    return
  }

  if (lowerPath.endsWith('/series') && dicomwebWarmupMaxSeries > 0) {
    const studyUid = extractStudyUidFromRsPath(proxyPath)
    if (!studyUid) return
    datasets
      .map((dataset) => getDicomJsonValue(dataset, '0020000E'))
      .filter(Boolean)
      .slice(0, dicomwebWarmupMaxSeries)
      .forEach((seriesUid) => {
        const warmupUrl = new URL(`/rs/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances`, dicomwebPacsRoot)
        queueDicomwebWarmup(warmupUrl, sourceHeaders)
      })
  }
}

function queueDicomwebWarmup(targetUrl, sourceHeaders) {
  viewerJobQueue.add('dicomweb-warmup', {
    url: targetUrl.href,
    headers: {
      accept: String(sourceHeaders.accept ?? 'application/dicom+json, application/json, */*'),
      authorization: String(sourceHeaders.authorization ?? ''),
      cookie: String(sourceHeaders.cookie ?? ''),
    },
  }, { attempts: 1, delayMs: 20 })
}

async function warmDicomwebProxyRequest({ url, headers = {} }) {
  const targetUrl = new URL(url)
  const cacheKey = getDicomwebProxyCacheKey({ method: 'GET', headers }, targetUrl)
  if (getDicomwebProxyCache(cacheKey)) {
    return { warmed: false, reason: 'cache-hit' }
  }

  const requestFn = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest
  const body = await new Promise((resolve, reject) => {
    const chunks = []
    let bodyBytes = 0
    const req = requestFn(targetUrl, {
      method: 'GET',
      headers: {
        accept: headers.accept || 'application/dicom+json, application/json, */*',
        ...(headers.authorization ? { authorization: headers.authorization } : {}),
        ...(headers.cookie ? { cookie: headers.cookie } : {}),
      },
    }, (response) => {
      response.on('data', (chunk) => {
        chunks.push(chunk)
        bodyBytes += chunk.length
        if (bodyBytes > dicomwebProxyCacheMaxEntryBytes) {
          req.destroy()
        }
      })
      response.on('end', () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          resolve(null)
          return
        }
        const body = Buffer.concat(chunks, bodyBytes)
        const proxyPath = new URL(targetUrl.href).pathname
        if (!shouldStoreDicomwebProxyResponse(proxyPath, response, body)) {
          resolve(null)
          return
        }
        setDicomwebProxyCache(cacheKey, {
          statusCode: response.statusCode ?? 200,
          headers: sanitizeProxyHeaders(response.headers),
          body,
          expiresAt: Date.now() + getDicomwebProxyCacheTtlMs(proxyPath),
        })
        resolve(body)
      })
    })
    req.on('error', reject)
    req.end()
  }).catch(() => null)

  return { warmed: Boolean(body), bytes: body?.length ?? 0 }
}

function parseDicomJsonArray(body) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function getDicomJsonValue(dataset, tag) {
  const value = dataset?.[tag]?.Value?.[0]
  if (value && typeof value === 'object') {
    return value.Alphabetic || value.Ideographic || value.Phonetic || ''
  }
  return value === undefined || value === null ? '' : String(value)
}

function extractStudyUidFromRsPath(proxyPath) {
  const match = proxyPath.match(/\/rs\/studies\/([^/]+)/i)
  return match ? decodeURIComponent(match[1]) : ''
}

function sanitizeProxyHeaders(headers) {
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
  const sanitized = {}

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (hopByHopHeaders.has(lowerName) || lowerName === 'set-cookie' || value === undefined) {
      continue
    }
    sanitized[name] = value
  }

  return sanitized
}

function sendCachedDicomwebProxyResponse(req, res, entry) {
  res.statusCode = entry.statusCode
  for (const [name, value] of Object.entries(entry.headers)) {
    if (value !== undefined) res.setHeader(name, value)
  }
  res.setHeader('Content-Length', entry.body.length)
  res.setHeader('X-VEXA-Proxy-Cache', 'HIT')
  res.end(req.method === 'HEAD' ? undefined : entry.body)
}

async function getStaticFilePath(assetPath) {
  const info = await stat(assetPath)
  return info.isDirectory() ? join(assetPath, 'index.html') : assetPath
}

function sendWellKnownClientFile(requestedPath, res) {
  if (requestedPath === '/manifest.json') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify({
      name: 'VEXA Viewer',
      short_name: 'VEXA Viewer',
      display: 'standalone',
      start_url: '/',
    }))
    return true
  }

  if (requestedPath === '/init-service-worker.js' || requestedPath === '/service-worker.js') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(staleClientCleanupScript)
    return true
  }

  return false
}

function sendMissingAssetResponse(extension, res) {
  if (!extension) return false

  if (extension === '.js') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(staleClientCleanupScript)
    return true
  }

  if (extension === '.json') {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify({ error: 'Static asset not found' }))
    return true
  }

  if (['.css', '.png', '.jpg', '.jpeg', '.svg', '.wasm', '.map', '.ico'].includes(extension)) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end('Static asset not found')
    return true
  }

  return false
}

async function loadEnvFile() {
  try {
    const envText = await readFile(join(process.cwd(), '.env'), 'utf8')
    for (const rawLine of envText.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue

      const separatorIndex = line.indexOf('=')
      if (separatorIndex <= 0) continue

      const key = line.slice(0, separatorIndex).trim()
      const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '')
      process.env[key] ??= value
    }
  } catch {
    // Running without .env is valid when the deployment provides real environment variables.
  }
}
