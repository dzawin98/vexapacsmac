/**
 * Mesin pemurnian mask ICH (edge-aware geodesic grow).
 *
 * Berkas ini SENGAJA bebas dari cornerstone/browser supaya bisa diuji headless
 * (skrip node/python memakai HU mentah). Modul ini hanya bekerja pada array:
 *  - hu     : Float32Array panjang w*h (nilai HU per piksel, sudah di-rescale)
 *  - mask   : Uint8Array panjang w*h (0/1) sebagai hasil operator
 *
 * Gagasan utama: batas mask tidak ditentukan oleh "HU masuk rentang" saja,
 * tetapi oleh biaya geodesic yang ikut menghitung kekuatan tepi (|gradien|).
 * Menyeberangi tepi anatomi jadi mahal, jadi pertumbuhan berhenti di tepi
 * jaringan, bukan di angka HU yang kebetulan sama.
 */

export type IchRefineOptions = {
  /** HU target (pusat jaringan yang disemai operator). */
  targetHu: number
  /** Setengah lebar rentang HU yang masih dianggap jaringan. */
  toleranceHu: number
  /** Radius maksimum pertumbuhan dari titik semai (piksel). */
  maxRadiusPx: number
  /** Batas jumlah voxel yang boleh diterima. */
  maxVoxels?: number
  /** Bobot suku tepi: makin besar, makin "lengket" ke tepi anatomi. */
  edgeWeight?: number
  /** Bobot suku HU: makin besar, makin ketat pada rentang HU. */
  huWeight?: number
  /** Ambang biaya kumulatif untuk menerima voxel. */
  budget?: number
  /** Berapa kali toleransi HU yang masih boleh dimasuki (dinding keras). */
  huWallFactor?: number
  /** Persentil gradien lokal yang dijadikan dinding tepi (default 0.9). */
  ridgePercentile?: number
  /** Nilai gradien absolut sebagai dinding tepi (menimpa ambang Otsu lokal). */
  ridgeThresholdAbsolute?: number
  /** Coba jalur eksperimental dinding ridge (keluar-gagal bila tepi tidak tertutup). */
  useRidgeWall?: boolean
  /** Batas HU absolut yang boleh dimasuki pertumbuhan (dinding keras). */
  minHu?: number
  maxHu?: number
  /** Pakai kontur aktif (pita sempit) setelah pertumbuhan awal: batas akhir ditentukan kontur, bukan anggaran. */
  useActiveContour?: boolean
  /** Parameter kontur aktif (lihat `activeContourRefine`). */
  contour?: IchContourParams
  /** Snap batas ke puncak gradien (default: aktif hanya tanpa kontur - snap per voxel membuat tepi bergerigi). */
  useSnapToEdges?: boolean
  /** Berapa pass buka-tutup morfologi untuk menghaluskan gerigi/notch (lihat `smoothMaskMorphology`). */
  smoothPasses?: number
}

export type IchRefineStats = {
  voxelCount: number
  boundaryVoxels: number
  boundaryMeanGradient: number
  backgroundMeanGradient: number
  /** Rasio energi tepi di batas mask vs energi tepi acak (makin > 1 makin baik). */
  edgeAlignment: number
  leaks: number
  holesFilled: number
  thinVoxelsRemoved: number
  snappedVoxels: number
  /** Simpangan baku model jaringan di titik semai (HU) yang dipakai kontur aktif. */
  sigmaHu: number
  /** Berapa voxel dibalik oleh kontur aktif dan berapa sapuan yang dipakai. */
  contourFlips: number
  contourIterations: number
  /** Energi kontur sebelum/sesudah (data + panjang antarmuka). Turun = kontur membaik. */
  contourEnergyBefore: number
  contourEnergyAfter: number
  /** Voxel yang dibuang/diisi pass penghalusan morfologi. */
  morphRemoved: number
  morphFilled: number
  /** Kalau tidak null: pemurnian dibatalkan oleh penjaga dan mask masukan dikembalikan apa adanya. */
  guard: string | null
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Penjaga agar pemurnian mask tidak pernah "menghancurkan" mask operator.
 * Semua angka di bawah datang dari pengukuran pada CT kepala dev (lihat
 * diag-refine-rusak.cjs): tanpa penjaga, 12 dari 41 slice meledak 100-14000%.
 */
export const ICH_REFINE_MIN_TARGET_HU = 50
export const ICH_REFINE_MAX_GROW_FACTOR = 4
export const ICH_REFINE_MAX_EXTRA_VOXELS = 2500
export const ICH_REFINE_MIN_REMAIN_FACTOR = 0.5

/** Hitung voxel mask yang bernilai 1. */
export function countMaskVoxels(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) n += 1
  return n
}

/** Gradien Sobel 3x3 (magnitudo) dari citra HU. */
export function computeGradientMagnitude(hu: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      const tl = hu[i - w - 1], t = hu[i - w], tr = hu[i - w + 1]
      const l = hu[i - 1], r = hu[i + 1]
      const bl = hu[i + w - 1], b = hu[i + w], br = hu[i + w + 1]
      const gx = tr + 2 * r + br - (tl + 2 * l + bl)
      const gy = bl + 2 * b + br - (tl + 2 * t + tr)
      out[i] = Math.sqrt(gx * gx + gy * gy) * 0.25
    }
  }
  return out
}

/** Persentil nilai (dipakai menormalkan skala gradien ke tepi anatomi terkuat). */
export function percentile(values: ArrayLike<number>, q: number): number {
  const n = values.length
  if (!n) return 0
  const bins = 1024
  let min = Infinity, max = -Infinity
  for (let i = 0; i < n; i += 1) {
    const v = values[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || max <= min) return min === Infinity ? 0 : min
  const hist = new Int32Array(bins)
  const scale = (bins - 1) / (max - min)
  for (let i = 0; i < n; i += 1) hist[Math.round((values[i] - min) * scale)] += 1
  const target = q * n
  let acc = 0
  for (let b = 0; b < bins; b += 1) {
    acc += hist[b]
    if (acc >= target) return min + b / scale
  }
  return max
}

/** Otsu: ambang pemisah dua populasi, dipakai untuk menormalkan skala gradien. */
export function otsuThreshold(values: ArrayLike<number>): number {
  let min = Infinity, max = -Infinity
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || max <= min) return min === Infinity ? 0 : min
  const bins = 256
  const hist = new Float64Array(bins)
  const scale = (bins - 1) / (max - min)
  for (let i = 0; i < values.length; i += 1) hist[Math.round((values[i] - min) * scale)] += 1
  const total = values.length
  let sum = 0
  for (let b = 0; b < bins; b += 1) sum += b * hist[b]
  let sumB = 0, wB = 0, best = 0, bestVar = -1
  for (let b = 0; b < bins; b += 1) {
    wB += hist[b]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += b * hist[b]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) { bestVar = between; best = b }
  }
  return min + best / scale
}

/** Min-heap kecil (biner) untuk Dijkstra; cukup untuk 512x512. */
class MinHeap {
  private keys: Float64Array
  private vals: Int32Array
  private size = 0

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity)
    this.vals = new Int32Array(capacity)
  }

  get length() { return this.size }

  push(key: number, val: number) {
    let i = this.size
    if (i >= this.keys.length) return
    this.size += 1
    this.keys[i] = key
    this.vals[i] = val
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= this.keys[i]) break
      this.swap(p, i)
      i = p
    }
  }

  pop(): { key: number; val: number } | null {
    if (this.size === 0) return null
    const key = this.keys[0], val = this.vals[0]
    this.size -= 1
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]
      this.vals[0] = this.vals[this.size]
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < this.size && this.keys[l] < this.keys[m]) m = l
        if (r < this.size && this.keys[r] < this.keys[m]) m = r
        if (m === i) break
        this.swap(m, i)
        i = m
      }
    }
    return { key, val }
  }

  private swap(a: number, b: number) {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v
  }
}

export { MinHeap }

/** Rata-rata HU + simpangan baku pada cakram kecil di sekitar titik semai. */
export function sampleDiscHu(hu: Float32Array, w: number, h: number, cx: number, cy: number, radius: number) {
  let n = 0, sum = 0, sumSq = 0
  const r2 = radius * radius
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x += 1) {
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      const v = hu[y * w + x]
      n += 1
      sum += v
      sumSq += v * v
    }
  }
  if (!n) return { mean: 0, stdDev: 0, count: 0 }
  const mean = sum / n
  const variance = Math.max(0, sumSq / n - mean * mean)
  return { mean, stdDev: Math.sqrt(variance), count: n }
}

