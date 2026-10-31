// Dev-time check: watertightness of the polygon-clipped terrain.
//  1. Summed top-mesh area ~= island polygon area (no cracks / missing cells).
//  2. Top-mesh surface height == HeightField.meshGroundY inside the island
//     (roads/buildings/parks drape exactly onto the visible surface).
import { readFileSync } from 'node:fs'
import { deriveCityBoundary, pointInRing } from '../src/geo/boundary.ts'
import { HeightField } from '../src/geo/heightfield.ts'
import { buildSlab } from '../src/scene/terrain/slabGeometry.ts'

function reader(buf) {
  const v = new DataView(buf)
  let o = 4
  return {
    u16: () => { const x = v.getUint16(o, true); o += 2; return x },
    u32: () => { const x = v.getUint32(o, true); o += 4; return x },
    f32: () => { const x = v.getFloat32(o, true); o += 4; return x },
    u8: () => { const x = v.getUint8(o); o += 1; return x },
  }
}
function readTerrain(buf) {
  const r = reader(buf)
  r.u16()
  const gridW = r.u16(), gridH = r.u16()
  const originX = r.f32(), originZ = r.f32(), dx = r.f32(), dz = r.f32(), minM = r.f32(), maxM = r.f32()
  const heights = new Float32Array(gridW * gridH)
  for (let i = 0; i < heights.length; i++) heights[i] = r.f32()
  return { gridW, gridH, originX, originZ, dx, dz, minM, maxM, heights }
}
function readBuildings(buf) {
  const r = reader(buf)
  r.u16()
  const count = r.u32()
  const out = []
  for (let b = 0; b < count; b++) {
    const pc = r.u16()
    r.f32(); r.u8(); r.u8()
    const ring = new Float32Array(pc * 2)
    for (let i = 0; i < pc * 2; i++) ring[i] = r.f32()
    out.push({ ring })
  }
  return out
}
function readRoads(buf) {
  const r = reader(buf)
  r.u16()
  const count = r.u32()
  const out = []
  for (let i = 0; i < count; i++) {
    r.u8(); r.u8()
    const pc = r.u16()
    const pts = new Float32Array(pc * 2)
    for (let p = 0; p < pc * 2; p++) pts[p] = r.f32()
    out.push({ pts })
  }
  return out
}

const A = 'public/data/city/'
const terrain = readTerrain(readFileSync(A + 'terrain.bin').buffer)
const buildings = readBuildings(readFileSync(A + 'buildings.bin').buffer)
const roads = readRoads(readFileSync(A + 'roads.bin').buffer)
const water = JSON.parse(readFileSync(A + 'water.json', 'utf8')).map((w) => ({
  elevation: w.elevation,
  outer: new Float32Array(w.outer.flat()),
  holes: w.holes.map((h) => new Float32Array(h.flat())),
}))
const parks = JSON.parse(readFileSync(A + 'parks.json', 'utf8')).map((p) => ({ ring: new Float32Array(p.ring.flat()) }))
const win = { south: 17.405, north: 17.445, west: 78.425, east: 78.485 }

const result = deriveCityBoundary(buildings, roads, water, parks, win)
const ground = new HeightField(terrain)
const slab = buildSlab(terrain, ground, result.boundary)
console.log('fallbackPieces (degenerate rim pieces):', slab.fallbackPieces)

// --- 1) area check ---
const top = slab.top
const pos = top.getAttribute('position')
const idx = top.getIndex()
let meshArea = 0
for (let t = 0; t < idx.count; t += 3) {
  const i0 = idx.getX(t) * 3, i1 = idx.getX(t + 1) * 3, i2 = idx.getX(t + 2) * 3
  const x1 = pos.array[i0], z1 = pos.array[i0 + 2]
  const x2 = pos.array[i1], z2 = pos.array[i1 + 2]
  const x3 = pos.array[i2], z3 = pos.array[i2 + 2]
  meshArea += Math.abs((x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1)) / 2
}
const ring = result.boundary.ring
let polyArea = 0
for (let i = 0; i < ring.length / 2; i++) {
  const j = (i + 1) % (ring.length / 2)
  polyArea += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1]
}
polyArea = Math.abs(polyArea) / 2
console.log('top mesh area km2:', (meshArea / 1e6).toFixed(2), ' island area km2:', (polyArea / 1e6).toFixed(2), ' ratio:', (meshArea / polyArea).toFixed(4))

// --- 2) drape alignment ---
const { minX, maxX, minZ, maxZ } = result.boundary
let worst = 0
let tested = 0
let seed = 12345
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
for (let s = 0; s < 4000; s++) {
  const x = minX + rand() * (maxX - minX)
  const z = minZ + rand() * (maxZ - minZ)
  if (!pointInRing(x, z, ring)) continue
  tested++
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t) * 3, i1 = idx.getX(t + 1) * 3, i2 = idx.getX(t + 2) * 3
    const x1 = pos.array[i0], z1 = pos.array[i0 + 2]
    const x2 = pos.array[i1], z2 = pos.array[i1 + 2]
    const x3 = pos.array[i2], z3 = pos.array[i2 + 2]
    const e1 = (x2 - x1) * (z - z1) - (z2 - z1) * (x - x1)
    const e2 = (x3 - x2) * (z - z2) - (z3 - z2) * (x - x2)
    const e3 = (x1 - x3) * (z - z3) - (z1 - z3) * (x - x3)
    const inside = (e1 >= 0 && e2 >= 0 && e3 >= 0) || (e1 <= 0 && e2 <= 0 && e3 <= 0)
    if (!inside) continue
    const area = (x2 - x1) * (z3 - z1) - (z2 - z1) * (x3 - x1)
    const w0 = ((x2 - x) * (z3 - z) - (z2 - z) * (x3 - x)) / area
    const w1 = ((x - x1) * (z3 - z1) - (z - z1) * (x3 - x1)) / area
    const w2 = 1 - w0 - w1
    const yMesh = w0 * pos.array[i0 + 1] + w1 * pos.array[i1 + 1] + w2 * pos.array[i2 + 1]
    const yDrape = ground.meshGroundY(x, z)
    worst = Math.max(worst, Math.abs(yMesh - yDrape))
    break
  }
}
console.log('drape alignment: worst |mesh - meshGroundY| over', tested, 'interior samples =', worst.toFixed(4), 'm')