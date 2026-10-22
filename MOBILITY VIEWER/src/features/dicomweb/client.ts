import { dicomWebConfig } from '../../config/dicomweb'
import { appUrl } from '../../config/appBase'
import type { DicomJsonDataset, InstanceSummary, SeriesSummary, StructuredReportItem, StructuredReportSummary, StudySummary, WaveformSummary } from './types'
import { wadors } from '@cornerstonejs/dicom-image-loader'

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // crypto.randomUUID is only available in secure contexts (HTTPS/localhost).
  // Fall back for plain-HTTP LAN deployments so STOW/ICH save still works.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] % 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const tags = {
  accessionNumber: '00080050',
  modality: '00080060',
  modalitiesInStudy: '00080061',
  studyDate: '00080020',
  studyDescription: '00081030',
  seriesDescription: '0008103E',
  seriesNumber: '00200011',
  instanceNumber: '00200013',
  patientName: '00100010',
  patientId: '00100020',
  studyInstanceUid: '0020000D',
  seriesInstanceUid: '0020000E',
  sopInstanceUid: '00080018',
  numberOfFrames: '00280008',
  numberOfSeriesRelatedInstances: '00201209',
  imagePositionPatient: '00200032',
  imageOrientationPatient: '00200037',
  sliceThickness: '00180050',
  pixelSpacing: '00280030',
  samplesPerPixel: '00280002',
  photometricInterpretation: '00280004',
  planarConfiguration: '00280006',
  rows: '00280010',
  columns: '00280011',
  bitsStored: '00280101',
  pixelRepresentation: '00280103',
  windowCenter: '00281050',
  windowWidth: '00281051',
  rescaleIntercept: '00281052',
  rescaleSlope: '00281053',
  waveformSequence: '54000100',
  waveformData: '54001010',
  numberOfWaveformChannels: '003A0005',
  numberOfWaveformSamples: '003A0010',
  samplingFrequency: '003A001A',
  waveformBitsAllocated: '54001004',
  waveformSampleInterpretation: '54001006',
  channelDefinitionSequence: '003A0200',
  channelLabel: '003A0203',
  channelSourceSequence: '003A0208',
  codeMeaning: '00080104',
  channelSensitivity: '003A0210',
  channelSensitivityCorrectionFactor: '003A0212',
  channelBaseline: '003A0213',
  filterLowFrequency: '003A0220',
  filterHighFrequency: '003A0221',
  notchFilterFrequency: '003A0222',
  ventricularHeartRate: '00181088',
  electrodePlacement: '00181060',
  textValue: '0040A160',
  contentSequence: '0040A730',
  conceptNameCodeSequence: '0040A043',
  valueType: '0040A040',
  dateValue: '0040A121',
  timeValue: '0040A122',
  dateTimeValue: '0040A120',
  personName: '0040A123',
  uid: '0040A124',
  measuredValueSequence: '0040A300',
  numericValue: '0040A30A',
  measurementUnitsCodeSequence: '004008EA',
}

function readValue(dataset: DicomJsonDataset, tag: string): string {
  const value = dataset[tag]?.Value?.[0]

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }

  if (value && typeof value === 'object' && 'Alphabetic' in value) {
    return String(value.Alphabetic)
  }

  return ''
}

function readNumberValues(dataset: DicomJsonDataset, tag: string): number[] {
  const values = dataset[tag]?.Value

  if (!Array.isArray(values)) {
    return []
  }

  return values.map(Number).filter(Number.isFinite)
}

function endpoint(prefix: string, path: string) {
  const base = [dicomWebConfig.baseUrl, prefix].filter(Boolean).join('/')
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function requestDicomJson(path: string, prefix = dicomWebConfig.qidoPrefix) {
  if (!dicomWebConfig.baseUrl) {
    return [] as DicomJsonDataset[]
  }

  const response = await fetch(endpoint(prefix ?? '', path), {
    headers: {
      Accept: 'application/dicom+json',
      ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`DICOMweb request failed: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as DicomJsonDataset[]
}

export async function stowDicomInstances(studyInstanceUid: string, instances: ArrayBuffer[]) {
  if (!dicomWebConfig.baseUrl) {
    throw new Error('DICOMweb base URL is not configured.')
  }
  if (!instances.length) {
    throw new Error('No DICOM object to store.')
  }

  const boundary = `vexa-${randomUuid()}`
  const parts: BlobPart[] = []
  instances.forEach((instance) => {
    parts.push(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`)
    parts.push(instance)
    parts.push('\r\n')
  })
  parts.push(`--${boundary}--\r\n`)

  const uploadBody = new Blob(parts, { type: `multipart/related; type="application/dicom"; boundary=${boundary}` })
  const headers = {
    Accept: 'application/dicom+json, application/json, */*',
    'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
    ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
  }
  const firstResponse = await postStowDicom(endpoint(dicomWebConfig.stowPrefix ?? '', `studies/${encodeURIComponent(studyInstanceUid)}`), headers, uploadBody)
  if (isSuccessfulStowResponse(firstResponse)) {
    invalidateDicomWebCaches(studyInstanceUid)
    return
  }

  if (firstResponse.status === 404 || firstResponse.status === 405 || isHtmlResponse(firstResponse)) {
    const fallbackResponse = await postStowDicom(endpoint(dicomWebConfig.stowPrefix ?? '', 'studies'), headers, uploadBody)
    if (isSuccessfulStowResponse(fallbackResponse)) {
      invalidateDicomWebCaches(studyInstanceUid)
      return
    }
    await throwStowError(fallbackResponse)
  }

  await throwStowError(firstResponse)
}

export type StowUploadResult = {
  stored?: number
  instances?: Array<{
    studyInstanceUid?: string
    seriesInstanceUid?: string
    sopInstanceUid?: string
  }>
}

export async function uploadDicomStowRs(files: File[]): Promise<StowUploadResult | null> {
  if (!dicomWebConfig.baseUrl) {
    throw new Error('DICOMweb base URL is not configured.')
  }
  if (!files.length) {
    throw new Error('No DICOM files selected.')
  }

  const boundary = `----vexa-stow-${Date.now()}-${randomUuid()}`
  const chunks: BlobPart[] = []

  for (const file of files) {
    chunks.push(`--${boundary}\r\n`)
    chunks.push('Content-Type: application/dicom\r\n\r\n')
    chunks.push(file)
    chunks.push('\r\n')
  }

  chunks.push(`--${boundary}--\r\n`)

  const body = new Blob(chunks, {
    type: `multipart/related; type="application/dicom"; boundary=${boundary}`,
  })
  const headers = {
    Accept: 'application/dicom+json, application/json, */*',
    'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
    ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
  }
  const response = await postStowDicom(endpoint(dicomWebConfig.stowPrefix ?? '', 'studies'), headers, body)

  if (!isSuccessfulStowResponse(response)) {
    await throwStowError(response)
  }

  invalidateDicomWebCaches()
  return response.json().catch(() => null) as Promise<StowUploadResult | null>
}

async function postStowDicom(url: string, headers: Record<string, string>, body: Blob) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 30000)
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('DICOMweb STOW-RS timeout after 30 seconds.')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function isSuccessfulStowResponse(response: Response) {
  if (!response.ok) {
    return false
  }

  return !isHtmlResponse(response)
}

