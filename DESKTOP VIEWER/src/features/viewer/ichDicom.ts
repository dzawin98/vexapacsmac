import { metaData } from '@cornerstonejs/core'
import type { SeriesSummary, StudySummary } from '../dicomweb/types'
import { stowDicomInstances } from '../dicomweb/client'
import {
  getIchVolumeDicomExportData,
  getIchVolumeSegmentStats,
  restoreIchVolumeFromReferencedSlices,
} from './cornerstone/ichSegmentation'

type DcmjsModule = {
  data: {
    DicomMessage: {
      readFile: (buffer: ArrayBuffer) => { dict: Record<string, unknown>; meta: Record<string, unknown> }
    }
    DicomMetaDictionary: {
      uid: () => string
      naturalizeDataset: (dataset: Record<string, unknown>) => Record<string, unknown>
      namifyDataset: (dataset: Record<string, unknown>) => Record<string, unknown>
      denaturalizeDataset: (dataset: Record<string, unknown>) => Record<string, unknown>
    }
    DicomDict: new (meta: Record<string, unknown>) => {
      dict: Record<string, unknown>
      write: () => ArrayBuffer
    }
  }
}

export type SavedIchDicomSeries = {
  segmentation: SeriesSummary
  measurementReport: SeriesSummary
  segmentationSopInstanceUid: string
  measurementReportSopInstanceUid: string
}

export type IchSegmentationDescriptor = {
  studyInstanceUid: string
  seriesInstanceUid: string
  sopInstanceUid: string
  referencedSeriesInstanceUid: string
  contentDescription: string
}

export type IchMovieFrames = {
  width: number
  height: number
  fps: number
  frames: Uint8Array[]
}

const segmentationStorage = '1.2.840.10008.5.1.4.1.1.66.4'
const comprehensive3dSrStorage = '1.2.840.10008.5.1.4.1.1.88.34'
const multiframeTrueColorSecondaryCaptureStorage = '1.2.840.10008.5.1.4.1.1.7.4'
const explicitVrLittleEndian = '1.2.840.10008.1.2.1'
const implementationClassUid = '1.2.826.0.1.3680043.10.5432.26.2'

const ichSegmentMetadata = {
  SegmentLabel: 'Intracerebral Hemorrhage',
  SegmentDescription: 'Semi-automatic intracerebral hemorrhage segmentation',
  SegmentedPropertyCategoryCodeSequence: {
    CodeValue: '49755003',
    CodingSchemeDesignator: 'SCT',
    CodeMeaning: 'Morphologically Abnormal Structure',
  },
  SegmentedPropertyTypeCodeSequence: {
    CodeValue: '50960005',
    CodingSchemeDesignator: 'SCT',
    CodeMeaning: 'Hemorrhage',
  },
  SegmentAlgorithmType: 'SEMIAUTOMATIC',
  SegmentAlgorithmName: 'VEXA Smart ICH',
  RecommendedDisplayCIELabValue: [34891, 53480, 36533],
}

