import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const dicomParser = require('dicom-parser')

const volumeCache = new Map()
const pendingVolumeLoads = new Map()
const maxCachedVolumes = Math.max(1, Number(process.env.VEXA_THIN_VOLUME_CACHE_MAX ?? 2))

export async function loadThinSeriesVolume({ studyInstanceUid, seriesInstanceUid }) {
  const cacheKey = `${studyInstanceUid}|${seriesInstanceUid}`
  const cached = volumeCache.get(cacheKey)
  if (cached) {
    cached.lastAccess = Date.now()
    return cached
  }

  const pending = pendingVolumeLoads.get(cacheKey)
  if (pending) {
    return pending
  }

  const pendingLoad = loadThinSeriesVolumeUncached({ studyInstanceUid, seriesInstanceUid, cacheKey })
    .finally(() => {
      pendingVolumeLoads.delete(cacheKey)
    })
  pendingVolumeLoads.set(cacheKey, pendingLoad)
  return pendingLoad
}

async function loadThinSeriesVolumeUncached({ studyInstanceUid, seriesInstanceUid, cacheKey }) {
  const loadStartedAt = Date.now()
  const storageRoot = resolveStorageRoot()
  const studyPath = path.join(storageRoot, studyInstanceUid)
  if (!existsSync(studyPath)) {
    throw new Error(`Study folder not found: ${studyPath}`)
  }

  const files = await collectFiles(studyPath)
  const instances = []

  for (const filePath of files) {
    const instance = await parseInstanceHeader(filePath)
    if (instance?.seriesInstanceUid === seriesInstanceUid) {
      instances.push(instance)
    }
  }

  if (!instances.length) {
    throw new Error(`No DICOM instances found for series ${seriesInstanceUid}`)
  }

  const sorted = sortInstances(instances)
  const first = sorted[0]
  const rows = first.rows
  const columns = first.columns
  if (!rows || !columns) {
    throw new Error('Series has invalid image dimensions')
  }

  const voxelCount = rows * columns * sorted.length
  const scalarData = new Int16Array(voxelCount)
  const decodedJpeg2000Frames = isJpeg2000TransferSyntax(first.transferSyntaxUid)
    ? await decodeJpeg2000Frames(sorted, rows * columns * 2)
    : null

  for (let slice = 0; slice < sorted.length; slice += 1) {
    const pixels = await decodeNativeInt16Pixels(sorted[slice], decodedJpeg2000Frames?.[slice])
    scalarData.set(pixels, slice * rows * columns)
  }

  const volume = {
    key: cacheKey,
    studyInstanceUid,
    seriesInstanceUid,
    scalarData,
    dimensions: [columns, rows, sorted.length],
    spacing: [
      first.columnPixelSpacing || first.rowPixelSpacing || 1,
      first.rowPixelSpacing || first.columnPixelSpacing || 1,
      estimateSliceSpacing(sorted),
    ],
    origin: first.imagePositionPatient || [0, 0, 0],
    direction: buildDirection(first.imageOrientationPatient),
    slope: 1,
    intercept: 0,
    rows,
    columns,
    slices: sorted.length,
    sopInstanceUids: sorted.map((instance) => instance.sopInstanceUid),
    sourceTransferSyntaxUid: first.transferSyntaxUid,
    modality: first.modality,
    createdAt: Date.now(),
    loadMs: Date.now() - loadStartedAt,
    lastAccess: Date.now(),
    bytes: scalarData.byteLength,
  }

  volumeCache.set(cacheKey, volume)
  evictOldVolumes()
  return volume
}

export function getThinVolumeCacheStats() {
  const volumes = [...volumeCache.values()].map((volume) => ({
    key: volume.key,
    dimensions: volume.dimensions,
    bytes: volume.bytes,
    createdAt: volume.createdAt,
    loadMs: volume.loadMs,
    lastAccess: volume.lastAccess,
  }))
  return {
    count: volumes.length,
    bytes: volumes.reduce((sum, item) => sum + item.bytes, 0),
    volumes,
  }
}

function resolveStorageRoot() {
  return path.resolve(
    process.env.DICOM_STORAGE_PATH ||
      process.env.PACS_STORAGE_PATH ||
      path.join(process.cwd(), '..', 'DATA'),
  )
}

async function collectFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) return []
      return collectFiles(entryPath)
    }
    if (!entry.isFile() || entry.name === 'image.db' || entry.name.endsWith('.json')) {
      return []
    }
    return [entryPath]
  }))
  return children.flat()
}

