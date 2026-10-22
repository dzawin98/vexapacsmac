import { createHash, randomBytes } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import dicomParser from 'dicom-parser';
import sharp from 'sharp';
import { BinaryResponse } from '../types';
import { ConfParams, config } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';
import { compressFile } from './compressFile';
import { decodeJ2kViaPool, getJ2kWorkerPoolStats, warmJ2kWorkerPool } from './j2kWorkerPool';
import {
  getFrameDiskCacheEntry,
  getFrameDiskCacheStats,
  noteFrameCacheAccess,
  noteFrameCachePromotion,
  putFrameDiskCacheEntry,
} from './frameDiskCache';
import { queryPacsMetadata } from './metadataDb';
import { QUERY_LEVEL } from './querLevel';
import { resolveInstancePath } from './storageIndex';

interface WadoRsArgs {
  studyInstanceUid: string;
  seriesInstanceUid?: string;
  sopInstanceUid: string;
  frame?: string;
  compressedMode?: string;
}

interface InstanceReference {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
}

const jpegTransferSyntaxes = new Set([
  '1.2.840.10008.1.2.4.50',
  '1.2.840.10008.1.2.4.51',
  '1.2.840.10008.1.2.4.57',
  '1.2.840.10008.1.2.4.70',
]);

const browserDisplayableJpegTransferSyntaxes = new Set([
  '1.2.840.10008.1.2.4.50',
  '1.2.840.10008.1.2.4.51',
]);

const htj2kTransferSyntaxes = new Set([
  '1.2.840.10008.1.2.4.201',
  '1.2.840.10008.1.2.4.202',
  '1.2.840.10008.1.2.4.203',
]);

const jpeg2000TransferSyntaxes = new Set([
  '1.2.840.10008.1.2.4.90',
  '1.2.840.10008.1.2.4.91',
  '1.2.840.10008.1.2.4.92',
  '1.2.840.10008.1.2.4.93',
]);

function isServerDecodedJpeg2000(transferSyntax: string): boolean {
  return jpeg2000TransferSyntaxes.has(transferSyntax) || htj2kTransferSyntaxes.has(transferSyntax);
}

