import { Enums, imageLoader, metaData, type Types } from '@cornerstonejs/core'
import { appUrl } from '../../../config/appBase'
import type { InstanceSummary, SeriesSummary, StudySummary } from '../../dicomweb/types'

type StackImageDescriptor = {
  imageId: string
  studyInstanceUid: string
  seriesInstanceUid: string
  index: number
  rows: number
  columns: number
  rowPixelSpacing: number
  columnPixelSpacing: number
  sliceSpacing: number
  imagePositionPatient: number[]
  imageOrientationPatient: number[]
  frameOfReferenceUid: string
  windowCenter: number
  windowWidth: number
  modality: string
}

type ServerStackLoaderGlobal = typeof globalThis & {
  __vexaServerStackDescriptors?: Map<string, StackImageDescriptor>
  __vexaServerStackImageCache?: Map<string, Types.IImage>
}

const loaderGlobal = globalThis as ServerStackLoaderGlobal
const descriptors = loaderGlobal.__vexaServerStackDescriptors ?? new Map<string, StackImageDescriptor>()
const imageCache = loaderGlobal.__vexaServerStackImageCache ?? new Map<string, Types.IImage>()
loaderGlobal.__vexaServerStackDescriptors = descriptors
loaderGlobal.__vexaServerStackImageCache = imageCache
let initialized = false
const SERVER_STACK_IMAGE_CACHE_LIMIT = 96

export function initializeServerStackImageLoader() {
  if (initialized) return
  imageLoader.registerImageLoader('vexa-stack', loadServerStackImage)
  metaData.addProvider(serverStackMetadataProvider, 10_000)
  initialized = true
}

export function createServerStackImageIds(input: {
  study?: StudySummary | null
  series: SeriesSummary
  instances: InstanceSummary[]
  windowLevel: { windowWidth: number; windowLevel: number }
}) {
  const sorted = [...input.instances].sort((a, b) => a.instanceNumber - b.instanceNumber)
  const first = sorted[0]
  const spacing = readPixelSpacing(first)
  const sliceSpacing = estimateSliceSpacing(sorted)
  const orientation = first?.imageOrientationPatient?.length === 6 ? first.imageOrientationPatient : [1, 0, 0, 0, 1, 0]
  const frameOfReferenceUid = `vexa-stack-${input.series.studyInstanceUid}`

  return sorted.map((instance, index) => {
    const imageId = `vexa-stack:${encodeURIComponent(input.series.studyInstanceUid)}:${encodeURIComponent(input.series.seriesInstanceUid)}:${index}`
    const descriptor: StackImageDescriptor = {
      imageId,
      studyInstanceUid: input.series.studyInstanceUid,
      seriesInstanceUid: input.series.seriesInstanceUid,
      index,
      rows: instance.rows || first?.rows || 512,
      columns: instance.columns || first?.columns || 512,
      rowPixelSpacing: spacing[0],
      columnPixelSpacing: spacing[1],
      sliceSpacing,
      imagePositionPatient: instance.imagePositionPatient?.length === 3
        ? instance.imagePositionPatient
        : estimateImagePosition(first?.imagePositionPatient, orientation, sliceSpacing, index),
      imageOrientationPatient: instance.imageOrientationPatient?.length === 6 ? instance.imageOrientationPatient : orientation,
      frameOfReferenceUid,
      windowCenter: input.windowLevel.windowLevel,
      windowWidth: input.windowLevel.windowWidth,
      modality: input.series.modality || 'CT',
    }
    descriptors.set(imageId, descriptor)
    return imageId
  })
}

function loadServerStackImage(imageId: string) {
  const descriptor = descriptors.get(imageId)
  const controller = new AbortController()
  const cached = imageCache.get(imageId)
  const promise = descriptor
    ? cached
      ? Promise.resolve(cached)
      : fetchStackFrame(descriptor, controller.signal).then((image) => {
        imageCache.set(imageId, image)
        while (imageCache.size > SERVER_STACK_IMAGE_CACHE_LIMIT) {
          const oldest = imageCache.keys().next().value
          if (!oldest) break
          imageCache.delete(oldest)
        }
        return image
      })
    : Promise.reject(new Error(`Server stack image descriptor not found: ${imageId}`))
  return {
    promise,
    cancelFn: () => controller.abort(),
    decache: () => {
      descriptors.delete(imageId)
      imageCache.delete(imageId)
    },
  }
}

