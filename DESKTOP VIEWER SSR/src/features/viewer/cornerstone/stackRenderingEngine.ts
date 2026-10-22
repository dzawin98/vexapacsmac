import { RenderingEngine, getRenderingEngine, getShouldUseCPURendering, setUseCPURendering } from '@cornerstonejs/core'

export const STACK_RENDERING_ENGINE_ID = 'nexia-stack-rendering-engine'
export const SSR_STACK_RENDERING_ENGINE_ID = 'nexia-stack-ssr-cpu-rendering-engine'

const acquiredStackViewportIdsByEngine = new Map<string, Set<string>>()
const anonymousStackViewportRefCountByEngine = new Map<string, number>()

type StackRenderingEngineOptions = {
  ssr?: boolean
  useCpu?: boolean
}

function getStackRenderingEngineId(options?: StackRenderingEngineOptions) {
  return options?.ssr ? SSR_STACK_RENDERING_ENGINE_ID : STACK_RENDERING_ENGINE_ID
}

function getAcquiredViewportIds(engineId: string) {
  let viewportIds = acquiredStackViewportIdsByEngine.get(engineId)
  if (!viewportIds) {
    viewportIds = new Set<string>()
    acquiredStackViewportIdsByEngine.set(engineId, viewportIds)
  }
  return viewportIds
}

export function withStackCpuRendering<T>(enabled: boolean, callback: () => T): T {
  if (!enabled) {
    return callback()
  }

  const previous = getShouldUseCPURendering()
  setUseCPURendering(true, false)
  try {
    return callback()
  } finally {
    setUseCPURendering(previous, false)
  }
}

export function acquireStackRenderingEngine(viewportId?: string, options?: StackRenderingEngineOptions) {
  const engineId = getStackRenderingEngineId(options)
  const acquiredStackViewportIds = getAcquiredViewportIds(engineId)

  if (viewportId) {
    acquiredStackViewportIds.add(viewportId)
  } else {
    anonymousStackViewportRefCountByEngine.set(
      engineId,
      (anonymousStackViewportRefCountByEngine.get(engineId) ?? 0) + 1,
    )
  }

  return getRenderingEngine(engineId) ?? withStackCpuRendering(Boolean(options?.useCpu), () => new RenderingEngine(engineId))
}

export function releaseStackRenderingEngine(viewportId: string, options?: StackRenderingEngineOptions) {
  const engineId = getStackRenderingEngineId(options)
  const renderingEngine = getRenderingEngine(engineId)

  if (renderingEngine) {
    try {
      renderingEngine.disableElement(viewportId)
    } catch {
      // The viewport may already be disabled if setup was interrupted.
    }
  }

  const acquiredStackViewportIds = getAcquiredViewportIds(engineId)
  if (acquiredStackViewportIds.has(viewportId)) {
    acquiredStackViewportIds.delete(viewportId)
  } else {
    anonymousStackViewportRefCountByEngine.set(
      engineId,
      Math.max(0, (anonymousStackViewportRefCountByEngine.get(engineId) ?? 0) - 1),
    )
  }

  if (acquiredStackViewportIds.size === 0 && (anonymousStackViewportRefCountByEngine.get(engineId) ?? 0) === 0) {
    renderingEngine?.destroy()
    acquiredStackViewportIdsByEngine.delete(engineId)
    anonymousStackViewportRefCountByEngine.delete(engineId)
  }
}

export function releaseCornerstoneWebGlContexts(root: HTMLElement | null) {
  if (!root) return
  const canvases = Array.from(root.querySelectorAll<HTMLCanvasElement>('canvas.cornerstone-canvas'))
  canvases.forEach((canvas) => {
    try {
      const context = (
        canvas.getContext('webgl2')
        ?? canvas.getContext('webgl')
        ?? canvas.getContext('experimental-webgl')
      ) as (WebGLRenderingContext | WebGL2RenderingContext | null)
      context?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      // Browser cleanup is best-effort; Cornerstone has already detached the viewport.
    }
  })
}
