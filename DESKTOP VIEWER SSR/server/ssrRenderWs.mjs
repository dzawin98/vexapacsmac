import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { loadThinSeriesVolume } from './thinVolumeStore.mjs'

const require = createRequire(import.meta.url)
const jpeg = require('jpeg-js')
let sharp = null
try {
  sharp = require('sharp')
} catch {
  sharp = null
}
if (sharp) {
  sharp.concurrency(Math.max(2, Math.min(4, sharp.concurrency())))
  void warmImageEncoder()
}

const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const defaultWidth = 512
const defaultHeight = 512
const defaultDepth = 348

export function handleSsrRenderUpgrade(req, socket, head) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/api/render/ws') {
    return false
  }

  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return true
  }

  const accept = createHash('sha1').update(`${key}${websocketGuid}`).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'))

  const connection = createRenderConnection(socket)
  if (head?.length) {
    connection.receive(head)
  }
  return true
}

function createRenderConnection(socket) {
  const state = {
    id: randomUUID(),
    buffer: Buffer.alloc(0),
    sessionId: '',
    studyInstanceUid: '',
    seriesInstanceUid: '',
    slice: Math.floor(defaultDepth / 2),
    orientation: 'axial',
    windowWidth: 80,
    windowLevel: 35,
    slabThickness: 1,
    projection: 'normal',
    zoom: 1,
    panX: 0,
    panY: 0,
    invert: false,
    showCrosshair: true,
    lastRequestId: '',
    framesRendered: 0,
    closed: false,
    volume: null,
    messageQueue: [],
    processingQueue: false,
    nextMessageSequence: 0,
    lastPriority: 'high',
  }

  const connection = {
    receive(chunk) {
      state.buffer = Buffer.concat([state.buffer, chunk])
      drainClientFrames(socket, state)
    },
  }

  socket.on('data', (chunk) => connection.receive(chunk))
  socket.on('close', () => {
    state.closed = true
  })
  socket.on('error', () => {
    state.closed = true
  })

  sendJson(socket, {
    type: 'hello',
    protocol: 'vexa.thin-render.v1',
    connectionId: state.id,
    capabilities: {
      binaryJpegFrames: true,
      interactions: ['scroll', 'windowLevel', 'pan', 'zoom', 'reset', 'orientation', 'syncWorld', 'SYNC_POSITION'],
      orientations: ['axial', 'sagittal', 'coronal'],
      tools: ['probe-hu-server', 'geometry-metadata'],
    },
  })

  return connection
}

function drainClientFrames(socket, state) {
  while (state.buffer.length >= 2) {
    const parsed = tryParseClientFrame(state.buffer)
    if (!parsed) {
      return
    }

    state.buffer = state.buffer.subarray(parsed.bytesConsumed)
    if (parsed.opcode === 0x8) {
      sendClose(socket)
      socket.end()
      return
    }
    if (parsed.opcode === 0x9) {
      sendFrame(socket, parsed.payload, 0xA)
      continue
    }
    if (parsed.opcode !== 0x1) {
      continue
    }

    try {
      const message = JSON.parse(parsed.payload.toString('utf8'))
      enqueueClientMessage(socket, state, message)
    } catch (error) {
      sendJson(socket, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function enqueueClientMessage(socket, state, message) {
  if (message?.type === 'keepAlive') {
    sendJson(socket, {
      type: 'keepAlive',
      priority: normalizePriority(message.priority),
      at: Date.now(),
      requestAt: Number(message.at || 0),
    })
    return
  }

  state.messageQueue.push({
    message,
    priority: getMessagePriority(message),
    sequence: state.nextMessageSequence++,
  })
  state.messageQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)

  if (!state.processingQueue) {
    void processClientQueue(socket, state)
  }
}

async function processClientQueue(socket, state) {
  state.processingQueue = true
  try {
    while (!state.closed && state.messageQueue.length > 0) {
      const item = state.messageQueue.shift()
      await handleClientMessage(socket, state, item.message)
    }
  } catch (error) {
    sendJson(socket, {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    state.processingQueue = false
    if (!state.closed && state.messageQueue.length > 0) {
      void processClientQueue(socket, state)
    }
  }
}

function getMessagePriority(message) {
  const priority = normalizePriority(message?.priority)
  if (priority === 'high') return 0
  if (message?.type === 'interaction') return 2
  if (message?.type === 'openStudy') return 1
  return 10
}

function normalizePriority(priority) {
  return String(priority || '').toLowerCase() === 'low' ? 'low' : 'high'
}

function tryParseClientFrame(buffer) {
  if (buffer.length < 2) return null

  const first = buffer[0]
  const second = buffer[1]
  const opcode = first & 0x0f
  const masked = (second & 0x80) === 0x80
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    const high = buffer.readUInt32BE(offset)
    const low = buffer.readUInt32BE(offset + 4)
    if (high !== 0) {
      throw new Error('WebSocket payload is too large for this PoC server')
    }
    length = low
    offset += 8
  }

  let mask
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + length) return null

  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4]
    }
  }

  return {
    opcode,
    payload,
    bytesConsumed: offset + length,
  }
}

