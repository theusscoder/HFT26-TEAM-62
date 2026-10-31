// Floating city-island geometry: the terrain surface clipped to an irregular
// urban footprint polygon, with perimeter side walls, a rocky underside and a
// thin emissive rim ribbon.
//
// Top surface rules:
//   - Grid cells fully inside the polygon keep the standard heightfield
//     triangulation (indexed, smooth normals) so draped layers (roads,
//     parks, buildings) stay exactly on the visible surface — HeightField
//     .meshGroundY() models the same anti-diagonal cell split.
//   - Cells the boundary passes through are clipped PER HALF-CELL TRIANGLE:
//     each half-triangle is planar under meshGroundY, so any triangulation of
//     its clipped remains reproduces the drape surface exactly. Boundary
//     crossings are inserted on the triangle edges, keeping the rim flush
//     with the skirt walls (no cracks).
//
// Everything is built once per dataset load (memoised upstream); nothing here
// runs per frame.

import * as THREE from 'three'
import earcut from 'earcut'
import type { TerrainData } from '../../types/city'
import type { HeightField } from '../../geo/heightfield'
import type { CityBoundary } from '../../geo/boundary'
import { pointInRing } from '../../geo/boundary'
import { triFacesUp } from '../../geo/rings'
import { SLAB_THICKNESS_M } from '../../config/cityConfig'

export interface SlabGeometries {
  /** World-space bounds of the island silhouette. */
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  top: THREE.BufferGeometry
  skirt: THREE.BufferGeometry
  bottom: THREE.BufferGeometry
  /** Thin emissive ribbon following the perimeter just below the rim. */
  rimGlow: THREE.BufferGeometry
  /** Display-space Y of the flat skirt base (= -SLAB_THICKNESS_M). */
  bottomY: number
  /** Y for the atmospheric glow plane (below the deepest underside point). */
  glowY: number
  /** Diagnostics: half-cell pieces resolved by the centroid fallback. */
  fallbackPieces: number
}

/** Underside loft tiers: contraction towards centroid + extra depth + jitter. */
const UNDER_RINGS = [
  { contract: 0.62, depth: 55, jitter: 26 },
  { contract: 0.3, depth: 105, jitter: 34 },
]
const UNDER_CAP = { depth: 150, jitter: 30 }

/** Deterministic 0..1 hash for underside jitter (no per-frame cost). */
function hash01(n: number): number {
  let t = (n + 0x9e3779b9) | 0
  t = Math.imul(t ^ (t >>> 16), 0x21f0aaad)
  t = Math.imul(t ^ (t >>> 15), 0x21f0aaad)
  return ((t ^ (t >>> 15)) >>> 0) / 4294967296
}

function ringCentroid(ring: ArrayLike<number>): [number, number] {
  let a = 0
  let cx = 0
  let cz = 0
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const cross = ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1]
    a += cross
    cx += (ring[2 * i] + ring[2 * j]) * cross
    cz += (ring[2 * i + 1] + ring[2 * j + 1]) * cross
  }
  a /= 2
  if (Math.abs(a) < 1e-6) return [0, 0]
  return [cx / (6 * a), cz / (6 * a)]
}

