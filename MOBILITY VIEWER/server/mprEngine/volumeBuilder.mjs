/**
 * Volume Builder — MPR Engine
 *
 * Reconstructs a 3D voxel volume from DICOM series by fetching instances
 * via the DICOMweb proxy (WADO-RS) and assembling them into a uniform
 * 3D array keyed by anatomical position (ImagePositionPatient).
 *
 * The volume is stored as a Float32Array (normalized HU values) with
 * associated metadata for reslicing: spacing, origin, dimensions.
 *
 * @module mprEngine/volumeBuilder
 */

import { request as httpRequest } from 'node:http'
import { resampleIsotropic } from './resliceEngine.mjs'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} VolumeMetadata
 * @property {number} width   — Columns (x)
 * @property {number} height  — Rows (y)
 * @property {number} depth   — Number of slices (z)
 * @property {number[]} spacing  — Voxel spacing [x, y, z] (mm)
 * @property {number[]} origin   — World origin of first slice [x, y, z]
 * @property {number[]} orientation — ImageOrientationPatient (6 values)
 * @property {number} rescaleSlope
 * @property {number} rescaleIntercept
 */

/**
 * @typedef {Object} BuiltVolume
 * @property {Float32Array} pixelData  — 3D array flattened [depth * height * width]
 * @property {VolumeMetadata} metadata
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a 3D volume from a DICOM series via the WADO-RS proxy.
 *
 * @param {string} studyUid
 * @param {string} seriesUid
 * @param {string} dicomwebBase  — Base URL of the DICOMweb endpoint (e.g. http://127.0.0.1:5001)
 * @param {object} [opts]
 * @param {number}  [opts.timeout=30000]  — Per-request timeout
 * @returns {Promise<BuiltVolume>}
 */
export async function buildVolume(studyUid, seriesUid, dicomwebBase, opts = {}) {
  const { timeout = 30000 } = opts

  // 1. Fetch instance list + metadata
  const instances = await fetchInstancesWithMetadata(studyUid, seriesUid, dicomwebBase, timeout)

  // 2. Sort by ImagePositionPatient Z-axis
  instances.sort((a, b) => {
    const az = a.imagePositionPatient?.[2] ?? 0
    const bz = b.imagePositionPatient?.[2] ?? 0
    return az - bz
  })

  // 3. Determine volume dimensions & geometry
  const { width, height } = instances[0] // assume uniform dimensions
  const depth = instances.length
  const spacing = computeVolumeSpacing(instances)
  const origin = [...(instances[0]?.imagePositionPatient ?? [0, 0, 0])]
  const orientation = instances[0]?.imageOrientationPatient ?? [1, 0, 0, 0, 1, 0]

  // 4. Allocate volume buffer
  const totalVoxels = depth * height * width
  const pixelData = new Float32Array(totalVoxels)

  // 5. Read pixel data from each instance
  for (let z = 0; z < depth; z++) {
    const instance = instances[z]
    const slicePixels = await fetchPixelData(instance, dicomwebBase, timeout)
    const offset = z * height * width
    pixelData.set(slicePixels, offset)
  }

  // 6. Resample to isotropic spacing (Priority #1)
  //    CT volumes often have 0.7×0.7×5.0mm spacing.
  //    Isotropic resampling is required for correct coronal/sagittal MPR.
  const { pixelData: isotropicPixelData, meta: isotropicMeta } = resampleIsotropic(
    pixelData,
    { width, height, depth, spacing, origin, orientation }
  )

  return {
    pixelData: isotropicPixelData,
    metadata: {
      width: isotropicMeta.width,
      height: isotropicMeta.height,
      depth: isotropicMeta.depth,
      spacing: isotropicMeta.spacing,
      origin: isotropicMeta.origin || origin,
      orientation: isotropicMeta.orientation || orientation,
      rescaleSlope: instances[0]?.rescaleSlope ?? 1,
      rescaleIntercept: instances[0]?.rescaleIntercept ?? 0,
    },
  }
}

