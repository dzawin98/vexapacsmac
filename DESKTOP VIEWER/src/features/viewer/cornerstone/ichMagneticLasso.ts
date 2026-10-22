/**
 * Lasso magnetik untuk mask ICH — operator menggambar/menggeser garis tepi, dan
 * garis itu "lengket" ke tepi anatomi terdekat (seperti magnetic lasso di Photoshop).
 *
 * Modul ini SENGAJA bebas cornerstone/browser supaya bisa diuji headless:
 *  - hu   : Float32Array panjang w*h (HU per piksel)
 *  - grad : Float32Array panjang w*h (magnitudo gradien Sobel, dari ichMaskRefine)
 *
 * Dua tahap:
 *  1. `magneticSnapPolygon` — titik kontrol yang digambar operator (boleh meleset
 *     beberapa piksel) ditarik ke jalur berbiaya minimum: biaya langkah = panjang
 *     + magnetism * (1 - |grad|/skala). Jalan sepanjang tepi anatomi jadi murah,
 *     memotong jaringan datar jadi mahal. Jadi garis berhenti menempel di tepi,
 *     bukan di tempat kursor.
 *  2. `rasterizeLassoPath` + `applyLassoToBaseMask` — isi poligon jadi mask, lalu
 *     digabung ke mask lama dengan tiga operasi: replace / add (melebarkan) /
 *     subtract (mengecilkan).
 *
 * Jalur magnetik dicari dengan Dijkstra dalam koridor di sekitar setiap segmen,
 * memakai MinHeap dari ichMaskRefine (satu implementasi saja).
 */

import { MinHeap, collectLocalGradients, percentile, computeGradientMagnitude } from './ichMaskRefine'

export { computeGradientMagnitude }

export type IchLassoPoint = { x: number; y: number }

export type IchMagneticLassoOptions = {
  /** 'edge' = magnet ke tepi (default), 'line' = garis lurus antar titik kontrol. */
  mode?: 'edge' | 'line'
  /** Lebar koridor pencarian jalur di sekitar segmen lurus (px, default 6). */
  corridorPx?: number
  /** Kekuatan magnet: makin besar, makin mau memutar demi menempel tepi (default 4). */
  magnetism?: number
  /** Dinding HU: piksel di luar rentang ini tidak boleh dilewati jalur. */
  minHu?: number
  maxHu?: number
  /** Skala gradien "tepi kuat". Default: persentil 0.9 lokal di sekitar poligon. */
  gradScale?: number
  /** Radius pengambilan skala gradien lokal (default 3x corridor). */
  scaleRadiusPx?: number
  /** Jarak antar titik hasil (px) supaya array tidak membengkak (default 2). */
  simplifyStep?: number
}

export type IchMagneticLassoResult = {
  /** Titik jalur hasil (tertutup, titik pertama = terakhir). */
  path: IchLassoPoint[]
  segments: number
  /** Rata-rata gradien di sepanjang jalur dan di latar koridor yang sama. */
  pathGradient: number
  backgroundGradient: number
  /** > 1 berarti jalur menempel di tepi yang lebih kuat daripada jaringan sekitar. */
  alignment: number
  gradScale: number
}

export type IchLassoFill = {
  mask: Uint8Array
  voxelCount: number
}

export type IchLassoApplyResult = {
  mask: Uint8Array
  added: number
  removed: number
}

const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Skala gradien "tepi kuat": persentil lokal di kotak sekitar titik kontrol. */
function localGradScale(
  grad: Float32Array,
  w: number,
  h: number,
  points: IchLassoPoint[],
  radius: number,
  override?: number,
): number {
  if (override && override > 0) return override
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const cx = Math.round((minX + maxX) / 2)
  const cy = Math.round((minY + maxY) / 2)
  const r = Math.max(8, Math.min(Math.max(16, radius), Math.round(Math.hypot(maxX - minX, maxY - minY) / 2)))
  const values = collectLocalGradients(grad, w, h, cx, cy, r)
  const scale = percentile(values, 0.9)
  return Math.max(8, scale)
}

/**
 * Tarik satu segmen (a -> b) ke jalur berbiaya minimum di dalam koridor.
 * Biaya langkah = panjang langkah + magnetism * (1 - g), dengan g = |grad|/skala.
 */
