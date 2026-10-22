import { RenderingEngine, getRenderingEngine } from '@cornerstonejs/core'

export const STACK_RENDERING_ENGINE_ID = 'nexia-stack-rendering-engine'

/**
 * Grace period before an idle stack engine is destroyed.
 *
 * Opening a study remounts tiles (layout switch, study/series swap), which
 * momentarily releases every viewport. Destroying the engine right there costs a
 * full WebGLContextPool rebuild: each `new RenderingEngine()` allocates
 * `webGlContextCount` fresh GPU contexts, and Chrome only frees the old ones on
 * GC. A 4-tile study load was measured to build the engine three times (12
 * contexts for 4 tiles), which pushes the page to Chrome's ~16 context ceiling
 * with a single tab open; the browser then evicts the oldest context and a
 * viewport goes permanently blank. Holding the idle engine for a few seconds
 * keeps study switching on the same pool.
 */
const IDLE_DESTROY_DELAY_MS = 8000

const acquiredStackViewportIds = new Set<string>()
let anonymousStackViewportRefCount = 0
let pendingDestroy: ReturnType<typeof setTimeout> | null = null

function cancelPendingDestroy() {
  if (pendingDestroy !== null) {
    clearTimeout(pendingDestroy)
    pendingDestroy = null
  }
}

export function acquireStackRenderingEngine(viewportId?: string) {
  cancelPendingDestroy()

  if (viewportId) {
    acquiredStackViewportIds.add(viewportId)
  } else {
    anonymousStackViewportRefCount += 1
  }

  return getRenderingEngine(STACK_RENDERING_ENGINE_ID) ?? new RenderingEngine(STACK_RENDERING_ENGINE_ID)
}

export function releaseStackRenderingEngine(viewportId: string) {
  const renderingEngine = getRenderingEngine(STACK_RENDERING_ENGINE_ID)

  if (renderingEngine) {
    try {
      renderingEngine.disableElement(viewportId)
    } catch {
      // The viewport may already be disabled if setup was interrupted.
    }
  }

  if (acquiredStackViewportIds.has(viewportId)) {
    acquiredStackViewportIds.delete(viewportId)
  } else {
    anonymousStackViewportRefCount = Math.max(0, anonymousStackViewportRefCount - 1)
  }

  if (acquiredStackViewportIds.size === 0 && anonymousStackViewportRefCount === 0) {
    cancelPendingDestroy()
    pendingDestroy = setTimeout(() => {
      pendingDestroy = null
      if (acquiredStackViewportIds.size > 0 || anonymousStackViewportRefCount > 0) {
        return
      }

      getRenderingEngine(STACK_RENDERING_ENGINE_ID)?.destroy()
    }, IDLE_DESTROY_DELAY_MS)
  }
}
