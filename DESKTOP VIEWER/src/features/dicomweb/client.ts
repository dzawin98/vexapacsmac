import { dicomWebConfig } from '../../config/dicomweb'
import { appUrl } from '../../config/appBase'
import type { DicomJsonDataset, InstanceSummary, SeriesSummary, StructuredReportItem, StructuredReportSummary, StudySummary, WaveformSummary } from './types'
import { wadors } from '@cornerstonejs/dicom-image-loader'
import { utilities as metadataUtilities } from '@cornerstonejs/metadata'

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
  sopClassUid: '00080016',
  patientName: '00100010',
  patientId: '00100020',
  studyInstanceUid: '0020000D',
  seriesInstanceUid: '0020000E',
  sopInstanceUid: '00080018',
  transferSyntaxUid: '00020010',
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
  conceptCodeSequence: '0040A168',
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

const wadoFramePresentationVersion = 'v2-ts-param'

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
    invalidateDicomWebMetadataCachesAfterStore(studyInstanceUid)
    return
  }

  if (firstResponse.status === 404 || firstResponse.status === 405 || isHtmlResponse(firstResponse)) {
    const fallbackResponse = await postStowDicom(endpoint(dicomWebConfig.stowPrefix ?? '', 'studies'), headers, uploadBody)
    if (isSuccessfulStowResponse(fallbackResponse)) {
      invalidateDicomWebMetadataCachesAfterStore(studyInstanceUid)
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

export async function retrieveDicomInstance(instance: InstanceSummary) {
  if (!dicomWebConfig.baseUrl) {
    throw new Error('DICOMweb base URL is not configured.')
  }

  const path = [
    'studies', encodeURIComponent(instance.studyInstanceUid),
    'series', encodeURIComponent(instance.seriesInstanceUid),
    'instances', encodeURIComponent(instance.sopInstanceUid),
  ].join('/')
  const response = await fetch(endpoint(dicomWebConfig.wadoPrefix ?? '', path), {
    headers: {
      Accept: 'application/dicom, multipart/related; type="application/dicom"',
      ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`DICOMweb instance retrieval failed: ${response.status} ${response.statusText}`)
  }

  const buffer = await response.arrayBuffer()
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.toLowerCase().includes('multipart/related')
    ? extractFirstDicomMultipartPart(buffer, contentType)
    : buffer
}

function extractFirstDicomMultipartPart(buffer: ArrayBuffer, contentType: string) {
  const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]
  if (!boundary) {
    throw new Error('DICOMweb multipart response has no boundary.')
  }

  const bytes = new Uint8Array(buffer)
  const headerEnd = findByteSequence(bytes, new TextEncoder().encode('\r\n\r\n'))
  if (headerEnd < 0) {
    throw new Error('DICOMweb multipart response is malformed.')
  }

  const payloadStart = headerEnd + 4
  const closingBoundary = new TextEncoder().encode(`\r\n--${boundary}`)
  const payloadEnd = findByteSequence(bytes, closingBoundary, payloadStart)
  if (payloadEnd < payloadStart) {
    throw new Error('DICOMweb multipart response has no closing boundary.')
  }

  return bytes.slice(payloadStart, payloadEnd).buffer
}

function findByteSequence(source: Uint8Array, target: Uint8Array, start = 0) {
  if (!target.length || source.length < target.length) {
    return -1
  }

  const maximum = source.length - target.length
  for (let index = Math.max(0, start); index <= maximum; index += 1) {
    let matched = true
    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      if (source[index + targetIndex] !== target[targetIndex]) {
        matched = false
        break
      }
    }
    if (matched) {
      return index
    }
  }
  return -1
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
  study?: StudySummary
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
      sopClassUid?: string
      sopInstanceUid: string
      transferSyntaxUid?: string
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
      return expandMixedOphthalmicSeries(seriesList)
    })
    .catch(() => requestDicomJson(`studies/${studyInstanceUid}/series${getStudyRefreshQuery(studyInstanceUid)}`)
      .then((datasets) => datasets.map((dataset) => ({
        studyInstanceUid,
        seriesInstanceUid: readValue(dataset, tags.seriesInstanceUid),
        modality: readValue(dataset, tags.modality),
        seriesDescription: readValue(dataset, tags.seriesDescription) || 'Series',
        seriesNumber: readValue(dataset, tags.seriesNumber),
        instanceCount: Number(readValue(dataset, tags.numberOfSeriesRelatedInstances)) || 0,
      })))
      .then(expandMixedOphthalmicSeries))
    .catch((error) => {
      seriesListCache.delete(studyInstanceUid)
      throw error
    })

  seriesListCache.set(studyInstanceUid, seriesRequest)

  return seriesRequest
}

export function getSeriesPresentationId(series: SeriesSummary) {
  return series.presentationId || series.seriesInstanceUid
}

