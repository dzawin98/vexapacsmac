import { Enums, imageLoader, metaData, type Types } from '@cornerstonejs/core'
import type { InstanceSummary, SeriesSummary, StudySummary } from '../../dicomweb/types'

type Orientation = 'axial' | 'sagittal' | 'coronal'
type SsrProjection = 'normal' | 'mip' | 'minip'

type VexaSsrDescriptor = {
  imageId: string
  studyInstanceUid: string
  seriesInstanceUid: string
  index: number
  orientation: Orientation
  rows: number
  columns: number
  rowPixelSpacing: number
  columnPixelSpacing: number
  sliceSpacing: number
  imagePositionPatient: number[]
  imageOrientationPatient: number[]
  frameOfReferenceUid: string
  windowCenter: number
  windowWidth: number
  slabThickness: number
  projection: SsrProjection
  modality: string
}

type FrameInfo = {
  type: 'frame'
  requestId: string
  width: number
  height: number
  slice: number
  orientation: Orientation
  totalSlices: number
  windowWidth: number
  windowLevel: number
  slabThickness?: number
  projection?: SsrProjection
  byteLength: number
  renderMs: number
  pixelSpacing?: [number, number]
  rowPixelSpacing?: number
  columnPixelSpacing?: number
  imagePositionPatient?: number[]
  imageOrientationPatient?: number[]
  frameOfReferenceUid?: string
  renderedGeometry?: Record<string, unknown>
  syncPositionRequestId?: string
  syncPosition?: number[]
}

type ProbeResult = {
  type: 'toolResult'
  tool: 'probe'
  requestId: string
  x: number
  y: number
  slice: number
  orientation: Orientation
  hu: number
  generatedAt: number
}

type RoiStatsResult = {
  type: 'toolResult'
  tool: 'roi'
  requestId: string
  shape: 'rectangle' | 'ellipse' | 'circle' | 'freehand'
  slice: number
  orientation: Orientation
  count: number
  area: number
  perimeter: number
  mean: number
  min: number
  max: number
  stdDev: number
  generatedAt: number
}

type SessionMessage = {
  type: 'session'
  geometry?: {
    dimensions?: number[]
    spacing?: number[]
    origin?: number[]
    direction?: number[]
    frameOfReferenceUid?: string
  }
}

type SyncPositionAck = {
  type: 'SYNC_POSITION_ACK'
  requestId: string
  position: Types.Point3
  frameOfReferenceUid?: string
  planes?: Partial<Record<Orientation, { slice: number; totalSlices: number }>>
}

type PendingRequest = {
  descriptor: VexaSsrDescriptor
  requestId: string
  priority: 'high' | 'low'
  resolve: (value: { frame: FrameInfo; bytes: ArrayBuffer }) => void
  reject: (reason?: unknown) => void
}

type SsrConnection = {
  key: string
  priority: 'high' | 'low'
  socket: WebSocket | null
  opened: boolean
  opening: Promise<void> | null
  chain: Promise<unknown>
  keepAliveTimer: number | null
  pending: Map<string, PendingRequest>
  pendingProbe: Map<string, { resolve: (value: ProbeResult) => void; reject: (reason?: unknown) => void }>
  pendingRoi: Map<string, { resolve: (value: RoiStatsResult) => void; reject: (reason?: unknown) => void }>
  pendingSyncPosition: Map<string, PendingSyncPosition>
  pendingFrame: FrameInfo | null
  session?: SessionMessage
}

type PendingSyncPosition = {
  requestId: string
  sourceDescriptor: VexaSsrDescriptor
  imageIdsByOrientation: Record<Orientation, string[]>
  requestedPosition: Types.Point3
  frames: Partial<Record<Orientation, { frame: FrameInfo; bytes: ArrayBuffer }>>
  ack?: SyncPositionAck
  resolve: (value: SyncPositionResult) => void
  reject: (reason?: unknown) => void
  timeoutId: number
}

export type SyncPositionResult = {
  requestId: string
  position: Types.Point3
  frameOfReferenceUid?: string
  planes: Partial<Record<Orientation, { imageId: string; imageIndex: number; frame: FrameInfo }>>
}

type CachedSsrFrame = {
  frame: FrameInfo
  bytes: ArrayBuffer
  bitmap?: ImageBitmap
  lastUsedAt: number
}

type FrameRequestOptions = {
  worldPoint?: Types.Point3
  frameOfReferenceUid?: string
}

type VexaSsrLoaderGlobal = typeof globalThis & {
  __vexaSsrDescriptors?: Map<string, VexaSsrDescriptor>
  __vexaSsrImageCache?: Map<string, Types.IImage>
  __vexaSsrFrameCache?: Map<string, CachedSsrFrame>
  __vexaSsrConnections?: Map<string, SsrConnection>
  __vexaSsrDebugFrames?: Array<Record<string, unknown>>
}

const loaderGlobal = globalThis as VexaSsrLoaderGlobal
const descriptors = loaderGlobal.__vexaSsrDescriptors ?? new Map<string, VexaSsrDescriptor>()
const imageCache = loaderGlobal.__vexaSsrImageCache ?? new Map<string, Types.IImage>()
const frameCache = loaderGlobal.__vexaSsrFrameCache ?? new Map<string, CachedSsrFrame>()
const connections = loaderGlobal.__vexaSsrConnections ?? new Map<string, SsrConnection>()
const frameRequests = new Map<string, Promise<CachedSsrFrame>>()
const decodeCanvasPool: HTMLCanvasElement[] = []
const prefetchQueue = new Map<string, VexaSsrDescriptor>()
loaderGlobal.__vexaSsrDescriptors = descriptors
loaderGlobal.__vexaSsrImageCache = imageCache
loaderGlobal.__vexaSsrFrameCache = frameCache
loaderGlobal.__vexaSsrConnections = connections

let initialized = false
const IMAGE_CACHE_LIMIT = 192
const FRAME_CACHE_LIMIT = 192
const DESCRIPTOR_LIMIT = 4096
const PREFETCH_FRAME_INTERVAL_MS = 22
let prefetchTimer: number | null = null
let prefetchInFlight = false
let prefetchGeneration = 0