/**
 * STAGE 1: Build a lightweight volume preview from just 3 slices (first, middle, last).
 *
 * Fetches metadata + sorts instances, returns volume geometry info + pixel data for 3 key slices.
 * No isotropic resampling (preview quality is acceptable at native spacing).
 *
 * @param {string} studyUid
 * @param {string} seriesUid
 * @param {string} dicomwebBase
 * @param {object} [opts]
 * @param {number}  [opts.timeout=30000]
 * @returns {Promise<{metadata: VolumeMetadata, instances: InstanceMeta[], previewSlices: number[], previewPixelData: Float32Array[]}>}
 */
export async function buildVolumePreview(studyUid, seriesUid, dicomwebBase, opts = {}) {
  const { timeout = 30000 } = opts

  // 1. Fetch instance list + metadata
  const instances = await fetchInstancesWithMetadata(studyUid, seriesUid, dicomwebBase, timeout)

  // 2. Sort by ImagePositionPatient Z-axis
  instances.sort((a, b) => {
    const az = a.imagePositionPatient?.[2] ?? 0
    const bz = b.imagePositionPatient?.[2] ?? 0
    return az - bz
  })

  // 3. Determine volume dimensions & geometry
  const { width, height } = instances[0]
  const depth = instances.length
  const spacing = computeVolumeSpacing(instances)
  const origin = [...(instances[0]?.imagePositionPatient ?? [0, 0, 0])]
  const orientation = instances[0]?.imageOrientationPatient ?? [1, 0, 0, 0, 1, 0]

  const metadata = {
    width, height, depth,
    spacing,
    origin,
    orientation,
    rescaleSlope: instances[0]?.rescaleSlope ?? 1,
    rescaleIntercept: instances[0]?.rescaleIntercept ?? 0,
  }

  // 4. Pick 3 key slices: first, middle, last
  const midZ = Math.floor(depth / 2)
  const previewSlices = [0, midZ, Math.max(0, depth - 1)]

  // 5. Fetch pixel data only for these 3 slices
  const previewPixelData = await Promise.all(
    previewSlices.map((z) => fetchPixelData(instances[z], dicomwebBase, timeout))
  )

  return { metadata, instances, previewSlices, previewPixelData }
}

/**
 * STAGE 2: Background progressive volume filler.
 *
 * Loads remaining slices in center-out order and calls onSlice(z, pixelData) for each.
 * Returns a promise that resolves when all slices have been loaded.
 *
 * @param {object[]} instances  — Sorted instances (from buildVolumePreview)
 * @param {object} volumeMeta  — Volume metadata (from buildVolumePreview)
 * @param {string} dicomwebBase
 * @param {function} onSlice   — Callback(z, pixelData, instance)
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<void>}
 */
export async function loadVolumeProgressive(instances, volumeMeta, dicomwebBase, onSlice, opts = {}) {
  const { timeout = 30000, signal } = opts
  const depth = instances.length
  const { width, height } = volumeMeta

  // Center-out order
  const order = centerOutOrder(depth)

  for (const z of order) {
    if (signal?.aborted) break

    const instance = instances[z]
    const slicePixels = await fetchPixelData(instance, dicomwebBase, timeout)

    onSlice(z, slicePixels, instance)
  }
}

// ---------------------------------------------------------------------------
// Internal: center-out slice order
// ---------------------------------------------------------------------------
function centerOutOrder(depth) {
  const order = []
  let low = Math.floor((depth - 1) / 2)
  let high = Math.ceil((depth - 1) / 2)

  while (low >= 0 || high < depth) {
    if (low === high) {
      order.push(low)
      low--
      high++
    } else {
      if (high < depth) order.push(high)
      if (low >= 0) order.push(low)
      low--
      high++
    }
  }

  return order
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} InstanceMeta
 * @property {string} sopInstanceUid
 * @property {number} rows
 * @property {number} columns
 * @property {number[]} imagePositionPatient
 * @property {number[]} [imageOrientationPatient]
 * @property {number} rescaleSlope
 * @property {number} rescaleIntercept
 * @property {number} bitsStored
 * @property {number} pixelRepresentation
 * @property {string} bulkDataUri  — URI to fetch pixel data
 */

