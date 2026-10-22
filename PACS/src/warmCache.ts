import fs from 'fs/promises';
import path from 'path';
import { getFrameWarmStats, noteStoredInstances, WarmedInstance } from './dimse/frameWarm';
import { ConfParams, config } from './utils/config';
import { LoggerSingleton } from './utils/logger';

/**
 * Warm cache massal untuk studi yang SUDAH ada di storage.
 *
 * Pakai saat pertama kali mengaktifkan cache: supaya studi yang sudah masuk
 * (mis. 14 hari terakhir) langsung hangat untuk semua dokter/device.
 *
 *   npx ts-node src/warmCache.ts --days=14 --limit=50 --max-instances=64
 *   npx ts-node src/warmCache.ts --study=1.2.826.0.1.3680043.10.5432.123   (studi tertentu, tanpa batas umur)
 */
function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

async function listStudyDirectories(storagePath: string): Promise<string[]> {
  const entries = await fs.readdir(storagePath, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
}

/**
 * File non-DICOM (mis. JSON worklist, berkas bantu) tidak boleh ikut dihangatkan:
 * percuma, dan bikin angka kegagalan menyesatkan. Cek murah: preamble DICM atau
 * tag awal group 0002 (explicit VR little endian).
 */
async function looksLikeDicom(filePath: string): Promise<boolean> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(132);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead < 8) return false;
    if (bytesRead >= 132 && buffer.subarray(128, 132).toString('latin1') === 'DICM') return true;
    return buffer[0] === 0x02 && buffer[1] === 0x00;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function main() {
  const logger = LoggerSingleton.Instance;
  const storagePath = path.resolve(String(config.get(ConfParams.STORAGE_PATH)));
  const days = Number(argValue('--days', '14'));
  const limit = Number(argValue('--limit', '0'));
  const studyFilter = argValue('--study', '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const stats0 = getFrameWarmStats();
  const maxInstances = Number(argValue('--max-instances', String(stats0.maxInstances)));
  const cutoff = studyFilter.length ? 0 : Date.now() - days * 24 * 3600 * 1000;
  const startedAt = Date.now();

  const studies = await listStudyDirectories(storagePath);
  const targets: Array<{ study: string; instances: WarmedInstance[]; newest: number }> = [];
  let skippedNotDicom = 0;
  let skippedByFilter = 0;

  for (const study of studies) {
    if (studyFilter.length && !studyFilter.includes(study)) {
      skippedByFilter += 1;
      continue;
    }
    const studyDir = path.join(storagePath, study);
    const files = await fs.readdir(studyDir).catch(() => [] as string[]);
    const instances: WarmedInstance[] = [];
    let newest = 0;
    for (const file of files) {
      const fullPath = path.join(studyDir, file);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || !stat.isFile() || stat.mtimeMs < cutoff) continue;
      if (!(await looksLikeDicom(fullPath))) {
        skippedNotDicom += 1;
        continue;
      }
      newest = Math.max(newest, stat.mtimeMs);
      instances.push({ studyInstanceUid: study, seriesInstanceUid: '', sopInstanceUid: file });
    }
    if (instances.length) targets.push({ study, instances, newest });
  }

  targets.sort((a, b) => b.newest - a.newest);
  const selected = limit > 0 ? targets.slice(0, limit) : targets;
  logger.info(
    `warm-cache: ${selected.length} studi (maks ${days} hari terakhir${studyFilter.length ? ', filter --study aktif' : ''}), maks ${maxInstances} instance/studi, paralel ${stats0.concurrency}, anggaran ${Math.round(stats0.budgetMs / 1000)}s/studi` +
      (skippedNotDicom ? `, dilewati non-DICOM=${skippedNotDicom}` : '') +
      (skippedByFilter ? `, dilewati filter=${skippedByFilter}` : '')
  );

  const before = getFrameWarmStats();
  for (const target of selected) {
    noteStoredInstances(target.instances.slice(0, maxInstances));
  }

  // tunggu antrian warmer selesai (quiet period + pemrosesan)
  for (let i = 0; i < 7200; i += 1) {
    const stats = getFrameWarmStats();
    if (stats.queuedStudies === 0 && stats.pendingStudies === 0 && stats.studiesInFlight === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const after = getFrameWarmStats();
  type CounterKey = keyof typeof after;
  const delta = (key: CounterKey) => (after[key] as number) - (before[key] as number);
  const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const warmed = delta('instancesWarmed');
  logger.info(
    `warm-cache selesai: studi=${delta('studiesWarmed')} instance=${warmed} thumbnail=${delta('thumbnailsWarmed')} preview=${delta('previewsWarmed')} raw=${delta('rawsWarmed')} gagal=${delta('failures')} nonImage=${delta('skippedNonImage')} anggaranLewat=${delta('budgetExceeded')} durasi=${elapsedSec.toFixed(1)}s kecepatan=${(warmed / elapsedSec).toFixed(1)} instance/s`
  );
}

main().catch((error) => {
  LoggerSingleton.Instance.error({ error }, 'warm-cache gagal');
  process.exitCode = 1;
});