function isHtmlResponse(response: Response) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  return contentType.includes('text/html')
}

async function throwStowError(response: Response): Promise<never> {
  const message = await response.text().catch(() => '')
  if (isHtmlResponse(response)) {
    throw new Error(`DICOMweb STOW-RS endpoint is not routed correctly: ${response.url || 'unknown URL'} returned viewer HTML instead of a DICOMweb STOW response. Configure VITE_DICOMWEB_STOW_PREFIX/base URL to a POST-capable STOW-RS endpoint.`)
  }
  throw new Error(`DICOMweb STOW-RS failed: ${response.status} ${response.statusText}${message ? ` - ${message.slice(0, 180)}` : ''}`)
}

async function requestBulkData(bulkDataUri: string) {
  const url = bulkDataUri.startsWith('http')
    ? bulkDataUri
    : `${dicomWebConfig.baseUrl.replace(/\/+$/, '')}/${bulkDataUri.replace(/^\/+/, '')}`

  const response = await fetch(url, {
    headers: {
      Accept: 'application/octet-stream, multipart/related; type=application/octet-stream',
      ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`DICOMweb bulk data request failed: ${response.status} ${response.statusText}`)
  }

  return response.arrayBuffer()
}

function toStudySummary(dataset: DicomJsonDataset): StudySummary {
  return {
    studyInstanceUid: readValue(dataset, tags.studyInstanceUid),
    patientName: readValue(dataset, tags.patientName) || 'Unknown Patient',
    patientId: readValue(dataset, tags.patientId),
    studyDate: readValue(dataset, tags.studyDate),
    studyDescription: readValue(dataset, tags.studyDescription) || 'No description',
    modalities: readValue(dataset, tags.modalitiesInStudy),
    accessionNumber: readValue(dataset, tags.accessionNumber),
  }
}

type ViewerStudyManifest = {
  series?: Array<{
    studyInstanceUid: string
    seriesInstanceUid: string
    modality?: string
    seriesDescription?: string
    seriesNumber?: string
    instanceCount?: number
    instances?: Array<{
      studyInstanceUid: string
      seriesInstanceUid: string
      sopInstanceUid: string
      instanceNumber?: number
      numberOfFrames?: number
      rows?: number
      columns?: number
      imagePositionPatient?: number[]
      imageOrientationPatient?: number[]
      metadata?: DicomJsonDataset
    }>
  }>
}

export async function searchStudies(): Promise<StudySummary[]> {
  const now = Date.now()
  if (studyListCache && studyListCache.expiresAt > now) {
    return studyListCache.promise
  }

  const promise = requestDicomJson('studies')
    .then((datasets) => datasets.map(toStudySummary))
    .catch((error) => {
      studyListCache = null
      throw error
    })
  studyListCache = {
    promise,
    expiresAt: now + studyListCacheTtlMs,
  }

  return promise
}

export async function getStudy(studyInstanceUid: string): Promise<StudySummary | null> {
  const datasets = await requestDicomJson(`studies?StudyInstanceUID=${encodeURIComponent(studyInstanceUid)}`)
  const study = datasets[0]

  if (!study) {
    return null
  }

  return toStudySummary(study)
}

export async function getStudyByAccession(accessionNumber: string): Promise<StudySummary | null> {
  const accession = accessionNumber.trim()
  if (!accession) return null

  try {
    const datasets = await requestDicomJson(`studies?AccessionNumber=${encodeURIComponent(accession)}`)
    const study = datasets[0]
    if (study) return toStudySummary(study)
  } catch {
    // Fall back to a broad QIDO search for servers that do not filter AccessionNumber.
  }

  const studies = await searchStudies()
  return studies.find((study) => study.accessionNumber === accession) ?? null
}

export async function listSeries(studyInstanceUid: string): Promise<SeriesSummary[]> {
  const cachedSeries = seriesListCache.get(studyInstanceUid)
  if (cachedSeries) {
    return cachedSeries
  }

  const seriesRequest = getViewerStudyManifest(studyInstanceUid)
    .then((manifest) => {
      if (!manifest?.series?.length) {
        throw new Error('Viewer manifest is empty')
      }
      const seriesList = manifest.series.map((series) => ({
        studyInstanceUid,
        seriesInstanceUid: series.seriesInstanceUid,
        modality: series.modality || '',
        seriesDescription: series.seriesDescription || 'Series',
        seriesNumber: series.seriesNumber || '',
        instanceCount: Number(series.instanceCount) || series.instances?.length || 0,
      }))
      seedManifestInstanceCaches(manifest)
      return seriesList
    })
    .catch(() => requestDicomJson(`studies/${studyInstanceUid}/series`).then((datasets) => datasets.map((dataset) => ({
      studyInstanceUid,
      seriesInstanceUid: readValue(dataset, tags.seriesInstanceUid),
      modality: readValue(dataset, tags.modality),
      seriesDescription: readValue(dataset, tags.seriesDescription) || 'Series',
      seriesNumber: readValue(dataset, tags.seriesNumber),
      instanceCount: Number(readValue(dataset, tags.numberOfSeriesRelatedInstances)) || 0,
    }))))
    .catch((error) => {
      seriesListCache.delete(studyInstanceUid)
      throw error
    })

  seriesListCache.set(studyInstanceUid, seriesRequest)

  return seriesRequest
}

const seriesListCache = new Map<string, Promise<SeriesSummary[]>>()
const instanceListCache = new Map<string, Promise<InstanceSummary[]>>()
const initialViewportPreviewCache = new Map<string, Promise<InstanceSummary | null>>()
const thumbnailCache = new Map<string, Promise<string | null>>()
const studyListCacheTtlMs = 10_000
let studyListCache: { promise: Promise<StudySummary[]>; expiresAt: number } | null = null
// The full manifest includes every instance's metadata. It is useful for an
// explicit warm-cache deployment, but is too expensive for a mobile first paint.
const viewerManifestEnabled = import.meta.env.VITE_VIEWER_MANIFEST_ENABLED === 'true'
const viewerManifestCache = new Map<string, Promise<ViewerStudyManifest | null>>()

async function getViewerStudyManifest(studyInstanceUid: string): Promise<ViewerStudyManifest | null> {
  if (!viewerManifestEnabled) return null
  const cached = viewerManifestCache.get(studyInstanceUid)
  if (cached) return cached

  const request = fetch(appUrl(`/api/viewer/studies/${encodeURIComponent(studyInstanceUid)}/manifest`), {
    headers: {
      Accept: 'application/json',
      ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
    },
  })
    .then(async (response) => {
      if (!response.ok) return null
      return response.json() as Promise<ViewerStudyManifest>
    })
    .catch(() => null)

  viewerManifestCache.set(studyInstanceUid, request)
  request.then((manifest) => {
    if (!manifest) viewerManifestCache.delete(studyInstanceUid)
  })
  return request
}

function seedManifestInstanceCaches(manifest: ViewerStudyManifest) {
  manifest.series?.forEach((series) => {
    if (!series.studyInstanceUid || !series.seriesInstanceUid || !series.instances?.length) return
    const cacheKey = `${series.studyInstanceUid}|${series.seriesInstanceUid}`
    if (instanceListCache.has(cacheKey)) return
    const instances = series.instances
      .map((instance, index) => ({
        studyInstanceUid: instance.studyInstanceUid || series.studyInstanceUid,
        seriesInstanceUid: instance.seriesInstanceUid || series.seriesInstanceUid,
        sopInstanceUid: instance.sopInstanceUid,
        instanceNumber: Number(instance.instanceNumber) || index + 1,
        numberOfFrames: Number(instance.numberOfFrames) || 1,
        rows: Number(instance.rows) || Number(instance.metadata ? readValue(instance.metadata, tags.rows) : 0) || 0,
        columns: Number(instance.columns) || Number(instance.metadata ? readValue(instance.metadata, tags.columns) : 0) || 0,
        imagePositionPatient: instance.imagePositionPatient?.length === 3
          ? instance.imagePositionPatient
          : instance.metadata ? normalizeNumberArray(instance.metadata, tags.imagePositionPatient, 3) : undefined,
        imageOrientationPatient: instance.imageOrientationPatient?.length === 6
          ? instance.imageOrientationPatient
          : instance.metadata ? normalizeNumberArray(instance.metadata, tags.imageOrientationPatient, 6) : undefined,
        metadata: instance.metadata ?? {},
      }))
      .filter((instance) => instance.sopInstanceUid)
      .sort((a, b) => {
        const az = a.imagePositionPatient?.[2] ?? Number.NaN
        const bz = b.imagePositionPatient?.[2] ?? Number.NaN
        if (Number.isFinite(az) && Number.isFinite(bz) && az !== bz) return az - bz
        return a.instanceNumber - b.instanceNumber
      })
    instanceListCache.set(cacheKey, Promise.resolve(instances))
  })
}

function normalizeNumberArray(dataset: DicomJsonDataset, tag: string, expectedLength: number) {
  const values = readNumberValues(dataset, tag)
  return values.length === expectedLength ? values : undefined
}

export function invalidateDicomWebCaches(studyInstanceUid?: string) {
  if (!studyInstanceUid) {
    studyListCache = null
    viewerManifestCache.clear()
    seriesListCache.clear()
    instanceListCache.clear()
    initialViewportPreviewCache.clear()
    thumbnailCache.clear()
    invalidateFastThumbnailCache()
    return
  }

  studyListCache = null
  viewerManifestCache.delete(studyInstanceUid)
  seriesListCache.delete(studyInstanceUid)
  Array.from(instanceListCache.keys())
    .filter((key) => key.startsWith(`${studyInstanceUid}|`))
    .forEach((key) => instanceListCache.delete(key))
  Array.from(initialViewportPreviewCache.keys())
    .filter((key) => key.startsWith(`${studyInstanceUid}|`))
    .forEach((key) => initialViewportPreviewCache.delete(key))
  Array.from(thumbnailCache.keys())
    .filter((key) => key.startsWith(`${studyInstanceUid}|`))
    .forEach((key) => thumbnailCache.delete(key))
  invalidateFastThumbnailCache(studyInstanceUid)
  invalidateRenderedPreviewCache()
}


export async function listInstances(series: SeriesSummary): Promise<InstanceSummary[]> {
  const cacheKey = `${series.studyInstanceUid}|${series.seriesInstanceUid}`
  const cachedInstances = instanceListCache.get(cacheKey)
  if (cachedInstances) {
    return cachedInstances
  }

  const instancesRequest = fetchInstances(series).catch((error) => {
    instanceListCache.delete(cacheKey)
    throw error
  })

  instanceListCache.set(cacheKey, instancesRequest)

  return instancesRequest
}

const initialPreviewIncludeFields = [
  'InstanceNumber',
  'NumberOfFrames',
  'Rows',
  'Columns',
  'ImagePositionPatient',
  'ImageOrientationPatient',
  'WindowCenter',
  'WindowWidth',
  'RescaleIntercept',
  'RescaleSlope',
  'PhotometricInterpretation',
].join(',')

export const RENDERED_VIEWPORT_PREVIEW_SIZE = 512

/** Fetch one centered DICOM header without waiting for the full series metadata. */
export async function fetchInitialViewportPreviewInstance(series: SeriesSummary): Promise<InstanceSummary | null> {
  const cacheKey = `${series.studyInstanceUid}|${series.seriesInstanceUid}`
  const cached = initialViewportPreviewCache.get(cacheKey)
  if (cached) return cached

  const request = fetchViewportPreviewInstance(series).catch((error) => {
    initialViewportPreviewCache.delete(cacheKey)
    throw error
  })
  initialViewportPreviewCache.set(cacheKey, request)
  return request
}

async function fetchViewportPreviewInstance(series: SeriesSummary): Promise<InstanceSummary | null> {
  const preferredOffset = Math.max(0, Math.floor(Math.max(1, series.instanceCount) / 2))
  const preferred = await requestPreviewInstanceAt(series, preferredOffset)
  return preferred ?? (preferredOffset > 0 ? requestPreviewInstanceAt(series, 0) : null)
}

async function requestPreviewInstanceAt(series: SeriesSummary, offset: number): Promise<InstanceSummary | null> {
  const datasets = await requestDicomJson(
    `studies/${series.studyInstanceUid}/series/${series.seriesInstanceUid}/instances?limit=1&offset=${offset}&includefield=${initialPreviewIncludeFields}`,
  )
  const dataset = datasets.find((item) => Boolean(readValue(item, tags.sopInstanceUid)))
  if (!dataset) return null

  const imagePositionPatient = readNumberValues(dataset, tags.imagePositionPatient)
  const imageOrientationPatient = readNumberValues(dataset, tags.imageOrientationPatient)
  return {
    studyInstanceUid: series.studyInstanceUid,
    seriesInstanceUid: series.seriesInstanceUid,
    sopInstanceUid: readValue(dataset, tags.sopInstanceUid),
    instanceNumber: Number(readValue(dataset, tags.instanceNumber)) || offset + 1,
    numberOfFrames: Number(readValue(dataset, tags.numberOfFrames)) || 1,
    rows: Number(readValue(dataset, tags.rows)) || 0,
    columns: Number(readValue(dataset, tags.columns)) || 0,
    imagePositionPatient: imagePositionPatient.length === 3 ? imagePositionPatient : undefined,
    imageOrientationPatient: imageOrientationPatient.length === 6 ? imageOrientationPatient : undefined,
    metadata: dataset,
  }
}

async function fetchInstances(series: SeriesSummary): Promise<InstanceSummary[]> {
  let metadata: DicomJsonDataset[] = []
  try {
    metadata = await requestDicomJson(`studies/${series.studyInstanceUid}/series/${series.seriesInstanceUid}/metadata`)
  } catch {
    metadata = []
  }

  const instances = metadata.length
    ? []
    : await requestDicomJson(
      `studies/${series.studyInstanceUid}/series/${series.seriesInstanceUid}/instances`,
    )

  const metadataBySopInstanceUid = new Map(
    metadata.map((dataset) => [readValue(dataset, tags.sopInstanceUid), dataset]),
  )
  const sourceDatasets = metadata.length ? metadata : instances

  return sourceDatasets
    .map((dataset, index) => {
      const sopInstanceUid = readValue(dataset, tags.sopInstanceUid)
      const fullMetadata = metadataBySopInstanceUid.get(sopInstanceUid) ?? dataset
      const imagePositionPatient = readNumberValues(fullMetadata, tags.imagePositionPatient)
      const imageOrientationPatient = readNumberValues(fullMetadata, tags.imageOrientationPatient)

      return {
        studyInstanceUid: series.studyInstanceUid,
        seriesInstanceUid: series.seriesInstanceUid,
        sopInstanceUid,
        instanceNumber:
          Number(readValue(fullMetadata, tags.instanceNumber)) || index + 1,
        numberOfFrames: Number(readValue(fullMetadata, tags.numberOfFrames)) || 1,
        rows: Number(readValue(fullMetadata, tags.rows)) || 0,
        columns: Number(readValue(fullMetadata, tags.columns)) || 0,
        imagePositionPatient: imagePositionPatient.length === 3 ? imagePositionPatient : undefined,
        imageOrientationPatient: imageOrientationPatient.length === 6 ? imageOrientationPatient : undefined,
        metadata: fullMetadata,
      }
    })
    .filter((instance) => instance.sopInstanceUid)
    .sort((a, b) => {
      // Sort by ImagePositionPatient Z-axis for proper anatomical ordering
      const az = a.imagePositionPatient?.[2] ?? 0
      const bz = b.imagePositionPatient?.[2] ?? 0
      if (az !== bz) return az - bz
      // Fallback: if same Z, use instanceNumber
      return a.instanceNumber - b.instanceNumber
    })
}

export async function listInstanceHeaders(series: SeriesSummary): Promise<InstanceSummary[]> {
  const datasets = await requestDicomJson(
    `studies/${series.studyInstanceUid}/series/${series.seriesInstanceUid}/instances`,
  )

  return datasets
    .map((dataset, index) => ({
      studyInstanceUid: series.studyInstanceUid,
      seriesInstanceUid: series.seriesInstanceUid,
      sopInstanceUid: readValue(dataset, tags.sopInstanceUid),
      instanceNumber: Number(readValue(dataset, tags.instanceNumber)) || index + 1,
      numberOfFrames: Number(readValue(dataset, tags.numberOfFrames)) || 1,
      rows: Number(readValue(dataset, tags.rows)) || 0,
      columns: Number(readValue(dataset, tags.columns)) || 0,
    }))
    .sort((a, b) => a.instanceNumber - b.instanceNumber)
}

export function createWadoRsImageId(instance: InstanceSummary, frame = 1) {
  const wadoBase = endpoint(dicomWebConfig.wadoPrefix ?? '', '')

  return `wadors:${wadoBase}studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/frames/${frame}`
}

export function createWadoRsImageIds(instances: InstanceSummary[]) {
  return instances.flatMap((instance) => {
    const frameCount = Math.max(1, instance.numberOfFrames || 1)
    const wadoBase = endpoint(dicomWebConfig.wadoPrefix ?? '', '')

    return Array.from({ length: frameCount }, (_, index) => (
      `wadors:${wadoBase}studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/frames/${index + 1}`
    ))
  })
}

export interface RenderedImageOptions {
  rows?: number
  columns?: number
  windowCenter?: number
  windowWidth?: number
  quality?: number
  frame?: number
}

const renderedPreviewPresentationVersion = 'v4-jpeg2000-rendered-jpeg'

export function createRenderedImageUrl(instance: InstanceSummary, options: RenderedImageOptions = {}) {
  const { rows, columns, windowCenter, windowWidth, quality = 70, frame = 1 } = options
  const wadoBase = endpoint(dicomWebConfig.wadoPrefix ?? '', '')
  let url = `${wadoBase}studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/rendered?frame=${encodeURIComponent(frame)}&pv=${encodeURIComponent(renderedPreviewPresentationVersion)}`
  if (rows) url += `&rows=${encodeURIComponent(rows)}`
  if (columns) url += `&columns=${encodeURIComponent(columns)}`
  if (windowCenter !== undefined) url += `&wc=${encodeURIComponent(windowCenter)}`
  if (windowWidth !== undefined) url += `&ww=${encodeURIComponent(windowWidth)}`
  if (quality !== 70) url += `&quality=${encodeURIComponent(quality)}`
  return url
}

const renderedPreviewCache = new Map<string, Promise<Blob | null>>()

export async function fetchRenderedPreviewDataUrl(
  instance: InstanceSummary,
  options: RenderedImageOptions = {},
  signal?: AbortSignal,
): Promise<string | null> {
  const blob = signal
    ? await _fetchRenderedPreviewBlob(instance, options, signal)
    : await getRenderedPreviewBlob(instance, options)
  return blob ? URL.createObjectURL(blob) : null
}

/** Warms the rendered JPEG cache so a viewport can paint without another network wait. */
export async function prefetchRenderedPreview(
  instance: InstanceSummary,
  options: RenderedImageOptions = {},
): Promise<void> {
  await getRenderedPreviewBlob(instance, options)
}

async function getRenderedPreviewBlob(
  instance: InstanceSummary,
  options: RenderedImageOptions = {},
): Promise<Blob | null> {
  const ck = [
    'rp',
    instance.studyInstanceUid,
    instance.seriesInstanceUid,
    instance.sopInstanceUid,
    `${options.rows ?? 0}x${options.columns ?? 0}`,
    `f${options.frame ?? 1}`,
    `wc${options.windowCenter ?? 'auto'}`,
    `ww${options.windowWidth ?? 'auto'}`,
    `q${options.quality ?? 70}`,
    `pv${renderedPreviewPresentationVersion}`,
  ].join('|')
  const c = renderedPreviewCache.get(ck)
  if (c) {
    return c
  }
  const p = _fetchRenderedPreviewBlob(instance, options)
  renderedPreviewCache.set(ck, p)
  p.catch(() => renderedPreviewCache.delete(ck))
  return p
}

async function _fetchRenderedPreviewBlob(
  instance: InstanceSummary,
  options: RenderedImageOptions = {},
  signal?: AbortSignal,
): Promise<Blob | null> {
  try {
    const url = createRenderedImageUrl(instance, options)
    const resp = await fetch(url, {
      signal,
      headers: {
        Accept: 'image/jpeg',
        ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
      },
    })
    if (!resp.ok) return null
    const blob = await resp.blob()
    if (!blob.size) return null
    return blob
  } catch {
    return null
  }
}

export function invalidateRenderedPreviewCache() {
  renderedPreviewCache.clear()
}

export function isRenderableImageInstance(instance: InstanceSummary) {
  return instance.rows > 0 && instance.columns > 0
}

export async function hasRenderableImages(series: SeriesSummary) {
  const instances = await listInstances(series)

  return instances.some(isRenderableImageInstance)
}

export async function getSeriesWaveform(series: SeriesSummary): Promise<WaveformSummary | null> {
  const instances = await listInstances(series)

  for (const instance of instances) {
    const waveform = await readWaveform(instance.metadata)
    if (waveform) {
      return waveform
    }
  }

  return null
}

export function hasWaveformData(instance: InstanceSummary) {
  return Boolean(instance.metadata?.[tags.waveformSequence]?.Value?.length)
}

export async function getSeriesStructuredReport(series: SeriesSummary): Promise<StructuredReportSummary | null> {
  if (series.modality?.toUpperCase() !== 'SR') {
    return null
  }

  const instances = await listInstances(series)
  const metadata = instances.find((instance) => instance.metadata?.[tags.contentSequence]?.Value?.length)?.metadata
  if (!metadata) {
    return null
  }

  const title = readConceptName(metadata) || series.seriesDescription || 'Structured Report'
  const contentItems = metadata[tags.contentSequence]?.Value ?? []
  const items = contentItems
    .map((item) => readStructuredReportItem(item as DicomJsonDataset))
    .filter((item): item is StructuredReportItem => Boolean(item))

  return { title, items }
}

export function registerWadoRsMetadata(instances: InstanceSummary[]) {
  instances.forEach((instance) => {
    if (!instance.metadata) {
      return
    }

    const imageIds = createWadoRsImageIds([instance])
    const metadata = normalizeWadoRsMetadata(cloneDicomJsonDataset(instance.metadata))

    imageIds.forEach((imageId) => {
      wadors.metaDataManager.remove(imageId)
      wadors.metaDataManager.add(imageId, metadata as never)
    })
  })
}

function normalizeWadoRsMetadata(metadata: DicomJsonDataset): DicomJsonDataset {
  const photometricInterpretation = readValue(metadata, tags.photometricInterpretation).toUpperCase()
  if (photometricInterpretation === 'RGB') {
    metadata[tags.samplesPerPixel] ??= { vr: 'US', Value: [3] }
    metadata[tags.planarConfiguration] ??= { vr: 'US', Value: [0] }
  }

  return metadata
}

function cloneDicomJsonDataset(dataset: DicomJsonDataset): DicomJsonDataset {
  return Object.fromEntries(
    Object.entries(dataset)
      .filter(([, element]) => element && Array.isArray(element.Value))
      .map(([tag, element]) => [
        tag,
        {
          ...element,
          Value: [...(element.Value ?? [])],
        },
      ]),
  )
}

async function readWaveform(dataset?: DicomJsonDataset): Promise<WaveformSummary | null> {
  const waveformItems = dataset?.[tags.waveformSequence]?.Value
  if (!Array.isArray(waveformItems)) {
    return null
  }

  for (const item of waveformItems) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const group = item as DicomJsonDataset
    const channelCount = Number(readValue(group, tags.numberOfWaveformChannels)) || 0
    const sampleCount = Number(readValue(group, tags.numberOfWaveformSamples)) || 0
    const samplingFrequency = Number(readValue(group, tags.samplingFrequency)) || 0
    const waveformDataElement = group[tags.waveformData]

    if (!channelCount || !sampleCount || !samplingFrequency || !waveformDataElement) {
      continue
    }

    const waveformBuffer = await readWaveformBuffer(waveformDataElement)
    if (!waveformBuffer) {
      continue
    }

    const bitsAllocated = Number(readValue(group, tags.waveformBitsAllocated)) || 16
    const interpretation = readValue(group, tags.waveformSampleInterpretation) || 'SS'
    const channelDefinitions = group[tags.channelDefinitionSequence]?.Value ?? []
    const samples = decodeWaveformSamples(waveformBuffer, channelCount, sampleCount, bitsAllocated, interpretation)
    const channels = samples.map((channelSamples, index) => {
      const channelDefinition = channelDefinitions[index] as DicomJsonDataset | undefined
      const sensitivity = Number(readValue(channelDefinition ?? {}, tags.channelSensitivity)) || 1
      const correction = Number(readValue(channelDefinition ?? {}, tags.channelSensitivityCorrectionFactor)) || 1
      const baseline = Number(readValue(channelDefinition ?? {}, tags.channelBaseline)) || 0
      const scaledSamples = channelSamples.map((sample) => (sample - baseline) * sensitivity * correction)

      return {
        label: readChannelLabel(channelDefinition, index),
        samples: scaledSamples,
        minimum: Math.min(...scaledSamples),
        maximum: Math.max(...scaledSamples),
      }
    })

    if (channels.some((channel) => channel.samples.length)) {
      return { samplingFrequency, sampleCount, channels, annotations: readWaveformAnnotations(dataset, group) }
    }
  }

  return null
}

