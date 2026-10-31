// Geographic placement of accident markers.
//
// Accidents arrive as WGS-84 lat/lng in the Accident record; the scene works
// in the shared local projection (src/geo/projection.ts). Everything here is
// pure and shared with any future consumer (e.g. analysis-side debugging) —
// no rendering in this module.

import type { Accident } from '../../types/accident'
import type { HeightField } from '../../geo/heightfield'
import { toWorld } from '../../geo/projection'
import { DRAPE_OFFSET_ROAD_M } from '../../config/cityConfig'

export interface MarkerPlacement {
  /** Accident world position [x, y, z] — base of the marker, on the terrain. */
  position: [number, number, number]
  /** Local world x/z, for distance sorting and diagnostics. */
  world: { x: number; z: number }
}

/**
 * Project an accident to its precise scene position: the shared lat/lng
 * projection for x/z, and the same HeightField instance the terrain, roads
 * and buildings sample — so the marker sits exactly on the visible surface,
 * lifted clear of draped roads (never inside terrain or buildings).
 */
export function placeAccident(accident: Accident, ground: HeightField): MarkerPlacement {
  const world = toWorld({ lat: accident.latitude, lng: accident.longitude })
  const y = ground.meshGroundY(world.x, world.z) + DRAPE_OFFSET_ROAD_M
  return { position: [world.x, y, world.z], world }
}