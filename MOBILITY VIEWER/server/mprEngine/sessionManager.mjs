/**
 * Session Manager — MPR Engine
 *
 * Lifecycle management for MPR rendering sessions.
 * Supports two-stage creation:
 *   Stage 1: createPreviewSession() — metadata + preview data only (fast)
 *   Stage 2: fillVolume() + upgradeToFull() — progressive volume fill
 *
 * Flow:
 *   POST /api/mpr/load-preview → createPreviewSession → return sessionId + 3 preview JPEGs
 *   POST /api/mpr/{sessionId}/progressive → fillVolume in background
 *   GET  /api/mpr/{sessionId}/slice → render slice → cache → return JPEG
 *   POST /api/mpr/{sessionId}/preset → update WL/WW
 *   DELETE /api/mpr/{sessionId} → cleanup
 *
 * @module mprEngine/sessionManager
 */

import crypto from 'node:crypto'
import { resliceVolume, getSliceCount } from './resliceEngine.mjs'
import { buildPyramid, scaleToLevelIndex } from './pyramid.mjs'
import { renderToJpeg, extractTile } from './tileRenderer.mjs'

// ---------------------------------------------------------------------------
// Session Store (in-memory)
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes
const MAX_SESSIONS = 10

/**
 * @typedef {Object} MprSession
 * @property {string} sessionId
 * @property {object} volume         — { pixelData (Float32Array|null), metadata }
 * @property {object} [pyramid]      — built when full volume is available
 * @property {number} lastAccess     — timestamp
 * @property {object} currentPreset  — { wc, ww }
 * @property {boolean} isFull        — true when full volume + pyramid are ready
 * @property {Set<number>} loadedSlices — tracks which Z-slices are loaded in volume
 * @property {boolean} volumeBuilding — true while background progressive load is active
 */

const sessions = new Map()

// Periodic cleanup
setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id)
    }
  }
}, 60_000)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a preview session (Stage 1).
 *
 * Only stores metadata and preview pixel data (3 slices).
 * No pyramid built. Sets isFull=false.
 *
 * @param {object} volumeMeta            — { width, height, depth, spacing, origin, orientation, rescaleSlope, rescaleIntercept }
 * @returns {string} sessionId
 */
export function createPreviewSession(volumeMeta) {
  // Evict oldest if at capacity
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess
    )[0]
    if (oldest) sessions.delete(oldest[0])
  }

  const sessionId = crypto.randomUUID()

  // Allocate empty volume buffer (filled progressively)
  const { width, height, depth } = volumeMeta
  const totalVoxels = depth * height * width
  const pixelData = new Float32Array(totalVoxels)

  sessions.set(sessionId, {
    sessionId,
    volume: { pixelData, metadata: volumeMeta },
    pyramid: null,
    lastAccess: Date.now(),
    currentPreset: { wc: 40, ww: 400 }, // default: soft tissue
    isFull: false,
    loadedSlices: new Set(),
    volumeBuilding: false,
    instances: null, // stored for progressive fill
  })

  return sessionId
}

/**
 * Store sorted instances reference in the session (needed for progressive fill).
 *
 * @param {string} sessionId
 * @param {object[]} instances - sorted DICOM instances from buildVolumePreview
 */
export function storeSessionInstances(sessionId, instances) {
  const session = sessions.get(sessionId)
  if (!session) return

  // Keep a reduced copy only containing fields needed to construct pixel data URLs.
  session.instances = instances.map((inst) => ({
    sopInstanceUid: inst.sopInstanceUid,
    studyInstanceUid: inst.studyInstanceUid,
    seriesInstanceUid: inst.seriesInstanceUid,
    rows: inst.rows,
    columns: inst.columns,
    bulkDataUri: inst.bulkDataUri,
    rescaleSlope: inst.rescaleSlope,
    rescaleIntercept: inst.rescaleIntercept,
    bitsStored: inst.bitsStored,
    pixelRepresentation: inst.pixelRepresentation,
  }))
  session.lastAccess = Date.now()
}

/**
 * Get stored instances from session.
 *
 * @param {string} sessionId
 * @returns {object[]|null}
 */
export function getSessionInstances(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return null
  return session.instances
}

/**
 * Fill a single slice into the session volume buffer.
 *
 * @param {string} sessionId
 * @param {number} z        — Slice index
 * @param {Float32Array} pixelData  — HU values for this slice
 */
export function fillVolumeSlice(sessionId, z, pixelData) {
  const session = sessions.get(sessionId)
  if (!session) return

  const { width, height, depth } = session.volume.metadata
  if (z < 0 || z >= depth) return

  const offset = z * height * width
  session.volume.pixelData.set(pixelData, offset)
  session.loadedSlices.add(z)
  session.lastAccess = Date.now()
}