function snapSegment(
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  a: IchLassoPoint,
  b: IchLassoPoint,
  corridorPx: number,
  magnetism: number,
  gradScale: number,
  minHu?: number,
  maxHu?: number,
): IchLassoPoint[] {
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - corridorPx))
  const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + corridorPx))
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - corridorPx))
  const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + corridorPx))
  const boxW = x1 - x0 + 1
  const boxH = y1 - y0 + 1
  if (boxW <= 0 || boxH <= 0) return [a, b]

  const inside = new Uint8Array(boxW * boxH)
  const cost = new Float64Array(boxW * boxH).fill(Infinity)
  const prev = new Int32Array(boxW * boxH).fill(-1)
  let count = 0
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (distToSegment(x, y, a.x, a.y, b.x, b.y) > corridorPx) continue
      const huValue = hu[y * w + x]
      if ((minHu !== undefined && huValue < minHu) || (maxHu !== undefined && huValue > maxHu)) continue
      inside[(y - y0) * boxW + (x - x0)] = 1
      count += 1
    }
  }
  if (count === 0) return [a, b]

  const toLocal = (p: IchLassoPoint) => {
    const lx = Math.min(boxW - 1, Math.max(0, Math.round(p.x) - x0))
    const ly = Math.min(boxH - 1, Math.max(0, Math.round(p.y) - y0))
    return ly * boxW + lx
  }
  const start = toLocal(a)
  const goal = toLocal(b)
  const heap = new MinHeap(boxW * boxH)
  cost[start] = 0
  heap.push(0, start)

  const steps: Array<[number, number, number]> = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ]

  while (heap.length > 0) {
    const top = heap.pop()
    if (!top) break
    const idx = top.val
    if (top.key > cost[idx]) continue
    if (idx === goal) break
    const lx = idx % boxW
    const ly = (idx - lx) / boxW
    for (const [ox, oy, geom] of steps) {
      const nx = lx + ox
      const ny = ly + oy
      if (nx < 0 || ny < 0 || nx >= boxW || ny >= boxH) continue
      const nIdx = ny * boxW + nx
      if (!inside[nIdx]) continue
      const g = Math.min(1, grad[(ny + y0) * w + (nx + x0)] / gradScale)
      // Tepi kuat = murah. Jaringan datar = mahal (di sini "magnet"-nya bekerja).
      const step = geom * (1 + magnetism * (1 - g))
      const next = top.key + step
      if (next < cost[nIdx]) {
        cost[nIdx] = next
        prev[nIdx] = idx
        heap.push(next, nIdx)
      }
    }
  }

  if (!Number.isFinite(cost[goal])) return [a, b]

  const path: IchLassoPoint[] = []
  let cursor = goal
  while (cursor >= 0) {
    const lx = cursor % boxW
    const ly = (cursor - lx) / boxW
    path.push({ x: lx + x0, y: ly + y0 })
    if (cursor === start) break
    cursor = prev[cursor]
  }
  path.reverse()
  return path
}

/**
 * Hasil akhir: jalur tertutup untuk seluruh titik kontrol operator.
 * `mode: 'line'` melewati magnet (dipakai sebagai pembanding terkontrol).
 */
