import { createHash } from 'crypto';
import { DicomJsonRecord } from '../types';
import { queryPacsMetadata } from './metadataDb';
import { QUERY_LEVEL } from './querLevel';

type ManifestInstance = {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  instanceNumber: number;
  numberOfFrames: number;
  rows: number;
  columns: number;
  metadata: DicomJsonRecord;
};

type ManifestSeries = {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  modality: string;
  seriesDescription: string;
  seriesNumber: string;
  instanceCount: number;
  rows: number;
  columns: number;
  windowCenter?: number;
  windowWidth?: number;
  firstInstance?: ManifestInstance;
  middleInstance?: ManifestInstance;
  instances: ManifestInstance[];
};

export type ViewerStudyManifest = {
  generatedAt: string;
  studyInstanceUid: string;
  study: {
    studyInstanceUid: string;
    patientName: string;
    patientId: string;
    studyDate: string;
    studyDescription: string;
    accessionNumber: string;
    modalities: string;
  };
  series: ManifestSeries[];
};

const manifestTags = [
  '00080018',
  '00080020',
  '00080050',
  '00080060',
  '00081030',
  '0008103E',
  '00100010',
  '00100020',
  '00100030',
  '00100040',
  '0020000D',
  '0020000E',
  '00200011',
  '00200013',
  '00200032',
  '00200037',
  '00200052',
  '00280002',
  '00280004',
  '00280006',
  '00280008',
  '00280010',
  '00280011',
  '00280030',
  '00280100',
  '00280101',
  '00280102',
  '00280103',
  '00281050',
  '00281051',
  '00281052',
  '00281053',
];

export async function buildViewerStudyManifest(studyInstanceUid: string): Promise<ViewerStudyManifest> {
  const records = await queryPacsMetadata(
    QUERY_LEVEL.IMAGE,
    manifestTags,
    [{ tag: '0020000D', vr: 'UI', value: studyInstanceUid }],
  );

  const validRecords = (records || []).filter((record) => readValue(record, '0020000D') === studyInstanceUid);
  if (!validRecords.length) {
    throw new Error(`Study ${studyInstanceUid} not found`);
  }

  const firstRecord = validRecords[0];
  const seriesMap = new Map<string, ManifestInstance[]>();
  for (const record of validRecords) {
    const seriesInstanceUid = readValue(record, '0020000E');
    const sopInstanceUid = readValue(record, '00080018');
    if (!seriesInstanceUid || !sopInstanceUid) continue;

    const instances = seriesMap.get(seriesInstanceUid) || [];
    instances.push({
      studyInstanceUid,
      seriesInstanceUid,
      sopInstanceUid,
      instanceNumber: readNumber(record, '00200013') || instances.length + 1,
      numberOfFrames: Math.max(1, readNumber(record, '00280008') || 1),
      rows: readNumber(record, '00280010') || 0,
      columns: readNumber(record, '00280011') || 0,
      metadata: record,
    });
    seriesMap.set(seriesInstanceUid, instances);
  }

  const series = [...seriesMap.entries()]
    .map(([seriesInstanceUid, instances]) => {
      const sortedInstances = sortInstances(instances);
      const seed = sortedInstances[0]?.metadata || {};
      const middleInstance = sortedInstances[Math.floor(sortedInstances.length / 2)] || sortedInstances[0];
      const modalities = readValue(seed, '00080060');
      const rows = firstPositive(sortedInstances.map((instance) => instance.rows));
      const columns = firstPositive(sortedInstances.map((instance) => instance.columns));
      const windowCenter = readNumber(seed, '00281050');
      const windowWidth = readNumber(seed, '00281051');

      return {
        studyInstanceUid,
        seriesInstanceUid,
        modality: modalities,
        seriesDescription: readValue(seed, '0008103E') || 'Series',
        seriesNumber: readValue(seed, '00200011'),
        instanceCount: sortedInstances.length,
        rows,
        columns,
        ...(Number.isFinite(windowCenter) && windowCenter !== 0 ? { windowCenter } : {}),
        ...(Number.isFinite(windowWidth) && windowWidth !== 0 ? { windowWidth } : {}),
        firstInstance: sortedInstances[0],
        middleInstance,
        instances: sortedInstances,
      };
    })
    .sort((a, b) => Number(b.instanceCount || 0) - Number(a.instanceCount || 0));

  return {
    generatedAt: new Date().toISOString(),
    studyInstanceUid,
    study: {
      studyInstanceUid,
      patientName: readValue(firstRecord, '00100010') || 'Unknown Patient',
      patientId: readValue(firstRecord, '00100020'),
      studyDate: readValue(firstRecord, '00080020'),
      studyDescription: readValue(firstRecord, '00081030') || 'No description',
      accessionNumber: readValue(firstRecord, '00080050'),
      modalities: [...new Set(series.map((item) => item.modality).filter(Boolean))].join('\\'),
    },
    series,
  };
}

