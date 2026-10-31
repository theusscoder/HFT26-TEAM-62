// ---------------------------------------------------------------------------
// Dev-time processor: raw Overpass + Terrarium cache (data/raw/) -> compact
// committed assets (public/data/city/) plus a source/licence manifest.
//
// Design notes
//   - Rings are simplified conservatively (Douglas-Peucker, <1 m) so building
//     footprints, junction shapes and geographic relationships survive.
//   - Small buildings are NOT dropped by size. Only degenerate geometry
//     (< 3 distinct points or < 6 m^2 after simplification) is discarded,
//     because it renders as noise and z-fights at diorama scale.
//   - Heights: OSM `height` where tagged, else `building:levels` x 3.2 m,
//     else a deterministic estimate keyed on OSM id + footprint area. The
//     source of every building's height is stored in the asset (flag byte)
//     and summarised in the manifest. Estimates are estimates.
//   - Elevation is stored as real metres; artistic exaggeration is applied at
//     runtime (cityConfig) so it can be tuned without reprocessing.
//
// Output contract is versioned (magic "HCV1"); the runtime reader validates it.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { toWorld, toLatLng, METRES_PER_DEG_LAT, METRES_PER_DEG_LNG, PROJECTION_ORIGIN } from '../src/geo/projection.ts'

const DATA_RAW = process.env.DATA_RAW ?? 'data/raw'
const OUT_DIR = 'public/data/city'
mkdirSync(OUT_DIR, { recursive: true })

// --- geographic constants (must match cityConfig.ts at runtime) --------------

const FULL_WINDOW = { south: 17.36, north: 17.50, west: 78.33, east: 78.51 }
const SAMPLE = { south: 17.405, north: 17.445, west: 78.425, east: 78.485 }

const BUILDING_EPS_M = 0.7
const ROAD_EPS_M = 1.0
const TERRAIN_Z = 12
const TERRAIN_GRID_W = 192
const TERRAIN_GRID_H = 144

const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'service',
]
const ROAD_CLASS_ID = Object.fromEntries(ROAD_CLASSES.map((c, i) => [c, i]))

// --- small geometry helpers ---------------------------------------------------

/** OSM `out geom` nodes use `lon`; the projection uses `lng`. */
function nodeToWorld(g) {
  return toWorld({ lat: g.lat, lng: g.lon })
}

function signedArea(points) {
  let a = 0
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i]
    const q = points[(i + 1) % n]
    a += p.x * q.z - q.x * p.z
  }
  return a / 2
}

function centroidOf(points) {
  let sx = 0
  let sz = 0
  for (const p of points) {
    sx += p.x
    sz += p.z
  }
  return { x: sx / points.length, z: sz / points.length }
}

/** Douglas-Peucker, squared-distance based, first == last point kept only once. */
function simplify(points, eps) {
  const n = points.length
  if (n <= 3) return points.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const A = points[a]
    const B = points[b]
    const dx = B.x - A.x
    const dz = B.z - A.z
    const len2 = dx * dx + dz * dz
    let maxD = -1
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const p = points[i]
      let t = len2 === 0 ? 0 : ((p.x - A.x) * dx + (p.z - A.z) * dz) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const ex = A.x + t * dx - p.x
      const ez = A.z + t * dz - p.z
      const d = ex * ex + ez * ez
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
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

/** Remove trailing duplicate of the first point, consecutive duplicates. */
function cleanRing(points) {
  const out = []
  for (const p of points) {
    const prev = out[out.length - 1]
    if (!prev || prev.x !== p.x || prev.z !== p.z) out.push(p)
  }
  if (out.length > 1) {
    const first = out[0]
    const last = out[out.length - 1]
    if (first.x === last.x && first.z === last.z) out.pop()
  }
  return out
}

function splitmix32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x9e3779b9) | 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t = t ^ (t >>> 15)
    t = Math.imul(t, 0x735a2d97)
    t = t ^ (t >>> 15)
    return (t >>> 0) / 4_294_967_296
  }
}

/**
 * Deterministic height estimate keyed on the OSM way id and footprint area.
 * Method is deliberately boring and biased towards low-rise stock, with a
 * small share of mid-rise outliers — and it is DETERMINISTIC: the same input
 * data always yields the same heights.
 */
