// Irregular urban footprint for the floating city island.
//
// There is NO official boundary asset (e.g. GHMC limits) in the processed
// data, so the island outline is DERIVED from the shipped OSM density —
// building footprint area, road length, park and water coverage — rasterised
// over the data window and contoured. This is a data-grounded study-area
// silhouette, NOT an administrative boundary, and must never be presented as
// one.
//
// Derivation pipeline (runs once per dataset load, memoised upstream):
//   1. Rasterise building area / road length / park+water coverage onto a
//      ~48 m grid over the shipped data window.
//   2. Gaussian blur to merge blocks into a continuous urban mass.
//   3. Pick the highest threshold whose largest connected component still
//      contains >= 90% of the rasterised building area (calibrated, not
//      arbitrary — sparse outliers are dropped, the dense core stays whole).
//   4. Morphological dilation (rounds the rim; no rim building gets shaved).
//   5. Marching-squares contour -> largest loop.
//   6. Douglas-Peucker simplify + Chaikin smoothing -> organic silhouette.
//
// Ring convention matches src/geo/rings.ts: the emitted ring has NEGATIVE
// shoelace area in (x, z), i.e. caps/triangles built from it face UP (+Y).

import { toWorld } from './projection'
import type { BuildingRecord, ParkArea, RoadRecord, WaterArea } from '../types/city'

/** Irregular island outline: flat [x, z, ...] ring, up-facing. */
export interface CityBoundary {
  ring: Float32Array
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  source: 'density-derived'
}

export interface BoundaryResult {
  boundary: CityBoundary
  /** Share of rasterised building area inside the chosen component. */
  buildingContainment: number
  contourPoints: number
  /** True when the containment target was met (vs best-effort fallback). */
  calibrated: boolean
}

// --- tuning constants (deterministic; documented in docs/DATA.md) ------------

const CELL_M = 48
const WINDOW_MARGIN_M = 240
const BLUR_SIGMA_CELLS = 2.2
const MIN_BUILDING_CONTAINMENT = 0.9
const THRESHOLD_LADDER = [0.42, 0.36, 0.3, 0.26, 0.22, 0.18, 0.14, 0.1, 0.07, 0.05]
const DILATE_ROUNDS = 2
const SIMPLIFY_EPS_M = 30
const CHAIKIN_ITERATIONS = 2
const RESAMPLE_M = 11
/** Road metres per cell that weigh as much as full building coverage. */
const ROAD_DENSITY_PER_M = 0.004
/**
 * Park / water polygons count as urban coverage at this weight. Below 1.0
 * they only anchor the silhouette where they adjoin built fabric, so green
 * gaps and lake shores shape the outline instead of filling it.
 */
const AREA_WEIGHT_PARK_WATER = 0.55

// --- point / ring primitives -------------------------------------------------

/** Even-odd point-in-polygon for a flat [x, z, ...] ring. */
export function pointInRing(x: number, z: number, ring: ArrayLike<number>): boolean {
  const n = ring.length / 2
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i]
    const zi = ring[2 * i + 1]
    const xj = ring[2 * j]
    const zj = ring[2 * j + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

function ringArea(ring: ArrayLike<number>): number {
  const n = ring.length / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1]
  }
  return sum / 2
}

function reverseRing(ring: number[]): number[] {
  const out: number[] = []
  const n = ring.length / 2
  for (let i = n - 1; i >= 0; i--) out.push(ring[2 * i], ring[2 * i + 1])
  return out
}

// --- rasterisation -----------------------------------------------------------

interface Raster {
  w: number
  h: number
  minX: number
  minZ: number
  cell: number
  data: Float32Array
}

function makeRaster(minX: number, minZ: number, maxX: number, maxZ: number): Raster {
  const w = Math.max(8, Math.ceil((maxX - minX) / CELL_M))
  const h = Math.max(8, Math.ceil((maxZ - minZ) / CELL_M))
  return { w, h, minX, minZ, cell: CELL_M, data: new Float32Array(w * h) }
}

