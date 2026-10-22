/**
 * Prefetch Engine — MPR Engine
 *
 * When a user requests slice N, pre-render adjacent slices in the
 * background and store in the frame cache.
 *
 * Adaptive prefetch adjusts the range based on scroll speed:
 *   - Fast scroll (>5 slices/sec): widen range to N±10
 *   - Normal scroll (2-5 slices/sec): N±5
 *   - Slow scroll (<2 slices/sec): narrow to N±2
 *   - Idle (>5 seconds since last scroll): stop prefetch
 *
 * @module mprEngine/prefetch
 */

import { renderSlice } from './sessionManager.mjs'
import { frameCache } from './cacheManager.mjs'

// ---------------------------------------------------------------------------
// Adaptive Prefetch Config
// ---------------------------------------------------------------------------

const MAX_PREFETCH_QUEUE = 50
const IDLE_THRESHOLD_MS = 5000 // 5 seconds without request = idle
const SPEED_WINDOW_MS = 2000   // Rolling window for speed calculation
const DEFAULT_RANGE = 3

const prefetchQueue = []
let isProcessing = false
let lastRequestTime = 0
let scrollTimestamps = [] // Array of { time, sliceIndex }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue prefetch tasks for slices adjacent to the requested slice.
 *
 * @param {string} sessionId
 * @param {object} options  — { plane, sliceIndex, ww, wc, level }
 */
export function enqueuePrefetch(sessionId, options) {
  const { plane, sliceIndex, ww, wc, level = 0 } = options

  // Track scroll timing
  const now = Date.now()
  lastRequestTime = now
  scrollTimestamps.push({ time: now, sliceIndex })

  // Prune old timestamps outside speed window
  const cutoff = now - SPEED_WINDOW_MS
  scrollTimestamps = scrollTimestamps.filter((t) => t.time >= cutoff)

  // Determine adaptive range based on scroll speed
  const range = computeAdaptiveRange(sliceIndex)

  for (const offset of range) {
    const targetSlice = sliceIndex + offset
    if (targetSlice < 0) continue

    // Check if already cached
    const cached = frameCache.get(sessionId, plane, targetSlice, ww, wc, level)
    if (cached) continue

    // Don't duplicate in queue
    const isQueued = prefetchQueue.some(
      (task) =>
        task.sessionId === sessionId &&
        task.plane === plane &&
        task.sliceIndex === targetSlice &&
        task.ww === ww &&
        task.wc === wc &&
        task.level === level
    )
    if (isQueued) continue

    if (prefetchQueue.length >= MAX_PREFETCH_QUEUE) {
      prefetchQueue.shift() // remove oldest
    }

    prefetchQueue.push({
      sessionId,
      plane,
      sliceIndex: targetSlice,
      ww,
      wc,
      level,
    })
  }

  // Start processing if not already running
  if (!isProcessing) {
    processQueue()
  }
}

// ---------------------------------------------------------------------------
// Adaptive Range Computation
// ---------------------------------------------------------------------------

/**
 * Compute the prefetch range based on scroll speed and direction.
 *
 * Returns an array of integer offsets (e.g., [-10, -9, ..., 9, 10])
 * that will be used to enqueue prefetch tasks.
 *
 * @param {number} currentSliceIndex
 * @returns {number[]} — Array of offsets (excluding 0)
 */
function computeAdaptiveRange(currentSliceIndex) {
  const now = Date.now()

  // Check if idle
  if (now - lastRequestTime > IDLE_THRESHOLD_MS) {
    return [] // Stop prefetch when idle
  }

  // If fewer than 2 scroll events, use default range
  if (scrollTimestamps.length < 2) {
    return generateOffsetRange(DEFAULT_RANGE)
  }

  // Calculate scroll speed (slices per second)
  const elapsed = now - scrollTimestamps[0].time
  if (elapsed <= 0) return generateOffsetRange(DEFAULT_RANGE)

  const sliceDelta = Math.abs(
    currentSliceIndex - scrollTimestamps[0].sliceIndex
  )
  const speed = sliceDelta / (elapsed / 1000) // slices per second

  // Also detect scroll direction
  const firstSlice = scrollTimestamps[0].sliceIndex
  const lastSlice = scrollTimestamps[scrollTimestamps.length - 1].sliceIndex
  const direction = lastSlice > firstSlice ? 1 : lastSlice < firstSlice ? -1 : 0

  let range
  if (speed > 5) {
    range = 10 // Fast scroll: wide range
  } else if (speed >= 2) {
    range = 5  // Normal scroll: medium range
  } else {
    range = 2  // Slow scroll: narrow range
  }

  // If direction is clear, bias prefetch in direction of travel
  if (direction !== 0) {
    const offsets = []
    for (let i = 1; i <= range; i++) {
      offsets.push(direction * i)
    }
    // Still include 1-2 in opposite direction for safety
    for (let i = 1; i <= Math.min(range, 2); i++) {
      offsets.push(-direction * i)
    }
    return [...new Set(offsets)].sort((a, b) => a - b)
  }

  return generateOffsetRange(range)
}

/**
 * Generate a symmetric range of offsets from -range to +range (excluding 0).
 * @param {number} range
 * @returns {number[]}
 */
function generateOffsetRange(range) {
  const offsets = []
  for (let i = -range; i <= range; i++) {
    if (i !== 0) offsets.push(i)
  }
  return offsets
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function processQueue() {
  if (isProcessing || prefetchQueue.length === 0) {
    isProcessing = false
    return
  }

  isProcessing = true

  const task = prefetchQueue.shift()
  if (!task) {
    isProcessing = false
    return
  }

  try {
    const buffer = await renderSlice(task.sessionId, {
      plane: task.plane,
      sliceIndex: task.sliceIndex,
      ww: task.ww,
      wc: task.wc,
      level: task.level,
    })

    if (buffer) {
      frameCache.set(
        task.sessionId,
        task.plane,
        task.sliceIndex,
        task.ww,
        task.wc,
        task.level,
        buffer
      )
    }
  } catch {
    // Silently fail prefetch — not critical
  }

  // Process next item with a small delay
  setTimeout(() => {
    isProcessing = false
    processQueue()
  }, 50)
}
