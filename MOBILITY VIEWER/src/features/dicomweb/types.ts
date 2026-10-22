export type DicomJsonElement = {
  vr: string
  Value?: unknown[]
  BulkDataURI?: string
  InlineBinary?: string
}

export type DicomJsonDataset = Record<string, DicomJsonElement>

export type StudySummary = {
  studyInstanceUid: string
  patientName: string
  patientId: string
  studyDate: string
  studyDescription: string
  modalities: string
  accessionNumber: string
}

export type SeriesSummary = {
  studyInstanceUid: string
  seriesInstanceUid: string
  modality: string
  seriesDescription: string
  seriesNumber: string
  instanceCount: number
  studyColor?: string
  studyDate?: string
  studyModalities?: string
}

export type InstanceSummary = {
  studyInstanceUid: string
  seriesInstanceUid: string
  sopInstanceUid: string
  instanceNumber: number
  numberOfFrames: number
  rows: number
  columns: number
  imagePositionPatient?: number[]
  imageOrientationPatient?: number[]
  metadata?: DicomJsonDataset
}

export type WaveformChannel = {
  label: string
  samples: number[]
  minimum: number
  maximum: number
}

export type WaveformSummary = {
  samplingFrequency: number
  sampleCount: number
  channels: WaveformChannel[]
  annotations: { tag: string; value: string }[]
}

export type StructuredReportItem = {
  name: string
  value: string
  children: StructuredReportItem[]
}

export type StructuredReportSummary = {
  title: string
  items: StructuredReportItem[]
}
