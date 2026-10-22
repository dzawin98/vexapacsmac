const fs = require('fs/promises');
const path = require('path');

let dicomParser;
try {
  dicomParser = require('dicom-parser');
} catch {
  dicomParser = require(path.resolve(__dirname, '..', 'dicomweb-pacs', 'node_modules', 'dicom-parser'));
}

const waveformSopClassPrefix = '1.2.840.10008.5.1.4.1.1.9.';
const maxPointsPerChannel = 5000;
const indexTtlMs = 5000;
let cachedIndex = null;

function elementBytes(dataset, element) {
  const byteOffset = dataset.byteArray.byteOffset || 0;
  return Buffer.from(dataset.byteArray.buffer, byteOffset + element.dataOffset, element.length);
}

function readSample(bytes, offset, bytesPerSample, signed) {
  if (bytesPerSample === 1) return signed ? bytes.readInt8(offset) : bytes.readUInt8(offset);
  if (offset + 2 > bytes.length) return 0;
  return signed ? bytes.readInt16LE(offset) : bytes.readUInt16LE(offset);
}

function codeMeaning(sequence) {
  const item = sequence?.items?.[0]?.dataSet;
  return item?.string('x00080104') || item?.string('x00080100') || '';
}

function readContentText(item) {
  return item.string('x0040a160') || item.string('x0040a30a') || item.string('x0040a168') || '';
}

