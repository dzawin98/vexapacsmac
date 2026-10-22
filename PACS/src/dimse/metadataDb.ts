import fs from 'fs/promises';
import path from 'path';
import { get_element } from '@iwharris/dicom-data-dictionary';
import dicomParser from 'dicom-parser';
import { createPool } from '../utils/postgresCompat';
import { DicomJsonElement, DicomJsonRecord } from '../types';
import { ConfParams, config } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';
import { QUERY_LEVEL } from './querLevel';
import { overlayMetadataTags } from './tags';

export interface QueryFilter {
  tag: string;
  vr: string;
  value: string;
}

interface StoredFile {
  path: string;
  mtimeMs: number;
}

interface KnownFile {
  mtimeMs: number;
  version: number;
}

interface KnownFiles {
  byPath: Map<string, KnownFile>;
  sopOwners: Map<string, string>;
}

type UpsertOutcome =
  | { kind: 'unchanged' }
  | { kind: 'unindexable' }
  | { kind: 'duplicate'; sopInstanceUid: string; ownerPath: string }
  | { kind: 'indexed'; studyInstanceUid: string; seriesInstanceUid: string; sopInstanceUid: string };

export interface MetadataSyncStats {
  enabled: boolean;
  fullSyncs: number;
  scheduledSyncs: number;
  backgroundSyncs: number;
  lastSyncMs: number;
  lastScanFiles: number;
  lastIndexedFiles: number;
  lastUnchangedFiles: number;
  lastUnindexableFiles: number;
  skippedByRejectCache: number;
  lastDuplicateFiles: number;
  skippedByDuplicateCache: number;
  duplicateCached: number;
  lastSyncAt: string | null;
  lastError: string | null;
  failures: number;
  syncInFlight: boolean;
  hasCompletedOnce: boolean;
  ttlMs: number;
  debounceMs: number;
  intervalMs: number;
  rejectedCached: number;
}

const dbConfig = {
  host: process.env.PACS_DB_HOST || process.env.DB_HOST || 'localhost',
  port: Number(process.env.PACS_DB_PORT || process.env.DB_PORT || 5432),
  user: process.env.PACS_DB_USER || process.env.DB_USER || 'postgres',
  password: process.env.PACS_DB_PASS || process.env.DB_PASS || 'velo',
  database: process.env.PACS_DB_NAME || 'velopacs_db',
};

const metadataVersion = 7;
const metadataSyncTtlMs = Number(process.env.PACS_METADATA_SYNC_TTL_MS || 60000);
let pool: any | null = null;
let metadataSyncExpiresAt = 0;
let metadataSyncPromise: Promise<void> | null = null;
let metadataSyncCompletedOnce = false;
/** null = not probed yet in this process. */
let metadataIndexPopulated: boolean | null = null;
let metadataSyncTimer: ReturnType<typeof setTimeout> | null = null;
let metadataSyncInterval: ReturnType<typeof setInterval> | null = null;
let pendingForcedSync = false;

const metadataSyncDebounceMs = Math.max(0, Number(process.env.PACS_METADATA_SYNC_DEBOUNCE_MS || 5000));
const metadataSyncIntervalMs = Math.max(0, Number(process.env.PACS_METADATA_SYNC_INTERVAL_MS || 300000));
const rejectedFileLimit = Math.max(0, Number(process.env.PACS_METADATA_REJECT_CACHE_MAX || 20000));
const duplicateFileLimit = Math.max(0, Number(process.env.PACS_METADATA_DUPLICATE_CACHE_MAX || 50000));

// Files that parsed but carry no study/series/instance UID (pixel blobs, sidecars,
// truncated objects). They can never be indexed at that mtime, so remember them and
// stop re-reading them on every walk.
const rejectedFiles = new Map<string, number>();

// Same SOPInstanceUID stored under two paths (re-sent study, duplicate folder).
// One row can only point at one file, so the loser is remembered and skipped
// instead of being re-read and re-written on every walk.
const duplicateFiles = new Map<string, number>();

const metadataSyncStats = {
  fullSyncs: 0,
  scheduledSyncs: 0,
  backgroundSyncs: 0,
  lastSyncMs: 0,
  lastScanFiles: 0,
  lastIndexedFiles: 0,
  lastUnchangedFiles: 0,
  lastUnindexableFiles: 0,
  skippedByRejectCache: 0,
  lastDuplicateFiles: 0,
  skippedByDuplicateCache: 0,
  lastSyncAt: null as string | null,
  lastError: null as string | null,
  failures: 0,
};

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

const tagVr: Record<string, string> = {
  '00020010': 'UI',
  '00080005': 'CS',
  '00080016': 'UI',
  '00080018': 'UI',
  '00080020': 'DA',
  '00080030': 'TM',
  '00080050': 'SH',
  '00080054': 'AE',
  '00080056': 'CS',
  '00080060': 'CS',
  '00080061': 'CS',
  '00080080': 'LO',
  '00080090': 'PN',
  '00081030': 'LO',
  '0008103E': 'LO',
  '00081190': 'UR',
  '00180050': 'DS',
  '00180060': 'DS',
  '00180088': 'DS',
  '00181030': 'LO',
  '00181100': 'DS',
  '00181150': 'IS',
  '00181151': 'IS',
  '00181210': 'SH',
  '00189311': 'FD',
  '00189345': 'FD',
  '00100010': 'PN',
  '00100020': 'LO',
  '00100030': 'DA',
  '00100040': 'CS',
  '0020000D': 'UI',
  '0020000E': 'UI',
  '00200010': 'SH',
  '00200011': 'IS',
  '00200013': 'IS',
  '00200032': 'DS',
  '00200037': 'DS',
  '00201041': 'DS',
  '00201206': 'IS',
  '00201208': 'IS',
  '00201209': 'IS',
  '00280002': 'US',
  '00280004': 'CS',
  '00280006': 'US',
  '00280008': 'IS',
  '00280010': 'US',
  '00280011': 'US',
  '00280030': 'DS',
  '00280100': 'US',
  '00280101': 'US',
  '00280102': 'US',
  '00280103': 'US',
  '00281050': 'DS',
  '00281051': 'DS',
  '00281052': 'DS',
  '00281053': 'DS',
  '0040A010': 'CS',
  '0040A040': 'CS',
  '0040A043': 'SQ',
  '0040A050': 'CS',
  '0040A073': 'SQ',
  '0040A075': 'PN',
  '0040A088': 'SQ',
  '0040A120': 'DT',
  '0040A121': 'DA',
  '0040A122': 'TM',
  '0040A123': 'PN',
  '0040A124': 'UI',
  '0040A130': 'CS',
  '0040A160': 'UT',
  '0040A168': 'SQ',
  '0040A170': 'SQ',
  '0040A300': 'SQ',
  '0040A301': 'SQ',
  '0040A30A': 'DS',
  '0040A30C': 'SQ',
  '0040DB00': 'CS',
  '0040DB73': 'UL',
  '0040E010': 'UR',
  '0040A730': 'SQ',
};

