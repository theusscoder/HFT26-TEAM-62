// Building geometry builders.
//
// Two representations for the same footprint records:
//
//  1. Instanced OBB boxes   — one unit box per building, oriented and scaled
//     to the footprint's principal axis (2D PCA). One draw call for the whole
//     sample window; the scalable tier for the full city window later.
//
//  2. Footprint extrusions  — real polygon extrusion (earcut caps + wall
//     quads) merged into one non-indexed geometry. Heavier, used near camera
//     (auto LOD). Phase 2 builds both so the benchmark can compare them.
//
// Both derive heights/base positions from the same HeightField instance.

import * as THREE from 'three'
import earcut from 'earcut'
import type { BuildingRecord } from '../../types/city'
import type { HeightField } from '../../geo/heightfield'
import { palette } from '../../config/palette'
import { normalizeRingUp, triFacesUp } from '../../geo/rings'

export interface BuildingInstances {
  count: number
  matrices: Float32Array
  colors: Float32Array
  /** Number of buildings actually encoded (skips degenerate footprints). */
  rendered: number
}

interface OBB {
  cx: number
  cz: number
  sx: number
  sz: number
  rot: number
}

const WALL_COLOR_CACHE = palette.buildingWalls.map((hex) => new THREE.Color(hex))

// Landmark accent (palette.accentTeal — "glass accent reserved for landmark
// towers"): walls teal-darkened, roofs teal-lightened, so named city-scale
// buildings read as anchors at every zoom without inventing geometry.
const LANDMARK_WALL = new THREE.Color(palette.accentTeal).multiplyScalar(0.82)
const LANDMARK_ROOF = (() => {
  const roof = new THREE.Color(palette.accentTeal)
  roof.lerp(new THREE.Color('#8fa3a8'), palette.buildingRoofLighten)
  return roof
})()

function roofColorOf(wall: THREE.Color): THREE.Color {
  const roof = wall.clone()
  roof.lerp(new THREE.Color('#8fa3a8'), palette.buildingRoofLighten)
  return roof
}

/** Principal-axis oriented bounding box of a footprint ring. */
function footprintObb(ring: Float32Array): OBB | null {
  const n = ring.length / 2
  if (n < 3) return null
  let cx = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    cx += ring[2 * i]
    cz += ring[2 * i + 1]
  }
  cx /= n
  cz /= n

  let cxx = 0
  let czz = 0
  let cxz = 0
  for (let i = 0; i < n; i++) {
    const dx = ring[2 * i] - cx
    const dz = ring[2 * i + 1] - cz
    cxx += dx * dx
    czz += dz * dz
    cxz += dx * dz
  }
  cxx /= n
  czz /= n
  cxz /= n

  const theta = 0.5 * Math.atan2(2 * cxz, cxx - czz)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)

  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (let i = 0; i < n; i++) {
    const dx = ring[2 * i] - cx
    const dz = ring[2 * i + 1] - cz
    const u = dx * cos + dz * sin
    const v = -dx * sin + dz * cos
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  const sx = maxU - minU
  const sz = maxV - minV
  if (!Number.isFinite(sx) || !Number.isFinite(sz) || sx < 0.5 || sz < 0.5) return null
  // Box centre offset along the principal frame.
  const midU = (minU + maxU) / 2
  const midV = (minV + maxV) / 2
  return {
    cx: cx + midU * cos - midV * sin,
    cz: cz + midU * sin + midV * cos,
    sx: Math.max(sx, 1.2),
    sz: Math.max(sz, 1.2),
    rot: -theta, // maps principal frame onto world x/z via Y rotation
  }
}

export function buildBuildingInstances(
  buildings: BuildingRecord[],
  ground: HeightField,
): BuildingInstances {
  const matrices = new Float32Array(buildings.length * 16)
  const colors = new Float32Array(buildings.length * 3)
  const quat = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const axisY = new THREE.Vector3(0, 1, 0)
  const mat = new THREE.Matrix4()

  let written = 0
  for (const building of buildings) {
    if (building.landmark) continue // landmarks render as extrusions at every tier
    const obb = footprintObb(building.ring)
    if (!obb) continue
    const baseY = ground.meshGroundY(obb.cx, obb.cz)
    const height = Math.max(building.height, 2)
    quat.setFromAxisAngle(axisY, obb.rot)
    pos.set(obb.cx, baseY + height / 2, obb.cz)
    scale.set(obb.sx, height, obb.sz)
    mat.compose(pos, quat, scale)
    const c = WALL_COLOR_CACHE[building.colorSeed % WALL_COLOR_CACHE.length]
    colors[written * 3] = c.r
    colors[written * 3 + 1] = c.g
    colors[written * 3 + 2] = c.b
    matrices.set(mat.elements, written * 16)
    written++
  }

  return { count: written, matrices, colors, rendered: written }
}

