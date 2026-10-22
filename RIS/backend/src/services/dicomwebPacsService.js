const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fetch = require('node-fetch');
const dicomParser = require('dicom-parser');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const AdmZip = require('adm-zip');
const postgres = require('./postgresCompat');
const dicomConfig = require('../../config/dicom');
const pool = require('./db');
const { createCache } = require('../utils/cache');

const QIDO_CACHE_TTL_MS = dicomConfig.dicomweb.cacheTtlMs;
// Date ranges that end before today can no longer receive new studies, so they
// are worth a longer TTL than the today-window worklist.
const QIDO_PAST_STUDY_TTL_MS = Number(process.env.DICOMWEB_PAST_CACHE_TTL_MS || 5 * 60 * 1000);
// Entries stay readable after their TTL so a request can be answered from
// memory while the refresh runs behind it.
const QIDO_STALE_MS = Number(process.env.DICOMWEB_CACHE_STALE_MS || Math.max(QIDO_CACHE_TTL_MS * 4, 60 * 1000));
const qidoCache = createCache(
  QIDO_CACHE_TTL_MS,
  dicomConfig.dicomweb.cacheMaxEntries,
  { staleMs: QIDO_STALE_MS }
);
// Preview cache: cheap to keep, expensive to redraw (1 ms hit vs 25-47 ms re-render once the
// PACS frame cache has let go). Env-tunable because each 512x512 preview holds 20-60 KB.
const previewCacheTtlMs = Math.max(1000, Number(process.env.RIS_PREVIEW_CACHE_MS || 10 * 60 * 1000));
const previewCacheMaxEntries = Math.max(50, Number(process.env.RIS_PREVIEW_CACHE_MAX || 1500));
const previewCache = createCache(previewCacheTtlMs, previewCacheMaxEntries);
// Thumbnails are immutable per series, so they can live much longer than previews.
const seriesThumbnailCache = createCache(30 * 60 * 1000, 2000);
const seriesThumbnailInFlight = new Map();

const PACS_RS_ROOT = String(dicomConfig.dicomweb.pacsRsRoot || 'http://127.0.0.1:5001/rs').replace(/\/+$/, '');
const PACS_STORAGE_PATH = path.resolve(dicomConfig.dicomweb.pacsStoragePath);
const PACS_PACKAGE_ROOT = path.resolve(dicomConfig.dicomweb.pacsPackageRoot);
const DICOM_BACKUP_ROOT = path.join(PACS_STORAGE_PATH, '.metadata-backups');
const MANAGER_HISTORY_ROOT = path.join(PACS_STORAGE_PATH, '.manager-history');
const METADATA_OVERRIDE_FILENAME = '.nexia-metadata-overrides.json';
const PREVIEW_RENDER_VERSION = 'dicom-rendered-physical-v7';
let pacsMetadataPool = null;

function parseJsonValue(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const studyOverrideTags = {
  StudyInstanceUID: ['0020000D', 'UI'],
  SeriesInstanceUID: ['0020000E', 'UI'],
  PatientName: ['00100010', 'PN'],
  PatientID: ['00100020', 'LO'],
  OtherPatientIDs: ['00101000', 'LO'],
  PatientBirthDate: ['00100030', 'DA'],
  PatientSex: ['00100040', 'CS'],
  AccessionNumber: ['00080050', 'SH'],
  InstitutionName: ['00080080', 'LO'],
  StudyDescription: ['00081030', 'LO'],
  ReferringPhysicianName: ['00080090', 'PN'],
  StudyDate: ['00080020', 'DA'],
  StudyTime: ['00080030', 'TM'],
  StudyID: ['00200010', 'SH'],
  Modality: ['00080060', 'CS'],
  SeriesDescription: ['0008103E', 'LO'],
  SeriesNumber: ['00200011', 'IS'],
  BodyPartExamined: ['00180015', 'CS'],
  ProtocolName: ['00181030', 'LO'],
  Laterality: ['00200060', 'CS'],
  InstanceNumber: ['00200013', 'IS'],
  ImageComments: ['00204000', 'LT'],
  ViewPosition: ['00185101', 'CS'],
};

const textVrByKeyword = Object.fromEntries(
  Object.entries(studyOverrideTags).map(([keyword, [, vr]]) => [keyword, vr])
);

function normalizeUid(value) {
  const uid = String(value || '').trim();
  if (!/^[0-9.]+$/.test(uid)) {
    const error = new Error('Invalid DICOM UID');
    error.status = 400;
    throw error;
  }
  return uid;
}

function generateDicomUid(suffix = '') {
  const stamp = Date.now();
  const rand = Number.parseInt(crypto.randomBytes(4).toString('hex'), 16);
  const cleanSuffix = String(suffix || '').replace(/[^0-9]/g, '').slice(0, 8);
  return `1.2.826.0.1.3680043.10.5432.${stamp}.${rand}${cleanSuffix ? `.${cleanSuffix}` : ''}`;
}

function tag(vr, value) {
  if (value === null || value === undefined || value === '') {
    return { vr };
  }
  return { vr, Value: [String(value)] };
}

function tagPN(value) {
  if (!value) {
    return { vr: 'PN' };
  }
  return { vr: 'PN', Value: [{ Alphabetic: String(value) }] };
}

function dicomJsonElement(tagId, value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  const pnTags = new Set(['00100010', '00080090']);
  const uiTags = new Set(['0020000D']);
  const daTags = new Set(['00080020', '00100030']);
  const tmTags = new Set(['00080030']);
  const csTags = new Set(['00100040', '00080061']);
  const vr =
    pnTags.has(tagId) ? 'PN' :
    uiTags.has(tagId) ? 'UI' :
    daTags.has(tagId) ? 'DA' :
    tmTags.has(tagId) ? 'TM' :
    csTags.has(tagId) ? 'CS' :
    'LO';
  if (!text) return { vr };
  if (vr === 'PN') return { vr, Value: [{ Alphabetic: text }] };
  return { vr, Value: [text] };
}

function normalizeDicomDate(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.slice(0, 8);
}

function normalizeDicomTime(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.slice(0, 6);
}

function getDicomString(record, tagId) {
  const value = record?.[tagId]?.Value?.[0];
  if (value && typeof value === 'object' && value.Alphabetic) {
    return String(value.Alphabetic);
  }
  return value === undefined || value === null ? '' : String(value);
}

function getDicomNumber(record, tagId, fallback = Number.POSITIVE_INFINITY) {
  const value = record?.[tagId]?.Value?.[0];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getStudyUid(record) {
  return getDicomString(record, '0020000D');
}

function getSeriesUid(record) {
  return getDicomString(record, '0020000E');
}

function getInstanceUid(record) {
  return getDicomString(record, '00080018');
}

function dicomRecordFromDataset(dataset, fallback = {}) {
  const text = (tagName) => {
    try {
      return dataset.string(tagName) || '';
    } catch (_) {
      return '';
    }
  };
  const value = (tagId, vr, tagName, fallbackValue = '') => {
    const textValue = text(tagName) || fallbackValue;
    return textValue ? { vr, Value: [textValue] } : { vr };
  };
  return {
    '00080016': value('00080016', 'UI', 'x00080016'),
    '00080018': value('00080018', 'UI', 'x00080018', fallback.sopInstanceUid),
    '00080060': value('00080060', 'CS', 'x00080060'),
    '0008103E': value('0008103E', 'LO', 'x0008103e'),
    '0020000D': value('0020000D', 'UI', 'x0020000d', fallback.studyUid),
    '0020000E': value('0020000E', 'UI', 'x0020000e', fallback.seriesUid),
    '00200011': value('00200011', 'IS', 'x00200011'),
    '00200013': value('00200013', 'IS', 'x00200013'),
  };
}

function readDicomFileIds(buffer) {
  try {
    const dataset = dicomParser.parseDicom(new Uint8Array(buffer), {
      untilTag: 'x7fe00010',
    });
    return {
      studyUid: getElementString(dataset, 'x0020000d'),
      seriesUid: getElementString(dataset, 'x0020000e'),
      sopInstanceUid: getElementString(dataset, 'x00080018'),
    };
  } catch (_) {
    return {
      studyUid: '',
      seriesUid: '',
      sopInstanceUid: '',
    };
  }
}

async function removeStoredFilesMatching(studyUid, predicate) {
  const studyPath = resolveStudyPath(studyUid);
  if (!(await fileExists(studyPath))) {
    return 0;
  }
  const entries = await fsp.readdir(studyPath, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === METADATA_OVERRIDE_FILENAME) continue;
    const filePath = path.join(studyPath, entry.name);
    let ids;
    try {
      ids = readDicomFileIds(await fsp.readFile(filePath));
    } catch (_) {
      ids = { studyUid, seriesUid: '', sopInstanceUid: entry.name };
    }
    if (!predicate({ ...ids, fileName: entry.name, filePath })) continue;
    await fsp.unlink(filePath).catch(() => {});
    removed += 1;
  }
  return removed;
}

function applyStudyOverride(record, replace) {
  if (!replace || typeof replace !== 'object') {
    return record;
  }
  const next = { ...record };
  for (const [keyword, value] of Object.entries(replace)) {
    const def = studyOverrideTags[keyword];
    if (!def) continue;
    if ((value === undefined || value === null || String(value).trim() === '') && getDicomString(record, def[0])) {
      continue;
    }
    const [tagId, vr] = def;
    next[tagId] = vr === 'PN' ? tagPN(value) : tag(vr, value);
  }
  return next;
}

async function ensureStateTables(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dicomweb_pacs_metadata_overrides (
      study_instance_uid VARCHAR(128) PRIMARY KEY,
      replace_json MEDIUMTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS dicomweb_pacs_deleted_resources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      resource_type VARCHAR(16) NOT NULL,
      resource_uid VARCHAR(128) NOT NULL,
      parent_study_uid VARCHAR(128) NULL,
      parent_series_uid VARCHAR(128) NULL,
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dicomweb_pacs_deleted (resource_type, resource_uid),
      INDEX idx_dicomweb_pacs_deleted_parent_study (parent_study_uid),
      INDEX idx_dicomweb_pacs_deleted_parent_series (parent_series_uid)
    )
  `);
}

function getPacsMetadataDb() {
  if (!pacsMetadataPool) {
    pacsMetadataPool = postgres.createPool({
      host: process.env.PACS_DB_HOST || process.env.DB_HOST || dicomConfig.database.host || 'localhost',
      port: Number(process.env.PACS_DB_PORT || process.env.DB_PORT || dicomConfig.database.port || 5432),
      user: process.env.PACS_DB_USER || process.env.DB_USER || dicomConfig.database.user || 'root',
      password:
        process.env.PACS_DB_PASS ||
        process.env.DB_PASS ||
        dicomConfig.database.password ||
        '',
      database: process.env.PACS_DB_NAME || 'vexapacs_db',
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
  }
  return pacsMetadataPool;
}

async function ensureManagerOperationTables(db = getPacsMetadataDb()) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pacs_manager_operations (
      id VARCHAR(64) PRIMARY KEY,
      parent_operation_id VARCHAR(64) NULL,
      restored_by_operation_id VARCHAR(64) NULL,
      operation_type VARCHAR(40) NOT NULL,
      status VARCHAR(24) NOT NULL,
      source_study_uid VARCHAR(128) NULL,
      source_series_uid VARCHAR(128) NULL,
      source_sop_uid VARCHAR(128) NULL,
      target_study_uid VARCHAR(128) NULL,
      target_series_uid VARCHAR(128) NULL,
      target_patient_id VARCHAR(128) NULL,
      username VARCHAR(100) NULL,
      reason VARCHAR(1000) NULL,
      object_count INT NOT NULL DEFAULT 0,
      manifest_path TEXT NULL,
      manifest_json LONGTEXT NULL,
      error_message TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL,
      restored_at DATETIME(3) NULL,
      restored_by VARCHAR(100) NULL,
      restore_reason VARCHAR(1000) NULL
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_pacs_manager_operations_created ON pacs_manager_operations (created_at DESC)').catch(() => {});
  await db.query('CREATE INDEX IF NOT EXISTS idx_pacs_manager_operations_source ON pacs_manager_operations (source_study_uid)').catch(() => {});
  await db.query('CREATE INDEX IF NOT EXISTS idx_pacs_manager_operations_target ON pacs_manager_operations (target_study_uid)').catch(() => {});
  await db.query('CREATE INDEX IF NOT EXISTS idx_pacs_manager_operations_status ON pacs_manager_operations (status)').catch(() => {});
  // Live progress columns: a study merge can run for minutes and the operator has
  // no feedback until the request returns, so the running operation reports where
  // it is and the manager page polls it.
  await db.query('ALTER TABLE pacs_manager_operations ADD COLUMN progress_stage VARCHAR(40) NULL').catch(() => {});
  await db.query('ALTER TABLE pacs_manager_operations ADD COLUMN progress_done INT NULL').catch(() => {});
  await db.query('ALTER TABLE pacs_manager_operations ADD COLUMN progress_total INT NULL').catch(() => {});
  await db.query('ALTER TABLE pacs_manager_operations ADD COLUMN progress_updated_at DATETIME(3) NULL').catch(() => {});
  await db.query('ALTER TABLE pacs_manager_operations ADD COLUMN cancel_requested_at DATETIME(3) NULL').catch(() => {});
}

/**
 * Ask a running manager operation to stop.
 *
 * The move loop checks this between series, so a cancel never interrupts a file
 * mid-rewrite: the series already moved stay moved, the rest stay in the source
 * study, and the caller reports both. The operation is still restorable from its
 * snapshot afterwards.
 */
async function requestManagerOperationCancel(operationId) {
  const db = getPacsMetadataDb();
  await ensureManagerOperationTables(db);
  const [result] = await db.query(
    `UPDATE pacs_manager_operations
     SET cancel_requested_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = ?`,
    [String(operationId || '').trim(), 'prepared']
  );
  return { operationId, requested: Number(result?.affectedRows || 0) > 0 };
}

async function isManagerOperationCancelRequested(operationId) {
  if (!operationId) return false;
  const db = getPacsMetadataDb();
  const [rows] = await db.query(
    'SELECT status, cancel_requested_at FROM pacs_manager_operations WHERE id = ? LIMIT 1',
    [String(operationId)]
  ).catch(() => [[]]);
  const row = rows?.[0];
  if (!row) return false;
  return Boolean(row.cancel_requested_at) || String(row.status) === 'cancelling';
}

/** Finish a cancelled operation: keep the manifest, mark the status. */
async function cancelManagerOperation(operationId, result = {}) {
  const db = getPacsMetadataDb();
  const row = await loadManagerOperationRow(operationId);
  const manifest = await loadManagerManifest(row);
  await hashManagerOperationOutputs(manifest);
  manifest.cancelledAt = new Date().toISOString();
  manifest.result = summarizeManagerResult(result);
  await writeManagerManifest(row.manifest_path, manifest);
  await db.query(
    `UPDATE pacs_manager_operations
     SET status = ?, manifest_json = ?, completed_at = CURRENT_TIMESTAMP, error_message = ?
     WHERE id = ?`,
    ['cancelled', JSON.stringify(manifest), 'Cancelled by operator', operationId]
  );
  return { operationId, status: 'cancelled' };
}

/**
 * Operation row for an operator-driven re-index.
 *
 * Re-indexing never rewrites DICOM objects, so it needs neither a snapshot nor the
 * per-object hashes a merge takes (those would read the whole study back); it only
 * needs progress and a cancellation flag - and the same row gives it a history entry.
 */
async function beginReindexOperation({ studyInstanceUid, username = null, reason = null }) {
  const db = getPacsMetadataDb();
  await ensureManagerOperationTables(db);
  const study = normalizeUid(studyInstanceUid);
  const operationId = crypto.randomUUID();
  await db.query(
    `INSERT INTO pacs_manager_operations
       (id, operation_type, status, source_study_uid, target_study_uid, username, reason, object_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      operationId,
      'study_reindex',
      'prepared',
      study,
      study,
      String(username || '').trim() || null,
      String(reason || '').trim() || null,
      0,
    ]
  );
  await updateManagerOperationProgress(operationId, { stage: 'queued', done: 0, total: 0 });
  return { operationId, studyInstanceUid: study };
}

/** Persist the outcome of a re-index on its operation row. */
async function finishReindexOperation(operationId, refresh) {
  if (!operationId) return { operationId, status: null };
  const db = getPacsMetadataDb();
  const refreshStatus = String(refresh?.status || 'unknown');
  const status = refreshStatus === 'cancelled'
    ? 'cancelled'
    : refreshStatus.startsWith('refreshed')
      ? 'completed'
      : 'failed';
  const fileCount = Number(refresh?.indexSync?.verified ?? refresh?.indexSync?.files ?? refresh?.files ?? 0);
  const targetRefresh = refresh
    ? {
      status: refresh.status,
      recoveredFiles: Array.isArray(refresh.recoveredFiles) ? refresh.recoveredFiles.length : refresh.recoveredFiles,
      unindexedFiles: refresh.indexSync?.unindexedFiles,
      indexSync: refresh.indexSync
        ? { ready: Boolean(refresh.indexSync.ready), waitedMs: Number(refresh.indexSync.waitedMs || 0) }
        : null,
    }
    : null;
  const result = {
    ...summarizeManagerResult({ pacsRefresh: refresh, targetRefresh }),
    refresh: refresh || null,
  };
  const manifestJson = JSON.stringify({ version: 1, operationId, operationType: 'study_reindex', result });
  await db.query(
    `UPDATE pacs_manager_operations
     SET status = ?, completed_at = CURRENT_TIMESTAMP, error_message = ?, manifest_json = ?,
         object_count = ?, progress_stage = ?, progress_done = ?, progress_total = ?,
         progress_updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [
      status,
      status === 'failed'
        ? `Re-index finished with status ${refreshStatus}`
        : status === 'cancelled'
          ? 'Cancelled by operator'
          : null,
      manifestJson,
      fileCount,
      status === 'cancelled' ? 'cancelled' : 'done',
      fileCount,
      fileCount,
      operationId,
    ]
  ).catch(() => {});
  return { operationId, status };
}

/**
 * Run a re-index as a tracked operation: progress phases, cooperative cancellation
 * (honoured between phases and inside the index verification loop) and a history row.
 */
async function runReindexOperation(operationId, studyInstanceUid, options = {}) {
  const progress = createMoveProgressReporter(operationId, 0);
  const shouldCancel = createCancelWatcher(operationId);
  try {
    progress.stage('inspecting');
    const refresh = await refreshStudyIndex(studyInstanceUid, {
      mode: options.mode,
      verifyAllFiles: options.verifyAllFiles !== false,
      waitTimeoutMs: options.waitTimeoutMs,
      progress,
      shouldCancel,
    });
    const finished = await finishReindexOperation(operationId, refresh);
    return { operationId, studyInstanceUid, refresh, operationStatus: finished.status };
  } catch (error) {
    await updateManagerOperationProgress(operationId, { stage: 'failed', done: 0, total: 0 }).catch(() => {});
    await getPacsMetadataDb().query(
      'UPDATE pacs_manager_operations SET status = ?, completed_at = CURRENT_TIMESTAMP, error_message = ? WHERE id = ?',
      ['failed', String(error?.message || error).slice(0, 4000), operationId]
    ).catch(() => {});
    throw error;
  }
}

/** Write the current progress of a running manager operation (best effort). */
async function updateManagerOperationProgress(operationId, progress = {}) {
  if (!operationId) return;
  const db = getPacsMetadataDb();
  await db.query(
    `UPDATE pacs_manager_operations
     SET progress_stage = ?, progress_done = ?, progress_total = ?, progress_updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [progress.stage || null, Number(progress.done || 0), Number(progress.total || 0), operationId]
  ).catch(() => {});
}

/**
 * Throttled progress reporter for a move.
 *
 * Writes at most every DICOMWEB_MANAGER_PROGRESS_MS (500 ms) so a study with
 * thousands of instances does not add a database write per file, plus one forced
 * write per phase change.
 */
function createMoveProgressReporter(operationId, total) {
  if (!operationId) {
    return { stage: () => {}, advance: () => {}, report: () => {}, setTotal: () => {}, finish: () => {} };
  }
  const effectiveTotal = Number(total || 0);
  const minIntervalMs = Math.max(Number(process.env.DICOMWEB_MANAGER_PROGRESS_MS || 500), 0);
  let done = 0;
  let reportedTotal = effectiveTotal;
  let lastWriteAt = 0;
  const write = (stage, force) => {
    const now = Date.now();
    if (!force && now - lastWriteAt < minIntervalMs) return;
    lastWriteAt = now;
    void updateManagerOperationProgress(operationId, { stage, done, total: reportedTotal });
  };
  return {
    stage: label => write(label, true),
    // Absolute progress for phases that can count their own work (a file walk, an
    // index verification loop) instead of counting discrete steps.
    report: (label, value) => {
      done = Math.max(Number(value || 0), 0);
      write(label, false);
    },
    setTotal: value => {
      reportedTotal = Math.max(Number(value || 0), 0);
      write('inspecting', true);
    },
    advance: (count = 1) => {
      done += count;
      write('moving', false);
    },
    finish: label => write(label, true),
  };
}

async function ensurePacsStudyMetadataTable(db = getPacsMetadataDb()) {
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
}