/**
 * Estimasi jaringan sasaran yang tahan bias: MEDIAN HU pada cakram besar
 * (default r=12) sebagai pusat jaringan, dan simpangan baku dari cakram kecil
 * (r=3) sebagai lebar sebarannya.
 *
 * Mengapa tidak rata-rata cakram kecil saja (perilaku lama): rata-rata r=3 jatuh
 * tepat di inti perdarahan yang paling padat (contoh nyata: 88 HU), sehingga
 * dinding bawah yang diturunkan dari angka itu memotong bagian lesi yang lebih
 * hipodense. Terukur pada 8 slice pasien dev: Dice terhadap blob otomatis
 * 0.725 -> 0.801 dan stabilitas luas terhadap radius drag 0.918 -> 1.000.
 */
export function sampleRobustTissueHu(
  hu: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  options: { targetRadius?: number; sigmaRadius?: number } = {},
) {
  const targetRadius = Math.max(2, Math.round(options.targetRadius ?? 12))
  const sigmaRadius = Math.max(1, Math.round(options.sigmaRadius ?? 3))
  const vals: number[] = []
  const r2 = targetRadius * targetRadius
  for (let y = Math.max(0, cy - targetRadius); y <= Math.min(h - 1, cy + targetRadius); y += 1) {
    for (let x = Math.max(0, cx - targetRadius); x <= Math.min(w - 1, cx + targetRadius); x += 1) {
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      vals.push(hu[y * w + x])
    }
  }
  if (!vals.length) {
    const small = sampleDiscHu(hu, w, h, cx, cy, sigmaRadius)
    return { median: small.mean, sigma: Math.max(4, small.stdDev), count: 0 }
  }
  vals.sort((a, b) => a - b)
  const at = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))]
  const small = sampleDiscHu(hu, w, h, cx, cy, sigmaRadius)
  return {
    median: at(0.5),
    sigma: Math.max(4, small.stdDev),
    count: vals.length,
    q25: at(0.25),
    q75: at(0.75),
  }
}

export const clampNumber = clamp

/** Gradien di dalam cakram sekitar titik semai (untuk skala lokal). */
export function collectLocalGradients(
  grad: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
): Float32Array {
  const out: number[] = []
  const r2 = radius * radius
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x += 1) {
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      out.push(grad[y * w + x])
    }
  }
  return Float32Array.from(out)
}

export type GrowResult = {
  mask: Uint8Array
  accepted: number
  reachedLimit: boolean
  seedAccepted: boolean
  budgetUsed: number
}

/**
 * Pertumbuhan geodesic dari titik semai.
 *
 * Biaya tiap langkah = huCost + edgeCost, dengan
 *   huCost  = |HU - target| / toleranceHu        (di luar rentang jadi mahal)
 *   edgeCost= edgeWeight * max(0, 1 - |grad|/gradRef)  (tepi kuat jadi murah,
 *             sehingga jalur pertumbuhan cenderung MENELUSURI tepi, bukan
 *             menyeberanginya)
 *
 * Perhatikan: suku tepi dipakai sebagai penghalang, bukan penarik. Voxel yang
 * berada di tepi kuat tidak otomatis masuk; yang terjadi adalah penyeberangan
 * tepi memakan biaya besar sampai melewati `budget`, jadi mask berhenti di
 * garis tepi anatomi.
 */
export function geodesicGrow(
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  options: IchRefineOptions & { seedMask?: Uint8Array | null },
): GrowResult {
  const {
    targetHu,
    toleranceHu,
    maxRadiusPx,
    maxVoxels = 90000,
    edgeWeight = 8,
    huWeight = 2,
    budget = Math.max(24, maxRadiusPx * 1.35),
    huWallFactor = 1.8,
    minHu,
    maxHu,
    seedMask = null,
  } = options

  const mask = new Uint8Array(w * h)
  // Float64 supaya pembandingan "entri basi" (top.key > dist[idx]) tidak pernah
  // salah buang karena pembulatan float32.
  const dist = new Float64Array(w * h).fill(Infinity)
  // Skala gradien dinormalkan LOKAL di sekitar titik semai (bukan seluruh citra):
  // tepi lesi harus jadi penghalang kuat, sedangkan tepi tulang di kejauhan tidak
  // boleh mendominasi skala.
  const gradRef = Math.max(8, percentile(collectLocalGradients(grad, w, h, seedX, seedY, Math.min(80, Math.max(24, maxRadiusPx))), 0.9))
  const tol = Math.max(6, toleranceHu)
  const radius2 = maxRadiusPx * maxRadiusPx
  const seed = seedY * w + seedX
  // Bila operator sudah mencoret, cakupan sudah ditentukan oleh coretannya:
  // batas radius tunggal tidak dipakai, pertumbuhan dibatasi anggaran biaya
  // dan maxVoxels saja.
  const useRadius = !seedMask

  const heap = new MinHeap(w * h)
  if (seedMask) {
    for (let i = 0; i < seedMask.length; i += 1) {
      if (!seedMask[i]) continue
      if ((hu[i] - targetHu) ** 2 > (tol * 4) ** 2) continue // buang coretan di luar jaringan
      dist[i] = 0
      heap.push(0, i)
    }
  }
  if (heap.length === 0) {
    dist[seed] = 0
    heap.push(0, seed)
  }
  let accepted = 0
  let reachedLimit = false
  let maxDist = 0

  while (heap.length > 0) {
    const top = heap.pop()
    if (!top) break
    const idx = top.val
    if (top.key > dist[idx]) continue
    if (top.key > budget) break
    if (mask[idx]) continue
    mask[idx] = 1
    accepted += 1
    if (top.key > maxDist) maxDist = top.key
    if (accepted >= maxVoxels) { reachedLimit = true; break }

    const x = idx % w
    const y = (idx - x) / w
    for (let k = 0; k < 4; k += 1) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0)
      const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0)
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nIdx = ny * w + nx
      if (mask[nIdx]) continue
      const dx = nx - seedX, dy = ny - seedY
      if (useRadius && dx * dx + dy * dy > radius2) continue
      const huDelta = Math.abs(hu[nIdx] - targetHu)
      // Dinding HU absolut (kalau diberi): batas bawah biasanya harus ketat supaya
      // pertumbuhan tidak menyusup ke jaringan otak isodens.
      if (minHu !== undefined && hu[nIdx] < minHu) continue
      if (maxHu !== undefined && hu[nIdx] > maxHu) continue
      if (huDelta > tol * huWallFactor) continue // dinding keras: jelas bukan jaringan sasaran
      const huCost = clamp(huDelta / tol, 0, 2) * huWeight
      // Tepi anatomi = penghalang keras: biaya naik kuadratik terhadap kekuatan
      // tepi, jadi menyeberangi ridge kuat langsung menghabiskan anggaran dan
      // pertumbuhan berhenti di garis tepi - bukan di jarak drag.
      const edgeRatio = clamp(grad[nIdx] / gradRef, 0, 1.5)
      const edgeCost = edgeWeight * edgeRatio * edgeRatio
      const step = 1 + huCost + edgeCost
      const nd = top.key + step
      if (nd < dist[nIdx]) {
        dist[nIdx] = nd
        heap.push(nd, nIdx)
      }
    }
  }
  return { mask, accepted, reachedLimit, seedAccepted: mask[seed] === 1, budgetUsed: maxDist }
}

/**
 * Pertumbuhan dibatasi ridge (dinding tepi anatomi).
 *
 * Beda mendasar dari `geodesicGrow`: voxel ber-gradien kuat dijadikan DINDING,
 * bukan sekadar biaya. Daerah yang memuat titik semai digenangi sampai berhenti
 * di dinding, lalu satu lapis dinding yang bersinggungan ditempelkan kembali
 * (dengan syarat HU-nya masih masuk akal). Hasilnya garis tepi mask jatuh tepat
 * di tepi anatomi, dan luasnya tidak lagi ditentukan jarak drag - ini yang
 * membuat masking terasa "tahu" batas lesi.
 */