function readWaveformAnnotations(dataset: DicomJsonDataset | undefined, group: DicomJsonDataset) {
  const annotations = [
    readAnnotation('Electrode Placement', dataset, tags.electrodePlacement),
    readAnnotation('Filter Low Frequency', group, tags.filterLowFrequency, 'Hz'),
    readAnnotation('Filter High Frequency', group, tags.filterHighFrequency, 'Hz'),
    readAnnotation('Notch Filter Frequency', group, tags.notchFilterFrequency, 'Hz'),
    readAnnotation('Text', group, tags.textValue),
    readAnnotation('Ventricular Heart Rate', dataset, tags.ventricularHeartRate, '{H.B.}/min'),
  ]

  return annotations.filter((annotation): annotation is { tag: string; value: string } => Boolean(annotation))
}

function readAnnotation(label: string, dataset: DicomJsonDataset | undefined, tag: string, unit = '') {
  const value = dataset ? readValue(dataset, tag) : ''

  if (!value) {
    return null
  }

  return { tag: label, value: unit ? `${value} ${unit}` : value }
}

async function readWaveformBuffer(element: DicomJsonDataset[string]) {
  if (element?.InlineBinary) {
    return decodeInlineBinary(element.InlineBinary)
  }

  if (element?.BulkDataURI) {
    return requestBulkData(element.BulkDataURI)
  }

  return null
}

