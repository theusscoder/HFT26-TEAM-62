import { cameraConfig, type CameraPose } from '../../config/cameraConfig'
import type { HeightField } from '../../geo/heightfield'
import { toWorld } from '../../geo/projection'
import type { Accident } from '../../types/accident'

/** Overview of the loaded sample area from the south-west, elevated oblique. */
export function defaultPose(ground: HeightField): CameraPose {
  const t = cameraConfig.defaultPose.target
  const y = ground.groundY(t[0], t[2])
  const { x, y: oy, z } = cameraConfig.defaultPose.offset
  return {
    target: [t[0], y, t[2]],
    position: [t[0] + x, y + oy, t[2] + z],
  }
}

/** Close view over a dense part of the sample (benchmark scenario). */
export function nearPose(ground: HeightField): CameraPose {
  const c = toWorld({ lat: 17.4305, lng: 78.4525 })
  const y = ground.groundY(c.x, c.z)
  return {
    target: [c.x, y, c.z],
    position: [c.x - 430, y + 400, c.z + 540],
  }
}

/** High survey view of the whole slab for diagnostics (benchmark 'survey'). */
export function surveyPose(ground: HeightField): CameraPose {
  const c = toWorld({ lat: 17.425, lng: 78.455 })
  return orbitPose([c.x, ground.groundY(c.x, c.z), c.z], 10_500, 135, 72)
}

/** Near-vertical probe over Necklace Road (diagnostics: road visibility). */
export function nadirPose(ground: HeightField): CameraPose {
  const c = toWorld({ lat: 17.4239, lng: 78.466 })
  return orbitPose([c.x, ground.groundY(c.x, c.z), c.z], 1_400, 90, 80)
}

/**
 * Low profile view of the island's west face (diagnostics: floating-diorama
 * read — wall strata, dark underside, rim glow, under-glow halo). Not a UI
 * pose. Targets the west rim of the derived island (sample-window data).
 */
export function profilePose(ground: HeightField): CameraPose {
  const c = toWorld({ lat: 17.4245, lng: 78.429 })
  return orbitPose([c.x, ground.groundY(c.x, c.z), c.z], 6_500, 292, 16)
}

/**
 * Focused oblique view over a selected accident: close enough to read the
 * marker and its junction, high/far enough to keep surrounding roads and
 * buildings visible for context. Flown via the existing eased fly-to.
 */
export function accidentFocusPose(ground: HeightField, accident: Accident): CameraPose {
  const c = toWorld({ lat: accident.latitude, lng: accident.longitude })
  return orbitPose([c.x, ground.groundY(c.x, c.z), c.z], 720, 160, 38)
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Pose with camera offset towards +z (south) — utility for future markers. */
export function orbitPose(target: [number, number, number], distance: number, azimuthDeg: number, pitchDeg: number): CameraPose {
  const az = (azimuthDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const horizontal = Math.cos(pitch) * distance
  return {
    target,
    position: [
      target[0] + Math.sin(az) * horizontal,
      target[1] + Math.sin(pitch) * distance,
      target[2] + Math.cos(az) * horizontal,
    ],
  }
}