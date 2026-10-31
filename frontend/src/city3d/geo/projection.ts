// Geographic <-> local-world projection shared by the app and dev-time scripts.
//
// Local equirectangular projection in metres, anchored at a single origin:
//   x: east-positive  (metres)
//   z: SOUTH-positive (so north points towards -z, matching three.js top view)
//
// At the scale of the city window (~20 km) this is accurate to well under a
// metre versus a true local transverse Mercator, which is far beyond what a
// stylised diorama requires.

export interface LatLng {
  lat: number
  lng: number
}

export interface WorldPoint {
  x: number
  z: number
}

/** Anchor of the local coordinate system (centre of the full city window). */
export const PROJECTION_ORIGIN: Readonly<LatLng> = { lat: 17.43, lng: 78.42 }

const DEG = Math.PI / 180
const PHI = PROJECTION_ORIGIN.lat * DEG

/** Metres per degree of latitude at the origin latitude. */
export const METRES_PER_DEG_LAT: number =
  111_132.954 - 559.822 * Math.cos(2 * PHI) + 1.175 * Math.cos(4 * PHI)

/** Metres per degree of longitude at the origin latitude. */
export const METRES_PER_DEG_LNG: number =
  111_412.84 * Math.cos(PHI) - 93.5 * Math.cos(3 * PHI) + 0.118 * Math.cos(5 * PHI)

export function toWorld(p: LatLng): WorldPoint {
  return {
    x: (p.lng - PROJECTION_ORIGIN.lng) * METRES_PER_DEG_LNG,
    z: -(p.lat - PROJECTION_ORIGIN.lat) * METRES_PER_DEG_LAT,
  }
}

export function toLatLng(p: WorldPoint): LatLng {
  return {
    lat: PROJECTION_ORIGIN.lat - p.z / METRES_PER_DEG_LAT,
    lng: PROJECTION_ORIGIN.lng + p.x / METRES_PER_DEG_LNG,
  }
}