interface ExtrusionWorkspace {
  positions: number[]
  normals: number[]
  colors: number[]
}

function pushTriangle(
  ws: ExtrusionWorkspace,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx2: number, cy2: number, cz2: number,
  nx: number, ny: number, nz: number,
  r: number, g: number, b: number,
): void {
  ws.positions.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2)
  ws.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
  ws.colors.push(r, g, b, r, g, b, r, g, b)
}

/** Extrude every footprint to display height. Returns a merged geometry. */
export function buildExtrudedBuildings(
  buildings: BuildingRecord[],
  ground: HeightField,
  filter?: (building: BuildingRecord) => boolean,
): THREE.BufferGeometry {
  const ws: ExtrusionWorkspace = { positions: [], normals: [], colors: [] }
  const wallColors = WALL_COLOR_CACHE.map((c) => c)
  const roofColors = wallColors.map((c) => roofColorOf(c))
  const flatCoords: number[] = []

  for (const building of buildings) {
    if (filter && !filter(building)) continue
    const ring = normalizeRingUp(building.ring)
    const n = ring.length / 2
    if (n < 3) continue

    let cx = 0
    let cz = 0
    for (let i = 0; i < n; i++) {
      cx += ring[2 * i]
      cz += ring[2 * i + 1]
    }
    cx /= n
    cz /= n

    const baseY = ground.meshGroundY(cx, cz)
    const topY = baseY + Math.max(building.height, 2)

    const wall = building.landmark ? LANDMARK_WALL : wallColors[building.colorSeed % wallColors.length]
    const roof = building.landmark ? LANDMARK_ROOF : roofColors[building.colorSeed % wallColors.length]

    // Walls — one quad (two triangles) per edge, flat outward normals. With
    // z south-positive and the ring normalised to face UP, the outward normal
    // of edge a->b is (az-bz, bx-ax).
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = ring[2 * i]
      const az = ring[2 * i + 1]
      const bx = ring[2 * j]
      const bz = ring[2 * j + 1]
      let nx = az - bz
      let nz = bx - ax
      const len = Math.hypot(nx, nz)
      if (len < 1e-6) continue
      nx /= len
      nz /= len
      pushTriangle(ws, ax, baseY, az, bx, baseY, bz, bx, topY, bz, nx, 0, nz, wall.r, wall.g, wall.b)
      pushTriangle(ws, ax, baseY, az, bx, topY, bz, ax, topY, az, nx, 0, nz, wall.r, wall.g, wall.b)
    }

    // Roof — earcut cap at topY.
    flatCoords.length = 0
    for (let i = 0; i < n; i++) {
      flatCoords.push(ring[2 * i], ring[2 * i + 1])
    }
    const tri = earcut(flatCoords)
    for (let t = 0; t < tri.length; t += 3) {
      const i0 = tri[t]
      const i1 = tri[t + 1]
      const i2 = tri[t + 2]
      const ax = flatCoords[2 * i0]
      const az = flatCoords[2 * i0 + 1]
      const bx = flatCoords[2 * i1]
      const bz = flatCoords[2 * i1 + 1]
      const cx = flatCoords[2 * i2]
      const cz = flatCoords[2 * i2 + 1]
      if (triFacesUp(ax, az, bx, bz, cx, cz)) {
        pushTriangle(ws, ax, topY, az, bx, topY, bz, cx, topY, cz, 0, 1, 0, roof.r, roof.g, roof.b)
      } else {
        pushTriangle(ws, ax, topY, az, cx, topY, cz, bx, topY, bz, 0, 1, 0, roof.r, roof.g, roof.b)
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(ws.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(ws.normals, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(ws.colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}