/** Scanline rasterisation of a flat ring: accumulates covered area per cell. */
function rasterRingArea(r: Raster, ring: ArrayLike<number>): void {
  const n = ring.length / 2
  if (n < 3) return
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const z = ring[2 * i + 1]
    if (z < minY) minY = z
    if (z > maxY) maxY = z
  }
  const j0 = Math.max(0, Math.floor((minY - r.minZ) / r.cell))
  const j1 = Math.min(r.h - 1, Math.floor((maxY - r.minZ) / r.cell))
  for (let j = j0; j <= j1; j++) {
    const zMid = r.minZ + (j + 0.5) * r.cell
    const xs: number[] = []
    for (let i = 0, k = n - 1; i < n; k = i++) {
      const zi = ring[2 * i + 1]
      const zk = ring[2 * k + 1]
      if (zi > zMid === zk > zMid) continue
      const t = (zMid - zi) / (zk - zi)
      xs.push(ring[2 * i] + t * (ring[2 * k] - ring[2 * i]))
    }
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const xA = xs[s]
      const xB = xs[s + 1]
      if (xB <= xA) continue
      const i0 = Math.max(0, Math.floor((xA - r.minX) / r.cell))
      const i1 = Math.min(r.w - 1, Math.floor((xB - r.minX) / r.cell))
      for (let i = i0; i <= i1; i++) {
        const cLo = r.minX + i * r.cell
        const cHi = cLo + r.cell
        const overlapX = Math.min(xB, cHi) - Math.max(xA, cLo)
        if (overlapX > 0) r.data[j * r.w + i] += overlapX * r.cell
      }
    }
  }
}

/** Accumulate road length (density-weighted) per cell. */
function rasterPolyline(r: Raster, pts: ArrayLike<number>, weightPerM: number): void {
  const n = pts.length / 2
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[2 * i]
    const az = pts[2 * i + 1]
    const bx = pts[2 * i + 2]
    const bz = pts[2 * i + 3]
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-6) continue
    const steps = Math.max(1, Math.ceil(len / (r.cell * 0.5)))
    const per = (len * weightPerM) / steps
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps
      const mx = ax + (bx - ax) * t
      const mz = az + (bz - az) * t
      const ci = Math.floor((mx - r.minX) / r.cell)
      const cj = Math.floor((mz - r.minZ) / r.cell)
      if (ci < 0 || cj < 0 || ci >= r.w || cj >= r.h) continue
      r.data[cj * r.w + ci] += per
    }
  }
}

/** Separable Gaussian blur, sigma in cells. */
function gaussianBlur(r: Raster, sigma: number): void {
  const radius = Math.max(1, Math.ceil(sigma * 2.5))
  const kernel = new Float32Array(2 * radius + 1)
  let kSum = 0
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma))
    kernel[k + radius] = v
    kSum += v
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= kSum
  const tmp = new Float32Array(r.data.length)
  for (let j = 0; j < r.h; j++) {
    for (let i = 0; i < r.w; i++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const ii = Math.min(Math.max(i + k, 0), r.w - 1)
        acc += r.data[j * r.w + ii] * kernel[k + radius]
      }
      tmp[j * r.w + i] = acc
    }
  }
  for (let j = 0; j < r.h; j++) {
    for (let i = 0; i < r.w; i++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const jj = Math.min(Math.max(j + k, 0), r.h - 1)
        acc += tmp[jj * r.w + i] * kernel[k + radius]
      }
      r.data[j * r.w + i] = acc
    }
  }
}

/** In-place 3x3 maximum filter (morphological dilation). */
function dilate3x3(r: Raster): void {
  const src = r.data.slice()
  for (let j = 0; j < r.h; j++) {
    for (let i = 0; i < r.w; i++) {
      let m = 0
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj
        if (jj < 0 || jj >= r.h) continue
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          if (ii < 0 || ii >= r.w) continue
          const v = src[jj * r.w + ii]
          if (v > m) m = v
        }
      }
      r.data[j * r.w + i] = m
    }
  }
}

