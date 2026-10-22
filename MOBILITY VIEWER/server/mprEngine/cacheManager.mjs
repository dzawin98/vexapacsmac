/**
 * Cache Manager — MPR Engine
 *
 * 2-level cache for MPR rendering:
 *   Level 1: Rendered Frame Cache (memory, in-process)
 *     - Key: `${sessionId}:${plane}:${sliceIndex}:${ww}:${wc}:${level}:${zoom}:${pan}:${thickness}`
 *     - Value: Buffer (JPEG encoded)
 *     - LRU eviction with byte-count memory cap (512MB)
 *
 *   Level 2: Volume Cache
 *     - Key: `${studyUID}:${seriesUID}`
 *     - Value: { pixelData, metadata }
 *     - Max: 3 volumes
 *     - TTL: 30 min
 *
 * @module mprEngine/cacheManager
 */

// ---------------------------------------------------------------------------
// Level 1: Frame Cache with LRU memory cap
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_CAP_MB = 512
const MAX_MEMORY_BYTES = (() => {
  const envMb = Number(process.env.MPR_FRAME_CACHE_MB)
  if (Number.isFinite(envMb) && envMb > 0) return envMb * 1024 * 1024
  return DEFAULT_MEMORY_CAP_MB * 1024 * 1024
})()

class FrameCache {
  constructor(maxEntriesPerSession = 500) {
    /** @type {Map<string, { buffer: Buffer, accessTime: number, bytes: number }>} */
    this._cache = new Map()
    this._maxPerSession = maxEntriesPerSession
    this._totalBytes = 0
  }

  /**
   * Build cache key with ALL relevant parameters to avoid stale cache hits.
   *
   * @param {string} sessionId
   * @param {string} plane
   * @param {number} sliceIndex
   * @param {number} ww
   * @param {number} wc
   * @param {number} [level=0]
   * @param {number} [zoom=1]
   * @param {string} [pan='0,0']
   * @param {number} [thickness=1]
   * @returns {string}
   */
  _makeKey(sessionId, plane, sliceIndex, ww, wc, level = 0, zoom = 1, pan = '0,0', thickness = 1) {
    return `${sessionId}:${plane}:${sliceIndex}:${ww}:${wc}:${level}:${zoom}:${pan}:${thickness}`
  }

  /**
   * @param {string} sessionId
   * @param {string} plane
   * @param {number} sliceIndex
   * @param {number} ww
   * @param {number} wc
   * @param {number} [level=0]
   * @param {number} [zoom=1]
   * @param {string} [pan='0,0']
   * @param {number} [thickness=1]
   * @returns {Buffer|null}
   */
  get(sessionId, plane, sliceIndex, ww, wc, level = 0, zoom = 1, pan = '0,0', thickness = 1) {
    const key = this._makeKey(sessionId, plane, sliceIndex, ww, wc, level, zoom, pan, thickness)
    const entry = this._cache.get(key)
    if (!entry) return null
    entry.accessTime = Date.now()
    return entry.buffer
  }

  /**
   * @param {string} sessionId
   * @param {string} plane
   * @param {number} sliceIndex
   * @param {number} ww
   * @param {number} wc
   * @param {number} [level=0]
   * @param {Buffer} buffer
   * @param {number} [zoom=1]
   * @param {string} [pan='0,0']
   * @param {number} [thickness=1]
   */
  set(sessionId, plane, sliceIndex, ww, wc, level = 0, buffer, zoom = 1, pan = '0,0', thickness = 1) {
    const key = this._makeKey(sessionId, plane, sliceIndex, ww, wc, level, zoom, pan, thickness)
    const bytes = buffer.length

    // If key already exists, subtract old bytes first
    const existing = this._cache.get(key)
    if (existing) {
      this._totalBytes -= existing.bytes
    }

    // Evict oldest from this session if over per-session limit
    if (this._countEntriesForSession(sessionId) >= this._maxPerSession) {
      this._evictOldestForSession(sessionId)
    }

    // Evict globally if over memory cap
    while (this._totalBytes + bytes > MAX_MEMORY_BYTES && this._cache.size > 0) {
      this._evictOldestGlobal()
    }

    this._cache.set(key, { buffer, accessTime: Date.now(), bytes })
    this._totalBytes += bytes
  }

  /**
   * Get approximate memory usage in bytes.
   * @returns {number}
   */
  getMemoryUsageBytes() {
    return this._totalBytes
  }

  /**
   * Clear all entries for a session.
   * @param {string} sessionId
   */
  clearSession(sessionId) {
    for (const [key, entry] of this._cache) {
      if (key.startsWith(`${sessionId}:`)) {
        this._totalBytes -= entry.bytes
        this._cache.delete(key)
      }
    }
  }

  _countEntriesForSession(sessionId) {
    let count = 0
    for (const [key] of this._cache) {
      if (key.startsWith(`${sessionId}:`)) count++
    }
    return count
  }

  _evictOldestForSession(sessionId) {
    let oldestKey = null
    let oldestTime = Infinity
    for (const [key, entry] of this._cache) {
      if (key.startsWith(`${sessionId}:`) && entry.accessTime < oldestTime) {
        oldestTime = entry.accessTime
        oldestKey = key
      }
    }
    if (oldestKey) {
      const removed = this._cache.get(oldestKey)
      if (removed) this._totalBytes -= removed.bytes
      this._cache.delete(oldestKey)
    }
  }

  _evictOldestGlobal() {
    let oldestKey = null
    let oldestTime = Infinity
    for (const [key, entry] of this._cache) {
      if (entry.accessTime < oldestTime) {
        oldestTime = entry.accessTime
        oldestKey = key
      }
    }
    if (oldestKey) {
      const removed = this._cache.get(oldestKey)
      if (removed) this._totalBytes -= removed.bytes
      this._cache.delete(oldestKey)
    }
  }
}

// ---------------------------------------------------------------------------
// Level 2: Volume Cache
// ---------------------------------------------------------------------------

class VolumeCache {
  constructor(maxVolumes = 3, ttlMs = 30 * 60 * 1000) {
    /** @type {Map<string, { volume: object, created: number, lastAccess: number }>} */
    this._cache = new Map()
    this._max = maxVolumes
    this._ttl = ttlMs

    // Periodic cleanup
    setInterval(() => this._cleanup(), 60_000)
  }

  /**
   * @param {string} studyUid
   * @param {string} seriesUid
   * @returns {object|null}
   */
  get(studyUid, seriesUid) {
    const key = `${studyUid}:${seriesUid}`
    const entry = this._cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.lastAccess > this._ttl) {
      this._cache.delete(key)
      return null
    }
    entry.lastAccess = Date.now()
    return entry.volume
  }

  /**
   * @param {string} studyUid
   * @param {string} seriesUid
   * @param {object} volume
   */
  set(studyUid, seriesUid, volume) {
    const key = `${studyUid}:${seriesUid}`

    // Evict oldest if at capacity
    if (this._cache.size >= this._max && !this._cache.has(key)) {
      const oldest = [...this._cache.entries()].sort(
        (a, b) => a[1].lastAccess - b[1].lastAccess
      )[0]
      if (oldest) this._cache.delete(oldest[0])
    }

    this._cache.set(key, { volume, created: Date.now(), lastAccess: Date.now() })
  }

  _cleanup() {
    const now = Date.now()
    for (const [key, entry] of this._cache) {
      if (now - entry.lastAccess > this._ttl) {
        this._cache.delete(key)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instances
// ---------------------------------------------------------------------------

export const frameCache = new FrameCache()
export const volumeCache = new VolumeCache()
