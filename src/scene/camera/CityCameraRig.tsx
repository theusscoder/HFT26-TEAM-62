// Camera rig: constrained, damped orbit controls + eased fly-to transitions.
// Deliberately NOT a free-flight camera: bounded target, tilt limits and zoom
// limits keep the city the centre of the experience.
//
// Navigation model (map-explorer, not editor):
//   - Left drag / one finger: orbit around the orbit target.
//   - Right drag / two fingers: pan ACROSS THE GROUND PLANE
//     (screenSpacePanning=false keeps panning horizontal; screen-space pan
//     slides the target underground at oblique view angles).
//   - Wheel / pinch: dolly, clamped to [minDistance, maxDistance].
// The initial pose is applied by THIS component at mount (not via competing
// mount-time prop paths) so the opening framing is deterministic.

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { cameraConfig } from '../../config/cameraConfig'
import { easeInOutCubic } from './poses'
import { CITY_WINDOW } from '../../config/cityConfig'
import { toWorld, toLatLng } from '../../geo/projection'
import { getCityPerf } from '../perf/renderStats'

export interface FlyRequest {
  id: number
  target: [number, number, number]
  position: [number, number, number]
}

export interface CameraReadout {
  centerLat: number
  centerLng: number
  distance: number
}

export interface InitialPose {
  target: [number, number, number]
  position: [number, number, number]
}

interface CityCameraRigProps {
  flyRequest: FlyRequest | null
  initialPose: InitialPose
  onCameraChange?: (readout: CameraReadout) => void
}

// Pan clamp: keep the orbit target on the slab. Z is SOUTH-positive, so the
// north neighbour is the MINIMUM z — use min/max() to stay order-independent.
const windowBounds = (() => {
  const sw = toWorld({ lat: CITY_WINDOW.south, lng: CITY_WINDOW.west })
  const ne = toWorld({ lat: CITY_WINDOW.north, lng: CITY_WINDOW.east })
  return {
    minX: Math.min(sw.x, ne.x) - 150,
    maxX: Math.max(sw.x, ne.x) + 150,
    minZ: Math.min(sw.z, ne.z) - 150,
    maxZ: Math.max(sw.z, ne.z) + 150,
  }
})()

// Orbit-target height clamp. Display-space terrain relief is 0..~247 m
// (relief 154.3 m × exaggeration 1.6); buildings rise above it, so the cap
// keeps the target in the urban band instead of under the slab or in the sky.
const TARGET_MIN_Y = 0
const TARGET_MAX_Y = 160

export function CityCameraRig({ flyRequest, initialPose, onCameraChange }: CityCameraRigProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const { camera } = useThree()
  const lastReport = useRef(0)
  const reportRef = useRef(onCameraChange)

  useEffect(() => {
    reportRef.current = onCameraChange
  }, [onCameraChange])

  // Deterministic opening framing: set the camera and orbit target here, once,
  // before the first frame — independent of prop-application order.
  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    camera.position.set(...initialPose.position)
    controls.target.set(...initialPose.target)
    controls.update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ongoing fly animation state (null when idle).
  const fly = useRef<{
    start: number
    fromTarget: [number, number, number]
    fromPosition: [number, number, number]
    to: FlyRequest
  } | null>(null)

  // Reposition camera when a new fly request arrives.
  useEffect(() => {
    if (!flyRequest || !controlsRef.current) return
    const controls = controlsRef.current
    fly.current = {
      start: performance.now(),
      fromTarget: [controls.target.x, controls.target.y, controls.target.z],
      fromPosition: [camera.position.x, camera.position.y, camera.position.z],
      to: flyRequest,
    }
    controls.enabled = false
  }, [flyRequest, camera])

  useFrame(() => {
    const controls = controlsRef.current
    if (!controls) return

    const anim = fly.current
    if (anim) {
      const t = Math.min((performance.now() - anim.start) / cameraConfig.flyDurationMs, 1)
      const e = easeInOutCubic(t)
      controls.target.set(
        anim.fromTarget[0] + (anim.to.target[0] - anim.fromTarget[0]) * e,
        anim.fromTarget[1] + (anim.to.target[1] - anim.fromTarget[1]) * e,
        anim.fromTarget[2] + (anim.to.target[2] - anim.fromTarget[2]) * e,
      )
      camera.position.set(
        anim.fromPosition[0] + (anim.to.position[0] - anim.fromPosition[0]) * e,
        anim.fromPosition[1] + (anim.to.position[1] - anim.fromPosition[1]) * e,
        anim.fromPosition[2] + (anim.to.position[2] - anim.fromPosition[2]) * e,
      )
      controls.update()
      if (t >= 1) {
        fly.current = null
        controls.enabled = true
      }
    } else {
      // Keep the pan target on the slab — horizontally AND in height, so
      // panning can never sink the orbit centre under the terrain or lift it
      // above the roofline band.
      const { minX, maxX, minZ, maxZ } = windowBounds
      controls.target.x = Math.min(Math.max(controls.target.x, minX), maxX)
      controls.target.z = Math.min(Math.max(controls.target.z, minZ), maxZ)
      controls.target.y = Math.min(Math.max(controls.target.y, TARGET_MIN_Y), TARGET_MAX_Y)
    }

    const perf = getCityPerf()
    perf.cameraDistanceM = camera.position.distanceTo(controls.target)

    const now = performance.now()
    if (now - lastReport.current > 125) {
      lastReport.current = now
      const ll = toLatLng({ x: controls.target.x, z: controls.target.z })
      reportRef.current?.({
        centerLat: ll.lat,
        centerLng: ll.lng,
        distance: perf.cameraDistanceM,
      })
    }
  })

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      minDistance={cameraConfig.minDistance}
      maxDistance={cameraConfig.maxDistance}
      minPolarAngle={cameraConfig.minPolarAngle}
      maxPolarAngle={cameraConfig.maxPolarAngle}
      enableDamping
      dampingFactor={0.09}
      panSpeed={cameraConfig.panSpeed}
      screenSpacePanning={false}
      zoomSpeed={0.8}
      rotateSpeed={0.55}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      }}
      touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
    />
  )
}