export function ridgeBoundedGrow(
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  options: IchRefineOptions & { ridgePercentile?: number; seedMask?: Uint8Array | null },
): GrowResult {
  const {
    targetHu,
    toleranceHu,
    maxRadiusPx,
    maxVoxels = 90000,
    seedMask = null,
  } = options

  const tol = Math.max(6, toleranceHu)
  const localGrads = collectLocalGradients(grad, w, h, seedX, seedY, Math.min(80, Math.max(24, maxRadiusPx)))
  // Ambang dinding tepi dari Otsu gradien lokal: memisahkan "tepi" dari "datar"
  // tanpa bergantung pada persentil yang bisa didominasi tepi tulang jauh.
  const gradRef = Math.max(8, options.ridgeThresholdAbsolute ?? otsuThreshold(localGrads))
  const seed = seedY * w + seedX
  const mask = new Uint8Array(w * h)
  const rawWall = new Uint8Array(w * h)
  for (let i = 0; i < rawWall.length; i += 1) {
    if (grad[i] >= gradRef) rawWall[i] = 1
    else if (Math.abs(hu[i] - targetHu) > tol * 2) rawWall[i] = 1
    else if (options.minHu !== undefined && hu[i] < options.minHu) rawWall[i] = 1
    else if (options.maxHu !== undefined && hu[i] > options.maxHu) rawWall[i] = 1
  }
  // Tutup celah 1 piksel pada dinding (dilatasi 4-tetangga): tepi lesi yang
  // terputus karena derau/bising harus jadi kurva tertutup, kalau tidak banjir
  // akan bocor lewat celah itu dan mask melebar ke seluruh jaringan.
  const wall = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      if (rawWall[i]) { wall[i] = 1; continue }
      if (x > 0 && rawWall[i - 1]) { wall[i] = 1; continue }
      if (x < w - 1 && rawWall[i + 1]) { wall[i] = 1; continue }
      if (y > 0 && rawWall[i - w]) { wall[i] = 1; continue }
      if (y < h - 1 && rawWall[i + w]) { wall[i] = 1; continue }
    }
  }

  const r2 = maxRadiusPx * maxRadiusPx
  const stack: number[] = []
  if (seedMask) {
    for (let i = 0; i < seedMask.length; i += 1) if (seedMask[i]) stack.push(i)
  }
  if (!stack.length) stack.push(seed)

  let accepted = 0
  let reachedLimit = false
  while (stack.length) {
    const i = stack.pop()
    if (mask[i]) continue
    const forceOpen = i === seed || Boolean(seedMask && seedMask[i])
    if (wall[i] && !forceOpen) continue
    const x = i % w
    const y = (i - x) / w
    const dx = x - seedX
    const dy = y - seedY
    if (dx * dx + dy * dy > r2) continue
    mask[i] = 1
    accepted += 1
    if (accepted >= maxVoxels) { reachedLimit = true; break }
    if (x > 0) stack.push(i - 1)
    if (x < w - 1) stack.push(i + 1)
    if (y > 0) stack.push(i - w)
    if (y < h - 1) stack.push(i + w)
  }

  // Tempelkan satu lapis dinding yang bersinggungan dengan mask: di sinilah
  // "garis tepi" ditempatkan, bukan di piksel terakhir yang masih lolos ambang.
  let ringVoxels = 0
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      if (!wall[i] || mask[i]) continue
      if (!(mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w])) continue
      if (Math.abs(hu[i] - targetHu) > tol * 2) continue
      mask[i] = 1
      ringVoxels += 1
    }
  }

  return {
    mask,
    accepted: accepted + ringVoxels,
    reachedLimit,
    seedAccepted: mask[seed] === 1,
    budgetUsed: gradRef,
  }
}

/** Parameter kontur aktif (geodesic active contour diskrit). */
export type IchContourParams = {
  /** Bobot suku data: makin besar, makin ketat mask mengikuti model HU jaringan. */
  dataWeight?: number
  /** Bobot suku panjang/tepi (geodesic): makin besar, makin "lengket" ke tepi anatomi. */
  lengthWeight?: number
  /** Dorongan keluar (balloon). 0 = hanya membentuk/menyusut, > 0 = boleh melebar ke tepi. */
  balloon?: number
  /** sigmaHU = simpangan baku jaringan (kali sigma di titik semai, minimum 8 HU). */
  sigmaScale?: number
  /** Menimpa sigmaHU langsung (HU). */
  sigmaHu?: number
  /** Dinding keras: voxel dengan |HU - target| > hardWallSigma * sigmaHu tidak pernah masuk mask. */
  hardWallSigma?: number
  /** Batas HU absolut yang boleh masuk mask (menimpa perhitungan sigma). Dinding bisa asimetris:
   *  sisi hipodense harus ketat (jaringan otak ~30-45 HU), sisi hiperdense longgar (inti perdarahan pekat). */
  minHu?: number
  maxHu?: number
  /** Batas HU lebar (kali sigmaHu) di sisi bawah/atas; dipakai kalau minHu/maxHu tidak diberi. */
  wallLowSigma?: number
  wallHighSigma?: number
  /** Sapuan maksimum ICM. */
  iterations?: number
  /** Lebar pita sempit dari batas awal (px). 0 = seluruh ROI. */
  bandWidthPx?: number
  /** Radius cakram untuk estimasi median HU jaringan (lihat `sampleRobustTissueHu`). */
  targetRadius?: number
  /** Sertakan tetangga diagonal (antarmuka lebih halus, tidak bergerigi). */
  diagonal?: boolean
  /** Menimpa skala gradien (nilai gradien yang dianggap "tepi kuat"). */
  gradScale?: number
  /** Ketajaman penarik tepi: 1 = 1/(1+r), makin besar makin hanya tepi kuat yang murah. */
  ridgeSharpness?: number
}

export type IchContourResult = {
  mask: Uint8Array
  flips: number
  iterations: number
  energyBefore: number
  energyAfter: number
  sigmaHu: number
  gradScale: number
}

/**
 * Pita sempit di sekitar batas mask: voxel yang jaraknya <= width dari batas
 * (ke dalam maupun ke luar). Dipakai supaya kontur hanya boleh menggeser batas
 * beberapa piksel, jadi pertumbuhan tidak bisa lari ke seluruh jaringan.
 */
export function buildNarrowBand(mask: Uint8Array, w: number, h: number, width: number): Uint8Array {
  const band = new Uint8Array(w * h)
  let front: number[] = []
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      const own = mask[i]
      const isEdge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        mask[i - 1] !== own || mask[i + 1] !== own || mask[i - w] !== own || mask[i + w] !== own
      if (!isEdge) continue
      band[i] = 1
      front.push(i)
    }
  }
  for (let step = 1; step < width; step += 1) {
    const next: number[] = []
    for (let k = 0; k < front.length; k += 1) {
      const i = front[k]
      const x = i % w, y = (i - x) / w
      if (x > 0 && !band[i - 1]) { band[i - 1] = 1; next.push(i - 1) }
      if (x < w - 1 && !band[i + 1]) { band[i + 1] = 1; next.push(i + 1) }
      if (y > 0 && !band[i - w]) { band[i - w] = 1; next.push(i - w) }
      if (y < h - 1 && !band[i + w]) { band[i + w] = 1; next.push(i + w) }
    }
    front = next
  }
  return band
}

/**
 * Kontur aktif geodesic (GAC) versi diskrit, dijalankan sebagai minimisasi
 * energi Potts dengan penurunan lokal (ICM) pada seluruh ROI atau pita sempit.
 *
 *   E = Σ_in ( I - μ )² / σ²  * λ_data    -> suku data: mask harus memuat
 *                                            jaringan yang HU-nya seperti semai
 *     - balloon * |in|                     -> dorongan melebar (opsional)
 *     + λ_len * Σ_antarmuka g( |∇I| )      -> suku geodesic: antarmuka murah di
 *                                            tepi anatomi kuat, mahal di jaringan datar
 *     g(r) = ( 1 / (1 + r²) )^sharpness,  r = |∇I| / gradScale
 *
 * Artinya: luas mask TIDAK lagi ditentukan radius drag atau anggaran biaya,
 * melainkan oleh keseimbangan "cocok dengan jaringan" vs "batas serapat mungkin
 * menempel di tepi". Suku panjang inilah yang menggantikan kurvatur: ia menutup
 * celah tepi dan menghaluskan gerigi tanpa menambah luas.
 *
 * ICM memakai keputusan flip per voxel; karena bentuknya Potts, setiap langkah
 * yang diterima selalu menurunkan energi (tidak divergen).
 */