async function parseInstanceHeader(filePath) {
  try {
    const bytes = await fs.readFile(filePath)
    const dataset = dicomParser.parseDicom(new Uint8Array(bytes))
    const pixelDataElement = dataset.elements.x7fe00010
    if (!pixelDataElement) return null

    const samplesPerPixel = dataset.uint16('x00280002') || 1
    const bitsAllocated = dataset.uint16('x00280100') || 16
    const transferSyntaxUid = dataset.string('x00020010') || '1.2.840.10008.1.2'
    const encapsulated = isEncapsulatedTransferSyntax(transferSyntaxUid)
    if (samplesPerPixel !== 1 || bitsAllocated !== 16 || (encapsulated && !isJpeg2000TransferSyntax(transferSyntaxUid))) {
      return null
    }

    return {
      filePath,
      bytes,
      dataset,
      pixelDataElement,
      studyInstanceUid: dataset.string('x0020000d') || '',
      seriesInstanceUid: dataset.string('x0020000e') || '',
      sopInstanceUid: dataset.string('x00080018') || '',
      transferSyntaxUid,
      modality: dataset.string('x00080060') || '',
      instanceNumber: Number(dataset.string('x00200013') || 0),
      rows: dataset.uint16('x00280010') || 0,
      columns: dataset.uint16('x00280011') || 0,
      pixelRepresentation: dataset.uint16('x00280103') || 0,
      rescaleSlope: Number(dataset.string('x00281053') || 1) || 1,
      rescaleIntercept: Number(dataset.string('x00281052') || 0) || 0,
      imagePositionPatient: parseNumberList(dataset.string('x00200032')),
      imageOrientationPatient: parseNumberList(dataset.string('x00200037')),
      rowPixelSpacing: parseNumberList(dataset.string('x00280030'))?.[0] || 1,
      columnPixelSpacing: parseNumberList(dataset.string('x00280030'))?.[1] || 1,
      sliceThickness: Number(dataset.string('x00180050') || 1) || 1,
    }
  } catch {
    return null
  }
}

function sortInstances(instances) {
  const firstOrientation = instances.find((item) => item.imageOrientationPatient)?.imageOrientationPatient
  const normal = firstOrientation ? normalFromOrientation(firstOrientation) : null
  return [...instances].sort((a, b) => {
    if (normal && a.imagePositionPatient && b.imagePositionPatient) {
      const da = dot(a.imagePositionPatient, normal)
      const db = dot(b.imagePositionPatient, normal)
      if (Math.abs(da - db) > 1e-3) return da - db
    }
    return a.instanceNumber - b.instanceNumber
  })
}

async function decodeNativeInt16Pixels(instance, decodedFrame) {
  const { dataset, pixelDataElement, rows, columns, pixelRepresentation, rescaleSlope, rescaleIntercept, transferSyntaxUid } = instance
  const frameSize = rows * columns
  const pixels = new Int16Array(frameSize)
  let nativeBytes

  if (decodedFrame) {
    nativeBytes = decodedFrame
  } else if (isJpeg2000TransferSyntax(transferSyntaxUid)) {
    const encodedFrame = extractEncapsulatedFrame(dataset, pixelDataElement)
    if (!encodedFrame) {
      throw new Error(`Unable to extract JPEG 2000 frame from ${instance.sopInstanceUid}`)
    }
    nativeBytes = await decodeJpeg2000Frame(encodedFrame, frameSize * 2)
  } else {
    const byteOffset = (dataset.byteArray.byteOffset ?? 0) + pixelDataElement.dataOffset
    nativeBytes = Buffer.from(dataset.byteArray.buffer, byteOffset, frameSize * 2)
  }

  const view = new DataView(nativeBytes.buffer, nativeBytes.byteOffset, frameSize * 2)
  const signed = pixelRepresentation === 1

  for (let i = 0; i < frameSize; i += 1) {
    const raw = signed ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true)
    const hu = Math.round(raw * rescaleSlope + rescaleIntercept)
    pixels[i] = clampInt16(hu)
  }

  instance.bytes = null
  instance.dataset = null
  return pixels
}

function estimateSliceSpacing(instances) {
  if (instances.length < 2) {
    return instances[0]?.sliceThickness || 1
  }
  const orientation = instances[0]?.imageOrientationPatient
  const normal = orientation ? normalFromOrientation(orientation) : null
  if (!normal) {
    return instances[0]?.sliceThickness || 1
  }
  const distances = instances
    .map((instance) => instance.imagePositionPatient ? dot(instance.imagePositionPatient, normal) : null)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  if (distances.length < 2) {
    return instances[0]?.sliceThickness || 1
  }
  const gaps = []
  for (let i = 1; i < distances.length; i += 1) {
    const gap = Math.abs(distances[i] - distances[i - 1])
    if (gap > 1e-3) gaps.push(gap)
  }
  if (!gaps.length) {
    return instances[0]?.sliceThickness || 1
  }
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

function buildDirection(orientation) {
  if (!orientation || orientation.length < 6) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  }
  const row = orientation.slice(0, 3)
  const column = orientation.slice(3, 6)
  const normal = normalFromOrientation(orientation)
  return [...row, ...column, ...normal]
}