function estimateHeight(osmId, areaM2) {
  const rand = splitmix32(osmId)
  const r1 = rand()
  const r2 = rand()
  let h
  if (areaM2 > 4000) {
    // Large footprints read as commercial / institutional blocks.
    h = 6 + 26 * r2
  } else if (areaM2 > 1200) {
    h = 5 + 14 * r2
  } else {
    h = 3.4 + 4.2 * r1
    if (r2 > 0.93) h += 8 + 6 * r1 // occasional mid-rise
  }
  return Math.min(Math.max(h, 3), 42)
}

/**
 * Building-type height priors for OSM-typed buildings (metres, low-rise
 * biased). These are ESTIMATES informed by the mapped use of the building —
 * a mapped hotel is taller than a mapped hut — not surveyed data.
 */
const HEIGHT_PRIORS = [
  { match: (t) => ['house', 'detached', 'bungalow', 'garage', 'hut', 'shed', 'roof', 'carport', 'terrace'].includes(t.building), min: 3, max: 6.5 },
  { match: (t) => ['temple', 'mosque', 'church', 'place_of_worship'].includes(t.building) || t.amenity === 'place_of_worship', min: 4, max: 12 },
  { match: (t) => ['apartments', 'residential', 'dormitory'].includes(t.building), min: 6, max: 21 },
  { match: (t) => t.shop === 'mall', min: 10, max: 24 },
  { match: (t) => ['retail', 'supermarket', 'commercial', 'office'].includes(t.building) || ['retail', 'supermarket', 'commercial', 'office'].includes(t.amenity), min: 6, max: 18 },
  { match: (t) => t.building === 'hotel' || t.tourism === 'hotel', min: 12, max: 33 },
  { match: (t) => t.building === 'hospital' || t.amenity === 'hospital' || t.amenity === 'clinic', min: 12, max: 30 },
  { match: (t) => ['school', 'kindergarten', 'college', 'educational_institution', 'university'].includes(t.building), min: 5, max: 14 },
  { match: (t) => ['government', 'public', 'police', 'fire_station', 'train_station'].includes(t.building) || ['government', 'police', 'train_station'].includes(t.amenity), min: 8, max: 20 },
  { match: (t) => ['industrial', 'warehouse', 'garages', 'service'].includes(t.building), min: 5, max: 12 },
  { match: (t) => ['cinema', 'theatre', 'museum', 'attraction'].includes(t.building) || ['cinema', 'theatre', 'museum', 'attraction'].includes(t.amenity) || t.tourism === 'attraction', min: 6, max: 16 },
]

/** Deterministic estimate from a type prior (spread across the prior band). */
function estimateHeightFromPrior(osmId, prior) {
  const rand = splitmix32(osmId)
  const r = rand()
  return Math.min(Math.max(prior.min + (prior.max - prior.min) * r, prior.min), prior.max)
}

/**
 * Landmark categories: named buildings whose mapped use is recognisable at
 * city scale (hotels, malls, hospitals, government seats, places of worship,
 * stations, cinemas, banks). Drives the accent-material landmark tier.
 */
const LANDMARK_CATEGORIES = [
  (t) => t.building === 'hotel' || t.tourism === 'hotel' || t.amenity === 'hotel',
  (t) => t.shop === 'mall',
  (t) => t.building === 'hospital' || t.amenity === 'hospital' || t.amenity === 'clinic',
  (t) => ['government', 'public', 'police', 'fire_station', 'train_station'].includes(t.building) || ['government', 'police', 'train_station'].includes(t.amenity),
  (t) => ['temple', 'mosque', 'church', 'place_of_worship'].includes(t.building) || t.amenity === 'place_of_worship',
  (t) => ['cinema', 'theatre', 'museum', 'attraction'].includes(t.building) || ['cinema', 'theatre', 'museum', 'attraction'].includes(t.amenity) || t.tourism === 'attraction',
  (t) => t.building === 'bank' || t.amenity === 'bank',
]

function isLandmark(tags) {
  if (!tags.name) return false
  return LANDMARK_CATEGORIES.some((match) => match(tags))
}

function parseHeightMeters(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^\s*(\d+(?:\.\d+)?)\s*m?\s*$/i)
  return m ? Number(m[1]) : null
}

function parseLevels(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
  return m ? Number(m[1]) : null
}

// --- OSM loading ---------------------------------------------------------------

console.log('[process] reading raw OSM cache …')

const buildingFiles = readdirSync(join(DATA_RAW, 'osm'))
  .filter((f) => f.startsWith('buildings-'))
  .sort()
const seenIds = new Set()
const buildings = []
let droppedOutside = 0
let droppedDegenerate = 0
let droppedNonBuilding = 0