function decodeInlineBinary(base64: string) {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer
}

function decodeWaveformSamples(buffer: ArrayBuffer, channelCount: number, sampleCount: number, bitsAllocated: number, interpretation: string) {
  const view = new DataView(buffer)
  const bytesPerSample = Math.max(1, bitsAllocated / 8)
  const channels = Array.from({ length: channelCount }, () => [] as number[])
  const totalSamples = Math.min(sampleCount * channelCount, Math.floor(buffer.byteLength / bytesPerSample))

  for (let index = 0; index < totalSamples; index += 1) {
    const offset = index * bytesPerSample
    const channelIndex = index % channelCount
    channels[channelIndex].push(readWaveformSample(view, offset, bitsAllocated, interpretation))
  }

  return channels
}

function readWaveformSample(view: DataView, offset: number, bitsAllocated: number, interpretation: string) {
  const signed = ['SB', 'MB', 'AB', 'SS', 'SL'].includes(interpretation)

  if (bitsAllocated === 8) {
    return signed ? view.getInt8(offset) : view.getUint8(offset)
  }

  if (bitsAllocated === 32) {
    if (interpretation === 'FL') {
      return view.getFloat32(offset, true)
    }
    return signed ? view.getInt32(offset, true) : view.getUint32(offset, true)
  }

  return signed ? view.getInt16(offset, true) : view.getUint16(offset, true)
}

