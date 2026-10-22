import { cache, imageLoader, metaData, volumeLoader, type Types } from '@cornerstonejs/core'
import { Enums as ToolEnums, segmentation } from '@cornerstonejs/tools'
import { segmentation as segmentationUtilities } from '@cornerstonejs/tools/utilities'
import {
  applyLassoToBaseMask,
  applyMagneticBoundaryDrag,
  computeGradientMagnitude,
  magneticSnapPolygon,
  magneticSnapPolyline,
  rasterizeLassoPath,
  type IchLassoPoint,
} from './ichMagneticLasso'
import { adaptiveHuEdgeGrow } from './ichMaskRefine'

export const ICH_SEGMENT_INDEX = 1
export const ICH_DEFAULT_BRUSH_SIZE = 18
export const ICH_DEFAULT_OPACITY = 0.42
export const ICH_DEFAULT_THRESHOLD_MIN = 40
export const ICH_DEFAULT_THRESHOLD_MAX = 80

const ICH_SEGMENT_COLOR: Types.Color = [244, 63, 94, 255]
const ICH_COLOR_LUT: Types.ColorLUT = [
  [0, 0, 0, 0],
  ICH_SEGMENT_COLOR,
]

type EnsureIchSegmentationOptions = {
  referencedVolumeId: string
  viewportIds: string[]
  toolGroupId: string
  brushSize?: number
  opacity?: number
}

type EnsureIchStackSegmentationOptions = {
  sourceKey: string
  referencedImageIds: string[]
  viewportId: string
  toolGroupId: string
  brushSize?: number
  opacity?: number
}

type IchSegmentationState = {
  segmentationId: string
  labelmapVolumeId?: string
  labelmapImageIds?: string[]
}

type StackThresholdProgress = {
  matchedVoxels: number
  processedSlices: number
  totalSlices: number
  skippedSlices: number
}

export type IchThresholdResult = StackThresholdProgress & {
  canceled: boolean
  volumeMl: number | null
}

export type IchRegionGrowResult = {
  matchedVoxels: number
  reachedLimit: boolean
  seedAccepted: boolean
  volumeMl: number | null
}

export type IchSmartDragResult = IchRegionGrowResult & {
  acceptedVoxels: number
  radiusPx: number
  minimumHu: number
  maximumHu: number
  meanHu: number | null
  stdDevHu: number | null
  adaptiveModel: IchAdaptiveHuModel | null
  totalVoxels: number
  totalVolumeMl: number | null
}

export type IchAdaptiveStackGrowResult = StackThresholdProgress & {
  canceled: boolean
  stoppedByLeakage: boolean
  volumeMl: number | null
  adaptiveModel: IchAdaptiveHuModel | null
  totalVoxels: number
  totalVolumeMl: number | null
}

export type IchStackSegmentStats = {
  voxelCount: number
  volumeMl: number | null
}

export type IchAdaptiveHuModel = {
  meanHu: number
  stdDevHu: number
  samples: number
  minimumHu: number
  maximumHu: number
}

export type IchVolumeHuLineSampleResult = {
  adaptiveModel: IchAdaptiveHuModel | null
  samples: number
  meanHu: number | null
  stdDevHu: number | null
  minimumHu: number | null
  maximumHu: number | null
}

export type IchForbiddenRegion = {
  sliceIndex: number
  center: Types.Point2
  radiusPx: number
}

export type IchVolumeForbiddenRegion = {
  centerIJK: Types.Point3
  radiusVoxels: number
}

export type IchStackSnapshot = {
  slices: Array<{
    imageId: string
    indices: Uint32Array
  }>
}

export type IchVolumeSnapshot = {
  volumeId: string
  indices: Uint32Array
}

export type IchVolumeSegmentStats = {
  voxelCount: number
  volumeMl: number | null
}

export type IchVolumeDicomExportData = {
  labelmapVolumeId: string
  dimensions: Types.Point3
  spacing: Types.Point3
  scalarData: Uint8Array
  sourceImageIds: string[]
  sourceImages: unknown[]
}

export type IchVolumeSmartDragResult = IchRegionGrowResult & {
  acceptedVoxels: number
  radiusVoxels: number
  minimumHu: number
  maximumHu: number
  meanHu: number | null
  stdDevHu: number | null
  adaptiveModel: IchAdaptiveHuModel | null
  totalVoxels: number
  totalVolumeMl: number | null
  failureReason?: 'volume-context-missing' | 'world-to-ijk-failed' | 'seed-hu-invalid' | 'seed-out-of-range'
}

type Bounds2D = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

type VolumeAxis = 0 | 1 | 2

type ScribbleVolumePlane = {
  fixedAxis: VolumeAxis
  uAxis: VolumeAxis
  vAxis: VolumeAxis
  fixedIndex: number
  uSize: number
  vSize: number
}

type LocalSeedHuModel = {
  mean: number
  standardDeviation: number
  lowerPercentile: number
  upperPercentile: number
  samples: number
}

type StackSliceContext = {
  sourceImageId: string
  sourceImage: ThresholdImage
  labelmapImage: ThresholdImage
  sourcePixels: MutableScalarData
  labelmapPixels: MutableScalarData
  width: number
  height: number
  slope: number
  intercept: number
  voxelVolumeMm3: number
}

type VolumeContext = {
  sourceVolume: ThresholdVolume
  labelmapVolume: ThresholdVolume
  sourcePixels: MutableScalarData | null
  labelmapPixels: MutableScalarData | null
  dimensions: Types.Point3
  spacing: Types.Point3
  slope: number
  intercept: number
  voxelCount: number
  voxelVolumeMm3: number
}

type InternalRegionGrowResult = IchRegionGrowResult & {
  acceptedVoxels: number
  meanHu: number | null
  stdDevHu: number | null
  bounds: Bounds2D | null
  centroid: Types.Point2 | null
}

type InternalVolumeRegionGrowResult = IchRegionGrowResult & {
  acceptedVoxels: number
  meanHu: number | null
  stdDevHu: number | null
  modifiedSlices: number[]
  modifiedIndices: number[]
  addedIndices: number[]
  removedIndices: number[]
}

type IchVolumeStatsCacheEntry = {
  voxelCount: number
  voxelVolumeMm3: number
  indices: Set<number>
}

const ichVolumeStatsCache = new Map<string, IchVolumeStatsCacheEntry>()

type ApplyIchThresholdToStackOptions = {
  segmentationId: string
  referencedImageIds: string[]
  sliceIndexes: number[]
  minimumHu: number
  maximumHu: number
  replace?: boolean
  onProgress?: (progress: StackThresholdProgress) => void
  shouldCancel?: () => boolean
}

type ApplyIchRegionGrowToStackSliceOptions = {
  segmentationId: string
  referencedImageIds: string[]
  sliceIndex: number
  seedPoint: Types.Point2
  minimumHu: number
  maximumHu: number
  mode?: 'add' | 'erase'
  maxVoxels?: number
}

type ApplyIchSmartDragToStackSliceOptions = {
  segmentationId: string
  referencedImageIds: string[]
  sliceIndex: number
  seedPoint: Types.Point2
  dragPoint: Types.Point2
  mode?: 'add' | 'erase'
  minimumHu?: number
  maximumHu?: number
  adaptiveModel?: IchAdaptiveHuModel | null
  maxRadiusPx?: number
  maxVoxels?: number
}

type ApplyIchVolumeSmartDragOptions = {
  segmentationId: string
  referencedVolumeId: string
  seedWorld: Types.Point3
  dragWorld: Types.Point3
  mode?: 'add' | 'erase'
  minimumHu?: number
  maximumHu?: number
  adaptiveModel?: IchAdaptiveHuModel | null
  forbiddenRegions?: IchVolumeForbiddenRegion[]
  minRadiusVoxels?: number
  maxRadiusVoxels?: number
  clearRadiusVoxels?: number
  maxVoxels?: number
}

type ApplyIchVolumeHuLineMaskOptions = {
  segmentationId: string
  referencedVolumeId: string
  startWorld: Types.Point3
  endWorld: Types.Point3
  adaptiveModel?: IchAdaptiveHuModel | null
  forbiddenRegions?: IchVolumeForbiddenRegion[]
  minRadiusVoxels?: number
  maxRadiusVoxels?: number
  maxVoxels?: number
}

type ApplyIchVolumeScribbleExtractMaskOptions = {
  segmentationId: string
  referencedVolumeId: string
  scribbleWorldPoints: Types.Point3[]
  adaptiveModel?: IchAdaptiveHuModel | null
  forbiddenRegions?: IchVolumeForbiddenRegion[]
  seedRadiusVoxels?: number
  roiMarginVoxels?: number
  maxVoxels?: number
}

type ApplyIchAdaptiveRegionGrowToStackOptions = {
  segmentationId: string
  referencedImageIds: string[]
  seedSliceIndex: number
  seedPoint: Types.Point2
  minimumHu: number
  maximumHu: number
  roiMargin?: number
  localToleranceHu?: number
  maxVoxelsPerSlice?: number
  maxAreaGrowthFactor?: number
  minVoxelsPerSlice?: number
  replaceExisting?: boolean
  adaptiveModel?: IchAdaptiveHuModel | null
  forbiddenRegions?: IchForbiddenRegion[]
  onProgress?: (progress: StackThresholdProgress) => void
  shouldCancel?: () => boolean
}

type DistanceWeightingOptions = {
  targetHu: number
  baseToleranceHu: number
  radiusPx: number
  floorRatio?: number
}

type GrowIchRegionOnSliceOptions = {
  seedPoint: Types.Point2
  lower: number
  upper: number
  mode?: 'add' | 'erase'
  maxVoxels?: number
  minVoxels?: number
  roiBounds?: Bounds2D
  rejectOnLimit?: boolean
  maxDistancePx?: number
  gradientStop?: number
  seedHu?: number
  distanceWeighting?: DistanceWeightingOptions
  forbiddenRegions?: Array<Pick<IchForbiddenRegion, 'center' | 'radiusPx'>>
}

type GrowIchRegionInVolumeOptions = {
  seedIJK: Types.Point3
  lower: number
  upper: number
  mode?: 'add' | 'erase'
  maxVoxels?: number
  minVoxels?: number
  maxDistanceVoxels: number
  gradientStop?: number
  gradientDistanceRatio?: number
  seedHu?: number
  distanceWeighting?: DistanceWeightingOptions
  forbiddenRegions?: IchVolumeForbiddenRegion[]
}

type ThresholdImage = {
  imageId?: string
  getPixelData?: () => ArrayLike<number>
  voxelManager?: {
    getScalarData?: () => ArrayLike<number>
    getScalarDataLength?: () => number
    getAtIndex?: (index: number) => unknown
    setAtIndex?: (index: number, value: number) => unknown
    forEach?: (callback: ({ value, index }: { value: unknown; index: number }) => void) => void
    modifiedSlices?: Set<number>
    invalidateCache?: () => void
    points?: Set<number>
  }
  slope?: number | string
  intercept?: number | string
  rowPixelSpacing?: number | null
  columnPixelSpacing?: number | null
  sliceThickness?: number | null
  spacingBetweenSlices?: number | null
  width?: number
  height?: number
  columns?: number
  rows?: number
  isPreScaled?: boolean
  preScale?: { scaled?: boolean }
  imageFrame?: { preScale?: { scaled?: boolean } }
}

type ThresholdVolume = {
  volumeId?: string
  imageIds?: string[]
  getCornerstoneImages?: () => unknown[]
  dimensions?: number[]
  spacing?: number[]
  scaling?: { rescaleSlope?: number | string; rescaleIntercept?: number | string }
  imageData?: {
    getDimensions?: () => number[]
    getSpacing?: () => number[]
    worldToIndex?: (point: readonly [number, number, number]) => ArrayLike<number>
  }
  voxelManager?: {
    getScalarData?: () => ArrayLike<number>
    getScalarDataLength?: () => number
    getAtIndex?: (index: number) => unknown
    setAtIndex?: (index: number, value: number) => unknown
    forEach?: (callback: ({ value, index }: { value: unknown; index: number }) => void) => void
    modifiedSlices?: Set<number>
    invalidateCache?: () => void
    points?: Set<number>
  }
  modified?: () => void
}

type ImagePlaneMetadata = {
  rows?: number
  columns?: number
  rowPixelSpacing?: number | null
  columnPixelSpacing?: number | null
  pixelSpacing?: number[]
  sliceThickness?: number
  spacingBetweenSlices?: number
  imagePositionPatient?: number[]
  rowCosines?: number[]
  columnCosines?: number[]
  imageOrientationPatient?: number[]
}

type ImagePixelMetadata = {
  rescaleSlope?: number | string
  rescaleIntercept?: number | string
}

type MutableScalarData = {
  length: number
  [index: number]: number
}

export function getIchSegmentationId(referencedVolumeId: string) {
  return `vexa-ich-${referencedVolumeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function getIchStackSegmentationId(sourceKey: string) {
  return `vexa-ich-stack-${sourceKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function ensureIchSegmentation({
  referencedVolumeId,
  viewportIds,
  toolGroupId,
  brushSize = ICH_DEFAULT_BRUSH_SIZE,
  opacity = ICH_DEFAULT_OPACITY,
}: EnsureIchSegmentationOptions): IchSegmentationState {
  const segmentationId = getIchSegmentationId(referencedVolumeId)
  const labelmapVolumeId = `${segmentationId}-labelmap`

  if (!cache.getVolume(labelmapVolumeId)) {
    volumeLoader.createAndCacheDerivedLabelmapVolume(referencedVolumeId, {
      volumeId: labelmapVolumeId,
    })
    initializeEmptyIchVolumeStatsCache(labelmapVolumeId, referencedVolumeId)
  }

  if (!segmentation.state.getSegmentation(segmentationId)) {
    segmentation.addSegmentations([{
      segmentationId,
      representation: {
        type: ToolEnums.SegmentationRepresentations.Labelmap,
        data: {
          volumeId: labelmapVolumeId,
          referencedVolumeId,
        },
      },
      config: {
        label: 'ICH Volume',
        segmentOrder: [ICH_SEGMENT_INDEX],
        segments: {
          [ICH_SEGMENT_INDEX]: {
            segmentIndex: ICH_SEGMENT_INDEX,
            label: 'ICH #1',
            active: true,
            locked: false,
            cachedStats: {},
          },
        },
      },
    }])
  }

  viewportIds.forEach((viewportId) => attachIchSegmentationToViewport(viewportId, segmentationId, opacity))
  segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, ICH_SEGMENT_INDEX)
  setIchBrushSize(toolGroupId, brushSize)

  return { segmentationId, labelmapVolumeId }
}

export function ensureIchStackSegmentation({
  sourceKey,
  referencedImageIds,
  viewportId,
  toolGroupId,
  brushSize = ICH_DEFAULT_BRUSH_SIZE,
  opacity = ICH_DEFAULT_OPACITY,
}: EnsureIchStackSegmentationOptions): IchSegmentationState {
  const segmentationId = getIchStackSegmentationId(sourceKey)
  const labelmapImageIds = referencedImageIds.map((_, index) => `${segmentationId}-labelmap-${index}`)

  if (referencedImageIds.length === 0) {
    throw new Error('ICH stack segmentation requires imageIds')
  }

  if (!cache.getImage(labelmapImageIds[0])) {
    let derivedImageIndex = 0
    imageLoader.createAndCacheDerivedImages(referencedImageIds, {
      getDerivedImageId: () => labelmapImageIds[derivedImageIndex++] ?? `${segmentationId}-labelmap-${derivedImageIndex}`,
      targetBuffer: { type: 'Uint8Array' },
    })
  }

  if (!segmentation.state.getSegmentation(segmentationId)) {
    segmentation.addSegmentations([{
      segmentationId,
      representation: {
        type: ToolEnums.SegmentationRepresentations.Labelmap,
        data: {
          imageIds: labelmapImageIds,
          referencedImageIds,
        },
      },
      config: {
        label: 'ICH Volume',
        segmentOrder: [ICH_SEGMENT_INDEX],
        segments: {
          [ICH_SEGMENT_INDEX]: {
            segmentIndex: ICH_SEGMENT_INDEX,
            label: 'ICH #1',
            active: true,
            locked: false,
            cachedStats: {},
          },
        },
      },
    }])
  }

  attachIchSegmentationToViewport(viewportId, segmentationId, opacity)
  segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, ICH_SEGMENT_INDEX)
  setIchBrushSize(toolGroupId, brushSize)

  return { segmentationId, labelmapImageIds }
}

export function attachIchSegmentationToViewport(viewportId: string, segmentationId: string, opacity = ICH_DEFAULT_OPACITY) {
  const existing = segmentation.state.getSegmentationRepresentation(viewportId, {
    segmentationId,
    type: ToolEnums.SegmentationRepresentations.Labelmap,
  })

  if (!existing) {
    segmentation.addLabelmapRepresentationToViewport(viewportId, [{
      segmentationId,
      config: {
        colorLUTOrIndex: ICH_COLOR_LUT,
      },
    }])
  }

  segmentation.activeSegmentation.setActiveSegmentation(viewportId, segmentationId)
  segmentation.config.color.setSegmentIndexColor(viewportId, segmentationId, ICH_SEGMENT_INDEX, ICH_SEGMENT_COLOR)
  setIchSegmentationOpacity(segmentationId, viewportId, opacity)
}

export function detachIchSegmentationFromViewports(viewportIds: string[], segmentationId: string) {
  viewportIds.forEach((viewportId) => {
    const existing = segmentation.state.getSegmentationRepresentation(viewportId, {
      segmentationId,
      type: ToolEnums.SegmentationRepresentations.Labelmap,
    })
    if (!existing) {
      return
    }

    try {
      segmentation.removeLabelmapRepresentation(viewportId, segmentationId, true)
    } catch (error) {
      console.warn(`Unable to detach ICH labelmap from viewport ${viewportId}.`, error)
    }
  })
}

export function setIchSegmentationOpacity(segmentationId: string, viewportId: string, opacity: number) {
  const fillAlpha = clampNumber(opacity, 0.05, 0.85)
  segmentation.segmentationStyle.setStyle({
    type: ToolEnums.SegmentationRepresentations.Labelmap,
    viewportId,
    segmentationId,
  }, {
    renderFill: true,
    fillAlpha,
    renderOutline: true,
    outlineWidth: 1,
    outlineOpacity: 0.92,
    renderFillInactive: true,
    fillAlphaInactive: fillAlpha,
    renderOutlineInactive: true,
    outlineWidthInactive: 1,
    outlineOpacityInactive: 0.72,
  })
}

export function setIchSegmentationVisibility(segmentationId: string, viewportId: string, visible: boolean, opacity = ICH_DEFAULT_OPACITY) {
  if (visible) {
    setIchSegmentationOpacity(segmentationId, viewportId, opacity)
    return
  }

  segmentation.segmentationStyle.setStyle({
    type: ToolEnums.SegmentationRepresentations.Labelmap,
    viewportId,
    segmentationId,
  }, {
    renderFill: false,
    renderOutline: false,
    renderFillInactive: false,
    renderOutlineInactive: false,
  })
}

export function setIchBrushSize(toolGroupId: string, brushSize: number) {
  segmentationUtilities.setBrushSizeForToolGroup(toolGroupId, clampNumber(brushSize, 1, 80))
}

export function setIchBrushThreshold(toolGroupId: string, minimumHu: number, maximumHu: number) {
  const thresholdUtilities = segmentationUtilities as typeof segmentationUtilities & {
    setBrushThresholdForToolGroup?: (toolGroupId: string, threshold: { range: Types.Point2; isDynamic: boolean; dynamicRadius: number }) => void
  }
  thresholdUtilities.setBrushThresholdForToolGroup?.(toolGroupId, {
    range: [Math.min(minimumHu, maximumHu), Math.max(minimumHu, maximumHu)],
    isDynamic: false,
    dynamicRadius: 0,
  })
}

export async function applyIchThresholdToStack({
  segmentationId,
  referencedImageIds,
  sliceIndexes,
  minimumHu,
  maximumHu,
  replace = true,
  onProgress,
  shouldCancel,
}: ApplyIchThresholdToStackOptions): Promise<IchThresholdResult> {
  const labelmapImageIds = getIchLabelmapImageIds(segmentationId)
  const uniqueSliceIndexes = Array.from(new Set(sliceIndexes))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < referencedImageIds.length)
    .sort((a, b) => a - b)
  const totalSlices = uniqueSliceIndexes.length
  const lower = Math.min(minimumHu, maximumHu)
  const upper = Math.max(minimumHu, maximumHu)
  let matchedVoxels = 0
  let processedSlices = 0
  let skippedSlices = 0
  let volumeMm3 = 0
  let canceled = false
  const modifiedSlices: number[] = []

  for (const sliceIndex of uniqueSliceIndexes) {
    if (shouldCancel?.()) {
      canceled = true
      break
    }

    const sourceImageId = referencedImageIds[sliceIndex]
    const labelmapImageId = labelmapImageIds[sliceIndex]
    if (!sourceImageId || !labelmapImageId) {
      skippedSlices += 1
      processedSlices += 1
      continue
    }

    try {
      const sourceImage = (cache.getImage(sourceImageId) ?? await imageLoader.loadAndCacheImage(sourceImageId)) as ThresholdImage | undefined
      const labelmapImage = cache.getImage(labelmapImageId) as ThresholdImage | undefined
      const result = applyThresholdToLabelmapImage({
        sourceImageId,
        sourceImage,
        labelmapImage,
        lower,
        upper,
        replace,
        sliceIndex,
        referencedImageIds,
      })

      matchedVoxels += result.matchedVoxels
      volumeMm3 += result.volumeMm3
      skippedSlices += result.skipped ? 1 : 0
      if (!result.skipped) {
        modifiedSlices.push(sliceIndex)
      }
    } catch (error) {
      skippedSlices += 1
      console.warn('Unable to apply ICH threshold for slice.', error)
    }

    processedSlices += 1
    onProgress?.({ matchedVoxels, processedSlices, totalSlices, skippedSlices })

    if (processedSlices % 3 === 0) {
      await yieldToBrowser()
    }
  }

  if (modifiedSlices.length > 0) {
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, modifiedSlices, ICH_SEGMENT_INDEX)
    segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
  }

  return {
    matchedVoxels,
    processedSlices,
    skippedSlices,
    totalSlices,
    canceled,
    volumeMl: volumeMm3 > 0 ? volumeMm3 / 1000 : null,
  }
}

export async function applyIchRegionGrowToStackSlice({
  segmentationId,
  referencedImageIds,
  sliceIndex,
  seedPoint,
  minimumHu,
  maximumHu,
  mode = 'add',
  maxVoxels = 180000,
}: ApplyIchRegionGrowToStackSliceOptions): Promise<IchRegionGrowResult> {
  const context = await getStackSliceContext(segmentationId, referencedImageIds, sliceIndex)
  if (!context) {
    return { matchedVoxels: 0, reachedLimit: false, seedAccepted: false, volumeMl: null }
  }

  const result = growIchRegionOnSlice(context, {
    seedPoint,
    lower: Math.min(minimumHu, maximumHu),
    upper: Math.max(minimumHu, maximumHu),
    mode,
    maxVoxels,
  })

  if (result.matchedVoxels > 0) {
    markImageLabelmapModified(context.labelmapImage)
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, [sliceIndex], ICH_SEGMENT_INDEX)
    segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
  }

  return {
    matchedVoxels: result.matchedVoxels,
    reachedLimit: result.reachedLimit,
    seedAccepted: result.seedAccepted,
    volumeMl: result.volumeMl,
  }
}