for (const file of buildingFiles) {
  const json = JSON.parse(readFileSync(join(DATA_RAW, 'osm', file), 'utf8'))
  for (const el of json.elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue
    if (seenIds.has(el.id)) continue
    seenIds.add(el.id)

    const tags = el.tags ?? {}
    const kind = tags.building
    if (kind === 'no' || kind === 'construction') {
      droppedNonBuilding++
      continue
    }

    let pts = cleanRing(el.geometry.map(nodeToWorld))
    if (signedArea(pts) < 0) pts.reverse() // consistent winding
    if (pts.length < 3) {
      droppedDegenerate++
      continue
    }
    const c = centroidOf(pts)
    const ll = toLatLng(c)
    if (ll.lat < SAMPLE.south || ll.lat > SAMPLE.north || ll.lng < SAMPLE.west || ll.lng > SAMPLE.east) {
      droppedOutside++
      continue
    }

    pts = simplify(pts, BUILDING_EPS_M)
    if (pts.length < 3 || Math.abs(signedArea(pts)) < 6) {
      droppedDegenerate++
      continue
    }

    let height
    let source
    let landmark = 0
    const tagged = parseHeightMeters(tags.height)
    const levels = parseLevels(tags['building:levels'])
    // Height-tag sanity: a tagged height wildly implausible for the tagged
    // level count (e.g. "90" m on a mapped 4-level block) is junk data —
    // prefer the levels-derived value in that case.
    const taggedPlausible =
      tagged === null ||
      levels === null ||
      levels <= 0 ||
      tagged / levels <= 4.6
    if (tagged !== null && taggedPlausible) {
      height = Math.min(Math.max(tagged, 3), 120)
      source = 2 // verified
    } else if (levels !== null && levels > 0) {
      height = levels * 3.2 + 1.2
      source = 1 // derived from levels
    } else {
      const prior = HEIGHT_PRIORS.find((p) => p.match(tags))
      if (prior) {
        height = estimateHeightFromPrior(el.id, prior)
      } else {
        height = estimateHeight(el.id, Math.abs(signedArea(pts)))
      }
      source = 0 // estimated
    }
    if (isLandmark(tags)) landmark = 1

    const rand = splitmix32(el.id ^ 0x51ed)
    buildings.push({
      id: el.id,
      pts,
      height,
      source,
      landmark,
      colorSeed: Math.floor(rand() * 256),
    })
  }
}

console.log(`[osm] buildings kept: ${buildings.length} (outside window: ${droppedOutside}, degenerate: ${droppedDegenerate}, non-building: ${droppedNonBuilding})`)

// --- roads / water / parks -------------------------------------------------

const networkJson = JSON.parse(readFileSync(join(DATA_RAW, 'osm', 'network.json'), 'utf8'))

const roads = []
const roadClassCounts = {}
for (const el of networkJson.elements) {
  if (el.type !== 'way' || !Array.isArray(el.geometry)) continue
  const hw = el.tags?.['highway']
  const classId = ROAD_CLASS_ID[hw]
  if (classId === undefined) continue
  if (el.tags?.tunnel === 'yes') continue // inside terrain, not rendered
  let pts = el.geometry.map(nodeToWorld)
  pts = simplify(pts, ROAD_EPS_M)
  if (pts.length < 2) continue
  roads.push({
    classId,
    bridge: el.tags?.bridge != null ? 1 : 0,
    pts,
  })
  roadClassCounts[hw] = (roadClassCounts[hw] ?? 0) + 1
}
console.log(`[osm] roads kept: ${roads.length}`, roadClassCounts)

/** Stitch open ways into closed rings (for multipolygon members). */
function assembleRings(ways) {
  const closed = []
  const open = []
  for (const w of ways) {
    let pts = cleanRing(w.pts)
    if (pts.length < 3) continue
    if (signedArea(pts) < 0) pts.reverse()
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (first.x === last.x && first.z === last.z) {
      pts.pop()
      closed.push(pts)
    } else {
      open.push(pts)
    }
  }
  // Greedy endpoint stitching for ring fragments.
  while (open.length > 0) {
    let chain = open.shift()
    let extended = true
    while (extended) {
      extended = false
      for (let i = 0; i < open.length; i++) {
        const cand = open[i]
        const chainEnd = chain[chain.length - 1]
        const chainStart = chain[0]
        if (chainEnd.x === cand[0].x && chainEnd.z === cand[0].z) {
          chain = chain.concat(cand.slice(1))
          open.splice(i, 1)
          extended = true
          break
        }
        if (chainStart.x === cand[cand.length - 1].x && chainStart.z === cand[cand.length - 1].z) {
          chain = cand.slice(0, -1).concat(chain)
          open.splice(i, 1)
          extended = true
          break
        }
      }
    }
    const first = chain[0]
    const last = chain[chain.length - 1]
    if (first.x === last.x && first.z === last.z) chain.pop()
    if (chain.length >= 3) closed.push(chain)
  }
  return closed
}

