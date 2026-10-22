import { getRenderingEngine, getRenderingEngines, type Types } from '@cornerstonejs/core'
import { getCornerstoneWebGlContextCount } from './initCornerstone'

/**
 * WebGL context-loss reporting for the ContextPool rendering engines.
 *
 * Chrome keeps a hard cap of roughly 16 live WebGL contexts per renderer
 * process. Once the cap is reached it evicts the OLDEST context and prints
 * exactly one line about it:
 *
 *   "Too many active WebGL contexts. Oldest context will be lost."
 *
 * Chrome never fires `webglcontextrestored` for an evicted context, so the
 * context stays dead for the life of the page and every later draw through it is
 * a silent no-op: Cornerstone reports a successful render while the operator
 * sees an empty tile. That is the blank-viewport report from the field.
 *
 * Because every RenderingEngine allocates its OWN pool of `webGlContextCount`
 * contexts, the cap is exhausted by the viewer itself — measured on a 4-tile
 * stack study: 3 engines x 4 contexts + 4 probe contexts = 16, i.e. the quota
 * with a single tab open. So this module never tells the operator to "close
 * unused viewer tabs" as the first remedy; a reload of this viewer is the
 * actionable step, and the context budget it reports is what makes the message
 * trustworthy.
 *
 * Two things are reported separately:
 *
 *  1. Losses on a canvas that actually belongs to a RenderingEngine
 *     (class `cornerstone-canvas` / inside a viewport tile). These blank a tile,
 *     so the operator is told.
 *  2. Losses on any other WebGL canvas in the page (Cornerstone's feature
 *     probes, a stray library canvas). These are counted and kept out of the UI:
 *     they never blank a viewport, and surfacing them as "a viewport lost its
 *     graphics context" was a false alarm (verified: a 64x64 filler canvas
 *     evicted by the browser raised the error banner while all 4 tiles kept
 *     rendering).
 */

/** Live WebGL contexts Chrome allows per renderer process before it evicts. */
const CONTEXT_QUOTA_PER_RENDERER = 16

/** Probe canvases are 4x4 / a single 300x150 feature check; never a viewport. */
const MIN_VIEWPORT_CANVAS_SIZE = 32

export type WebGlContextLossReason =
  /** The browser evicted the context because the page hit its context quota. */
  | 'gpu-quota'
  /** The context was lost for an unknown reason (driver reset, page teardown). */
  | 'context-lost'

export type WebGlContextLossInfo = {
  at: number
  reason: WebGlContextLossReason
  canvas: { width: number; height: number; inViewportTile: boolean } | null
  engineCount: number
  engineIds: string[]
  contextsPerEngine: number
  requestedContexts: number
  contextQuota: number
  evictionWarnings: number
  losses: number
}

export type ViewerWebGlHealth = {
  contextLost: boolean
  lastLossAt: number
  lastLoss: WebGlContextLossInfo | null
  suppressedWarnings: number
  evictionWarnings: number
  viewportLosses: number
  ignoredLosses: number
  engineCount: number
  engineIds: string[]
  contextsPerEngine: number
  requestedContexts: number
  contextQuota: number
}

type ContextLossListener = (info: WebGlContextLossInfo) => void

const listeners = new Set<ContextLossListener>()
const viewportCanvases = new WeakSet<HTMLCanvasElement>()
let installed = false
let lastContextLostAt = 0
let lastLossInfo: WebGlContextLossInfo | null = null
let suppressedWarnings = 0
let evictionWarnings = 0
let viewportLossCount = 0
let ignoredLossCount = 0

function readEngineStats() {
  let engines: Types.IRenderingEngine[] = []

  try {
    engines = (getRenderingEngines?.() ?? []) as Types.IRenderingEngine[]
  } catch {
    engines = []
  }

  const contextsPerEngine = getCornerstoneWebGlContextCount()

  return {
    engineCount: engines.length,
    engineIds: engines.map((engine) => String((engine as unknown as { id?: string }).id ?? 'unknown')),
    contextsPerEngine,
    requestedContexts: engines.length * contextsPerEngine,
  }
}