async function handleClientMessage(socket, state, message) {
  if (!message || typeof message !== 'object') {
    return
  }

  if (message.type === 'openStudy') {
    state.lastPriority = normalizePriority(message.priority)
    state.sessionId = randomUUID()
    state.studyInstanceUid = String(message.studyInstanceUid || '')
    state.seriesInstanceUid = String(message.seriesInstanceUid || '')
    state.orientation = normalizeOrientation(message.orientation)
    state.windowWidth = clampNumber(Number(message.windowWidth ?? state.windowWidth), 1, 4096)
    state.windowLevel = clampNumber(Number(message.windowLevel ?? state.windowLevel), -2048, 4096)
    state.slabThickness = clampNumber(Number(message.slabThickness ?? state.slabThickness), 0.1, 50)
    state.projection = normalizeProjection(message.projection)
    state.zoom = clampNumber(Number(message.zoom ?? 1), 0.25, 8)
    state.panX = 0
    state.panY = 0
    state.invert = Boolean(message.invert)
    state.showCrosshair = message.showCrosshair !== false

    state.volume = await loadThinSeriesVolume({
      studyInstanceUid: state.studyInstanceUid,
      seriesInstanceUid: state.seriesInstanceUid,
    })
    const requestedSopIndex = state.orientation === 'axial' && message.initialSopInstanceUid
      ? state.volume.sopInstanceUids?.indexOf(String(message.initialSopInstanceUid))
      : -1
    state.slice = clampInt(
      requestedSopIndex >= 0
        ? requestedSopIndex
        : Number(message.initialSlice ?? Math.floor(getPlaneDepth(state.volume, state.orientation) / 2)),
      0,
      getPlaneDepth(state.volume, state.orientation) - 1,
    )
    console.log(`[SSR WS] openStudy ${state.orientation} slice=${state.slice} renderInitial=${message.renderInitial !== false}`)
    sendJson(socket, buildSessionMetadata(state))
    if (message.renderInitial !== false) {
      await sendRenderedFrame(socket, state, message.requestId || randomUUID())
    }
    return
  }

  if (message.type === 'interaction') {
    state.lastPriority = normalizePriority(message.priority)
    applyInteraction(state, message)
    await sendRenderedFrame(socket, state, message.requestId || randomUUID())
    return
  }

  if (message.type === 'SYNC_POSITION' || message.type === 'syncPosition') {
    state.lastPriority = normalizePriority(message.priority)
    applySyncRenderSettings(state, message)
    await sendSyncPositionFrames(socket, state, message)
    return
  }

  if (message.type === 'probe') {
    if (state.volume) {
      state.orientation = normalizeOrientation(message.orientation || state.orientation)
      state.slice = clampInt(Number(message.slice ?? state.slice), 0, getPlaneDepth(state.volume, state.orientation) - 1)
    }
    const x = Number(message.x || 0)
    const y = Number(message.y || 0)
    sendJson(socket, {
      type: 'toolResult',
      tool: 'probe',
      requestId: message.requestId || '',
      x,
      y,
      slice: state.slice,
      orientation: state.orientation,
      hu: sampleRealHuFromCanvas(state, x, y),
      generatedAt: Date.now(),
    })
  }

  if (message.type === 'roi') {
    if (state.volume) {
      state.orientation = normalizeOrientation(message.orientation || state.orientation)
      state.slice = clampInt(Number(message.slice ?? state.slice), 0, getPlaneDepth(state.volume, state.orientation) - 1)
    }
    const result = calculateRoiStatsFromCanvas(state, String(message.shape || 'freehand'), Array.isArray(message.points) ? message.points : [])
    sendJson(socket, {
      type: 'toolResult',
      tool: 'roi',
      requestId: message.requestId || '',
      shape: result.shape,
      slice: state.slice,
      orientation: state.orientation,
      count: result.count,
      area: result.area,
      perimeter: result.perimeter,
      mean: result.mean,
      min: result.min,
      max: result.max,
      stdDev: result.stdDev,
      generatedAt: Date.now(),
    })
  }
}