export async function applyIchSmartDragToStackSlice({
  segmentationId,
  referencedImageIds,
  sliceIndex,
  seedPoint,
  dragPoint,
  mode = 'add',
  minimumHu = ICH_DEFAULT_THRESHOLD_MIN,
  maximumHu = ICH_DEFAULT_THRESHOLD_MAX,
  adaptiveModel,
  maxRadiusPx = 120,
  maxVoxels = 90000,
}: ApplyIchSmartDragToStackSliceOptions): Promise<IchSmartDragResult> {
  const context = await getStackSliceContext(segmentationId, referencedImageIds, sliceIndex)
  if (!context) {
    const totalStats = getIchStackSegmentStats(segmentationId, referencedImageIds)

    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusPx: 0,
      minimumHu,
      maximumHu,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
    }
  }

  const seedX = clampNumber(Math.round(seedPoint[0]), 0, context.width - 1)
  const seedY = clampNumber(Math.round(seedPoint[1]), 0, context.height - 1)
  const dragX = clampNumber(Math.round(dragPoint[0]), 0, context.width - 1)
  const dragY = clampNumber(Math.round(dragPoint[1]), 0, context.height - 1)
  const seedHu = getHuAtPixel(context, seedY * context.width + seedX)
  if (!Number.isFinite(seedHu)) {
    const totalStats = getIchStackSegmentStats(segmentationId, referencedImageIds)

    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusPx: 0,
      minimumHu,
      maximumHu,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
    }
  }

  const radiusPx = clampNumber(Math.hypot(dragX - seedX, dragY - seedY), 4, maxRadiusPx)
  if (mode === 'erase') {
    const result = eraseIchMaskAlongStackDrag(context, {
      seedPoint: [seedX, seedY],
      dragPoint: capStackPointDrag([seedX, seedY], [dragX, dragY], radiusPx),
      clearRadiusPx: clampNumber(Math.max(3, radiusPx * 0.22), 3, 18),
      maxVoxels,
    })

    if (result.matchedVoxels > 0) {
      markImageLabelmapModified(context.labelmapImage)
      segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, [sliceIndex], ICH_SEGMENT_INDEX)
      segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
    }

    const totalStats = getIchStackSegmentStats(segmentationId, referencedImageIds)

    return {
      matchedVoxels: result.matchedVoxels,
      acceptedVoxels: result.acceptedVoxels,
      reachedLimit: result.reachedLimit,
      seedAccepted: true,
      volumeMl: result.volumeMl,
      radiusPx,
      minimumHu,
      maximumHu,
      meanHu: result.meanHu,
      stdDevHu: result.stdDevHu,
      adaptiveModel: null,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
    }
  }

  const stats = sampleLocalHuStats(context, [seedX, seedY], 2)
  const modelTargetHu = adaptiveModel
    ? adaptiveModel.meanHu * 0.62 + seedHu * 0.38
    : seedHu
  const localTolerance = clampNumber(
    Math.max(
      14,
      stats.standardDeviation * 3 + 10,
      adaptiveModel ? adaptiveModel.stdDevHu * 2.2 + 8 : 0,
    ),
    14,
    42,
  )
  const range = getSmartDragHuRange({
    mode,
    seedHu: modelTargetHu,
    minimumHu,
    maximumHu,
    localTolerance,
  })
  const roiBounds = expandBounds(
    {
      minX: Math.max(0, Math.floor(seedX - radiusPx - 3)),
      maxX: Math.min(context.width - 1, Math.ceil(seedX + radiusPx + 3)),
      minY: Math.max(0, Math.floor(seedY - radiusPx - 3)),
      maxY: Math.min(context.height - 1, Math.ceil(seedY + radiusPx + 3)),
    },
    0,
    context.width,
    context.height,
  )
  const gradientStop = estimateSmartDragGradientStop(context, [seedX, seedY], radiusPx, stats.standardDeviation)
  const areaLimit = Math.min(
    maxVoxels,
    Math.max(32, Math.ceil(Math.PI * radiusPx * radiusPx * 0.7)),
  )
  const growLower = Math.min(
    Math.max(range.minimumHu, Math.floor(modelTargetHu - localTolerance)),
    Math.floor(seedHu - 3),
  )
  const growUpper = Math.max(
    Math.min(range.maximumHu, Math.ceil(modelTargetHu + localTolerance)),
    Math.ceil(seedHu + 3),
  )

  const result = growIchRegionOnSlice(context, {
    seedPoint: [seedX, seedY],
    lower: growLower,
    upper: growUpper,
    mode,
    maxVoxels: areaLimit,
    minVoxels: 1,
    roiBounds,
    rejectOnLimit: false,
    maxDistancePx: radiusPx + 1.5,
    gradientStop,
    seedHu,
    distanceWeighting: {
      targetHu: modelTargetHu,
      baseToleranceHu: localTolerance,
      radiusPx,
      floorRatio: 0.44,
    },
  })

  if (result.matchedVoxels > 0) {
    markImageLabelmapModified(context.labelmapImage)
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, [sliceIndex], ICH_SEGMENT_INDEX)
    segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
  }

  const totalStats = getIchStackSegmentStats(segmentationId, referencedImageIds)

  const resultModel = mode === 'add'
    ? createIchAdaptiveHuModelFromRegion(result, range.minimumHu, range.maximumHu)
    : null

  return {
    matchedVoxels: result.matchedVoxels,
    acceptedVoxels: result.acceptedVoxels,
    reachedLimit: result.reachedLimit,
    seedAccepted: result.seedAccepted,
    volumeMl: result.volumeMl,
    radiusPx,
    minimumHu: range.minimumHu,
    maximumHu: range.maximumHu,
    meanHu: result.meanHu,
    stdDevHu: result.stdDevHu,
    adaptiveModel: resultModel,
    totalVoxels: totalStats.voxelCount,
    totalVolumeMl: totalStats.volumeMl,
  }
}

export async function applyIchVolumeSmartDrag({
  segmentationId,
  referencedVolumeId,
  seedWorld,
  dragWorld,
  mode = 'add',
  minimumHu = ICH_DEFAULT_THRESHOLD_MIN,
  maximumHu = ICH_DEFAULT_THRESHOLD_MAX,
  adaptiveModel,
  forbiddenRegions = [],
  minRadiusVoxels = 2,
  maxRadiusVoxels = 42,
  clearRadiusVoxels,
  maxVoxels = 240000,
}: ApplyIchVolumeSmartDragOptions): Promise<IchVolumeSmartDragResult> {
  const context = getVolumeContext(segmentationId, referencedVolumeId)
  if (!context) {
    const totalStats = getIchVolumeSegmentStats(segmentationId, referencedVolumeId)

    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu,
      maximumHu,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
      failureReason: 'volume-context-missing',
    }
  }

  const seedIJK = worldToVolumeIJK(context, seedWorld)
  const dragIJK = worldToVolumeIJK(context, dragWorld)
  if (!seedIJK || !dragIJK) {
    const totalStats = getIchVolumeSegmentStats(segmentationId, referencedVolumeId)

    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu,
      maximumHu,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
      failureReason: 'world-to-ijk-failed',
    }
  }

  let growSeedIJK = seedIJK
  let growDragIJK = dragIJK
  if (mode === 'erase') {
    const seedIndex = getVolumeLinearIndex(context, seedIJK)
    const dragIndex = getVolumeLinearIndex(context, dragIJK)
    const seedOnMask = seedIndex !== null && getVolumeLabelmapValue(context, seedIndex) === ICH_SEGMENT_INDEX
    const dragOnMask = dragIndex !== null && getVolumeLabelmapValue(context, dragIndex) === ICH_SEGMENT_INDEX
    if (!seedOnMask && dragOnMask) {
      growSeedIJK = dragIJK
      growDragIJK = seedIJK
    }
  }

  const radiusVoxels = clampNumber(getVolumeIJKDistance(growSeedIJK, growDragIJK), minRadiusVoxels, maxRadiusVoxels)

  if (mode === 'erase') {
    const cappedDragIJK = capVolumeIJKDrag(growSeedIJK, growDragIJK, radiusVoxels)
    const result = eraseIchMaskAlongVolumeDrag(context, {
      seedIJK: growSeedIJK,
      dragIJK: cappedDragIJK,
      clearRadiusVoxels: clearRadiusVoxels ?? Math.max(2.5, minRadiusVoxels),
      maxVoxels,
    })

    if (result.matchedVoxels > 0) {
      markVolumeLabelmapModified(context.labelmapVolume, result.modifiedSlices)
      segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
        segmentationId,
        result.modifiedSlices.length > 0 ? result.modifiedSlices : undefined,
        ICH_SEGMENT_INDEX,
      )
      segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
    }

    const totalStats = updateIchVolumeStatsCacheFromResult(segmentationId, context, mode, result)

    return {
      matchedVoxels: result.matchedVoxels,
      acceptedVoxels: result.acceptedVoxels,
      reachedLimit: result.reachedLimit,
      seedAccepted: result.seedAccepted,
      volumeMl: result.volumeMl,
      radiusVoxels,
      minimumHu,
      maximumHu,
      meanHu: result.meanHu,
      stdDevHu: result.stdDevHu,
      adaptiveModel: null,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
    }
  }

  const seedHu = getHuAtVolumeIJK(context, growSeedIJK)
  if (!Number.isFinite(seedHu)) {
    const totalStats = getIchVolumeSegmentStats(segmentationId, referencedVolumeId)

    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu,
      maximumHu,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
      failureReason: 'seed-hu-invalid',
    }
  }

  const seedModel = sampleAdaptiveVolumeSeedHuModel(context, growSeedIJK, seedHu)
  const modelTargetHu = adaptiveModel
    ? seedModel.mean * 0.48 + seedHu * 0.12 + adaptiveModel.meanHu * 0.4
    : seedModel.mean * 0.78 + seedHu * 0.22
  const localTolerance = clampNumber(
    Math.max(
      10,
      seedModel.standardDeviation * 2.35 + 7,
      Math.abs(seedModel.upperPercentile - seedModel.lowerPercentile) * 0.72 + 6,
      adaptiveModel ? adaptiveModel.stdDevHu * 1.85 + 8 : 0,
    ),
    10,
    adaptiveModel ? 44 : 38,
  )
  const dynamicLower = Math.floor(
    Math.min(seedHu, seedModel.lowerPercentile, modelTargetHu) - Math.max(5, localTolerance * 0.55),
  )
  const dynamicUpper = Math.ceil(
    Math.max(seedHu, seedModel.upperPercentile, modelTargetHu) + Math.max(6, localTolerance * 0.75),
  )
  const boneSafetyUpper = Math.max(95, Math.min(155, modelTargetHu + Math.max(34, localTolerance * 1.25)))
  const adaptivePadding = adaptiveModel ? clampNumber(Math.max(8, adaptiveModel.stdDevHu * 1.6 + 8), 8, 44) : 0
  const adaptiveLower = adaptiveModel ? adaptiveModel.minimumHu - adaptivePadding : -1000
  const adaptiveUpper = adaptiveModel ? adaptiveModel.maximumHu + adaptivePadding : 3000
  const range = {
    minimumHu: Math.max(-1000, dynamicLower, Math.floor(adaptiveLower)),
    maximumHu: Math.min(3000, dynamicUpper, Math.ceil(boneSafetyUpper), Math.ceil(adaptiveUpper)),
  }
  const gradientStop = estimateVolumeSmartDragGradientStop(context, growSeedIJK, radiusVoxels, seedModel.standardDeviation)
  const sphereLimit = Math.ceil((4 / 3) * Math.PI * radiusVoxels ** 3 * 0.42)
  const growLower = Math.min(range.minimumHu, Math.floor(seedHu - 2))
  const growUpper = Math.max(range.maximumHu, Math.ceil(seedHu + 2))
  const result = growIchRegionInVolume(context, {
    seedIJK: growSeedIJK,
    lower: growLower,
    upper: growUpper,
    mode,
    maxVoxels: Math.min(maxVoxels, Math.max(48, sphereLimit)),
    minVoxels: 1,
    maxDistanceVoxels: radiusVoxels + 1.25,
    gradientStop,
    gradientDistanceRatio: 0.38,
    seedHu,
    distanceWeighting: {
      targetHu: modelTargetHu,
      baseToleranceHu: localTolerance,
      radiusPx: radiusVoxels,
      floorRatio: 0.46,
    },
    forbiddenRegions,
  })

  if (result.matchedVoxels > 0) {
    markVolumeLabelmapModified(context.labelmapVolume, result.modifiedSlices)
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      result.modifiedSlices.length > 0 ? result.modifiedSlices : undefined,
      ICH_SEGMENT_INDEX,
    )
    segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
  }

  const totalStats = updateIchVolumeStatsCacheFromResult(segmentationId, context, mode, result)
  const resultModel = mode === 'add'
    ? createIchAdaptiveHuModelFromRegion(result, range.minimumHu, range.maximumHu)
    : null

  return {
    matchedVoxels: result.matchedVoxels,
    acceptedVoxels: result.acceptedVoxels,
    reachedLimit: result.reachedLimit,
    seedAccepted: result.seedAccepted,
    volumeMl: result.volumeMl,
    radiusVoxels,
    minimumHu: range.minimumHu,
    maximumHu: range.maximumHu,
    meanHu: result.meanHu,
    stdDevHu: result.stdDevHu,
    adaptiveModel: resultModel,
    totalVoxels: totalStats.voxelCount,
    totalVolumeMl: totalStats.volumeMl,
    failureReason: !result.seedAccepted ? 'seed-out-of-range' : undefined,
  }
}

export function sampleIchVolumeHuLineModel({
  segmentationId,
  referencedVolumeId,
  startWorld,
  endWorld,
}: {
  segmentationId: string
  referencedVolumeId: string
  startWorld: Types.Point3
  endWorld: Types.Point3
}): IchVolumeHuLineSampleResult {
  const emptyResult: IchVolumeHuLineSampleResult = {
    adaptiveModel: null,
    samples: 0,
    meanHu: null,
    stdDevHu: null,
    minimumHu: null,
    maximumHu: null,
  }
  const context = getVolumeContext(segmentationId, referencedVolumeId)
  if (!context) {
    return emptyResult
  }

  const startIJK = worldToVolumeIJK(context, startWorld)
  const endIJK = worldToVolumeIJK(context, endWorld)
  if (!startIJK || !endIJK) {
    return emptyResult
  }

  const distance = getVolumeIJKDistance(startIJK, endIJK)
  if (!Number.isFinite(distance) || distance < 1) {
    return emptyResult
  }

  const steps = Math.ceil(clampNumber(distance * 2.5, 8, 240))
  const rawValues: number[] = []
  const sampledIndices = new Set<number>()

  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps
    const point = [
      startIJK[0] + (endIJK[0] - startIJK[0]) * ratio,
      startIJK[1] + (endIJK[1] - startIJK[1]) * ratio,
      startIJK[2] + (endIJK[2] - startIJK[2]) * ratio,
    ] as Types.Point3
    const roundedPoint = [
      Math.round(point[0]),
      Math.round(point[1]),
      Math.round(point[2]),
    ] as Types.Point3
    const index = getVolumeLinearIndex(context, roundedPoint)
    if (index === null || sampledIndices.has(index)) {
      continue
    }

    sampledIndices.add(index)
    const hu = getHuAtVolumeIndex(context, index)
    if (Number.isFinite(hu)) {
      rawValues.push(hu)
    }
  }

  if (rawValues.length < 4) {
    return emptyResult
  }

  rawValues.sort((left, right) => left - right)
  const median = getSortedPercentile(rawValues, 0.5)
  const lowerQuartile = getSortedPercentile(rawValues, 0.25)
  const upperQuartile = getSortedPercentile(rawValues, 0.75)
  const deviations = rawValues.map((value) => Math.abs(value - median)).sort((left, right) => left - right)
  const mad = getSortedPercentile(deviations, 0.5)
  const robustWindow = clampNumber(Math.max(10, mad * 3.4 + 7, (upperQuartile - lowerQuartile) * 0.75 + 8), 10, 58)
  let values = rawValues.filter((value) => Math.abs(value - median) <= robustWindow)

  if (values.length < Math.max(4, Math.floor(rawValues.length * 0.38))) {
    const trimCount = Math.floor(rawValues.length * 0.12)
    values = rawValues.slice(trimCount, Math.max(trimCount + 1, rawValues.length - trimCount))
  }
  if (values.length < 4) {
    return emptyResult
  }

  const sum = values.reduce((total, value) => total + value, 0)
  const sumSquares = values.reduce((total, value) => total + value * value, 0)
  const meanHu = sum / values.length
  const variance = Math.max(0, sumSquares / values.length - meanHu * meanHu)
  const stdDevHu = clampNumber(Math.sqrt(variance), 1, 80)
  const sortedValues = [...values].sort((left, right) => left - right)
  const lowerPercentile = getSortedPercentile(sortedValues, 0.12)
  const upperPercentile = getSortedPercentile(sortedValues, 0.88)
  const tolerance = clampNumber(
    Math.max(9, stdDevHu * 1.8 + 6, (upperPercentile - lowerPercentile) * 0.34 + 7),
    9,
    48,
  )
  const minimumHu = Math.floor(Math.max(-1000, lowerPercentile - tolerance * 0.48))
  const maximumHu = Math.ceil(Math.min(3000, upperPercentile + tolerance * 0.58))

  return {
    adaptiveModel: {
      meanHu,
      stdDevHu,
      samples: values.length,
      minimumHu,
      maximumHu,
    },
    samples: values.length,
    meanHu,
    stdDevHu,
    minimumHu,
    maximumHu,
  }
}

export async function applyIchVolumeScribbleExtractMask({
  segmentationId,
  referencedVolumeId,
  scribbleWorldPoints,
  adaptiveModel,
  forbiddenRegions = [],
  seedRadiusVoxels = 3,
  roiMarginVoxels = 34,
  maxVoxels = 140000,
}: ApplyIchVolumeScribbleExtractMaskOptions): Promise<IchVolumeSmartDragResult> {
  const context = getVolumeContext(segmentationId, referencedVolumeId)
  const totalStatsFallback = getIchVolumeSegmentStats(segmentationId, referencedVolumeId)
  if (!context) {
    return getEmptyVolumeSmartDragResult({
      minimumHu: adaptiveModel?.minimumHu ?? ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: adaptiveModel?.maximumHu ?? ICH_DEFAULT_THRESHOLD_MAX,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'volume-context-missing',
    })
  }

  const ijkPath = scribbleWorldPoints
    .map((worldPoint) => worldToVolumeIJK(context, worldPoint))
    .filter((point): point is Types.Point3 => Boolean(point))

  if (ijkPath.length < 2) {
    return getEmptyVolumeSmartDragResult({
      minimumHu: adaptiveModel?.minimumHu ?? ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: adaptiveModel?.maximumHu ?? ICH_DEFAULT_THRESHOLD_MAX,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'world-to-ijk-failed',
    })
  }

  const plane = inferScribblePlane(ijkPath)
  const seedRadius = clampNumber(seedRadiusVoxels, 1.5, 7)
  const seedSet = rasterizeScribblePlaneSeeds(context, plane, ijkPath, seedRadius, forbiddenRegions)
  if (seedSet.size < 2) {
    return getEmptyVolumeSmartDragResult({
      minimumHu: adaptiveModel?.minimumHu ?? ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: adaptiveModel?.maximumHu ?? ICH_DEFAULT_THRESHOLD_MAX,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'seed-out-of-range',
    })
  }

  const foregroundValues: number[] = []
  seedSet.forEach((planeKey) => {
    const point = getScribblePlaneIJKFromKey(plane, planeKey)
    const index = getVolumeLinearIndex(context, point)
    if (index === null) {
      return
    }

    const hu = getHuAtVolumeIndex(context, index)
    if (Number.isFinite(hu)) {
      foregroundValues.push(hu)
    }
  })

  const foregroundModel = createIchAdaptiveHuModelFromValues(foregroundValues)
  const model = mergeIchAdaptiveHuModels(adaptiveModel, foregroundModel)
  if (!model) {
    return getEmptyVolumeSmartDragResult({
      minimumHu: ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: ICH_DEFAULT_THRESHOLD_MAX,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'seed-hu-invalid',
    })
  }

  const bounds = getScribblePlaneSeedBounds(context, plane, seedSet, Math.round(clampNumber(roiMarginVoxels, 14, 86)))
  const extractResult = extractScribbleMaskOnPlane(context, {
    plane,
    bounds,
    foregroundSeedSet: seedSet,
    foregroundModel: model,
    forbiddenRegions,
    maxVoxels,
  })

  if (extractResult.matchedVoxels > 0) {
    markVolumeLabelmapModified(context.labelmapVolume, extractResult.modifiedSlices)
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      extractResult.modifiedSlices.length > 0 ? extractResult.modifiedSlices : undefined,
      ICH_SEGMENT_INDEX,
    )
    segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
  }

  const totalStats = updateIchVolumeStatsCacheFromResult(segmentationId, context, 'add', extractResult)
  const resultModel = mergeIchAdaptiveHuModels(
    model,
    createIchAdaptiveHuModelFromRegion(extractResult, model.minimumHu, model.maximumHu),
  )

  return {
    matchedVoxels: extractResult.matchedVoxels,
    acceptedVoxels: extractResult.acceptedVoxels,
    reachedLimit: extractResult.reachedLimit,
    seedAccepted: extractResult.seedAccepted,
    volumeMl: extractResult.volumeMl,
    radiusVoxels: Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2,
    minimumHu: model.minimumHu,
    maximumHu: model.maximumHu,
    meanHu: extractResult.meanHu,
    stdDevHu: extractResult.stdDevHu,
    adaptiveModel: resultModel,
    totalVoxels: totalStats.voxelCount,
    totalVolumeMl: totalStats.volumeMl,
    failureReason: extractResult.seedAccepted ? undefined : 'seed-out-of-range',
  }
}

