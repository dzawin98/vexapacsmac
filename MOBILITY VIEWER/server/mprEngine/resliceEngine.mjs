/**
 * Reslice Engine — MPR Engine
 *
 * Performs Multi-Planar Reconstruction (MPR) by sampling a 3D volume
 * along arbitrary planes. Supports axial, coronal, sagittal, and
 * oblique orientations using trilinear interpolation.
 *
 * Formula: P = O + u*X + v*Y
 *   O = origin of reslice plane
 *   u = axis vector (X direction in output space)
 *   v = axis vector (Y direction in output space)
 *
 * Each output pixel at (x,y) is sampled from the 3D volume using
 * trilinear interpolation of the 8 surrounding voxels.
 *
 * @module mprEngine/resliceEngine
 */

// ---------------------------------------------------------------------------
// Standard plane definitions (in volume voxel coordinates)
// ---------------------------------------------------------------------------

const STANDARD_PLANES = {
  axial: {
    label: 'Axial',
    // u = +x (columns), v = -y (rows), normal = +z (depth)
    u: [1, 0, 0],
    v: [0, 1, 0],
    w: [0, 0, 1],
  },
  coronal: {
    label: 'Coronal',
    // u = +x, v = +z, normal = -y
    u: [1, 0, 0],
    v: [0, 0, 1],
    w: [0, 1, 0],
  },
  sagittal: {
    label: 'Sagittal',
    // u = +y, v = +z, normal = -x
    u: [0, 1, 0],
    v: [0, 0, 1],
    w: [1, 0, 0],
  },
}

// ---------------------------------------------------------------------------
// Isotropic Resampling (Priority #1)
// ---------------------------------------------------------------------------

/**
 * Resample a 3D volume to isotropic voxel spacing using trilinear interpolation.
 *
 * CT volumes often have anisotropic spacing (e.g., 0.7×0.7×5.0 mm).
 * Without isotropic resampling, coronal/sagittal MPR will have severe
 * step artifacts because the Z-spacing is much larger than X/Y spacing.
 *
 * This function creates a new volume where all voxel dimensions are equal
 * to the smallest original spacing (typically X or Y), interpolating
 * new slices between existing ones.
 *
 * @param {Float32Array} pixelData  — Original volume [depth * height * width]
 * @param {object} meta  — { width, height, depth, spacing }
 * @returns {{ pixelData: Float32Array, meta: object }} — Resampled volume + updated metadata
 */
