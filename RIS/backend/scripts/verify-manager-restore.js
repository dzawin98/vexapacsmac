const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const { PNG } = require('pngjs');
// The service reads PACS_DB_* / DICOMWEB_* from the environment; without this the
// script fell back to the shipped default database name and died on connect.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.DICOMWEB_PACS_STORAGE_PATH = process.env.DICOMWEB_PACS_STORAGE_PATH
  || path.resolve(__dirname, '..', '..', '..', 'DATA');
const service = require('../src/services/dicomwebPacsService');
const risDb = require('../src/services/db');

const STORAGE_ROOT = path.resolve(process.env.DICOMWEB_PACS_STORAGE_PATH);
const MANAGER_HISTORY_ROOT = path.join(STORAGE_ROOT, '.manager-history');

const stamp = Date.now();
const sourceStudyUid = `1.2.826.0.1.3680043.10.5432.9999.${stamp}.1`;
const targetStudyUid = `1.2.826.0.1.3680043.10.5432.9999.${stamp}.2`;
let sourceSeriesUid = '';
let targetSeriesUid = '';
let sopInstanceUid = '';
let operationId = '';
let restoreOperationId = '';

async function cleanup() {
  const db = service.getPacsMetadataDb();
  for (const studyUid of [sourceStudyUid, targetStudyUid]) {
    await service.deleteStudy(studyUid).catch(() => {});
  }
  for (const id of [restoreOperationId, operationId].filter(Boolean)) {
    await db.query('DELETE FROM pacs_manager_operations WHERE id = ?', [id]).catch(() => {});
    const operationDir = path.resolve(MANAGER_HISTORY_ROOT, id);
    if (operationDir.startsWith(MANAGER_HISTORY_ROOT)) {
      await fs.rm(operationDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  await fs.rm(
    path.resolve(STORAGE_ROOT, '.metadata-backups', sourceStudyUid),
    { recursive: true, force: true }
  ).catch(() => {});
  const resourceUids = [sourceStudyUid, targetStudyUid, sourceSeriesUid, targetSeriesUid, sopInstanceUid].filter(Boolean);
  for (const uid of resourceUids) {
    await risDb.query('DELETE FROM dicomweb_pacs_deleted_resources WHERE resource_uid = ?', [uid]).catch(() => {});
  }
  for (const studyUid of [sourceStudyUid, targetStudyUid]) {
    await risDb.query(
      'DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?',
      [studyUid]
    ).catch(() => {});
  }
}

async function run() {
  await service.createStudyPlaceholder({
    studyInstanceUid: sourceStudyUid,
    patientId: `QA-SOURCE-${stamp}`,
    patientName: 'QA^RESTORE^SOURCE',
    accessionNumber: `QA-SRC-${stamp}`,
    modality: 'OT',
    studyDescription: 'Temporary manager restore QA source',
  });
  await service.createStudyPlaceholder({
    studyInstanceUid: targetStudyUid,
    patientId: `QA-TARGET-${stamp}`,
    patientName: 'QA^RESTORE^TARGET',
    accessionNumber: `QA-TGT-${stamp}`,
    modality: 'OT',
    studyDescription: 'Temporary manager restore QA target',
  });
  sourceSeriesUid = (await service.createSeriesPlaceholder(sourceStudyUid, {
    modality: 'OT',
    seriesNumber: '1',
    seriesDescription: 'QA source series',
  })).seriesInstanceUid;
  targetSeriesUid = (await service.createSeriesPlaceholder(targetStudyUid, {
    modality: 'OT',
    seriesNumber: '2',
    seriesDescription: 'QA target series',
  })).seriesInstanceUid;

  const png = new PNG({ width: 2, height: 2 });
  png.data.set([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const encodedPng = PNG.sync.write(png).toString('base64');
  await service.createImageFromUpload(targetStudyUid, targetSeriesUid, {
    fileName: 'manager-restore-target-seed.png',
    mimeType: 'image/png',
    base64: encodedPng,
    instanceNumber: '1',
    imageComments: 'Temporary target seed for DICOM Manager restore QA',
  });
  const image = await service.createImageFromUpload(sourceStudyUid, sourceSeriesUid, {
    fileName: 'manager-restore-qa.png',
    mimeType: 'image/png',
    base64: encodedPng,
    instanceNumber: '1',
    imageComments: 'Temporary DICOM Manager restore QA',
  });
  sopInstanceUid = image.sopInstanceUid;

  const db = service.getPacsMetadataDb();
  let indexedBefore = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    [indexedBefore] = await db.query(
      'SELECT study_instance_uid, series_instance_uid FROM pacs_instances WHERE sop_instance_uid = ?',
      [sopInstanceUid]
    );
    if (indexedBefore.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!indexedBefore.length) {
    throw new Error(`Synthetic instance was not indexed: ${JSON.stringify(image.pacsRefresh)}`);
  }

  const journal = await service.beginManagerOperation({
    operationType: 'instance_move',
    sourceStudyUid,
    sourceSeriesUid,
    sourceSopUid: sopInstanceUid,
    targetStudyUid,
    targetSeriesUid,
    username: 'codex-qa',
    reason: 'Automated isolated restore verification',
    input: { qa: true },
  });
  operationId = journal.operationId;
  const moved = await service.moveInstanceToSeries(
    sourceStudyUid,
    sourceSeriesUid,
    sopInstanceUid,
    targetStudyUid,
    targetSeriesUid
  );
  await service.completeManagerOperation(operationId, moved);
  const preflight = await service.preflightManagerOperationRestore(operationId);
  if (!preflight.canRestore) {
    throw new Error(`Preflight rejected isolated QA move: ${JSON.stringify(preflight.conflicts)}`);
  }

  const restored = await service.restoreManagerOperation(operationId, {
    username: 'codex-qa',
    reason: 'Verify end-to-end restore implementation',
  });
  restoreOperationId = restored.restoreOperationId;

  const sourcePath = path.resolve(STORAGE_ROOT, sourceStudyUid, sopInstanceUid);
  const targetPath = path.resolve(STORAGE_ROOT, targetStudyUid, sopInstanceUid);
  const sourceFileRestored = await fs.access(sourcePath).then(() => true).catch(() => false);
  const targetFileRemoved = await fs.access(targetPath).then(() => false).catch(() => true);
  const [indexedAfter] = await db.query(
    'SELECT study_instance_uid, series_instance_uid FROM pacs_instances WHERE sop_instance_uid = ?',
    [sopInstanceUid]
  );
  const sourceIndexRestored = indexedAfter.some(row => (
    row.study_instance_uid === sourceStudyUid && row.series_instance_uid === sourceSeriesUid
  ));
  const original = await service.getManagerOperation(operationId);
  const compensating = await service.getManagerOperation(restoreOperationId);
  const result = {
    preflightCanRestore: preflight.canRestore,
    restoredObjectCount: restored.restoredObjectCount,
    sourceFileRestored,
    targetFileRemoved,
    sourceIndexRestored,
    originalStatus: original.status,
    compensatingStatus: compensating.status,
    compensatingParentMatches: compensating.parentOperationId === operationId,
    sourceRefreshStatus: restored.sourceRefresh?.status || null,
  };
  const passed = sourceFileRestored
    && targetFileRemoved
    && sourceIndexRestored
    && result.compensatingParentMatches
    && original.status === 'restored'
    && compensating.status === 'completed';
  if (!passed) throw new Error(`Restore assertions failed: ${JSON.stringify(result)}`);
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
