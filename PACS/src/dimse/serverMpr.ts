import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import { doWadoRsRaw } from './wadoRs';
import { buildViewerStudyManifest } from './viewerManifest';

type Vec3 = [number, number, number];
type MprOrientation = 'axial' | 'sagittal' | 'coronal';
type MprProjection = 'normal' | 'mip' | 'minip' | 'average';

type VolumeGeometry = {
  dimensions: [number, number, number];
  spacing: Vec3;
  origin: Vec3;
  directionX: Vec3;
  directionY: Vec3;
  directionZ: Vec3;
  frameOfReferenceUid: string;
};

type VolumeCacheEntry = {
  cacheKey: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sourceHash: string;
  geometry: VolumeGeometry;
  defaultWindowCenter: number;
  defaultWindowWidth: number;
  status: 'building' | 'ready' | 'error';
  progress: number;
  error?: string;
  voxels?: Int16Array;
  bytes: number;
  createdAt: number;
  lastAccess: number;
  promise: Promise<void>;
  planeCache: Map<string, CachedMprPlane>;
  planeCacheBytes: number;
};

type MprSession = {
  id: string;
  cacheKey: string;
  createdAt: number;
  lastAccess: number;
};

type CachedMprPlane = {
  buffer: Buffer;
  contentType: string;
  bytes: number;
  createdAt: number;
  lastAccess: number;
};

export type ServerMprSessionRequest = {
  studyInstanceUid: string;
  seriesInstanceUid: string;
};

export type ServerMprResliceRequest = {
  orientation?: MprOrientation;
  index?: number;
  maxEdge?: number;
  windowCenter?: number;
  windowWidth?: number;
  quality?: 'preview' | 'diagnostic';
  jpegQuality?: number;
  slabThickness?: number;
  projection?: MprProjection;
  sequenceId?: number;
};

export type ServerMprProxyVolumeRequest = {
  maxEdge?: number;
  maxDepth?: number;
  maxVoxels?: number;
};

export class ServerMprNotReadyError extends Error {
  constructor(public progress: number) {
    super(`MPR volume is still building (${Math.round(progress * 100)}%)`);
  }
}

const volumeCache = new Map<string, VolumeCacheEntry>();
const sessions = new Map<string, MprSession>();
const volumeCacheMaxBytes = Math.max(256, Number(process.env.MPR_VOLUME_CACHE_MB || 1024)) * 1024 * 1024;
const volumeCacheTtlMs = Math.max(60_000, Number(process.env.MPR_VOLUME_CACHE_TTL_MS || 10 * 60_000));
const sessionTtlMs = Math.max(60_000, Number(process.env.MPR_SESSION_TTL_MS || 15 * 60_000));
const decodeConcurrency = Math.max(1, Math.min(12, Number(process.env.MPR_DECODE_CONCURRENCY || 4)));
const planeCacheMaxBytes = Math.max(16, Number(process.env.MPR_PLANE_CACHE_MB || 256)) * 1024 * 1024;
const planeCacheMaxEntries = Math.max(32, Number(process.env.MPR_PLANE_CACHE_ENTRIES || 512));

let volumeCacheBytes = 0;

export async function createServerMprSession(request: ServerMprSessionRequest) {
  const studyInstanceUid = String(request.studyInstanceUid || '').trim();
  const seriesInstanceUid = String(request.seriesInstanceUid || '').trim();
  if (!studyInstanceUid || !seriesInstanceUid) {
    throw new Error('studyInstanceUid and seriesInstanceUid are required');
  }

  const manifest = await buildViewerStudyManifest(studyInstanceUid);
  const series = manifest.series.find((item) => item.seriesInstanceUid === seriesInstanceUid);
  if (!series?.instances?.length) {
    throw new Error('MPR source series was not found');
  }

  const sourceFrames = expandAndSortFrames(series.instances);
  if (sourceFrames.length < 2) {
    throw new Error('MPR requires at least two image frames');
  }

  const geometry = buildVolumeGeometry(sourceFrames);
  const sourceHash = createHash('sha1')
    .update(sourceFrames.map((frame) => `${frame.sopInstanceUid}:${frame.frame}`).join('|'))
    .digest('base64url');
  const cacheKey = `${studyInstanceUid}|${seriesInstanceUid}|${sourceHash}`;
  let entry = volumeCache.get(cacheKey);

  if (!entry) {
    evictExpiredEntries();
    entry = createVolumeEntry({
      cacheKey,
      studyInstanceUid,
      seriesInstanceUid,
      sourceHash,
      sourceFrames,
      geometry,
      defaultWindowCenter: finiteOr(series.windowCenter, 40),
      defaultWindowWidth: Math.max(1, finiteOr(series.windowWidth, 400)),
    });
    volumeCache.set(cacheKey, entry);
  }

  entry.lastAccess = Date.now();
  const session: MprSession = {
    id: randomUUID(),
    cacheKey,
    createdAt: Date.now(),
    lastAccess: Date.now(),
  };
  sessions.set(session.id, session);

  return describeSession(session, entry);
}