function wayToPoints(el) {
  return { pts: el.geometry.map(nodeToWorld), id: el.id }
}

const waterAreas = []
const parkAreas = []

for (const el of networkJson.elements) {
  if (el.type === 'way' && el.tags?.natural === 'water') {
    const rings = assembleRings([wayToPoints(el)])
    for (const ring of rings) if (ring.length >= 3) waterAreas.push({ outer: ring, holes: [] })
  }
  if (el.type === 'way' && el.tags?.leisure === 'park') {
    const rings = assembleRings([wayToPoints(el)])
    for (const ring of rings) if (ring.length >= 3) parkAreas.push({ ring })
  }
}

// Relations (multipolygons) — Hussain Sagar arrives this way.
for (const el of networkJson.elements) {
  if (el.type !== 'relation' || !Array.isArray(el.members)) continue
  const outerWays = []
  const innerWays = []
  for (const m of el.members) {
    if (m.type !== 'way' || !Array.isArray(m.geometry)) continue
    const entry = { pts: m.geometry.map(nodeToWorld), id: m.ref }
    if (m.role === 'inner') innerWays.push(entry)
    else outerWays.push(entry)
  }
  if (el.tags?.natural === 'water') {
    for (const outer of assembleRings(outerWays)) waterAreas.push({ outer, holes: assembleRings(innerWays) })
  } else if (el.tags?.leisure === 'park') {
    for (const outer of assembleRings(outerWays)) parkAreas.push({ ring: outer })
  }
}

console.log(`[osm] water polygons: ${waterAreas.length} (holes total: ${waterAreas.reduce((a, w) => a + w.holes.length, 0)}), parks: ${parkAreas.length}`)

// --- terrain heightfield ----------------------------------------------------

console.log('[terrain] decoding terrarium tiles …')
const tileDir = join(DATA_RAW, 'terrarium')
const tileFiles = readdirSync(tileDir).filter((f) => f.endsWith('.png'))
const tiles = new Map()
for (const f of tileFiles) {
  const [z, x, y] = f.replace('.png', '').split('_').map(Number)
  const png = PNG.sync.read(readFileSync(join(tileDir, f)))
  tiles.set(`${z}/${x}/${y}`, png)
}

function elevationAt(lng, lat) {
  // Mercator tile math
  const n = 2 ** TERRAIN_Z
  const xf = ((lng + 180) / 360) * n
  const rad = (lat * Math.PI) / 180
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  const tx = Math.floor(xf)
  const ty = Math.floor(yf)
  const key = `${TERRAIN_Z}/${tx}/${ty}`
  const png = tiles.get(key)
  if (!png) return null
  const px = Math.min(255, Math.max(0, (xf - tx) * 256))
  const py = Math.min(255, Math.max(0, (yf - ty) * 256))
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const x1 = Math.min(255, x0 + 1)
  const y1 = Math.min(255, y0 + 1)
  const fx = px - x0
  const fy = py - y0
  const sample = (x, y) => {
    const i = (y * png.width + x) * 4
    return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768
  }
  const e00 = sample(x0, y0)
  const e10 = sample(x1, y0)
  const e01 = sample(x0, y1)
  const e11 = sample(x1, y1)
  return e00 * (1 - fx) * (1 - fy) + e10 * fx * (1 - fy) + e01 * (1 - fx) * fy + e11 * fx * fy
}