export async function saveIchSegmentationAsDicom({
  study,
  sourceSeries,
  segmentationId,
  referencedVolumeId,
  seriesDescription,
}: {
  study: StudySummary
  sourceSeries: SeriesSummary
  segmentationId: string
  referencedVolumeId: string
  seriesDescription: string
}): Promise<SavedIchDicomSeries> {
  const stats = getIchVolumeSegmentStats(segmentationId, referencedVolumeId)
  if (stats.voxelCount <= 0 || stats.volumeMl === null) {
    throw new Error('The ICH segmentation mask is empty.')
  }

  const dcmjs = await importDcmjs()
  const { adaptersSEG } = await import('@cornerstonejs/adapters')
  const exportData = getIchVolumeDicomExportData(segmentationId, referencedVolumeId)
  const labelmap3D = adaptersSEG.Cornerstone3D.Segmentation.generateLabelMaps2DFrom3D({
    scalarData: exportData.scalarData,
    dimensions: exportData.dimensions,
    metadata: [undefined, ichSegmentMetadata],
  })
  const segmentation = adaptersSEG.Cornerstone3D.Segmentation.generateSegmentation(
    exportData.sourceImages,
    labelmap3D,
    metaData,
    {
      includeSliceSpacing: true,
      rleEncode: false,
      Manufacturer: 'VEXA',
      ManufacturerModelName: 'VEXAPACS',
      SoftwareVersions: '1.26.1',
      SeriesDescription: seriesDescription,
    },
  ) as { dataset: Record<string, unknown> }

  const segmentationSopInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const segmentationSeriesInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const measurementReportSopInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const measurementReportSeriesInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const date = dicomDate()
  const time = dicomTime()

  Object.assign(segmentation.dataset, {
    SOPClassUID: segmentationStorage,
    SOPInstanceUID: segmentationSopInstanceUid,
    StudyInstanceUID: study.studyInstanceUid,
    SeriesInstanceUID: segmentationSeriesInstanceUid,
    Modality: 'SEG',
    SeriesNumber: nextSeriesNumber(),
    InstanceNumber: 1,
    SeriesDate: date,
    SeriesTime: time,
    ContentDate: date,
    ContentTime: time,
    ContentLabel: 'ICH_SEG',
    ContentDescription: `ICH segmentation; volume ${stats.volumeMl.toFixed(2)} ml`,
    SeriesDescription: seriesDescription,
    Manufacturer: 'VEXA',
    ManufacturerModelName: 'VEXAPACS',
    SoftwareVersions: '1.26.1',
    ClinicalTrialSeriesID: 'ICH',
    ClinicalTrialTimePointID: '1',
  })

  const measurementReportDataset = buildIchMeasurementReport({
    sourceDataset: segmentation.dataset,
    study,
    sourceSeries,
    segmentationSeriesInstanceUid,
    segmentationSopInstanceUid,
    sopInstanceUid: measurementReportSopInstanceUid,
    seriesInstanceUid: measurementReportSeriesInstanceUid,
    volumeMl: stats.volumeMl,
    date,
    time,
    seriesDescription: `${seriesDescription} Volume Measurement`.slice(0, 64),
  })

  await stowDicomInstances(study.studyInstanceUid, [
    writeDicomDataset(dcmjs, segmentationStorage, segmentationSopInstanceUid, segmentation.dataset),
    writeDicomDataset(dcmjs, comprehensive3dSrStorage, measurementReportSopInstanceUid, measurementReportDataset),
  ])

  const savedSegmentation = toSavedSeries(
    study.studyInstanceUid,
    segmentationSeriesInstanceUid,
    'SEG',
    seriesDescription,
  )
  const savedReport = toSavedSeries(
    study.studyInstanceUid,
    measurementReportSeriesInstanceUid,
    'SR',
    `${seriesDescription} Volume Measurement`.slice(0, 64),
  )
  notifySeriesSaved(savedSegmentation)
  notifySeriesSaved(savedReport)

  return {
    segmentation: savedSegmentation,
    measurementReport: savedReport,
    segmentationSopInstanceUid,
    measurementReportSopInstanceUid,
  }
}

export async function importIchSegmentationFromDicom({
  arrayBuffer,
  segmentationId,
  referencedVolumeId,
}: {
  arrayBuffer: ArrayBuffer
  segmentationId: string
  referencedVolumeId: string
}) {
  const { adaptersSEG } = await import('@cornerstonejs/adapters')
  const exportData = getIchVolumeDicomExportData(segmentationId, referencedVolumeId)
  const result = await adaptersSEG.Cornerstone3D.Segmentation.createFromDICOMSegBuffer(
    exportData.sourceImageIds,
    arrayBuffer,
    { metadataProvider: metaData, tolerance: 1e-3 },
  )
  const labelmapGroup = Array.isArray(result.labelMapImages?.[0])
    ? result.labelMapImages[0]
    : result.labelMapImages
  if (!Array.isArray(labelmapGroup) || labelmapGroup.length === 0) {
    throw new Error('The DICOM SEG object does not contain a readable labelmap.')
  }

  const referencedSlices = labelmapGroup.map((image: { getPixelData?: () => ArrayLike<number> }) => image.getPixelData?.() ?? null)
  return restoreIchVolumeFromReferencedSlices(segmentationId, referencedVolumeId, referencedSlices)
}

