export type AccidentSeverity = 'critical' | 'high' | 'moderate'

/** Mapped incident category (simulated data until the backend lands). */
export type AccidentType = 'collision' | 'two_wheeler' | 'pedestrian' | 'rollover' | 'obstruction'

/** Lifecycle shown in the UI — simulated records only. */
export type AccidentDisplayStatus = 'active' | 'investigating' | 'cleared'

export interface Accident {
  id: string
  locationName: string
  /** Decimal degrees (WGS-84) — projected through src/geo/projection.ts. */
  latitude: number
  longitude: number
  type: AccidentType
  severity: AccidentSeverity
  /** ISO timestamp of when the incident was reported (simulated). */
  reportedAt: string
  /** UI lifecycle label (simulated). */
  displayStatus: AccidentDisplayStatus
  vehiclesInvolved: number
  /** True for every mock record until a real data source is connected. */
  isSimulated: true
  summary: string
}

/**
 * Integration seam for the analysis view.
 * The analysis team should listen for this event on `window` —
 * no analysis UI is implemented in this codebase.
 *
 * Selection flow (single source of truth: App state):
 *   marker click -> onSelectAccident(accident) -> App sets selectedId
 *   -> dispatches `accident:selected` with { id, accident } on `window`
 *   -> scene highlights the marker via the selectedId prop.
 * Deselect dispatches `accident:deselected` with { id }.
 * The analysis module must NOT own selection state — it consumes the event.
 */
export const ACCIDENT_SELECTED_EVENT = 'accident:selected'
export const ACCIDENT_DESELECTED_EVENT = 'accident:deselected'

export interface AccidentSelectedDetail {
  id: string
  accident: Accident
}

export interface AccidentDeselectedDetail {
  id: string
}