// After a manager merge, is the rewritten DICOM file still parseable?
// The old flow re-ingested every file over C-STORE right after the rewrite, so a
// broken rewrite would have been masked by the PACS writing its own copy back.
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.DICOMWEB_PACS_STORAGE_PATH = process.env.DICOMWEB_PACS_STORAGE_PATH
  || path.resolve(__dirname, '..', '..', '..', 'DATA');

const { PNG } = require('pngjs');
const dicomParser = require('dicom-parser');
const service = require('../src/services/dicomwebPacsService');

const STORAGE = path.resolve(process.env.DICOMWEB_PACS_STORAGE_PATH);
const stamp = Date.now();
const sourceStudyUid = `1.2.826.0.1.3680043.10.5432.9991.${stamp}.1`;
const targetStudyUid = `1.2.826.0.1.3680043.10.5432.9991.${stamp}.2`;

function describe(filePath, label, buffer) {
  try {
    const dataset = dicomParser.parseDicom(buffer);
    const read = tag => {
      try {
        return dataset.string(tag) || '';
      } catch (_) {
        return '';
      }
    };
    console.log(`${label}: parsed ok bytes=${buffer.length} study=${read('x0020000d')} series=${read('x0020000e')} sop=${read('x00080018')} patientName=${read('x00100010')}`);
  } catch (error) {
    console.log(`${label}: PARSE FAILED bytes=${buffer.length} -> ${error.message}`);
    console.log(`  head=${buffer.subarray(0, 160).toString('hex')}`);
  }
}

(async () => {
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < png.data.length; i += 1) png.data[i] = (i * 3) % 256;
  const base64 = PNG.sync.write(png).toString('base64');
  await service.createStudyPlaceholder({ studyInstanceUid: sourceStudyUid, patientId: `P-${stamp}`, patientName: 'PROBE^REWRITE', accessionNumber: `P-${stamp}`, modality: 'OT' });
  await service.createStudyPlaceholder({ studyInstanceUid: targetStudyUid, patientId: `T-${stamp}`, patientName: 'PROBE^TARGET', accessionNumber: `T-${stamp}`, modality: 'OT' });
  const targetSeries = (await service.createSeriesPlaceholder(targetStudyUid, { modality: 'OT', seriesNumber: '1', seriesDescription: 'target' })).seriesInstanceUid;
  await service.createImageFromUpload(targetStudyUid, targetSeries, {
    fileName: 'seed.png', mimeType: 'image/png', base64, instanceNumber: '1',
  });
  const sourceSeries = (await service.createSeriesPlaceholder(sourceStudyUid, { modality: 'OT', seriesNumber: '2', seriesDescription: 'source' })).seriesInstanceUid;
  const uploaded = await service.createImageFromUpload(sourceStudyUid, sourceSeries, {
    fileName: 'src.png', mimeType: 'image/png', base64, instanceNumber: '1',
  });
  const originalFile = path.join(STORAGE, sourceStudyUid, uploaded.sopInstanceUid);
  describe(originalFile, 'source file (before merge)', await fs.readFile(originalFile));

  const journal = await service.beginManagerOperation({
    operationType: 'study_merge', sourceStudyUid, targetStudyUid, username: 'probe', reason: 'probe rewrite integrity', input: {},
  });
  const moved = await service.moveStudyToStudy(sourceStudyUid, targetStudyUid);
  await service.completeManagerOperation(journal.operationId, moved);
  console.log('targetRefresh:', JSON.stringify(moved.targetRefresh));

  const snapshotFile = path.join(STORAGE, '.manager-history', journal.operationId, 'originals', `${uploaded.sopInstanceUid}.dcm`);
  const movedFile = path.join(STORAGE, targetStudyUid, uploaded.sopInstanceUid);
  describe(snapshotFile, 'manager-history snapshot    ', await fs.readFile(snapshotFile).catch(error => Buffer.from(`ERR ${error.message}`)));
  describe(movedFile, 'moved file (after merge)   ', await fs.readFile(movedFile).catch(error => Buffer.from(`ERR ${error.message}`)));

  const backupDir = path.join(STORAGE, '.metadata-backups', sourceStudyUid);
  const backupNames = await fs.readdir(backupDir).catch(() => []);
  const links = [];
  for (const candidate of [snapshotFile, path.join(backupDir, backupNames[0] || 'missing')]) {
    const stat = await fs.stat(candidate).catch(() => null);
    links.push(`${path.basename(path.dirname(candidate))}/${path.basename(candidate).slice(0, 24)}: nlink=${stat ? stat.nlink : 'n/a'} size=${stat ? stat.size : 'n/a'}`);
  }
  console.log('link check:', JSON.stringify(links));

  const db = service.getPacsMetadataDb();
  const [rows] = await db.query(
    'SELECT study_instance_uid, file_path FROM pacs_instances WHERE sop_instance_uid = ?',
    [uploaded.sopInstanceUid]
  );
  console.log('index rows for moved sop:', JSON.stringify(rows));

  await service.deleteStudy(sourceStudyUid).catch(() => {});
  await service.deleteStudy(targetStudyUid).catch(() => {});
  await db.query('DELETE FROM pacs_manager_operations WHERE id = ?', [journal.operationId]).catch(() => {});
  await fs.rm(path.join(STORAGE, '.manager-history', journal.operationId), { recursive: true, force: true }).catch(() => {});
  process.exit(0);
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
