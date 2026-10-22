import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config, ConfParams } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';

/**
 * Persistent (disk) tier for the WADO-RS frame response cache.
 *
 * Why: the in-memory `frameResponseCache` in wadoRs.ts is per-process and dies on
 * restart, so the first open of a study after a restart (or by a different
 * radiologist / different device) is always cold. This tier keeps the exact bytes
 * that were served on disk, so any client hitting the same frame URL later gets the
 * identical response without a re-decode / re-render.
 *
 * Retention is time-boxed by DICOMWEB_FRAME_DISK_CACHE_DAYS (default 14 days) and
 * space-boxed by DICOMWEB_FRAME_DISK_CACHE_MB (default 8192 MB), evicted LRU by file
 * mtime (touched on every hit).
 */

const MAGIC = 'VEXAFDC1';
const HEADER_SEPARATOR = Buffer.from('\n', 'utf8');

const diskCacheEnabled = String(process.env.DICOMWEB_FRAME_DISK_CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const diskCacheMaxBytes = Math.max(8, Number(process.env.DICOMWEB_FRAME_DISK_CACHE_MB || 8192)) * 1024 * 1024;
const diskCacheMaxAgeMs = Math.max(1, Number(process.env.DICOMWEB_FRAME_DISK_CACHE_DAYS || 14)) * 24 * 60 * 60 * 1000;
const diskCacheMaxEntryBytes = Math.max(1, Number(process.env.DICOMWEB_FRAME_DISK_CACHE_MAX_ENTRY_MB || 64)) * 1024 * 1024;
const statsIntervalMs = Math.max(0, Number(process.env.DICOMWEB_FRAME_STATS_INTERVAL_S || 900)) * 1000;
const configuredDir = String(process.env.DICOMWEB_FRAME_DISK_CACHE_DIR || '').trim();

const counters = {
  l1Hits: 0,
  l2Hits: 0,
  misses: 0,
  promotions: 0,
  writes: 0,
  writeErrors: 0,
  readErrors: 0,
  staleInvalidations: 0,
  evictions: 0,
  expired: 0,
  bytesWritten: 0,
  bytesServedFromDisk: 0,
  skippedTooLarge: 0,
};

let resolvedDir: string | null = null;
let readyPromise: Promise<void> | null = null;
let cachedBytes = 0;
let sweepTimer: NodeJS.Timeout | null = null;
let sweepScheduled = false;
let lastSweepAt = 0;
let lastSweepMs = 0;
let lastError: string | null = null;
let lastStatsLogAt = 0;
let inFlightWrites = 0;

export interface DiskFramePayload {
  contentType: string;
  etag: string;
  buffer: Buffer;
  sourceSize: number;
  sourceMtimeMs: number;
  rows?: number;
  columns?: number;
  dataType?: string;
}

export interface DiskFrameEntry {
  contentType: string;
  etag: string;
  buffer: Buffer;
  rows?: number;
  columns?: number;
  dataType?: string;
}

function getDir(): string {
  if (resolvedDir) {
    return resolvedDir;
  }

  if (configuredDir) {
    resolvedDir = path.resolve(configuredDir);
    return resolvedDir;
  }

  // Keep the cache OUTSIDE the DICOM storage tree: the PACS walks storage to find
  // study folders, and a cache directory in there can be mistaken for a study.
  const storagePath = config.get<string>(ConfParams.STORAGE_PATH);
  resolvedDir = storagePath
    ? path.resolve(path.join(storagePath, '..', 'frame-cache'))
    : path.resolve(process.cwd(), 'frame-cache');
  return resolvedDir;
}

function entryFile(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex');
  return path.join(getDir(), hash.slice(0, 2), `${hash}.vfc`);
}

function encodeEntry(payload: DiskFramePayload): Buffer {
  const meta = {
    contentType: payload.contentType,
    etag: payload.etag,
    sourceSize: payload.sourceSize,
    sourceMtimeMs: payload.sourceMtimeMs,
    rows: payload.rows,
    columns: payload.columns,
    dataType: payload.dataType,
    bytes: payload.buffer.byteLength,
    storedAt: Date.now(),
  };
  return Buffer.concat([Buffer.from(`${MAGIC}\n${JSON.stringify(meta)}\n`, 'utf8'), payload.buffer]);
}

function decodeEntry(raw: Buffer): { meta: Record<string, unknown>; buffer: Buffer } | null {
  if (raw.byteLength < MAGIC.length + 3 || raw.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
    return null;
  }
  const firstBreak = raw.indexOf(HEADER_SEPARATOR, MAGIC.length);
  if (firstBreak < 0) {
    return null;
  }
  const secondBreak = raw.indexOf(HEADER_SEPARATOR, firstBreak + 1);
  if (secondBreak < 0) {
    return null;
  }
  const metaRaw = raw.subarray(firstBreak + 1, secondBreak).toString('utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(metaRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
  return { meta: parsed, buffer: raw.subarray(secondBreak + 1) };
}

async function collectFiles(): Promise<Array<{ file: string; size: number; mtimeMs: number }>> {
  const dir = getDir();
  const collected: Array<{ file: string; size: number; mtimeMs: number }> = [];
  let shards: string[];
  try {
    shards = await fs.readdir(dir);
  } catch {
    return collected;
  }

  for (const shard of shards) {
    const shardPath = path.join(dir, shard);
    let entries: string[];
    try {
      const stat = await fs.stat(shardPath);
      if (!stat.isDirectory()) {
        continue;
      }
      entries = await fs.readdir(shardPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = path.join(shardPath, name);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) {
          continue;
        }
        if (name.endsWith('.tmp')) {
          // Leftover from an interrupted write.
          if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
            await fs.unlink(file).catch(() => undefined);
          }
          continue;
        }
        collected.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return collected;
}

async function sweep(): Promise<void> {
  if (!diskCacheEnabled) {
    return;
  }
  const startedAt = Date.now();
  try {
    const files = await collectFiles();
    const now = Date.now();
    const stale: typeof files = [];
    const fresh: typeof files = [];

    for (const item of files) {
      if (now - item.mtimeMs > diskCacheMaxAgeMs) {
        stale.push(item);
      } else {
        fresh.push(item);
      }
    }

    for (const item of stale) {
      try {
        await fs.unlink(item.file);
        counters.expired += 1;
      } catch {
        // ignore
      }
    }

    let total = fresh.reduce((sum, item) => sum + item.size, 0);
    if (total > diskCacheMaxBytes) {
      fresh.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of fresh) {
        if (total <= diskCacheMaxBytes) {
          break;
        }
        try {
          await fs.unlink(item.file);
          total -= item.size;
          counters.evictions += 1;
        } catch {
          // ignore
        }
      }
    }

    cachedBytes = total;
    lastSweepAt = Date.now();
    lastSweepMs = lastSweepAt - startedAt;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
}

function scheduleSweep(delayMs = 3000): void {
  if (!diskCacheEnabled || sweepScheduled) {
    return;
  }
  sweepScheduled = true;
  const timer = setTimeout(() => {
    sweepScheduled = false;
    void sweep();
  }, delayMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

async function ensureReady(): Promise<void> {
  if (!diskCacheEnabled) {
    return;
  }
  if (!readyPromise) {
    readyPromise = (async () => {
      const dir = getDir();
      await fs.mkdir(dir, { recursive: true });
      await sweep();
      const interval = Math.max(60 * 1000, Math.min(diskCacheMaxAgeMs, 10 * 60 * 1000));
      sweepTimer = setInterval(() => {
        void sweep();
      }, interval);
      if (typeof sweepTimer.unref === 'function') {
        sweepTimer.unref();
      }
    })().catch((error) => {
      readyPromise = null;
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });
  }
  await readyPromise;
}

export function isFrameDiskCacheEnabled(): boolean {
  return diskCacheEnabled;
}

export async function getFrameDiskCacheEntry(
  key: string,
  sourceSize: number,
  sourceMtimeMs: number,
): Promise<DiskFrameEntry | null> {
  if (!diskCacheEnabled) {
    return null;
  }
  const file = entryFile(key);
  try {
    await ensureReady();
    const raw = await fs.readFile(file);
    const decoded = decodeEntry(raw);
    if (!decoded) {
      await fs.unlink(file).catch(() => undefined);
      counters.staleInvalidations += 1;
      return null;
    }

    const metaSize = Number(decoded.meta.sourceSize);
    const metaMtime = Number(decoded.meta.sourceMtimeMs);
    if (metaSize !== sourceSize || metaMtime !== sourceMtimeMs) {
      await fs.unlink(file).catch(() => undefined);
      counters.staleInvalidations += 1;
      return null;
    }

    // Touch mtime so LRU eviction sees this as fresh.
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => undefined);

    counters.l2Hits += 1;
    counters.bytesServedFromDisk += decoded.buffer.byteLength;
    return {
      contentType: String(decoded.meta.contentType ?? ''),
      etag: String(decoded.meta.etag ?? ''),
      buffer: decoded.buffer,
      rows: decoded.meta.rows === undefined ? undefined : Number(decoded.meta.rows),
      columns: decoded.meta.columns === undefined ? undefined : Number(decoded.meta.columns),
      dataType: decoded.meta.dataType === undefined ? undefined : String(decoded.meta.dataType),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      counters.readErrors += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
    return null;
  }
}

export async function putFrameDiskCacheEntry(key: string, payload: DiskFramePayload): Promise<void> {
  if (!diskCacheEnabled) {
    return;
  }
  if (payload.buffer.byteLength > diskCacheMaxEntryBytes || payload.buffer.byteLength > diskCacheMaxBytes) {
    counters.skippedTooLarge += 1;
    return;
  }
  if (inFlightWrites > 8) {
    // Protect the disk from a burst of concurrent clients; the in-memory tier still serves them.
    counters.skippedTooLarge += 1;
    return;
  }

  inFlightWrites += 1;
  try {
    await ensureReady();
    const file = entryFile(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmp, encodeEntry(payload));
    await fs.rename(tmp, file);
    cachedBytes += payload.buffer.byteLength;
    counters.writes += 1;
    counters.bytesWritten += payload.buffer.byteLength;
    if (cachedBytes > diskCacheMaxBytes) {
      scheduleSweep();
    }
  } catch (error) {
    counters.writeErrors += 1;
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    inFlightWrites -= 1;
  }
}

function diskHitRate(): number {
  const total = counters.l1Hits + counters.l2Hits + counters.misses;
  return total ? Number(((counters.l1Hits + counters.l2Hits) / total).toFixed(4)) : 0;
}

/**
 * Called for every frame access decision. Also emits a one-line rolling summary so the
 * disk tier can be judged from the PACS log without polling an endpoint.
 */
export function noteFrameCacheAccess(layer: 'l1' | 'l2' | 'miss'): void {
  if (layer === 'l1') {
    counters.l1Hits += 1;
  } else if (layer === 'miss') {
    counters.misses += 1;
  }

  if (statsIntervalMs <= 0) {
    return;
  }
  const now = Date.now();
  if (lastStatsLogAt && now - lastStatsLogAt < statsIntervalMs) {
    return;
  }
  lastStatsLogAt = now;
  LoggerSingleton.Instance.info(
    `[frame-cache] memory=${counters.l1Hits} disk=${counters.l2Hits} miss=${counters.misses}` +
      ` hitRate=${diskHitRate()} writes=${counters.writes} diskMb=${Math.round(cachedBytes / 1024 / 1024)}` +
      ` evicted=${counters.evictions} expired=${counters.expired}`,
  );
}

export function getFrameDiskCacheStats() {
  if (diskCacheEnabled && !readyPromise) {
    // Pindai isi disk sekali supaya angka byte/entri tidak 0 sebelum ada request pertama.
    void ensureReady();
  }

  return {
    enabled: diskCacheEnabled,
    dir: diskCacheEnabled ? getDir() : null,
    initialized: readyPromise !== null,
    maxBytes: diskCacheMaxBytes,
    maxAgeDays: Math.round(diskCacheMaxAgeMs / (24 * 60 * 60 * 1000)),
    maxEntryBytes: diskCacheMaxEntryBytes,
    bytes: cachedBytes,
    l1Hits: counters.l1Hits,
    l2Hits: counters.l2Hits,
    misses: counters.misses,
    promotions: counters.promotions,
    hitRate: diskHitRate(),
    writes: counters.writes,
    writeErrors: counters.writeErrors,
    readErrors: counters.readErrors,
    staleInvalidations: counters.staleInvalidations,
    evictions: counters.evictions,
    expired: counters.expired,
    bytesWritten: counters.bytesWritten,
    bytesServedFromDisk: counters.bytesServedFromDisk,
    skipped: counters.skippedTooLarge,
    inFlightWrites,
    lastSweepAt: lastSweepAt ? new Date(lastSweepAt).toISOString() : null,
    lastSweepMs,
    lastError,
  };
}

export async function sweepFrameDiskCache(): Promise<void> {
  await ensureReady();
  await sweep();
}

export function noteFrameCachePromotion(): void {
  counters.promotions += 1;
}
