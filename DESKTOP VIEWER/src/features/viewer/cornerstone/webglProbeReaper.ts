/**
 * Cornerstone probes the GPU with throwaway canvases: `getSupportedTextureFormats()`
 * creates a canvas, asks for a WebGL2 context to read the extension list and then
 * never releases it (`isFloatPrecisionTexturesSupported()` does release, that one
 * only leaks nothing). Chrome counts every live context against its per-renderer
 * quota (~16), so a leaked probe context permanently steals one slot from the
 * viewports and shrinks the headroom for the MPR/3D panes.
 *
 * This helper wraps `initCore()`: it records the canvases that ask for a WebGL
 * context during init and, once init is done, releases the contexts of the ones
 * that never made it into the document (i.e. the probes). Real render-window
 * canvases are attached to a tile, so they are left untouched.
 */
export function reapDetachedProbeContexts(run: () => void) {
  const created: Array<{ canvas: HTMLCanvasElement; contextType: string }> = []
  const originalGetContext = HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.getContext = function patchedGetContext(
    this: HTMLCanvasElement,
    contextId: string,
    ...rest: unknown[]
  ) {
    const context = (originalGetContext as (...args: unknown[]) => unknown).apply(this, [contextId, ...rest])
    if (context && typeof contextId === 'string' && contextId.startsWith('webgl')) {
      created.push({ canvas: this, contextType: contextId })
    }

    return context as never
  } as typeof HTMLCanvasElement.prototype.getContext

  try {
    run()
  } finally {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }

  let released = 0
  for (const { canvas, contextType } of created) {
    if (canvas.isConnected) {
      // A pooled render window that already reached a viewport: keep it.
      continue
    }

    try {
      const context = originalGetContext.call(canvas, contextType) as WebGLRenderingContext | WebGL2RenderingContext | null
      context?.getExtension('WEBGL_lose_context')?.loseContext()
      released += 1
    } catch {
      // Probe canvases are disposable; a failed release must never break init.
    }
  }

  return released
}
