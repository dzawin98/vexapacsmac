import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { ConfParams, config } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';
import { doWadoRsFrame, doWadoRsRendered, doWadoRsThumbnail } from './wadoRs';

/**
 * Warm-on-arrival untuk cache frame.
 *
 * Tujuan: ketika sebuah studi selesai dikirim dari modalitas, PACS langsung
 * mengisi cache gambar (thumbnail + preview viewport) untuk instance pertama,
 * sehingga pembukaan PERTAMA oleh dokter mana pun, di device mana pun, sudah
 * hangat (hit) -- sesuai target 7-14 hari retensi cache.
 *
 * Semua pekerjaan berjalan asinkron (satu antrean studi, tanpa memblokir respons
 * STOW/C-STORE). Per studi: instance diproses paralel sejumlah `concurrency`
 * (menyesuaikan ukuran pool decoder), dibatasi `maxInstances` dan anggaran waktu
 * `budgetMs` supaya studi raksasa tidak mengunci antrean.
 */

export interface WarmedInstance {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
}

interface WarmTally {
  thumbnails: number;
  previews: number;
  raws: number;
  failures: number;
  nonImage: number;
}

const truthy = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const enabled = truthy(process.env.DICOMWEB_FRAME_WARM_ENABLED, true);
const quietMs = Math.max(0, Number(process.env.DICOMWEB_FRAME_WARM_QUIET_MS || 6000));
const maxInstances = Math.max(1, Number(process.env.DICOMWEB_FRAME_WARM_MAX_INSTANCES || 64));
const concurrency = Math.max(1, Math.min(16, Number(process.env.DICOMWEB_FRAME_WARM_CONCURRENCY || 4)));
const budgetMs = Math.max(5000, Math.min(3600000, Number(process.env.DICOMWEB_FRAME_WARM_BUDGET_MS || 300000)));
const previewRows = Math.max(64, Number(process.env.DICOMWEB_FRAME_WARM_PREVIEW_ROWS || 512));
const previewColumns = Math.max(64, Number(process.env.DICOMWEB_FRAME_WARM_PREVIEW_COLUMNS || previewRows));
const previewQuality = Math.max(10, Math.min(100, Number(process.env.DICOMWEB_FRAME_WARM_PREVIEW_QUALITY || 70)));
const warmThumbnail = truthy(process.env.DICOMWEB_FRAME_WARM_THUMBNAIL, true);
const warmRaw = truthy(process.env.DICOMWEB_FRAME_WARM_RAW, false);
const logEnabled = truthy(process.env.DICOMWEB_FRAME_WARM_LOG, true);

const counters = {
  studiesQueued: 0,
  studiesWarmed: 0,
  instancesWarmed: 0,
  thumbnailsWarmed: 0,
  previewsWarmed: 0,
  rawsWarmed: 0,
  failures: 0,
  skippedNonImage: 0,
  budgetExceeded: 0,
  skippedDisabled: 0,
};

const pendingStudies = new Map<string, WarmedInstance[]>();
const studyTimers = new Map<string, NodeJS.Timeout>();
const queue: WarmedInstance[][] = [];
let running = false;
let studiesInFlight = 0;

/**
 * Dipanggil setiap kali instance selesai disimpan (STOW-RS / C-STORE).
 * Menunggu tenang `quietMs` supaya seluruh series selesai dulu, baru dihangatkan.
 */
export function noteStoredInstances(instances: WarmedInstance[]) {
  if (!enabled) {
    counters.skippedDisabled += 1;
    return;
  }
  if (!instances.length) return;

  for (const instance of instances) {
    if (!instance.studyInstanceUid || !instance.sopInstanceUid) continue;
    const bucket = pendingStudies.get(instance.studyInstanceUid) || [];
    if (bucket.some((item) => item.sopInstanceUid === instance.sopInstanceUid)) continue;
    bucket.push(instance);
    pendingStudies.set(instance.studyInstanceUid, bucket);

    const previous = studyTimers.get(instance.studyInstanceUid);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      studyTimers.delete(instance.studyInstanceUid);
      const studyInstances = pendingStudies.get(instance.studyInstanceUid) || [];
      pendingStudies.delete(instance.studyInstanceUid);
      if (!studyInstances.length) return;
      counters.studiesQueued += 1;
      queue.push(studyInstances);
      void drainQueue();
    }, quietMs);
    if (typeof timer.unref === 'function') timer.unref();
    studyTimers.set(instance.studyInstanceUid, timer);
  }
}

export function getFrameWarmStats() {
  return {
    enabled,
    quietMs,
    maxInstances,
    concurrency,
    budgetMs,
    previewRows,
    previewColumns,
    previewQuality,
    warmThumbnail,
    warmRaw,
    queuedStudies: queue.length,
    pendingStudies: pendingStudies.size,
    studiesInFlight,
    ...counters,
  };
}

async function drainQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const studyInstances = queue.shift() as WarmedInstance[];
      studiesInFlight += 1;
      try {
        await warmStudy(studyInstances);
      } finally {
        studiesInFlight -= 1;
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Objek tanpa PixelData (ECG waveform, SR, KO, PDF) memang tidak punya gambar
 * untuk dihangatkan -- jangan dihitung sebagai kegagalan decoder.
 */
function isNonImageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no pixel data|pixeldata not found/i.test(message);
}