function applyInteraction(state, message) {
  const action = String(message.action || '')
  if (message.slabThickness !== undefined) {
    state.slabThickness = clampNumber(Number(message.slabThickness), 0.1, 50)
  }
  if (message.projection !== undefined) {
    state.projection = normalizeProjection(message.projection)
  }
  if (action === 'scroll') {
    if (!state.volume) return
    const requestedDelta = Number(message.delta || 0)
    const step = clampInt(Math.trunc(requestedDelta), -24, 24)
    if (step !== 0) {
      state.slice = clampInt(state.slice + step, 0, getPlaneDepth(state.volume, state.orientation) - 1)
    }
    return
  }
  if (action === 'jump') {
    if (!state.volume) return
    state.slice = clampInt(Number(message.slice || state.slice), 0, getPlaneDepth(state.volume, state.orientation) - 1)
    return
  }
  if (action === 'syncWorld') {
    if (!state.volume) return
    state.orientation = normalizeOrientation(message.orientation || state.orientation)
    const slice = worldToPlaneSliceIndex(state.volume, state.orientation, message.worldPosition)
    if (typeof slice === 'number') {
      state.slice = clampInt(slice, 0, getPlaneDepth(state.volume, state.orientation) - 1)
    } else {
      state.slice = clampInt(Number(message.slice || state.slice), 0, getPlaneDepth(state.volume, state.orientation) - 1)
    }
    return
  }
  if (action === 'orientation') {
    if (!state.volume) return
    state.orientation = normalizeOrientation(message.orientation)
    state.slice = Math.floor(getPlaneDepth(state.volume, state.orientation) / 2)
    state.panX = 0
    state.panY = 0
    return
  }
  if (action === 'windowLevel') {
    state.windowWidth = clampNumber(state.windowWidth + Number(message.deltaWidth || 0), 1, 4096)
    state.windowLevel = clampNumber(state.windowLevel + Number(message.deltaLevel || 0), -2048, 4096)
    return
  }
  if (action === 'setWindowLevel') {
    state.windowWidth = clampNumber(Number(message.windowWidth ?? state.windowWidth), 1, 4096)
    state.windowLevel = clampNumber(Number(message.windowLevel ?? state.windowLevel), -2048, 4096)
    return
  }
  if (action === 'pan') {
    state.panX = clampNumber(state.panX + Number(message.deltaX || 0), -512, 512)
    state.panY = clampNumber(state.panY + Number(message.deltaY || 0), -512, 512)
    return
  }
  if (action === 'zoom') {
    state.zoom = clampNumber(state.zoom * (1 + Number(message.delta || 0)), 0.25, 8)
    return
  }
  if (action === 'setZoom') {
    state.zoom = clampNumber(Number(message.zoom ?? state.zoom), 0.25, 8)
    return
  }
  if (action === 'fit') {
    state.zoom = 1
    state.panX = 0
    state.panY = 0
    return
  }
  if (action === 'invert') {
    state.invert = !state.invert
    return
  }
  if (action === 'reset') {
    state.slice = state.volume ? Math.floor(getPlaneDepth(state.volume, state.orientation) / 2) : Math.floor(defaultDepth / 2)
    state.windowWidth = 80
    state.windowLevel = 35
    state.zoom = 1
    state.panX = 0
    state.panY = 0
    state.invert = false
  }
}

function buildSessionMetadata(state) {
  const volume = state.volume
  return {
    type: 'session',
    protocol: 'vexa.thin-render.v1',
    sessionId: state.sessionId,
    studyInstanceUid: state.studyInstanceUid,
    seriesInstanceUid: state.seriesInstanceUid,
    serverVolume: {
      bytes: volume.bytes,
      loadMs: volume.loadMs,
      transferSyntaxUid: volume.sourceTransferSyntaxUid,
      cachedAt: volume.createdAt,
    },
    geometry: {
      dimensions: volume.dimensions,
      spacing: volume.spacing,
      origin: volume.origin,
      direction: volume.direction,
      slope: volume.slope,
      intercept: volume.intercept,
      frameOfReferenceUid: `vexa-ssr-${state.studyInstanceUid || 'study'}`,
    },
    defaultViewport: {
      slice: state.slice,
      orientation: state.orientation,
      windowWidth: state.windowWidth,
      windowLevel: state.windowLevel,
      zoom: state.zoom,
      panX: state.panX,
      panY: state.panY,
    },
  }
}

async function sendSyncPositionFrames(socket, state, message) {
  const requestId = message.requestId || randomUUID()
  if (!state.volume) {
    sendJson(socket, {
      type: 'error',
      requestId,
      message: 'SSR volume is not loaded; refusing to sync MPR position.',
    })
    return
  }

  const position = normalizeWorldPosition(message.position)
  if (!position) {
    sendJson(socket, {
      type: 'error',
      requestId,
      message: 'SYNC_POSITION requires a valid patient world position [x,y,z].',
    })
    return
  }

  const planes = resliceAt(state.volume, position)
  sendJson(socket, {
    type: 'SYNC_POSITION_ACK',
    requestId,
    position: position.map(roundGeometry),
    frameOfReferenceUid: `vexa-ssr-${state.studyInstanceUid || 'study'}`,
    planes,
    generatedAt: Date.now(),
  })

  for (const orientation of ['axial', 'sagittal', 'coronal']) {
    const plane = planes[orientation]
    const frameState = {
      ...state,
      orientation,
      slice: plane.slice,
      showCrosshair: false,
    }
    await sendRenderedFrame(socket, frameState, `${requestId}:${orientation}`, {
      syncPositionRequestId: requestId,
      syncPosition: position.map(roundGeometry),
    })
  }
}

function applySyncRenderSettings(state, message) {
  if (message.windowWidth !== undefined) {
    state.windowWidth = clampNumber(Number(message.windowWidth), 1, 4096)
  }
  if (message.windowLevel !== undefined) {
    state.windowLevel = clampNumber(Number(message.windowLevel), -2048, 4096)
  }
  if (message.slabThickness !== undefined) {
    state.slabThickness = clampNumber(Number(message.slabThickness), 0.1, 50)
  }
  if (message.projection !== undefined) {
    state.projection = normalizeProjection(message.projection)
  }
  if (message.zoom !== undefined) {
    state.zoom = clampNumber(Number(message.zoom), 0.25, 8)
  }
}

function resliceAt(volume, position) {
  const result = {}
  for (const orientation of ['axial', 'sagittal', 'coronal']) {
    const depth = getPlaneDepth(volume, orientation)
    const rawSlice = worldToPlaneSliceIndex(volume, orientation, position)
    const slice = clampInt(
      Number.isFinite(rawSlice) ? Math.round(rawSlice) : Math.floor(depth / 2),
      0,
      depth - 1,
    )
    result[orientation] = {
      slice,
      totalSlices: depth,
    }
  }
  return result
}