export async function readIchSegmentationDescriptor(arrayBuffer: ArrayBuffer): Promise<IchSegmentationDescriptor> {
  const dcmjs = await importDcmjs()
  const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer)
  const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict)
  const referencedSeries = firstSequenceItem(dataset.ReferencedSeriesSequence)

  return {
    studyInstanceUid: stringValue(dataset.StudyInstanceUID),
    seriesInstanceUid: stringValue(dataset.SeriesInstanceUID),
    sopInstanceUid: stringValue(dataset.SOPInstanceUID),
    referencedSeriesInstanceUid: stringValue(referencedSeries?.SeriesInstanceUID),
    contentDescription: stringValue(dataset.ContentDescription),
  }
}

export async function saveIchMovieAsDicom({
  study,
  sourceSeries,
  movie,
  direction,
}: {
  study: StudySummary
  sourceSeries: SeriesSummary
  movie: IchMovieFrames
  direction: string
}) {
  validateMovieFrames(movie)
  const dcmjs = await importDcmjs()
  const sopInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const seriesInstanceUid = dcmjs.data.DicomMetaDictionary.uid()
  const pixelData = joinRgbFrames(movie)
  const date = dicomDate()
  const time = dicomTime()
  const dataset: Record<string, unknown> = {
    SpecificCharacterSet: 'ISO_IR 192',
    SOPClassUID: multiframeTrueColorSecondaryCaptureStorage,
    SOPInstanceUID: sopInstanceUid,
    StudyInstanceUID: study.studyInstanceUid,
    SeriesInstanceUID: seriesInstanceUid,
    Modality: 'SC',
    PatientName: study.patientName || 'Unknown',
    PatientID: study.patientId || '',
    StudyDate: study.studyDate || date,
    StudyTime: time,
    StudyDescription: study.studyDescription || '',
    AccessionNumber: study.accessionNumber || '',
    SeriesNumber: nextSeriesNumber(),
    InstanceNumber: 1,
    SeriesDate: date,
    SeriesTime: time,
    ContentDate: date,
    ContentTime: time,
    SeriesDescription: 'VEXA ICH 3D Cine',
    Manufacturer: 'VEXA',
    ManufacturerModelName: 'VEXAPACS',
    SoftwareVersions: '1.26.2',
    ImageType: ['DERIVED', 'SECONDARY', 'CINE', 'ICH'],
    ConversionType: 'WSD',
    DerivationDescription: `3D ICH segmentation orbit; direction ${direction}; ${movie.fps} fps`,
    SamplesPerPixel: 3,
    PhotometricInterpretation: 'RGB',
    PlanarConfiguration: 0,
    Rows: movie.height,
    Columns: movie.width,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    PixelAspectRatio: [1, 1],
    NumberOfFrames: movie.frames.length,
    FrameTime: Number((1000 / movie.fps).toFixed(4)),
    CineRate: movie.fps,
    RecommendedDisplayFrameRate: movie.fps,
    StartTrim: 1,
    StopTrim: movie.frames.length,
    FrameIncrementPointer: ['00181063'],
    BurnedInAnnotation: 'NO',
    LossyImageCompression: '00',
    PresentationLUTShape: 'IDENTITY',
    ReferencedSeriesSequence: [{ SeriesInstanceUID: sourceSeries.seriesInstanceUid }],
    PixelData: [pixelData.buffer],
    _vrMap: { PixelData: 'OB' },
  }

  await stowDicomInstances(study.studyInstanceUid, [
    writeDicomDataset(dcmjs, multiframeTrueColorSecondaryCaptureStorage, sopInstanceUid, dataset),
  ])
  const savedSeries = toSavedSeries(study.studyInstanceUid, seriesInstanceUid, 'SC', 'VEXA ICH 3D Cine')
  notifySeriesSaved(savedSeries)
  return savedSeries
}