/**
 * True for canvases that belong to a RenderingEngine render window. Cornerstone
 * tags every pooled canvas with the `cornerstone-canvas` class — including the
 * spare (detached) pool contexts — while its capability probes use plain
 * `document.createElement('canvas')` and stay unlabelled.
 */
function isViewportCanvas(canvas: HTMLCanvasElement) {
  if (viewportCanvases.has(canvas)) {
    return true
  }

  if (canvas.classList?.contains('cornerstone-canvas')) {
    return true
  }

  if (canvas.width < MIN_VIEWPORT_CANVAS_SIZE || canvas.height < MIN_VIEWPORT_CANVAS_SIZE) {
    return false
  }

  return Boolean(canvas.closest?.('[data-viewport-key]'))
}

function describeCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) {
    return null
  }

  return {
    width: canvas.width,
    height: canvas.height,
    inViewportTile: Boolean(canvas.closest?.('[data-viewport-key]')),
  }
}

function buildLossInfo(canvas: HTMLCanvasElement | null, reason: WebGlContextLossReason): WebGlContextLossInfo {
  const stats = readEngineStats()

  return {
    at: Date.now(),
    reason,
    canvas: describeCanvas(canvas),
    evictionWarnings,
    losses: viewportLossCount,
    contextQuota: CONTEXT_QUOTA_PER_RENDERER,
    ...stats,
  }
}

function notify(info: WebGlContextLossInfo) {
  lastContextLostAt = info.at
  lastLossInfo = info

  for (const listener of listeners) {
    try {
      listener(info)
    } catch {
      // A failing listener must never break rendering.
    }
  }
}

export function onWebGlContextLost(listener: ContextLossListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLastWebGlContextLossAt() {
  return lastContextLostAt
}

export function getLastWebGlContextLossInfo() {
  return lastLossInfo
}

export function hasRecentWebGlContextLoss(withinMs = 60_000) {
  return lastContextLostAt > 0 && Date.now() - lastContextLostAt < withinMs
}

export function getSuppressedContextWarningCount() {
  return suppressedWarnings
}

type LossHandledEvent = Event & { __viewerWebGlLossHandled?: boolean }
type WatchedCanvas = HTMLCanvasElement & { __viewerWebGlWatched?: boolean }

/**
 * Single entry point for a `webglcontextlost` event, whether it arrives from the
 * window capture listener (canvases that live in the document) or from the
 * per-canvas listener installed by `registerViewportCanvas` (Cornerstone's
 * pooled render windows, which are DETACHED — a detached node's event path has
 * no ancestors, so a window listener never sees those losses at all).
 */
function handleContextLoss(event: Event) {
  const flagged = event as LossHandledEvent
  if (flagged.__viewerWebGlLossHandled) {
    // Both listeners are installed for a registered canvas that is also in the
    // document; the same event must only be counted once.
    return
  }
  flagged.__viewerWebGlLossHandled = true

  // Do NOT preventDefault(): for an evicted context Chrome will not fire
  // webglcontextrestored, so claiming the event would only hide the loss.
  const canvas = event.target instanceof HTMLCanvasElement ? event.target : null

  if (!canvas || !isViewportCanvas(canvas)) {
    // Cornerstone's capability probes (4x4 / 300x150, class-less) and any other
    // canvas in the page: a loss here never blanks a viewport. Only count it —
    // raising the viewport error for it was the false alarm.
    ignoredLossCount += 1
    return
  }

  viewportLossCount += 1
  const reason: WebGlContextLossReason = evictionWarnings > 0 ? 'gpu-quota' : 'context-lost'
  const info = buildLossInfo(canvas, reason)
  notify(info)

  const budget = info.engineCount > 0
    ? ` (this viewer requests ${info.requestedContexts} of ${info.contextQuota} contexts: ${info.engineCount} engines x ${info.contextsPerEngine})`
    : ''
  console.warn(`[viewer] WebGL context lost on a viewport canvas (${canvas.width}x${canvas.height})${budget}. Reload the viewer to restore the image.`)
}

export function registerViewportCanvas(canvas: HTMLCanvasElement | null | undefined) {
  if (!canvas) {
    return
  }

  const watched = canvas as WatchedCanvas
  viewportCanvases.add(canvas)

  if (watched.__viewerWebGlWatched) {
    return
  }

  watched.__viewerWebGlWatched = true
  canvas.addEventListener('webglcontextlost', handleContextLoss, true)
}

export function installWebGlContextLossWatch() {
  if (installed || typeof window === 'undefined') {
    return
  }

  const originalWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    const message = args.map((arg) => String(arg ?? '')).join(' ')
    if (message.includes('Too many active WebGL contexts')) {
      evictionWarnings += 1
      suppressedWarnings += 1
      // One actionable line instead of one per evicted context: the raw browser
      // message repeats for every context the page drops.
      if (suppressedWarnings === 1) {
        originalWarn('[viewer] WebGL context limit reached; the browser dropped the oldest viewport context. Reload the viewer to restore the image tiles.')
      }
      return
    }

    originalWarn(...args)
  }

  window.addEventListener('webglcontextlost', handleContextLoss, true)

  // Field diagnostics: open the devtools console and run `__viewerWebGlHealth()`.
  ;(globalThis as unknown as { __viewerWebGlHealth?: () => ViewerWebGlHealth }).__viewerWebGlHealth = readViewerWebGlHealth

  installed = true
}

