import type { InstanceSummary, SeriesSummary, StudySummary } from '../dicomweb/types'
import { stowDicomInstances } from '../dicomweb/client'

type CaptureViewport = {
  getCornerstoneImage?: () => {
    rows?: number
    columns?: number
    width?: number
    height?: number
    slope?: number
    intercept?: number
    invert?: boolean
    isPreScaled?: boolean
    preScale?: { scaled?: boolean }
    imageFrame?: { preScale?: { scaled?: boolean } }
    getPixelData?: () => ArrayLike<number> | null
  } | undefined
  getProperties?: () => { voiRange?: { lower: number; upper: number } }
  getImageData?: () => {
    origin?: ArrayLike<number>
    spacing?: ArrayLike<number>
    direction?: ArrayLike<number>
    dimensions?: ArrayLike<number>
  } | undefined
  worldToCanvas?: (worldPosition: number[]) => [number, number]
}

type DcmjsModule = {
  data: {
    DicomMetaDictionary: {
      uid: () => string
      denaturalizeDataset: (dataset: Record<string, unknown>) => Record<string, unknown>
    }
    DicomDict: new (meta: Record<string, unknown>) => {
      dict: Record<string, unknown>
      write: () => ArrayBuffer
    }
  }
}

export type GraphicSaveObject =
  | { type: 'polyline'; points: Array<[number, number]> }
  | { type: 'circle'; points: Array<[number, number]> }
  | { type: 'text'; point: [number, number]; text: string }

export type SavedGspsOverlay = {
  id: string
  studyInstanceUid: string
  seriesInstanceUid: string
  sopInstanceUid: string
  sourceSize: { width: number; height: number }
  graphics: GraphicSaveObject[]
  annotations?: SavedGspsAnnotation[]
  createdAt: number
}

export type SavedGspsAnnotation = {
  uid: string
  toolName: string
  metadata: Record<string, unknown>
  data: Record<string, unknown>
}

type SaveContext = {
  study: StudySummary | null
  series: SeriesSummary | null
  instance: InstanceSummary | null
  viewportSize: { width: number; height: number }
  graphics: GraphicSaveObject[]
  annotations?: SavedGspsAnnotation[]
}

type SecondaryCaptureContext = SaveContext & {
  canvas: HTMLCanvasElement
  seriesDescription?: string
}

export type ViewportCaptureSource = {
  canvas: HTMLCanvasElement
  label: string
  series: SeriesSummary | null
  instance: InstanceSummary | null
}

export type SecondaryCaptureRenderOptions = {
  targetLongEdge?: number
  cropToContent?: boolean
  includeTextOverlay?: boolean
  relocateViewportTextOverlay?: boolean
  includeAnnotations?: boolean
  includeMasks?: boolean
  anonymize?: boolean
  trueSize?: boolean
  nativeImage?: NativeDicomImageDimensions | null
}

export type NativeDicomImageDimensions = {
  columns: number
  rows: number
  rowPixelSpacing?: number
  columnPixelSpacing?: number
}

type CaptureRect = {
  left: number
  top: number
  width: number
  height: number
}

type CaptureRenderGeometry = {
  captureRect: CaptureRect
  outputWidth: number
  outputHeight: number
  scaleX: number
  scaleY: number
  nativeImage: NativeDicomImageDimensions | null
  imageRect: CaptureRect | null
}

const explicitVrLittleEndian = '1.2.840.10008.1.2.1'
const gspsStorage = '1.2.840.10008.5.1.4.1.1.11.1'
const secondaryCaptureStorage = '1.2.840.10008.5.1.4.1.1.7'
const implementationClassUid = '1.2.826.0.1.3680043.10.5432.26.1'
const savedGspsStorageKey = 'vexa.viewer.savedGspsOverlays.v1'
const suppressedGspsStorageKey = 'vexa.viewer.suppressedGspsOverlays.v1'

export async function saveGspsPresentationState(context: SaveContext) {
  assertSaveContext(context)
  if (!context.graphics.length) {
    throw new Error('No visual annotation found to save as GSPS.')
  }

  const dcmjs = await importDcmjs()
  const sopInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const seriesInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const seriesDescription = 'VEXA GSPS Annotations'
  const dataset = buildBaseDataset(context, {
    sopClassUid: gspsStorage,
    sopInstanceUid,
    seriesInstanceUid,
    modality: 'PR',
    seriesDescription,
  })

  Object.assign(dataset, {
    ContentLabel: 'VEXA_ANN',
    ContentDescription: 'VEXA visual annotations',
    PresentationCreationDate: today(),
    PresentationCreationTime: nowTime(),
    GraphicLayerSequence: [{
      GraphicLayer: 'ANNOTATIONS',
      GraphicLayerOrder: 1,
      GraphicLayerRecommendedDisplayCIELabValue: [65535, 32768, 32768],
    }],
    DisplayedAreaSelectionSequence: [{
      ReferencedImageSequence: [referencedImage(context.instance)],
      DisplayedAreaTopLeftHandCorner: [1, 1],
      DisplayedAreaBottomRightHandCorner: [
        Math.max(1, Math.round(context.viewportSize.width)),
        Math.max(1, Math.round(context.viewportSize.height)),
      ],
      PresentationSizeMode: 'SCALE TO FIT',
    }],
    GraphicAnnotationSequence: [{
      ReferencedImageSequence: [referencedImage(context.instance)],
      GraphicLayer: 'ANNOTATIONS',
      TextObjectSequence: context.graphics
        .filter((graphic): graphic is Extract<GraphicSaveObject, { type: 'text' }> => graphic.type === 'text')
        .map((graphic) => ({
          UnformattedTextValue: graphic.text || 'Annotation',
          BoundingBoxAnnotationUnits: 'DISPLAY',
          BoundingBoxTopLeftHandCorner: [graphic.point[0], graphic.point[1]],
          BoundingBoxBottomRightHandCorner: [graphic.point[0] + 220, graphic.point[1] + 34],
          AnchorPointAnnotationUnits: 'DISPLAY',
          AnchorPoint: graphic.point,
          AnchorPointVisibility: 'Y',
        })),
      GraphicObjectSequence: context.graphics
        .filter((graphic): graphic is Exclude<GraphicSaveObject, { type: 'text' }> => graphic.type !== 'text')
        .map((graphic) => ({
          GraphicAnnotationUnits: 'DISPLAY',
          GraphicDimensions: 2,
          NumberOfGraphicPoints: graphic.points.length,
          GraphicData: graphic.points.flatMap((point) => [Number(point[0].toFixed(2)), Number(point[1].toFixed(2))]),
          GraphicType: graphic.type === 'circle' ? 'CIRCLE' : 'POLYLINE',
          GraphicFilled: 'N',
        })),
    }],
  })

  await stowDicomInstances(context.study!.studyInstanceUid, [writeDicom(dcmjs, gspsStorage, sopInstanceUid, dataset)])
  persistSavedGspsOverlay({
    id: sopInstanceUid,
    studyInstanceUid: context.study!.studyInstanceUid,
    seriesInstanceUid: context.series!.seriesInstanceUid,
    sopInstanceUid: context.instance!.sopInstanceUid,
    sourceSize: {
      width: Math.max(1, Math.round(context.viewportSize.width)),
      height: Math.max(1, Math.round(context.viewportSize.height)),
    },
    graphics: context.graphics,
    annotations: context.annotations ?? [],
    createdAt: Date.now(),
  })
  const savedSeries = toSavedSeries(context.study!.studyInstanceUid, seriesInstanceUid, 'PR', seriesDescription)
  notifySeriesSaved(savedSeries)
  return savedSeries
}