export async function exportIchMovieFile(movie: IchMovieFrames, fileBaseName = 'VEXA-ICH-3D-Cine') {
  validateMovieFrames(movie)
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support video export.')
  }

  const mimeType = [
    'video/mp4;codecs=avc1.42E01E',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ].find((candidate) => MediaRecorder.isTypeSupported(candidate))
  if (!mimeType) {
    throw new Error('No compatible video codec is available in this browser.')
  }

  const canvas = document.createElement('canvas')
  canvas.width = movie.width
  canvas.height = movie.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    throw new Error('The canvas encoder is unavailable.')
  }

  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: movie.width >= 512 ? 6_000_000 : 3_500_000,
  })
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.addEventListener('error', () => reject(new Error('Video encoding failed.')), { once: true })
  })

  recorder.start()
  const frameDelay = Math.max(1, Math.round(1000 / movie.fps))
  for (const frame of movie.frames) {
    context.putImageData(rgbFrameToImageData(frame, movie.width, movie.height), 0, 0)
    track.requestFrame?.()
    await delay(frameDelay)
  }
  recorder.stop()
  await stopped
  stream.getTracks().forEach((streamTrack) => streamTrack.stop())

  const blob = new Blob(chunks, { type: mimeType })
  const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${fileBaseName}.${extension}`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
  return { extension, size: blob.size }
}

function buildIchMeasurementReport({
  sourceDataset,
  study,
  sourceSeries,
  segmentationSeriesInstanceUid,
  segmentationSopInstanceUid,
  sopInstanceUid,
  seriesInstanceUid,
  volumeMl,
  date,
  time,
  seriesDescription,
}: {
  sourceDataset: Record<string, unknown>
  study: StudySummary
  sourceSeries: SeriesSummary
  segmentationSeriesInstanceUid: string
  segmentationSopInstanceUid: string
  sopInstanceUid: string
  seriesInstanceUid: string
  volumeMl: number
  date: string
  time: string
  seriesDescription: string
}) {
  return {
    SpecificCharacterSet: 'ISO_IR 192',
    SOPClassUID: comprehensive3dSrStorage,
    SOPInstanceUID: sopInstanceUid,
    StudyInstanceUID: study.studyInstanceUid,
    SeriesInstanceUID: seriesInstanceUid,
    Modality: 'SR',
    PatientName: sourceDataset.PatientName ?? study.patientName ?? 'Unknown',
    PatientID: sourceDataset.PatientID ?? study.patientId ?? '',
    PatientBirthDate: sourceDataset.PatientBirthDate ?? '',
    PatientSex: sourceDataset.PatientSex ?? '',
    StudyDate: sourceDataset.StudyDate ?? study.studyDate ?? date,
    StudyTime: sourceDataset.StudyTime ?? time,
    StudyDescription: sourceDataset.StudyDescription ?? study.studyDescription ?? '',
    AccessionNumber: sourceDataset.AccessionNumber ?? study.accessionNumber ?? '',
    StudyID: sourceDataset.StudyID ?? '',
    ReferringPhysicianName: sourceDataset.ReferringPhysicianName ?? '',
    SeriesNumber: nextSeriesNumber(),
    InstanceNumber: 1,
    SeriesDate: date,
    SeriesTime: time,
    ContentDate: date,
    ContentTime: time,
    SeriesDescription: seriesDescription,
    Manufacturer: 'VEXA',
    ManufacturerModelName: 'VEXAPACS',
    SoftwareVersions: '1.26.1',
    CompletionFlag: 'COMPLETE',
    VerificationFlag: 'UNVERIFIED',
    PreliminaryFlag: 'FINAL',
    ValueType: 'CONTAINER',
    ContinuityOfContent: 'SEPARATE',
    ConceptNameCodeSequence: [code('126000', 'DCM', 'Imaging Measurement Report')],
    ContentTemplateSequence: [{ MappingResource: 'DCMR', TemplateIdentifier: '1500' }],
    CurrentRequestedProcedureEvidenceSequence: [{
      StudyInstanceUID: study.studyInstanceUid,
      ReferencedSeriesSequence: [{
        SeriesInstanceUID: sourceSeries.seriesInstanceUid,
      }, {
        SeriesInstanceUID: segmentationSeriesInstanceUid,
        ReferencedSOPSequence: [{
          ReferencedSOPClassUID: segmentationStorage,
          ReferencedSOPInstanceUID: segmentationSopInstanceUid,
        }],
      }],
    }],
    ContentSequence: [{
      RelationshipType: 'CONTAINS',
      ValueType: 'CONTAINER',
      ContinuityOfContent: 'SEPARATE',
      ConceptNameCodeSequence: [code('125007', 'DCM', 'Measurement Group')],
      ContentSequence: [{
        RelationshipType: 'CONTAINS',
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [code('121071', 'DCM', 'Finding')],
        TextValue: 'Intracerebral Hemorrhage',
      }, {
        RelationshipType: 'CONTAINS',
        ValueType: 'NUM',
        ConceptNameCodeSequence: [code('118565006', 'SCT', 'Volume')],
        MeasuredValueSequence: [{
          NumericValue: volumeMl.toFixed(3),
          MeasurementUnitsCodeSequence: [code('mL', 'UCUM', 'milliliter')],
        }],
      }, {
        RelationshipType: 'CONTAINS',
        ValueType: 'IMAGE',
        ConceptNameCodeSequence: [code('121191', 'DCM', 'Referenced Segment')],
        ReferencedSOPSequence: [{
          ReferencedSOPClassUID: segmentationStorage,
          ReferencedSOPInstanceUID: segmentationSopInstanceUid,
          ReferencedSegmentNumber: 1,
        }],
      }],
    }],
  }
}

function code(codeValue: string, codingSchemeDesignator: string, codeMeaning: string) {
  return { CodeValue: codeValue, CodingSchemeDesignator: codingSchemeDesignator, CodeMeaning: codeMeaning }
}

function validateMovieFrames(movie: IchMovieFrames) {
  const frameLength = movie.width * movie.height * 3
  if (!Number.isInteger(movie.width) || !Number.isInteger(movie.height) || movie.width < 64 || movie.height < 64) {
    throw new Error('The cine resolution is invalid.')
  }
  if (!Number.isFinite(movie.fps) || movie.fps < 1 || movie.fps > 60) {
    throw new Error('The cine frame rate is invalid.')
  }
  if (!movie.frames.length || movie.frames.some((frame) => frame.length !== frameLength)) {
    throw new Error('The ICH cine frames are incomplete.')
  }
}

function joinRgbFrames(movie: IchMovieFrames) {
  const frameLength = movie.width * movie.height * 3
  const payloadLength = frameLength * movie.frames.length
  const output = new Uint8Array(payloadLength + (payloadLength % 2))
  movie.frames.forEach((frame, index) => output.set(frame, index * frameLength))
  return output
}

function rgbFrameToImageData(frame: Uint8Array, width: number, height: number) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let source = 0, target = 0; source < frame.length; source += 3, target += 4) {
    rgba[target] = frame[source]
    rgba[target + 1] = frame[source + 1]
    rgba[target + 2] = frame[source + 2]
    rgba[target + 3] = 255
  }
  return new ImageData(rgba, width, height)
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}

function firstSequenceItem(value: unknown) {
  return Array.isArray(value) ? value[0] as Record<string, unknown> | undefined : value as Record<string, unknown> | undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function dicomDate() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function dicomTime() {
  return new Date().toTimeString().slice(0, 8).replaceAll(':', '')
}

function nextSeriesNumber() {
  return Math.floor(Date.now() / 1000) % 100000
}

function writeDicomDataset(
  dcmjs: DcmjsModule,
  sopClassUid: string,
  sopInstanceUid: string,
  dataset: Record<string, unknown>,
) {
  const meta = dcmjs.data.DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    TransferSyntaxUID: explicitVrLittleEndian,
    MediaStorageSOPClassUID: sopClassUid,
    MediaStorageSOPInstanceUID: sopInstanceUid,
    ImplementationClassUID: implementationClassUid,
    ImplementationVersionName: 'VEXA_1_26_2',
  })
  const dicomDict = new dcmjs.data.DicomDict(meta)
  dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
  return dicomDict.write()
}

function toSavedSeries(studyInstanceUid: string, seriesInstanceUid: string, modality: string, seriesDescription: string): SeriesSummary {
  return {
    studyInstanceUid,
    seriesInstanceUid,
    modality,
    seriesDescription,
    seriesNumber: String(nextSeriesNumber()),
    instanceCount: 1,
  }
}

function notifySeriesSaved(series: SeriesSummary) {
  window.dispatchEvent(new CustomEvent('vexa-viewer-series-saved', {
    detail: { studyInstanceUid: series.studyInstanceUid, series },
  }))
}

async function importDcmjs() {
  return await import('dcmjs') as unknown as DcmjsModule
}