export async function applyIchVolumeHuLineMask({
  segmentationId,
  referencedVolumeId,
  startWorld,
  endWorld,
  adaptiveModel,
  forbiddenRegions = [],
  minRadiusVoxels = 6,
  maxRadiusVoxels = 84,
  maxVoxels = 120000,
}: ApplyIchVolumeHuLineMaskOptions): Promise<IchVolumeSmartDragResult> {
  const context = getVolumeContext(segmentationId, referencedVolumeId)
  const totalStatsFallback = getIchVolumeSegmentStats(segmentationId, referencedVolumeId)
  if (!context) {
    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu: adaptiveModel?.minimumHu ?? ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: adaptiveModel?.maximumHu ?? ICH_DEFAULT_THRESHOLD_MAX,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'volume-context-missing',
    }
  }

  const startIJK = worldToVolumeIJK(context, startWorld)
  const endIJK = worldToVolumeIJK(context, endWorld)
  if (!startIJK || !endIJK) {
    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu: adaptiveModel?.minimumHu ?? ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: adaptiveModel?.maximumHu ?? ICH_DEFAULT_THRESHOLD_MAX,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'world-to-ijk-failed',
    }
  }

  const lineDistance = getVolumeIJKDistance(startIJK, endIJK)
  if (!Number.isFinite(lineDistance) || lineDistance < 1) {
    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu: adaptiveModel?.minimumHu ?? ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: adaptiveModel?.maximumHu ?? ICH_DEFAULT_THRESHOLD_MAX,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'seed-hu-invalid',
    }
  }

  const lineModelResult = sampleIchVolumeHuLineModel({
    segmentationId,
    referencedVolumeId,
    startWorld,
    endWorld,
  })
  const lineModel = mergeIchAdaptiveHuModels(adaptiveModel, lineModelResult.adaptiveModel)
  if (!lineModel) {
    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu: ICH_DEFAULT_THRESHOLD_MIN,
      maximumHu: ICH_DEFAULT_THRESHOLD_MAX,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: null,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'seed-out-of-range',
    }
  }

  const modelTolerance = clampNumber(Math.max(11, lineModel.stdDevHu * 2.05 + 8), 11, 54)
  const lower = Math.floor(Math.max(-1000, lineModel.minimumHu - modelTolerance * 0.3))
  const upper = Math.ceil(Math.min(
    3000,
    lineModel.maximumHu + modelTolerance * 0.45,
    Math.max(108, lineModel.meanHu + Math.max(38, modelTolerance * 1.35)),
  ))
  const seedWindow = Math.max(modelTolerance * 1.05, 12)
  const seedSamples: Array<{ point: Types.Point3; hu: number; ratio: number }> = []
  const seenSeedIndices = new Set<number>()
  const steps = Math.ceil(clampNumber(lineDistance * 2.2, 8, 180))

  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps
    const point = [
      startIJK[0] + (endIJK[0] - startIJK[0]) * ratio,
      startIJK[1] + (endIJK[1] - startIJK[1]) * ratio,
      startIJK[2] + (endIJK[2] - startIJK[2]) * ratio,
    ] as Types.Point3
    const roundedPoint = [
      Math.round(point[0]),
      Math.round(point[1]),
      Math.round(point[2]),
    ] as Types.Point3
    const index = getVolumeLinearIndex(context, roundedPoint)
    if (index === null || seenSeedIndices.has(index)) {
      continue
    }

    seenSeedIndices.add(index)
    const hu = getHuAtVolumeIndex(context, index)
    if (
      Number.isFinite(hu)
      && hu >= lower
      && hu <= upper
      && Math.abs(hu - lineModel.meanHu) <= seedWindow
      && !isPointInsideVolumeForbiddenRegions(roundedPoint[0], roundedPoint[1], roundedPoint[2], forbiddenRegions)
    ) {
      seedSamples.push({ point: roundedPoint, hu, ratio })
    }
  }

  if (seedSamples.length === 0) {
    return {
      matchedVoxels: 0,
      acceptedVoxels: 0,
      reachedLimit: false,
      seedAccepted: false,
      volumeMl: null,
      radiusVoxels: 0,
      minimumHu: lower,
      maximumHu: upper,
      meanHu: null,
      stdDevHu: null,
      adaptiveModel: lineModel,
      totalVoxels: totalStatsFallback.voxelCount,
      totalVolumeMl: totalStatsFallback.volumeMl,
      failureReason: 'seed-out-of-range',
    }
  }

  const sortedSeeds = seedSamples
    .sort((left, right) => Math.abs(left.hu - lineModel.meanHu) - Math.abs(right.hu - lineModel.meanHu))
  const balancedSeeds = selectBalancedHuLineSeeds(sortedSeeds, lineDistance)
  const growRadius = clampNumber(
    Math.max(minRadiusVoxels, lineDistance * 0.62 + 4),
    minRadiusVoxels,
    maxRadiusVoxels,
  )
  const perSeedMaxVoxels = Math.max(1600, Math.ceil(maxVoxels / Math.max(1, balancedSeeds.length) * 1.35))
  const modifiedSlices = new Set<number>()
  const modifiedIndices: number[] = []
  const addedIndices: number[] = []
  const removedIndices: number[] = []
  let matchedVoxels = 0
  let acceptedVoxels = 0
  let reachedLimit = false
  let seedAccepted = false
  let sumHu = 0
  let sumHuSquares = 0

  balancedSeeds.forEach((seed) => {
    const seedModel = sampleAdaptiveVolumeSeedHuModel(context, seed.point, seed.hu)
    const targetHu = seedModel.mean * 0.28 + seed.hu * 0.12 + lineModel.meanHu * 0.6
    const localTolerance = clampNumber(
      Math.max(
        modelTolerance,
        seedModel.standardDeviation * 2.05 + 8,
        Math.abs(seedModel.upperPercentile - seedModel.lowerPercentile) * 0.55 + 7,
      ),
      12,
      56,
    )
    const gradientStop = estimateVolumeSmartDragGradientStop(context, seed.point, growRadius, Math.max(seedModel.standardDeviation, lineModel.stdDevHu))
    const result = growIchRegionInVolume(context, {
      seedIJK: seed.point,
      lower: Math.min(lower, Math.floor(seed.hu - 3)),
      upper: Math.max(upper, Math.ceil(seed.hu + 3)),
      mode: 'add',
      maxVoxels: perSeedMaxVoxels,
      minVoxels: 1,
      maxDistanceVoxels: growRadius,
      gradientStop,
      gradientDistanceRatio: 0.32,
      seedHu: seed.hu,
      distanceWeighting: {
        targetHu,
        baseToleranceHu: localTolerance,
        radiusPx: growRadius,
        floorRatio: 0.42,
      },
      forbiddenRegions,
    })

    if (result.seedAccepted) {
      seedAccepted = true
    }
    if (result.reachedLimit) {
      reachedLimit = true
    }
    matchedVoxels += result.matchedVoxels
    acceptedVoxels += result.acceptedVoxels
    result.modifiedSlices.forEach((sliceIndex) => modifiedSlices.add(sliceIndex))
    modifiedIndices.push(...result.modifiedIndices)
    addedIndices.push(...result.addedIndices)
    removedIndices.push(...result.removedIndices)
    if (result.meanHu !== null && result.stdDevHu !== null && result.acceptedVoxels > 0) {
      sumHu += result.meanHu * result.acceptedVoxels
      sumHuSquares += (result.stdDevHu * result.stdDevHu + result.meanHu * result.meanHu) * result.acceptedVoxels
    }
  })

  const aggregateResult: InternalVolumeRegionGrowResult = {
    matchedVoxels,
    acceptedVoxels,
    reachedLimit,
    seedAccepted,
    volumeMl: matchedVoxels > 0 ? (matchedVoxels * context.voxelVolumeMm3) / 1000 : null,
    meanHu: getMeanFromMoments(sumHu, acceptedVoxels),
    stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, acceptedVoxels),
    modifiedSlices: Array.from(modifiedSlices).sort((a, b) => a - b),
    modifiedIndices,
    addedIndices,
    removedIndices,
  }

  if (aggregateResult.matchedVoxels > 0) {
    markVolumeLabelmapModified(context.labelmapVolume, aggregateResult.modifiedSlices)
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      aggregateResult.modifiedSlices.length > 0 ? aggregateResult.modifiedSlices : undefined,
      ICH_SEGMENT_INDEX,
    )
    segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
  }

  const totalStats = updateIchVolumeStatsCacheFromResult(segmentationId, context, 'add', aggregateResult)
  const resultModel = mergeIchAdaptiveHuModels(
    lineModel,
    createIchAdaptiveHuModelFromRegion(aggregateResult, lower, upper),
  )

  return {
    matchedVoxels: aggregateResult.matchedVoxels,
    acceptedVoxels: aggregateResult.acceptedVoxels,
    reachedLimit: aggregateResult.reachedLimit,
    seedAccepted: aggregateResult.seedAccepted,
    volumeMl: aggregateResult.volumeMl,
    radiusVoxels: growRadius,
    minimumHu: lower,
    maximumHu: upper,
    meanHu: aggregateResult.meanHu,
    stdDevHu: aggregateResult.stdDevHu,
    adaptiveModel: resultModel,
    totalVoxels: totalStats.voxelCount,
    totalVolumeMl: totalStats.volumeMl,
    failureReason: aggregateResult.seedAccepted ? undefined : 'seed-out-of-range',
  }
}

export async function applyIchAdaptiveRegionGrowToStack({
  segmentationId,
  referencedImageIds,
  seedSliceIndex,
  seedPoint,
  minimumHu,
  maximumHu,
  roiMargin = 20,
  maxVoxelsPerSlice = 150000,
  maxAreaGrowthFactor = 2.8,
  minVoxelsPerSlice = 6,
  replaceExisting = true,
  adaptiveModel,
  forbiddenRegions = [],
  onProgress,
  shouldCancel,
}: ApplyIchAdaptiveRegionGrowToStackOptions): Promise<IchAdaptiveStackGrowResult> {
  const totalSlices = referencedImageIds.length
  const lower = Math.min(minimumHu, maximumHu)
  const upper = Math.max(minimumHu, maximumHu)
  let learnedModel = adaptiveModel ?? null
  let matchedVoxels = 0
  let processedSlices = 0
  let skippedSlices = 0
  let volumeMm3 = 0
  let canceled = false
  let stoppedByLeakage = false
  const modifiedSlices: number[] = []

  if (replaceExisting) {
    clearStackLabelmapSegment(segmentationId)
  }

  const seedContext = await getStackSliceContext(segmentationId, referencedImageIds, seedSliceIndex)
  if (!seedContext) {
    const totalStats = getIchStackSegmentStats(segmentationId, referencedImageIds)

    return {
      matchedVoxels: 0,
      processedSlices: 0,
      totalSlices,
      skippedSlices: 1,
      canceled: false,
      stoppedByLeakage: false,
      volumeMl: null,
      adaptiveModel: learnedModel,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
    }
  }

  const seedHuForModel = getHuAtImagePoint(seedContext, seedPoint)
  // Batas slice benih diukur lokal: inti lesi vs jaringan SEKELILING (mesin deteksi baru).
  const seedWalls = deriveAdaptiveWallsForSlice(seedContext, seedPoint, {
    maxRadiusPx: Math.max(roiMargin * 6, 160),
  })
  const seedResult = growIchRegionOnSlice(seedContext, {
    seedPoint,
    lower: seedHuForModel !== null ? Math.min(seedWalls.lower, seedHuForModel - 4) : seedWalls.lower,
    upper: seedHuForModel !== null ? Math.max(seedWalls.upper, seedHuForModel + 4) : seedWalls.upper,
    mode: 'add',
    maxVoxels: maxVoxelsPerSlice,
    minVoxels: minVoxelsPerSlice,
    rejectOnLimit: true,
    forbiddenRegions: getForbiddenRegionsForSlice(forbiddenRegions, seedSliceIndex),
    // distanceWeighting DIHAPUS: dulu ia menyempitkan toleransi menurut radius sehingga
    // batas mengikuti radius, bukan HU jaringan sekitar. Kini adaptivitas berasal dari dinding.
  })

  processedSlices += 1
  if (!seedResult.seedAccepted || !seedResult.bounds || !seedResult.centroid || seedResult.acceptedVoxels < minVoxelsPerSlice) {
    skippedSlices += 1
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, undefined, ICH_SEGMENT_INDEX)
    segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
    const totalStats = getIchStackSegmentStats(segmentationId, referencedImageIds)

    return {
      matchedVoxels: 0,
      processedSlices,
      totalSlices,
      skippedSlices,
      canceled: false,
      stoppedByLeakage: false,
      volumeMl: null,
      adaptiveModel: learnedModel,
      totalVoxels: totalStats.voxelCount,
      totalVolumeMl: totalStats.volumeMl,
    }
  }

  if (seedResult.matchedVoxels > 0) {
    markImageLabelmapModified(seedContext.labelmapImage)
    modifiedSlices.push(seedSliceIndex)
    matchedVoxels += seedResult.matchedVoxels
    volumeMm3 += (seedResult.volumeMl ?? 0) * 1000
  }
  learnedModel = mergeIchAdaptiveHuModels(
    learnedModel,
    createIchAdaptiveHuModelFromRegion(seedResult, lower, upper),
  )
  const fixedRoi = expandBounds(seedResult.bounds, roiMargin, seedContext.width, seedContext.height)
  onProgress?.({ matchedVoxels, processedSlices, totalSlices, skippedSlices })

  const walkDirection = async (direction: 1 | -1) => {
    let previous = seedResult

    for (let sliceIndex = seedSliceIndex + direction; sliceIndex >= 0 && sliceIndex < totalSlices; sliceIndex += direction) {
      if (shouldCancel?.()) {
        canceled = true
        break
      }
      if (!previous.bounds || !previous.centroid) {
        break
      }

      const context = await getStackSliceContext(segmentationId, referencedImageIds, sliceIndex)
      processedSlices += 1
      if (!context) {
        skippedSlices += 1
        onProgress?.({ matchedVoxels, processedSlices, totalSlices, skippedSlices })
        await yieldToBrowser()
        continue
      }

      const adjacentRoi = intersectBounds(
        fixedRoi,
        expandBounds(previous.bounds, roiMargin, context.width, context.height),
      )
      if (!adjacentRoi) {
        break
      }

      const seed = findAdaptiveSeed(context, previous.centroid, adjacentRoi, lower, upper, Math.max(roiMargin, 24))
      if (!seed) {
        skippedSlices += 1
        break
      }

      // Batas slice ini juga diukur lokal dari jaringan di sekeliling lesi pada slice itu.
      const areaLimit = Math.min(
        maxVoxelsPerSlice,
        Math.max(5000, Math.ceil(previous.acceptedVoxels * maxAreaGrowthFactor)),
      )
      const previousRadius = previous.bounds
        ? Math.max(
            roiMargin * 1.5,
            Math.hypot(previous.bounds.maxX - previous.bounds.minX + 1, previous.bounds.maxY - previous.bounds.minY + 1) * 0.62,
          )
        : Math.max(roiMargin * 2, 36)
      // Batas slice ini diukur lokal dari jaringan di sekeliling lesi pada slice itu.
      const sliceWalls = deriveAdaptiveWallsForSlice(context, seed.point, {
        maxRadiusPx: Math.max(previousRadius + roiMargin, 120),
      })
      const localLower = Math.min(sliceWalls.lower, seed.hu - 4)
      const localUpper = Math.max(sliceWalls.upper, seed.hu + 4)
      const result = growIchRegionOnSlice(context, {
        seedPoint: seed.point,
        lower: localLower,
        upper: localUpper,
        mode: 'add',
        maxVoxels: areaLimit,
        minVoxels: minVoxelsPerSlice,
        roiBounds: adjacentRoi,
        rejectOnLimit: true,
        forbiddenRegions: getForbiddenRegionsForSlice(forbiddenRegions, sliceIndex),
        // distanceWeighting dihapus — lihat catatan pada slice benih di atas.
      })

      if (result.reachedLimit) {
        stoppedByLeakage = true
        break
      }
      if (!result.seedAccepted || !result.bounds || !result.centroid || result.acceptedVoxels < minVoxelsPerSlice) {
        skippedSlices += 1
        break
      }
      if (!boundsOverlap(expandBounds(previous.bounds, 2, context.width, context.height), result.bounds)) {
        stoppedByLeakage = true
        break
      }

      if (result.matchedVoxels > 0) {
        markImageLabelmapModified(context.labelmapImage)
        modifiedSlices.push(sliceIndex)
        matchedVoxels += result.matchedVoxels
        volumeMm3 += (result.volumeMl ?? 0) * 1000
      }
      previous = result
      learnedModel = mergeIchAdaptiveHuModels(
        learnedModel,
        createIchAdaptiveHuModelFromRegion(result, lower, upper),
      )
      onProgress?.({ matchedVoxels, processedSlices, totalSlices, skippedSlices })
      await yieldToBrowser()
    }
  }

  await walkDirection(1)
  if (!canceled) {
    await walkDirection(-1)
  }

  if (modifiedSlices.length > 0) {
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, modifiedSlices, ICH_SEGMENT_INDEX)
  } else {
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, undefined, ICH_SEGMENT_INDEX)
  }
  segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
  const totalStats = getIchStackSegmentStats(segmentationId, referencedImageIds)

  return {
    matchedVoxels,
    processedSlices,
    totalSlices,
    skippedSlices,
    canceled,
    stoppedByLeakage,
    volumeMl: volumeMm3 > 0 ? volumeMm3 / 1000 : null,
    adaptiveModel: learnedModel,
    totalVoxels: totalStats.voxelCount,
    totalVolumeMl: totalStats.volumeMl,
  }
}

export type IchLassoOperation = 'add' | 'subtract' | 'replace'

export type IchLassoRequest = {
  segmentationId: string
  referencedImageIds: string[]
  /** Indeks slice tempat operator menggambar. */
  sliceIndex: number
  /** Titik jalur operator pada bidang slice: x = kolom, y = baris. */
  points: IchLassoPoint[]
  /** 'polygon' = lasso tertutup, 'drag' = geser sebagian garis tepi yang sudah ada. */
  mode: 'polygon' | 'drag'
  /** Khusus mode polygon: add / subtract / replace. */
  operation?: IchLassoOperation
  /** 0 = ikut jalur operator persis; makin besar makin lengket ke tepi anatomi (default 6). */
  magnetism?: number
  /** Lebar koridor pencarian jalur magnetik (px, default 6). */
  corridorPx?: number
  /** Khusus mode drag: setengah lebar jendela yang boleh berubah (px, default 10). */
  windowPx?: number
}

export type IchLassoPreview = {
  /** Jalur hasil magnet (koordinat kolom/baris) untuk digambar di layar. */
  path: IchLassoPoint[]
  pathGradient: number
  alignment: number
}

export type IchLassoResult = IchLassoPreview & {
  added: number
  removed: number
  voxelCount: number
  volumeMl: number | null
}

type IchLassoPlane = {
  context: StackSliceContext
  hu: Float32Array
  grad: Float32Array
  mask: Uint8Array
  width: number
  height: number
  voxelCount: number
}

/** Ambil bidang slice (HU + mask labelmap) untuk lasso; null kalau tidak siap. */
async function getIchLassoPlane(
  segmentationId: string,
  referencedImageIds: string[],
  sliceIndex: number,
): Promise<IchLassoPlane | null> {
  const context = await getStackSliceContext(segmentationId, referencedImageIds, sliceIndex)
  if (!context) {
    return null
  }

  const { width, height, sourcePixels, labelmapPixels, slope, intercept } = context
  const voxelCount = width * height
  if (voxelCount <= 0 || sourcePixels.length < voxelCount || labelmapPixels.length < voxelCount) {
    return null
  }

  const hu = new Float32Array(voxelCount)
  const mask = new Uint8Array(voxelCount)
  for (let index = 0; index < voxelCount; index += 1) {
    hu[index] = Number(sourcePixels[index]) * slope + intercept
    mask[index] = Number(labelmapPixels[index]) === ICH_SEGMENT_INDEX ? 1 : 0
  }

  return { context, hu, grad: computeGradientMagnitude(hu, width, height), mask, width, height, voxelCount }
}

function lassoSnapOptions(request: IchLassoRequest) {
  const magnetism = Math.max(0, request.magnetism ?? 6)
  return {
    // magnetism 0 = operator ingin mengikuti kursor persis (tanpa magnet).
    mode: (magnetism > 0 ? 'edge' : 'line') as 'edge' | 'line',
    corridorPx: Math.max(2, request.corridorPx ?? 6),
    magnetism,
  }
}

/**
 * Pratinjau jalur magnet (tidak mengubah mask). Dipakai saat operator menggambar
 * supaya garis di layar sudah menunjukkan hasil snap, bukan jalur kursor mentah.
 */
export async function previewIchLassoPath(request: IchLassoRequest): Promise<IchLassoPreview | null> {
  const plane = await getIchLassoPlane(request.segmentationId, request.referencedImageIds, request.sliceIndex)
  if (!plane || request.points.length < 2) {
    return null
  }

  const snap = request.mode === 'polygon'
    ? magneticSnapPolygon(plane.hu, plane.grad, plane.width, plane.height, request.points, lassoSnapOptions(request))
    : magneticSnapPolyline(plane.hu, plane.grad, plane.width, plane.height, request.points, lassoSnapOptions(request))

  return { path: snap.path, pathGradient: snap.pathGradient, alignment: snap.alignment }
}

/**
 * Terapkan lasso ke mask slice ini.
 *  - mode 'polygon': jalur ditutup, diisi, lalu digabung (add/subtract/replace).
 *  - mode 'drag'   : hanya jendela lokal di sekitar jalur yang berubah; sisi "dalam"
 *                    ditebak dari mask lama, jadi bagian batas yang tidak diseret tetap.
 * Voxel yang berubah langsung ditulis ke labelmap + ditandai modified.
 */
export async function applyIchLassoToStackSlice(request: IchLassoRequest): Promise<IchLassoResult | null> {
  const plane = await getIchLassoPlane(request.segmentationId, request.referencedImageIds, request.sliceIndex)
  if (!plane || request.points.length < 2) {
    return null
  }

  const options = lassoSnapOptions(request)
  let nextMask: Uint8Array
  let path: IchLassoPoint[]
  let pathGradient = 0
  let alignment = 0

  if (request.mode === 'polygon') {
    if (request.points.length < 3) {
      return null
    }
    const snap = magneticSnapPolygon(plane.hu, plane.grad, plane.width, plane.height, request.points, options)
    const fill = rasterizeLassoPath(snap.path, plane.width, plane.height)
    nextMask = applyLassoToBaseMask(plane.mask, fill.mask, request.operation ?? 'add').mask
    path = snap.path
    pathGradient = snap.pathGradient
    alignment = snap.alignment
  } else {
    const drag = applyMagneticBoundaryDrag(plane.hu, plane.grad, plane.width, plane.height, plane.mask, request.points, {
      ...options,
      windowPx: request.windowPx ?? 10,
    })
    nextMask = drag.mask
    path = drag.path
    pathGradient = drag.pathGradient
    alignment = drag.alignment
  }

  let added = 0
  let removed = 0
  for (let index = 0; index < plane.voxelCount; index += 1) {
    const was = plane.mask[index] === 1
    const now = nextMask[index] === 1
    if (was === now) {
      continue
    }
    plane.context.labelmapPixels[index] = now ? ICH_SEGMENT_INDEX : 0
    if (now) {
      added += 1
    } else {
      removed += 1
    }
  }

  if (added || removed) {
    markImageLabelmapModified(plane.context.labelmapImage)
  }
  const stats = getIchStackSegmentStats(request.segmentationId, request.referencedImageIds)
  return { path, pathGradient, alignment, added, removed, voxelCount: stats.voxelCount, volumeMl: stats.volumeMl }
}

