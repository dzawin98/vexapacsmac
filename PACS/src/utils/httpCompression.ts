import { createHash } from 'crypto';
import { FastifyInstance, FastifyRequest } from 'fastify';
import zlib from 'zlib';

/**
 * Compress JSON metadata responses on the fly.
 *
 * The DICOMweb metadata payloads are extremely repetitive (the same StudyInstanceUID,
 * SeriesInstanceUID and patient tags repeat once per instance), so a 815-instance study
 * manifest is ~1.5 MB raw and ~25 KB gzipped. Before this module the PACS shipped those
 * bytes uncompressed, which is what made the first worklist / study open feel slow on
 * branch links.
 *
 * Encoded bodies are memoised per (encoding, payload) pair because the worklist polls
 * every 30 s with byte-identical payloads between changes; without the memo the server
 * would re-run zlib for every poll of a large worklist.
 */

const MIN_BYTES = Number(process.env.DICOMWEB_HTTP_COMPRESS_MIN_BYTES || 1024);
const CACHE_MAX_BYTES = Number(process.env.DICOMWEB_HTTP_COMPRESS_CACHE_MB || 32) * 1024 * 1024;
const CACHE_MAX_ENTRIES = Number(process.env.DICOMWEB_HTTP_COMPRESS_CACHE_ENTRIES || 120);
const GZIP_LEVEL = Number(process.env.DICOMWEB_HTTP_COMPRESS_LEVEL || 6);
const BROTLI_QUALITY = Number(process.env.DICOMWEB_HTTP_BROTLI_QUALITY || 5);

export function httpCompressionEnabled(): boolean {
  return String(process.env.DICOMWEB_HTTP_COMPRESS || 'true').toLowerCase() !== 'false';
}

const COMPRESSIBLE_PREFIXES = [
  'application/dicom+json',
  'application/json',
  'application/dicom+xml',
  'application/xml',
  'text/',
  'application/javascript',
  'image/svg+xml',
];

const SKIPPED_PREFIXES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/octet-stream',
  'application/zip',
  'application/dicom;',
  'multipart/',
];

