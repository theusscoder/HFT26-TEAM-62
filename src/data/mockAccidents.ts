// ---------------------------------------------------------------------------
// ⚠ SIMULATED DEMO DATA — every record in this file is fictional.
// Coordinates sit on real Hyderabad junctions inside the rendered sample
// window (17.405–17.445 N, 78.425–78.485 E) so the demo reads geographically
// true, but no incident described here actually occurred. Replace this module
// (via src/services/accidentService.ts) with a real backend feed.
// ---------------------------------------------------------------------------

import type { Accident } from '../types/accident'

export const MOCK_ACCIDENTS: Accident[] = [
  {
    id: 'SIM-001',
    locationName: 'Khairatabad Circle',
    latitude: 17.4183,
    longitude: 78.4553,
    type: 'collision',
    severity: 'critical',
    reportedAt: '2026-10-30T08:12:00+05:30',
    displayStatus: 'active',
    vehiclesInvolved: 3,
    isSimulated: true,
    summary: 'Multi-vehicle collision at the junction, two lanes blocked.',
  },
  {
    id: 'SIM-002',
    locationName: 'Panjagutta Junction',
    latitude: 17.4239,
    longitude: 78.449,
    type: 'pedestrian',
    severity: 'high',
    reportedAt: '2026-10-30T07:48:00+05:30',
    displayStatus: 'investigating',
    vehiclesInvolved: 1,
    isSimulated: true,
    summary: 'Pedestrian struck near the bus stop, traffic slowing.',
  },
  {
    id: 'SIM-003',
    locationName: 'Somajiguda Signal',
    latitude: 17.4335,
    longitude: 78.4506,
    type: 'two_wheeler',
    severity: 'high',
    reportedAt: '2026-10-30T06:37:00+05:30',
    displayStatus: 'active',
    vehiclesInvolved: 2,
    isSimulated: true,
    summary: 'Two-wheeler skidded on wet surface, lane partly blocked.',
  },
  {
    id: 'SIM-004',
    locationName: 'Banjara Hills Road No. 12',
    latitude: 17.4122,
    longitude: 78.4383,
    type: 'rollover',
    severity: 'moderate',
    reportedAt: '2026-10-30T09:05:00+05:30',
    displayStatus: 'cleared',
    vehiclesInvolved: 2,
    isSimulated: true,
    summary: 'Vehicle lost control at the bend, roadway clear.',
  },
  {
    id: 'SIM-005',
    locationName: 'Necklace Road, Hussain Sagar east',
    latitude: 17.422,
    longitude: 78.476,
    type: 'obstruction',
    severity: 'moderate',
    reportedAt: '2026-10-30T09:41:00+05:30',
    displayStatus: 'investigating',
    vehiclesInvolved: 1,
    isSimulated: true,
    summary: 'Dumped debris on the lakeside carriageway, single lane.',
  },
  {
    id: 'SIM-006',
    locationName: 'Ameerpet Junction',
    latitude: 17.4372,
    longitude: 78.4461,
    type: 'collision',
    severity: 'high',
    reportedAt: '2026-10-30T10:02:00+05:30',
    displayStatus: 'active',
    vehiclesInvolved: 2,
    isSimulated: true,
    summary: 'Auto–car collision at the signal, shoulder occupied.',
  },
]