export function clearIchSegment(segmentationId: string) {
  getIchLabelmapVolumeIds(segmentationId).forEach((volumeId) => {
    const volume = cache.getVolume(volumeId) as unknown as ThresholdVolume | undefined
    const pixels = getVolumeScalarData(volume)
    const length = getVolumeDataLength(volume, pixels)
    if (length <= 0) {
      return
    }

    const dimensions = getVolumeDimensions(volume, length)
    const sliceSize = dimensions ? dimensions[0] * dimensions[1] : 0
    const modifiedSlices = new Set<number>()
    const cachedStats = ichVolumeStatsCache.get(volumeId)
    if (cachedStats?.indices.size) {
      cachedStats.indices.forEach((index) => {
        if (index >= 0 && index < length && getCachedVolumeValue(volume, pixels, index) === ICH_SEGMENT_INDEX) {
          setCachedVolumeValue(volume, pixels, index, 0)
          if (sliceSize > 0) {
            modifiedSlices.add(Math.floor(index / sliceSize))
          }
        }
      })
    } else {
      for (let index = 0; index < length; index += 1) {
        if (getCachedVolumeValue(volume, pixels, index) === ICH_SEGMENT_INDEX) {
          setCachedVolumeValue(volume, pixels, index, 0)
          if (sliceSize > 0) {
            modifiedSlices.add(Math.floor(index / sliceSize))
          }
        }
      }
    }
    const voxelVolumeMm3 = cachedStats?.voxelVolumeMm3 ?? getVolumeVoxelVolumeMm3(volume)
    ichVolumeStatsCache.set(volumeId, {
      voxelCount: 0,
      voxelVolumeMm3,
      indices: new Set(),
    })
    markVolumeLabelmapModified(volume, Array.from(modifiedSlices))
  })
  getIchLabelmapImageIds(segmentationId).forEach((imageId) => {
    const image = cache.getImage(imageId)
    const voxelManager = image?.voxelManager
    if (!voxelManager) {
      return
    }

    voxelManager.forEach(({ value, index }) => {
      if (Number(value) === ICH_SEGMENT_INDEX) {
        voxelManager.setAtIndex(index, 0)
      }
    })
  })

  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, undefined, ICH_SEGMENT_INDEX)
  segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
}

export function getIchSegmentVoxelCount(segmentationId: string) {
  let voxelCount = 0
  getIchLabelmapVolumeIds(segmentationId).forEach((volumeId) => {
    const voxelManager = cache.getVolume(volumeId)?.voxelManager
    voxelManager?.forEach(({ value }) => {
      if (Number(value) === ICH_SEGMENT_INDEX) {
        voxelCount += 1
      }
    })
  })
  getIchLabelmapImageIds(segmentationId).forEach((imageId) => {
    const voxelManager = cache.getImage(imageId)?.voxelManager
    voxelManager?.forEach(({ value }) => {
      if (Number(value) === ICH_SEGMENT_INDEX) {
        voxelCount += 1
      }
    })
  })

  return voxelCount
}

export function getIchStackSegmentStats(segmentationId: string, referencedImageIds: string[]): IchStackSegmentStats {
  let voxelCount = 0
  let volumeMm3 = 0
  let hasVolume = false

  getIchLabelmapImageIds(segmentationId).forEach((imageId, sliceIndex) => {
    const labelmapImage = cache.getImage(imageId) as ThresholdImage | undefined
    const labelmapPixels = getImageScalarData(labelmapImage)
    if (!labelmapPixels?.length) {
      return
    }

    let sliceVoxels = 0
    for (let index = 0; index < labelmapPixels.length; index += 1) {
      if (Number(labelmapPixels[index]) === ICH_SEGMENT_INDEX) {
        sliceVoxels += 1
      }
    }

    if (sliceVoxels <= 0) {
      return
    }

    voxelCount += sliceVoxels
    const sourceImageId = referencedImageIds[sliceIndex]
    if (sourceImageId) {
      const sourceImage = cache.getImage(sourceImageId) as ThresholdImage | undefined
      volumeMm3 += sliceVoxels * getVoxelVolumeMm3(sourceImageId, sourceImage, sliceIndex, referencedImageIds)
      hasVolume = true
    }
  })

  return {
    voxelCount,
    volumeMl: hasVolume && volumeMm3 > 0 ? volumeMm3 / 1000 : null,
  }
}

export function getIchVolumeSegmentStats(segmentationId: string, referencedVolumeId: string): IchVolumeSegmentStats {
  const context = getVolumeContext(segmentationId, referencedVolumeId)
  if (!context) {
    return { voxelCount: 0, volumeMl: null }
  }

  const cacheKey = getIchVolumeStatsCacheKey(segmentationId, context.labelmapVolume)
  const cachedStats = ichVolumeStatsCache.get(cacheKey)
  if (cachedStats) {
    return formatCachedIchVolumeStats(cachedStats)
  }

  let voxelCount = 0
  const indices = new Set<number>()
  const points = context.labelmapVolume.voxelManager?.points
  if (points?.size && !context.labelmapPixels?.length) {
    points.forEach((index) => {
      if (getVolumeLabelmapValue(context, index) === ICH_SEGMENT_INDEX) {
        voxelCount += 1
        indices.add(index)
      }
    })
  } else {
    for (let index = 0; index < context.voxelCount; index += 1) {
      if (getVolumeLabelmapValue(context, index) === ICH_SEGMENT_INDEX) {
        voxelCount += 1
        indices.add(index)
      }
    }
  }

  const nextStats = {
    voxelCount,
    voxelVolumeMm3: context.voxelVolumeMm3,
    indices,
  }
  ichVolumeStatsCache.set(cacheKey, nextStats)

  return formatCachedIchVolumeStats(nextStats)
}

export function getIchVolumeDicomExportData(
  segmentationId: string,
  referencedVolumeId: string,
): IchVolumeDicomExportData {
  const context = getVolumeContext(segmentationId, referencedVolumeId)
  if (!context) {
    throw new Error('The ICH volume or labelmap is not ready.')
  }

  const sourceImageIds = context.sourceVolume.imageIds?.filter(Boolean) ?? []
  const sourceImages = context.sourceVolume.getCornerstoneImages?.().filter(Boolean) ?? []
  if (!sourceImageIds.length || sourceImages.length !== sourceImageIds.length) {
    throw new Error('All source images must finish loading before the ICH segmentation can be saved.')
  }

  const scalarData = context.labelmapPixels instanceof Uint8Array
    ? context.labelmapPixels
    : copyIchLabelmapToUint8(context)

  return {
    labelmapVolumeId: context.labelmapVolume.volumeId ?? getIchLabelmapVolumeIds(segmentationId)[0] ?? '',
    dimensions: context.dimensions,
    spacing: context.spacing,
    scalarData,
    sourceImageIds,
    sourceImages,
  }
}

export function restoreIchVolumeFromReferencedSlices(
  segmentationId: string,
  referencedVolumeId: string,
  referencedSlices: ArrayLike<ArrayLike<number> | null | undefined>,
) {
  const context = getVolumeContext(segmentationId, referencedVolumeId)
  if (!context) {
    throw new Error('The ICH volume or labelmap is not ready.')
  }

  const sliceSize = context.dimensions[0] * context.dimensions[1]
  const depth = context.dimensions[2]
  const indices: number[] = []
  const sliceCount = Math.min(depth, referencedSlices.length)

  for (let sourceSliceIndex = 0; sourceSliceIndex < sliceCount; sourceSliceIndex += 1) {
    const slicePixels = referencedSlices[sourceSliceIndex]
    if (!slicePixels) {
      continue
    }

    // Cornerstone volume scalar Z is the reverse of the referenced imageId order.
    const volumeSliceIndex = depth - 1 - sourceSliceIndex
    const volumeOffset = volumeSliceIndex * sliceSize
    const length = Math.min(sliceSize, slicePixels.length)
    for (let pixelIndex = 0; pixelIndex < length; pixelIndex += 1) {
      if (Number(slicePixels[pixelIndex]) === ICH_SEGMENT_INDEX) {
        indices.push(volumeOffset + pixelIndex)
      }
    }
  }

  restoreIchVolumeSnapshot(segmentationId, {
    volumeId: context.labelmapVolume.volumeId ?? getIchLabelmapVolumeIds(segmentationId)[0] ?? '',
    indices: Uint32Array.from(indices),
  })

  return getIchVolumeSegmentStats(segmentationId, referencedVolumeId)
}

export function captureIchVolumeSnapshot(segmentationId: string): IchVolumeSnapshot {
  const volumeId = getIchLabelmapVolumeIds(segmentationId)[0] ?? ''
  const volume = cache.getVolume(volumeId) as unknown as ThresholdVolume | undefined
  const pixels = getVolumeScalarData(volume)
  const cachedStats = ichVolumeStatsCache.get(volumeId)
  if (cachedStats) {
    return {
      volumeId,
      indices: Uint32Array.from(cachedStats.indices),
    }
  }

  const indices: number[] = []

  if (pixels?.length) {
    for (let index = 0; index < pixels.length; index += 1) {
      if (getCachedVolumeValue(volume, pixels, index) === ICH_SEGMENT_INDEX) {
        indices.push(index)
      }
    }
  } else {
    volume?.voxelManager?.points?.forEach((index) => {
      if (getCachedVolumeValue(volume, pixels, index) === ICH_SEGMENT_INDEX) {
        indices.push(index)
      }
    })
  }

  ichVolumeStatsCache.set(volumeId, {
    voxelCount: indices.length,
    voxelVolumeMm3: getVolumeVoxelVolumeMm3(volume),
    indices: new Set(indices),
  })

  return {
    volumeId,
    indices: Uint32Array.from(indices),
  }
}

export function restoreIchVolumeSnapshot(segmentationId: string, snapshot: IchVolumeSnapshot) {
  const volumeId = getIchLabelmapVolumeIds(segmentationId)[0] ?? snapshot.volumeId
  const volume = cache.getVolume(volumeId) as unknown as ThresholdVolume | undefined
  const pixels = getVolumeScalarData(volume)
  const length = getVolumeDataLength(volume, pixels)
  if (length <= 0) {
    return
  }

  const dimensions = getVolumeDimensions(volume, length)
  const sliceSize = dimensions ? dimensions[0] * dimensions[1] : 0
  const modifiedSlices = new Set<number>()
  const cachedStats = ichVolumeStatsCache.get(volumeId)

  if (cachedStats?.indices.size) {
    cachedStats.indices.forEach((index) => {
      if (index >= 0 && index < length && getCachedVolumeValue(volume, pixels, index) === ICH_SEGMENT_INDEX) {
        setCachedVolumeValue(volume, pixels, index, 0)
        if (sliceSize > 0) {
          modifiedSlices.add(Math.floor(index / sliceSize))
        }
      }
    })
  } else if (pixels?.length) {
    for (let index = 0; index < length; index += 1) {
      if (getCachedVolumeValue(volume, pixels, index) === ICH_SEGMENT_INDEX) {
        setCachedVolumeValue(volume, pixels, index, 0)
        if (sliceSize > 0) {
          modifiedSlices.add(Math.floor(index / sliceSize))
        }
      }
    }
  } else {
    volume?.voxelManager?.points?.forEach((index) => {
      if (getCachedVolumeValue(volume, pixels, index) === ICH_SEGMENT_INDEX) {
        setCachedVolumeValue(volume, pixels, index, 0)
        if (sliceSize > 0) {
          modifiedSlices.add(Math.floor(index / sliceSize))
        }
      }
    })
  }

  for (let index = 0; index < snapshot.indices.length; index += 1) {
    const voxelIndex = snapshot.indices[index]
    if (voxelIndex >= 0 && voxelIndex < length && getCachedVolumeValue(volume, pixels, voxelIndex) !== ICH_SEGMENT_INDEX) {
      setCachedVolumeValue(volume, pixels, voxelIndex, ICH_SEGMENT_INDEX)
      if (sliceSize > 0) {
        modifiedSlices.add(Math.floor(voxelIndex / sliceSize))
      }
    }
  }

  markVolumeLabelmapModified(volume, Array.from(modifiedSlices))
  ichVolumeStatsCache.set(volumeId, {
    voxelCount: snapshot.indices.length,
    voxelVolumeMm3: getVolumeVoxelVolumeMm3(volume),
    indices: new Set(Array.from(snapshot.indices)),
  })
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    segmentationId,
    modifiedSlices.size > 0 ? Array.from(modifiedSlices) : undefined,
    ICH_SEGMENT_INDEX,
  )
  segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
}

export function captureIchStackSnapshot(segmentationId: string): IchStackSnapshot {
  return {
    slices: getIchLabelmapImageIds(segmentationId).map((imageId) => {
      const image = cache.getImage(imageId) as ThresholdImage | undefined
      const pixels = getImageScalarData(image)
      const indices: number[] = []
      if (pixels?.length) {
        for (let index = 0; index < pixels.length; index += 1) {
          if (Number(pixels[index]) === ICH_SEGMENT_INDEX) {
            indices.push(index)
          }
        }
      }

      return {
        imageId,
        indices: Uint32Array.from(indices),
      }
    }),
  }
}

export function restoreIchStackSnapshot(segmentationId: string, snapshot: IchStackSnapshot) {
  const snapshotByImageId = new Map(snapshot.slices.map((slice) => [slice.imageId, slice.indices]))
  const imageIds = getIchLabelmapImageIds(segmentationId)
  const modifiedSlices: number[] = []

  imageIds.forEach((imageId, sliceIndex) => {
    const image = cache.getImage(imageId) as ThresholdImage | undefined
    const pixels = getImageScalarData(image)
    if (!pixels?.length) {
      return
    }

    let modified = false
    for (let index = 0; index < pixels.length; index += 1) {
      if (Number(pixels[index]) === ICH_SEGMENT_INDEX) {
        pixels[index] = 0
        modified = true
      }
    }

    const indices = snapshotByImageId.get(imageId)
    if (indices?.length) {
      for (let index = 0; index < indices.length; index += 1) {
        const pixelIndex = indices[index]
        if (pixelIndex >= 0 && pixelIndex < pixels.length && Number(pixels[pixelIndex]) !== ICH_SEGMENT_INDEX) {
          pixels[pixelIndex] = ICH_SEGMENT_INDEX
          modified = true
        }
      }
    }

    if (modified) {
      markImageLabelmapModified(image)
      modifiedSlices.push(sliceIndex)
    }
  })

  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    segmentationId,
    modifiedSlices.length > 0 ? modifiedSlices : undefined,
    ICH_SEGMENT_INDEX,
  )
  segmentationUtilities.triggerSegmentationRenderBySegmentationId(segmentationId)
}

function getIchLabelmapVolumeIds(segmentationId: string) {
  const current = segmentation.state.getSegmentation(segmentationId)
  const labelmapData = current?.representationData.Labelmap
  if (!labelmapData) {
    return []
  }

  const volumeIds = new Set<string>()
  if (labelmapData.volumeId) {
    volumeIds.add(labelmapData.volumeId)
  }

  Object.values(labelmapData.labelmaps ?? {}).forEach((labelmap) => {
    if (labelmap.volumeId) {
      volumeIds.add(labelmap.volumeId)
    }
    if (labelmap.geometryVolumeId) {
      volumeIds.add(labelmap.geometryVolumeId)
    }
  })

  return Array.from(volumeIds)
}

function getIchLabelmapImageIds(segmentationId: string) {
  const current = segmentation.state.getSegmentation(segmentationId)
  const labelmapData = current?.representationData.Labelmap
  if (!labelmapData) {
    return []
  }

  const imageIds = new Set<string>()
  labelmapData.imageIds?.forEach((imageId) => imageIds.add(imageId))
  Object.values(labelmapData.labelmaps ?? {}).forEach((labelmap) => {
    labelmap.imageIds?.forEach((imageId) => imageIds.add(imageId))
  })

  return Array.from(imageIds)
}

function copyIchLabelmapToUint8(context: VolumeContext) {
  const copy = new Uint8Array(context.voxelCount)
  for (let index = 0; index < context.voxelCount; index += 1) {
    if (getVolumeLabelmapValue(context, index) === ICH_SEGMENT_INDEX) {
      copy[index] = ICH_SEGMENT_INDEX
    }
  }
  return copy
}

function applyThresholdToLabelmapImage({
  sourceImageId,
  sourceImage,
  labelmapImage,
  lower,
  upper,
  replace,
  sliceIndex,
  referencedImageIds,
}: {
  sourceImageId: string
  sourceImage: ThresholdImage | undefined
  labelmapImage: ThresholdImage | undefined
  lower: number
  upper: number
  replace: boolean
  sliceIndex: number
  referencedImageIds: string[]
}) {
  const sourcePixels = getImageScalarData(sourceImage)
  const labelmapPixels = getImageScalarData(labelmapImage)
  if (!sourcePixels?.length || !labelmapPixels?.length) {
    return { matchedVoxels: 0, volumeMm3: 0, skipped: true }
  }

  const length = Math.min(sourcePixels.length, labelmapPixels.length)
  const { slope, intercept } = getImageScaling(sourceImageId, sourceImage)
  let matchedVoxels = 0

  for (let index = 0; index < length; index += 1) {
    const hu = Number(sourcePixels[index]) * slope + intercept
    const inRange = Number.isFinite(hu) && hu >= lower && hu <= upper
    if (inRange) {
      labelmapPixels[index] = ICH_SEGMENT_INDEX
      matchedVoxels += 1
    } else if (replace && Number(labelmapPixels[index]) === ICH_SEGMENT_INDEX) {
      labelmapPixels[index] = 0
    }
  }

  markImageLabelmapModified(labelmapImage)

  return {
    matchedVoxels,
    volumeMm3: matchedVoxels * getVoxelVolumeMm3(sourceImageId, sourceImage, sliceIndex, referencedImageIds),
    skipped: false,
  }
}

async function getStackSliceContext(
  segmentationId: string,
  referencedImageIds: string[],
  sliceIndex: number,
): Promise<StackSliceContext | null> {
  const sourceImageId = referencedImageIds[sliceIndex]
  const labelmapImageId = getIchLabelmapImageIds(segmentationId)[sliceIndex]
  if (!sourceImageId || !labelmapImageId) {
    return null
  }

  const sourceImage = (cache.getImage(sourceImageId) ?? await imageLoader.loadAndCacheImage(sourceImageId)) as ThresholdImage | undefined
  const labelmapImage = cache.getImage(labelmapImageId) as ThresholdImage | undefined
  const sourcePixels = getImageScalarData(sourceImage)
  const labelmapPixels = getImageScalarData(labelmapImage)
  if (!sourcePixels?.length || !labelmapPixels?.length) {
    return null
  }

  const dimensions = getImageDimensions(sourceImageId, sourceImage, sourcePixels.length)
  if (!dimensions) {
    return null
  }

  const width = Math.floor(dimensions[0])
  const height = Math.floor(dimensions[1])
  if (width <= 0 || height <= 0) {
    return null
  }

  const { slope, intercept } = getImageScaling(sourceImageId, sourceImage)

  return {
    sourceImageId,
    sourceImage,
    labelmapImage,
    sourcePixels,
    labelmapPixels,
    width,
    height,
    slope,
    intercept,
    voxelVolumeMm3: getVoxelVolumeMm3(sourceImageId, sourceImage, sliceIndex, referencedImageIds),
  }
}

function growIchRegionOnSlice(context: StackSliceContext, {
  seedPoint,
  lower,
  upper,
  mode = 'add',
  maxVoxels = 180000,
  minVoxels = 1,
  roiBounds,
  rejectOnLimit = false,
  maxDistancePx,
  gradientStop,
  seedHu: expectedSeedHu,
  distanceWeighting,
  forbiddenRegions,
}: GrowIchRegionOnSliceOptions): InternalRegionGrowResult {
  const width = context.width
  const height = context.height
  const pixelCount = Math.min(width * height, context.sourcePixels.length, context.labelmapPixels.length)
  const seedX = Math.round(seedPoint[0])
  const seedY = Math.round(seedPoint[1])

  if (
    pixelCount <= 0
    || seedX < 0
    || seedX >= width
    || seedY < 0
    || seedY >= height
    || (roiBounds && !isPointInsideBounds(seedX, seedY, roiBounds))
    || isPointInsideForbiddenRegions(seedX, seedY, forbiddenRegions)
  ) {
    return { matchedVoxels: 0, acceptedVoxels: 0, meanHu: null, stdDevHu: null, reachedLimit: false, seedAccepted: false, volumeMl: null, bounds: null, centroid: null }
  }

  const seedIndex = seedY * width + seedX
  const seedHu = getHuAtPixel(context, seedIndex)
  if (!Number.isFinite(seedHu) || seedHu < lower || seedHu > upper) {
    return { matchedVoxels: 0, acceptedVoxels: 0, meanHu: null, stdDevHu: null, reachedLimit: false, seedAccepted: false, volumeMl: null, bounds: null, centroid: null }
  }

  const maxAccepted = Math.max(1, Math.min(Math.floor(maxVoxels), pixelCount))
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  const accepted = new Int32Array(maxAccepted)
  let head = 0
  let tail = 0
  let acceptedCount = 0
  let reachedLimit = false
  let minX = seedX
  let maxX = seedX
  let minY = seedY
  let maxY = seedY
  let sumX = 0
  let sumY = 0
  let sumHu = 0
  let sumHuSquares = 0

  visited[seedIndex] = 1
  queue[tail] = seedIndex
  tail += 1

  while (head < tail) {
    const index = queue[head]
    head += 1

    const y = Math.floor(index / width)
    const x = index - y * width
    if (maxDistancePx !== undefined && Math.hypot(x - seedX, y - seedY) > maxDistancePx) {
      continue
    }

    const hu = getHuAtPixel(context, index)
    if (!Number.isFinite(hu) || hu < lower || hu > upper) {
      continue
    }

    if (distanceWeighting && !isHuAcceptedByDistanceWeighting(distanceWeighting, hu, Math.hypot(x - seedX, y - seedY))) {
      continue
    }

    const seedDelta = expectedSeedHu !== undefined ? Math.abs(hu - expectedSeedHu) : 0
    const gradient = gradientStop !== undefined ? getSobelGradientMagnitude(context, x, y) : 0
    if (acceptedCount > 0 && gradientStop !== undefined && gradient > gradientStop && seedDelta > 6) {
      continue
    }

    if (acceptedCount >= maxAccepted) {
      reachedLimit = true
      break
    }

    accepted[acceptedCount] = index
    acceptedCount += 1
    sumX += x
    sumY += y
    sumHu += hu
    sumHuSquares += hu * hu
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)

    enqueueNeighbor(index - 1, x - 1, y)
    enqueueNeighbor(index + 1, x + 1, y)
    enqueueNeighbor(index - width, x, y - 1)
    enqueueNeighbor(index + width, x, y + 1)
  }

  if ((reachedLimit && rejectOnLimit) || acceptedCount < minVoxels) {
    return {
      matchedVoxels: 0,
      acceptedVoxels: acceptedCount,
      meanHu: getMeanFromMoments(sumHu, acceptedCount),
      stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, acceptedCount),
      reachedLimit,
      seedAccepted: true,
      volumeMl: null,
      bounds: null,
      centroid: null,
    }
  }

  let matchedVoxels = 0
  const addedPixels: number[] = []
  for (let acceptedIndex = 0; acceptedIndex < acceptedCount; acceptedIndex += 1) {
    const pixelIndex = accepted[acceptedIndex]
    const currentValue = Number(context.labelmapPixels[pixelIndex])
    if (mode === 'erase') {
      if (currentValue === ICH_SEGMENT_INDEX) {
        context.labelmapPixels[pixelIndex] = 0
        matchedVoxels += 1
      }
    } else if (currentValue !== ICH_SEGMENT_INDEX) {
      context.labelmapPixels[pixelIndex] = ICH_SEGMENT_INDEX
      addedPixels.push(pixelIndex)
      matchedVoxels += 1
    }
  }

  if (mode === 'add' && addedPixels.length > 0) {
    const smoothing = smoothIchStackMask(context, addedPixels)
    matchedVoxels = Math.max(0, matchedVoxels + smoothing.addedPixels - smoothing.removedPixels)
  }

  return {
    matchedVoxels,
    acceptedVoxels: acceptedCount,
    meanHu: getMeanFromMoments(sumHu, acceptedCount),
    stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, acceptedCount),
    reachedLimit,
    seedAccepted: true,
    volumeMl: matchedVoxels > 0 ? (matchedVoxels * context.voxelVolumeMm3) / 1000 : null,
    bounds: { minX, maxX, minY, maxY },
    centroid: [sumX / acceptedCount, sumY / acceptedCount],
  }

  function enqueueNeighbor(index: number, x: number, y: number) {
    if (
      x < 0
      || x >= width
      || y < 0
      || y >= height
      || index < 0
      || index >= pixelCount
      || visited[index]
      || (roiBounds && !isPointInsideBounds(x, y, roiBounds))
      || (maxDistancePx !== undefined && Math.hypot(x - seedX, y - seedY) > maxDistancePx)
      || isPointInsideForbiddenRegions(x, y, forbiddenRegions)
    ) {
      return
    }

    visited[index] = 1
    queue[tail] = index
    tail += 1
  }
}