export function getServerMprSession(sessionId: string) {
  const { session, entry } = requireSession(sessionId);
  return describeSession(session, entry);
}

export async function renderServerMprPlane(sessionId: string, request: ServerMprResliceRequest) {
  const { entry } = requireSession(sessionId);
  await requireReadyVolume(entry);

  const orientation = normalizeOrientation(request.orientation);
  const plane = createPlaneGeometry(entry.geometry, orientation, request.index, request.maxEdge);
  const projection = normalizeProjection(request.projection);
  const slabThickness = clamp(finiteOr(request.slabThickness, 1), 0.1, 100);
  const windowCenter = finiteOr(request.windowCenter, entry.defaultWindowCenter);
  const windowWidth = Math.max(1, finiteOr(request.windowWidth, entry.defaultWindowWidth));
  const quality = request.quality === 'preview' ? 'preview' : 'diagnostic';
  const jpegQuality = clampInteger(request.jpegQuality, 45, 20, 82);
  const headers = buildPlaneHeaders(entry, plane, request, quality, projection, slabThickness);
  const cacheKey = buildPlaneCacheKey(entry, plane, quality, projection, slabThickness, windowCenter, windowWidth, jpegQuality);
  const cached = getCachedPlane(entry, cacheKey);
  if (cached) {
    return {
      buffer: cached.buffer,
      contentType: cached.contentType,
      cacheControl: 'private, max-age=300',
      etag: buildPlaneEtag(entry, cacheKey),
      headers,
    };
  }

  entry.lastAccess = Date.now();
  const pixels = resliceVolume(entry, plane, projection, slabThickness);
  if (quality === 'preview') {
    const displayPixels = windowInt16Pixels(pixels, windowCenter, windowWidth);
    const buffer = await sharp(Buffer.from(displayPixels), {
      raw: { width: plane.columns, height: plane.rows, channels: 1 },
    }).jpeg({ quality: jpegQuality, chromaSubsampling: '4:4:4' }).toBuffer();
    storeCachedPlane(entry, cacheKey, buffer, 'image/jpeg');

    return {
      buffer,
      contentType: 'image/jpeg',
      cacheControl: 'private, max-age=300',
      etag: buildPlaneEtag(entry, cacheKey),
      headers,
    };
  }

  const buffer = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  storeCachedPlane(entry, cacheKey, buffer, 'application/vnd.vexa.mpr-plane+int16');

  return {
    buffer,
    contentType: 'application/vnd.vexa.mpr-plane+int16',
    cacheControl: 'private, max-age=300',
    etag: buildPlaneEtag(entry, cacheKey),
    headers,
  };
}

export async function probeServerMprVolume(sessionId: string, world: unknown) {
  const { entry } = requireSession(sessionId);
  await requireReadyVolume(entry);
  if (!Array.isArray(world) || world.length !== 3 || !world.every((value) => Number.isFinite(Number(value)))) {
    throw new Error('world must contain three finite coordinates');
  }

  const point = world.map(Number) as Vec3;
  const index = worldToContinuousIndex(entry.geometry, point);
  const value = sampleTrilinear(entry.voxels!, entry.geometry.dimensions, index[0], index[1], index[2]);
  entry.lastAccess = Date.now();
  return {
    value: Math.round(value * 10) / 10,
    unit: 'HU',
    world: point,
    index: index.map((coordinate) => Math.round(coordinate * 1000) / 1000),
    sourceHash: entry.sourceHash,
  };
}