async function expandMixedOphthalmicSeries(seriesList: SeriesSummary[]) {
  const expanded = await Promise.all(seriesList.map(async (series) => {
    const modality = series.modality?.toUpperCase() ?? ''
    if (modality !== 'OP' && modality !== 'OPT') {
      return [series]
    }

    const instances = await listInstances(series)
    const groups = new Map<string, InstanceSummary[]>()
    instances.filter(isRenderableImageInstance).forEach((instance) => {
      const instanceModality = readValue(instance.metadata ?? {}, tags.modality).toUpperCase()
      const groupKey = instanceModality || instance.sopClassUid || 'IMAGE'
      const group = groups.get(groupKey) ?? []
      group.push(instance)
      groups.set(groupKey, group)
    })

    if (groups.size < 2) {
      return [series]
    }

    return Array.from(groups.entries()).map(([groupKey, group]) => {
      const first = group[0]
      const groupModality = readValue(first.metadata ?? {}, tags.modality).toUpperCase() || modality
      const description = readValue(first.metadata ?? {}, tags.seriesDescription)
        || (groupModality === 'OPT' ? 'OCT' : groupModality === 'OP' ? 'COLOR' : series.seriesDescription)

      return {
        ...series,
        presentationId: `${series.seriesInstanceUid}|${groupKey}`,
        instanceSopInstanceUids: group.map((instance) => instance.sopInstanceUid),
        modality: groupModality,
        seriesDescription: description,
        instanceCount: group.reduce((total, instance) => total + Math.max(1, instance.numberOfFrames || 1), 0),
      }
    })
  }))

  return expanded.flat()
}

const seriesListCache = new Map<string, Promise<SeriesSummary[]>>()
const instanceListCache = new Map<string, Promise<InstanceSummary[]>>()
const thumbnailCache = new Map<string, Promise<string | null>>()
const studyListCacheTtlMs = 10_000
let studyListCache: { promise: Promise<StudySummary[]>; expiresAt: number } | null = null
const viewerManifestEnabled = import.meta.env.VITE_VIEWER_MANIFEST_ENABLED !== 'false'
const viewerManifestCache = new Map<string, Promise<ViewerStudyManifest | null>>()
const studyRefreshStoragePrefix = 'vexa.dicomweb.refresh.v1'

async function getViewerStudyManifest(studyInstanceUid: string): Promise<ViewerStudyManifest | null> {
  if (!viewerManifestEnabled) return null
  const cached = viewerManifestCache.get(studyInstanceUid)
  if (cached) return cached

  const request = fetch(appUrl(`/api/viewer/studies/${encodeURIComponent(studyInstanceUid)}/manifest${getStudyRefreshQuery(studyInstanceUid)}`), {
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
        sopClassUid: instance.sopClassUid || (instance.metadata ? readValue(instance.metadata, tags.sopClassUid) : ''),
        sopInstanceUid: instance.sopInstanceUid,
        transferSyntaxUid: instance.transferSyntaxUid || (instance.metadata ? readValue(instance.metadata, tags.transferSyntaxUid) : ''),
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
      .sort(compareInstancesAnatomically)
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
    thumbnailCache.clear()
    invalidateFastThumbnailCache()
    return
  }

  markStudyRefresh(studyInstanceUid)
  studyListCache = null
  viewerManifestCache.delete(studyInstanceUid)
  seriesListCache.delete(studyInstanceUid)
  Array.from(instanceListCache.keys())
    .filter((key) => key.startsWith(`${studyInstanceUid}|`))
    .forEach((key) => instanceListCache.delete(key))
  Array.from(thumbnailCache.keys())
    .filter((key) => key.startsWith(`${studyInstanceUid}|`))
    .forEach((key) => thumbnailCache.delete(key))
  invalidateFastThumbnailCache(studyInstanceUid)
  invalidateRenderedPreviewCache()
}

/**
 * A successful STOW changes study/series metadata, but it must not revoke
 * thumbnail object URLs that are already mounted in the series browser.
 * Revoking those URLs here turns every existing thumbnail in the study black
 * until its React component happens to mount again.
 */
function invalidateDicomWebMetadataCachesAfterStore(studyInstanceUid: string) {
  markStudyRefresh(studyInstanceUid)
  studyListCache = null
  viewerManifestCache.delete(studyInstanceUid)
  seriesListCache.delete(studyInstanceUid)
  Array.from(instanceListCache.keys())
    .filter((key) => key.startsWith(`${studyInstanceUid}|`))
    .forEach((key) => instanceListCache.delete(key))
}

function getStudyRefreshQuery(studyInstanceUid: string) {
  if (typeof window === 'undefined') return ''
  try {
    const key = `${studyRefreshStoragePrefix}:${studyInstanceUid}`
    let token = window.sessionStorage.getItem(key)
    if (!token) {
      token = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      window.sessionStorage.setItem(key, token)
    }
    return token ? `?refresh=${encodeURIComponent(token)}` : ''
  } catch {
    return ''
  }
}

function markStudyRefresh(studyInstanceUid: string) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(`${studyRefreshStoragePrefix}:${studyInstanceUid}`, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  } catch {
    // A fresh in-memory cache is still enough when browser session storage is unavailable.
  }
}


export async function listInstances(series: SeriesSummary): Promise<InstanceSummary[]> {
  const cacheKey = `${series.studyInstanceUid}|${series.seriesInstanceUid}`
  const cachedInstances = instanceListCache.get(cacheKey)
  if (cachedInstances) {
    return filterSeriesInstances(await cachedInstances, series)
  }

  const instancesRequest = fetchInstances(series).catch((error) => {
    instanceListCache.delete(cacheKey)
    throw error
  })

  instanceListCache.set(cacheKey, instancesRequest)

  return filterSeriesInstances(await instancesRequest, series)
}