export function activeContourRefine(
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  initialMask: Uint8Array,
  seedX: number,
  seedY: number,
  targetHu: number,
  sigmaHu: number,
  maxRadiusPx: number,
  params: IchContourParams = {},
): IchContourResult {
  const {
    dataWeight = 0.5,
    lengthWeight = 2,
    balloon = 0,
    hardWallSigma = 2.5,
    iterations = 30,
    bandWidthPx = 6,
    diagonal = true,
    gradScale,
    ridgeSharpness = 1,
    wallLowSigma,
    wallHighSigma,
  } = params

  const wallLow = params.minHu ?? targetHu - (wallLowSigma ?? hardWallSigma) * sigmaHu
  const wallHigh = params.maxHu ?? targetHu + (wallHighSigma ?? hardWallSigma) * sigmaHu

  const sigma = Math.max(1e-3, sigmaHu)
  const gradRef = Math.max(
    8,
    gradScale ?? percentile(collectLocalGradients(grad, w, h, seedX, seedY, Math.min(80, Math.max(24, maxRadiusPx))), 0.9),
  )
  // Bobot tepi g: 1 di jaringan datar, mendekati 0 di tepi anatomi kuat.
  const gw = new Float32Array(w * h)
  for (let i = 0; i < gw.length; i += 1) {
    const r = grad[i] / gradRef
    gw[i] = Math.pow(1 / (1 + r * r), ridgeSharpness)
  }

  const FORBIDDEN = 1e6
  const r2 = maxRadiusPx * maxRadiusPx
  const dataCost = new Float32Array(w * h)
  const allowed = new Uint8Array(w * h)
  const band = bandWidthPx > 0 ? buildNarrowBand(initialMask, w, h, bandWidthPx) : null
  const candidates: number[] = []
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      const dx = x - seedX, dy = y - seedY
      if (dx * dx + dy * dy > r2) { dataCost[i] = FORBIDDEN; continue }
      if (hu[i] < wallLow || hu[i] > wallHigh) { dataCost[i] = FORBIDDEN; continue }
      const z = Math.abs(hu[i] - targetHu) / sigma
      allowed[i] = 1
      dataCost[i] = dataWeight * Math.min(z * z, 6) - balloon
      if (!band || band[i]) candidates.push(i)
    }
  }

  const mask = new Uint8Array(initialMask)
  const seed = seedY * w + seedX
  if (!mask[seed]) mask[seed] = 1

  const DIAG = 1 / Math.SQRT2
  const offsets: Array<[number, number, number]> = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
  ]
  const useOffsets = diagonal ? offsets : offsets.slice(0, 4)

  const energyOf = () => {
    let e = 0
    for (let i = 0; i < mask.length; i += 1) if (mask[i]) e += allowed[i] ? dataCost[i] : FORBIDDEN
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (x < w - 1 && mask[i] !== mask[i + 1]) e += lengthWeight * ((gw[i] + gw[i + 1]) / 2)
        if (y < h - 1 && mask[i] !== mask[i + w]) e += lengthWeight * ((gw[i] + gw[i + w]) / 2)
        if (diagonal) {
          if (x < w - 1 && y < h - 1) {
            const j = i + w + 1
            if (mask[i] !== mask[j]) e += lengthWeight * DIAG * ((gw[i] + gw[j]) / 2)
          }
          if (x < w - 1 && y > 0) {
            const j = i - w + 1
            if (mask[i] !== mask[j]) e += lengthWeight * DIAG * ((gw[i] + gw[j]) / 2)
          }
        }
      }
    }
    return e
  }

  const energyBefore = energyOf()
  let flips = 0
  let used = 0

  for (let it = 0; it < iterations; it += 1) {
    used = it + 1
    let changed = 0
    for (let pass = 0; pass < 2; pass += 1) {
      const forward = pass === 0
      for (let c = 0; c < candidates.length; c += 1) {
        const idx = forward ? candidates[c] : candidates[candidates.length - 1 - c]
        if (idx === seed) continue
        const x = idx % w
        const y = (idx - x) / w
        const gp = gw[idx]
        let s = 0
        for (let k = 0; k < useOffsets.length; k += 1) {
          const [ox, oy, geom] = useOffsets[k]
          const nx = x + ox, ny = y + oy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const nIdx = ny * w + nx
          // Tetangga yang tidak boleh masuk mask dan memang di luar tidak
          // dihitung: kalau dihitung, ROI dinding HU palsu akan menyusutkan mask.
          if (!allowed[nIdx] && !mask[nIdx]) continue
          s += lengthWeight * geom * ((gp + gw[nIdx]) / 2) * (mask[nIdx] ? 1 : -1)
        }
        const d = allowed[idx] ? dataCost[idx] : FORBIDDEN
        if (mask[idx]) {
          if (s < d) { mask[idx] = 0; changed += 1 }
        } else if (s > d) {
          mask[idx] = 1; changed += 1
        }
      }
    }
    flips += changed
    if (!changed) break
  }

  return {
    mask,
    flips,
    iterations: used,
    energyBefore,
    energyAfter: energyOf(),
    sigmaHu: sigma,
    gradScale: gradRef,
  }
}

/**
 * Haluskan mask: buka lalu tutup morfologi (SE silang 3x3) sebanyak `passes`.
 * Buka membuang tonjolan tipis (spikula) setebal <= passes px, tutup mengisi
 * lekukan/celah sempit. Bentuk cembung (lesi bulat) tidak berubah - yang hilang
 * hanya gerigi hasil keputusan per-voxel, jadi luas tidak bergeser jauh.
 */
export function smoothMaskMorphology(
  mask: Uint8Array,
  w: number,
  h: number,
  passes = 1,
): { removed: number; filled: number } {
  if (passes <= 0) return { removed: 0, filled: 0 }
  const before = new Uint8Array(mask)
  const bufA = new Uint8Array(mask)
  const bufB = new Uint8Array(w * h)
  const apply = (src: Uint8Array, dst: Uint8Array, dilate: boolean) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { dst[i] = src[i]; continue }
        const up = src[i - w], down = src[i + w], left = src[i - 1], right = src[i + 1]
        dst[i] = dilate
          ? (up || down || left || right ? 1 : 0)
          : (up && down && left && right ? 1 : 0)
      }
    }
  }
  // Buffer ditukar setiap pass: tanpa itu, pass ke-2 membaca buffer yang sama dan
  // hasilnya identik dengan pass ke-1 (roda-2 morfologi tidak pernah terjadi).
  let src: Uint8Array = bufA
  let dst: Uint8Array = bufB
  const step = (dilate: boolean) => {
    apply(src, dst, dilate)
    const t = src
    src = dst
    dst = t
  }
  for (let p = 0; p < passes; p += 1) step(false) // buka: erosi
  for (let p = 0; p < passes; p += 1) step(true)  // buka: dilatasi
  for (let p = 0; p < passes; p += 1) step(true)  // tutup: dilatasi
  for (let p = 0; p < passes; p += 1) step(false) // tutup: erosi
  mask.set(src)
  let removed = 0, filled = 0
  for (let i = 0; i < mask.length; i += 1) {
    if (before[i] && !mask[i]) removed += 1
    if (!before[i] && mask[i]) filled += 1
  }
  return { removed, filled }
}

/** Daftar voxel yang bersinggungan dengan latar (batas mask). */
export function getBoundaryIndices(mask: Uint8Array, w: number, h: number): Int32Array {
  const out: number[] = []
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      if (!mask[i]) continue
      const isBoundary =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]
      if (isBoundary) out.push(i)
    }
  }
  return Int32Array.from(out)
}

/**
 * Selaraskan batas mask ke puncak gradien lokal: tiap voxel batas dicari
 * penggantinya dalam radius 2 piksel sepanjang arah normal (taksiran dari
 * selisih centroid lokal), dan pindah hanya bila HU-nya masih masuk akal.
 * Ini yang menajamkan "garis tepi" tanpa menambah/mengurangi luas secara liar.
 */
export function snapBoundaryToEdges(
  mask: Uint8Array,
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  targetHu: number,
  toleranceHu: number,
  searchRadius = 2,
): number {
  const boundary = getBoundaryIndices(mask, w, h)
  let moved = 0
  const huLo = targetHu - toleranceHu * 2.5
  const huHi = targetHu + toleranceHu * 2.5
  const additions: number[] = []
  const removals: number[] = []

  for (let b = 0; b < boundary.length; b += 1) {
    const idx = boundary[b]
    const x = idx % w
    const y = (idx - x) / w
    const own = grad[idx]
    let bestIdx = idx
    let bestGrad = own
    for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
      for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
        if (!dx && !dy) continue
        const nx = x + dx, ny = y + dy
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
        const nIdx = ny * w + nx
        if (mask[nIdx]) continue
        const huOk = hu[nIdx] >= huLo && hu[nIdx] <= huHi
        if (!huOk) continue
        const g = grad[nIdx]
        if (g > bestGrad * 1.15) { bestGrad = g; bestIdx = nIdx }
      }
    }
    if (bestIdx !== idx) { additions.push(bestIdx); removals.push(idx) }
  }
  // Penghapusan hanya untuk voxel yang pindah; penambahan selalu di tepi.
  for (const i of removals) mask[i] = 0
  for (const i of additions) { mask[i] = 1; moved += 1 }
  return moved
}

