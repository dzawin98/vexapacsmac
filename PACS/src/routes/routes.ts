import { FastifyPluginCallback } from 'fastify';
import { gzip as gzipCallback } from 'zlib';
import { promisify } from 'util';
import {
  FrameParams,
  ImageParams,
  QueryParams,
  SeriesParams,
  StudyParams,
  WadoUriQuery,
} from '../types';
import { fetchInstanceMetadata, fetchSeriesMetadata, fetchStudyMetadata } from '../dimse/fetchMeta';
import { doFind } from '../dimse/findData';
import { QUERY_LEVEL } from '../dimse/querLevel';
import { getFrameWarmStats } from '../dimse/frameWarm';
import { getHttpCompressionStats } from '../utils/httpCompression';
import { doWadoRsFrame, doWadoRsInstance, doWadoRsRaw, doWadoRsSeries, doWadoRsStudy, doWadoRsRendered, doWadoRsThumbnail, getWadoRsFrameEtag, getWadoRsRawEtag, getWadoRsRuntimeStats } from '../dimse/wadoRs';
import { doWadoUri } from '../dimse/wadoUri';
import { getRelatedStudyWaveforms, getStudyWaveform } from '../dimse/waveform';
import { doStowRs } from '../dimse/stowRs';
import { buildViewerStudyManifest, getViewerManifestBodyCacheStats, serializeViewerManifest } from '../dimse/viewerManifest';
import { getMetadataSyncStats } from '../dimse/metadataDb';
import { buildProgressiveReadinessAudit } from '../dimse/progressiveReadiness';
import {
  createServerMprSession,
  exportServerMprProxyVolume,
  getServerMprRuntimeStats,
  getServerMprSession,
  probeServerMprVolume,
  renderServerMprPlane,
  ServerMprNotReadyError,
} from '../dimse/serverMpr';
import { LoggerSingleton } from '../utils/logger';

const logger = LoggerSingleton.Instance;
const dicomJsonContentType = 'application/dicom+json';
const metadataCacheControl = process.env.DICOMWEB_METADATA_CACHE_CONTROL || 'private, max-age=60';
const gzip = promisify(gzipCallback);

type RenderedStackWarmFrame = {
  sopInstanceUid?: string;
  frame?: string | number;
};

type RenderedStackWarmBody = {
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  frames?: RenderedStackWarmFrame[];
  centerIndex?: string | number;
  radius?: string | number;
  maxFrames?: string | number;
  rows?: string | number;
  columns?: string | number;
  wc?: string | number;
  ww?: string | number;
  windowCenter?: string | number;
  windowWidth?: string | number;
  quality?: string | number;
};

function setDicomJsonHeaders(reply: any) {
  reply.header('Content-Type', dicomJsonContentType);
  reply.header('Cache-Control', metadataCacheControl);
}

function setBinaryResponseHeaders(reply: any, response: { contentType: string; etag?: string; cacheControl?: string; buffer?: Buffer }) {
  reply.header('Content-Type', response.contentType);
  reply.header('Cache-Control', response.cacheControl || process.env.DICOMWEB_PIXEL_CACHE_CONTROL || 'private, max-age=86400, immutable');
  if (response.etag) {
    reply.header('ETag', response.etag);
  }
  if (response.buffer) {
    reply.header('Content-Length', String(response.buffer.byteLength));
  }
}

function requestHasMatchingEtag(req: any, etag: string | null | undefined) {
  if (!etag) return false;
  const value = String(req.headers?.['if-none-match'] || '');
  return value.split(',').map((item) => item.trim()).includes(etag);
}

function acceptsGzip(req: any) {
  return String(req.headers?.['accept-encoding'] || '').toLowerCase().split(',').some((item) => item.trim().startsWith('gzip'));
}

function shouldGzipBinaryResponse(req: any, response: { contentType: string; buffer?: Buffer }) {
  if (String(process.env.DICOMWEB_PIXEL_GZIP || 'true').toLowerCase() === 'false') return false;
  if (!acceptsGzip(req)) return false;
  if (!response.buffer || response.buffer.byteLength < Number(process.env.DICOMWEB_PIXEL_GZIP_MIN_BYTES || 65536)) return false;
  const contentType = response.contentType.toLowerCase();
  if (contentType.includes('image/jpeg') || contentType.includes('image/jp2')) return false;
  return contentType.includes('application/octet-stream')
    || contentType.includes('application/dicom')
    || contentType.includes('application/vnd.vexa.mpr-plane')
    || contentType.includes('application/vnd.vexa.mpr-proxy-volume');
}

