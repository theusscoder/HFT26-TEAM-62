import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Play, RotateCcw } from "lucide-react";
import { post, useApi, type Analysis } from "../lib/api";
import { Loading, Panel, Stat } from "../components/ui";

/* The counterfactual, played out. Backend physics: d = v*t_r + v^2/(2*mu*g). Change speed, reaction time or road
   and watch where the vehicle would have stopped against where the hazard was. A simulation, not a finding. */
interface Ghost { speed_kmh: number; hazard_at_m: number; stops_at_m: number; margin_m: number; avoided: boolean; samples: { t: number; x: number; v_kmh: number }[]; assumptions: any }

export default function Avoidable() {
  const { id } = useParams();
  const an = useApi<Analysis>(`/cases/${id}/analysis`);
  const [speed, setSpeed] = useState<number | null>(null);
  const [reaction, setReaction] = useState(1.0);
  const [wet, setWet] = useState<boolean | null>(null);
  const [g, setG] = useState<Ghost | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const raf = useRef(0);
  useEffect(() => { if (an.data?.counterfactual && speed == null) setSpeed(Math.round(an.data.counterfactual.observed_speed_kmh)); }, [an.data]);
  useEffect(() => {
    if (an.data?.counterfactual && speed != null)
      post<Ghost>(`/cases/${id}/counterfactual`, { speed_kmh: speed, reaction_s: reaction, ...(wet == null ? {} : { mu: wet ? 0.4 : 0.7 }) }).then((r) => { setG(r); setClock(null); });
  }, [id, speed, reaction, wet, an.data]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  if (an.data && !an.data.counterfactual) return <Loading error="404 needs a calibrated speed (road homography) or a sensor log for this case" />;
  if (!an.data || !g || speed == null) return <Loading error={an.error} />;

  function play() {
    cancelAnimationFrame(raf.current);
    const end = g!.samples[g!.samples.length - 1]?.t ?? 0, start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / 1000;
      setClock(Math.min(t, end));
      if (t < end) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }
  const sample = clock == null ? g.samples[g.samples.length - 1] : g.samples.find((s) => s.t >= clock) ?? g.samples[g.samples.length - 1];
  const x = sample?.x ?? 0;
  const W = 760, span = Math.max(12, g.hazard_at_m * 1.5, g.stops_at_m * 1.15), sc = (W - 40) / span, hz = 20 + g.hazard_at_m * sc, reactEnd = g.samples.find((s) => s.t >= reaction)?.x ?? 0;
  const tone = g.avoided ? "#3ecf8e" : "#ff5d5d";
  const mu = g.assumptions?.mu ?? 0.7;
  const v = speed / 3.6;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Could it have been avoided?</h1>
        <p className="text-sm text-muted">{an.data.counterfactual.note}</p>
      </div>
      <Panel title="Play it out" right={<button onClick={play} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white transition hover:brightness-110">{clock != null && clock >= (g.samples[g.samples.length - 1]?.t ?? 0) ? <RotateCcw size={13} /> : <Play size={13} />}Play</button>}>
        <svg viewBox={`0 0 ${W} 130`} className="w-full" role="img" aria-label={`Stops at ${g.stops_at_m} metres, hazard at ${g.hazard_at_m} metres`}>
          <rect x={0} y={44} width={W} height={46} fill="#1a1e25" rx={6} />
          <line x1={0} x2={W} y1={67} y2={67} stroke="#5d6570" strokeDasharray="14 12" strokeWidth={1.5} />
          <rect x={20} y={46} width={Math.min(W - 20, reactEnd * sc)} height={42} fill="#f5b84f" opacity={0.12} />
          <text x={22} y={38} fontSize={11} fill="#f5b84f">reaction: still at full speed</text>
          <rect x={20 + reactEnd * sc} y={46} width={Math.max(0, Math.min(W - 20 - reactEnd * sc, (g.stops_at_m - reactEnd) * sc))} height={42} fill={tone} opacity={0.14} />
          <line x1={hz} x2={hz} y1={30} y2={102} stroke="#f5b84f" strokeWidth={3} />
          <text x={hz} y={22} fontSize={12} fontWeight={600} textAnchor="middle" fill="#f5b84f">hazard · {g.hazard_at_m} m</text>
          <g transform={`translate(${20 + x * sc}, 67)`}>
            <rect x={-26} y={-11} width={26} height={22} rx={5} fill={tone} />
            <rect x={-9} y={-8} width={6} height={16} rx={2} fill="#0b0d10" opacity={0.55} />
          </g>
          <text x={Math.min(W - 70, 20 + g.stops_at_m * sc)} y={118} fontSize={12} fill="#8a93a0" textAnchor="middle">stops at {g.stops_at_m} m</text>
        </svg>
        <div className="mt-2 grid gap-3 md:grid-cols-3">
          <label className="text-sm"><span className="flex justify-between"><span className="text-muted">Initial speed</span><span className="mono">{speed} km/h</span></span><input aria-label="Initial speed" type="range" min={5} max={80} value={speed} onChange={(e) => setSpeed(+e.target.value)} className="mt-1 w-full accent-[#4f8cff]" /></label>
          <label className="text-sm"><span className="flex justify-between"><span className="text-muted">Reaction time</span><span className="mono">{reaction.toFixed(1)} s</span></span><input aria-label="Reaction time" type="range" min={0.3} max={2.5} step={0.1} value={reaction} onChange={(e) => setReaction(+e.target.value)} className="mt-1 w-full accent-[#4f8cff]" /></label>
          <div className="text-sm"><div className="text-muted">Road</div><div className="mt-1 flex gap-1">
            {([[null, "From the case"], [false, "Dry"], [true, "Wet"]] as const).map(([val, label]) => <button key={label} onClick={() => setWet(val)} className={`flex-1 rounded-lg border px-2 py-1 text-xs transition ${wet === val ? "border-accent bg-accent/15" : "border-line text-muted hover:text-ink"}`}>{label}</button>)}
          </div></div>
        </div>
        <motion.p key={`${g.avoided}${g.margin_m}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className={`mt-5 text-xl font-semibold ${g.avoided ? "text-ok" : "text-bad"}`}>
          {g.avoided ? `Stops ${g.margin_m} m before the hazard.` : `Reaches the hazard with ${Math.abs(g.margin_m)} m still needed to stop.`}
        </motion.p>
      </Panel>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Metres while reacting" value={v * reaction} decimals={1} suffix=" m" />
        <Stat label="Metres braking" value={(v * v) / (2 * mu * 9.81)} decimals={1} suffix=" m" delay={0.05} />
        <Stat label="Total to stop" value={g.stops_at_m} decimals={1} suffix=" m" delay={0.1} />
        <Stat label="Road available" value={g.hazard_at_m} decimals={1} suffix=" m" delay={0.15} tone="text-inferred" />
      </div>
      <Panel title="The math">
        <p className="mono text-sm">d = v·t + v² / (2·μ·g)</p>
        <p className="mono mt-1 text-sm text-muted">= {v.toFixed(2)} × {reaction.toFixed(1)} + {v.toFixed(2)}² / (2 × {mu} × 9.81) = {(v * reaction + (v * v) / (2 * mu * 9.81)).toFixed(2)} m</p>
        <p className="mt-2 text-xs text-muted">Speed in m/s, friction μ {g.assumptions?.note ?? ""}. A simulation, not a finding: it assumes constant braking on a straight path.</p>
      </Panel>
    </div>
  );
}