/**
 * Bersihkan mask: isi lubang 1 voxel, buang tonjolan/jembatan tipis, dan
 * (opsional) buang voxel yang tidak didukung tetangga di slice sebelah.
 * Semua keputusan dijalankan pada salinan supaya bisa dihitung berapa yang
 * berubah.
 */
export function cleanIchMask(
  mask: Uint8Array,
  w: number,
  h: number,
  options: { allowThinRemoval?: boolean; neighbourMask?: Uint8Array | null } = {},
): { holesFilled: number; thinVoxelsRemoved: number } {
  const { allowThinRemoval = true, neighbourMask = null } = options
  let holesFilled = 0
  let thinVoxelsRemoved = 0

  // 1) isi lubang: latar yang seluruh 8 tetangganya mask -> jadi mask.
  const fill: number[] = []
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      if (mask[i]) continue
      let all = true
      for (let dy = -1; dy <= 1 && all; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue
          if (!mask[i + dy * w + dx]) { all = false; break }
        }
      }
      if (all) fill.push(i)
    }
  }
  for (const i of fill) mask[i] = 1
  holesFilled = fill.length

  // 2) buang voxel "tipis": voxel mask yang tetangga 4-nya <= 1 dan bukan
  //    bagian dari struktur padat (dicek dua kali untuk stabilitas).
  if (allowThinRemoval) {
    for (let pass = 0; pass < 2; pass += 1) {
      const drop: number[] = []
      for (let y = 1; y < h - 1; y += 1) {
        for (let x = 1; x < w - 1; x += 1) {
          const i = y * w + x
          if (!mask[i]) continue
          let n = 0
          if (mask[i - 1]) n += 1
          if (mask[i + 1]) n += 1
          if (mask[i - w]) n += 1
          if (mask[i + w]) n += 1
          if (n <= 1) drop.push(i)
        }
      }
      if (!drop.length) break
      for (const i of drop) mask[i] = 0
      thinVoxelsRemoved += drop.length
    }
  }

  // 3) dukungan antar-slice: voxel yang tidak punya tetangga di slice sebelah
  //    biasanya kebocoran satu slice. Hanya dibuang kalau mask tetangga ada.
  if (neighbourMask) {
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i]) continue
      const x = i % w
      const y = (i - x) / w
      let support = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          if (neighbourMask[ny * w + nx]) { support += 1; break }
        }
        if (support) break
      }
      if (!support) { mask[i] = 0; thinVoxelsRemoved += 1 }
    }
  }

  return { holesFilled, thinVoxelsRemoved }
}

/** Hitung statistik mutu mask: energi tepi di batas, lubang, dan kebocoran. */
export function analyzeIchMask(
  mask: Uint8Array,
  hu: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  targetHu: number,
  toleranceHu: number,
  maxRadiusPx: number,
  seedX: number,
  seedY: number,
): Omit<IchRefineStats, 'voxelCount' | 'holesFilled' | 'thinVoxelsRemoved' | 'snappedVoxels' | 'sigmaHu' | 'contourFlips' | 'contourIterations' | 'contourEnergyBefore' | 'contourEnergyAfter' | 'morphRemoved' | 'morphFilled' | 'guard'> {
  const boundary = getBoundaryIndices(mask, w, h)
  let boundaryGrad = 0
  for (let b = 0; b < boundary.length; b += 1) boundaryGrad += grad[boundary[b]]
  const boundaryMeanGradient = boundary.length ? boundaryGrad / boundary.length : 0

  // Pembanding jujur: energi tepi pada latar di dalam radius yang sama.
  let bgSum = 0, bgCount = 0, leaks = 0
  const r2 = maxRadiusPx * maxRadiusPx
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - seedX, dy = y - seedY
      if (dx * dx + dy * dy > r2) continue
      const i = y * w + x
      if (mask[i]) {
        const huOut = hu[i] < targetHu - toleranceHu * 2.5 || hu[i] > targetHu + toleranceHu * 2.5
        if (huOut) leaks += 1
        continue
      }
      bgSum += grad[i]
      bgCount += 1
    }
  }
  const backgroundMeanGradient = bgCount ? bgSum / bgCount : 0
  const edgeAlignment = backgroundMeanGradient > 0 ? boundaryMeanGradient / backgroundMeanGradient : 0

  return { boundaryVoxels: boundary.length, boundaryMeanGradient, backgroundMeanGradient, edgeAlignment, leaks }
}

/** Orkestrator: ambil mask operator, hasilkan mask yang tepinya menempel anatomi. */
export function refineIchMask(
  hu: Float32Array,
  operatorMask: Uint8Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  options: Partial<IchRefineOptions> = {},
): { mask: Uint8Array; stats: IchRefineStats } {
  const local = sampleDiscHu(hu, w, h, seedX, seedY, 3)
  const cp = options.contour ?? {}
  const robust = sampleRobustTissueHu(hu, w, h, seedX, seedY, { targetRadius: cp.targetRadius ?? 12 })
  const targetHu = options.targetHu ?? robust.median
  const toleranceHu = options.toleranceHu ?? clamp(Math.max(12, local.stdDev * 2.5 + 6), 12, 45)
  const maxRadiusPx = options.maxRadiusPx ?? 120
  const grad = computeGradientMagnitude(hu, w, h)
  const useContour = options.useActiveContour ?? false
  const sigmaHu = cp.sigmaHu ?? clamp(robust.sigma * (cp.sigmaScale ?? 1.2), 8, 40)
  // Dinding HU asimetris: sisi hipodense ketat (jaringan otak isodens tidak boleh
  // ikut - terukur: dinding simetris 2.5 sigma membuat mask bocor ke seluruh
  // jaringan pada radius drag besar di slice yang tepinya halus), sisi hiperdense
  // longgar supaya inti perdarahan yang pekat tidak berlubang.
  const wallLowSigma = cp.wallLowSigma ?? 1.2
  const wallHighSigma = cp.wallHighSigma ?? 3
  const minHu = cp.minHu ?? targetHu - wallLowSigma * sigmaHu
  const maxHu = cp.maxHu ?? targetHu + wallHighSigma * sigmaHu

  const hasOperatorMask = operatorMask.some((v) => v > 0)
  const growOptions = {
    targetHu,
    toleranceHu,
    maxRadiusPx,
    maxVoxels: options.maxVoxels,
    edgeWeight: options.edgeWeight,
    huWeight: options.huWeight,
    // Tanpa kontur aktif, yang membatasi luas adalah anggaran biaya (perilaku lama).
    // Dengan kontur aktif, wilayah awal dibuat "seluas yang masih jelas jaringan
    // sasaran" (dinding HU), lalu kontur yang memindahkan batasnya ke tepi anatomi.
    budget: useContour ? maxRadiusPx * maxRadiusPx + 1 : options.budget,
    huWallFactor: options.huWallFactor,
    minHu: useContour ? minHu : options.minHu,
    maxHu: useContour ? maxHu : options.maxHu,
    ridgePercentile: options.ridgePercentile,
    // Niat operator dihormati: coretannya jadi titik semai, jadi yang berubah
    // hanya PERLUASAN-nya (berhenti di tepi anatomi, bukan di ambang HU).
    seedMask: hasOperatorMask ? operatorMask : null,
  }
  const grownMask = options.useRidgeWall
    ? ridgeBoundedGrow(hu, grad, w, h, seedX, seedY, growOptions).mask
    : geodesicGrow(hu, grad, w, h, seedX, seedY, growOptions).mask

  const inputCount = countMaskVoxels(operatorMask)
  let guard: string | null = null
  let combined = grownMask
  let contour: IchContourResult | null = null
  if (useContour) {
    // PENJAGA (terukur, penting). Kontur aktif memakai model jaringan dari titik
    // semai. Kalau titik semai TIDAK di perdarahan (mis. centroid mask di slice
    // tepi jatuh di jaringan otak ~40 HU, atau coretan operator meleset), modelnya
    // jadi 40 HU, isinya membanjiri seluruh ROI dan mask hancur: pada data dev
    // terukur 12 slice meledak 100-14000% (131 px -> 18.537 px). Karena itu:
    //  - jaringan sasaran harus hiperdense (median >= 50 HU), dan
    //  - hasil tidak boleh melebar > 4x (atau +2500 voxel) maupun menyusut < 50%
    //    dari mask masukan operator.
    // Bila salah satu tidak terpenuhi, mask masukan dikembalikan apa adanya.
    const targetPlausible = robust.median >= ICH_REFINE_MIN_TARGET_HU
    if (!targetPlausible) {
      guard = `target-tidak-hiperdense (${robust.median.toFixed(0)} HU)`
    } else {
      contour = activeContourRefine(hu, grad, w, h, combined, seedX, seedY, targetHu, sigmaHu, maxRadiusPx,
        { ...cp, minHu, maxHu })
      combined = contour.mask
      if (inputCount > 0) {
        const outCount = countMaskVoxels(combined)
        const grewTooMuch = outCount > Math.max(ICH_REFINE_MAX_GROW_FACTOR * inputCount, inputCount + ICH_REFINE_MAX_EXTRA_VOXELS)
        const shrankTooMuch = outCount < ICH_REFINE_MIN_REMAIN_FACTOR * inputCount
        if (grewTooMuch || shrankTooMuch) {
          guard = grewTooMuch
            ? `melebar ${(outCount / inputCount).toFixed(1)}x dari mask masukan`
            : `menyusut ke ${((outCount / inputCount) * 100).toFixed(0)}% dari mask masukan`
        }
      }
    }

    if (guard) {
      combined = inputCount > 0 ? Uint8Array.from(operatorMask) : grownMask
      contour = null
    }
  }
  // Snap menggeser tiap voxel batas sendiri-sendiri ke puncak gradien terdekat.
  // Itu menajamkan garis tepi pada mask hasil banjir, tetapi pada mask kontur
  // (batasnya sudah di tepi anatomi) justru menambah spikula dan lubang kecil -
  // terukur: 189 dari 385 voxel batas bergeser, compactness 5.2 vs 1.4.
  const snapEnabled = (options.useSnapToEdges ?? !useContour) && !guard
  const snappedVoxels = snapEnabled ? snapBoundaryToEdges(combined, hu, grad, w, h, targetHu, toleranceHu) : 0
  let morphRemoved = 0
  let morphFilled = 0
  if (options.smoothPasses && options.smoothPasses > 0 && !guard) {
    const before = new Uint8Array(combined)
    const beforeCount = countMaskVoxels(before)
    const s = smoothMaskMorphology(combined, w, h, options.smoothPasses)
    // Penghalusan tidak boleh menggerus mask tipis (slice ujung lesi hanya 1-2 px
    // tebal, opening bisa menghapusnya): kalau hilangnya > setengah, batalkan.
    const afterCount = countMaskVoxels(combined)
    if (beforeCount > 0 && afterCount < ICH_REFINE_MIN_REMAIN_FACTOR * beforeCount) {
      combined = before
    } else {
      morphRemoved = s.removed
      morphFilled = s.filled
    }
  }
  const cleaned = cleanIchMask(combined, w, h, { allowThinRemoval: true })

  let voxelCount = 0
  for (let i = 0; i < combined.length; i += 1) if (combined[i]) voxelCount += 1
  void 0
  const stats: IchRefineStats = {
    voxelCount,
    ...analyzeIchMask(combined, hu, grad, w, h, targetHu, toleranceHu, maxRadiusPx, seedX, seedY),
    snappedVoxels,
    ...cleaned,
    sigmaHu,
    contourFlips: contour ? contour.flips : 0,
    contourIterations: contour ? contour.iterations : 0,
    contourEnergyBefore: contour ? contour.energyBefore : 0,
    contourEnergyAfter: contour ? contour.energyAfter : 0,
    morphRemoved,
    morphFilled,
    guard,
  }
  return { mask: combined, stats }
}

