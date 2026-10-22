import { Enums, init as initCore } from '@cornerstonejs/core'
import { init as initDicomImageLoader } from '@cornerstonejs/dicom-image-loader'
import {
  addTool,
  AngleTool,
  ArrowAnnotateTool,
  BidirectionalTool,
  BrushTool,
  CircleROITool,
  CobbAngleTool,
  CrosshairsTool,
  EllipticalROITool,
  EraserTool,
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
import * as polySeg from '@cornerstonejs/polymorphic-segmentation'
import { configureCornerstoneLoading } from './progressiveLoading'
import { reapDetachedProbeContexts } from './webglProbeReaper'
import { initializeProxyVolumeLoader } from '../serverMpr/proxyVolumeLoader'
import { initializeServerMprImageLoader } from '../serverMpr/serverMprImageLoader'

let consoleNoiseFilterInstalled = false
const CORNERSTONE_INITIALIZED_KEY = '__vexaCornerstoneInitialized'

export function initializeCornerstone() {
  const runtime = globalThis as typeof globalThis & { [CORNERSTONE_INITIALIZED_KEY]?: boolean }
  if (runtime[CORNERSTONE_INITIALIZED_KEY]) {
    return
  }

  installCornerstoneConsoleNoiseFilter()
  // Wrapped so the WebGL capability probes run by initCore() hand their context
  // back to the browser instead of holding one of Chrome's ~16 context slots
  // for the lifetime of the page.
  reapDetachedProbeContexts(() => {
    initCore({
      rendering: {
        renderingEngineMode: Enums.RenderingEngineModeEnum.ContextPool,
        webGlContextCount: getCornerstoneWebGlContextCount(),
      },
      debug: {
        statsOverlay: false,
      },
    })
  })
  initTools({
    addons: {
      polySeg,
    },
  })
  initDicomImageLoader({
    maxWebWorkers: getDicomDecodeWorkerCount(),
    beforeSend: async () => ({
      ...(dicomWebConfig.authorization ? { Authorization: dicomWebConfig.authorization } : {}),
    }),
  })
  configureCornerstoneLoading()
  initializeServerMprImageLoader()
  initializeProxyVolumeLoader()
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
    BrushTool,
    RectangleROITool,
    EllipticalROITool,
    EraserTool,
    ProbeTool,
    CrosshairsTool,
    ReferenceLinesTool,
    TrackballRotateTool,
  ].forEach(addTool)

  runtime[CORNERSTONE_INITIALIZED_KEY] = true
}

function getHardwareConcurrency() {
  return Math.max(1, Math.floor(navigator.hardwareConcurrency || 2))
}

const DEFAULT_WEBGL_CONTEXTS_PER_ENGINE = 2

/**
 * WebGL contexts the app asks Cornerstone to pool per RenderingEngine.
 *
 * Every engine allocates its OWN WebGLContextPool of this size, and Chrome caps
 * live WebGL contexts per renderer process (~16). Stock Cornerstone asks for 7-8
 * here, so one stack tile plus any MPR/3D pane already crosses the quota: Chrome
 * then evicts the oldest context ("Too many active WebGL contexts. Oldest
 * context will be lost.") and never restores it, which leaves a permanently
 * blank viewport. The pool hands its contexts to the viewports round-robin, so
 * two per engine still covers layouts larger than 2x2.
 *
 * Measured on the built viewer with one 4-tile stack study open, counting live
 * (unreleased) canvas contexts in the page:
 *   pool of 8  8 live contexts — 4 tile-sized render windows + 4 unused spares
 *              sitting at their default 300x300
 *   pool of 2  2 live contexts, all four tiles still rendering (pixel variance
 *              5200-9200 per tile, no `webglcontextlost` events); switching the
 *              same page to a 3x3 layout stayed at 2.
 */
export function getCornerstoneWebGlContextCount() {
  const configured = Number(import.meta.env.VITE_CORNERSTONE_WEBGL_CONTEXTS)
  if (Number.isFinite(configured) && configured > 0) {
    return clampInteger(configured, 1, 12)
  }

  return DEFAULT_WEBGL_CONTEXTS_PER_ENGINE
}

function getDicomDecodeWorkerCount() {
  const configured = Number(import.meta.env.VITE_DICOM_DECODE_WORKERS)
  if (Number.isFinite(configured) && configured > 0) {
    return clampInteger(configured, 1, 12)
  }

  const cores = getHardwareConcurrency()
  if (cores >= 16) return 8
  if (cores >= 8) return 6
  if (cores >= 4) return 3
  return 1
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
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
      || message.includes('For crosshairs to operate, at least two viewports must be given.')
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