/**
 * Registers the watch and attaches a canvas-level loss listener to every
 * viewport that already lives in a RenderingEngine, so a loss is noticed even if
 * the window-level capture listener is bypassed.
 */
export function watchRenderingEngineContexts(viewportIds: string[]) {
  installWebGlContextLossWatch()
  if (typeof window === 'undefined') {
    return
  }

  let engines: Types.IRenderingEngine[] = []
  try {
    engines = (getRenderingEngines?.() ?? []) as Types.IRenderingEngine[]
  } catch {
    engines = []
  }

  if (engines.length === 0) {
    const stackEngine = getRenderingEngine('nexia-stack-rendering-engine')
    engines = stackEngine ? [stackEngine] : []
  }

  for (const viewportId of viewportIds) {
    for (const engine of engines) {
      try {
        const viewport = engine.getViewport?.(viewportId) as (Types.IViewport & { element?: HTMLElement }) | undefined
        const renderWindow = engine.getOffscreenMultiRenderWindow?.(viewportId) as
          | { getContainer?: () => HTMLElement | null; getOpenGLRenderWindow?: () => { getCanvas?: () => HTMLCanvasElement | null } }
          | undefined
        const canvas = renderWindow?.getOpenGLRenderWindow?.()?.getCanvas?.()
          ?? renderWindow?.getContainer?.()?.querySelector?.('canvas')
          ?? viewport?.element?.querySelector?.('canvas')
          ?? null

        registerViewportCanvas(canvas ?? null)
      } catch {
        // getOffscreenMultiRenderWindow throws when the viewport is not assigned
        // to a pool context yet; the window-level listener still covers us.
      }
    }
  }
}

export function readViewerWebGlHealth(): ViewerWebGlHealth {
  const stats = readEngineStats()

  return {
    contextLost: hasRecentWebGlContextLoss(),
    lastLossAt: lastContextLostAt,
    lastLoss: lastLossInfo,
    suppressedWarnings,
    evictionWarnings,
    viewportLosses: viewportLossCount,
    ignoredLosses: ignoredLossCount,
    contextQuota: CONTEXT_QUOTA_PER_RENDERER,
    ...stats,
  }
}

export type CornerstoneViewport = Types.IViewport