export function loadSavedGspsOverlays(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
  if (isSavedGspsSuppressed(studyInstanceUid, seriesInstanceUid, sopInstanceUid)) {
    return []
  }

  return readSavedGspsOverlays().filter((overlay) => (
    overlay.studyInstanceUid === studyInstanceUid &&
    overlay.seriesInstanceUid === seriesInstanceUid &&
    overlay.sopInstanceUid === sopInstanceUid
  ))
}

export function deleteSavedGspsOverlays(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
  try {
    const remaining = readSavedGspsOverlays().filter((overlay) => !(
      overlay.studyInstanceUid === studyInstanceUid &&
      overlay.seriesInstanceUid === seriesInstanceUid &&
      overlay.sopInstanceUid === sopInstanceUid
    ))
    window.localStorage.setItem(savedGspsStorageKey, JSON.stringify(remaining))
    suppressSavedGsps(studyInstanceUid, seriesInstanceUid, sopInstanceUid)
    window.dispatchEvent(new CustomEvent('vexa-viewer-gsps-overlay-deleted', {
      detail: { studyInstanceUid, seriesInstanceUid, sopInstanceUid },
    }))
    return true
  } catch {
    return false
  }
}

export function isSavedGspsSuppressed(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
  return readSuppressedGspsKeys().includes(savedGspsKey(studyInstanceUid, seriesInstanceUid, sopInstanceUid))
}

export async function saveSecondaryCapture(context: SecondaryCaptureContext) {
  assertSaveContext(context)
  const dcmjs = await importDcmjs()
  const sopInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const seriesInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const seriesDescription = sanitizeSeriesDescription(context.seriesDescription) || 'VEXA Secondary Capture'
  const modality = sanitizeModality(context.series?.modality) || 'OT'
  const pixelData = canvasToHighContrastGrayscalePixelData(context.canvas)
  const dataset = buildBaseDataset(context, {
    sopClassUid: secondaryCaptureStorage,
    sopInstanceUid,
    seriesInstanceUid,
    modality,
    seriesDescription,
  })

  Object.assign(dataset, {
    ImageType: ['DERIVED', 'SECONDARY', 'SCREEN SAVE'],
    ConversionType: 'WSD',
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    Rows: context.canvas.height,
    Columns: context.canvas.width,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    RescaleIntercept: 0,
    RescaleSlope: 1,
    WindowCenter: 127.5,
    WindowWidth: 255,
    BurnedInAnnotation: context.graphics.length ? 'YES' : 'NO',
    LossyImageCompression: '00',
    PixelData: [pixelData.buffer],
    _vrMap: { PixelData: 'OB' },
  })

  await stowDicomInstances(context.study!.studyInstanceUid, [writeDicom(dcmjs, secondaryCaptureStorage, sopInstanceUid, dataset)])
  const savedSeries = toSavedSeries(context.study!.studyInstanceUid, seriesInstanceUid, modality, seriesDescription)
  notifySeriesSaved(savedSeries)
  return savedSeries
}

