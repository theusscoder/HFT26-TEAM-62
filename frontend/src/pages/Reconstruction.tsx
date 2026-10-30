import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";
import { useApi, type Event } from "../lib/api";
import { useClock } from "../lib/clock";
import { Loading, Panel } from "../components/ui";
import TopView, { type Metric, type Selection } from "../components/TopView";
import { at, type CamPreset } from "../components/Scene3D";
import KeyFindings, { type Finding } from "../components/Findings";
import DriverView, { type Dashcam } from "../components/DriverView";

/* OWNER: P4. B1: the reconstruction, built for the person investigating.
   Two views of the same calibrated scene on the shared clock: Top view (plan, speed-coloured paths with 1 s ticks)
   and Bird's-eye 3D (true-scale vehicles, speed curtain, witness line of sight, camera presets).
   Key-moment chips jump the clock; the side panel shows each key actor's speed with its uncertainty. */

const Scene3D = lazy(() => import("../components/Scene3D"));

export default function Reconstruction() {
  const { id } = useParams();
  const { t, seek, toggle, playing, range } = useClock();
  const metric = useApi<Metric>(`/cases/${id}/tracks_metric`);
  const events = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<any>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const ins = useApi<Finding[]>(`/cases/${id}/insights`);
  const dash = useApi<Dashcam>(`/cases/${id}/dashcam`);
  const [view, setView] = useState<"driver" | "top" | "3d" | null>(null);
  const [preset, setPreset] = useState<CamPreset>("bird");
  const [curtain, setCurtain] = useState(true);
  const [sight, setSight] = useState(true);
  const [sel, setSel] = useState<Selection | null>(null);

  const ent = an.data?.entities;
  const isDash = !!dash.data;
  const v = view ?? (isDash ? "driver" : "top");
  const large = useMemo(() => new Set<string>(ent?.large ?? []), [ent]);
  if (metric.error) return (
    <Panel title="Reconstruction">
      <p className="text-sm text-muted">This case has no road calibration yet, so positions and speeds cannot be put in metres.</p>
      <Link to="../calibrate" relative="path" className="mt-3 inline-block text-sm text-accent">Calibrate the road →</Link>
    </Panel>
  );
  if (!metric.data || !events.data || !an.data) return <Loading error={events.error ?? an.error} />;

  const names: Record<string, string> = ent?.names ?? {};
  const keyIds: string[] = [ent?.primary, ...(ent?.involved ?? [])].filter(Boolean);
  const keyTracks = metric.data.tracks.filter((tr) => keyIds.includes(tr.id));
  const prim = keyTracks.find((tr) => tr.id === ent?.primary);
  const W = wit.data ?? {};
  const brake = events.data.find((e) => e.action === "brake" && e.kind !== "CLAIMED" && e.actor === ent?.primary && e.t.start < 0);
  const rest = prim ? prim.points.find((p, i, a) => p.t > 0 && a.slice(i).every((q) => q.v_kmh < 3)) : undefined;
  const moments = [
    prim && { label: "first seen", t: prim.points[0].t },
    brake && { label: "braking", t: brake.t.start },
    { label: "impact", t: 0 },
    rest && { label: "at rest", t: rest.t },
  ].filter(Boolean) as { label: string; t: number }[];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-line p-0.5">
          {((isDash ? [["driver", "Driver's view"], ["top", "Top view"], ["3d", "Bird's-eye 3D"]] : [["top", "Top view"], ["3d", "Bird's-eye 3D"]]) as ["driver" | "top" | "3d", string][]).map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className={`rounded-md px-3 py-1.5 text-sm ${v === k ? "bg-accent text-white" : "text-muted hover:text-ink"}`}>{l}</button>
          ))}
        </div>
        {v === "3d" && (
          <div className="flex flex-wrap rounded-lg border border-line p-0.5 text-xs">
            {([["bird", "Bird's-eye"], ["top", "Overhead"], ["chase", "Follow vehicle"], ...Object.entries(W).filter(([, m]: any) => m.position_m).map(([w, m]: any) => [`witness:${w}`, `${m.name}'s view`])] as [CamPreset, string][]).map(([p, l]) => (
              <button key={p} onClick={() => setPreset(p)} className={`rounded-md px-2.5 py-1 ${preset === p ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"}`}>{l}</button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm text-muted">
          {v === "3d" && <label className="flex items-center gap-1.5"><input type="checkbox" checked={curtain} onChange={(e) => setCurtain(e.target.checked)} />speed curtain</label>}
          {Object.values(W).some((m: any) => m.position_m) && <label className="flex items-center gap-1.5"><input type="checkbox" checked={sight} onChange={(e) => setSight(e.target.checked)} />witness line of sight</label>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-line">
          {v === "driver" && dash.data
            ? <div className="h-full p-3"><DriverView dc={dash.data} t={t} names={names} egoName={(names[ent?.primary] ?? "You").replace(" (primary)", "")} /></div>
            : v === "top"
            ? <TopView metric={metric.data} t={t} events={events.data} entities={ent} witnesses={W} sight={sight} large={large} onSelect={setSel} findings={ins.data} />
            : <Suspense fallback={<div className="p-6 text-sm text-muted">Loading 3D…</div>}>
                <Scene3D metric={metric.data} t={t} entities={ent} witnesses={W} preset={preset} curtain={curtain} sight={sight} large={large} findings={ins.data} />
              </Suspense>}
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-bg/80 px-3 py-2 text-[11px] text-muted">
            <div className="flex items-center gap-2">speed
              <span className="h-2 w-24 rounded" style={{ background: "linear-gradient(90deg,#3ecf8e,#f5b84f,#ff5d5d)" }} />
              <span className="mono">0–{Math.max(10, ...keyTracks.flatMap((tr) => tr.points.map((p) => p.v_kmh))).toFixed(0)} km/h</span>
            </div>
            {sight && Object.values(W).some((m: any) => m.position_m) && <div className="mt-1"><span className="text-ok">green</span> = witness can see the vehicle · <span className="text-bad">red</span> = view blocked</div>}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Key findings" className="max-h-[480px] overflow-auto" right={<span className="text-[10px] text-muted">click to jump</span>}>
            <KeyFindings findings={ins.data ?? []} />
          </Panel>
          <Panel title="Key actors">
            <ul className="space-y-3">
              {keyTracks.map((tr) => {
                const p = at(tr, t);
                return (
                  <li key={tr.id}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-medium">{names[tr.id] ?? tr.id}</span>
                      <span className="mono">{p.live ? `${p.v_kmh.toFixed(0)} ± ${(p.v_kmh * metric.data!.scale_sigma + 2).toFixed(0)} km/h` : "out of view"}</span>
                    </div>
                    <div className="h-10">
                      <ResponsiveContainer>
                        <LineChart data={tr.points.filter((q) => q.t >= range[0] && q.t <= range[1])}>
                          <YAxis hide domain={[0, "dataMax"]} />
                          <Line dataKey="v_kmh" dot={false} stroke="#4f8cff" strokeWidth={1.5} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </li>
                );
              })}
              {!keyTracks.length && <li className="text-sm text-muted">No vehicle could be identified as involved.</li>}
            </ul>
          </Panel>
          {sel && (
            <Panel title={sel.kind} right={<button onClick={() => setSel(null)} className="text-xs text-muted">close</button>}>
              <div className="font-semibold">{sel.title}</div>
              {sel.lines.map((l, i) => <div key={i} className="text-sm text-muted">{l}</div>)}
              {sel.refs?.map((r) => <div key={r} className="mono mt-1 text-[11px] text-accent">{r}</div>)}
            </Panel>
          )}
          <Panel title="How accurate is this?">
            <p className="text-sm">Positions and speeds are <b>±{Math.round(metric.data.scale_sigma * 100)}%</b>.</p>
            <p className="mt-1 text-xs text-muted">{metric.data.auto ? "Auto-calibrated from object sizes (no measured road points)." : "Calibrated from measured road points."} {metric.data.note?.split(". ")[0]}.</p>
            <Link to="../calibrate" relative="path" className="mt-2 inline-block text-xs text-accent">refine calibration →</Link>
          </Panel>
        </div>
      </div>

      <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel/95 px-4 py-3 backdrop-blur">
        <button onClick={toggle} className="w-20 rounded-md bg-accent py-1.5 text-sm font-semibold text-white">{playing ? "Pause" : "Play"}</button>
        {moments.map((m) => (
          <button key={m.label} onClick={() => seek(m.t)} className={`rounded-md border px-2.5 py-1 text-xs ${m.label === "impact" ? "border-bad/60 text-bad" : "border-line text-muted hover:text-ink"}`}>
            {m.label} <span className="mono">{m.t >= 0 ? "+" : ""}{m.t.toFixed(1)}s</span>
          </button>
        ))}
        <input type="range" min={range[0]} max={range[1]} step={0.05} value={t} onChange={(e) => seek(+e.target.value)} className="min-w-[200px] flex-1 accent-[#4f8cff]" />
        <span className="mono w-24 text-right text-sm">T{t >= 0 ? "+" : ""}{t.toFixed(2)} s</span>
      </div>
    </div>
  );
}