async function warmOne(instance: WarmedInstance): Promise<WarmTally> {
  const tally: WarmTally = { thumbnails: 0, previews: 0, raws: 0, failures: 0, nonImage: 0 };
  let nonImageHit = false;

  if (warmThumbnail) {
    try {
      await doWadoRsThumbnail({
        studyInstanceUid: instance.studyInstanceUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        sopInstanceUid: instance.sopInstanceUid,
      });
      tally.thumbnails += 1;
    } catch (error) {
      if (isNonImageError(error)) nonImageHit = true;
      else tally.failures += 1;
    }
  }

  try {
    await doWadoRsRendered({
      studyInstanceUid: instance.studyInstanceUid,
      seriesInstanceUid: instance.seriesInstanceUid,
      sopInstanceUid: instance.sopInstanceUid,
      frame: '1',
      rows: previewRows,
      columns: previewColumns,
      quality: previewQuality,
    });
    tally.previews += 1;
  } catch (error) {
    if (isNonImageError(error)) nonImageHit = true;
    else tally.failures += 1;
  }

  if (warmRaw) {
    try {
      await doWadoRsFrame({
        studyInstanceUid: instance.studyInstanceUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        sopInstanceUid: instance.sopInstanceUid,
        frame: '1',
      });
      tally.raws += 1;
    } catch (error) {
      if (isNonImageError(error)) nonImageHit = true;
      else tally.failures += 1;
    }
  }

  if (nonImageHit && tally.failures === 0 && tally.previews === 0 && tally.thumbnails === 0) {
    tally.nonImage = 1;
  }
  return tally;
}

async function warmStudy(instances: WarmedInstance[]) {
  const logger = LoggerSingleton.Instance;
  const slice = instances.slice(0, maxInstances);
  const deadline = Date.now() + budgetMs;
  const totals: WarmTally = { thumbnails: 0, previews: 0, raws: 0, failures: 0, nonImage: 0 };
  let processed = 0;
  let next = 0;
  let budgetExceeded = false;

  const worker = async () => {
    while (true) {
      if (Date.now() > deadline) {
        budgetExceeded = true;
        return;
      }
      const index = next;
      next += 1;
      if (index >= slice.length) return;
      const tally = await warmOne(slice[index]);
      processed += 1;
      totals.thumbnails += tally.thumbnails;
      totals.previews += tally.previews;
      totals.raws += tally.raws;
      totals.failures += tally.failures;
      totals.nonImage += tally.nonImage;
    }
  };

  const workerCount = Math.min(concurrency, slice.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  counters.studiesWarmed += 1;
  counters.instancesWarmed += processed;
  counters.thumbnailsWarmed += totals.thumbnails;
  counters.previewsWarmed += totals.previews;
  counters.rawsWarmed += totals.raws;
  counters.failures += totals.failures;
  counters.skippedNonImage += totals.nonImage;
  if (budgetExceeded) counters.budgetExceeded += 1;

  if (logEnabled) {
    logger.info(
      `Frame cache warming: study=${instances[0]?.studyInstanceUid || '?'} instances=${processed}/${instances.length} thumbnails=${totals.thumbnails} previews=${totals.previews} raws=${totals.raws} failures=${totals.failures} nonImage=${totals.nonImage}${budgetExceeded ? ' budgetExceeded=true' : ''}`
    );
  }
}

/**
 * Pemantau kedatangan gambar yang tidak bergantung pada jalur transfer.
 *
 * Layout storage VEXAPACS adalah <storage>/<studyInstanceUid>/<sopInstanceUid>,
 * jadi study + sop bisa dibaca langsung dari path tanpa parse header DICOM.
 * Dipakai untuk C-STORE (modalitas), STOW-RS, maupun import manual.
 */
export function startStorageArrivalWatcher() {
  if (!enabled) return;
  if (!truthy(process.env.DICOMWEB_FRAME_WARM_WATCH, true)) return;

  const logger = LoggerSingleton.Instance;
  const storagePath = path.resolve(config.get<string>(ConfParams.STORAGE_PATH));
  let watcher: fsSync.FSWatcher | null = null;

  try {
    watcher = fsSync.watch(storagePath, { recursive: true }, (_event, relative) => {
      if (!relative) return;
      const relativePath = relative.toString().split(path.sep).join('/');
      const parts = relativePath.split('/').filter(Boolean);
      if (parts.length !== 2) return;
      const [studyInstanceUid, sopInstanceUid] = parts;
      if (!studyInstanceUid || !sopInstanceUid || sopInstanceUid.endsWith('.tmp')) return;
      noteStoredInstances([{ studyInstanceUid, seriesInstanceUid: '', sopInstanceUid }]);
    });
    if (typeof watcher.unref === 'function') watcher.unref();
    logger.info(`frame cache warmer watching storage for new studies: ${storagePath}`);
  } catch (error) {
    logger.warn(
      `frame cache warmer could not watch storage (${error instanceof Error ? error.message : String(error)})`
    );
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Ambil path file instance (dipakai untuk diagnosa/verifikasi). */
export async function instanceFileExists(studyInstanceUid: string, sopInstanceUid: string): Promise<boolean> {
  const storagePath = path.resolve(config.get<string>(ConfParams.STORAGE_PATH));
  try {
    await fs.stat(path.join(storagePath, studyInstanceUid, sopInstanceUid));
    return true;
  } catch {
    return false;
  }
}
