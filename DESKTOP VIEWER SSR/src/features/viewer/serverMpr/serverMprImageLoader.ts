import { Enums, imageLoader, metaData, type Types } from '@cornerstonejs/core'
import { appUrl } from '../../../config/appBase'
import type { ServerMprPlane, ServerMprResliceRequest } from './serverMprClient'

type ServerMprImageDescriptor = {
  imageId: string
  volumeSessionId: string
  request: ServerMprResliceRequest
  plane: ServerMprPlane
  frameOfReferenceUid: string
  windowCenter: number
  windowWidth: number
  sourceHash: string
}

type ServerMprLoaderGlobal = typeof globalThis & {
  __vexaServerMprDescriptors?: Map<string, ServerMprImageDescriptor>
  __vexaServerMprImageCache?: Map<string, Types.IImage>
}

const loaderGlobal = globalThis as ServerMprLoaderGlobal
const descriptors = loaderGlobal.__vexaServerMprDescriptors ?? new Map<string, ServerMprImageDescriptor>()
const imageCache = loaderGlobal.__vexaServerMprImageCache ?? new Map<string, Types.IImage>()
loaderGlobal.__vexaServerMprDescriptors = descriptors
loaderGlobal.__vexaServerMprImageCache = imageCache
let initialized = false
const SERVER_MPR_DESCRIPTOR_LIMIT = 4096
const SERVER_MPR_IMAGE_CACHE_LIMIT = 160

export function initializeServerMprImageLoader() {
  if (initialized) return
  imageLoader.registerImageLoader('vexa-mpr', loadServerMprImage)
  metaData.addProvider(serverMprMetadataProvider, 10_000)
  initialized = true
}

export function createServerMprImageId(input: Omit<ServerMprImageDescriptor, 'imageId'>) {
  const imageId = createStableServerMprImageId(input)
  descriptors.set(imageId, { ...input, imageId })
  while (descriptors.size > SERVER_MPR_DESCRIPTOR_LIMIT) {
    const oldest = descriptors.keys().next().value
    if (!oldest) break
    descriptors.delete(oldest)
  }
  return imageId
}

function loadServerMprImage(imageId: string) {
  const descriptor = descriptors.get(imageId)
  const controller = new AbortController()
  const cached = imageCache.get(imageId)
  const promise = descriptor
    ? cached
      ? Promise.resolve(cached)
      : fetchDiagnosticPlane(descriptor, controller.signal).then((image) => {
        imageCache.set(imageId, image)
        while (imageCache.size > SERVER_MPR_IMAGE_CACHE_LIMIT) {
          const oldest = imageCache.keys().next().value
          if (!oldest) break
          imageCache.delete(oldest)
        }
        return image
      })
    : Promise.reject(new Error(`Server MPR image descriptor not found: ${imageId}`))
  return {
    promise,
    cancelFn: () => controller.abort(),
    decache: () => {
      descriptors.delete(imageId)
      imageCache.delete(imageId)
    },
  }
}

function createStableServerMprImageId(input: Omit<ServerMprImageDescriptor, 'imageId'>) {
  const request = input.request
  return [
    'vexa-mpr',
    safeImageIdPart(input.volumeSessionId),
    request.orientation,
    String(request.index),
    String(request.maxEdge ?? 512),
    request.projection ?? 'normal',
    stableNumber(request.slabThickness ?? 1),
    stableNumber(input.windowCenter),
    stableNumber(input.windowWidth),
  ].join(':')
}

function stableNumber(value: number) {
  return String(Math.round(Number(value || 0) * 1000) / 1000)
}

function safeImageIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

async function fetchDiagnosticPlane(descriptor: ServerMprImageDescriptor, signal: AbortSignal) {
  const response = await fetch(appUrl(`/api/mpr/sessions/${encodeURIComponent(descriptor.volumeSessionId)}/reslice`), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.vexa.mpr-plane+int16',
    },
    body: JSON.stringify({ ...descriptor.request, quality: 'diagnostic' }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error || `Diagnostic MPR plane failed: ${response.status}`)
  }

  const rows = Number(response.headers.get('X-MPR-Rows') || descriptor.plane.rows)
  const columns = Number(response.headers.get('X-MPR-Columns') || descriptor.plane.columns)
  const buffer = await response.arrayBuffer()
  const expectedBytes = rows * columns * Int16Array.BYTES_PER_ELEMENT
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`Diagnostic MPR plane returned ${buffer.byteLength} bytes; expected ${expectedBytes}`)
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

  const image = {
    imageId: descriptor.imageId,
    intercept: 0,
    slope: 1,
    minPixelValue,
    maxPixelValue,
    windowCenter: [descriptor.windowCenter],
    windowWidth: [descriptor.windowWidth],
    voiLUTFunction: Enums.VOILUTFunctionType.LINEAR,
    getPixelData: () => scalarData,
    getCanvas: undefined,
    rows,
    columns,
    height: rows,
    width: columns,
    color: false,
    rgba: false,
    numberOfComponents: 1,
    columnPixelSpacing: descriptor.plane.columnPixelSpacing,
    rowPixelSpacing: descriptor.plane.rowPixelSpacing,
    sliceThickness: descriptor.request.slabThickness,
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
      redPaletteColorLookupTableDescriptor: [],
      greenPaletteColorLookupTableDescriptor: [],
      bluePaletteColorLookupTableDescriptor: [],
      redPaletteColorLookupTableData: [],
      greenPaletteColorLookupTableData: [],
      bluePaletteColorLookupTableData: [],
      pixelData: scalarData,
      imageId: descriptor.imageId,
      windowCenter: descriptor.windowCenter,
      windowWidth: descriptor.windowWidth,
      imageQualityStatus: Enums.ImageQualityStatus.FULL_RESOLUTION,
    },
  } as unknown as Types.IImage

  return image
}

function serverMprMetadataProvider(type: string, imageId: string) {
  const descriptor = descriptors.get(imageId)
  if (!descriptor) return undefined
  const { plane } = descriptor
  if (type === 'imagePlaneModule') {
    return {
      frameOfReferenceUID: descriptor.frameOfReferenceUid,
      FrameOfReferenceUID: descriptor.frameOfReferenceUid,
      rows: plane.rows,
      columns: plane.columns,
      rowCosines: plane.rowDirection,
      columnCosines: plane.columnDirection,
      imageOrientationPatient: [...plane.rowDirection, ...plane.columnDirection],
      imagePositionPatient: plane.imagePositionPatient,
      rowPixelSpacing: plane.rowPixelSpacing,
      columnPixelSpacing: plane.columnPixelSpacing,
      pixelSpacing: [plane.rowPixelSpacing, plane.columnPixelSpacing],
    }
  }
  if (type === 'imagePixelModule') {
    return {
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      rows: plane.rows,
      columns: plane.columns,
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
    return { modality: 'CT', seriesInstanceUID: descriptor.sourceHash }
  }
  if (type === 'generalImageModule') {
    return { instanceNumber: descriptor.request.index + 1 }
  }
  return undefined
}