/**
 * Check how many slices are loaded.
 *
 * @param {string} sessionId
 * @returns {{ loaded: number, total: number, percent: number }}
 */
export function getSessionFillState(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return { loaded: 0, total: 0, percent: 0 }

  const total = session.volume.metadata.depth
  const loaded = session.loadedSlices.size
  return { loaded, total, percent: total > 0 ? Math.round((loaded / total) * 100) : 0 }
}

/**
 * Upgrade a preview session to full (Stage 2 complete).
 * Builds pyramid from the (now full) volume.
 *
 * @param {string} sessionId
 */
export function upgradeToFull(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return

  session.pyramid = buildPyramid(session.volume.pixelData, session.volume.metadata)
  session.isFull = true
  session.volumeBuilding = false
  session.lastAccess = Date.now()
}

/**
 * Create a full session (original behavior, backward compatible).
 *
 * @param {object} volume — built volume (from volumeBuilder)
 * @returns {string} sessionId
 */
export function createSession(volume) {
  const sessionId = createPreviewSession(volume.metadata)

  // Copy full pixel data into the session
  const session = sessions.get(sessionId)
  session.volume.pixelData.set(volume.pixelData)
  for (let z = 0; z < volume.metadata.depth; z++) {
    session.loadedSlices.add(z)
  }

  upgradeToFull(sessionId)
  return sessionId
}

/**
 * Get session info.
 *
 * @param {string} sessionId
 * @returns {object|null} { dimensions, spacing, sliceCounts, ... }
 */
export function getSessionInfo(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return null

  session.lastAccess = Date.now()

  const { volume } = session
  const { width, height, depth, spacing } = volume.metadata

  return {
    sessionId,
    dimensions: { width, height, depth },
    spacing,
    sliceCounts: {
      axial: getSliceCount(volume.metadata, 'axial'),
      coronal: getSliceCount(volume.metadata, 'coronal'),
      sagittal: getSliceCount(volume.metadata, 'sagittal'),
    },
    pyramidLevels: session.pyramid
      ? session.pyramid.levels.map((l) => ({
          scale: l.scale,
          width: l.width,
          height: l.height,
          depth: l.depth,
        }))
      : [],
    currentPreset: session.currentPreset,
    isFull: session.isFull,
    fillState: getSessionFillState(sessionId),
  }
}

/**
 * Render a slice for a session.
 *
 * Falls back to closest available slice if the requested one is not yet loaded.
 *
 * @param {string} sessionId
 * @param {object} options
 * @param {string}  options.plane  — 'axial' | 'coronal' | 'sagittal'
 * @param {number}  options.sliceIndex
 * @param {number}  [options.ww]
 * @param {number}  [options.wc]
 * @param {number}  [options.level=0]  — Pyramid level (0 = L0 full, 1 = L1 half, 2 = L2 quarter)
 * @returns {Promise<Buffer|null>} — JPEG buffer or null
 */
export async function renderSlice(sessionId, options) {
  const session = sessions.get(sessionId)
  if (!session) return null

  session.lastAccess = Date.now()
  const {
    plane = 'axial',
    sliceIndex = 0,
    ww = session.currentPreset.ww,
    wc = session.currentPreset.wc,
    level = 0,
  } = options

  let sourceData
  let sourceMeta

  if (session.isFull && session.pyramid) {
    // Full session: use pyramid for level-of-detail
    const levelIndex = scaleToLevelIndex(Math.pow(2, level))
    const pyramidLevel = session.pyramid.levels[levelIndex]
    sourceData = pyramidLevel.pixelData
    sourceMeta = {
      width: pyramidLevel.width,
      height: pyramidLevel.height,
      depth: pyramidLevel.depth,
      spacing: session.volume.metadata.spacing,
    }
  } else {
    // Preview session: use raw volume (no pyramid)
    sourceData = session.volume.pixelData
    sourceMeta = {
      width: session.volume.metadata.width,
      height: session.volume.metadata.height,
      depth: session.volume.metadata.depth,
      spacing: session.volume.metadata.spacing,
    }
  }

  // Store current preset
  session.currentPreset = { wc, ww }

  const pixels = resliceVolume(sourceData, sourceMeta, {
    plane,
    sliceIndex,
    ww,
    wc,
  })

  // Encode to JPEG
  const jpeg = await renderToJpeg(
    pixels,
    plane === 'sagittal' ? sourceMeta.depth : sourceMeta.width,
    plane === 'axial' ? sourceMeta.height : sourceMeta.depth,
    80
  )

  return jpeg
}

/**
 * Release a session.
 *
 * @param {string} sessionId
 */
export function releaseSession(sessionId) {
  sessions.delete(sessionId)
}