export function resampleIsotropic(pixelData, meta) {
  const { width, height, depth, spacing } = meta
  if (!spacing || spacing.length < 3) return { pixelData, meta }

  const sx = spacing[0]
  const sy = spacing[1]
  const sz = spacing[2]

  // Find target spacing: smallest voxel dimension (typically X or Y)
  const targetSpacing = Math.min(sx, sy, sz)

  // Skip if already isotropic (within 1% tolerance)
  const maxRatio = Math.max(sx, sy, sz) / Math.min(sx, sy, sz)
  if (maxRatio < 1.01) {
    return { pixelData, meta }
  }

  // Compute new dimensions preserving physical extent
  const physicalX = width * sx
  const physicalY = height * sy
  const physicalZ = depth * sz

  const newWidth = Math.max(1, Math.round(physicalX / targetSpacing))
  const newHeight = Math.max(1, Math.round(physicalY / targetSpacing))
  const newDepth = Math.max(1, Math.round(physicalZ / targetSpacing))

  // Map voxel index to original volume physical coordinate,
  // then back to original voxel index for trilinear sampling.
  // Scale factors: how many original voxels per new voxel
  const scaleX = sx / targetSpacing  // >1 if new voxels are smaller
  const scaleY = sy / targetSpacing
  const scaleZ = sz / targetSpacing

  const totalVoxels = newDepth * newHeight * newWidth
  const output = new Float32Array(totalVoxels)

  // Loop over new volume grid
  for (let oz = 0; oz < newDepth; oz++) {
    // Map new voxel center to original volume coordinates
    const origZ = (oz + 0.5) / scaleZ - 0.5
    for (let oy = 0; oy < newHeight; oy++) {
      const origY = (oy + 0.5) / scaleY - 0.5
      for (let ox = 0; ox < newWidth; ox++) {
        const origX = (ox + 0.5) / scaleX - 0.5

        // Trilinearly sample from original volume
        const value = trilinearInterpolate(
          pixelData, width, height, depth,
          origX, origY, origZ
        )

        output[oz * newHeight * newWidth + oy * newWidth + ox] = value
      }
    }
  }

  return {
    pixelData: output,
    meta: {
      ...meta,
      width: newWidth,
      height: newHeight,
      depth: newDepth,
      spacing: [targetSpacing, targetSpacing, targetSpacing],
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reslice a 3D volume along a specified plane.
 *
 * @param {Float32Array} pixelData  — flattened [depth * height * width]
 * @param {object} meta  — VolumeMetadata: { width, height, depth, spacing }
 * @param {object} options
 * @param {string}  options.plane    — 'axial' | 'coronal' | 'sagittal' | 'oblique'
 * @param {number}  [options.sliceIndex=0]  — Which slice along the plane normal
 * @param {number}  [options.ww=400]        — Window Width (for HU→display)
 * @param {number}  [options.wc=40]         — Window Center
 * @param {number[]} [options.customU]      — Custom axis U (oblique only)
 * @param {number[]} [options.customV]      — Custom axis V (oblique only)
 * @param {number[]} [options.customOrigin] — Custom origin (oblique only)
 * @returns {Uint8Array}  — 8-bit pixel buffer [width * height], 0-255
 */
export function resliceVolume(pixelData, meta, options = {}) {
  const {
    plane = 'axial',
    sliceIndex = 0,
    ww = 400,
    wc = 40,
    customU,
    customV,
    customOrigin,
  } = options

  const { width, height, depth, spacing } = meta

  // Determine plane vectors
  const planeDef = plane === 'oblique'
    ? { u: customU || [1, 0, 0], v: customV || [0, 1, 0], w: [0, 0, 1] }
    : STANDARD_PLANES[plane] || STANDARD_PLANES.axial

  const u = planeDef.u
  const v = planeDef.v
  const w = planeDef.w

  // Compute origin (corner of the slice in volume voxel space)
  // For standard planes, sliceIndex selects the slice along the w axis
  const origin = customOrigin || [
    w[0] !== 0 ? (sliceIndex / (depth - 1 || 1)) * (depth - 1) * spacing[2] : 0,
    w[1] !== 0 ? (sliceIndex / (depth - 1 || 1)) * (depth - 1) * spacing[2] : 0,
    w[2] !== 0 ? (sliceIndex / (depth - 1 || 1)) * (depth - 1) * spacing[2] : 0,
  ]

  // Output dimensions (match the plane's cross-section)
  const outWidth = plane === 'sagittal' ? depth : width
  const outHeight = plane === 'axial' ? height : depth
  const output = new Uint8Array(outWidth * outHeight)

  // Step sizes in voxel coordinates
  const stepU = [u[0] * spacing[0], u[1] * spacing[0], u[2] * spacing[0]]
  const stepV = [v[0] * spacing[1], v[1] * spacing[1], v[2] * spacing[1]]

  // Reslice: for each output pixel, sample volume
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      // World coordinate: P = O + x*stepU + y*stepV
      const px = origin[0] + x * stepU[0] + y * stepV[0]
      const py = origin[1] + x * stepU[1] + y * stepV[1]
      const pz = origin[2] + x * stepU[2] + y * stepV[2]

      // Convert to voxel indices
      const vx = px / (spacing[0] || 1)
      const vy = py / (spacing[1] || 1)
      const vz = pz / (spacing[2] || 1)

      // Sample with trilinear interpolation
      const value = trilinearInterpolate(pixelData, width, height, depth, vx, vy, vz)

      // Apply windowing
      const display = applyWindow(value, wc, ww)

      output[y * outWidth + x] = display
    }
  }

  return output
}

/**
 * Get the number of slices for a given plane.
 *
 * @param {object} meta  — VolumeMetadata
 * @param {string} plane — 'axial' | 'coronal' | 'sagittal'
 * @returns {number}
 */
export function getSliceCount(meta, plane) {
  const { width, height, depth } = meta
  switch (plane) {
    case 'axial':   return depth
    case 'coronal': return height
    case 'sagittal':return width
    default:        return depth
  }
}

// ---------------------------------------------------------------------------
// Trilinear Interpolation
// ---------------------------------------------------------------------------

/**
 * Trilinearly interpolate a value from a 3D volume at sub-voxel coordinates.
 *
 * Samples the 8 surrounding voxels and interpolates using fractional weights.
 *
 * @param {Float32Array} volume — flattened [depth * height * width]
 * @param {number} w — volume width
 * @param {number} h — volume height
 * @param {number} d — volume depth
 * @param {number} x — sub-voxel x (column)
 * @param {number} y — sub-voxel y (row)
 * @param {number} z — sub-voxel z (slice)
 * @returns {number} — interpolated value
 */
export function trilinearInterpolate(volume, w, h, d, x, y, z) {
  // Clamp to volume bounds
  const ix0 = clamp(Math.floor(x), 0, w - 1)
  const iy0 = clamp(Math.floor(y), 0, h - 1)
  const iz0 = clamp(Math.floor(z), 0, d - 1)
  const ix1 = Math.min(ix0 + 1, w - 1)
  const iy1 = Math.min(iy0 + 1, h - 1)
  const iz1 = Math.min(iz0 + 1, d - 1)

  // Fractional weights
  const fx = x - Math.floor(x)
  const fy = y - Math.floor(y)
  const fz = z - Math.floor(z)

  // Helper: index into flat array
  const idx = (iz, iy, ix) => iz * h * w + iy * w + ix

  // 8 corner voxels
  const v000 = volume[idx(iz0, iy0, ix0)]
  const v100 = volume[idx(iz0, iy0, ix1)]
  const v010 = volume[idx(iz0, iy1, ix0)]
  const v110 = volume[idx(iz0, iy1, ix1)]
  const v001 = volume[idx(iz1, iy0, ix0)]
  const v101 = volume[idx(iz1, iy0, ix1)]
  const v011 = volume[idx(iz1, iy1, ix0)]
  const v111 = volume[idx(iz1, iy1, ix1)]

  // Trilinear interpolation
  const c00 = v000 * (1 - fx) + v100 * fx
  const c10 = v010 * (1 - fx) + v110 * fx
  const c01 = v001 * (1 - fx) + v101 * fx
  const c11 = v011 * (1 - fx) + v111 * fx

  const c0 = c00 * (1 - fy) + c10 * fy
  const c1 = c01 * (1 - fy) + c11 * fy

  return c0 * (1 - fz) + c1 * fz
}

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

/**
 * Apply CT windowing (HU → display pixel).
 *
 * Formula: display = clamp(((HU - WC) / WW + 0.5) * 255, 0, 255)
 *
 * @param {number} hu  — Hounsfield Unit value
 * @param {number} wc  — Window Center
 * @param {number} ww  — Window Width
 * @returns {number}   — 8-bit pixel value (0-255)
 */
export function applyWindow(hu, wc, ww) {
  if (ww <= 0) return 0
  const normalized = ((hu - wc) / ww + 0.5) * 255
  return clamp(Math.round(normalized), 0, 255)
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// ---------------------------------------------------------------------------
// Window Width / Level Presets
// ---------------------------------------------------------------------------

export const WL_PRESETS = {
  lung:         { wc: -600, ww: 1500, label: 'Lung' },
  bone:         { wc: 300,  ww: 1500, label: 'Bone' },
  brain:        { wc: 40,   ww: 80,   label: 'Brain' },
  softTissue:   { wc: 40,   ww: 400,  label: 'Soft Tissue' },
  mediastinum:  { wc: 40,   ww: 350,  label: 'Mediastinum' },
}