export function initializeVexaSsrImageLoader() {
  if (initialized) return
  imageLoader.registerImageLoader('vexa-ssr', loadVexaSsrImage)
  metaData.addProvider(vexaSsrMetadataProvider, 11_000)
  initialized = true
}

export function createVexaSsrStackImageIds(input: {
  study?: StudySummary | null
  series: SeriesSummary
  instances: InstanceSummary[]
  windowLevel: { windowWidth: number; windowLevel: number }
}) {
  // listInstances() already returns anatomical slice order. Preserve it so the
  // server volume index, displayed SOP metadata, and measurement geometry agree.
  const sorted = [...input.instances]
  if (sorted.length < 1) {
    return []
  }
  const first = sorted[0]
  const spacing = readPixelSpacing(first)
  const sliceSpacing = estimateSliceSpacing(sorted)
  const orientation = first?.imageOrientationPatient?.length === 6 ? first.imageOrientationPatient : [1, 0, 0, 0, 1, 0]
  const frameOfReferenceUid = `vexa-ssr-${input.series.studyInstanceUid}`
  return sorted.map((instance, index) => {
    const descriptor: Omit<VexaSsrDescriptor, 'imageId'> = {
      studyInstanceUid: input.series.studyInstanceUid,
      seriesInstanceUid: input.series.seriesInstanceUid,
      index,
      orientation: 'axial',
      rows: 512,
      columns: 512,
      rowPixelSpacing: spacing[0],
      columnPixelSpacing: spacing[1],
      sliceSpacing,
      imagePositionPatient: instance.imagePositionPatient?.length === 3
        ? instance.imagePositionPatient
        : estimateImagePosition(first?.imagePositionPatient, orientation, sliceSpacing, index),
      imageOrientationPatient: orientation,
      frameOfReferenceUid,
      windowCenter: input.windowLevel.windowLevel,
      windowWidth: input.windowLevel.windowWidth,
      slabThickness: 1,
      projection: 'normal',
      modality: input.series.modality || 'CT',
    }
    return registerDescriptor(descriptor)
  })
}

export function createVexaSsrMprImageIds(input: {
  study?: StudySummary | null
  series: SeriesSummary
  instances: InstanceSummary[]
  orientation: Orientation
  windowLevel: { windowWidth: number; windowLevel: number }
  slabThickness?: number
  projection?: SsrProjection
}) {
  const sorted = [...input.instances]
  if (sorted.length < 1) {
    return []
  }
  const first = sorted[0]
  const spacing = readPixelSpacing(first)
  const sliceSpacing = estimateSliceSpacing(sorted)
  const sourceRows = first?.rows || 512
  const sourceColumns = first?.columns || 512
  const sourceSlices = Math.max(1, sorted.length)
  const volumeGeometry = getSourceVolumeGeometry(first, spacing, sliceSpacing, sourceSlices)
  const count = input.orientation === 'sagittal'
    ? sourceColumns
    : input.orientation === 'coronal'
      ? sourceRows
      : sourceSlices
  const frameOfReferenceUid = `vexa-ssr-${input.series.studyInstanceUid}`
  const planeSpacing = getPlaneSpacing(input.orientation, spacing, sliceSpacing)
  const orientationPatient = getPlaneOrientation(input.orientation, volumeGeometry)
  const planePositions = getPlaneImagePositions(input.orientation, count, volumeGeometry)
  const slabThickness = clampSlabThickness(input.slabThickness)
  const projection = normalizeProjection(input.projection)

  return Array.from({ length: count }, (_, index) => registerDescriptor({
    studyInstanceUid: input.series.studyInstanceUid,
    seriesInstanceUid: input.series.seriesInstanceUid,
    index,
    orientation: input.orientation,
    rows: 512,
    columns: 512,
    rowPixelSpacing: planeSpacing.row,
    columnPixelSpacing: planeSpacing.column,
    sliceSpacing: planeSpacing.depth,
    imagePositionPatient: planePositions[index] ?? [0, 0, index * planeSpacing.depth],
    imageOrientationPatient: orientationPatient,
    frameOfReferenceUid,
    windowCenter: input.windowLevel.windowLevel,
    windowWidth: input.windowLevel.windowWidth,
    slabThickness,
    projection,
    modality: input.series.modality || 'CT',
  }))
}

