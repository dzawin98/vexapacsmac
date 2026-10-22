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
const DEFAULT_STACK_FAST_CHUNK_BYTES = 96 * 1024
const DEFAULT_STACK_PREFETCH_RADIUS = 3
const DEFAULT_STACK_ADAPTIVE_MAX_RADIUS = 6
const DEFAULT_STACK_PREFETCH_CONCURRENCY = 2
const activeStackPrewarms = new Map<string, () => void>()
const stackPrewarmMotion = new Map<string, { centerIndex: number; requestedAt: number; direction: -1 | 0 | 1 }>()
const imagesBeingPrewarmed = new Set<string>()
let loadingConfigured = false

export function configureCornerstoneLoading() {
  if (loadingConfigured) {
    return
  }

  cache.setMaxCacheSize(getCacheSizeMb() * MEBIBYTE)
  configureImageLoadPool()
  configureImageRetrievalPool()

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
    priority: -30,
    requestType: Enums.RequestType.Interaction,
    additionalDetails: { source: 'viewport-display' },
  })
}

export function primeStackImagesForDisplay(imageIds: string[], centerIndex: number) {
  if (!imageIds.length) {
    return
  }

  const safeCenterIndex = clampInteger(centerIndex, 0, imageIds.length - 1)
  const displayIndexes = [
    safeCenterIndex,
    ...buildCenterOutIndexes(
      imageIds.length,
      safeCenterIndex,
      clampInteger(
        getConfiguredNumber(import.meta.env.VITE_STACK_DISPLAY_PRIME_RADIUS, DEFAULT_STACK_PREFETCH_RADIUS),
        0,
        8,
      ),
    ),
  ]

  displayIndexes.forEach((imageIndex, order) => {
    const imageId = imageIds[imageIndex]
    if (!imageId || cache.getImageLoadObject(imageId) || imagesBeingPrewarmed.has(imageId)) {
      return
    }

    imagesBeingPrewarmed.add(imageId)
    void imageLoader.loadAndCacheImage(imageId, {
      priority: order === 0 ? -30 : -20 + order,
      requestType: order === 0 ? Enums.RequestType.Interaction : Enums.RequestType.Prefetch,
      additionalDetails: { source: 'stack-display-prime', centerIndex: safeCenterIndex },
    }).catch(() => undefined).finally(() => {
      imagesBeingPrewarmed.delete(imageId)
    })
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
    options.radius ?? getConfiguredNumber(import.meta.env.VITE_STACK_SCROLL_PREFETCH_RADIUS, DEFAULT_STACK_PREFETCH_RADIUS),
    0,
    12,
  )
  const timeoutMs = options.timeoutMs ?? 20_000
  const stackKey = `${imageIds.length}|${imageIds[0]}|${imageIds[imageIds.length - 1]}`
  activeStackPrewarms.get(stackKey)?.()

  const prewarmPlan = buildAdaptivePrewarmPlan(imageIds.length, centerIndex, radius, stackKey)
  const orderedIndexes = prewarmPlan.indexes
  const maxConcurrent = prewarmPlan.direction === 0
    ? 1
    : clampInteger(
      getConfiguredNumber(import.meta.env.VITE_STACK_PREFETCH_CONCURRENCY, DEFAULT_STACK_PREFETCH_CONCURRENCY),
      1,
      4,
    )
  let cancelled = false
  let cursor = 0
  let activeRequests = 0
  let scheduledRequests = 0
  const idleHandles = new Set<number>()

  const cancel = () => {
    cancelled = true
    for (const idleHandle of idleHandles) {
      if ('cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleHandle)
      } else {
        clearTimeout(idleHandle)
      }
    }
    idleHandles.clear()
    clearTimeout(timeoutHandle)
    if (activeStackPrewarms.get(stackKey) === cancel) {
      activeStackPrewarms.delete(stackKey)
    }
  }
  const timeoutHandle = setTimeout(cancel, timeoutMs)

  const runNext = () => {
    scheduledRequests = Math.max(0, scheduledRequests - 1)
    if (cancelled) {
      return
    }

    let imageIndex: number | undefined
    let imageId: string | undefined
    while (cursor < orderedIndexes.length && !imageId) {
      imageIndex = orderedIndexes[cursor]
      cursor += 1
      const candidate = imageIds[imageIndex]
      if (candidate && !cache.getImageLoadObject(candidate) && !imagesBeingPrewarmed.has(candidate)) {
        imageId = candidate
      }
    }

    if (!imageId || imageIndex === undefined) {
      if (activeRequests === 0 && scheduledRequests === 0) {
        cancel()
      }
      return
    }

    const distance = Math.max(1, Math.abs(imageIndex - centerIndex))
    imagesBeingPrewarmed.add(imageId)
    activeRequests += 1
    void imageLoader.loadAndCacheImage(imageId, {
      priority: Math.min(20, distance),
      requestType: Enums.RequestType.Prefetch,
      additionalDetails: {
        source: 'stack-neighbor-prewarm',
        centerIndex,
        direction: prewarmPlan.direction,
        velocitySlicesPerSecond: prewarmPlan.velocitySlicesPerSecond,
      },
    }).catch(() => undefined).finally(() => {
      imagesBeingPrewarmed.delete(imageId)
      activeRequests = Math.max(0, activeRequests - 1)
      pump()
    })

    pump()
  }

  const scheduleNext = () => {
    if (cancelled) {
      return
    }
    const requestIdleCallback = window.requestIdleCallback
    if (requestIdleCallback) {
      const idleHandle = requestIdleCallback(() => {
        idleHandles.delete(idleHandle)
        runNext()
      }, { timeout: 400 })
      idleHandles.add(idleHandle)
    } else {
      const idleHandle = window.setTimeout(() => {
        idleHandles.delete(idleHandle)
        runNext()
      }, 24)
      idleHandles.add(idleHandle)
    }
  }

  const pump = () => {
    if (cancelled) {
      return
    }
    while (
      cursor < orderedIndexes.length &&
      activeRequests + scheduledRequests < maxConcurrent
    ) {
      scheduledRequests += 1
      scheduleNext()
    }
    if (cursor >= orderedIndexes.length && activeRequests === 0 && scheduledRequests === 0) {
      cancel()
    }
  }

  activeStackPrewarms.set(stackKey, cancel)
  pump()
  return cancel
}

function buildAdaptivePrewarmPlan(length: number, centerIndex: number, baseRadius: number, stackKey: string) {
  const now = performance.now()
  const previous = stackPrewarmMotion.get(stackKey)
  const delta = previous ? centerIndex - previous.centerIndex : 0
  const elapsedMs = previous ? Math.max(1, now - previous.requestedAt) : 0
  const inferredDirection: -1 | 0 | 1 = delta > 0 ? 1 : delta < 0 ? -1 : previous?.direction ?? 0
  const direction = import.meta.env.VITE_STACK_ADAPTIVE_PREFETCH === 'false' ? 0 : inferredDirection
  const velocitySlicesPerSecond = elapsedMs > 0 ? Math.abs(delta) * 1000 / elapsedMs : 0

  stackPrewarmMotion.set(stackKey, {
    centerIndex,
    requestedAt: now,
    direction,
  })

  if (direction === 0) {
    return {
      indexes: buildCenterOutIndexes(length, centerIndex, baseRadius),
      direction,
      velocitySlicesPerSecond,
    }
  }

  const maxRadius = clampInteger(
    getConfiguredNumber(import.meta.env.VITE_STACK_ADAPTIVE_PREFETCH_MAX_RADIUS, DEFAULT_STACK_ADAPTIVE_MAX_RADIUS),
    Math.max(1, baseRadius),
    12,
  )
  const velocityBoost = clampInteger(Math.ceil(velocitySlicesPerSecond / 8), 1, Math.max(1, maxRadius - baseRadius))
  const forwardRadius = Math.min(maxRadius, Math.max(baseRadius + 1, baseRadius + velocityBoost))
  const backwardRadius = Math.max(1, Math.min(baseRadius, 2))
  const indexes: number[] = []

  for (let offset = 1; offset <= forwardRadius; offset += 1) {
    const imageIndex = centerIndex + offset * direction
    if (imageIndex >= 0 && imageIndex < length) indexes.push(imageIndex)
  }
  for (let offset = 1; offset <= backwardRadius; offset += 1) {
    const imageIndex = centerIndex - offset * direction
    if (imageIndex >= 0 && imageIndex < length) indexes.push(imageIndex)
  }

  return { indexes, direction, velocitySlicesPerSecond }
}

function createStackRetrieveConfiguration(): IRetrieveConfiguration {
  if (import.meta.env.VITE_DICOM_HTJ2K_BYTE_RANGE === 'true') {
    return createHtJ2kByteRangeStackRetrieveConfiguration()
  }

  const stackStreamingEnabled = import.meta.env.VITE_DICOM_STACK_STREAMING === 'true'

  return {
    stages: createStackProgressiveStages('single'),
    retrieveOptions: {
      single: stackStreamingEnabled ? { streaming: true } : {},
    },
  }
}

function createHtJ2kByteRangeStackRetrieveConfiguration(): IRetrieveConfiguration {
  return {
    stages: [
      {
        id: 'htj2kFastVisible',
        positions: [0.5, 0, -1],
        retrieveType: 'singleFast',
        requestType: Enums.RequestType.Interaction,
        priority: -30,
        nearbyFrames: createNearbyFrameHints(),
      },
      {
        id: 'htj2kFastSweepA',
        decimate: 4,
        offset: 1,
        retrieveType: 'singleFast',
        requestType: Enums.RequestType.Thumbnail,
        priority: -8,
        nearbyFrames: createNearbyFrameHints(),
      },
      {
        id: 'htj2kFastSweepB',
        decimate: 4,
        offset: 3,
        retrieveType: 'singleFast',
        requestType: Enums.RequestType.Thumbnail,
        priority: -6,
        nearbyFrames: createNearbyFrameHints(),
      },
      {
        id: 'htj2kFinalSweepA',
        decimate: 2,
        offset: 0,
        retrieveType: 'singleFinal',
        requestType: Enums.RequestType.Prefetch,
        priority: 6,
      },
      {
        id: 'htj2kFinalSweepB',
        decimate: 2,
        offset: 1,
        retrieveType: 'singleFinal',
        requestType: Enums.RequestType.Prefetch,
        priority: 8,
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
        chunkSize: getConfiguredNumber(import.meta.env.VITE_DICOM_HTJ2K_RANGE_CHUNK_BYTES, DEFAULT_STACK_FAST_CHUNK_BYTES),
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

function createStackProgressiveStages(retrieveType: string): RetrieveStage[] {
  return [
    {
      id: 'visibleStackImages',
      positions: [0.5, 0, -1],
      retrieveType,
      requestType: Enums.RequestType.Interaction,
      priority: -25,
      nearbyFrames: createNearbyFrameHints(),
    },
    {
      id: 'nearStackImagesA',
      decimate: 4,
      offset: 1,
      retrieveType,
      requestType: Enums.RequestType.Thumbnail,
      priority: -4,
      nearbyFrames: createNearbyFrameHints(),
    },
    {
      id: 'nearStackImagesB',
      decimate: 4,
      offset: 3,
      retrieveType,
      requestType: Enums.RequestType.Thumbnail,
      priority: -2,
      nearbyFrames: createNearbyFrameHints(),
    },
    {
      id: 'remainingStackImagesA',
      decimate: 2,
      offset: 0,
      retrieveType,
      requestType: Enums.RequestType.Prefetch,
      priority: 8,
    },
    {
      id: 'remainingStackImagesB',
      decimate: 2,
      offset: 1,
      retrieveType,
      requestType: Enums.RequestType.Prefetch,
      priority: 10,
    },
  ]
}

function createNearbyFrameHints(): RetrieveStage['nearbyFrames'] {
  return [
    { offset: -1, imageQualityStatus: Enums.ImageQualityStatus.ADJACENT_REPLICATE },
    { offset: 1, imageQualityStatus: Enums.ImageQualityStatus.ADJACENT_REPLICATE },
    { offset: 2, imageQualityStatus: Enums.ImageQualityStatus.FAR_REPLICATE },
  ]
}

function configureImageLoadPool() {
  imageLoadPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Interaction,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_LOAD_INTERACTION_REQUESTS, getDefaultImageLoadInteractionCount()), 2, 16),
  )
  imageLoadPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Thumbnail,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_LOAD_THUMBNAIL_REQUESTS, getDefaultImageLoadThumbnailCount()), 1, 10),
  )
  imageLoadPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Prefetch,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_LOAD_PREFETCH_REQUESTS, getDefaultImageLoadPrefetchCount()), 1, 8),
  )
  imageLoadPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Compute,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_LOAD_COMPUTE_REQUESTS, 4), 1, 12),
  )
}

