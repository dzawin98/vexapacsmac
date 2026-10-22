import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DicomJsonRecord } from '../types';
import { ConfParams, config } from '../utils/config';
import { doFind } from './findData';
import { QUERY_LEVEL } from './querLevel';
import { ensurePacsMetadataTables, getPacsMetadataPool, syncPacsMetadataFromStorage } from './metadataDb';

const explicitVrLittleEndian = '1.2.840.10008.1.2.1';
const basicTextSrStorage = '1.2.840.10008.5.1.4.1.1.88.11';
const implementationClassUid = '1.2.826.0.1.3680043.10.5432.9001';
const nexiaRootUid = '1.2.826.0.1.3680043.10.5432';

const longVr = new Set(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);

type DicomValue = string | number | Buffer | DicomElement[];

interface DicomElement {
  tag: string;
  vr: string;
  value?: DicomValue | DicomValue[];
}

interface SrReportPayload {
  studyInstanceUid: string;
  findings?: string;
  conclusion?: string;
  clinicalInfo?: string;
  radiologistName?: string;
  radiologistUsername?: string;
  patientId?: string;
}

function uid(): string {
  const bytes = randomBytes(16);
  const number = BigInt(`0x${bytes.toString('hex')}`);
  return `2.25.${number.toString(10)}`;
}

function yyyymmdd(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
}

function hhmmss(date = new Date()): string {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('');
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function firstString(record: DicomJsonRecord | undefined, tag: string): string {
  const value = record?.[tag]?.Value?.[0];
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'Alphabetic' in value) {
    return String(value.Alphabetic || '');
  }
  return '';
}

function bytesForText(vr: string, value: unknown): Buffer {
  const text = Array.isArray(value) ? value.join('\\') : String(value ?? '');
  const pad = vr === 'UI' ? 0x00 : 0x20;
  const buffer = Buffer.from(text, 'ascii');
  return buffer.length % 2 === 0 ? buffer : Buffer.concat([buffer, Buffer.from([pad])]);
}

function bytesForElement(vr: string, value: DicomElement['value']): Buffer {
  if (value === undefined || value === null) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(value)) {
    return value.length % 2 === 0 ? value : Buffer.concat([value, Buffer.from([0])]);
  }
  if (vr === 'SQ') {
    const items = (Array.isArray(value) ? value : [value]) as DicomElement[][];
    return Buffer.concat(
      items.map((item) => {
        const dataset = writeElements(item);
        const header = Buffer.alloc(8);
        header.writeUInt16LE(0xfffe, 0);
        header.writeUInt16LE(0xe000, 2);
        header.writeUInt32LE(dataset.length, 4);
        return Buffer.concat([header, dataset]);
      }),
    );
  }
  if (vr === 'US') {
    const values = Array.isArray(value) ? value : [value];
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((entry, index) => buffer.writeUInt16LE(Number(entry) || 0, index * 2));
    return buffer;
  }
  if (vr === 'UL') {
    const values = Array.isArray(value) ? value : [value];
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((entry, index) => buffer.writeUInt32LE(Number(entry) || 0, index * 4));
    return buffer;
  }
  return bytesForText(vr, value);
}

