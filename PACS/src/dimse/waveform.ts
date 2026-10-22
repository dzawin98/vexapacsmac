import fs from 'fs/promises';
import dicomParser from 'dicom-parser';
import { DicomJsonRecord } from '../types';
import { queryPacsMetadata } from './metadataDb';
import { QUERY_LEVEL } from './querLevel';
import { resolveInstancePath } from './storageIndex';

const waveformSopClassPrefix = '1.2.840.10008.5.1.4.1.1.9.';
const maxPointsPerChannel = 5000;

function dicomValue(record: DicomJsonRecord, tag: string): string {
  const value = record[tag]?.Value;
  return Array.isArray(value) && value[0] !== undefined ? String(value[0]) : '';
}

function elementBytes(dataset: dicomParser.DataSet, element: dicomParser.Element): Buffer {
  const byteOffset = dataset.byteArray.byteOffset ?? 0;
  return Buffer.from(dataset.byteArray.buffer, byteOffset + element.dataOffset, element.length);
}

function readSample(bytes: Buffer, offset: number, bytesPerSample: number, signed: boolean): number {
  if (bytesPerSample === 1) return signed ? bytes.readInt8(offset) : bytes.readUInt8(offset);
  if (offset + 2 > bytes.length) return 0;
  return signed ? bytes.readInt16LE(offset) : bytes.readUInt16LE(offset);
}

function codeMeaning(sequence: any): string {
  const item = sequence?.items?.[0]?.dataSet;
  return item?.string('x00080104') || item?.string('x00080100') || '';
}

function readContentText(item: dicomParser.DataSet): string {
  return item.string('x0040a160') || item.string('x0040a30a') || item.string('x0040a168') || '';
}

function extractAnnotations(dataset: dicomParser.DataSet, waveformItem: dicomParser.DataSet): Array<{ tag: string; value: string }> {
  const annotations: Array<{ tag: string; value: string }> = [];
  const add = (tag: string, value?: string | number) => {
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

  const seen = new Set<string>();
  return annotations.filter((item) => {
    const key = `${item.tag}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseChannelDefinitions(waveformItem: dicomParser.DataSet, channelCount: number) {
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

export async function getStudyWaveform(studyInstanceUid: string) {
  const records = await queryPacsMetadata(
    QUERY_LEVEL.IMAGE,
    ['0020000D', '0020000E', '00080018', '00080016', '00080060'],
    [{ tag: '0020000D', vr: 'UI', value: studyInstanceUid }],
  );
  const record = (records || []).find((item) => {
    const modality = dicomValue(item, '00080060').toUpperCase();
    const sopClassUid = dicomValue(item, '00080016');
    return modality === 'ECG' || sopClassUid.startsWith(waveformSopClassPrefix);
  });
  if (!record) return null;

  const sopInstanceUid = dicomValue(record, '00080018');
  const seriesInstanceUid = dicomValue(record, '0020000E');
  const pathname = await resolveInstancePath(studyInstanceUid, sopInstanceUid);
  if (!pathname) return null;

  const data = await fs.readFile(pathname);
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

  const channels = channelDefinitions.map((channel) => {
    const points: Array<[number, number]> = [];
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let sample = 0; sample < availableSamples; sample += step) {
      const offset = (sample * channelCount + channel.index) * bytesPerSample;
      const raw = readSample(bytes, offset, bytesPerSample, signed);
      const value = (raw + channel.baseline) * channel.sensitivity * channel.correction;
      const time = samplingFrequency > 0 ? sample / samplingFrequency : sample;
      const roundedValue = Number(value.toFixed(6));
      points.push([Number(time.toFixed(6)), roundedValue]);
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
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid,
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

export async function getRelatedStudyWaveforms(studyInstanceUid: string) {
  const current = await getStudyWaveform(studyInstanceUid);
  if (!current?.patientId) {
    return current ? [current] : [];
  }

  const records = await queryPacsMetadata(
    QUERY_LEVEL.IMAGE,
    ['0020000D', '00080016', '00080060'],
    [
      { tag: '00100020', vr: 'LO', value: current.patientId },
      { tag: '00080060', vr: 'CS', value: 'ECG' },
    ],
  );
  const studyUids = Array.from(
    new Set(
      (records || [])
        .filter((item) => {
          const modality = dicomValue(item, '00080060').toUpperCase();
          const sopClassUid = dicomValue(item, '00080016');
          return modality === 'ECG' || sopClassUid.startsWith(waveformSopClassPrefix);
        })
        .map((item) => dicomValue(item, '0020000D'))
        .filter(Boolean),
    ),
  );

  if (!studyUids.includes(studyInstanceUid)) {
    studyUids.push(studyInstanceUid);
  }

  const waveforms = (await Promise.all(studyUids.map((uid) => getStudyWaveform(uid)))).filter(Boolean) as Array<NonNullable<typeof current>>;
  return waveforms.sort((a, b) => `${b.studyDate || ''}${b.studyTime || ''}`.localeCompare(`${a.studyDate || ''}${a.studyTime || ''}`));
}