// Node grid spans the FULL window exactly (used for the slab + draping).
const westX = FULL_WINDOW.west
const eastX = FULL_WINDOW.east
const northLat = FULL_WINDOW.north
const southLat = FULL_WINDOW.south
const nw = toWorld({ lat: northLat, lng: westX })
const se = toWorld({ lat: southLat, lng: eastX })
const gridW = TERRAIN_GRID_W
const gridH = TERRAIN_GRID_H
const dx = (se.x - nw.x) / (gridW - 1)
const dz = (se.z - nw.z) / (gridH - 1)
const heights = new Float32Array(gridW * gridH)
let hMin = Infinity
let hMax = -Infinity
for (let j = 0; j < gridH; j++) {
  for (let i = 0; i < gridW; i++) {
    const x = nw.x + i * dx
    const z = nw.z + j * dz
    const ll = toLatLng({ x, z })
    // 2x2 subsamples smooth pixel noise slightly.
    let sum = 0
    let count = 0
    for (const [ox, oz] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ]) {
      const e = elevationAt(ll.lng + ((ox - 0.5) * dx) / METRES_PER_DEG_LNG, ll.lat - ((oz - 0.5) * dz) / METRES_PER_DEG_LAT)
      if (e !== null) {
        sum += e
        count++
      }
    }
    const h = count > 0 ? sum / count : 0
    heights[j * gridW + i] = h
    if (h < hMin) hMin = h
    if (h > hMax) hMax = h
  }
}
console.log(`[terrain] grid ${gridW}x${gridH}, elevation ${hMin.toFixed(1)}–${hMax.toFixed(1)} m (relief ${(hMax - hMin).toFixed(1)} m)`)

// Water surface level. SRTM-style rasters return the WATER SURFACE elevation
// for lakes, so the polygon interior (centroid) is the best estimate. Shore
// ring pixels sit on land, so they are only a fallback (10th percentile).
for (const area of waterAreas) {
  let cx = 0
  let cz = 0
  for (const p of area.outer) {
    cx += p.x
    cz += p.z
  }
  cx /= area.outer.length
  cz /= area.outer.length
  const ll = toLatLng({ x: cx, z: cz })
  const interior = elevationAt(ll.lng, ll.lat)
  const ringSamples = []
  for (const p of area.outer) {
    const rll = toLatLng(p)
    const e = elevationAt(rll.lng, rll.lat)
    if (e !== null) ringSamples.push(e)
  }
  ringSamples.sort((a, b) => a - b)
  const ringP10 = ringSamples.length ? ringSamples[Math.floor(ringSamples.length * 0.1)] : hMin
  if (interior !== null) {
    area.elevation = (interior + ringP10) / 2
  } else {
    area.elevation = ringP10
  }
}

// --- writers ----------------------------------------------------------------

function writeBinary(path, magic, writeBody) {
  const magicBytes = new Uint8Array([...magic].map((c) => c.charCodeAt(0)))
  const chunks = [magicBytes]
  let total = magicBytes.length
  const w = {
    u8: (v) => {
      const b = new Uint8Array([v & 0xff])
      chunks.push(b)
      total += 1
    },
    u16: (v) => {
      const b = new Uint8Array(2)
      new DataView(b.buffer).setUint16(0, v, true)
      chunks.push(b)
      total += 2
    },
    u32: (v) => {
      const b = new Uint8Array(4)
      new DataView(b.buffer).setUint32(0, v, true)
      chunks.push(b)
      total += 4
    },
    f32: (v) => {
      const b = new Uint8Array(4)
      new DataView(b.buffer).setFloat32(0, v, true)
      chunks.push(b)
      total += 4
    },
  }
  writeBody(w)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  writeFileSync(path, out)
  console.log(`[write] ${path} — ${(total / 1024).toFixed(0)} KB`)
}

// buildings.bin — v2 adds the landmark flag byte.
writeBinary(join(OUT_DIR, 'buildings.bin'), 'HCV1', (w) => {
  w.u16(2)
  w.u32(buildings.length)
  for (const b of buildings) {
    w.u16(b.pts.length)
    w.f32(b.height)
    w.u8(b.colorSeed)
    w.u8(b.source)
    w.u8(b.landmark)
    for (const p of b.pts) {
      w.f32(p.x)
      w.f32(p.z)
    }
  }
})

// roads.bin
writeBinary(join(OUT_DIR, 'roads.bin'), 'HCV1', (w) => {
  w.u16(1)
  w.u32(roads.length)
  for (const r of roads) {
    w.u8(r.classId)
    w.u8(r.bridge)
    w.u16(r.pts.length)
    for (const p of r.pts) {
      w.f32(p.x)
      w.f32(p.z)
    }
  }
})

// terrain.bin
writeBinary(join(OUT_DIR, 'terrain.bin'), 'HCV1', (w) => {
  w.u16(1)
  w.u16(gridW)
  w.u16(gridH)
  w.f32(nw.x)
  w.f32(nw.z)
  w.f32(dx)
  w.f32(dz)
  w.f32(hMin)
  w.f32(hMax)
  for (let i = 0; i < heights.length; i++) w.f32(heights[i])
})