function normalizeWorldPosition(value) {
  if (!Array.isArray(value) || value.length < 3) return null
  const point = [Number(value[0]), Number(value[1]), Number(value[2])]
  return point.every((part) => Number.isFinite(part)) ? point : null
}

async function sendRenderedFrame(socket, state, requestId, extraFrameFields = {}) {
  if (state.closed) return
  if (!state.volume) {
    sendJson(socket, {
      type: 'error',
      requestId,
      message: 'SSR volume is not loaded; refusing to render synthetic fallback.',
    })
    return
  }

  const startedAt = Date.now()
  const resliceStartedAt = Date.now()
  const image = renderVolumeFrame(state.volume, state)
  const resliceMs = Date.now() - resliceStartedAt
  const encodeStartedAt = Date.now()
  const { buffer: jpegBuffer, encoder } = await encodeRenderedImage(image)
  const encodeMs = Date.now() - encodeStartedAt
  const geometryStartedAt = Date.now()
  const geometry = getRenderedPlaneGeometry(state.volume, state, image.width, image.height)
  const geometryMs = Date.now() - geometryStartedAt
  const totalRenderMs = Date.now() - startedAt
  state.framesRendered += 1
  state.lastRequestId = requestId
  console.log(`[SSR WS] frame ${requestId} priority=${state.lastPriority} ${state.orientation} slice=${state.slice} reslice=${resliceMs}ms encode=${encodeMs}ms encoder=${encoder} geometry=${geometryMs}ms total=${totalRenderMs}ms bytes=${jpegBuffer.length} queued=${state.messageQueue.length}`)

  sendJson(socket, {
    type: 'frame',
    requestId,
    sessionId: state.sessionId,
    contentType: 'image/jpeg',
    width: image.width,
    height: image.height,
    byteLength: jpegBuffer.length,
    sopInstanceUid: state.orientation === 'axial' ? state.volume.sopInstanceUids?.[state.slice] || '' : '',
    slice: state.slice,
    orientation: state.orientation,
    totalSlices: getPlaneDepth(state.volume, state.orientation),
    windowWidth: Math.round(state.windowWidth),
    windowLevel: Math.round(state.windowLevel),
    zoom: Number(state.zoom.toFixed(3)),
    panX: Math.round(state.panX),
    panY: Math.round(state.panY),
    invert: state.invert,
    slabThickness: Number(state.slabThickness.toFixed(3)),
    projection: state.projection,
    framesRendered: state.framesRendered,
    renderMs: totalRenderMs,
    resliceMs,
    encodeMs,
    geometryMs,
    generatedAt: Date.now(),
    priority: state.lastPriority,
    pixelSpacing: geometry.pixelSpacing,
    rowPixelSpacing: geometry.rowPixelSpacing,
    columnPixelSpacing: geometry.columnPixelSpacing,
    imagePositionPatient: geometry.imagePositionPatient,
    imageOrientationPatient: geometry.imageOrientationPatient,
    frameOfReferenceUid: geometry.frameOfReferenceUid,
    renderedGeometry: geometry.renderedGeometry,
    ...extraFrameFields,
  })
  sendFrame(socket, jpegBuffer, 0x2)
}

async function encodeRenderedImage(image) {
  if (sharp) {
    const buffer = await sharp(image.data, {
      raw: {
        width: image.width,
        height: image.height,
        channels: 4,
      },
    })
      .jpeg({
        quality: 74,
        chromaSubsampling: '4:4:4',
        trellisQuantisation: false,
        overshootDeringing: false,
        optimizeScans: false,
      })
      .toBuffer()
    return { buffer, encoder: 'sharp' }
  }
  return { buffer: jpeg.encode(image, 74).data, encoder: 'jpeg-js' }
}

async function warmImageEncoder() {
  try {
    const data = Buffer.alloc(32 * 32 * 4, 0)
    await encodeRenderedImage({ data, width: 32, height: 32 })
    console.log('[SSR WS] sharp encoder warmed')
  } catch (error) {
    console.warn('[SSR WS] encoder warmup failed', error instanceof Error ? error.message : String(error))
  }
}

function renderVolumeFrame(volume, state) {
  const outputWidth = 512
  const outputHeight = 512
  const data = Buffer.allocUnsafe(outputWidth * outputHeight * 4)
  const plane = getPlaneDimensions(volume, state.orientation)
  const baseScale = Math.min(outputWidth / plane.physicalWidth, outputHeight / plane.physicalHeight)
  const scale = Math.max(0.01, baseScale * state.zoom)
  const centerX = outputWidth / 2 + state.panX
  const centerY = outputHeight / 2 + state.panY
  const depthSpacing = Math.max(0.001, Number(plane.depthSpacing || 1))
  const halfSlices = Math.max(0, Math.floor((Number(state.slabThickness || 1) / depthSpacing) / 2))

  if (halfSlices <= 0 && state.projection === 'normal') {
    renderNearestSingleSlice(volume, state, plane, data, outputWidth, outputHeight, scale, centerX, centerY)
    if (state.showCrosshair) {
      drawCrosshair(data, outputWidth, outputHeight, Math.round(centerX), Math.round(centerY))
    }
    return { data, width: outputWidth, height: outputHeight }
  }

  for (let y = 0; y < outputHeight; y += 1) {
    const physicalY = (y - centerY) / scale + plane.physicalHeight / 2
    const sourceY = physicalY / plane.spacingY
    for (let x = 0; x < outputWidth; x += 1) {
      const physicalX = (x - centerX) / scale + plane.physicalWidth / 2
      const sourceX = physicalX / plane.spacingX
      const hu = sampleProjectedVolumePlane(volume, state, plane, sourceX, sourceY)
      const gray = maybeInvertGray(windowHuToGray(hu, state.windowWidth, state.windowLevel), state.invert)
      const index = (y * outputWidth + x) * 4
      data[index] = gray
      data[index + 1] = gray
      data[index + 2] = gray
      data[index + 3] = 255
    }
  }

  if (state.showCrosshair) {
    drawCrosshair(data, outputWidth, outputHeight, Math.round(centerX), Math.round(centerY))
  }
  return { data, width: outputWidth, height: outputHeight }
}

