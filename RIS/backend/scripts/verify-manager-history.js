/**
 * Verify that DICOM Manager history carries the detail an operator needs to act.
 *
 * Scenario: a study merge where one source file disappears between the snapshot
 * and the move. The merge must not abort, and the history has to tell the
 * operator which SOP was skipped and why, so they can repair and re-index.
 *
 * Asserts:
 *   - the merge finishes, moving every readable image and reporting one skip,
 *   - the skip survives into the persisted operation detail (reason + SOP),
 *   - the history list exposes a compact outcome without a per-operation fetch,
 *   - a cancelled operation is restorable (preflight accepts the status),
 *   - POST /api/dicom/manager/studies/:uid/reindex re-indexes after the repair
 *     (only when MANAGER_QA_BASE_URL points at a running RIS backend),
 *   - the re-indexed study is complete again (indexed files == repository files).
 *
 * Usage: node scripts/verify-manager-history.js [--series=3] [--instances=4] [--image=256] [--keep]
 *        MANAGER_QA_BASE_URL=http://127.0.0.1:8098 node scripts/verify-manager-history.js
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

const KEEP_ARTIFACTS = process.argv.includes('--keep');
const SERIES_COUNT = numberArg('series', 3);
const INSTANCES_PER_SERIES = numberArg('instances', 4);
const IMAGE_SIZE = numberArg('image', 256);
const BACKEND_BASE_URL = String(process.env.MANAGER_QA_BASE_URL || '').replace(/\/+$/, '');

const STORAGE_ROOT = path.resolve(process.env.DICOMWEB_PACS_STORAGE_PATH);
const stamp = Date.now();
const sourceStudyUid = `1.2.826.0.1.3680043.10.5432.9987.${stamp}.1`;
const targetStudyUid = `1.2.826.0.1.3680043.10.5432.9987.${stamp}.2`;

function buildPng() {
  const png = new PNG({ width: IMAGE_SIZE, height: IMAGE_SIZE });
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const index = (y * IMAGE_SIZE + x) * 4;
      png.data[index] = (x * 7) % 256;
      png.data[index + 1] = (y * 11) % 256;
      png.data[index + 2] = (x * y) % 256;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

async function indexState(studyUid, sopUids) {
  const sops = (sopUids || []).filter(Boolean);
  if (!sops.length) return 0;
  const db = service.getPacsMetadataDb();
  const [rows] = await db.query(
    `SELECT COUNT(DISTINCT sop_instance_uid) AS c
     FROM pacs_instances
     WHERE study_instance_uid = ? AND sop_instance_uid IN (${sops.map(() => '?').join(',')})`,
    [studyUid, ...sops]
  );
  return Number(rows?.[0]?.c || 0);
}

async function indexStateWithPaths(studyUid, sopUids) {
  const sops = (sopUids || []).filter(Boolean);
  if (!sops.length) return [];
  const db = service.getPacsMetadataDb();
  const [rows] = await db.query(
    `SELECT sop_instance_uid, file_path FROM pacs_instances
     WHERE study_instance_uid = ? AND sop_instance_uid IN (${sops.map(() => '?').join(',')})`,
    [studyUid, ...sops]
  );
  return rows || [];
}

async function countStoredFiles(studyUid) {
  const root = path.join(STORAGE_ROOT, studyUid);
  let files = 0;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) {
      files += 1;
      continue;
    }
    if (entry.isDirectory()) {
      // Nested layouts keep the series folder under the study folder.
      const nested = await fs.readdir(path.join(root, entry.name)).catch(() => []);
      files += nested.filter(name => !name.startsWith('.')).length;
    }
  }
  return files;
}

async function postJson(url, body, headers = { 'x-user-role': 'administrator', 'x-user-username': 'qa-history' }) {
  const attempt = async (extra) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra, ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  };
  const plain = await attempt({});
  if (plain.status !== 401 && plain.status !== 403) return plain;
  return attempt({ 'x-ris-order-worker': '1' });
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'x-user-role': 'administrator', 'x-user-username': 'qa-history' },
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  await service.createStudyPlaceholder({
    studyInstanceUid: sourceStudyUid,
    patientId: `HIST-SRC-${stamp}`,
    patientName: 'QA^HISTORY^SOURCE',
    accessionNumber: `HIST-SRC-${stamp}`,
    modality: 'OT',
    studyDescription: 'Temporary history QA source',
  });
  await service.createStudyPlaceholder({
    studyInstanceUid: targetStudyUid,
    patientId: `HIST-TGT-${stamp}`,
    patientName: 'QA^HISTORY^TARGET',
    accessionNumber: `HIST-TGT-${stamp}`,
    modality: 'OT',
    studyDescription: 'Temporary history QA target',
  });
  await service.createSeriesPlaceholder(targetStudyUid, {
    modality: 'OT',
    seriesNumber: '1',
    seriesDescription: 'QA target series',
  });

  const base64 = buildPng();
  const allSourceSops = [];
  for (let seriesIndex = 0; seriesIndex < SERIES_COUNT; seriesIndex += 1) {
    const seriesUid = (await service.createSeriesPlaceholder(sourceStudyUid, {
      modality: 'OT',
      seriesNumber: String(seriesIndex + 2),
      seriesDescription: `QA source series ${seriesIndex + 1}`,
    })).seriesInstanceUid;
    for (let instanceIndex = 0; instanceIndex < INSTANCES_PER_SERIES; instanceIndex += 1) {
      const image = await service.createImageFromUpload(sourceStudyUid, seriesUid, {
        fileName: `history-${seriesIndex}-${instanceIndex}.png`,
        mimeType: 'image/png',
        base64,
        instanceNumber: String(instanceIndex + 1),
        imageComments: 'verify-manager-history',
      });
      allSourceSops.push(image.sopInstanceUid);
    }
  }
  await new Promise(resolve => setTimeout(resolve, 1500));

  const journal = await service.beginManagerOperation({
    operationType: 'study_merge',
    sourceStudyUid,
    targetStudyUid,
    username: 'qa-history',
    reason: 'Verify manager history detail',
    input: { qa: true },
  });
  const operationId = journal.operationId;

  // Simulate a file that vanishes between the snapshot and the move: the merge
  // must keep going and report the skip instead of failing the whole study.
  const [missingRow] = await indexStateWithPaths(sourceStudyUid, allSourceSops.slice(0, 1));
  const missingSop = missingRow?.sop_instance_uid || allSourceSops[0];
  const missingPath = missingRow?.file_path;
  if (missingPath) await fs.rm(missingPath, { force: true });
  const snapshotPath = path.join(STORAGE_ROOT, '.manager-history', operationId, 'originals', `${missingSop}.dcm`);
  const snapshotExists = await fs.access(snapshotPath).then(() => true).catch(() => false);

  const moved = await service.moveStudyToStudy(sourceStudyUid, targetStudyUid, {
    operationId,
    expectedInstances: allSourceSops.length,
  });
  await service.completeManagerOperation(operationId, moved);

  const skipped = (moved.skippedInstances || []).filter(item => item.sopInstanceUid === missingSop);
  const movedSops = (moved.movedSeries || []).flatMap(item => (item.movedInstances || []).map(instance => instance.sopInstanceUid));
  const movedIndexedUnderTarget = await indexState(targetStudyUid, movedSops);
  const missingIndexedUnderSource = await indexState(sourceStudyUid, [missingSop]);
  const missingFileStillGone = !(await fs.access(missingPath).then(() => true).catch(() => false));

  // The history API is what the panel renders: detail comes from the single
  // operation endpoint, the compact outcome from the list endpoint.
  const detail = await service.getManagerOperation(operationId);
  const detailResult = detail.details?.result || {};
  const listed = (await service.listManagerOperations({ studyUid: sourceStudyUid, limit: 50 }))
    .find(operation => operation.id === operationId) || {};
  const listedOutcome = listed.outcome || {};

  // Cancelled operations must stay restorable: the UI offers Restore for them.
  // The skipped file was never repaired here, so a file-level conflict is expected
  // (the image is genuinely absent) - what must not happen is the blanket
  // `invalid_status` rejection of the cancelled status itself.
  await service.getPacsMetadataDb().query('UPDATE pacs_manager_operations SET status = ? WHERE id = ?', ['cancelled', operationId]);
  let cancelledPreflight = null;
  try {
    const preflight = await service.preflightManagerOperationRestore(operationId);
    cancelledPreflight = {
      canRestore: preflight.canRestore,
      conflicts: preflight.conflicts.map(conflict => conflict.code),
      statusAccepted: !preflight.conflicts.some(conflict => conflict.code === 'invalid_status'),
    };
  } catch (error) {
    cancelledPreflight = { canRestore: false, conflicts: [String(error.message)], statusAccepted: false };
  }
  await service.getPacsMetadataDb().query('UPDATE pacs_manager_operations SET status = ? WHERE id = ?', ['completed', operationId]);

  // Recovery: put the file back from the operation snapshot, then re-index the
  // study through the routes the UI uses.
  let reindex = null;
  let afterRepair = null;
  let asyncReindex = null;
  if (BACKEND_BASE_URL) {
    if (snapshotExists) {
      await fs.mkdir(path.dirname(missingPath), { recursive: true });
      await fs.copyFile(snapshotPath, `${missingPath}.qa-tmp`);
      await fs.rename(`${missingPath}.qa-tmp`, missingPath);
    }
    const gate = await fetch(`${BACKEND_BASE_URL}/api/dicom/manager/operations?limit=1`).then(response => response.status).catch(() => 0);
    // wait=1 keeps the synchronous contract for scripts.
    const response = await postJson(`${BACKEND_BASE_URL}/api/dicom/manager/studies/${encodeURIComponent(sourceStudyUid)}/reindex?wait=1`, {
      reason: 'QA repaired the skipped file and re-indexed the study',
    });
    reindex = {
      healthStatus: gate,
      status: response.status,
      ok: response.payload?.ok === true,
      refreshStatus: response.payload?.refresh?.status || null,
      indexed: response.payload?.refresh?.reindex?.indexed ?? null,
      unindexable: response.payload?.refresh?.reindex?.unindexable ?? null,
    };
    const repairedSops = [missingSop];
    afterRepair = {
      indexedUnderSource: await indexState(sourceStudyUid, repairedSops),
      storedFiles: await countStoredFiles(sourceStudyUid),
    };

    // Async run + cooperative stop. A stray non-DICOM file keeps the index
    // verification pending, which is where an operator-driven re-index spends its
    // time - and where Stop has to be honoured.
    const strayPath = path.join(STORAGE_ROOT, sourceStudyUid, 'qa-stray.bin');
    await fs.writeFile(strayPath, 'qa stray file that is not DICOM');
    const started = await postJson(
      `${BACKEND_BASE_URL}/api/dicom/manager/studies/${encodeURIComponent(sourceStudyUid)}/reindex`,
      { reason: 'QA asynchronous re-index' }
    );
    const startedOperationId = started.payload?.operationId || '';
    const observedStages = [];
    let progressTotal = 0;
    let running = null;
    const observeDeadline = Date.now() + 20000;
    while (Date.now() < observeDeadline) {
      const listed = await getJson(`${BACKEND_BASE_URL}/api/dicom/manager/operations?limit=20&studyInstanceUid=${encodeURIComponent(sourceStudyUid)}`);
      running = (listed.payload?.operations || []).find(operation => operation.id === startedOperationId) || null;
      if (running?.progress?.stage) {
        if (observedStages[observedStages.length - 1] !== running.progress.stage) observedStages.push(running.progress.stage);
        progressTotal = Math.max(progressTotal, Number(running.progress.total || 0));
        if (observedStages.includes('verifying')) break;
      }
      await sleep(250);
    }
    const cancelResponse = await postJson(
      `${BACKEND_BASE_URL}/api/dicom/manager/operations/${encodeURIComponent(startedOperationId)}/cancel`,
      { reason: 'QA stops the asynchronous re-index' }
    );
    let terminal = null;
    const terminalDeadline = Date.now() + 30000;
    while (Date.now() < terminalDeadline) {
      const detail = await getJson(`${BACKEND_BASE_URL}/api/dicom/manager/operations/${encodeURIComponent(startedOperationId)}`);
      terminal = detail.payload?.operation || null;
      if (terminal && ['completed', 'cancelled', 'failed'].includes(terminal.status)) break;
      await sleep(300);
    }
    asyncReindex = {
      acceptedStatus: started.status,
      accepted: started.payload?.accepted === true,
      operationId: startedOperationId,
      observedStages,
      progressTotal,
      cancelStatus: cancelResponse.status,
      cancelRequested: cancelResponse.payload?.requested === true,
      terminalStatus: terminal?.status || null,
      terminalStage: terminal?.progress?.stage || null,
      terminalMessage: terminal?.errorMessage || null,
    };
    // While the stray file is still there a synchronous re-index must not claim a
    // clean result: it has to name the file it could not index.
    const withStray = await postJson(
      `${BACKEND_BASE_URL}/api/dicom/manager/studies/${encodeURIComponent(sourceStudyUid)}/reindex?wait=1`,
      { reason: 'QA re-index with the stray file still present' }
    );
    asyncReindex.strayReindex = {
      status: withStray.status,
      ok: withStray.payload?.ok === true,
      refreshStatus: withStray.payload?.refresh?.status || null,
      unindexedFiles: withStray.payload?.refresh?.indexSync?.unindexedFiles ?? null,
      verified: withStray.payload?.refresh?.indexSync?.verified ?? null,
    };
    await fs.rm(strayPath, { force: true });
    // With the stray file gone a plain re-index has to come back clean.
    const clean = await postJson(
      `${BACKEND_BASE_URL}/api/dicom/manager/studies/${encodeURIComponent(sourceStudyUid)}/reindex?wait=1`,
      { reason: 'QA final re-index after removing the stray file' }
    );
    asyncReindex.cleanReindex = {
      status: clean.status,
      ok: clean.payload?.ok === true,
      refreshStatus: clean.payload?.refresh?.status || null,
    };
  }

  const result = {
    config: {
      series: SERIES_COUNT,
      instancesPerSeries: INSTANCES_PER_SERIES,
      imageSize: IMAGE_SIZE,
      backend: BACKEND_BASE_URL || 'not set (service-level only)',
    },
    totalSourceInstances: allSourceSops.length,
    movedInstanceCount: movedSops.length,
    skippedInstanceCount: (moved.skippedInstances || []).length,
    skippedMatchesMissingSop: skipped.length === 1,
    skippedReason: skipped[0]?.reason || null,
    snapshotKeptForRecovery: snapshotExists,
    movedSopsIndexedUnderTarget: `${movedIndexedUnderTarget}/${movedSops.length}`,
    missingSopStillIndexedUnderSource: missingIndexedUnderSource,
    missingFileStillGone,
    historyDetailSkippedCount: detailResult.skippedInstanceCount ?? null,
    historyDetailSkippedSopMatches: (detailResult.skippedInstances || []).some(item => item.sopInstanceUid === missingSop),
    historyDetailSkippedReason: (detailResult.skippedInstances || [])[0]?.reason || null,
    historyDetailMovedInstances: detailResult.movedInstanceCount ?? null,
    historyDetailRefreshStatus: detailResult.pacsRefreshStatus || null,
    historyListOutcomeSkipped: listedOutcome.skippedInstanceCount ?? null,
    historyListOutcomeMoved: listedOutcome.movedInstanceCount ?? null,
    cancelledPreflight,
    reindex,
    afterRepair,
    asyncReindex,
  };

  const passed = result.missingFileStillGone === true
    && result.movedInstanceCount === allSourceSops.length - 1
    && result.skippedInstanceCount === 1
    && result.skippedMatchesMissingSop
    && Boolean(result.skippedReason)
    && result.snapshotKeptForRecovery
    && movedIndexedUnderTarget === movedSops.length
    && missingIndexedUnderSource === 0
    && result.historyDetailSkippedCount === 1
    && result.historyDetailSkippedSopMatches === true
    && Boolean(result.historyDetailSkippedReason)
    && result.historyDetailMovedInstances === movedSops.length
    && result.historyListOutcomeSkipped === 1
    && result.historyListOutcomeMoved === movedSops.length
    && cancelledPreflight?.statusAccepted === true
    && (!BACKEND_BASE_URL || (
      result.reindex?.status === 200
      && result.reindex?.ok === true
      && String(result.reindex?.refreshStatus || '').startsWith('refreshed')
      && result.afterRepair?.indexedUnderSource === 1
      && result.afterRepair?.storedFiles === 1
      && result.asyncReindex?.acceptedStatus === 202
      && result.asyncReindex?.accepted === true
      && (result.asyncReindex?.observedStages || []).length > 0
      && Number(result.asyncReindex?.progressTotal || 0) > 0
      && result.asyncReindex?.cancelStatus === 200
      && result.asyncReindex?.cancelRequested === true
      && result.asyncReindex?.terminalStatus === 'cancelled'
      && result.asyncReindex?.strayReindex?.ok === false
      && result.asyncReindex?.strayReindex?.refreshStatus === 'refreshed-with-unindexed-files'
      && Number(result.asyncReindex?.strayReindex?.unindexedFiles || 0) === 1
      && result.asyncReindex?.cleanReindex?.status === 200
      && result.asyncReindex?.cleanReindex?.ok === true
      && result.asyncReindex?.cleanReindex?.refreshStatus === 'refreshed'
    ));
  result.passed = passed;
  return result;
}

async function cleanup() {
  for (const studyUid of [sourceStudyUid, targetStudyUid]) {
    await service.deleteStudy(studyUid).catch(() => {});
    await fs.rm(path.join(STORAGE_ROOT, studyUid), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(STORAGE_ROOT, '.metadata-backups', studyUid), { recursive: true, force: true }).catch(() => {});
    await risDb.query('DELETE FROM dicomweb_pacs_deleted_resources WHERE resource_uid = ?', [studyUid]).catch(() => {});
    await risDb.query('DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?', [studyUid]).catch(() => {});
  }
  const db = service.getPacsMetadataDb();
  const [operations] = await db.query(
    'SELECT id FROM pacs_manager_operations WHERE source_study_uid = ? OR target_study_uid = ?',
    [sourceStudyUid, targetStudyUid]
  ).catch(() => [[]]);
  for (const operation of operations || []) {
    await db.query('DELETE FROM pacs_manager_operations WHERE id = ?', [operation.id]).catch(() => {});
    await fs.rm(path.join(STORAGE_ROOT, '.manager-history', operation.id), { recursive: true, force: true }).catch(() => {});
  }
  service.clearQidoCache?.();
}

(async () => {
  let exitCode = 0;
  try {
    const result = await run();
    if (!KEEP_ARTIFACTS) await cleanup();
    else console.error(`[history-qa] --keep set, leaving source=${sourceStudyUid} target=${targetStudyUid}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(`[history-qa] failed: ${error?.stack || error}`);
    await cleanup().catch(() => {});
    exitCode = 1;
  }
  process.exit(exitCode);
})();
