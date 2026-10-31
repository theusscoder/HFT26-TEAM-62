// Loads the processed city dataset from static assets. Single seam between the
// 3D scene and the processed data files; if the pipeline re-runs, only these
// files change, never the scene code.

import { ASSET_BASE } from '../../config/cityConfig'
import type { CityDataset, CityManifest, WaterArea, ParkArea } from '../../types/city'
import { readBuildings, readRoads, readTerrain } from './format'

async function fetchArrayBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

/** Flat numeric JSON arrays -> Float32Array [x, z, ...]. */
function flatToRing(flat: number[]): Float32Array {
  return new Float32Array(flat)
}

/** Raw (JSON) shapes of the small polygon assets. */
interface RawWaterArea {
  elevation: number
  outer: number[][]
  holes: number[][]
}

interface RawParkArea {
  ring: number[][]
}

export async function loadCityData(): Promise<CityDataset> {
  const manifest = await fetchJson<CityManifest>(`${ASSET_BASE}/manifest.json`)

  const [terrainBuf, buildingsBuf, roadsBuf, waterJson, parksJson] = await Promise.all([
    fetchArrayBuffer(`${ASSET_BASE}/terrain.bin`),
    fetchArrayBuffer(`${ASSET_BASE}/buildings.bin`),
    fetchArrayBuffer(`${ASSET_BASE}/roads.bin`),
    fetchJson<RawWaterArea[]>(`${ASSET_BASE}/water.json`),
    fetchJson<RawParkArea[]>(`${ASSET_BASE}/parks.json`),
  ])

  const terrain = readTerrain(terrainBuf)
  const buildings = readBuildings(buildingsBuf)
  const roads = readRoads(roadsBuf)

  const water: WaterArea[] = waterJson.map((w) => ({
    elevation: w.elevation,
    outer: flatToRing(w.outer.flat()),
    holes: w.holes.map((h) => flatToRing(h.flat())),
  }))

  const parks: ParkArea[] = parksJson.map((p) => ({ ring: flatToRing(p.ring.flat()) }))

  // Basic sanity — a mismatch here means the pipeline and reader drifted apart.
  const total = manifest.counts.buildings.total
  if (total !== buildings.length) {
    throw new Error(`manifest/buildings mismatch: ${total} != ${buildings.length} — re-run the processor`)
  }

  return { manifest, terrain, buildings, roads, water, parks }
}