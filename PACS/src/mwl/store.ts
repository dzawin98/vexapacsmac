import fs from 'fs/promises';
import path from 'path';
import { getPacsMetadataPool } from '../dimse/metadataDb';
import { ConfParams, config } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';

type MwlTags = Record<string, any>;

export interface MwlRecord {
  id: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  accessionNumber: string;
  studyInstanceUid: string;
  patientId: string;
  patientName: string;
  modality: string;
  stationAet: string;
  scheduledDate: string;
  scheduledTime: string;
  tags: MwlTags;
  dicomTags?: MwlTags;
  meta?: MwlTags;
  sourcePayload?: MwlTags;
}

export interface MwlQuery {
  active?: string;
  AccessionNumber?: string;
  StudyInstanceUID?: string;
  PatientID?: string;
  PatientName?: string;
  Modality?: string;
  ScheduledStationAETitle?: string;
  ScheduledProcedureStepStartDate?: string;
}

interface MwlRow {
  id: string;
  active: number;
  created_at: Date | string;
  updated_at: Date | string;
  accession_number: string | null;
  study_instance_uid: string | null;
  patient_id: string | null;
  patient_name: string | null;
  modality: string | null;
  station_aet: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  tags_json: string | null;
  dicom_tags_json: string | null;
  meta_json: string | null;
  source_payload_json: string | null;
}

const logger = LoggerSingleton.Instance;
let mwlTableReady: Promise<void> | null = null;

function mwlRoot(): string {
  const configured = process.env.DICOMWEB_PACS_MWL_PATH || process.env.MWL_STORAGE_PATH;
  return configured ? path.resolve(configured) : path.resolve(config.get<string>(ConfParams.STORAGE_PATH), '_mwl');
}

function cleanId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
}

function makeId(tags: MwlTags): string {
  const accession = String(tags.AccessionNumber || '').trim();
  const study = String(tags.StudyInstanceUID || '').trim();
  const base = accession || study || `${Date.now()}`;
  return cleanId(base);
}

function getFirstSps(tags: MwlTags): MwlTags {
  const sequence = tags.ScheduledProcedureStepSequence;
  if (Array.isArray(sequence) && sequence[0] && typeof sequence[0] === 'object') {
    return sequence[0];
  }
  return {};
}

function extractTags(payload: MwlTags): MwlTags {
  if (payload?.Tags && typeof payload.Tags === 'object') {
    return payload.Tags;
  }
  if (payload?.orthancRequest?.Tags && typeof payload.orthancRequest.Tags === 'object') {
    return payload.orthancRequest.Tags;
  }
  return payload || {};
}