function isCompressibleType(contentType: string): boolean {
  const value = contentType.toLowerCase().trim();
  if (!value) return false;
  if (SKIPPED_PREFIXES.some((prefix) => value.startsWith(prefix))) return false;
  // `application/dicom` (raw part-10 payload) is already-compressed pixel data.
  if (/^application\/dicom\b/.test(value) && !value.startsWith('application/dicom+')) return false;
  return COMPRESSIBLE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function negotiateEncoding(header: string | undefined): 'br' | 'gzip' | null {
  const value = String(header || '').toLowerCase();
  if (!value) return null;
  const accepts = (token: string): boolean => {
    const match = new RegExp(`(^|,)\\s*${token}\\s*(;\\s*q=([0-9.]+))?`).exec(value);
    if (!match) return false;
    const q = match[3] ? Number(match[3]) : 1;
    return q > 0;
  };
  const identityBlocked = (): boolean => {
    const match = /(^|,)\s*identity\s*;\s*q=0/.exec(value);
    return Boolean(match) || /\*\s*;\s*q=0($|,)/.test(value);
  };
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return identityBlocked() ? 'gzip' : null;
}

type CacheEntry = { body: Buffer; hits: number };
const encodedBodyCache = new Map<string, CacheEntry>();
let encodedBodyCacheBytes = 0;

const stats = {
  enabled: httpCompressionEnabled(),
  responses: 0,
  compressed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesIn: 0,
  bytesOut: 0,
  skippedSmall: 0,
  skippedType: 0,
  clientsWithoutSupport: 0,
};

export type HttpCompressionStats = typeof stats & {
  ratio: number;
  cacheEntries: number;
  cacheBytes: number;
  cacheMaxBytes: number;
};

export function getHttpCompressionStats(): HttpCompressionStats {
  return {
    ...stats,
    ratio: stats.bytesOut > 0 ? Number((stats.bytesIn / stats.bytesOut).toFixed(2)) : 0,
    cacheEntries: encodedBodyCache.size,
    cacheBytes: encodedBodyCacheBytes,
    cacheMaxBytes: CACHE_MAX_BYTES,
  };
}

function rememberEncodedBody(key: string, body: Buffer): void {
  if (body.length > CACHE_MAX_BYTES) return;
  if (encodedBodyCacheBytes + body.length > CACHE_MAX_BYTES) {
    while (encodedBodyCache.size && encodedBodyCacheBytes + body.length > CACHE_MAX_BYTES) {
      const oldest = encodedBodyCache.keys().next().value;
      if (oldest === undefined) break;
      const dropped = encodedBodyCache.get(oldest);
      encodedBodyCacheBytes -= dropped ? dropped.body.length : 0;
      encodedBodyCache.delete(oldest);
    }
  }
  encodedBodyCache.set(key, { body, hits: 0 });
  encodedBodyCacheBytes += body.length;
  while (encodedBodyCache.size > CACHE_MAX_ENTRIES) {
    const oldest = encodedBodyCache.keys().next().value;
    if (oldest === undefined) break;
    const dropped = encodedBodyCache.get(oldest);
    encodedBodyCacheBytes -= dropped ? dropped.body.length : 0;
    encodedBodyCache.delete(oldest);
  }
}

/** Drop memoised bodies (used when metadata is re-indexed and payloads change wholesale). */
export function clearHttpCompressionCache(): number {
  const cleared = encodedBodyCache.size;
  encodedBodyCache.clear();
  encodedBodyCacheBytes = 0;
  return cleared;
}

function encodePayload(encoding: 'br' | 'gzip', payload: Buffer): Buffer | null {
  try {
    if (encoding === 'br') {
      return zlib.brotliCompressSync(payload, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: payload.length,
        },
      });
    }
    return zlib.gzipSync(payload, { level: GZIP_LEVEL });
  } catch {
    return null;
  }
}

export function registerHttpCompression(server: FastifyInstance): void {
  if (!httpCompressionEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[http-compression] disabled via DICOMWEB_HTTP_COMPRESS=false');
    return;
  }

  server.addHook('onSend', async (req: FastifyRequest, reply, payload) => {
    if (payload === null || payload === undefined) return payload;
    if (req.method === 'HEAD') return payload;

    const status = reply.statusCode;
    if (status < 200 || status >= 300 || status === 204 || status === 304) return payload;
    if (reply.getHeader('content-encoding')) return payload;

    const contentType = String(reply.getHeader('content-type') || '');
    if (!isCompressibleType(contentType)) {
      stats.skippedType += 1;
      return payload;
    }

    let buffer: Buffer | null = null;
    if (typeof payload === 'string') buffer = Buffer.from(payload, 'utf8');
    else if (Buffer.isBuffer(payload)) buffer = payload;
    if (!buffer) return payload;

    if (buffer.length < MIN_BYTES) {
      stats.skippedSmall += 1;
      return payload;
    }
    stats.responses += 1;

    const encoding = negotiateEncoding(req.headers['accept-encoding'] as string | undefined);
    if (!encoding) {
      stats.clientsWithoutSupport += 1;
      return payload;
    }

    const key = `${encoding}:${buffer.length}:${createHash('sha1').update(buffer).digest('hex')}`;
    const cached = encodedBodyCache.get(key);
    if (cached) {
      stats.cacheHits += 1;
      cached.hits += 1;
    }
    const body = cached ? cached.body : encodePayload(encoding, buffer);
    if (!body) return payload;
    if (!cached) {
      stats.cacheMisses += 1;
      rememberEncodedBody(key, body);
    }

    stats.compressed += 1;
    stats.bytesIn += buffer.length;
    stats.bytesOut += body.length;

    reply.header('content-encoding', encoding);
    reply.header('vary', 'Accept-Encoding');
    reply.removeHeader('content-length');
    reply.header('content-length', String(body.length));
    return body;
  });
}
