/**
 * Verify cooperative cancellation of a study merge.
 *
 * Starts a real merge over several series, requests cancellation while it runs,
 * then asserts the contract:
 *   - the merge stops between series (never mid-file),
 *   - series already moved stay in the target, the rest stay in the source,
 *   - both studies are indexed consistently afterwards,
 *   - the operation is marked `cancelled` and remains restorable,
 *   - re-running the merge finishes the remaining series.
 *
 * Usage: node scripts/verify-manager-cancel.js [--series=6] [--instances=10] [--image=512]
 */
const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.DICOMWEB_PACS_STORAGE_PATH = process.env.DICOMWEB_PACS_STORAGE_PATH
  || path.resolve(__dirname, '..', '..', '..', 'DATA');
// One file at a time keeps a series long enough that a cancel request reliably
// lands in the middle of the merge instead of after it, and a short cancel poll
// makes the mid-series stop observable within the same series.
process.env.DICOMWEB_MANAGER_MOVE_CONCURRENCY = process.env.DICOMWEB_MANAGER_MOVE_CONCURRENCY || '1';
process.env.DICOMWEB_MANAGER_CANCEL_POLL_MS = process.env.DICOMWEB_MANAGER_CANCEL_POLL_MS || '50';

const { PNG } = require('pngjs');
const service = require('../src/services/dicomwebPacsService');
const risDb = require('../src/services/db');

function numberArg(name, fallback) {
  const raw = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// --keep leaves both temporary studies in place for post-run inspection.
const KEEP_ARTIFACTS = process.argv.includes('--keep');
const SERIES_COUNT = numberArg('series', 6);
const INSTANCES_PER_SERIES = numberArg('instances', 10);
const IMAGE_SIZE = numberArg('image', 512);

const STORAGE_ROOT = path.resolve(process.env.DICOMWEB_PACS_STORAGE_PATH);
const MANAGER_HISTORY_ROOT = path.join(STORAGE_ROOT, '.manager-history');
const stamp = Date.now();
const sourceStudyUid = `1.2.826.0.1.3680043.10.5432.9988.${stamp}.1`;
const targetStudyUid = `1.2.826.0.1.3680043.10.5432.9988.${stamp}.2`;
const sourceSeriesUids = [];
const sourceSopsBySeries = new Map();
let targetSeriesUid = '';
let firstOperationId = '';
let secondOperationId = '';

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
    console.error(`[cancel-qa] --keep set, leaving artifacts: source=${sourceStudyUid} target=${targetStudyUid} ops=${firstOperationId},${secondOperationId}`);
    return;
  }
  for (const studyUid of [sourceStudyUid, targetStudyUid]) {
    await service.deleteStudy(studyUid).catch(() => {});
    await fs.rm(path.join(STORAGE_ROOT, '.metadata-backups', studyUid), { recursive: true, force: true }).catch(() => {});
    await risDb.query('DELETE FROM dicomweb_pacs_deleted_resources WHERE resource_uid = ?', [studyUid]).catch(() => {});
    await risDb.query('DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?', [studyUid]).catch(() => {});
  }
  const db = service.getPacsMetadataDb();
  for (const id of [firstOperationId, secondOperationId].filter(Boolean)) {
    await db.query('DELETE FROM pacs_manager_operations WHERE id = ?', [id]).catch(() => {});
    await fs.rm(path.resolve(MANAGER_HISTORY_ROOT, id), { recursive: true, force: true }).catch(() => {});
  }
}

async function indexState(studyUid, sopUids) {
  const sops = (sopUids || []).filter(Boolean);
  if (!sops.length) return 0;
  const db = service.getPacsMetadataDb();
  const [rows] = await db.query(
    'SELECT COUNT(*) AS count FROM pacs_instances WHERE study_instance_uid = ? AND sop_instance_uid IN (?)',
    [studyUid, sops]
  );
  return Number(rows?.[0]?.count || 0);
}

