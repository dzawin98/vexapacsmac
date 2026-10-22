import fs from 'fs/promises';
import dicomParser from 'dicom-parser';
import { buildViewerStudyManifest, ViewerStudyManifest } from './viewerManifest';
import { resolveInstancePath } from './storageIndex';

type ProgressiveAuditRequest = {
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sampleLimit?: number | string;
};

type ManifestSeries = ViewerStudyManifest['series'][number];
type ManifestInstance = ManifestSeries['instances'][number];

const htj2kTransferSyntaxes = new Set([
  '1.2.840.10008.1.2.4.201',
  '1.2.840.10008.1.2.4.202',
  '1.2.840.10008.1.2.4.203',
]);

const htj2kRpclTransferSyntaxes = new Set([
  '1.2.840.10008.1.2.4.202',
  '1.2.840.10008.1.2.4.203',
]);

const transferSyntaxNames: Record<string, string> = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless SV1',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Near Lossless',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.4.92': 'JPEG 2000 Multi-component Lossless',
  '1.2.840.10008.1.2.4.93': 'JPEG 2000 Multi-component',
  '1.2.840.10008.1.2.4.201': 'HTJ2K Lossless',
  '1.2.840.10008.1.2.4.202': 'HTJ2K Lossless RPCL',
  '1.2.840.10008.1.2.4.203': 'HTJ2K RPCL',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
};

export async function buildProgressiveReadinessAudit(request: ProgressiveAuditRequest) {
  const studyInstanceUid = String(request.studyInstanceUid || '').trim();
  if (!studyInstanceUid) {
    throw new Error('studyInstanceUid is required');
  }

  const manifest = await buildViewerStudyManifest(studyInstanceUid);
  const requestedSeriesInstanceUid = String(request.seriesInstanceUid || '').trim();
  const sampleLimit = clampInteger(request.sampleLimit, Number(process.env.DICOMWEB_PROGRESSIVE_AUDIT_SAMPLE_LIMIT || 64), 1, 512);
  const seriesList = manifest.series
    .filter((series) => !requestedSeriesInstanceUid || series.seriesInstanceUid === requestedSeriesInstanceUid)
    .filter((series) => series.instances.some((instance) => instance.rows > 0 && instance.columns > 0));

  const auditedSeries = await Promise.all(seriesList.map((series) => auditSeries(series, sampleLimit)));
  const htj2kSeries = auditedSeries.filter((series) => series.htj2k.sampledInstances > 0).length;
  const rpclSeries = auditedSeries.filter((series) => series.htj2k.rpclSampledInstances > 0).length;
  const byteRangeReadySeries = auditedSeries.filter((series) => series.recommendation.safeToEnableByteRange).length;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    studyInstanceUid,
    requestedSeriesInstanceUid: requestedSeriesInstanceUid || null,
    sampleLimit,
    summary: {
      seriesAudited: auditedSeries.length,
      htj2kSeries,
      rpclSeries,
      byteRangeReadySeries,
      safeToEnableGlobalByteRange: byteRangeReadySeries > 0 && byteRangeReadySeries === auditedSeries.length,
    },
    server: {
      frameEndpointRangeSupport: false,
      reason: 'Current PACS /frames endpoint returns complete multipart frame bodies and does not implement HTTP 206 byte-range responses yet.',
      requiredForByteRange: [
        'Expose frame byte ranges with HTTP 206 Partial Content.',
        'Return Content-Range and Accept-Ranges headers.',
        'Serve HTJ2K RPCL/JPH frame payloads with image/jhc content type.',
      ],
    },
    cornerstone: {
      safeDefault: 'Keep WADO-RS Cornerstone as the diagnostic layer.',
      optInFlags: {
        stackStreaming: 'VITE_DICOM_STACK_STREAMING=true',
        htj2kByteRange: 'VITE_DICOM_HTJ2K_BYTE_RANGE=true',
      },
      warning: 'Do not enable byte range globally unless this audit reports RPCL HTJ2K data and the server range endpoint is implemented.',
    },
    series: auditedSeries,
  };
}

