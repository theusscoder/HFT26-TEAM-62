// Dev-time check: run deriveCityBoundary against the shipped assets and
// print diagnostics + an SVG outline preview (not part of the app build).
import { readFileSync, writeFileSync } from 'node:fs'
import { deriveCityBoundary, pointInRing } from '../src/geo/boundary.ts'

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

const buildings = readBuildings(readFileSync('public/data/city/buildings.bin').buffer)
const roads = readRoads(readFileSync('public/data/city/roads.bin').buffer)
const water = JSON.parse(readFileSync('public/data/city/water.json', 'utf8')).map((w) => ({
  outer: new Float32Array(w.outer.flat()),
  holes: [],
}))
const parks = JSON.parse(readFileSync('public/data/city/parks.json', 'utf8')).map((p) => ({ ring: new Float32Array(p.ring.flat()) }))
const window_ = { south: 17.405, north: 17.445, west: 78.425, east: 78.485 }

// Sweep the containment floor to find the most silhouette-like edge that
// still keeps essentially all buildings on the island.
const sweep = process.argv[2] === 'sweep'
const targets = sweep ? [0.97, 0.94, 0.9, 0.85, 0.8] : [0.9]
for (const target of targets) {
  console.time('derive')
  const result = deriveCityBoundary(buildings, roads, water, parks, window_, target)
  console.timeEnd('derive')
  if (!result) {
    console.log('DERIVATION FAILED for target', target)
    continue
  }
  const { boundary } = result
  const n = boundary.ring.length / 2
  let A = 0
  let P = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    A += boundary.ring[2 * i] * boundary.ring[2 * j + 1] - boundary.ring[2 * j] * boundary.ring[2 * i + 1]
    P += Math.hypot(boundary.ring[2 * j] - boundary.ring[2 * i], boundary.ring[2 * j + 1] - boundary.ring[2 * i + 1])
  }
  A = Math.abs(A) / 2
  const bw = boundary.maxX - boundary.minX
  const bd = boundary.maxZ - boundary.minZ
  let dropped = 0
  for (const b of buildings) {
    let cx = 0
    let cz = 0
    const k = b.ring.length / 2
    for (let i = 0; i < k; i++) { cx += b.ring[2 * i]; cz += b.ring[2 * i + 1] }
    if (!pointInRing(cx / k, cz / k, boundary.ring)) dropped++
  }
  console.log(
    `target ${(target * 100).toFixed(0)}% -> pts ${result.contourPoints}, containment ${(result.buildingContainment * 100).toFixed(1)}%, calibrated ${result.calibrated}, area ${(A / 1e6).toFixed(2)} km2, bbox ${(bw * bd / 1e6).toFixed(2)} km2, occupancy ${(A / (bw * bd) * 100).toFixed(0)}%, compactness ${(4 * Math.PI * A / (P * P)).toFixed(3)}, buildings dropped ${dropped}/${buildings.length}`,
  )
}
if (sweep) process.exit(0)

const result = deriveCityBoundary(buildings, roads, water, parks, window_)
const { boundary } = result
console.log('bounds x:', boundary.minX.toFixed(0), '..', boundary.maxX.toFixed(0), ' z:', boundary.minZ.toFixed(0), '..', boundary.maxZ.toFixed(0))

// Sanity: centroid + area
const n = boundary.ring.length / 2
let cx = 0, cz = 0
for (let i = 0; i < n; i++) { cx += boundary.ring[2 * i]; cz += boundary.ring[2 * i + 1] }
console.log('centroid:', (cx / n).toFixed(0), (cz / n).toFixed(0))
// Projection origin should be inside the island.
console.log('origin inside:', pointInRing(0, 0, boundary.ring))

// SVG preview (world x -> svg x, world z -> svg y).
const W = 800, H = Math.round((800 * (boundary.maxZ - boundary.minZ)) / (boundary.maxX - boundary.minX))
let d = ''
for (let i = 0; i < n; i++) {
  const x = ((boundary.ring[2 * i] - boundary.minX) / (boundary.maxX - boundary.minX)) * W
  const y = ((boundary.ring[2 * i + 1] - boundary.minZ) / (boundary.maxZ - boundary.minZ)) * H
  d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1)
}
d += 'Z'
const bld = buildings.slice(0, 24000).map((b) => {
  const cx2 = b.ring.reduce((s, v, i) => (i % 2 === 0 ? s + v : s), 0) / (b.ring.length / 2)
  const cz2 = b.ring.reduce((s, v, i) => (i % 2 === 1 ? s + v : s), 0) / (b.ring.length / 2)
  if (cx2 < boundary.minX || cx2 > boundary.maxX || cz2 < boundary.minZ || cz2 > boundary.maxZ) return null
  const x = ((cx2 - boundary.minX) / (boundary.maxX - boundary.minX)) * W
  const y = ((cz2 - boundary.minZ) / (boundary.maxZ - boundary.minZ)) * H
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="0.7" fill="#5ac8"/>`
}).filter(Boolean).join('')
writeFileSync('docs/screenshots/boundary-preview.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#0b1214"/><path d="${d}" fill="#123038" stroke="#4d8494" stroke-width="2"/>${bld}</svg>`)
console.log('svg -> docs/screenshots/boundary-preview.svg')