export async function saveViewportCaptureSeries({
  study,
  seriesDescription,
  captures,
}: {
  study: StudySummary | null
  seriesDescription: string
  captures: ViewportCaptureSource[]
}) {
  if (!study?.studyInstanceUid) {
    throw new Error('The active study is not ready to receive captures.')
  }
  const cleanSeriesDescription = sanitizeSeriesDescription(seriesDescription)
  if (!cleanSeriesDescription) {
    throw new Error('Series description is required.')
  }
  if (!captures.length) {
    throw new Error('Select at least one viewport to capture.')
  }

  const dcmjs = await importDcmjs()
  const seriesInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const seriesNumber = nextSeriesNumber()
  const seriesDate = today()
  const seriesTime = nowTime()
  const dicomInstances = captures.map((capture, index) => {
    if (capture.canvas.width < 1 || capture.canvas.height < 1) {
      throw new Error(`Viewport ${capture.label} did not produce a valid image.`)
    }

    const sopInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
    const metadata = capture.instance?.metadata ?? {}
    const pixelData = canvasToRgbPixelData(capture.canvas)
    const sourceReference = capture.instance?.sopInstanceUid
      ? referencedImage(capture.instance)
      : null
    const referencedSeries = capture.series?.seriesInstanceUid
      ? [{
        SeriesInstanceUID: capture.series.seriesInstanceUid,
        ...(sourceReference ? { ReferencedImageSequence: [sourceReference] } : {}),
      }]
      : undefined

    const dataset: Record<string, unknown> = {
      SpecificCharacterSet: 'ISO_IR 192',
      SOPClassUID: secondaryCaptureStorage,
      SOPInstanceUID: sopInstanceUid,
      StudyInstanceUID: study.studyInstanceUid,
      SeriesInstanceUID: seriesInstanceUid,
      Modality: 'SC',
      PatientName: readDicomString(metadata, '00100010') || study.patientName || 'Unknown',
      PatientID: readDicomString(metadata, '00100020') || study.patientId || '',
      PatientBirthDate: readDicomString(metadata, '00100030'),
      PatientSex: readDicomString(metadata, '00100040'),
      StudyDate: readDicomString(metadata, '00080020') || study.studyDate || seriesDate,
      StudyTime: readDicomString(metadata, '00080030') || seriesTime,
      StudyDescription: readDicomString(metadata, '00081030') || study.studyDescription || '',
      AccessionNumber: readDicomString(metadata, '00080050') || study.accessionNumber || '',
      StudyID: readDicomString(metadata, '00200010') || '',
      ReferringPhysicianName: readDicomString(metadata, '00080090'),
      SeriesNumber: seriesNumber,
      InstanceNumber: index + 1,
      SeriesDate: seriesDate,
      SeriesTime: seriesTime,
      ContentDate: seriesDate,
      ContentTime: nowTime(),
      Manufacturer: 'VEXA',
      ManufacturerModelName: 'VEXAPACS',
      SoftwareVersions: '1.26.2',
      SeriesDescription: cleanSeriesDescription,
      ContentDescription: capture.label.slice(0, 64),
      ImageComments: `Viewport capture: ${capture.label}`.slice(0, 1024),
      ImageType: ['DERIVED', 'SECONDARY', 'SCREEN SAVE'],
      ConversionType: 'WSD',
      DerivationDescription: 'High-resolution viewport capture.',
      SamplesPerPixel: 3,
      PhotometricInterpretation: 'RGB',
      PlanarConfiguration: 0,
      Rows: capture.canvas.height,
      Columns: capture.canvas.width,
      BitsAllocated: 8,
      BitsStored: 8,
      HighBit: 7,
      PixelRepresentation: 0,
      PixelAspectRatio: [1, 1],
      BurnedInAnnotation: 'YES',
      LossyImageCompression: '00',
      PresentationLUTShape: 'IDENTITY',
      ...(referencedSeries ? { ReferencedSeriesSequence: referencedSeries } : {}),
      ...(sourceReference ? { SourceImageSequence: [sourceReference] } : {}),
      PixelData: [pixelData.buffer],
      _vrMap: { PixelData: 'OB' },
    }

    return writeDicom(dcmjs, secondaryCaptureStorage, sopInstanceUid, dataset)
  })

  await stowDicomInstances(study.studyInstanceUid, dicomInstances)
  const savedSeries = toSavedSeries(study.studyInstanceUid, seriesInstanceUid, 'SC', cleanSeriesDescription, captures.length)
  notifySeriesSaved(savedSeries)
  return savedSeries
}

export async function renderSecondaryCaptureCanvas(
  sourceElement: HTMLElement,
  viewport?: CaptureViewport,
  options: SecondaryCaptureRenderOptions = {},
) {
  await waitForDiagnosticViewportPixels(sourceElement)
  const sourceCanvas = sourceElement.querySelector('canvas:not([data-vexa-progressive-preview])') ?? sourceElement.querySelector('canvas')
  if (!(sourceCanvas instanceof HTMLCanvasElement)) {
    throw new Error('Viewport canvas is not ready.')
  }

  const viewportRect = sourceElement.getBoundingClientRect()
  if (viewportRect.width <= 0 || viewportRect.height <= 0) {
    throw new Error('The viewport is not visible and cannot be captured.')
  }
  const sourceRect = sourceCanvas.getBoundingClientRect()
  const annotationBounds = options.includeAnnotations !== false
    ? getCaptureAnnotationBounds(sourceElement)
    : null
  const geometry = createCaptureRenderGeometry({
    viewportRect,
    sourceRect,
    annotationBounds,
    nativeImage: normalizeNativeImageDimensions(options.nativeImage),
    targetLongEdge: options.targetLongEdge,
    trueSize: options.trueSize,
  })
  const output = document.createElement('canvas')
  output.width = geometry.outputWidth
  output.height = geometry.outputHeight
  const context = output.getContext('2d')
  if (!context) {
    throw new Error('Unable to create capture canvas.')
  }

  context.fillStyle = '#000'
  context.fillRect(0, 0, output.width, output.height)
  if (!drawViewportImage(context, viewport, geometry)) {
    drawVisibleCanvas(context, sourceCanvas, sourceRect, geometry)
  }
  if (options.anonymize) {
    drawCaptureAnonymizationBlocks(context, output.width, output.height)
  }
  if (options.includeAnnotations !== false) {
    await drawSvgOverlays(context, sourceElement, geometry)
  }
  if (options.includeTextOverlay !== false && !options.anonymize) {
    drawCaptureTextOverlays(context, sourceElement, geometry, {
      includeViewportOverlays: !options.relocateViewportTextOverlay,
    })
  } else if (options.includeMasks !== false && !options.anonymize) {
    drawCaptureTextOverlays(context, sourceElement, geometry, {
      measurementBadgesOnly: true,
    })
  }

  return options.cropToContent === false || Boolean(geometry.nativeImage) ? output : cropCanvasToVisibleContent(output)
}

async function waitForDiagnosticViewportPixels(sourceElement: HTMLElement, timeoutMs = 5_000) {
  const diagnosticViewport = sourceElement.matches('.dicom-viewport[data-vexa-diagnostic-state]')
    ? sourceElement as HTMLElement
    : sourceElement.querySelector<HTMLElement>('.dicom-viewport[data-vexa-diagnostic-state]')
  if (!diagnosticViewport || diagnosticViewport.dataset.vexaDiagnosticState === 'raw-ready') {
    return
  }

  const startedAt = performance.now()
  while (diagnosticViewport.dataset.vexaDiagnosticState !== 'raw-ready') {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error('The diagnostic image is still loading. Try capturing it again in a moment.')
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 24))
  }
}

