import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, normalize } from 'node:path'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'

await loadEnvFile()
const require = createRequire(import.meta.url)
const { enforceLicenseAtStartup } = require('../../scripts/license/licenseRuntime')
enforceLicenseAtStartup('MOBILE_VIEWER')
const { handleAuthApi } = await import('./authApi.mjs')
const { handleMprApi } = await import('./mprEngine/mprApi.mjs')
const port = Number(process.env.PORT ?? 5992)
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

createServer(async (req, res) => {
  if (await handleAuthApi(req, res)) return
  if (await handleMprApi(req, res, `${dicomwebPacsRoot.origin}`)) return
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
}).listen(port, () => {
  console.log(`VEXA Mobile Viewer server listening on http://localhost:${port}`)
  console.log(`DICOMweb proxy forwarding /rs and /wadouri to ${dicomwebPacsRoot.origin}`)
})

function getClientAssetPath(pathname) {
  const decoded = decodeURIComponent(pathname || '/')
  const stripped = decoded.replace(/^\/mobile(?=\/|$)/i, '') || '/'
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

async function proxyDicomwebRequest(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const proxyPath = getClientAssetPath(requestUrl.pathname)
  if (!proxyPath.startsWith('/rs') && !proxyPath.startsWith('/api/viewer') && proxyPath !== '/wadouri') {
    return false
  }

  const targetUrl = new URL(`${proxyPath}${requestUrl.search}`, dicomwebPacsRoot)
  const requestFn = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = { ...req.headers, host: targetUrl.host }
  delete headers.origin

  await new Promise((resolve) => {
    const proxyRequest = requestFn(targetUrl, {
      method: req.method,
      headers,
    }, (proxyResponse) => {
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
      name: 'VEXA Mobile',
      short_name: 'VEXA Mobile',
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