function eraseIchMaskAlongStackDrag(
  context: StackSliceContext,
  {
    seedPoint,
    dragPoint,
    clearRadiusPx,
    maxVoxels = 90000,
  }: {
    seedPoint: Types.Point2
    dragPoint: Types.Point2
    clearRadiusPx: number
    maxVoxels?: number
  },
): InternalRegionGrowResult {
  const radius = clampNumber(clearRadiusPx, 2, 24)
  const padding = Math.ceil(radius)
  const start = [
    clampNumber(seedPoint[0], 0, context.width - 1),
    clampNumber(seedPoint[1], 0, context.height - 1),
  ] as Types.Point2
  const end = [
    clampNumber(dragPoint[0], 0, context.width - 1),
    clampNumber(dragPoint[1], 0, context.height - 1),
  ] as Types.Point2
  const minX = Math.max(0, Math.floor(Math.min(start[0], end[0]) - padding))
  const maxX = Math.min(context.width - 1, Math.ceil(Math.max(start[0], end[0]) + padding))
  const minY = Math.max(0, Math.floor(Math.min(start[1], end[1]) - padding))
  const maxY = Math.min(context.height - 1, Math.ceil(Math.max(start[1], end[1]) + padding))
  const maxInspected = Math.max(1, Math.floor(maxVoxels))
  let inspectedVoxels = 0
  let matchedVoxels = 0
  let reachedLimit = false
  let sumHu = 0
  let sumHuSquares = 0
  let sumX = 0
  let sumY = 0

  scanSlice:
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (getDistanceToStackSegment([x, y], start, end) > radius) {
        continue
      }

      inspectedVoxels += 1
      if (inspectedVoxels > maxInspected) {
        reachedLimit = true
        break scanSlice
      }

      const index = y * context.width + x
      if (Number(context.labelmapPixels[index]) !== ICH_SEGMENT_INDEX) {
        continue
      }

      const hu = getHuAtPixel(context, index)
      if (Number.isFinite(hu)) {
        sumHu += hu
        sumHuSquares += hu * hu
      }
      context.labelmapPixels[index] = 0
      matchedVoxels += 1
      sumX += x
      sumY += y
    }
  }

  return {
    matchedVoxels,
    acceptedVoxels: inspectedVoxels,
    meanHu: getMeanFromMoments(sumHu, matchedVoxels),
    stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, matchedVoxels),
    reachedLimit,
    seedAccepted: true,
    volumeMl: matchedVoxels > 0 ? (matchedVoxels * context.voxelVolumeMm3) / 1000 : null,
    bounds: matchedVoxels > 0 ? { minX, maxX, minY, maxY } : null,
    centroid: matchedVoxels > 0 ? [sumX / matchedVoxels, sumY / matchedVoxels] : null,
  }
}

function smoothIchStackMask(context: StackSliceContext, seedPixels: number[]) {
  let minX = context.width - 1
  let maxX = 0
  let minY = context.height - 1
  let maxY = 0
  seedPixels.forEach((index) => {
    const y = Math.floor(index / context.width)
    const x = index - y * context.width
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  })

  if (seedPixels.length <= 0 || minX > maxX || minY > maxY) {
    return { addedPixels: 0, removedPixels: 0 }
  }

  const bounds = expandBounds({ minX, maxX, minY, maxY }, 3, context.width, context.height)
  const addedPixels = new Set<number>()
  const removedPixels = new Set<number>()

  closeSmallMaskGapsOnStackSlice(context, bounds, addedPixels)
  fillEnclosedMaskHolesOnStackSlice(context, bounds, addedPixels)
  removeTinyMaskIslandsOnStackSlice(context, bounds, addedPixels, removedPixels)

  removedPixels.forEach((index) => addedPixels.delete(index))

  return {
    addedPixels: addedPixels.size,
    removedPixels: removedPixels.size,
  }
}

function closeSmallMaskGapsOnStackSlice(
  context: StackSliceContext,
  bounds: Bounds2D,
  addedPixels: Set<number>,
) {
  const toAdd: number[] = []

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const index = y * context.width + x
      if (Number(context.labelmapPixels[index]) === ICH_SEGMENT_INDEX) {
        continue
      }

      if (countMaskedStackNeighbors(context, x, y) >= 5) {
        toAdd.push(index)
      }
    }
  }

  toAdd.forEach((index) => {
    if (Number(context.labelmapPixels[index]) !== ICH_SEGMENT_INDEX) {
      context.labelmapPixels[index] = ICH_SEGMENT_INDEX
      addedPixels.add(index)
    }
  })
}

function fillEnclosedMaskHolesOnStackSlice(
  context: StackSliceContext,
  bounds: Bounds2D,
  addedPixels: Set<number>,
) {
  const roiWidth = bounds.maxX - bounds.minX + 1
  const roiHeight = bounds.maxY - bounds.minY + 1
  const roiSize = roiWidth * roiHeight
  if (roiSize <= 0 || roiSize > 20000) {
    return
  }

  const visited = new Uint8Array(roiSize)
  const queue = new Int32Array(roiSize)
  let head = 0
  let tail = 0

  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    enqueueBackground(x, bounds.minY)
    enqueueBackground(x, bounds.maxY)
  }
  for (let y = bounds.minY + 1; y < bounds.maxY; y += 1) {
    enqueueBackground(bounds.minX, y)
    enqueueBackground(bounds.maxX, y)
  }

  while (head < tail) {
    const localIndex = queue[head]
    head += 1
    const y = bounds.minY + Math.floor(localIndex / roiWidth)
    const x = bounds.minX + (localIndex % roiWidth)
    enqueueBackground(x - 1, y)
    enqueueBackground(x + 1, y)
    enqueueBackground(x, y - 1)
    enqueueBackground(x, y + 1)
  }

  for (let y = bounds.minY + 1; y < bounds.maxY; y += 1) {
    for (let x = bounds.minX + 1; x < bounds.maxX; x += 1) {
      const localIndex = (y - bounds.minY) * roiWidth + (x - bounds.minX)
      const index = y * context.width + x
      if (
        !visited[localIndex]
        && Number(context.labelmapPixels[index]) !== ICH_SEGMENT_INDEX
        && countMaskedStackNeighbors(context, x, y) >= 2
      ) {
        context.labelmapPixels[index] = ICH_SEGMENT_INDEX
        addedPixels.add(index)
      }
    }
  }

  function enqueueBackground(x: number, y: number) {
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      return
    }

    const localIndex = (y - bounds.minY) * roiWidth + (x - bounds.minX)
    if (visited[localIndex]) {
      return
    }

    const index = y * context.width + x
    if (Number(context.labelmapPixels[index]) === ICH_SEGMENT_INDEX) {
      return
    }

    visited[localIndex] = 1
    queue[tail] = localIndex
    tail += 1
  }
}

function removeTinyMaskIslandsOnStackSlice(
  context: StackSliceContext,
  bounds: Bounds2D,
  addedPixels: Set<number>,
  removedPixels: Set<number>,
) {
  const roiWidth = bounds.maxX - bounds.minX + 1
  const roiHeight = bounds.maxY - bounds.minY + 1
  const roiSize = roiWidth * roiHeight
  if (roiSize <= 0 || roiSize > 20000) {
    return
  }

  const visited = new Uint8Array(roiSize)
  const queue = new Int32Array(roiSize)
  const component: number[] = []
  const tinyIslandMaxPixels = 3
  let componentHead = 0
  let componentTail = 0

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const startLocal = (y - bounds.minY) * roiWidth + (x - bounds.minX)
      const startIndex = y * context.width + x
      if (visited[startLocal] || Number(context.labelmapPixels[startIndex]) !== ICH_SEGMENT_INDEX) {
        continue
      }

      component.length = 0
      componentHead = 0
      componentTail = 0
      visited[startLocal] = 1
      queue[componentTail] = startLocal
      componentTail += 1

      while (componentHead < componentTail) {
        const localIndex = queue[componentHead]
        componentHead += 1
        const componentY = bounds.minY + Math.floor(localIndex / roiWidth)
        const componentX = bounds.minX + (localIndex % roiWidth)
        component.push(componentY * context.width + componentX)
        enqueueMask(componentX - 1, componentY)
        enqueueMask(componentX + 1, componentY)
        enqueueMask(componentX, componentY - 1)
        enqueueMask(componentX, componentY + 1)
      }

      if (component.length <= tinyIslandMaxPixels) {
        component.forEach((index) => {
          context.labelmapPixels[index] = 0
          addedPixels.delete(index)
          removedPixels.add(index)
        })
      }
    }
  }

  function enqueueMask(x: number, y: number) {
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      return
    }

    const localIndex = (y - bounds.minY) * roiWidth + (x - bounds.minX)
    if (visited[localIndex]) {
      return
    }

    const index = y * context.width + x
    if (Number(context.labelmapPixels[index]) !== ICH_SEGMENT_INDEX) {
      return
    }

    visited[localIndex] = 1
    queue[componentTail] = localIndex
    componentTail += 1
  }
}

function countMaskedStackNeighbors(context: StackSliceContext, x: number, y: number) {
  let count = 0

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue
      }

      const neighborX = x + dx
      const neighborY = y + dy
      if (neighborX < 0 || neighborX >= context.width || neighborY < 0 || neighborY >= context.height) {
        continue
      }

      if (Number(context.labelmapPixels[neighborY * context.width + neighborX]) === ICH_SEGMENT_INDEX) {
        count += 1
      }
    }
  }

  return count
}

function growIchRegionInVolume(context: VolumeContext, {
  seedIJK,
  lower,
  upper,
  mode = 'add',
  maxVoxels = 240000,
  minVoxels = 1,
  maxDistanceVoxels,
  gradientStop,
  gradientDistanceRatio = 0.35,
  seedHu: expectedSeedHu,
  distanceWeighting,
  forbiddenRegions,
}: GrowIchRegionInVolumeOptions): InternalVolumeRegionGrowResult {
  const [width, height, depth] = context.dimensions.map((value) => Math.floor(value)) as Types.Point3
  const voxelCount = Math.min(width * height * depth, context.voxelCount)
  const sliceSize = width * height
  const seedX = Math.round(seedIJK[0])
  const seedY = Math.round(seedIJK[1])
  const seedZ = Math.round(seedIJK[2])

  if (
    voxelCount <= 0
    || !isVolumeIJKInside(context, [seedX, seedY, seedZ])
    || isPointInsideVolumeForbiddenRegions(seedX, seedY, seedZ, forbiddenRegions)
  ) {
    return getEmptyVolumeGrowResult()
  }

  const seedIndex = getVolumeLinearIndex(context, [seedX, seedY, seedZ])
  if (seedIndex === null) {
    return getEmptyVolumeGrowResult()
  }

  const seedHu = getHuAtVolumeIndex(context, seedIndex)
  if (!Number.isFinite(seedHu) || seedHu < lower || seedHu > upper) {
    return getEmptyVolumeGrowResult()
  }

  const radius = Math.max(1, Math.ceil(maxDistanceVoxels))
  const minX = Math.max(0, seedX - radius)
  const maxX = Math.min(width - 1, seedX + radius)
  const minY = Math.max(0, seedY - radius)
  const maxY = Math.min(height - 1, seedY + radius)
  const minZ = Math.max(0, seedZ - radius)
  const maxZ = Math.min(depth - 1, seedZ + radius)
  const boxWidth = maxX - minX + 1
  const boxHeight = maxY - minY + 1
  const boxDepth = maxZ - minZ + 1
  const boxSliceSize = boxWidth * boxHeight
  const boxVoxelCount = boxSliceSize * boxDepth
  const maxAccepted = Math.max(1, Math.min(Math.floor(maxVoxels), boxVoxelCount))
  const visited = new Uint8Array(boxVoxelCount)
  const queue = new Int32Array(boxVoxelCount)
  const accepted = new Int32Array(maxAccepted)
  const maxDistanceSquared = maxDistanceVoxels * maxDistanceVoxels
  const gradientDistanceThreshold = maxDistanceVoxels * clampNumber(gradientDistanceRatio, 0, 0.9)
  let head = 0
  let tail = 0
  let acceptedCount = 0
  let reachedLimit = false
  let sumHu = 0
  let sumHuSquares = 0

  enqueue(seedX, seedY, seedZ)

  while (head < tail) {
    const localIndex = queue[head]
    head += 1

    const localZ = Math.floor(localIndex / boxSliceSize)
    const remainder = localIndex - localZ * boxSliceSize
    const localY = Math.floor(remainder / boxWidth)
    const localX = remainder - localY * boxWidth
    const x = minX + localX
    const y = minY + localY
    const z = minZ + localZ
    const dx = x - seedX
    const dy = y - seedY
    const dz = z - seedZ
    const distanceSquared = dx * dx + dy * dy + dz * dz
    if (distanceSquared > maxDistanceSquared) {
      continue
    }

    const index = z * sliceSize + y * width + x
    if (index >= voxelCount) {
      continue
    }

    const hu = getHuAtVolumeIndex(context, index)
    if (!Number.isFinite(hu) || hu < lower || hu > upper) {
      continue
    }

    const distanceVoxels = Math.sqrt(distanceSquared)
    if (distanceWeighting && !isHuAcceptedByDistanceWeighting(distanceWeighting, hu, distanceVoxels)) {
      continue
    }

    const seedDelta = expectedSeedHu !== undefined ? Math.abs(hu - expectedSeedHu) : 0
    const shouldCheckGradient = gradientStop !== undefined
      && acceptedCount > 0
      && distanceVoxels > gradientDistanceThreshold
    const gradient = shouldCheckGradient ? getVolumeGradientMagnitude(context, x, y, z) : 0
    if (shouldCheckGradient && gradient > gradientStop && seedDelta > 6) {
      continue
    }

    if (acceptedCount >= maxAccepted) {
      reachedLimit = true
      break
    }

    accepted[acceptedCount] = index
    acceptedCount += 1
    sumHu += hu
    sumHuSquares += hu * hu

    enqueue(x - 1, y, z)
    enqueue(x + 1, y, z)
    enqueue(x, y - 1, z)
    enqueue(x, y + 1, z)
    enqueue(x, y, z - 1)
    enqueue(x, y, z + 1)
  }

  if (acceptedCount < minVoxels) {
    return {
      matchedVoxels: 0,
      acceptedVoxels: acceptedCount,
      meanHu: getMeanFromMoments(sumHu, acceptedCount),
      stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, acceptedCount),
      reachedLimit,
      seedAccepted: true,
      volumeMl: null,
      modifiedSlices: [],
      modifiedIndices: [],
      addedIndices: [],
      removedIndices: [],
    }
  }

  const modifiedSlices = new Set<number>()
  const modifiedIndices: number[] = []
  const addedIndices: number[] = []
  const removedIndices: number[] = []
  let matchedVoxels = 0
  for (let acceptedIndex = 0; acceptedIndex < acceptedCount; acceptedIndex += 1) {
    const voxelIndex = accepted[acceptedIndex]
    const currentValue = getVolumeLabelmapValue(context, voxelIndex)
    if (mode === 'erase') {
      if (currentValue === ICH_SEGMENT_INDEX) {
        setVolumeLabelmapValue(context, voxelIndex, 0)
        modifiedSlices.add(Math.floor(voxelIndex / sliceSize))
        modifiedIndices.push(voxelIndex)
        removedIndices.push(voxelIndex)
        matchedVoxels += 1
      }
    } else if (currentValue !== ICH_SEGMENT_INDEX) {
      setVolumeLabelmapValue(context, voxelIndex, ICH_SEGMENT_INDEX)
      modifiedSlices.add(Math.floor(voxelIndex / sliceSize))
      modifiedIndices.push(voxelIndex)
      addedIndices.push(voxelIndex)
      matchedVoxels += 1
    }
  }

  if (mode === 'add' && addedIndices.length > 0) {
    const smoothing = smoothIchVolumeMaskInModifiedSlices(context, addedIndices)
    smoothing.addedIndices.forEach((index) => {
      addedIndices.push(index)
      modifiedIndices.push(index)
      modifiedSlices.add(Math.floor(index / sliceSize))
      matchedVoxels += 1
    })
    smoothing.removedIndices.forEach((index) => {
      removedIndices.push(index)
      modifiedIndices.push(index)
      modifiedSlices.add(Math.floor(index / sliceSize))
      matchedVoxels = Math.max(0, matchedVoxels - 1)
    })
  }

  return {
    matchedVoxels,
    acceptedVoxels: acceptedCount,
    meanHu: getMeanFromMoments(sumHu, acceptedCount),
    stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, acceptedCount),
    reachedLimit,
    seedAccepted: true,
    volumeMl: matchedVoxels > 0 ? (matchedVoxels * context.voxelVolumeMm3) / 1000 : null,
    modifiedSlices: Array.from(modifiedSlices).sort((a, b) => a - b),
    modifiedIndices,
    addedIndices,
    removedIndices,
  }

  function enqueue(x: number, y: number, z: number) {
    if (
      x < minX
      || x > maxX
      || y < minY
      || y > maxY
      || z < minZ
      || z > maxZ
      || isPointInsideVolumeForbiddenRegions(x, y, z, forbiddenRegions)
    ) {
      return
    }

    const dx = x - seedX
    const dy = y - seedY
    const dz = z - seedZ
    if (dx * dx + dy * dy + dz * dz > maxDistanceSquared) {
      return
    }

    const localIndex = (z - minZ) * boxSliceSize + (y - minY) * boxWidth + (x - minX)
    if (visited[localIndex]) {
      return
    }

    visited[localIndex] = 1
    queue[tail] = localIndex
    tail += 1
  }
}

function smoothIchVolumeMaskInModifiedSlices(context: VolumeContext, seedIndices: number[]) {
  const [width, height, depth] = context.dimensions.map((value) => Math.floor(value)) as Types.Point3
  const sliceSize = width * height
  const sliceBounds = new Map<number, Bounds2D>()
  const addedIndices = new Set<number>()
  const removedIndices = new Set<number>()

  seedIndices.forEach((index) => {
    if (index < 0 || index >= context.voxelCount) {
      return
    }

    const z = Math.floor(index / sliceSize)
    if (z < 0 || z >= depth) {
      return
    }

    const offset = index - z * sliceSize
    const y = Math.floor(offset / width)
    const x = offset - y * width
    const current = sliceBounds.get(z)
    if (current) {
      current.minX = Math.min(current.minX, x)
      current.maxX = Math.max(current.maxX, x)
      current.minY = Math.min(current.minY, y)
      current.maxY = Math.max(current.maxY, y)
    } else {
      sliceBounds.set(z, { minX: x, maxX: x, minY: y, maxY: y })
    }
  })

  sliceBounds.forEach((bounds, z) => {
    const roi = expandBounds(bounds, 5, width, height)
    closeSmallMaskGapsOnVolumeSlice(context, z, roi, addedIndices)
    closeSmallMaskGapsOnVolumeSlice(context, z, roi, addedIndices, 4)
    fillEnclosedMaskHolesOnVolumeSlice(context, z, roi, addedIndices)
    removeTinyMaskIslandsOnVolumeSlice(context, z, roi, addedIndices, removedIndices)
  })

  removedIndices.forEach((index) => {
    addedIndices.delete(index)
  })

  return {
    addedIndices: Array.from(addedIndices),
    removedIndices: Array.from(removedIndices),
  }
}

function closeSmallMaskGapsOnVolumeSlice(
  context: VolumeContext,
  z: number,
  bounds: Bounds2D,
  addedIndices: Set<number>,
  neighborThreshold = 5,
) {
  const width = Math.floor(context.dimensions[0])
  const sliceSize = width * Math.floor(context.dimensions[1])
  const toAdd: number[] = []

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const index = z * sliceSize + y * width + x
      if (getVolumeLabelmapValue(context, index) === ICH_SEGMENT_INDEX) {
        continue
      }

      const neighbors = countMasked2DNeighbors(context, x, y, z)
      if (neighbors >= neighborThreshold) {
        toAdd.push(index)
      }
    }
  }

  toAdd.forEach((index) => {
    if (getVolumeLabelmapValue(context, index) !== ICH_SEGMENT_INDEX) {
      setVolumeLabelmapValue(context, index, ICH_SEGMENT_INDEX)
      addedIndices.add(index)
    }
  })
}