function drawCaptureAnonymizationBlocks(context: CanvasRenderingContext2D, width: number, height: number) {
  const blockWidth = Math.min(width * 0.43, 360)
  const blockHeight = Math.min(height * 0.22, 145)
  context.save()
  context.fillStyle = '#000'
  context.fillRect(0, 0, blockWidth, blockHeight)
  context.fillRect(width - blockWidth, 0, blockWidth, blockHeight)
  context.fillRect(0, height - blockHeight, blockWidth, blockHeight)
  context.fillRect(width - blockWidth, height - blockHeight, blockWidth, blockHeight)
  context.restore()
}

function createCaptureRenderGeometry({
  viewportRect,
  sourceRect,
  annotationBounds,
  nativeImage,
  targetLongEdge,
  trueSize,
}: {
  viewportRect: DOMRect
  sourceRect: DOMRect
  annotationBounds: CaptureRect | null
  nativeImage: NativeDicomImageDimensions | null
  targetLongEdge: number | undefined
  trueSize: boolean | undefined
}): CaptureRenderGeometry {
  const requestedLongEdge = Number(targetLongEdge)
  const fallbackLongEdge = Math.max(viewportRect.width, viewportRect.height)
  const maximumLongEdge = Number.isFinite(requestedLongEdge)
    ? clamp(Math.round(requestedLongEdge), 1024, 4096)
    : Math.max(1, Math.round(fallbackLongEdge))

  if (!nativeImage) {
    const outputWidth = Math.max(1, Math.round(viewportRect.width * Math.max(1, maximumLongEdge / Math.max(viewportRect.width, viewportRect.height))))
    const outputHeight = Math.max(1, Math.round(viewportRect.height * Math.max(1, maximumLongEdge / Math.max(viewportRect.width, viewportRect.height))))
    return {
      captureRect: toCaptureRect(viewportRect),
      outputWidth,
      outputHeight,
      scaleX: outputWidth / viewportRect.width,
      scaleY: outputHeight / viewportRect.height,
      nativeImage: null,
      imageRect: null,
    }
  }

  const physicalAspect = getNativePhysicalAspect(nativeImage)
  const captureRect = trueSize
    ? expandRectToAspect(
      padCaptureRect(
        mergeCaptureRects([toCaptureRect(sourceRect), annotationBounds]),
        Math.max(10, Math.min(sourceRect.width, sourceRect.height) * 0.055),
      ),
      physicalAspect,
    )
    : fitRectToAspect(toCaptureRect(sourceRect), physicalAspect)
  const sourceCoverage = Math.max(0.01, Math.min(
    sourceRect.width / captureRect.width,
    sourceRect.height / captureRect.height,
  ))
  const dimensions = trueSize
    ? calculateBoundedDimensions(
      physicalAspect,
      clamp(Math.ceil(Math.max(nativeImage.columns, nativeImage.rows) / sourceCoverage), Math.max(nativeImage.columns, nativeImage.rows), 4096),
    )
    : calculateBoundedDimensions(physicalAspect, maximumLongEdge)
  const geometry: CaptureRenderGeometry = {
    captureRect,
    outputWidth: dimensions.width,
    outputHeight: dimensions.height,
    scaleX: dimensions.width / captureRect.width,
    scaleY: dimensions.height / captureRect.height,
    nativeImage,
    imageRect: null,
  }
  if (trueSize) {
    geometry.imageRect = fitRectToAspect(mapRectToCaptureOutput(toCaptureRect(sourceRect), geometry), physicalAspect)
  }
  return geometry
}

function normalizeNativeImageDimensions(value: NativeDicomImageDimensions | null | undefined) {
  const columns = Math.round(Number(value?.columns))
  const rows = Math.round(Number(value?.rows))
  if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns < 1 || rows < 1) {
    return null
  }

  const rowPixelSpacing = normalizePixelSpacing(value?.rowPixelSpacing)
  const columnPixelSpacing = normalizePixelSpacing(value?.columnPixelSpacing)
  return { columns, rows, rowPixelSpacing, columnPixelSpacing }
}

function normalizePixelSpacing(value: number | undefined) {
  const spacing = Number(value)
  return Number.isFinite(spacing) && spacing > 0 ? spacing : 1
}

function getNativePhysicalAspect(nativeImage: NativeDicomImageDimensions) {
  return Math.max(0.01, (nativeImage.columns * normalizePixelSpacing(nativeImage.columnPixelSpacing)) / (nativeImage.rows * normalizePixelSpacing(nativeImage.rowPixelSpacing)))
}

function calculateBoundedDimensions(aspect: number, maximumLongEdge: number) {
  if (aspect >= 1) {
    return {
      width: maximumLongEdge,
      height: Math.max(1, Math.round(maximumLongEdge / aspect)),
    }
  }
  return {
    width: Math.max(1, Math.round(maximumLongEdge * aspect)),
    height: maximumLongEdge,
  }
}

function fitRectToAspect(rect: CaptureRect, aspect: number): CaptureRect {
  const currentAspect = rect.width / rect.height
  if (currentAspect > aspect) {
    const width = rect.height * aspect
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top,
      width,
      height: rect.height,
    }
  }

  const height = rect.width / aspect
  return {
    left: rect.left,
    top: rect.top + (rect.height - height) / 2,
    width: rect.width,
    height,
  }
}

function expandRectToAspect(rect: CaptureRect, aspect: number): CaptureRect {
  const currentAspect = rect.width / rect.height
  if (currentAspect > aspect) {
    const height = rect.width / aspect
    return {
      left: rect.left,
      top: rect.top - (height - rect.height) / 2,
      width: rect.width,
      height,
    }
  }

  const width = rect.height * aspect
  return {
    left: rect.left - (width - rect.width) / 2,
    top: rect.top,
    width,
    height: rect.height,
  }
}

function padCaptureRect(rect: CaptureRect, padding: number): CaptureRect {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  }
}

function mergeCaptureRects(rects: Array<CaptureRect | null>) {
  const validRects = rects.filter((rect): rect is CaptureRect => Boolean(rect && rect.width > 0 && rect.height > 0))
  if (!validRects.length) {
    return { left: 0, top: 0, width: 1, height: 1 }
  }

  const left = Math.min(...validRects.map((rect) => rect.left))
  const top = Math.min(...validRects.map((rect) => rect.top))
  const right = Math.max(...validRects.map((rect) => rect.left + rect.width))
  const bottom = Math.max(...validRects.map((rect) => rect.top + rect.height))
  return { left, top, width: right - left, height: bottom - top }
}

