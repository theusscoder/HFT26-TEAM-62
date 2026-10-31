// Road ribbon builder — drapes polylines over the shared HeightField and
// emits two merged non-indexed geometries (major / minor network) with
// per-vertex class-based colour, so the minor mesh can be hidden when zoomed
// out without rebuilding anything.
//
// Joins use averaged perpendiculars with a clamped miter scale (~2x), which is
// clean enough at diorama scale and keeps triangle count low.
// OSM bridge ways are raised clear of the water/terrain surface.

import * as THREE from 'three'
import type { RoadRecord } from '../../types/city'
import type { HeightField } from '../../geo/heightfield'
import { ROAD_WIDTHS, DRAPE_OFFSET_ROAD_M, DRAPE_OFFSET_BRIDGE_M } from '../../config/cityConfig'
import { palette } from '../../config/palette'

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary'])

export interface RoadGeometries {
  /** Motorway…tertiary — always rendered (the zoomed-out network). */
  major: THREE.BufferGeometry
  /** Residential/unclassified/living_street/service — near-tier detail. */
  minor: THREE.BufferGeometry
}

function buildRoads(roads: RoadRecord[], ground: HeightField, major: boolean): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const majorColor = new THREE.Color(palette.road)
  const minorColor = new THREE.Color(palette.roadMinor)

  for (const road of roads) {
    const isMajor = MAJOR.has(road.roadClass)
    if (isMajor !== major) continue
    const n = road.pts.length / 2
    if (n < 2) continue
    const width = ROAD_WIDTHS[road.roadClass]
    const halfW = width / 2
    const color = isMajor ? majorColor : minorColor
    // Service roads would visually noise the slab; darken them further.
    const shade = road.roadClass === 'service' ? 0.6 : 1
    const drape = road.bridge ? DRAPE_OFFSET_BRIDGE_M : DRAPE_OFFSET_ROAD_M

    // Per-point perpendicular offsets (left/right), averaged at joins.
    const left: number[] = new Array(n * 2)
    const right: number[] = new Array(n * 2)
    const y: number[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const px = road.pts[2 * i]
      const pz = road.pts[2 * i + 1]
      const prev = i > 0 ? i - 1 : i
      const next = i < n - 1 ? i + 1 : i
      let dx = road.pts[2 * next] - road.pts[2 * prev]
      let dz = road.pts[2 * next + 1] - road.pts[2 * prev + 1]
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) {
        dx = 1
        dz = 0
      } else {
        dx /= len
        dz /= len
      }
      // Perpendicular in x/z plane.
      const nx = -dz
      const nz = dx
      // Miter scale: 1 / cos(angle between averaged dirs), clamped.
      const scale = Math.min(1 / Math.max(dx * dx + dz * dz, 0.55), 2)
      left[2 * i] = px + nx * halfW * scale
      left[2 * i + 1] = pz + nz * halfW * scale
      right[2 * i] = px - nx * halfW * scale
      right[2 * i + 1] = pz - nz * halfW * scale
      y[i] = ground.meshGroundY(px, pz) + drape
    }

    const push = (x: number, yy: number, z: number) => {
      positions.push(x, yy, z)
      colors.push(color.r * shade, color.g * shade, color.b * shade)
    }

    for (let i = 0; i < n - 1; i++) {
      // Quad facing UP: (R, L, L') + (R, L', R') — with z south-positive the
      // opposite order produced downward-facing ribbons (backface-culled).
      push(right[2 * i], y[i], right[2 * i + 1])
      push(left[2 * i], y[i], left[2 * i + 1])
      push(left[2 * i + 2], y[i + 1], left[2 * i + 3])

      push(right[2 * i], y[i], right[2 * i + 1])
      push(left[2 * i + 2], y[i + 1], left[2 * i + 3])
      push(right[2 * i + 2], y[i + 1], right[2 * i + 3])
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}

export function buildRoadGeometry(roads: RoadRecord[], ground: HeightField): RoadGeometries {
  return {
    major: buildRoads(roads, ground, true),
    minor: buildRoads(roads, ground, false),
  }
}