const tagAccessors: Record<string, string> = {
  '00020010': 'x00020010',
  '00080005': 'x00080005',
  '00080016': 'x00080016',
  '00080018': 'x00080018',
  '00080020': 'x00080020',
  '00080030': 'x00080030',
  '00080050': 'x00080050',
  '00080060': 'x00080060',
  '00080080': 'x00080080',
  '00080090': 'x00080090',
  '00081030': 'x00081030',
  '0008103E': 'x0008103e',
  '00180050': 'x00180050',
  '00180060': 'x00180060',
  '00180088': 'x00180088',
  '00181030': 'x00181030',
  '00181100': 'x00181100',
  '00181150': 'x00181150',
  '00181151': 'x00181151',
  '00181210': 'x00181210',
  '00189311': 'x00189311',
  '00189345': 'x00189345',
  '00100010': 'x00100010',
  '00100020': 'x00100020',
  '00100030': 'x00100030',
  '00100040': 'x00100040',
  '0020000D': 'x0020000d',
  '0020000E': 'x0020000e',
  '00200010': 'x00200010',
  '00200011': 'x00200011',
  '00200013': 'x00200013',
  '00200032': 'x00200032',
  '00200037': 'x00200037',
  '00201041': 'x00201041',
  '00280002': 'x00280002',
  '00280004': 'x00280004',
  '00280006': 'x00280006',
  '00280008': 'x00280008',
  '00280010': 'x00280010',
  '00280011': 'x00280011',
  '00280030': 'x00280030',
  '00280100': 'x00280100',
  '00280101': 'x00280101',
  '00280102': 'x00280102',
  '00280103': 'x00280103',
  '00281050': 'x00281050',
  '00281051': 'x00281051',
  '00281052': 'x00281052',
  '00281053': 'x00281053',
  '0040A730': 'x0040a730',
};

const columnByTag: Record<string, string> = {
  '00100020': 'patient_id',
  '00100010': 'patient_name',
  '00080050': 'accession_number',
  '0020000D': 'study_instance_uid',
  '0020000E': 'series_instance_uid',
  '00080018': 'sop_instance_uid',
  '00080060': 'modality',
  '00080020': 'study_date',
  '00081030': 'study_description',
};

function metadataEnabled(): boolean {
  return !['0', 'false', 'no', 'off'].includes(
    String(process.env.DICOMWEB_PACS_METADATA_DB || 'true').toLowerCase(),
  );
}

export function getPacsMetadataPool(): any {
  if (!pool) {
    pool = createPool({
      ...dbConfig,
      connectionLimit: Number(process.env.PACS_DB_POOL_SIZE || 10),
    });
  }
  return pool;
}

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function datasetString(dataset: dicomParser.DataSet, tag: string): string {
  const key = tagAccessors[tag];
  if (!key) {
    return '';
  }
  try {
    return asString(dataset.string(key));
  } catch {
    return '';
  }
}

function datasetNumber(dataset: dicomParser.DataSet, tag: string): number | null {
  const key = tagAccessors[tag];
  if (!key) {
    return null;
  }
  try {
    const vr = tagVr[tag];
    if (vr === 'US') {
      return dataset.uint16(key) ?? null;
    }
    if (vr === 'SS') {
      return dataset.int16(key) ?? null;
    }
    if (vr === 'UL') {
      return dataset.uint32(key) ?? null;
    }
    if (vr === 'SL') {
      return dataset.int32(key) ?? null;
    }
    if (vr === 'FL') {
      return dataset.float(key) ?? null;
    }
    if (vr === 'FD') {
      return dataset.double(key) ?? null;
    }
  } catch {
    // Fall back to text parsing for numeric text VRs such as IS/DS.
  }
  const raw = datasetString(dataset, tag);
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTag(tag: string): string {
  return tag.startsWith('x') ? tag.slice(1).toUpperCase() : tag.toUpperCase();
}

function tagKey(tag: string): string {
  return `x${tag.toLowerCase()}`;
}

function dictionaryVr(tag: string): string {
  const element = get_element(tag);
  return element?.vr || tagVr[tag] || 'LO';
}

function stringValues(dataset: dicomParser.DataSet, key: string): string[] {
  const element = dataset.elements[key];
  if (!element || element.length <= 0) {
    return [];
  }
  const raw = dataset.string(key);
  return raw === undefined || raw === null ? [] : String(raw).split('\\').map((value) => value.trim());
}

function numericValues(dataset: dicomParser.DataSet, key: string, vr: string): number[] {
  const element = dataset.elements[key];
  if (!element || element.length <= 0) {
    return [];
  }
  const countByVr: Record<string, number> = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8 };
  const bytes = countByVr[vr];
  if (!bytes) {
    return [];
  }
  const count = Math.floor(element.length / bytes);
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let value: number | undefined;
    if (vr === 'US') value = dataset.uint16(key, index);
    if (vr === 'SS') value = dataset.int16(key, index);
    if (vr === 'UL') value = dataset.uint32(key, index);
    if (vr === 'SL') value = dataset.int32(key, index);
    if (vr === 'FL') value = dataset.float(key, index);
    if (vr === 'FD') value = dataset.double(key, index);
    if (value !== undefined && Number.isFinite(value)) {
      values.push(value);
    }
  }
  return values;
}