/**
 * ============================================================================
 * DETEKSI ADAPTIF HU + TEPI (menggantikan ambang toleransi tetap)
 * ============================================================================
 * Masalah yang diperbaiki (keluhan operator: "garis tepi belum peka dengan HU
 * sekitar"): perilaku lama memakai banjir `[seedHu ± tol]` dengan `tol` tetap
 * (14..42) dan satu ambang gradien untuk seluruh citra. Akibatnya batas mask
 * ditentukan angka tetap itu, bukan oleh perbedaan HU antara lesi dan jaringan
 * di sekitarnya — di slice di mana jaringan sekitar lebih terang/gelap, mask
 * melebar atau mengerut tanpa alasan anatomis.
 *
 * Cara baru:
 * 1. Dinding HU DITURUNKAN DARI UKURAN LOKAL: cakram inti (r≈6) memberi HU lesi
 *    (median mC, sigma sC), cincin latar (14..24 px) memberi HU sekeliling
 *    (median mB, sigma sB dari IQR). Dinding bawah = titik tengah kontras
 *    (mB + 0.5*(mC-mB)), dijepit oleh bantalan noise 1.5*sB dan aturan agar inti
 *    lesi tetap masuk. Jadi kalau sekelilingnya 30 HU, dinding turun; kalau 45 HU,
 *    dinding naik — persis yang diminta.
 * 2. Kontras lemah (mC-mB < 8 HU, ciri slice ujung lesi): dinding bawah
 *    dilonggarkan (mB + 0.25*kontras) supaya ujung lesi tipis tidak hilang.
 * 3. Penghenti tepi dinormalkan LOKAL di sekitar titik semai (P90 gradien lokal,
 *    bukan P95 seluruh citra — pelajaran terukur sebelumnya), dan hanya
 *    menghentikan banjir kalau voxel itu HU-nya sudah dekat latar. Tepi di dalam
 *    lesi (septa) tidak memblokir.
 * 4. Pertumbuhan pakai Dijkstra (heap) dengan biaya jarak-HU + bobot tepi,
 *    TANPA anggaran biaya sebagai penentu batas (pelajaran: anggaran selalu
 *    membuat luas ∝ anggaran, bukan ∝ anatomi). Pengaman hanya maxVoxels /
 *    maxRadiusPx.
 * 5. Dukungan lintas-slice (opsional): voxel yang hanya muncul di satu slice
 *    (derau) dibuang kalau tidak didukung slice tetangga.
 */
export type AdaptiveGrowOptions = {
  /** Radius cakram inti lesi untuk statistik HU (default 6). */
  coreRadiusPx?: number
  /** Cincin latar: radius dalam (default 14). */
  bgInnerPx?: number
  /** Cincin latar: radius luar (default 24). */
  bgOuterPx?: number
  /** Bobot suku tepi pada biaya (0 = murni HU). Default 0.6. */
  edgeWeight?: number
  /** Persentil gradien lokal untuk normalisasi (default 0.9). */
  localGradPercentile?: number
  /** Tepi dianggap kuat kalau |grad| >= ratio x P90 lokal (default 1.0). */
  strongEdgeRatio?: number
  /** Skala jarak-HU; 0 = otomatis dari sigma inti (default 0). */
  huScale?: number
  /** Pengaman jumlah voxel (default 200000). */
  maxVoxels?: number
  /** Pengaman radius dari titik semai (default 320 px). */
  maxRadiusPx?: number
  /** Mask slice tetangga (hasil fungsi ini) untuk saringan dukungan. */
  neighbourMasks?: Array<Uint8Array | null | undefined>
  /** Jumlah minimum dukungan tetangga agar voxel dipertahankan (default 1). */
  minNeighbourSupport?: number
}

export type AdaptiveGrowResult = {
  mask: Uint8Array
  coreHu: number
  backgroundHu: number
  coreSigma: number
  backgroundSigma: number
  contrastHu: number
  lowWallHu: number
  highWallHu: number
  edgeScale: number
  voxels: number
  reachedLimit: boolean
  weakContrast: boolean
  removedByNeighbourSupport: number
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** Heap biner untuk pertumbuhan Dijkstra; indeks & kunci sama-sama Float64. */
class GrowHeap {
  private indices: Float64Array
  private keys: Float64Array
  private count = 0

  constructor(capacity: number) {
    this.indices = new Float64Array(Math.max(1, capacity))
    this.keys = new Float64Array(Math.max(1, capacity))
  }

  get size() {
    return this.count
  }

  push(index: number, key: number) {
    if (this.count >= this.indices.length) return
    this.indices[this.count] = index
    this.keys[this.count] = key
    this.count += 1
    let i = this.count - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] <= this.keys[i]) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): { index: number; key: number } | null {
    if (this.count === 0) return null
    const index = this.indices[0]
    const key = this.keys[0]
    this.count -= 1
    if (this.count > 0) {
      this.indices[0] = this.indices[this.count]
      this.keys[0] = this.keys[this.count]
      let i = 0
      while (true) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < this.count && this.keys[left] < this.keys[smallest]) smallest = left
        if (right < this.count && this.keys[right] < this.keys[smallest]) smallest = right
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return { index, key }
  }

  private swap(a: number, b: number) {
    const index = this.indices[a]
    this.indices[a] = this.indices[b]
    this.indices[b] = index
    const key = this.keys[a]
    this.keys[a] = this.keys[b]
    this.keys[b] = key
  }
}

