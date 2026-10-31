// City dataset types shared by the data service, geometry builders and scene.

export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'service',
] as const

export type RoadClass = (typeof ROAD_CLASSES)[number]

export const ROAD_CLASS_IDS: Record<number, RoadClass> = Object.fromEntries(
  ROAD_CLASSES.map((name, id) => [id, name]),
) as Record<number, RoadClass>

export const HEIGHT_SOURCES = ['estimated', 'levels', 'verified'] as const
export type BuildingHeightSource = (typeof HEIGHT_SOURCES)[number]

export interface BuildingRecord {
  osmId: number
  /** Footprint ring in local world metres, [x, z, x, z, ...], not closed. */
  ring: Float32Array
  /** Extrusion height in metres (may be estimated — see heightSource). */
  height: number
  /** 0..255, deterministic per OSM id — drives shade selection. */
  colorSeed: number
  heightSource: BuildingHeightSource
  /** Named city-scale use category (hotel, mall, hospital, government, …). */
  landmark: boolean
}

export interface RoadRecord {
  roadClass: RoadClass
  bridge: boolean
  /** Polyline in local world metres, [x, z, x, z, ...]. */
  pts: Float32Array
}

export interface WaterArea {
  /** Real elevation (metres ASL) of the surface — sampled from terrain data. */
  elevation: number
  /** Outer ring, [x, z, ...]. */
  outer: Float32Array
  holes: Float32Array[]
}

export interface ParkArea {
  ring: Float32Array
}

export interface TerrainData {
  gridW: number
  gridH: number
  /** World x of the NW node. */
  originX: number
  /** World z of the NW node. */
  originZ: number
  dx: number
  dz: number
  minM: number
  maxM: number
  heights: Float32Array
}

/** Subset of the manifest used by the UI (attribution / coverage notes). */
export interface CityManifest {
  schemaVersion: number
  generatedAt: string
  coverage: {
    kind: string
    south: number
    north: number
    west: number
    east: number
    note: string
  }
  counts: {
    buildings: {
      total: number
      estimated: number
      fromLevels: number
      verified: number
      landmarks?: number
    }
    roads: { total: number }
    waterAreas: number
    parks: number
  }
  sources: Array<{
    id: string
    name: string
    license: string
    attribution: string
  }>
}

export interface CityDataset {
  manifest: CityManifest
  terrain: TerrainData
  buildings: BuildingRecord[]
  roads: RoadRecord[]
  water: WaterArea[]
  parks: ParkArea[]
}