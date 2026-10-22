import { cache, volumeLoader } from '@cornerstonejs/core'
import { createWadoRsImageIds, isRenderableImageInstance, listInstances, registerWadoRsMetadata } from '../../dicomweb/client'
import type { InstanceSummary, SeriesSummary } from '../../dicomweb/types'

type SharedVolumeEntry = {
  volumeId: string
  instances: InstanceSummary[]
  promise: Promise<{ volumeId: string; instances: InstanceSummary[] }>
  references: number
  prepared: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
}

export type SharedVolumeScope = 'mpr' | 'bone3d'

export type VolumeLoadProgress = {
  framesLoaded: number
  framesProcessed: number
  totalNumFrames: number
}

export type VolumeLoadCallback = (progress: VolumeLoadProgress) => void

const sharedVolumes = new Map<string, SharedVolumeEntry>()
const PREPARED_VOLUME_TTL_MS = 300_000

export async function acquireSharedSeriesVolume(series: SeriesSummary, scope: SharedVolumeScope = 'mpr', ownerId: string = scope, onProgress?: VolumeLoadCallback) {
  const cacheKey = getSeriesVolumeCacheKey(series, scope, ownerId)
  const existing = sharedVolumes.get(cacheKey)
  if (existing) {
    if (existing.cleanupTimer) {
      clearTimeout(existing.cleanupTimer)
      existing.cleanupTimer = undefined
    }
    existing.prepared = false
    existing.references += 1
    return existing.promise
  }

  const volumeId = `vexa-volume-${createOpaqueVolumeId()}`
  const entry: SharedVolumeEntry = {
    volumeId,
    instances: [],
    references: 1,
    prepared: false,
    promise: loadSharedSeriesVolume(series, volumeId, onProgress)
      .then((result) => {
        entry.instances = result.instances
        return result
      })
      .catch((error) => {
        sharedVolumes.delete(cacheKey)
        throw error
      }),
  }

  sharedVolumes.set(cacheKey, entry)
  return entry.promise
}

export async function prepareMprSeriesVolume(series: SeriesSummary, ownerId: string, onProgress?: VolumeLoadCallback) {
  const cacheKey = getSeriesVolumeCacheKey(series, 'mpr', ownerId)
  const existing = sharedVolumes.get(cacheKey)
  if (existing) {
    return existing.promise
  }

  const volumeId = `vexa-volume-${createOpaqueVolumeId()}`
  const entry: SharedVolumeEntry = {
    volumeId,
    instances: [],
    references: 0,
    prepared: true,
    promise: loadSharedSeriesVolume(series, volumeId, onProgress)
      .then((result) => {
        entry.instances = result.instances
        return result
      })
      .catch((error) => {
        sharedVolumes.delete(cacheKey)
        throw error
      }),
  }

  sharedVolumes.set(cacheKey, entry)
  entry.cleanupTimer = setTimeout(() => {
    if (entry.references === 0 && entry.prepared) {
      removeSharedVolume(cacheKey, entry)
    }
  }, PREPARED_VOLUME_TTL_MS)

  return entry.promise
}

export function discardPreparedMprSeriesVolume(series: SeriesSummary, ownerId: string) {
  const cacheKey = getSeriesVolumeCacheKey(series, 'mpr', ownerId)
  const entry = sharedVolumes.get(cacheKey)
  if (entry && entry.references === 0 && entry.prepared) {
    removeSharedVolume(cacheKey, entry)
  }
}

export function releaseSharedSeriesVolume(series: SeriesSummary, scope: SharedVolumeScope = 'mpr', ownerId: string = scope) {
  const cacheKey = getSeriesVolumeCacheKey(series, scope, ownerId)
  const entry = sharedVolumes.get(cacheKey)
  if (!entry) {
    return
  }

  entry.references = Math.max(0, entry.references - 1)
  if (entry.references > 0) {
    return
  }

  // Hold the loaded volume briefly so rapid viewport remounts do not cancel
  // in-flight streaming and produce black/flickering 3D viewports.
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer)
  }
  entry.cleanupTimer = setTimeout(() => {
    removeSharedVolume(cacheKey, entry)
  }, 60_000)
}

async function loadSharedSeriesVolume(series: SeriesSummary, volumeId: string, onProgress?: VolumeLoadCallback) {
  const instances = (await listInstances(series)).filter(isRenderableImageInstance)
  if (!instances.length) {
    throw new Error('No renderable CT images found for volume rendering')
  }

  registerWadoRsMetadata(instances)
  const imageIds = createWadoRsImageIds(instances)
  const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds })
  startVolumeStreaming(volume, onProgress)

  return { volumeId, instances }
}

function getSeriesVolumeCacheKey(series: SeriesSummary, scope: SharedVolumeScope, ownerId: string) {
  return `${scope}|${ownerId}|${series.studyInstanceUid}|${series.seriesInstanceUid}`
}

function removeSharedVolume(cacheKey: string, entry: SharedVolumeEntry) {
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer)
  }
  try {
    cache.removeVolumeLoadObject(entry.volumeId)
  } catch {
    // The volume may already be evicted by Cornerstone.
  }
  sharedVolumes.delete(cacheKey)
}

function createOpaqueVolumeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function startVolumeStreaming(volume: Awaited<ReturnType<typeof volumeLoader.createAndCacheVolume>>, onProgress?: VolumeLoadCallback) {
  const streamingVolume = volume as unknown as {
    autoRenderOnLoad?: boolean
    loadStatus?: { loaded?: boolean }
    load: (callback?: (event: VolumeLoadCompletion) => void) => void
  }

  streamingVolume.autoRenderOnLoad = true
  if (streamingVolume.loadStatus?.loaded) {
    return
  }

  try {
    streamingVolume.load((event) => {
      if (event.framesProcessed >= event.totalNumFrames && event.framesLoaded < 1) {
        console.warn('Unable to load diagnostic volume.')
      }
      // Report progress to caller
      onProgress?.({
        framesLoaded: event.framesLoaded,
        framesProcessed: event.framesProcessed,
        totalNumFrames: event.totalNumFrames,
      })
    })
  } catch (error) {
    console.warn('Unable to start diagnostic volume streaming.', error)
  }
}

type VolumeLoadCompletion = {
  framesLoaded: number
  framesProcessed: number
  totalNumFrames: number
}
