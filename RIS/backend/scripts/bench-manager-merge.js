/**
 * Bench + correctness harness for a DICOM Manager *study merge*.
 *
 * Why it exists: "merge di /manager lama sekali" is a wall-clock complaint, and
 * the merge touches four different subsystems (RIS metadata DB, on-disk storage,
 * PACS DIMSE re-ingest, PACS metadata walk). This script builds a throwaway
 * source study with several series, merges it into a throwaway target study with
 * the real service calls, prints the phase breakdown (getManagerTraceStats) and
 * asserts the result before always cleaning up.
 *
 * Usage:
 *   node scripts/bench-manager-merge.js [--series=3] [--instances=4] [--image=512]
 *
 * Requires: PostgreSQL + dicomweb-pacs listening on DICOMWEB_PACS_ROOT (5001).
 */
const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.DICOMWEB_PACS_STORAGE_PATH = process.env.DICOMWEB_PACS_STORAGE_PATH
  || path.resolve(__dirname, '..', '..', '..', 'DATA');

const { PNG } = require('pngjs');
const service = require('../src/services/dicomwebPacsService');
const risDb = require('../src/services/db');

function numberArg(name, fallback) {
  const raw = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SERIES_COUNT = numberArg('series', 3);
const INSTANCES_PER_SERIES = numberArg('instances', 4);
const TARGET_INSTANCES = numberArg('target', 1);
const IMAGE_SIZE = numberArg('image', 512);
// --keep leaves the two temporary studies in place for post-run inspection.
const KEEP_ARTIFACTS = process.argv.includes('--keep');

const STORAGE_ROOT = path.resolve(process.env.DICOMWEB_PACS_STORAGE_PATH);
const MANAGER_HISTORY_ROOT = path.join(STORAGE_ROOT, '.manager-history');
const stamp = Date.now();
const sourceStudyUid = `1.2.826.0.1.3680043.10.5432.9998.${stamp}.1`;
const targetStudyUid = `1.2.826.0.1.3680043.10.5432.9998.${stamp}.2`;
const sourceSeriesUids = [];
const targetSeriesUidSeed = `1.2.826.0.1.3680043.10.5432.9998.${stamp}.3`;
const uploadedSops = [];
let operationId = '';

function buildPng() {
  const png = new PNG({ width: IMAGE_SIZE, height: IMAGE_SIZE });
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const index = (y * IMAGE_SIZE + x) * 4;
      png.data[index] = (x * 3) % 256;
      png.data[index + 1] = (y * 5) % 256;
      png.data[index + 2] = (x + y) % 256;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

async function cleanup() {
  if (KEEP_ARTIFACTS) {
    console.error(`[bench] --keep set, leaving artifacts: source=${sourceStudyUid} target=${targetStudyUid} operation=${operationId}`);
    return;
  }
  for (const studyUid of [sourceStudyUid, targetStudyUid]) {
    await service.deleteStudy(studyUid).catch(() => {});
  }
  const db = service.getPacsMetadataDb();
  if (operationId) {
    await db.query('DELETE FROM pacs_manager_operations WHERE id = ?', [operationId]).catch(() => {});
    const operationDir = path.resolve(MANAGER_HISTORY_ROOT, operationId);
    if (operationDir.startsWith(MANAGER_HISTORY_ROOT)) {
      await fs.rm(operationDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const studyUid of [sourceStudyUid, targetStudyUid]) {
    await fs.rm(path.join(STORAGE_ROOT, '.metadata-backups', studyUid), { recursive: true, force: true }).catch(() => {});
    await risDb.query('DELETE FROM dicomweb_pacs_deleted_resources WHERE resource_uid = ?', [studyUid]).catch(() => {});
    await risDb.query(
      'DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?',
      [studyUid]
    ).catch(() => {});
  }
}

async function waitForIndexed(sopUids, studyUid, timeoutMs = 30000) {
  const db = service.getPacsMetadataDb();
  const startedAt = Date.now();
  for (;;) {
    const [rows] = await db.query(
      'SELECT COUNT(*) AS count FROM pacs_instances WHERE study_instance_uid = ? AND sop_instance_uid IN (?)',
      [studyUid, sopUids]
    );
    const count = Number(rows?.[0]?.count || 0);
    if (count >= sopUids.length) return { indexed: count, waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt > timeoutMs) return { indexed: count, waitedMs: Date.now() - startedAt, timedOut: true };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function run() {
  const setupStartedAt = Date.now();
  await service.createStudyPlaceholder({
    studyInstanceUid: sourceStudyUid,
    patientId: `BENCH-SRC-${stamp}`,
    patientName: 'BENCH^MERGE^SOURCE',
    accessionNumber: `BENCH-SRC-${stamp}`,
    modality: 'OT',
    studyDescription: 'Bench manager merge source',
  });
  await service.createStudyPlaceholder({
    studyInstanceUid: targetStudyUid,
    patientId: `BENCH-TGT-${stamp}`,
    patientName: 'BENCH^MERGE^TARGET',
    accessionNumber: `BENCH-TGT-${stamp}`,
    modality: 'OT',
    studyDescription: 'Bench manager merge target',
  });
  const targetSeriesUid = (await service.createSeriesPlaceholder(targetStudyUid, {
    modality: 'OT',
    seriesNumber: '1',
    seriesDescription: 'Bench target series',
  })).seriesInstanceUid;

  const base64 = buildPng();
  for (let seriesIndex = 0; seriesIndex < SERIES_COUNT; seriesIndex += 1) {
    const seriesUid = (await service.createSeriesPlaceholder(sourceStudyUid, {
      modality: 'OT',
      seriesNumber: String(seriesIndex + 2),
      seriesDescription: `Bench source series ${seriesIndex + 1}`,
    })).seriesInstanceUid;
    sourceSeriesUids.push(seriesUid);
    for (let instanceIndex = 0; instanceIndex < INSTANCES_PER_SERIES; instanceIndex += 1) {
      const image = await service.createImageFromUpload(sourceStudyUid, seriesUid, {
        fileName: `bench-${seriesIndex}-${instanceIndex}.png`,
        mimeType: 'image/png',
        base64,
        instanceNumber: String(instanceIndex + 1),
        imageComments: 'bench-manager-merge',
      });
      uploadedSops.push(image.sopInstanceUid);
    }
  }
  const seed = await service.createImageFromUpload(targetStudyUid, targetSeriesUid, {
    fileName: 'bench-target-seed.png',
    mimeType: 'image/png',
    base64,
    instanceNumber: '1',
    imageComments: 'bench-manager-merge seed',
  });
  for (let index = 1; index < TARGET_INSTANCES; index += 1) {
    await service.createImageFromUpload(targetStudyUid, targetSeriesUid, {
      fileName: `bench-target-${index}.png`,
      mimeType: 'image/png',
      base64,
      instanceNumber: String(index + 1),
      imageComments: 'bench-manager-merge target filler',
    });
  }
  const setupIndex = await waitForIndexed(uploadedSops, sourceStudyUid);
  const setupMs = Date.now() - setupStartedAt;

  const bytesOnDisk = (await Promise.all(uploadedSops.map((sop) => fs.stat(path.join(STORAGE_ROOT, sourceStudyUid, sop))
    .then(stat => stat.size)
    .catch(() => 0)))).reduce((total, size) => total + size, 0);

  service.resetManagerTraceStats();
  const beginStartedAt = Date.now();
  const journal = await service.beginManagerOperation({
    operationType: 'study_merge',
    sourceStudyUid,
    targetStudyUid,
    username: 'bench',
    reason: 'bench-manager-merge harness',
    input: { bench: true },
  });
  operationId = journal.operationId;
  const beginMs = Date.now() - beginStartedAt;

  const moveStartedAt = Date.now();
  const moved = await service.moveStudyToStudy(sourceStudyUid, targetStudyUid, {
    operationId,
    expectedInstances: uploadedSops.length,
  });
  const moveMs = Date.now() - moveStartedAt;

  const completeStartedAt = Date.now();
  await service.completeManagerOperation(operationId, moved);
  const completeMs = Date.now() - completeStartedAt;

  const trace = service.getManagerTraceStats();

  const db = service.getPacsMetadataDb();
  const [indexed] = await db.query(
    'SELECT COUNT(*) AS count FROM pacs_instances WHERE study_instance_uid = ? AND sop_instance_uid IN (?)',
    [targetStudyUid, uploadedSops]
  );
  // The merge reports live progress on the operation row; assert it finished.
  const [progressRows] = await db.query(
    'SELECT progress_stage, progress_done, progress_total FROM pacs_manager_operations WHERE id = ?',
    [operationId]
  ).catch(() => [[]]);
  const operationProgress = progressRows?.[0]
    ? {
      stage: progressRows[0].progress_stage || null,
      done: Number(progressRows[0].progress_done || 0),
      total: Number(progressRows[0].progress_total || 0),
    }
    : null;
  const sourceFolderPresent = await fs.access(path.join(STORAGE_ROOT, sourceStudyUid)).then(() => true).catch(() => false);
  const targetFiles = (await fs.readdir(path.join(STORAGE_ROOT, targetStudyUid)).catch(() => []))
    .filter(name => !name.startsWith('.')).length;
  const [staleRows] = await db.query(
    'SELECT COUNT(*) AS count FROM pacs_instances WHERE study_instance_uid = ?',
    [sourceStudyUid]
  );

  const result = {
    config: {
      series: SERIES_COUNT,
      instancesPerSeries: INSTANCES_PER_SERIES,
      sourceInstances: uploadedSops.length,
      imageSize: IMAGE_SIZE,
      sourceBytesOnDisk: bytesOnDisk,
    },
    setupMs,
    setupIndex,
    beginMs,
    moveMs,
    completeMs,
    totalMergeMs: beginMs + moveMs + completeMs,
    movedSeriesCount: moved.movedSeries?.length || 0,
    sourceStudyRemoved: moved.sourceStudyRemoved,
    targetRefreshStatus: moved.movedSeries?.[0]?.targetRefresh?.status || null,
    studyTargetRefresh: {
      status: moved.targetRefresh?.status || null,
      mode: moved.targetRefresh?.mode || null,
      recoveredFiles: moved.targetRefresh?.recoveredFiles?.length || 0,
      indexSync: moved.targetRefresh?.indexSync || null,
    },
    skippedInstanceCount: moved.skippedInstances?.length || 0,
    operationProgress,
    verify: {
      sourceInstancesIndexedUnderTarget: Number(indexed?.[0]?.count || 0),
      expectedInstances: uploadedSops.length,
      sourceFolderPresent,
      targetFileCount: targetFiles,
      staleSourceIndexRows: Number(staleRows?.[0]?.count || 0),
      seedInstancePresent: Boolean(seed.sopInstanceUid),
    },
    phases: trace,
  };
  const passed = result.verify.sourceInstancesIndexedUnderTarget === uploadedSops.length
    && !sourceFolderPresent
    && result.verify.staleSourceIndexRows === 0
    && result.verify.targetFileCount === uploadedSops.length + TARGET_INSTANCES
    && result.operationProgress?.stage === 'done'
    && result.operationProgress?.done === uploadedSops.length;
  result.passed = passed;
  if (!passed) throw new Error(`Bench assertions failed: ${JSON.stringify(result.verify)}`);
  return result;
}

(async () => {
  try {
    const result = await run();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await cleanup();
  }
  process.exit(0);
})().catch(async error => {
  await cleanup().catch(() => {});
  console.error(error.stack || error.message);
  process.exit(1);
});
