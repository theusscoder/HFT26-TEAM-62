// Top-level HUD: identity, status, camera readout and view controls.
// Pointer-events pass through except on the interactive controls.

import { useState } from 'react'
import type { BuildingRenderMode } from '../config/cameraConfig'
import type { CameraReadout } from '../scene/camera/CityCameraRig'

interface HudOverlayProps {
  readout: CameraReadout | null
  accidentCount: number
  buildingMode: BuildingRenderMode
  onSetMode: (mode: BuildingRenderMode) => void
  onResetView: () => void
}

const MODE_LABELS: Array<{ id: BuildingRenderMode; label: string }> = [
  { id: 'auto', label: 'AUTO' },
  { id: 'boxes', label: 'BOX' },
  { id: 'footprints', label: 'FOOTPRINT' },
]

export function HudOverlay({ readout, accidentCount, buildingMode, onSetMode, onResetView }: HudOverlayProps) {
  const [modeOpen, setModeOpen] = useState(false)

  return (
    <div className="hud pointer-events-none absolute inset-0 z-20 select-none">
      <header className="absolute left-5 top-4">
        <h1 className="font-display text-[13px] font-semibold tracking-[0.35em] text-white/90">
          HYDERABAD <span className="text-rose-400/90">/</span> ACCIDENT GRID
        </h1>
        <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.25em] text-amber-300/80">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
          SIMULATED DATA · {accidentCount} RECORDS STAGED
        </p>
      </header>

      <div className="absolute right-5 top-4 text-right font-mono text-[10px] leading-5 tracking-[0.15em] text-white/55">
        <p>
          {readout ? `${readout.centerLat.toFixed(4)}° N · ${readout.centerLng.toFixed(4)}° E` : '—'}
        </p>
        <p>{readout ? `CAM ${Math.round(readout.distance)} m` : ''}</p>
      </div>

      <div className="absolute bottom-4 left-5 flex items-center gap-2">
        <button type="button" className="hud-btn pointer-events-auto" onClick={onResetView}>
          CITY VIEW
        </button>

        <div className="relative pointer-events-auto">
          <button
            type="button"
            className="hud-btn"
            onClick={() => setModeOpen((v) => !v)}
            title="Building rendering mode (Phase 2 benchmark comparison)"
          >
            LOD · {MODE_LABELS.find((m) => m.id === buildingMode)?.label}
          </button>
          {modeOpen && (
            <div className="hud-menu absolute bottom-9 left-0 w-28">
              {MODE_LABELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`hud-menu-item ${m.id === buildingMode ? 'is-active' : ''}`}
                  onClick={() => {
                    onSetMode(m.id)
                    setModeOpen(false)
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}