/** Binary mask of the largest 8-connected component of (data > threshold). */
function largestComponentMask(r: Raster, threshold: number): Uint8Array | null {
  const label = new Int32Array(r.w * r.h).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  let next = 0
  for (let start = 0; start < label.length; start++) {
    if (label[start] !== -1 || r.data[start] <= threshold) continue
    let area = 0
    label[start] = next
    stack.push(start)
    while (stack.length) {
      const idx = stack.pop()!
      area++
      const i = idx % r.w
      const j = (idx - i) / r.w
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj
        if (jj < 0 || jj >= r.h) continue
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          if (ii < 0 || ii >= r.w) continue
          const nIdx = jj * r.w + ii
          if (label[nIdx] !== -1 || r.data[nIdx] <= threshold) continue
          label[nIdx] = next
          stack.push(nIdx)
        }
      }
    }
    sizes.push(area)
    next++
  }
  if (sizes.length === 0) return null
  let best = 0
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[best]) best = c
  const mask = new Uint8Array(r.w * r.h)
  for (let idx = 0; idx < label.length; idx++) mask[idx] = label[idx] === best ? 1 : 0
  return mask
}

// --- marching squares --------------------------------------------------------

/** Extract closed contours of a binary raster as flat [x, z, ...] loops. */
function marchingSquares(mask: Uint8Array, r: Raster): number[][] {
  const sampleX = (i: number) => r.minX + (i + 0.5) * r.cell
  const sampleZ = (j: number) => r.minZ + (j + 0.5) * r.cell
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= r.w || j >= r.h ? 0 : mask[j * r.w + i])
  const segs: number[] = [] // ax, az, bx, bz quads

  for (let j = -1; j < r.h; j++) {
    for (let i = -1; i < r.w; i++) {
      const tl = at(i, j)
      const tr = at(i + 1, j)
      const br = at(i + 1, j + 1)
      const bl = at(i, j + 1)
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl
      if (code === 0 || code === 15) continue
      // Edge midpoints between adjacent samples.
      const topX = (sampleX(i) + sampleX(i + 1)) / 2
      const topZ = sampleZ(j)
      const botX = topX
      const botZ = sampleZ(j + 1)
      const leftX = sampleX(i)
      const leftZ = (sampleZ(j) + sampleZ(j + 1)) / 2
      const rightX = sampleX(i + 1)
      const rightZ = leftZ
      const emit = (ax: number, az: number, bx: number, bz: number) => segs.push(ax, az, bx, bz)
      switch (code) {
        case 1: emit(leftX, leftZ, botX, botZ); break
        case 2: emit(botX, botZ, rightX, rightZ); break
        case 3: emit(leftX, leftZ, rightX, rightZ); break
        case 4: emit(rightX, rightZ, topX, topZ); break
        case 5: emit(rightX, rightZ, botX, botZ); emit(leftX, leftZ, topX, topZ); break
        case 6: emit(botX, botZ, topX, topZ); break
        case 7: emit(leftX, leftZ, topX, topZ); break
        case 8: emit(topX, topZ, leftX, leftZ); break
        case 9: emit(topX, topZ, botX, botZ); break
        case 10: emit(topX, topZ, rightX, rightZ); emit(botX, botZ, leftX, leftZ); break
        case 11: emit(topX, topZ, rightX, rightZ); break
        case 12: emit(rightX, rightZ, leftX, leftZ); break
        case 13: emit(rightX, rightZ, botX, botZ); break
        case 14: emit(botX, botZ, leftX, leftZ); break
      }
    }
  }

  // Chain segments into closed loops. Direction-agnostic: the case table may
  // emit either orientation, so each step matches either endpoint and flips
  // the segment when needed. Final ring orientation is normalised later.
  const segCount = segs.length / 4
  const buckets = new Map<string, number[]>()
  const keyOf = (x: number, z: number) => `${Math.round(x * 20)},${Math.round(z * 20)}`
  for (let s = 0; s < segCount; s++) {
    for (const k of [keyOf(segs[4 * s], segs[4 * s + 1]), keyOf(segs[4 * s + 2], segs[4 * s + 3])]) {
      const list = buckets.get(k)
      if (list) list.push(s)
      else buckets.set(k, [s])
    }
  }
  const loops: number[][] = []
  const consumed = new Uint8Array(segCount)
  for (let s = 0; s < segCount; s++) {
    if (consumed[s]) continue
    consumed[s] = 1
    const loop: number[] = [segs[4 * s], segs[4 * s + 1], segs[4 * s + 2], segs[4 * s + 3]]
    const startKey = keyOf(loop[0], loop[1])
    let endX = loop[2]
    let endZ = loop[3]
    for (let guard = 0; guard <= segCount; guard++) {
      if (keyOf(endX, endZ) === startKey) break
      const list = buckets.get(keyOf(endX, endZ))
      let picked = -1
      if (list) {
        for (let li = list.length - 1; li >= 0; li--) {
          const cand = list[li]
          if (!consumed[cand]) {
            list.splice(li, 1)
            picked = cand
            break
          }
        }
      }
      if (picked < 0) break
      consumed[picked] = 1
      const ax = segs[4 * picked]
      const az = segs[4 * picked + 1]
      const bx = segs[4 * picked + 2]
      const bz = segs[4 * picked + 3]
      const entersAtEnd = keyOf(ax, az) === keyOf(endX, endZ)
      loop.push(entersAtEnd ? bx : ax, entersAtEnd ? bz : az)
      endX = entersAtEnd ? bx : ax
      endZ = entersAtEnd ? bz : az
    }
    if (loop.length >= 8 && keyOf(loop[loop.length - 2], loop[loop.length - 1]) === startKey) {
      loops.push(loop)
    }
  }
  return loops
}