async function fetchInstancesWithMetadata(studyUid, seriesUid, dicomwebBase, timeout) {
  const metadataUrl = `${getDicomWebBase(dicomwebBase)}/studies/${studyUid}/series/${seriesUid}/metadata`
  const datasets = await dicomJsonRequest(metadataUrl, timeout)

  return datasets.map((ds) => {
    const ipp = readNumberValues(ds, '00200032')
    const iop = readNumberValues(ds, '00200037')

    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: readString(ds, '00080018'),
      rows: Number(readString(ds, '00280010')) || 0,
      columns: Number(readString(ds, '00280011')) || 0,
      imagePositionPatient: ipp.length === 3 ? ipp : [0, 0, 0],
      imageOrientationPatient: iop.length === 6 ? iop : undefined,
      rescaleSlope: Number(readString(ds, '00281053')) || 1,
      rescaleIntercept: Number(readString(ds, '00281052')) || 0,
      bitsStored: Number(readString(ds, '00280101')) || 16,
      pixelRepresentation: Number(readString(ds, '00280103')) || 0,
      bulkDataUri: findBulkDataUri(ds),
      metadata: ds,
    }
  }).filter((inst) => inst.sopInstanceUid && inst.rows > 0 && inst.columns > 0)
}

export async function fetchPixelData(instance, dicomwebBase, timeout) {
  const url = `${getDicomWebBase(dicomwebBase)}/studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/raw`
  const { buffer, headers } = await rawPixelRequest(url, timeout)
  const dataType = String(headers['x-datatype'] || 'Float32').toLowerCase()

  // Use DataView on sliced ArrayBuffer (always byteOffset 0) to avoid
  // alignment errors from Buffer.concat's underlying buffer layout.
  const src = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const view = new DataView(src)

  if (dataType === 'float32') {
    const floatCount = Math.floor(buffer.byteLength / 4)
    const result = new Float32Array(floatCount)
    for (let i = 0; i < floatCount; i++) result[i] = view.getFloat32(i * 4, true)
    return result
  }
  if (dataType === 'int16') {
    const count = Math.floor(buffer.byteLength / 2)
    const result = new Float32Array(count)
    for (let i = 0; i < count; i++) result[i] = view.getInt16(i * 2, true)
    return result
  }
  if (dataType === 'uint16') {
    const count = Math.floor(buffer.byteLength / 2)
    const result = new Float32Array(count)
    for (let i = 0; i < count; i++) result[i] = view.getUint16(i * 2, true)
    return result
  }
  return decodePixelBuffer(buffer, instance)
}

function decodePixelBuffer(buffer, instance) {
  const expectedSize = instance.rows * instance.columns
  const bitsStored = instance.bitsStored || 16
  const isSigned = instance.pixelRepresentation === 1

  // Use DataView on sliced ArrayBuffer to avoid byteOffset alignment issues
  const src = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const view = new DataView(src)
  const count = Math.floor(buffer.byteLength / (bitsStored <= 8 ? 1 : 2))

  if (bitsStored <= 8) {
    const rawValues = new Float32Array(count)
    for (let i = 0; i < count; i++) rawValues[i] = view.getUint8(i)
    const slope = instance.rescaleSlope
    const intercept = instance.rescaleIntercept
    const floatValues = new Float32Array(expectedSize)
    for (let i = 0; i < Math.min(rawValues.length, expectedSize); i++) {
      floatValues[i] = rawValues[i] * slope + intercept
    }
    return floatValues
  }

  const rawValues = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    rawValues[i] = isSigned ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true)
  }

  const slope = instance.rescaleSlope
  const intercept = instance.rescaleIntercept
  const floatValues = new Float32Array(expectedSize)
  for (let i = 0; i < Math.min(rawValues.length, expectedSize); i++) {
    floatValues[i] = rawValues[i] * slope + intercept
  }

  return floatValues
}

