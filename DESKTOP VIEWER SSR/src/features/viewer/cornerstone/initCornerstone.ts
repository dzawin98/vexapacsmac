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
import { initializeProxyVolumeLoader } from '../serverMpr/proxyVolumeLoader'
import { initializeServerMprImageLoader } from '../serverMpr/serverMprImageLoader'
import { initializeServerStackImageLoader } from '../serverMpr/serverStackImageLoader'
import { initializeVexaSsrImageLoader } from '../serverMpr/vexaSsrImageLoader'

let consoleNoiseFilterInstalled = false
const CORNERSTONE_INITIALIZED_KEY = '__vexaCornerstoneInitialized'

export function initializeCornerstone() {
  const runtime = globalThis as typeof globalThis & { [CORNERSTONE_INITIALIZED_KEY]?: boolean }
  if (runtime[CORNERSTONE_INITIALIZED_KEY]) {
    return
  }

  installCornerstoneConsoleNoiseFilter()
  initCore({
    rendering: {
      webGlContextCount: 2,
    },
    debug: {
      statsOverlay: false,
    },
  })
  initTools()
  initDicomImageLoader({
    maxWebWorkers: Math.min(navigator.hardwareConcurrency || 2, 8),
    beforeSend: async () => ({
      ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
    }),
  })
  configureCornerstoneLoading()
  initializeServerMprImageLoader()
  initializeProxyVolumeLoader()
  initializeServerStackImageLoader()
  initializeVexaSsrImageLoader()
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

  runtime[CORNERSTONE_INITIALIZED_KEY] = true
}

function installCornerstoneConsoleNoiseFilter() {
  if (consoleNoiseFilterInstalled) {
    return
  }

  const shouldSuppressConsoleNoise = (...args: unknown[]) => {
    const message = args.map((arg) => String(arg ?? '')).join(' ')
    return (
      message.includes('Warning: Set value to model directly ')
      || message.includes('Set value to model directly ')
      || message.includes('volume load cancelled, returning for imageIdIndex:')
      || message.includes("Worker type 'dicomImageLoader' is already registered")
      || message.includes('Image not found for imageId:')
      || message.includes('Viewport is too small')
      || (message.includes('Metadata add skipped') && message.includes('because cache already has a value'))
    )
  }
  const originalWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    if (shouldSuppressConsoleNoise(...args)) {
      return
    }

    originalWarn(...args)
  }
  const originalError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    if (shouldSuppressConsoleNoise(...args)) {
      return
    }

    originalError(...args)
  }
  consoleNoiseFilterInstalled = true
}
