// ---------------------------------------------------------------------------
// Dev-time data fetch for the Phase 2 representative sample.
//
// Downloads (into the gitignored data/raw/ cache):
//   1. OSM geometry for the sample window (buildings by quadrant, plus
//      roads / water / parks) via the Overpass API.
//   2. Terrarium elevation tiles covering the FULL approved city window.
//
// This script is development tooling only — the application never contacts
// Overpass at runtime. Raw files are processed by process-sample-data.mjs.
//
// License/attribution (surfaced in the generated manifest + app UI):
//   - OpenStreetMap data: © OpenStreetMap contributors, ODbL 1.0.
//   - Terrarium tiles: Mapzen / NASA SRTM / USGS, public domain.
// ---------------------------------------------------------------------------

import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DATA_RAW = process.env.DATA_RAW ?? 'data/raw'
mkdirSync(join(DATA_RAW, 'osm'), { recursive: true })
mkdirSync(join(DATA_RAW, 'terrarium'), { recursive: true })

// The FULL approved geographic window (projection domain for the slab).
export const FULL_WINDOW = { south: 17.36, north: 17.50, west: 78.33, east: 78.51 }

// Phase 2 representative sample coverage (a subset, NOT the whole window).
const SAMPLE = { south: 17.405, north: 17.445, west: 78.425, east: 78.485 }

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
const UA = 'hyderabad-accident-visualiser/0.1 (dev-time data prep; contact: local dev)'

async function overpass(query, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[(attempt - 1) % OVERPASS_ENDPOINTS.length]
    process.stdout.write(`[fetch] ${label} (attempt ${attempt}, ${new URL(endpoint).host}) … `)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
        signal: AbortSignal.timeout(300_000),
      })
      if (res.status === 429 || res.status >= 500) {
        console.warn(`HTTP ${res.status} — will retry`)
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      } else {
        const text = await res.text()
        if (!text.trimStart().startsWith('{')) throw new Error(`non-JSON response: ${text.slice(0, 120)}`)
        const json = JSON.parse(text)
        console.log(`ok (${text.length.toLocaleString()} bytes, ${json.elements.length} elements)`)
        return json
      }
    } catch (err) {
      console.warn(`${err.message}`)
    }
    const backoff = 15_000 * 2 ** (attempt - 1)
    await new Promise((r) => setTimeout(r, backoff))
  }
  throw new Error(`Overpass query failed after retries: ${label}`)
}

function buildingQuery(bbox) {
  return `[out:json][timeout:180];
way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out geom;`
}

function networkQuery(bbox) {
  return `[out:json][timeout:180];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)$"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}); out geom;
way["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}); out geom;
relation["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}); out geom;
way["leisure"="park"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}); out geom;
relation["leisure"="park"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}); out geom;`
}

// --- Terrarium tile helpers -------------------------------------------------

function lngToTileX(lng, z) {
  return Math.floor(((lng + 180) / 360) * 2 ** z)
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}

async function fetchTerrarium(z, x, y) {
  const file = join(DATA_RAW, 'terrarium', `${z}_${x}_${y}.png`)
  if (existsSync(file) && statSync(file).size > 1000) {
    console.log(`[terrarium] ${z}/${x}/${y} — cached`)
    return
  }
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
  process.stdout.write(`[terrarium] ${z}/${x}/${y} … `)
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`terrarium HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(file, buf)
  console.log(`ok (${buf.length.toLocaleString()} bytes)`)
}

// --- main --------------------------------------------------------------------

// --- main --------------------------------------------------------------------

async function main() {
  const what = process.argv[2] ?? 'all'

  if (what === 'all' || what === 'osm') {
    const rows = 2
    const cols = 2
    let qIndex = 1
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bbox = {
          south: SAMPLE.south + ((SAMPLE.north - SAMPLE.south) * r) / rows,
          north: SAMPLE.south + ((SAMPLE.north - SAMPLE.south) * (r + 1)) / rows,
          west: SAMPLE.west + ((SAMPLE.east - SAMPLE.west) * c) / cols,
          east: SAMPLE.west + ((SAMPLE.east - SAMPLE.west) * (c + 1)) / cols,
        }
        const json = await overpass(buildingQuery(bbox), `buildings q${qIndex}`)
        writeFileSync(join(DATA_RAW, 'osm', `buildings-q${qIndex}.json`), JSON.stringify(json))
        await new Promise((res) => setTimeout(res, 3000))
        qIndex++
      }
    }

    const net = await overpass(networkQuery(SAMPLE), 'roads / water / parks')
    writeFileSync(join(DATA_RAW, 'osm', 'network.json'), JSON.stringify(net))
  }

  if (what === 'all' || what === 'terrarium') {
    const z = 12
    const x0 = lngToTileX(FULL_WINDOW.west, z)
    const x1 = lngToTileX(FULL_WINDOW.east, z)
    const y0 = latToTileY(FULL_WINDOW.north, z)
    const y1 = latToTileY(FULL_WINDOW.south, z)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        await fetchTerrarium(z, x, y)
      }
    }
    console.log(`[terrarium] tiles covering full window: z${z} x${x0}-${x1} y${y0}-${y1}`)
  }

  console.log('\n[done] raw cache ready in data/raw/')
}

main().catch((err) => {
  console.error(`\n[error] ${err.message}`)
  process.exit(1)
})