/** Statistik cincin latar: median + sigma kokoh dari IQR, udara & tulang disaring. */
export function sampleAnnulusHu(
  hu: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  innerPx: number,
  outerPx: number,
  options: { ignoreBelowHu?: number; ignoreAboveHu?: number } = {},
) {
  const inner2 = innerPx * innerPx
  const outer2 = outerPx * outerPx
  const ignoreBelow = options.ignoreBelowHu ?? -200
  const ignoreAbove = options.ignoreAboveHu ?? 200
  const values: number[] = []
  for (let y = Math.max(0, cy - outerPx); y <= Math.min(h - 1, cy + outerPx); y += 1) {
    for (let x = Math.max(0, cx - outerPx); x <= Math.min(w - 1, cx + outerPx); x += 1) {
      const dx = x - cx
      const dy = y - cy
      const d2 = dx * dx + dy * dy
      if (d2 < inner2 || d2 > outer2) continue
      const value = hu[y * w + x]
      if (!Number.isFinite(value)) continue
      if (value <= ignoreBelow || value >= ignoreAbove) continue
      values.push(value)
    }
  }
  if (values.length < 8) {
    return { median: Number.NaN, sigma: Number.NaN, count: values.length, q25: Number.NaN, q75: Number.NaN }
  }
  values.sort((a, b) => a - b)
  const at = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))]
  const q25 = at(0.25)
  const q75 = at(0.75)
  return {
    median: at(0.5),
    sigma: Math.max(3, (q75 - q25) / 1.349),
    count: values.length,
    q25,
    q75,
  }
}

/** Statistik HU pada cincin DI LUAR mask (jarak d_min..d_max px dari mask). */
export function ringStatsOutsideMask(
  hu: Float32Array,
  w: number,
  h: number,
  mask: Uint8Array,
  options: { innerPx?: number; outerPx?: number; ignoreBelowHu?: number; ignoreAboveHu?: number } = {},
) {
  const innerPx = Math.max(1, Math.round(options.innerPx ?? 3))
  const outerPx = Math.max(innerPx + 1, Math.round(options.outerPx ?? 10))
  const ignoreBelow = options.ignoreBelowHu ?? -200
  const ignoreAbove = options.ignoreAboveHu ?? 200
  const distance = new Float32Array(w * h).fill(Number.POSITIVE_INFINITY)
  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue
    distance[index] = 0
    queue[tail] = index
    tail += 1
  }
  while (head < tail) {
    const index = queue[head]
    head += 1
    const x = index % w
    const y = (index - x) / w
    const next = distance[index] + 1
    if (next > outerPx) continue
    const push = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
      const at = ny * w + nx
      if (distance[at] <= next) return
      distance[at] = next
      queue[tail] = at
      tail += 1
    }
    push(x - 1, y)
    push(x + 1, y)
    push(x, y - 1)
    push(x, y + 1)
  }
  const values: number[] = []
  for (let index = 0; index < mask.length; index += 1) {
    if (distance[index] < innerPx || distance[index] > outerPx) continue
    const value = hu[index]
    if (!Number.isFinite(value) || value <= ignoreBelow || value >= ignoreAbove) continue
    values.push(value)
  }
  if (values.length < 8) {
    return { median: Number.NaN, sigma: Number.NaN, count: values.length }
  }
  values.sort((a, b) => a - b)
  const at = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))]
  return {
    median: at(0.5),
    sigma: Math.max(3, (at(0.75) - at(0.25)) / 1.349),
    count: values.length,
  }
}

/** Banjir kasar (tanpa gerbang tepi) untuk mengetahui luas perkiraan lesi. */
function coarseFlood(
  hu: Float32Array,
  w: number,
  h: number,
  seedIdx: number,
  low: number,
  high: number,
  maxRadiusPx: number,
) {
  const mask = new Uint8Array(w * h)
  const seedX = seedIdx % w
  const seedY = (seedIdx - seedX) / w
  const stack = [seedIdx]
  const r2 = maxRadiusPx * maxRadiusPx
  while (stack.length) {
    const index = stack.pop() as number
    if (mask[index]) continue
    const value = hu[index]
    if (!Number.isFinite(value) || value < low || value > high) continue
    const x = index % w
    const y = (index - x) / w
    const dx = x - seedX
    const dy = y - seedY
    if (dx * dx + dy * dy > r2) continue
    mask[index] = 1
    if (x > 0) stack.push(index - 1)
    if (x < w - 1) stack.push(index + 1)
    if (y > 0) stack.push(index - w)
    if (y < h - 1) stack.push(index + w)
  }
  return mask
}

/** Voxel semai yang aman: kalau voxel di titik klik tidak masuk band, cari yang terdekat. */
function resolveSeedIndex(hu: Float32Array, w: number, h: number, seedX: number, seedY: number, low: number, high: number) {
  const seedIdx = seedY * w + seedX
  const fits = (index: number) => {
    const value = hu[index]
    return Number.isFinite(value) && value >= low && value <= high
  }
  if (fits(seedIdx)) return seedIdx
  let best = -1
  let bestValue = Number.NEGATIVE_INFINITY
  for (let radius = 1; radius <= 6; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const x = seedX + dx
        const y = seedY + dy
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const index = y * w + x
        if (!fits(index)) continue
        if (hu[index] > bestValue) {
          bestValue = hu[index]
          best = index
        }
      }
    }
    if (best >= 0) return best
  }
  return -1
}

/** Isi lubang latar tertutup (tidak terhubung ke tepi citra) sampai maxHolePx voxel. */
export function fillEnclosedBackgroundHoles(
  mask: Uint8Array,
  w: number,
  h: number,
  maxHolePx = 400,
) {
  const visited = new Uint8Array(w * h)
  let filled = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] || visited[start]) continue
    const component: number[] = []
    const stack = [start]
    let touchesBorder = false
    visited[start] = 1
    while (stack.length) {
      const index = stack.pop() as number
      component.push(index)
      const x = index % w
      const y = (index - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true
      const visit = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
        const at = ny * w + nx
        if (mask[at] || visited[at]) return
        visited[at] = 1
        stack.push(at)
      }
      visit(x - 1, y)
      visit(x + 1, y)
      visit(x, y - 1)
      visit(x, y + 1)
    }
    if (touchesBorder || component.length > maxHolePx) continue
    component.forEach((index) => {
      mask[index] = 1
    })
    filled += component.length
  }
  return filled
}

