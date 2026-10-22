import fs from 'fs/promises';
import path from 'path';
import dicomParser from 'dicom-parser';
import { DicomJsonRecord } from '../types';
import { ConfParams, config } from '../utils/config';
import { fileExists } from '../utils/fileHelper';
import { LoggerSingleton } from '../utils/logger';

interface StoredInstance {
  path: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
}

interface StorageIndex {
  studies: Set<string>;
  series: Set<string>;
  instances: Map<string, StoredInstance>;
  instancesBySop: Map<string, StoredInstance>;
}

const indexTtlMs = 5000;
let cachedIndex: { expiresAt: number; value: StorageIndex } | null = null;

export function invalidateStorageIndex(): void {
  cachedIndex = null;
}

function firstStringValue(record: DicomJsonRecord, tag: string): string | undefined {
  const value = record[tag]?.Value?.[0];
  return typeof value === 'string' ? value : undefined;
}

function indexKey(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('|');
}

async function collectDicomFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files = await Promise.all(
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
      return [entryPath];
    }),
  );
  return files.flat();
}

async function buildStorageIndex(): Promise<StorageIndex> {
  const logger = LoggerSingleton.Instance;
  const storagePath = config.get<string>(ConfParams.STORAGE_PATH);
  const index: StorageIndex = {
    studies: new Set(),
    series: new Set(),
    instances: new Map(),
    instancesBySop: new Map(),
  };

  const files = await collectDicomFiles(storagePath);
  for (const filePath of files) {
    try {
      const data = await fs.readFile(filePath);
      const dataset = dicomParser.parseDicom(data);
      const studyInstanceUid = dataset.string('x0020000d');
      const seriesInstanceUid = dataset.string('x0020000e');
      const sopInstanceUid = dataset.string('x00080018');
      if (!studyInstanceUid || !seriesInstanceUid || !sopInstanceUid) {
        continue;
      }

      const instance = { path: filePath, studyInstanceUid, seriesInstanceUid, sopInstanceUid };
      index.studies.add(studyInstanceUid);
      index.series.add(indexKey(studyInstanceUid, seriesInstanceUid));
      index.instances.set(indexKey(studyInstanceUid, sopInstanceUid), instance);
      index.instancesBySop.set(sopInstanceUid, instance);
    } catch (error) {
      logger.warn(`failed to index DICOM file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return index;
}

export async function getStorageIndex(): Promise<StorageIndex> {
  const now = Date.now();
  if (cachedIndex && cachedIndex.expiresAt > now) {
    return cachedIndex.value;
  }

  const value = await buildStorageIndex();
  cachedIndex = { value, expiresAt: now + indexTtlMs };
  return value;
}

export async function resolveInstancePath(
  studyInstanceUid: string,
  sopInstanceUid: string,
): Promise<string | null> {
  const storagePath = config.get<string>(ConfParams.STORAGE_PATH);
  const directPath = path.join(storagePath, studyInstanceUid, sopInstanceUid);
  if (await fileExists(directPath)) {
    return directPath;
  }

  const index = await getStorageIndex();
  return (
    index.instances.get(indexKey(studyInstanceUid, sopInstanceUid))?.path ??
    index.instancesBySop.get(sopInstanceUid)?.path ??
    null
  );
}

export async function filterRecordsWithStoredFiles(
  records: DicomJsonRecord[],
  level: 'STUDY' | 'SERIES' | 'IMAGE',
): Promise<DicomJsonRecord[]> {
  const index = await getStorageIndex();

  return records.filter((record) => {
    const studyInstanceUid = firstStringValue(record, '0020000D');
    if (!studyInstanceUid) {
      return false;
    }

    if (level === 'STUDY') {
      return index.studies.has(studyInstanceUid);
    }

    const seriesInstanceUid = firstStringValue(record, '0020000E');
    if (!seriesInstanceUid) {
      return false;
    }

    if (level === 'SERIES') {
      return index.series.has(indexKey(studyInstanceUid, seriesInstanceUid));
    }

    const sopInstanceUid = firstStringValue(record, '00080018');
    if (!sopInstanceUid) {
      return false;
    }

    return (
      index.instances.has(indexKey(studyInstanceUid, sopInstanceUid)) ||
      index.instancesBySop.has(sopInstanceUid)
    );
  });
}