function validateTags(tags: MwlTags) {
  const sps = getFirstSps(tags);
  const required: [string, unknown][] = [
    ['PatientName', tags.PatientName],
    ['PatientID', tags.PatientID],
    ['PatientBirthDate', tags.PatientBirthDate],
    ['PatientSex', tags.PatientSex],
    ['AccessionNumber', tags.AccessionNumber],
    ['RequestedProcedureDescription', tags.RequestedProcedureDescription],
    ['StudyInstanceUID', tags.StudyInstanceUID],
    ['ScheduledProcedureStepSequence[0].Modality', sps.Modality],
    ['ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate', sps.ScheduledProcedureStepStartDate],
    ['ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartTime', sps.ScheduledProcedureStepStartTime],
  ];
  const missing = required.filter(([, value]) => !String(value || '').trim()).map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing MWL required fields: ${missing.join(', ')}`);
  }
}

async function ensureMwlRoot() {
  await fs.mkdir(mwlRoot(), { recursive: true });
}

function recordPath(id: string): string {
  return path.join(mwlRoot(), `${cleanId(id)}.json`);
}

async function writeRecordMirror(record: MwlRecord): Promise<void> {
  await ensureMwlRoot();
  await fs.writeFile(recordPath(record.id), JSON.stringify(record, null, 2), 'utf8');
}

async function readRecordMirror(id: string): Promise<MwlRecord | null> {
  try {
    const raw = await fs.readFile(recordPath(id), 'utf8');
    return JSON.parse(raw) as MwlRecord;
  } catch {
    return null;
  }
}

function jsonText(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value ?? null);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toIsoString(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function mapRowToRecord(row: MwlRow): MwlRecord {
  return {
    id: row.id,
    active: Boolean(row.active),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    accessionNumber: String(row.accession_number || ''),
    studyInstanceUid: String(row.study_instance_uid || ''),
    patientId: String(row.patient_id || ''),
    patientName: String(row.patient_name || ''),
    modality: String(row.modality || ''),
    stationAet: String(row.station_aet || ''),
    scheduledDate: String(row.scheduled_date || ''),
    scheduledTime: String(row.scheduled_time || ''),
    tags: parseJson<MwlTags>(row.tags_json, {}),
    dicomTags: parseJson<MwlTags | undefined>(row.dicom_tags_json, undefined),
    meta: parseJson<MwlTags | undefined>(row.meta_json, undefined),
    sourcePayload: parseJson<MwlTags | undefined>(row.source_payload_json, undefined),
  };
}

async function ensureMwlTable(): Promise<void> {
  if (!mwlTableReady) {
    mwlTableReady = (async () => {
      const db = getPacsMetadataPool();
      await db.query(`
        CREATE TABLE IF NOT EXISTS mwl_worklists (
          id VARCHAR(180) PRIMARY KEY,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          accession_number VARCHAR(128) NULL,
          study_instance_uid VARCHAR(128) NULL,
          patient_id VARCHAR(128) NULL,
          patient_name VARCHAR(255) NULL,
          modality VARCHAR(32) NULL,
          station_aet VARCHAR(64) NULL,
          scheduled_date VARCHAR(32) NULL,
          scheduled_time VARCHAR(32) NULL,
          tags_json LONGTEXT NULL,
          dicom_tags_json LONGTEXT NULL,
          meta_json LONGTEXT NULL,
          source_payload_json LONGTEXT NULL,
          INDEX idx_mwl_worklists_active (active),
          INDEX idx_mwl_worklists_updated_at (updated_at),
          INDEX idx_mwl_worklists_accession (accession_number),
          INDEX idx_mwl_worklists_study_uid (study_instance_uid),
          INDEX idx_mwl_worklists_patient_id (patient_id),
          INDEX idx_mwl_worklists_modality (modality),
          INDEX idx_mwl_worklists_station_aet (station_aet)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    })().catch((error) => {
      mwlTableReady = null;
      throw error;
    });
  }
  await mwlTableReady;
}

function matches(value: string, expected?: string): boolean {
  const needle = String(expected || '').trim();
  if (!needle) return true;
  const haystack = String(value || '');
  if (needle.endsWith('*')) {
    return haystack.toLowerCase().startsWith(needle.slice(0, -1).toLowerCase());
  }
  return haystack.toLowerCase() === needle.toLowerCase();
}