function renderNearestSingleSlice(volume, state, plane, data, outputWidth, outputHeight, scale, centerX, centerY) {
  const [columns, rows, slices] = volume.dimensions
  const scalarData = volume.scalarData
  const sliceStride = rows * columns
  const low = state.windowLevel - state.windowWidth / 2
  const range = Math.max(1, state.windowWidth)
  const invert = Boolean(state.invert)
  const missGray = windowHuToGray(-1024, state.windowWidth, state.windowLevel)
  const finalMissGray = invert ? 255 - missGray : missGray
  const missPixel = 0xff000000 | (finalMissGray << 16) | (finalMissGray << 8) | finalMissGray
  const xSamples = new Int32Array(outputWidth)
  const ySamples = new Int32Array(outputHeight)
  const data32 = data.byteOffset % 4 === 0
    ? new Uint32Array(data.buffer, data.byteOffset, outputWidth * outputHeight)
    : null

  for (let x = 0; x < outputWidth; x += 1) {
    const physicalX = (x - centerX) / scale + plane.physicalWidth / 2
    xSamples[x] = Math.round(physicalX / plane.spacingX)
  }
  for (let y = 0; y < outputHeight; y += 1) {
    const physicalY = (y - centerY) / scale + plane.physicalHeight / 2
    ySamples[y] = Math.round(physicalY / plane.spacingY)
  }

  const axialSlice = clampInt(Math.round(state.slice), 0, Math.max(0, slices - 1))
  const sagittalColumn = clampInt(Math.round(state.slice), 0, Math.max(0, columns - 1))
  const coronalRow = clampInt(Math.round(state.slice), 0, Math.max(0, rows - 1))

  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = ySamples[y]
    let rowBase = -1
    let zBase = -1

    if (state.orientation === 'axial') {
      if (sourceY >= 0 && sourceY < rows) {
        rowBase = axialSlice * sliceStride + sourceY * columns
      }
    } else {
      const z = slices - 1 - sourceY
      if (z >= 0 && z < slices) {
        zBase = z * sliceStride
      }
    }

    if ((state.orientation === 'axial' && rowBase < 0) || (state.orientation !== 'axial' && zBase < 0)) {
      if (data32) {
        data32.fill(missPixel, y * outputWidth, (y + 1) * outputWidth)
      } else {
        data.fill(finalMissGray, y * outputWidth * 4, (y + 1) * outputWidth * 4)
        for (let alpha = y * outputWidth * 4 + 3; alpha < (y + 1) * outputWidth * 4; alpha += 4) {
          data[alpha] = 255
        }
      }
      continue
    }

    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = xSamples[x]
      let hu = -1024

      if (state.orientation === 'sagittal') {
        const row = sourceX
        if (zBase >= 0 && row >= 0 && row < rows) {
          hu = scalarData[zBase + row * columns + sagittalColumn] ?? -1024
        }
      } else if (state.orientation === 'coronal') {
        const column = sourceX
        if (zBase >= 0 && column >= 0 && column < columns) {
          hu = scalarData[zBase + coronalRow * columns + column] ?? -1024
        }
      } else if (rowBase >= 0 && sourceX >= 0 && sourceX < columns) {
        hu = scalarData[rowBase + sourceX] ?? -1024
      }

      let gray = hu === -1024
        ? missGray
        : Math.round(((hu - low) / range) * 255)
      if (gray < 0) gray = 0
      else if (gray > 255) gray = 255
      if (invert) gray = 255 - gray

      if (data32) {
        data32[y * outputWidth + x] = 0xff000000 | (gray << 16) | (gray << 8) | gray
      } else {
        const index = (y * outputWidth + x) * 4
        data[index] = gray
        data[index + 1] = gray
        data[index + 2] = gray
        data[index + 3] = 255
      }
    }
  }
}

function drawCrosshair(data, width, height, cx, cy) {
  for (let x = 0; x < width; x += 1) {
    blendPixel(data, width, height, x, cy, 80, 215, 190)
  }
  for (let y = 0; y < height; y += 1) {
    blendPixel(data, width, height, cx, y, 80, 215, 190)
  }
}

function blendPixel(data, width, height, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const index = (y * width + x) * 4
  data[index] = Math.round(data[index] * 0.45 + r * 0.55)
  data[index + 1] = Math.round(data[index + 1] * 0.45 + g * 0.55)
  data[index + 2] = Math.round(data[index + 2] * 0.45 + b * 0.55)
}