function writeElement(element: DicomElement): Buffer {
  const tag = element.tag.replace(/[(),]/g, '').toUpperCase();
  const group = Number.parseInt(tag.slice(0, 4), 16);
  const number = Number.parseInt(tag.slice(4), 16);
  const value = bytesForElement(element.vr, element.value);
  const header = Buffer.alloc(longVr.has(element.vr) ? 12 : 8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(number, 2);
  header.write(element.vr, 4, 2, 'ascii');
  if (longVr.has(element.vr)) {
    header.writeUInt16LE(0, 6);
    header.writeUInt32LE(value.length, 8);
  } else {
    header.writeUInt16LE(value.length, 6);
  }
  return Buffer.concat([header, value]);
}

function writeElements(elements: DicomElement[]): Buffer {
  return Buffer.concat(
    [...elements].sort((a, b) => a.tag.localeCompare(b.tag)).map(writeElement),
  );
}

function codeItem(codeValue: string, scheme: string, meaning: string): DicomElement[] {
  return [
    { tag: '00080100', vr: 'SH', value: codeValue },
    { tag: '00080102', vr: 'SH', value: scheme },
    { tag: '00080104', vr: 'LO', value: meaning },
  ];
}

function textContentItem(codeValue: string, codeMeaning: string, text: string): DicomElement[] {
  return [
    { tag: '0040A010', vr: 'CS', value: 'CONTAINS' },
    { tag: '0040A040', vr: 'CS', value: 'TEXT' },
    { tag: '0040A043', vr: 'SQ', value: [codeItem(codeValue, '99NEXIA', codeMeaning)] },
    { tag: '0040A160', vr: 'UT', value: text || '-' },
  ];
}

function fileMetaElements(sopInstanceUid: string): DicomElement[] {
  const rest: DicomElement[] = [
    { tag: '00020001', vr: 'OB', value: Buffer.from([0x00, 0x01]) },
    { tag: '00020002', vr: 'UI', value: basicTextSrStorage },
    { tag: '00020003', vr: 'UI', value: sopInstanceUid },
    { tag: '00020010', vr: 'UI', value: explicitVrLittleEndian },
    { tag: '00020012', vr: 'UI', value: implementationClassUid },
    { tag: '00020013', vr: 'SH', value: 'NEXIA_PACS' },
  ];
  const restBytes = writeElements(rest);
  return [{ tag: '00020000', vr: 'UL', value: restBytes.length }, ...rest];
}

function buildSrDataset(payload: SrReportPayload, source: DicomJsonRecord | undefined): {
  buffer: Buffer;
  seriesInstanceUid: string;
  sopInstanceUid: string;
} {
  const now = new Date();
  const seriesInstanceUid = `${nexiaRootUid}.${Date.now()}.900`;
  const sopInstanceUid = uid();
  const findings = cleanText(payload.findings);
  const conclusion = cleanText(payload.conclusion);
  const radiologistName = cleanText(payload.radiologistName || payload.radiologistUsername);
  const reportTitle = conclusion ? 'Radiology Report' : 'Radiology Preliminary Report';

  const patientName = firstString(source, '00100010') || firstString(source, '00100020') || payload.patientId || '';
  const patientId = payload.patientId || firstString(source, '00100020');

  const contentItems: DicomElement[][] = [
    textContentItem('FINDINGS', 'Finding', findings),
    textContentItem('CONCLUSION', 'Conclusion', conclusion),
  ];

  const dataset = writeElements([
    { tag: '00080005', vr: 'CS', value: 'ISO_IR 100' },
    { tag: '00080016', vr: 'UI', value: basicTextSrStorage },
    { tag: '00080018', vr: 'UI', value: sopInstanceUid },
    { tag: '00080020', vr: 'DA', value: firstString(source, '00080020') || yyyymmdd(now) },
    { tag: '00080030', vr: 'TM', value: firstString(source, '00080030') || hhmmss(now) },
    { tag: '00080050', vr: 'SH', value: firstString(source, '00080050') },
    { tag: '00080060', vr: 'CS', value: 'SR' },
    { tag: '00080090', vr: 'PN', value: firstString(source, '00080090') },
    { tag: '00081030', vr: 'LO', value: firstString(source, '00081030') },
    { tag: '0008103E', vr: 'LO', value: 'SR REPORT' },
    { tag: '00100010', vr: 'PN', value: patientName },
    { tag: '00100020', vr: 'LO', value: patientId },
    { tag: '00100030', vr: 'DA', value: firstString(source, '00100030') },
    { tag: '00100040', vr: 'CS', value: firstString(source, '00100040') },
    { tag: '0020000D', vr: 'UI', value: payload.studyInstanceUid },
    { tag: '0020000E', vr: 'UI', value: seriesInstanceUid },
    { tag: '00200010', vr: 'SH', value: firstString(source, '00200010') },
    { tag: '00200011', vr: 'IS', value: '990' },
    { tag: '0040A040', vr: 'CS', value: 'CONTAINER' },
    { tag: '0040A043', vr: 'SQ', value: [codeItem('18748-4', 'LN', reportTitle)] },
    { tag: '0040A050', vr: 'CS', value: 'SEPARATE' },
    { tag: '0040A491', vr: 'CS', value: 'COMPLETE' },
    { tag: '0040A493', vr: 'CS', value: 'VERIFIED' },
    { tag: '0040A730', vr: 'SQ', value: contentItems },
    ...(radiologistName
      ? [
          {
            tag: '0040A073',
            vr: 'SQ',
            value: [
              [
                { tag: '0040A075', vr: 'PN', value: radiologistName },
                { tag: '0040A030', vr: 'DT', value: `${yyyymmdd(now)}${hhmmss(now)}` },
              ],
            ],
          } as DicomElement,
        ]
      : []),
  ]);

  const preamble = Buffer.alloc(128);
  const magic = Buffer.from('DICM', 'ascii');
  const meta = writeElements(fileMetaElements(sopInstanceUid));
  return {
    buffer: Buffer.concat([preamble, magic, meta, dataset]),
    seriesInstanceUid,
    sopInstanceUid,
  };
}

async function removeExistingSrReportSeries(studyInstanceUid: string): Promise<void> {
  await ensurePacsMetadataTables();
  const db = getPacsMetadataPool();
  const [rows] = await db.query(
    `
    SELECT s.series_instance_uid, i.sop_instance_uid, i.file_path
    FROM pacs_series s
    LEFT JOIN pacs_instances i ON i.series_instance_uid = s.series_instance_uid
    WHERE s.study_instance_uid = ?
      AND s.modality = 'SR'
      AND s.series_description = 'SR REPORT'
    `,
    [studyInstanceUid],
  );
  const entries = rows as Array<{
    series_instance_uid: string;
    sop_instance_uid?: string | null;
    file_path?: string | null;
  }>;
  if (!entries.length) {
    return;
  }

  const storageRoot = path.resolve(config.get<string>(ConfParams.STORAGE_PATH));
  const seriesUids = Array.from(new Set(entries.map((entry) => entry.series_instance_uid).filter(Boolean)));
  const filePaths = Array.from(new Set(entries.map((entry) => entry.file_path).filter(Boolean))) as string[];

  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath);
    if (resolved.startsWith(storageRoot)) {
      await fs.rm(resolved, { force: true });
    }
  }

  if (seriesUids.length) {
    await db.query('DELETE FROM pacs_instances WHERE series_instance_uid IN (?)', [seriesUids]);
    await db.query('DELETE FROM pacs_series WHERE series_instance_uid IN (?)', [seriesUids]);
  }
}

export async function createSrReportSeries(payload: SrReportPayload): Promise<{
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  filePath: string;
}> {
  const studyInstanceUid = String(payload.studyInstanceUid || '').trim();
  if (!studyInstanceUid) {
    throw new Error('studyInstanceUid is required');
  }

  const records = await doFind(QUERY_LEVEL.IMAGE, {
    StudyInstanceUID: studyInstanceUid,
    limit: '1',
  });
  const source = records[0];
  const sr = buildSrDataset({ ...payload, studyInstanceUid }, source);
  await removeExistingSrReportSeries(studyInstanceUid);
  const studyPath = path.join(config.get<string>(ConfParams.STORAGE_PATH), studyInstanceUid);
  await fs.mkdir(studyPath, { recursive: true });
  const filePath = path.join(studyPath, sr.sopInstanceUid);
  await fs.writeFile(filePath, sr.buffer);
  await syncPacsMetadataFromStorage(true);

  return {
    studyInstanceUid,
    seriesInstanceUid: sr.seriesInstanceUid,
    sopInstanceUid: sr.sopInstanceUid,
    filePath,
  };
}