export function magneticSnapPolygon(
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  points: IchLassoPoint[],
  options: IchMagneticLassoOptions = {},
): IchMagneticLassoResult {
  const mode = options.mode ?? 'edge'
  const corridorPx = Math.max(2, Math.round(options.corridorPx ?? 6))
  const magnetism = Math.max(0, options.magnetism ?? 4)
  const simplifyStep = Math.max(1, Math.round(options.simplifyStep ?? 2))
  const gradScale = localGradScale(grad, w, h, points, options.scaleRadiusPx ?? corridorPx * 3, options.gradScale)

  let path: IchLassoPoint[] = []
  if (mode === 'line' || points.length < 2) {
    path = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
  } else {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      const segment = snapSegment(hu, grad, w, h, a, b, corridorPx, magnetism, gradScale, options.minHu, options.maxHu)
      const thinned = segment.filter((_, index) => index === 0 || index % simplifyStep === 0 || index === segment.length - 1)
      path = path.concat(thinned)
    }
  }
  if (path.length) {
    path.push({ ...path[0] })
  }

  // Statistik: energi tepi di jalur vs latar di koridor yang sama.
  let pathSum = 0
  let bgSum = 0
  let bgCount = 0
  const corridor = new Uint8Array(w * h)
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - corridorPx))
    const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + corridorPx))
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - corridorPx))
    const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + corridorPx))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (distToSegment(x, y, a.x, a.y, b.x, b.y) > corridorPx * 0.6) continue
        corridor[y * w + x] = 1
      }
    }
  }
  const pathMask = new Uint8Array(w * h)
  for (const p of path) {
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue
    pathMask[p.y * w + p.x] = 1
    pathSum += grad[p.y * w + p.x]
  }
  for (let i = 0; i < corridor.length; i += 1) {
    if (!corridor[i] || pathMask[i]) continue
    bgSum += grad[i]
    bgCount += 1
  }
  const pathGradient = path.length ? pathSum / path.length : 0
  const backgroundGradient = bgCount ? bgSum / bgCount : 0
  return {
    path,
    segments: Math.max(0, path.length - 1),
    pathGradient,
    backgroundGradient,
    alignment: backgroundGradient > 0 ? pathGradient / backgroundGradient : 0,
    gradScale,
  }
}

/**
 * Jalur magnetik TERBUKA (polyline) untuk mode geser-batas: setiap segmen antar
 * titik kursor ditarik ke tepi, tanpa menutup poligon.
 */
export function magneticSnapPolyline(
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  points: IchLassoPoint[],
  options: IchMagneticLassoOptions = {},
): IchMagneticLassoResult {
  const mode = options.mode ?? 'edge'
  const corridorPx = Math.max(2, Math.round(options.corridorPx ?? 6))
  const magnetism = Math.max(0, options.magnetism ?? 6)
  const simplifyStep = Math.max(1, Math.round(options.simplifyStep ?? 2))
  const gradScale = localGradScale(grad, w, h, points, options.scaleRadiusPx ?? corridorPx * 3, options.gradScale)

  let path: IchLassoPoint[] = []
  if (mode === 'line' || points.length < 2) {
    path = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
  } else {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      const segment = snapSegment(hu, grad, w, h, a, b, corridorPx, magnetism, gradScale, options.minHu, options.maxHu)
      const thinned = segment.filter((_, index) => index === 0 || index % simplifyStep === 0 || index === segment.length - 1)
      path = i === 0 ? thinned : path.concat(thinned.slice(1))
    }
  }

  let pathSum = 0
  for (const p of path) {
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue
    pathSum += grad[p.y * w + p.x]
  }

  // Latar pembanding: piksel di koridor yang sama tetapi tidak di jalur.
  let bgSum = 0
  let bgCount = 0
  const corridor = new Uint8Array(w * h)
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - corridorPx))
    const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + corridorPx))
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - corridorPx))
    const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + corridorPx))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (distToSegment(x, y, a.x, a.y, b.x, b.y) > corridorPx * 0.6) continue
        corridor[y * w + x] = 1
      }
    }
  }
  for (const p of path) {
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue
    corridor[p.y * w + p.x] = 0
  }
  for (let i = 0; i < corridor.length; i += 1) {
    if (!corridor[i]) continue
    bgSum += grad[i]
    bgCount += 1
  }

  const pathGradient = path.length ? pathSum / path.length : 0
  const backgroundGradient = bgCount ? bgSum / bgCount : 0
  return {
    path,
    segments: Math.max(0, path.length - 1),
    pathGradient,
    backgroundGradient,
    alignment: backgroundGradient > 0 ? pathGradient / backgroundGradient : 0,
    gradScale,
  }
}

/** Tanda sisi piksel terhadap polyline: +1 di satu sisi, -1 di sisi lain, 0 tepat di jalur. */
function sideOfPolyline(
  px: number,
  py: number,
  path: IchLassoPoint[],
): { distance: number; side: number } {
  let best = Infinity
  let side = 0
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    let t = lenSq === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / lenSq
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    const d = Math.hypot(px - cx, py - cy)
    if (d < best) {
      best = d
      const cross = dx * (py - a.y) - dy * (px - a.x)
      side = cross > 0 ? 1 : cross < 0 ? -1 : 0
    }
  }
  return { distance: best, side }
}