function readChannelLabel(channelDefinition: DicomJsonDataset | undefined, index: number) {
  const label = readValue(channelDefinition ?? {}, tags.channelLabel)
  if (label) {
    return label
  }

  const sourceSequence = channelDefinition?.[tags.channelSourceSequence]?.Value
  const source = Array.isArray(sourceSequence) ? sourceSequence[0] as DicomJsonDataset | undefined : undefined
  const codeMeaning = readValue(source ?? {}, tags.codeMeaning)

  return codeMeaning || `Lead ${index + 1}`
}

function readStructuredReportItem(dataset: DicomJsonDataset): StructuredReportItem | null {
  const name = readConceptName(dataset) || readValue(dataset, tags.valueType) || 'Item'
  const value = readStructuredReportValue(dataset)
  const children = (dataset[tags.contentSequence]?.Value ?? [])
    .map((item) => readStructuredReportItem(item as DicomJsonDataset))
    .filter((item): item is StructuredReportItem => Boolean(item))

  if (!value && !children.length) {
    return null
  }

  return { name, value, children }
}

function readStructuredReportValue(dataset: DicomJsonDataset) {
  const directValue = [
    tags.textValue,
    tags.dateTimeValue,
    tags.dateValue,
    tags.timeValue,
    tags.personName,
    tags.uid,
  ].map((tag) => readValue(dataset, tag)).find(Boolean)

  if (directValue) {
    return directValue
  }

  const measuredValue = dataset[tags.measuredValueSequence]?.Value?.[0] as DicomJsonDataset | undefined
  if (measuredValue) {
    const numericValue = readValue(measuredValue, tags.numericValue)
    const unitSequence = measuredValue[tags.measurementUnitsCodeSequence]?.Value
    const unit = Array.isArray(unitSequence) ? readValue(unitSequence[0] as DicomJsonDataset, tags.codeMeaning) : ''

    return [numericValue, unit].filter(Boolean).join(' ')
  }

  return ''
}