async function waitForIndexed(studyUid, sopUids, timeoutMs = 30000) {
  const startedAt = Date.now();
  for (;;) {
    const indexed = await indexState(studyUid, sopUids);
    if (indexed >= sopUids.length) return { indexed, waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt > timeoutMs) return { indexed, waitedMs: Date.now() - startedAt, timedOut: true };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function run() {
  await service.createStudyPlaceholder({
    studyInstanceUid: sourceStudyUid,
    patientId: `CANCEL-SRC-${stamp}`,
    patientName: 'QA^CANCEL^SOURCE',
    accessionNumber: `CANCEL-SRC-${stamp}`,
    modality: 'OT',
    studyDescription: 'Temporary cancellation QA source',
  });
  await service.createStudyPlaceholder({
    studyInstanceUid: targetStudyUid,
    patientId: `CANCEL-TGT-${stamp}`,
    patientName: 'QA^CANCEL^TARGET',
    accessionNumber: `CANCEL-TGT-${stamp}`,
    modality: 'OT',
    studyDescription: 'Temporary cancellation QA target',
  });
  targetSeriesUid = (await service.createSeriesPlaceholder(targetStudyUid, {
    modality: 'OT',
    seriesNumber: '1',
    seriesDescription: 'QA target series',
  })).seriesInstanceUid;

  const base64 = buildPng();
  const allSourceSops = [];
  for (let seriesIndex = 0; seriesIndex < SERIES_COUNT; seriesIndex += 1) {
    const seriesUid = (await service.createSeriesPlaceholder(sourceStudyUid, {
      modality: 'OT',
      seriesNumber: String(seriesIndex + 2),
      seriesDescription: `QA source series ${seriesIndex + 1}`,
    })).seriesInstanceUid;
    sourceSeriesUids.push(seriesUid);
    const sops = [];
    for (let instanceIndex = 0; instanceIndex < INSTANCES_PER_SERIES; instanceIndex += 1) {
      const image = await service.createImageFromUpload(sourceStudyUid, seriesUid, {
        fileName: `cancel-${seriesIndex}-${instanceIndex}.png`,
        mimeType: 'image/png',
        base64,
        instanceNumber: String(instanceIndex + 1),
        imageComments: 'verify-manager-cancel',
      });
      sops.push(image.sopInstanceUid);
      allSourceSops.push(image.sopInstanceUid);
    }
    sourceSopsBySeries.set(seriesUid, sops);
  }
  await waitForIndexed(sourceStudyUid, allSourceSops);

  const journal = await service.beginManagerOperation({
    operationType: 'study_merge',
    sourceStudyUid,
    targetStudyUid,
    username: 'qa-cancel',
    reason: 'Verify cooperative cancellation',
    input: { qa: true },
  });
  firstOperationId = journal.operationId;

  const db = service.getPacsMetadataDb();
  const movePromise = service.moveStudyToStudy(sourceStudyUid, targetStudyUid, {
    operationId: firstOperationId,
    expectedInstances: allSourceSops.length,
  });

  // Cancel as soon as files start landing in the target study: the loop only
  // checks the flag between series, so this lands while later series are pending
  // (progress columns are throttled, so the folder is the faster signal).
  const cancelStartedAt = Date.now();
  let observedProgress = null;
  const targetStudyPath = path.join(STORAGE_ROOT, targetStudyUid);
  let targetFilesBeforeCancel = 0;
  for (;;) {
    targetFilesBeforeCancel = (await fs.readdir(targetStudyPath).catch(() => []))
      .filter(name => !name.startsWith('.')).length;
    if (targetFilesBeforeCancel > 0) break;
    if (Date.now() - cancelStartedAt > 8000) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const [progressRows] = await db.query(
    'SELECT progress_done, progress_total FROM pacs_manager_operations WHERE id = ?',
    [firstOperationId]
  ).catch(() => [[]]);
  observedProgress = progressRows?.[0] || null;
  const cancelRequest = await service.requestManagerOperationCancel(firstOperationId);
  const moved = await movePromise;
  const cancelled = await service.cancelManagerOperation(firstOperationId, moved);
  const operation = await service.getManagerOperation(firstOperationId);
  // A cancelled merge must stay restorable: the panel offers Restore for it, and
  // the preflight used to reject the status outright.
  const cancelPreflight = await service.preflightManagerOperationRestore(firstOperationId)
    .then(preflight => ({ canRestore: preflight.canRestore, conflicts: preflight.conflicts.map(conflict => conflict.code) }))
    .catch(error => ({ canRestore: false, conflicts: [String(error?.message || error)] }));

  const movedSeriesUids = (moved.movedSeries || []).map(item => item.sourceSeriesUid);
  const pendingSeriesUids = moved.pendingSeriesUids || [];
  const sourceFolderPresent = await fs.access(path.join(STORAGE_ROOT, sourceStudyUid)).then(() => true).catch(() => false);

  // Accounting: every source instance is either in the target (moved), still in the
  // source (pending) or reported as unreadable (skipped).
  const movedSops = (moved.movedSeries || []).flatMap(item => (item.movedInstances || []).map(instance => instance.sopInstanceUid));
  const pendingSops = pendingSeriesUids.flatMap(uid => sourceSopsBySeries.get(uid) || []);
  const skippedSops = (moved.skippedInstances || []).map(item => item.sopInstanceUid);
  const movedIndexedUnderTarget = await indexState(targetStudyUid, movedSops);
  const pendingIndexedUnderSource = await indexState(sourceStudyUid, pendingSops);
  const targetFiles = (await fs.readdir(path.join(STORAGE_ROOT, targetStudyUid)).catch(() => []))
    .filter(name => !name.startsWith('.')).length;
  // A series is the atomic unit of the index: no series may end up half in each
  // study, and every pending series must stay visible in the source hierarchy -
  // otherwise its images are stranded in storage with nothing pointing at them.
  const seriesPlacement = [];
  for (const uid of sourceSeriesUids) {
    const sops = sourceSopsBySeries.get(uid) || [];
    seriesPlacement.push({
      uid,
      total: sops.length,
      inTarget: await indexState(targetStudyUid, sops),
      inSource: await indexState(sourceStudyUid, sops),
    });
  }
  const straddlingSeries = seriesPlacement.filter(item => item.inTarget > 0 && item.inSource > 0);
  const whollyMovedSeries = seriesPlacement.filter(item => item.inTarget === item.total && item.inSource === 0);
  const whollyPendingSeries = seriesPlacement.filter(item => item.inSource === item.total && item.inTarget === 0);
  const sourceSeriesAfterCancel = await service.getSeries(sourceStudyUid, { fresh: '1' }).catch(() => ({ data: [] }));
  const visibleSourceSeriesUids = (sourceSeriesAfterCancel.data || [])
    .map(series => String(series?.['0020000E']?.Value?.[0] || ''))
    .filter(Boolean);
  const pendingSeriesVisible = pendingSeriesUids.filter(uid => visibleSourceSeriesUids.includes(uid)).length;
  const [seriesRows] = await service.getPacsMetadataDb().query(
    'SELECT series_instance_uid, instance_count FROM pacs_series WHERE study_instance_uid = ?',
    [sourceStudyUid]
  );
  const [instanceGroups] = await service.getPacsMetadataDb().query(
    'SELECT series_instance_uid, COUNT(*) AS c FROM pacs_instances WHERE study_instance_uid = ? GROUP BY series_instance_uid',
    [sourceStudyUid]
  );
  const countBySeries = new Map((instanceGroups || []).map(row => [String(row.series_instance_uid), Number(row.c)]));
  const staleCounters = (seriesRows || []).filter(row => Number(row.instance_count || 0) !== (countBySeries.get(String(row.series_instance_uid)) || 0));

  // Continue: a second merge must finish exactly the remaining series.
  const resumeJournal = await service.beginManagerOperation({
    operationType: 'study_merge',
    sourceStudyUid,
    targetStudyUid,
    username: 'qa-cancel',
    reason: 'Continue after cancellation',
    input: { qa: true, resumed: true },
  });
  secondOperationId = resumeJournal.operationId;
  const resumed = await service.moveStudyToStudy(sourceStudyUid, targetStudyUid, {
    operationId: secondOperationId,
    expectedInstances: pendingSops.length,
  });
  await service.completeManagerOperation(secondOperationId, resumed);
  const sourceFolderGoneAfterResume = !(await fs.access(path.join(STORAGE_ROOT, sourceStudyUid)).then(() => true).catch(() => false));
  const allIndexedUnderTarget = await indexState(targetStudyUid, allSourceSops);

  const result = {
    config: { series: SERIES_COUNT, instancesPerSeries: INSTANCES_PER_SERIES, imageSize: IMAGE_SIZE, moveConcurrency: process.env.DICOMWEB_MANAGER_MOVE_CONCURRENCY },
    targetFilesBeforeCancel,
    cancelRequestAccepted: cancelRequest.requested,
    observedProgressBeforeCancel: observedProgress,
    cancelled: Boolean(moved.cancelled),
    movedSeriesCount: movedSeriesUids.length,
    pendingSeriesCount: pendingSeriesUids.length,
    movedInstanceCount: movedSops.length,
    pendingInstanceCount: pendingSops.length,
    skippedInstanceCount: skippedSops.length,
    accountedInstances: movedSops.length + pendingSops.length + skippedSops.length,
    totalSourceInstances: allSourceSops.length,
    operationStatus: operation.status,
    operationCancelled: cancelled.status,
    operationRestorable: operation.canRestore,
    cancelPreflight,
    sourceFolderPresentAfterCancel: sourceFolderPresent,
    movedSopsIndexedUnderTarget: `${movedIndexedUnderTarget}/${movedSops.length}`,
    pendingSopsStillUnderSource: `${pendingIndexedUnderSource}/${pendingSops.length}`,
    straddlingSeries: straddlingSeries.map(item => `${String(item.uid).slice(-10)} t=${item.inTarget} s=${item.inSource}`),
    whollyMovedSeries: whollyMovedSeries.length,
    whollyPendingSeries: whollyPendingSeries.length,
    sourceSeriesVisibleAfterCancel: visibleSourceSeriesUids.length,
    pendingSeriesVisibleInSource: `${pendingSeriesVisible}/${pendingSeriesUids.length}`,
    staleSeriesCounters: staleCounters.map(row => `${String(row.series_instance_uid).slice(-10)}:${row.instance_count}`),
    targetFileCount: targetFiles,
    resumedSeriesCount: (resumed.movedSeries || []).length,
    sourceFolderGoneAfterResume,
    allSourceSopsIndexedUnderTarget: `${allIndexedUnderTarget}/${allSourceSops.length}`,
  };
  const passed = result.cancelled
    && result.movedInstanceCount > 0
    && result.pendingInstanceCount > 0
    && result.accountedInstances === result.totalSourceInstances
    && result.operationStatus === 'cancelled'
    && result.operationRestorable === true
    && result.cancelPreflight?.canRestore === true
    && sourceFolderPresent
    && movedIndexedUnderTarget === movedSops.length
    && pendingIndexedUnderSource === pendingSops.length
    && targetFiles === movedSops.length
    && straddlingSeries.length === 0
    && whollyMovedSeries.length === movedSeriesUids.length
    && whollyPendingSeries.length === pendingSeriesUids.length
    && pendingSeriesVisible === pendingSeriesUids.length
    && staleCounters.length === 0
    && resumed.movedSeries.length === pendingSeriesUids.length
    && sourceFolderGoneAfterResume
    && allIndexedUnderTarget === allSourceSops.length;
  result.passed = passed;
  if (!passed) {
    console.log(JSON.stringify(result));
    throw new Error('Cancellation verification failed (see the printed result above)');
  }
  return result;
}

(async () => {
  try {
    const result = await run();
    console.log(JSON.stringify(result));
  } finally {
    await cleanup();
  }
  process.exit(0);
})().catch(async error => {
  await cleanup().catch(() => {});
  console.error(error.stack || error.message);
  process.exit(1);
});