function fillEnclosedMaskHolesOnVolumeSlice(
  context: VolumeContext,
  z: number,
  bounds: Bounds2D,
  addedIndices: Set<number>,
) {
  const width = Math.floor(context.dimensions[0])
  const sliceSize = width * Math.floor(context.dimensions[1])
  const roiWidth = bounds.maxX - bounds.minX + 1
  const roiHeight = bounds.maxY - bounds.minY + 1
  const roiSize = roiWidth * roiHeight
  if (roiSize <= 0 || roiSize > 20000) {
    return
  }

  const visited = new Uint8Array(roiSize)
  const queue = new Int32Array(roiSize)
  let head = 0
  let tail = 0

  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    enqueueBackground(x, bounds.minY)
    enqueueBackground(x, bounds.maxY)
  }
  for (let y = bounds.minY + 1; y < bounds.maxY; y += 1) {
    enqueueBackground(bounds.minX, y)
    enqueueBackground(bounds.maxX, y)
  }

  while (head < tail) {
    const localIndex = queue[head]
    head += 1
    const y = bounds.minY + Math.floor(localIndex / roiWidth)
    const x = bounds.minX + (localIndex % roiWidth)
    enqueueBackground(x - 1, y)
    enqueueBackground(x + 1, y)
    enqueueBackground(x, y - 1)
    enqueueBackground(x, y + 1)
  }

  for (let y = bounds.minY + 1; y < bounds.maxY; y += 1) {
    for (let x = bounds.minX + 1; x < bounds.maxX; x += 1) {
      const localIndex = (y - bounds.minY) * roiWidth + (x - bounds.minX)
      const index = z * sliceSize + y * width + x
      if (
        !visited[localIndex]
        && getVolumeLabelmapValue(context, index) !== ICH_SEGMENT_INDEX
        && countMasked2DNeighbors(context, x, y, z) >= 2
      ) {
        setVolumeLabelmapValue(context, index, ICH_SEGMENT_INDEX)
        addedIndices.add(index)
      }
    }
  }

  function enqueueBackground(x: number, y: number) {
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      return
    }

    const localIndex = (y - bounds.minY) * roiWidth + (x - bounds.minX)
    if (visited[localIndex]) {
      return
    }

    const index = z * sliceSize + y * width + x
    if (getVolumeLabelmapValue(context, index) === ICH_SEGMENT_INDEX) {
      return
    }

    visited[localIndex] = 1
    queue[tail] = localIndex
    tail += 1
  }
}

function removeTinyMaskIslandsOnVolumeSlice(
  context: VolumeContext,
  z: number,
  bounds: Bounds2D,
  addedIndices: Set<number>,
  removedIndices: Set<number>,
) {
  const width = Math.floor(context.dimensions[0])
  const sliceSize = width * Math.floor(context.dimensions[1])
  const roiWidth = bounds.maxX - bounds.minX + 1
  const roiHeight = bounds.maxY - bounds.minY + 1
  const roiSize = roiWidth * roiHeight
  if (roiSize <= 0 || roiSize > 20000) {
    return
  }

  const visited = new Uint8Array(roiSize)
  const queue = new Int32Array(roiSize)
  const component: number[] = []
  const tinyIslandMaxPixels = 3
  let componentHead = 0
  let componentTail = 0

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const startLocal = (y - bounds.minY) * roiWidth + (x - bounds.minX)
      const startIndex = z * sliceSize + y * width + x
      if (visited[startLocal] || getVolumeLabelmapValue(context, startIndex) !== ICH_SEGMENT_INDEX) {
        continue
      }

      component.length = 0
      componentHead = 0
      componentTail = 0
      visited[startLocal] = 1
      queue[componentTail] = startLocal
      componentTail += 1

      while (componentHead < componentTail) {
        const localIndex = queue[componentHead]
        componentHead += 1
        const componentY = bounds.minY + Math.floor(localIndex / roiWidth)
        const componentX = bounds.minX + (localIndex % roiWidth)
        component.push(z * sliceSize + componentY * width + componentX)
        enqueueMask(componentX - 1, componentY)
        enqueueMask(componentX + 1, componentY)
        enqueueMask(componentX, componentY - 1)
        enqueueMask(componentX, componentY + 1)
      }

      if (component.length <= tinyIslandMaxPixels) {
        component.forEach((index) => {
          setVolumeLabelmapValue(context, index, 0)
          addedIndices.delete(index)
          removedIndices.add(index)
        })
      }
    }
  }

  function enqueueMask(x: number, y: number) {
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      return
    }

    const localIndex = (y - bounds.minY) * roiWidth + (x - bounds.minX)
    if (visited[localIndex]) {
      return
    }

    const index = z * sliceSize + y * width + x
    if (getVolumeLabelmapValue(context, index) !== ICH_SEGMENT_INDEX) {
      return
    }

    visited[localIndex] = 1
    queue[componentTail] = localIndex
    componentTail += 1
  }
}

function countMasked2DNeighbors(context: VolumeContext, x: number, y: number, z: number) {
  const width = Math.floor(context.dimensions[0])
  const height = Math.floor(context.dimensions[1])
  const sliceSize = width * height
  let count = 0

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue
      }

      const neighborX = x + dx
      const neighborY = y + dy
      if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
        continue
      }

      const index = z * sliceSize + neighborY * width + neighborX
      if (getVolumeLabelmapValue(context, index) === ICH_SEGMENT_INDEX) {
        count += 1
      }
    }
  }

  return count
}

function eraseIchMaskAlongVolumeDrag(
  context: VolumeContext,
  {
    seedIJK,
    dragIJK,
    clearRadiusVoxels,
    maxVoxels = 90000,
  }: {
    seedIJK: Types.Point3
    dragIJK: Types.Point3
    clearRadiusVoxels: number
    maxVoxels?: number
  },
): InternalVolumeRegionGrowResult {
  const [width, height, depth] = context.dimensions.map((value) => Math.floor(value)) as Types.Point3
  const voxelCount = Math.min(width * height * depth, context.voxelCount)
  const radius = clampNumber(clearRadiusVoxels, 2, 18)
  const padding = Math.ceil(radius)
  const start = [
    clampNumber(seedIJK[0], 0, width - 1),
    clampNumber(seedIJK[1], 0, height - 1),
    clampNumber(seedIJK[2], 0, depth - 1),
  ] as Types.Point3
  const end = [
    clampNumber(dragIJK[0], 0, width - 1),
    clampNumber(dragIJK[1], 0, height - 1),
    clampNumber(dragIJK[2], 0, depth - 1),
  ] as Types.Point3

  if (voxelCount <= 0 || width <= 0 || height <= 0 || depth <= 0) {
    return getEmptyVolumeGrowResult()
  }

  const minX = Math.max(0, Math.floor(Math.min(start[0], end[0]) - padding))
  const maxX = Math.min(width - 1, Math.ceil(Math.max(start[0], end[0]) + padding))
  const minY = Math.max(0, Math.floor(Math.min(start[1], end[1]) - padding))
  const maxY = Math.min(height - 1, Math.ceil(Math.max(start[1], end[1]) + padding))
  const minZ = Math.max(0, Math.floor(Math.min(start[2], end[2]) - padding))
  const maxZ = Math.min(depth - 1, Math.ceil(Math.max(start[2], end[2]) + padding))
  const sliceSize = width * height
  const modifiedSlices = new Set<number>()
  const modifiedIndices: number[] = []
  const addedIndices: number[] = []
  const removedIndices: number[] = []
  const maxInspected = Math.max(1, Math.floor(maxVoxels))
  let inspectedVoxels = 0
  let matchedVoxels = 0
  let reachedLimit = false
  let sumHu = 0
  let sumHuSquares = 0

  scanVolume:
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (getDistanceToVolumeSegment([x, y, z], start, end) > radius) {
          continue
        }

        inspectedVoxels += 1
        if (inspectedVoxels > maxInspected) {
          reachedLimit = true
          break scanVolume
        }

        const index = z * sliceSize + y * width + x
        if (index >= voxelCount || getVolumeLabelmapValue(context, index) !== ICH_SEGMENT_INDEX) {
          continue
        }

        const hu = getHuAtVolumeIndex(context, index)
        if (Number.isFinite(hu)) {
          sumHu += hu
          sumHuSquares += hu * hu
        }
        setVolumeLabelmapValue(context, index, 0)
        modifiedSlices.add(z)
        modifiedIndices.push(index)
        removedIndices.push(index)
        matchedVoxels += 1
      }
    }
  }

  return {
    matchedVoxels,
    acceptedVoxels: inspectedVoxels,
    meanHu: getMeanFromMoments(sumHu, matchedVoxels),
    stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, matchedVoxels),
    reachedLimit,
    seedAccepted: true,
    volumeMl: matchedVoxels > 0 ? (matchedVoxels * context.voxelVolumeMm3) / 1000 : null,
    modifiedSlices: Array.from(modifiedSlices).sort((a, b) => a - b),
    modifiedIndices,
    addedIndices,
    removedIndices,
  }
}

function getEmptyVolumeGrowResult(): InternalVolumeRegionGrowResult {
  return {
    matchedVoxels: 0,
    acceptedVoxels: 0,
    meanHu: null,
    stdDevHu: null,
    reachedLimit: false,
    seedAccepted: false,
    volumeMl: null,
    modifiedSlices: [],
    modifiedIndices: [],
    addedIndices: [],
    removedIndices: [],
  }
}

function clearStackLabelmapSegment(segmentationId: string) {
  getIchLabelmapImageIds(segmentationId).forEach((imageId) => {
    const image = cache.getImage(imageId) as ThresholdImage | undefined
    const pixels = getImageScalarData(image)
    if (!pixels?.length) {
      return
    }

    let modified = false
    for (let index = 0; index < pixels.length; index += 1) {
      if (Number(pixels[index]) === ICH_SEGMENT_INDEX) {
        pixels[index] = 0
        modified = true
      }
    }

    if (modified) {
      markImageLabelmapModified(image)
    }
  })
}

function findAdaptiveSeed(
  context: StackSliceContext,
  centroid: Types.Point2,
  bounds: Bounds2D,
  lower: number,
  upper: number,
  searchRadius: number,
) {
  const centerX = Math.round(centroid[0])
  const centerY = Math.round(centroid[1])
  const radius = Math.max(1, Math.floor(searchRadius))
  const minX = Math.max(bounds.minX, centerX - radius, 0)
  const maxX = Math.min(bounds.maxX, centerX + radius, context.width - 1)
  const minY = Math.max(bounds.minY, centerY - radius, 0)
  const maxY = Math.min(bounds.maxY, centerY + radius, context.height - 1)
  let bestPoint: Types.Point2 | null = null
  let bestHu = 0
  let bestScore = Number.POSITIVE_INFINITY

  for (let y = minY; y <= maxY; y += 1) {
    const rowOffset = y * context.width
    for (let x = minX; x <= maxX; x += 1) {
      const hu = getHuAtPixel(context, rowOffset + x)
      if (!Number.isFinite(hu) || hu < lower || hu > upper) {
        continue
      }

      const dx = x - centroid[0]
      const dy = y - centroid[1]
      const score = dx * dx + dy * dy
      if (score < bestScore) {
        bestScore = score
        bestPoint = [x, y]
        bestHu = hu
      }
    }
  }

  return bestPoint ? { point: bestPoint, hu: bestHu } : null
}

export function mergeIchAdaptiveHuModels(
  current: IchAdaptiveHuModel | null | undefined,
  next: IchAdaptiveHuModel | null | undefined,
): IchAdaptiveHuModel | null {
  if (!next) {
    return current ?? null
  }
  if (!current) {
    return next
  }

  const currentSamples = clampNumber(current.samples, 120, 8000)
  const nextSamples = clampNumber(next.samples, 120, 12000)
  const totalSamples = currentSamples + nextSamples
  const delta = next.meanHu - current.meanHu
  const meanHu = (current.meanHu * currentSamples + next.meanHu * nextSamples) / totalSamples
  const currentVariance = current.stdDevHu * current.stdDevHu
  const nextVariance = next.stdDevHu * next.stdDevHu
  const variance = (
    currentSamples * currentVariance
    + nextSamples * nextVariance
    + (delta * delta * currentSamples * nextSamples) / totalSamples
  ) / totalSamples
  const stdDevHu = Math.sqrt(Math.max(0, variance))
  const tolerance = clampNumber(Math.max(12, stdDevHu * 2.4 + 8), 12, 48)

  return {
    meanHu,
    stdDevHu,
    samples: Math.min(current.samples + next.samples, 40000),
    minimumHu: Math.floor(Math.max(-1000, meanHu - tolerance)),
    maximumHu: Math.ceil(Math.min(3000, meanHu + tolerance)),
  }
}

function createIchAdaptiveHuModelFromRegion(
  result: Pick<InternalRegionGrowResult, 'acceptedVoxels' | 'meanHu' | 'stdDevHu'> | null,
  fallbackMinimumHu: number,
  fallbackMaximumHu: number,
): IchAdaptiveHuModel | null {
  if (!result?.acceptedVoxels || result.meanHu === null || result.stdDevHu === null) {
    return null
  }

  const stdDevHu = clampNumber(result.stdDevHu, 2, 60)
  const tolerance = clampNumber(Math.max(12, stdDevHu * 2.6 + 8), 12, 52)

  return {
    meanHu: result.meanHu,
    stdDevHu,
    samples: result.acceptedVoxels,
    minimumHu: Math.floor(Math.max(-1000, Math.max(Math.min(fallbackMinimumHu, fallbackMaximumHu), result.meanHu - tolerance))),
    maximumHu: Math.ceil(Math.min(3000, Math.min(Math.max(fallbackMinimumHu, fallbackMaximumHu), result.meanHu + tolerance))),
  }
}

/** Toleransi HU dari model jaringan adaptif (dipakai jalur lain & pengukuran). */
export function getIchModelTolerance(model: IchAdaptiveHuModel, minimumToleranceHu: number) {
  return clampNumber(Math.max(minimumToleranceHu, model.stdDevHu * 2.4 + 8), 10, 46)
}

function selectBalancedHuLineSeeds<TSeed extends { ratio: number }>(seeds: TSeed[], lineDistance: number): TSeed[] {
  if (seeds.length <= 1) {
    return seeds
  }

  const targetCount = Math.round(clampNumber(Math.ceil(lineDistance / 7) + 2, 3, 9))
  const selected = new Set<TSeed>()
  const huRank = new Map<TSeed, number>()
  seeds.forEach((seed, index) => huRank.set(seed, index))
  const targetRatios = Array.from({ length: targetCount }, (_, index) => {
    if (targetCount === 1) {
      return 0.5
    }

    return 0.12 + (0.76 * index) / (targetCount - 1)
  })

  targetRatios.forEach((targetRatio) => {
    let bestSeed: TSeed | null = null
    let bestScore = Number.POSITIVE_INFINITY
    seeds.forEach((seed) => {
      if (selected.has(seed)) {
        return
      }

      const score = Math.abs(seed.ratio - targetRatio) * 3 + (huRank.get(seed) ?? 0) * 0.012
      if (score < bestScore) {
        bestScore = score
        bestSeed = seed
      }
    })
    if (bestSeed) {
      selected.add(bestSeed)
    }
  })

  seeds.slice(0, Math.min(3, seeds.length)).forEach((seed) => {
    if (selected.size < targetCount) {
      selected.add(seed)
    }
  })

  return Array.from(selected).sort((left, right) => left.ratio - right.ratio)
}

function getEmptyVolumeSmartDragResult({
  minimumHu,
  maximumHu,
  totalVoxels,
  totalVolumeMl,
  failureReason,
}: {
  minimumHu: number
  maximumHu: number
  totalVoxels: number
  totalVolumeMl: number | null
  failureReason: IchVolumeSmartDragResult['failureReason']
}): IchVolumeSmartDragResult {
  return {
    matchedVoxels: 0,
    acceptedVoxels: 0,
    reachedLimit: false,
    seedAccepted: false,
    volumeMl: null,
    radiusVoxels: 0,
    minimumHu,
    maximumHu,
    meanHu: null,
    stdDevHu: null,
    adaptiveModel: null,
    totalVoxels,
    totalVolumeMl,
    failureReason,
  }
}

function inferScribblePlane(points: Types.Point3[]): ScribbleVolumePlane {
  const ranges = [0, 1, 2].map((axis) => {
    const values = points.map((point) => point[axis])
    return Math.max(...values) - Math.min(...values)
  })
  const fixedAxis = ranges.reduce((bestAxis, range, axis) => (range < ranges[bestAxis] ? axis : bestAxis), 0) as VolumeAxis
  const sortedFixedValues = points.map((point) => point[fixedAxis]).sort((left, right) => left - right)
  const fixedIndex = Math.round(getSortedPercentile(sortedFixedValues, 0.5))
  const [uAxis, vAxis] = ([0, 1, 2] as VolumeAxis[]).filter((axis) => axis !== fixedAxis)

  return {
    fixedAxis,
    uAxis,
    vAxis,
    fixedIndex,
    uSize: 0,
    vSize: 0,
  }
}

function getScribblePlaneWithDimensions(context: VolumeContext, plane: ScribbleVolumePlane): ScribbleVolumePlane {
  return {
    ...plane,
    uSize: Math.floor(context.dimensions[plane.uAxis]),
    vSize: Math.floor(context.dimensions[plane.vAxis]),
  }
}

function getScribblePlaneUV(plane: ScribbleVolumePlane, point: Types.Point3): Types.Point2 {
  return [Math.round(point[plane.uAxis]), Math.round(point[plane.vAxis])]
}

function getScribblePlaneIJK(plane: ScribbleVolumePlane, u: number, v: number): Types.Point3 {
  const point = [0, 0, 0] as Types.Point3
  point[plane.fixedAxis] = plane.fixedIndex
  point[plane.uAxis] = Math.round(u)
  point[plane.vAxis] = Math.round(v)

  return point
}

function getScribblePlaneKey(u: number, v: number) {
  return `${Math.round(u)},${Math.round(v)}`
}

function getScribblePlaneIJKFromKey(plane: ScribbleVolumePlane, key: string): Types.Point3 {
  const [u, v] = key.split(',').map((value) => Number(value))
  return getScribblePlaneIJK(plane, u, v)
}

function rasterizeScribblePlaneSeeds(
  context: VolumeContext,
  planeInput: ScribbleVolumePlane,
  points: Types.Point3[],
  radiusVoxels: number,
  forbiddenRegions: IchVolumeForbiddenRegion[],
) {
  const plane = getScribblePlaneWithDimensions(context, planeInput)
  const radius = Math.max(1, Math.ceil(radiusVoxels))
  const radiusSquared = radiusVoxels * radiusVoxels
  const seedSet = new Set<string>()

  for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
    const start = getScribblePlaneUV(plane, points[pointIndex - 1])
    const end = getScribblePlaneUV(plane, points[pointIndex])
    const distance = Math.hypot(end[0] - start[0], end[1] - start[1])
    const steps = Math.max(1, Math.ceil(distance * 1.75))
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps
      const centerU = start[0] + (end[0] - start[0]) * ratio
      const centerV = start[1] + (end[1] - start[1]) * ratio
      for (let dv = -radius; dv <= radius; dv += 1) {
        for (let du = -radius; du <= radius; du += 1) {
          if (du * du + dv * dv > radiusSquared) {
            continue
          }

          const u = Math.round(centerU + du)
          const v = Math.round(centerV + dv)
          if (u < 0 || u >= plane.uSize || v < 0 || v >= plane.vSize) {
            continue
          }

          const ijk = getScribblePlaneIJK(plane, u, v)
          if (isPointInsideVolumeForbiddenRegions(ijk[0], ijk[1], ijk[2], forbiddenRegions)) {
            continue
          }

          seedSet.add(getScribblePlaneKey(u, v))
        }
      }
    }
  }

  return seedSet
}

function getScribblePlaneSeedBounds(
  context: VolumeContext,
  planeInput: ScribbleVolumePlane,
  seedSet: Set<string>,
  margin: number,
): Bounds2D {
  const plane = getScribblePlaneWithDimensions(context, planeInput)
  let minU = plane.uSize - 1
  let maxU = 0
  let minV = plane.vSize - 1
  let maxV = 0

  seedSet.forEach((key) => {
    const [u, v] = key.split(',').map((value) => Number(value))
    minU = Math.min(minU, u)
    maxU = Math.max(maxU, u)
    minV = Math.min(minV, v)
    maxV = Math.max(maxV, v)
  })

  return {
    minX: Math.max(0, minU - margin),
    maxX: Math.min(plane.uSize - 1, maxU + margin),
    minY: Math.max(0, minV - margin),
    maxY: Math.min(plane.vSize - 1, maxV + margin),
  }
}

function createIchAdaptiveHuModelFromValues(values: number[]): IchAdaptiveHuModel | null {
  const finiteValues = values.filter((value) => Number.isFinite(value))
  if (finiteValues.length < 3) {
    return null
  }

  finiteValues.sort((left, right) => left - right)
  const median = getSortedPercentile(finiteValues, 0.5)
  const deviations = finiteValues.map((value) => Math.abs(value - median)).sort((left, right) => left - right)
  const mad = getSortedPercentile(deviations, 0.5)
  const robustWindow = clampNumber(Math.max(10, mad * 3.6 + 7), 10, 64)
  let robustValues = finiteValues.filter((value) => Math.abs(value - median) <= robustWindow)
  if (robustValues.length < 3) {
    robustValues = finiteValues
  }

  const sum = robustValues.reduce((total, value) => total + value, 0)
  const sumSquares = robustValues.reduce((total, value) => total + value * value, 0)
  const meanHu = sum / robustValues.length
  const variance = Math.max(0, sumSquares / robustValues.length - meanHu * meanHu)
  const stdDevHu = clampNumber(Math.sqrt(variance), 2, 72)
  const sortedValues = [...robustValues].sort((left, right) => left - right)
  const lowerPercentile = getSortedPercentile(sortedValues, 0.12)
  const upperPercentile = getSortedPercentile(sortedValues, 0.88)
  const tolerance = clampNumber(
    Math.max(12, stdDevHu * 2.35 + 8, (upperPercentile - lowerPercentile) * 0.54 + 9),
    12,
    64,
  )

  return {
    meanHu,
    stdDevHu,
    samples: robustValues.length,
    minimumHu: Math.floor(Math.max(-1000, lowerPercentile - tolerance * 0.45)),
    maximumHu: Math.ceil(Math.min(3000, upperPercentile + tolerance * 0.6)),
  }
}