function toCaptureRect(rect: DOMRect): CaptureRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function mapRectToCaptureOutput(rect: CaptureRect, geometry: CaptureRenderGeometry): CaptureRect {
  return {
    left: (rect.left - geometry.captureRect.left) * geometry.scaleX,
    top: (rect.top - geometry.captureRect.top) * geometry.scaleY,
    width: rect.width * geometry.scaleX,
    height: rect.height * geometry.scaleY,
  }
}

function cropCanvasToVisibleContent(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  if (!context) {
    return canvas
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data
  const threshold = 6
  let left = canvas.width
  let top = canvas.height
  let right = -1
  let bottom = -1

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4
      if (data[index] > threshold || data[index + 1] > threshold || data[index + 2] > threshold) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }

  if (right < left || bottom < top) {
    return canvas
  }

  const padding = 32
  left = Math.max(0, left - padding)
  top = Math.max(0, top - padding)
  right = Math.min(canvas.width - 1, right + padding)
  bottom = Math.min(canvas.height - 1, bottom + padding)

  const width = right - left + 1
  const height = bottom - top + 1
  if (width >= canvas.width * 0.98 && height >= canvas.height * 0.98) {
    return canvas
  }

  const cropped = document.createElement('canvas')
  cropped.width = width
  cropped.height = height
  const croppedContext = cropped.getContext('2d')
  if (!croppedContext) {
    return canvas
  }

  croppedContext.fillStyle = '#000'
  croppedContext.fillRect(0, 0, width, height)
  croppedContext.drawImage(canvas, left, top, width, height, 0, 0, width, height)
  return cropped
}

function drawViewportImage(
  context: CanvasRenderingContext2D,
  viewport: CaptureViewport | undefined,
  geometry: CaptureRenderGeometry,
) {
  const image = viewport?.getCornerstoneImage?.()
  const pixelData = image?.getPixelData?.()
  const columns = Number(image?.columns ?? image?.width)
  const rows = Number(image?.rows ?? image?.height)
  if (!image || !pixelData || !Number.isFinite(columns) || !Number.isFinite(rows) || columns <= 0 || rows <= 0) {
    return false
  }

  const imageCanvas = document.createElement('canvas')
  imageCanvas.width = columns
  imageCanvas.height = rows
  const imageContext = imageCanvas.getContext('2d')
  if (!imageContext) {
    return false
  }

  const rgba = imageContext.createImageData(columns, rows)
  const voiRange = viewport?.getProperties?.()?.voiRange
  const lower = Number.isFinite(voiRange?.lower) ? Number(voiRange?.lower) : getPixelMinimum(pixelData)
  const upper = Number.isFinite(voiRange?.upper) && Number(voiRange?.upper) > lower ? Number(voiRange?.upper) : getPixelMaximum(pixelData)
  const range = Math.max(1, upper - lower)
  const alreadyScaled = Boolean(
    image.isPreScaled || image.preScale?.scaled || image.imageFrame?.preScale?.scaled,
  )
  const slope = alreadyScaled ? 1 : Number(image.slope ?? 1) || 1
  const intercept = alreadyScaled ? 0 : Number(image.intercept ?? 0) || 0

  for (let source = 0, target = 0; target < rgba.data.length; source += 1, target += 4) {
    const scaledValue = Number(pixelData[source] ?? 0) * slope + intercept
    const displayValue = clamp(Math.round(((scaledValue - lower) / range) * 255), 0, 255)
    const value = image.invert ? 255 - displayValue : displayValue
    rgba.data[target] = value
    rgba.data[target + 1] = value
    rgba.data[target + 2] = value
    rgba.data[target + 3] = 255
  }
  imageContext.putImageData(rgba, 0, 0)

  context.save()
  context.imageSmoothingEnabled = false
  const destination = geometry.imageRect
  if (destination) {
    context.drawImage(imageCanvas, destination.left, destination.top, destination.width, destination.height)
  } else {
    const transform = getImageCanvasTransform(viewport, columns, rows)
    if (transform) {
      context.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f)
      context.drawImage(imageCanvas, 0, 0)
    } else {
      const scale = Math.min(context.canvas.width / columns, context.canvas.height / rows)
      const width = columns * scale
      const height = rows * scale
      context.drawImage(imageCanvas, (context.canvas.width - width) / 2, (context.canvas.height - height) / 2, width, height)
    }
  }
  context.restore()
  return true
}

function getImageCanvasTransform(viewport: CaptureViewport | undefined, columns: number, rows: number) {
  const imageData = viewport?.getImageData?.()
  if (!viewport?.worldToCanvas || !imageData?.origin || !imageData.spacing || !imageData.direction) {
    return null
  }

  const topLeft = viewport.worldToCanvas(imageToWorld(imageData, 0, 0))
  const topRight = viewport.worldToCanvas(imageToWorld(imageData, columns, 0))
  const bottomLeft = viewport.worldToCanvas(imageToWorld(imageData, 0, rows))

  return {
    a: (topRight[0] - topLeft[0]) / columns,
    b: (topRight[1] - topLeft[1]) / columns,
    c: (bottomLeft[0] - topLeft[0]) / rows,
    d: (bottomLeft[1] - topLeft[1]) / rows,
    e: topLeft[0],
    f: topLeft[1],
  }
}

function imageToWorld(imageData: { origin?: ArrayLike<number>; spacing?: ArrayLike<number>; direction?: ArrayLike<number> }, column: number, row: number) {
  const origin = imageData.origin ?? [0, 0, 0]
  const spacing = imageData.spacing ?? [1, 1, 1]
  const direction = imageData.direction ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]

  return [
    origin[0] + direction[0] * column * spacing[0] + direction[3] * row * spacing[1],
    origin[1] + direction[1] * column * spacing[0] + direction[4] * row * spacing[1],
    origin[2] + direction[2] * column * spacing[0] + direction[5] * row * spacing[1],
  ]
}

