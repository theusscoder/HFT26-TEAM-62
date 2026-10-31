// Water surfaces (lakes with islands) and park canopies, triangulated from
// the processed OSM polygons.

import { useMemo } from 'react'
import type { ParkArea, WaterArea } from '../../types/city'
import type { HeightField } from '../../geo/heightfield'
import { buildParkGeometry, buildWaterGeometry } from './geometry'
import { palette } from '../../config/palette'

export function WaterLayer({ water, ground }: { water: WaterArea[]; ground: HeightField }) {
  const geometry = useMemo(() => buildWaterGeometry(water, ground), [water, ground])
  return (
    <mesh name="water" geometry={geometry}>
      <meshStandardMaterial
        color={palette.water}
        roughness={0.28}
        metalness={0.15}
        transparent
        opacity={0.94}
      />
    </mesh>
  )
}

export function ParkLayer({ parks, ground }: { parks: ParkArea[]; ground: HeightField }) {
  const geometry = useMemo(() => buildParkGeometry(parks, ground), [parks, ground])
  return (
    <mesh name="parks" geometry={geometry}>
      <meshStandardMaterial color={palette.park} roughness={0.95} metalness={0} />
    </mesh>
  )
}