async function createScheduledStudyPlaceholder({
  studyInstanceUid,
  patientId,
  patientName,
  patientBirthDate,
  patientSex,
  accessionNumber,
  studyDate,
  studyTime,
  modality,
  studyDescription,
  studyId,
  referringPhysician,
} = {}) {
  const study = normalizeUid(studyInstanceUid);
  const db = getPacsMetadataDb();
  await ensurePacsStudyMetadataTable(db);
  const normalizedStudyDate = normalizeDicomDate(studyDate);
  const normalizedStudyTime = normalizeDicomTime(studyTime);
  const normalizedModality = String(modality || '').trim().toUpperCase();
  const studyJson = {
    '0020000D': dicomJsonElement('0020000D', study),
    '00100020': dicomJsonElement('00100020', patientId),
    '00100010': dicomJsonElement('00100010', patientName),
    '00100030': dicomJsonElement('00100030', normalizeDicomDate(patientBirthDate)),
    '00100040': dicomJsonElement('00100040', patientSex),
    '00080050': dicomJsonElement('00080050', accessionNumber),
    '00080020': dicomJsonElement('00080020', normalizedStudyDate),
    '00080030': dicomJsonElement('00080030', normalizedStudyTime),
    '00080061': dicomJsonElement('00080061', normalizedModality),
    '00081030': dicomJsonElement('00081030', studyDescription),
    '00200010': dicomJsonElement('00200010', studyId),
    '00080090': dicomJsonElement('00080090', referringPhysician),
  };
  await db.query(
    `
    INSERT INTO pacs_studies (
      study_instance_uid, patient_id, patient_name, accession_number, study_date,
      study_time, modality_list, study_description, study_id, referring_physician,
      series_count, instance_count, study_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    ON DUPLICATE KEY UPDATE
      patient_id = VALUES(patient_id),
      patient_name = VALUES(patient_name),
      accession_number = VALUES(accession_number),
      study_date = VALUES(study_date),
      study_time = VALUES(study_time),
      modality_list = VALUES(modality_list),
      study_description = VALUES(study_description),
      study_id = VALUES(study_id),
      referring_physician = VALUES(referring_physician),
      study_json = VALUES(study_json)
    `,
    [
      study,
      String(patientId || '').trim() || null,
      String(patientName || '').trim() || null,
      String(accessionNumber || '').trim() || null,
      normalizedStudyDate || null,
      normalizedStudyTime || null,
      normalizedModality || null,
      String(studyDescription || '').trim() || null,
      String(studyId || '').trim() || null,
      String(referringPhysician || '').trim() || null,
      JSON.stringify(studyJson),
    ]
  );
  invalidateQidoCacheForStudies(study);
  return { studyInstanceUid: study };
}

async function createStudyPlaceholder({
  studyInstanceUid,
  patientId,
  patientName,
  patientBirthDate,
  patientSex,
  accessionNumber,
  studyDate,
  studyTime,
  modality,
  studyDescription,
  studyId,
  referringPhysician,
} = {}) {
  const study = studyInstanceUid ? normalizeUid(studyInstanceUid) : generateDicomUid();
  const db = getPacsMetadataDb();
  await ensurePacsStudyMetadataTable(db);
  const normalizedStudyDate = normalizeDicomDate(studyDate) || normalizeDicomDate(new Date().toISOString());
  const normalizedStudyTime = normalizeDicomTime(studyTime) || normalizeDicomTime(new Date().toTimeString());
  const normalizedModality = String(modality || 'OT').trim().toUpperCase();
  const studyJson = {
    '0020000D': dicomJsonElement('0020000D', study),
    '00100020': dicomJsonElement('00100020', patientId || `MANUAL-${Date.now()}`),
    '00100010': dicomJsonElement('00100010', patientName || 'MANUAL^PATIENT'),
    '00100030': dicomJsonElement('00100030', normalizeDicomDate(patientBirthDate)),
    '00100040': dicomJsonElement('00100040', patientSex || 'O'),
    '00080050': dicomJsonElement('00080050', accessionNumber || `MANUAL${Date.now()}`),
    '00080020': dicomJsonElement('00080020', normalizedStudyDate),
    '00080030': dicomJsonElement('00080030', normalizedStudyTime),
    '00080061': dicomJsonElement('00080061', normalizedModality),
    '00081030': dicomJsonElement('00081030', studyDescription || 'Manual Study'),
    '00200010': dicomJsonElement('00200010', studyId || ''),
    '00080090': dicomJsonElement('00080090', referringPhysician || ''),
  };
  await db.query(
    `
    INSERT INTO pacs_studies (
      study_instance_uid, patient_id, patient_name, accession_number, study_date,
      study_time, modality_list, study_description, study_id, referring_physician,
      series_count, instance_count, study_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    ON DUPLICATE KEY UPDATE
      patient_id = VALUES(patient_id),
      patient_name = VALUES(patient_name),
      accession_number = VALUES(accession_number),
      study_date = VALUES(study_date),
      study_time = VALUES(study_time),
      modality_list = VALUES(modality_list),
      study_description = VALUES(study_description),
      study_id = VALUES(study_id),
      referring_physician = VALUES(referring_physician),
      study_json = VALUES(study_json)
    `,
    [
      study,
      getDicomString(studyJson, '00100020') || null,
      getDicomString(studyJson, '00100010') || null,
      getDicomString(studyJson, '00080050') || null,
      normalizedStudyDate || null,
      normalizedStudyTime || null,
      normalizedModality || null,
      getDicomString(studyJson, '00081030') || null,
      getDicomString(studyJson, '00200010') || null,
      getDicomString(studyJson, '00080090') || null,
      JSON.stringify(studyJson),
    ]
  );
  await fsp.mkdir(resolveStudyPath(study), { recursive: true });
  invalidateQidoCacheForStudies(study);
  return { studyInstanceUid: study };
}

async function createSeriesPlaceholder(studyInstanceUid, {
  seriesInstanceUid,
  modality,
  seriesNumber,
  seriesDescription,
  bodyPartExamined,
  protocolName,
} = {}) {
  const study = normalizeUid(studyInstanceUid);
  await getStudyRecord(study);
  const series = seriesInstanceUid ? normalizeUid(seriesInstanceUid) : generateDicomUid('200');
  const normalizedModality = String(modality || 'OT').trim().toUpperCase();
  const numericSeriesNumber = Number(seriesNumber || 1);
  const seriesJson = {
    '0020000D': dicomJsonElement('0020000D', study),
    '0020000E': dicomJsonElement('0020000E', series),
    '00080060': dicomJsonElement('00080060', normalizedModality),
    '00200011': dicomJsonElement('00200011', Number.isFinite(numericSeriesNumber) ? numericSeriesNumber : 1),
    '0008103E': dicomJsonElement('0008103E', seriesDescription || 'Manual Series'),
    '00180015': dicomJsonElement('00180015', bodyPartExamined || ''),
    '00181030': dicomJsonElement('00181030', protocolName || ''),
  };
  const db = getPacsMetadataDb();
  await ensurePacsStudyMetadataTable(db);
  await db.query(
    `
    INSERT INTO pacs_series (
      series_instance_uid, study_instance_uid, modality, series_number, series_description,
      instance_count, series_json
    ) VALUES (?, ?, ?, ?, ?, 0, ?)
    ON DUPLICATE KEY UPDATE
      study_instance_uid = VALUES(study_instance_uid),
      modality = VALUES(modality),
      series_number = VALUES(series_number),
      series_description = VALUES(series_description),
      series_json = VALUES(series_json)
    `,
    [
      series,
      study,
      normalizedModality || null,
      Number.isFinite(numericSeriesNumber) ? numericSeriesNumber : 1,
      String(seriesDescription || 'Manual Series'),
      JSON.stringify(seriesJson),
    ]
  );
  await refreshPacsMetadataCounts(db, study);
  invalidateQidoCacheForStudies(study);
  previewCache.clear(); seriesThumbnailCache.clear();
  return { studyInstanceUid: study, seriesInstanceUid: series };
}

async function createImageFromUpload(studyInstanceUid, seriesInstanceUid, {
  fileName,
  mimeType,
  base64,
  instanceNumber,
  imageComments,
} = {}) {
  const study = normalizeUid(studyInstanceUid);
  const series = normalizeUid(seriesInstanceUid);
  const studyRecord = await getStudyRecord(study);
  const seriesRecord = await getSeriesRecord(study, series);
  const cleanBase64 = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!cleanBase64) {
    const error = new Error('base64 image is required');
    error.status = 400;
    throw error;
  }
  const uploaded = Buffer.from(cleanBase64, 'base64');
  const image = decodeImageData({ mimeType: mimeType || fileName, buffer: uploaded });
  const pixelData = rgbaToRgb(image.rgba);
  const sop = generateDicomUid('300');
  const sopClassUid = '1.2.840.10008.5.1.4.1.1.7';
  const now = new Date();
  const contentDate = normalizeDicomDate(now.toISOString());
  const contentTime = normalizeDicomTime(now.toTimeString());
  const imageNumber = Number(instanceNumber || Date.now() % 100000);
  const dataset = [
    dicomElement('00080005', 'CS', 'ISO_IR 100'),
    dicomElement('00080016', 'UI', sopClassUid),
    dicomElement('00080018', 'UI', sop),
    dicomElement('00080020', 'DA', getDicomString(studyRecord, '00080020') || contentDate),
    dicomElement('00080030', 'TM', getDicomString(studyRecord, '00080030') || contentTime),
    dicomElement('00080023', 'DA', contentDate),
    dicomElement('00080033', 'TM', contentTime),
    dicomElement('00080050', 'SH', getDicomString(studyRecord, '00080050')),
    dicomElement('00080060', 'CS', getDicomString(seriesRecord, '00080060') || 'OT'),
    dicomElement('00080064', 'CS', 'WSD'),
    dicomElement('00081030', 'LO', getDicomString(studyRecord, '00081030')),
    dicomElement('0008103E', 'LO', getDicomString(seriesRecord, '0008103E') || 'Uploaded Image'),
    dicomElement('00080090', 'PN', getDicomString(studyRecord, '00080090')),
    dicomElement('00100010', 'PN', getDicomString(studyRecord, '00100010')),
    dicomElement('00100020', 'LO', getDicomString(studyRecord, '00100020')),
    dicomElement('00100030', 'DA', getDicomString(studyRecord, '00100030')),
    dicomElement('00100040', 'CS', getDicomString(studyRecord, '00100040') || 'O'),
    dicomElement('0020000D', 'UI', study),
    dicomElement('0020000E', 'UI', series),
    dicomElement('00200010', 'SH', getDicomString(studyRecord, '00200010')),
    dicomElement('00200011', 'IS', getDicomString(seriesRecord, '00200011') || '1'),
    dicomElement('00200013', 'IS', Number.isFinite(imageNumber) ? imageNumber : 1),
    dicomElement('00280002', 'US', 3),
    dicomElement('00280004', 'CS', 'RGB'),
    dicomElement('00280006', 'US', 0),
    dicomElement('00280010', 'US', image.height),
    dicomElement('00280011', 'US', image.width),
    dicomElement('00280100', 'US', 8),
    dicomElement('00280101', 'US', 8),
    dicomElement('00280102', 'US', 7),
    dicomElement('00280103', 'US', 0),
    dicomElement('00204000', 'LT', imageComments || fileName || ''),
    dicomElement('7FE00010', 'OB', pixelData),
  ];
  const dicom = createDicomFileBuffer({
    mediaStorageSopClassUid: sopClassUid,
    sopInstanceUid: sop,
    dataset,
  });
  await fsp.mkdir(resolveStudyPath(study), { recursive: true });
  const filePath = resolveInstancePath(study, sop);
  await fsp.writeFile(filePath, dicom);
  const pacsRefresh = await refreshStudyIndex(study);
  invalidateQidoCacheForStudies(study);
  previewCache.clear(); seriesThumbnailCache.clear();
  return {
    studyInstanceUid: study,
    seriesInstanceUid: series,
    sopInstanceUid: sop,
    filePath,
    rows: image.height,
    columns: image.width,
    pacsRefresh,
  };
}

async function getStudyInstanceCount(studyInstanceUid) {
  const study = normalizeUid(studyInstanceUid);
  const db = getPacsMetadataDb();
  await ensurePacsStudyMetadataTable(db);
  const [rows] = await db.query(
    'SELECT COALESCE(instance_count, 0) AS instance_count FROM pacs_studies WHERE study_instance_uid = ? LIMIT 1',
    [study]
  );
  return Number(rows?.[0]?.instance_count || 0);
}

async function deleteScheduledStudyPlaceholder(studyInstanceUid) {
  const study = normalizeUid(studyInstanceUid);
  const db = getPacsMetadataDb();
  await ensurePacsStudyMetadataTable(db);
  const [result] = await db.query(
    'DELETE FROM pacs_studies WHERE study_instance_uid = ? AND COALESCE(instance_count, 0) = 0',
    [study]
  );
  invalidateQidoCacheForStudies(study);
  return { deleted: Number(result?.affectedRows || 0) > 0 };
}

async function refreshPacsMetadataCounts(db, studyUid) {
  await db.query(
    `
    UPDATE pacs_series
    SET instance_count = COALESCE((
      SELECT COUNT(*)
      FROM pacs_instances pi
      WHERE pi.series_instance_uid = pacs_series.series_instance_uid
    ), 0)
    WHERE study_instance_uid = ?
    `,
    [studyUid]
  );
  await db.query(
    `
    UPDATE pacs_studies
    SET series_count = COALESCE((
          SELECT COUNT(DISTINCT pi.series_instance_uid)
          FROM pacs_instances pi
          WHERE pi.study_instance_uid = pacs_studies.study_instance_uid
        ), 0),
        instance_count = COALESCE((
          SELECT COUNT(*)
          FROM pacs_instances pi
          WHERE pi.study_instance_uid = pacs_studies.study_instance_uid
        ), 0)
    WHERE study_instance_uid = ?
    `,
    [studyUid]
  );
  await db.query(
    `
    UPDATE pacs_studies
    SET modality_list = (
      SELECT STRING_AGG(DISTINCT ps.modality, '\\\\' ORDER BY ps.modality)
      FROM pacs_series ps
      WHERE ps.study_instance_uid = pacs_studies.study_instance_uid
    )
    WHERE study_instance_uid = ?
    `,
    [studyUid]
  );
}

async function purgePacsMetadata(resourceType, studyUid, seriesUid = null, sopInstanceUid = null) {
  const db = getPacsMetadataDb();
  try {
    if (resourceType === 'study') {
      await db.query('DELETE FROM pacs_instances WHERE study_instance_uid = ?', [studyUid]);
      await db.query('DELETE FROM pacs_series WHERE study_instance_uid = ?', [studyUid]);
      await db.query('DELETE FROM pacs_studies WHERE study_instance_uid = ?', [studyUid]);
      return;
    }

    if (resourceType === 'series') {
      await db.query('DELETE FROM pacs_instances WHERE study_instance_uid = ? AND series_instance_uid = ?', [
        studyUid,
        seriesUid,
      ]);
      await db.query('DELETE FROM pacs_series WHERE study_instance_uid = ? AND series_instance_uid = ?', [
        studyUid,
        seriesUid,
      ]);
      await refreshPacsMetadataCounts(db, studyUid);
      return;
    }

    if (resourceType === 'instance') {
      await db.query(
        'DELETE FROM pacs_instances WHERE study_instance_uid = ? AND series_instance_uid = ? AND sop_instance_uid = ?',
        [studyUid, seriesUid, sopInstanceUid]
      );
      await refreshPacsMetadataCounts(db, studyUid);
    }
  } catch (error) {
    console.warn(`[dicomweb-pacs] failed to purge PACS metadata for ${resourceType}:`, error.message);
  }
}

async function getDeletedSets() {
  const sets = {
    study: new Set(),
    series: new Set(),
    instance: new Set(),
    studyDeletedAt: new Map(),
  };
  let rows = [];
  try {
    await ensureStateTables();
    const result = await pool.query(
      'SELECT resource_type, resource_uid, deleted_at FROM dicomweb_pacs_deleted_resources'
    );
    rows = result[0];
  } catch (error) {
    return sets;
  }
  for (const row of rows) {
    if (sets[row.resource_type]) {
      const uid = String(row.resource_uid);
      sets[row.resource_type].add(uid);
      if (row.resource_type === 'study' && row.deleted_at) {
        sets.studyDeletedAt.set(uid, new Date(row.deleted_at).getTime());
      }
    }
  }
  return sets;
}

async function restoreReingestedStudies(records, deleted) {
  const restored = [];
  for (const record of records) {
    const studyUid = getStudyUid(record);
    if (!studyUid || !deleted.study.has(studyUid)) continue;
    const deletedAt = deleted.studyDeletedAt.get(studyUid);
    if (!Number.isFinite(deletedAt)) continue;
    try {
      const stat = await fsp.stat(path.join(PACS_STORAGE_PATH, studyUid));
      if (stat.mtimeMs <= deletedAt) continue;
      await pool.query(
        'DELETE FROM dicomweb_pacs_deleted_resources WHERE resource_type = ? AND resource_uid = ?',
        ['study', studyUid]
      );
      deleted.study.delete(studyUid);
      deleted.studyDeletedAt.delete(studyUid);
      restored.push(studyUid);
    } catch (_) {
      // Keep the tombstone if the storage folder cannot prove a newer re-ingest.
    }
  }
  if (restored.length > 0) {
    invalidateQidoCacheForStudies(restored);
    console.log(`[dicomweb-pacs] restored ${restored.length} re-ingested study tombstone(s)`);
  }
}

async function getStudyOverrides() {
  const map = new Map();
  let rows = [];
  try {
    await ensureStateTables();
    const result = await pool.query(
      'SELECT study_instance_uid, replace_json FROM dicomweb_pacs_metadata_overrides'
    );
    rows = result[0];
  } catch (error) {
    return map;
  }
  for (const row of rows) {
    try {
      map.set(String(row.study_instance_uid), parseJsonValue(row.replace_json, {}));
    } catch (_) {
      map.set(String(row.study_instance_uid), {});
    }
  }
  return map;
}

