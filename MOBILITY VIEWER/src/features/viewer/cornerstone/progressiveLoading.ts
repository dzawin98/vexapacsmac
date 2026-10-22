import {
  cache,
  Enums,
  imageLoader,
  imageLoadPoolManager,
  imageRetrievalPoolManager,
  utilities,
  type IRetrieveConfiguration,
  type RetrieveStage,
} from '@cornerstonejs/core'

const MEBIBYTE = 1024 * 1024
const DEFAULT_PREWARM_RADIUS = 2
const DEFAULT_INITIAL_PRIME_RADIUS = 0
const prewarmingImageIds = new Set<string>()
const activePrewarms = new Map<string, () => void>()
let configured = false

export function configureCornerstoneLoading() {
  if (configured) return

  cache.setMaxCacheSize(getMobileCacheSizeMb() * MEBIBYTE)
  configurePools()
  utilities.imageRetrieveMetadataProvider.add('stack', createStackRetrieveConfiguration())
  configured = true
}

export function getStackInitialImageIndex(imageCount: number) {
  return imageCount > 20 ? Math.floor(imageCount / 2) : 0
}

export function primeStackImagesForDisplay(imageIds: string[], centerIndex: number) {
  if (!imageIds.length) return

  const indexes = [
    clampIndex(centerIndex, imageIds.length),
    ...buildCenterOutIndexes(imageIds.length, centerIndex, getConfiguredNumber(import.meta.env.VITE_MOBILE_STACK_PRIME_RADIUS, DEFAULT_INITIAL_PRIME_RADIUS)),
  ]

  indexes.forEach((imageIndex, order) => {
    const imageId = imageIds[imageIndex]
    if (!imageId || cache.getImageLoadObject(imageId) || prewarmingImageIds.has(imageId)) return

    prewarmingImageIds.add(imageId)
    void imageLoader.loadAndCacheImage(imageId, {
      priority: order === 0 ? -30 : -18 + order,
      requestType: order === 0 ? Enums.RequestType.Interaction : Enums.RequestType.Prefetch,
      additionalDetails: { source: 'mobile-stack-prime', imageIndex },
    }).catch(() => undefined).finally(() => {
      prewarmingImageIds.delete(imageId)
    })
  })
}

export function prewarmStackNeighbors(
  imageIds: string[],
  centerIndex: number,
  options: { radius?: number; timeoutMs?: number } = {},
) {
  if (imageIds.length < 2 || document.visibilityState === 'hidden') {
    return () => undefined
  }

  const radius = clampInteger(
    options.radius ?? getConfiguredNumber(import.meta.env.VITE_MOBILE_STACK_SCROLL_PREFETCH_RADIUS, DEFAULT_PREWARM_RADIUS),
    0,
    4,
  )
  if (!radius) return () => undefined

  const indexes = buildCenterOutIndexes(imageIds.length, centerIndex, radius)
  const stackKey = `${imageIds.length}|${imageIds[0]}|${imageIds[imageIds.length - 1]}`
  activePrewarms.get(stackKey)?.()

  let cancelled = false
  let cursor = 0
  let workTimer: number | undefined
  const timeoutTimer = window.setTimeout(cancel, options.timeoutMs ?? 8_000)

  const scheduleNext = () => {
    workTimer = window.setTimeout(loadNext, 0)
  }

  const loadNext = () => {
    if (cancelled || document.visibilityState === 'hidden' || cursor >= indexes.length) {
      cancel()
      return
    }

    const imageIndex = indexes[cursor]
    cursor += 1
    const imageId = imageIds[imageIndex]
    if (!imageId || cache.getImageLoadObject(imageId) || prewarmingImageIds.has(imageId)) {
      scheduleNext()
      return
    }

    prewarmingImageIds.add(imageId)
    void imageLoader.loadAndCacheImage(imageId, {
      priority: 16 + cursor,
      requestType: Enums.RequestType.Prefetch,
      additionalDetails: { source: 'mobile-stack-neighbor-prewarm', centerIndex, imageIndex },
    }).catch(() => undefined).finally(() => {
      prewarmingImageIds.delete(imageId)
      if (!cancelled) scheduleNext()
    })
  }

  function cancel() {
    if (cancelled) return
    cancelled = true
    if (workTimer !== undefined) window.clearTimeout(workTimer)
    window.clearTimeout(timeoutTimer)
    if (activePrewarms.get(stackKey) === cancel) {
      activePrewarms.delete(stackKey)
    }
  }

  activePrewarms.set(stackKey, cancel)
  workTimer = window.setTimeout(loadNext, 120)
  return cancel
}

