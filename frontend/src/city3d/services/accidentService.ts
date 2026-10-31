import { MOCK_ACCIDENTS } from '../data/mockAccidents'
import type { Accident } from '../types/accident'

/**
 * Single data seam for the whole UI.
 * Today it resolves the clearly-labelled simulated dataset; when the backend
 * lands, only this file changes — components and types stay untouched.
 */
export async function getAccidents(): Promise<Accident[]> {
  // TODO(backend): replace with fetch('/api/accidents') when the backend exists.
  return Promise.resolve(MOCK_ACCIDENTS)
}