function getPixelMinimum(pixelData: ArrayLike<number>) {
  let minimum = Number.POSITIVE_INFINITY
  for (let index = 0; index < pixelData.length; index += 1) {
    const value = Number(pixelData[index])
    if (Number.isFinite(value) && value < minimum) minimum = value
  }
  return Number.isFinite(minimum) ? minimum : 0
}

function getPixelMaximum(pixelData: ArrayLike<number>) {
  let maximum = Number.NEGATIVE_INFINITY
  for (let index = 0; index < pixelData.length; index += 1) {
    const value = Number(pixelData[index])
    if (Number.isFinite(value) && value > maximum) maximum = value
  }
  return Number.isFinite(maximum) ? maximum : 255
}

function drawVisibleCanvas(
  context: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  sourceRect: DOMRect,
  geometry: CaptureRenderGeometry,
) {
  if (sourceRect.width <= 0 || sourceRect.height <= 0) {
    return
  }

  const sourceScaleX = getCanvasCssScale(sourceCanvas.width, sourceRect.width)
  const sourceScaleY = getCanvasCssScale(sourceCanvas.height, sourceRect.height)
  const captureRect = geometry.captureRect
  const visibleLeft = Math.max(captureRect.left, sourceRect.left)
  const visibleTop = Math.max(captureRect.top, sourceRect.top)
  const visibleRight = Math.min(captureRect.left + captureRect.width, sourceRect.right)
  const visibleBottom = Math.min(captureRect.top + captureRect.height, sourceRect.bottom)
  const visibleWidth = visibleRight - visibleLeft
  const visibleHeight = visibleBottom - visibleTop

  if (visibleWidth <= 0 || visibleHeight <= 0) {
    return
  }

  const sx = clamp((visibleLeft - sourceRect.left) * sourceScaleX, 0, sourceCanvas.width)
  const sy = clamp((visibleTop - sourceRect.top) * sourceScaleY, 0, sourceCanvas.height)
  const sw = clamp(visibleWidth * sourceScaleX, 1, Math.max(1, sourceCanvas.width - sx))
  const sh = clamp(visibleHeight * sourceScaleY, 1, Math.max(1, sourceCanvas.height - sy))
  const dx = Math.round((visibleLeft - captureRect.left) * geometry.scaleX)
  const dy = Math.round((visibleTop - captureRect.top) * geometry.scaleY)
  const dw = Math.round(visibleWidth * geometry.scaleX)
  const dh = Math.round(visibleHeight * geometry.scaleY)

  context.drawImage(sourceCanvas, sx, sy, sw, sh, dx, dy, dw, dh)
}

function getCanvasCssScale(canvasSize: number, cssSize: number) {
  const rawScale = canvasSize / Math.max(1, cssSize)
  const deviceScale = window.devicePixelRatio || 1

  if (rawScale > deviceScale * 1.75) {
    return deviceScale
  }

  return rawScale
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

async function drawSvgOverlays(
  context: CanvasRenderingContext2D,
  sourceElement: HTMLElement,
  geometry: CaptureRenderGeometry,
) {
  const svgElements = getCaptureSvgElements(sourceElement)

  for (const svg of svgElements) {
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      continue
    }

    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(Math.max(1, Math.round(rect.width))))
    clone.setAttribute('height', String(Math.max(1, Math.round(rect.height))))
    if (!clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', `0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`)
    }
    inlineSvgStyles(svg, clone)

    const serialized = new XMLSerializer().serializeToString(clone)
    const image = await loadSvgImage(serialized)
    const targetRect = mapRectToCaptureOutput(toCaptureRect(rect), geometry)
    context.drawImage(
      image,
      targetRect.left,
      targetRect.top,
      targetRect.width,
      targetRect.height,
    )
  }
}

function getCaptureAnnotationBounds(sourceElement: HTMLElement) {
  const bounds = getCaptureSvgElements(sourceElement)
    .map((svg) => getSvgContentBounds(svg))
    .filter((rect): rect is CaptureRect => Boolean(rect))
  return bounds.length ? mergeCaptureRects(bounds) : null
}

function getCaptureSvgElements(sourceElement: HTMLElement) {
  return Array.from(sourceElement.querySelectorAll('svg'))
    .filter((svg) => !svg.closest([
      '.viewport-context-menu',
      '.cine-control-panel',
      '.viewport-overlay',
      '.viewport-chip',
      '.viewport-zoom-control',
      '.mpr-inline-controls',
      '.ich-segmentation-panel',
      '.ich-settings-menu',
      '.ich-smart-drag-preview',
      '.ich-lasso-preview',
    ].join(', ')))
}

function getSvgContentBounds(svg: SVGSVGElement): CaptureRect | null {
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null

  try {
    const box = svg.getBBox()
    if (box.width <= 0 || box.height <= 0) return null
    const viewBox = svg.viewBox.baseVal
    const viewBoxWidth = viewBox.width > 0 ? viewBox.width : rect.width
    const viewBoxHeight = viewBox.height > 0 ? viewBox.height : rect.height
    const viewBoxX = viewBox.width > 0 ? viewBox.x : 0
    const viewBoxY = viewBox.height > 0 ? viewBox.y : 0
    return {
      left: rect.left + ((box.x - viewBoxX) / viewBoxWidth) * rect.width,
      top: rect.top + ((box.y - viewBoxY) / viewBoxHeight) * rect.height,
      width: (box.width / viewBoxWidth) * rect.width,
      height: (box.height / viewBoxHeight) * rect.height,
    }
  } catch {
    return null
  }
}

function inlineSvgStyles(source: Element, target: Element) {
  if (source instanceof SVGElement && target instanceof SVGElement) {
    const style = window.getComputedStyle(source)
    ;[
      'fill',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'stroke-dasharray',
      'opacity',
      'font-family',
      'font-size',
      'font-weight',
      'text-anchor',
      'dominant-baseline',
      'paint-order',
    ].forEach((property) => {
      const value = style.getPropertyValue(property)
      if (value) {
        target.style.setProperty(property, value)
      }
    })
  }

  Array.from(source.children).forEach((child, index) => {
    const targetChild = target.children[index]
    if (targetChild) {
      inlineSvgStyles(child, targetChild)
    }
  })
}

function loadSvgImage(serializedSvg: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const blob = new Blob([serializedSvg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Unable to render annotation overlay for capture.'))
    }
    image.src = url
  })
}