// --- contour refinement ------------------------------------------------------

function squaredSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = ax + t * dx - px
  const ez = az + t * dz - pz
  return ex * ex + ez * ez
}

function simplifyRing(ring: number[], eps: number): number[] {
  const n = ring.length / 2
  if (n <= 4) return ring.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    if (b - a < 2) continue
    const ax = ring[2 * a]
    const az = ring[2 * a + 1]
    const bx = ring[2 * b]
    const bz = ring[2 * b + 1]
    let maxD = -1
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const d = squaredSegDist(ring[2 * i], ring[2 * i + 1], ax, az, bx, bz)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > eps * eps) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[2 * i], ring[2 * i + 1])
  return out
}

function chaikin(ring: number[], iterations: number): number[] {
  let cur = ring
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 2
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = cur[2 * i]
      const az = cur[2 * i + 1]
      const bx = cur[2 * j]
      const bz = cur[2 * j + 1]
      out.push(0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz)
      out.push(0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz)
    }
    cur = out
  }
  return cur
}

function decimate(ring: number[], minSpacing: number): number[] {
  const n = ring.length / 2
  if (n < 4) return ring
  const out: number[] = [ring[0], ring[1]]
  let lx = ring[0]
  let lz = ring[1]
  for (let i = 1; i < n; i++) {
    const x = ring[2 * i]
    const z = ring[2 * i + 1]
    if (Math.hypot(x - lx, z - lz) >= minSpacing) {
      out.push(x, z)
      lx = x
      lz = z
    }
  }
  return out
}

// --- polyline clipping (roads) -----------------------------------------------

function crossRing(ax: number, az: number, bx: number, bz: number, ring: ArrayLike<number>): [number, number] | null {
  const n = ring.length / 2
  let best: [number, number] | null = null
  let bestD = Infinity
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const cx = ring[2 * i]
    const cz = ring[2 * i + 1]
    const dx = ring[2 * j]
    const dz = ring[2 * j + 1]
    const rX = bx - ax
    const rZ = bz - az
    const sX = dx - cx
    const sZ = dz - cz
    const denom = rX * sZ - rZ * sX
    if (Math.abs(denom) < 1e-12) continue
    const t = ((cx - ax) * sZ - (cz - az) * sX) / denom
    const u = ((cx - ax) * rZ - (cz - az) * rX) / denom
    if (t < 0 || t > 1 || u < 0 || u > 1) continue
    const hx = ax + t * rX
    const hz = az + t * rZ
    const d = (hx - ax) * (hx - ax) + (hz - az) * (hz - az)
    if (d < bestD) {
      bestD = d
      best = [hx, hz]
    }
  }
  return best
}