function sampleRealHuFromCanvas(state, x, y) {
  const volume = state.volume
  if (!volume) return Number.NaN
  const point = canvasToPlaneSource(state, x, y)
  return sampleVolumePlane(volume, state.orientation, state.slice, point.sourceX, point.sourceY)
}

function canvasToPlaneSource(state, x, y) {
  const volume = state.volume
  const plane = getPlaneDimensions(volume, state.orientation)
  const baseScale = Math.min(512 / plane.physicalWidth, 512 / plane.physicalHeight)
  const scale = Math.max(0.01, baseScale * state.zoom)
  const physicalX = (x - (512 / 2 + state.panX)) / scale + plane.physicalWidth / 2
  const physicalY = (y - (512 / 2 + state.panY)) / scale + plane.physicalHeight / 2
  return {
    physicalX,
    physicalY,
    sourceX: physicalX / plane.spacingX,
    sourceY: physicalY / plane.spacingY,
    pixelSpacing: 1 / scale,
  }
}

function calculateRoiStatsFromCanvas(state, rawShape, rawPoints) {
  const shape = normalizeRoiShape(rawShape)
  const points = rawPoints
    .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number.NaN, Number.NaN])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (!state.volume || points.length < 1) {
    return emptyRoiStats(shape)
  }

  const bounds = getRoiBounds(shape, points)
  if (!bounds) {
    return emptyRoiStats(shape)
  }

  let count = 0
  let sum = 0
  let sumSquares = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      if (!pointInRoi(shape, x + 0.5, y + 0.5, points, bounds)) {
        continue
      }
      const hu = sampleRealHuFromCanvas(state, x + 0.5, y + 0.5)
      if (!Number.isFinite(hu)) continue
      count += 1
      sum += hu
      sumSquares += hu * hu
      if (hu < min) min = hu
      if (hu > max) max = hu
    }
  }

  if (count <= 0) {
    return emptyRoiStats(shape)
  }

  const pixelSpacing = canvasToPlaneSource(state, points[0][0], points[0][1]).pixelSpacing
  const mean = sum / count
  const variance = Math.max(0, sumSquares / count - mean * mean)
  return {
    shape,
    count,
    area: count * pixelSpacing * pixelSpacing,
    perimeter: calculateCanvasPerimeter(shape, points, bounds) * pixelSpacing,
    mean,
    min,
    max,
    stdDev: Math.sqrt(variance),
  }
}

function normalizeRoiShape(shape) {
  const value = String(shape || '').toLowerCase()
  if (value === 'rectangle' || value === 'ellipse' || value === 'circle') return value
  return 'freehand'
}

function emptyRoiStats(shape) {
  return {
    shape,
    count: 0,
    area: Number.NaN,
    perimeter: Number.NaN,
    mean: Number.NaN,
    min: Number.NaN,
    max: Number.NaN,
    stdDev: Number.NaN,
  }
}

function getRoiBounds(shape, points) {
  if (shape === 'circle' && points.length >= 2) {
    const radius = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])
    return clampBounds(points[0][0] - radius, points[0][1] - radius, points[0][0] + radius, points[0][1] + radius)
  }
  if ((shape === 'rectangle' || shape === 'ellipse') && points.length >= 2) {
    return clampBounds(
      Math.min(points[0][0], points[1][0]),
      Math.min(points[0][1], points[1][1]),
      Math.max(points[0][0], points[1][0]),
      Math.max(points[0][1], points[1][1]),
    )
  }
  if (points.length < 3) return null
  return clampBounds(
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])),
  )
}

function clampBounds(minX, minY, maxX, maxY) {
  return {
    minX: clampInt(Math.floor(minX), 0, 511),
    minY: clampInt(Math.floor(minY), 0, 511),
    maxX: clampInt(Math.ceil(maxX), 0, 511),
    maxY: clampInt(Math.ceil(maxY), 0, 511),
  }
}

function pointInRoi(shape, x, y, points, bounds) {
  if (shape === 'rectangle') {
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
  }
  if (shape === 'circle' && points.length >= 2) {
    const radius = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])
    return Math.hypot(x - points[0][0], y - points[0][1]) <= radius
  }
  if (shape === 'ellipse') {
    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    const rx = Math.max(0.5, (bounds.maxX - bounds.minX) / 2)
    const ry = Math.max(0.5, (bounds.maxY - bounds.minY) / 2)
    return ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1
  }
  return pointInPolygon(x, y, points)
}

function pointInPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i][0]
    const yi = points[i][1]
    const xj = points[j][0]
    const yj = points[j][1]
    const intersects = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

function calculateCanvasPerimeter(shape, points, bounds) {
  if (shape === 'rectangle') {
    return 2 * (Math.abs(bounds.maxX - bounds.minX) + Math.abs(bounds.maxY - bounds.minY))
  }
  if (shape === 'circle' && points.length >= 2) {
    return 2 * Math.PI * Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])
  }
  if (shape === 'ellipse') {
    const a = Math.abs(bounds.maxX - bounds.minX) / 2
    const b = Math.abs(bounds.maxY - bounds.minY) / 2
    return Math.PI * (3 * (a + b) - Math.sqrt(Math.max(0, (3 * a + b) * (a + 3 * b))))
  }
  let length = 0
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  if (points.length > 2) {
    length += Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1])
  }
  return length
}