export async function requestVexaSsrProbe(imageId: string, canvasPoint: Types.Point2) {
  const descriptor = descriptors.get(imageId)
  if (!descriptor) {
    throw new Error(`Vexa SSR descriptor not found for probe: ${imageId}`)
  }
  const connection = getConnection(descriptor)
  await ensureConnectionOpen(connection, descriptor)
  const socket = connection.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('Vexa SSR WebSocket is not open')
  }
  const requestId = `vexa-ssr-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = new Promise<ProbeResult>((resolve, reject) => {
    connection.pendingProbe.set(requestId, { resolve, reject })
    window.setTimeout(() => {
      const pending = connection.pendingProbe.get(requestId)
      if (!pending) return
      connection.pendingProbe.delete(requestId)
      reject(new Error('Vexa SSR probe timed out'))
    }, 8_000)
  })
  socket.send(JSON.stringify({
    type: 'probe',
    requestId,
    orientation: descriptor.orientation,
    slice: descriptor.index,
    x: canvasPoint[0],
    y: canvasPoint[1],
  }))
  return result
}

export function getVexaSsrWindowLevel(imageId: string) {
  const descriptor = descriptors.get(imageId)
  return descriptor
    ? { windowWidth: descriptor.windowWidth, windowLevel: descriptor.windowCenter }
    : null
}

export function getNearestVexaSsrImageIndexForWorldPoint(imageIds: string[], worldPoint: Types.Point3) {
  let nearestIndex: number | null = null
  let nearestDistance = Number.POSITIVE_INFINITY

  imageIds.forEach((imageId, index) => {
    const descriptor = descriptors.get(imageId)
    if (!descriptor) return

    const normal = cross(
      descriptor.imageOrientationPatient.slice(0, 3),
      descriptor.imageOrientationPatient.slice(3, 6),
    )
    const distance = Math.abs(
      (worldPoint[0] - descriptor.imagePositionPatient[0]) * normal[0]
      + (worldPoint[1] - descriptor.imagePositionPatient[1]) * normal[1]
      + (worldPoint[2] - descriptor.imagePositionPatient[2]) * normal[2],
    )

    if (Number.isFinite(distance) && distance < nearestDistance) {
      nearestDistance = distance
      nearestIndex = index
    }
  })

  return nearestIndex
}

export function setVexaSsrWindowLevel(imageId: string, windowLevel: { windowWidth: number; windowLevel: number }) {
  const descriptor = descriptors.get(imageId)
  if (!descriptor) return false
  descriptor.windowWidth = clampPositive(windowLevel.windowWidth, descriptor.windowWidth)
  descriptor.windowCenter = Number.isFinite(windowLevel.windowLevel) ? windowLevel.windowLevel : descriptor.windowCenter
  imageCache.delete(imageId)
  evictFrameCacheEntry(imageId)
  return true
}

export async function requestVexaSsrFrameBitmap(imageId: string, priority: 'high' | 'low' = 'high') {
  const descriptor = descriptors.get(imageId)
  if (!descriptor) {
    throw new Error(`Vexa SSR descriptor not found: ${imageId}`)
  }
  const cached = await fetchVexaSsrFrame(descriptor, priority)
  cached.lastUsedAt = Date.now()
  await ensureCachedFrameBitmap(cached)
  return {
    imageId,
    frame: cached.frame,
    bitmap: cached.bitmap!,
  }
}

export async function requestVexaSsrFrameForWorldPoint(
  imageIds: string[],
  worldPoint: Types.Point3,
  priority: 'high' | 'low' = 'high',
) {
  const targetIndex = getNearestVexaSsrImageIndexForWorldPoint(imageIds, worldPoint)
  if (typeof targetIndex !== 'number') {
    return null
  }

  const targetImageId = imageIds[targetIndex]
  const descriptor = descriptors.get(targetImageId)
  if (!descriptor) {
    return null
  }

  const cached = await fetchVexaSsrFrame(descriptor, priority, {
    worldPoint,
    frameOfReferenceUid: descriptor.frameOfReferenceUid,
  })
  cached.lastUsedAt = Date.now()

  const serverIndex = Number.isFinite(cached.frame.slice)
    ? Math.max(0, Math.min(imageIds.length - 1, Math.round(cached.frame.slice)))
    : targetIndex
  const serverImageId = imageIds[serverIndex] ?? targetImageId
  if (serverImageId !== targetImageId) {
    frameCache.set(serverImageId, cached)
    imageCache.delete(serverImageId)
    enforceFrameCacheLimit()
  }

  return {
    imageId: serverImageId,
    imageIndex: serverIndex,
    frame: cached.frame,
  }
}

export async function requestVexaSsrSyncPosition(input: {
  sourceImageId: string
  worldPoint: Types.Point3
  imageIdsByOrientation: Record<Orientation, string[]>
  priority?: 'high' | 'low'
}) {
  const sourceDescriptor = descriptors.get(input.sourceImageId)
  if (!sourceDescriptor) {
    throw new Error(`Vexa SSR descriptor not found for sync position: ${input.sourceImageId}`)
  }

  const worldPoint = normalizeWorldPoint(input.worldPoint)
  if (!worldPoint) {
    throw new Error('Vexa SSR sync position requires a valid world point')
  }

  const priority = input.priority ?? 'high'
  const connection = getConnection(sourceDescriptor, priority)
  await ensureConnectionOpen(connection, sourceDescriptor)
  const socket = connection.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('Vexa SSR WebSocket is not open')
  }

  const requestId = `vexa-ssr-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = new Promise<SyncPositionResult>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      const pending = connection.pendingSyncPosition.get(requestId)
      if (!pending) return
      connection.pendingSyncPosition.delete(requestId)
      reject(new Error('Vexa SSR sync position timed out'))
    }, 20_000)
    connection.pendingSyncPosition.set(requestId, {
      requestId,
      sourceDescriptor,
      imageIdsByOrientation: input.imageIdsByOrientation,
      requestedPosition: worldPoint,
      frames: {},
      resolve,
      reject,
      timeoutId,
    })
  })

  socket.send(JSON.stringify({
    type: 'SYNC_POSITION',
    requestId,
    position: worldPoint,
    frameOfReferenceUid: sourceDescriptor.frameOfReferenceUid,
    windowWidth: sourceDescriptor.windowWidth,
    windowLevel: sourceDescriptor.windowCenter,
    slabThickness: sourceDescriptor.slabThickness,
    projection: sourceDescriptor.projection,
    priority,
  }))

  return result
}

export function prefetchVexaSsrFrames(imageIds: string[]) {
  prefetchGeneration += 1
  prefetchQueue.clear()
  if (prefetchTimer !== null) {
    window.clearTimeout(prefetchTimer)
    prefetchTimer = null
  }

  for (const imageId of imageIds) {
    const descriptor = descriptors.get(imageId)
    if (!descriptor || isVexaSsrFrameCached(imageId)) continue
    prefetchQueue.set(imageId, descriptor)
  }

  drainPrefetchQueue(prefetchGeneration)
  return Promise.resolve()
}

export function isVexaSsrFrameCached(imageId: string) {
  return frameCache.has(imageId) || imageCache.has(imageId) || frameRequests.has(imageId)
}

export function getCachedVexaSsrFrameBitmap(imageId: string) {
  const cached = frameCache.get(imageId)
  if (!cached?.bitmap) return null
  cached.lastUsedAt = Date.now()
  return {
    imageId,
    frame: cached.frame,
    bitmap: cached.bitmap,
  }
}