function pointInTri(px: number, pz: number, tri: ArrayLike<number>): boolean {
  const d1 = (tri[2] - tri[0]) * (pz - tri[1]) - (tri[3] - tri[1]) * (px - tri[0])
  const d2 = (tri[4] - tri[2]) * (pz - tri[3]) - (tri[5] - tri[3]) * (px - tri[2])
  const d3 = (tri[0] - tri[4]) * (pz - tri[5]) - (tri[1] - tri[5]) * (px - tri[4])
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

interface TriVert {
  x: number
  z: number
  y: number
  /** Grid vertex index when the vertex is an original corner (-1 otherwise). */
  gridIdx: number
}

function segIntersectT(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number | null {
  const rX = bx - ax
  const rZ = bz - az
  const sX = dx - cx
  const sZ = dz - cz
  const denom = rX * sZ - rZ * sX
  if (Math.abs(denom) < 1e-12) return null
  const t = ((cx - ax) * sZ - (cz - az) * sX) / denom
  const u = ((cx - ax) * rZ - (cz - az) * rX) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return t
}

export function buildSlab(terrain: TerrainData, ground: HeightField, boundary: CityBoundary): SlabGeometries {
  const { gridW, gridH, dx, dz } = terrain
  const westX = terrain.originX
  const northZ = terrain.originZ
  const ring = boundary.ring
  const ringN = ring.length / 2
  const bottomY = -SLAB_THICKNESS_M

  // ---- ring edges -> crossing candidate cells ------------------------------
  const cellEdges = new Map<number, number[]>()
  const i0 = (x: number) => Math.min(gridW - 1, Math.max(0, Math.floor((x - westX) / dx)))
  const j0 = (z: number) => Math.min(gridH - 1, Math.max(0, Math.floor((z - northZ) / dz)))
  for (let e = 0; e < ringN; e++) {
    const ex = ring[2 * e]
    const ez = ring[2 * e + 1]
    const fx = ring[2 * ((e + 1) % ringN)]
    const fz = ring[2 * ((e + 1) % ringN) + 1]
    const ci0 = i0(Math.min(ex, fx))
    const ci1 = i0(Math.max(ex, fx))
    const cj0 = j0(Math.min(ez, fz))
    const cj1 = j0(Math.max(ez, fz))
    for (let j = cj0; j <= cj1; j++) {
      for (let i = ci0; i <= ci1; i++) {
        const key = j * gridW + i
        const list = cellEdges.get(key)
        if (list) list.push(e)
        else cellEdges.set(key, [e])
      }
    }
  }

  // ---- grid node inside flags (lazy) ----------------------------------------
  const nodeInside = new Int8Array(gridW * gridH).fill(-1)
  const isNodeInside = (i: number, j: number): boolean => {
    const idx = j * gridW + i
    const cached = nodeInside[idx]
    if (cached !== -1) return cached === 1
    const x = westX + i * dx
    const z = northZ + j * dz
    const inside = pointInRing(x, z, ring) ? 1 : 0
    nodeInside[idx] = inside
    return inside === 1
  }
  const nodeX = (i: number) => westX + i * dx
  const nodeZ = (j: number) => northZ + j * dz
  const nodeY = (i: number, j: number) => ground.groundY(nodeX(i), nodeZ(j))

  // ---- top surface -----------------------------------------------------------
  const positions: number[] = new Array(gridW * gridH * 3)
  for (let j = 0; j < gridH; j++) {
    for (let i = 0; i < gridW; i++) {
      const idx = j * gridW + i
      positions[3 * idx] = nodeX(i)
      positions[3 * idx + 1] = nodeY(i, j)
      positions[3 * idx + 2] = nodeZ(j)
    }
  }
  const indices: number[] = []
  let fallbackPieces = 0

  const pushVert = (v: TriVert): number => {
    const idx = positions.length / 3
    positions.push(v.x, v.y, v.z)
    return idx
  }
  const pushTriUp = (a: number, b: number, c: number) => {
    const ax = positions[3 * a]
    const az = positions[3 * a + 2]
    const bx = positions[3 * b]
    const bz = positions[3 * b + 2]
    const cx = positions[3 * c]
    const cz = positions[3 * c + 2]
    if (triFacesUp(ax, az, bx, bz, cx, cz)) indices.push(a, b, c)
    else indices.push(a, c, b)
  }

  /**
   * Clip one half-cell triangle against the island polygon and emit the
   * remains. Vertices on the ring chain sample meshGroundY (exact plane
   * value inside this half-triangle), crossings lerp along tri edges.
   */
  const emitClippedTri = (v0: TriVert, v1: TriVert, v2: TriVert, candEdges: number[]): void => {
    const tri = [v0.x, v0.z, v1.x, v1.z, v2.x, v2.z]
    const corners = [v0, v1, v2]
    const inC = corners.map((c) => pointInRing(c.x, c.z, ring))

    // Crossings per triangle edge (edge k: corner k -> corner k+1).
    const crossings: Array<Array<{ t: number; x: number; z: number; y: number; ringIdx: number }>> = [[], [], []]
    let total = 0
    for (const e of candEdges) {
      const ex = ring[2 * e]
      const ez = ring[2 * e + 1]
      const fx = ring[2 * ((e + 1) % ringN)]
      const fz = ring[2 * ((e + 1) % ringN) + 1]
      for (let k = 0; k < 3; k++) {
        const a = corners[k]
        const b = corners[(k + 1) % 3]
        const t = segIntersectT(a.x, a.z, b.x, b.z, ex, ez, fx, fz)
        if (t === null) continue
        crossings[k].push({
          t,
          x: a.x + (b.x - a.x) * t,
          z: a.z + (b.z - a.z) * t,
          y: a.y + (b.y - a.y) * t,
          ringIdx: e,
        })
        total++
      }
    }
    for (const list of crossings) list.sort((p, q) => p.t - q.t)

    if (total === 0) {
      // Boundary does not cross the half-triangle: all-in or all-out.
      if (inC[0] && inC[1] && inC[2]) pushTriUp(v0.gridIdx, v1.gridIdx, v2.gridIdx)
      return
    }
    if (total > 2) {
      // Degenerate multi-crossing sliver: resolve by centroid, keep count.
      fallbackPieces++
      const cx = (v0.x + v1.x + v2.x) / 3
      const cz = (v0.z + v1.z + v2.z) / 3
      if (pointInRing(cx, cz, ring)) pushTriUp(v0.gridIdx, v1.gridIdx, v2.gridIdx)
      return
    }

    // Exactly two crossings: build tri ∩ polygon.
    const c = crossings.flat()
    const first = c[0]
    const second = c[1]
    const poly: TriVert[] = []
    if (first.ringIdx === second.ringIdx) {
      // One ring segment cuts through the triangle (enter + exit on the same
      // straight ring edge): the region is the sub-segment plus the tri
      // corners inside the polygon.
      const e1 = crossings.findIndex((list) => list.includes(first))
      const e2 = crossings.findIndex((list) => list.includes(second))
      poly.push({ ...first, gridIdx: -1 })
      let k = e1
      while (k !== e2) {
        const corner = corners[(k + 1) % 3]
        if (pointInRing(corner.x, corner.z, ring)) poly.push(corner)
        k = (k + 1) % 3
      }
      poly.push({ ...second, gridIdx: -1 })
    } else {
      // Walk the ring from `first` to `second` in ring direction.
      const enter = first
      const exit = second
      poly.push({ ...enter, gridIdx: -1 })

      // Ring chain between the crossing edges (vertices inside this tri).
      const startEdge = enter.ringIdx
      const endEdge = exit.ringIdx
      let e = startEdge
      while (e !== endEdge) {
        const next = (e + 1) % ringN
        const nx = ring[2 * next]
        const nz = ring[2 * next + 1]
        if (pointInTri(nx, nz, tri)) poly.push({ x: nx, z: nz, y: ground.meshGroundY(nx, nz), gridIdx: -1 })
        e = next
      }
      poly.push({ ...exit, gridIdx: -1 })

      // Triangle boundary from exit back to enter: inside corners in tri order.
      const exitEdge = crossings.findIndex((list) => list.includes(exit))
      const enterEdge = crossings.findIndex((list) => list.includes(enter))
      let k = exitEdge
      while (k !== enterEdge) {
        const corner = corners[(k + 1) % 3]
        if (pointInTri(corner.x, corner.z, tri)) poly.push(corner)
        k = (k + 1) % 3
      }
    }

    // Dedupe near-identical consecutive points, then triangulate.
    const cleaned: TriVert[] = []
    for (const p of poly) {
      const last = cleaned[cleaned.length - 1]
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.05) continue
      cleaned.push(p)
    }
    if (cleaned.length > 2) {
      const first = cleaned[0]
      const last = cleaned[cleaned.length - 1]
      if (Math.hypot(first.x - last.x, first.z - last.z) < 0.05) cleaned.pop()
    }
    if (cleaned.length < 3) return
    const flat: number[] = []
    for (const p of cleaned) flat.push(p.x, p.z)
    const triIdx = earcut(flat)
    for (let t = 0; t < triIdx.length; t += 3) {
      const ia = pushVert(cleaned[triIdx[t]])
      const ib = pushVert(cleaned[triIdx[t + 1]])
      const ic = pushVert(cleaned[triIdx[t + 2]])
      pushTriUp(ia, ib, ic)
    }
  }

  for (let j = 0; j < gridH - 1; j++) {
    for (let i = 0; i < gridW - 1; i++) {
      // Fast reject: cells far outside the island silhouette.
      const cx = nodeX(i)
      const cz = nodeZ(j)
      if (
        cx > boundary.maxX + dx * 2 || nodeX(i + 1) < boundary.minX - dx * 2 ||
        cz > boundary.maxZ + dz * 2 || nodeZ(j + 1) < boundary.minZ - dz * 2
      ) continue

      const key = j * gridW + i
      const candEdges = cellEdges.get(key)
      const a: TriVert = { x: nodeX(i), z: nodeZ(j), y: nodeY(i, j), gridIdx: j * gridW + i }
      const b: TriVert = { x: nodeX(i + 1), z: nodeZ(j), y: nodeY(i + 1, j), gridIdx: j * gridW + i + 1 }
      const c: TriVert = { x: nodeX(i), z: nodeZ(j + 1), y: nodeY(i, j + 1), gridIdx: (j + 1) * gridW + i }
      const d: TriVert = { x: nodeX(i + 1), z: nodeZ(j + 1), y: nodeY(i + 1, j + 1), gridIdx: (j + 1) * gridW + i + 1 }

      if (!candEdges) {
        const anyIn = isNodeInside(i, j) || isNodeInside(i + 1, j) || isNodeInside(i, j + 1) || isNodeInside(i + 1, j + 1)
        if (!anyIn) continue
        // Fully inside — standard heightfield triangulation (meshGroundY planes).
        indices.push(a.gridIdx, c.gridIdx, b.gridIdx)
        indices.push(b.gridIdx, c.gridIdx, d.gridIdx)
        continue
      }
      emitClippedTri(a, b, c, candEdges)
      emitClippedTri(b, d, c, candEdges)
    }
  }

  const top = new THREE.BufferGeometry()
  top.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  top.setIndex(indices)
  top.computeVertexNormals()

  // ---- skirt walls (vertical extrusion along the silhouette) ----------------
  const rimYs = new Float32Array(ringN)
  for (let i = 0; i < ringN; i++) rimYs[i] = ground.meshGroundY(ring[2 * i], ring[2 * i + 1])

  const skirtPos: number[] = []
  const glowPos: number[] = []
  const RIM_DROP_M = 13
  for (let i = 0; i < ringN; i++) {
    const j = (i + 1) % ringN
    const ax = ring[2 * i]
    const az = ring[2 * i + 1]
    const bx = ring[2 * j]
    const bz = ring[2 * j + 1]
    const ay = rimYs[i]
    const by = rimYs[j]
    // Up-facing ring -> outward wall winding is (a_top, b_bottom, b_top) and
    // (a_top, a_bottom, b_bottom).
    skirtPos.push(ax, ay, az, bx, bottomY, bz, bx, by, bz)
    skirtPos.push(ax, ay, az, ax, bottomY, az, bx, bottomY, bz)
    // Emissive rim ribbon hugging the wall just below the rim.
    glowPos.push(ax, ay - 0.5, az, bx, by - RIM_DROP_M, bz, bx, by - 0.5, bz)
    glowPos.push(ax, ay - 0.5, az, ax, ay - RIM_DROP_M, az, bx, by - RIM_DROP_M, bz)
  }
  const skirt = new THREE.BufferGeometry()
  skirt.setAttribute('position', new THREE.Float32BufferAttribute(skirtPos, 3))
  skirt.computeVertexNormals()
  const rimGlow = new THREE.BufferGeometry()
  rimGlow.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3))
  rimGlow.computeVertexNormals()

  // ---- rocky underside (contracted loft rings + cap) -------------------------
  const [cenX, cenZ] = ringCentroid(ring)
  const underRings: Array<{ x: number; z: number; y: number }> = []
  // Tier 0 shares the skirt base exactly (watertight seam).
  for (let i = 0; i < ringN; i++) underRings.push({ x: ring[2 * i], z: ring[2 * i + 1], y: bottomY })
  UNDER_RINGS.forEach((tier, tierIdx) => {
    for (let i = 0; i < ringN; i++) {
      const x = ring[2 * i]
      const z = ring[2 * i + 1]
      const hx = (hash01(tierIdx * 7919 + i * 2 + 1) - 0.5) * 2 * tier.jitter
      const hz = (hash01(tierIdx * 7919 + i * 2 + 2) - 0.5) * 2 * tier.jitter
      const hy = (hash01(tierIdx * 7919 + i * 2 + 3) - 0.5) * 2 * tier.jitter
      underRings.push({
        x: cenX + (x - cenX) * tier.contract + hx,
        z: cenZ + (z - cenZ) * tier.contract + hz,
        y: bottomY - tier.depth - hy,
      })
    }
  })
  const capY = bottomY - UNDER_CAP.depth
  const capX = cenX + (hash01(99991) - 0.5) * 2 * UNDER_CAP.jitter
  const capZ = cenZ + (hash01(0x51ed) - 0.5) * 2 * UNDER_CAP.jitter

  const bottomPos: number[] = []
  const bands = 1 + UNDER_RINGS.length
  for (let band = 0; band < bands; band++) {
    const upper = band * ringN
    const lower = (band + 1) * ringN
    const isCapBand = band + 1 === bands
    for (let i = 0; i < ringN; i++) {
      const j = (i + 1) % ringN
      const a = underRings[upper + i]
      const b = underRings[upper + j]
      if (isCapBand) {
        bottomPos.push(a.x, a.y, a.z, capX, capY, capZ, b.x, b.y, b.z)
      } else {
        const a2 = underRings[lower + i]
        const b2 = underRings[lower + j]
        bottomPos.push(a.x, a.y, a.z, b2.x, b2.y, b2.z, b.x, b.y, b.z)
        bottomPos.push(a.x, a.y, a.z, a2.x, a2.y, a2.z, b2.x, b2.y, b2.z)
      }
    }
  }
  const bottom = new THREE.BufferGeometry()
  bottom.setAttribute('position', new THREE.Float32BufferAttribute(bottomPos, 3))
  bottom.computeVertexNormals()

  let minY = Infinity
  for (let i = 1; i < bottomPos.length; i += 3) if (bottomPos[i] < minY) minY = bottomPos[i]

  return {
    minX: boundary.minX,
    maxX: boundary.maxX,
    minZ: boundary.minZ,
    maxZ: boundary.maxZ,
    top,
    skirt,
    bottom,
    rimGlow,
    bottomY,
    glowY: minY - 30,
    fallbackPieces,
  }
}