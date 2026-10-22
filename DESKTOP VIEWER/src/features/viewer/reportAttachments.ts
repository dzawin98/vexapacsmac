export type ReportAttachment = {
  id: string
  studyInstanceUid: string
  seriesInstanceUid: string
  sourceSeriesInstanceUid: string
  title: string
  instanceCount: number
  createdAt: string
}

const storagePrefix = 'vexa.viewer.reportAttachments.v1'

export function queueCaptureForReport(attachment: Omit<ReportAttachment, 'id' | 'createdAt'>) {
  const next: ReportAttachment = {
    ...attachment,
    id: `${attachment.seriesInstanceUid}:${Date.now()}`,
    createdAt: new Date().toISOString(),
  }
  const existing = readReportAttachments(attachment.studyInstanceUid)
  writeReportAttachments(attachment.studyInstanceUid, [next, ...existing].slice(0, 100))
  window.dispatchEvent(new CustomEvent('vexa-viewer-report-attachment-added', { detail: next }))
  return next
}

export function readReportAttachments(studyInstanceUid: string) {
  try {
    const raw = window.localStorage.getItem(storageKey(studyInstanceUid))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isReportAttachment) as ReportAttachment[] : []
  } catch {
    return []
  }
}

function writeReportAttachments(studyInstanceUid: string, attachments: ReportAttachment[]) {
  try {
    window.localStorage.setItem(storageKey(studyInstanceUid), JSON.stringify(attachments))
  } catch {
    // The capture remains safely stored in PACS when browser report queue storage is unavailable.
  }
}

function storageKey(studyInstanceUid: string) {
  return `${storagePrefix}:${studyInstanceUid}`
}

function isReportAttachment(value: unknown) {
  const item = value as Partial<ReportAttachment> | null
  return Boolean(
    item
    && typeof item.id === 'string'
    && typeof item.studyInstanceUid === 'string'
    && typeof item.seriesInstanceUid === 'string'
    && typeof item.title === 'string',
  )
}
