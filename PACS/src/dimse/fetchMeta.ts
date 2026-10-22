import { DicomJsonRecord, QueryParams } from '../types';
import { doFind } from './findData';
import { QUERY_LEVEL } from './querLevel';
import { imageMetadataTags, seriesLevelTags, studyLevelTags } from './tags';

function applyDefault(
  record: DicomJsonRecord,
  tag: string,
  vr: string,
  defaultValue: string | number | Array<string | number>,
): DicomJsonRecord {
  if (record[tag]?.Value) {
    return record;
  }

  return {
    ...record,
    [tag]: {
      Value: Array.isArray(defaultValue) ? defaultValue : [defaultValue],
      vr,
    },
  };
}

function valueOf(record: DicomJsonRecord, tag: string): string {
  const value = record[tag]?.Value;
  return Array.isArray(value) && value[0] !== undefined ? String(value[0]) : '';
}

function isEcgWaveform(record: DicomJsonRecord): boolean {
  const modality = valueOf(record, '00080060').toUpperCase();
  const sopClassUid = valueOf(record, '00080016');
  return modality === 'ECG' || sopClassUid.startsWith('1.2.840.10008.5.1.4.1.1.9.');
}

function applyEcgImageFallback(record: DicomJsonRecord): DicomJsonRecord {
  if (!isEcgWaveform(record)) return record;
  return {
    ...record,
    '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.7'] },
    '00280002': { vr: 'US', Value: [1] },
    '00280004': { vr: 'CS', Value: ['MONOCHROME2'] },
    '00280008': { vr: 'IS', Value: [1] },
    '00280010': { vr: 'US', Value: [768] },
    '00280011': { vr: 'US', Value: [1024] },
    '00280100': { vr: 'US', Value: [8] },
    '00280101': { vr: 'US', Value: [8] },
    '00280102': { vr: 'US', Value: [7] },
    '00280103': { vr: 'US', Value: [0] },
    '00281050': { vr: 'DS', Value: [128] },
    '00281051': { vr: 'DS', Value: [256] },
    '00281052': { vr: 'DS', Value: [0] },
    '00281053': { vr: 'DS', Value: [1] },
  };
}

function fixResponse(records: DicomJsonRecord[]): DicomJsonRecord[] {
  return records.map((record) => {
    let nextRecord = record;
    nextRecord = applyDefault(nextRecord, '00281050', 'DS', 100.0);
    nextRecord = applyDefault(nextRecord, '00281051', 'DS', 100.0);
    nextRecord = applyDefault(nextRecord, '00281052', 'DS', 1.0);
    nextRecord = applyDefault(nextRecord, '00281053', 'DS', 1.0);
    nextRecord = applyDefault(nextRecord, '00200032', 'DS', ['0', '0', '0']);
    nextRecord = applyDefault(nextRecord, '00200037', 'DS', ['1', '0', '0', '0', '1', '0']);
    nextRecord = applyDefault(nextRecord, '00280008', 'IS', 1);
    return applyEcgImageFallback(nextRecord);
  });
}

export async function fetchStudyMetadata(query: QueryParams): Promise<DicomJsonRecord[]> {
  const records = await doFind(QUERY_LEVEL.IMAGE, query, [
    ...studyLevelTags,
    ...seriesLevelTags,
    ...imageMetadataTags,
  ]);
  return fixResponse(records);
}

export async function fetchSeriesMetadata(query: QueryParams): Promise<DicomJsonRecord[]> {
  const records = await doFind(QUERY_LEVEL.IMAGE, query, [
    ...studyLevelTags,
    ...seriesLevelTags,
    ...imageMetadataTags,
  ]);
  return fixResponse(records);
}

export async function fetchInstanceMetadata(query: QueryParams): Promise<DicomJsonRecord[]> {
  const records = await doFind(QUERY_LEVEL.IMAGE, query, [
    ...studyLevelTags,
    ...seriesLevelTags,
    ...imageMetadataTags,
  ]);
  return fixResponse(records);
}