function getPlaneDimensions(volume, orientation) {
  const [columns, rows, slices] = volume?.dimensions || [defaultWidth, defaultHeight, 1]
  const [columnSpacing = 1, rowSpacing = 1, sliceSpacing = 1] = volume?.spacing || [1, 1, 1]
  if (orientation === 'sagittal') {
    return {
      width: rows,
      height: slices,
      depth: columns,
      spacingX: rowSpacing,
      spacingY: sliceSpacing,
      depthSpacing: columnSpacing,
      physicalWidth: Math.max(1, rows * rowSpacing),
      physicalHeight: Math.max(1, slices * sliceSpacing),
    }
  }
  if (orientation === 'coronal') {
    return {
      width: columns,
      height: slices,
      depth: rows,
      spacingX: columnSpacing,
      spacingY: sliceSpacing,
      depthSpacing: rowSpacing,
      physicalWidth: Math.max(1, columns * columnSpacing),
      physicalHeight: Math.max(1, slices * sliceSpacing),
    }
  }
  return {
    width: columns,
    height: rows,
    depth: slices,
    spacingX: columnSpacing,
    spacingY: rowSpacing,
    depthSpacing: sliceSpacing,
    physicalWidth: Math.max(1, columns * columnSpacing),
    physicalHeight: Math.max(1, rows * rowSpacing),
  }
}

function getPlaneDepth(volume, orientation) {
  return Math.max(1, getPlaneDimensions(volume, orientation).depth)
}

function worldToPlaneSliceIndex(volume, orientation, worldPosition) {
  if (!volume) return null
  const point = Array.isArray(worldPosition) && worldPosition.length >= 3
    ? [Number(worldPosition[0]), Number(worldPosition[1]), Number(worldPosition[2])]
    : null
  if (!point) return null
  if (!point.every((value) => Number.isFinite(value))) return null
  const origin = normalizePoint(volume.origin, [0, 0, 0])
  const [columnSpacing = 1, rowSpacing = 1, sliceSpacing = 1] = volume.spacing || [1, 1, 1]
  const { rowAxis, columnAxis, normalAxis } = getVolumeAxes(volume)
  const relative = [
    point[0] - origin[0],
    point[1] - origin[1],
    point[2] - origin[2],
  ]

  if (orientation === 'sagittal') {
    return dot(relative, rowAxis) / Math.max(0.001, columnSpacing)
  }
  if (orientation === 'coronal') {
    return dot(relative, columnAxis) / Math.max(0.001, rowSpacing)
  }
  return dot(relative, normalAxis) / Math.max(0.001, sliceSpacing)
}

function getRenderedPlaneGeometry(volume, state, outputWidth, outputHeight) {
  const plane = getPlaneDimensions(volume, state.orientation)
  const baseScale = Math.min(outputWidth / plane.physicalWidth, outputHeight / plane.physicalHeight)
  const scale = Math.max(0.01, baseScale * state.zoom)
  const centerX = outputWidth / 2 + state.panX
  const centerY = outputHeight / 2 + state.panY
  const topLeftPhysicalX = (0 - centerX) / scale + plane.physicalWidth / 2
  const topLeftPhysicalY = (0 - centerY) / scale + plane.physicalHeight / 2
  const pixelSpacing = 1 / scale
  const axes = getPlaneAxes(volume, state.orientation, state.slice)
  const imagePositionPatient = addVectors(
    axes.base,
    addVectors(
      scaleVector(axes.xAxis, topLeftPhysicalX),
      scaleVector(axes.yAxis, topLeftPhysicalY),
    ),
  )

  return {
    pixelSpacing: [roundGeometry(pixelSpacing), roundGeometry(pixelSpacing)],
    columnPixelSpacing: roundGeometry(pixelSpacing),
    rowPixelSpacing: roundGeometry(pixelSpacing),
    imagePositionPatient: imagePositionPatient.map(roundGeometry),
    imageOrientationPatient: [
      ...axes.xAxis.map(roundGeometry),
      ...axes.yAxis.map(roundGeometry),
    ],
    frameOfReferenceUid: `vexa-ssr-${volume.studyInstanceUid || 'study'}`,
    renderedGeometry: {
      orientation: state.orientation,
      slice: state.slice,
      outputWidth,
      outputHeight,
      sourceWidth: plane.width,
      sourceHeight: plane.height,
      physicalWidth: roundGeometry(plane.physicalWidth),
      physicalHeight: roundGeometry(plane.physicalHeight),
      scale: roundGeometry(scale),
      topLeftPhysicalX: roundGeometry(topLeftPhysicalX),
      topLeftPhysicalY: roundGeometry(topLeftPhysicalY),
    },
  }
}

