// Merged road ribbons draped over the terrain, split into a major network
// (always visible) and a minor street mesh that appears below
// cameraConfig.roadLodDistanceM — the Phase 3 road LOD: zoomed out reads as
// silhouette + arterials; medium zoom shows the full street layout.
//
// The minor-tier toggle uses a hysteresis band so the street mesh does not
// flicker while the distance hovers at the threshold.

import { useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import type { RoadRecord } from '../../types/city'
import type { HeightField } from '../../geo/heightfield'
import { cameraConfig } from '../../config/cameraConfig'
import { getCityPerf } from '../perf/renderStats'
import { buildRoadGeometry } from './geometry'

/** Minor roads reappear below roadLodDistanceM and hide again above this. */
const ROAD_LOD_HIDE_M = cameraConfig.roadLodDistanceM + 500

export function RoadNetwork({ roads, ground }: { roads: RoadRecord[]; ground: HeightField }) {
  const { major, minor } = useMemo(() => buildRoadGeometry(roads, ground), [roads, ground])

  const [minorVisible, setMinorVisible] = useState(false)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null

  useFrame(() => {
    const target = controls?.target
    const dist = target ? camera.position.distanceTo(target) : camera.position.length()
    setMinorVisible((prev) => {
      if (!prev && dist < cameraConfig.roadLodDistanceM) return true
      if (prev && dist > ROAD_LOD_HIDE_M) return false
      return prev
    })
    getCityPerf().minorRoadsVisible = minorVisible
    if (target === null) getCityPerf().lodTier = `no-controls?dist=${Math.round(dist)}`
  })

  return (
    <group>
      <mesh name="roads" geometry={major} renderOrder={2}>
        <meshBasicMaterial vertexColors polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
      <mesh name="roads-minor" geometry={minor} renderOrder={2} visible={minorVisible}>
        <meshBasicMaterial vertexColors polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
    </group>
  )
}