function extractScribbleMaskOnPlane(
  context: VolumeContext,
  {
    plane: planeInput,
    bounds,
    foregroundSeedSet,
    foregroundModel,
    forbiddenRegions,
    maxVoxels,
  }: {
    plane: ScribbleVolumePlane
    bounds: Bounds2D
    foregroundSeedSet: Set<string>
    foregroundModel: IchAdaptiveHuModel
    forbiddenRegions: IchVolumeForbiddenRegion[]
    maxVoxels: number
  },
): InternalVolumeRegionGrowResult {
  const plane = getScribblePlaneWithDimensions(context, planeInput)
  const width = bounds.maxX - bounds.minX + 1
  const height = bounds.maxY - bounds.minY + 1
  const count = width * height
  const huValues = new Float32Array(count)
  const validMask = new Uint8Array(count)
  const foregroundSeeds = new Uint8Array(count)
  const backgroundSeeds = new Uint8Array(count)
  const seedCoordinates: Types.Point2[] = []
  const modelTolerance = clampNumber(Math.max(13, foregroundModel.stdDevHu * 2.25 + 9), 13, 68)
  const lowerGuard = foregroundModel.minimumHu - modelTolerance * 0.8
  const upperGuard = Math.min(
    foregroundModel.maximumHu + modelTolerance * 0.9,
    Math.max(118, foregroundModel.meanHu + Math.max(42, modelTolerance * 1.55)),
  )
  const boneLikeHu = Math.max(120, foregroundModel.meanHu + Math.max(44, modelTolerance * 1.45))
  const lowBackgroundHu = foregroundModel.meanHu - Math.max(26, modelTolerance * 1.65)

  for (let localY = 0; localY < height; localY += 1) {
    const v = bounds.minY + localY
    for (let localX = 0; localX < width; localX += 1) {
      const u = bounds.minX + localX
      const localIndex = localY * width + localX
      const ijk = getScribblePlaneIJK(plane, u, v)
      const volumeIndex = getVolumeLinearIndex(context, ijk)
      if (volumeIndex === null) {
        huValues[localIndex] = Number.NaN
        continue
      }

      const hu = getHuAtVolumeIndex(context, volumeIndex)
      huValues[localIndex] = Number.isFinite(hu) ? hu : Number.NaN
      if (!Number.isFinite(hu)) {
        continue
      }

      validMask[localIndex] = 1
      const key = getScribblePlaneKey(u, v)
      if (foregroundSeedSet.has(key)) {
        foregroundSeeds[localIndex] = 1
        seedCoordinates.push([localX, localY])
      }
      if (
        localX <= 1
        || localY <= 1
        || localX >= width - 2
        || localY >= height - 2
        || isPointInsideVolumeForbiddenRegions(ijk[0], ijk[1], ijk[2], forbiddenRegions)
      ) {
        backgroundSeeds[localIndex] = 1
      }
    }
  }

  if (seedCoordinates.length === 0) {
    return getEmptyVolumeGrowResult()
  }

  for (let localY = 0; localY < height; localY += 1) {
    for (let localX = 0; localX < width; localX += 1) {
      const localIndex = localY * width + localX
      if (!validMask[localIndex] || foregroundSeeds[localIndex] || backgroundSeeds[localIndex]) {
        continue
      }

      const hu = huValues[localIndex]
      const distanceToSeed = getSquaredDistanceToClosestSeed(localX, localY, seedCoordinates)
      if (
        hu > boneLikeHu
        || hu < lowBackgroundHu
        || (
          distanceToSeed > 36
          && (hu < lowerGuard || hu > upperGuard || Math.abs(hu - foregroundModel.meanHu) > modelTolerance * 1.85)
        )
      ) {
        backgroundSeeds[localIndex] = 1
      }
    }
  }

  const foregroundCosts = computeScribbleGeodesicCosts({
    width,
    height,
    huValues,
    validMask,
    seedMask: foregroundSeeds,
    foregroundModel,
    mode: 'foreground',
  })
  const backgroundCosts = computeScribbleGeodesicCosts({
    width,
    height,
    huValues,
    validMask,
    seedMask: backgroundSeeds,
    foregroundModel,
    mode: 'background',
  })
  let mask = new Uint8Array(count)
  let candidateCount = 0

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    if (!validMask[localIndex]) {
      continue
    }

    const hu = huValues[localIndex]
    const foregroundCost = foregroundCosts[localIndex]
    const backgroundCost = backgroundCosts[localIndex]
    const modelPenalty = getScribbleForegroundPenalty(hu, foregroundModel, modelTolerance)
    if (
      Number.isFinite(foregroundCost)
      && foregroundCost <= backgroundCost * 0.92 + 1.35
      && modelPenalty <= 2.65
      && hu <= boneLikeHu
      && hu >= lowerGuard
    ) {
      mask[localIndex] = 1
      candidateCount += 1
    }
  }

  if (candidateCount <= 0) {
    return getEmptyVolumeGrowResult()
  }

  mask = keepScribbleSeedConnectedMask(mask, foregroundSeeds, width, height)
  mask = smoothScribbleExtractMask(mask, foregroundSeeds, backgroundSeeds, width, height)
  const activeIndices = Array.from(mask.entries())
    .filter(([, value]) => value > 0)
    .map(([index]) => index)
  const reachedLimit = activeIndices.length > maxVoxels
  const commitIndices = reachedLimit
    ? activeIndices
      .sort((left, right) => foregroundCosts[left] - backgroundCosts[left] - (foregroundCosts[right] - backgroundCosts[right]))
      .slice(0, maxVoxels)
    : activeIndices

  return commitScribblePlaneMask(context, {
    plane,
    bounds,
    localMaskIndices: commitIndices,
    huValues,
    width,
    reachedLimit,
  })
}

function computeScribbleGeodesicCosts({
  width,
  height,
  huValues,
  validMask,
  seedMask,
  foregroundModel,
  mode,
}: {
  width: number
  height: number
  huValues: Float32Array
  validMask: Uint8Array
  seedMask: Uint8Array
  foregroundModel: IchAdaptiveHuModel
  mode: 'foreground' | 'background'
}) {
  const count = width * height
  const costs = new Float32Array(count)
  costs.fill(Number.POSITIVE_INFINITY)
  const heap = new IchMinHeap()
  const tolerance = clampNumber(Math.max(12, foregroundModel.stdDevHu * 2.1 + 8), 12, 64)
  const edgeScale = clampNumber(Math.max(8, foregroundModel.stdDevHu * 1.35 + 7), 8, 38)
  const offsets = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, 1, Math.SQRT2],
  ] as const

  for (let index = 0; index < count; index += 1) {
    if (seedMask[index] && validMask[index]) {
      costs[index] = 0
      heap.push(index, 0)
    }
  }

  while (heap.size > 0) {
    const item = heap.pop()
    if (!item || item.cost > costs[item.index] + 0.0001) {
      continue
    }

    const x = item.index % width
    const y = Math.floor(item.index / width)
    const sourceHu = huValues[item.index]
    for (const [dx, dy, distance] of offsets) {
      const neighborX = x + dx
      const neighborY = y + dy
      if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
        continue
      }

      const neighborIndex = neighborY * width + neighborX
      if (!validMask[neighborIndex]) {
        continue
      }

      const neighborHu = huValues[neighborIndex]
      const edgeDelta = Math.abs(neighborHu - sourceHu)
      const gradientCost = distance * (1 + edgeDelta / edgeScale)
      const foregroundPenalty = getScribbleForegroundPenalty(neighborHu, foregroundModel, tolerance)
      const unaryCost = mode === 'foreground'
        ? foregroundPenalty * 1.95
        : Math.max(0, 1 - Math.abs(neighborHu - foregroundModel.meanHu) / Math.max(1, tolerance)) * 0.42
      const nextCost = item.cost + gradientCost + unaryCost
      if (nextCost < costs[neighborIndex]) {
        costs[neighborIndex] = nextCost
        heap.push(neighborIndex, nextCost)
      }
    }
  }

  return costs
}

function getScribbleForegroundPenalty(hu: number, model: IchAdaptiveHuModel, tolerance: number) {
  if (!Number.isFinite(hu)) {
    return 8
  }

  const distance = Math.abs(hu - model.meanHu)
  const softTolerance = Math.max(1, tolerance * 0.62)
  if (distance <= softTolerance) {
    return 0
  }

  return Math.min(8, ((distance - softTolerance) / Math.max(1, tolerance)) ** 1.35)
}

function getSquaredDistanceToClosestSeed(x: number, y: number, seeds: Types.Point2[]) {
  let bestDistance = Number.POSITIVE_INFINITY
  seeds.forEach((seed) => {
    const dx = x - seed[0]
    const dy = y - seed[1]
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
    }
  })

  return bestDistance
}

function keepScribbleSeedConnectedMask(mask: Uint8Array, seedMask: Uint8Array, width: number, height: number) {
  const count = width * height
  const kept = new Uint8Array(count)
  const visited = new Uint8Array(count)
  const queue = new Int32Array(count)
  let head = 0
  let tail = 0

  for (let index = 0; index < count; index += 1) {
    if (mask[index] && seedMask[index]) {
      visited[index] = 1
      queue[tail] = index
      tail += 1
    }
  }

  while (head < tail) {
    const index = queue[head]
    head += 1
    kept[index] = 1
    const x = index % width
    const y = Math.floor(index / width)
    enqueue(x - 1, y)
    enqueue(x + 1, y)
    enqueue(x, y - 1)
    enqueue(x, y + 1)
  }

  return kept

  function enqueue(x: number, y: number) {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return
    }
    const index = y * width + x
    if (visited[index] || !mask[index]) {
      return
    }
    visited[index] = 1
    queue[tail] = index
    tail += 1
  }
}

function smoothScribbleExtractMask(mask: Uint8Array, seedMask: Uint8Array, backgroundSeedMask: Uint8Array, width: number, height: number) {
  let nextMask = mask
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const current = nextMask
    nextMask = new Uint8Array(current)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x
        if (seedMask[index]) {
          nextMask[index] = 1
          continue
        }
        if (backgroundSeedMask[index]) {
          nextMask[index] = 0
          continue
        }

        let neighbors = 0
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue
            }
            neighbors += current[(y + dy) * width + (x + dx)]
          }
        }

        if (!current[index] && neighbors >= 6) {
          nextMask[index] = 1
        } else if (current[index] && neighbors <= 1) {
          nextMask[index] = 0
        }
      }
    }
  }

  return fillSmallScribbleHoles(nextMask, backgroundSeedMask, width, height)
}

function fillSmallScribbleHoles(mask: Uint8Array, backgroundSeedMask: Uint8Array, width: number, height: number) {
  const count = width * height
  const visited = new Uint8Array(count)
  const nextMask = new Uint8Array(mask)
  const queue = new Int32Array(count)

  for (let startIndex = 0; startIndex < count; startIndex += 1) {
    if (visited[startIndex] || mask[startIndex] || backgroundSeedMask[startIndex]) {
      continue
    }

    let head = 0
    let tail = 0
    let touchesBorder = false
    const component: number[] = []
    visited[startIndex] = 1
    queue[tail] = startIndex
    tail += 1

    while (head < tail) {
      const index = queue[head]
      head += 1
      component.push(index)
      const x = index % width
      const y = Math.floor(index / width)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true
      }
      ;[
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].forEach(([neighborX, neighborY]) => {
        if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
          return
        }
        const neighborIndex = neighborY * width + neighborX
        if (visited[neighborIndex] || mask[neighborIndex] || backgroundSeedMask[neighborIndex]) {
          return
        }
        visited[neighborIndex] = 1
        queue[tail] = neighborIndex
        tail += 1
      })
    }

    if (!touchesBorder && component.length <= Math.max(16, count * 0.018)) {
      component.forEach((index) => {
        nextMask[index] = 1
      })
    }
  }

  return nextMask
}

function commitScribblePlaneMask(
  context: VolumeContext,
  {
    plane,
    bounds,
    localMaskIndices,
    huValues,
    width,
    reachedLimit,
  }: {
    plane: ScribbleVolumePlane
    bounds: Bounds2D
    localMaskIndices: number[]
    huValues: Float32Array
    width: number
    reachedLimit: boolean
  },
): InternalVolumeRegionGrowResult {
  const modifiedSlices = new Set<number>()
  const modifiedIndices: number[] = []
  const addedIndices: number[] = []
  const removedIndices: number[] = []
  const sliceSize = Math.floor(context.dimensions[0]) * Math.floor(context.dimensions[1])
  let sumHu = 0
  let sumHuSquares = 0

  localMaskIndices.forEach((localIndex) => {
    const localX = localIndex % width
    const localY = Math.floor(localIndex / width)
    const u = bounds.minX + localX
    const v = bounds.minY + localY
    const ijk = getScribblePlaneIJK(plane, u, v)
    const volumeIndex = getVolumeLinearIndex(context, ijk)
    if (volumeIndex === null) {
      return
    }

    const hu = huValues[localIndex]
    if (Number.isFinite(hu)) {
      sumHu += hu
      sumHuSquares += hu * hu
    }
    if (getVolumeLabelmapValue(context, volumeIndex) !== ICH_SEGMENT_INDEX) {
      setVolumeLabelmapValue(context, volumeIndex, ICH_SEGMENT_INDEX)
      modifiedSlices.add(Math.floor(volumeIndex / sliceSize))
      modifiedIndices.push(volumeIndex)
      addedIndices.push(volumeIndex)
    }
  })

  return {
    matchedVoxels: addedIndices.length,
    acceptedVoxels: localMaskIndices.length,
    reachedLimit,
    seedAccepted: localMaskIndices.length > 0,
    volumeMl: addedIndices.length > 0 ? (addedIndices.length * context.voxelVolumeMm3) / 1000 : null,
    meanHu: getMeanFromMoments(sumHu, localMaskIndices.length),
    stdDevHu: getStdDevFromMoments(sumHu, sumHuSquares, localMaskIndices.length),
    modifiedSlices: Array.from(modifiedSlices).sort((a, b) => a - b),
    modifiedIndices,
    addedIndices,
    removedIndices,
  }
}

class IchMinHeap {
  private items: Array<{ index: number; cost: number }> = []

  get size() {
    return this.items.length
  }

  push(index: number, cost: number) {
    this.items.push({ index, cost })
    this.bubbleUp(this.items.length - 1)
  }

  pop() {
    if (this.items.length === 0) {
      return null
    }

    const first = this.items[0]
    const last = this.items.pop()
    if (last && this.items.length > 0) {
      this.items[0] = last
      this.bubbleDown(0)
    }

    return first
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      if (this.items[parentIndex].cost <= this.items[index].cost) {
        break
      }
      this.swap(index, parentIndex)
      index = parentIndex
    }
  }

  private bubbleDown(index: number) {
    while (true) {
      const leftIndex = index * 2 + 1
      const rightIndex = leftIndex + 1
      let smallestIndex = index
      if (leftIndex < this.items.length && this.items[leftIndex].cost < this.items[smallestIndex].cost) {
        smallestIndex = leftIndex
      }
      if (rightIndex < this.items.length && this.items[rightIndex].cost < this.items[smallestIndex].cost) {
        smallestIndex = rightIndex
      }
      if (smallestIndex === index) {
        break
      }
      this.swap(index, smallestIndex)
      index = smallestIndex
    }
  }

  private swap(firstIndex: number, secondIndex: number) {
    const item = this.items[firstIndex]
    this.items[firstIndex] = this.items[secondIndex]
    this.items[secondIndex] = item
  }
}

function getForbiddenRegionsForSlice(forbiddenRegions: IchForbiddenRegion[], sliceIndex: number) {
  return forbiddenRegions
    .filter((region) => Math.abs(region.sliceIndex - sliceIndex) <= 1)
    .map((region) => ({
      center: region.center,
      radiusPx: region.radiusPx * (region.sliceIndex === sliceIndex ? 1 : 0.72),
    }))
}

function isHuAcceptedByDistanceWeighting({ targetHu, baseToleranceHu, radiusPx, floorRatio = 0.5 }: DistanceWeightingOptions, hu: number, distancePx: number) {
  const radius = Math.max(1, radiusPx)
  const normalizedDistance = Math.max(0, distancePx) / radius
  const gaussian = Math.exp(-0.5 * (normalizedDistance / 0.72) ** 2)
  const minimumTolerance = baseToleranceHu * clampNumber(floorRatio, 0.25, 0.9)
  const allowedTolerance = minimumTolerance + (baseToleranceHu - minimumTolerance) * gaussian

  return Math.abs(hu - targetHu) <= allowedTolerance
}

function isPointInsideForbiddenRegions(
  x: number,
  y: number,
  forbiddenRegions: Array<Pick<IchForbiddenRegion, 'center' | 'radiusPx'>> | undefined,
) {
  if (!forbiddenRegions?.length) {
    return false
  }

  return forbiddenRegions.some((region) => {
    const dx = x - region.center[0]
    const dy = y - region.center[1]

    return dx * dx + dy * dy <= region.radiusPx * region.radiusPx
  })
}

function getMeanFromMoments(sum: number, count: number) {
  return count > 0 ? sum / count : null
}

function getStdDevFromMoments(sum: number, sumSquares: number, count: number) {
  if (count <= 0) {
    return null
  }

  const mean = sum / count
  const variance = Math.max(0, sumSquares / count - mean * mean)

  return Math.sqrt(variance)
}

function getSmartDragHuRange({
  mode,
  seedHu,
  minimumHu,
  maximumHu,
  localTolerance,
}: {
  mode: 'add' | 'erase'
  seedHu: number
  minimumHu: number
  maximumHu: number
  localTolerance: number
}) {
  void mode
  void minimumHu
  void maximumHu

  return {
    minimumHu: Math.max(-1000, Math.floor(seedHu - localTolerance)),
    maximumHu: Math.min(3000, Math.ceil(seedHu + localTolerance)),
  }
}

function sampleLocalHuStats(context: StackSliceContext, point: Types.Point2, radius: number) {
  const centerX = Math.round(point[0])
  const centerY = Math.round(point[1])
  const sampleRadius = Math.max(1, Math.floor(radius))
  let count = 0
  let sum = 0
  let sumSquares = 0

  for (let y = Math.max(0, centerY - sampleRadius); y <= Math.min(context.height - 1, centerY + sampleRadius); y += 1) {
    const rowOffset = y * context.width
    for (let x = Math.max(0, centerX - sampleRadius); x <= Math.min(context.width - 1, centerX + sampleRadius); x += 1) {
      const hu = getHuAtPixel(context, rowOffset + x)
      if (!Number.isFinite(hu)) {
        continue
      }

      count += 1
      sum += hu
      sumSquares += hu * hu
    }
  }

  if (count === 0) {
    return { mean: 0, standardDeviation: 0 }
  }

  const mean = sum / count
  const variance = Math.max(0, sumSquares / count - mean * mean)

  return {
    mean,
    standardDeviation: Math.sqrt(variance),
  }
}

function estimateSmartDragGradientStop(
  context: StackSliceContext,
  seedPoint: Types.Point2,
  radiusPx: number,
  localStandardDeviation: number,
) {
  const centerX = Math.round(seedPoint[0])
  const centerY = Math.round(seedPoint[1])
  const sampleRadius = clampNumber(Math.min(16, Math.max(5, radiusPx * 0.35)), 3, 18)
  let count = 0
  let sum = 0
  let sumSquares = 0

  for (let y = Math.max(1, Math.round(centerY - sampleRadius)); y <= Math.min(context.height - 2, Math.round(centerY + sampleRadius)); y += 1) {
    for (let x = Math.max(1, Math.round(centerX - sampleRadius)); x <= Math.min(context.width - 2, Math.round(centerX + sampleRadius)); x += 1) {
      if (Math.hypot(x - centerX, y - centerY) > sampleRadius) {
        continue
      }

      const gradient = getSobelGradientMagnitude(context, x, y)
      if (!Number.isFinite(gradient)) {
        continue
      }

      count += 1
      sum += gradient
      sumSquares += gradient * gradient
    }
  }

  if (count === 0) {
    return clampNumber(localStandardDeviation * 5 + 24, 20, 76)
  }

  const mean = sum / count
  const variance = Math.max(0, sumSquares / count - mean * mean)
  const gradientStd = Math.sqrt(variance)

  return clampNumber(Math.max(mean + gradientStd * 2.6 + 10, localStandardDeviation * 4 + 20), 20, 84)
}

function getSobelGradientMagnitude(context: StackSliceContext, x: number, y: number) {
  if (x <= 0 || y <= 0 || x >= context.width - 1 || y >= context.height - 1) {
    return 0
  }

  const width = context.width
  const top = (y - 1) * width
  const middle = y * width
  const bottom = (y + 1) * width
  const topLeft = getHuAtPixel(context, top + x - 1)
  const topCenter = getHuAtPixel(context, top + x)
  const topRight = getHuAtPixel(context, top + x + 1)
  const middleLeft = getHuAtPixel(context, middle + x - 1)
  const middleRight = getHuAtPixel(context, middle + x + 1)
  const bottomLeft = getHuAtPixel(context, bottom + x - 1)
  const bottomCenter = getHuAtPixel(context, bottom + x)
  const bottomRight = getHuAtPixel(context, bottom + x + 1)
  const gx = -topLeft - 2 * middleLeft - bottomLeft + topRight + 2 * middleRight + bottomRight
  const gy = -topLeft - 2 * topCenter - topRight + bottomLeft + 2 * bottomCenter + bottomRight

  return Math.hypot(gx, gy) / 4
}

function getHuAtImagePoint(context: StackSliceContext, point: Types.Point2) {
  const x = Math.round(point[0])
  const y = Math.round(point[1])
  if (x < 0 || x >= context.width || y < 0 || y >= context.height) {
    return null
  }

  const hu = getHuAtPixel(context, y * context.width + x)

  return Number.isFinite(hu) ? hu : null
}

/** Bidang HU satu slice sebagai larik (indeks = y * width + x), untuk mesin deteksi baru. */
function readStackHuPlane(context: StackSliceContext) {
  const size = context.width * context.height
  const plane = new Float32Array(size)
  for (let index = 0; index < size; index += 1) {
    const value = getHuAtPixel(context, index)
    plane[index] = Number.isFinite(value) ? value : -1024
  }
  return plane
}

/**
 * Dinding HU untuk satu slice, diukur dari keadaan lokal di sekitar titik semai:
 * inti lesi (median r=6) vs jaringan SEKELILING lesi (cincin tepat di luar banjir kasar).
 * Inilah yang membuat batas peka terhadap HU sekitar — sebelumnya toleransi tetap
 * (targetHu ± 10 HU) membuat batas tidak peduli jaringan sekitarnya.
 */
function deriveAdaptiveWallsForSlice(
  context: StackSliceContext,
  seedPoint: Types.Point2,
  options: { maxRadiusPx?: number } = {},
) {
  const plane = readStackHuPlane(context)
  const result = adaptiveHuEdgeGrow(plane, context.width, context.height, Math.round(seedPoint[0]), Math.round(seedPoint[1]), {
    maxRadiusPx: options.maxRadiusPx ?? 320,
    maxVoxels: 200000,
  })
  return { lower: result.lowWallHu, upper: result.highWallHu, plane, result }
}

function getHuAtPixel(context: StackSliceContext, index: number) {
  return Number(context.sourcePixels[index]) * context.slope + context.intercept
}

function initializeEmptyIchVolumeStatsCache(labelmapVolumeId: string, referencedVolumeId: string) {
  const sourceVolume = cache.getVolume(referencedVolumeId) as unknown as ThresholdVolume | undefined
  ichVolumeStatsCache.set(labelmapVolumeId, {
    voxelCount: 0,
    voxelVolumeMm3: getVolumeVoxelVolumeMm3(sourceVolume),
    indices: new Set(),
  })
}

function getIchVolumeStatsCacheKey(segmentationId: string, labelmapVolume: ThresholdVolume | undefined) {
  return labelmapVolume?.volumeId ?? getIchLabelmapVolumeIds(segmentationId)[0] ?? segmentationId
}

function formatCachedIchVolumeStats(stats: IchVolumeStatsCacheEntry): IchVolumeSegmentStats {
  return {
    voxelCount: stats.voxelCount,
    volumeMl: stats.voxelCount > 0 ? (stats.voxelCount * stats.voxelVolumeMm3) / 1000 : null,
  }
}

