import {
  Enums,
  ProgressiveRetrieveImages,
  cache,
  imageLoadPoolManager,
  imageLoader,
  imageRetrievalPoolManager,
  utilities,
  type IRetrieveConfiguration,
  type RetrieveStage,
} from '@cornerstonejs/core'

const MEBIBYTE = 1024 * 1024
const activeStackPrewarms = new Map<string, () => void>()
const imagesBeingPrewarmed = new Set<string>()
let loadingConfigured = false

export function configureCornerstoneLoading() {
  if (loadingConfigured) {
    return
  }

  cache.setMaxCacheSize(getCacheSizeMb() * MEBIBYTE)
  configureRequestPool(imageLoadPoolManager)
  configureRequestPool(imageRetrievalPoolManager)

  utilities.imageRetrieveMetadataProvider.add('volume', createVolumeRetrieveConfiguration())

  if (import.meta.env.VITE_DICOM_PROGRESSIVE_STREAMING !== 'false') {
    utilities.imageRetrieveMetadataProvider.add('stack', createStackRetrieveConfiguration())
  }

  loadingConfigured = true
}

export function registerVolumeProgressiveLoading(volumeId: string) {
  utilities.imageRetrieveMetadataProvider.add(volumeId, createVolumeRetrieveConfiguration())
}

export function getStackInitialImageIndex(imageCount: number) {
  return imageCount > 20 ? Math.floor(imageCount / 2) : 0
}

export function loadStackImageForDisplay(imageId: string) {
  return imageLoader.loadAndCacheImage(imageId, {
    priority: -20,
    requestType: Enums.RequestType.Interaction,
    additionalDetails: { source: 'viewport-display' },
  })
}

export function prewarmStackNeighbors(
  imageIds: string[],
  centerIndex: number,
  options: { radius?: number; timeoutMs?: number } = {},
) {
  if (imageIds.length < 2) {
    return () => undefined
  }

  const radius = clampInteger(
    options.radius ?? getConfiguredNumber(import.meta.env.VITE_STACK_SCROLL_PREFETCH_RADIUS, 4),
    0,
    12,
  )
  const timeoutMs = options.timeoutMs ?? 20_000
  const stackKey = `${imageIds.length}|${imageIds[0]}|${imageIds[imageIds.length - 1]}`
  activeStackPrewarms.get(stackKey)?.()

  const orderedIndexes = buildCenterOutIndexes(imageIds.length, centerIndex, radius)
  let cancelled = false
  let cursor = 0
  let idleHandle: number | undefined

  const cancel = () => {
    cancelled = true
    if (idleHandle !== undefined && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(idleHandle)
    }
    clearTimeout(timeoutHandle)
    if (activeStackPrewarms.get(stackKey) === cancel) {
      activeStackPrewarms.delete(stackKey)
    }
  }
  const timeoutHandle = setTimeout(cancel, timeoutMs)

  const runNext = () => {
    if (cancelled || cursor >= orderedIndexes.length) {
      cancel()
      return
    }

    const distance = cursor + 1
    const imageId = imageIds[orderedIndexes[cursor]]
    cursor += 1

    if (cache.getImageLoadObject(imageId) || imagesBeingPrewarmed.has(imageId)) {
      scheduleNext()
      return
    }

    imagesBeingPrewarmed.add(imageId)
    void imageLoader.loadAndCacheImage(imageId, {
      priority: Math.min(20, distance),
      requestType: Enums.RequestType.Prefetch,
      additionalDetails: { source: 'stack-neighbor-prewarm', centerIndex },
    }).catch(() => undefined).finally(() => {
      imagesBeingPrewarmed.delete(imageId)
      scheduleNext()
    })
  }

  const scheduleNext = () => {
    if (cancelled) {
      return
    }
    const requestIdleCallback = window.requestIdleCallback
    if (requestIdleCallback) {
      idleHandle = requestIdleCallback(runNext, { timeout: 400 })
    } else {
      idleHandle = window.setTimeout(runNext, 24)
    }
  }

  activeStackPrewarms.set(stackKey, cancel)
  scheduleNext()
  return cancel
}