/**
 * Clip a polyline to the island. Returns inside sub-polylines (flat arrays);
 * boundary crossings are inserted so ribbons terminate exactly at the rim.
 */
export function clipPolylineToRing(pts: ArrayLike<number>, ring: ArrayLike<number>): number[][] {
  const n = pts.length / 2
  const runs: number[][] = []
  let cur: number[] | null = null
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i]
    const z = pts[2 * i + 1]
    const inside = pointInRing(x, z, ring)
    if (inside) {
      if (!cur) {
        cur = []
        if (i > 0 && !pointInRing(pts[2 * (i - 1)], pts[2 * (i - 1) + 1], ring)) {
          const cross = crossRing(pts[2 * (i - 1)], pts[2 * (i - 1) + 1], x, z, ring)
          if (cross) cur.push(cross[0], cross[1])
        }
      }
      cur.push(x, z)
    } else if (cur) {
      const cross = crossRing(pts[2 * (i - 1)], pts[2 * (i - 1) + 1], x, z, ring)
      if (cross) cur.push(cross[0], cross[1])
      if (cur.length >= 4) runs.push(cur)
      cur = null
    }
  }
  if (cur && cur.length >= 4) runs.push(cur)
  return runs
}

// --- layer clipping helpers --------------------------------------------------

export interface ClipResult<T> {
  kept: T[]
  dropped: number
}

function centroidOf(ring: ArrayLike<number>): [number, number] {
  const n = ring.length / 2
  let cx = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    cx += ring[2 * i]
    cz += ring[2 * i + 1]
  }
  return [cx / n, cz / n]
}

/** Drop buildings whose footprint centroid falls outside the island. */
export function buildingsInsideBoundary(buildings: BuildingRecord[], boundary: CityBoundary): ClipResult<BuildingRecord> {
  const kept: BuildingRecord[] = []
  let dropped = 0
  for (const b of buildings) {
    const [cx, cz] = centroidOf(b.ring)
    if (pointInRing(cx, cz, boundary.ring)) kept.push(b)
    else dropped++
  }
  return { kept, dropped }
}

/** Split road polylines into inside runs; drops fully-outside roads. */
export function roadsInsideBoundary(roads: RoadRecord[], boundary: CityBoundary): ClipResult<RoadRecord> {
  const kept: RoadRecord[] = []
  let dropped = 0
  for (const road of roads) {
    const runs = clipPolylineToRing(road.pts, boundary.ring)
    if (runs.length === 0) {
      dropped++
      continue
    }
    for (const run of runs) {
      kept.push({ roadClass: road.roadClass, bridge: road.bridge, pts: new Float32Array(run) })
    }
  }
  return { kept, dropped }
}

/** Drop polygon records (parks/water) whose centroid falls outside. */
export function polygonsInsideBoundary<T>(items: T[], ringOf: (item: T) => ArrayLike<number>, boundary: CityBoundary): ClipResult<T> {
  const kept: T[] = []
  let dropped = 0
  for (const item of items) {
    const [cx, cz] = centroidOf(ringOf(item))
    if (pointInRing(cx, cz, boundary.ring)) kept.push(item)
    else dropped++
  }
  return { kept, dropped }
}

// --- main derivation ---------------------------------------------------------

/**
 * Derive the irregular urban footprint from the loaded dataset.
 * Deterministic: identical data always yields the identical outline.
 * `minBuildingContainment` (0..1) tunes how much of the built mass the
 * silhouette must keep — lower values yield a tighter, more irregular edge.
 */