async function fetchStackFrame(descriptor: StackImageDescriptor, signal: AbortSignal) {
  const url = appUrl(`/api/render/stack-frame?studyInstanceUid=${encodeURIComponent(descriptor.studyInstanceUid)}&seriesInstanceUid=${encodeURIComponent(descriptor.seriesInstanceUid)}&index=${descriptor.index}`)
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/vnd.vexa.stack-frame+int16' },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error || `Server stack frame failed: ${response.status}`)
  }

  const rows = Number(response.headers.get('X-Stack-Rows') || descriptor.rows)
  const columns = Number(response.headers.get('X-Stack-Columns') || descriptor.columns)
  const buffer = await response.arrayBuffer()
  const expectedBytes = rows * columns * Int16Array.BYTES_PER_ELEMENT
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`Server stack frame returned ${buffer.byteLength} bytes; expected ${expectedBytes}`)
  }
  const sourceData = new Int16Array(buffer)
  const scalarData = new Float32Array(sourceData.length)
  let minPixelValue = sourceData[0] ?? 0
  let maxPixelValue = sourceData[0] ?? 0
  for (let index = 0; index < sourceData.length; index += 1) {
    const value = sourceData[index]
    scalarData[index] = value
    if (value < minPixelValue) minPixelValue = value
    if (value > maxPixelValue) maxPixelValue = value
  }

  return {
    imageId: descriptor.imageId,
    intercept: 0,
    slope: 1,
    minPixelValue,
    maxPixelValue,
    windowCenter: [descriptor.windowCenter],
    windowWidth: [descriptor.windowWidth],
    voiLUTFunction: Enums.VOILUTFunctionType.LINEAR,
    getPixelData: () => scalarData,
    rows,
    columns,
    height: rows,
    width: columns,
    color: false,
    rgba: false,
    numberOfComponents: 1,
    columnPixelSpacing: descriptor.columnPixelSpacing,
    rowPixelSpacing: descriptor.rowPixelSpacing,
    sliceThickness: descriptor.sliceSpacing,
    invert: false,
    photometricInterpretation: 'MONOCHROME2',
    sizeInBytes: scalarData.byteLength,
    imageQualityStatus: Enums.ImageQualityStatus.FULL_RESOLUTION,
    FrameOfReferenceUID: descriptor.frameOfReferenceUid,
    dataType: 'Float32Array',
    imageFrame: {
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      planarConfiguration: 0,
      rows,
      columns,
      bitsAllocated: 32,
      bitsStored: 32,
      pixelRepresentation: 1,
      smallestPixelValue: minPixelValue,
      largestPixelValue: maxPixelValue,
      pixelData: scalarData,
      imageId: descriptor.imageId,
      windowCenter: descriptor.windowCenter,
      windowWidth: descriptor.windowWidth,
      imageQualityStatus: Enums.ImageQualityStatus.FULL_RESOLUTION,
    },
  } as unknown as Types.IImage
}

function serverStackMetadataProvider(type: string, imageId: string) {
  const descriptor = descriptors.get(imageId)
  if (!descriptor) return undefined
  if (type === 'imagePlaneModule') {
    const [rowX, rowY, rowZ, columnX, columnY, columnZ] = descriptor.imageOrientationPatient
    return {
      frameOfReferenceUID: descriptor.frameOfReferenceUid,
      FrameOfReferenceUID: descriptor.frameOfReferenceUid,
      rows: descriptor.rows,
      columns: descriptor.columns,
      rowCosines: [rowX, rowY, rowZ],
      columnCosines: [columnX, columnY, columnZ],
      imageOrientationPatient: descriptor.imageOrientationPatient,
      imagePositionPatient: descriptor.imagePositionPatient,
      rowPixelSpacing: descriptor.rowPixelSpacing,
      columnPixelSpacing: descriptor.columnPixelSpacing,
      pixelSpacing: [descriptor.rowPixelSpacing, descriptor.columnPixelSpacing],
    }
  }
  if (type === 'imagePixelModule') {
    return {
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      rows: descriptor.rows,
      columns: descriptor.columns,
      bitsAllocated: 16,
      bitsStored: 16,
      highBit: 15,
      pixelRepresentation: 1,
    }
  }
  if (type === 'voiLutModule') {
    return { windowCenter: [descriptor.windowCenter], windowWidth: [descriptor.windowWidth] }
  }
  if (type === 'modalityLutModule') {
    return { rescaleIntercept: 0, rescaleSlope: 1, rescaleType: 'HU' }
  }
  if (type === 'generalSeriesModule') {
    return { modality: descriptor.modality, seriesInstanceUID: descriptor.seriesInstanceUid }
  }
  if (type === 'generalImageModule') {
    return { instanceNumber: descriptor.index + 1 }
  }
  return undefined
}

function readPixelSpacing(instance?: InstanceSummary): [number, number] {
  const value = instance?.metadata?.['00280030']?.Value
  if (Array.isArray(value) && value.length >= 2) {
    const row = Number(value[0])
    const column = Number(value[1])
    if (Number.isFinite(row) && Number.isFinite(column) && row > 0 && column > 0) return [row, column]
  }
  return [1, 1]
}

function estimateSliceSpacing(instances: InstanceSummary[]) {
  if (instances.length < 2) return 1
  const a = instances[0]?.imagePositionPatient
  const b = instances[1]?.imagePositionPatient
  if (a?.length === 3 && b?.length === 3) {
    const distance = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (Number.isFinite(distance) && distance > 0) return distance
  }
  return 1
}

function estimateImagePosition(origin: number[] | undefined, orientation: number[], sliceSpacing: number, index: number) {
  if (!origin || origin.length !== 3) return [0, 0, index * sliceSpacing]
  const normal = normalFromOrientation(orientation)
  return [
    origin[0] + normal[0] * sliceSpacing * index,
    origin[1] + normal[1] * sliceSpacing * index,
    origin[2] + normal[2] * sliceSpacing * index,
  ]
}

function normalFromOrientation(orientation: number[]) {
  const row = orientation.slice(0, 3)
  const column = orientation.slice(3, 6)
  return [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0],
  ]
}
