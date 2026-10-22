/**
 * Multiresolution Pyramid — MPR Engine
 *
 * Generates Level-of-Detail (LOD) representations of a 3D volume:
 *   L0 — Full resolution (original)
 *   L1 — Half resolution (2x downsample via 2x2x2 averaging)
 *   L2 — Quarter resolution (4x downsample via 4x4x4 averaging)
 *
 * The pyramid is used for progressive loading: client requests L2 first
 * (instant), then L1 (fast), then L0 (full detail).
 *
 * @module mprEngine/pyramid
 */

/**
 * @typedef {Object} PyramidLevel
 * @property {Float32Array} pixelData  — Downsampled volume
 * @property {number} width
 * @property {number} height
 * @property {number} depth
 * @property {number} scale  — 1 = L0, 2 = L1, 4 = L2
 */

/**
 * @typedef {Object} VolumePyramid
 * @property {PyramidLevel[]} levels
 */

/**
 * Build a multiresolution pyramid from a full-res volume.
 *
 * @param {Float32Array} pixelData  — Full-res volume [depth * height * width]
 * @param {object} meta  — { width, height, depth }
 * @returns {VolumePyramid}
 */
export function buildPyramid(pixelData, meta) {
  const { width, height, depth } = meta

  return {
    levels: [
      // L0 — full resolution
      { pixelData, width, height, depth, scale: 1 },
      // L1 — half resolution
      downsampleVolume(pixelData, width, height, depth, 2),
      // L2 — quarter resolution
      downsampleVolume(pixelData, width, height, depth, 4),
    ],
  }
}

/**
 * Downsample a volume by averaging blocks.
 *
 * @param {Float32Array} src — Source volume
 * @param {number} w — Source width
 * @param {number} h — Source height
 * @param {number} d — Source depth
 * @param {number} factor — Downsample factor (2, 4, etc.)
 * @returns {PyramidLevel}
 */
function downsampleVolume(src, w, h, d, factor) {
  const dw = Math.max(1, Math.floor(w / factor))
  const dh = Math.max(1, Math.floor(h / factor))
  const dd = Math.max(1, Math.floor(d / factor))
  const dst = new Float32Array(dd * dh * dw)

  for (let oz = 0; oz < dd; oz++) {
    for (let oy = 0; oy < dh; oy++) {
      for (let ox = 0; ox < dw; ox++) {
        let sum = 0
        let count = 0
        const sz = oz * factor
        const sy = oy * factor
        const sx = ox * factor

        for (let iz = sz; iz < Math.min(sz + factor, d); iz++) {
          for (let iy = sy; iy < Math.min(sy + factor, h); iy++) {
            for (let ix = sx; ix < Math.min(sx + factor, w); ix++) {
              sum += src[iz * h * w + iy * w + ix]
              count++
            }
          }
        }

        dst[oz * dh * dw + oy * dw + ox] = count > 0 ? sum / count : 0
      }
    }
  }

  return { pixelData: dst, width: dw, height: dh, depth: dd, scale: factor }
}

/**
 * Get the appropriate level index for a given scale.
 *
 * @param {number} scale — 1 = L0, 2 = L1, 4 = L2
 * @returns {number} level index (0, 1, 2)
 */
export function scaleToLevelIndex(scale) {
  if (scale <= 1) return 0
  if (scale <= 2) return 1
  return 2
}
