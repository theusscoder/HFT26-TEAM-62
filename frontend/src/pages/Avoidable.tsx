import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { post, useApi, type Analysis } from "../lib/api";
import { Loading, Panel } from "../components/ui";

/* OWNER: P4. Counterfactual slider. Backend physics: d = v*t_r + v^2/(2*mu*g).
   TODO(P4): animate the ghost car in the 2.5D scene alongside the observed replay. */
interface Ghost { speed_kmh: number; hazard_at_m: number; stops_at_m: number; margin_m: number; avoided: boolean; assumptions: Record<string, unknown> }

export default function Avoidable() {
  const { id } = useParams();
  const an = useApi<Analysis>(`/cases/${id}/analysis`);
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => { if (an.data?.counterfactual && speed == null) setSpeed(Math.round(an.data.counterfactual.observed_speed_kmh)); }, [an.data]);
  const [g, setG] = useState<Ghost | null>(null);
  useEffect(() => { if (an.data?.counterfactual && speed != null) post<Ghost>(`/cases/${id}/counterfactual`, { speed_kmh: speed }).then(setG); }, [id, speed, an.data]);
  if (an.data && !an.data.counterfactual)
    return <Loading error="404 needs a calibrated speed (road homography) or a sensor log for this case" />;
  if (!an.data || !g || speed == null) return <Loading error={an.error} />;

  const W = 640, scale = W / Math.max(15, g.hazard_at_m * 2.2, g.stops_at_m * 1.1), hz = g.hazard_at_m * scale;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Could it have been avoided?</h1>
        <p className="text-sm text-muted">{an.data.counterfactual.note}</p>
      </div>
      <Panel title="Stopping distance">
        <svg viewBox={`0 0 ${W} 90`} className="w-full">
          <rect x={0} y={35} width={W} height={20} fill="#1a1e25" />
          <rect x={hz - 4} y={25} width={8} height={40} fill="#f5b84f" />
          <text x={hz} y={18} fontSize={11} textAnchor="middle" fill="#f5b84f">hazard</text>
          <rect x={0} y={40} width={Math.min(W, g.stops_at_m * scale)} height={10} rx={3} fill={g.avoided ? "#3ecf8e" : "#ff5d5d"} />
          <text x={Math.min(W - 40, g.stops_at_m * scale + 6)} y={80} fontSize={11} fill="#8a93a0">stops at {g.stops_at_m} m</text>
        </svg>
        <div className="mt-6 flex items-center gap-4">
          <span className="w-28 text-sm text-muted">Initial speed</span>
          <input type="range" min={5} max={80} value={speed} onChange={(e) => setSpeed(+e.target.value)} className="flex-1 accent-[#4f8cff]" />
          <span className="mono w-20 text-right text-lg">{speed} km/h</span>
        </div>
        <p className={`mt-6 text-xl font-semibold ${g.avoided ? "text-ok" : "text-bad"}`}>
          {g.avoided ? `Stops ${g.margin_m} m before the pedestrian.` : `Reaches the pedestrian ${Math.abs(g.margin_m)} m too late to stop.`}
        </p>
        <p className="mono mt-2 text-xs text-muted">Counterfactual simulation, not a finding · assumptions: {JSON.stringify(g.assumptions)}</p>
      </Panel>
    </div>
  );
}