function getPlaneAxes(volume, orientation, slice) {
  const [columns, rows, slices] = volume.dimensions || [defaultWidth, defaultHeight, 1]
  const [columnSpacing = 1, rowSpacing = 1, sliceSpacing = 1] = volume.spacing || [1, 1, 1]
  const { rowAxis, columnAxis, normalAxis } = getVolumeAxes(volume)
  const origin = normalizePoint(volume.origin, [0, 0, 0])

  if (orientation === 'sagittal') {
    return {
      xAxis: columnAxis,
      yAxis: scaleVector(normalAxis, -1),
      base: addVectors(
        origin,
        addVectors(
          scaleVector(rowAxis, clampInt(Math.round(slice), 0, Math.max(0, columns - 1)) * columnSpacing),
          scaleVector(normalAxis, Math.max(0, slices - 1) * sliceSpacing),
        ),
      ),
    }
  }

  if (orientation === 'coronal') {
    return {
      xAxis: rowAxis,
      yAxis: scaleVector(normalAxis, -1),
      base: addVectors(
        origin,
        addVectors(
          scaleVector(columnAxis, clampInt(Math.round(slice), 0, Math.max(0, rows - 1)) * rowSpacing),
          scaleVector(normalAxis, Math.max(0, slices - 1) * sliceSpacing),
        ),
      ),
    }
  }

  return {
    xAxis: rowAxis,
    yAxis: columnAxis,
    base: addVectors(
      origin,
      scaleVector(normalAxis, clampInt(Math.round(slice), 0, Math.max(0, slices - 1)) * sliceSpacing),
    ),
  }
}

function getVolumeAxes(volume) {
  const direction = Array.isArray(volume.direction) ? volume.direction : []
  const rowAxis = normalizeVector(direction.slice(0, 3), [1, 0, 0])
  const columnAxis = normalizeVector(direction.slice(3, 6), [0, 1, 0])
  const normalAxis = normalizeVector(direction.slice(6, 9), cross(rowAxis, columnAxis))
  return { rowAxis, columnAxis, normalAxis }
}

function sampleVolumePlane(volume, orientation, slice, sourceX, sourceY) {
  const x = Math.round(sourceX)
  const y = Math.round(sourceY)
  const [columns, rows, slices] = volume.dimensions

  if (orientation === 'sagittal') {
    const row = x
    const z = slices - 1 - y
    const column = slice
    return sampleVoxel(volume, column, row, z, columns, rows, slices)
  }

  if (orientation === 'coronal') {
    const column = x
    const z = slices - 1 - y
    const row = slice
    return sampleVoxel(volume, column, row, z, columns, rows, slices)
  }

  return sampleVoxel(volume, x, y, slice, columns, rows, slices)
}

function sampleProjectedVolumePlane(volume, state, plane, sourceX, sourceY) {
  const depthSpacing = Math.max(0.001, Number(plane.depthSpacing || 1))
  const halfSlices = Math.max(0, Math.floor((Number(state.slabThickness || 1) / depthSpacing) / 2))
  if (halfSlices <= 0 && state.projection === 'normal') {
    return sampleVolumePlane(volume, state.orientation, state.slice, sourceX, sourceY)
  }

  const depth = getPlaneDepth(volume, state.orientation)
  let count = 0
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let offset = -halfSlices; offset <= halfSlices; offset += 1) {
    const slice = clampInt(state.slice + offset, 0, depth - 1)
    const hu = sampleVolumePlane(volume, state.orientation, slice, sourceX, sourceY)
    if (!Number.isFinite(hu)) continue
    count += 1
    sum += hu
    if (hu < min) min = hu
    if (hu > max) max = hu
  }
  if (count < 1) return -1024
  if (state.projection === 'mip') return max
  if (state.projection === 'minip') return min
  return sum / count
}

function sampleVoxel(volume, column, row, slice, columns, rows, slices) {
  if (column < 0 || row < 0 || slice < 0 || column >= columns || row >= rows || slice >= slices) {
    return -1024
  }
  const index = slice * rows * columns + row * columns + column
  return volume.scalarData[index] ?? -1024
}

function normalizeOrientation(value) {
  const orientation = String(value || '').toLowerCase()
  if (orientation === 'sagittal' || orientation === 'coronal') return orientation
  return 'axial'
}

function normalizeProjection(value) {
  const projection = String(value || '').toLowerCase()
  if (projection === 'mip' || projection === 'minip') return projection
  return 'normal'
}

function windowHuToGray(hu, width, level) {
  const low = level - width / 2
  const high = level + width / 2
  const normalized = (hu - low) / Math.max(1, high - low)
  return clampInt(Math.round(normalized * 255), 0, 255)
}

function maybeInvertGray(gray, invert) {
  return invert ? 255 - gray : gray
}

function normalizePoint(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) return fallback
  return [
    Number.isFinite(Number(value[0])) ? Number(value[0]) : fallback[0],
    Number.isFinite(Number(value[1])) ? Number(value[1]) : fallback[1],
    Number.isFinite(Number(value[2])) ? Number(value[2]) : fallback[2],
  ]
}

function normalizeVector(value, fallback) {
  const vector = normalizePoint(value, fallback)
  const length = Math.hypot(vector[0], vector[1], vector[2])
  if (!Number.isFinite(length) || length <= 1e-8) return fallback
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

function addVectors(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scaleVector(vector, scale) {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function roundGeometry(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000
}

function sendJson(socket, payload) {
  sendFrame(socket, Buffer.from(JSON.stringify(payload), 'utf8'), 0x1)
}

function sendClose(socket) {
  sendFrame(socket, Buffer.alloc(0), 0x8)
}

function sendFrame(socket, payload, opcode) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(length, 6)
  }
  socket.write(Buffer.concat([header, payload]))
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)))
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}
