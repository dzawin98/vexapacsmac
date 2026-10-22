import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { BinaryResponse } from '../types';
import { ConfParams, config } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';
import { compressFile } from './compressFile';
import { resolveInstancePath } from './storageIndex';

interface WadoUriArgs {
  studyInstanceUid: string;
  seriesInstanceUid?: string;
  sopInstanceUid: string;
}

export async function doWadoUri({ studyInstanceUid, sopInstanceUid }: WadoUriArgs): Promise<BinaryResponse> {
  const logger = LoggerSingleton.Instance;
  const storagePath = config.get<string>(ConfParams.STORAGE_PATH);
  const studyPath = path.join(storagePath, studyInstanceUid);
  const pathname = await resolveInstancePath(studyInstanceUid, sopInstanceUid);

  if (!pathname) {
    const message = `DICOM instance ${sopInstanceUid} for study ${studyInstanceUid} not found in storage`;
    logger.error(message);
    throw new Error(message);
  }

  await compressFile(pathname, studyPath);
  const stat = await fs.stat(pathname);

  return {
    contentType: config.get<string>(ConfParams.MIMETYPE),
    buffer: await fs.readFile(pathname),
    etag: `"vexa-${createHash('sha1').update(['wadouri', pathname, stat.size, stat.mtimeMs].join('|')).digest('base64url')}"`,
    cacheControl: process.env.DICOMWEB_PIXEL_CACHE_CONTROL || 'private, max-age=86400, immutable',
  };
}