function drawCaptureTextOverlays(
  context: CanvasRenderingContext2D,
  sourceElement: HTMLElement,
  geometry: CaptureRenderGeometry,
  options: { includeViewportOverlays?: boolean; measurementBadgesOnly?: boolean } = {},
) {
  const selectors = options.measurementBadgesOnly
    ? ['.ich-volume-badge']
    : [
      ...(options.includeViewportOverlays === false ? [] : ['.viewport-overlay span', '.mpr-overlay span']),
      '.text-marker-label',
      '.ich-volume-badge',
      '.bone-3d-mode-badge',
    ]
  const labels = Array.from(sourceElement.querySelectorAll<HTMLElement>(selectors.join(', ')))
  const isVisibleLabel = (label: HTMLElement) => {
    const rect = label.getBoundingClientRect()
    const style = window.getComputedStyle(label)
    const text = label.textContent?.trim()
    return Boolean(text && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none')
  }

  labels.filter(isVisibleLabel).forEach((label) => {
    const rect = label.getBoundingClientRect()
    const style = window.getComputedStyle(label)
    const text = label.textContent?.trim() ?? ''

    const scale = Math.min(geometry.scaleX, geometry.scaleY)
    let fontSize = (Number.parseFloat(style.fontSize) || 13) * scale
    let textAlign: CanvasTextAlign = style.textAlign === 'right' || style.textAlign === 'center' ? style.textAlign as CanvasTextAlign : 'left'
    const targetRect = mapRectToCaptureOutput(toCaptureRect(rect), geometry)
    let x = textAlign === 'right'
      ? targetRect.left + targetRect.width
      : textAlign === 'center'
        ? targetRect.left + targetRect.width / 2
        : targetRect.left
    let y = targetRect.top + Math.max(0, (targetRect.height - fontSize) / 2)
    const overlayBlock = label.closest<HTMLElement>('.viewport-overlay')
    const isLeft = Boolean(overlayBlock?.classList.contains('top-left') || overlayBlock?.classList.contains('bottom-left'))
    const isRight = Boolean(overlayBlock?.classList.contains('top-right') || overlayBlock?.classList.contains('bottom-right'))
    const isTop = Boolean(overlayBlock?.classList.contains('top-left') || overlayBlock?.classList.contains('top-right'))
    const isBottom = Boolean(overlayBlock?.classList.contains('bottom-left') || overlayBlock?.classList.contains('bottom-right'))

    context.save()
    context.fillStyle = style.color || '#33ff66'
    context.strokeStyle = 'rgba(0, 0, 0, 0.9)'
    context.lineJoin = 'round'

    if (overlayBlock && (isLeft || isRight) && (isTop || isBottom)) {
      const blockLabels = Array.from(overlayBlock.querySelectorAll<HTMLElement>('span')).filter(isVisibleLabel)
      const lineIndex = Math.max(0, blockLabels.indexOf(label))
      const padding = Math.max(10, fontSize * 0.65)
      const maximumWidth = Math.max(1, context.canvas.width * 0.48 - padding)
      context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`
      const measuredWidth = context.measureText(text).width
      if (measuredWidth > maximumWidth) {
        fontSize = Math.max(8, fontSize * maximumWidth / measuredWidth)
      }
      const lineHeight = fontSize * 1.08
      textAlign = isRight ? 'right' : 'left'
      x = isRight ? context.canvas.width - padding : padding
      y = isBottom
        ? context.canvas.height - padding - (blockLabels.length - lineIndex) * lineHeight
        : padding + lineIndex * lineHeight
    }

    context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`
    context.lineWidth = Math.max(1.5, fontSize * 0.16)
    const textWidth = context.measureText(text).width
    const edgePadding = Math.max(6, fontSize * 0.35)
    if (textAlign === 'right') {
      x = clamp(x, Math.min(context.canvas.width - edgePadding, textWidth + edgePadding), context.canvas.width - edgePadding)
    } else if (textAlign === 'center') {
      x = clamp(x, textWidth / 2 + edgePadding, context.canvas.width - textWidth / 2 - edgePadding)
    } else {
      x = clamp(x, edgePadding, Math.max(edgePadding, context.canvas.width - textWidth - edgePadding))
    }
    y = clamp(y, edgePadding, Math.max(edgePadding, context.canvas.height - fontSize - edgePadding))
    context.textAlign = textAlign
    context.textBaseline = 'top'
    context.strokeText(text, x, y)
    context.fillText(text, x, y)
    context.restore()
  })
}

function buildBaseDataset(
  context: SaveContext,
  options: {
    sopClassUid: string
    sopInstanceUid: string
    seriesInstanceUid: string
    modality: string
    seriesDescription: string
  },
) {
  const metadata = context.instance?.metadata ?? {}

  return {
    SpecificCharacterSet: 'ISO_IR 192',
    SOPClassUID: options.sopClassUid,
    SOPInstanceUID: options.sopInstanceUid,
    StudyInstanceUID: context.study!.studyInstanceUid,
    SeriesInstanceUID: options.seriesInstanceUid,
    Modality: options.modality,
    PatientName: readDicomString(metadata, '00100010') || context.study!.patientName || 'Unknown',
    PatientID: readDicomString(metadata, '00100020') || context.study!.patientId || '',
    PatientBirthDate: readDicomString(metadata, '00100030'),
    PatientSex: readDicomString(metadata, '00100040'),
    StudyDate: readDicomString(metadata, '00080020') || context.study!.studyDate || today(),
    StudyTime: readDicomString(metadata, '00080030') || nowTime(),
    StudyDescription: readDicomString(metadata, '00081030') || context.study!.studyDescription || '',
    AccessionNumber: readDicomString(metadata, '00080050') || context.study!.accessionNumber || '',
    StudyID: readDicomString(metadata, '00200010') || '',
    ReferringPhysicianName: readDicomString(metadata, '00080090'),
    SeriesNumber: nextSeriesNumber(),
    InstanceNumber: 1,
    SeriesDate: today(),
    SeriesTime: nowTime(),
    ContentDate: today(),
    ContentTime: nowTime(),
    Manufacturer: 'VEXA',
    ManufacturerModelName: 'VEXAPACS',
    SoftwareVersions: '1.26.1',
    SeriesDescription: options.seriesDescription,
    ReferencedSeriesSequence: [{
      SeriesInstanceUID: context.series!.seriesInstanceUid,
      ReferencedImageSequence: [referencedImage(context.instance!)],
    }],
  }
}

function writeDicom(dcmjs: DcmjsModule, sopClassUid: string, sopInstanceUid: string, dataset: Record<string, unknown>) {
  const meta = dcmjs.data.DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    TransferSyntaxUID: explicitVrLittleEndian,
    MediaStorageSOPClassUID: sopClassUid,
    MediaStorageSOPInstanceUID: sopInstanceUid,
    ImplementationClassUID: implementationClassUid,
    ImplementationVersionName: 'VEXA_1_26_1',
  })
  const dicomDict = new dcmjs.data.DicomDict(meta)
  dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
  return dicomDict.write()
}

