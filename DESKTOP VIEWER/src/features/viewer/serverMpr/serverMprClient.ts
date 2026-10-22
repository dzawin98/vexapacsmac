import { appUrl } from '../../../config/appBase'

export type ServerMprOrientation = 'axial' | 'sagittal' | 'coronal'
export type ServerMprProjection = 'normal' | 'mip' | 'minip' | 'average'
export type ServerMprVec3 = [number, number, number]
export type ServerMprMat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

export type ServerMprPlane = {
  orientation: ServerMprOrientation
  index: number
  maxIndex: number
  rows: number
  columns: number
  rowPixelSpacing: number
  columnPixelSpacing: number
  imagePositionPatient: ServerMprVec3
  rowDirection: ServerMprVec3
  columnDirection: ServerMprVec3
  normal: ServerMprVec3
  geometryHash: string
}

export type ServerMprSession = {
  volumeSessionId: string
  status: 'building' | 'ready' | 'error'
  progress: number
  error?: string
  sourceHash: string
  geometry: {
    dimensions: [number, number, number]
    spacing: ServerMprVec3
    origin: ServerMprVec3
    directionX: ServerMprVec3
    directionY: ServerMprVec3
    directionZ: ServerMprVec3
    frameOfReferenceUid: string
  }
  defaultWindowCenter: number
  defaultWindowWidth: number
  planes: Record<ServerMprOrientation, ServerMprPlane>
}

export type ServerMprProxyVolume = {
  version: number
  sourceHash: string
  sourceDimensions: [number, number, number]
  dimensions: [number, number, number]
  spacing: ServerMprVec3
  origin: ServerMprVec3
  directionX: ServerMprVec3
  directionY: ServerMprVec3
  directionZ: ServerMprVec3
  direction?: ServerMprMat3
  frameOfReferenceUid: string
  defaultWindowCenter: number
  defaultWindowWidth: number
  metadata?: {
    modality?: string
    samplesPerPixel?: number
    bitsAllocated?: number
    bitsStored?: number
    highBit?: number
    pixelRepresentation?: number
    photometricInterpretation?: string
  }
  bytes: number
  voxels: Int16Array
}

export type ServerMprResliceRequest = {
  orientation: ServerMprOrientation
  index: number
  maxEdge?: number
  windowCenter?: number
  windowWidth?: number
  quality?: 'preview' | 'diagnostic'
  jpegQuality?: number
  slabThickness?: number
  projection?: ServerMprProjection
  sequenceId?: number
}

export async function createServerMprSession(studyInstanceUid: string, seriesInstanceUid: string, signal?: AbortSignal) {
  return requestJson<ServerMprSession>(appUrl('/api/mpr/sessions'), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studyInstanceUid, seriesInstanceUid }),
  })
}

export async function getServerMprSession(volumeSessionId: string, signal?: AbortSignal) {
  return requestJson<ServerMprSession>(appUrl(`/api/mpr/sessions/${encodeURIComponent(volumeSessionId)}`), { signal })
}

export async function waitForServerMprSession(
  initial: ServerMprSession,
  onProgress?: (session: ServerMprSession) => void,
  signal?: AbortSignal,
) {
  let session = initial
  while (session.status === 'building') {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.(session)
    await delay(280, signal)
    session = await getServerMprSession(session.volumeSessionId, signal)
  }
  if (session.status === 'error') throw new Error(session.error || 'Server MPR volume failed to build')
  onProgress?.(session)
  return session
}

export async function fetchServerMprPreview(
  volumeSessionId: string,
  request: ServerMprResliceRequest,
  signal?: AbortSignal,
) {
  const response = await fetch(appUrl(`/api/mpr/sessions/${encodeURIComponent(volumeSessionId)}/reslice`), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'image/jpeg' },
    body: JSON.stringify({ ...request, quality: 'preview' }),
  })
  if (!response.ok) throw await responseError(response)
  const blob = await response.blob()
  return {
    url: URL.createObjectURL(blob),
    geometryHash: response.headers.get('X-MPR-Geometry-Hash') || '',
    sequenceId: Number(response.headers.get('X-MPR-Sequence-Id') || request.sequenceId || 0),
  }
}

export async function probeServerMpr(
  volumeSessionId: string,
  world: ServerMprVec3,
  signal?: AbortSignal,
) {
  return requestJson<{ value: number; unit: string; world: ServerMprVec3; index: ServerMprVec3 }>(
    appUrl(`/api/mpr/sessions/${encodeURIComponent(volumeSessionId)}/probe`),
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ world }),
    },
  )
}

export async function fetchServerMprProxyVolume(
  volumeSessionId: string,
  options: { maxEdge?: number; maxDepth?: number; maxVoxels?: number } = {},
  signal?: AbortSignal,
) {
  const response = await fetch(appUrl(`/api/mpr/sessions/${encodeURIComponent(volumeSessionId)}/proxy-volume`), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.vexa.mpr-proxy-volume',
    },
    body: JSON.stringify(options),
  })
  if (!response.ok) throw await responseError(response)

  const buffer = await response.arrayBuffer()
  const view = new DataView(buffer)
  if (buffer.byteLength < 4) {
    throw new Error('MPR proxy response is empty.')
  }
  const headerLength = view.getUint32(0, true)
  const voxelOffset = 4 + headerLength
  if (headerLength < 2 || voxelOffset > buffer.byteLength) {
    throw new Error('MPR proxy response header is invalid.')
  }
  const headerText = new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))
  const header = JSON.parse(headerText) as Omit<ServerMprProxyVolume, 'voxels'>
  const voxelBytes = buffer.byteLength - voxelOffset
  if (voxelBytes < 2 || voxelBytes % 2 !== 0) {
    throw new Error('MPR proxy voxel payload is invalid.')
  }
  const voxelBuffer = voxelOffset % 2 === 0
    ? buffer
    : buffer.slice(voxelOffset, voxelOffset + voxelBytes)
  const voxelStart = voxelOffset % 2 === 0 ? voxelOffset : 0

  return {
    ...header,
    voxels: new Int16Array(voxelBuffer, voxelStart, voxelBytes / 2),
  } satisfies ServerMprProxyVolume
}

export function deriveServerMprPlane(session: ServerMprSession, orientation: ServerMprOrientation, index: number) {
  const base = session.planes[orientation]
  const axisSpacing = orientation === 'sagittal'
    ? session.geometry.spacing[0]
    : orientation === 'coronal'
      ? session.geometry.spacing[1]
      : session.geometry.spacing[2]
  const offset = (index - base.index) * axisSpacing
  return {
    ...base,
    index,
    imagePositionPatient: add(base.imagePositionPatient, scale(base.normal, offset)),
  } satisfies ServerMprPlane
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<T>
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null
  return new Error(payload?.error || `Server MPR request failed: ${response.status}`)
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function add(a: ServerMprVec3, b: ServerMprVec3): ServerMprVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scale(value: ServerMprVec3, factor: number): ServerMprVec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor]
}