/**
 * Mode "geser garis tepi": operator menyeret kursor dari satu titik di batas mask
 * ke titik lain. Jalur kursor di-snap magnetik ke tepi anatomi, lalu HANYA jendela
 * lokal di sekitar jalur itu yang diubah: piksel yang berada di sisi "dalam"
 * jendela menjadi mask, sisi luar tidak. Di luar jendela mask lama tidak tersentuh
 * - jadi bagian batas yang tidak digeser tetap seperti semula (itulah pengikatnya,
 * tanpa perlu menggambar poligon penuh).
 */
export function applyMagneticBoundaryDrag(
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  baseMask: Uint8Array,
  dragPoints: IchLassoPoint[],
  options: IchMagneticLassoOptions & {
    /** Setengah lebar jendela lokal (px, default 10). */
    windowPx?: number
    /** 'auto' (default) menebak sisi dalam dari mask lama, atau paksa 'left'/'right'. */
    insideSide?: 'auto' | 'left' | 'right'
  } = {},
): { mask: Uint8Array; added: number; removed: number; path: IchLassoPoint[]; alignment: number; pathGradient: number } {
  const windowPx = Math.max(3, Math.round(options.windowPx ?? 10))
  const snap = magneticSnapPolyline(hu, grad, w, h, dragPoints, { magnetism: 6, corridorPx: 6, ...options })
  const path = snap.path
  if (path.length < 2) {
    return { mask: Uint8Array.from(baseMask), added: 0, removed: 0, path, alignment: 0, pathGradient: 0 }
  }

  // HANYA kotak di sekitar jalur (+ jendela) yang dihitung. Versi pertama menghitung
  // uji sisi untuk seluruh 512x512 piksel dan menjadi ~1 detik - tidak layak untuk
  // interaksi. Sekarang: satu lintasan untuk medan sisi, satu lintasan untuk mengubah.
  let minX = w - 1
  let maxX = 0
  let minY = h - 1
  let maxY = 0
  for (const p of path) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const bx0 = Math.max(0, Math.floor(minX - windowPx))
  const bx1 = Math.min(w - 1, Math.ceil(maxX + windowPx))
  const by0 = Math.max(0, Math.floor(minY - windowPx))
  const by1 = Math.min(h - 1, Math.ceil(maxY + windowPx))
  const boxW = bx1 - bx0 + 1
  const boxH = by1 - by0 + 1
  if (boxW <= 0 || boxH <= 0) {
    return { mask: Uint8Array.from(baseMask), added: 0, removed: 0, path, alignment: snap.alignment, pathGradient: snap.pathGradient }
  }

  const sideField = new Int8Array(boxW * boxH)
  const inside = new Uint8Array(boxW * boxH)
  for (let y = by0; y <= by1; y += 1) {
    for (let x = bx0; x <= bx1; x += 1) {
      const { distance, side } = sideOfPolyline(x, y, path)
      if (distance > windowPx) continue
      const local = (y - by0) * boxW + (x - bx0)
      inside[local] = 1
      sideField[local] = side
    }
  }

  // Sisi "dalam": di sisi mana mask lama lebih banyak - operator menyeret batas, jadi
  // mask harus mengisi sampai ke jalur di sisi yang berisi mask.
  let insideSide: number
  if (options.insideSide === 'left') {
    insideSide = 1
  } else if (options.insideSide === 'right') {
    insideSide = -1
  } else {
    let plus = 0
    let minus = 0
    for (let y = by0; y <= by1; y += 1) {
      for (let x = bx0; x <= bx1; x += 1) {
        const local = (y - by0) * boxW + (x - bx0)
        if (!inside[local] || sideField[local] === 0) continue
        if (!baseMask[y * w + x]) continue
        if (sideField[local] > 0) plus += 1
        else minus += 1
      }
    }
    insideSide = plus >= minus ? 1 : -1
  }

  const mask = Uint8Array.from(baseMask)
  let added = 0
  let removed = 0
  for (let y = by0; y <= by1; y += 1) {
    for (let x = bx0; x <= bx1; x += 1) {
      const local = (y - by0) * boxW + (x - bx0)
      if (!inside[local]) continue
      const i = y * w + x
      const shouldBeInside = sideField[local] === insideSide || sideField[local] === 0
      const was = mask[i] === 1
      if (shouldBeInside && !was) {
        mask[i] = 1
        added += 1
      } else if (!shouldBeInside && was) {
        mask[i] = 0
        removed += 1
      }
    }
  }
  return { mask, added, removed, path, alignment: snap.alignment, pathGradient: snap.pathGradient }
}

