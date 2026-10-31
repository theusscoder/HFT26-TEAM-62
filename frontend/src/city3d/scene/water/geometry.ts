// Water and park polygon triangulation (earcut, with hole support for lake
// islands such as the Buddha statue rock in Hussain Sagar).

import * as THREE from 'three'
import earcut from 'earcut'
import type { ParkArea, WaterArea } from '../../types/city'
import type { HeightField } from '../../geo/heightfield'
import { DRAPE_OFFSET_PARK_M } from '../../config/cityConfig'
import { TERRAIN_EXAGGERATION } from '../../config/cityConfig'
import { normalizeRingUp, triFacesUp } from '../../geo/rings'

export function buildWaterGeometry(water: WaterArea[], ground: HeightField): THREE.BufferGeometry {
  const positions: number[] = []
  for (const area of water) {
    const outer = normalizeRingUp(area.outer)
    const holeIndices: number[] = []
    const all = outer
    for (const hole of area.holes) {
      holeIndices.push(all.length / 2)
      all.push(...Array.from(hole))
    }
    const tri = earcut(all, holeIndices)
    const y = (area.elevation - ground.data.minM) * TERRAIN_EXAGGERATION
    for (let t = 0; t < tri.length; t += 3) {
      const i0 = tri[t] * 2
      const i1 = tri[t + 1] * 2
      const i2 = tri[t + 2] * 2
      const ax = all[i0]
      const az = all[i0 + 1]
      const bx = all[i1]
      const bz = all[i1 + 1]
      const cx = all[i2]
      const cz = all[i2 + 1]
      if (triFacesUp(ax, az, bx, bz, cx, cz)) {
        positions.push(ax, y, az, bx, y, bz, cx, y, cz)
      } else {
        positions.push(ax, y, az, cx, y, cz, bx, y, bz)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

export function buildParkGeometry(parks: ParkArea[], ground: HeightField): THREE.BufferGeometry {
  const positions: number[] = []
  for (const park of parks) {
    const ring = normalizeRingUp(park.ring)
    const tri = earcut(ring)
    let cx = 0
    let cz = 0
    for (let i = 0; i < ring.length; i += 2) {
      cx += ring[i]
      cz += ring[i + 1]
    }
    cx /= ring.length / 2
    cz /= ring.length / 2
    const y = ground.meshGroundY(cx, cz) + DRAPE_OFFSET_PARK_M
    for (let t = 0; t < tri.length; t += 3) {
      const i0 = tri[t] * 2
      const i1 = tri[t + 1] * 2
      const i2 = tri[t + 2] * 2
      const ax = ring[i0]
      const az = ring[i0 + 1]
      const bx = ring[i1]
      const bz = ring[i1 + 1]
      const cx = ring[i2]
      const cz = ring[i2 + 1]
      if (triFacesUp(ax, az, bx, bz, cx, cz)) {
        positions.push(ax, y, az, bx, y, bz, cx, y, cz)
      } else {
        positions.push(ax, y, az, cx, y, cz, bx, y, bz)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}