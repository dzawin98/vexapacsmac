/**
 * Verify a metadata rewrite (patient correction / study or series edit) end to end.
 *
 * Regression for the header-offset bug in rewriteDicomMetadataBuffer: the file it
 * wrote used to be structurally invalid (the rewrite spliced 4 bytes into the
 * PixelData header), which went unnoticed because every rewrite was immediately
 * followed by a C-STORE re-ingest that replaced the broken file with a valid one.
 * This script asserts the on-disk file parses, carries the new values, keeps the
 * original identifiers and is still reachable through the PACS index.
 *
 * Usage: node scripts/verify-metadata-rewrite.js
 * Requires: PostgreSQL + dicomweb-pacs on DICOMWEB_PACS_ROOT (5001).
 */
const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.DICOMWEB_PACS_STORAGE_PATH = process.env.DICOMWEB_PACS_STORAGE_PATH
  || path.resolve(__dirname, '..', '..', '..', 'DATA');

const { PNG } = require('pngjs');
const dicomParser = require('dicom-parser');
const service = require('../src/services/dicomwebPacsService');
const risDb = require('../src/services/db');

const STORAGE = path.resolve(process.env.DICOMWEB_PACS_STORAGE_PATH);
const stamp = Date.now();
const studyUid = `1.2.826.0.1.3680043.10.5432.9989.${stamp}.1`;
const newPatientName = `QA^REWRITTEN^${stamp}`;
const newPatientId = `QA-REWRITE-${stamp}`;
let sopInstanceUid = '';

function readTag(dataset, tag) {
  try {
    return dataset.string(tag) || '';
  } catch (_) {
    return '';
  }
}

async function cleanup() {
  await service.deleteStudy(studyUid).catch(() => {});
  await fs.rm(path.join(STORAGE, '.metadata-backups', studyUid), { recursive: true, force: true }).catch(() => {});
  await risDb.query('DELETE FROM dicomweb_pacs_deleted_resources WHERE resource_uid = ?', [studyUid]).catch(() => {});
  await risDb.query('DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?', [studyUid]).catch(() => {});
}

async function run() {
  await service.createStudyPlaceholder({
    studyInstanceUid: studyUid,
    patientId: `QA-ORIGINAL-${stamp}`,
    patientName: 'QA^ORIGINAL',
    accessionNumber: `QA-ACC-${stamp}`,
    modality: 'OT',
    studyDescription: 'Temporary metadata rewrite QA',
  });
  const seriesUid = (await service.createSeriesPlaceholder(studyUid, {
    modality: 'OT',
    seriesNumber: '1',
    seriesDescription: 'QA rewrite series',
  })).seriesInstanceUid;

  const png = new PNG({ width: 32, height: 32 });
  png.data.fill(200);
  const uploaded = await service.createImageFromUpload(studyUid, seriesUid, {
    fileName: 'verify-rewrite.png',
    mimeType: 'image/png',
    base64: PNG.sync.write(png).toString('base64'),
    instanceNumber: '1',
    imageComments: 'verify-metadata-rewrite',
  });
  sopInstanceUid = uploaded.sopInstanceUid;
  const filePath = path.join(STORAGE, studyUid, sopInstanceUid);

  const update = await service.updateStudyMetadata(studyUid, {
    PatientName: newPatientName,
    PatientID: newPatientId,
    StudyDescription: `QA REWRITTEN ${stamp}`,
  });

  const buffer = await fs.readFile(filePath);
  let parsed = null;
  let parseError = null;
  try {
    parsed = dicomParser.parseDicom(buffer);
  } catch (error) {
    parseError = error?.message || 'parse failed';
  }
  const [indexRows] = await service.getPacsMetadataDb().query(
    'SELECT study_instance_uid, file_path FROM pacs_instances WHERE sop_instance_uid = ?',
    [sopInstanceUid]
  );
  const stillExists = await fs.access(filePath).then(() => true).catch(() => false);

  const result = {
    bytes: buffer.length,
    parseable: Boolean(parsed),
    parseError,
    patientName: parsed ? readTag(parsed, 'x00100010') : null,
    patientId: parsed ? readTag(parsed, 'x00100020') : null,
    studyInstanceUid: parsed ? readTag(parsed, 'x0020000d') : null,
    sopInstanceUid: parsed ? readTag(parsed, 'x00080018') : null,
    fileStillOnDisk: stillExists,
    rewrittenInstances: update.rewrittenInstances.length,
    refreshStatus: update.pacsRefresh?.status || null,
    refreshMode: update.pacsRefresh?.mode || null,
    indexRows: indexRows.length,
  };
  const passed = result.parseable
    && result.patientName === newPatientName
    && result.patientId === newPatientId
    && result.studyInstanceUid === studyUid
    && result.sopInstanceUid === sopInstanceUid
    && result.fileStillOnDisk
    && result.indexRows === 1
    && result.refreshStatus === 'refreshed';
  result.passed = passed;
  if (!passed) {
    throw new Error(`Metadata rewrite verification failed: ${JSON.stringify(result)}`);
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