function readConceptName(dataset: DicomJsonDataset) {
  const conceptSequence = dataset[tags.conceptNameCodeSequence]?.Value
  const concept = Array.isArray(conceptSequence) ? conceptSequence[0] as DicomJsonDataset | undefined : undefined

  return readValue(concept ?? {}, tags.codeMeaning)
}

const fastThumbnailCache = new Map<string, string>()
const fastThumbnailPendingCache = new Map<string, Promise<string | null>>()

export async function generateFirstFrameThumbnail(series: SeriesSummary): Promise<string | null> {
  const cacheKey = `fast|${series.studyInstanceUid}|${series.seriesInstanceUid}`
  const cached = fastThumbnailCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const pending = fastThumbnailPendingCache.get(cacheKey)
  if (pending) {
    return pending
  }

  const promise = (async () => {
    try {
      const firstInstance = await fetchFirstInstance(series)
      if (!firstInstance?.sopInstanceUid) return null

      const renderedUrl = await fetchRenderedPreviewDataUrl(firstInstance, {
        rows: 160,
        columns: 160,
        frame: 1,
        quality: 60,
        ...getThumbnailWindowing(firstInstance.metadata),
      })
      if (renderedUrl) {
        fastThumbnailCache.set(cacheKey, renderedUrl)
      }
      return renderedUrl
    } catch {
      return null
    }
  })()

  fastThumbnailPendingCache.set(cacheKey, promise)
  promise.then(
    () => fastThumbnailPendingCache.delete(cacheKey),
    () => fastThumbnailPendingCache.delete(cacheKey),
  )

  return promise
}