export async function exportServerMprProxyVolume(sessionId: string, request: ServerMprProxyVolumeRequest = {}) {
  const { entry } = requireSession(sessionId);
  await requireReadyVolume(entry);

  const [sourceColumns, sourceRows, sourceDepth] = entry.geometry.dimensions;
  const maxEdge = clampInteger(request.maxEdge, 256, 96, 512);
  const maxDepth = clampInteger(request.maxDepth, 192, 32, 512);
  const maxVoxels = clampInteger(request.maxVoxels, 12_000_000, 1_000_000, 48_000_000);
  let scaleFactor = Math.max(sourceColumns / maxEdge, sourceRows / maxEdge, sourceDepth / maxDepth, 1);
  let columns = Math.max(2, Math.round(sourceColumns / scaleFactor));
  let rows = Math.max(2, Math.round(sourceRows / scaleFactor));
  let depth = Math.max(2, Math.round(sourceDepth / scaleFactor));

  while (columns * rows * depth > maxVoxels) {
    scaleFactor *= 1.08;
    columns = Math.max(2, Math.round(sourceColumns / scaleFactor));
    rows = Math.max(2, Math.round(sourceRows / scaleFactor));
    depth = Math.max(2, Math.round(sourceDepth / scaleFactor));
  }

  const proxy = new Int16Array(columns * rows * depth);
  const source = entry.voxels!;
  let targetOffset = 0;
  for (let z = 0; z < depth; z += 1) {
    const sourceZ = Math.round((z * (sourceDepth - 1)) / Math.max(1, depth - 1));
    const sourceSliceOffset = sourceZ * sourceRows * sourceColumns;
    for (let y = 0; y < rows; y += 1) {
      const sourceY = Math.round((y * (sourceRows - 1)) / Math.max(1, rows - 1));
      const sourceRowOffset = sourceSliceOffset + sourceY * sourceColumns;
      for (let x = 0; x < columns; x += 1) {
        const sourceX = Math.round((x * (sourceColumns - 1)) / Math.max(1, columns - 1));
        proxy[targetOffset++] = source[sourceRowOffset + sourceX];
      }
    }
  }

  const header = {
    version: 1,
    sourceHash: entry.sourceHash,
    sourceDimensions: entry.geometry.dimensions,
    dimensions: [columns, rows, depth] as [number, number, number],
    spacing: [
      entry.geometry.spacing[0] * sourceColumns / Math.max(1, columns),
      entry.geometry.spacing[1] * sourceRows / Math.max(1, rows),
      entry.geometry.spacing[2] * sourceDepth / Math.max(1, depth),
    ] as Vec3,
    origin: entry.geometry.origin,
    directionX: entry.geometry.directionX,
    directionY: entry.geometry.directionY,
    directionZ: entry.geometry.directionZ,
    direction: [
      ...entry.geometry.directionX,
      ...entry.geometry.directionY,
      ...entry.geometry.directionZ,
    ],
    frameOfReferenceUid: entry.geometry.frameOfReferenceUid,
    defaultWindowCenter: entry.defaultWindowCenter,
    defaultWindowWidth: entry.defaultWindowWidth,
    metadata: {
      modality: 'CT',
      samplesPerPixel: 1,
      bitsAllocated: 16,
      bitsStored: 16,
      highBit: 15,
      pixelRepresentation: 1,
      photometricInterpretation: 'MONOCHROME2',
    },
    bytes: proxy.byteLength,
  };
  const headerJson = JSON.stringify(header);
  const headerBuffer = Buffer.from(headerJson.length % 2 === 0 ? headerJson : `${headerJson} `, 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(headerBuffer.byteLength, 0);
  const voxelBuffer = Buffer.from(proxy.buffer, proxy.byteOffset, proxy.byteLength);
  const buffer = Buffer.concat([prefix, headerBuffer, voxelBuffer], prefix.byteLength + headerBuffer.byteLength + voxelBuffer.byteLength);
  const etag = `"mpr-proxy-${createHash('sha1').update(`${entry.cacheKey}|${entry.sourceHash}|${columns}x${rows}x${depth}`).digest('base64url')}"`;

  entry.lastAccess = Date.now();
  return {
    buffer,
    contentType: 'application/vnd.vexa.mpr-proxy-volume',
    cacheControl: 'private, max-age=600',
    etag,
  };
}

export function getServerMprRuntimeStats() {
  evictExpiredEntries();
  return {
    sessions: sessions.size,
    cacheEntries: volumeCache.size,
    cacheBytes: volumeCacheBytes,
    cacheMaxBytes: volumeCacheMaxBytes,
    entries: [...volumeCache.values()].map((entry) => ({
      studyInstanceUid: entry.studyInstanceUid,
      seriesInstanceUid: entry.seriesInstanceUid,
      status: entry.status,
      progress: entry.progress,
      bytes: entry.bytes,
      planeCacheBytes: entry.planeCacheBytes,
      planeCacheEntries: entry.planeCache.size,
      ageMs: Date.now() - entry.createdAt,
      idleMs: Date.now() - entry.lastAccess,
    })),
  };
}

function createVolumeEntry(input: {
  cacheKey: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sourceHash: string;
  sourceFrames: ReturnType<typeof expandAndSortFrames>;
  geometry: VolumeGeometry;
  defaultWindowCenter: number;
  defaultWindowWidth: number;
}): VolumeCacheEntry {
  const entry = {
    cacheKey: input.cacheKey,
    studyInstanceUid: input.studyInstanceUid,
    seriesInstanceUid: input.seriesInstanceUid,
    sourceHash: input.sourceHash,
    geometry: input.geometry,
    defaultWindowCenter: input.defaultWindowCenter,
    defaultWindowWidth: input.defaultWindowWidth,
    status: 'building' as const,
    progress: 0,
    bytes: 0,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    promise: Promise.resolve(),
    planeCache: new Map(),
    planeCacheBytes: 0,
  } as VolumeCacheEntry;

  entry.promise = loadVolume(entry, input.sourceFrames)
    .then(() => {
      entry.status = 'ready';
      entry.progress = 1;
      entry.bytes = entry.voxels?.byteLength || 0;
      volumeCacheBytes += entry.bytes;
      evictToBudget(entry.cacheKey);
    })
    .catch((error) => {
      entry.status = 'error';
      entry.error = error instanceof Error ? error.message : String(error);
    });
  return entry;
}

async function loadVolume(entry: VolumeCacheEntry, frames: ReturnType<typeof expandAndSortFrames>) {
  const [columns, rows, depth] = entry.geometry.dimensions;
  const sliceLength = rows * columns;
  const voxels = new Int16Array(sliceLength * depth);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const frameIndex = cursor++;
      if (frameIndex >= frames.length) return;
      const frame = frames[frameIndex];
      const decoded = await doWadoRsRaw({
        studyInstanceUid: entry.studyInstanceUid,
        seriesInstanceUid: entry.seriesInstanceUid,
        sopInstanceUid: frame.sopInstanceUid,
        frame: String(frame.frame),
      });
      if (decoded.rows !== rows || decoded.columns !== columns) {
        throw new Error(`MPR source dimensions changed at frame ${frameIndex + 1}`);
      }

      const view = new DataView(decoded.buffer.buffer, decoded.buffer.byteOffset, decoded.buffer.byteLength);
      const available = Math.min(sliceLength, Math.floor(decoded.buffer.byteLength / Float32Array.BYTES_PER_ELEMENT));
      const offset = frameIndex * sliceLength;
      for (let pixelIndex = 0; pixelIndex < available; pixelIndex += 1) {
        const value = view.getFloat32(pixelIndex * Float32Array.BYTES_PER_ELEMENT, true);
        voxels[offset + pixelIndex] = clampInteger(value, 0, -32768, 32767);
      }
      entry.progress = (frameIndex + 1) / frames.length;
      entry.lastAccess = Date.now();
    }
  };

  await Promise.all(Array.from({ length: Math.min(decodeConcurrency, frames.length) }, () => worker()));
  entry.voxels = voxels;
}

