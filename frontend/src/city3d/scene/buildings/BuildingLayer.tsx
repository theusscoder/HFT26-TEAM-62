// Buildings: instanced OBB boxes (far tier) + true footprint extrusions
// (near tier), switchable manually ("boxes" / "footprints") or automatically
// by camera distance ("auto"). Named landmarks render as accent-tinted
// extrusions at EVERY tier — they are the city's identity anchors.
//
// The auto tier uses a hysteresis band (footprints < 950 m, boxes > 1150 m)
// so hovering at the boundary does not flip geometry back and forth.

import { useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { BuildingRecord } from '../../types/city'
import type { HeightField } from '../../geo/heightfield'
import type { BuildingRenderMode } from '../../config/cameraConfig'
import { cameraConfig } from '../../config/cameraConfig'
import { palette } from '../../config/palette'
import { getCityPerf } from '../perf/renderStats'
import { buildBuildingInstances, buildExtrudedBuildings } from './geometry'

interface BuildingLayerProps {
  buildings: BuildingRecord[]
  ground: HeightField
  mode: BuildingRenderMode
}

function InstancedBuildings({ buildings, ground, visible }: { buildings: BuildingRecord[]; ground: HeightField; visible: boolean }) {
  const instances = useMemo(() => buildBuildingInstances(buildings, ground), [buildings, ground])

  const mesh = useMemo(() => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshLambertMaterial()
    const instanced = new THREE.InstancedMesh(geometry, material, instances.count)
    const mat4 = new THREE.Matrix4()
    for (let i = 0; i < instances.count; i++) {
      for (let e = 0; e < 16; e++) mat4.elements[e] = instances.matrices[i * 16 + e]
      instanced.setMatrixAt(i, mat4)
      instanced.setColorAt(i, new THREE.Color(instances.colors[3 * i], instances.colors[3 * i + 1], instances.colors[3 * i + 2]))
    }
    instanced.instanceMatrix.needsUpdate = true
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true
    instanced.frustumCulled = false // spans the whole window; culling costs more than it saves here
    instanced.name = 'buildings-boxes'
    return instanced
  }, [instances])

  return <primitive object={mesh} visible={visible} />
}

function ExtrudedBuildings({ buildings, ground, visible }: { buildings: BuildingRecord[]; ground: HeightField; visible: boolean }) {
  const geometry = useMemo(
    () => buildExtrudedBuildings(buildings, ground, (b) => !b.landmark),
    [buildings, ground],
  )
  return (
    <mesh name="buildings-footprints" geometry={geometry} visible={visible}>
      <meshLambertMaterial vertexColors />
    </mesh>
  )
}

/** Accent-tinted named landmarks — visible at every zoom tier. */
function LandmarkBuildings({ buildings, ground }: { buildings: BuildingRecord[]; ground: HeightField }) {
  const geometry = useMemo(
    () => buildExtrudedBuildings(buildings, ground, (b) => b.landmark),
    [buildings, ground],
  )
  return (
    <mesh name="buildings-landmarks" geometry={geometry}>
      <meshStandardMaterial
        vertexColors
        emissive={palette.accentTeal}
        emissiveIntensity={0.22}
        roughness={0.55}
        metalness={0.1}
      />
    </mesh>
  )
}

export function BuildingLayer({ buildings, ground, mode }: BuildingLayerProps) {
  // "auto" resolves per-frame from camera distance to controls target.
  const [autoTier, setAutoTier] = useState<'boxes' | 'footprints'>('boxes')
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null

  useFrame(() => {
    if (mode !== 'auto') return
    const target = controls?.target
    const dist = target ? camera.position.distanceTo(target) : camera.position.length()
    // Hysteresis: enter footprints below autoFootprintDistanceM, leave only
    // above autoBoxesDistanceM.
    setAutoTier((prev) => {
      if (prev === 'boxes' && dist < cameraConfig.autoFootprintDistanceM) return 'footprints'
      if (prev === 'footprints' && dist > cameraConfig.autoBoxesDistanceM) return 'boxes'
      return prev
    })
  })

  const effective: 'boxes' | 'footprints' = mode === 'auto' ? autoTier : mode
  getCityPerf().lodTier = `${mode}/${effective}`

  return (
    <group>
      <InstancedBuildings buildings={buildings} ground={ground} visible={effective === 'boxes'} />
      <ExtrudedBuildings buildings={buildings} ground={ground} visible={effective === 'footprints'} />
      <LandmarkBuildings buildings={buildings} ground={ground} />
    </group>
  )
}