function configureImageRetrievalPool() {
  imageRetrievalPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Interaction,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_RETRIEVAL_INTERACTION_REQUESTS, getDefaultRetrievalInteractionCount()), 2, 16),
  )
  imageRetrievalPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Thumbnail,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_RETRIEVAL_THUMBNAIL_REQUESTS, getDefaultImageLoadThumbnailCount()), 1, 8),
  )
  imageRetrievalPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Prefetch,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_RETRIEVAL_PREFETCH_REQUESTS, getDefaultImageLoadPrefetchCount()), 1, 8),
  )
  imageRetrievalPoolManager.setMaxSimultaneousRequests(
    Enums.RequestType.Compute,
    clampInteger(getConfiguredNumber(import.meta.env.VITE_CORNERSTONE_RETRIEVAL_COMPUTE_REQUESTS, 2), 1, 6),
  )
}

function getDefaultRetrievalInteractionCount() {
  const cores = getRuntimeCoreCount()
  if (cores >= 12) return 12
  if (cores >= 8) return 8
  if (cores >= 4) return 6
  return 4
}

function getDefaultImageLoadInteractionCount() {
  const cores = getRuntimeCoreCount()
  if (cores >= 12) return 10
  if (cores >= 8) return 8
  if (cores >= 4) return 6
  return 4
}

function getDefaultImageLoadThumbnailCount() {
  const cores = getRuntimeCoreCount()
  if (cores >= 8) return 4
  if (cores >= 4) return 3
  return 2
}

function getDefaultImageLoadPrefetchCount() {
  const cores = getRuntimeCoreCount()
  if (cores >= 8) return 3
  if (cores >= 4) return 2
  return 1
}

function getRuntimeCoreCount() {
  return Math.max(1, Math.floor(navigator.hardwareConcurrency || 4))
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