export async function requestVexaSsrRoiStats(input: {
  imageId: string
  shape: 'rectangle' | 'ellipse' | 'circle' | 'freehand'
  points: Types.Point2[]
}) {
  const descriptor = descriptors.get(input.imageId)
  if (!descriptor) {
    throw new Error(`Vexa SSR descriptor not found for ROI: ${input.imageId}`)
  }
  const connection = getConnection(descriptor)
  await ensureConnectionOpen(connection, descriptor)
  const socket = connection.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('Vexa SSR WebSocket is not open')
  }
  const requestId = `vexa-ssr-roi-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = new Promise<RoiStatsResult>((resolve, reject) => {
    connection.pendingRoi.set(requestId, { resolve, reject })
    window.setTimeout(() => {
      const pending = connection.pendingRoi.get(requestId)
      if (!pending) return
      connection.pendingRoi.delete(requestId)
      reject(new Error('Vexa SSR ROI timed out'))
    }, 12_000)
  })
  socket.send(JSON.stringify({
    type: 'roi',
    requestId,
    orientation: descriptor.orientation,
    slice: descriptor.index,
    shape: input.shape,
    points: input.points.map(([x, y]) => [x, y]),
  }))
  return result
}

function registerDescriptor(input: Omit<VexaSsrDescriptor, 'imageId'>) {
  const imageId = [
    'vexa-ssr',
    safePart(input.studyInstanceUid),
    safePart(input.seriesInstanceUid),
    input.orientation,
    input.index,
    Math.round(input.windowWidth),
    Math.round(input.windowCenter),
    Math.round(input.slabThickness * 10),
    input.projection,
  ].join(':')
  descriptors.set(imageId, { ...input, imageId })
  while (descriptors.size > DESCRIPTOR_LIMIT) {
    const oldest = descriptors.keys().next().value
    if (!oldest) break
    descriptors.delete(oldest)
  }
  return imageId
}

function loadVexaSsrImage(imageId: string) {
  const descriptor = descriptors.get(imageId)
  const cached = imageCache.get(imageId)
  const promise = descriptor
    ? cached
      ? Promise.resolve(cached)
      : fetchVexaSsrFrame(descriptor, 'high').then(async ({ frame, bytes }) => {
        const image = await createImageFromJpeg(descriptor, frame, bytes)
        imageCache.set(imageId, image)
        while (imageCache.size > IMAGE_CACHE_LIMIT) {
          const oldest = imageCache.keys().next().value
          if (!oldest) break
          imageCache.delete(oldest)
        }
        return image
      })
    : Promise.reject(new Error(`Vexa SSR descriptor not found: ${imageId}`))
  return {
    promise,
    cancelFn: () => undefined,
    decache: () => {
      imageCache.delete(imageId)
      evictFrameCacheEntry(imageId)
    },
  }
}

function fetchVexaSsrFrame(
  descriptor: VexaSsrDescriptor,
  priority: 'high' | 'low',
  options?: FrameRequestOptions,
) {
  const cached = frameCache.get(descriptor.imageId)
  if (cached) {
    cached.lastUsedAt = Date.now()
    return Promise.resolve(cached)
  }
  const pending = frameRequests.get(descriptor.imageId)
  if (pending) return pending

  const request = requestSsrFrame(descriptor, priority, options)
    .then(({ frame, bytes }) => {
      const cachedFrame: CachedSsrFrame = { frame, bytes, lastUsedAt: Date.now() }
      frameCache.set(descriptor.imageId, cachedFrame)
      enforceFrameCacheLimit()
      return cachedFrame
    })
    .finally(() => {
      frameRequests.delete(descriptor.imageId)
    })

  frameRequests.set(descriptor.imageId, request)
  return request
}

async function ensureCachedFrameBitmap(cached: CachedSsrFrame) {
  if (!cached.bitmap) {
    cached.bitmap = await createImageBitmap(new Blob([cached.bytes], { type: 'image/jpeg' }))
  }
  cached.lastUsedAt = Date.now()
  return cached
}

function requestSsrFrame(
  descriptor: VexaSsrDescriptor,
  priority: 'high' | 'low' = 'high',
  options?: FrameRequestOptions,
) {
  if (priority === 'high') {
    prefetchGeneration += 1
    prefetchQueue.clear()
    if (prefetchTimer !== null) {
      window.clearTimeout(prefetchTimer)
      prefetchTimer = null
    }
  }
  const connection = getConnection(descriptor, priority)
  connection.chain = connection.chain
    .catch(() => undefined)
    .then(() => requestSsrFrameOnConnection(connection, descriptor, priority, options))
  return connection.chain as Promise<{ frame: FrameInfo; bytes: ArrayBuffer }>
}

function drainPrefetchQueue(generation: number) {
  if (prefetchInFlight || generation !== prefetchGeneration || prefetchQueue.size < 1) {
    return
  }

  const next = prefetchQueue.entries().next().value as [string, VexaSsrDescriptor] | undefined
  if (!next) return
  const [imageId, descriptor] = next
  prefetchQueue.delete(imageId)

  if (isVexaSsrFrameCached(imageId)) {
    scheduleNextPrefetch(generation, 0)
    return
  }

  prefetchInFlight = true
  fetchVexaSsrFrame(descriptor, 'low')
    .then((cached) => ensureCachedFrameBitmap(cached))
    .catch(() => undefined)
    .finally(() => {
      prefetchInFlight = false
      scheduleNextPrefetch(generation, PREFETCH_FRAME_INTERVAL_MS)
    })
}

function scheduleNextPrefetch(generation: number, delayMs: number) {
  if (generation !== prefetchGeneration || prefetchQueue.size < 1) return
  if (prefetchTimer !== null) {
    window.clearTimeout(prefetchTimer)
  }
  prefetchTimer = window.setTimeout(() => {
    prefetchTimer = null
    drainPrefetchQueue(generation)
  }, delayMs)
}

async function requestSsrFrameOnConnection(
  connection: SsrConnection,
  descriptor: VexaSsrDescriptor,
  priority: 'high' | 'low',
  options?: FrameRequestOptions,
) {
  await ensureConnectionOpen(connection, descriptor)
  const socket = connection.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('Vexa SSR WebSocket is not open')
  }
  const requestId = `vexa-ssr-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = new Promise<{ frame: FrameInfo; bytes: ArrayBuffer }>((resolve, reject) => {
    connection.pending.set(requestId, { descriptor, requestId, priority, resolve, reject })
    window.setTimeout(() => {
      const pending = connection.pending.get(requestId)
      if (!pending) return
      connection.pending.delete(requestId)
      reject(new Error('Vexa SSR frame timed out'))
    }, 20_000)
  })
  const worldPoint = Array.isArray(options?.worldPoint)
    ? options.worldPoint.map((value) => Number(value))
    : null
  socket.send(JSON.stringify({
    type: 'interaction',
    action: worldPoint ? 'syncWorld' : 'jump',
    slice: descriptor.index,
    orientation: descriptor.orientation,
    worldPosition: worldPoint,
    frameOfReferenceUid: options?.frameOfReferenceUid || descriptor.frameOfReferenceUid,
    slabThickness: descriptor.slabThickness,
    projection: descriptor.projection,
    requestId,
    priority,
  }))
  return result
}