function expandAndSortFrames(instances: Array<{
  sopInstanceUid: string;
  seriesInstanceUid: string;
  instanceNumber: number;
  numberOfFrames: number;
  rows: number;
  columns: number;
  metadata: Record<string, { Value?: unknown[] }>;
}>) {
  const sorted = [...instances].sort((a, b) => {
    const orientation = readNumberArray(a.metadata, '00200037');
    const normal = orientation.length === 6
      ? normalize(cross(orientation.slice(0, 3) as Vec3, orientation.slice(3, 6) as Vec3))
      : [0, 0, 1] as Vec3;
    const aPosition = readNumberArray(a.metadata, '00200032') as Vec3;
    const bPosition = readNumberArray(b.metadata, '00200032') as Vec3;
    const aLocation = aPosition.length === 3 ? dot(aPosition, normal) : a.instanceNumber;
    const bLocation = bPosition.length === 3 ? dot(bPosition, normal) : b.instanceNumber;
    return aLocation - bLocation || a.instanceNumber - b.instanceNumber;
  });

  return sorted.flatMap((instance) => Array.from({ length: Math.max(1, instance.numberOfFrames || 1) }, (_, frameIndex) => ({
    ...instance,
    frame: frameIndex + 1,
  })));
}

function buildVolumeGeometry(frames: ReturnType<typeof expandAndSortFrames>): VolumeGeometry {
  const first = frames[0];
  const orientation = readNumberArray(first.metadata, '00200037');
  const directionX = normalize((orientation.length === 6 ? orientation.slice(0, 3) : [1, 0, 0]) as Vec3);
  const directionY = normalize((orientation.length === 6 ? orientation.slice(3, 6) : [0, 1, 0]) as Vec3);
  let directionZ = normalize(cross(directionX, directionY));
  const firstPosition = readNumberArray(first.metadata, '00200032');
  const lastPosition = readNumberArray(frames[frames.length - 1].metadata, '00200032');
  if (firstPosition.length === 3 && lastPosition.length === 3 && dot(subtract(lastPosition as Vec3, firstPosition as Vec3), directionZ) < 0) {
    directionZ = scale(directionZ, -1);
  }

  const pixelSpacing = readNumberArray(first.metadata, '00280030');
  const rowSpacing = positiveOr(pixelSpacing[0], 1);
  const columnSpacing = positiveOr(pixelSpacing[1], rowSpacing);
  const sliceLocations = frames
    .map((frame) => readNumberArray(frame.metadata, '00200032'))
    .filter((position) => position.length === 3)
    .map((position) => dot(position as Vec3, directionZ));
  const sliceDistances = sliceLocations.slice(1)
    .map((position, index) => Math.abs(position - sliceLocations[index]))
    .filter((distance) => distance > 0.0001)
    .sort((a, b) => a - b);
  const spacingZ = positiveOr(
    sliceDistances.length ? sliceDistances[Math.floor(sliceDistances.length / 2)] : 0,
    positiveOr(readNumber(first.metadata, '00180088'), positiveOr(readNumber(first.metadata, '00180050'), 1)),
  );

  return {
    dimensions: [first.columns, first.rows, frames.length],
    spacing: [columnSpacing, rowSpacing, spacingZ],
    origin: (firstPosition.length === 3 ? firstPosition : [0, 0, 0]) as Vec3,
    directionX,
    directionY,
    directionZ,
    frameOfReferenceUid: readString(first.metadata, '00200052') || `vexa-mpr-${first.seriesInstanceUid}`,
  };
}