function computeVolumeSpacing(instances) {
  // Pixel spacing from first instance
  const first = instances[0]
  let pixelSpacing = [1, 1]
  if (first.metadata?.['00280030']?.Value) {
    pixelSpacing = first.metadata['00280030'].Value.map(Number)
  }

  // Slice spacing: average distance between adjacent ImagePositionPatient Z
  let totalSpacing = 0
  let count = 0
  for (let i = 1; i < instances.length; i++) {
    const dz = Math.abs(
      (instances[i]?.imagePositionPatient?.[2] ?? 0) -
      (instances[i - 1]?.imagePositionPatient?.[2] ?? 0)
    )
    if (dz > 0 && dz < 100) {
      totalSpacing += dz
      count++
    }
  }
  const sliceSpacing = count > 0 ? totalSpacing / count : 1

  return [pixelSpacing[1] || 1, pixelSpacing[0] || 1, sliceSpacing]
}

// ---------------------------------------------------------------------------
// Helper: find BulkDataURI in DICOM JSON
// ---------------------------------------------------------------------------

function findBulkDataUri(dataset) {
  // Look for PixelData tag (7FE0,0010) with BulkDataURI
  const pixelData = dataset['7FE00010']
  if (pixelData?.BulkDataURI) {
    return pixelData.BulkDataURI
  }

  // Fallback: look in data set for any bulk data URI
  for (const tag of Object.keys(dataset)) {
    const el = dataset[tag]
    if (el?.BulkDataURI) {
      return el.BulkDataURI
    }
  }

  return null
}

function makeAbsolute(uri, base) {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri
  const normalizedBase = base.replace(/\/+$/, '')
  const normalizedUri = uri.replace(/^\/+/, '')
  return `${normalizedBase}/${normalizedUri}`
}

function getDicomWebBase(base) {
  const normalized = String(base || '').replace(/\/+$/, '')
  return /\/rs$/i.test(normalized) ? normalized : `${normalized}/rs`
}

function extractDicomwebPayload(buffer) {
  const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'))
  if (headerEnd < 0) return buffer

  const header = buffer.subarray(0, headerEnd).toString('latin1')
  if (!/content-type:/i.test(header) && !/content-location:/i.test(header)) {
    return buffer
  }

  const bodyStart = headerEnd + 4
  const nextBoundary = buffer.indexOf(Buffer.from('\r\n--'), bodyStart)
  return nextBoundary > bodyStart ? buffer.subarray(bodyStart, nextBoundary) : buffer.subarray(bodyStart)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function dicomJsonRequest(url, timeout) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? import('node:https').then(m => m.default) : import('node:http').then(m => m.default)
    const req = httpRequest(url, {
      method: 'GET',
      headers: { Accept: 'application/dicom+json' },
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`DICOMweb metadata request failed: ${res.statusCode} ${res.statusMessage}`))
        return
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('Failed to parse DICOM JSON response')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout: ${url}`)) })
    req.end()
  })
}

function binaryRequest(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream, multipart/related; type="application/octet-stream"' },
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Binary request failed: ${res.statusCode} ${res.statusMessage}`))
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout: ${url}`)) })
    req.end()
  })
}

function rawPixelRequest(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Raw pixel request failed: ${res.statusCode} ${res.statusMessage}`))
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout: ${url}`)) })
    req.end()
  })
}

function readString(dataset, tag) {
  const value = dataset?.[tag]?.Value?.[0]
  return value != null ? String(value) : ''
}

function readNumberValues(dataset, tag) {
  const values = dataset?.[tag]?.Value
  if (!Array.isArray(values)) return []
  return values.map(Number).filter(Number.isFinite)
}