type FirstInstanceThumbnailSeed = InstanceSummary | null
const firstInstanceCache = new Map<string, Promise<FirstInstanceThumbnailSeed>>()

async function fetchFirstInstance(series: SeriesSummary) {
  const cacheKey = `fi|${series.studyInstanceUid}|${series.seriesInstanceUid}`
  const cached = firstInstanceCache.get(cacheKey)
  if (cached) return cached

  const seededInstances = instanceListCache.get(`${series.studyInstanceUid}|${series.seriesInstanceUid}`)
  const promise = seededInstances
    ? seededInstances.then((instances) => instances.find(isRenderableImageInstance) ?? instances[0] ?? null)
    : fetchFirstInstanceUncached(series)
  firstInstanceCache.set(cacheKey, promise)
  promise.then(
    () => undefined,
    () => { firstInstanceCache.delete(cacheKey) },
  )
  return promise
}

async function fetchFirstInstanceUncached(series: SeriesSummary) {
  return requestPreviewInstanceAt(series, 0)
}

export function invalidateFastThumbnailCache(studyInstanceUid?: string) {
  if (!studyInstanceUid) {
    for (const url of fastThumbnailCache.values()) {
      URL.revokeObjectURL(url)
    }
    fastThumbnailCache.clear()
    return
  }

  for (const [key, url] of fastThumbnailCache.entries()) {
    if (key.startsWith(`fast|${studyInstanceUid}|`)) {
      URL.revokeObjectURL(url)
      fastThumbnailCache.delete(key)
    }
  }
}