async function sendBinaryResponse(req: any, reply: any, response: { contentType: string; etag?: string; cacheControl?: string; buffer: Buffer }) {
  if (shouldGzipBinaryResponse(req, response)) {
    const compressed = await gzip(response.buffer, { level: Number(process.env.DICOMWEB_PIXEL_GZIP_LEVEL || 4) });
    setBinaryResponseHeaders(reply, { ...response, buffer: compressed });
    reply.header('Content-Encoding', 'gzip');
    reply.header('Vary', 'Accept-Encoding');
    return reply.send(compressed);
  }

  setBinaryResponseHeaders(reply, response);
  return reply.send(response.buffer);
}

function parseFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = parseFiniteNumber(value);
  const next = Math.floor(parsed ?? fallback);
  return Math.min(max, Math.max(min, next));
}

function normalizeRenderedWarmBody(value: unknown): RenderedStackWarmBody {
  return value && typeof value === 'object' ? value as RenderedStackWarmBody : {};
}

function buildCenterOutIndexes(length: number, centerIndex: number, radius: number, maxFrames: number) {
  const indexes: number[] = [];
  const add = (index: number) => {
    if (index >= 0 && index < length && !indexes.includes(index) && indexes.length < maxFrames) {
      indexes.push(index);
    }
  };

  add(centerIndex);
  for (let offset = 1; offset <= radius && indexes.length < maxFrames; offset += 1) {
    add(centerIndex + offset);
    add(centerIndex - offset);
  }
  return indexes;
}

function getFrameReferenceAtIndex(instances: Array<{ sopInstanceUid: string; numberOfFrames?: number }>, imageIndex: number) {
  let remaining = Math.max(0, Math.floor(imageIndex));
  for (const instance of instances) {
    const frameCount = Math.max(1, Number(instance.numberOfFrames || 1));
    if (remaining < frameCount) {
      return { sopInstanceUid: instance.sopInstanceUid, frame: remaining + 1 };
    }
    remaining -= frameCount;
  }

  const lastInstance = instances[instances.length - 1];
  return lastInstance ? { sopInstanceUid: lastInstance.sopInstanceUid, frame: Math.max(1, Number(lastInstance.numberOfFrames || 1)) } : null;
}

async function collectRenderedWarmFrames(body: RenderedStackWarmBody) {
  const maxFrames = clampInteger(body.maxFrames, Number(process.env.DICOMWEB_RENDERED_WARM_MAX_FRAMES || 16), 1, Number(process.env.DICOMWEB_RENDERED_WARM_HARD_MAX_FRAMES || 48));
  const directFrames = Array.isArray(body.frames)
    ? body.frames
        .map((frame) => ({
          sopInstanceUid: String(frame?.sopInstanceUid || '').trim(),
          frame: clampInteger(frame?.frame, 1, 1, 99999),
        }))
        .filter((frame) => frame.sopInstanceUid)
        .slice(0, maxFrames)
    : [];

  if (directFrames.length > 0) {
    return directFrames;
  }

  if (!body.studyInstanceUid || !body.seriesInstanceUid) {
    return [];
  }

  const manifest = await buildViewerStudyManifest(String(body.studyInstanceUid));
  const series = manifest.series.find((item) => item.seriesInstanceUid === body.seriesInstanceUid);
  if (!series?.instances?.length) {
    return [];
  }

  const totalFrames = series.instances.reduce((total, instance) => total + Math.max(1, Number(instance.numberOfFrames || 1)), 0);
  const radius = clampInteger(body.radius, 6, 0, Math.max(0, totalFrames - 1));
  const centerIndex = clampInteger(body.centerIndex, Math.floor(totalFrames / 2), 0, Math.max(0, totalFrames - 1));

  return buildCenterOutIndexes(totalFrames, centerIndex, radius, maxFrames)
    .map((index) => getFrameReferenceAtIndex(series.instances, index))
    .filter((frame): frame is { sopInstanceUid: string; frame: number } => Boolean(frame));
}