function getConnection(descriptor: VexaSsrDescriptor, priority: 'high' | 'low' = 'high') {
  const key = [
    descriptor.studyInstanceUid,
    descriptor.seriesInstanceUid,
    descriptor.orientation,
    Math.round(descriptor.windowWidth),
    Math.round(descriptor.windowCenter),
    Math.round(descriptor.slabThickness * 10),
    descriptor.projection,
    priority,
  ].join('|')
  let connection = connections.get(key)
  if (!connection) {
    connection = {
      key,
      priority,
      socket: null,
      opened: false,
      opening: null,
      chain: Promise.resolve(),
      keepAliveTimer: null,
      pending: new Map(),
      pendingProbe: new Map(),
      pendingRoi: new Map(),
      pendingSyncPosition: new Map(),
      pendingFrame: null,
    }
    connections.set(key, connection)
  }
  return connection
}

function ensureConnectionOpen(connection: SsrConnection, descriptor: VexaSsrDescriptor) {
  if (connection.opened && connection.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (connection.opening) return connection.opening

  connection.opening = new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(defaultRenderWsUrl())
    connection.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'openStudy',
        requestId: `open-${Date.now()}`,
        studyInstanceUid: descriptor.studyInstanceUid,
        seriesInstanceUid: descriptor.seriesInstanceUid,
        initialSlice: descriptor.index,
        orientation: descriptor.orientation,
        showCrosshair: false,
        windowWidth: descriptor.windowWidth,
        windowLevel: descriptor.windowCenter,
        slabThickness: descriptor.slabThickness,
        projection: descriptor.projection,
        renderInitial: false,
        priority: connection.priority,
      }))
    }
    socket.onerror = () => reject(new Error('Vexa SSR WebSocket failed'))
    socket.onclose = () => {
      connection.opened = false
      connection.opening = null
      connection.socket = null
      if (connection.keepAliveTimer !== null) {
        window.clearInterval(connection.keepAliveTimer)
        connection.keepAliveTimer = null
      }
      for (const pending of connection.pending.values()) {
        pending.reject(new Error('Vexa SSR WebSocket closed'))
      }
      connection.pending.clear()
      for (const pending of connection.pendingProbe.values()) {
        pending.reject(new Error('Vexa SSR WebSocket closed'))
      }
      connection.pendingProbe.clear()
      for (const pending of connection.pendingRoi.values()) {
        pending.reject(new Error('Vexa SSR WebSocket closed'))
      }
      connection.pendingRoi.clear()
      for (const pending of connection.pendingSyncPosition.values()) {
        window.clearTimeout(pending.timeoutId)
        pending.reject(new Error('Vexa SSR WebSocket closed'))
      }
      connection.pendingSyncPosition.clear()
    }
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleSsrJson(connection, event.data, resolve)
        return
      }
      handleSsrBinary(connection, event.data)
    }
  })
  return connection.opening
}

function handleSsrJson(connection: SsrConnection, raw: string, resolveOpen: () => void) {
  const message = JSON.parse(raw) as SessionMessage | FrameInfo | SyncPositionAck | { type?: string; requestId?: string; message?: string }
  if (message.type === 'session') {
    connection.session = message as SessionMessage
    connection.opened = true
    if (connection.keepAliveTimer !== null) {
      window.clearInterval(connection.keepAliveTimer)
    }
    connection.keepAliveTimer = window.setInterval(() => {
      const socket = connection.socket
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'keepAlive', at: Date.now(), priority: connection.priority }))
      }
    }, 15_000)
    resolveOpen()
    return
  }
  if (message.type === 'frame') {
    connection.pendingFrame = message as FrameInfo
    return
  }
  if (message.type === 'SYNC_POSITION_ACK') {
    const ack = message as SyncPositionAck
    const pending = connection.pendingSyncPosition.get(ack.requestId)
    if (pending) {
      pending.ack = ack
    }
    return
  }
  if (message.type === 'error') {
    const requestId = message.requestId || ''
    const pending = connection.pending.get(requestId)
    if (pending) {
      connection.pending.delete(requestId)
      pending.reject(new Error(message.message || 'Vexa SSR render error'))
    }
    const pendingProbe = connection.pendingProbe.get(requestId)
    if (pendingProbe) {
      connection.pendingProbe.delete(requestId)
      pendingProbe.reject(new Error(message.message || 'Vexa SSR probe error'))
    }
    const pendingRoi = connection.pendingRoi.get(requestId)
    if (pendingRoi) {
      connection.pendingRoi.delete(requestId)
      pendingRoi.reject(new Error(message.message || 'Vexa SSR ROI error'))
    }
    const pendingSync = connection.pendingSyncPosition.get(requestId)
    if (pendingSync) {
      connection.pendingSyncPosition.delete(requestId)
      window.clearTimeout(pendingSync.timeoutId)
      pendingSync.reject(new Error(message.message || 'Vexa SSR sync position error'))
    }
    return
  }
  if (message.type === 'toolResult' && (message as ProbeResult).tool === 'probe') {
    const probe = message as ProbeResult
    const pending = connection.pendingProbe.get(probe.requestId)
    if (pending) {
      connection.pendingProbe.delete(probe.requestId)
      pending.resolve(probe)
    }
    return
  }
  if (message.type === 'toolResult' && (message as RoiStatsResult).tool === 'roi') {
    const roi = message as RoiStatsResult
    const pending = connection.pendingRoi.get(roi.requestId)
    if (pending) {
      connection.pendingRoi.delete(roi.requestId)
      pending.resolve(roi)
    }
  }
}