function createPlaneGeometry(geometry: VolumeGeometry, orientation: MprOrientation, requestedIndex?: number, requestedMaxEdge?: number) {
  const [columns, rows, depth] = geometry.dimensions;
  const [spacingX, spacingY, spacingZ] = geometry.spacing;
  const extentX = Math.max(spacingX, (columns - 1) * spacingX);
  const extentY = Math.max(spacingY, (rows - 1) * spacingY);
  const extentZ = Math.max(spacingZ, (depth - 1) * spacingZ);
  const volumeCenter = add(
    add(add(geometry.origin, scale(geometry.directionX, extentX / 2)), scale(geometry.directionY, extentY / 2)),
    scale(geometry.directionZ, extentZ / 2),
  );

  let axisLength: number;
  let maxIndex: number;
  let u: Vec3;
  let v: Vec3;
  let normal: Vec3;
  let physicalWidth: number;
  let physicalHeight: number;

  if (orientation === 'sagittal') {
    axisLength = spacingX;
    maxIndex = columns - 1;
    normal = geometry.directionX;
    u = scale(geometry.directionY, -1);
    v = scale(geometry.directionZ, -1);
    physicalWidth = extentY;
    physicalHeight = extentZ;
  } else if (orientation === 'coronal') {
    axisLength = spacingY;
    maxIndex = rows - 1;
    normal = geometry.directionY;
    u = geometry.directionX;
    v = scale(geometry.directionZ, -1);
    physicalWidth = extentX;
    physicalHeight = extentZ;
  } else {
    axisLength = spacingZ;
    maxIndex = depth - 1;
    normal = geometry.directionZ;
    u = geometry.directionX;
    v = geometry.directionY;
    physicalWidth = extentX;
    physicalHeight = extentY;
  }

  const index = clampInteger(requestedIndex, Math.floor(maxIndex / 2), 0, maxIndex);
  const center = add(volumeCenter, scale(normal, (index - maxIndex / 2) * axisLength));
  const maxEdge = clampInteger(requestedMaxEdge, 512, 128, 768);
  let outputColumns: number;
  let outputRows: number;
  if (physicalWidth >= physicalHeight) {
    outputColumns = maxEdge;
    outputRows = Math.max(64, Math.round(maxEdge * physicalHeight / physicalWidth));
  } else {
    outputRows = maxEdge;
    outputColumns = Math.max(64, Math.round(maxEdge * physicalWidth / physicalHeight));
  }
  const columnPixelSpacing = physicalWidth / Math.max(1, outputColumns - 1);
  const rowPixelSpacing = physicalHeight / Math.max(1, outputRows - 1);
  const imagePositionPatient = subtract(
    subtract(center, scale(u, physicalWidth / 2)),
    scale(v, physicalHeight / 2),
  );
  const geometryHash = createHash('sha1')
    .update(JSON.stringify({ orientation, index, center, u, v, normal, physicalWidth, physicalHeight }))
    .digest('base64url');

  return {
    orientation,
    index,
    maxIndex,
    rows: outputRows,
    columns: outputColumns,
    rowPixelSpacing,
    columnPixelSpacing,
    imagePositionPatient,
    rowDirection: u,
    columnDirection: v,
    normal,
    geometryHash,
  };
}