/**
 * Isi poligon (aturan even-odd, scanline) jadi mask 0/1.
 * Dipakai untuk mask poligon lurus maupun jalur hasil magnet.
 */
export function rasterizeLassoPath(points: IchLassoPoint[], w: number, h: number): IchLassoFill {
  const mask = new Uint8Array(w * h)
  if (points.length < 3) return { mask, voxelCount: 0 }

  const xs: number[] = []
  let minY = h
  let maxY = -1
  for (const p of points) {
    const py = Math.round(p.y)
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }
  minY = Math.max(0, minY)
  maxY = Math.min(h - 1, maxY)

  for (let y = minY; y <= maxY; y += 1) {
    xs.length = 0
    const scanY = y + 0.5
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      const ay = a.y
      const by = b.y
      if ((ay <= scanY && by > scanY) || (by <= scanY && ay > scanY)) {
        const t = (scanY - ay) / (by - ay)
        xs.push(a.x + t * (b.x - a.x))
      }
    }
    if (xs.length < 2) continue
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const startX = Math.max(0, Math.ceil(xs[k]))
      const endX = Math.min(w - 1, Math.floor(xs[k + 1]))
      for (let x = startX; x <= endX; x += 1) mask[y * w + x] = 1
    }
  }

  let voxelCount = 0
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) voxelCount += 1
  return { mask, voxelCount }
}

/**
 * Gabungkan hasil lasso ke mask yang sudah ada.
 *  - 'replace'  : mask lama di dalam poligon dibuang, isi poligon dipakai
 *  - 'add'      : isi poligon ditambahkan (melebarkan tepi)
 *  - 'subtract' : isi poligon dibuang dari mask lama (mengecilkan tepi)
 */
export function applyLassoToBaseMask(
  baseMask: Uint8Array,
  lassoMask: Uint8Array,
  operation: 'replace' | 'add' | 'subtract',
): IchLassoApplyResult {
  const mask = Uint8Array.from(baseMask)
  let added = 0
  let removed = 0
  for (let i = 0; i < mask.length; i += 1) {
    const inLasso = lassoMask[i] === 1
    const inBase = baseMask[i] === 1
    if (operation === 'add') {
      if (inLasso && !inBase) {
        mask[i] = 1
        added += 1
      }
      continue
    }
    if (operation === 'subtract') {
      if (inLasso && inBase) {
        mask[i] = 0
        removed += 1
      }
      continue
    }
    const want = inLasso
    if (want && !inBase) {
      mask[i] = 1
      added += 1
    } else if (!want && inBase) {
      mask[i] = 0
      removed += 1
    }
  }
  return { mask, added, removed }
}

/** Ubah mask jadi titik kontrol poligon: batas mask, diurutkan mengelilingi centroid, disampling. */
export function maskBoundaryToLassoPoints(
  mask: Uint8Array,
  w: number,
  h: number,
  options: { maxPoints?: number } = {},
): IchLassoPoint[] {
  const boundary: IchLassoPoint[] = []
  let sumX = 0
  let sumY = 0
  let count = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      if (!mask[i]) continue
      sumX += x
      sumY += y
      count += 1
      const isEdge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]
      if (isEdge) boundary.push({ x, y })
    }
  }
  if (!boundary.length || !count) return []
  const cx = sumX / count
  const cy = sumY / count
  boundary.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  const maxPoints = Math.max(4, options.maxPoints ?? 24)
  if (boundary.length <= maxPoints) return boundary
  const step = boundary.length / maxPoints
  const out: IchLassoPoint[] = []
  for (let k = 0; k < maxPoints; k += 1) out.push(boundary[Math.floor(k * step)])
  return out
}