function handleSsrBinary(connection: SsrConnection, data: Blob | ArrayBuffer) {
  const frame = connection.pendingFrame
  if (!frame) return
  connection.pendingFrame = null
  const pending = connection.pending.get(frame.requestId)
  if (!pending) {
    const syncRequestId = getSyncPositionRequestId(frame)
    const pendingSync = syncRequestId ? connection.pendingSyncPosition.get(syncRequestId) : undefined
    if (!pendingSync) return

    const resolveSyncFrame = (bytes: ArrayBuffer) => {
      pendingSync.frames[frame.orientation] = { frame, bytes }
      maybeResolveSyncPosition(connection, pendingSync)
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then(resolveSyncFrame).catch(pendingSync.reject)
      return
    }
    resolveSyncFrame(data)
    return
  }
  connection.pending.delete(frame.requestId)
  if (data instanceof Blob) {
    void data.arrayBuffer().then((bytes) => pending.resolve({ frame, bytes })).catch(pending.reject)
    return
  }
  pending.resolve({ frame, bytes: data })
}

function getSyncPositionRequestId(frame: FrameInfo) {
  if (typeof frame.syncPositionRequestId === 'string' && frame.syncPositionRequestId) {
    return frame.syncPositionRequestId
  }
  const separator = frame.requestId.lastIndexOf(':')
  if (separator < 1) return ''
  const suffix = frame.requestId.slice(separator + 1)
  return suffix === 'axial' || suffix === 'sagittal' || suffix === 'coronal'
    ? frame.requestId.slice(0, separator)
    : ''
}

function maybeResolveSyncPosition(connection: SsrConnection, pending: PendingSyncPosition) {
  const orientations: Orientation[] = ['axial', 'sagittal', 'coronal']
  if (!orientations.every((orientation) => pending.frames[orientation])) {
    return
  }

  const planes: SyncPositionResult['planes'] = {}
  for (const orientation of orientations) {
    const synced = pending.frames[orientation]
    if (!synced) continue
    const imageIds = pending.imageIdsByOrientation[orientation] ?? []
    if (!imageIds.length) continue
    const imageIndex = clampFrameIndex(synced.frame.slice, imageIds.length)
    const imageId = imageIds[imageIndex]
    if (!imageId) continue

    frameCache.set(imageId, { frame: synced.frame, bytes: synced.bytes, lastUsedAt: Date.now() })
    imageCache.delete(imageId)
    planes[orientation] = { imageId, imageIndex, frame: synced.frame }
  }
  enforceFrameCacheLimit()

  connection.pendingSyncPosition.delete(pending.requestId)
  window.clearTimeout(pending.timeoutId)
  pending.resolve({
    requestId: pending.requestId,
    position: pending.ack?.position ?? pending.requestedPosition,
    frameOfReferenceUid: pending.ack?.frameOfReferenceUid ?? pending.sourceDescriptor.frameOfReferenceUid,
    planes,
  })
}

function enforceFrameCacheLimit() {
  while (frameCache.size > FRAME_CACHE_LIMIT) {
    let oldestKey = ''
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, frame] of frameCache) {
      if (frame.lastUsedAt < oldestAt) {
        oldestAt = frame.lastUsedAt
        oldestKey = key
      }
    }
    if (!oldestKey) break
    evictFrameCacheEntry(oldestKey)
  }
}

function evictFrameCacheEntry(imageId: string) {
  const cached = frameCache.get(imageId)
  if (cached?.bitmap) {
    try {
      cached.bitmap.close()
    } catch {
      // Some browsers may already have released the bitmap; cache eviction should be best effort.
    }
  }
  frameCache.delete(imageId)
}

async function createImageFromJpeg(descriptor: VexaSsrDescriptor, frame: FrameInfo, bytes: ArrayBuffer) {
  const blob = new Blob([bytes], { type: 'image/jpeg' })
  const bitmap = await createImageBitmap(blob)
  const canvas = acquireDecodeCanvas()
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    releaseDecodeCanvas(canvas)
    throw new Error('Unable to decode Vexa SSR JPEG frame')
  }
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
  const pixelData = new Float32Array(canvas.width * canvas.height)
  let minPixelValue = 255
  let maxPixelValue = 0
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
    const value = rgba[source]
    pixelData[target] = value
    if (value < minPixelValue) minPixelValue = value
    if (value > maxPixelValue) maxPixelValue = value
  }

  const rows = frame.height || canvas.height
  const columns = frame.width || canvas.width
  const geometry = resolveFrameGeometry(descriptor, frame, rows, columns)
  descriptor.rows = rows
  descriptor.columns = columns
  descriptor.rowPixelSpacing = geometry.rowPixelSpacing
  descriptor.columnPixelSpacing = geometry.columnPixelSpacing
  descriptor.imagePositionPatient = geometry.imagePositionPatient
  descriptor.imageOrientationPatient = geometry.imageOrientationPatient
  descriptor.frameOfReferenceUid = geometry.frameOfReferenceUid

  const image = {
    imageId: descriptor.imageId,
    intercept: 0,
    slope: 1,
    minPixelValue,
    maxPixelValue,
    windowCenter: [127.5],
    windowWidth: [255],
    voiLUTFunction: Enums.VOILUTFunctionType.LINEAR,
    getPixelData: () => pixelData,
    getCanvas: undefined,
    rows,
    columns,
    height: rows,
    width: columns,
    color: false,
    rgba: false,
    numberOfComponents: 1,
    columnPixelSpacing: geometry.columnPixelSpacing,
    rowPixelSpacing: geometry.rowPixelSpacing,
    sliceThickness: descriptor.sliceSpacing,
    invert: false,
    photometricInterpretation: 'MONOCHROME2',
    sizeInBytes: pixelData.byteLength,
    imageQualityStatus: Enums.ImageQualityStatus.FULL_RESOLUTION,
    FrameOfReferenceUID: geometry.frameOfReferenceUid,
    imagePositionPatient: geometry.imagePositionPatient,
    imageOrientationPatient: geometry.imageOrientationPatient,
    interpolation: false,
    dataType: 'Float32Array',
    imageFrame: {
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      planarConfiguration: 0,
      rows,
      columns,
      bitsAllocated: 32,
      bitsStored: 32,
      highBit: 31,
      pixelRepresentation: 1,
      smallestPixelValue: minPixelValue,
      largestPixelValue: maxPixelValue,
      redPaletteColorLookupTableDescriptor: [],
      greenPaletteColorLookupTableDescriptor: [],
      bluePaletteColorLookupTableDescriptor: [],
      redPaletteColorLookupTableData: [],
      greenPaletteColorLookupTableData: [],
      bluePaletteColorLookupTableData: [],
      pixelData,
      imageId: descriptor.imageId,
      windowCenter: 127.5,
      windowWidth: 255,
      imageQualityStatus: Enums.ImageQualityStatus.FULL_RESOLUTION,
      imagePositionPatient: geometry.imagePositionPatient,
      imageOrientationPatient: geometry.imageOrientationPatient,
      rowPixelSpacing: geometry.rowPixelSpacing,
      columnPixelSpacing: geometry.columnPixelSpacing,
    },
  } as unknown as Types.IImage

  loaderGlobal.__vexaSsrDebugFrames = [
    ...(loaderGlobal.__vexaSsrDebugFrames ?? []),
    {
      imageId: descriptor.imageId,
      orientation: descriptor.orientation,
      index: descriptor.index,
      slabThickness: descriptor.slabThickness,
      projection: descriptor.projection,
      rows,
      columns,
      minPixelValue,
      maxPixelValue,
      scalarLength: pixelData.length,
      hasVoxelManager: Boolean(image.voxelManager),
      firstPixels: Array.from(pixelData.slice(0, 12)),
    },
  ].slice(-24)

  if (import.meta.env.DEV) {
    console.info('[VEXA SSR IMAGE] ' + JSON.stringify({
    imageId: descriptor.imageId,
    orientation: descriptor.orientation,
    index: descriptor.index,
    rows,
    columns,
    minPixelValue,
    maxPixelValue,
    scalarLength: pixelData.length,
    firstPixels: Array.from(pixelData.slice(0, 12)),
    }))
  }
  releaseDecodeCanvas(canvas)
  return image
}