const ecgWaveformSopClassPrefix = '1.2.840.10008.5.1.4.1.1.9.';
const ecgFallbackRows = 768;
const ecgFallbackColumns = 1024;
const frameCacheMaxBytes = Math.max(8, Number(process.env.DICOMWEB_FRAME_CACHE_MB || 256)) * 1024 * 1024;
const frameResponseCache = new Map<string, FrameCacheEntry>();
const rawFrameCacheEnabled = String(process.env.DICOMWEB_RAW_CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const rawFrameInFlight = new Map<string, Promise<RawFrameResponse>>();
const thumbnailFrameInFlight = new Map<string, Promise<BinaryResponse>>();
const renderedFrameCacheVersion = 'v5-physical-pixel-spacing';
const rawFrameCacheVersion = 'v1-modality-pixels';
const thumbnailFrameCacheVersion = 'v2-private-thumbnail';
let frameResponseCacheBytes = 0;
const frameResponseCacheCounters = {
  hits: 0,
  misses: 0,
  sets: 0,
  evictions: 0,
};
const rawFrameCacheCounters = {
  decodes: 0,
  coalesced: 0,
};
const thumbnailFrameCacheCounters = {
  renders: 0,
  coalesced: 0,
};

interface FrameCacheEntry {
  size: number;
  mtimeMs: number;
  bytes: number;
  contentType: string;
  buffer: Buffer;
  etag: string;
  lastAccess: number;
  rows?: number;
  columns?: number;
  dataType?: string;
}

type RawFrameCacheStatus = 'HIT' | 'MISS' | 'COALESCED' | 'BYPASS';

interface RawFrameResponse {
  buffer: Buffer;
  rows: number;
  columns: number;
  dataType: string;
  etag: string;
  cacheControl: string;
  cacheStatus: RawFrameCacheStatus;
}

function buildContentLocation(
  studyInstanceUid: string,
  seriesInstanceUid: string | undefined,
  sopInstanceUid: string,
  frame: string | undefined,
): string {
  let contentLocation = `/studies/${studyInstanceUid}`;
  if (seriesInstanceUid) {
    contentLocation += `/series/${seriesInstanceUid}`;
  }
  contentLocation += `/instances/${sopInstanceUid}`;
  if (frame) {
    contentLocation += `/frames/${frame}`;
  }
  return contentLocation;
}

function parseFrameNumber(frame: string | undefined): number {
  const parsed = Number.parseInt(frame || '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getPixelCacheControl(): string {
  return process.env.DICOMWEB_PIXEL_CACHE_CONTROL || 'private, max-age=86400, immutable';
}

function buildFrameCacheKey(pathname: string, frameNumber: number): string {
  return `${pathname}|${frameNumber}`;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

function isJpegLsMode(compressedMode: string | undefined): boolean {
  const mode = String(compressedMode || '').trim().toLowerCase();
  return mode === 'jls' || mode === 'jpeg-ls' || mode === 'jpegls';
}

async function findLatestJpegLsTestInstancePath(
  studyInstanceUid: string,
  seriesInstanceUid: string | undefined,
  sopInstanceUid: string,
): Promise<string | null> {
  if (!seriesInstanceUid) {
    return null;
  }

  const storagePath = config.get<string>(ConfParams.STORAGE_PATH);
  const overrideRoot = process.env.DICOMWEB_JPEGLS_TEST_ROOT;
  const root = overrideRoot
    ? path.resolve(overrideRoot, studyInstanceUid, seriesInstanceUid)
    : path.join(storagePath, '.compression-tests', 'jpeg-ls', studyInstanceUid, seriesInstanceUid);

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, sopInstanceUid))
      .reverse();

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveWadoInstancePath({
  studyInstanceUid,
  seriesInstanceUid,
  sopInstanceUid,
  compressedMode,
}: WadoRsArgs): Promise<string | null> {
  if (isJpegLsMode(compressedMode)) {
    const jpegLsPath = await findLatestJpegLsTestInstancePath(studyInstanceUid, seriesInstanceUid, sopInstanceUid);
    if (jpegLsPath) {
      return jpegLsPath;
    }
  }

  return resolveInstancePath(studyInstanceUid, sopInstanceUid);
}

function buildWadoEtag(parts: Array<string | number>): string {
  const hash = createHash('sha1').update(parts.join('|')).digest('base64url');
  return `"vexa-${hash}"`;
}

function getFrameCacheEntry(key: string, size: number, mtimeMs: number): FrameCacheEntry | null {
  const entry = frameResponseCache.get(key);
  if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) {
    if (entry) {
      frameResponseCache.delete(key);
      frameResponseCacheBytes -= entry.bytes;
      frameResponseCacheCounters.evictions += 1;
    }
    frameResponseCacheCounters.misses += 1;
    return null;
  }
  entry.lastAccess = Date.now();
  frameResponseCacheCounters.hits += 1;
  noteFrameCacheAccess('l1');
  return entry;
}

function putFrameCacheEntry(key: string, entry: FrameCacheEntry, options?: { skipDisk?: boolean }) {
  if (entry.bytes <= frameCacheMaxBytes) {
    const existing = frameResponseCache.get(key);
    if (existing) {
      frameResponseCacheBytes -= existing.bytes;
    }

    frameResponseCache.set(key, entry);
    frameResponseCacheBytes += entry.bytes;
    frameResponseCacheCounters.sets += 1;

    while (frameResponseCacheBytes > frameCacheMaxBytes) {
      const oldest = [...frameResponseCache.entries()]
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
      if (!oldest) break;
      frameResponseCache.delete(oldest[0]);
      frameResponseCacheBytes -= oldest[1].bytes;
      frameResponseCacheCounters.evictions += 1;
    }
  }

  if (!options?.skipDisk) {
    // Write-behind: the response is returned immediately, the persistent tier is filled
    // in the background so a later open by any client (or after a restart) is a hit.
    void putFrameDiskCacheEntry(key, {
      contentType: entry.contentType,
      etag: entry.etag,
      buffer: entry.buffer,
      sourceSize: entry.size,
      sourceMtimeMs: entry.mtimeMs,
      rows: entry.rows,
      columns: entry.columns,
      dataType: entry.dataType,
    });
  }
}

/**
 * Memory first, then the persistent disk tier (shared by every client and surviving
 * restarts), promoting disk hits back into memory.
 */
async function getFrameCacheEntryWithDisk(
  key: string,
  size: number,
  mtimeMs: number,
): Promise<FrameCacheEntry | null> {
  const memoryEntry = getFrameCacheEntry(key, size, mtimeMs);
  if (memoryEntry) {
    return memoryEntry;
  }

  const diskEntry = await getFrameDiskCacheEntry(key, size, mtimeMs);
  if (!diskEntry) {
    noteFrameCacheAccess('miss');
    return null;
  }

  const promoted: FrameCacheEntry = {
    size,
    mtimeMs,
    bytes: diskEntry.buffer.byteLength,
    contentType: diskEntry.contentType,
    buffer: diskEntry.buffer,
    etag: diskEntry.etag,
    lastAccess: Date.now(),
    rows: diskEntry.rows,
    columns: diskEntry.columns,
    dataType: diskEntry.dataType,
  };
  noteFrameCachePromotion();
  putFrameCacheEntry(key, promoted, { skipDisk: true });
  return promoted;
}

export async function getWadoRsFrameEtag({
  studyInstanceUid,
  seriesInstanceUid,
  sopInstanceUid,
  frame,
  compressedMode,
}: WadoRsArgs): Promise<string | null> {
  const pathname = await resolveWadoInstancePath({ studyInstanceUid, seriesInstanceUid, sopInstanceUid, frame, compressedMode });
  if (!pathname) {
    return null;
  }
  const stat = await fs.stat(pathname);
  const frameNumber = parseFrameNumber(frame);
  return buildWadoEtag(['frame', pathname, stat.size, stat.mtimeMs, frameNumber]);
}

function getTransferSyntax(dataset: dicomParser.DataSet): string {
  return dataset.string('x00020010') || '1.2.840.10008.1.2';
}

function isEcgWaveformDataset(dataset: dicomParser.DataSet): boolean {
  const modality = String(dataset.string('x00080060') || '').toUpperCase();
  const sopClassUid = String(dataset.string('x00080016') || '');
  return modality === 'ECG' || sopClassUid.startsWith(ecgWaveformSopClassPrefix);
}

function getSamplesPerPixel(dataset: dicomParser.DataSet): number {
  return dataset.uint16('x00280002') || 1;
}

function isMonochrome1(dataset: dicomParser.DataSet): boolean {
  return String(dataset.string('x00280004') || '').toUpperCase().includes('MONOCHROME1');
}

function getRows(dataset: dicomParser.DataSet): number {
  return dataset.uint16('x00280010') || 0;
}

function getColumns(dataset: dicomParser.DataSet): number {
  return dataset.uint16('x00280011') || 0;
}

function firstSequenceItemDataset(
  dataset: dicomParser.DataSet,
  key: string,
): dicomParser.DataSet | undefined {
  return dataset.elements[key]?.items?.find((item) => item.dataSet)?.dataSet;
}

function positiveDecimalValues(dataset: dicomParser.DataSet, key: string): number[] {
  try {
    const raw = dataset.string(key);
    if (raw === undefined || raw === null) return [];
    return String(raw)
      .split('\\')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function getPixelSpacing(dataset: dicomParser.DataSet): [number, number] | null {
  let values = positiveDecimalValues(dataset, 'x00280030');
  if (values.length < 2) {
    const sharedFunctionalGroups = firstSequenceItemDataset(dataset, 'x52009229');
    const pixelMeasures = sharedFunctionalGroups
      ? firstSequenceItemDataset(sharedFunctionalGroups, 'x00289110')
      : undefined;
    values = pixelMeasures ? positiveDecimalValues(pixelMeasures, 'x00280030') : [];
  }
  return values.length >= 2 ? [values[0], values[1]] : null;
}

function getRenderedDimensions(
  dataset: dicomParser.DataSet,
  nativeRows: number,
  nativeColumns: number,
  requestedRows?: number,
  requestedColumns?: number,
): { rows: number; columns: number } {
  if (!requestedRows && !requestedColumns) {
    return { rows: nativeRows, columns: nativeColumns };
  }

  const spacing = getPixelSpacing(dataset);
  const rowSpacing = spacing?.[0] ?? 1;
  const columnSpacing = spacing?.[1] ?? rowSpacing;
  const physicalAspect = Math.max(
    Number.EPSILON,
    (nativeColumns * columnSpacing) / Math.max(Number.EPSILON, nativeRows * rowSpacing),
  );
  const maximumRows = Math.max(1, Math.round(requestedRows || nativeRows));
  const maximumColumns = Math.max(1, Math.round(requestedColumns || nativeColumns));
  const boundingAspect = maximumColumns / maximumRows;

  if (physicalAspect >= boundingAspect) {
    return {
      columns: maximumColumns,
      rows: Math.max(1, Math.round(maximumColumns / physicalAspect)),
    };
  }

  return {
    rows: maximumRows,
    columns: Math.max(1, Math.round(maximumRows * physicalAspect)),
  };
}

function getBitsAllocated(dataset: dicomParser.DataSet): number {
  return dataset.uint16('x00280100') || 8;
}

function extractEncapsulatedFrame(
  dataset: dicomParser.DataSet,
  pixelDataElement: dicomParser.Element,
  frameNumber: number,
): Buffer | null {
  const fragments = pixelDataElement.fragments;
  if (!fragments || !fragments.length) {
    return null;
  }

  const fragment = fragments[Math.min(frameNumber - 1, fragments.length - 1)];
  if (!fragment || typeof fragment.position !== 'number' || typeof fragment.length !== 'number') {
    return null;
  }

  const byteOffset = dataset.byteArray.byteOffset ?? 0;
  return Buffer.from(dataset.byteArray.buffer, byteOffset + fragment.position, fragment.length);
}

function extractNativeFrame(
  dataset: dicomParser.DataSet,
  pixelDataElement: dicomParser.Element,
  frameNumber: number,
): Buffer {
  const rows = getRows(dataset);
  const columns = getColumns(dataset);
  const samplesPerPixel = getSamplesPerPixel(dataset);
  const bytesPerSample = Math.max(1, Math.ceil(getBitsAllocated(dataset) / 8));
  const frameSize = rows * columns * samplesPerPixel * bytesPerSample;
  const offset = frameSize > 0 ? frameSize * (frameNumber - 1) : 0;
  const length =
    frameSize > 0 && offset + frameSize <= pixelDataElement.length
      ? frameSize
      : pixelDataElement.length;
  const byteOffset = dataset.byteArray.byteOffset ?? 0;
  return Buffer.from(
    dataset.byteArray.buffer,
    byteOffset + pixelDataElement.dataOffset + offset,
    length,
  );
}

function contentTypeForTransferSyntax(transferSyntax: string): string {
  if (htj2kTransferSyntaxes.has(transferSyntax)) {
    return 'image/jhc';
  }
  if (transferSyntax.startsWith('1.2.840.10008.1.2.4.8')) {
    return 'image/jls';
  }
  if (jpegTransferSyntaxes.has(transferSyntax)) {
    return 'image/jpeg';
  }
  if (transferSyntax.startsWith('1.2.840.10008.1.2.4.9')) {
    return 'image/jp2';
  }
  return 'application/octet-stream';
}

function framePartContentTypeForTransferSyntax(transferSyntax: string): string {
  const mediaType = contentTypeForTransferSyntax(transferSyntax);
  return `${mediaType}; transfer-syntax="${transferSyntax}"`;
}

function isEncapsulatedTransferSyntax(transferSyntax: string): boolean {
  return jpegTransferSyntaxes.has(transferSyntax)
    || htj2kTransferSyntaxes.has(transferSyntax)
    || transferSyntax.startsWith('1.2.840.10008.1.2.4.8')
    || transferSyntax.startsWith('1.2.840.10008.1.2.4.9')
    || transferSyntax === '1.2.840.10008.1.2.5';
}

function getElementBytes(dataset: dicomParser.DataSet, element: dicomParser.Element): Buffer {
  const byteOffset = dataset.byteArray.byteOffset ?? 0;
  return Buffer.from(dataset.byteArray.buffer, byteOffset + element.dataOffset, element.length);
}

function readSignedSample(bytes: Buffer, offset: number, bytesPerSample: number, signed: boolean): number {
  if (bytesPerSample === 1) return signed ? bytes.readInt8(offset) : bytes.readUInt8(offset);
  if (offset + 2 > bytes.length) return 0;
  return signed ? bytes.readInt16LE(offset) : bytes.readUInt16LE(offset);
}

function drawPixel(image: Buffer, x: number, y: number, value: number) {
  if (x < 0 || y < 0 || x >= ecgFallbackColumns || y >= ecgFallbackRows) return;
  image[y * ecgFallbackColumns + x] = value;
}

function drawLine(image: Buffer, x0: number, y0: number, x1: number, y1: number, value: number) {
  let dx = Math.abs(x1 - x0);
  let sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0);
  let sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    drawPixel(image, x0, y0, value);
    drawPixel(image, x0, y0 + 1, value);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function drawEcgGrid(image: Buffer) {
  for (let y = 0; y < ecgFallbackRows; y += 24) {
    for (let x = 0; x < ecgFallbackColumns; x++) drawPixel(image, x, y, 218);
  }
  for (let x = 0; x < ecgFallbackColumns; x += 24) {
    for (let y = 0; y < ecgFallbackRows; y++) drawPixel(image, x, y, 218);
  }
  for (let y = 0; y < ecgFallbackRows; y += 120) {
    for (let x = 0; x < ecgFallbackColumns; x++) drawPixel(image, x, y, 190);
  }
  for (let x = 0; x < ecgFallbackColumns; x += 120) {
    for (let y = 0; y < ecgFallbackRows; y++) drawPixel(image, x, y, 190);
  }
}

function renderEcgWaveform(dataset: dicomParser.DataSet): Buffer {
  const image = Buffer.alloc(ecgFallbackRows * ecgFallbackColumns, 255);
  drawEcgGrid(image);

  const sequence = dataset.elements.x54000100;
  const item = sequence?.items?.[0]?.dataSet;
  const waveformData = item?.elements.x54001010;
  const channels = item?.uint16('x003a0005') || 1;
  const samples = item?.uint32('x003a0010') || 0;
  const bitsAllocated = item?.uint16('x54001004') || 16;
  const interpretation = String(item?.string('x54001006') || 'SS').toUpperCase();

  if (!item || !waveformData || !samples) {
    const mid = Math.floor(ecgFallbackRows / 2);
    drawLine(image, 60, mid, ecgFallbackColumns - 60, mid, 0);
    return image;
  }

  const bytes = getElementBytes(item, waveformData);
  const bytesPerSample = Math.max(1, Math.ceil(bitsAllocated / 8));
  const signed = interpretation.startsWith('S');
  const channelCount = Math.max(1, Math.min(channels, 12));
  const rowsPerChannel = Math.floor((ecgFallbackRows - 48) / channelCount);
  const drawableWidth = ecgFallbackColumns - 96;
  const maxSamples = Math.min(samples, Math.floor(bytes.length / (bytesPerSample * Math.max(1, channels))));

  for (let channel = 0; channel < channelCount; channel++) {
    const values: number[] = [];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const step = Math.max(1, Math.floor(maxSamples / drawableWidth));
    for (let sample = 0; sample < maxSamples; sample += step) {
      const offset = (sample * channels + channel) * bytesPerSample;
      const value = readSignedSample(bytes, offset, bytesPerSample, signed);
      values.push(value);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const top = 24 + channel * rowsPerChannel;
    const centerY = top + Math.floor(rowsPerChannel / 2);
    const amplitude = Math.max(8, Math.min(42, Math.floor(rowsPerChannel * 0.36)));
    const range = max - min || 1;
    let previousX = 48;
    let previousY = centerY;
    values.forEach((value, index) => {
      const x = 48 + Math.round((index / Math.max(1, values.length - 1)) * drawableWidth);
      const normalized = (value - min) / range - 0.5;
      const y = centerY - Math.round(normalized * 2 * amplitude);
      drawLine(image, previousX, previousY, x, y, 0);
      previousX = x;
      previousY = y;
    });
  }

  return image;
}

function getDicomJsonValue(record: any, tag: string): string {
  const value = record?.[tag]?.Value;
  return Array.isArray(value) && value[0] ? String(value[0]) : '';
}

async function findInstanceReferences(
  studyInstanceUid: string,
  seriesInstanceUid?: string,
): Promise<InstanceReference[]> {
  const filters = [
    { tag: '0020000D', vr: 'UI', value: studyInstanceUid },
    ...(seriesInstanceUid ? [{ tag: '0020000E', vr: 'UI', value: seriesInstanceUid }] : []),
  ];
  const records = await queryPacsMetadata(
    QUERY_LEVEL.IMAGE,
    ['0020000D', '0020000E', '00080018'],
    filters,
  );

  return (records || [])
    .map((record) => ({
      studyInstanceUid: getDicomJsonValue(record, '0020000D'),
      seriesInstanceUid: getDicomJsonValue(record, '0020000E'),
      sopInstanceUid: getDicomJsonValue(record, '00080018'),
    }))
    .filter((record) => record.studyInstanceUid && record.seriesInstanceUid && record.sopInstanceUid);
}

async function buildMultipartDicomResponse(instances: InstanceReference[]): Promise<BinaryResponse> {
  if (!instances.length) {
    throw new Error('No DICOM instances found in storage');
  }

  const boundary = randomBytes(16).toString('hex');
  const contentId = randomBytes(16).toString('hex');
  const term = '\r\n';
  const bodyParts: Buffer[] = [];

  for (const instance of instances) {
    const pathname = await resolveInstancePath(instance.studyInstanceUid, instance.sopInstanceUid);
    if (!pathname) continue;
    const dicomData = await fs.readFile(pathname);
    const contentLocation = buildContentLocation(
      instance.studyInstanceUid,
      instance.seriesInstanceUid,
      instance.sopInstanceUid,
      undefined,
    );
    bodyParts.push(
      Buffer.from(`${term}--${boundary}${term}`),
      Buffer.from(`Content-Location: ${contentLocation}${term}`),
      Buffer.from(`Content-ID: ${randomBytes(16).toString('hex')}${term}`),
      Buffer.from(`Content-Type: application/dicom${term}`),
      Buffer.from(term),
      dicomData,
    );
  }

  if (!bodyParts.length) {
    throw new Error('No DICOM instance files found in storage');
  }

  bodyParts.push(Buffer.from(`${term}--${boundary}--${term}`));

  return {
    contentType: `multipart/related; start="${contentId}"; type="application/dicom"; boundary="${boundary}"`,
    buffer: Buffer.concat(bodyParts),
  };
}

export async function doWadoRsFrame({
  studyInstanceUid,
  seriesInstanceUid,
  sopInstanceUid,
  frame,
  compressedMode,
}: WadoRsArgs): Promise<BinaryResponse> {
  const logger = LoggerSingleton.Instance;
  const storagePath = config.get<string>(ConfParams.STORAGE_PATH);
  const studyPath = path.join(storagePath, studyInstanceUid);
  const pathname = await resolveWadoInstancePath({ studyInstanceUid, seriesInstanceUid, sopInstanceUid, frame, compressedMode });

  if (!pathname) {
    throw new Error(`DICOM instance ${sopInstanceUid} for study ${studyInstanceUid} not found in storage`);
  }

  const stat = await fs.stat(pathname);
  const selectedFrame = parseFrameNumber(frame);
  const cacheKey = buildFrameCacheKey(pathname, selectedFrame);
  const cached = await getFrameCacheEntryWithDisk(cacheKey, stat.size, stat.mtimeMs);
  if (cached) {
    return {
      contentType: cached.contentType,
      buffer: cached.buffer,
      etag: cached.etag,
      cacheControl: getPixelCacheControl(),
    };
  }

  const data = await fs.readFile(pathname);
  const dataset = dicomParser.parseDicom(data);
  const pixelDataElement = dataset.elements.x7fe00010;
  const etag = buildWadoEtag(['frame', pathname, stat.size, stat.mtimeMs, selectedFrame]);
  if (!pixelDataElement && isEcgWaveformDataset(dataset)) {
    const pixelData = renderEcgWaveform(dataset);
    const boundary = randomBytes(16).toString('hex');
    const contentId = randomBytes(16).toString('hex');
    const term = '\r\n';
    const contentLocation = buildContentLocation(studyInstanceUid, seriesInstanceUid, sopInstanceUid, frame);
    const body = Buffer.concat([
      Buffer.from(`${term}--${boundary}${term}`),
      Buffer.from(`Content-Location: ${contentLocation}${term}`),
      Buffer.from(`Content-ID: ${contentId}${term}`),
      Buffer.from(`Content-Type: application/octet-stream${term}`),
      Buffer.from(term),
      pixelData,
      Buffer.from(`${term}--${boundary}--${term}`),
    ]);
    const response = {
      contentType: `multipart/related; start="${contentId}"; type="application/octet-stream"; boundary="${boundary}"`,
      buffer: body,
      etag,
      cacheControl: getPixelCacheControl(),
    };
    putFrameCacheEntry(cacheKey, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      bytes: body.byteLength,
      contentType: response.contentType,
      buffer: body,
      etag,
      lastAccess: Date.now(),
    });
    return response;
  }
  if (!pixelDataElement) {
    throw new Error(`PixelData not found in ${pathname}`);
  }

  const transferSyntax = getTransferSyntax(dataset);
  const encapsulatedFrame = extractEncapsulatedFrame(dataset, pixelDataElement, selectedFrame);
  let pixelData = encapsulatedFrame ?? extractNativeFrame(dataset, pixelDataElement, selectedFrame);
  const partMediaType = contentTypeForTransferSyntax(transferSyntax);
  const partContentType = framePartContentTypeForTransferSyntax(transferSyntax);

  if (!encapsulatedFrame && partMediaType === 'application/octet-stream') {
    try {
      await compressFile(pathname, studyPath, '1.2.840.10008.1.2');
      const refreshed = await fs.readFile(pathname);
      const refreshedDataset = dicomParser.parseDicom(refreshed);
      const refreshedPixelDataElement = refreshedDataset.elements.x7fe00010;
      if (refreshedPixelDataElement) {
        pixelData = extractNativeFrame(refreshedDataset, refreshedPixelDataElement, selectedFrame);
      }
    } catch (error) {
      logger.error(error);
      throw new Error(`failed to compress ${pathname}`);
    }
  }

  const boundary = randomBytes(16).toString('hex');
  const contentId = randomBytes(16).toString('hex');
  const term = '\r\n';
  const contentLocation = buildContentLocation(
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid,
    frame,
  );

  const body = Buffer.concat([
    Buffer.from(`${term}--${boundary}${term}`),
    Buffer.from(`Content-Location: ${contentLocation}${term}`),
    Buffer.from(`Content-ID: ${contentId}${term}`),
    Buffer.from(`Content-Type: ${partContentType}${term}`),
    Buffer.from(term),
    pixelData,
    Buffer.from(`${term}--${boundary}--${term}`),
  ]);

  const response = {
    contentType: `multipart/related; start="${contentId}"; type="${contentTypeForTransferSyntax(transferSyntax)}"; transfer-syntax="${transferSyntax}"; boundary="${boundary}"`,
    buffer: body,
    etag,
    cacheControl: getPixelCacheControl(),
  };
  putFrameCacheEntry(cacheKey, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    bytes: body.byteLength,
    contentType: response.contentType,
    buffer: body,
    etag,
    lastAccess: Date.now(),
  });
  return response;
}

export async function doWadoRsInstance({
  studyInstanceUid,
  seriesInstanceUid,
  sopInstanceUid,
}: WadoRsArgs): Promise<BinaryResponse> {
  const pathname = await resolveInstancePath(studyInstanceUid, sopInstanceUid);

  if (!pathname) {
    throw new Error(`DICOM instance ${sopInstanceUid} for study ${studyInstanceUid} not found in storage`);
  }

  const stat = await fs.stat(pathname);
  const dicomData = await fs.readFile(pathname);
  const boundary = randomBytes(16).toString('hex');
  const contentId = randomBytes(16).toString('hex');
  const term = '\r\n';
  const contentLocation = buildContentLocation(
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid,
    undefined,
  );

  const body = Buffer.concat([
    Buffer.from(`${term}--${boundary}${term}`),
    Buffer.from(`Content-Location: ${contentLocation}${term}`),
    Buffer.from(`Content-ID: ${contentId}${term}`),
    Buffer.from(`Content-Type: application/dicom${term}`),
    Buffer.from(term),
    dicomData,
    Buffer.from(`${term}--${boundary}--${term}`),
  ]);

  return {
    contentType: `multipart/related; start="${contentId}"; type="application/dicom"; boundary="${boundary}"`,
    buffer: body,
    etag: buildWadoEtag(['instance', pathname, stat.size, stat.mtimeMs]),
    cacheControl: getPixelCacheControl(),
  };
}

export async function doWadoRsSeries({
  studyInstanceUid,
  seriesInstanceUid,
}: WadoRsArgs): Promise<BinaryResponse> {
  const instances = await findInstanceReferences(studyInstanceUid, seriesInstanceUid);
  return buildMultipartDicomResponse(instances);
}

export async function doWadoRsStudy({
  studyInstanceUid,
}: WadoRsArgs): Promise<BinaryResponse> {
  const instances = await findInstanceReferences(studyInstanceUid);
  return buildMultipartDicomResponse(instances);
}


export async function doWadoRsThumbnail({
  studyInstanceUid,
  sopInstanceUid,
}: WadoRsArgs): Promise<BinaryResponse> {
  const pathname = await resolveInstancePath(studyInstanceUid, sopInstanceUid);
  if (!pathname) throw new Error('instance not found');
  const stat = await fs.stat(pathname);
  const cacheKey = `${thumbnailFrameCacheVersion}|${pathname}`;
  const cached = await getFrameCacheEntryWithDisk(cacheKey, stat.size, stat.mtimeMs);
  if (cached) {
    return {
      contentType: cached.contentType,
      buffer: cached.buffer,
      etag: cached.etag,
      cacheControl: getPixelCacheControl(),
    };
  }

  const pending = thumbnailFrameInFlight.get(cacheKey);
  if (pending) {
    thumbnailFrameCacheCounters.coalesced += 1;
    return pending;
  }

  const renderPromise = renderWadoRsThumbnail(pathname, stat.size, stat.mtimeMs, cacheKey);
  thumbnailFrameInFlight.set(cacheKey, renderPromise);
  try {
    return await renderPromise;
  } finally {
    if (thumbnailFrameInFlight.get(cacheKey) === renderPromise) {
      thumbnailFrameInFlight.delete(cacheKey);
    }
  }
}

async function renderWadoRsThumbnail(
  pathname: string,
  fileSize: number,
  mtimeMs: number,
  cacheKey: string,
): Promise<BinaryResponse> {
  thumbnailFrameCacheCounters.renders += 1;
  const data = await fs.readFile(pathname);
  const dataset = dicomParser.parseDicom(data);
  const p = dataset.elements.x7fe00010;
  if (!p) throw new Error('no pixel data');
  const rows = getRows(dataset);
  const cols = getColumns(dataset);
  const transferSyntax = getTransferSyntax(dataset);
  const etag = buildWadoEtag(['thumb', thumbnailFrameCacheVersion, pathname, fileSize, mtimeMs]);
  const enc = extractEncapsulatedFrame(dataset, p, 1);
  let response: BinaryResponse;
  if (enc) {
    if (isServerDecodedJpeg2000(transferSyntax)) {
      const bitsAllocated = getBitsAllocated(dataset);
      const samplesPerPixel = getSamplesPerPixel(dataset);
      const pixelRepresentation = dataset.uint16('x00280103') ?? 0;
      const expectedByteLength = rows * cols * samplesPerPixel * Math.max(1, Math.ceil(bitsAllocated / 8));
      const native = await decodeJpeg2000FrameToNative(enc, expectedByteLength, transferSyntax);
      const rendered = await renderPixelDataToJpeg(native, dataset, {
        rows: 256,
        columns: 256,
        quality: 78,
        nativeRows: rows,
        nativeCols: cols,
        bitsAllocated,
        samplesPerPixel,
        pixelRepresentation,
        rescaleSlope: Number(dataset.floatString('x00281053') ?? 1) || 1,
        rescaleIntercept: Number(dataset.floatString('x00281052') ?? 0) || 0,
      });
      response = { contentType: 'image/jpeg', buffer: rendered, etag, cacheControl: getPixelCacheControl() };
      putThumbnailCacheEntry(cacheKey, fileSize, mtimeMs, response);
      return response;
    }
    let pipeline = sharp(enc).resize(256, 256, { fit: 'inside' });
    if (isMonochrome1(dataset)) {
      pipeline = pipeline.negate({ alpha: false });
    }
    const jpg = await pipeline.jpeg({ quality: 78 }).toBuffer();
    response = { contentType: 'image/jpeg', buffer: jpg, etag, cacheControl: getPixelCacheControl() };
    putThumbnailCacheEntry(cacheKey, fileSize, mtimeMs, response);
    return response;
  }
  const native = extractNativeFrame(dataset, p, 1);
  const sps = getSamplesPerPixel(dataset);
  const ba = getBitsAllocated(dataset);
  let rendered;
  if (sps === 3) {
    rendered = await sharp(native, { raw: { width: cols, height: rows, channels: 3 } }).resize(256, 256, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
  } else {
    const vals = ba > 8 ? new Uint16Array(native.buffer, native.byteOffset, Math.floor(native.length / 2)) : new Uint8Array(native);
    let min = ba <= 8 ? 0 : vals[0], max = ba <= 8 ? 255 : vals[0];
    for (let i = 1; i < vals.length; i++) { if (vals[i] < min) min = vals[i]; if (vals[i] > max) max = vals[i]; }
    const range = max - min || 1;
    const norm = new Uint8Array(vals.length);
    const shouldInvert = isMonochrome1(dataset);
    for (let i = 0; i < vals.length; i++) {
      const gray = Math.round(((vals[i] - min) / range) * 255);
      norm[i] = shouldInvert ? 255 - gray : gray;
    }
    rendered = await sharp(norm, { raw: { width: cols, height: rows, channels: 1 } }).resize(256, 256, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
  }
  response = { contentType: 'image/jpeg', buffer: rendered, etag, cacheControl: getPixelCacheControl() };
  putThumbnailCacheEntry(cacheKey, fileSize, mtimeMs, response);
  return response;
}

function putThumbnailCacheEntry(cacheKey: string, size: number, mtimeMs: number, response: BinaryResponse) {
  putFrameCacheEntry(cacheKey, {
    size,
    mtimeMs,
    bytes: response.buffer.byteLength,
    contentType: response.contentType,
    buffer: response.buffer,
    etag: response.etag || '',
    lastAccess: Date.now(),
  });
}

export async function doWadoRsRaw({
  studyInstanceUid,
  sopInstanceUid,
  frame,
  dataType,
}: WadoRsArgs & { dataType?: string }): Promise<RawFrameResponse> {
  const pathname = await resolveInstancePath(studyInstanceUid, sopInstanceUid);
  if (!pathname) throw new Error('instance not found');
  const fileStat = await fs.stat(pathname);
  const selectedFrame = parseFrameNumber(frame);
  const requestedDataType = normalizeRawDataType(dataType);
  const cacheKey = `${rawFrameCacheVersion}|${pathname}|${selectedFrame}|${requestedDataType}`;
  const etag = buildRawFrameEtag(
    pathname,
    fileStat.size,
    fileStat.mtimeMs,
    selectedFrame,
    requestedDataType,
  );

  if (rawFrameCacheEnabled) {
    const cached = await getFrameCacheEntryWithDisk(cacheKey, fileStat.size, fileStat.mtimeMs);
    if (cached && cached.rows && cached.columns && cached.dataType) {
      return {
        buffer: cached.buffer,
        rows: cached.rows,
        columns: cached.columns,
        dataType: cached.dataType,
        etag: cached.etag,
        cacheControl: getPixelCacheControl(),
        cacheStatus: 'HIT',
      };
    }
  }

  const pending = rawFrameInFlight.get(cacheKey);
  if (pending) {
    rawFrameCacheCounters.coalesced += 1;
    const response = await pending;
    return { ...response, cacheStatus: 'COALESCED' };
  }

  const decodePromise = decodeRawFrame(pathname, selectedFrame, requestedDataType, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    cacheKey,
    etag,
  });
  rawFrameInFlight.set(cacheKey, decodePromise);

  try {
    return await decodePromise;
  } finally {
    if (rawFrameInFlight.get(cacheKey) === decodePromise) {
      rawFrameInFlight.delete(cacheKey);
    }
  }
}

export async function getWadoRsRawEtag({
  studyInstanceUid,
  sopInstanceUid,
  frame,
  dataType,
}: WadoRsArgs & { dataType?: string }): Promise<string | null> {
  const pathname = await resolveInstancePath(studyInstanceUid, sopInstanceUid);
  if (!pathname) return null;
  const fileStat = await fs.stat(pathname);
  return buildRawFrameEtag(
    pathname,
    fileStat.size,
    fileStat.mtimeMs,
    parseFrameNumber(frame),
    normalizeRawDataType(dataType),
  );
}

function buildRawFrameEtag(
  pathname: string,
  size: number,
  mtimeMs: number,
  selectedFrame: number,
  requestedDataType: 'Int16' | 'Float32',
) {
  return buildWadoEtag([
    'raw',
    rawFrameCacheVersion,
    pathname,
    size,
    mtimeMs,
    selectedFrame,
    requestedDataType,
  ]);
}

async function decodeRawFrame(
  pathname: string,
  selectedFrame: number,
  requestedDataType: 'Int16' | 'Float32',
  cacheContext: { size: number; mtimeMs: number; cacheKey: string; etag: string },
): Promise<RawFrameResponse> {
  rawFrameCacheCounters.decodes += 1;
  const data = await fs.readFile(pathname);
  const dataset = dicomParser.parseDicom(data);
  const p = dataset.elements.x7fe00010;
  if (!p) throw new Error('no pixel data');
  const rows = getRows(dataset);
  const cols = getColumns(dataset);
  const transferSyntax = getTransferSyntax(dataset);
  const isEncapsulated = isEncapsulatedTransferSyntax(transferSyntax);
  const rescaleSlope = Number(dataset.floatString('x00281053') ?? 1) || 1;
  const rescaleIntercept = Number(dataset.floatString('x00281052') ?? 0) || 0;
  const pixelRep = dataset.uint16('x00280103') ?? 0;

  let float32: Float32Array;
  if (isEncapsulated) {
    const enc = extractEncapsulatedFrame(dataset, p, selectedFrame);
    if (!enc) throw new Error('failed to extract encapsulated frame');
    const bitsAllocated = getBitsAllocated(dataset);
    const samplesPerPixel = getSamplesPerPixel(dataset);
    const expectedByteLength = rows * cols * samplesPerPixel * Math.max(1, Math.ceil(bitsAllocated / 8));
    const rawBytes = isServerDecodedJpeg2000(transferSyntax)
      ? await decodeJpeg2000FrameToNative(enc, expectedByteLength, transferSyntax)
      : (await sharp(enc).raw().toBuffer({ resolveWithObject: true })).data as Buffer;
    float32 = convertNativePixelBytesToFloat32(rawBytes, rows * cols, bitsAllocated, pixelRep, rescaleSlope, rescaleIntercept);
  } else {
    const native = extractNativeFrame(dataset, p, selectedFrame);
    const bitsAllocated = getBitsAllocated(dataset);
    const pixelCount = rows * cols;
    float32 = convertNativePixelBytesToFloat32(native, pixelCount, bitsAllocated, pixelRep, rescaleSlope, rescaleIntercept);
  }

  const buffer = requestedDataType === 'Int16'
    ? convertFloat32PixelsToInt16Buffer(float32)
    : Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
  const response: RawFrameResponse = {
    buffer,
    rows,
    columns: cols,
    dataType: requestedDataType,
    etag: cacheContext.etag,
    cacheControl: getPixelCacheControl(),
    cacheStatus: rawFrameCacheEnabled ? 'MISS' : 'BYPASS',
  };

  if (rawFrameCacheEnabled) {
    putFrameCacheEntry(cacheContext.cacheKey, {
      size: cacheContext.size,
      mtimeMs: cacheContext.mtimeMs,
      bytes: buffer.byteLength,
      contentType: 'application/octet-stream',
      buffer,
      etag: cacheContext.etag,
      lastAccess: Date.now(),
      rows,
      columns: cols,
      dataType: requestedDataType,
    });
  }

  return response;
}

function normalizeRawDataType(value: string | undefined): 'Int16' | 'Float32' {
  return String(value || '').toLowerCase() === 'int16' ? 'Int16' : 'Float32';
}

function convertFloat32PixelsToInt16Buffer(source: Float32Array): Buffer {
  const pixels = new Int16Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    pixels[index] = Math.min(32767, Math.max(-32768, Math.round(Number.isFinite(value) ? value : 0)));
  }
  return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

function convertNativePixelBytesToFloat32(
  pixelBytes: Uint8Array,
  pixelCount: number,
  bitsAllocated: number,
  pixelRepresentation: number,
  rescaleSlope: number,
  rescaleIntercept: number,
): Float32Array {
  const values = new Float32Array(pixelCount);
  if (bitsAllocated > 8) {
    const available = Math.min(Math.floor(pixelBytes.byteLength / 2), pixelCount);
    const source = pixelRepresentation === 1
      ? new Int16Array(pixelBytes.buffer, pixelBytes.byteOffset, available)
      : new Uint16Array(pixelBytes.buffer, pixelBytes.byteOffset, available);
    for (let index = 0; index < available; index += 1) {
      values[index] = source[index] * rescaleSlope + rescaleIntercept;
    }
    return values;
  }

  const available = Math.min(pixelBytes.byteLength, pixelCount);
  if (pixelRepresentation === 1) {
    const source = new Int8Array(pixelBytes.buffer, pixelBytes.byteOffset, available);
    for (let index = 0; index < available; index += 1) {
      values[index] = source[index] * rescaleSlope + rescaleIntercept;
    }
    return values;
  }

  for (let index = 0; index < available; index += 1) {
    values[index] = pixelBytes[index] * rescaleSlope + rescaleIntercept;
  }
  return values;
}

export interface RenderedFrameOptions {
  studyInstanceUid: string;
  seriesInstanceUid?: string;
  sopInstanceUid: string;
  frame?: string;
  rows?: number;
  columns?: number;
  windowCenter?: number;
  windowWidth?: number;
  quality?: number;
}

async function renderPixelDataToJpeg(
  pixelBytes: Buffer,
  dataset: dicomParser.DataSet,
  opts: { rows?: number; columns?: number; windowCenter?: number; windowWidth?: number; quality?: number; nativeRows: number; nativeCols: number; bitsAllocated: number; samplesPerPixel: number; pixelRepresentation: number; rescaleSlope: number; rescaleIntercept: number },
): Promise<Buffer> {
  const { nativeRows, nativeCols, bitsAllocated, samplesPerPixel, pixelRepresentation, rescaleSlope, rescaleIntercept } = opts
  const dimensions = getRenderedDimensions(dataset, nativeRows, nativeCols, opts.rows, opts.columns)
  const targetRows = dimensions.rows
  const targetCols = dimensions.columns
  const quality = opts.quality || 70
  const wc = opts.windowCenter ?? null
  const ww = opts.windowWidth ?? null

  if (samplesPerPixel === 3 && bitsAllocated === 8) {
    return sharp(pixelBytes, { raw: { width: nativeCols, height: nativeRows, channels: 3 } })
      .resize(targetCols, targetRows, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .jpeg({ quality })
      .toBuffer()
  }

  const isSigned = pixelRepresentation === 1
  const bytesPerSample = Math.max(1, Math.ceil(bitsAllocated / 8))
  const pixelCount = nativeRows * nativeCols
  let rawValues: number[] = []

  if (bitsAllocated <= 8) {
    const u8 = new Uint8Array(pixelBytes.buffer, pixelBytes.byteOffset, Math.min(pixelBytes.length, pixelCount))
    rawValues = Array.from(u8).map(v => v * rescaleSlope + rescaleIntercept)
  } else if (bytesPerSample === 2 && !isSigned) {
    const u16 = new Uint16Array(pixelBytes.buffer, pixelBytes.byteOffset, Math.min(Math.floor(pixelBytes.length / 2), pixelCount))
    rawValues = Array.from(u16).map(v => v * rescaleSlope + rescaleIntercept)
  } else if (bytesPerSample === 2 && isSigned) {
    const i16 = new Int16Array(pixelBytes.buffer, pixelBytes.byteOffset, Math.min(Math.floor(pixelBytes.length / 2), pixelCount))
    rawValues = Array.from(i16).map(v => v * rescaleSlope + rescaleIntercept)
  } else {
    throw new Error('Unsupported pixel format for rendering')
  }

  if (rawValues.length < pixelCount) {
    const missing = pixelCount - rawValues.length
    for (let i = 0; i < missing; i++) rawValues.push(rawValues[rawValues.length - 1] || 0)
  }

  let minVal: number, maxVal: number
  if (wc !== null && ww !== null) {
    minVal = wc - ww / 2
    maxVal = wc + ww / 2
  } else {
    minVal = rawValues[0]; maxVal = rawValues[0]
    for (let i = 1; i < rawValues.length; i++) {
      const v = rawValues[i]
      if (v === v && v > Number.NEGATIVE_INFINITY && v < Number.POSITIVE_INFINITY) {
        if (v < minVal) minVal = v
        if (v > maxVal) maxVal = v
      }
    }
  }

  const range = maxVal - minVal || 1
  const norm = new Uint8Array(rawValues.length)
  const shouldInvert = samplesPerPixel === 1 && isMonochrome1(dataset)
  for (let i = 0; i < rawValues.length; i++) {
    const v = Math.round(((rawValues[i] - minVal) / range) * 255)
    const clipped = v < 0 ? 0 : v > 255 ? 255 : v
    norm[i] = shouldInvert ? 255 - clipped : clipped
  }

  return sharp(Buffer.from(norm), { raw: { width: nativeCols, height: nativeRows, channels: 1 } })
    .resize(targetCols, targetRows, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .jpeg({ quality })
    .toBuffer()
}

/**
 * Warm the JPEG 2000 decoder pool at startup so the first study does not pay the
 * interpreter start. Measured: first burst after a cold start 779 ms/frame, with one warm
 * worker 14 ms/frame.
 */
export function warmJpeg2000DecoderPool(count = 1): number {
  // count <= 0 disables the startup warm (useful to reproduce the lazy-spawn behaviour).
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  try {
    return warmJ2kWorkerPool(resolveJpeg2000DecoderPython(), count);
  } catch (error) {
    LoggerSingleton.Instance.warn(`gagal memanaskan decoder pool: ${(error as Error).message}`);
    return 0;
  }
}

async function decodeJpeg2000FrameToNative(
  pixelBytes: Buffer,
  expectedByteLength: number,
  transferSyntax: string,
): Promise<Buffer> {
  const python = resolveJpeg2000DecoderPython();
  const script = htj2kTransferSyntaxes.has(transferSyntax)
    ? [
        'import sys',
        'import imagecodecs',
        'data = sys.stdin.buffer.read()',
        'arr = imagecodecs.htj2k_decode(data)',
        "sys.stdout.buffer.write(arr.tobytes(order='C'))",
      ].join('\n')
    : [
        'import sys',
        'import openjpeg',
        'data = sys.stdin.buffer.read()',
        'arr = openjpeg.decode(data, j2k_format=0)',
        "sys.stdout.buffer.write(arr.tobytes(order='C'))",
      ].join('\n');
  const kind = htj2kTransferSyntaxes.has(transferSyntax) ? 'htj2k' : 'j2k';
  // Worker persisten: biaya start interpreter + import openjpeg dibayar sekali, bukan per frame.
  let decoded: Buffer | null = null;
  try {
    decoded = await decodeJ2kViaPool(kind, pixelBytes, python);
  } catch (error) {
    throw new Error(`JPEG 2000 decoder failed: ${(error as Error).message}`);
  }
  if (!decoded) {
    decoded = await runPythonBinaryFilter(python, ['-c', script], pixelBytes);
  }

  if (decoded.byteLength < expectedByteLength) {
    throw new Error(`JPEG 2000 decoder returned ${decoded.byteLength} byte(s), expected at least ${expectedByteLength}`);
  }

  return decoded.byteLength === expectedByteLength
    ? decoded
    : decoded.subarray(0, expectedByteLength);
}

/**
 * Interpreter used for JPEG 2000 / HTJ2K decoding.
 *
 * The decoder must be able to `import openjpeg`. When PACS is started outside the
 * launcher (service restart, manual `npm start`, the dev helper) the first `python` on
 * PATH is often an interpreter without that module, and then *every* compressed frame
 * fails with a 500 and the log only says "No module named 'openjpeg'". Probe the
 * candidates once, keep the first one that really works, and say so - a silent
 * fallback to a broken interpreter costs the whole archive.
 */
let cachedDecoderPython: string | null = null;
let decoderPythonProbed = false;

function decoderPythonCandidates(): string[] {
  const localTestDecoder = path.resolve(process.cwd(), '..', 'scratch', 'htj2k-test', '.venv', 'Scripts', 'python.exe');
  return [
    process.env.DICOMWEB_JPEG2000_DECODER_PYTHON,
    process.env.DICOMWEB_HTJ2K_DECODER_PYTHON,
    existsSync(localTestDecoder) ? localTestDecoder : null,
    process.env.PYTHON,
    'py',
    'python3',
    'python',
  ].filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function probeDecoderPython(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, ['-c', 'import openjpeg'], { timeout: 15000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveJpeg2000DecoderPython(): string {
  if (cachedDecoderPython) {
    return cachedDecoderPython;
  }
  const candidates = decoderPythonCandidates();
  const fallback = candidates[0] || 'python';
  if (decoderPythonProbed) {
    return fallback;
  }
  decoderPythonProbed = true;
  for (const candidate of candidates) {
    if (probeDecoderPython(candidate)) {
      cachedDecoderPython = candidate;
      if (candidate !== fallback) {
        LoggerSingleton.Instance.warn(
          `JPEG 2000 decoder: "${fallback}" cannot import openjpeg, using "${candidate}" instead`,
        );
      }
      return candidate;
    }
  }
  cachedDecoderPython = fallback;
  LoggerSingleton.Instance.error(
    `JPEG 2000 decoder: none of [${candidates.join(', ')}] can import openjpeg - compressed frames will fail. `
    + 'Install openjpeg for that interpreter (pip install openjpeg) or set DICOMWEB_JPEG2000_DECODER_PYTHON.',
  );
  return fallback;
}

function runPythonBinaryFilter(command: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    // Tanpa handler ini, kegagalan tulis ke stdin (mis. 'write EOF' ketika proses decoder
    // sudah keluar lebih dulu karena import gagal) naik menjadi uncaughtException dan
    // mematikan seluruh proses PACS - satu frame yang gagal decode = PACS down.
    child.stdin.on('error', (error: Error) => {
      LoggerSingleton.Instance.debug(`decoder stdin error (diabaikan, ditangani lewat exit code): ${error.message}`);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      reject(new Error(`HTJ2K decoder failed with exit code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`));
    });
    child.stdin.end(input);
  });
}

export async function doWadoRsRendered(opts: RenderedFrameOptions): Promise<BinaryResponse> {
  const { studyInstanceUid, seriesInstanceUid, sopInstanceUid, frame, rows, columns, windowCenter, windowWidth, quality } = opts
  const pathname = await resolveInstancePath(studyInstanceUid, sopInstanceUid)
  if (!pathname) throw new Error('instance not found')

  const stat = await fs.stat(pathname)
  const selectedFrame = parseFrameNumber(frame)
  const cacheKey = `rendered-${renderedFrameCacheVersion}-${pathname}-${selectedFrame}-${rows || 0}-${columns || 0}-${windowCenter ?? 'auto'}-${windowWidth ?? 'auto'}-${quality || 70}`
  const etag = buildWadoEtag(['rendered', renderedFrameCacheVersion, pathname, stat.size, stat.mtimeMs, selectedFrame, rows || 0, columns || 0, windowCenter ?? 'auto', windowWidth ?? 'auto', quality || 70])

  const cached = await getFrameCacheEntryWithDisk(cacheKey, stat.size, stat.mtimeMs)
  if (cached) {
    return { contentType: cached.contentType, buffer: cached.buffer, etag: cached.etag, cacheControl: 'public, max-age=300' }
  }

  const data = await fs.readFile(pathname)
  const dataset = dicomParser.parseDicom(data)
  const pixelDataElement = dataset.elements.x7fe00010
  if (!pixelDataElement) throw new Error('no pixel data')

  const transferSyntax = getTransferSyntax(dataset)
  const isEncapsulated = isEncapsulatedTransferSyntax(transferSyntax)
  let pixelBytes: Buffer

  if (isEncapsulated) {
    pixelBytes = extractEncapsulatedFrame(dataset, pixelDataElement, selectedFrame) ?? extractNativeFrame(dataset, pixelDataElement, selectedFrame)
  } else {
    pixelBytes = extractNativeFrame(dataset, pixelDataElement, selectedFrame)
  }

  const nativeRows = getRows(dataset)
  const nativeCols = getColumns(dataset)
  const bitsAllocated = getBitsAllocated(dataset)
  const samplesPerPixel = getSamplesPerPixel(dataset)
  const pixelRep = dataset.uint16('x00280103') ?? 0

  let rescaleSlope = 1, rescaleIntercept = 0
  const dsSlope = dataset.floatString('x00281053')
  const dsIntercept = dataset.floatString('x00281052')
  if (dsSlope !== undefined) rescaleSlope = Number(dsSlope) || 1
  if (dsIntercept !== undefined) rescaleIntercept = Number(dsIntercept) || 0

  let rendered: Buffer

  if (isEncapsulated && isServerDecodedJpeg2000(transferSyntax)) {
    const expectedByteLength = nativeRows * nativeCols * samplesPerPixel * Math.max(1, Math.ceil(bitsAllocated / 8))
    const nativePixelBytes = await decodeJpeg2000FrameToNative(pixelBytes, expectedByteLength, transferSyntax)
    rendered = await renderPixelDataToJpeg(nativePixelBytes, dataset, {
      rows, columns, windowCenter, windowWidth, quality,
      nativeRows, nativeCols, bitsAllocated, samplesPerPixel, pixelRepresentation: pixelRep,
      rescaleSlope, rescaleIntercept,
    })
  } else if (isEncapsulated && samplesPerPixel === 1) {
    try {
      const needsResize = (rows && rows > 0) || (columns && columns > 0)
      const shouldInvert = isMonochrome1(dataset)
      const canPassThrough = browserDisplayableJpegTransferSyntaxes.has(transferSyntax)
      if (canPassThrough && !needsResize && !shouldInvert && !quality) {
        rendered = pixelBytes
      } else {
        let pipeline = sharp(pixelBytes)
        if (needsResize) {
          const dimensions = getRenderedDimensions(dataset, nativeRows, nativeCols, rows, columns)
          pipeline = pipeline.resize(dimensions.columns, dimensions.rows, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        }
        if (shouldInvert) {
          pipeline = pipeline.negate({ alpha: false })
        }
        rendered = await pipeline.jpeg({ quality: quality || 70 }).toBuffer()
      }
    } catch (error) {
      if (browserDisplayableJpegTransferSyntaxes.has(transferSyntax) && !rows && !columns && !quality && !isMonochrome1(dataset)) {
        rendered = pixelBytes
      } else {
        throw error
      }
    }
  } else {
    rendered = await renderPixelDataToJpeg(pixelBytes, dataset, {
      rows, columns, windowCenter, windowWidth, quality,
      nativeRows, nativeCols, bitsAllocated, samplesPerPixel, pixelRepresentation: pixelRep,
      rescaleSlope, rescaleIntercept,
    })
  }

  const response: BinaryResponse = {
    contentType: 'image/jpeg',
    buffer: rendered,
    etag,
    cacheControl: 'public, max-age=300',
  }

  putFrameCacheEntry(cacheKey, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    bytes: rendered.byteLength,
    contentType: response.contentType,
    buffer: rendered,
    etag,
    lastAccess: Date.now(),
  })

  return response
}

export function getWadoRsRuntimeStats() {
  const total = frameResponseCacheCounters.hits + frameResponseCacheCounters.misses
  return {
    frameResponseCache: {
      backend: 'memory+disk',
      entries: frameResponseCache.size,
      bytes: frameResponseCacheBytes,
      maxBytes: frameCacheMaxBytes,
      hits: frameResponseCacheCounters.hits,
      misses: frameResponseCacheCounters.misses,
      sets: frameResponseCacheCounters.sets,
      evictions: frameResponseCacheCounters.evictions,
      hitRate: total ? Number((frameResponseCacheCounters.hits / total).toFixed(4)) : 0,
    },
    frameDiskCache: getFrameDiskCacheStats(),
    j2kWorkerPool: getJ2kWorkerPoolStats(),
    rawFrameCache: {
      enabled: rawFrameCacheEnabled,
      inFlight: rawFrameInFlight.size,
      decodes: rawFrameCacheCounters.decodes,
      coalesced: rawFrameCacheCounters.coalesced,
    },
    thumbnailFrameCache: {
      inFlight: thumbnailFrameInFlight.size,
      renders: thumbnailFrameCacheCounters.renders,
      coalesced: thumbnailFrameCacheCounters.coalesced,
    },
  }
}
