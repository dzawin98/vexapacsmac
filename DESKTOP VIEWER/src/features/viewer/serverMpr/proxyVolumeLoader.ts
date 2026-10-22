import { cache, registerImageLoader, volumeLoader, type Types } from '@cornerstonejs/core'
import {
  fetchServerMprProxyVolume,
  type ServerMprMat3,
  type ServerMprProxyVolume,
} from './serverMprClient'

const PROXY_VOLUME_SCHEME = 'vexa-proxy'

let proxyVolumeLoaderInitialized = false

export function createProxyVolumeId(sessionId: string) {
  return `${PROXY_VOLUME_SCHEME}:${encodeURIComponent(sessionId)}`
}

export function initializeProxyVolumeLoader() {
  if (proxyVolumeLoaderInitialized) {
    return
  }

  registerImageLoader(PROXY_VOLUME_SCHEME, (imageId) => {
    const cachedImage = cache.getImage(imageId)
      || cache.getCachedImageBasedOnImageURI(imageId)?.image
      || getFirstCachedImageForProxyVolume(imageId)
    return {
      promise: cachedImage
        ? Promise.resolve(cachedImage)
        : Promise.reject(new Error(`Proxy volume local image is not cached: ${imageId}`)),
    }
  })

  volumeLoader.registerVolumeLoader(PROXY_VOLUME_SCHEME, (volumeId, options) => {
    const abortController = new AbortController()
    const promise = loadProxyVolume(volumeId, options || {}, abortController.signal)

    return {
      promise,
      cancelFn: () => abortController.abort(),
    }
  })

  proxyVolumeLoaderInitialized = true
}

function getFirstCachedImageForProxyVolume(imageId: string) {
  const volume = cache.getVolume(imageId) as Types.IImageVolume | undefined
  const firstImageId = volume?.imageIds?.[0]
  return firstImageId ? cache.getImage(firstImageId) : undefined
}

async function loadProxyVolume(
  volumeId: string,
  options: Record<string, unknown>,
  signal: AbortSignal,
) {
  const sessionId = getSessionId(volumeId, options)
  const proxy = await fetchServerMprProxyVolume(
    sessionId,
    {
      maxEdge: readNumberOption(options.maxEdge),
      maxDepth: readNumberOption(options.maxDepth),
      maxVoxels: readNumberOption(options.maxVoxels),
    },
    signal,
  )

  return volumeLoader.createLocalVolume(volumeId, {
    metadata: buildVolumeMetadata(proxy),
    dimensions: proxy.dimensions,
    spacing: proxy.spacing,
    origin: proxy.origin,
    direction: getDirection(proxy),
    scalarData: proxy.voxels,
    preventCache: true,
  })
}

function getSessionId(volumeId: string, options: Record<string, unknown>) {
  if (typeof options.sessionId === 'string' && options.sessionId.trim()) {
    return options.sessionId
  }

  const prefix = `${PROXY_VOLUME_SCHEME}:`
  if (!volumeId.startsWith(prefix)) {
    throw new Error(`Invalid proxy volumeId: ${volumeId}`)
  }

  const encodedSessionId = volumeId.slice(prefix.length).split('?')[0]
  if (!encodedSessionId) {
    throw new Error('Proxy volumeId does not contain a session id.')
  }

  return decodeURIComponent(encodedSessionId)
}

function getDirection(proxy: ServerMprProxyVolume) {
  const direction = proxy.direction || ([
    ...proxy.directionX,
    ...proxy.directionY,
    ...proxy.directionZ,
  ] as ServerMprMat3)

  return direction as Types.Mat3
}

function buildVolumeMetadata(proxy: ServerMprProxyVolume) {
  const metadata = proxy.metadata || {}

  return {
    BitsAllocated: metadata.bitsAllocated ?? 16,
    BitsStored: metadata.bitsStored ?? 16,
    SamplesPerPixel: metadata.samplesPerPixel ?? 1,
    HighBit: metadata.highBit ?? 15,
    PhotometricInterpretation: metadata.photometricInterpretation ?? 'MONOCHROME2',
    PixelRepresentation: metadata.pixelRepresentation ?? 1,
    Modality: metadata.modality ?? 'CT',
    ImageOrientationPatient: [
      ...proxy.directionX,
      ...proxy.directionY,
    ],
    PixelSpacing: [
      proxy.spacing[1],
      proxy.spacing[0],
    ],
    FrameOfReferenceUID: proxy.frameOfReferenceUid,
    Columns: proxy.dimensions[0],
    Rows: proxy.dimensions[1],
    voiLut: [
      {
        windowCenter: proxy.defaultWindowCenter,
        windowWidth: proxy.defaultWindowWidth,
      },
    ],
    VOILUTFunction: 'LINEAR',
  } satisfies Types.Metadata
}

function readNumberOption(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
