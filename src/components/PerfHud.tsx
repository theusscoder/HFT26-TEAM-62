// On-screen perf panel (P key / benchmark). Reads the same perf singleton the
// automated benchmark samples, so numbers always agree.

import { useEffect, useState } from 'react'
import { getCityPerf } from '../scene/perf/renderStats'

export function PerfHud({ visible }: { visible: boolean }) {
  const [, force] = useState(0)

  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => force((n) => n + 1), 500)
    return () => window.clearInterval(timer)
  }, [visible])

  if (!visible) return null
  const perf = getCityPerf()

  const rows: Array<[string, string]> = [
    ['FPS', perf.fps.toFixed(0)],
    ['1% low', perf.fps1pLow.toFixed(0)],
    ['frame', `${perf.frameMs.toFixed(1)} ms`],
    ['draw calls', String(perf.drawCalls)],
    ['triangles', perf.triangles.toLocaleString()],
    ['geometries', String(perf.geometries)],
    ['mode', perf.buildingMode],
    ['cam dist', `${Math.round(perf.cameraDistanceM)} m`],
    ['heap', perf.heapMB !== null ? `${Math.round(perf.heapMB)} MB` : 'n/a'],
  ]
  if (perf.loadMs) {
    rows.push(['ready→1st frame', `${Math.round(perf.loadMs.dataset)} ms`])
  }

  return (
    <aside className="perf-panel" role="status" aria-label="Render performance">
      <p className="perf-title">RENDER PERF</p>
      {rows.map(([k, v]) => (
        <p key={k} className="perf-row">
          <span>{k}</span>
          <span>{v}</span>
        </p>
      ))}
    </aside>
  )
}