function filterRecords(records: MwlRecord[], query: MwlQuery): MwlRecord[] {
  const activeFilter = String(query.active ?? 'true').toLowerCase();
  return records
    .filter((record) => {
      if (!['all', '*', ''].includes(activeFilter)) {
        const wantsActive = !['0', 'false', 'no', 'inactive'].includes(activeFilter);
        if (record.active !== wantsActive) return false;
      }
      return (
        matches(record.accessionNumber, query.AccessionNumber) &&
        matches(record.studyInstanceUid, query.StudyInstanceUID) &&
        matches(record.patientId, query.PatientID) &&
        matches(record.patientName, query.PatientName) &&
        matches(record.modality, query.Modality) &&
        matches(record.stationAet, query.ScheduledStationAETitle) &&
        matches(record.scheduledDate, query.ScheduledProcedureStepStartDate)
      );
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function loadRecordsFromMirror(): Promise<MwlRecord[]> {
  await ensureMwlRoot();
  const files = await fs.readdir(mwlRoot());
  const records = await Promise.all(
    files
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .map((file) =>
        fs.readFile(path.join(mwlRoot(), file), 'utf8').then((raw) => JSON.parse(raw) as MwlRecord),
      ),
  );
  return records;
}

export async function saveWorklist(payload: MwlTags): Promise<MwlRecord> {
  const tags = extractTags(payload);
  validateTags(tags);
  await ensureMwlTable();
  const sps = getFirstSps(tags);
  const id = makeId(tags);
  const db = getPacsMetadataPool();
  const now = new Date().toISOString();
  const record: MwlRecord = {
    id,
    active: true,
    createdAt: now,
    updatedAt: now,
    accessionNumber: String(tags.AccessionNumber || ''),
    studyInstanceUid: String(tags.StudyInstanceUID || ''),
    patientId: String(tags.PatientID || ''),
    patientName: String(tags.PatientName || ''),
    modality: String(sps.Modality || ''),
    stationAet: String(sps.ScheduledStationAETitle || ''),
    scheduledDate: String(sps.ScheduledProcedureStepStartDate || ''),
    scheduledTime: String(sps.ScheduledProcedureStepStartTime || ''),
    tags,
    dicomTags: payload?.dicomTags,
    meta: payload?.meta,
    sourcePayload: payload,
  };
  await db.query(
    `
    INSERT INTO mwl_worklists (
      id, active, accession_number, study_instance_uid, patient_id, patient_name,
      modality, station_aet, scheduled_date, scheduled_time,
      tags_json, dicom_tags_json, meta_json, source_payload_json
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      active = VALUES(active),
      accession_number = VALUES(accession_number),
      study_instance_uid = VALUES(study_instance_uid),
      patient_id = VALUES(patient_id),
      patient_name = VALUES(patient_name),
      modality = VALUES(modality),
      station_aet = VALUES(station_aet),
      scheduled_date = VALUES(scheduled_date),
      scheduled_time = VALUES(scheduled_time),
      tags_json = VALUES(tags_json),
      dicom_tags_json = VALUES(dicom_tags_json),
      meta_json = VALUES(meta_json),
      source_payload_json = VALUES(source_payload_json)
    `,
    [
      record.id,
      record.accessionNumber,
      record.studyInstanceUid,
      record.patientId,
      record.patientName,
      record.modality,
      record.stationAet || null,
      record.scheduledDate,
      record.scheduledTime,
      jsonText(record.tags),
      jsonText(record.dicomTags),
      jsonText(record.meta),
      jsonText(record.sourcePayload),
    ],
  );
  await writeRecordMirror(record).catch((error) => {
    logger.warn('[mwl] failed to write mirror file', error);
  });
  return record;
}

export async function listWorklists(query: MwlQuery = {}): Promise<MwlRecord[]> {
  try {
    await ensureMwlTable();
    const db = getPacsMetadataPool();
    const [rows]: [MwlRow[]] = await db.query(
      `
      SELECT
        id,
        active,
        created_at,
        updated_at,
        accession_number,
        study_instance_uid,
        patient_id,
        patient_name,
        modality,
        station_aet,
        scheduled_date,
        scheduled_time,
        tags_json,
        dicom_tags_json,
        meta_json,
        source_payload_json
      FROM mwl_worklists
      ORDER BY updated_at DESC
      `,
    );
    return filterRecords(rows.map(mapRowToRecord), query);
  } catch (error) {
    logger.warn('[mwl] failed to read database-backed worklists, falling back to mirror files', error);
    return filterRecords(await loadRecordsFromMirror(), query);
  }
}

export async function getWorklist(id: string): Promise<MwlRecord | null> {
  try {
    await ensureMwlTable();
    const db = getPacsMetadataPool();
    const [rows]: [MwlRow[]] = await db.query(
      `
      SELECT
        id,
        active,
        created_at,
        updated_at,
        accession_number,
        study_instance_uid,
        patient_id,
        patient_name,
        modality,
        station_aet,
        scheduled_date,
        scheduled_time,
        tags_json,
        dicom_tags_json,
        meta_json,
        source_payload_json
      FROM mwl_worklists
      WHERE id = ?
      LIMIT 1
      `,
      [cleanId(id)],
    );
    if (rows.length) {
      return mapRowToRecord(rows[0]);
    }
  } catch (error) {
    logger.warn('[mwl] failed to read worklist from database, falling back to mirror file', error);
  }
  return readRecordMirror(id);
}

export async function deactivateWorklist(id: string): Promise<MwlRecord | null> {
  const recordId = cleanId(id);
  let record = await getWorklist(recordId);
  if (!record) return null;
  record = {
    ...record,
    active: false,
    updatedAt: new Date().toISOString(),
  };
  try {
    await ensureMwlTable();
    const db = getPacsMetadataPool();
    await db.query(
      `
      UPDATE mwl_worklists
      SET active = 0
      WHERE id = ?
      `,
      [recordId],
    );
  } catch (error) {
    logger.warn('[mwl] failed to deactivate worklist in database, mirror file will still be updated', error);
  }
  await writeRecordMirror(record).catch((error) => {
    logger.warn('[mwl] failed to write mirror file during deactivation', error);
  });
  return record;
}