export function adaptiveHuEdgeGrow(
  hu: Float32Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  options: AdaptiveGrowOptions = {},
): AdaptiveGrowResult {
  const coreRadiusPx = Math.max(3, Math.round(options.coreRadiusPx ?? 6))
  const bgInnerPx = Math.max(2, Math.round(options.bgInnerPx ?? 3))
  const bgOuterPx = Math.max(bgInnerPx + 2, Math.round(options.bgOuterPx ?? 10))
  const coarseRadiusPx = Math.max(20, Math.round(options.maxRadiusPx ?? 320) > 120 ? 70 : 40)
  const edgeWeight = Math.max(0, options.edgeWeight ?? 0.6)
  const gradQ = clampValue(options.localGradPercentile ?? 0.9, 0.5, 0.99)
  const strongEdgeRatio = Math.max(0.2, options.strongEdgeRatio ?? 1.25)
  const maxVoxels = Math.max(1000, options.maxVoxels ?? 200000)
  const maxRadiusPx = Math.max(24, options.maxRadiusPx ?? 320)
  const minNeighbourSupport = Math.max(0, Math.round(options.minNeighbourSupport ?? 1))
  const neighbours = (options.neighbourMasks ?? []).filter(Boolean) as Uint8Array[]

  const seedIdx = seedY * w + seedX
  const seedDisc = sampleDiscHu(hu, w, h, seedX, seedY, 3)
  const core = sampleRobustTissueHu(hu, w, h, seedX, seedY, {
    targetRadius: coreRadiusPx,
    sigmaRadius: 3,
  })
  const coreHu = core.median
  const coreSigma = Math.max(4, core.sigma)

  // --- Tahap 1: banjir kasar dengan toleransi (perilaku lama) hanya untuk mencari LUAS lesi.
  const coarseTolerance = clampValue(Math.max(14, seedDisc.stdDev * 3 + 10), 14, 42)
  const coarseLow = coreHu - coarseTolerance
  const coarseHigh = coreHu + Math.max(2 * coreSigma, 12)
  const coarse = coarseFlood(hu, w, h, seedIdx, coarseLow, coarseHigh, coarseRadiusPx)

  // --- Tahap 2: ukur HU SEKELILING lesi (cincin tepat di luar banjir kasar). Inilah inti
  // perubahan "peka terhadap HU sekitar": dinding diturunkan dari jaringan nyata di luar lesi,
  // bukan dari cincin radius tetap yang bisa jatuh di dalam lesi.
  const ring = ringStatsOutsideMask(hu, w, h, coarse, { innerPx: bgInnerPx, outerPx: bgOuterPx })
  const backgroundHu = Number.isFinite(ring.median) ? ring.median : coreHu - 20
  const backgroundSigma = Number.isFinite(ring.sigma) ? Math.max(3, ring.sigma) : 6
  const contrastHu = coreHu - backgroundHu
  const weakContrast = contrastHu < 8

  const floorWall = backgroundHu + Math.max(1.5 * backgroundSigma, 3)
  const ceilWall = coreHu - 0.4 * coreSigma
  const desiredWall = contrastHu > 8
    ? backgroundHu + 0.5 * contrastHu
    : backgroundHu + Math.max(1.5 * backgroundSigma, 0.3 * contrastHu)
  let lowWallHu = clampValue(desiredWall, Math.min(floorWall, ceilWall), ceilWall)
  const highWallHu = coreHu + Math.max(3 * coreSigma, 15)

  // Voxel semai tidak boleh hilang: kalau di titik klik di bawah dinding, turunkan dinding
  // sampai voxel itu masuk (operator menunjuk lesi, bukan jaringan).
  const seedHuValue = hu[seedIdx]
  if (Number.isFinite(seedHuValue) && seedHuValue < lowWallHu && seedHuValue > backgroundHu - 2 * backgroundSigma) {
    lowWallHu = seedHuValue
  }

  const huScale = options.huScale && options.huScale > 0 ? options.huScale : Math.max(6, 2 * coreSigma)
  const gradient = computeGradientMagnitude(hu, w, h)
  const localGradients = collectLocalGradients(gradient, w, h, seedX, seedY, Math.max(bgOuterPx * 3, 24))
  const edgeScale = Math.max(1, percentile(localGradients, gradQ))
  const maxRadius2 = maxRadiusPx * maxRadiusPx

  /** Pertumbuhan Dijkstra untuk dinding tertentu (dipakai dua iterasi). */
  const growInPlane = (lowWall: number, highWall: number) => {
    const strongEdgeHuHere = lowWall + 0.15 * Math.max(0, coreHu - lowWall)
    const planeMask = new Uint8Array(w * h)
    const dist = new Float64Array(w * h).fill(Number.POSITIVE_INFINITY)
    const heap = new GrowHeap(Math.min(w * h, 1 << 22))
    const fits = (index: number) => {
      const value = hu[index]
      return Number.isFinite(value) && value >= lowWall && value <= highWall
    }
    const start = resolveSeedIndex(hu, w, h, seedX, seedY, lowWall, highWall)
    let limitReached = false
    let voxelCount = 0
    if (start >= 0) {
      planeMask[start] = 1
      dist[start] = 0
      heap.push(start, 0)
      voxelCount = 1
    }
    while (true) {
      const top = heap.pop()
      if (!top) break
      const current = top.index
      if (top.key > dist[current]) continue
      const cx = current % w
      const cy = (current - cx) / w
      for (let step = 0; step < 4; step += 1) {
        const nx = cx + (step === 0 ? -1 : step === 1 ? 1 : 0)
        const ny = cy + (step === 2 ? -1 : step === 3 ? 1 : 0)
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const neighbour = ny * w + nx
        if (planeMask[neighbour] || !fits(neighbour)) continue
        const dx = nx - seedX
        const dy = ny - seedY
        if (dx * dx + dy * dy > maxRadius2) continue
        const value = hu[neighbour]
        const gradHere = gradient[neighbour] / edgeScale
        // Tepi kuat hanya memblokir kalau voxel itu HU-nya sudah mendekati latar:
        // tepi di dalam lesi (septa) tidak boleh memotong pertumbuhan.
        if (gradHere >= strongEdgeRatio && value < strongEdgeHuHere) continue
        if (voxelCount >= maxVoxels) {
          limitReached = true
          break
        }
        const cost = top.key + Math.abs(value - coreHu) / huScale + edgeWeight * (1 - Math.min(1, gradHere))
        if (cost < dist[neighbour]) {
          dist[neighbour] = cost
          planeMask[neighbour] = 1
          voxelCount += 1
          heap.push(neighbour, cost)
        }
      }
      if (limitReached) break
    }
    return { mask: planeMask, voxels: voxelCount, reachedLimit: limitReached }
  }

  // Dinding batas atas dijepit: HU > 100 di CT kepala hampir selalu tulang/kalsifikasi,
  // jadi lesi tidak boleh menyerapnya walau dinding dari sigma inti lebih tinggi.
  const highWallCapped = Math.min(highWallHu, Math.max(coreHu + 12, 100))
  const first = growInPlane(lowWallHu, highWallCapped)

  // --- Tahap 3: ukur ulang latar dari tepi mask hasil tahap 2 dan pertumbuhan final.
  // Ini yang memperbaiki slice dengan inti sangat padat: tahap 1 masih bisa berhenti di dalam
  // lesi, sehingga latarnya belum benar-benar jaringan sekitar.
  let finalLowWallHu = lowWallHu
  let finalMask = first.mask
  let finalVoxels = first.voxels
  let finalReachedLimit = first.reachedLimit
  if (first.voxels > 0) {
    const ring2 = ringStatsOutsideMask(hu, w, h, first.mask, { innerPx: bgInnerPx, outerPx: Math.max(bgOuterPx, 6) })
    if (Number.isFinite(ring2.median)) {
      const background2 = ring2.median
      const sigma2 = Number.isFinite(ring2.sigma) ? Math.max(3, ring2.sigma) : backgroundSigma
      const contrast2 = coreHu - background2
      const floor2 = background2 + Math.max(1.5 * sigma2, 3)
      const ceil2 = coreHu - 0.4 * coreSigma
      const desired2 = contrast2 > 8
        ? background2 + 0.5 * contrast2
        : background2 + Math.max(1.5 * sigma2, 0.3 * contrast2)
      const wall2 = clampValue(desired2, Math.min(floor2, ceil2), ceil2)
      // Dinding hanya boleh longgar ke bawah (menambah lesi), tidak menggerus hasil pertama
      // lebih dari 25% — melindungi slice ujung lesi.
      const candidate = Math.min(wall2, lowWallHu)
      const second = growInPlane(candidate, highWallCapped)
      const shrink = first.voxels > 0 ? second.voxels / first.voxels : 1
      if (second.voxels > 0 && shrink >= 0.75) {
        finalLowWallHu = candidate
        finalMask = second.mask
        finalVoxels = second.voxels
        finalReachedLimit = second.reachedLimit
      }
    }
  }

  const mask = finalMask
  let voxels = finalVoxels
  const reachedLimit = finalReachedLimit
  lowWallHu = finalLowWallHu
  const filledHoles = fillEnclosedBackgroundHoles(mask, w, h, 400)
  voxels += filledHoles
  smoothMaskMorphology(mask, w, h, 1)
  voxels = countMaskVoxels(mask)

  let removedByNeighbourSupport = 0
  if (neighbours.length > 0) {
    for (let index = 0; index < mask.length; index += 1) {
      if (!mask[index]) continue
      let support = 0
      for (let n = 0; n < neighbours.length; n += 1) {
        if (neighbours[n][index]) support += 1
      }
      if (support < minNeighbourSupport) {
        mask[index] = 0
        voxels -= 1
        removedByNeighbourSupport += 1
      }
    }
  }

  return {
    mask,
    coreHu,
    backgroundHu,
    coreSigma,
    backgroundSigma,
    contrastHu,
    lowWallHu,
    highWallHu,
    edgeScale,
    voxels,
    reachedLimit,
    weakContrast,
    removedByNeighbourSupport,
  }
}