// water.json / parks.json (small, human-checkable)
const roundPt = (p) => [Math.round(p.x * 4) / 4, Math.round(p.z * 4) / 4]
const water = waterAreas.map((a) => ({
  elevation: Math.round(a.elevation * 10) / 10,
  outer: a.outer.map(roundPt),
  holes: a.holes.map((h) => h.map(roundPt)),
}))
writeFileSync(join(OUT_DIR, 'water.json'), JSON.stringify(water))
console.log(`[write] water.json — ${(JSON.stringify(water).length / 1024).toFixed(0)} KB`)

const parks = parkAreas.map((p) => ({ ring: p.ring.map(roundPt) }))
writeFileSync(join(OUT_DIR, 'parks.json'), JSON.stringify(parks))
console.log(`[write] parks.json — ${(JSON.stringify(parks).length / 1024).toFixed(0)} KB`)

// --- manifest ----------------------------------------------------------------

const sourceCounts = { estimated: 0, fromLevels: 0, verified: 0 }
let landmarkCount = 0
for (const b of buildings) {
  if (b.source === 2) sourceCounts.verified++
  else if (b.source === 1) sourceCounts.fromLevels++
  else sourceCounts.estimated++
  if (b.landmark) landmarkCount++
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  coverage: {
    kind: 'phase2-sample',
    south: SAMPLE.south,
    north: SAMPLE.north,
    west: SAMPLE.west,
    east: SAMPLE.east,
    note: 'Representative sample area around Hussain Sagar / Banjara Hills used for Phase 2 validation. This is a subset of the approved city window — NOT the full urban coverage area and NOT the GHMC boundary.',
  },
  fullWindow: FULL_WINDOW,
  projection: {
    origin: PROJECTION_ORIGIN,
    metresPerDegLat: METRES_PER_DEG_LAT,
    metresPerDegLng: METRES_PER_DEG_LNG,
  },
  sources: [
    {
      id: 'osm',
      name: 'OpenStreetMap via Overpass API',
      license: 'ODbL 1.0',
      attribution: '(c) OpenStreetMap contributors',
      fetchedAt: new Date().toISOString().slice(0, 10),
    },
    {
      id: 'terrarium',
      name: 'AWS Terrain Tiles (Terrarium encoding), zoom 12',
      license: 'Public domain (SRTM / USGS / NASA via Mapzen)',
      attribution: 'Elevation: NASA SRTM / USGS via Mapzen Terrarium tiles',
      tiles: tileFiles.map((f) => `${TERRAIN_Z}/${f.replace('.png', '').split('_')[1]}/${f.replace('.png', '').split('_')[2]}`),
    },
  ],
  terrain: {
    gridW,
    gridH,
    minElevationM: Math.round(hMin * 10) / 10,
    maxElevationM: Math.round(hMax * 10) / 10,
    storage: 'real metres; exaggeration applied at runtime (cityConfig.terrainExaggeration)',
  },
  counts: {
    buildings: {
      total: buildings.length,
      ...sourceCounts,
      landmarks: landmarkCount,
      droppedOutside,
      droppedDegenerate,
      droppedNonBuilding,
    },
    roads: { total: roads.length, byClass: roadClassCounts },
    waterAreas: waterAreas.length,
    parks: parkAreas.length,
  },
  simplification: { buildingsEpsM: BUILDING_EPS_M, roadsEpsM: ROAD_EPS_M, note: 'conservative; footprints and junction shapes preserved' },
  heightEstimation: {
    method: 'OSM height tag (plausibility-checked against building:levels) > building:levels x 3.2 m + 1.2 > deterministic estimate from mapped building type, else OSM way id + footprint area',
    note: 'Estimated heights are approximations, NOT surveyed data. Verified heights cover a small fraction of buildings.',
  },
  landmarks: {
    definition: 'Named OSM buildings with a city-scale use category (hotel, mall, hospital, government, place of worship, station, cinema, bank)',
    note: 'Landmark flag marks recognisable geography; it does not alter heights.',
  },
}
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('[write] manifest.json')
console.log(`[summary] buildings ${buildings.length} (verified ${sourceCounts.verified}, levels ${sourceCounts.fromLevels}, estimated ${sourceCounts.estimated})`)
console.log('[done]')