function updateIchVolumeStatsCacheFromResult(
  segmentationId: string,
  context: VolumeContext,
  mode: 'add' | 'erase',
  result: InternalVolumeRegionGrowResult,
): IchVolumeSegmentStats {
  const cacheKey = getIchVolumeStatsCacheKey(segmentationId, context.labelmapVolume)
  const current = ichVolumeStatsCache.get(cacheKey) ?? {
    voxelCount: 0,
    voxelVolumeMm3: context.voxelVolumeMm3,
    indices: new Set<number>(),
  }

  if (result.modifiedIndices.length <= 0 && result.addedIndices.length <= 0 && result.removedIndices.length <= 0) {
    ichVolumeStatsCache.set(cacheKey, current)
    return formatCachedIchVolumeStats(current)
  }

  if (result.addedIndices.length > 0 || result.removedIndices.length > 0) {
    result.removedIndices.forEach((index) => current.indices.delete(index))
    result.addedIndices.forEach((index) => current.indices.add(index))
  } else if (mode === 'erase') {
    result.modifiedIndices.forEach((index) => current.indices.delete(index))
  } else {
    result.modifiedIndices.forEach((index) => current.indices.add(index))
  }
  current.voxelCount = current.indices.size
  current.voxelVolumeMm3 = context.voxelVolumeMm3
  ichVolumeStatsCache.set(cacheKey, current)

  return formatCachedIchVolumeStats(current)
}

function getVolumeVoxelVolumeMm3(volume: ThresholdVolume | undefined) {
  const spacing = getVolumeSpacing(volume)

  return spacing[0] * spacing[1] * spacing[2]
}

function getVolumeContext(segmentationId: string, referencedVolumeId: string): VolumeContext | null {
  const labelmapVolumeId = getIchLabelmapVolumeIds(segmentationId)[0]
  if (!labelmapVolumeId) {
    return null
  }

  const sourceVolume = cache.getVolume(referencedVolumeId) as unknown as ThresholdVolume | undefined
  const labelmapVolume = cache.getVolume(labelmapVolumeId) as unknown as ThresholdVolume | undefined
  const sourcePixels = getVolumeScalarData(sourceVolume)
  const labelmapPixels = getVolumeScalarData(labelmapVolume)
  if (!sourceVolume || !labelmapVolume) {
    return null
  }

  const sourceLength = getVolumeDataLength(sourceVolume, sourcePixels)
  const labelmapLength = getVolumeDataLength(labelmapVolume, labelmapPixels)
  const dimensions = getVolumeDimensions(sourceVolume, sourceLength)
  if (!dimensions) {
    return null
  }
  const voxelCount = Math.min(dimensions[0] * dimensions[1] * dimensions[2], sourceLength, labelmapLength)
  if (voxelCount <= 0) {
    return null
  }

  const spacing = getVolumeSpacing(sourceVolume)
  const { slope, intercept } = getVolumeScaling(sourceVolume)

  return {
    sourceVolume,
    labelmapVolume,
    sourcePixels,
    labelmapPixels,
    dimensions,
    spacing,
    slope,
    intercept,
    voxelCount,
    voxelVolumeMm3: spacing[0] * spacing[1] * spacing[2],
  }
}

function worldToVolumeIJK(context: VolumeContext, world: Types.Point3): Types.Point3 | null {
  const index = context.sourceVolume.imageData?.worldToIndex?.([world[0], world[1], world[2]] as const)
  if (!index || index.length < 3) {
    return null
  }

  const point = [
    Math.round(Number(index[0])),
    Math.round(Number(index[1])),
    Math.round(Number(index[2])),
  ] as Types.Point3

  return isVolumeIJKInside(context, point) ? point : null
}

function isVolumeIJKInside(context: VolumeContext, point: Types.Point3) {
  const [width, height, depth] = context.dimensions
  const x = Math.round(point[0])
  const y = Math.round(point[1])
  const z = Math.round(point[2])

  return x >= 0 && x < width && y >= 0 && y < height && z >= 0 && z < depth
}

function getVolumeLinearIndex(context: VolumeContext, point: Types.Point3): number | null {
  if (!isVolumeIJKInside(context, point)) {
    return null
  }

  const width = Math.floor(context.dimensions[0])
  const height = Math.floor(context.dimensions[1])
  const x = Math.round(point[0])
  const y = Math.round(point[1])
  const z = Math.round(point[2])

  return z * width * height + y * width + x
}

function getHuAtVolumeIJK(context: VolumeContext, point: Types.Point3) {
  const index = getVolumeLinearIndex(context, point)

  return index === null ? Number.NaN : getHuAtVolumeIndex(context, index)
}

function getHuAtVolumeIndex(context: VolumeContext, index: number) {
  return getCachedVolumeValue(context.sourceVolume, context.sourcePixels, index) * context.slope + context.intercept
}

function getVolumeLabelmapValue(context: VolumeContext, index: number) {
  return getCachedVolumeValue(context.labelmapVolume, context.labelmapPixels, index)
}

function setVolumeLabelmapValue(context: VolumeContext, index: number, value: number) {
  setCachedVolumeValue(context.labelmapVolume, context.labelmapPixels, index, value)
}

function getCachedVolumeValue(volume: ThresholdVolume | undefined, pixels: MutableScalarData | null, index: number) {
  const value = volume?.voxelManager?.getAtIndex?.(index)

  return Number(value ?? pixels?.[index] ?? 0)
}

function setCachedVolumeValue(volume: ThresholdVolume | undefined, pixels: MutableScalarData | null, index: number, value: number) {
  if (volume?.voxelManager?.setAtIndex) {
    volume.voxelManager.setAtIndex(index, value)
  }

  if (pixels?.length) {
    pixels[index] = value
  }
}

function getVolumeIJKDistance(first: Types.Point3, second: Types.Point3) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])
}

function capStackPointDrag(seed: Types.Point2, drag: Types.Point2, maxDistance: number): Types.Point2 {
  const distance = Math.hypot(seed[0] - drag[0], seed[1] - drag[1])
  if (!Number.isFinite(distance) || distance <= maxDistance || distance <= 0) {
    return drag
  }

  const scale = maxDistance / distance

  return [
    seed[0] + (drag[0] - seed[0]) * scale,
    seed[1] + (drag[1] - seed[1]) * scale,
  ] as Types.Point2
}

function getDistanceToStackSegment(point: Types.Point2, start: Types.Point2, end: Types.Point2) {
  const vx = end[0] - start[0]
  const vy = end[1] - start[1]
  const wx = point[0] - start[0]
  const wy = point[1] - start[1]
  const lengthSquared = vx * vx + vy * vy
  if (lengthSquared <= 0) {
    return Math.hypot(wx, wy)
  }

  const t = clampNumber((wx * vx + wy * vy) / lengthSquared, 0, 1)
  const projectedX = start[0] + vx * t
  const projectedY = start[1] + vy * t

  return Math.hypot(point[0] - projectedX, point[1] - projectedY)
}

function capVolumeIJKDrag(seed: Types.Point3, drag: Types.Point3, maxDistance: number): Types.Point3 {
  const distance = getVolumeIJKDistance(seed, drag)
  if (!Number.isFinite(distance) || distance <= maxDistance || distance <= 0) {
    return drag
  }

  const scale = maxDistance / distance

  return [
    seed[0] + (drag[0] - seed[0]) * scale,
    seed[1] + (drag[1] - seed[1]) * scale,
    seed[2] + (drag[2] - seed[2]) * scale,
  ] as Types.Point3
}

function getDistanceToVolumeSegment(point: Types.Point3, start: Types.Point3, end: Types.Point3) {
  const vx = end[0] - start[0]
  const vy = end[1] - start[1]
  const vz = end[2] - start[2]
  const wx = point[0] - start[0]
  const wy = point[1] - start[1]
  const wz = point[2] - start[2]
  const lengthSquared = vx * vx + vy * vy + vz * vz
  if (lengthSquared <= 0) {
    return Math.hypot(wx, wy, wz)
  }

  const t = clampNumber((wx * vx + wy * vy + wz * vz) / lengthSquared, 0, 1)
  const projectedX = start[0] + vx * t
  const projectedY = start[1] + vy * t
  const projectedZ = start[2] + vz * t

  return Math.hypot(point[0] - projectedX, point[1] - projectedY, point[2] - projectedZ)
}

function sampleAdaptiveVolumeSeedHuModel(context: VolumeContext, point: Types.Point3, seedHu: number): LocalSeedHuModel {
  const centerX = Math.round(point[0])
  const centerY = Math.round(point[1])
  const centerZ = Math.round(point[2])
  const [width, height, depth] = context.dimensions
  const sampleRadius = 3
  const broadSeedWindow = clampNumber(Math.abs(seedHu) * 0.18 + 24, 18, 52)
  const rawValues: number[] = []

  for (let z = Math.max(0, centerZ - sampleRadius); z <= Math.min(depth - 1, centerZ + sampleRadius); z += 1) {
    for (let y = Math.max(0, centerY - sampleRadius); y <= Math.min(height - 1, centerY + sampleRadius); y += 1) {
      for (let x = Math.max(0, centerX - sampleRadius); x <= Math.min(width - 1, centerX + sampleRadius); x += 1) {
        if (getVolumeIJKDistance(point, [x, y, z]) > sampleRadius + 0.25) {
          continue
        }

        const hu = getHuAtVolumeIJK(context, [x, y, z])
        if (!Number.isFinite(hu) || Math.abs(hu - seedHu) > broadSeedWindow) {
          continue
        }

        rawValues.push(hu)
      }
    }
  }

  if (rawValues.length === 0) {
    return {
      mean: seedHu,
      standardDeviation: 0,
      lowerPercentile: seedHu,
      upperPercentile: seedHu,
      samples: 1,
    }
  }

  rawValues.sort((left, right) => left - right)
  const median = getSortedPercentile(rawValues, 0.5)
  const deviations = rawValues.map((value) => Math.abs(value - median)).sort((left, right) => left - right)
  const mad = getSortedPercentile(deviations, 0.5)
  const robustWindow = clampNumber(Math.max(9, mad * 3.2 + 7), 9, 36)
  let values = rawValues.filter((value) => (
    Math.abs(value - median) <= robustWindow
    && Math.abs(value - seedHu) <= Math.max(12, robustWindow * 1.35)
  ))

  if (values.length < 4) {
    values = rawValues.filter((value) => Math.abs(value - seedHu) <= Math.max(12, broadSeedWindow * 0.55))
  }
  if (values.length === 0) {
    values = [seedHu]
  }

  const sum = values.reduce((total, value) => total + value, 0)
  const sumSquares = values.reduce((total, value) => total + value * value, 0)
  const mean = sum / values.length
  const variance = Math.max(0, sumSquares / values.length - mean * mean)
  const sortedValues = [...values].sort((left, right) => left - right)

  return {
    mean,
    standardDeviation: Math.sqrt(variance),
    lowerPercentile: getSortedPercentile(sortedValues, 0.18),
    upperPercentile: getSortedPercentile(sortedValues, 0.82),
    samples: values.length,
  }
}

function getSortedPercentile(sortedValues: number[], percentile: number) {
  if (sortedValues.length === 0) {
    return 0
  }
  if (sortedValues.length === 1) {
    return sortedValues[0]
  }

  const clampedPercentile = clampNumber(percentile, 0, 1)
  const position = (sortedValues.length - 1) * clampedPercentile
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex]
  }

  const ratio = position - lowerIndex
  return sortedValues[lowerIndex] * (1 - ratio) + sortedValues[upperIndex] * ratio
}

function estimateVolumeSmartDragGradientStop(
  context: VolumeContext,
  seedIJK: Types.Point3,
  radiusVoxels: number,
  localStandardDeviation: number,
) {
  const centerX = Math.round(seedIJK[0])
  const centerY = Math.round(seedIJK[1])
  const centerZ = Math.round(seedIJK[2])
  const [width, height, depth] = context.dimensions
  const sampleRadius = clampNumber(Math.min(8, Math.max(3, radiusVoxels * 0.28)), 2, 10)
  let count = 0
  let sum = 0
  let sumSquares = 0

  for (let z = Math.max(1, Math.round(centerZ - sampleRadius)); z <= Math.min(depth - 2, Math.round(centerZ + sampleRadius)); z += 1) {
    for (let y = Math.max(1, Math.round(centerY - sampleRadius)); y <= Math.min(height - 2, Math.round(centerY + sampleRadius)); y += 1) {
      for (let x = Math.max(1, Math.round(centerX - sampleRadius)); x <= Math.min(width - 2, Math.round(centerX + sampleRadius)); x += 1) {
        if (getVolumeIJKDistance(seedIJK, [x, y, z]) > sampleRadius) {
          continue
        }

        const gradient = getVolumeGradientMagnitude(context, x, y, z)
        if (!Number.isFinite(gradient)) {
          continue
        }

        count += 1
        sum += gradient
        sumSquares += gradient * gradient
      }
    }
  }

  if (count === 0) {
    return clampNumber(localStandardDeviation * 5 + 24, 18, 78)
  }

  const mean = sum / count
  const variance = Math.max(0, sumSquares / count - mean * mean)
  const gradientStd = Math.sqrt(variance)

  return clampNumber(Math.max(mean + gradientStd * 2.5 + 10, localStandardDeviation * 4 + 18), 18, 88)
}

function getVolumeGradientMagnitude(context: VolumeContext, x: number, y: number, z: number) {
  const [width, height, depth] = context.dimensions
  if (x <= 0 || y <= 0 || z <= 0 || x >= width - 1 || y >= height - 1 || z >= depth - 1) {
    return 0
  }

  const spacingX = context.spacing[0] || 1
  const spacingY = context.spacing[1] || 1
  const spacingZ = context.spacing[2] || 1
  const gx = (getHuAtVolumeIJK(context, [x + 1, y, z]) - getHuAtVolumeIJK(context, [x - 1, y, z])) / (2 * spacingX)
  const gy = (getHuAtVolumeIJK(context, [x, y + 1, z]) - getHuAtVolumeIJK(context, [x, y - 1, z])) / (2 * spacingY)
  const gz = (getHuAtVolumeIJK(context, [x, y, z + 1]) - getHuAtVolumeIJK(context, [x, y, z - 1])) / (2 * spacingZ)

  return Math.hypot(gx, gy, gz)
}

function isPointInsideVolumeForbiddenRegions(
  x: number,
  y: number,
  z: number,
  forbiddenRegions: IchVolumeForbiddenRegion[] | undefined,
) {
  if (!forbiddenRegions?.length) {
    return false
  }

  return forbiddenRegions.some((region) => {
    const dx = x - region.centerIJK[0]
    const dy = y - region.centerIJK[1]
    const dz = z - region.centerIJK[2]

    return dx * dx + dy * dy + dz * dz <= region.radiusVoxels * region.radiusVoxels
  })
}

function expandBounds(bounds: Bounds2D, margin: number, width: number, height: number): Bounds2D {
  const padding = Math.max(0, Math.floor(margin))

  return {
    minX: Math.max(0, bounds.minX - padding),
    maxX: Math.min(width - 1, bounds.maxX + padding),
    minY: Math.max(0, bounds.minY - padding),
    maxY: Math.min(height - 1, bounds.maxY + padding),
  }
}

function intersectBounds(first: Bounds2D, second: Bounds2D): Bounds2D | null {
  const bounds = {
    minX: Math.max(first.minX, second.minX),
    maxX: Math.min(first.maxX, second.maxX),
    minY: Math.max(first.minY, second.minY),
    maxY: Math.min(first.maxY, second.maxY),
  }

  return bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY ? bounds : null
}

function boundsOverlap(first: Bounds2D, second: Bounds2D) {
  return first.minX <= second.maxX
    && first.maxX >= second.minX
    && first.minY <= second.maxY
    && first.maxY >= second.minY
}

function isPointInsideBounds(x: number, y: number, bounds: Bounds2D) {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
}

function getImageScalarData(image: ThresholdImage | undefined): MutableScalarData | null {
  return (image?.voxelManager?.getScalarData?.() ?? image?.getPixelData?.() ?? null) as MutableScalarData | null
}

function getVolumeScalarData(volume: ThresholdVolume | undefined): MutableScalarData | null {
  try {
    return (volume?.voxelManager?.getScalarData?.() ?? null) as MutableScalarData | null
  } catch (error) {
    if (error instanceof Error && error.message.includes('No scalar data available')) {
      return null
    }
    throw error
  }
}

function getVolumeDataLength(volume: ThresholdVolume | undefined, pixels: MutableScalarData | null) {
  if (pixels?.length) {
    return pixels.length
  }

  try {
    const length = Number(volume?.voxelManager?.getScalarDataLength?.())
    if (Number.isFinite(length) && length > 0) {
      return Math.floor(length)
    }
  } catch {
    // Some Cornerstone labelmap voxel managers are sparse and intentionally have no scalar array.
  }

  const rawDimensions = volume?.dimensions ?? volume?.imageData?.getDimensions?.()
  const width = Math.floor(Number(rawDimensions?.[0]))
  const height = Math.floor(Number(rawDimensions?.[1]))
  const depth = Math.floor(Number(rawDimensions?.[2]))
  if (Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(depth) && width > 0 && height > 0 && depth > 0) {
    return width * height * depth
  }

  return 0
}

function markImageLabelmapModified(image: ThresholdImage | undefined) {
  const voxelManager = image?.voxelManager
  voxelManager?.modifiedSlices?.add(0)
  voxelManager?.invalidateCache?.()
}

function markVolumeLabelmapModified(volume: ThresholdVolume | undefined, modifiedSlices?: number[]) {
  const voxelManager = volume?.voxelManager
  const slices = Array.from(new Set(modifiedSlices ?? []))
  slices.forEach((sliceIndex) => {
    if (Number.isInteger(sliceIndex) && sliceIndex >= 0) {
      voxelManager?.modifiedSlices?.add(sliceIndex)
    }
  })
  voxelManager?.invalidateCache?.()
  volume?.modified?.()
}

function getImageDimensions(imageId: string, image: ThresholdImage | undefined, pixelLength: number): Types.Point2 | null {
  const imagePlane = metaData.get('imagePlaneModule', imageId) as ImagePlaneMetadata | undefined
  const width = Math.floor(Number(image?.width ?? image?.columns ?? imagePlane?.columns))
  const height = Math.floor(Number(image?.height ?? image?.rows ?? imagePlane?.rows))
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return [width, height]
  }

  const squareSize = Math.sqrt(pixelLength)
  if (Number.isInteger(squareSize) && squareSize > 0) {
    return [squareSize, squareSize]
  }

  return null
}

function getVolumeDimensions(volume: ThresholdVolume | undefined, pixelLength: number): Types.Point3 | null {
  const rawDimensions = volume?.dimensions ?? volume?.imageData?.getDimensions?.()
  const width = Math.floor(Number(rawDimensions?.[0]))
  const height = Math.floor(Number(rawDimensions?.[1]))
  const depth = Math.floor(Number(rawDimensions?.[2]))
  if (
    Number.isFinite(width)
    && Number.isFinite(height)
    && Number.isFinite(depth)
    && width > 0
    && height > 0
    && depth > 0
    && (pixelLength <= 0 || width * height * depth <= pixelLength)
  ) {
    return [width, height, depth]
  }

  return null
}

function getVolumeSpacing(volume: ThresholdVolume | undefined): Types.Point3 {
  const rawSpacing = volume?.spacing ?? volume?.imageData?.getSpacing?.()
  const spacingX = toFiniteNumber(rawSpacing?.[0]) ?? 1
  const spacingY = toFiniteNumber(rawSpacing?.[1]) ?? 1
  const spacingZ = toFiniteNumber(rawSpacing?.[2]) ?? 1

  return [spacingX, spacingY, spacingZ]
}

function getImageScaling(imageId: string, image: ThresholdImage | undefined) {
  const imagePixelModule = metaData.get('imagePixelModule', imageId) as ImagePixelMetadata | undefined
  const alreadyScaled = Boolean(image?.isPreScaled || image?.preScale?.scaled || image?.imageFrame?.preScale?.scaled)

  return {
    slope: alreadyScaled ? 1 : Number(image?.slope ?? imagePixelModule?.rescaleSlope ?? 1) || 1,
    intercept: alreadyScaled ? 0 : Number(image?.intercept ?? imagePixelModule?.rescaleIntercept ?? 0) || 0,
  }
}

function getVolumeScaling(volume: ThresholdVolume | undefined) {
  return {
    slope: Number(volume?.scaling?.rescaleSlope ?? 1) || 1,
    intercept: Number(volume?.scaling?.rescaleIntercept ?? 0) || 0,
  }
}

function getVoxelVolumeMm3(
  imageId: string,
  image: ThresholdImage | undefined,
  sliceIndex: number,
  referencedImageIds: string[],
) {
  const imagePlane = metaData.get('imagePlaneModule', imageId) as ImagePlaneMetadata | undefined
  const rowSpacing = toFiniteNumber(imagePlane?.rowPixelSpacing ?? imagePlane?.pixelSpacing?.[0] ?? image?.rowPixelSpacing) ?? 1
  const columnSpacing = toFiniteNumber(imagePlane?.columnPixelSpacing ?? imagePlane?.pixelSpacing?.[1] ?? image?.columnPixelSpacing) ?? 1
  const sliceSpacing = getSliceSpacingMm(imagePlane, sliceIndex, referencedImageIds)
    ?? toFiniteNumber(imagePlane?.spacingBetweenSlices)
    ?? toFiniteNumber(imagePlane?.sliceThickness)
    ?? toFiniteNumber(image?.spacingBetweenSlices)
    ?? toFiniteNumber(image?.sliceThickness)
    ?? 1

  return rowSpacing * columnSpacing * sliceSpacing
}

function getSliceSpacingMm(imagePlane: ImagePlaneMetadata | undefined, sliceIndex: number, referencedImageIds: string[]) {
  const currentPosition = imagePlane?.imagePositionPatient
  if (!currentPosition || currentPosition.length < 3) {
    return null
  }

  const normal = getImagePlaneNormal(imagePlane)
  const distances: number[] = []
  ;[sliceIndex - 1, sliceIndex + 1].forEach((neighborIndex) => {
    const neighborImageId = referencedImageIds[neighborIndex]
    const neighborPlane = neighborImageId ? metaData.get('imagePlaneModule', neighborImageId) as ImagePlaneMetadata | undefined : undefined
    const neighborPosition = neighborPlane?.imagePositionPatient
    if (!neighborPosition || neighborPosition.length < 3) {
      return
    }

    const delta = [
      neighborPosition[0] - currentPosition[0],
      neighborPosition[1] - currentPosition[1],
      neighborPosition[2] - currentPosition[2],
    ]
    const distance = normal
      ? Math.abs(delta[0] * normal[0] + delta[1] * normal[1] + delta[2] * normal[2])
      : Math.hypot(delta[0], delta[1], delta[2])
    if (Number.isFinite(distance) && distance > 0) {
      distances.push(distance)
    }
  })

  if (!distances.length) {
    return null
  }

  return distances.reduce((total, value) => total + value, 0) / distances.length
}

function getImagePlaneNormal(imagePlane: ImagePlaneMetadata) {
  const row = imagePlane.rowCosines ?? imagePlane.imageOrientationPatient?.slice(0, 3)
  const column = imagePlane.columnCosines ?? imagePlane.imageOrientationPatient?.slice(3, 6)
  if (!row || !column || row.length < 3 || column.length < 3) {
    return null
  }

  const normal = [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0],
  ]
  const length = Math.hypot(normal[0], normal[1], normal[2])
  if (!Number.isFinite(length) || length === 0) {
    return null
  }

  return [normal[0] / length, normal[1] / length, normal[2] / length]
}

function toFiniteNumber(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

function clampNumber(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) {
    return minimum
  }

  return Math.min(maximum, Math.max(minimum, value))
}
