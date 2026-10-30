import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Eye, Pause, Play, RotateCcw, ShieldCheck, Siren, TrafficCone } from "lucide-react";
import { post, useApi } from "../lib/api";
import { Loading, Panel } from "../components/ui";
import type { CityMap } from "../components/CityMap3D";
import KnowledgeGraph from "../components/KnowledgeGraph";

/* Hit-and-run intercept, as a SIMULATION on the real Hyderabad road map. The agent observes camera sightings, predicts where
   the driver will go, picks a spot police can reach first, holds signals so he has one way to go, and re-plans when he turns
   off the plan. An officer approves before it plays. No real signal, camera or radio is touched. */
const CityMap3D = lazy(() => import("../components/CityMap3D"));
const KIND: Record<string, { Icon: any; cls: string }> = { observe: { Icon: Eye, cls: "text-observed" }, plan: { Icon: Bot, cls: "text-claimed" }, signal: { Icon: TrafficCone, cls: "text-ok" }, dispatch: { Icon: Siren, cls: "text-accent" }, decide: { Icon: Bot, cls: "text-muted" } };
const AGENT_CHIP: Record<string, string> = { Tracker: "border-[#4f8cff]/50 text-[#7fb0ff]", Planner: "border-[#c58cff]/50 text-[#d6aaff]", Signal: "border-[#ffc21a]/50 text-[#ffd65c]", Dispatch: "border-accent text-accent" };
const RESULT: Record<string, string> = { contained: "Stopped at the planned spot", dead_end: "Cornered in a road with no way out", left_map: "Left the mapped area", timeout: "Not stopped in time" };
const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function Intercept() {
  const { id } = useParams();
  const map = useApi<CityMap>("/map/hyderabad");
  const [sim, setSim] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [officer, setOfficer] = useState("");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [follow, setFollow] = useState(false);
  const [reach, setReach] = useState(true);
  const [baseline, setBaseline] = useState(false);
  const raf = useRef(0);
  const load = (drill = false) => fetch(`/api/cases/${id}/intercept${drill ? "?drill=true" : ""}`).then((r) => r.ok ? r.json() : Promise.reject(`${r.status}`)).then(setSim).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (!playing || !sim) return;
    let last: number | null = null;
    const step = (now: number) => {
      if (last != null) setT((v) => { const n = v + ((now - last!) / 1000) * speed; if (n >= sim.run.duration) { setPlaying(false); return sim.run.duration; } return n; });
      last = now;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, sim]);

  if (sim && sim.eligible === false) return (
    <div className="max-w-3xl space-y-4">
      <Panel title="Intercept">
        <h2 className="text-2xl font-bold">Nobody to intercept in this case</h2>
        <p className="mt-2 text-sm text-muted">{sim.summary}</p>
        <p className="mt-2 text-sm">The intercept runs when the hit-and-run check finds an involved vehicle leaving the scene. It didn't here{sim.status === "unclear" ? ", though it couldn't rule it out" : ""}.</p>
        <button onClick={() => { setSim(null); load(true); }} className="mt-4 bg-ink px-4 py-2 text-sm font-semibold text-panel">Run a training drill from this case's location</button>
        <p className="mt-2 text-[11px] text-muted">A drill pretends a vehicle fled from here, to practise the plan. It's labelled as a drill throughout.</p>
      </Panel>
    </div>
  );
  if (!sim || !map.data) return <Loading error={err ?? map.error} />;
  const run = sim.run, approved = !!sim.approved_by, ev = sim.evaluation;
  const reachNow = [...run.reach].reverse().find((r: any) => r.t <= t);
  const shown = run.decisions.filter((d: any) => d.t <= t + 0.01);
  const active = run.units.filter((u: any) => u.goal != null);
  const done = t >= run.duration;
  async function approve() { try { setSim(await post(`/cases/${id}/intercept/approve`, { officer })); setT(0); setPlaying(true); } catch (e) { setErr(String(e)); } }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3  border border-warn/50 bg-warn/10 px-4 py-2.5 text-sm text-warn">
        <Siren size={16} /><b>Simulation.</b><span className="text-ink/80">The map is real Hyderabad (OpenStreetMap). The signal control, cameras, traffic, patrol units and the driver's behaviour are simulated{sim.training ? ". TRAINING DRILL: no vehicle left the scene in this case" : ""}{sim.drill ? ". This case has no location on the map, so it starts from Gachibowli" : ""}.</span>
      </div>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="relative overflow-hidden  border border-ink bg-white " style={{ height: "68vh", minHeight: 480 }}>
          <Suspense fallback={<div className="p-6 text-sm text-muted">Loading Hyderabad…</div>}>
            <CityMap3D map={map.data} sim={sim} t={t} follow={follow} showReach={reach} showBaseline={baseline} />
          </Suspense>
          <div className="pointer-events-none absolute left-3 top-3 space-y-1 rounded-lg bg-bg/85 px-3 py-2 text-[11px] text-muted">
            <div><span className="font-semibold text-bad">red</span> suspect · <span className="font-semibold text-accent">blue</span> police · <span className="font-semibold text-ok">green</span> where he's being steered</div>
            <div><span className="font-semibold text-inferred">amber</span> road he could reach in 90 s · bars at junctions: the one green exit, the reds</div>
          </div>
          <div className="pointer-events-none absolute right-3 top-3 rounded-lg bg-bg/85 px-3 py-2 text-right">
            <div className="mono text-2xl font-bold">T+{t.toFixed(0)} s</div>
            <div className="text-[11px] text-muted">{done ? RESULT[run.outcome.result] : `${active.length} unit${active.length === 1 ? "" : "s"} dispatched`}</div>
          </div>
          {!approved && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg/60 backdrop-blur-[2px]">
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-[440px]  border border-line bg-panel p-5">
                <div className="flex items-center gap-2 text-lg font-semibold"><Bot size={18} className="text-claimed" />Intercept plan ready</div>
                <p className="mt-1 text-sm text-muted">{run.decisions.find((d: any) => d.kind === "plan")?.text}</p>
                <p className="mt-2 text-xs text-muted">Signals are held only for the seconds around his arrival. Spots near hospitals are never used. Nothing runs until an officer approves.</p>
                <div className="mt-3 flex gap-2">
                  <input aria-label="Officer name" placeholder="Approving officer's name" value={officer} onChange={(e) => setOfficer(e.target.value)} className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm" />
                  <button disabled={!officer.trim()} onClick={approve} className="rounded-lg bg-bad px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-40">Approve and run</button>
                </div>
              </motion.div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Panel title="Agent" right={approved ? <span className="flex items-center gap-1 text-xs text-ok"><ShieldCheck size={12} />approved by {sim.approved_by}</span> : <span className="text-xs text-warn">awaiting approval</span>}>
            <ol className="max-h-[38vh] space-y-2.5 overflow-auto pr-1">
              <AnimatePresence initial={false}>
                {shown.map((d: any, i: number) => { const K = KIND[d.kind] ?? KIND.decide; return (
                  <motion.li key={i} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex gap-2 text-sm">
                    <K.Icon size={15} className={`mt-0.5 shrink-0 ${K.cls}`} /><span><span className="mono mr-1.5 text-[11px] text-muted">T+{d.t.toFixed(0)}</span>{d.agent && <span className={`mr-1.5 rounded border px-1 py-px text-[10px] font-semibold ${AGENT_CHIP[d.agent] ?? "border-line text-muted"}`}>{d.agent}</span>}{d.text}</span>
                  </motion.li>
                ); })}
              </AnimatePresence>
              {!shown.length && <li className="text-sm text-muted">Press play to watch the agent work.</li>}
            </ol>
          </Panel>
          <Panel title="Narrowing his options">
            {reachNow ? <>
              <div className="flex items-baseline gap-2"><span className="whitespace-nowrap text-3xl font-bold text-inferred">{reachNow.held_km} km</span><span className="text-sm text-muted">he could reach in 90 s, with signals held</span></div>
              <div className="mt-1 text-sm text-muted">{reachNow.free_km} km with every signal running normally</div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-panel-2"><motion.div className="h-full bg-inferred" animate={{ width: `${Math.min(100, (reachNow.held_km / Math.max(reachNow.free_km, 0.1)) * 100)}%` }} /></div>
            </> : <p className="text-sm text-muted">Starts with the first camera sighting.</p>}
          </Panel>
          <Panel title="Units">
            <ul className="space-y-1.5 text-sm">
              {run.units.map((u: any) => <li key={u.id} className="flex justify-between gap-2"><span><span className="mono text-xs text-accent">{u.id}</span> {u.name}</span><span className="text-right text-xs text-muted">{u.goal != null ? `${u.role}${u.arrive != null ? `, in place T+${u.arrive.toFixed(0)} s` : ""}` : "on patrol"}</span></li>)}
            </ul>
          </Panel>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3  border border-line bg-panel px-4 py-3">
        <button disabled={!approved} onClick={() => { if (done) setT(0); setPlaying(!playing); }} className="flex w-24 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-sm font-semibold text-white disabled:opacity-40">{done ? <RotateCcw size={14} /> : playing ? <Pause size={14} /> : <Play size={14} />}{done ? "Replay" : playing ? "Pause" : "Play"}</button>
        <input aria-label="Time" type="range" disabled={!approved} min={0} max={run.duration} step={0.5} value={t} onChange={(e) => { setPlaying(false); setT(+e.target.value); }} className="min-w-[200px] flex-1 accent-[#4f8cff]" />
        <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(+e.target.value)} className="rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-xs">{[1, 2, 4, 8, 16].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
        <label className="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />follow suspect</label>
        <label className="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" checked={reach} onChange={(e) => setReach(e.target.checked)} />reachable road</label>
        <label className="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} />without the system</label>
      </div>

      {sim.graph && (
        <Panel title="Knowledge graph" right={<span className="text-xs text-muted">facts appear as the agents learn them</span>} className="border-ink bg-white">
          <KnowledgeGraph graph={sim.graph} t={approved ? t : 0} />
        </Panel>
      )}

      <Panel title={`Does steering help? ${ev.agent_signals.runs} simulated runs each, same map and driver model`}>
        <div className="grid gap-4 md:grid-cols-4">
          {([["agent_signals", "Agents + signal control", "text-ok"], ...(ev.agent_defied ? [["agent_defied", "Same, but he jumps one red", "text-ok"]] : []), ["agent_only", "Agent, signals untouched", "text-warn"], ["chase", "Radio chase of the last sighting", "text-muted"]] ).map(([k, label, tone]: any, i: number) => (
            <div key={k} className=" bg-panel-2/70 p-3">
              <div className={`text-3xl font-bold ${tone}`}>{pct(ev[k].rate)}</div>
              <div className="text-sm">{label}</div>
              <div className="mt-1 text-xs text-muted">stopped in {ev[k].contained}/{ev[k].runs}{ev[k].median_s != null ? `, median ${Math.round(ev[k].median_s)} s` : ""}{ev[k].left_map ? `, ${ev[k].left_map} left the map` : ""}</div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel"><motion.div className={`h-full ${k === "agent_signals" ? "bg-ok" : k === "agent_only" ? "bg-warn" : "bg-muted"}`} initial={{ width: 0 }} animate={{ width: pct(ev[k].rate) }} transition={{ duration: 0.8, delay: i * 0.1 }} /></div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">This tests the plan against its own assumptions, so it shows the method works if drivers behave as modelled. It isn't evidence that they do. Assumptions: {sim.assumptions.join(" ")}</p>
        <p className="mt-1 text-[11px] text-muted">Map data {sim.attribution}.</p>
      </Panel>
    </div>
  );
}
