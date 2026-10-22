import { RenderingEngine, getRenderingEngine } from '@cornerstonejs/core'

export const STACK_RENDERING_ENGINE_ID = 'nexia-stack-rendering-engine'

let stackViewportRefCount = 0

export function acquireStackRenderingEngine() {
  stackViewportRefCount += 1

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

  stackViewportRefCount = Math.max(0, stackViewportRefCount - 1)

  if (stackViewportRefCount === 0) {
    renderingEngine?.destroy()
  }
}