export function deriveCityBoundary(
  buildings: BuildingRecord[],
  roads: RoadRecord[],
  water: WaterArea[],
  parks: ParkArea[],
  window: { south: number; north: number; west: number; east: number },
  minBuildingContainment: number = MIN_BUILDING_CONTAINMENT,
): BoundaryResult | null {
  // The raster window is the SHIPPED data window (itself a subset of the
  // approved study window) plus margin — the contour cannot leave it.
  const nw = toWorld({ lat: window.north, lng: window.west })
  const se = toWorld({ lat: window.south, lng: window.east })
  const r = makeRaster(nw.x - WINDOW_MARGIN_M, nw.z - WINDOW_MARGIN_M, se.x + WINDOW_MARGIN_M, se.z + WINDOW_MARGIN_M)
  const cellArea = r.cell * r.cell

  // Raw building-area raster, used only for threshold calibration.
  const buildingRaster: Raster = { ...r, data: new Float32Array(r.data.length) }
  for (const b of buildings) rasterRingArea(buildingRaster, b.ring)
  let totalBuildingArea = 0
  for (let i = 0; i < buildingRaster.data.length; i++) totalBuildingArea += buildingRaster.data[i]
  if (totalBuildingArea <= 0) return null

  // Combined urban density: building coverage anchors the mass; parks, water
  // and roads contribute at reduced weights so green gaps shape the edge.
  const buildingCoverage = new Float32Array(r.data.length)
  const parkWaterCoverage = new Float32Array(r.data.length)
  const buildingOnlyRaster: Raster = { ...r, data: buildingCoverage }
  for (const b of buildings) rasterRingArea(buildingOnlyRaster, b.ring)
  const parkWaterRaster: Raster = { ...r, data: parkWaterCoverage }
  for (const p of parks) rasterRingArea(parkWaterRaster, p.ring)
  for (const w of water) rasterRingArea(parkWaterRaster, w.outer)
  const roadRaster: Raster = { ...r, data: new Float32Array(r.data.length) }
  for (const road of roads) rasterPolyline(roadRaster, road.pts, ROAD_DENSITY_PER_M)
  for (let i = 0; i < r.data.length; i++) {
    r.data[i] =
      buildingCoverage[i] / cellArea + AREA_WEIGHT_PARK_WATER * (parkWaterCoverage[i] / cellArea + roadRaster.data[i])
  }

  gaussianBlur(r, BLUR_SIGMA_CELLS)

  let maxD = 0
  for (let i = 0; i < r.data.length; i++) if (r.data[i] > maxD) maxD = r.data[i]
  if (maxD <= 0) return null

  // Calibrated threshold: highest rung whose largest component keeps the
  // required share of building area; best-effort fallback otherwise.
  let bestMask: Uint8Array | null = null
  let bestContainment = 0
  let calibrated = false
  for (const frac of THRESHOLD_LADDER) {
    const mask = largestComponentMask(r, frac * maxD)
    if (!mask) continue
    let inside = 0
    for (let i = 0; i < mask.length; i++) if (mask[i]) inside += buildingRaster.data[i]
    const containment = inside / totalBuildingArea
    if (containment >= minBuildingContainment) {
      bestMask = mask
      bestContainment = containment
      calibrated = true
      break
    }
    if (containment > bestContainment) {
      bestMask = mask
      bestContainment = containment
    }
  }
  if (!bestMask) return null

  // Rim safety: dilate so simplify/smooth never shaves rim buildings.
  const maskRaster: Raster = { ...r, data: Float32Array.from(bestMask) }
  for (let k = 0; k < DILATE_ROUNDS; k++) dilate3x3(maskRaster)
  const dilated = new Uint8Array(maskRaster.data.length)
  for (let i = 0; i < dilated.length; i++) dilated[i] = maskRaster.data[i] > 0.5 ? 1 : 0

  const loops = marchingSquares(dilated, r)
  if (loops.length === 0) return null
  let ring = loops.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a))

  ring = decimate(ring, 6)
  ring = simplifyRing(ring, SIMPLIFY_EPS_M)
  ring = chaikin(ring, CHAIKIN_ITERATIONS)
  ring = decimate(ring, RESAMPLE_M)
  if (ring.length < 6) return null

  // Scene-wide flat-ring convention: caps built from the ring must face UP.
  if (ringArea(ring) > 0) ring = reverseRing(ring)

  const flat = new Float32Array(ring)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < flat.length / 2; i++) {
    const x = flat[2 * i]
    const z = flat[2 * i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  return {
    boundary: { ring: flat, minX, maxX, minZ, maxZ, source: 'density-derived' },
    buildingContainment: bestContainment,
    contourPoints: flat.length / 2,
    calibrated,
  }
}