async function getMwlStudyDescriptions(records) {
  const studyUids = [];
  const accessionNumbers = [];
  for (const record of records || []) {
    const studyUid = getStudyUid(record);
    const accessionNumber = getDicomString(record, '00080050');
    if (studyUid) studyUids.push(studyUid);
    if (accessionNumber) accessionNumbers.push(accessionNumber);
  }

  const uniqueStudyUids = Array.from(new Set(studyUids));
  const uniqueAccessions = Array.from(new Set(accessionNumbers));
  if (!uniqueStudyUids.length && !uniqueAccessions.length) {
    return new Map();
  }

  const where = [];
  const params = [];
  if (uniqueStudyUids.length) {
    where.push('o.study_instance_uid IN (?)');
    params.push(uniqueStudyUids);
  }
  if (uniqueAccessions.length) {
    where.push('o.accession_number IN (?)');
    params.push(uniqueAccessions);
  }

  try {
    const result = await pool.query(
      `
      SELECT
        o.study_instance_uid,
        o.accession_number,
        COALESCE(NULLIF(o.procedure_desc, ''), NULLIF(o.nama_pemeriksaan, ''), NULLIF(s.study_description, '')) AS study_description
      FROM mwl_orders o
      LEFT JOIN mwl_studies s ON s.id = o.study_master_id
      WHERE ${where.join(' OR ')}
      ORDER BY o.updated_at DESC
      `,
      params
    );
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
    const map = new Map();
    for (const row of rows || []) {
      const description = String(row.study_description || '').trim();
      if (!description) continue;
      if (row.study_instance_uid && !map.has(`study:${row.study_instance_uid}`)) {
        map.set(`study:${row.study_instance_uid}`, description);
      }
      if (row.accession_number && !map.has(`accession:${row.accession_number}`)) {
        map.set(`accession:${row.accession_number}`, description);
      }
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

function applyMwlStudyDescription(record, descriptionMap) {
  if (getDicomString(record, '00081030')) {
    return record;
  }
  const studyUid = getStudyUid(record);
  const accessionNumber = getDicomString(record, '00080050');
  const description =
    (studyUid && descriptionMap.get(`study:${studyUid}`)) ||
    (accessionNumber && descriptionMap.get(`accession:${accessionNumber}`));
  if (!description) {
    return record;
  }
  return {
    ...record,
    '00081030': tag('LO', description),
  };
}

function buildUrl(endpoint, query) {
  const url = new URL(`${PACS_RS_ROOT}${endpoint}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (key === 'nocache' || key === 'fresh') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function fetchDicomJson(endpoint, query) {
  const response = await fetch(buildUrl(endpoint, query).toString(), {
    headers: { Accept: 'application/dicom+json' },
  });
  if (!response.ok) {
    const error = new Error(`dicomweb-pacs request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Invalidate only the cache entries a study change can affect.  The study list
 * aggregates every study, so those entries always go; series/instance entries
 * are dropped for the touched studies only.
 */
function invalidateQidoCacheForStudies(...studyUids) {
  const uidSet = new Set(
    studyUids.filter(Boolean).map(uid => normalizeUid(uid)).filter(Boolean)
  );
  return qidoCache.clearMatching(key => {
    if (key.startsWith('studies:')) return true;
    if (!key.startsWith('series:') && !key.startsWith('instances:')) return false;
    const rest = key.slice(key.indexOf(':') + 1);
    return uidSet.has(rest.slice(0, rest.indexOf(':')));
  });
}

function isPastDateRange(dateRange) {
  if (!dateRange) return false;
  const [start, end] = String(dateRange).split('-');
  const last = (end || start || '').replace(/[^0-9]/g, '');
  if (last.length !== 8) return false;
  const now = new Date();
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return last < today;
}

/** Longer TTL for queries that can no longer change (fully past date ranges). */
function studiesCacheTtl(query = {}) {
  return isPastDateRange(query.StudyDate || query.studyDate) ? QIDO_PAST_STUDY_TTL_MS : undefined;
}

/** Single-flight background refresh so parallel readers trigger one origin call. */
const inflightRefreshes = new Map();
function refreshInBackground(cacheKey, loader) {
  if (inflightRefreshes.has(cacheKey)) return inflightRefreshes.get(cacheKey);
  const task = Promise.resolve()
    .then(loader)
    .catch(error => {
      console.warn(`[dicomweb-pacs] background refresh failed for ${cacheKey}: ${error?.message || error}`);
      return null;
    })
    .finally(() => {
      inflightRefreshes.delete(cacheKey);
    });
  inflightRefreshes.set(cacheKey, task);
  return task;
}

async function getStudies(query = {}) {
  const skipCache =
    query.nocache === '1' ||
    query.nocache === 'true' ||
    query.fresh === '1' ||
    query.fresh === 'true';
  const includeEmpty =
    query.includeEmpty === '1' ||
    query.includeEmpty === 'true' ||
    query.includeEmpty === true;
  const cacheKey = `studies:${JSON.stringify(query)}`;
  const ttl = studiesCacheTtl(query);
  if (!skipCache) {
    const cached = qidoCache.getWithMeta(cacheKey);
    if (cached) {
      if (cached.stale) {
        // Serve the known list immediately and refresh behind the response.
        refreshInBackground(cacheKey, async () => qidoCache.set(cacheKey, await loadStudies(query, includeEmpty), ttl));
      }
      return { data: cached.value, cached: true, stale: cached.stale };
    }
  }
  const data = await loadStudies(query, includeEmpty);
  if (!skipCache) qidoCache.set(cacheKey, data, ttl);
  return { data, cached: false, stale: false };
}

async function loadStudies(query, includeEmpty) {
  const [records, deleted, overrides] = await Promise.all([
    fetchDicomJson('/studies', query),
    getDeletedSets(),
    getStudyOverrides(),
  ]);
  await restoreReingestedStudies(records, deleted);
  const descriptionMap = await getMwlStudyDescriptions(records);
  return records
    .filter(record => {
      const studyUid = getStudyUid(record);
      if (!studyUid || deleted.study.has(studyUid)) return false;
      if (!includeEmpty && getDicomNumber(record, '00201208', 0) <= 0) return false;
      return true;
    })
    .map(record => {
      const studyUid = getStudyUid(record);
      return applyMwlStudyDescription(applyStudyOverride(record, overrides.get(studyUid)), descriptionMap);
    });
}

async function getSeries(studyUid, query = {}) {
  const uid = normalizeUid(studyUid);
  const cacheKey = `series:${uid}:${JSON.stringify(query)}`;
  const skipCache = query.nocache === '1' || query.nocache === 'true' || query.fresh === '1' || query.fresh === 'true';
  if (!skipCache) {
    const cached = qidoCache.getWithMeta(cacheKey);
    if (cached) {
      if (cached.stale) {
        refreshInBackground(cacheKey, async () => qidoCache.set(cacheKey, await loadSeries(uid, query), QIDO_CACHE_TTL_MS));
      }
      return { data: cached.value, cached: true, stale: cached.stale };
    }
  }
  const data = await loadSeries(uid, query);
  if (!skipCache) qidoCache.set(cacheKey, data, QIDO_CACHE_TTL_MS);
  return { data, cached: false, stale: false };
}

async function loadSeries(uid, query) {
  const [records, deleted] = await Promise.all([
    fetchDicomJson(`/studies/${encodeURIComponent(uid)}/series`, query),
    getDeletedSets(),
  ]);
  let data = records.filter(record => {
    const seriesUid = getSeriesUid(record);
    return (
      seriesUid &&
      !deleted.study.has(uid) &&
      !deleted.series.has(seriesUid)
    );
  });
  if (!data.length) {
    data = await getSeriesFromStorage(uid, deleted);
  }
  return data;
}

async function getSeriesFromStorage(studyUid, deleted) {
  const studyPath = resolveStudyPath(studyUid);
  if (!(await fileExists(studyPath))) return [];
  const entries = await fsp.readdir(studyPath, { withFileTypes: true });
  const bySeries = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const filePath = path.join(studyPath, entry.name);
    try {
      const buffer = await fsp.readFile(filePath);
      const dataset = dicomParser.parseDicom(new Uint8Array(buffer), { untilTag: 'x7fe00010' });
      const ids = {
        studyUid: getElementString(dataset, 'x0020000d') || studyUid,
        seriesUid: getElementString(dataset, 'x0020000e'),
        sopInstanceUid: getElementString(dataset, 'x00080018') || entry.name,
      };
      if (ids.studyUid !== studyUid || !ids.seriesUid || deleted?.series?.has(ids.seriesUid) || deleted?.instance?.has(ids.sopInstanceUid)) continue;
      const existing = bySeries.get(ids.seriesUid);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const record = dicomRecordFromDataset(dataset, ids);
      record['00201209'] = { vr: 'IS', Value: ['1'] };
      bySeries.set(ids.seriesUid, { record, count: 1 });
    } catch (_) {
      // Ignore non-DICOM files in the study folder.
    }
  }
  return Array.from(bySeries.values())
    .map(item => ({
      ...item.record,
      '00201209': { vr: 'IS', Value: [String(item.count)] },
    }))
    .sort((a, b) => {
      const numberDiff = getDicomNumber(a, '00200011') - getDicomNumber(b, '00200011');
      if (Number.isFinite(numberDiff) && numberDiff !== 0) return numberDiff;
      return getSeriesUid(a).localeCompare(getSeriesUid(b));
    });
}

async function getInstances(studyUid, seriesUid, query = {}) {
  const study = normalizeUid(studyUid);
  const series = normalizeUid(seriesUid);
  const cacheKey = `instances:${study}:${series}:${JSON.stringify(query)}`;
  const skipCache = query.nocache === '1' || query.nocache === 'true' || query.fresh === '1' || query.fresh === 'true';
  if (!skipCache) {
    const cached = qidoCache.getWithMeta(cacheKey);
    if (cached) {
      if (cached.stale) {
        refreshInBackground(cacheKey, async () => qidoCache.set(cacheKey, await loadInstances(study, series, query), QIDO_CACHE_TTL_MS));
      }
      return { data: cached.value, cached: true, stale: cached.stale };
    }
  }
  const data = await loadInstances(study, series, query);
  if (!skipCache) qidoCache.set(cacheKey, data, QIDO_CACHE_TTL_MS);
  return { data, cached: false, stale: false };
}

async function loadInstances(study, series, query) {
  const [records, deleted] = await Promise.all([
    fetchDicomJson(
      `/studies/${encodeURIComponent(study)}/series/${encodeURIComponent(series)}/instances`,
      query
    ),
    getDeletedSets(),
  ]);
  let data = records.filter(record => {
    const instanceUid = getInstanceUid(record);
    return (
      instanceUid &&
      !deleted.study.has(study) &&
      !deleted.series.has(series) &&
      !deleted.instance.has(instanceUid)
    );
  }).sort((a, b) => {
    const numberDiff =
      getDicomNumber(a, '00200013') - getDicomNumber(b, '00200013');
    if (Number.isFinite(numberDiff) && numberDiff !== 0) return numberDiff;
    return getInstanceUid(a).localeCompare(getInstanceUid(b));
  });
  if (!data.length) {
    data = await getInstancesFromStorage(study, series, deleted);
  }
  return data;
}

async function getInstancesFromStorage(studyUid, seriesUid, deleted) {
  const studyPath = resolveStudyPath(studyUid);
  if (!(await fileExists(studyPath))) return [];
  const entries = await fsp.readdir(studyPath, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const filePath = path.join(studyPath, entry.name);
    try {
      const buffer = await fsp.readFile(filePath);
      const dataset = dicomParser.parseDicom(new Uint8Array(buffer), { untilTag: 'x7fe00010' });
      const ids = {
        studyUid: getElementString(dataset, 'x0020000d') || studyUid,
        seriesUid: getElementString(dataset, 'x0020000e'),
        sopInstanceUid: getElementString(dataset, 'x00080018') || entry.name,
      };
      if (ids.studyUid !== studyUid || ids.seriesUid !== seriesUid || deleted?.instance?.has(ids.sopInstanceUid)) continue;
      records.push(dicomRecordFromDataset(dataset, ids));
    } catch (_) {
      // Ignore non-DICOM files in the study folder.
    }
  }
  return records.sort((a, b) => {
    const numberDiff = getDicomNumber(a, '00200013') - getDicomNumber(b, '00200013');
    if (Number.isFinite(numberDiff) && numberDiff !== 0) return numberDiff;
    return getInstanceUid(a).localeCompare(getInstanceUid(b));
  });
}

async function getFrame(studyUid, seriesUid, instanceUid, frameNumber) {
  const study = normalizeUid(studyUid);
  const series = normalizeUid(seriesUid);
  const instance = normalizeUid(instanceUid);
  const response = await fetch(
    buildUrl(
      `/studies/${encodeURIComponent(study)}/series/${encodeURIComponent(series)}/instances/${encodeURIComponent(instance)}/frames/${encodeURIComponent(frameNumber || 1)}`
    ).toString()
  );
  if (!response.ok) {
    const error = new Error(`dicomweb-pacs frame request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.buffer();
}

function resolveStudyPath(studyUid) {
  const uid = normalizeUid(studyUid);
  const resolved = path.resolve(PACS_STORAGE_PATH, uid);
  if (!resolved.startsWith(PACS_STORAGE_PATH)) {
    const error = new Error('Invalid study path');
    error.status = 400;
    throw error;
  }
  return resolved;
}

function resolveInstancePath(studyUid, sopInstanceUid) {
  const studyPath = resolveStudyPath(studyUid);
  const sop = normalizeUid(sopInstanceUid);
  const resolved = path.resolve(studyPath, sop);
  if (!resolved.startsWith(studyPath)) {
    const error = new Error('Invalid instance path');
    error.status = 400;
    throw error;
  }
  return resolved;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function isPathWithin(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPathWithin(rootPath, candidatePath, label = 'path') {
  if (!isPathWithin(rootPath, candidatePath)) {
    const error = new Error(`Invalid ${label} outside managed storage`);
    error.status = 400;
    throw error;
  }
  return path.resolve(candidatePath);
}

// Same file written by two code paths can differ in separator style or drive
// letter case on Windows, so index/database lookups compare canonical keys.
function pathKey(candidate) {
  return path.resolve(String(candidate || '')).replace(/\\/g, '/').toLowerCase();
}

/**
 * SHA-256 of a file, streamed.
 *
 * A manager operation hashes every source file (and every output file) twice, and a
 * DX/CR object can be hundreds of megabytes: reading each one whole put the entire
 * object on the heap at once. Chunked hashing keeps peak memory flat and produces the
 * exact same digest, which matters because restore preflight compares stored hashes.
 */
async function sha256File(filePath, options = {}) {
  const chunkBytes = Math.max(Number(options.chunkBytes || process.env.DICOMWEB_SHA256_CHUNK_BYTES || 1024 * 1024), 64 * 1024);
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, { highWaterMark: chunkBytes });
  await new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', error => {
      stream.destroy();
      reject(error);
    });
  });
  return hash.digest('hex');
}

async function atomicCopyFile(sourcePath, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.copyFile(sourcePath, tempPath);
  await fsp.rename(tempPath, targetPath);
}

async function readStudyOverrideSnapshot(studyUid) {
  const [rows] = await pool.query(
    'SELECT replace_json FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ? LIMIT 1',
    [studyUid]
  ).catch(() => [[]]);
  if (!rows.length) return { present: false, replace: null };
  return { present: true, replace: parseJsonValue(rows[0].replace_json, {}) };
}

async function writeManagerManifest(manifestPath, manifest) {
  assertPathWithin(MANAGER_HISTORY_ROOT, manifestPath, 'manager manifest path');
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(manifest, null, 2));
  await fsp.rename(tempPath, manifestPath);
}

async function collectManagerSourceFiles(options) {
  const db = getPacsMetadataDb();
  const sourceStudyUid = normalizeUid(options.sourceStudyUid);
  const conditions = ['study_instance_uid = ?'];
  const params = [sourceStudyUid];
  if (options.sourceSeriesUid) {
    conditions.push('series_instance_uid = ?');
    params.push(normalizeUid(options.sourceSeriesUid));
  }
  if (options.sourceSopUid) {
    conditions.push('sop_instance_uid = ?');
    params.push(normalizeUid(options.sourceSopUid));
  }
  const [rows] = await db.query(
    `SELECT study_instance_uid, series_instance_uid, sop_instance_uid, file_path
     FROM pacs_instances
     WHERE ${conditions.join(' AND ')}
     ORDER BY series_instance_uid, sop_instance_uid`,
    params
  );
  const existing = [];
  for (const row of rows) {
    const sourcePath = row.file_path
      ? assertPathWithin(PACS_STORAGE_PATH, row.file_path, 'indexed DICOM path')
      : resolveInstancePath(sourceStudyUid, row.sop_instance_uid);
    if (await fileExists(sourcePath)) {
      existing.push({ ...row, file_path: sourcePath });
    }
  }
  if (!existing.length) {
    const error = new Error('No source DICOM files are available for a restorable manager operation');
    error.status = 404;
    throw error;
  }
  return existing;
}

function normalizeManagerOperationType(value) {
  const type = String(value || '').trim().toLowerCase();
  const allowed = new Set(['patient_correction', 'study_merge', 'series_move', 'instance_move']);
  if (!allowed.has(type)) {
    const error = new Error('Unsupported DICOM Manager operation type');
    error.status = 400;
    throw error;
  }
  return type;
}

async function beginManagerOperation(options = {}) {
  const db = getPacsMetadataDb();
  await ensureManagerOperationTables(db);
  const operationType = normalizeManagerOperationType(options.operationType);
  const operationId = crypto.randomUUID();
  const sourceStudyUid = normalizeUid(options.sourceStudyUid);
  const sourceSeriesUid = options.sourceSeriesUid ? normalizeUid(options.sourceSeriesUid) : null;
  const sourceSopUid = options.sourceSopUid ? normalizeUid(options.sourceSopUid) : null;
  const targetStudyUid = operationType === 'patient_correction'
    ? sourceStudyUid
    : normalizeUid(options.targetStudyUid);
  const targetSeriesUid = options.targetSeriesUid ? normalizeUid(options.targetSeriesUid) : null;
  const operationDir = path.join(MANAGER_HISTORY_ROOT, operationId);
  const manifestPath = path.join(operationDir, 'manifest.json');
  const sourceRows = await collectManagerSourceFiles({ sourceStudyUid, sourceSeriesUid, sourceSopUid });
  const sourceOverride = await readStudyOverrideSnapshot(sourceStudyUid);
  const manifest = {
    version: 1,
    operationId,
    operationType,
    createdAt: new Date().toISOString(),
    sourceStudyUid,
    sourceSeriesUid,
    sourceSopUid,
    targetStudyUid,
    targetSeriesUid,
    targetPatientId: String(options.targetPatientId || '').trim() || null,
    input: options.input && typeof options.input === 'object' ? options.input : {},
    sourceOverride,
    entries: [],
  };

  try {
    await fsp.mkdir(path.join(operationDir, 'originals'), { recursive: true });
    // Snapshot + hash with bounded concurrency: one file at a time made the
    // "preparing the operation" phase O(items) of serial I/O on big studies.
    const entries = await mapWithConcurrency(
      sourceRows,
      Number(process.env.DICOMWEB_MANAGER_SNAPSHOT_CONCURRENCY || 4),
      async (row) => {
        const sopInstanceUid = normalizeUid(row.sop_instance_uid);
        const sourcePath = row.file_path;
        const targetPath = resolveInstancePath(targetStudyUid, sopInstanceUid);
        const snapshotPath = path.join(operationDir, 'originals', `${sopInstanceUid}.dcm`);
        const originalHash = await traced('begin.sha256Source', () => sha256File(sourcePath));
        const snapshotKind = await traced('begin.copySnapshot', () => snapshotDicomFile(sourcePath, snapshotPath));
        let targetSnapshotPath = null;
        let targetOriginalHash = null;
        if (sourcePath !== targetPath && await fileExists(targetPath)) {
          await fsp.mkdir(path.join(operationDir, 'target-conflicts'), { recursive: true });
          targetSnapshotPath = path.join(operationDir, 'target-conflicts', `${sopInstanceUid}.dcm`);
          targetOriginalHash = await traced('begin.sha256Target', () => sha256File(targetPath));
          await traced('begin.copyTargetSnapshot', () => snapshotDicomFile(targetPath, targetSnapshotPath));
        }
        return {
          studyInstanceUid: String(row.study_instance_uid),
          seriesInstanceUid: String(row.series_instance_uid),
          sopInstanceUid,
          targetSeriesInstanceUid: targetSeriesUid || String(row.series_instance_uid),
          sourcePath,
          targetPath,
          snapshotPath,
          snapshotKind,
          targetSnapshotPath,
          originalHash,
          targetOriginalHash,
          operationOutputHash: null,
        };
      },
    );
    manifest.entries = entries.sort((left, right) => (
      left.seriesInstanceUid.localeCompare(right.seriesInstanceUid)
      || left.sopInstanceUid.localeCompare(right.sopInstanceUid)
    ));
    await writeManagerManifest(manifestPath, manifest);
    await db.query(
      `INSERT INTO pacs_manager_operations (
         id, operation_type, status, source_study_uid, source_series_uid, source_sop_uid,
         target_study_uid, target_series_uid, target_patient_id, username, reason,
         object_count, manifest_path, manifest_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operationId,
        operationType,
        'prepared',
        sourceStudyUid,
        sourceSeriesUid,
        sourceSopUid,
        targetStudyUid,
        targetSeriesUid,
        manifest.targetPatientId,
        String(options.username || '').trim() || null,
        String(options.reason || '').trim() || null,
        manifest.entries.length,
        manifestPath,
        JSON.stringify(manifest),
      ]
    );
    return { operationId, manifest };
  } catch (error) {
    await fsp.rm(operationDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function loadManagerOperationRow(operationId) {
  const db = getPacsMetadataDb();
  await ensureManagerOperationTables(db);
  const [rows] = await db.query('SELECT * FROM pacs_manager_operations WHERE id = ? LIMIT 1', [String(operationId || '').trim()]);
  if (!rows.length) {
    const error = new Error('DICOM Manager operation not found');
    error.status = 404;
    throw error;
  }
  return rows[0];
}

async function loadManagerManifest(row) {
  const manifestPath = row?.manifest_path ? assertPathWithin(MANAGER_HISTORY_ROOT, row.manifest_path, 'manager manifest path') : '';
  if (manifestPath && await fileExists(manifestPath)) {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  }
  const manifest = parseJsonValue(row?.manifest_json, null);
  if (!manifest) {
    const error = new Error('Operation snapshot manifest is unavailable');
    error.status = 410;
    throw error;
  }
  return manifest;
}

/**
 * Persist the operational outcome of a manager operation.
 *
 * The history panel is the operator's only record of what happened, so anything
 * they may have to act on later - images that were skipped and why, series left
 * behind by a cancel, whether the PACS index caught up - has to survive here.
 * Detail arrays are capped so one huge operation cannot bloat the history row.
 */
function summarizeManagerResult(result = {}) {
  const detailCap = Math.max(Number(process.env.DICOMWEB_MANAGER_RESULT_DETAIL_CAP || 100), 1);
  const skippedInstances = Array.isArray(result.skippedInstances) ? result.skippedInstances : [];
  const pendingSeriesUids = (Array.isArray(result.pendingSeriesUids) ? result.pendingSeriesUids : []).filter(Boolean);
  const targetRefresh = result.targetRefresh || null;
  const sourceRefresh = result.sourceRefresh || null;
  const reindex = result.reindex && typeof result.reindex === 'object' ? result.reindex : null;
  // A study merge reports instances per series, so the flat shapes above miss it.
  const movedFromSeries = Array.isArray(result.movedSeries)
    ? result.movedSeries.reduce((sum, item) => sum + (Array.isArray(item?.movedInstances) ? item.movedInstances.length : 0), 0)
    : 0;
  return {
    cancelled: Boolean(result.cancelled),
    sourceStudyRemoved: Boolean(result.sourceStudyRemoved),
    movedSeriesCount: Array.isArray(result.movedSeries) ? result.movedSeries.length : undefined,
    movedInstanceCount: Array.isArray(result.movedInstances)
      ? result.movedInstances.length
      : result.movedInstance
        ? 1
        : Array.isArray(result.rewrittenInstances)
          ? result.rewrittenInstances.length
          : movedFromSeries || undefined,
    pacsRefreshStatus: result.pacsRefresh?.status || targetRefresh?.status || null,
    pendingSeriesCount: pendingSeriesUids.length || undefined,
    pendingSeriesUids: pendingSeriesUids.length ? pendingSeriesUids.slice(0, detailCap) : undefined,
    pendingSeriesTruncated: pendingSeriesUids.length > detailCap ? true : undefined,
    skippedInstanceCount: skippedInstances.length || undefined,
    skippedInstances: skippedInstances.length
      ? skippedInstances.slice(0, detailCap).map(item => ({
        sopInstanceUid: item?.sopInstanceUid || null,
        reason: String(item?.reason || 'Unknown reason').slice(0, 300),
        status: item?.status ?? null,
      }))
      : undefined,
    skippedInstancesTruncated: skippedInstances.length > detailCap ? true : undefined,
    recoveredFiles: Number(targetRefresh?.recoveredFiles || 0) || undefined,
    unindexedFiles: Number(targetRefresh?.unindexedFiles || 0) || undefined,
    waitForIndex: targetRefresh?.indexSync
      ? { ready: Boolean(targetRefresh.indexSync.ready), waitedMs: Number(targetRefresh.indexSync.waitedMs || 0) }
      : undefined,
    sourceRefreshStatus: sourceRefresh?.status || undefined,
    reindex: reindex
      ? { status: reindex.status || null, mode: reindex.mode || null, reason: reindex.reason || null }
      : undefined,
  };
}

/**
 * Re-hash every object a manager operation produced so restore preflight can
 * detect later edits. Parallel: it reads the whole study back from disk.
 */
async function hashManagerOperationOutputs(manifest) {
  const entries = manifest.entries || [];
  await mapWithConcurrency(
    entries,
    Number(process.env.DICOMWEB_MANAGER_SNAPSHOT_CONCURRENCY || 4),
    async (entry) => {
      if (await fileExists(entry.targetPath)) {
        entry.operationOutputHash = await traced('complete.sha256Output', () => sha256File(entry.targetPath));
      }
    },
  );
}

async function completeManagerOperation(operationId, result = {}) {
  const db = getPacsMetadataDb();
  const row = await loadManagerOperationRow(operationId);
  const manifest = await loadManagerManifest(row);
  await hashManagerOperationOutputs(manifest);
  manifest.completedAt = new Date().toISOString();
  manifest.result = summarizeManagerResult(result);
  await writeManagerManifest(row.manifest_path, manifest);
  await db.query(
    `UPDATE pacs_manager_operations
     SET status = ?, manifest_json = ?, completed_at = CURRENT_TIMESTAMP, error_message = NULL
     WHERE id = ?`,
    ['completed', JSON.stringify(manifest), operationId]
  );
  return { operationId, status: 'completed' };
}

async function failManagerOperation(operationId, error) {
  if (!operationId) return;
  const db = getPacsMetadataDb();
  await ensureManagerOperationTables(db);
  let manifestJson = null;
  try {
    const row = await loadManagerOperationRow(operationId);
    const manifest = await loadManagerManifest(row);
    await hashManagerOperationOutputs(manifest);
    manifest.failedAt = new Date().toISOString();
    manifest.failure = String(error?.message || error || 'Manager operation failed').slice(0, 4000);
    await writeManagerManifest(row.manifest_path, manifest);
    manifestJson = JSON.stringify(manifest);
  } catch (_) {
    manifestJson = null;
  }
  await db.query(
    `UPDATE pacs_manager_operations
     SET status = ?, error_message = ?, manifest_json = COALESCE(?, manifest_json)
     WHERE id = ?`,
    [
      'failed',
      String(error?.message || error || 'Manager operation failed').slice(0, 4000),
      manifestJson,
      operationId,
    ]
  ).catch(() => {});
}

function publicManagerOperation(row, includeDetails = false) {
  const manifest = parseJsonValue(row.manifest_json, null);
  let snapshotAvailable = false;
  if (row.manifest_path) {
    try {
      snapshotAvailable = fs.existsSync(assertPathWithin(MANAGER_HISTORY_ROOT, row.manifest_path, 'manager manifest path'));
    } catch (_) {
      snapshotAvailable = false;
    }
  }
  const value = {
    id: row.id,
    parentOperationId: row.parent_operation_id || null,
    restoredByOperationId: row.restored_by_operation_id || null,
    operationType: row.operation_type,
    status: row.status,
    sourceStudyUid: row.source_study_uid || null,
    sourceSeriesUid: row.source_series_uid || null,
    sourceSopUid: row.source_sop_uid || null,
    targetStudyUid: row.target_study_uid || null,
    targetSeriesUid: row.target_series_uid || null,
    targetPatientId: row.target_patient_id || null,
    username: row.username || null,
    reason: row.reason || null,
    objectCount: Number(row.object_count || 0),
    progress: row.progress_stage || row.progress_total
      ? {
        stage: row.progress_stage || null,
        done: Number(row.progress_done || 0),
        total: Number(row.progress_total || 0),
        updatedAt: row.progress_updated_at || null,
      }
      : null,
    snapshotAvailable,
    canRestore: snapshotAvailable && ['completed', 'failed', 'restore_failed', 'cancelled'].includes(String(row.status)),
    cancelRequested: Boolean(row.cancel_requested_at),
    errorMessage: row.error_message || null,
    createdAt: row.created_at || null,
    completedAt: row.completed_at || null,
    restoredAt: row.restored_at || null,
    restoredBy: row.restored_by || null,
    restoreReason: row.restore_reason || null,
  };
  // Compact outcome so the history list can flag work that needs attention
  // (skipped images, a cancelled merge, a PACS index that fell behind) without
  // fetching every operation detail.
  if (manifest?.result) {
    value.outcome = {
      cancelled: Boolean(manifest.result.cancelled),
      sourceStudyRemoved: Boolean(manifest.result.sourceStudyRemoved),
      movedSeriesCount: manifest.result.movedSeriesCount ?? null,
      movedInstanceCount: manifest.result.movedInstanceCount ?? null,
      pendingSeriesCount: manifest.result.pendingSeriesCount ?? null,
      skippedInstanceCount: manifest.result.skippedInstanceCount ?? null,
      recoveredFiles: manifest.result.recoveredFiles ?? null,
      unindexedFiles: manifest.result.unindexedFiles ?? null,
      pacsRefreshStatus: manifest.result.pacsRefreshStatus ?? null,
      sourceRefreshStatus: manifest.result.sourceRefreshStatus ?? null,
      reindexStatus: manifest.result.reindex?.status ?? null,
    };
  }
  if (includeDetails && manifest) {
    value.details = {
      input: manifest.input || {},
      result: manifest.result || null,
      entries: (manifest.entries || []).map(entry => ({
        studyInstanceUid: entry.studyInstanceUid,
        seriesInstanceUid: entry.seriesInstanceUid,
        sopInstanceUid: entry.sopInstanceUid,
        targetSeriesInstanceUid: entry.targetSeriesInstanceUid,
        hasTargetConflictBackup: Boolean(entry.targetSnapshotPath),
      })),
    };
  }
  return value;
}

async function listManagerOperations(options = {}) {
  const db = getPacsMetadataDb();
  await ensureManagerOperationTables(db);
  const where = [];
  const params = [];
  if (options.studyUid) {
    const studyUid = normalizeUid(options.studyUid);
    where.push('(source_study_uid = ? OR target_study_uid = ?)');
    params.push(studyUid, studyUid);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(String(options.status));
  }
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  params.push(limit);
  const [rows] = await db.query(
    `SELECT * FROM pacs_manager_operations
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    params
  );
  return rows.map(row => publicManagerOperation(row, false));
}

async function getManagerOperation(operationId) {
  return publicManagerOperation(await loadManagerOperationRow(operationId), true);
}

async function preflightManagerOperationRestore(operationId) {
  const row = await loadManagerOperationRow(operationId);
  const conflicts = [];
  if (!['completed', 'failed', 'restore_failed', 'cancelled'].includes(String(row.status))) {
    conflicts.push({ code: 'invalid_status', message: `Operation status ${row.status} cannot be restored` });
  }
  let manifest = null;
  try {
    manifest = await loadManagerManifest(row);
  } catch (error) {
    conflicts.push({ code: 'snapshot_unavailable', message: error.message });
  }
  for (const entry of manifest?.entries || []) {
    if (!(await fileExists(entry.snapshotPath))) {
      conflicts.push({ code: 'snapshot_file_missing', sopInstanceUid: entry.sopInstanceUid, message: 'Original snapshot file is missing' });
      continue;
    }
    const snapshotHash = await sha256File(entry.snapshotPath);
    if (snapshotHash !== entry.originalHash) {
      conflicts.push({ code: 'snapshot_checksum_mismatch', sopInstanceUid: entry.sopInstanceUid, message: 'Original snapshot checksum does not match' });
    }
    if (entry.targetSnapshotPath) {
      if (!(await fileExists(entry.targetSnapshotPath))) {
        conflicts.push({ code: 'target_snapshot_file_missing', sopInstanceUid: entry.sopInstanceUid, message: 'The overwritten target backup is missing' });
      } else if (entry.targetOriginalHash && await sha256File(entry.targetSnapshotPath) !== entry.targetOriginalHash) {
        conflicts.push({ code: 'target_snapshot_checksum_mismatch', sopInstanceUid: entry.sopInstanceUid, message: 'The overwritten target backup checksum does not match' });
      }
    }
    if (!(await fileExists(entry.targetPath))) {
      // A cancelled merge leaves entries that never moved: their target file does not
      // exist yet and their source file is still in place, so there is nothing to roll
      // back. Only a genuinely missing object (absent on both sides) is a conflict.
      if (entry.sourcePath && await fileExists(entry.sourcePath)) continue;
      conflicts.push({ code: 'current_file_missing', sopInstanceUid: entry.sopInstanceUid, message: 'The operation output file is no longer at its expected location' });
      continue;
    }
    if (entry.operationOutputHash) {
      const currentHash = await sha256File(entry.targetPath);
      if (currentHash !== entry.operationOutputHash) {
        conflicts.push({ code: 'current_file_changed', sopInstanceUid: entry.sopInstanceUid, message: 'The DICOM file changed after this operation' });
      }
    }
  }
  return {
    operation: publicManagerOperation(row, true),
    canRestore: conflicts.length === 0,
    conflicts,
  };
}

async function restoreStudyOverrideSnapshot(manifest) {
  const studyUid = normalizeUid(manifest.sourceStudyUid);
  const override = manifest.sourceOverride || { present: false, replace: null };
  if (override.present) {
    const replace = override.replace && typeof override.replace === 'object' ? override.replace : {};
    await pool.query(
      `INSERT INTO dicomweb_pacs_metadata_overrides (study_instance_uid, replace_json)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE replace_json = VALUES(replace_json)`,
      [studyUid, JSON.stringify(replace)]
    );
    await writeStudyMetadataOverrideFile(studyUid, replace);
    return;
  }

  await pool.query(
    'DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?',
    [studyUid]
  ).catch(() => {});
  const overridePath = path.join(resolveStudyPath(studyUid), METADATA_OVERRIDE_FILENAME);
  await fsp.rm(overridePath, { force: true }).catch(() => {});
}

async function clearManagerRestoreTombstones(manifest) {
  await ensureStateTables();
  const resources = [
    ['study', manifest.sourceStudyUid],
    ...(manifest.sourceSeriesUid ? [['series', manifest.sourceSeriesUid]] : []),
    ...(manifest.entries || []).map(entry => ['instance', entry.sopInstanceUid]),
  ];
  for (const [resourceType, resourceUid] of resources) {
    await pool.query(
      'DELETE FROM dicomweb_pacs_deleted_resources WHERE resource_type = ? AND resource_uid = ?',
      [resourceType, resourceUid]
    ).catch(() => {});
  }
}

async function restoreManagerManifestFiles(manifest) {
  const db = getPacsMetadataDb();
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];

  // First remove the operation output. If the operation overwrote a matching
  // SOP in the target, put that exact target object back instead.
  for (const entry of entries) {
    const sourcePath = assertPathWithin(PACS_STORAGE_PATH, entry.sourcePath, 'source DICOM path');
    const targetPath = assertPathWithin(PACS_STORAGE_PATH, entry.targetPath, 'target DICOM path');
    if (sourcePath === targetPath) continue;
    if (entry.targetSnapshotPath) {
      const targetSnapshotPath = assertPathWithin(
        MANAGER_HISTORY_ROOT,
        entry.targetSnapshotPath,
        'target conflict snapshot path'
      );
      if (!(await fileExists(targetSnapshotPath))) {
        const error = new Error(`Target conflict snapshot is missing for SOP ${entry.sopInstanceUid}`);
        error.status = 409;
        throw error;
      }
      await atomicCopyFile(targetSnapshotPath, targetPath);
    } else {
      await fsp.rm(targetPath, { force: true });
    }
  }

  // Then restore every original source object, including same-path metadata
  // corrections and moves between series in the same study.
  for (const entry of entries) {
    const snapshotPath = assertPathWithin(MANAGER_HISTORY_ROOT, entry.snapshotPath, 'original snapshot path');
    const sourcePath = assertPathWithin(PACS_STORAGE_PATH, entry.sourcePath, 'source DICOM path');
    await atomicCopyFile(snapshotPath, sourcePath);
  }

  await restoreStudyOverrideSnapshot(manifest);
  await clearManagerRestoreTombstones(manifest);

  // Remove stale PACS metadata rows for the operation output before the
  // restored DICOM objects are re-indexed by the PACS listener.
  const affectedStudies = new Set();
  for (const entry of entries) {
    const targetStudyUid = normalizeUid(manifest.targetStudyUid || entry.studyInstanceUid);
    const targetSeriesUid = normalizeUid(entry.targetSeriesInstanceUid || entry.seriesInstanceUid);
    await db.query(
      `DELETE FROM pacs_instances
       WHERE study_instance_uid = ? AND series_instance_uid = ? AND sop_instance_uid = ?`,
      [targetStudyUid, targetSeriesUid, entry.sopInstanceUid]
    );
    affectedStudies.add(targetStudyUid);
  }
  for (const studyUid of affectedStudies) {
    await db.query(
      `DELETE FROM pacs_series ps
       WHERE ps.study_instance_uid = ?
         AND NOT EXISTS (
           SELECT 1 FROM pacs_instances pi
           WHERE pi.study_instance_uid = ps.study_instance_uid
             AND pi.series_instance_uid = ps.series_instance_uid
         )`,
      [studyUid]
    );
    await refreshPacsMetadataCounts(db, studyUid).catch(() => {});
  }

  const sourceStudyUid = normalizeUid(manifest.sourceStudyUid);
  const sourceRefresh = await refreshStudyIndex(sourceStudyUid);
  let targetRefresh = null;
  if (
    manifest.targetStudyUid &&
    manifest.targetStudyUid !== sourceStudyUid &&
    entries.some(entry => Boolean(entry.targetSnapshotPath))
  ) {
    targetRefresh = await refreshStudyIndex(manifest.targetStudyUid);
  }
  invalidateQidoCacheForStudies(sourceStudyUid, manifest && manifest.targetStudyUid);
  previewCache.clear(); seriesThumbnailCache.clear();
  return {
    restoredObjectCount: entries.length,
    sourceRefresh,
    targetRefresh,
  };
}

async function restoreManagerOperation(operationId, options = {}) {
  const reason = String(options.reason || '').trim();
  if (reason.length < 3) {
    const error = new Error('Restore reason must contain at least 3 characters');
    error.status = 400;
    throw error;
  }

  const preflight = await preflightManagerOperationRestore(operationId);
  if (!preflight.canRestore) {
    const error = new Error('Restore preflight found conflicts; no files were changed');
    error.status = 409;
    error.conflicts = preflight.conflicts;
    throw error;
  }

  const db = getPacsMetadataDb();
  const row = await loadManagerOperationRow(operationId);
  const [lockResult] = await db.query(
    `UPDATE pacs_manager_operations
     SET status = ?, error_message = NULL
     WHERE id = ? AND status IN (?, ?, ?, ?)`,
    ['restoring', operationId, 'completed', 'failed', 'restore_failed', 'cancelled']
  );
  if (Number(lockResult?.affectedRows || 0) !== 1) {
    const error = new Error('Operation is no longer available for restore');
    error.status = 409;
    throw error;
  }

  const restoreOperationId = crypto.randomUUID();
  const restoredBy = String(options.username || '').trim() || null;
  const restoreManifest = {
    version: 1,
    operationId: restoreOperationId,
    operationType: 'restore',
    parentOperationId: operationId,
    createdAt: new Date().toISOString(),
    reason,
    result: null,
  };
  let restoreApplied = false;
  let restoreResult = null;
  try {
    await db.query(
      `INSERT INTO pacs_manager_operations (
         id, parent_operation_id, operation_type, status,
         source_study_uid, source_series_uid, source_sop_uid,
         target_study_uid, target_series_uid, target_patient_id,
         username, reason, object_count, manifest_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        restoreOperationId,
        operationId,
        'restore',
        'restoring',
        row.source_study_uid,
        row.source_series_uid,
        row.source_sop_uid,
        row.target_study_uid,
        row.target_series_uid,
        row.target_patient_id,
        restoredBy,
        reason,
        row.object_count,
        JSON.stringify(restoreManifest),
      ]
    );
    const manifest = await loadManagerManifest(row);
    restoreResult = await restoreManagerManifestFiles(manifest);
    restoreApplied = true;
    restoreManifest.result = restoreResult;
    await db.query(
      `UPDATE pacs_manager_operations
       SET status = ?, manifest_json = ?, completed_at = CURRENT_TIMESTAMP, error_message = NULL
       WHERE id = ?`,
      [
        'completed',
        JSON.stringify(restoreManifest),
        restoreOperationId,
      ]
    );
    await db.query(
      `UPDATE pacs_manager_operations
       SET status = ?, restored_at = CURRENT_TIMESTAMP, restored_by = ?,
           restore_reason = ?, restored_by_operation_id = ?, error_message = NULL
       WHERE id = ?`,
      ['restored', restoredBy, reason, restoreOperationId, operationId]
    );
    return {
      operationId,
      restoreOperationId,
      status: 'restored',
      ...restoreResult,
    };
  } catch (error) {
    const message = String(error?.message || error || 'Restore failed').slice(0, 4000);
    await db.query(
      `UPDATE pacs_manager_operations
       SET status = ?, manifest_json = ?, completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,
           error_message = ?
       WHERE id = ?`,
      [
        restoreApplied ? 'completed' : 'failed',
        JSON.stringify({ ...restoreManifest, result: restoreResult, journalWarning: restoreApplied ? message : null }),
        restoreApplied,
        message,
        restoreOperationId,
      ]
    ).catch(() => {});
    await db.query(
      `UPDATE pacs_manager_operations
       SET status = ?, restored_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE restored_at END,
           restored_by = CASE WHEN ? THEN ? ELSE restored_by END,
           restore_reason = CASE WHEN ? THEN ? ELSE restore_reason END,
           restored_by_operation_id = CASE WHEN ? THEN ? ELSE restored_by_operation_id END,
           error_message = ?
       WHERE id = ?`,
      [
        restoreApplied ? 'restored' : 'restore_failed',
        restoreApplied,
        restoreApplied,
        restoredBy,
        restoreApplied,
        reason,
        restoreApplied,
        restoreOperationId,
        message,
        operationId,
      ]
    ).catch(() => {});
    if (restoreApplied) {
      return {
        operationId,
        restoreOperationId,
        status: 'restored',
        ...restoreResult,
        journalWarning: message,
      };
    }
    throw error;
  }
}

function writeUInt16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeUInt32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function parseTagId(tagId) {
  return {
    group: Number.parseInt(tagId.slice(0, 4), 16),
    element: Number.parseInt(tagId.slice(4, 8), 16),
  };
}

function encodeDicomTextValue(value, vr = 'LO') {
  if (value === null || value === undefined || value === '') {
    return Buffer.alloc(0);
  }
  let text = String(value);
  if (text.length % 2 === 1) {
    text += vr === 'UI' ? '\0' : ' ';
  }
  return Buffer.from(text, 'ascii');
}

function buildElementHeader(tagId, vr, valueLength, implicitVr) {
  const { group, element } = parseTagId(tagId);
  if (implicitVr) {
    return Buffer.concat([
      writeUInt16LE(group),
      writeUInt16LE(element),
      writeUInt32LE(valueLength),
    ]);
  }
  const vrBuffer = Buffer.from(vr || 'LO', 'ascii');
  return Buffer.concat([
    writeUInt16LE(group),
    writeUInt16LE(element),
    vrBuffer,
    writeUInt16LE(valueLength),
  ]);
}

function getTransferSyntax(dataset) {
  return getElementString(dataset, 'x00020010') || '1.2.840.10008.1.2';
}

function isImplicitLittleEndian(dataset) {
  return getTransferSyntax(dataset) === '1.2.840.10008.1.2';
}

// VRs whose explicit-VR header carries a 2-byte reserved field and a 4-byte
// length, i.e. a 12-byte header instead of the usual 8.
const LONG_VR_SET = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'UN', 'UC', 'UR']);

/**
 * Offset of an element's header inside the file buffer.
 *
 * Long-VR elements (PixelData is OB, the big one) have a 12-byte header, so
 * assuming 8 spliced the byte stream in the middle of their own header and
 * produced a file that no longer parses. The buffer is inspected when the parser
 * did not expose a VR (implicit datasets carry none).
 */
function getElementHeaderStart(element, implicitVr, buffer = null) {
  if (!element || typeof element.dataOffset !== 'number') return null;
  if (implicitVr) return element.dataOffset - 8;
  let vr = String(element.vr || '');
  if (!vr && buffer && element.dataOffset >= 6) {
    vr = buffer.subarray(element.dataOffset - 6, element.dataOffset - 4).toString('ascii');
  }
  return element.dataOffset - (LONG_VR_SET.has(vr) ? 12 : 8);
}

function buildReplacementElement(tagId, keyword, value, implicitVr) {
  const vr = textVrByKeyword[keyword] || 'LO';
  const valueBuffer = encodeDicomTextValue(value, vr);
  return Buffer.concat([
    buildElementHeader(tagId, vr, valueBuffer.length, implicitVr),
    valueBuffer,
  ]);
}

function writeTagHeader(tagId, vr, length) {
  const { group, element } = parseTagId(tagId);
  const parts = [writeUInt16LE(group), writeUInt16LE(element), Buffer.from(vr, 'ascii')];
  if (LONG_VR_SET.has(vr)) {
    parts.push(Buffer.alloc(2), writeUInt32LE(length));
  } else {
    parts.push(writeUInt16LE(length));
  }
  return Buffer.concat(parts);
}

function encodeValueByVr(vr, value) {
  if (Buffer.isBuffer(value)) {
    return value.length % 2 === 1 ? Buffer.concat([value, Buffer.alloc(1)]) : value;
  }
  if (vr === 'US') {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(Number(value || 0), 0);
    return buffer;
  }
  if (vr === 'UL') {
    return writeUInt32LE(Number(value || 0));
  }
  return encodeDicomTextValue(value, vr);
}

function dicomElement(tagId, vr, value) {
  const valueBuffer = encodeValueByVr(vr, value);
  return Buffer.concat([writeTagHeader(tagId, vr, valueBuffer.length), valueBuffer]);
}

function createDicomFileBuffer(elements) {
  const preamble = Buffer.alloc(128);
  const prefix = Buffer.from('DICM', 'ascii');
  const metaWithoutLength = Buffer.concat([
    dicomElement('00020001', 'OB', Buffer.from([0x00, 0x01])),
    dicomElement('00020002', 'UI', elements.mediaStorageSopClassUid),
    dicomElement('00020003', 'UI', elements.sopInstanceUid),
    dicomElement('00020010', 'UI', '1.2.840.10008.1.2.1'),
    dicomElement('00020012', 'UI', '1.2.826.0.1.3680043.10.5432.1'),
    dicomElement('00020013', 'SH', 'NEXIA_RIS'),
  ]);
  const fileMeta = Buffer.concat([
    dicomElement('00020000', 'UL', metaWithoutLength.length),
    metaWithoutLength,
  ]);
  const dataset = Buffer.concat(elements.dataset);
  return Buffer.concat([preamble, prefix, fileMeta, dataset]);
}

function decodeImageData({ mimeType, buffer }) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, rgba: png.data };
  }
  if (mime.includes('jpeg') || mime.includes('jpg')) {
    const jpegImage = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 512 });
    return { width: jpegImage.width, height: jpegImage.height, rgba: jpegImage.data };
  }
  const error = new Error('Only PNG and JPEG uploads are supported');
  error.status = 400;
  throw error;
}

