import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { authorizeViewerRequest } from './authApi.mjs'

const printSettingsPath = process.env.DICOM_PRINT_SETTINGS_PATH || join(fileURLToPath(new URL('.', import.meta.url)), 'dicom-print-settings.json')

const maxVideoBytes = Math.max(8 * 1024 * 1024, Number(process.env.VEXA_EXPORT_VIDEO_MAX_BYTES ?? 512 * 1024 * 1024))

// Resolved once per process; '' means "not probed yet", null means "not found".
let cachedFfmpegBinary

export function getViewerExportRuntimeStatus() {
  return {
    ffmpegConfigured: Boolean(process.env.FFMPEG_PATH),
    dicomPrintConfigured: Boolean(process.env.DICOM_PRINT_GATEWAY_URL),
  }
}

export async function probeFfmpegAvailability() {
  const binary = await resolveFfmpegBinary()
  let available = false
  try {
    available = await new Promise((resolve) => {
      const probe = spawn(binary, ['-version'], { windowsHide: true })
      probe.on('error', () => resolve(false))
      probe.on('close', (code) => resolve(code === 0))
    })
  } catch {
    available = false
  }
  return { available, binary: available ? binary : null, attempted: binary }
}

export async function handleViewerExportApi(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = requestUrl.pathname.replace(/^\/viewer(?=\/|$)/i, '') || '/'

  if (pathname === '/api/viewer/export/video') {
    if (req.method !== 'OPTIONS' && !await authorizeViewerRequest(req, 'viewer.export.use')) {
      sendJson(res, 403, { error: 'This role is not authorized to export viewer content.' })
      return true
    }
    await handleVideoExport(req, res, requestUrl)
    return true
  }

  if (pathname === '/api/viewer/dicom-print') {
    if (req.method !== 'OPTIONS' && !await authorizeViewerRequest(req, 'viewer.export.use')) {
      sendJson(res, 403, { error: 'This role is not authorized to export viewer content.' })
      return true
    }
    if (req.method === 'GET') {
      // Report whether cine export can actually run, not merely whether an env
      // var is set — the field install had neither, so the UI showed a format
      // list that always failed at the final encode step.
      const ffmpeg = await probeFfmpegAvailability()
      const settings = await readPrintSettings()
      sendJson(res, 200, {
        ...publicPrintSettings(settings),
        ...getViewerExportRuntimeStatus(),
        ffmpegAvailable: ffmpeg.available,
        ffmpegPath: ffmpeg.binary,
      })
      return true
    }
    await handleDicomPrint(req, res, requestUrl)
    return true
  }

  if (pathname === '/api/viewer/dicom-print/config') {
    const authorization = await authorizeViewerRequest(req, 'service.manage')
    if (!authorization) {
      sendJson(res, 403, { error: 'Forbidden' })
      return true
    }
    if (req.method === 'GET') {
      sendJson(res, 200, await readPrintSettings())
      return true
    }
    if (req.method === 'POST') {
      const body = await readJsonRequestBody(req, 1024 * 1024)
      const current = await readPrintSettings()
      const settings = normalizePrintSettings({
        ...body,
        filmProfiles: Array.isArray(body.filmProfiles) && body.filmProfiles.length ? body.filmProfiles : current.filmProfiles,
        identity: mergePrintIdentity(current.identity, body.identity),
      })
      await writeFile(`${printSettingsPath}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await import('node:fs/promises').then(({ rename }) => rename(`${printSettingsPath}.tmp`, printSettingsPath))
      sendJson(res, 200, settings)
      return true
    }
    sendJson(res, 405, { error: 'Method not allowed' })
    return true
  }

  return false
}

function mergePrintIdentity(current, incoming) {
  const previous = current && typeof current === 'object' ? current : {}
  const next = incoming && typeof incoming === 'object' ? incoming : {}
  return {
    ...previous,
    ...next,
    templates: { ...(previous.templates || {}), ...(next.templates || {}) },
    footerHeights: { ...(previous.footerHeights || {}), ...(next.footerHeights || {}) },
    logoSizes: { ...(previous.logoSizes || {}), ...(next.logoSizes || {}) },
  }
}

async function handleVideoExport(req, res, requestUrl) {
  if (req.method !== 'POST') {
    sendJson(res, req.method === 'OPTIONS' ? 204 : 405, req.method === 'OPTIONS' ? null : { error: 'Method not allowed' })
    return
  }

  const format = String(requestUrl.searchParams.get('format') ?? '').toLowerCase()
  if (!['mp4', 'avi', 'mpeg'].includes(format)) {
    sendJson(res, 400, { error: 'Video format must be MP4, AVI, or MPEG.' })
    return
  }
  const body = await readBinaryRequestBody(req, maxVideoBytes)
  if (!body) {
    sendJson(res, 413, { error: 'The video input is empty or exceeds the export limit.' })
    return
  }

  const fps = clampInteger(requestUrl.searchParams.get('fps'), 1, 60, 24)
  const safeName = sanitizeFileName(requestUrl.searchParams.get('filename') ?? 'vexa-export')
  const jobDirectory = await mkdtemp(join(tmpdir(), 'vexa-video-export-'))
  const inputPath = join(jobDirectory, 'input.webm')
  const outputPath = join(jobDirectory, `output.${format}`)

  try {
    await writeFile(inputPath, body)
    await runFfmpeg(inputPath, outputPath, format, fps)
    const output = await readFile(outputPath)
    const contentType = format === 'mp4' ? 'video/mp4' : format === 'avi' ? 'video/x-msvideo' : 'video/mpeg'
    res.statusCode = 200
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', output.length)
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.end(output)
  } catch (error) {
    sendJson(res, 500, {
      error: `Video conversion failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function handleDicomPrint(req, res, requestUrl) {
  if (req.method !== 'POST') {
    sendJson(res, req.method === 'OPTIONS' ? 204 : 405, req.method === 'OPTIONS' ? null : { error: 'Method not allowed' })
    return
  }

  const settings = await readPrintSettings()
  const printerId = String(requestUrl.searchParams.get('printerId') || '')
  const printer = settings.printers.find((item) => item.id === printerId && item.enabled !== false)
  if (!printer) {
    sendJson(res, 400, { error: 'Select an enabled DICOM printer destination.' })
    return
  }
  const gatewayUrl = printer.gatewayUrl || process.env.DICOM_PRINT_GATEWAY_URL
  const filmImage = await readBinaryRequestBody(req, 128 * 1024 * 1024)
  if (!filmImage) {
    sendJson(res, 400, { error: 'The rendered film image is empty or invalid.' })
    return
  }

  try {
    if (!gatewayUrl) {
      const result = await runDirectDicomPrint(filmImage, {
        ...printer,
        callingAet: settings.callingAet || 'VEXA_PRINT',
        filmSizeId: String(requestUrl.searchParams.get('filmSizeId') || '14INX17IN'),
        orientation: String(requestUrl.searchParams.get('orientation') || 'PORTRAIT').toUpperCase(),
        layout: String(requestUrl.searchParams.get('layout') || 'STANDARD\\1,1'),
      })
      sendJson(res, 202, result)
      return
    }
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        Accept: 'application/json',
        'X-VEXA-Print-File-Name': sanitizeFileName(requestUrl.searchParams.get('filename') ?? 'vexa-print'),
        'X-VEXA-Printer-ID': printer.id,
        'X-VEXA-Printer-AET': printer.aet,
        'X-VEXA-Printer-Host': printer.host,
        'X-VEXA-Printer-Port': String(printer.port),
        'X-VEXA-Calling-AET': settings.callingAet || 'VEXA_PRINT',
        'X-VEXA-Film-Size': String(requestUrl.searchParams.get('filmSizeId') || ''),
        'X-VEXA-Film-Orientation': String(requestUrl.searchParams.get('orientation') || 'PORTRAIT').toUpperCase(),
        'X-VEXA-Image-Display-Format': String(requestUrl.searchParams.get('layout') || 'STANDARD\\1,1'),
        ...(req.headers.authorization ? { Authorization: String(req.headers.authorization) } : {}),
      },
      body: filmImage,
    })
    const text = await response.text()
    if (!response.ok) {
      sendJson(res, response.status, { error: `DICOM Print gateway menolak dokumen: ${text.slice(0, 480) || response.statusText}` })
      return
    }
    let payload = { ok: true }
    try {
      payload = text ? JSON.parse(text) : payload
    } catch {
      // A 2xx gateway response without JSON still confirms print submission.
    }
    sendJson(res, 202, payload)
  } catch (error) {
    sendJson(res, 502, { error: `The DICOM print gateway could not be reached: ${error instanceof Error ? error.message : String(error)}` })
  }
}

async function runDirectDicomPrint(jpeg, config) {
  const jpegModule = await import('jpeg-js')
  const decoded = jpegModule.decode(jpeg, { useTArray: true, formatAsRGBA: true })
  if (!decoded?.width || !decoded?.height || !decoded?.data) throw new Error('Unable to decode the rendered film image.')
  const grayscale = Buffer.alloc(decoded.width * decoded.height)
  for (let source = 0, target = 0; target < grayscale.length; source += 4, target += 1) {
    grayscale[target] = Math.round(decoded.data[source] * 0.299 + decoded.data[source + 1] * 0.587 + decoded.data[source + 2] * 0.114)
  }
  const jobDirectory = await mkdtemp(join(tmpdir(), 'vexa-dicom-print-'))
  const configPath = join(jobDirectory, 'print.json')
  const rasterPath = join(jobDirectory, 'film.gray')
  try {
    await writeFile(configPath, JSON.stringify({ ...config, width: decoded.width, height: decoded.height }), 'utf8')
    await writeFile(rasterPath, grayscale)
    const python = process.env.DICOM_PRINT_PYTHON || join(process.cwd(), '..', 'RIS', 'backend', 'mwl_scp', '.venv', 'Scripts', 'python.exe')
    const script = join(fileURLToPath(new URL('.', import.meta.url)), 'dicom_print_scu.py')
    const result = await runProcess(python, [script, configPath, rasterPath])
    let payload
    try { payload = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}') } catch { payload = null }
    if (result.code !== 0 || !payload?.ok) throw new Error(payload?.error || result.stderr.trim() || 'DICOM Print SCU failed.')
    return payload
  } finally {
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runProcess(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function readPrintSettings() {
  try {
    const parsed = JSON.parse(await readFile(printSettingsPath, 'utf8'))
    return {
      callingAet: String(parsed.callingAet || 'VEXA_PRINT'),
      printers: Array.isArray(parsed.printers) ? parsed.printers : [],
      filmProfiles: Array.isArray(parsed.filmProfiles) ? parsed.filmProfiles : [],
      identity: parsed.identity && typeof parsed.identity === 'object' ? parsed.identity : {},
    }
  } catch {
    return { callingAet: 'VEXA_PRINT', printers: [], filmProfiles: [], identity: {} }
  }
}

function normalizePrintSettings(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    callingAet: String(source.callingAet || 'VEXA_PRINT').trim().slice(0, 16),
    printers: (Array.isArray(source.printers) ? source.printers : []).map((item, index) => ({
      id: String(item.id || `printer-${index + 1}`).trim(),
      name: String(item.name || `DICOM Printer ${index + 1}`).trim(),
      aet: String(item.aet || '').trim().slice(0, 16),
      host: String(item.host || '').trim(),
      port: Math.min(65535, Math.max(1, Number(item.port) || 104)),
      gatewayUrl: String(item.gatewayUrl || '').trim(),
      enabled: item.enabled !== false,
    })).filter((item) => item.aet && item.host),
    filmProfiles: Array.isArray(source.filmProfiles) ? source.filmProfiles : [],
    identity: source.identity && typeof source.identity === 'object' ? source.identity : {},
  }
}

async function readJsonRequestBody(req, maxBytes) {
  const body = await readBinaryRequestBody(req, maxBytes)
  if (!body) return {}
  try { return JSON.parse(body.toString('utf8')) } catch { return {} }
}

function publicPrintSettings(settings) {
  return {
    configured: settings.printers.some((item) => item.enabled !== false && item.aet && item.host && item.port),
    printers: settings.printers.filter((item) => item.enabled !== false).map(({ gatewayUrl, ...item }) => item),
    filmProfiles: settings.filmProfiles,
    identity: settings.identity,
  }
}

async function resolveFfmpegBinary() {
  if (cachedFfmpegBinary !== undefined) return cachedFfmpegBinary

  const candidates = []
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  // Bundled runtime shipped by the installer next to this server.
  candidates.push(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tools', 'ffmpeg', 'ffmpeg.exe'))
  candidates.push(join(process.cwd(), 'tools', 'ffmpeg', 'ffmpeg.exe'))
  const bundled = findBundledFfmpeg()
  if (bundled) candidates.push(bundled)

  for (const candidate of candidates) {
    try {
      if (candidate && (await stat(candidate)).isFile()) {
        cachedFfmpegBinary = candidate
        return cachedFfmpegBinary
      }
    } catch {
      // try the next candidate
    }
  }

  // Fall back to PATH; on failure the caller reports a precise message.
  cachedFfmpegBinary = process.env.FFMPEG_PATH || 'ffmpeg'
  return cachedFfmpegBinary
}

function findBundledFfmpeg() {
  const roots = [
    join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'ffmpeg'),
    join(process.cwd(), '..', '..', 'tools', 'ffmpeg'),
    process.env.VEXA_FFMPEG_DIR || '',
  ].filter(Boolean)
  const names = ['ffmpeg.exe', 'ffmpeg']
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name)
      try {
        if (require$statSyncSafe(candidate)) return candidate
      } catch {
        // keep looking
      }
    }
  }
  return ''
}

