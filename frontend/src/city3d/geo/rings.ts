// Flat [x,z,...] ring orientation helpers for up-facing geometry.
//
// World convention: x east, z SOUTH-positive (map-down). In that plane a ring
// with POSITIVE shoelace area extrudes/triangulates into DOWNWARD-facing
// triangles (normal -Y); backface culling then hides them from any camera
// above. All extruded caps and draped polygons must therefore be emitted with
// NEGATIVE shoelace area — which reads counter-clockwise on a map view.

/**
 * Shoelace sum of a flat [x,z, x,z, ...] ring.
 * Positive  -> triangles would face DOWN (-Y) with this point order.
 * Negative  -> triangles face UP (+Y).
 */
export function ringSignedArea(coords: ArrayLike<number>): number {
  const n = coords.length / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sum += coords[2 * i] * coords[2 * j + 1] - coords[2 * j] * coords[2 * i + 1]
  }
  return sum
}

/** Returns the ring (copied if needed) ordered so caps face UP (+Y). */
export function normalizeRingUp(coords: ArrayLike<number>): number[] {
  const out = Array.from(coords)
  if (ringSignedArea(out) > 0) {
    const n = out.length / 2
    for (let i = 0; i < n / 2; i++) {
      const j = n - 1 - i
      const tx = out[2 * i]
      const tz = out[2 * i + 1]
      out[2 * i] = out[2 * j]
      out[2 * i + 1] = out[2 * j + 1]
      out[2 * j] = tx
      out[2 * j + 1] = tz
    }
  }
  return out
}

/**
 * Triangle shoelace test for three flat points. True when the order (a, b, c)
 * faces UP (+Y); false when it must be flipped.
 */
export function triFacesUp(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax) < 0
}