export async function refreshInstances(series: SeriesSummary): Promise<InstanceSummary[]> {
  const cacheKey = `${series.studyInstanceUid}|${series.seriesInstanceUid}`
  const previousRequest = instanceListCache.get(cacheKey)
  const instancesRequest = fetchInstances(series).catch((error) => {
    if (previousRequest) {
      instanceListCache.set(cacheKey, previousRequest)
    } else {
      instanceListCache.delete(cacheKey)
    }
    throw error
  })

  instanceListCache.set(cacheKey, instancesRequest)
  return filterSeriesInstances(await instancesRequest, series)
}

function filterSeriesInstances(instances: InstanceSummary[], series: SeriesSummary) {
  if (!series.instanceSopInstanceUids?.length) {
    return instances
  }

  const allowed = new Set(series.instanceSopInstanceUids)
  return instances.filter((instance) => allowed.has(instance.sopInstanceUid))
}

export function prefetchSeriesInstances(seriesList: SeriesSummary[], limit = 8) {
  if (import.meta.env.VITE_SERIES_INSTANCE_PREFETCH_ENABLED !== 'true') {
    return
  }
  seriesList.slice(0, limit).forEach((series, index) => {
    window.setTimeout(() => {
      void listInstances(series).catch(() => undefined)
    }, index * 80)
  })
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

  const mappedInstances = sourceDatasets
    .map((dataset, index) => {
      const sopInstanceUid = readValue(dataset, tags.sopInstanceUid)
      const fullMetadata = metadataBySopInstanceUid.get(sopInstanceUid) ?? dataset
      const imagePositionPatient = readNumberValues(fullMetadata, tags.imagePositionPatient)
      const imageOrientationPatient = readNumberValues(fullMetadata, tags.imageOrientationPatient)

      return {
        studyInstanceUid: series.studyInstanceUid,
        seriesInstanceUid: series.seriesInstanceUid,
        sopClassUid: readValue(fullMetadata, tags.sopClassUid),
        sopInstanceUid,
        transferSyntaxUid: readValue(fullMetadata, tags.transferSyntaxUid),
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

  return selectDominantStackGeometry(mappedInstances).sort(compareInstancesAnatomically)
}

function selectDominantStackGeometry(instances: InstanceSummary[]) {
  if (instances.length < 3) return instances

  const groups = new Map<string, InstanceSummary[]>()
  instances.forEach((instance) => {
    const orientation = instance.imageOrientationPatient
    const spacing = instance.metadata ? readNumberValues(instance.metadata, tags.pixelSpacing) : []
    const orientationKey = orientation?.length === 6
      ? orientation.map((value) => Number(value).toFixed(3)).join(',')
      : 'unknown'
    const spacingKey = spacing.length >= 2
      ? spacing.slice(0, 2).map((value) => Number(value).toFixed(4)).join(',')
      : 'unknown'
    const key = `${instance.rows}x${instance.columns}|${spacingKey}|${orientationKey}`
    const group = groups.get(key) ?? []
    group.push(instance)
    groups.set(key, group)
  })

  const dominantGroup = [...groups.values()].sort((a, b) => b.length - a.length)[0]
  if (!dominantGroup || dominantGroup.length < 2 || dominantGroup.length / instances.length < 0.8) {
    return instances
  }

  if (dominantGroup.length !== instances.length) {
    console.warn(`Excluded ${instances.length - dominantGroup.length} mixed-geometry image(s) from the diagnostic stack.`)
  }
  return dominantGroup
}

function compareInstancesAnatomically(a: InstanceSummary, b: InstanceSummary) {
  const aPosition = getPositionAlongSliceNormal(a)
  const bPosition = getPositionAlongSliceNormal(b)
  if (Number.isFinite(aPosition) && Number.isFinite(bPosition) && Math.abs(aPosition - bPosition) > 1e-5) {
    return aPosition - bPosition
  }
  return a.instanceNumber - b.instanceNumber
}

function getPositionAlongSliceNormal(instance: InstanceSummary) {
  const position = instance.imagePositionPatient
  const orientation = instance.imageOrientationPatient
  if (!position || position.length !== 3 || !orientation || orientation.length !== 6) {
    return Number.NaN
  }

  const row = orientation.slice(0, 3)
  const column = orientation.slice(3, 6)
  const normal = [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0],
  ]

  return position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2]
}

export async function listInstanceHeaders(series: SeriesSummary): Promise<InstanceSummary[]> {
  const datasets = await requestDicomJson(
    `studies/${series.studyInstanceUid}/series/${series.seriesInstanceUid}/instances`,
  )

  const instances = datasets
    .map((dataset, index) => ({
      studyInstanceUid: series.studyInstanceUid,
      seriesInstanceUid: series.seriesInstanceUid,
      sopClassUid: readValue(dataset, tags.sopClassUid),
      sopInstanceUid: readValue(dataset, tags.sopInstanceUid),
      transferSyntaxUid: readValue(dataset, tags.transferSyntaxUid),
      instanceNumber: Number(readValue(dataset, tags.instanceNumber)) || index + 1,
      numberOfFrames: Number(readValue(dataset, tags.numberOfFrames)) || 1,
      rows: Number(readValue(dataset, tags.rows)) || 0,
      columns: Number(readValue(dataset, tags.columns)) || 0,
    }))
    .sort((a, b) => a.instanceNumber - b.instanceNumber)

  return filterSeriesInstances(instances, series)
}

export function createWadoRsImageId(instance: InstanceSummary, frame = 1) {
  const wadoBase = endpoint(dicomWebConfig.wadoPrefix ?? '', '')

  return `wadors:${wadoBase}studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/frames/${frame}?v=${wadoFramePresentationVersion}`
}

export function createRenderedVideoUrl(instance: InstanceSummary) {
  const wadoBase = endpoint(dicomWebConfig.wadoPrefix ?? '', '')
  return `${wadoBase}studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/rendered?contentType=${encodeURIComponent('video/mp4')}`
}

export function createWadoRsImageIds(instances: InstanceSummary[]) {
  return instances.flatMap((instance) => {
    const frameCount = Math.max(1, instance.numberOfFrames || 1)
    const wadoBase = endpoint(dicomWebConfig.wadoPrefix ?? '', '')

    return Array.from({ length: frameCount }, (_, index) => (
      `wadors:${wadoBase}studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/frames/${index + 1}?v=${wadoFramePresentationVersion}`
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

export interface RenderedStackWarmOptions {
  radius?: number
  maxFrames?: number
  rows?: number
  columns?: number
  windowCenter?: number
  windowWidth?: number
  quality?: number
}

export type RenderedStackWarmResult = {
  ok: boolean
  enabled?: boolean
  reason?: string
  requested?: number
  warmed?: number
  failed?: number
  bytes?: number
  elapsedMs?: number
  quality?: number
  rows?: number | null
  columns?: number | null
  errors?: string[]
}

export type ProgressiveReadinessAuditOptions = {
  studyInstanceUid: string
  seriesInstanceUid?: string
  sampleLimit?: number
}

export type ProgressiveReadinessAudit = {
  ok: boolean
  generatedAt?: string
  studyInstanceUid?: string
  requestedSeriesInstanceUid?: string | null
  sampleLimit?: number
  summary?: {
    seriesAudited: number
    htj2kSeries: number
    rpclSeries: number
    byteRangeReadySeries: number
    safeToEnableGlobalByteRange: boolean
  }
  server?: {
    frameEndpointRangeSupport: boolean
    reason: string
    requiredForByteRange: string[]
  }
  cornerstone?: Record<string, unknown>
  series?: Array<{
    seriesInstanceUid: string
    modality: string
    seriesDescription: string
    instanceCount: number
    totalFrames: number
    rows: number
    columns: number
    sampledInstances: number
    readableSamples: number
    transferSyntaxes: Array<{
      uid: string
      name: string
      family: string
      count: number
      frames: number
      bytes: number
      contentType: string
      htj2k: boolean
      rpcl: boolean
    }>
    htj2k: {
      sampledInstances: number
      rpclSampledInstances: number
      allReadableSamplesAreRpcl: boolean
    }
    range: {
      frameEndpointSupportsHttpRange: boolean
      rangeRequestSafe: boolean
      reason: string
    }
    recommendation: {
      safeToEnableStackStreaming: boolean
      safeToEnableByteRange: boolean
      mode: string
      reason: string
    }
    sampleErrors: Array<{ sopInstanceUid: string; error: string }>
  }>
  error?: string
}

export type InstanceFrameReference = {
  instance: InstanceSummary
  frame: number
}

const renderedPreviewPresentationVersion = 'v5-physical-pixel-spacing'

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

export function createServerDecodedImageUrl(instance: InstanceSummary, frame = 1) {
  const wadoBase = endpoint(dicomWebConfig.wadoPrefix ?? '', '')
  return `${wadoBase}studies/${instance.studyInstanceUid}/series/${instance.seriesInstanceUid}/instances/${instance.sopInstanceUid}/raw?frame=${encodeURIComponent(frame)}&dtype=int16`
}

const renderedPreviewCache = new Map<string, Promise<Blob | null>>()
const renderedPreviewCacheMaxEntries = 512
const renderedStackWarmPending = new Map<string, Promise<RenderedStackWarmResult | null>>()
const renderedStackWarmRecent = new Map<string, number>()
const renderedStackWarmFramePending = new Set<string>()
const renderedStackWarmFrameRecent = new Map<string, number>()
const renderedStackWarmTtlMs = 15_000
const renderedStackWarmFrameTtlMs = 45_000
let renderedStackWarmUnavailable = false

export async function fetchRenderedPreviewDataUrl(
  instance: InstanceSummary,
  options: RenderedImageOptions = {},
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) {
    return null
  }

  const ck = [
    'rp',
    instance.studyInstanceUid,
    instance.seriesInstanceUid,
    instance.sopInstanceUid,
    `${options.rows ?? 0}x${options.columns ?? 0}`,
    `frame:${options.frame ?? 1}`,
    `wc:${options.windowCenter ?? 'auto'}`,
    `ww:${options.windowWidth ?? 'auto'}`,
    `q:${options.quality ?? 70}`,
    `pv:${renderedPreviewPresentationVersion}`,
  ].join('|')
  const c = renderedPreviewCache.get(ck)
  if (c) {
    const cachedBlob = await c
    return cachedBlob ? URL.createObjectURL(cachedBlob) : null
  }

  const p = _fetchRenderedPreviewBlob(instance, options, signal)
  rememberRenderedPreviewBlob(ck, p)
  p.then((blob) => {
    if (!blob || signal?.aborted) {
      renderedPreviewCache.delete(ck)
    }
  }).catch(() => renderedPreviewCache.delete(ck))
  const blob = await p
  return blob ? URL.createObjectURL(blob) : null
}

function rememberRenderedPreviewBlob(cacheKey: string, promise: Promise<Blob | null>) {
  renderedPreviewCache.delete(cacheKey)
  renderedPreviewCache.set(cacheKey, promise)
  while (renderedPreviewCache.size > renderedPreviewCacheMaxEntries) {
    const oldestKey = renderedPreviewCache.keys().next().value
    if (!oldestKey) break
    renderedPreviewCache.delete(oldestKey)
  }
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
  renderedStackWarmPending.clear()
  renderedStackWarmRecent.clear()
  renderedStackWarmFramePending.clear()
  renderedStackWarmFrameRecent.clear()
}

export function isRenderableImageInstance(instance: InstanceSummary) {
  const seriesDescription = readValue(instance.metadata ?? {}, tags.seriesDescription).trim().toLowerCase()
  const isProtocolObject = seriesDescription === 'patient protocol'
    || seriesDescription.startsWith('patient protocol ')

  return !isProtocolObject && instance.rows > 0 && instance.columns > 0
}

export function getInstanceFrameForImageIndex(instances: InstanceSummary[], imageIndex: number): InstanceFrameReference | null {
  if (!instances.length || imageIndex < 0) {
    return null
  }

  let remaining = Math.floor(imageIndex)
  for (const instance of instances) {
    const frameCount = Math.max(1, instance.numberOfFrames || 1)
    if (remaining < frameCount) {
      return { instance, frame: remaining + 1 }
    }
    remaining -= frameCount
  }

  const lastInstance = instances[instances.length - 1]
  return lastInstance
    ? { instance: lastInstance, frame: Math.max(1, lastInstance.numberOfFrames || 1) }
    : null
}

export async function warmRenderedStackCache(
  instances: InstanceSummary[],
  centerIndex: number,
  options: RenderedStackWarmOptions = {},
  signal?: AbortSignal,
): Promise<RenderedStackWarmResult | null> {
  if (
    signal?.aborted ||
    import.meta.env.VITE_STACK_RENDERED_WARM === 'false' ||
    renderedStackWarmUnavailable ||
    instances.length < 1
  ) {
    return null
  }

  const seed = instances.find(isRenderableImageInstance)
  if (!seed) {
    return null
  }

  const radius = clampInteger(options.radius ?? 5, 0, 32)
  const maxFrames = clampInteger(options.maxFrames ?? Math.min(radius * 2 + 1, 12), 1, 48)
  pruneRecentRenderedWarmEntries()
  pruneRecentRenderedWarmFrameEntries()
  const warmSignature = buildRenderedWarmSignature(seed.studyInstanceUid, seed.seriesInstanceUid, options)
  const frames = buildRenderedWarmFrames(instances, centerIndex, radius, maxFrames)
    .filter((frame) => shouldWarmRenderedFrame(warmSignature, frame))
  if (!frames.length) {
    return null
  }

  const body = {
    studyInstanceUid: seed.studyInstanceUid,
    seriesInstanceUid: seed.seriesInstanceUid,
    frames,
    centerIndex: clampInteger(centerIndex, 0, Number.MAX_SAFE_INTEGER),
    radius,
    maxFrames,
    rows: options.rows,
    columns: options.columns,
    windowCenter: options.windowCenter,
    windowWidth: options.windowWidth,
    quality: options.quality ?? 22,
  }
  const cacheKey = [
    body.studyInstanceUid,
    body.seriesInstanceUid,
    body.centerIndex,
    body.radius,
    body.maxFrames,
    `${body.rows ?? 0}x${body.columns ?? 0}`,
    `wc:${body.windowCenter ?? 'auto'}`,
    `ww:${body.windowWidth ?? 'auto'}`,
    `q:${body.quality}`,
  ].join('|')
  const now = Date.now()
  const recentAt = renderedStackWarmRecent.get(cacheKey)
  if (recentAt && now - recentAt < renderedStackWarmTtlMs) {
    return null
  }

  const pending = renderedStackWarmPending.get(cacheKey)
  if (pending) {
    return null
  }

  const frameKeys = frames.map((frame) => buildRenderedWarmFrameKey(warmSignature, frame))
  frameKeys.forEach((frameKey) => renderedStackWarmFramePending.add(frameKey))

  const request = fetch(appUrl('/api/rendered-stack/warm'), {
    method: 'POST',
    signal,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(async (response) => {
      if (response.status === 404) {
        renderedStackWarmUnavailable = true
        return null
      }
      if (!response.ok) {
        return null
      }
      const result = await response.json() as RenderedStackWarmResult
      if (result.enabled === false && String(result.reason || '').includes('route-not-found')) {
        renderedStackWarmUnavailable = true
      }
      const now = Date.now()
      renderedStackWarmRecent.set(cacheKey, Date.now())
      frameKeys.forEach((frameKey) => renderedStackWarmFrameRecent.set(frameKey, now))
      pruneRecentRenderedWarmEntries()
      pruneRecentRenderedWarmFrameEntries()
      return result
    })
    .catch(() => null)
    .finally(() => {
      renderedStackWarmPending.delete(cacheKey)
      frameKeys.forEach((frameKey) => renderedStackWarmFramePending.delete(frameKey))
    })

  renderedStackWarmPending.set(cacheKey, request)
  return request
}

export async function auditProgressiveReadiness(
  options: ProgressiveReadinessAuditOptions,
  signal?: AbortSignal,
): Promise<ProgressiveReadinessAudit> {
  const response = await fetch(appUrl('/api/viewer/progressive/audit'), {
    method: 'POST',
    signal,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      studyInstanceUid: options.studyInstanceUid,
      seriesInstanceUid: options.seriesInstanceUid,
      sampleLimit: options.sampleLimit,
    }),
  })
  const result = await response.json().catch(() => null) as ProgressiveReadinessAudit | null

  if (!response.ok) {
    throw new Error(result?.error || `Progressive readiness audit failed: ${response.status}`)
  }
  if (!result) {
    throw new Error('Progressive readiness audit returned an empty response.')
  }

  return result
}

function buildRenderedWarmFrames(instances: InstanceSummary[], centerIndex: number, radius: number, maxFrames: number) {
  return buildCenterOutIndexes(getImageFrameCount(instances), centerIndex, radius, maxFrames)
    .map((index) => getInstanceFrameForImageIndex(instances, index))
    .filter((frame): frame is InstanceFrameReference => Boolean(frame))
    .map((frame) => ({
      sopInstanceUid: frame.instance.sopInstanceUid,
      frame: frame.frame,
    }))
}

function buildRenderedWarmSignature(studyInstanceUid: string, seriesInstanceUid: string, options: RenderedStackWarmOptions) {
  return [
    studyInstanceUid,
    seriesInstanceUid,
    `${options.rows ?? 0}x${options.columns ?? 0}`,
    `wc:${options.windowCenter ?? 'auto'}`,
    `ww:${options.windowWidth ?? 'auto'}`,
    `q:${options.quality ?? 22}`,
  ].join('|')
}

function buildRenderedWarmFrameKey(signature: string, frame: { sopInstanceUid: string; frame: number }) {
  return `${signature}|${frame.sopInstanceUid}|frame:${frame.frame || 1}`
}

function shouldWarmRenderedFrame(signature: string, frame: { sopInstanceUid: string; frame: number }) {
  const frameKey = buildRenderedWarmFrameKey(signature, frame)
  if (renderedStackWarmFramePending.has(frameKey)) {
    return false
  }
  const recentAt = renderedStackWarmFrameRecent.get(frameKey)
  return !recentAt || Date.now() - recentAt >= renderedStackWarmFrameTtlMs
}

function buildCenterOutIndexes(length: number, centerIndex: number, radius: number, maxItems: number) {
  const indexes: number[] = []
  const center = clampInteger(centerIndex, 0, Math.max(0, length - 1))
  const add = (index: number) => {
    if (index >= 0 && index < length && !indexes.includes(index) && indexes.length < maxItems) {
      indexes.push(index)
    }
  }

  add(center)
  for (let offset = 1; offset <= radius && indexes.length < maxItems; offset += 1) {
    add(center + offset)
    add(center - offset)
  }
  return indexes
}

function getImageFrameCount(instances: InstanceSummary[]) {
  return instances.reduce((total, instance) => total + Math.max(1, instance.numberOfFrames || 1), 0)
}

function clampInteger(value: number, minimum: number, maximum: number) {
  const parsed = Number.isFinite(value) ? Math.floor(value) : minimum
  return Math.min(maximum, Math.max(minimum, parsed))
}

function pruneRecentRenderedWarmEntries() {
  const cutoff = Date.now() - renderedStackWarmTtlMs
  for (const [key, timestamp] of renderedStackWarmRecent) {
    if (timestamp < cutoff || renderedStackWarmRecent.size > 80) {
      renderedStackWarmRecent.delete(key)
    }
  }
}

function pruneRecentRenderedWarmFrameEntries() {
  const cutoff = Date.now() - renderedStackWarmFrameTtlMs
  for (const [key, timestamp] of renderedStackWarmFrameRecent) {
    if (timestamp < cutoff || renderedStackWarmFrameRecent.size > 1_500) {
      renderedStackWarmFrameRecent.delete(key)
    }
  }
}

const videoSopClassUids = new Set([
  '1.2.840.10008.5.1.4.1.1.77.1.1.1',
  '1.2.840.10008.5.1.4.1.1.77.1.2.1',
  '1.2.840.10008.5.1.4.1.1.77.1.4.1',
])

const videoTransferSyntaxUids = new Set([
  '1.2.840.10008.1.2.4.100',
  '1.2.840.10008.1.2.4.100.1',
  '1.2.840.10008.1.2.4.101',
  '1.2.840.10008.1.2.4.101.1',
  '1.2.840.10008.1.2.4.102',
  '1.2.840.10008.1.2.4.102.1',
  '1.2.840.10008.1.2.4.103',
  '1.2.840.10008.1.2.4.103.1',
  '1.2.840.10008.1.2.4.104',
  '1.2.840.10008.1.2.4.104.1',
  '1.2.840.10008.1.2.4.105',
  '1.2.840.10008.1.2.4.105.1',
  '1.2.840.10008.1.2.4.106',
  '1.2.840.10008.1.2.4.106.1',
  '1.2.840.10008.1.2.4.107',
  '1.2.840.10008.1.2.4.108',
])

export function isVideoInstance(instance: InstanceSummary) {
  const sopClassUid = instance.sopClassUid || readValue(instance.metadata ?? {}, tags.sopClassUid)
  const transferSyntaxUid = instance.transferSyntaxUid || readValue(instance.metadata ?? {}, tags.transferSyntaxUid)

  return videoSopClassUids.has(sopClassUid) || videoTransferSyntaxUids.has(transferSyntaxUid)
}

export function isSegmentationInstance(instance: InstanceSummary) {
  const sopClassUid = instance.sopClassUid || readValue(instance.metadata ?? {}, tags.sopClassUid)
  return sopClassUid === '1.2.840.10008.5.1.4.1.1.66.4'
}

const imageSeriesModalities = new Set(['CT', 'MR', 'PT', 'NM', 'US', 'XA', 'XRF', 'RF', 'DX', 'CR', 'PX', 'MG', 'SC', 'OP', 'OPT'])

export function isImageSeriesCandidate(series: SeriesSummary) {
  const description = series.seriesDescription?.trim().toLowerCase() ?? ''
  const isProtocolObject = description === 'patient protocol'
    || description.startsWith('patient protocol ')

  return series.instanceCount > 0
    && !isProtocolObject
    && imageSeriesModalities.has(series.modality?.toUpperCase() ?? '')
}

export async function filterRenderableImageSeries(seriesList: SeriesSummary[]) {
  const results = await Promise.all(seriesList
    .filter(isImageSeriesCandidate)
    .map(async (series) => {
      try {
        return await hasRenderableImages(series) ? series : null
      } catch {
        return null
      }
    }))

  return results.filter((series): series is SeriesSummary => Boolean(series))
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
  let metadataCandidates = instances
    .map((instance) => instance.metadata)
    .filter((metadata): metadata is DicomJsonDataset => Boolean(metadata))

  if (!metadataCandidates.some(hasStructuredReportContent)) {
    metadataCandidates = await fetchStructuredReportMetadata(series, instances, metadataCandidates)
  }

  const metadata = metadataCandidates.find(hasStructuredReportContent) ?? metadataCandidates[0]
  if (!metadata) {
    return null
  }

  const title = readConceptName(metadata) || series.seriesDescription || 'Structured Report'
  const contentItems = metadata[tags.contentSequence]?.Value ?? []
  const items = contentItems
    .map((item) => readStructuredReportItem(item as DicomJsonDataset))
    .filter((item): item is StructuredReportItem => Boolean(item))

  return {
    title,
    items: items.length ? items : buildStructuredReportFallbackItems(metadata, series),
  }
}

function hasStructuredReportContent(metadata: DicomJsonDataset) {
  return Boolean(metadata[tags.contentSequence]?.Value?.length)
}

function buildStructuredReportFallbackItems(metadata: DicomJsonDataset, series: SeriesSummary): StructuredReportItem[] {
  const rows: Array<[string, string]> = [
    ['Patient', readValue(metadata, tags.patientName)],
    ['Patient ID', readValue(metadata, tags.patientId)],
    ['Study Date', readValue(metadata, tags.studyDate) || series.studyDate || ''],
    ['Accession', readValue(metadata, tags.accessionNumber)],
    ['Modality', readValue(metadata, tags.modality) || series.modality],
    ['Study', readValue(metadata, tags.studyDescription)],
    ['Series', readValue(metadata, tags.seriesDescription) || series.seriesDescription],
    ['Series Number', readValue(metadata, tags.seriesNumber) || series.seriesNumber],
    ['SOP Class UID', readValue(metadata, tags.sopClassUid)],
    ['SOP Instance UID', readValue(metadata, tags.sopInstanceUid)],
  ]

  const children = rows
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => ({ name, value, children: [] }))

  return [
    {
      name: 'DICOM SR Metadata',
      value: children.length
        ? 'Structured content is not expanded by the current PACS metadata response.'
        : 'Structured content is not available in the current PACS metadata response.',
      children,
    },
  ]
}

async function fetchStructuredReportMetadata(
  series: SeriesSummary,
  instances: InstanceSummary[],
  fallback: DicomJsonDataset[],
) {
  const seriesPath = `studies/${series.studyInstanceUid}/series/${series.seriesInstanceUid}`
  try {
    const seriesMetadata = await requestDicomJson(`${seriesPath}/metadata`, dicomWebConfig.wadoPrefix)
    if (seriesMetadata.some(hasStructuredReportContent)) {
      return seriesMetadata
    }
    if (seriesMetadata.length) {
      fallback = seriesMetadata
    }
  } catch {
    // Some DICOMweb servers only expose metadata at instance level.
  }

  for (const instance of instances) {
    try {
      const instanceMetadata = await requestDicomJson(
        `${seriesPath}/instances/${instance.sopInstanceUid}/metadata`,
        dicomWebConfig.wadoPrefix,
      )
      if (instanceMetadata.some(hasStructuredReportContent)) {
        return instanceMetadata
      }
      if (instanceMetadata.length) {
        fallback = instanceMetadata
      }
    } catch {
      // Continue to the next SR instance and retain the best metadata found.
    }
  }

  return fallback
}

export function registerWadoRsMetadata(instances: InstanceSummary[]) {
  instances.forEach((instance) => {
    if (!instance.metadata) {
      return
    }

    const imageIds = createWadoRsImageIds([instance])
    const metadata = normalizeWadoRsMetadata(cloneDicomJsonDataset(instance.metadata))
    if (instance.transferSyntaxUid) {
      metadata[tags.transferSyntaxUid] = { vr: 'UI', Value: [instance.transferSyntaxUid] }
    }

    if (imageIds[0]) {
      void Promise.resolve(metadataUtilities.addDicomWebInstance(imageIds[0], metadata))
        .catch((error) => console.warn('Unable to add Cornerstone naturalized metadata.', error))
    }

    // Keep the WADO-RS manager populated during the 5.x transition because
    // the DICOM image loader still exposes its compatibility provider.
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

  const conceptValueSequence = dataset[tags.conceptCodeSequence]?.Value
  if (Array.isArray(conceptValueSequence)) {
    const conceptValue = readValue(conceptValueSequence[0] as DicomJsonDataset, tags.codeMeaning)
    if (conceptValue) {
      return conceptValue
    }
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
const nonImageSeriesModalities = new Set(['SR', 'PR', 'KO', 'SEG', 'RTSTRUCT', 'RTPLAN', 'RTDOSE', 'RTRECORD', 'DOC'])

export function canRenderSeriesThumbnail(series: SeriesSummary) {
  const modality = series.modality?.toUpperCase() ?? ''
  return series.instanceCount > 0 && !nonImageSeriesModalities.has(modality)
}

export async function generateFirstFrameThumbnail(series: SeriesSummary): Promise<string | null> {
  if (!canRenderSeriesThumbnail(series)) {
    return null
  }

  const cacheKey = `fast|${series.studyInstanceUid}|${getSeriesPresentationId(series)}`
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
      const candidate = await fetchFastThumbnailCandidate(series)
      if (!candidate?.instance.sopInstanceUid) return null

      const renderedUrl = await fetchRenderedPreviewDataUrl(candidate.instance, {
        rows: 160,
        columns: 160,
        frame: candidate.frame,
        quality: 60,
        ...getThumbnailWindowing(candidate.instance.metadata),
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

type FastThumbnailSeed = ThumbnailCandidate | null
const firstInstanceCache = new Map<string, Promise<FastThumbnailSeed>>()

async function fetchFastThumbnailCandidate(series: SeriesSummary) {
  const cacheKey = `fi|${series.studyInstanceUid}|${getSeriesPresentationId(series)}`
  const cached = firstInstanceCache.get(cacheKey)
  if (cached) return cached

  if (series.instanceSopInstanceUids?.length) {
    const promise = listInstances(series)
      .then((instances) => createThumbnailCandidate(instances.filter(isRenderableImageInstance), series))
    firstInstanceCache.set(cacheKey, promise)
    promise.catch(() => { firstInstanceCache.delete(cacheKey) })
    return promise
  }

  const seededInstances = instanceListCache.get(`${series.studyInstanceUid}|${series.seriesInstanceUid}`)
  const promise = seededInstances
    ? seededInstances.then((instances) => createThumbnailCandidate(instances.filter(isRenderableImageInstance), series))
    : fetchFastThumbnailCandidateUncached(series)
  firstInstanceCache.set(cacheKey, promise)
  promise.then(
    () => undefined,
    () => { firstInstanceCache.delete(cacheKey) },
  )
  return promise
}

async function fetchFastThumbnailCandidateUncached(series: SeriesSummary): Promise<FastThumbnailSeed> {
  if (isCrossSectionalThumbnailSeries(series) && series.instanceCount > 8) {
    const instances = await listInstances(series)
    return createThumbnailCandidate(instances.filter(isRenderableImageInstance), series)
  }

  const datasets = await requestDicomJson(
    `studies/${series.studyInstanceUid}/series/${series.seriesInstanceUid}/instances?limit=5`,
  )
  if (!datasets?.length) return null

  for (const dataset of datasets) {
    const sopInstanceUid = readValue(dataset, tags.sopInstanceUid)
    const rows = Number(readValue(dataset, tags.rows)) || 0
    const columns = Number(readValue(dataset, tags.columns)) || 0
    if (!sopInstanceUid) continue

    if (rows > 0 && columns > 0) {
      return {
        instance: {
          studyInstanceUid: series.studyInstanceUid,
          seriesInstanceUid: series.seriesInstanceUid,
          sopInstanceUid,
          instanceNumber: Number(readValue(dataset, tags.instanceNumber)) || 1,
          rows,
          columns,
          numberOfFrames: Number(readValue(dataset, tags.numberOfFrames)) || 1,
          metadata: dataset,
        },
        frame: 1,
      }
    }
  }

  return null
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
  if (!canRenderSeriesThumbnail(series)) {
    return null
  }

  const cacheKey = `${series.studyInstanceUid}|${getSeriesPresentationId(series)}|${size}`
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
    const candidate = createThumbnailCandidate(renderableInstances, series)
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
    ...(Number.isFinite(windowCenter) && windowCenter !== 0 ? { windowCenter } : {}),
    ...(Number.isFinite(windowWidth) && windowWidth > 0 ? { windowWidth } : {}),
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

function createThumbnailCandidate(instances: InstanceSummary[], series?: SeriesSummary): ThumbnailCandidate | null {
  const totalFrames = instances.reduce((sum, instance) => sum + Math.max(1, instance.numberOfFrames || 1), 0)
  if (!totalFrames) {
    return null
  }

  const representativeRatio = isCrossSectionalThumbnailSeries(series) ? 0.58 : 0.5
  let remaining = totalFrames > 20 ? Math.floor((totalFrames - 1) * representativeRatio) : 0
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

function isCrossSectionalThumbnailSeries(series?: SeriesSummary) {
  const modality = series?.modality?.toUpperCase() ?? ''
  return modality === 'CT' || modality === 'MR'
}