function referencedImage(instance: InstanceSummary) {
  return {
    ReferencedSOPClassUID: readDicomString(instance.metadata ?? {}, '00080016') || '1.2.840.10008.5.1.4.1.1.2',
    ReferencedSOPInstanceUID: instance.sopInstanceUid,
  }
}

function sanitizeSeriesDescription(value: string | undefined) {
  return value?.trim().slice(0, 64) ?? ''
}

function sanitizeModality(value: string | undefined) {
  return value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) ?? ''
}

function canvasToHighContrastGrayscalePixelData(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Unable to read capture canvas.')
  }
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
  const grayscaleLength = canvas.width * canvas.height
  const grayscale = new Uint8Array(grayscaleLength + (grayscaleLength % 2))
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
    const red = rgba[source]
    const green = rgba[source + 1]
    const blue = rgba[source + 2]
    const luminance = Math.round((red * 0.299) + (green * 0.587) + (blue * 0.114))
    const channelSpread = Math.max(red, green, blue) - Math.min(red, green, blue)
    const isColoredOverlay = channelSpread > 8 && Math.max(red, green, blue) > 20
    grayscale[target] = isColoredOverlay ? 255 : luminance
  }
  return grayscale
}

function canvasToRgbPixelData(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Unable to read capture canvas.')
  }
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
  const byteLength = canvas.width * canvas.height * 3
  const rgb = new Uint8Array(byteLength + (byteLength % 2))
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source]
    rgb[target + 1] = rgba[source + 1]
    rgb[target + 2] = rgba[source + 2]
  }
  return rgb
}

function assertSaveContext(context: SaveContext) {
  if (!context.study?.studyInstanceUid || !context.series?.seriesInstanceUid || !context.instance?.sopInstanceUid) {
    throw new Error('Active image metadata is incomplete.')
  }
}

function readDicomString(dataset: Record<string, unknown>, tag: string) {
  const element = dataset[tag] as { Value?: unknown[] } | undefined
  const value = element?.Value?.[0]
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'Alphabetic' in value) return String((value as { Alphabetic?: string }).Alphabetic ?? '')
  return ''
}

async function importDcmjs() {
  return await import('dcmjs') as unknown as DcmjsModule
}

function today() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function nowTime() {
  return new Date().toTimeString().slice(0, 8).replaceAll(':', '')
}

function nextSeriesNumber() {
  return Math.floor(Date.now() / 1000) % 100000
}

function toSavedSeries(
  studyInstanceUid: string,
  seriesInstanceUid: string,
  modality: string,
  seriesDescription: string,
  instanceCount = 1,
): SeriesSummary {
  return {
    studyInstanceUid,
    seriesInstanceUid,
    modality,
    seriesDescription,
    seriesNumber: String(nextSeriesNumber()),
    instanceCount,
  }
}

function notifySeriesSaved(series: SeriesSummary) {
  window.dispatchEvent(new CustomEvent('vexa-viewer-series-saved', { detail: { studyInstanceUid: series.studyInstanceUid, series } }))
}

function persistSavedGspsOverlay(overlay: SavedGspsOverlay) {
  try {
    unsuppressSavedGsps(overlay.studyInstanceUid, overlay.seriesInstanceUid, overlay.sopInstanceUid)
    const existing = readSavedGspsOverlays()
    const next = [...existing.filter((item) => item.id !== overlay.id), overlay]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500)
    window.localStorage.setItem(savedGspsStorageKey, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('vexa-viewer-gsps-overlay-saved', { detail: overlay }))
  } catch {
    // The PACS save still succeeds if browser persistence is unavailable.
  }
}

function readSavedGspsOverlays(): SavedGspsOverlay[] {
  try {
    const rawValue = window.localStorage.getItem(savedGspsStorageKey)
    const parsed = rawValue ? JSON.parse(rawValue) : []
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(isSavedGspsOverlay)
  } catch {
    return []
  }
}

function isSavedGspsOverlay(value: unknown): value is SavedGspsOverlay {
  const overlay = value as Partial<SavedGspsOverlay>
  return Boolean(
    overlay &&
    typeof overlay.id === 'string' &&
    typeof overlay.studyInstanceUid === 'string' &&
    typeof overlay.seriesInstanceUid === 'string' &&
    typeof overlay.sopInstanceUid === 'string' &&
    Array.isArray(overlay.graphics),
  )
}

function savedGspsKey(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
  return `${studyInstanceUid}|${seriesInstanceUid}|${sopInstanceUid}`
}

function suppressSavedGsps(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
  const key = savedGspsKey(studyInstanceUid, seriesInstanceUid, sopInstanceUid)
  const next = [...new Set([...readSuppressedGspsKeys(), key])]
  window.localStorage.setItem(suppressedGspsStorageKey, JSON.stringify(next))
}

function unsuppressSavedGsps(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
  const key = savedGspsKey(studyInstanceUid, seriesInstanceUid, sopInstanceUid)
  const next = readSuppressedGspsKeys().filter((item) => item !== key)
  window.localStorage.setItem(suppressedGspsStorageKey, JSON.stringify(next))
}

function readSuppressedGspsKeys() {
  try {
    const rawValue = window.localStorage.getItem(suppressedGspsStorageKey)
    const parsed = rawValue ? JSON.parse(rawValue) : []
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}
