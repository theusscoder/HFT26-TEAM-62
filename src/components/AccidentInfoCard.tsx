// Compact information overlay for the selected accident.
// Shows the simulated record's fields and a clear SIMULATED label; the close
// button deselects (camera stays where the user has it — CITY VIEW resets it).

import type { Accident } from '../types/accident'

const TYPE_LABELS: Record<Accident['type'], string> = {
  collision: 'Collision',
  two_wheeler: 'Two-wheeler',
  pedestrian: 'Pedestrian',
  rollover: 'Rollover',
  obstruction: 'Obstruction',
}

const STATUS_LABELS: Record<Accident['displayStatus'], string> = {
  active: 'Active',
  investigating: 'Investigating',
  cleared: 'Cleared',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function AccidentInfoCard({ accident, onClose }: { accident: Accident; onClose: () => void }) {
  return (
    <aside className="accident-card" role="dialog" aria-label={`Simulated incident ${accident.id}`}>
      <header className="accident-card-head">
        <div>
          <p className="accident-card-title">{accident.locationName}</p>
          <p className="accident-card-sub">
            <span className="accident-card-badge">SIMULATED</span>
            {accident.id} · {TYPE_LABELS[accident.type]}
          </p>
        </div>
        <button type="button" className="accident-card-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <dl className="accident-card-grid">
        <div>
          <dt>Reported</dt>
          <dd>{formatTime(accident.reportedAt)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABELS[accident.displayStatus]}</dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd className={`accident-sev accident-sev-${accident.severity}`}>{accident.severity}</dd>
        </div>
        <div>
          <dt>Vehicles</dt>
          <dd>{accident.vehiclesInvolved}</dd>
        </div>
      </dl>

      <p className="accident-card-summary">{accident.summary}</p>
    </aside>
  )
}