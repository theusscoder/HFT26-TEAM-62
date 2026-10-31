import type { TerrainData } from '../types/city'
import { TERRAIN_EXAGGERATION } from '../config/cityConfig'

/**
 * Bilinear terrain sampler over the heightfield grid.
 *
 * Two coordinate systems meet here:
 *  - `elevation(x, z)` returns REAL metres above sea level (as stored).
 *  - `groundY(x, z)` returns the display height: relative relief, exaggerated
 *    by the documented artistic factor, zero at the lowest window point.
 *    Every scene layer (terrain, roads, water, buildings, parks) must sample
 *    through the same instance so they share one ground truth.
 */
export class HeightField {
  private readonly terrain: TerrainData

  constructor(terrain: TerrainData) {
    this.terrain = terrain
  }

  get data(): TerrainData {
    return this.terrain
  }

  /** Real elevation in metres ASL (bilinear, clamped to the grid edge). */
  elevation(x: number, z: number): number {
    const t = this.terrain
    const fi = (x - t.originX) / t.dx
    const fj = (z - t.originZ) / t.dz
    const i0 = Math.min(Math.max(Math.floor(fi), 0), t.gridW - 1)
    const j0 = Math.min(Math.max(Math.floor(fj), 0), t.gridH - 1)
    const i1 = Math.min(i0 + 1, t.gridW - 1)
    const j1 = Math.min(j0 + 1, t.gridH - 1)
    const fx = Math.min(Math.max(fi - i0, 0), 1)
    const fz = Math.min(Math.max(fj - j0, 0), 1)
    const h00 = t.heights[j0 * t.gridW + i0]
    const h10 = t.heights[j0 * t.gridW + i1]
    const h01 = t.heights[j1 * t.gridW + i0]
    const h11 = t.heights[j1 * t.gridW + i1]
    return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz
  }

  /** Display-space ground height (exaggerated relative relief). */
  groundY(x: number, z: number): number {
    return (this.elevation(x, z) - this.terrain.minM) * TERRAIN_EXAGGERATION
  }

  /**
   * Display-space ground height that matches the RENDERED MESH surface
   * exactly. The terrain mesh splits each grid cell along the anti-diagonal,
   * so bilinear sampling can deviate from the visible triangles — draped
   * layers (roads, parks) must use this method or they sink into the terrain.
   */
  meshGroundY(x: number, z: number): number {
    const t = this.terrain
    const fi = (x - t.originX) / t.dx
    const fj = (z - t.originZ) / t.dz
    const i0 = Math.min(Math.max(Math.floor(fi), 0), t.gridW - 2)
    const j0 = Math.min(Math.max(Math.floor(fj), 0), t.gridH - 2)
    const s = Math.min(Math.max(fi - i0, 0), 1)
    const u = Math.min(Math.max(fj - j0, 0), 1)
    const ha = t.heights[j0 * t.gridW + i0]
    const hb = t.heights[j0 * t.gridW + i0 + 1]
    const hc = t.heights[(j0 + 1) * t.gridW + i0]
    const hd = t.heights[(j0 + 1) * t.gridW + i0 + 1]
    let y: number
    if (s + u <= 1) {
      // Triangle (a, b, c)
      y = ha + (hb - ha) * s + (hc - ha) * u
    } else {
      // Triangle (b, c, d)
      y = hd + (hb - hd) * (1 - u) + (hc - hd) * (1 - s)
    }
    return (y - t.minM) * TERRAIN_EXAGGERATION
  }

  /** Lowest display-space ground height in the window. */
  get minGroundY(): number {
    return 0
  }
}