/**
 * Serialise a manifest for HTTP responses, reusing the previous body when the
 * manifest fingerprint (ETag) is unchanged.
 *
 * The manifest is the heaviest JSON this server produces (815 instances ->
 * ~1.5 MB). `generatedAt` would change on every build, which defeats both the
 * HTTP cache and the shared compression memo, so the body of an unchanged
 * study is reused verbatim - the client only sees a stable body plus the same
 * ETag, and its revalidation answers 304.
 */
const manifestBodyCache = new Map<string, { etag: string; body: Buffer }>();
const MANIFEST_BODY_CACHE_MAX = Math.max(2, Number(process.env.DICOMWEB_MANIFEST_BODY_CACHE_ENTRIES || 24));

export function serializeViewerManifest(manifest: ViewerStudyManifest): { etag: string; body: Buffer } {
  const etag = buildViewerManifestEtag(manifest);
  const cached = manifestBodyCache.get(manifest.studyInstanceUid);
  if (cached && cached.etag === etag) {
    manifestBodyCache.delete(manifest.studyInstanceUid);
    manifestBodyCache.set(manifest.studyInstanceUid, cached);
    return cached;
  }

  const entry = { etag, body: Buffer.from(JSON.stringify(manifest)) };
  manifestBodyCache.delete(manifest.studyInstanceUid);
  manifestBodyCache.set(manifest.studyInstanceUid, entry);
  while (manifestBodyCache.size > MANIFEST_BODY_CACHE_MAX) {
    const oldest = manifestBodyCache.keys().next();
    if (oldest.done) break;
    manifestBodyCache.delete(oldest.value);
  }
  return entry;
}

export function getViewerManifestBodyCacheStats() {
  let bytes = 0;
  for (const entry of manifestBodyCache.values()) bytes += entry.body.length;
  return { entries: manifestBodyCache.size, bytes, maxEntries: MANIFEST_BODY_CACHE_MAX };
}

export function buildViewerManifestEtag(manifest: ViewerStudyManifest): string {
  const fingerprint = manifest.series
    .map((series) => `${series.seriesInstanceUid}:${series.instanceCount}:${series.middleInstance?.sopInstanceUid || ''}`)
    .join('|');
  const hash = createHash('sha1')
    .update(`${manifest.studyInstanceUid}|${fingerprint}`)
    .digest('base64url');
  return `"vexa-manifest-${hash}"`;
}

function sortInstances(instances: ManifestInstance[]) {
  return [...instances].sort((a, b) => {
    const az = readNumberArray(a.metadata, '00200032')[2] ?? Number.NaN;
    const bz = readNumberArray(b.metadata, '00200032')[2] ?? Number.NaN;
    if (Number.isFinite(az) && Number.isFinite(bz) && az !== bz) return az - bz;
    return a.instanceNumber - b.instanceNumber;
  });
}

function readValue(record: DicomJsonRecord, tag: string): string {
  const value = record?.[tag]?.Value?.[0];
  if (value && typeof value === 'object' && 'Alphabetic' in value) {
    return String(value.Alphabetic || '');
  }
  return value === undefined || value === null ? '' : String(value);
}

function readNumber(record: DicomJsonRecord, tag: string): number {
  const value = Number(readValue(record, tag));
  return Number.isFinite(value) ? value : 0;
}

function readNumberArray(record: DicomJsonRecord, tag: string): number[] {
  const value = record?.[tag]?.Value;
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function firstPositive(values: number[]) {
  return values.find((value) => Number.isFinite(value) && value > 0) || 0;
}
