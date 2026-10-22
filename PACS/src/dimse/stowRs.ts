import fs from 'fs/promises';
import path from 'path';
import dicomParser from 'dicom-parser';
import { ConfParams, config } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';
import { noteStoredInstances } from './frameWarm';
import { indexStoredDicomFile } from './metadataDb';
import { invalidateStorageIndex } from './storageIndex';

export interface StowResult {
  stored: number;
  instances: Array<{
    studyInstanceUid: string;
    seriesInstanceUid: string;
    sopInstanceUid: string;
  }>;
}

interface ParsedPart {
  headers: Record<string, string>;
  body: Buffer;
}

export async function doStowRs(body: Buffer, contentType = '', requestedStudyInstanceUid?: string): Promise<StowResult> {
  const logger = LoggerSingleton.Instance;
  const instances = extractDicomPayloads(body, contentType);
  if (!instances.length) {
    throw new Error('No application/dicom instance found in STOW-RS request.');
  }

  const storagePath = path.resolve(config.get<string>(ConfParams.STORAGE_PATH));
  const stored: StowResult['instances'] = [];

  for (const instance of instances) {
    const dataset = dicomParser.parseDicom(instance);
    const studyInstanceUid = readUid(dataset, 'x0020000d');
    const seriesInstanceUid = readUid(dataset, 'x0020000e');
    const sopInstanceUid = readUid(dataset, 'x00080018');
    if (!studyInstanceUid || !seriesInstanceUid || !sopInstanceUid) {
      throw new Error('DICOM instance is missing StudyInstanceUID, SeriesInstanceUID, or SOPInstanceUID.');
    }
    if (requestedStudyInstanceUid && requestedStudyInstanceUid !== studyInstanceUid) {
      throw new Error(`DICOM StudyInstanceUID ${studyInstanceUid} does not match STOW-RS URL study ${requestedStudyInstanceUid}.`);
    }

    const studyDirectory = path.join(storagePath, studyInstanceUid);
    await fs.mkdir(studyDirectory, { recursive: true });
    const filePath = path.join(studyDirectory, sopInstanceUid);
    await fs.writeFile(filePath, instance);
    await indexStoredDicomFile(filePath);
    stored.push({ studyInstanceUid, seriesInstanceUid, sopInstanceUid });
  }

  invalidateStorageIndex();
  logger.info(`STOW-RS stored ${stored.length} DICOM instance(s)`);
  noteStoredInstances(stored);

  return { stored: stored.length, instances: stored };
}

function extractDicomPayloads(body: Buffer, contentType: string): Buffer[] {
  const normalizedContentType = contentType.toLowerCase();
  if (!normalizedContentType.includes('multipart/related') && normalizedContentType.includes('application/dicom')) {
    return [stripPreamble(body)];
  }

  const boundary = boundaryFromContentType(contentType);
  if (!boundary) {
    return [];
  }

  return splitMultipart(body, boundary)
    .filter((part) => (part.headers['content-type'] ?? '').toLowerCase().includes('application/dicom'))
    .map((part) => stripPreamble(part.body))
    .filter((part) => part.length > 0);
}

function boundaryFromContentType(contentType: string): string {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match?.[1] ?? match?.[2] ?? '';
}

function splitMultipart(body: Buffer, boundary: string): ParsedPart[] {
  const marker = Buffer.from(`--${boundary}`, 'latin1');
  const parts: ParsedPart[] = [];
  let cursor = indexOfBuffer(body, marker, 0);

  while (cursor >= 0) {
    const next = indexOfBuffer(body, marker, cursor + marker.length);
    if (next < 0) {
      break;
    }

    let part = body.subarray(cursor + marker.length, next);
    part = trimBoundaryPart(part);
    if (part.length) {
      const headerEnd = indexOfBuffer(part, Buffer.from('\r\n\r\n', 'latin1'), 0);
      if (headerEnd >= 0) {
        const rawHeaders = part.subarray(0, headerEnd).toString('latin1');
        const payload = part.subarray(headerEnd + 4);
        parts.push({ headers: parsePartHeaders(rawHeaders), body: payload });
      }
    }

    cursor = next;
  }

  return parts;
}

function trimBoundaryPart(part: Buffer): Buffer {
  let start = 0;
  let end = part.length;

  if (part.subarray(0, 2).toString('latin1') === '--') {
    return Buffer.alloc(0);
  }
  if (part.subarray(0, 2).toString('latin1') === '\r\n') {
    start = 2;
  }
  if (part.subarray(end - 2, end).toString('latin1') === '\r\n') {
    end -= 2;
  }

  return part.subarray(start, end);
}

function parsePartHeaders(rawHeaders: string): Record<string, string> {
  return Object.fromEntries(
    rawHeaders
      .split(/\r\n/)
      .map((line) => {
        const separator = line.indexOf(':');
        if (separator < 0) {
          return null;
        }
        return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
      })
      .filter((entry): entry is [string, string] => Boolean(entry)),
  );
}

function indexOfBuffer(source: Buffer, search: Buffer, fromIndex: number): number {
  return source.indexOf(search, fromIndex);
}

function stripPreamble(body: Buffer): Buffer {
  if (body.length >= 132 && body.subarray(128, 132).toString('latin1') === 'DICM') {
    return body;
  }

  return body;
}

function readUid(dataset: dicomParser.DataSet, key: string): string {
  return String(dataset.string(key) ?? '').trim();
}