export function requestStackImageForDisplay(imageIds: string[], imageIndex: number) {
  const safeIndex = clampIndex(imageIndex, imageIds.length)
  const imageId = imageIds[safeIndex]
  if (!imageId || cache.getImageLoadObject(imageId)) return

  prewarmingImageIds.add(imageId)
  void imageLoader.loadAndCacheImage(imageId, {
    priority: -32,
    requestType: Enums.RequestType.Interaction,
    additionalDetails: { source: 'mobile-stack-scroll-target', imageIndex: safeIndex },
  }).catch(() => undefined).finally(() => {
    prewarmingImageIds.delete(imageId)
  })
}

function createStackRetrieveConfiguration(): IRetrieveConfiguration {
  return {
    stages: createStackStages('single'),
    retrieveOptions: {
      single: {},
    },
  }
}

function createStackStages(retrieveType: string): RetrieveStage[] {
  return [
    {
      id: 'visibleStackImages',
      positions: [0.5, 0, -1],
      retrieveType,
      requestType: Enums.RequestType.Interaction,
      priority: -25,
    },
    {
      id: 'nearStackImagesA',
      decimate: 4,
      offset: 1,
      retrieveType,
      requestType: Enums.RequestType.Thumbnail,
      priority: -4,
    },
    {
      id: 'nearStackImagesB',
      decimate: 4,
      offset: 3,
      retrieveType,
      requestType: Enums.RequestType.Thumbnail,
      priority: -2,
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

function configurePools() {
  const interaction = getMobileInteractionCount()
  imageLoadPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Interaction, interaction)
  imageLoadPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Thumbnail, 1)
  imageLoadPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Prefetch, 1)
  imageLoadPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Compute, 1)

  imageRetrievalPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Interaction, interaction)
  imageRetrievalPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Thumbnail, 1)
  imageRetrievalPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Prefetch, 1)
  imageRetrievalPoolManager.setMaxSimultaneousRequests(Enums.RequestType.Compute, 1)
}

function getMobileInteractionCount() {
  const configuredCount = getConfiguredNumber(import.meta.env.VITE_MOBILE_CORNERSTONE_INTERACTION_REQUESTS, 0)
  if (configuredCount > 0) return clampInteger(configuredCount, 1, 4)

  const cores = Math.max(1, Math.floor(navigator.hardwareConcurrency || 2))
  const memory = getDeviceMemoryGb()
  if (memory >= 6 && cores >= 8) return 4
  if (memory >= 4 && cores >= 4) return 3
  return 2
}

function getMobileCacheSizeMb() {
  const configuredSize = getConfiguredNumber(import.meta.env.VITE_MOBILE_CORNERSTONE_CACHE_MB, 0)
  if (configuredSize > 0) return clampInteger(configuredSize, 96, 512)

  const memory = getDeviceMemoryGb()
  if (memory >= 8) return 384
  if (memory >= 4) return 256
  return 128
}

function getDeviceMemoryGb() {
  return Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 0
}

function buildCenterOutIndexes(imageCount: number, centerIndex: number, radius: number) {
  const safeCenter = clampIndex(centerIndex, imageCount)
  const indexes: number[] = []
  for (let offset = 1; offset <= radius; offset += 1) {
    const before = safeCenter - offset
    const after = safeCenter + offset
    if (before >= 0) indexes.push(before)
    if (after < imageCount) indexes.push(after)
  }
  return indexes
}

function clampIndex(value: number, imageCount: number) {
  return clampInteger(value, 0, Math.max(0, imageCount - 1))
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

function getConfiguredNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
