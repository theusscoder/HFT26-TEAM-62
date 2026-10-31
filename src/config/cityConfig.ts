import type { RoadClass } from '../types/city'

// ---------------------------------------------------------------------------
// Geographic domain constants. These MUST match the values used by the
// dev-time processor (scripts/process-sample-data.mjs).
// ---------------------------------------------------------------------------

/**
 * The FULL approved coverage window — the projection/data-selection domain.
 * The rendered island is NOT this rectangle: its outline is the irregular
 * urban footprint derived from the shipped OSM density (src/geo/boundary.ts),
 * clipped to the currently loaded data window.
 */
export const CITY_WINDOW = {
  south: 17.36,
  north: 17.50,
  west: 78.33,
  east: 78.51,
} as const

/**
 * Relative terrain relief exaggeration (artistic, documented in the manifest).
 * Applied to (elevation - windowMinElevation), never to absolute elevation.
 */
export const TERRAIN_EXAGGERATION = 1.6

/** Metres of visible wall thickness below the lowest terrain point. */
export const SLAB_THICKNESS_M = 170

/** Ribbons widths per road class (metres, total). */
export const ROAD_WIDTHS: Record<RoadClass, number> = {
  motorway: 26,
  trunk: 22,
  primary: 18,
  secondary: 14,
  tertiary: 11,
  residential: 7.5,
  unclassified: 7,
  living_street: 6.5,
  service: 5,
}

/** Vertical offsets to keep draped layers above the terrain without z-fighting. */
export const DRAPE_OFFSET_ROAD_M = 0.9
export const DRAPE_OFFSET_PARK_M = 0.45
/** Bridges (OSM bridge=yes) ride higher — causeways cross water at surface level. */
export const DRAPE_OFFSET_BRIDGE_M = 2.6

/** Base URL for processed city assets (served statically from public/). */
export const ASSET_BASE = '/data/city'