function extractAnnotations(dataset, waveformItem) {
  const annotations = [];
  const add = (tag, value) => {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (text) annotations.push({ tag, value: text });
  };

  add('Filter Low Frequency', waveformItem.string('x003a0220'));
  add('Filter High Frequency', waveformItem.string('x003a0221'));
  add('Notch Filter Frequency', waveformItem.string('x003a0222'));
  add('Heart Rate', dataset.string('x00181088'));

  const content = dataset.elements.x0040a730?.items || [];
  for (const entry of content) {
    const item = entry.dataSet;
    if (!item) continue;
    const name = codeMeaning(item.elements.x0040a043) || item.string('x0040a043') || 'Annotation';
    const value = readContentText(item);
    add(name, value);
  }

  const seen = new Set();
  return annotations.filter(item => {
    const key = `${item.tag}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseChannelDefinitions(waveformItem, channelCount) {
  const definitions = waveformItem.elements.x003a0200?.items || [];
  return Array.from({ length: channelCount }, (_, index) => {
    const item = definitions[index]?.dataSet;
    const label = codeMeaning(item?.elements.x003a0208) || `CH ${index + 1}`;
    const sensitivity = item?.floatString('x003a0210') || item?.floatString('x003a0212') || 1;
    const correction = item?.floatString('x003a0212') || 1;
    const baseline = item?.floatString('x003a0213') || 0;
    const unit = codeMeaning(item?.elements.x003a0211) || 'mV';
    return { index, label, sensitivity, correction, baseline, unit };
  });
}

async function collectDicomFiles(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) return [];
      return collectDicomFiles(entryPath);
    }
    if (entry.name === 'image.db' || entry.name.endsWith('.json')) return [];
    return [entryPath];
  }));
  return files.flat();
}

function isWaveformDataset(dataset) {
  const modality = String(dataset.string('x00080060') || '').toUpperCase();
  const sopClassUid = dataset.string('x00080016') || '';
  return modality === 'ECG' || sopClassUid.startsWith(waveformSopClassPrefix) || Boolean(dataset.elements.x54000100);
}

async function buildStorageIndex(storagePath) {
  const files = await collectDicomFiles(storagePath);
  const instances = [];
  for (const filePath of files) {
    try {
      const data = await fs.readFile(filePath);
      const dataset = dicomParser.parseDicom(data);
      if (!isWaveformDataset(dataset)) continue;
      const studyInstanceUid = dataset.string('x0020000d') || '';
      const seriesInstanceUid = dataset.string('x0020000e') || '';
      const sopInstanceUid = dataset.string('x00080018') || '';
      const patientId = dataset.string('x00100020') || '';
      if (!studyInstanceUid || !sopInstanceUid) continue;
      instances.push({ path: filePath, studyInstanceUid, seriesInstanceUid, sopInstanceUid, patientId });
    } catch {
      // Non-DICOM files are ignored.
    }
  }
  return instances;
}

async function getStorageIndex(storagePath) {
  const now = Date.now();
  if (cachedIndex && cachedIndex.storagePath === storagePath && cachedIndex.expiresAt > now) {
    return cachedIndex.value;
  }
  const value = await buildStorageIndex(storagePath);
  cachedIndex = { storagePath, value, expiresAt: now + indexTtlMs };
  return value;
}

async function parseWaveformFile(instance) {
  const data = await fs.readFile(instance.path);
  const dataset = dicomParser.parseDicom(data);
  const waveformItem = dataset.elements.x54000100?.items?.[0]?.dataSet;
  const waveformData = waveformItem?.elements.x54001010;
  if (!waveformItem || !waveformData) return null;

  const channelCount = waveformItem.uint16('x003a0005') || 1;
  const sampleCount = waveformItem.uint32('x003a0010') || 0;
  const samplingFrequency = waveformItem.floatString('x003a001a') || 0;
  const bitsAllocated = waveformItem.uint16('x54001004') || 16;
  const interpretation = String(waveformItem.string('x54001006') || 'SS').toUpperCase();
  const bytes = elementBytes(waveformItem, waveformData);
  const bytesPerSample = Math.max(1, Math.ceil(bitsAllocated / 8));
  const signed = interpretation.startsWith('S');
  const availableSamples = Math.min(sampleCount, Math.floor(bytes.length / (bytesPerSample * Math.max(1, channelCount))));
  const step = Math.max(1, Math.ceil(availableSamples / maxPointsPerChannel));
  const channelDefinitions = parseChannelDefinitions(waveformItem, channelCount);

  const channels = channelDefinitions.map(channel => {
    const points = [];
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let sample = 0; sample < availableSamples; sample += step) {
      const offset = (sample * channelCount + channel.index) * bytesPerSample;
      const raw = readSample(bytes, offset, bytesPerSample, signed);
      const value = (raw + channel.baseline) * channel.sensitivity * channel.correction;
      const time = samplingFrequency > 0 ? sample / samplingFrequency : sample;
      points.push([Number(time.toFixed(6)), Number(value.toFixed(6))]);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    return {
      label: channel.label,
      unit: channel.unit,
      minimum: Number((Number.isFinite(minimum) ? minimum : 0).toFixed(6)),
      maximum: Number((Number.isFinite(maximum) ? maximum : 0).toFixed(6)),
      points,
    };
  });

  return {
    studyInstanceUid: instance.studyInstanceUid,
    seriesInstanceUid: instance.seriesInstanceUid,
    sopInstanceUid: instance.sopInstanceUid,
    patientName: dataset.string('x00100010') || '',
    patientId: dataset.string('x00100020') || '',
    studyDate: dataset.string('x00080020') || '',
    studyTime: dataset.string('x00080030') || '',
    studyDescription: dataset.string('x00081030') || 'ECG',
    samplingFrequency,
    sampleCount: availableSamples,
    durationSeconds: samplingFrequency > 0 ? Number((availableSamples / samplingFrequency).toFixed(3)) : null,
    annotations: extractAnnotations(dataset, waveformItem),
    channels,
  };
}

async function getStudyWaveform(storagePath, studyInstanceUid) {
  const index = await getStorageIndex(storagePath);
  const instance = index.find(item => item.studyInstanceUid === studyInstanceUid);
  return instance ? parseWaveformFile(instance) : null;
}

async function getRelatedStudyWaveforms(storagePath, studyInstanceUid) {
  const index = await getStorageIndex(storagePath);
  const currentInstance = index.find(item => item.studyInstanceUid === studyInstanceUid);
  if (!currentInstance) return [];
  const related = currentInstance.patientId
    ? index.filter(item => item.patientId === currentInstance.patientId)
    : [currentInstance];
  const unique = Array.from(new Map(related.map(item => [item.studyInstanceUid, item])).values());
  const waveforms = (await Promise.all(unique.map(item => parseWaveformFile(item)))).filter(Boolean);
  return waveforms.sort((a, b) => `${b.studyDate || ''}${b.studyTime || ''}`.localeCompare(`${a.studyDate || ''}${a.studyTime || ''}`));
}

module.exports = { getRelatedStudyWaveforms, getStudyWaveform };
