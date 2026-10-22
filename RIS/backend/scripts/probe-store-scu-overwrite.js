// Reproduce the manager re-ingest hazard: write a DICOM into PACS storage, then
// C-STORE that same object to the PACS (what refreshStudyIndex does) and see
// whether the stored file survives.
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.DICOMWEB_PACS_STORAGE_PATH = process.env.DICOMWEB_PACS_STORAGE_PATH
  || path.resolve(__dirname, '..', '..', '..', 'DATA');
// Keep refreshStudyIndex out of the way: this probe does the C-STORE itself.
process.env.DICOMWEB_PACS_REINDEX_AFTER_METADATA = '0';

const { PNG } = require('pngjs');
const service = require('../src/services/dicomwebPacsService');
const { storeScu } = require('D:/VELOPACS-RIS/PACS/node_modules/dicom-dimse-native');

const STORAGE = path.resolve(process.env.DICOMWEB_PACS_STORAGE_PATH);
const stamp = Date.now();
const studyUid = `1.2.826.0.1.3680043.10.5432.9992.${stamp}.1`;
const source = { aet: 'NEXIA_RIS', ip: '127.0.0.1', port: 11115 };
const target = { aet: 'VEXA_INT', ip: '127.0.0.1', port: 8890 };

function sendStoreScu(sourcePath) {
  return new Promise((resolve, reject) => {
    storeScu({ source, target, sourcePath, verbose: false }, response => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

(async () => {
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < png.data.length; i += 1) png.data[i] = (i * 3) % 256;
  const base64 = PNG.sync.write(png).toString('base64');
  await service.createStudyPlaceholder({ studyInstanceUid: studyUid, patientId: `P-${stamp}`, patientName: 'PROBE^SCU', accessionNumber: `P-${stamp}`, modality: 'OT' });
  const seriesUid = (await service.createSeriesPlaceholder(studyUid, { modality: 'OT', seriesNumber: '1', seriesDescription: 'probe' })).seriesInstanceUid;
  const up = await service.createImageFromUpload(studyUid, seriesUid, {
    fileName: 'probe-scu.png', mimeType: 'image/png', base64, instanceNumber: '1',
  });
  const studyPath = path.join(STORAGE, studyUid);
  const storedFile = path.join(studyPath, up.sopInstanceUid);
  console.log('stored file exists before store:', await fs.access(storedFile).then(() => true).catch(() => false));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-cstore-'));
  const tempFile = path.join(tempDir, up.sopInstanceUid);
  await fs.copyFile(storedFile, tempFile);
  const result = await sendStoreScu(tempDir);
  console.log('storeScu result:', JSON.stringify(result));
  console.log('stored file exists after store :', await fs.access(storedFile).then(() => true).catch(() => false));
  console.log('dir after store:', JSON.stringify(await fs.readdir(studyPath).catch(e => `ERR ${e.message}`)));

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(studyPath, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
