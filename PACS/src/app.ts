import path from 'path';
import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyAutoload from '@fastify/autoload';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifySensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import closeWithGrace from 'close-with-grace';
import { fetchStudyMetadata } from './dimse/fetchMeta';
import { startStorageArrivalWatcher } from './dimse/frameWarm';
import { warmJpeg2000DecoderPool } from './dimse/wadoRs';
import { startMetadataSyncScheduler } from './dimse/metadataDb';
import { shutdown, startScp } from './dimse/store';
import { ConfParams, config } from './utils/config';
import { ensureDirectories } from './utils/fileHelper';
import { registerHttpCompression } from './utils/httpCompression';
import { LoggerSingleton } from './utils/logger';

const { enforceLicenseAtStartup } = require('../../scripts/license/licenseRuntime');

enforceLicenseAtStartup('PACS_DIMSE');

const logger = LoggerSingleton.Instance;
const server: FastifyInstance = fastify({
  bodyLimit: Number(process.env.DICOMWEB_PACS_BODY_LIMIT || 250 * 1024 * 1024),
});

server.addContentTypeParser(/^multipart\/related\b/i, { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

server.addContentTypeParser(/^application\/dicom\b/i, { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

// Compress repetitive JSON metadata (manifest/QIDO). Registered before the Cache-Control
// hook so every send path (routes, static viewer assets) is covered.
registerHttpCompression(server);

server.addHook('onSend', async (_req, reply, payload) => {
  if (!reply.getHeader('Cache-Control')) {
    reply.header('Cache-Control', 'no-store, max-age=0');
  }
  return payload;
});

server.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  },
});

function hasStudyLaunchQuery(req: FastifyRequest): boolean {
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.has('StudyInstanceUIDs') || url.searchParams.has('StudyInstanceUID');
}

function launchStudyUids(req: FastifyRequest): string[] {
  const url = new URL(req.url, 'http://localhost');
  return [...url.searchParams.getAll('StudyInstanceUIDs'), ...url.searchParams.getAll('StudyInstanceUID')]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function isEcgLaunch(req: FastifyRequest): Promise<boolean> {
  const studyInstanceUids = launchStudyUids(req);
  if (!studyInstanceUids.length) return false;
  try {
    const records = (await Promise.all(studyInstanceUids.map((studyInstanceUid) => fetchStudyMetadata({ StudyInstanceUID: studyInstanceUid })))).flat();
    return records.some((record) => {
      const modality = record['00080060']?.Value?.[0];
      return typeof modality === 'string' && modality.toUpperCase() === 'ECG';
    });
  } catch (error) {
    logger.warn(`failed to detect ECG launch: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

server.get('/', (_req: FastifyRequest, reply: FastifyReply) => {
  return reply.code(204).send();
});

server.get('/viewer', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!hasStudyLaunchQuery(req)) {
    return reply.code(204).send();
  }

  if (await isEcgLaunch(req)) {
    return reply.sendFile('ecg-viewer.html');
  }

  return reply.sendFile('index.html');
});

server.get('/viewer/', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!hasStudyLaunchQuery(req)) {
    return reply.code(204).send();
  }

  if (await isEcgLaunch(req)) {
    return reply.sendFile('ecg-viewer.html');
  }

  return reply.sendFile('index.html');
});

server.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
  reply.sendFile('index.html');
});

server.register(fastifyCors, {});
server.register(fastifySensible);
server.register(fastifyHelmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  hsts: false,
});
server.register(fastifyAutoload, {
  dir: path.join(__dirname, 'routes'),
});
server.register(fastifyAutoload, {
  dir: path.join(__dirname, 'routes'),
  options: { prefix: '/viewer' },
});

server.setErrorHandler((err, _req, reply) => {
  logger.error(err);
  reply.send(err);
});

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception received:');
  logger.error(err.stack ?? err.message);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection received:');
  logger.error(reason);
});

closeWithGrace({ delay: 500 }, async ({ signal, err, manual }) => {
  if (err) {
    logger.error(err);
  }
  logger.info('shutting down...', signal, manual);
  try {
    await server.close();
    await shutdown();
  } catch (error) {
    logger.error(error);
  }
});

async function start() {
  await ensureDirectories();

  const port = config.get<number>(ConfParams.HTTP_PORT);
  const host = config.get<string>(ConfParams.HTTP_IP);
  logger.info('starting...');

  await server.listen({ port, host });
  logger.info(`web-server listening on port: ${port}`);
  startScp();
  startStorageArrivalWatcher();
  // Decoder workers are spawned lazily otherwise, and the first study after a start pays
  // the python+openjpeg start per worker (measured 779 ms/frame cold vs 14 ms with warm
  // workers). Warm the whole pool; the count is capped by DICOMWEB_J2K_WORKERS.
  warmJpeg2000DecoderPool(Number(process.env.DICOMWEB_J2K_WARM_WORKERS || 4));
  startMetadataSyncScheduler();
}

start().catch((error) => {
  logger.error(error);
  process.exit(1);
});