function resliceVolume(
  entry: VolumeCacheEntry,
  plane: ReturnType<typeof createPlaneGeometry>,
  projection: MprProjection,
  slabThickness: number,
) {
  const output = new Int16Array(plane.rows * plane.columns);
  const sampleSpacing = Math.max(0.25, Math.min(...entry.geometry.spacing));
  const sampleCount = projection === 'normal' ? 1 : clampInteger(Math.ceil(slabThickness / sampleSpacing), 1, 1, 64);
  const slabStart = -((sampleCount - 1) * sampleSpacing) / 2;
  let outputIndex = 0;

  for (let row = 0; row < plane.rows; row += 1) {
    for (let column = 0; column < plane.columns; column += 1) {
      const world = add(
        add(plane.imagePositionPatient, scale(plane.rowDirection, column * plane.columnPixelSpacing)),
        scale(plane.columnDirection, row * plane.rowPixelSpacing),
      );
      let aggregate = projection === 'minip' ? Number.POSITIVE_INFINITY : projection === 'mip' ? Number.NEGATIVE_INFINITY : 0;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const sampleWorld = sampleCount === 1 ? world : add(world, scale(plane.normal, slabStart + sample * sampleSpacing));
        const [x, y, z] = worldToContinuousIndex(entry.geometry, sampleWorld);
        const value = sampleTrilinear(entry.voxels!, entry.geometry.dimensions, x, y, z);
        if (projection === 'mip') aggregate = Math.max(aggregate, value);
        else if (projection === 'minip') aggregate = Math.min(aggregate, value);
        else aggregate += value;
      }
      if (projection === 'average') aggregate /= sampleCount;
      output[outputIndex++] = clampInteger(aggregate, 0, -32768, 32767);
    }
  }
  return output;
}

function worldToContinuousIndex(geometry: VolumeGeometry, world: Vec3): Vec3 {
  const delta = subtract(world, geometry.origin);
  return [
    dot(delta, geometry.directionX) / geometry.spacing[0],
    dot(delta, geometry.directionY) / geometry.spacing[1],
    dot(delta, geometry.directionZ) / geometry.spacing[2],
  ];
}

