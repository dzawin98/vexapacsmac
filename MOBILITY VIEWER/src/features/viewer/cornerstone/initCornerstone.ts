import { init as initCore } from '@cornerstonejs/core'
import { init as initDicomImageLoader } from '@cornerstonejs/dicom-image-loader'
import {
  addTool,
  AngleTool,
  ArrowAnnotateTool,
  BidirectionalTool,
  CircleROITool,
  CobbAngleTool,
  CrosshairsTool,
  EllipticalROITool,
  LengthTool,
  MagnifyTool,
  PanTool,
  PlanarFreehandROITool,
  ProbeTool,
  RectangleROITool,
  ReferenceLinesTool,
  StackScrollTool,
  TrackballRotateTool,
  WindowLevelTool,
  ZoomTool,
  init as initTools,
} from '@cornerstonejs/tools'
import { dicomWebConfig } from '../../../config/dicomweb'
import { configureCornerstoneLoading } from './progressiveLoading'

let initialized = false
let consoleNoiseFilterInstalled = false

export function initializeCornerstone() {
  if (initialized) {
    return
  }

  installCornerstoneConsoleNoiseFilter()
  initCore()
  initTools()
  initDicomImageLoader({
    maxWebWorkers: getDicomDecodeWorkerCount(),
    beforeSend: () => ({
      ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
    }),
  })
  configureCornerstoneLoading()

  ;[
    WindowLevelTool,
    PanTool,
    ZoomTool,
    StackScrollTool,
    LengthTool,
    ArrowAnnotateTool,
    CircleROITool,
    MagnifyTool,
    PlanarFreehandROITool,
    AngleTool,
    CobbAngleTool,
    BidirectionalTool,
    RectangleROITool,
    EllipticalROITool,
    ProbeTool,
    CrosshairsTool,
    ReferenceLinesTool,
    TrackballRotateTool,
  ].forEach(addTool)

  initialized = true
}

function getDicomDecodeWorkerCount() {
  const cores = Math.max(1, Math.floor(navigator.hardwareConcurrency || 2))
  const memory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 0

  if (memory >= 6 && cores >= 8) return 4
  if (memory >= 4 && cores >= 4) return 3
  return Math.min(2, cores)
}

function installCornerstoneConsoleNoiseFilter() {
  if (consoleNoiseFilterInstalled) {
    return
  }

  const originalWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    const message = String(args[0] ?? '')
    if (
      message.startsWith('Warning: Set value to model directly ')
      || message.startsWith('volume load cancelled, returning for imageIdIndex:')
    ) {
      return
    }

    originalWarn(...args)
  }
  consoleNoiseFilterInstalled = true
}
