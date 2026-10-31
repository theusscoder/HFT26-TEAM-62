import { toWorld } from '../geo/projection'

/** Default framing looks at the Phase 2 sample area centre from the south-west. */
const DEFAULT_TARGET_WORLD = toWorld({ lat: 17.4245, lng: 78.455 })

export interface CameraPose {
  target: [number, number, number]
  position: [number, number, number]
}

export const cameraConfig = {
  fov: 36,
  near: 1,
  far: 40_000,

  defaultPose: {
    // y is filled in at runtime from terrain height under the target.
    target: [DEFAULT_TARGET_WORLD.x, 0, DEFAULT_TARGET_WORLD.z] as [number, number, number],
    offset: { x: -2650, y: 2450, z: 3200 },
  },

  minDistance: 260,
  maxDistance: 13_000,
  minPolarAngle: 0.18,
  maxPolarAngle: 1.32,
  panSpeed: 0.85,

  flyDurationMs: 1600,

  /**
   * Auto building LOD: below autoFootprintDistanceM the detailed footprint
   * extrusions render; the tier switches back to instanced boxes only above
   * autoBoxesDistanceM — the hysteresis band stops flip-flopping while the
   * distance hovers at the boundary.
   */
  autoFootprintDistanceM: 950,
  autoBoxesDistanceM: 1150,

  /**
   * Road LOD: above this distance only the major network (motorway…tertiary)
   * renders — the zoomed-out read is silhouette + arterials, per the Phase 3
   * LOD spec. Below it, the full street layout appears.
   */
  roadLodDistanceM: 3600,
} as const

export type BuildingRenderMode = 'boxes' | 'footprints' | 'auto'