function require$statSyncSafe(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

async function runFfmpeg(inputPath, outputPath, format, fps) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-an', '-r', String(fps)]
  if (format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath)
  } else if (format === 'avi') {
    args.push('-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p', outputPath)
  } else {
    args.push('-c:v', 'mpeg2video', '-q:v', '3', '-f', 'mpeg', outputPath)
  }
  const binary = await resolveFfmpegBinary()
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    // A missing binary surfaces as a raw ENOENT whose message ("spawn ffmpeg
    // ENOENT") never reaches the user usefully, because the handler then
    // reports the generic "encoding failed". Trap it and say what is wrong.
    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        reject(new Error(
          'FFmpeg was not found on the viewer server. '
          + 'Run the latest installer (FFmpeg is bundled) or set the FFMPEG_PATH variable to ffmpeg.exe.',
        ))
        return
      }
      reject(error)
    })
    child.on('close', (code) => resolve({ code, stderr, binary }))
  })
  if (result.code !== 0) {
    const detail = result.stderr.trim()
    if (!detail && result.code === -4058) {
      throw new Error('FFmpeg could not be started (binary not found). Check FFMPEG_PATH for the VexaDesktopViewer service.')
    }
    throw new Error(detail || `FFmpeg failed to encode the video (exit code ${result.code}).`)
  }
}

async function readBinaryRequestBody(req, maxBytes) {
  return new Promise((resolve) => {
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
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks, bytes)))
    req.on('error', () => resolve(null))
  })
}

function sanitizeFileName(value) {
  return basename(String(value || 'vexa-export').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()).slice(0, 96) || 'vexa-export'
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function sendJson(res, statusCode, payload) {
  const body = payload === null ? '' : JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  if (body) res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}