function acquireDecodeCanvas() {
  return decodeCanvasPool.pop() ?? document.createElement('canvas')
}

function releaseDecodeCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  context?.clearRect(0, 0, canvas.width, canvas.height)
  canvas.width = 1
  canvas.height = 1
  if (decodeCanvasPool.length < 4) {
    decodeCanvasPool.push(canvas)
  }
}

function resolveFrameGeometry(descriptor: VexaSsrDescriptor, frame: FrameInfo, rows: number, columns: number) {
  const pixelSpacing = Array.isArray(frame.pixelSpacing) ? frame.pixelSpacing : null
  const columnPixelSpacing = positiveNumber(
    frame.columnPixelSpacing,
    positiveNumber(pixelSpacing?.[0], descriptor.columnPixelSpacing),
  )
  const rowPixelSpacing = positiveNumber(
    frame.rowPixelSpacing,
    positiveNumber(pixelSpacing?.[1], descriptor.rowPixelSpacing),
  )
  return {
    rows,
    columns,
    rowPixelSpacing,
    columnPixelSpacing,
    imagePositionPatient: normalizeVector(frame.imagePositionPatient, descriptor.imagePositionPatient, 3),
    imageOrientationPatient: normalizeVector(frame.imageOrientationPatient, descriptor.imageOrientationPatient, 6),
    frameOfReferenceUid: typeof frame.frameOfReferenceUid === 'string' && frame.frameOfReferenceUid
      ? frame.frameOfReferenceUid
      : descriptor.frameOfReferenceUid,
  }
}

function vexaSsrMetadataProvider(type: string, imageId: string) {
  const descriptor = descriptors.get(imageId)
  if (!descriptor) return undefined
  if (type === 'imagePlaneModule') {
    const [rowX, rowY, rowZ, columnX, columnY, columnZ] = descriptor.imageOrientationPatient
    return {
      frameOfReferenceUID: descriptor.frameOfReferenceUid,
      FrameOfReferenceUID: descriptor.frameOfReferenceUid,
      rows: descriptor.rows,
      columns: descriptor.columns,
      rowCosines: [rowX, rowY, rowZ],
      columnCosines: [columnX, columnY, columnZ],
      imageOrientationPatient: descriptor.imageOrientationPatient,
      imagePositionPatient: descriptor.imagePositionPatient,
      rowPixelSpacing: descriptor.rowPixelSpacing,
      columnPixelSpacing: descriptor.columnPixelSpacing,
      pixelSpacing: [descriptor.rowPixelSpacing, descriptor.columnPixelSpacing],
    }
  }
  if (type === 'imagePixelModule') {
    return {
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      rows: descriptor.rows,
      columns: descriptor.columns,
      bitsAllocated: 32,
      bitsStored: 32,
      highBit: 31,
      pixelRepresentation: 1,
    }
  }
  if (type === 'voiLutModule') {
    return { windowCenter: [127.5], windowWidth: [255] }
  }
  if (type === 'modalityLutModule') {
    return { rescaleIntercept: 0, rescaleSlope: 1, rescaleType: 'US' }
  }
  if (type === 'generalSeriesModule') {
    return { modality: descriptor.modality, seriesInstanceUID: descriptor.seriesInstanceUid }
  }
  if (type === 'generalImageModule') {
    return { instanceNumber: descriptor.index + 1 }
  }
  return undefined
}

function defaultRenderWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/render/ws`
}

function readPixelSpacing(instance?: InstanceSummary): [number, number] {
  const spacing = readNumberList(instance?.metadata?.['00280030'])
  const row = Number(spacing[0])
  const column = Number(spacing[1])
  return [
    Number.isFinite(row) && row > 0 ? row : 1,
    Number.isFinite(column) && column > 0 ? column : 1,
  ]
}

function readNumberList(element: { Value?: unknown[] } | undefined) {
  return (element?.Value || []).map((value) => Number(value)).filter((value) => Number.isFinite(value))
}

function estimateSliceSpacing(instances: InstanceSummary[]) {
  if (instances.length > 1) {
    const first = instances[0]?.imagePositionPatient
    const second = instances[1]?.imagePositionPatient
    if (first?.length === 3 && second?.length === 3) {
      const distance = Math.hypot(second[0] - first[0], second[1] - first[1], second[2] - first[2])
      if (Number.isFinite(distance) && distance > 0) return distance
    }
  }
  return 1
}

function estimateImagePosition(origin: number[] | undefined, orientation: number[], sliceSpacing: number, index: number) {
  const normal = cross(orientation.slice(0, 3), orientation.slice(3, 6))
  return [
    (origin?.[0] || 0) + normal[0] * sliceSpacing * index,
    (origin?.[1] || 0) + normal[1] * sliceSpacing * index,
    (origin?.[2] || 0) + normal[2] * sliceSpacing * index,
  ]
}

function getPlaneSpacing(orientation: Orientation, spacing: [number, number], sliceSpacing: number) {
  if (orientation === 'sagittal') return { row: sliceSpacing, column: spacing[0], depth: spacing[1] }
  if (orientation === 'coronal') return { row: sliceSpacing, column: spacing[1], depth: spacing[0] }
  return { row: spacing[0], column: spacing[1], depth: sliceSpacing }
}

type SourceVolumeGeometry = {
  origin: number[]
  rowAxis: number[]
  columnAxis: number[]
  normalAxis: number[]
  rowSpacing: number
  columnSpacing: number
  sliceSpacing: number
  lastSliceOffset: number
}

function getSourceVolumeGeometry(
  first: InstanceSummary | undefined,
  spacing: [number, number],
  sliceSpacing: number,
  sourceSlices: number,
): SourceVolumeGeometry {
  const orientation = first?.imageOrientationPatient?.length === 6
    ? first.imageOrientationPatient
    : [1, 0, 0, 0, 1, 0]
  const rowAxis = normalizeAxis(orientation.slice(0, 3), [1, 0, 0])
  const columnAxis = normalizeAxis(orientation.slice(3, 6), [0, 1, 0])
  const normalAxis = normalizeAxis(cross(rowAxis, columnAxis), [0, 0, 1])

  return {
    origin: first?.imagePositionPatient?.length === 3 ? first.imagePositionPatient : [0, 0, 0],
    rowAxis,
    columnAxis,
    normalAxis,
    rowSpacing: spacing[0],
    columnSpacing: spacing[1],
    sliceSpacing,
    lastSliceOffset: Math.max(0, sourceSlices - 1) * sliceSpacing,
  }
}

function getPlaneImagePositions(orientation: Orientation, count: number, geometry: SourceVolumeGeometry) {
  return Array.from({ length: count }, (_, index) => {
    if (orientation === 'sagittal') {
      return addVectors(
        geometry.origin,
        addVectors(
          scaleVector(geometry.rowAxis, index * geometry.columnSpacing),
          scaleVector(geometry.normalAxis, geometry.lastSliceOffset),
        ),
      )
    }

    if (orientation === 'coronal') {
      return addVectors(
        geometry.origin,
        addVectors(
          scaleVector(geometry.columnAxis, index * geometry.rowSpacing),
          scaleVector(geometry.normalAxis, geometry.lastSliceOffset),
        ),
      )
    }

    return addVectors(geometry.origin, scaleVector(geometry.normalAxis, index * geometry.sliceSpacing))
  })
}

function getPlaneOrientation(orientation: Orientation, geometry?: SourceVolumeGeometry) {
  if (geometry) {
    if (orientation === 'sagittal') {
      return [
        ...geometry.columnAxis,
        ...scaleVector(geometry.normalAxis, -1),
      ]
    }
    if (orientation === 'coronal') {
      return [
        ...geometry.rowAxis,
        ...scaleVector(geometry.normalAxis, -1),
      ]
    }
    return [
      ...geometry.rowAxis,
      ...geometry.columnAxis,
    ]
  }

  if (orientation === 'sagittal') return [0, 1, 0, 0, 0, -1]
  if (orientation === 'coronal') return [1, 0, 0, 0, 0, -1]
  return [1, 0, 0, 0, 1, 0]
}

function cross(a: number[], b: number[]) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function addVectors(a: number[], b: number[]) {
  return [
    Number(a[0] || 0) + Number(b[0] || 0),
    Number(a[1] || 0) + Number(b[1] || 0),
    Number(a[2] || 0) + Number(b[2] || 0),
  ]
}

function scaleVector(vector: number[], scalar: number) {
  return [
    Number(vector[0] || 0) * scalar,
    Number(vector[1] || 0) * scalar,
    Number(vector[2] || 0) * scalar,
  ]
}

function normalizeAxis(value: number[], fallback: number[]) {
  const x = Number(value[0])
  const y = Number(value[1])
  const z = Number(value[2])
  const length = Math.hypot(x, y, z)
  if (!Number.isFinite(length) || length <= 0.00001) {
    return fallback
  }
  return [x / length, y / length, z / length]
}

function safePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function positiveNumber(value: unknown, fallback: number) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback
}

function clampPositive(value: unknown, fallback: number) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 1 ? Math.min(Math.max(numberValue, 1), 8192) : fallback
}

function clampSlabThickness(value: unknown) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.min(Math.max(numberValue, 0.1), 50) : 1
}

function normalizeProjection(value: unknown): SsrProjection {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'mip' || normalized === 'minip') return normalized
  return 'normal'
}

function normalizeWorldPoint(value: unknown): Types.Point3 | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const point: Types.Point3 = [Number(value[0]), Number(value[1]), Number(value[2])]
  return point.every((part) => Number.isFinite(part)) ? point : null
}

function clampFrameIndex(value: unknown, length: number) {
  const fallbackMax = Math.max(0, length - 1)
  const index = Number(value)
  return Number.isFinite(index)
    ? Math.min(Math.max(Math.round(index), 0), fallbackMax)
    : 0
}

function normalizeVector(value: unknown, fallback: number[], length: number) {
  const source = Array.isArray(value) && value.length >= length ? value : fallback
  const normalized = Array.from({ length }, (_, index) => {
    const numberValue = Number(source[index])
    return Number.isFinite(numberValue) ? numberValue : Number(fallback[index] || 0)
  })
  return normalized
}