async function auditSeries(series: ManifestSeries, sampleLimit: number) {
  const sampleIndexes = buildSampleIndexes(series.instances.length, sampleLimit);
  const samples = await Promise.all(sampleIndexes.map((index) => auditInstance(series.instances[index])));
  const readableSamples = samples.filter((sample): sample is Awaited<ReturnType<typeof auditInstance>> & { ok: true } => Boolean(sample?.ok));
  const syntaxMap = new Map<string, { uid: string; name: string; family: string; count: number; frames: number; bytes: number; contentType: string; htj2k: boolean; rpcl: boolean }>();

  for (const sample of readableSamples) {
    const info = getTransferSyntaxInfo(sample.transferSyntaxUid);
    const current = syntaxMap.get(info.uid) ?? {
      uid: info.uid,
      name: info.name,
      family: info.family,
      count: 0,
      frames: 0,
      bytes: 0,
      contentType: info.contentType,
      htj2k: info.htj2k,
      rpcl: info.rpcl,
    };
    current.count += 1;
    current.frames += sample.numberOfFrames;
    current.bytes += sample.fileSize;
    syntaxMap.set(info.uid, current);
  }

  const transferSyntaxes = [...syntaxMap.values()].sort((a, b) => b.count - a.count);
  const htj2kSampledInstances = transferSyntaxes.filter((item) => item.htj2k).reduce((total, item) => total + item.count, 0);
  const rpclSampledInstances = transferSyntaxes.filter((item) => item.rpcl).reduce((total, item) => total + item.count, 0);
  const sampleErrors = samples
    .filter((sample) => !sample?.ok)
    .map((sample) => ({ sopInstanceUid: sample?.sopInstanceUid ?? '', error: sample?.error ?? 'Unknown audit error' }))
    .slice(0, 10);
  const allReadableSamplesAreRpcl = readableSamples.length > 0 && readableSamples.every((sample) => getTransferSyntaxInfo(sample.transferSyntaxUid).rpcl);

  return {
    seriesInstanceUid: series.seriesInstanceUid,
    modality: series.modality,
    seriesDescription: series.seriesDescription,
    instanceCount: series.instanceCount,
    totalFrames: series.instances.reduce((total, instance) => total + Math.max(1, Number(instance.numberOfFrames || 1)), 0),
    rows: series.rows,
    columns: series.columns,
    sampledInstances: samples.length,
    readableSamples: readableSamples.length,
    transferSyntaxes,
    htj2k: {
      sampledInstances: htj2kSampledInstances,
      rpclSampledInstances,
      allReadableSamplesAreRpcl,
    },
    range: {
      frameEndpointSupportsHttpRange: false,
      rangeRequestSafe: false,
      reason: 'Server route audit only: HTTP byte-range delivery is intentionally still disabled.',
    },
    recommendation: {
      safeToEnableStackStreaming: rpclSampledInstances > 0,
      safeToEnableByteRange: false,
      mode: allReadableSamplesAreRpcl ? 'htj2k-rpcl-candidate' : htj2kSampledInstances > 0 ? 'htj2k-non-rpcl-or-mixed' : 'ordinary-wadors',
      reason: allReadableSamplesAreRpcl
        ? 'Series samples are HTJ2K RPCL, but server byte-range support is not implemented yet.'
        : htj2kSampledInstances > 0
          ? 'Series contains HTJ2K samples, but not all sampled instances are RPCL-ready.'
          : 'Series is not HTJ2K RPCL; keep current WADO-RS loading and cache/prewarm strategy.',
    },
    sampleErrors,
  };
}

async function auditInstance(instance: ManifestInstance): Promise<{
  ok: true;
  sopInstanceUid: string;
  transferSyntaxUid: string;
  numberOfFrames: number;
  fileSize: number;
} | {
  ok: false;
  sopInstanceUid: string;
  error: string;
}> {
  try {
    const pathname = await resolveInstancePath(instance.studyInstanceUid, instance.sopInstanceUid);
    if (!pathname) {
      return { ok: false, sopInstanceUid: instance.sopInstanceUid, error: 'instance file not found' };
    }

    const [stat, data] = await Promise.all([fs.stat(pathname), fs.readFile(pathname)]);
    const dataset = dicomParser.parseDicom(data, { untilTag: 'x7fe00010' });
    return {
      ok: true,
      sopInstanceUid: instance.sopInstanceUid,
      transferSyntaxUid: dataset.string('x00020010') || '1.2.840.10008.1.2',
      numberOfFrames: Math.max(1, Number(instance.numberOfFrames || 1)),
      fileSize: stat.size,
    };
  } catch (error) {
    return {
      ok: false,
      sopInstanceUid: instance.sopInstanceUid,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getTransferSyntaxInfo(uid: string) {
  const normalizedUid = uid || '1.2.840.10008.1.2';
  const htj2k = htj2kTransferSyntaxes.has(normalizedUid);
  const rpcl = htj2kRpclTransferSyntaxes.has(normalizedUid);

  return {
    uid: normalizedUid,
    name: transferSyntaxNames[normalizedUid] ?? 'Unknown Transfer Syntax',
    family: getTransferSyntaxFamily(normalizedUid),
    contentType: getTransferSyntaxContentType(normalizedUid),
    htj2k,
    rpcl,
  };
}

function getTransferSyntaxFamily(uid: string) {
  if (htj2kTransferSyntaxes.has(uid)) return 'HTJ2K';
  if (uid.startsWith('1.2.840.10008.1.2.4.9')) return 'JPEG 2000';
  if (uid.startsWith('1.2.840.10008.1.2.4.8')) return 'JPEG-LS';
  if (uid.startsWith('1.2.840.10008.1.2.4.5') || uid === '1.2.840.10008.1.2.4.70') return 'JPEG';
  if (uid === '1.2.840.10008.1.2.5') return 'RLE';
  return 'Native';
}

function getTransferSyntaxContentType(uid: string) {
  if (htj2kTransferSyntaxes.has(uid)) return 'image/jhc';
  if (uid.startsWith('1.2.840.10008.1.2.4.9')) return 'image/jp2';
  if (uid.startsWith('1.2.840.10008.1.2.4.5') || uid === '1.2.840.10008.1.2.4.70') return 'image/jpeg';
  return 'application/octet-stream';
}

function buildSampleIndexes(length: number, limit: number) {
  if (length <= 0) return [];
  if (length <= limit) {
    return Array.from({ length }, (_, index) => index);
  }

  const indexes = new Set<number>([0, Math.floor(length / 2), length - 1]);
  for (let sample = 0; indexes.size < limit && sample < limit * 3; sample += 1) {
    indexes.add(Math.round((sample * (length - 1)) / Math.max(1, limit - 1)));
  }
  return [...indexes].sort((a, b) => a - b).slice(0, limit);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(parsed) ? parsed : fallback)));
}
