// Readers for the compact processed assets emitted by the dev-time processor
// (scripts/process-sample-data.mjs). Format contract: magic "HCV1" + version.

import {
  ROAD_CLASS_IDS,
  type BuildingRecord,
  type RoadRecord,
  type TerrainData,
  type BuildingHeightSource,
} from '../../types/city'

class Reader {
  readonly view: DataView
  private off = 0

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
  }

  get remaining(): number {
    return this.view.byteLength - this.off
  }

  magic(expected: string): void {
    for (let i = 0; i < 4; i++) {
      if (this.view.getUint8(this.off++) !== expected.charCodeAt(i)) {
        throw new Error(`asset format mismatch: expected magic "${expected}"`)
      }
    }
  }

  u16(): number {
    const v = this.view.getUint16(this.off, true)
    this.off += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.off, true)
    this.off += 4
    return v
  }

  u8(): number {
    return this.view.getUint8(this.off++)
  }

  f32(): number {
    const v = this.view.getFloat32(this.off, true)
    this.off += 4
    return v
  }
}

export function readBuildings(buffer: ArrayBuffer): BuildingRecord[] {
  const r = new Reader(buffer)
  r.magic('HCV1')
  const version = r.u16()
  if (version !== 1 && version !== 2) throw new Error(`unsupported buildings.bin version ${version}`)
  const count = r.u32()
  const buildings: BuildingRecord[] = new Array(count)
  const sources: BuildingHeightSource[] = ['estimated', 'levels', 'verified']
  for (let b = 0; b < count; b++) {
    const pointCount = r.u16()
    const height = r.f32()
    const colorSeed = r.u8()
    const source = r.u8()
    const landmark = version >= 2 ? r.u8() === 1 : false
    const ring = new Float32Array(pointCount * 2)
    for (let i = 0; i < ring.length; i++) ring[i] = r.f32()
    buildings[b] = {
      osmId: b,
      ring,
      height,
      colorSeed,
      heightSource: sources[source] ?? 'estimated',
      landmark,
    }
  }
  if (r.remaining !== 0) throw new Error('buildings.bin has trailing bytes — format mismatch')
  return buildings
}

export function readRoads(buffer: ArrayBuffer): RoadRecord[] {
  const r = new Reader(buffer)
  r.magic('HCV1')
  const version = r.u16()
  if (version !== 1) throw new Error(`unsupported roads.bin version ${version}`)
  const count = r.u32()
  const roads: RoadRecord[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const classId = r.u8()
    const bridge = r.u8() === 1
    const pointCount = r.u16()
    const pts = new Float32Array(pointCount * 2)
    for (let p = 0; p < pts.length; p++) pts[p] = r.f32()
    const roadClass = ROAD_CLASS_IDS[classId]
    if (!roadClass) throw new Error(`unknown road class id ${classId}`)
    roads[i] = { roadClass, bridge, pts }
  }
  if (r.remaining !== 0) throw new Error('roads.bin has trailing bytes — format mismatch')
  return roads
}

export function readTerrain(buffer: ArrayBuffer): TerrainData {
  const r = new Reader(buffer)
  r.magic('HCV1')
  const version = r.u16()
  if (version !== 1) throw new Error(`unsupported terrain.bin version ${version}`)
  const gridW = r.u16()
  const gridH = r.u16()
  const originX = r.f32()
  const originZ = r.f32()
  const dx = r.f32()
  const dz = r.f32()
  const minM = r.f32()
  const maxM = r.f32()
  const heights = new Float32Array(gridW * gridH)
  for (let i = 0; i < heights.length; i++) heights[i] = r.f32()
  if (r.remaining !== 0) throw new Error('terrain.bin has trailing bytes — format mismatch')
  return { gridW, gridH, originX, originZ, dx, dz, minM, maxM, heights }
}