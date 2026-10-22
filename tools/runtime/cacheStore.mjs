import { gzipSync, gunzipSync } from 'node:zlib'

const defaultMaxBytes = 128 * 1024 * 1024
const defaultMaxEntryBytes = 16 * 1024 * 1024

export function createCacheStore(options = {}) {
  const namespace = String(options.namespace || 'runtime-cache')
  const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes || defaultMaxBytes))
  const maxEntries = Math.max(1, Number(options.maxEntries || 5000))
  const maxEntryBytes = Math.max(1024, Number(options.maxEntryBytes || defaultMaxEntryBytes))
  const defaultTtlMs = Math.max(0, Number(options.defaultTtlMs || 0))
  const compressValues = Boolean(options.compressValues)
  const compressionMinBytes = Math.max(1024, Number(options.compressionMinBytes || 64 * 1024))
  const store = new Map()
  const counters = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
    bytes: 0,
  }

  function get(key) {
    const cacheKey = normalizeKey(key)
    const entry = store.get(cacheKey)
    if (!entry) {
      counters.misses += 1
      return null
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      deleteEntry(cacheKey, true)
      counters.misses += 1
      return null
    }

    counters.hits += 1
    entry.lastAccess = Date.now()
    store.delete(cacheKey)
    store.set(cacheKey, entry)
    return unpackValue(entry)
  }

  function set(key, value, ttlMs = defaultTtlMs) {
    const cacheKey = normalizeKey(key)
    const packed = packValue(value)
    if (packed.bytes > maxEntryBytes) {
      deleteEntry(cacheKey, false)
      return false
    }

    deleteEntry(cacheKey, false)
    const entry = {
      ...packed,
      createdAt: Date.now(),
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
      lastAccess: Date.now(),
    }
    store.set(cacheKey, entry)
    counters.bytes += entry.bytes
    counters.sets += 1
    evictIfNeeded()
    return true
  }

  function del(key) {
    return deleteEntry(normalizeKey(key), false)
  }

  function clear() {
    store.clear()
    counters.bytes = 0
    counters.deletes += 1
  }

  function stats() {
    return {
      namespace,
      backend: 'memory',
      entries: store.size,
      bytes: counters.bytes,
      maxBytes,
      maxEntries,
      maxEntryBytes,
      hits: counters.hits,
      misses: counters.misses,
      sets: counters.sets,
      deletes: counters.deletes,
      evictions: counters.evictions,
      hitRate: counters.hits + counters.misses > 0
        ? Number((counters.hits / (counters.hits + counters.misses)).toFixed(4))
        : 0,
    }
  }

  function sweepExpired() {
    const now = Date.now()
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        deleteEntry(key, true)
      }
    }
  }

  function deleteEntry(key, evicted) {
    const entry = store.get(key)
    if (!entry) return false
    store.delete(key)
    counters.bytes = Math.max(0, counters.bytes - entry.bytes)
    if (evicted) counters.evictions += 1
    else counters.deletes += 1
    return true
  }

  function evictIfNeeded() {
    while (store.size > maxEntries || counters.bytes > maxBytes) {
      const oldestKey = store.keys().next().value
      if (!oldestKey) break
      deleteEntry(oldestKey, true)
    }
  }

  function packValue(value) {
    const estimatedBytes = estimateValueBytes(value)
    const canCompress = Buffer.isBuffer(value) || typeof value === 'string' || isPlainJsonValue(value)
    const buffer = canCompress && !hasNestedBuffer(value)
      ? Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
      : null
    if (compressValues && buffer && buffer.length >= compressionMinBytes) {
      const compressed = gzipSync(buffer, { level: 4 })
      if (compressed.length < buffer.length) {
        return {
          value: compressed,
          bytes: compressed.length,
          rawBytes: buffer.length,
          compressed: true,
          json: !Buffer.isBuffer(value),
        }
      }
    }

    return {
      value,
      bytes: estimatedBytes,
      rawBytes: estimatedBytes,
      compressed: false,
      json: canCompress && !Buffer.isBuffer(value),
    }
  }

  function unpackValue(entry) {
    if (!entry.compressed) return entry.value
    const inflated = gunzipSync(entry.value)
    return entry.json ? JSON.parse(inflated.toString('utf8')) : inflated
  }

  return { get, set, delete: del, clear, stats, sweepExpired }
}

export function normalizeKey(key) {
  if (Array.isArray(key)) return key.map((part) => String(part)).join('\u001f')
  return String(key)
}

function estimateValueBytes(value) {
  if (Buffer.isBuffer(value)) return value.length
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (value && typeof value === 'object') {
    let bytes = 0
    for (const [key, item] of Object.entries(value)) {
      bytes += Buffer.byteLength(key)
      if (Buffer.isBuffer(item)) bytes += item.length
      else if (typeof item === 'string') bytes += Buffer.byteLength(item)
      else if (typeof item === 'number' || typeof item === 'boolean') bytes += 8
      else if (item && typeof item === 'object') bytes += estimateValueBytes(item)
    }
    return bytes
  }
  return 8
}

function hasNestedBuffer(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return false
  return Object.values(value).some((item) => Buffer.isBuffer(item) || hasNestedBuffer(item))
}

function isPlainJsonValue(value) {
  if (value === null) return true
  if (Array.isArray(value)) return value.every(isPlainJsonValue)
  if (typeof value !== 'object') return ['string', 'number', 'boolean'].includes(typeof value)
  if (Buffer.isBuffer(value)) return false
  return Object.values(value).every(isPlainJsonValue)
}