async function handleRenderedStackWarm(req: any, reply: any) {
  if (String(process.env.DICOMWEB_RENDERED_STACK_WARM_ENABLED || 'true').toLowerCase() === 'false') {
    return reply.header('Cache-Control', 'no-store').send({ ok: true, enabled: false, warmed: 0, failed: 0 });
  }

  const body = normalizeRenderedWarmBody(req.body);
  const studyInstanceUid = String(body.studyInstanceUid || '').trim();
  const seriesInstanceUid = String(body.seriesInstanceUid || '').trim();
  if (!studyInstanceUid || !seriesInstanceUid) {
    return reply.code(400).header('Cache-Control', 'no-store').send({ ok: false, error: 'studyInstanceUid and seriesInstanceUid are required' });
  }

  const startedAt = Date.now();
  const frames = await collectRenderedWarmFrames(body);
  const rows = parseFiniteNumber(body.rows);
  const columns = parseFiniteNumber(body.columns);
  const windowCenter = parseFiniteNumber(body.windowCenter ?? body.wc);
  const windowWidth = parseFiniteNumber(body.windowWidth ?? body.ww);
  const quality = clampInteger(body.quality, 22, 10, 92);
  let warmed = 0;
  let failed = 0;
  let bytes = 0;
  const errors: string[] = [];

  for (const frame of frames) {
    try {
      const response = await doWadoRsRendered({
        studyInstanceUid,
        seriesInstanceUid,
        sopInstanceUid: frame.sopInstanceUid,
        frame: String(frame.frame || 1),
        rows,
        columns,
        windowCenter,
        windowWidth,
        quality,
      });
      warmed += 1;
      bytes += response.buffer?.byteLength || 0;
    } catch (error) {
      failed += 1;
      if (errors.length < 3) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return reply.header('Cache-Control', 'no-store').send({
    ok: true,
    enabled: true,
    requested: frames.length,
    warmed,
    failed,
    bytes,
    elapsedMs: Date.now() - startedAt,
    quality,
    rows: rows || null,
    columns: columns || null,
    errors,
  });
}

async function handleProgressiveReadinessAudit(req: any, reply: any) {
  try {
    const payload = req.method === 'GET' ? req.query : req.body;
    const audit = await buildProgressiveReadinessAudit(payload || {});
    return reply.header('Cache-Control', 'no-store').send(audit);
  } catch (error) {
    logger.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return reply
      .code(message.includes('required') || message.includes('not found') ? 400 : 500)
      .header('Cache-Control', 'no-store')
      .send({ ok: false, error: message });
  }
}

const routes: FastifyPluginCallback = function (server, _opts, done) {
  server.get('/api/system/health', async (_req, reply) => {
    return reply
      .header('Cache-Control', 'no-store')
      .send({
        service: 'dicomweb-pacs',
        status: 'ok',
        generatedAt: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      });
  });

  server.get('/api/system/performance', async (_req, reply) => {
    const memory = process.memoryUsage();
    return reply
      .header('Cache-Control', 'no-store')
      .send({
        service: 'dicomweb-pacs',
        generatedAt: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        memory: {
          rssMb: Math.round(memory.rss / 1024 / 1024),
          heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
        },
        wadoRs: getWadoRsRuntimeStats(),
        serverMpr: getServerMprRuntimeStats(),
        frameWarm: getFrameWarmStats(),
        httpCompression: getHttpCompressionStats(),
        viewerManifest: getViewerManifestBodyCacheStats(),
        metadataSync: getMetadataSyncStats(),
      });
  });

  server.post('/api/system/telemetry', async (req, reply) => {
    if (String(process.env.VIEWER_TELEMETRY_LOG || 'false').toLowerCase() === 'true') {
      logger.info({ viewerTelemetry: req.body }, 'viewer telemetry');
    }
    return reply.code(204).header('Cache-Control', 'no-store').send();
  });

  server.post('/api/rendered-stack/warm', handleRenderedStackWarm);
  server.post('/api/viewer/rendered-stack/warm', handleRenderedStackWarm);
  server.post('/api/mpr/sessions', async (req, reply) => {
    try {
      return reply.header('Cache-Control', 'no-store').send(await createServerMprSession((req.body || {}) as any));
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('required') || message.includes('not found') ? 400 : 500).header('Cache-Control', 'no-store').send({ error: message });
    }
  });
  server.get<{ Params: { sessionId: string } }>('/api/mpr/sessions/:sessionId', async (req, reply) => {
    try {
      return reply.header('Cache-Control', 'no-store').send(getServerMprSession(req.params.sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') || message.includes('expired') ? 404 : 500).header('Cache-Control', 'no-store').send({ error: message });
    }
  });
  server.post<{ Params: { sessionId: string } }>('/api/mpr/sessions/:sessionId/reslice', async (req, reply) => {
    try {
      const response = await renderServerMprPlane(req.params.sessionId, (req.body || {}) as any);
      Object.entries(response.headers).forEach(([name, value]) => reply.header(name, value));
      return sendBinaryResponse(req, reply, response);
    } catch (error) {
      if (error instanceof ServerMprNotReadyError) {
        return reply.code(425).header('Cache-Control', 'no-store').header('Retry-After', '1').send({ error: error.message, progress: error.progress });
      }
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') || message.includes('expired') ? 404 : 500).header('Cache-Control', 'no-store').send({ error: message });
    }
  });
  server.post<{ Params: { sessionId: string } }>('/api/mpr/sessions/:sessionId/probe', async (req, reply) => {
    try {
      const body = (req.body || {}) as { world?: unknown };
      return reply.header('Cache-Control', 'no-store').send(await probeServerMprVolume(req.params.sessionId, body.world));
    } catch (error) {
      if (error instanceof ServerMprNotReadyError) {
        return reply.code(425).header('Cache-Control', 'no-store').send({ error: error.message, progress: error.progress });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') || message.includes('expired') ? 404 : 400).header('Cache-Control', 'no-store').send({ error: message });
    }
  });
  server.post<{ Params: { sessionId: string } }>('/api/mpr/sessions/:sessionId/proxy-volume', async (req, reply) => {
    try {
      const response = await exportServerMprProxyVolume(req.params.sessionId, (req.body || {}) as any);
      return sendBinaryResponse(req, reply, response);
    } catch (error) {
      if (error instanceof ServerMprNotReadyError) {
        return reply.code(425).header('Cache-Control', 'no-store').send({ error: error.message, progress: error.progress });
      }
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') || message.includes('expired') ? 404 : 500).header('Cache-Control', 'no-store').send({ error: message });
    }
  });
  server.get('/api/mpr/runtime', async (_req, reply) => reply.header('Cache-Control', 'no-store').send(getServerMprRuntimeStats()));
  server.get('/api/experimental/progressive/audit', handleProgressiveReadinessAudit);
  server.post('/api/experimental/progressive/audit', handleProgressiveReadinessAudit);
  server.get('/api/viewer/progressive/audit', handleProgressiveReadinessAudit);
  server.post('/api/viewer/progressive/audit', handleProgressiveReadinessAudit);

  server.get<{
    Params: StudyParams;
  }>('/api/viewer/studies/:studyInstanceUid/manifest', async (req, reply) => {
    try {
      const manifest = await buildViewerStudyManifest(req.params.studyInstanceUid);
      const { etag, body } = serializeViewerManifest(manifest);
      const ifNoneMatch = String(req.headers['if-none-match'] || '');
      if (ifNoneMatch.split(',').map((item) => item.trim()).includes(etag)) {
        return reply
          .code(304)
          .header('ETag', etag)
          .header('Cache-Control', 'private, max-age=30')
          .send();
      }

      // Compression (brotli when the client accepts it) is applied centrally by
      // registerHttpCompression, which also memoises the encoded body.
      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Cache-Control', 'private, max-age=30')
        .header('ETag', etag)
        .send(body);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') ? 404 : 500).send({ error: message });
    }
  });

  server.get<{
    Querystring: QueryParams;
  }>('/rs/studies', async (req, reply) => {
    try {
      setDicomJsonHeaders(reply);
      return reply.send(await doFind(QUERY_LEVEL.STUDY, req.query));
    } catch (error) {
      logger.error(error);
      return reply.code(500).send();
    }
  });

  server.get<{
    Params: StudyParams;
    Querystring: QueryParams;
  }>('/rs/studies/:studyInstanceUid/metadata', async (req, reply) => {
    const query = { ...req.query, StudyInstanceUID: req.params.studyInstanceUid };
    try {
      setDicomJsonHeaders(reply);
      return reply.send(await fetchStudyMetadata(query));
    } catch (error) {
      logger.error(error);
      return reply.code(500).send();
    }
  });

  server.get<{
    Params: StudyParams;
    Querystring: QueryParams;
  }>('/rs/studies/:studyInstanceUid/series', async (req, reply) => {
    const query = { ...req.query, StudyInstanceUID: req.params.studyInstanceUid };
    try {
      setDicomJsonHeaders(reply);
      return reply.send(await doFind(QUERY_LEVEL.SERIES, query));
    } catch (error) {
      logger.error(error);
      return reply.code(500).send();
    }
  });

  server.get<{
    Params: SeriesParams;
    Querystring: QueryParams;
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances', async (req, reply) => {
    const query = {
      ...req.query,
      StudyInstanceUID: req.params.studyInstanceUid,
      SeriesInstanceUID: req.params.seriesInstanceUid,
    };
    try {
      setDicomJsonHeaders(reply);
      return reply.send(await doFind(QUERY_LEVEL.IMAGE, query));
    } catch (error) {
      logger.error(error);
      return reply.code(500).send();
    }
  });

  server.get<{
    Params: SeriesParams;
    Querystring: QueryParams;
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/metadata', async (req, reply) => {
    const query = {
      ...req.query,
      StudyInstanceUID: req.params.studyInstanceUid,
      SeriesInstanceUID: req.params.seriesInstanceUid,
    };
    try {
      setDicomJsonHeaders(reply);
      return reply.send(await fetchSeriesMetadata(query));
    } catch (error) {
      logger.error(error);
      return reply.code(500).send();
    }
  });

  server.get<{
    Params: ImageParams;
    Querystring: QueryParams;
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/metadata', async (req, reply) => {
    const query = {
      ...req.query,
      StudyInstanceUID: req.params.studyInstanceUid,
      SeriesInstanceUID: req.params.seriesInstanceUid,
      SOPInstanceUID: req.params.sopInstanceUid,
    };
    try {
      setDicomJsonHeaders(reply);
      return reply.send(await fetchInstanceMetadata(query));
    } catch (error) {
      logger.error(error);
      return reply.code(500).send();
    }
  });

  server.get<{
    Params: FrameParams;
    Querystring: { vexaCompressed?: string };
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/frames/:frame', async (req, reply) => {
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid, frame } = req.params;
    const compressedMode = String((req.query as any)?.vexaCompressed || '').trim() || undefined;
    try {
      const etag = await getWadoRsFrameEtag({
        studyInstanceUid,
        seriesInstanceUid,
        sopInstanceUid,
        frame,
        compressedMode,
      });
      if (requestHasMatchingEtag(req, etag)) {
        reply.header('Cache-Control', process.env.DICOMWEB_PIXEL_CACHE_CONTROL || 'private, max-age=86400, immutable');
        reply.header('ETag', etag as string);
        return reply.code(304).send();
      }
      const response = await doWadoRsFrame({
        studyInstanceUid,
        seriesInstanceUid,
        sopInstanceUid,
        frame,
        compressedMode,
      });
      return sendBinaryResponse(req, reply, response);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found in storage') ? 404 : 500).send(message);
    }
  });

  server.get<{
    Params: ImageParams;
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/thumb', async (req, reply) => {
    const { studyInstanceUid, sopInstanceUid } = req.params;
    try {
      const response = await doWadoRsThumbnail({ studyInstanceUid, sopInstanceUid });
      reply.header('Content-Type', response.contentType);
      reply.header('Cache-Control', response.cacheControl);
      reply.header('ETag', response.etag);
      return reply.send(response.buffer);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') ? 404 : 500).send(message);
    }
  });

  server.get<{
    Params: FrameParams;
    Querystring: { rows?: string; columns?: string; wc?: string; ww?: string; quality?: string };
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/rendered', async (req, reply) => {
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;
    const frame = (req.query as any)?.frame || '1';
    const rows = parseInt((req.query as any)?.rows || '0', 10) || undefined;
    const columns = parseInt((req.query as any)?.columns || '0', 10) || undefined;
    const windowCenter = (req.query as any)?.wc !== undefined ? parseFloat((req.query as any).wc) : undefined;
    const windowWidth = (req.query as any)?.ww !== undefined ? parseFloat((req.query as any).ww) : undefined;
    const quality = parseInt((req.query as any)?.quality || '70', 10) || 70;

    try {
      const response = await doWadoRsRendered({
        studyInstanceUid,
        seriesInstanceUid,
        sopInstanceUid,
        frame,
        rows: rows || undefined,
        columns: columns || undefined,
        windowCenter,
        windowWidth,
        quality,
      });
      reply.header('Content-Type', response.contentType);
      reply.header('Cache-Control', response.cacheControl || 'public, max-age=300');
      if (response.etag) reply.header('ETag', response.etag);
      return reply.send(response.buffer);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') ? 404 : 500).send(message);
    }
  });

  server.get<{
    Params: FrameParams;
    Querystring: { frame?: string; dtype?: string };
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/raw', async (req, reply) => {
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;
    const frame = (req.query as any)?.frame || '1';
    const dataType = String((req.query as any)?.dtype || '');
    try {
      if (req.headers?.['if-none-match']) {
        const etag = await getWadoRsRawEtag({
          studyInstanceUid,
          seriesInstanceUid,
          sopInstanceUid,
          frame,
          dataType,
        });
        if (requestHasMatchingEtag(req, etag)) {
          reply.header('Cache-Control', process.env.DICOMWEB_PIXEL_CACHE_CONTROL || 'private, max-age=86400, immutable');
          reply.header('ETag', etag as string);
          return reply.code(304).send();
        }
      }

      const raw = await doWadoRsRaw({
        studyInstanceUid,
        seriesInstanceUid,
        sopInstanceUid,
        frame,
        dataType,
      });
      reply.header('X-Rows', String(raw.rows));
      reply.header('X-Columns', String(raw.columns));
      reply.header('X-DataType', raw.dataType);
      reply.header('X-VEXA-Raw-Cache', raw.cacheStatus);

      return sendBinaryResponse(req, reply, {
        contentType: 'application/octet-stream',
        cacheControl: raw.cacheControl,
        etag: raw.etag,
        buffer: raw.buffer,
      });
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') ? 404 : 500).send(message);
    }
  });

  server.get<{
    Params: ImageParams;
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid', async (req, reply) => {
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;
    try {
      const response = await doWadoRsInstance({
        studyInstanceUid,
        seriesInstanceUid,
        sopInstanceUid,
      });
      if (requestHasMatchingEtag(req, response.etag)) {
        reply.header('Cache-Control', response.cacheControl || process.env.DICOMWEB_PIXEL_CACHE_CONTROL || 'private, max-age=86400, immutable');
        reply.header('ETag', response.etag as string);
        return reply.code(304).send();
      }
      return sendBinaryResponse(req, reply, response);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found in storage') ? 404 : 500).send(message);
    }
  });

  server.get<{
    Params: SeriesParams;
  }>('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid', async (req, reply) => {
    const { studyInstanceUid, seriesInstanceUid } = req.params;
    try {
      const response = await doWadoRsSeries({
        studyInstanceUid,
        seriesInstanceUid,
        sopInstanceUid: '',
      });
      return sendBinaryResponse(req, reply, response);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') || message.includes('No DICOM') ? 404 : 500).send(message);
    }
  });

  server.post('/rs/studies', async (req, reply) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await doStowRs(body, String(req.headers['content-type'] ?? ''));
      setDicomJsonHeaders(reply);
      return reply.code(200).send(result);
    } catch (error) {
      logger.error(error);
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.post<{
    Params: StudyParams;
  }>('/rs/studies/:studyInstanceUid', async (req, reply) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await doStowRs(body, String(req.headers['content-type'] ?? ''), req.params.studyInstanceUid);
      setDicomJsonHeaders(reply);
      return reply.code(200).send(result);
    } catch (error) {
      logger.error(error);
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get<{
    Params: StudyParams;
  }>('/rs/studies/:studyInstanceUid/waveform', async (req, reply) => {
    try {
      const waveform = await getStudyWaveform(req.params.studyInstanceUid);
      if (!waveform) {
        return reply.code(404).send({ error: 'DICOM waveform not found' });
      }
      return reply.send(waveform);
    } catch (error) {
      logger.error(error);
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get<{
    Params: StudyParams;
  }>('/rs/studies/:studyInstanceUid/waveforms', async (req, reply) => {
    try {
      const waveforms = await getRelatedStudyWaveforms(req.params.studyInstanceUid);
      return reply.send(waveforms);
    } catch (error) {
      logger.error(error);
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get<{
    Params: StudyParams;
  }>('/rs/studies/:studyInstanceUid', async (req, reply) => {
    const { studyInstanceUid } = req.params;
    try {
      const response = await doWadoRsStudy({
        studyInstanceUid,
        sopInstanceUid: '',
      });
      return sendBinaryResponse(req, reply, response);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found') || message.includes('No DICOM') ? 404 : 500).send(message);
    }
  });

  server.get<{
    Querystring: WadoUriQuery;
  }>('/wadouri', async (req, reply) => {
    const { studyUID, seriesUID, objectUID } = req.query;
    if (!studyUID || !seriesUID || !objectUID) {
      const message = 'Error missing parameters.';
      logger.error(message);
      return reply.code(400).send(message);
    }

    try {
      const response = await doWadoUri({
        studyInstanceUid: studyUID,
        seriesInstanceUid: seriesUID,
        sopInstanceUid: objectUID,
      });
      return sendBinaryResponse(req, reply, response);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('not found in storage') ? 404 : 500).send(message);
    }
  });

  done();
};

module.exports = routes;