function sampleTrilinear(voxels: Int16Array, dimensions: [number, number, number], x: number, y: number, z: number) {
  const [columns, rows, depth] = dimensions;
  if (x < 0 || y < 0 || z < 0 || x > columns - 1 || y > rows - 1 || z > depth - 1) return -1024;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(columns - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1), z1 = Math.min(depth - 1, z0 + 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const at = (ix: number, iy: number, iz: number) => voxels[iz * rows * columns + iy * columns + ix];
  const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
  const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
  const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
  const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
  const c0 = c00 * (1 - fy) + c10 * fy;
  const c1 = c01 * (1 - fy) + c11 * fy;
  return c0 * (1 - fz) + c1 * fz;
}

function windowInt16Pixels(pixels: Int16Array, center: number, width: number) {
  const lower = center - width / 2;
  const scaleValue = 255 / Math.max(1, width);
  const output = new Uint8Array(pixels.length);
  for (let index = 0; index < pixels.length; index += 1) {
    output[index] = clampInteger((pixels[index] - lower) * scaleValue, 0, 0, 255);
  }
  return output;
}

function buildPlaneCacheKey(
  entry: VolumeCacheEntry,
  plane: ReturnType<typeof createPlaneGeometry>,
  quality: 'preview' | 'diagnostic',
  projection: MprProjection,
  slabThickness: number,
  windowCenter: number,
  windowWidth: number,
  jpegQuality: number,
) {
  const values = [
    entry.sourceHash,
    quality,
    plane.orientation,
    plane.index,
    plane.rows,
    plane.columns,
    projection,
    stableCacheNumber(slabThickness),
  ];
  if (quality === 'preview') {
    values.push(stableCacheNumber(windowCenter), stableCacheNumber(windowWidth), String(jpegQuality));
  }
  return values.join('|');
}

function buildPlaneEtag(entry: VolumeCacheEntry, cacheKey: string) {
  return `"mpr-${createHash('sha1').update(`${entry.cacheKey}|${cacheKey}`).digest('base64url')}"`;
}

function getCachedPlane(entry: VolumeCacheEntry, cacheKey: string) {
  const cached = entry.planeCache.get(cacheKey);
  if (!cached) return null;
  cached.lastAccess = Date.now();
  entry.planeCache.delete(cacheKey);
  entry.planeCache.set(cacheKey, cached);
  entry.lastAccess = Date.now();
  return cached;
}

function storeCachedPlane(entry: VolumeCacheEntry, cacheKey: string, buffer: Buffer, contentType: string) {
  if (buffer.byteLength > planeCacheMaxBytes) return;
  const previous = entry.planeCache.get(cacheKey);
  if (previous) {
    entry.planeCacheBytes = Math.max(0, entry.planeCacheBytes - previous.bytes);
    entry.planeCache.delete(cacheKey);
  }
  const cached = {
    buffer,
    contentType,
    bytes: buffer.byteLength,
    createdAt: Date.now(),
    lastAccess: Date.now(),
  };
  entry.planeCache.set(cacheKey, cached);
  entry.planeCacheBytes += cached.bytes;
  evictPlaneCache(entry);
}

function evictPlaneCache(entry: VolumeCacheEntry) {
  while (entry.planeCacheBytes > planeCacheMaxBytes || entry.planeCache.size > planeCacheMaxEntries) {
    const oldestKey = entry.planeCache.keys().next().value;
    if (!oldestKey) return;
    const oldest = entry.planeCache.get(oldestKey);
    if (oldest) entry.planeCacheBytes = Math.max(0, entry.planeCacheBytes - oldest.bytes);
    entry.planeCache.delete(oldestKey);
  }
}

function stableCacheNumber(value: number) {
  return String(Math.round(Number(value || 0) * 1000) / 1000);
}

function buildPlaneHeaders(
  entry: VolumeCacheEntry,
  plane: ReturnType<typeof createPlaneGeometry>,
  request: ServerMprResliceRequest,
  quality: 'preview' | 'diagnostic',
  projection: MprProjection,
  slabThickness: number,
) {
  return {
    'X-MPR-Rows': String(plane.rows),
    'X-MPR-Columns': String(plane.columns),
    'X-MPR-Row-Spacing': String(plane.rowPixelSpacing),
    'X-MPR-Column-Spacing': String(plane.columnPixelSpacing),
    'X-MPR-Image-Position': plane.imagePositionPatient.join(','),
    'X-MPR-Image-Orientation': [...plane.rowDirection, ...plane.columnDirection].join(','),
    'X-MPR-Frame-Of-Reference': entry.geometry.frameOfReferenceUid,
    'X-MPR-Geometry-Hash': plane.geometryHash,
    'X-MPR-Source-Hash': entry.sourceHash,
    'X-MPR-Orientation': plane.orientation,
    'X-MPR-Index': String(plane.index),
    'X-MPR-Max-Index': String(plane.maxIndex),
    'X-MPR-Quality': quality,
    'X-MPR-Lossy': quality === 'preview' ? 'true' : 'false',
    'X-MPR-Pixel-Semantics': quality === 'preview' ? 'display' : 'modality',
    'X-MPR-Pixel-Type': quality === 'preview' ? 'uint8-display' : 'int16-hu',
    'X-MPR-Projection': projection,
    'X-MPR-Slab-Thickness': String(slabThickness),
    'X-MPR-Sequence-Id': String(clampInteger(request.sequenceId, 0, 0, Number.MAX_SAFE_INTEGER)),
    'Access-Control-Expose-Headers': '*',
  };
}

function describeSession(session: MprSession, entry: VolumeCacheEntry) {
  session.lastAccess = Date.now();
  entry.lastAccess = Date.now();
  const [columns, rows, depth] = entry.geometry.dimensions;
  return {
    volumeSessionId: session.id,
    status: entry.status,
    progress: entry.progress,
    error: entry.error,
    sourceHash: entry.sourceHash,
    geometry: entry.geometry,
    defaultWindowCenter: entry.defaultWindowCenter,
    defaultWindowWidth: entry.defaultWindowWidth,
    planes: {
      axial: createPlaneGeometry(entry.geometry, 'axial', Math.floor(depth / 2), 512),
      sagittal: createPlaneGeometry(entry.geometry, 'sagittal', Math.floor(columns / 2), 512),
      coronal: createPlaneGeometry(entry.geometry, 'coronal', Math.floor(rows / 2), 512),
    },
  };
}

function requireSession(sessionId: string) {
  evictExpiredEntries();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('MPR session not found or expired');
  const entry = volumeCache.get(session.cacheKey);
  if (!entry) throw new Error('MPR volume cache entry is unavailable');
  session.lastAccess = Date.now();
  entry.lastAccess = Date.now();
  return { session, entry };
}

async function requireReadyVolume(entry: VolumeCacheEntry) {
  if (entry.status === 'error') throw new Error(entry.error || 'MPR volume failed to build');
  if (entry.status !== 'ready' || !entry.voxels) throw new ServerMprNotReadyError(entry.progress);
}

function evictExpiredEntries() {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.lastAccess > sessionTtlMs) sessions.delete(sessionId);
  }
  const activeKeys = new Set([...sessions.values()].map((session) => session.cacheKey));
  for (const [cacheKey, entry] of volumeCache) {
    if (!activeKeys.has(cacheKey) && now - entry.lastAccess > volumeCacheTtlMs && entry.status !== 'building') {
      removeVolumeEntry(cacheKey, entry);
    }
  }
}