function datasetToDicomJson(dataset: dicomParser.DataSet, tags?: Set<string>): DicomJsonRecord {
  const record: DicomJsonRecord = {};
  for (const [rawTag, element] of Object.entries(dataset.elements)) {
    const tag = normalizeTag(rawTag);
    if (tag.startsWith('FFFE') || (tags && !tags.has(tag))) {
      continue;
    }
    const key = tagKey(tag);
    const vr = element.vr || dictionaryVr(tag);
    if (vr === 'SQ') {
      const value =
        element.items?.flatMap((item) => (item.dataSet ? [datasetToDicomJson(item.dataSet)] : [])) ?? [];
      record[tag] = { vr, Value: value };
      continue;
    }
    if (vr === 'PN') {
      const value = stringValues(dataset, key).filter(Boolean).map((name) => ({ Alphabetic: name }));
      if (value.length) {
        record[tag] = { vr, Value: value };
      }
      continue;
    }
    const numericVr = ['US', 'SS', 'UL', 'SL', 'FL', 'FD'];
    if (numericVr.includes(vr)) {
      const value = numericValues(dataset, key, vr);
      if (value.length) {
        record[tag] = { vr, Value: value };
      }
      continue;
    }
    const value = stringValues(dataset, key).filter(Boolean);
    if (value.length) {
      record[tag] = { vr, Value: value };
    }
  }
  return record;
}

function jsonElement(tag: string, value: string | number | null): DicomJsonElement | undefined {
  if (value === null || value === undefined || String(value).trim() === '') {
    return undefined;
  }
  const vr = tagVr[tag] || 'LO';
  if (vr === 'PN') {
    return { vr, Value: [{ Alphabetic: String(value) }] };
  }
  if (['IS', 'US', 'UL'].includes(vr) && typeof value === 'number') {
    return { vr, Value: [value] };
  }
  if (vr === 'DS' && String(value).includes('\\')) {
    return { vr, Value: String(value).split('\\').filter(Boolean) };
  }
  return { vr, Value: [value] };
}

function pickRecord(record: DicomJsonRecord, tags: string[]): DicomJsonRecord {
  const next: DicomJsonRecord = {};
  for (const tag of tags) {
    if (record[tag]) {
      next[tag] = record[tag];
    }
  }
  return next;
}

function mergeRecords(...records: DicomJsonRecord[]): DicomJsonRecord {
  return Object.assign({}, ...records);
}

function buildRecord(dataset: dicomParser.DataSet, tags: string[]): DicomJsonRecord {
  return datasetToDicomJson(dataset, new Set(tags));
}