function rgbaToRgb(rgba) {
  const rgb = Buffer.alloc(Math.floor(rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

function getSortedElements(dataset) {
  return Object.values(dataset.elements || {})
    .filter(element => element && typeof element.dataOffset === 'number')
    .sort((a, b) => a.dataOffset - b.dataOffset);
}

function rewriteDicomMetadataBuffer(inputBuffer, replace) {
  const dataSet = dicomParser.parseDicom(new Uint8Array(inputBuffer));
  const implicitVr = isImplicitLittleEndian(dataSet);
  const targetByTag = new Map();
  for (const [keyword, value] of Object.entries(replace || {})) {
    const def = studyOverrideTags[keyword];
    if (!def) continue;
    targetByTag.set(`x${def[0].toLowerCase()}`, {
      tagId: def[0],
      keyword,
      value,
    });
  }
  if (!targetByTag.size) {
    return inputBuffer;
  }

  const elements = getSortedElements(dataSet);
  const pixelData = dataSet.elements.x7fe00010;
  const pixelHeaderStart = pixelData ? getElementHeaderStart(pixelData, implicitVr, inputBuffer) : null;
  const parts = [];
  let cursor = 0;
  const handled = new Set();

  for (const element of elements) {
    const target = targetByTag.get(element.tag);
    if (!target) continue;
    const headerStart = getElementHeaderStart(element, implicitVr, inputBuffer);
    if (headerStart === null || headerStart < cursor) continue;
    parts.push(inputBuffer.subarray(cursor, headerStart));
    parts.push(buildReplacementElement(target.tagId, target.keyword, target.value, implicitVr));
    cursor = element.dataOffset + element.length;
    handled.add(element.tag);
  }

  const missing = Array.from(targetByTag.entries())
    .filter(([tag]) => !handled.has(tag))
    .map(([, target]) => target)
    .sort((a, b) => a.tagId.localeCompare(b.tagId));
  if (missing.length && pixelHeaderStart !== null && pixelHeaderStart >= cursor) {
    parts.push(inputBuffer.subarray(cursor, pixelHeaderStart));
    for (const target of missing) {
      parts.push(buildReplacementElement(target.tagId, target.keyword, target.value, implicitVr));
    }
    cursor = pixelHeaderStart;
  }

  parts.push(inputBuffer.subarray(cursor));
  return Buffer.concat(parts);
}

/**
 * Run `worker` over `items` with a bounded number of concurrent workers.
 *
 * Every manager operation used to process one DICOM file at a time: read,
 * rewrite, snapshot, write. The work is dominated by file I/O, so a handful of
 * workers keeps the disk busy without exhausting memory on large studies.
 */
async function mapWithConcurrency(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Keep a second reference to `sourcePath`'s bytes.
 *
 * A hard link is O(1) instead of a full copy, and it is safe here because every
 * writer in this service replaces files through write-to-temp + rename: the
 * linked inode is never mutated, so backups and restore snapshots keep the
 * original bytes even after the working file is moved or deleted. Volumes that
 * refuse links (different drive, no permission) silently fall back to a copy.
 */
async function linkOrCopy(sourcePath, targetPath) {
  try {
    await fsp.link(sourcePath, targetPath);
    return 'link';
  } catch (_) {
    await fsp.copyFile(sourcePath, targetPath);
    return 'copy';
  }
}

function managerSnapshotLinkEnabled() {
  const value = String(process.env.VEXA_MANAGER_SNAPSHOT_LINK ?? 'true').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

async function snapshotDicomFile(sourcePath, targetPath) {
  if (!managerSnapshotLinkEnabled()) {
    await fsp.copyFile(sourcePath, targetPath);
    return 'copy';
  }
  return linkOrCopy(sourcePath, targetPath);
}

async function backupDicomFile(filePath, studyUid, sopInstanceUid) {
  const backupDir = path.join(DICOM_BACKUP_ROOT, studyUid);
  await fsp.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(4).toString('hex');
  const backupPath = path.join(backupDir, `${sopInstanceUid}.${stamp}.${suffix}.dcm`);
  await linkOrCopy(filePath, backupPath);
  return backupPath;
}

async function writeStudyMetadataOverrideFile(studyUid, replace) {
  const study = normalizeUid(studyUid);
  const studyPath = resolveStudyPath(study);
  if (!(await fileExists(studyPath))) {
    return;
  }
  const overridePath = path.join(studyPath, METADATA_OVERRIDE_FILENAME);
  const tempPath = `${overridePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(
    tempPath,
    JSON.stringify({ replace, updatedAt: new Date().toISOString() }, null, 2)
  );
  await fsp.rename(tempPath, overridePath);
}

/**
 * Resolve the stored file for many SOP UIDs in one query.
 *
 * getInstanceFilePath does one round trip per instance, and the pool only has a
 * handful of connections, so a study merge serialised on the database. One query
 * per series removes that bottleneck; callers fall back to the per-instance
 * lookup (and then to the storage convention) when a path is missing or gone.
 */
async function resolveInstancePathsForSeries(studyUid, seriesUid, sopUids) {
  const result = new Map();
  const sops = Array.from(new Set((sopUids || []).filter(Boolean)));
  if (!sops.length) return result;
  const db = getPacsMetadataDb();
  const conditions = ['study_instance_uid = ?', 'sop_instance_uid IN (?)'];
  const params = [normalizeUid(studyUid), sops];
  if (seriesUid) {
    conditions.splice(1, 0, 'series_instance_uid = ?');
    params.splice(1, 0, normalizeUid(seriesUid));
  }
  try {
    const [rows] = await db.query(
      `SELECT sop_instance_uid, file_path FROM pacs_instances WHERE ${conditions.join(' AND ')}`,
      params
    );
    for (const row of rows) {
      const storedPath = String(row?.file_path || '').trim();
      if (!storedPath) continue;
      try {
        result.set(String(row.sop_instance_uid), assertPathWithin(PACS_STORAGE_PATH, storedPath, 'indexed DICOM path'));
      } catch (_) {
        // Row points outside managed storage: ignore it and use the fallbacks.
      }
    }
  } catch (_) {
    return result;
  }
  return result;
}

async function rewriteStudyDicomFiles(studyUid, replace) {
  const study = normalizeUid(studyUid);
  const seriesList = await getSeries(study, {});
  const changed = [];
  for (const series of seriesList.data) {
    const seriesUid = getSeriesUid(series);
    if (!seriesUid) continue;
    const instances = await getInstances(study, seriesUid, {});
    for (const instance of instances.data) {
      const sop = getInstanceUid(instance);
      if (!sop) continue;
      const filePath = resolveInstancePath(study, sop);
      if (!(await fileExists(filePath))) continue;
      const original = await fsp.readFile(filePath);
      const next = rewriteDicomMetadataBuffer(original, replace);
      if (next.equals(original)) continue;
      const backupPath = await backupDicomFile(filePath, study, sop);
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tempPath, next);
      await fsp.rename(tempPath, filePath);
      changed.push({ sopInstanceUid: sop, backupPath });
    }
  }
  return changed;
}

async function findInstanceRecordBySop(sopInstanceUid, seriesInstanceUid) {
  const query = { SOPInstanceUID: sopInstanceUid };
  const studies = await fetchDicomJson('/studies', {});
  for (const study of studies) {
    const studyUid = getStudyUid(study);
    if (!studyUid) continue;
    const seriesList = await fetchDicomJson(`/studies/${encodeURIComponent(studyUid)}/series`, {});
    for (const series of seriesList) {
      const seriesUid = getSeriesUid(series);
      if (!seriesUid) continue;
      if (seriesInstanceUid && seriesUid !== seriesInstanceUid) continue;
      const instances = await fetchDicomJson(
        `/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances`,
        query
      );
      const match = instances.find(item => getInstanceUid(item) === sopInstanceUid);
      if (match) return { studyUid, seriesUid, instance: match };
    }
  }
  return null;
}

async function getInstanceFilePath({ studyUid, seriesUid, sopInstanceUid }) {
  const sop = normalizeUid(sopInstanceUid);
  const db = getPacsMetadataDb();
  const conditions = ['sop_instance_uid = ?'];
  const params = [sop];
  if (studyUid) {
    conditions.push('study_instance_uid = ?');
    params.push(normalizeUid(studyUid));
  }
  if (seriesUid) {
    conditions.push('series_instance_uid = ?');
    params.push(normalizeUid(seriesUid));
  }
  try {
    const [rows] = await db.query(
      `SELECT file_path FROM pacs_instances WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params
    );
    const indexedPath = String(rows?.[0]?.file_path || '').trim();
    if (indexedPath) {
      const resolvedPath = path.isAbsolute(indexedPath)
        ? path.resolve(indexedPath)
        : path.resolve(PACS_STORAGE_PATH, indexedPath);
      const relativePath = path.relative(PACS_STORAGE_PATH, resolvedPath);
      if (
        relativePath &&
        !relativePath.startsWith('..') &&
        !path.isAbsolute(relativePath) &&
        await fileExists(resolvedPath)
      ) {
        return resolvedPath;
      }
    }
  } catch (_) {
    // Fall back to the legacy study/SOP storage convention below.
  }
  if (studyUid) {
    const directPath = resolveInstancePath(studyUid, sop);
    if (await fileExists(directPath)) {
      return directPath;
    }
  }
  const found = await findInstanceRecordBySop(sop, seriesUid);
  if (found?.studyUid) {
    const filePath = resolveInstancePath(found.studyUid, sop);
    if (await fileExists(filePath)) return filePath;
  }
  const error = new Error('DICOM instance file not found in dicomweb-pacs storage');
  error.status = 404;
  throw error;
}

function getElementString(dataset, tagName) {
  try {
    return dataset.string(tagName) || '';
  } catch (_) {
    return '';
  }
}

function getElementNumber(dataset, tagName, fallback = 0) {
  const element = dataset.elements[tagName];
  if (!element) return fallback;

  const binaryNumericTags = new Set([
    'x00280002', // SamplesPerPixel
    'x00280006', // PlanarConfiguration
    'x00280010', // Rows
    'x00280011', // Columns
    'x00280100', // BitsAllocated
    'x00280101', // BitsStored
    'x00280102', // HighBit
    'x00280103', // PixelRepresentation
  ]);
  if (binaryNumericTags.has(tagName)) {
    const readers = element.length <= 2
      ? [
          () => dataset.uint16(tagName, 0),
          () => dataset.int16(tagName, 0),
        ]
      : [
          () => dataset.uint32(tagName, 0),
          () => dataset.int32(tagName, 0),
        ];
    for (const read of readers) {
      try {
        const value = read();
        if (Number.isFinite(value)) return value;
      } catch (_) {
      }
    }
  }

  const readers = [
    () => dataset.floatString(tagName, 0),
    () => dataset.intString(tagName, 0),
    () => dataset.uint16(tagName, 0),
    () => dataset.int16(tagName, 0),
    () => dataset.uint32(tagName, 0),
    () => dataset.int32(tagName, 0),
  ];
  for (const read of readers) {
    try {
      const value = read();
      if (Number.isFinite(value)) return value;
    } catch (_) {
    }
  }

  const raw = getElementString(dataset, tagName);
  const first = String(raw || '').split('\\')[0];
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getElementNumberValues(dataset, tagName) {
  const raw = getElementString(dataset, tagName);
  if (!raw) return [];
  return String(raw)
    .split('\\')
    .map(value => Number(String(value).trim()))
    .filter(value => Number.isFinite(value));
}

function getDicomWindowRange(dataset, min, max, windowCenter, windowWidth) {
  const requestedCenter = Number(windowCenter);
  const requestedWidth = Number(windowWidth);
  if (Number.isFinite(requestedCenter) && Number.isFinite(requestedWidth) && requestedWidth > 1) {
    return {
      min: requestedCenter - requestedWidth / 2,
      max: requestedCenter + requestedWidth / 2,
    };
  }
  const centers = getElementNumberValues(dataset, 'x00281050');
  const widths = getElementNumberValues(dataset, 'x00281051');
  if (!centers.length || !widths.length) {
    return { min, max };
  }
  const selectedCenter = centers[0];
  const selectedWidth = widths[0];
  if (!Number.isFinite(selectedCenter) || !Number.isFinite(selectedWidth) || selectedWidth <= 1) {
    return { min, max };
  }
  return {
    min: selectedCenter - selectedWidth / 2,
    max: selectedCenter + selectedWidth / 2,
  };
}

/**
 * Placeholder untuk keadaan "gambar belum bisa dirender" (bukan "tidak ada gambar").
 * Ditandai notReady supaya route mengirim Cache-Control: no-store + Retry-After,
 * sehingga viewer mencoba lagi dan tidak menyimpan tile kosong.
 */
function svgNotReady(message) {
  const placeholder = svgPlaceholder(message);
  placeholder.notReady = true;
  return placeholder;
}

function svgPlaceholder(message) {
  const safe = String(message || 'Preview unavailable')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return {
    contentType: 'image/svg+xml; charset=utf-8',
    buffer: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#111827"/><text x="256" y="244" fill="#d1d5db" font-family="Arial, sans-serif" font-size="24" text-anchor="middle">DICOM</text><text x="256" y="284" fill="#9ca3af" font-family="Arial, sans-serif" font-size="18" text-anchor="middle">${safe}</text></svg>`
    ),
  };
}

function renderRgbaToPng(rgba, sourceWidth, sourceHeight) {
  const maxDim = 512;
  const scale = Math.min(1, maxDim / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const png = new PNG({ width: targetWidth, height: targetHeight });
  for (let y = 0; y < targetHeight; y += 1) {
    const srcY = Math.min(sourceHeight - 1, Math.floor(y / scale));
    for (let x = 0; x < targetWidth; x += 1) {
      const srcX = Math.min(sourceWidth - 1, Math.floor(x / scale));
      const srcIdx = (srcY * sourceWidth + srcX) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      png.data[dstIdx] = rgba[srcIdx];
      png.data[dstIdx + 1] = rgba[srcIdx + 1];
      png.data[dstIdx + 2] = rgba[srcIdx + 2];
      png.data[dstIdx + 3] = rgba[srcIdx + 3] ?? 255;
    }
  }
  return {
    contentType: 'image/png',
    buffer: PNG.sync.write(png),
  };
}

function renderEncapsulatedJpegPreview(dataset, pixelDataElement) {
  const fragment = pixelDataElement.fragments?.find(item => item && item.length > 0);
  if (!fragment) {
    return null;
  }
  const byteOffset = dataset.byteArray.byteOffset ?? 0;
  const jpegBuffer = Buffer.from(
    dataset.byteArray.buffer,
    byteOffset + fragment.position,
    fragment.length
  );
  try {
    const decoded = jpeg.decode(jpegBuffer, { useTArray: true, maxMemoryUsageInMB: 512 });
    if (!decoded?.width || !decoded?.height || !decoded?.data) {
      return null;
    }
    return renderRgbaToPng(decoded.data, decoded.width, decoded.height);
  } catch (_) {
    return null;
  }
}

function setPngPixel(png, width, height, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const idx = (y * width + x) * 4;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function drawPngLine(png, width, height, x0, y0, x1, y1, r, g, b) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const dx = Math.abs(endX - x);
  const dy = Math.abs(endY - y);
  const sx = x < endX ? 1 : -1;
  const sy = y < endY ? 1 : -1;
  let err = dx - dy;
  while (true) {
    setPngPixel(png, width, height, x, y, r, g, b);
    if (x === endX && y === endY) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function renderWaveformPng(dataset) {
  const waveformSequence = dataset.elements.x54000100;
  const groups = Array.isArray(waveformSequence?.items) ? waveformSequence.items : [];
  const group = groups.find(item => item?.dataSet?.elements?.x54001010)?.dataSet;
  if (!group) return null;

  const channels = Math.max(1, getElementNumber(group, 'x003a0005', 0));
  const samples = Math.max(1, getElementNumber(group, 'x003a0010', 0));
  const bitsAllocated = getElementNumber(group, 'x54001004', 16);
  const waveformData = group.elements.x54001010;
  if (!waveformData || bitsAllocated !== 16 || channels <= 0 || samples <= 0) return null;

  const src = group.byteArray;
  const dataView = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const width = 640;
  const height = 420;
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 252;
    png.data[i + 1] = 247;
    png.data[i + 2] = 247;
    png.data[i + 3] = 255;
  }

  for (let x = 0; x < width; x += 10) {
    const major = x % 50 === 0;
    for (let y = 0; y < height; y += 1) setPngPixel(png, width, height, x, y, major ? 232 : 244, major ? 196 : 224, major ? 196 : 224, 255);
  }
  for (let y = 0; y < height; y += 10) {
    const major = y % 50 === 0;
    for (let x = 0; x < width; x += 1) setPngPixel(png, width, height, x, y, major ? 232 : 244, major ? 196 : 224, major ? 196 : 224, 255);
  }

  const visibleChannels = Math.min(channels, 12);
  const left = 28;
  const right = 12;
  const top = 18;
  const bottom = 18;
  const laneHeight = (height - top - bottom) / visibleChannels;
  const maxPoints = Math.min(width - left - right, samples);
  const sampleStep = Math.max(1, Math.floor(samples / maxPoints));
  const bytesPerFrame = channels * 2;

  for (let channel = 0; channel < visibleChannels; channel += 1) {
    let min = Infinity;
    let max = -Infinity;
    for (let sample = 0; sample < samples; sample += sampleStep) {
      const offset = waveformData.dataOffset + sample * bytesPerFrame + channel * 2;
      if (offset + 2 > src.byteLength) break;
      const value = dataView.getInt16(offset, true);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const range = max > min ? max - min : 1;
    const centerY = top + laneHeight * channel + laneHeight / 2;
    const amplitude = Math.max(8, laneHeight * 0.38);
    drawPngLine(png, width, height, left, centerY, width - right, centerY, 210, 210, 210);
    let previousX = left;
    let previousY = centerY;
    let pointIndex = 0;
    for (let sample = 0; sample < samples; sample += sampleStep) {
      const offset = waveformData.dataOffset + sample * bytesPerFrame + channel * 2;
      if (offset + 2 > src.byteLength) break;
      const value = dataView.getInt16(offset, true);
      const x = left + (pointIndex / Math.max(1, maxPoints - 1)) * (width - left - right);
      const normalized = ((value - min) / range - 0.5) * 2;
      const y = centerY - normalized * amplitude;
      if (pointIndex > 0) drawPngLine(png, width, height, previousX, previousY, x, y, 18, 65, 48);
      previousX = x;
      previousY = y;
      pointIndex += 1;
      if (pointIndex >= maxPoints) break;
    }
  }

  return {
    contentType: 'image/png',
    buffer: PNG.sync.write(png),
  };
}

function renderDicomPng(buffer, { windowCenter, windowWidth } = {}) {
  let dataset;
  try {
    dataset = dicomParser.parseDicom(new Uint8Array(buffer));
  } catch (_) {
    return svgPlaceholder('Invalid DICOM file');
  }
  const rows = getElementNumber(dataset, 'x00280010');
  const columns = getElementNumber(dataset, 'x00280011');
  const samplesPerPixel = getElementNumber(dataset, 'x00280002', 1);
  const bitsAllocated = getElementNumber(dataset, 'x00280100', 8);
  const pixelRepresentation = getElementNumber(dataset, 'x00280103', 0);
  const photometric = getElementString(dataset, 'x00280004').toUpperCase();
  const rescaleIntercept = getElementNumber(dataset, 'x00281052', 0);
  const rescaleSlope = getElementNumber(dataset, 'x00281053', 1) || 1;
  const pixelDataElement = dataset.elements.x7fe00010;
  if (!rows || !columns || !pixelDataElement) {
    return renderWaveformPng(dataset) || svgNotReady('Preview unavailable');
  }
  if (pixelDataElement.fragments) {
    const renderedJpeg = renderEncapsulatedJpegPreview(dataset, pixelDataElement);
    return renderedJpeg || svgNotReady('Preview unavailable');
  }

  const src = dataset.byteArray;
  const bytesPerSample = bitsAllocated > 8 ? 2 : 1;
  const frameSize = rows * columns * samplesPerPixel * bytesPerSample;
  if (pixelDataElement.length < frameSize) {
    return svgNotReady('Pixel data incomplete');
  }

  const maxDim = 512;
  const scale = Math.min(1, maxDim / Math.max(rows, columns));
  const targetWidth = Math.max(1, Math.floor(columns * scale));
  const targetHeight = Math.max(1, Math.floor(rows * scale));
  const png = new PNG({ width: targetWidth, height: targetHeight });

  const dataView = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const start = pixelDataElement.dataOffset;
  const isRgb = samplesPerPixel >= 3 && photometric.includes('RGB') && bitsAllocated === 8;
  const values = [];

  if (!isRgb) {
    const sampleCount = rows * columns;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < sampleCount; i += 1) {
      const offset = start + i * bytesPerSample;
      let value;
      if (bytesPerSample === 1) {
        value = src[offset];
      } else {
        value = pixelRepresentation
          ? dataView.getInt16(offset, true)
          : dataView.getUint16(offset, true);
      }
      value = value * rescaleSlope + rescaleIntercept;
      values.push(value);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const selectedRange = getDicomWindowRange(dataset, min, max, windowCenter, windowWidth);
    min = selectedRange.min;
    max = selectedRange.max;
    const range = max > min ? max - min : 1;
    for (let y = 0; y < targetHeight; y += 1) {
      const srcY = Math.min(rows - 1, Math.floor(y / scale));
      for (let x = 0; x < targetWidth; x += 1) {
        const srcX = Math.min(columns - 1, Math.floor(x / scale));
        const sample = values[srcY * columns + srcX];
        let gray = Math.max(0, Math.min(255, Math.round(((sample - min) / range) * 255)));
        if (photometric.includes('MONOCHROME1')) gray = 255 - gray;
        const idx = (y * targetWidth + x) * 4;
        png.data[idx] = gray;
        png.data[idx + 1] = gray;
        png.data[idx + 2] = gray;
        png.data[idx + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < targetHeight; y += 1) {
      const srcY = Math.min(rows - 1, Math.floor(y / scale));
      for (let x = 0; x < targetWidth; x += 1) {
        const srcX = Math.min(columns - 1, Math.floor(x / scale));
        const srcIdx = start + (srcY * columns + srcX) * 3;
        const idx = (y * targetWidth + x) * 4;
        png.data[idx] = src[srcIdx];
        png.data[idx + 1] = src[srcIdx + 1];
        png.data[idx + 2] = src[srcIdx + 2];
        png.data[idx + 3] = 255;
      }
    }
  }

  return {
    contentType: 'image/png',
    buffer: PNG.sync.write(png),
  };
}

async function renderInstancePreview({ studyUid, seriesUid, sopInstanceUid, frame = 1, windowCenter, windowWidth }) {
  const sop = normalizeUid(sopInstanceUid);
  const requestedFrame = Math.max(1, Math.floor(Number(frame) || 1));
  const requestedCenter = Number(windowCenter);
  const requestedWidth = Number(windowWidth);
  const hasRequestedWindow = Number.isFinite(requestedCenter) && Number.isFinite(requestedWidth) && requestedWidth > 1;
  const windowKey = hasRequestedWindow ? `${requestedCenter}:${requestedWidth}` : 'auto';
  const cacheKey = `preview:${PREVIEW_RENDER_VERSION}:${studyUid || ''}:${seriesUid || ''}:${sop}:frame-${requestedFrame}:${windowKey}`;
  const cached = previewCache.get(cacheKey);
  if (cached && !String(cached.contentType || '').includes('image/svg+xml')) {
    return cached;
  }

  if (studyUid && seriesUid) {
    try {
      const query = new URLSearchParams({
        frame: String(requestedFrame),
        rows: '512',
        columns: '512',
        quality: '82',
      });
      if (hasRequestedWindow) {
        query.set('wc', String(requestedCenter));
        query.set('ww', String(requestedWidth));
      }
      const renderedResponse = await fetch(
        `${PACS_RS_ROOT}/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(sop)}/rendered?${query.toString()}`,
        { headers: { Accept: 'image/jpeg, image/png' } }
      );
      if (renderedResponse.ok) {
        const renderedBuffer = Buffer.from(await renderedResponse.arrayBuffer());
        const result = {
          contentType: renderedResponse.headers.get('content-type') || 'image/jpeg',
          buffer: renderedBuffer,
          etag:
            renderedResponse.headers.get('etag') ||
            `W/"dicomweb-pacs-rendered-${PREVIEW_RENDER_VERSION}-${sop}-${requestedFrame}-${windowKey}"`,
        };
        previewCache.set(cacheKey, result);
        return result;
      }
    } catch (_) {
    }
  }

  const filePath = await getInstanceFilePath({ studyUid, seriesUid, sopInstanceUid: sop });
  const buffer = await fsp.readFile(filePath);
  const rendered = renderDicomPng(buffer, {
    windowCenter: hasRequestedWindow ? requestedCenter : undefined,
    windowWidth: hasRequestedWindow ? requestedWidth : undefined,
  });
  const result = {
    ...rendered,
    etag: `W/"dicomweb-pacs-preview-${PREVIEW_RENDER_VERSION}-${sop}-${windowKey}"`,
  };
  previewCache.set(cacheKey, result);
  return result;
}

/**
 * The study that owns a series, straight from the PACS metadata index.
 *
 * The fallback below lists /studies and then issues a series query per study until it finds
 * a match - O(archive) HTTP round trips, seconds once the archive is real. One indexed
 * query replaces it; the QIDO walk stays as a last resort when the index has no row.
 */
async function resolveStudyUidForSeries(seriesUid) {
  try {
    const result = await getPacsMetadataDb().query(
      'SELECT study_instance_uid FROM pacs_instances WHERE series_instance_uid = $1 LIMIT 1',
      [seriesUid]
    );
    const row = Array.isArray(result) ? result[0]?.[0] : result?.rows?.[0];
    return row?.study_instance_uid || null;
  } catch (_) {
    return null;
  }
}

async function renderSeriesThumbnailUncached(seriesInstanceUid, studyInstanceUid) {
  const seriesUid = normalizeUid(seriesInstanceUid);
  const studyUid = studyInstanceUid ? normalizeUid(studyInstanceUid) : null;
  let targetStudyUid = studyUid;
  if (!targetStudyUid) {
    targetStudyUid = await resolveStudyUidForSeries(seriesUid);
  }
  if (!targetStudyUid) {
    const studies = await fetchDicomJson('/studies', {});
    for (const study of studies) {
      const uid = getStudyUid(study);
      if (!uid) continue;
      const series = await fetchDicomJson(`/studies/${encodeURIComponent(uid)}/series`, {
        SeriesInstanceUID: seriesUid,
      });
      if (series.some(item => getSeriesUid(item) === seriesUid)) {
        targetStudyUid = uid;
        break;
      }
    }
  }
  if (!targetStudyUid) {
    const error = new Error('Series not found');
    error.status = 404;
    throw error;
  }
  const instances = await getInstances(targetStudyUid, seriesUid, {});
  const seriesInstances = Array.isArray(instances?.data) ? instances.data : [];
  if (!seriesInstances.length) {
    return svgNotReady('No image');
  }
  let fallbackResult = null;
  // Seri yang instance-nya ada tapi frame-nya masih kosong = "belum siap", bukan "tanpa gambar".
  let sawNotReadyRender = false;
  for (const item of seriesInstances) {
    const sop = getInstanceUid(item);
    if (!sop) {
      continue;
    }
    try {
      const rendered = await renderInstancePreview({
        studyUid: targetStudyUid,
        seriesUid,
        sopInstanceUid: sop,
        frame: Math.max(1, Math.ceil(getDicomNumber(item, '00280008', 1) / 2)),
      });
      // Frame 0 byte bukan gambar: tepat setelah STOW, PACS bisa mengembalikan frame kosong
      // selagi indeks/frame cache menyusul. Kalau itu diteruskan sebagai 200 image/jpeg,
      // viewer menyimpannya sebagai gambar kosong dan tile tetap hitam sampai cache kedaluwarsa.
      const renderedBytes = Buffer.isBuffer(rendered?.buffer)
        ? rendered.buffer.length
        : Number(rendered?.buffer?.byteLength || 0);
      if (!String(rendered.contentType || '').includes('image/svg+xml') && renderedBytes > 0) {
        return rendered;
      }
      if (renderedBytes <= 0) {
        sawNotReadyRender = true;
      } else if (!fallbackResult && String(rendered.contentType || '').includes('image/svg+xml')) {
        fallbackResult = rendered;
      }
    } catch (_) {
      continue;
    }
  }
  if (sawNotReadyRender) {
    // Instance ada tapi gambarnya belum bisa dirender: tandai supaya pemanggil TIDAK
    // men-cache placeholder ini dan UI mencoba lagi setelah PACS selesai mengindeks.
    const placeholder = svgPlaceholder('Preparing image');
    placeholder.notReady = true;
    return placeholder;
  }
  return fallbackResult || svgPlaceholder('No image');
}

/**
 * Thumbnail of a series, cached and coalesced.
 *
 * Every panel mount used to re-render: 20 concurrent requests for one series each did the
 * full work (measured 675 ms total, 523 ms per request) and even warm requests repeated the
 * instance lookup (~34 ms). Concurrent callers now share a single render, and the result is
 * reused for later viewers; an SVG placeholder (empty/unreadable series) is never cached.
 */
async function renderSeriesThumbnail(seriesInstanceUid, studyInstanceUid) {
  const cacheKey = `thumb:${normalizeUid(seriesInstanceUid)}:${studyInstanceUid ? normalizeUid(studyInstanceUid) : '-'}`;
  const cached = seriesThumbnailCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = seriesThumbnailInFlight.get(cacheKey);
  if (pending) {
    return pending;
  }
  const work = renderSeriesThumbnailUncached(seriesInstanceUid, studyInstanceUid)
    .then((result) => {
      if (!String(result?.contentType || '').includes('image/svg+xml')) {
        seriesThumbnailCache.set(cacheKey, result);
      }
      return result;
    })
    .finally(() => {
      seriesThumbnailInFlight.delete(cacheKey);
    });
  seriesThumbnailInFlight.set(cacheKey, work);
  return work;
}

async function tombstone(resourceType, resourceUid, parentStudyUid = null, parentSeriesUid = null) {
  await ensureStateTables();
  await pool.query(
    `
    INSERT INTO dicomweb_pacs_deleted_resources
      (resource_type, resource_uid, parent_study_uid, parent_series_uid)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      parent_study_uid = VALUES(parent_study_uid),
      parent_series_uid = VALUES(parent_series_uid),
      deleted_at = CURRENT_TIMESTAMP
    `,
    [resourceType, resourceUid, parentStudyUid, parentSeriesUid]
  );
  invalidateQidoCacheForStudies(parentStudyUid);
  previewCache.clear(); seriesThumbnailCache.clear();
}

async function deleteInstance(studyUid, seriesUid, sopInstanceUid) {
  const study = normalizeUid(studyUid);
  const series = normalizeUid(seriesUid);
  const sop = normalizeUid(sopInstanceUid);
  const filePath = resolveInstancePath(study, sop);
  if (await fileExists(filePath)) {
    await fsp.unlink(filePath);
  }
  await removeStoredFilesMatching(
    study,
    ids => ids.sopInstanceUid === sop || ids.fileName === sop
  );
  await tombstone('instance', sop, study, series);
  await purgePacsMetadata('instance', study, series, sop);
}

async function deleteSeries(studyUid, seriesUid) {
  const study = normalizeUid(studyUid);
  const series = normalizeUid(seriesUid);
  const instances = await getInstances(study, series, {});
  for (const instance of instances.data) {
    const sop = getInstanceUid(instance);
    if (sop) {
      const filePath = resolveInstancePath(study, sop);
      if (await fileExists(filePath)) {
        await fsp.unlink(filePath);
      }
      await tombstone('instance', sop, study, series);
    }
  }
  await removeStoredFilesMatching(study, ids => ids.seriesUid === series);
  await tombstone('series', series, study, null);
  await purgePacsMetadata('series', study, series);
}

async function deleteStudy(studyUid) {
  const study = normalizeUid(studyUid);
  const studyPath = resolveStudyPath(study);
  if (await fileExists(studyPath)) {
    await fsp.rm(studyPath, { recursive: true, force: true });
  }
  await tombstone('study', study, study, null);
  await purgePacsMetadata('study', study);
}

async function updateStudyMetadata(studyUid, replace) {
  const study = normalizeUid(studyUid);
  await ensureStateTables();
  const [rows] = await pool.query(
    'SELECT replace_json FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?',
    [study]
  );
  let current = {};
  if (rows.length) {
    try {
      current = parseJsonValue(rows[0].replace_json, {});
    } catch (_) {
      current = {};
    }
  }
  const next = { ...current, ...replace };
  const rewrittenInstances = await rewriteStudyDicomFiles(study, replace);
  let pacsRefresh = { status: 'skipped' };
  if (rewrittenInstances.length) {
    pacsRefresh = await refreshStudyIndex(study);
  }
  await pool.query(
    `
    INSERT INTO dicomweb_pacs_metadata_overrides (study_instance_uid, replace_json)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE replace_json = VALUES(replace_json)
    `,
    [study, JSON.stringify(next)]
  );
  await writeStudyMetadataOverrideFile(study, next);
  invalidateQidoCacheForStudies(study);
  previewCache.clear(); seriesThumbnailCache.clear();
  return {
    replace: next,
    rewrittenInstances,
    pacsRefresh,
  };
}

async function updateSeriesMetadata(studyUid, seriesUid, replace) {
  const study = normalizeUid(studyUid);
  const series = normalizeUid(seriesUid);
  const instances = await getInstances(study, series, { fresh: '1' });
  const rewrittenInstances = [];
  for (const instance of instances.data) {
    const sop = getInstanceUid(instance);
    if (!sop) continue;
    const filePath = resolveInstancePath(study, sop);
    if (!(await fileExists(filePath))) continue;
    const original = await fsp.readFile(filePath);
    const next = rewriteDicomMetadataBuffer(original, replace);
    if (next.equals(original)) continue;
    const backupPath = await backupDicomFile(filePath, study, sop);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tempPath, next);
    await fsp.rename(tempPath, filePath);
    rewrittenInstances.push({ sopInstanceUid: sop, backupPath });
  }
  const pacsRefresh = rewrittenInstances.length ? await refreshStudyIndex(study) : { status: 'skipped' };
  invalidateQidoCacheForStudies(study);
  previewCache.clear(); seriesThumbnailCache.clear();
  return {
    replace,
    rewrittenInstances,
    pacsRefresh,
  };
}

async function updateInstanceMetadata(studyUid, seriesUid, sopInstanceUid, replace) {
  const study = normalizeUid(studyUid);
  const series = normalizeUid(seriesUid);
  const sop = normalizeUid(sopInstanceUid);
  const filePath = await getInstanceFilePath({ studyUid: study, seriesUid: series, sopInstanceUid: sop });
  const original = await fsp.readFile(filePath);
  const next = rewriteDicomMetadataBuffer(original, replace);
  const rewrittenInstances = [];
  if (!next.equals(original)) {
    const backupPath = await backupDicomFile(filePath, study, sop);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tempPath, next);
    await fsp.rename(tempPath, filePath);
    rewrittenInstances.push({ sopInstanceUid: sop, backupPath });
  }
  const pacsRefresh = rewrittenInstances.length ? await refreshStudyIndex(study) : { status: 'skipped' };
  invalidateQidoCacheForStudies(study);
  previewCache.clear(); seriesThumbnailCache.clear();
  return {
    replace,
    rewrittenInstances,
    pacsRefresh,
  };
}

function buildStudyMoveReplace(targetStudyUid, targetStudyRecord) {
  return {
    StudyInstanceUID: normalizeUid(targetStudyUid),
    PatientName: getDicomString(targetStudyRecord, '00100010'),
    PatientID: getDicomString(targetStudyRecord, '00100020'),
    OtherPatientIDs: getDicomString(targetStudyRecord, '00101000'),
    PatientBirthDate: getDicomString(targetStudyRecord, '00100030'),
    PatientSex: getDicomString(targetStudyRecord, '00100040'),
    AccessionNumber: getDicomString(targetStudyRecord, '00080050'),
    InstitutionName: getDicomString(targetStudyRecord, '00080080'),
    StudyDescription: getDicomString(targetStudyRecord, '00081030'),
    ReferringPhysicianName: getDicomString(targetStudyRecord, '00080090'),
    StudyDate: getDicomString(targetStudyRecord, '00080020'),
    StudyTime: getDicomString(targetStudyRecord, '00080030'),
    StudyID: getDicomString(targetStudyRecord, '00200010'),
  };
}

function buildSeriesMoveReplace(targetSeriesUid, targetSeriesRecord) {
  return {
    SeriesInstanceUID: normalizeUid(targetSeriesUid),
    Modality: getDicomString(targetSeriesRecord, '00080060'),
    SeriesDescription: getDicomString(targetSeriesRecord, '0008103E'),
    SeriesNumber: getDicomString(targetSeriesRecord, '00200011'),
    BodyPartExamined: getDicomString(targetSeriesRecord, '00180015'),
    ProtocolName: getDicomString(targetSeriesRecord, '00181030'),
    Laterality: getDicomString(targetSeriesRecord, '00200060'),
  };
}

async function getStudyRecord(studyUid) {
  const study = normalizeUid(studyUid);
  const rows = await fetchDicomJson('/studies', { StudyInstanceUID: study, fresh: '1' });
  let record = rows.find(item => getStudyUid(item) === study);
  if (!record) {
    const db = getPacsMetadataDb();
    const [placeholderRows] = await db.query(
      'SELECT study_json FROM pacs_studies WHERE study_instance_uid = ? LIMIT 1',
      [study]
    );
    record = parseJsonValue(placeholderRows?.[0]?.study_json, null);
  }
  if (!record) {
    const error = new Error('Target study not found');
    error.status = 404;
    throw error;
  }
  return record;
}

async function getSeriesRecord(studyUid, seriesUid) {
  const study = normalizeUid(studyUid);
  const series = normalizeUid(seriesUid);
  const rows = await fetchDicomJson(`/studies/${encodeURIComponent(study)}/series`, {
    SeriesInstanceUID: series,
    fresh: '1',
  });
  let record = rows.find(item => getSeriesUid(item) === series);
  if (!record) {
    const db = getPacsMetadataDb();
    const [placeholderRows] = await db.query(
      `SELECT series_json FROM pacs_series
       WHERE study_instance_uid = ? AND series_instance_uid = ? LIMIT 1`,
      [study, series]
    );
    record = parseJsonValue(placeholderRows?.[0]?.series_json, null);
  }
  if (!record) {
    const error = new Error('Target series not found');
    error.status = 404;
    throw error;
  }
  return record;
}

async function writeMovedDicomFile({ sourceStudyUid, targetStudyUid, sopInstanceUid, replace, indexedPath = null }) {
  const sourceStudy = normalizeUid(sourceStudyUid);
  const targetStudy = normalizeUid(targetStudyUid);
  const sop = normalizeUid(sopInstanceUid);
  // Callers that moved a whole series hand in the already-resolved path so the
  // per-instance lookup (a database round trip each) only happens on a miss.
  const sourcePath = indexedPath && await fileExists(indexedPath)
    ? indexedPath
    : await traced('write.fileLookup', () => getInstanceFilePath({ studyUid: sourceStudy, sopInstanceUid: sop }));
  const targetStudyPath = resolveStudyPath(targetStudy);
  const targetPath = resolveInstancePath(targetStudy, sop);
  await fsp.mkdir(targetStudyPath, { recursive: true });
  const original = await fsp.readFile(sourcePath);
  const next = await traced('write.rewriteMetadata', async () => rewriteDicomMetadataBuffer(original, replace));
  const backupPath = await traced('write.backupSource', () => backupDicomFile(sourcePath, sourceStudy, sop));
  let replacedTargetBackupPath = null;
  if (sourcePath !== targetPath && await fileExists(targetPath)) {
    // A manual merge may encounter the same SOP already staged in the target
    // study. Overwrite it with the source rewritten to the target metadata so
    // the PACS index cannot split the object back into the source study.
    replacedTargetBackupPath = await traced('write.backupTargetConflict', () => backupDicomFile(targetPath, targetStudy, sop));
  }
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await traced('write.writeAndRename', async () => {
    await fsp.writeFile(tempPath, next);
    await fsp.rename(tempPath, targetPath);
  });
  if (sourcePath !== targetPath) {
    await fsp.unlink(sourcePath).catch(() => {});
  }
  return {
    sopInstanceUid: sop,
    sourcePath,
    targetPath,
    backupPath,
    replacedTargetBackupPath,
    conflictResolution: replacedTargetBackupPath ? 'overwritten_existing_target_sop' : 'moved',
  };
}

async function removeEmptyStudyFolder(studyUid) {
  const study = normalizeUid(studyUid);
  const studyPath = resolveStudyPath(study);
  const db = getPacsMetadataDb();
  let indexedInstanceCount = 0;
  try {
    const [rows] = await db.query(
      'SELECT COUNT(*) AS count FROM pacs_instances WHERE study_instance_uid = ?',
      [study]
    );
    indexedInstanceCount = Number(rows?.[0]?.count || 0);
  } catch (_) {
    indexedInstanceCount = 0;
  }

  if (!(await fileExists(studyPath))) {
    await purgePacsMetadata('study', study);
    await pool.query('DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?', [study]).catch(() => {});
    await tombstone('study', study, study, null);
    return true;
  }
  if (indexedInstanceCount <= 0) {
    await fsp.rm(studyPath, { recursive: true, force: true });
    await purgePacsMetadata('study', study);
    await pool.query('DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?', [study]).catch(() => {});
    await tombstone('study', study, study, null);
    return true;
  }
  const entries = await fsp.readdir(studyPath, { withFileTypes: true });
  const remainingDicomFiles = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.'));
  if (remainingDicomFiles.length) return false;
  await fsp.rm(studyPath, { recursive: true, force: true });
  await purgePacsMetadata('study', study);
  await pool.query('DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?', [study]).catch(() => {});
  await tombstone('study', study, study, null);
  return true;
}

async function removeMergedSourceStudy(studyUid) {
  const study = normalizeUid(studyUid);
  const studyPath = resolveStudyPath(study);
  await fsp.rm(studyPath, { recursive: true, force: true });
  await purgePacsMetadata('study', study);
  await pool.query('DELETE FROM dicomweb_pacs_metadata_overrides WHERE study_instance_uid = ?', [study]).catch(() => {});
  await tombstone('study', study, study, null);
  return true;
}

/**
 * Throttled cancellation watcher.
 *
 * Reading the operation row for every file would re-introduce one database round
 * trip per instance (the bottleneck this service just removed), so the flag is
 * refreshed at most every DICOMWEB_MANAGER_CANCEL_POLL_MS (500 ms) and cached in
 * between. Once set it stays set for the rest of the operation.
 */
function createCancelWatcher(operationId) {
  if (!operationId) return null;
  const ttlMs = Math.max(Number(process.env.DICOMWEB_MANAGER_CANCEL_POLL_MS || 500), 0);
  let lastCheckedAt = 0;
  let requested = false;
  return async () => {
    if (requested) return true;
    const now = Date.now();
    if (now - lastCheckedAt < ttlMs) return false;
    lastCheckedAt = now;
    requested = await isManagerOperationCancelRequested(operationId);
    return requested;
  };
}

/**
 * Move every instance of a source series into the target study folder.
 *
 * Bounded concurrency (DICOMWEB_MANAGER_MOVE_CONCURRENCY, default 4) because the
 * work is file I/O bound, and per-instance error isolation: a single unreadable
 * or already-vanished object must not abort a merge that is half-way through a
 * study. Anything that could not be moved is returned so the caller can report
 * it instead of silently dropping images.
 *
 * A series is the atomic unit: PACS indexes series by SeriesInstanceUID, so a
 * series split across two studies would leave the source half without a series
 * row (invisible to QIDO) and strand those files. Cancellation is therefore
 * honoured between series, never inside one.
 */
async function moveInstancesToStudy({ sourceStudy, sourceSeries, targetStudy, instances, replace, progress = null }) {
  const movedInstances = [];
  const skippedInstances = [];
  const items = instances
    .map(instance => getInstanceUid(instance))
    .filter(Boolean);
  const indexedPaths = await traced('moveSeries.resolvePaths', () => resolveInstancePathsForSeries(sourceStudy, sourceSeries, items));
  await mapWithConcurrency(items, Number(process.env.DICOMWEB_MANAGER_MOVE_CONCURRENCY || 4), async (sop) => {
    try {
      const moved = await traced('moveSeries.writeMovedDicomFile', () => writeMovedDicomFile({
        sourceStudyUid: sourceStudy,
        targetStudyUid: targetStudy,
        sopInstanceUid: sop,
        replace,
        indexedPath: indexedPaths.get(sop) || null,
      }));
      movedInstances.push(moved);
    } catch (error) {
      skippedInstances.push({
        sopInstanceUid: sop,
        reason: error?.message || String(error),
        status: error?.status || null,
      });
      await purgePacsMetadata('instance', sourceStudy, sourceSeries, sop).catch(() => {});
    }
    // Counted either way: the bar tracks "instances processed", and a skipped
    // instance is reported separately in the operation result.
    if (progress) progress.advance(1);
  });
  const bySop = (a, b) => String(a.sopInstanceUid).localeCompare(String(b.sopInstanceUid));
  movedInstances.sort(bySop);
  skippedInstances.sort(bySop);
  const handled = new Set([
    ...movedInstances.map(item => item.sopInstanceUid),
    ...skippedInstances.map(item => item.sopInstanceUid),
  ]);
  const pendingSopUids = items.filter(sop => !handled.has(sop));
  return { movedInstances, skippedInstances, cancelled: false, pendingSopUids };
}

async function moveSeriesToStudy(sourceStudyUid, sourceSeriesUid, targetStudyUid, options = {}) {
  const sourceStudy = normalizeUid(sourceStudyUid);
  const sourceSeries = normalizeUid(sourceSeriesUid);
  const targetStudy = normalizeUid(targetStudyUid);
  if (sourceStudy === targetStudy) {
    const error = new Error('Source and target study are the same');
    error.status = 400;
    throw error;
  }
  // A study merge moves every series in one operation: it refreshes the target
  // index (and drops the source metadata) once at the end instead of paying a
  // per-series index refresh - the dominant cost of the old implementation.
  const deferIndexRefresh = options.deferIndexRefresh === true;
  const targetStudyRecord = options.targetStudyRecord
    || await traced('moveSeries.getStudyRecord', () => getStudyRecord(targetStudy));
  const instances = await traced('moveSeries.getInstances', () => getInstances(sourceStudy, sourceSeries, { fresh: '1' }));
  if (!instances.data.length) {
    const error = new Error('Source series has no images');
    error.status = 404;
    throw error;
  }
  const replace = options.replace || buildStudyMoveReplace(targetStudy, targetStudyRecord);
  const { movedInstances, skippedInstances, pendingSopUids } = await moveInstancesToStudy({
    sourceStudy,
    sourceSeries,
    targetStudy,
    instances: instances.data,
    replace,
    progress: options.progress || null,
  });
  if (!movedInstances.length && skippedInstances.length) {
    const error = new Error(`None of the ${skippedInstances.length} source instance(s) could be moved`);
    error.status = 404;
    error.skippedInstances = skippedInstances;
    throw error;
  }
  if (!deferIndexRefresh) {
    await traced('moveSeries.purgePacsMetadata', () => purgePacsMetadata('series', sourceStudy, sourceSeries));
  }
  const sourceStudyRemoved = deferIndexRefresh
    ? false
    : await traced('moveSeries.removeEmptyStudyFolder', () => removeEmptyStudyFolder(sourceStudy));
  const targetRefresh = deferIndexRefresh
    ? { status: 'deferred', reason: 'study merge refreshes the target index once' }
    : await traced('moveSeries.refreshStudyIndex', () => refreshStudyIndex(targetStudy));
  invalidateQidoCacheForStudies(sourceStudy, targetStudy);
  previewCache.clear(); seriesThumbnailCache.clear();
  return {
    sourceStudyUid: sourceStudy,
    sourceSeriesUid: sourceSeries,
    targetStudyUid: targetStudy,
    movedInstances,
    skippedInstances,
    sourceStudyRemoved,
    targetRefresh,
  };
}

async function moveStudyToStudy(sourceStudyUid, targetStudyUid, options = {}) {
  const sourceStudy = normalizeUid(sourceStudyUid);
  const targetStudy = normalizeUid(targetStudyUid);
  if (sourceStudy === targetStudy) {
    const error = new Error('Source and target study are the same');
    error.status = 400;
    throw error;
  }
  const progress = createMoveProgressReporter(options.operationId, options.expectedInstances);
  const shouldCancel = createCancelWatcher(options.operationId);
  progress.stage('inspecting');
  const targetStudyRecord = await traced('moveStudy.getStudyRecord', () => getStudyRecord(targetStudy));
  const replace = buildStudyMoveReplace(targetStudy, targetStudyRecord);
  const seriesList = await traced('moveStudy.getSeries', () => getSeries(sourceStudy, { fresh: '1' }));
  if (!seriesList.data.length) {
    const error = new Error('Source study has no series');
    error.status = 404;
    throw error;
  }
  const movedSeries = [];
  const skippedInstances = [];
  const pendingSeries = [];
  let cancelled = false;
  progress.stage('moving');
  try {
    for (let index = 0; index < seriesList.data.length; index += 1) {
      const series = seriesList.data[index];
      const seriesUid = getSeriesUid(series);
      if (!seriesUid) continue;
      // Cancellation is honoured between series (never inside one): PACS indexes a
      // series by SeriesInstanceUID, so a half-moved series would disappear from the
      // source study's hierarchy and strand the images that stayed behind.
      if (shouldCancel && await shouldCancel()) {
        cancelled = true;
        for (const remaining of seriesList.data.slice(index)) {
          const remainingUid = getSeriesUid(remaining);
          if (remainingUid) pendingSeries.push(remainingUid);
        }
        break;
      }
      const result = await traced('moveStudy.moveSeriesToStudy', () => moveSeriesToStudy(sourceStudy, seriesUid, targetStudy, {
        deferIndexRefresh: true,
        targetStudyRecord,
        replace,
        progress,
      }));
      movedSeries.push(result);
      if (result.skippedInstances?.length) {
        skippedInstances.push(...result.skippedInstances);
      }
    }
  } catch (error) {
    // A merge that dies half-way must not leave the index lying about where the
    // files are: re-index both studies before the error reaches the caller.
    progress.finish('failed');
    await traced('moveStudy.reindexAfterFailure', () => requestPacsStudyReindex([sourceStudy, targetStudy]));
    throw error;
  }
  const movedInstanceCount = movedSeries.reduce((total, item) => total + (item.movedInstances?.length || 0), 0);
  if (cancelled) {
    // The source study stays: it still owns every series (or instance) that was not
    // moved. The scoped re-index prunes the rows of what did move and adds them to
    // the target, so both studies stay truthful without a full-archive walk.
    progress.finish('cancelled');
    const reindex = await traced('moveStudy.reindexAfterCancel', () => requestPacsStudyReindex([sourceStudy, targetStudy]));
    invalidateQidoCacheForStudies(sourceStudy, targetStudy);
    previewCache.clear(); seriesThumbnailCache.clear();
    return {
      sourceStudyUid: sourceStudy,
      targetStudyUid: targetStudy,
      movedSeries,
      skippedInstances,
      movedInstanceCount,
      sourceStudyRemoved: false,
      cancelled: true,
      pendingSeriesUids: pendingSeries,
      movedSeriesCount: movedSeries.length,
      reindex,
      targetRefresh: { status: 'refreshed', mode: 'index', reason: 'cancelled merge', reindex },
    };
  }
  progress.stage('cleaning-metadata');
  const sourceStudyRemoved = await traced('moveStudy.removeMergedSourceStudy', () => removeMergedSourceStudy(sourceStudy));
  progress.stage('reindexing');
  const targetRefresh = await traced('moveStudy.refreshStudyIndex', () => refreshStudyIndex(targetStudy));
  invalidateQidoCacheForStudies(sourceStudy, targetStudy);
  previewCache.clear(); seriesThumbnailCache.clear();
  progress.finish('done');
  return {
    sourceStudyUid: sourceStudy,
    targetStudyUid: targetStudy,
    movedSeries,
    skippedInstances,
    movedInstanceCount,
    sourceStudyRemoved,
    cancelled: false,
    targetRefresh,
  };
}

async function moveInstanceToSeries(sourceStudyUid, sourceSeriesUid, sopInstanceUid, targetStudyUid, targetSeriesUid) {
  const sourceStudy = normalizeUid(sourceStudyUid);
  const sourceSeries = normalizeUid(sourceSeriesUid);
  const sop = normalizeUid(sopInstanceUid);
  const targetStudy = normalizeUid(targetStudyUid);
  const targetSeries = normalizeUid(targetSeriesUid);
  if (sourceStudy === targetStudy && sourceSeries === targetSeries) {
    const error = new Error('Source and target series are the same');
    error.status = 400;
    throw error;
  }
  const targetStudyRecord = await getStudyRecord(targetStudy);
  const targetSeriesRecord = await getSeriesRecord(targetStudy, targetSeries);
  const replace = {
    ...buildStudyMoveReplace(targetStudy, targetStudyRecord),
    ...buildSeriesMoveReplace(targetSeries, targetSeriesRecord),
  };
  const movedInstance = await writeMovedDicomFile({
    sourceStudyUid: sourceStudy,
    targetStudyUid: targetStudy,
    sopInstanceUid: sop,
    replace,
  });
  await purgePacsMetadata('series', sourceStudy, sourceSeries);
  const sourceStudyRemoved = await removeEmptyStudyFolder(sourceStudy);
  const sourceRefresh = sourceStudyRemoved ? { status: 'skipped', reason: 'source study removed' } : await refreshStudyIndex(sourceStudy);
  const targetRefresh = sourceStudy === targetStudy ? sourceRefresh : await refreshStudyIndex(targetStudy);
  invalidateQidoCacheForStudies(sourceStudy, targetStudy);
  previewCache.clear(); seriesThumbnailCache.clear();
  return {
    sourceStudyUid: sourceStudy,
    sourceSeriesUid: sourceSeries,
    sopInstanceUid: sop,
    targetStudyUid: targetStudy,
    targetSeriesUid: targetSeries,
    movedInstance,
    sourceStudyRemoved,
    sourceRefresh,
    targetRefresh,
  };
}

async function archiveStudy(studyUid) {
  const study = normalizeUid(studyUid);
  const studyPath = resolveStudyPath(study);
  if (!(await fileExists(studyPath))) {
    const error = new Error('Study not found');
    error.status = 404;
    throw error;
  }
  const deleted = await getDeletedSets();
  const zip = new AdmZip();
  const entries = await fsp.readdir(studyPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === METADATA_OVERRIDE_FILENAME) continue;
    if (deleted.instance.has(entry.name)) continue;
    zip.addLocalFile(path.join(studyPath, entry.name), '', `${entry.name}.dcm`);
  }
  return zip.toBuffer();
}

async function hasStudy(studyUid) {
  const study = normalizeUid(studyUid);
  const deleted = await getDeletedSets();
  if (deleted.study.has(study)) return false;
  const result = await getStudies({ StudyInstanceUID: study, fresh: '1' });
  return result.data.some(record => getStudyUid(record) === study);
}

function loadDimseNative() {
  const modulePath = path.join(PACS_PACKAGE_ROOT, 'node_modules', 'dicom-dimse-native');
  return require(modulePath);
}

function parseStoreScuResult(result) {
  if (!result) {
    const error = new Error('Empty C-STORE response');
    error.status = 502;
    throw error;
  }
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  if (parsed.code !== 0 && parsed.status !== 'success') {
    const error = new Error(parsed.message || parsed.status || 'C-STORE failed');
    error.status = 502;
    throw error;
  }
  return parsed;
}

function parseFindScuRecords(result) {
  if (!result) {
    return [];
  }
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  if (parsed.code !== 0 && parsed.status !== 'success') {
    const error = new Error(parsed.message || parsed.status || 'C-FIND failed');
    error.status = 502;
    throw error;
  }
  if (!parsed.container) {
    return [];
  }
  const records = JSON.parse(parsed.container);
  return Array.isArray(records) ? records : [];
}

function parseEchoScuResult(result) {
  if (!result) {
    const error = new Error('Empty C-ECHO response');
    error.status = 502;
    throw error;
  }
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  if (parsed.code !== 0 && parsed.status !== 'success') {
    const error = new Error(parsed.message || parsed.status || 'C-ECHO failed');
    error.status = 502;
    throw error;
  }
  return parsed;
}

function buildDimseSource(prefix = 'DICOM_NODE_TEST') {
  return {
    aet: process.env[`${prefix}_AET`] || process.env.DICOM_FORWARD_AET || 'NEXIA_RIS',
    ip: process.env[`${prefix}_IP`] || process.env.DICOM_FORWARD_IP || '127.0.0.1',
    port: Number(process.env[`${prefix}_PORT`] || process.env.DICOM_FORWARD_PORT || 11113),
  };
}

function buildDimseTarget(node) {
  return {
    aet: node.aet,
    ip: node.host,
    port: Number(node.port),
  };
}

async function echoNode(node) {
  const { echoScu } = loadDimseNative();
  const source = buildDimseSource('DICOM_NODE_ECHO');
  const target = buildDimseTarget(node);
  const options = { source, target, verbose: false };
  const result = await new Promise((resolve, reject) => {
    echoScu(options, response => {
      try {
        resolve(parseEchoScuResult(response));
      } catch (error) {
        reject(error);
      }
    });
  });
  return { status: 'ok', source, target, result };
}

async function queryNode(node, query = {}) {
  const { findScu } = loadDimseNative();
  const source = buildDimseSource('DICOM_NODE_QUERY');
  const target = buildDimseTarget(node);
  const level = String(query.level || 'STUDY').toUpperCase();
  const tags = [
    { key: '00080052', value: level },
    { key: '00100010', value: String(query.patientName || '') },
    { key: '00100020', value: String(query.patientId || '') },
    { key: '00080050', value: String(query.accessionNumber || '') },
    { key: '0020000D', value: String(query.studyInstanceUid || '') },
    { key: '00080020', value: String(query.studyDate || '') },
    { key: '00081030', value: '' },
  ];
  const options = { source, target, verbose: false, tags };
  const records = await new Promise((resolve, reject) => {
    findScu(options, response => {
      try {
        resolve(parseFindScuRecords(response));
      } catch (error) {
        reject(error);
      }
    });
  });
  return { status: 'ok', source, target, records, count: records.length };
}

function shouldVerifyForward() {
  const value = String(process.env.DICOM_FORWARD_VERIFY || 'true').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function isOrthancNode(node) {
  const label = `${node?.name || ''} ${node?.aet || ''}`.toLowerCase();
  return label.includes('orthanc') || String(process.env.DICOM_FORWARD_VERIFY_ORTHANC || '').toLowerCase() === 'true';
}

function orthancRestUrl(node) {
  const configured = process.env.ORTHANC_REST_URL || process.env.DICOM_FORWARD_ORTHANC_REST_URL;
  if (configured) {
    return String(configured).replace(/\/+$/, '');
  }
  const port = process.env.ORTHANC_REST_PORT || process.env.DICOM_FORWARD_ORTHANC_REST_PORT || '8042';
  return `http://${node.host}:${port}`;
}

function orthancHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const username = process.env.ORTHANC_USERNAME || process.env.DICOM_FORWARD_ORTHANC_USERNAME;
  const password = process.env.ORTHANC_PASSWORD || process.env.DICOM_FORWARD_ORTHANC_PASSWORD;
  if (username || password) {
    headers.Authorization = `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`;
  }
  return headers;
}

async function findStudyOnOrthanc(studyUid, node) {
  const study = normalizeUid(studyUid);
  const response = await fetch(`${orthancRestUrl(node)}/tools/find`, {
    method: 'POST',
    headers: orthancHeaders(),
    body: JSON.stringify({
      Level: 'Study',
      Query: {
        StudyInstanceUID: study,
      },
    }),
  });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    const error = new Error(message || `Orthanc verification failed (${response.status})`);
    error.status = 502;
    throw error;
  }
  const matches = await response.json();
  return Array.isArray(matches) ? matches : [];
}

function shouldVerifyForwardWithCFind() {
  const value = String(process.env.DICOM_FORWARD_VERIFY_C_FIND || 'false').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

async function verifyStudyWithCFind(studyUid, node) {
  const study = normalizeUid(studyUid);
  const { findScu } = loadDimseNative();
  const source = {
    aet: process.env.DICOM_FORWARD_AET || 'NEXIA_RIS',
    ip: process.env.DICOM_FORWARD_IP || '127.0.0.1',
    port: Number(process.env.DICOM_FORWARD_FIND_PORT || process.env.DICOM_FORWARD_PORT || 11113),
  };
  const target = {
    aet: node.aet,
    ip: node.host,
    port: Number(node.port),
  };
  const options = {
    source,
    target,
    verbose: false,
    tags: [
      { key: '00080052', value: 'STUDY' },
      { key: '0020000D', value: study },
      { key: '00100010', value: '' },
      { key: '00100020', value: '' },
      { key: '00080020', value: '' },
    ],
  };
  const records = await new Promise((resolve, reject) => {
    findScu(options, response => {
      try {
        resolve(parseFindScuRecords(response));
      } catch (error) {
        reject(error);
      }
    });
  });
  const found = records.some(record => {
    const value = record?.['0020000D']?.Value?.[0];
    return value === study;
  });
  if (!found) {
    const error = new Error(`Destination accepted the send request, but StudyInstanceUID ${study} was not found by C-FIND verification`);
    error.status = 502;
    throw error;
  }
  return {
    status: 'verified',
    method: 'c-find',
    records: records.length,
  };
}

async function verifyStudyOnNode(studyUid, node, context = {}) {
  if (!shouldVerifyForward()) {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (isOrthancNode(node)) {
    const matches = await findStudyOnOrthanc(studyUid, node);
    if (!matches.length) {
      const error = new Error(`Destination accepted the send request, but StudyInstanceUID ${studyUid} was not found in Orthanc REST verification`);
      error.status = 502;
      throw error;
    }
    return {
      status: 'verified',
      method: 'orthanc-rest',
      matches: matches.length,
      existedBefore: Boolean(context.existedBefore),
    };
  }
  if (shouldVerifyForwardWithCFind()) {
    return verifyStudyWithCFind(studyUid, node);
  }
  return { status: 'skipped', reason: 'non-orthanc destination' };
}

function shouldRefreshStudyIndex() {
  const value = String(process.env.DICOMWEB_PACS_REINDEX_AFTER_METADATA || 'true').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

/**
 * Wait until the PACS index actually knows the files we just stored.
 *
 * The previous helper compared "number of files in the folder" with "number of
 * indexed rows for the study". One file the PACS will never index (a non-DICOM
 * leftover, an exported JSON sidecar, a decompression artefact) made every call
 * burn the full 15 s budget and still report "not ready". Checking the exact
 * paths we stored is precise and returns as soon as the index caught up.
 */
async function waitForStoredFilesIndexed(studyUid, filePaths, timeoutMs, options = {}) {
  const db = getPacsMetadataDb();
  // The SQL lookup must use the paths as they are stored on disk (Windows
  // backslashes, drive case); the canonical key is only for comparing results.
  const rawPaths = Array.from(new Set((filePaths || []).filter(Boolean).map(candidate => path.resolve(candidate))));
  const expectedKeys = rawPaths.map(candidate => pathKey(candidate));
  const startedAt = Date.now();
  if (!rawPaths.length) {
    return { ready: true, expected: 0, indexed: 0, missing: [], waitedMs: 0, timedOut: false };
  }
  const budget = Math.max(Number(timeoutMs ?? process.env.DICOMWEB_PACS_REINDEX_WAIT_MS ?? 15000), 0);
  const progress = options.progress || null;
  const shouldCancel = options.shouldCancel || null;
  for (;;) {
    const indexedKeys = new Set();
    for (let index = 0; index < rawPaths.length; index += 500) {
      const slice = rawPaths.slice(index, index + 500);
      const [rows] = await db.query(
        'SELECT file_path FROM pacs_instances WHERE study_instance_uid = ? AND file_path IN (?)',
        [studyUid, slice]
      ).catch(() => [[]]);
      for (const row of rows) {
        indexedKeys.add(pathKey(row.file_path));
      }
    }
    const missing = rawPaths.filter((candidate, index) => !indexedKeys.has(expectedKeys[index]));
    const indexedCount = rawPaths.length - missing.length;
    if (progress) progress.report('verifying', indexedCount);
    if (!missing.length) {
      return {
        ready: true,
        expected: rawPaths.length,
        indexed: rawPaths.length,
        missing: [],
        waitedMs: Date.now() - startedAt,
        timedOut: false,
      };
    }
    if (shouldCancel && await shouldCancel()) {
      return {
        ready: false,
        cancelled: true,
        expected: rawPaths.length,
        indexed: indexedCount,
        missing,
        waitedMs: Date.now() - startedAt,
        timedOut: false,
      };
    }
    if (Date.now() - startedAt >= budget) {
      return {
        ready: false,
        expected: rawPaths.length,
        indexed: indexedCount,
        missing,
        waitedMs: Date.now() - startedAt,
        timedOut: true,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function forcePacsMetadataSync() {
  const pacsRoot = PACS_RS_ROOT.replace(/\/rs\/?$/i, '');
  try {
    const response = await fetch(`${pacsRoot}/internal/metadata/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      return { status: 'error', httpStatus: response.status };
    }
    return parseJsonValue(await response.text(), { status: 'synchronized' });
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

/**
 * Ask dicomweb-pacs to re-index specific study folders.
 *
 * The endpoint falls back to a full-archive walk when the body is ignored (older
 * PACS builds), which keeps this call correct everywhere while staying cheap on
 * builds that understand `studies`.
 */
async function requestPacsStudyReindex(studyUids) {
  const studies = Array.from(new Set((studyUids || []).map(uid => String(uid || '').trim()).filter(uid => /^[0-9.]+$/.test(uid))));
  if (!studies.length) {
    return { status: 'skipped', reason: 'no study uid' };
  }
  const pacsRoot = PACS_RS_ROOT.replace(/\/rs\/?$/i, '');
  try {
    const response = await fetch(`${pacsRoot}/internal/metadata/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studies }),
    });
    const body = await response.text();
    if (!response.ok) {
      return { status: 'error', httpStatus: response.status, message: String(body || '').slice(0, 500) };
    }
    return { status: 'synchronized', studies, ...parseJsonValue(body, {}) };
  } catch (error) {
    return { status: 'error', message: error.message, studies };
  }
}
// Full rebuild of PACS metadata from the on-disk DICOM storage: every file under
// DICOMWEB_PACS_STORAGE_PATH is re-read and upserted into pacs_instances/series/
// studies, and index rows whose file disappeared are pruned. Exposed so an
// operator can index DICOM that was copied into storage by hand.
async function syncPacsMetadataFromStorage(force = true) {
  return forcePacsMetadataSync(force);
}

/**
 * refreshStudyIndex / refreshStudyIndexByStoreScu.
 *
 * The index refresh used to always re-send the whole study folder over C-STORE,
 * which was the single biggest cost of a DICOM Manager operation (copy + store
 * every file of the *target* study once per source series) and is also unsafe on
 * PACS builds that compress on write: the store SCP replaces the object it is
 * writing over and deletes it when the replacement fails, so re-ingesting a file
 * that already sits at its final path can destroy it. The default mode now just
 * re-indexes the folder; `DICOMWEB_PACS_REINDEX_MODE=store` restores the old
 * behaviour for sites that rely on the PACS rewriting stored transfer syntaxes.
 */
function reindexMode() {
  const value = String(process.env.DICOMWEB_PACS_REINDEX_MODE || 'index').toLowerCase();
  return value === 'store' ? 'store' : 'index';
}

async function refreshStudyIndexByStoreScu(study, studyPath, options = {}) {
  const { storeScu } = loadDimseNative();
  const source = {
    aet: process.env.DICOMWEB_PACS_REINDEX_SOURCE_AET || 'NEXIA_RIS',
    ip: process.env.DICOMWEB_PACS_REINDEX_SOURCE_IP || '127.0.0.1',
    port: Number(process.env.DICOMWEB_PACS_REINDEX_SOURCE_PORT || 11115),
  };
  const target = {
    aet: process.env.DICOMWEB_INTERNAL_AET || process.env.DICOMWEB_PACS_INTERNAL_AET || 'VEXA_INT',
    ip: process.env.DICOMWEB_INTERNAL_HOST || process.env.DICOMWEB_PACS_INTERNAL_DICOM_HOST || '127.0.0.1',
    port: Number(process.env.DICOMWEB_INTERNAL_PORT || process.env.DICOMWEB_PACS_INTERNAL_DICOM_PORT || 8890),
  };
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexia-pacs-reindex-'));
  const staged = [];
  try {
    await traced('refresh.copyFilesToTemp', async () => {
      const entries = await fsp.readdir(studyPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        const tempPath = path.join(tempDir, entry.name);
        await fsp.copyFile(path.join(studyPath, entry.name), tempPath);
        staged.push({ name: entry.name, tempPath, targetPath: path.join(studyPath, entry.name) });
      }
    });
    const result = await traced('refresh.storeScu', () => new Promise((resolve, reject) => {
      storeScu({ source, target, sourcePath: tempDir, verbose: false }, response => {
        try {
          resolve(parseStoreScuResult(response));
        } catch (error) {
          reject(error);
        }
      });
    }));
    // A re-store can silently delete the object it was writing over (the store
    // SCP writes a temp file, deletes the destination and renames - a failed
    // rename leaves nothing behind). Put the staged bytes back so a
    // "successful" store can never end with the study missing a file.
    const recoveredFiles = new Set();
    const restoreMissingStagedFiles = async (label) => traced(label, async () => {
      const missing = [];
      for (const item of staged) {
        if (await fileExists(item.targetPath)) continue;
        await fsp.copyFile(item.tempPath, item.targetPath);
        missing.push(item.name);
        recoveredFiles.add(item.name);
      }
      return missing;
    });
    await restoreMissingStagedFiles('refresh.verifyStoredFiles');
    const storedPaths = staged.map(item => item.targetPath);
    const waitMs = options.waitTimeoutMs
      ?? Number(process.env.DICOMWEB_PACS_STORE_REINDEX_WAIT_MS || 2000);
    // Scoped re-index first, not the full walk: it is precise, independent of
    // archive size, and - unlike forcePacsMetadataSync - it always actually runs
    // (the walk returns the in-flight promise when another walk is running).
    const scopedFirst = await traced('refresh.scopedReindex', () => requestPacsStudyReindex([study]));
    let metadataSync = scopedFirst.status === 'synchronized'
      ? { status: 'skipped', reason: 'scoped re-index used' }
      : { status: 'pending', reason: 'scoped re-index unavailable' };
    let indexSync = options.skipWait
      ? { status: 'skipped', reason: 'caller verifies' }
      : await traced('refresh.waitIndex', () => waitForStoredFilesIndexed(study, storedPaths, waitMs));
    if (!options.skipWait && indexSync.ready === false) {
      // Files can disappear after the association ACK (the store SCP deletes the
      // destination before renaming), so verify again, retry the scoped re-index
      // and only fall back to the full-archive walk when that is unavailable.
      await restoreMissingStagedFiles('refresh.verifyStoredFilesAfterSync');
      const scopedRetry = await traced('refresh.scopedReindexFallback', () => requestPacsStudyReindex([study]));
      if (scopedRetry.status !== 'synchronized' && !options.skipFullSync) {
        metadataSync = await traced('refresh.metadataSync', () => forcePacsMetadataSync());
      }
      indexSync = {
        ...(await traced('refresh.waitIndexAfterScoped', () => waitForStoredFilesIndexed(study, storedPaths, waitMs))),
        scopedFallback: scopedRetry.status === 'synchronized',
      };
    }
    invalidateQidoCacheForStudies(study);
    previewCache.clear(); seriesThumbnailCache.clear();
    const recovered = Array.from(recoveredFiles);
    // Missing files after both passes mean the store really lost objects: report
    // it instead of claiming a clean refresh.
    const status = indexSync.ready === false
      ? 'refreshed-with-unindexed-files'
      : recovered.length
        ? 'refreshed-with-recovered-files'
        : 'refreshed';
    return { status, mode: 'store', target, result, metadataSync, indexSync, recoveredFiles: recovered };
  } catch (error) {
    return { status: 'error', mode: 'store', message: error.message };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Every stored file of a study folder (one level of series sub-folders included),
 * used to verify a re-index against what is really on disk.
 */
async function listStudyStoredFiles(studyPath) {
  const files = [];
  const entries = await fsp.readdir(studyPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) {
      files.push(path.join(studyPath, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const nested = await fsp.readdir(path.join(studyPath, entry.name), { withFileTypes: true }).catch(() => []);
    for (const child of nested) {
      if (child.name.startsWith('.')) continue;
      if (child.isFile()) files.push(path.join(studyPath, entry.name, child.name));
    }
  }
  return files;
}

async function refreshStudyIndex(studyUid, options = {}) {
  const progress = options.progress || null;
  const shouldCancel = options.shouldCancel || null;
  if (!shouldRefreshStudyIndex()) {
    return { status: 'disabled' };
  }
  const study = normalizeUid(studyUid);
  const studyPath = resolveStudyPath(study);
  if (!(await fileExists(studyPath))) {
    return { status: 'skipped', reason: 'study folder not found' };
  }
  if (options.mode === 'store' || reindexMode() === 'store') {
    if (progress) progress.stage('store');
    return refreshStudyIndexByStoreScu(study, studyPath, options);
  }
  // Files to verify against the index. A DICOM Manager operation passes the paths it
  // just wrote (or nothing at all, keeping the previous counter-based readiness); an
  // operator-driven re-index asks for the whole folder so stray or unreadable files
  // are reported instead of being called a clean refresh.
  let verifyPaths = Array.isArray(options.verifyPaths) && options.verifyPaths.length ? options.verifyPaths : null;
  if (!verifyPaths && options.verifyAllFiles) {
    if (progress) progress.stage('inspecting');
    verifyPaths = await traced('refresh.listStoredFiles', () => listStudyStoredFiles(studyPath));
    if (progress) progress.setTotal(verifyPaths.length);
    if (shouldCancel && await shouldCancel()) {
      return { status: 'cancelled', mode: 'index', reason: 'cancelled before re-index', files: verifyPaths.length };
    }
  }
  if (progress) progress.stage('indexing');
  const sync = await traced('refresh.studyReindex', () => requestPacsStudyReindex([study]));
  invalidateQidoCacheForStudies(study);
  previewCache.clear(); seriesThumbnailCache.clear();
  if (sync.status !== 'synchronized') {
    // Without a usable scoped reindex the index would go stale, so fall back to
    // the C-STORE path (which also re-verifies that stored files survived).
    if (progress) progress.stage('store-fallback');
    const fallback = await refreshStudyIndexByStoreScu(study, studyPath, { ...options, skipFullSync: false, skipWait: false });
    return { status: fallback.status, mode: 'store-fallback', reindex: sync, storeScu: fallback };
  }
  const indexed = Number(sync.indexed || 0);
  const unchanged = Number(sync.unchanged || 0);
  const unindexable = Number(sync.unindexable || 0);
  const files = Number(sync.files || 0);
  const waitMs = options.waitTimeoutMs ?? Number(process.env.DICOMWEB_PACS_REINDEX_WAIT_MS || 15000);
  const verification = verifyPaths && options.skipWait !== true
    ? await traced('refresh.verifyIndexed', () => waitForStoredFilesIndexed(study, verifyPaths, waitMs, { progress, shouldCancel }))
    : null;
  if (verification?.cancelled) {
    return {
      status: 'cancelled',
      mode: 'index',
      reindex: sync,
      files: verifyPaths.length,
      indexSync: { ready: false, cancelled: true, indexed: verification.indexed, verified: verification.expected, waitedMs: verification.waitedMs },
    };
  }
  const ready = verification ? verification.ready : files === indexed + unchanged + unindexable;
  return {
    status: ready ? 'refreshed' : 'refreshed-with-unindexed-files',
    mode: 'index',
    reindex: sync,
    indexSync: {
      ready,
      files: verifyPaths?.length ?? files,
      indexed,
      unchanged,
      unindexable,
      unindexedFiles: verification && !verification.ready ? verification.missing.length : 0,
      verified: verification?.expected ?? null,
      waitedMs: verification?.waitedMs ?? 0,
      removedRows: Number(sync.removed || 0),
      durationMs: Number(sync.durationMs || 0),
    },
  };
}
async function forwardStudyToNode(studyUid, node) {
  const study = normalizeUid(studyUid);
  const studyPath = resolveStudyPath(study);
  if (!(await fileExists(studyPath))) {
    const error = new Error('Study not found in dicomweb-pacs');
    error.status = 404;
    throw error;
  }
  let existedBefore = false;
  if (shouldVerifyForward() && isOrthancNode(node)) {
    try {
      existedBefore = (await findStudyOnOrthanc(study, node)).length > 0;
    } catch (_) {
      existedBefore = false;
    }
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexia-dicom-forward-'));
  const { storeScu } = loadDimseNative();
  const source = {
    aet: process.env.DICOM_FORWARD_AET || 'NEXIA_RIS',
    ip: process.env.DICOM_FORWARD_IP || '127.0.0.1',
    port: Number(process.env.DICOM_FORWARD_PORT || 11113),
  };
  const target = {
    aet: node.aet,
    ip: node.host,
    port: Number(node.port),
  };
  const options = {
    source,
    target,
    sourcePath: tempDir,
    verbose: false,
  };
  try {
    const entries = await fsp.readdir(studyPath, { withFileTypes: true });
    let copied = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      const sourceFilePath = path.join(studyPath, entry.name);
      let ids;
      try {
        ids = readDicomFileIds(await fsp.readFile(sourceFilePath));
      } catch (_) {
        ids = { studyUid: '', seriesUid: '', sopInstanceUid: '' };
      }
      if (!ids.studyUid || !ids.sopInstanceUid) {
        skipped += 1;
        continue;
      }
      await fsp.copyFile(sourceFilePath, path.join(tempDir, entry.name));
      copied += 1;
    }
    if (!copied) {
      const error = new Error(
        skipped
          ? 'No valid DICOM instances found for this study; all candidate files were unreadable as DICOM'
          : 'No DICOM instances found for this study'
      );
      error.status = 404;
      throw error;
    }
    const result = await new Promise((resolve, reject) => {
      storeScu(options, response => {
        try {
          resolve(parseStoreScuResult(response));
        } catch (error) {
          reject(error);
        }
      });
    });
    const verification = await verifyStudyOnNode(study, node, { existedBefore });
    return {
      ...result,
      source,
      target,
      instances: copied,
      skipped,
      verification,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// DICOM Manager phase tracing.
//
// A manager operation touches dozens of files plus the PACS DIMSE and metadata
// services, and "the merge is slow" is impossible to diagnose from the outside.
// traced() records count/total/max per label (a few nanoseconds when unused) and
// getManagerTraceStats() hands the breakdown to scripts/bench-manager-merge.js.
// Set VEXA_PACS_TRACE=1 to also log each phase to stdout.
const traceStats = new Map();

function traceEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.VEXA_PACS_TRACE || '').toLowerCase());
}

function recordTrace(label, ms) {
  const entry = traceStats.get(label) || { count: 0, totalMs: 0, maxMs: 0 };
  entry.count += 1;
  entry.totalMs += ms;
  if (ms > entry.maxMs) entry.maxMs = ms;
  traceStats.set(label, entry);
  if (traceEnabled()) {
    console.log(`[pacs-trace] ${label} ${ms}ms`);
  }
}

async function traced(label, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordTrace(label, Date.now() - startedAt);
  }
}

function getManagerTraceStats() {
  return Array.from(traceStats.entries())
    .map(([label, entry]) => ({
      label,
      count: entry.count,
      totalMs: entry.totalMs,
      avgMs: Math.round(entry.totalMs / entry.count),
      maxMs: entry.maxMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function resetManagerTraceStats() {
  traceStats.clear();
}

module.exports = {
  ensureStateTables,
  ensureManagerOperationTables,
  getPacsMetadataDb,
  syncPacsMetadataFromStorage,
  getManagerTraceStats,
  resetManagerTraceStats,
  createStudyPlaceholder,
  createSeriesPlaceholder,
  createImageFromUpload,
  createScheduledStudyPlaceholder,
  getStudyInstanceCount,
  deleteScheduledStudyPlaceholder,
  getStudies,
  getSeries,
  getInstances,
  getFrame,
  renderInstancePreview,
  renderSeriesThumbnail,
  deleteStudy,
  deleteSeries,
  deleteInstance,
  purgePacsMetadata,
  updateStudyMetadata,
  updateSeriesMetadata,
  updateInstanceMetadata,
  moveStudyToStudy,
  moveSeriesToStudy,
  moveInstanceToSeries,
  beginManagerOperation,
  completeManagerOperation,
  failManagerOperation,
  cancelManagerOperation,
  requestManagerOperationCancel,
  listManagerOperations,
  getManagerOperation,
  preflightManagerOperationRestore,
  restoreManagerOperation,
  refreshStudyIndex,
  requestPacsStudyReindex,
  sha256File,
  beginReindexOperation,
  runReindexOperation,
  archiveStudy,
  hasStudy,
  echoNode,
  queryNode,
  forwardStudyToNode,
  invalidateStudies: (...studyUids) => invalidateQidoCacheForStudies(...studyUids),
  getRuntimeStats: () => ({
    qidoCache: qidoCache.stats(),
    previewCache: previewCache.stats(),
  }),
  clearQidoCache: () => {
    qidoCache.clear();
    previewCache.clear(); seriesThumbnailCache.clear();
  },
};
