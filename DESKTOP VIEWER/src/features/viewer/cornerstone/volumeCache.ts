import { cache, volumeLoader } from '@cornerstonejs/core'
import { createWadoRsImageIds, isRenderableImageInstance, listInstances, registerWadoRsMetadata } from '../../dicomweb/client'
import type { InstanceSummary, SeriesSummary } from '../../dicomweb/types'
import { registerVolumeProgressiveLoading } from './progressiveLoading'

type SharedVolumeEntry = {
  volumeId: string
  instances: InstanceSummary[]
  promise: Promise<LoadedSharedVolume>
  references: number
  prepared: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
}

type LoadedSharedVolume = {
  volumeId: string
  instances: InstanceSummary[]
  streamingComplete: Promise<void>
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

export function getDiagnosticVolumeOwnerId(viewportKey: string) {
  return `diagnostic-volume-${viewportKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

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
        if (entry.references === 0 && entry.prepared) {
          entry.cleanupTimer = setTimeout(() => {
            if (entry.references === 0 && entry.prepared) {
              removeSharedVolume(cacheKey, entry)
            }
          }, PREPARED_VOLUME_TTL_MS)
        }
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

  // VTK textures are owned by the RenderingEngine WebGL context. When the
  // viewer unmounts that engine is destroyed, so reusing the cached volume can
  // bind textures from the old context and leave the next viewport blank.
  removeSharedVolume(cacheKey, entry)
}

async function loadSharedSeriesVolume(series: SeriesSummary, volumeId: string, onProgress?: VolumeLoadCallback, waitForStreaming = false) {
  const instances = (await listInstances(series)).filter(isRenderableImageInstance)
  if (!instances.length) {
    throw new Error('No renderable CT images found for volume rendering')
  }

  registerWadoRsMetadata(instances)
  const imageIds = createWadoRsImageIds(instances)
  registerVolumeProgressiveLoading(volumeId)
  const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds })
  const streamingComplete = startVolumeStreaming(volume, onProgress)
  if (waitForStreaming) {
    await streamingComplete
  }

  return { volumeId, instances, streamingComplete }
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
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    try {
      streamingVolume.load((event) => {
        onProgress?.({
          framesLoaded: event.framesLoaded,
          framesProcessed: event.framesProcessed,
          totalNumFrames: event.totalNumFrames,
        })
        resolve()
      })
    } catch (error) {
      console.warn('Unable to start diagnostic volume streaming.', error)
      resolve()
    }
  })
}

type VolumeLoadCompletion = {
  framesLoaded: number
  framesProcessed: number
  totalNumFrames: number
}