function evictToBudget(protectedKey: string) {
  const candidates = [...volumeCache.entries()]
    .filter(([key, entry]) => key !== protectedKey && entry.status === 'ready')
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  while (volumeCacheBytes > volumeCacheMaxBytes && candidates.length) {
    const [key, entry] = candidates.shift()!;
    removeVolumeEntry(key, entry);
  }
}

function removeVolumeEntry(cacheKey: string, entry: VolumeCacheEntry) {
  volumeCache.delete(cacheKey);
  volumeCacheBytes = Math.max(0, volumeCacheBytes - entry.bytes);
  entry.planeCache.clear();
  entry.planeCacheBytes = 0;
  entry.voxels = undefined;
}

function normalizeOrientation(value: unknown): MprOrientation {
  return value === 'sagittal' || value === 'coronal' ? value : 'axial';
}

function normalizeProjection(value: unknown): MprProjection {
  return value === 'mip' || value === 'minip' || value === 'average' ? value : 'normal';
}

function readString(metadata: Record<string, { Value?: unknown[] }>, tag: string) {
  const value = metadata?.[tag]?.Value?.[0];
  return value === undefined || value === null ? '' : String(value);
}

function readNumber(metadata: Record<string, { Value?: unknown[] }>, tag: string) {
  return finiteOr(readString(metadata, tag), 0);
}

function readNumberArray(metadata: Record<string, { Value?: unknown[] }>, tag: string) {
  const values = metadata?.[tag]?.Value;
  return Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
}

function finiteOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return Math.round(clamp(finiteOr(value, fallback), minimum, maximum));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}