function createStackRetrieveConfiguration(): IRetrieveConfiguration {
  if (import.meta.env.VITE_DICOM_HTJ2K_BYTE_RANGE === 'true') {
    return createHtJ2kByteRangeStackRetrieveConfiguration()
  }

  const stackStreamingEnabled = import.meta.env.VITE_DICOM_STACK_STREAMING === 'true'

  return {
    stages: [{
      id: 'initialImage',
      retrieveType: 'single',
      requestType: Enums.RequestType.Interaction,
      priority: -10,
    }],
    retrieveOptions: {
      single: stackStreamingEnabled ? { streaming: true } : {},
    },
  }
}

function createHtJ2kByteRangeStackRetrieveConfiguration(): IRetrieveConfiguration {
  return {
    stages: [
      {
        id: 'htj2kFastRange',
        retrieveType: 'singleFast',
        requestType: Enums.RequestType.Interaction,
        priority: -10,
      },
      {
        id: 'htj2kFinalRange',
        retrieveType: 'singleFinal',
        requestType: Enums.RequestType.Prefetch,
        priority: 5,
      },
      {
        id: 'wadoFallback',
        retrieveType: 'singleFallback',
        requestType: Enums.RequestType.Prefetch,
        priority: 15,
      },
    ],
    retrieveOptions: {
      singleFast: {
        urlArguments: 'accept=image/jhc',
        rangeIndex: 0,
        chunkSize: getConfiguredNumber(import.meta.env.VITE_DICOM_HTJ2K_RANGE_CHUNK_BYTES, 64 * 1024),
        decodeLevel: getConfiguredNumber(import.meta.env.VITE_DICOM_HTJ2K_DECODE_LEVEL, 3),
      },
      singleFinal: {
        urlArguments: 'accept=image/jhc',
        rangeIndex: -1,
      },
      singleFallback: {},
    },
  }
}

function createVolumeRetrieveConfiguration(): IRetrieveConfiguration {
  const stages = ProgressiveRetrieveImages.interleavedRetrieveStages.stages.map((stage) => ({
    ...stage,
    requestType: stage.id === 'initialImages'
      ? Enums.RequestType.Interaction
      : Enums.RequestType.Prefetch,
    priority: stage.id === 'initialImages' ? -10 : stage.priority,
  })) as RetrieveStage[]

  if (import.meta.env.VITE_DICOM_PROGRESSIVE_BYTE_RANGE === 'true') {
    return {
      stages,
      retrieveOptions: {
        default: {},
        multipleFast: { rangeIndex: 0, chunkSize: 64 * 1024, decodeLevel: 3 },
        multipleFinal: { rangeIndex: -1 },
      },
    }
  }

  // Interleaving works for ordinary WADO-RS data without requiring partial-content support.
  return {
    stages,
    retrieveOptions: {
      default: {},
      multipleFast: {},
      multipleFinal: {},
    },
  }
}

function configureRequestPool(pool: typeof imageLoadPoolManager) {
  pool.setMaxSimultaneousRequests(
    Enums.RequestType.Interaction,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_INTERACTION_REQUESTS, 4), 2, 16),
  )
  pool.setMaxSimultaneousRequests(
    Enums.RequestType.Thumbnail,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_THUMBNAIL_REQUESTS, 4), 1, 12),
  )
  pool.setMaxSimultaneousRequests(
    Enums.RequestType.Prefetch,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_PREFETCH_REQUESTS, 2), 1, 8),
  )
  pool.setMaxSimultaneousRequests(
    Enums.RequestType.Compute,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_COMPUTE_REQUESTS, 2), 1, 8),
  )
}

function getCacheSizeMb() {
  const configured = getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_CACHE_MB, 0)
  if (configured > 0) {
    return clampInteger(configured, 256, 3072)
  }

  const deviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4)
  if (deviceMemory >= 12) return 1536
  if (deviceMemory >= 8) return 1024
  if (deviceMemory >= 4) return 512
  return 256
}

function getConfiguredNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function buildCenterOutIndexes(length: number, centerIndex: number, radius: number) {
  const indexes: number[] = []
  for (let offset = 1; offset <= radius; offset += 1) {
    const forward = centerIndex + offset
    const backward = centerIndex - offset
    if (forward < length) indexes.push(forward)
    if (backward >= 0) indexes.push(backward)
  }
  return indexes
}