export async function generateSeriesThumbnail(series: SeriesSummary, size = 120): Promise<string | null> {
  const cacheKey = `${series.studyInstanceUid}|${series.seriesInstanceUid}|${size}`
  const cachedThumbnail = thumbnailCache.get(cacheKey)
  if (cachedThumbnail) {
    return cachedThumbnail
  }

  const thumbnailRequest = runThumbnailTask(() => generateSeriesThumbnailUncached(series, size))
    .catch((error) => {
      thumbnailCache.delete(cacheKey)
      throw error
    })

  thumbnailCache.set(cacheKey, thumbnailRequest)

  return thumbnailRequest
}

async function generateSeriesThumbnailUncached(series: SeriesSummary, size = 120): Promise<string | null> {
  try {
    const instances = await listInstances(series)
    if (!instances.length) {
      return null
    }

    const renderableInstances = instances.filter(isRenderableImageInstance)
    const candidate = createThumbnailCandidate(renderableInstances)
    if (!candidate) {
      return null
    }

    return fetchRenderedPreviewDataUrl(candidate.instance, {
      rows: size,
      columns: size,
      frame: candidate.frame,
      quality: 60,
      ...getThumbnailWindowing(candidate.instance.metadata),
    })
  } catch {
    return null
  }
}

function getThumbnailWindowing(metadata?: DicomJsonDataset) {
  if (!metadata) {
    return {}
  }

  const windowCenter = Number(readValue(metadata, tags.windowCenter))
  const windowWidth = Number(readValue(metadata, tags.windowWidth))

  return {
    ...(Number.isFinite(windowCenter) ? { windowCenter } : {}),
    ...(Number.isFinite(windowWidth) ? { windowWidth } : {}),
  }
}

function runThumbnailTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    thumbnailTaskQueue.push(() => {
      activeThumbnailTasks += 1
      void task()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeThumbnailTasks -= 1
          drainThumbnailTaskQueue()
        })
    })
    drainThumbnailTaskQueue()
  })
}

function drainThumbnailTaskQueue() {
  while (activeThumbnailTasks < maxConcurrentThumbnails && thumbnailTaskQueue.length) {
    thumbnailTaskQueue.shift()?.()
  }
}

const thumbnailTaskQueue: Array<() => void> = []
let activeThumbnailTasks = 0
const maxConcurrentThumbnails = 2

type ThumbnailCandidate = {
  instance: InstanceSummary
  frame: number
}

function createThumbnailCandidate(instances: InstanceSummary[]): ThumbnailCandidate | null {
  const totalFrames = instances.reduce((sum, instance) => sum + Math.max(1, instance.numberOfFrames || 1), 0)
  if (!totalFrames) {
    return null
  }

  let remaining = totalFrames > 20 ? Math.floor(totalFrames / 2) : 0
  for (const instance of instances) {
    const frameCount = Math.max(1, instance.numberOfFrames || 1)
    if (remaining < frameCount) {
      return { instance, frame: remaining + 1 }
    }
    remaining -= frameCount
  }

  const lastInstance = instances[instances.length - 1]
  return { instance: lastInstance, frame: Math.max(1, lastInstance.numberOfFrames || 1) }
}