function positiveDecimalValues(dataset: dicomParser.DataSet, key: string): number[] {
  try {
    const raw = dataset.string(key);
    if (raw === undefined || raw === null) {
      return [];
    }
    return String(raw)
      .split('\\')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function firstSequenceItemDataset(
  dataset: dicomParser.DataSet,
  key: string,
): dicomParser.DataSet | undefined {
  return dataset.elements[key]?.items?.find((item) => item.dataSet)?.dataSet;
}

function sharedPixelMeasures(dataset: dicomParser.DataSet): dicomParser.DataSet | undefined {
  const sharedFunctionalGroups = firstSequenceItemDataset(dataset, 'x52009229');
  return sharedFunctionalGroups
    ? firstSequenceItemDataset(sharedFunctionalGroups, 'x00289110')
    : undefined;
}

function applySharedPixelMeasures(
  record: DicomJsonRecord,
  dataset: dicomParser.DataSet,
): DicomJsonRecord {
  if (record['00280030']?.Value) {
    return record;
  }

  const pixelMeasures = sharedPixelMeasures(dataset);
  if (!pixelMeasures) {
    return record;
  }

  const pixelSpacing = positiveDecimalValues(pixelMeasures, 'x00280030');
  const sliceThickness = positiveDecimalValues(pixelMeasures, 'x00180050');
  const next = { ...record };

  if (pixelSpacing.length >= 2) {
    next['00280030'] = { vr: 'DS', Value: pixelSpacing.slice(0, 2) };
  }
  if (!next['00180050']?.Value && sliceThickness.length) {
    next['00180050'] = { vr: 'DS', Value: [sliceThickness[0]] };
  }

  return next;
}

async function ensureDatabaseExists(): Promise<void> {
  // PostgreSQL databases are provisioned by the workspace migration script.
}

export async function ensurePacsMetadataTables(): Promise<void> {
  await ensureDatabaseExists();
  const db = getPacsMetadataPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS pacs_studies (
      study_instance_uid VARCHAR(128) PRIMARY KEY,
      patient_id VARCHAR(128) NULL,
      patient_name VARCHAR(255) NULL,
      accession_number VARCHAR(128) NULL,
      study_date VARCHAR(16) NULL,
      study_time VARCHAR(32) NULL,
      modality_list VARCHAR(255) NULL,
      study_description VARCHAR(255) NULL,
      study_id VARCHAR(128) NULL,
      referring_physician VARCHAR(255) NULL,
      series_count INT NOT NULL DEFAULT 0,
      instance_count INT NOT NULL DEFAULT 0,
      study_json LONGTEXT NULL CHECK (json_valid(study_json)),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_pacs_studies_patient_id (patient_id),
      INDEX idx_pacs_studies_accession (accession_number),
      INDEX idx_pacs_studies_date (study_date),
      INDEX idx_pacs_studies_patient_name (patient_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS pacs_series (
      series_instance_uid VARCHAR(128) PRIMARY KEY,
      study_instance_uid VARCHAR(128) NOT NULL,
      modality VARCHAR(32) NULL,
      series_number INT NULL,
      series_description VARCHAR(255) NULL,
      instance_count INT NOT NULL DEFAULT 0,
      series_json LONGTEXT NULL CHECK (json_valid(series_json)),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_pacs_series_study (study_instance_uid),
      INDEX idx_pacs_series_modality (modality)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS pacs_instances (
      sop_instance_uid VARCHAR(128) PRIMARY KEY,
      study_instance_uid VARCHAR(128) NOT NULL,
      series_instance_uid VARCHAR(128) NOT NULL,
      sop_class_uid VARCHAR(128) NULL,
      instance_number INT NULL,
      file_path VARCHAR(1024) NOT NULL,
      file_mtime_ms BIGINT NOT NULL DEFAULT 0,
      rows_value INT NULL,
      columns_value INT NULL,
      metadata_version INT NOT NULL DEFAULT 1,
      instance_json LONGTEXT NULL CHECK (json_valid(instance_json)),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_pacs_instances_study (study_instance_uid),
      INDEX idx_pacs_instances_series (series_instance_uid),
      INDEX idx_pacs_instances_number (instance_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  try {
    await db.query('ALTER TABLE pacs_instances ADD COLUMN metadata_version INT NOT NULL DEFAULT 1');
  } catch (error: any) {
    if (error?.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }
}

async function collectDicomFiles(rootPath: string): Promise<StoredFile[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) {
          return [];
        }
        return collectDicomFiles(entryPath);
      }
      if (entry.name === 'image.db' || entry.name.endsWith('.json')) {
        return [];
      }
      const stat = await fs.stat(entryPath);
      return [{ path: entryPath, mtimeMs: Math.round(stat.mtimeMs) }];
    }),
  );
  return nested.flat();
}

/**
 * Index one stored DICOM file.
 *
 * `previous` lets a bulk walk hand in the mtime/version it already fetched in one
 * batch query, so the walk does not need a SELECT per file.
 * Returns null when the file is unchanged or is not an indexable DICOM object.
 */
async function upsertDicomFile(
  file: StoredFile,
  options: { previous?: KnownFile; sopOwners?: Map<string, string> } = {},
): Promise<UpsertOutcome> {
  const db = getPacsMetadataPool();
  const previous = options.previous;
  if (previous) {
    if (previous.mtimeMs === file.mtimeMs && previous.version >= metadataVersion) {
      return { kind: 'unchanged' };
    }
  } else {
    const [existing] = await db.query(
      'SELECT file_mtime_ms, metadata_version FROM pacs_instances WHERE file_path = ? LIMIT 1',
      [file.path],
    );
    const rows = existing as Array<{ file_mtime_ms: number; metadata_version?: number }>;
    if (rows[0] && Number(rows[0].file_mtime_ms) === file.mtimeMs && Number(rows[0].metadata_version || 1) >= metadataVersion) {
      return { kind: 'unchanged' };
    }
  }

  let dataset: dicomParser.DataSet;
  try {
    const buffer = await fs.readFile(file.path);
    dataset = dicomParser.parseDicom(buffer);
  } catch {
    // Not a readable DICOM object: never indexable at this mtime.
    return { kind: 'unindexable' };
  }
  const studyInstanceUid = datasetString(dataset, '0020000D');
  const seriesInstanceUid = datasetString(dataset, '0020000E');
  const sopInstanceUid = datasetString(dataset, '00080018');
  if (!studyInstanceUid || !seriesInstanceUid || !sopInstanceUid) {
    return { kind: 'unindexable' };
  }
  if (options.sopOwners) {
    const ownerPath = options.sopOwners.get(sopInstanceUid);
    if (ownerPath && ownerPath !== file.path) {
      return { kind: 'duplicate', sopInstanceUid, ownerPath };
    }
  }

  const studyJson = buildRecord(dataset, [
    '00080005',
    '00080020',
    '00080030',
    '00080050',
    '00080054',
    '00080056',
    '00080061',
    '00080080',
    '00080090',
    '00081030',
    '00081190',
    '00100010',
    '00100020',
    '00100030',
    '00100040',
    '0020000D',
    '00200010',
  ]);
  const seriesJson = buildRecord(dataset, [
    '00080005',
    '00080054',
    '00080056',
    '00080060',
    '0008103E',
    '00081190',
    '0020000D',
    '0020000E',
    '00200011',
  ]);
  const instanceJson = applySharedPixelMeasures(buildRecord(dataset, [
    '00080005',
    '00020010',
    '00080016',
    '00080018',
    '00080060',
    ...overlayMetadataTags,
    '00180050',
    '00180060',
    '00180088',
    '00181030',
    '00181100',
    '00181150',
    '00181151',
    '00181210',
    '00189311',
    '00189345',
    '0020000D',
    '0020000E',
    '00200013',
    '00201041',
    '00280002',
    '00280004',
    '00280006',
    '00280008',
    '00280010',
    '00280011',
    '00280030',
    '00280100',
    '00280101',
    '00280102',
    '00280103',
    '00281050',
    '00281051',
    '00281052',
      '00281053',
      '00200032',
      '00200037',
      '0040A730',
  ]), dataset);

  await db.query(
    `
    INSERT INTO pacs_studies (
      study_instance_uid, patient_id, patient_name, accession_number, study_date,
      study_time, study_description, study_id, referring_physician, study_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      patient_id = COALESCE(NULLIF(VALUES(patient_id), ''), pacs_studies.patient_id),
      patient_name = COALESCE(NULLIF(VALUES(patient_name), ''), pacs_studies.patient_name),
      accession_number = COALESCE(NULLIF(VALUES(accession_number), ''), pacs_studies.accession_number),
      study_date = COALESCE(NULLIF(VALUES(study_date), ''), pacs_studies.study_date),
      study_time = COALESCE(NULLIF(VALUES(study_time), ''), pacs_studies.study_time),
      study_description = COALESCE(NULLIF(VALUES(study_description), ''), pacs_studies.study_description),
      study_id = COALESCE(NULLIF(VALUES(study_id), ''), pacs_studies.study_id),
      referring_physician = COALESCE(NULLIF(VALUES(referring_physician), ''), pacs_studies.referring_physician),
      study_json = CASE
        WHEN NULLIF(VALUES(accession_number), '') IS NULL
         AND NULLIF(VALUES(study_description), '') IS NULL
         AND NULLIF(VALUES(referring_physician), '') IS NULL
        THEN pacs_studies.study_json
        ELSE VALUES(study_json)
      END
    `,
    [
      studyInstanceUid,
      datasetString(dataset, '00100020'),
      datasetString(dataset, '00100010'),
      datasetString(dataset, '00080050'),
      datasetString(dataset, '00080020'),
      datasetString(dataset, '00080030'),
      datasetString(dataset, '00081030'),
      datasetString(dataset, '00200010'),
      datasetString(dataset, '00080090'),
      JSON.stringify(studyJson),
    ],
  );

  await db.query(
    `
    INSERT INTO pacs_series (
      series_instance_uid, study_instance_uid, modality, series_number, series_description, series_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      study_instance_uid = VALUES(study_instance_uid),
      modality = VALUES(modality),
      series_number = VALUES(series_number),
      series_description = VALUES(series_description),
      series_json = VALUES(series_json)
    `,
    [
      seriesInstanceUid,
      studyInstanceUid,
      datasetString(dataset, '00080060'),
      datasetNumber(dataset, '00200011'),
      datasetString(dataset, '0008103E'),
      JSON.stringify(seriesJson),
    ],
  );

  await db.query(
    `
    INSERT INTO pacs_instances (
      sop_instance_uid, study_instance_uid, series_instance_uid, sop_class_uid,
      instance_number, file_path, file_mtime_ms, rows_value, columns_value, metadata_version, instance_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      study_instance_uid = VALUES(study_instance_uid),
      series_instance_uid = VALUES(series_instance_uid),
      sop_class_uid = VALUES(sop_class_uid),
      instance_number = VALUES(instance_number),
      file_path = VALUES(file_path),
      file_mtime_ms = VALUES(file_mtime_ms),
      rows_value = VALUES(rows_value),
      columns_value = VALUES(columns_value),
      metadata_version = VALUES(metadata_version),
      instance_json = VALUES(instance_json)
    `,
    [
      sopInstanceUid,
      studyInstanceUid,
      seriesInstanceUid,
      datasetString(dataset, '00080016'),
      datasetNumber(dataset, '00200013'),
      file.path,
      file.mtimeMs,
      datasetNumber(dataset, '00280010'),
      datasetNumber(dataset, '00280011'),
      metadataVersion,
      JSON.stringify(instanceJson),
    ],
  );

  return { kind: 'indexed', studyInstanceUid, seriesInstanceUid, sopInstanceUid };
}

async function refreshCounts(): Promise<void> {
  const db = getPacsMetadataPool();
  await db.query(`
    UPDATE pacs_series s SET instance_count = (
      SELECT COUNT(*) FROM pacs_instances i WHERE i.series_instance_uid = s.series_instance_uid
    )
  `);
  await db.query(`
    UPDATE pacs_studies st SET
      series_count = (SELECT COUNT(DISTINCT i.series_instance_uid) FROM pacs_instances i WHERE i.study_instance_uid = st.study_instance_uid),
      instance_count = (SELECT COUNT(*) FROM pacs_instances i WHERE i.study_instance_uid = st.study_instance_uid)
  `);
  await db.query(`
    UPDATE pacs_studies st SET modality_list = COALESCE(
      (SELECT STRING_AGG(DISTINCT s.modality, '\\' ORDER BY s.modality) FROM pacs_series s WHERE s.study_instance_uid = st.study_instance_uid),
      st.modality_list
    )
  `);
}

/**
 * Recompute counters for one study only.
 *
 * The full-table refreshCounts() above scans every instance three times; running it
 * per stored file made each C-STORE/STOW pay for the whole archive (815 instances =
 * 815 x 3 full scans). Counters for a single study are exact and index-bounded.
 */
async function refreshCountsForStudy(studyInstanceUid: string, seriesInstanceUid?: string): Promise<void> {
  const db = getPacsMetadataPool();
  if (seriesInstanceUid) {
    await db.query(
      `UPDATE pacs_series SET instance_count = (
        SELECT COUNT(*) FROM pacs_instances WHERE series_instance_uid = ?
      ) WHERE series_instance_uid = ?`,
      [seriesInstanceUid, seriesInstanceUid],
    );
  }
  await db.query(
    `UPDATE pacs_studies st SET
      series_count = (SELECT COUNT(DISTINCT i.series_instance_uid) FROM pacs_instances i WHERE i.study_instance_uid = st.study_instance_uid),
      instance_count = (SELECT COUNT(*) FROM pacs_instances i WHERE i.study_instance_uid = st.study_instance_uid),
      modality_list = COALESCE(
        (SELECT STRING_AGG(DISTINCT s.modality, '\\' ORDER BY s.modality) FROM pacs_series s WHERE s.study_instance_uid = st.study_instance_uid),
        st.modality_list
      )
    WHERE st.study_instance_uid = ?`,
    [studyInstanceUid],
  );
}

/**
 * Drop study/series rows that no instance points at any more.
 *
 * Runs only right after refreshCounts(), so a row that survives is one whose
 * counters were just recomputed from the instance table.
 */
async function removeOrphanRows(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  await db.query(`
    DELETE FROM pacs_series s
    WHERE NOT EXISTS (SELECT 1 FROM pacs_instances i WHERE i.series_instance_uid = s.series_instance_uid)
  `);
  await db.query(`
    DELETE FROM pacs_studies st
    WHERE NOT EXISTS (SELECT 1 FROM pacs_instances i WHERE i.study_instance_uid = st.study_instance_uid)
  `);
}

async function loadKnownFiles(filePaths: string[]): Promise<KnownFiles> {
  const byPath = new Map<string, KnownFile>();
  const sopOwners = new Map<string, string>();
  const db = getPacsMetadataPool();
  const chunkSize = 500;
  for (let index = 0; index < filePaths.length; index += chunkSize) {
    const slice = filePaths.slice(index, index + chunkSize);
    const [rows] = await db.query(
      'SELECT file_path, file_mtime_ms, metadata_version, sop_instance_uid FROM pacs_instances WHERE file_path IN (?)',
      [slice],
    );
    for (const row of rows as Array<{
      file_path: string;
      file_mtime_ms: number;
      metadata_version?: number;
      sop_instance_uid?: string;
    }>) {
      byPath.set(String(row.file_path), {
        mtimeMs: Number(row.file_mtime_ms),
        version: Number(row.metadata_version || 1),
      });
      if (row.sop_instance_uid) {
        sopOwners.set(String(row.sop_instance_uid), String(row.file_path));
      }
    }
  }
  return { byPath, sopOwners };
}

export async function indexStoredDicomFile(filePath: string): Promise<boolean> {
  if (!metadataEnabled()) {
    return false;
  }

  try {
    await ensurePacsMetadataTables();
    const stat = await fs.stat(filePath);
    const outcome = await upsertDicomFile({ path: filePath, mtimeMs: Math.round(stat.mtimeMs) });
    if (outcome.kind === 'indexed') {
      await refreshCountsForStudy(outcome.studyInstanceUid, outcome.seriesInstanceUid);
      return true;
    }
    return false;
  } catch (error) {
    // Never let indexing failures break the caller (STOW-RS already wrote the file).
    // Report the real error - previously these surfaced as "[object Object]".
    const message = describeError(error);
    metadataSyncStats.failures += 1;
    metadataSyncStats.lastError = message;
    LoggerSingleton.Instance.warn(`failed to index stored DICOM file ${filePath}: ${message}`);
    requestMetadataSync({ force: true, delayMs: metadataSyncDebounceMs, reason: 'index-failure' });
    return false;
  }
}

/**
 * Re-index a bounded set of study folders instead of walking the whole archive.
 *
 * QIDO/WADO answer from the metadata tables, so anything that rewrites or moves
 * DICOM files on disk has to get those tables back in sync. The full walk costs
 * O(archive) - measured ~3.9 s for a small dev archive and linear in file count -
 * which is prohibitively expensive when a DICOM Manager merge moves a handful of
 * series: the old code paid it once per source series. This scoped variant only
 * touches the given study folders (plus rows under them that lost their file),
 * so the cost stays proportional to what actually changed.
 */
export async function syncPacsMetadataForStudies(studyUids: string[]): Promise<{
  studies: number;
  files: number;
  indexed: number;
  unchanged: number;
  unindexable: number;
  removed: number;
  durationMs: number;
}> {
  const requested = Array.from(
    new Set(studyUids.map((uid) => String(uid || '').trim()).filter((uid) => /^[0-9.]+$/.test(uid))),
  );
  const result = { studies: 0, files: 0, indexed: 0, unchanged: 0, unindexable: 0, removed: 0, durationMs: 0 };
  if (!metadataEnabled() || !requested.length) {
    return result;
  }

  const startedAt = Date.now();
  const logger = LoggerSingleton.Instance;
  await ensurePacsMetadataTables();
  const storageRoot = path.resolve(config.get<string>(ConfParams.STORAGE_PATH));
  const db = getPacsMetadataPool();

  const folders: string[] = [];
  const files: StoredFile[] = [];
  for (const uid of requested) {
    const folder = path.join(storageRoot, uid);
    const stat = await fs.stat(folder).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }
    folders.push(folder);
    files.push(...(await collectDicomFiles(folder)));
  }
  result.studies = folders.length;
  result.files = files.length;

  if (files.length) {
    // Drop rows whose file no longer exists inside the scoped folders: a move
    // between studies leaves the old row pointing at the old path, and the walk
    // would only clean it up on the next full-archive pass.
    const alive = new Set(files.map((file) => path.resolve(file.path)));
    for (const folder of folders) {
      const [rows] = await db.query('SELECT file_path FROM pacs_instances WHERE file_path LIKE ?', [
        `${folder}${path.sep}%`,
      ]);
      const stale: string[] = [];
      for (const row of rows as Array<{ file_path?: string }>) {
        const filePath = String(row?.file_path || '');
        if (!filePath || alive.has(path.resolve(filePath))) {
          continue;
        }
        const exists = await fs.stat(filePath).then(() => true).catch(() => false);
        if (!exists) {
          stale.push(filePath);
        }
      }
      for (let index = 0; index < stale.length; index += 500) {
        const slice = stale.slice(index, index + 500);
        const [deleteResult] = await db.query('DELETE FROM pacs_instances WHERE file_path IN (?)', [slice]);
        result.removed += Number((deleteResult as { affectedRows?: number })?.affectedRows || 0);
      }
    }
  }

  const known = await loadKnownFiles(files.map((file) => file.path));
  for (const file of files) {
    const previous = known.byPath.get(file.path);
    if (previous && previous.mtimeMs === file.mtimeMs && previous.version >= metadataVersion) {
      result.unchanged += 1;
      continue;
    }
    try {
      const outcome = await upsertDicomFile(file, { previous, sopOwners: known.sopOwners });
      if (outcome.kind === 'indexed') {
        result.indexed += 1;
        known.sopOwners.set(outcome.sopInstanceUid, file.path);
      } else if (outcome.kind === 'unchanged') {
        result.unchanged += 1;
      } else {
        result.unindexable += 1;
      }
    } catch (error) {
      result.unindexable += 1;
      logger.warn(`scoped metadata sync failed for ${file.path}: ${describeError(error)}`);
    }
  }

  for (const uid of requested) {
    await refreshCountsForStudy(uid).catch(() => undefined);
  }
  // pacs_series.instance_count is not covered by refreshCountsForStudy (its second
  // argument is the series UID), and upsertDicomFile only rewrites the series row
  // for files it re-indexes - so an unchanged folder keeps a stale count, which
  // makes a series look empty in QIDO. Recompute the counters for every series of
  // the studies we touched.
  for (const uid of requested) {
    const [seriesRows] = await db.query(
      'SELECT series_instance_uid FROM pacs_series WHERE study_instance_uid = ?',
      [uid],
    ).catch(() => [[]]);
    for (const row of seriesRows as Array<{ series_instance_uid?: string }>) {
      if (!row?.series_instance_uid) continue;
      await refreshCountsForStudy(uid, String(row.series_instance_uid)).catch(() => undefined);
    }
  }
  if (result.removed > 0) {
    await removeOrphanRows(db);
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(
    `VEXAPACS scoped metadata sync ${result.studies} study(ies) ${result.files} file(s) in ${result.durationMs} ms: ` +
      `${result.indexed} indexed, ${result.unchanged} unchanged, ${result.unindexable} not indexable, ${result.removed} row(s) pruned`,
  );
  return result;
}

export async function syncPacsMetadataFromStorage(force = false): Promise<void> {
  if (!metadataEnabled()) {
    return;
  }
  const now = Date.now();
  if (!force && metadataSyncExpiresAt > now) {
    return;
  }
  if (metadataSyncPromise) {
    return metadataSyncPromise;
  }

  metadataSyncPromise = (async () => {
    const startedAt = Date.now();
    const logger = LoggerSingleton.Instance;
    await ensurePacsMetadataTables();
    const files = await collectDicomFiles(config.get<string>(ConfParams.STORAGE_PATH));
    const filePaths = files.map((file) => file.path);
    const db = getPacsMetadataPool();
    let removedRows = 0;
    if (filePaths.length) {
      const [deleteResult] = await db.query('DELETE FROM pacs_instances WHERE file_path NOT IN (?)', [filePaths]);
      removedRows = Number((deleteResult as { affectedRows?: number })?.affectedRows || 0);
    } else {
      await db.query('DELETE FROM pacs_instances');
      removedRows = 1;
    }
    if (removedRows > 0) {
      await removeOrphanRows(db);
    }

    // One batched lookup instead of a SELECT per file.
    const known = await loadKnownFiles(filePaths);
    const dirtyStudies = new Set<string>();
    let indexed = 0;
    let unchanged = 0;
    let unindexable = 0;
    let skippedByRejectCache = 0;
    let duplicates = 0;
    let skippedByDuplicateCache = 0;
    for (const file of files) {
      const previous = known.byPath.get(file.path);
      if (previous && previous.mtimeMs === file.mtimeMs && previous.version >= metadataVersion) {
        unchanged += 1;
        continue;
      }
      if (rejectedFiles.get(file.path) === file.mtimeMs) {
        skippedByRejectCache += 1;
        continue;
      }
      if (duplicateFiles.get(file.path) === file.mtimeMs) {
        skippedByDuplicateCache += 1;
        continue;
      }
      try {
        const outcome = await upsertDicomFile(file, { previous, sopOwners: known.sopOwners });
        switch (outcome.kind) {
          case 'indexed':
            indexed += 1;
            dirtyStudies.add(outcome.studyInstanceUid);
            known.sopOwners.set(outcome.sopInstanceUid, file.path);
            rejectedFiles.delete(file.path);
            break;
          case 'unchanged':
            unchanged += 1;
            break;
          case 'duplicate':
            duplicates += 1;
            if (duplicateFileLimit > 0 && duplicateFiles.size < duplicateFileLimit) {
              duplicateFiles.set(file.path, file.mtimeMs);
            }
            break;
          case 'unindexable':
            unindexable += 1;
            if (rejectedFileLimit > 0 && rejectedFiles.size < rejectedFileLimit) {
              rejectedFiles.set(file.path, file.mtimeMs);
            }
            break;
        }
      } catch (error) {
        logger.warn(`failed to sync PACS metadata ${file.path}: ${describeError(error)}`);
      }
    }

    // Rows were deleted, or duplicate SOP UIDs changed which file owns a row:
    // counters may be stale anywhere, so pay for one full refresh.
    if (removedRows > 0 || duplicates > 0) {
      await refreshCounts();
      await removeOrphanRows(db);
    } else {
      for (const studyInstanceUid of dirtyStudies) {
        await refreshCountsForStudy(studyInstanceUid);
      }
    }

    metadataSyncExpiresAt = Date.now() + metadataSyncTtlMs;
    metadataSyncCompletedOnce = true;
    metadataIndexPopulated = true;
    metadataSyncStats.fullSyncs += 1;
    if (force) {
      metadataSyncStats.backgroundSyncs += 1;
    }
    metadataSyncStats.lastSyncMs = Date.now() - startedAt;
    metadataSyncStats.lastScanFiles = files.length;
    metadataSyncStats.lastIndexedFiles = indexed;
    metadataSyncStats.lastUnchangedFiles = unchanged;
    metadataSyncStats.lastUnindexableFiles = unindexable;
    metadataSyncStats.skippedByRejectCache = skippedByRejectCache;
    metadataSyncStats.lastDuplicateFiles = duplicates;
    metadataSyncStats.skippedByDuplicateCache = skippedByDuplicateCache;
    metadataSyncStats.lastSyncAt = new Date().toISOString();
    metadataSyncStats.lastError = null;
    logger.info(
      `VEXAPACS metadata sync scanned ${files.length} file(s) in ${metadataSyncStats.lastSyncMs} ms: ` +
        `${indexed} indexed, ${unchanged} unchanged, ${unindexable} not indexable, ${duplicates} duplicate, ` +
        `${skippedByRejectCache + skippedByDuplicateCache} skipped (cache)`,
    );
  })()
    .catch((error) => {
      metadataSyncStats.failures += 1;
      metadataSyncStats.lastError = describeError(error);
      LoggerSingleton.Instance.warn(`PACS metadata sync failed: ${describeError(error)}`);
    })
    .finally(() => {
      metadataSyncPromise = null;
    });

  return metadataSyncPromise;
}

/**
 * Queue a storage walk in the background.
 *
 * The walk is debounced so a 800-instance study arriving over C-STORE schedules one
 * pass instead of one per instance, and it never runs in the request path.
 */
export function requestMetadataSync(
  options: { force?: boolean; delayMs?: number; reason?: string } = {},
): void {
  if (!metadataEnabled()) {
    return;
  }
  if (options.force) {
    pendingForcedSync = true;
  }
  const delayMs = Math.max(0, options.delayMs ?? metadataSyncDebounceMs);
  if (metadataSyncTimer) {
    clearTimeout(metadataSyncTimer);
  }
  metadataSyncStats.scheduledSyncs += 1;
  metadataSyncTimer = setTimeout(() => {
    metadataSyncTimer = null;
    const force = pendingForcedSync;
    pendingForcedSync = false;
    void syncPacsMetadataFromStorage(force);
  }, delayMs);
  if (typeof (metadataSyncTimer as { unref?: () => void }).unref === 'function') {
    (metadataSyncTimer as { unref: () => void }).unref();
  }
}

/**
 * Serve queries from the current index and refresh behind them.
 *
 * QIDO used to await a full storage walk every time the TTL expired (measured 3.9 s
 * for 36 studies, linear in archive size). Only the very first sync after startup
 * blocks, so a cold index still answers with data.
 */
export async function scheduleMetadataRefreshIfStale(): Promise<void> {
  if (!metadataEnabled()) {
    return;
  }
  if (metadataSyncPromise || metadataSyncTimer) {
    return;
  }
  if (metadataSyncExpiresAt > Date.now()) {
    return;
  }
  // Claim the window so parallel queries do not each queue a walk.
  metadataSyncExpiresAt = Date.now() + metadataSyncTtlMs;
  if (metadataIndexPopulated === null) {
    // First query of this process: only block when the index is really empty
    // (fresh install). A populated index is served from the tables immediately.
    try {
      metadataIndexPopulated = await pacsMetadataHasRows();
    } catch {
      metadataIndexPopulated = false;
    }
  }
  if (!metadataIndexPopulated) {
    metadataSyncStats.scheduledSyncs += 1;
    try {
      await syncPacsMetadataFromStorage();
    } catch {
      /* logged inside the walk */
    }
    metadataIndexPopulated = true;
    return;
  }
  // force: the walk must not be skipped by the TTL window we just claimed.
  requestMetadataSync({ force: true, delayMs: 0, reason: 'query-ttl' });
}

/** Cheap "is the index already usable" probe, done once per process. */
async function pacsMetadataHasRows(): Promise<boolean> {
  const db = getPacsMetadataPool();
  const [rows] = await db.query('SELECT 1 AS present FROM pacs_studies LIMIT 1');
  return Array.isArray(rows) && rows.length > 0;
}

/** Periodic maintenance walk so files copied into storage outside DIMSE are still found. */
export function startMetadataSyncScheduler(): void {
  if (!metadataEnabled() || metadataSyncIntervalMs <= 0 || metadataSyncInterval) {
    return;
  }
  metadataSyncInterval = setInterval(() => {
    if (!metadataSyncPromise) {
      requestMetadataSync({ force: true, delayMs: 0, reason: 'interval' });
    }
  }, metadataSyncIntervalMs);
  if (typeof (metadataSyncInterval as { unref?: () => void }).unref === 'function') {
    (metadataSyncInterval as { unref: () => void }).unref();
  }
  LoggerSingleton.Instance.info(
    `PACS metadata sync scheduler every ${Math.round(metadataSyncIntervalMs / 1000)} s ` +
      `(ttl ${Math.round(metadataSyncTtlMs / 1000)} s, debounce ${Math.round(metadataSyncDebounceMs / 1000)} s)`,
  );
}

export function stopMetadataSyncScheduler(): void {
  if (metadataSyncInterval) {
    clearInterval(metadataSyncInterval);
    metadataSyncInterval = null;
  }
}

export function getMetadataSyncStats(): MetadataSyncStats {
  return {
    enabled: metadataEnabled(),
    ...metadataSyncStats,
    syncInFlight: metadataSyncPromise !== null,
    hasCompletedOnce: metadataSyncCompletedOnce,
    ttlMs: metadataSyncTtlMs,
    debounceMs: metadataSyncDebounceMs,
    intervalMs: metadataSyncIntervalMs,
    rejectedCached: rejectedFiles.size,
    duplicateCached: duplicateFiles.size,
  };
}

function sqlForFilter(filter: QueryFilter, alias: string): { sql: string; params: string[] } | null {
  const column = columnByTag[filter.tag];
  if (!column) {
    return null;
  }
  const value = String(filter.value || '').trim();
  if (!value) {
    return null;
  }
  if (filter.tag === '00080020' && value.includes('-')) {
    const [start, end] = value.split('-', 2);
    const parts: string[] = [];
    const params: string[] = [];
    if (start) {
      parts.push(`${alias}.${column} >= ?`);
      params.push(start);
    }
    if (end) {
      parts.push(`${alias}.${column} <= ?`);
      params.push(end);
    }
    return parts.length ? { sql: parts.join(' AND '), params } : null;
  }
  if (value.includes('*')) {
    return { sql: `${alias}.${column} LIKE ?`, params: [value.replace(/\*/g, '%')] };
  }
  return { sql: `${alias}.${column} = ?`, params: [value] };
}

function parseJsonRecord(value: unknown): DicomJsonRecord {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function withGeneratedStudyFields(row: any, record: DicomJsonRecord): DicomJsonRecord {
  const next = { ...record };
  const studyFieldTags: Array<[string, string]> = [
    ['00100020', 'patient_id'],
    ['00100010', 'patient_name'],
    ['00080050', 'accession_number'],
    ['00080020', 'study_date'],
    ['00080030', 'study_time'],
    ['00081030', 'study_description'],
    ['00200010', 'study_id'],
    ['00080090', 'referring_physician'],
  ];
  for (const [tag, column] of studyFieldTags) {
    const value = row[column];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      next[tag] = jsonElement(tag, value) as DicomJsonElement;
    }
  }
  if (row.modality_list) {
    next['00080061'] = jsonElement('00080061', row.modality_list) as DicomJsonElement;
  }
  next['00201206'] = jsonElement('00201206', Number(row.series_count || 0)) as DicomJsonElement;
  next['00201208'] = jsonElement('00201208', Number(row.instance_count || 0)) as DicomJsonElement;
  return next;
}

function withGeneratedSeriesFields(row: any, record: DicomJsonRecord): DicomJsonRecord {
  const next = { ...record };
  next['00201209'] = jsonElement('00201209', Number(row.instance_count || 0)) as DicomJsonElement;
  return next;
}

export async function queryPacsMetadata(
  level: QUERY_LEVEL,
  requestedTags: string[],
  filters: QueryFilter[],
): Promise<DicomJsonRecord[] | null> {
  if (!metadataEnabled()) {
    return null;
  }
  await scheduleMetadataRefreshIfStale();
  const db = getPacsMetadataPool();
  const where: string[] = [];
  const params: string[] = [];

  if (level === QUERY_LEVEL.STUDY) {
    for (const filter of filters) {
      const condition = sqlForFilter(filter, 'st');
      if (condition) {
        where.push(condition.sql);
        params.push(...condition.params);
      }
    }
    const [rows] = await db.query(
      `
      SELECT *
      FROM pacs_studies st
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY st.study_date DESC, st.study_time DESC
      `,
      params,
    );
    return (rows as any[]).map((row) =>
      pickRecord(withGeneratedStudyFields(row, parseJsonRecord(row.study_json)), requestedTags),
    );
  }

  if (level === QUERY_LEVEL.SERIES) {
    for (const filter of filters) {
      const condition = sqlForFilter(filter, filter.tag === '0020000E' || filter.tag === '00080060' ? 's' : 'st');
      if (condition) {
        where.push(condition.sql);
        params.push(...condition.params);
      }
    }
    const [rows] = await db.query(
      `
      SELECT s.*, st.study_json
      FROM pacs_series s
      INNER JOIN pacs_studies st ON st.study_instance_uid = s.study_instance_uid
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.series_number IS NULL, s.series_number, s.series_instance_uid
      `,
      params,
    );
    return (rows as any[]).map((row) =>
      pickRecord(
        withGeneratedSeriesFields(row, mergeRecords(parseJsonRecord(row.study_json), parseJsonRecord(row.series_json))),
        requestedTags,
      ),
    );
  }

  for (const filter of filters) {
    const alias = filter.tag === '00080018' ? 'i' : filter.tag === '0020000E' || filter.tag === '00080060' ? 's' : 'st';
    const condition = sqlForFilter(filter, alias);
    if (condition) {
      where.push(condition.sql);
      params.push(...condition.params);
    }
  }
  const [rows] = await db.query(
    `
    SELECT i.*, s.series_json, st.study_json
    FROM pacs_instances i
    INNER JOIN pacs_series s ON s.series_instance_uid = i.series_instance_uid
    INNER JOIN pacs_studies st ON st.study_instance_uid = i.study_instance_uid
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.instance_number IS NULL, i.instance_number, i.sop_instance_uid
    `,
    params,
  );
  return (rows as any[]).map((row) =>
    pickRecord(
      mergeRecords(parseJsonRecord(row.study_json), parseJsonRecord(row.series_json), parseJsonRecord(row.instance_json)),
      requestedTags,
    ),
  );
}