function normalFromOrientation(orientation) {
  const row = orientation.slice(0, 3)
  const column = orientation.slice(3, 6)
  return [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0],
  ]
}

function parseNumberList(value) {
  if (!value) return null
  const values = String(value).split('\\').map(Number).filter(Number.isFinite)
  return values.length ? values : null
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function isEncapsulatedTransferSyntax(transferSyntaxUid) {
  return transferSyntaxUid.startsWith('1.2.840.10008.1.2.4.') || transferSyntaxUid === '1.2.840.10008.1.2.5'
}

function isJpeg2000TransferSyntax(transferSyntaxUid) {
  return transferSyntaxUid === '1.2.840.10008.1.2.4.90'
    || transferSyntaxUid === '1.2.840.10008.1.2.4.91'
    || transferSyntaxUid === '1.2.840.10008.1.2.4.92'
    || transferSyntaxUid === '1.2.840.10008.1.2.4.93'
}

function extractEncapsulatedFrame(dataset, pixelDataElement) {
  const fragment = pixelDataElement.fragments?.[0]
  if (!fragment || typeof fragment.position !== 'number' || typeof fragment.length !== 'number') {
    return null
  }
  const byteOffset = dataset.byteArray.byteOffset ?? 0
  return Buffer.from(dataset.byteArray.buffer, byteOffset + fragment.position, fragment.length)
}

async function decodeJpeg2000Frame(encodedFrame, expectedByteLength) {
  const python = process.env.DICOMWEB_JPEG2000_DECODER_PYTHON
    || process.env.DICOMWEB_HTJ2K_DECODER_PYTHON
    || process.env.PYTHON
    || 'python'
  const script = [
    'import sys',
    'import openjpeg',
    'data = sys.stdin.buffer.read()',
    'arr = openjpeg.decode(data, j2k_format=0)',
    "sys.stdout.buffer.write(arr.tobytes(order='C'))",
  ].join('\n')
  const decoded = await runPythonBinaryFilter(python, ['-c', script], encodedFrame)
  if (decoded.byteLength < expectedByteLength) {
    throw new Error(`JPEG 2000 decoder returned ${decoded.byteLength} byte(s), expected ${expectedByteLength}`)
  }
  return decoded.byteLength === expectedByteLength ? decoded : decoded.subarray(0, expectedByteLength)
}

async function decodeJpeg2000Frames(instances, expectedByteLength) {
  const chunks = []
  for (const instance of instances) {
    const encodedFrame = extractEncapsulatedFrame(instance.dataset, instance.pixelDataElement)
    if (!encodedFrame) {
      throw new Error(`Unable to extract JPEG 2000 frame from ${instance.sopInstanceUid}`)
    }
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(encodedFrame.byteLength)
    chunks.push(header, encodedFrame)
  }

  const python = process.env.DICOMWEB_JPEG2000_DECODER_PYTHON
    || process.env.DICOMWEB_HTJ2K_DECODER_PYTHON
    || process.env.PYTHON
    || 'python'
  const script = [
    'import sys',
    'import openjpeg',
    'source = sys.stdin.buffer',
    'target = sys.stdout.buffer',
    'while True:',
    '    header = source.read(4)',
    '    if not header:',
    '        break',
    "    size = int.from_bytes(header, 'big')",
    '    data = source.read(size)',
    '    arr = openjpeg.decode(data, j2k_format=0)',
    "    raw = arr.tobytes(order='C')",
    "    target.write(len(raw).to_bytes(4, 'big'))",
    '    target.write(raw)',
  ].join('\n')
  const output = await runPythonBinaryFilter(python, ['-c', script], Buffer.concat(chunks))
  const decodedFrames = []
  let offset = 0
  while (offset + 4 <= output.byteLength) {
    const length = output.readUInt32BE(offset)
    offset += 4
    if (offset + length > output.byteLength) {
      throw new Error('JPEG 2000 batch decoder returned a truncated frame')
    }
    const frame = output.subarray(offset, offset + length)
    offset += length
    if (frame.byteLength < expectedByteLength) {
      throw new Error(`JPEG 2000 batch decoder returned ${frame.byteLength} byte(s), expected ${expectedByteLength}`)
    }
    decodedFrames.push(frame.byteLength === expectedByteLength ? frame : frame.subarray(0, expectedByteLength))
  }
  if (decodedFrames.length !== instances.length) {
    throw new Error(`JPEG 2000 batch decoder returned ${decodedFrames.length} frame(s), expected ${instances.length}`)
  }
  return decodedFrames
}

function runPythonBinaryFilter(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout))
        return
      }
      reject(new Error(`JPEG 2000 decoder failed with exit code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`))
    })
    child.stdin.end(input)
  })
}

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, value))
}

function evictOldVolumes() {
  while (volumeCache.size > maxCachedVolumes) {
    const oldest = [...volumeCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0]
    if (!oldest) return
    volumeCache.delete(oldest[0])
  }
}
