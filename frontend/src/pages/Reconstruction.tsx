import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";
import { useApi, type Event } from "../lib/api";
import { useClock } from "../lib/clock";
import { Loading, Panel } from "../components/ui";
import TopView, { type Metric, type Selection } from "../components/TopView";
import KeyFindings, { type Finding } from "../components/Findings";
import DriverView, { type Dashcam } from "../components/DriverView";
import { at, type CamPreset, type Look, type SceneData } from "../components/Scene3D";

/* OWNER: P4. B1: the reconstruction, built for the person investigating.
   Two views of the same scene on the shared clock: Top view (plan, speed-coloured paths with 1 s ticks) and 3D (the
   real place projected from the solved camera, vehicles fitted to the footage, cinematic and witness cameras).
   CCTV match puts the 3D over the actual video from the actual camera, which is the proof it is real.
   Key-moment chips jump the clock; the side panel shows each key actor's speed with its uncertainty. */

const Scene3D = lazy(() => import("../components/Scene3D"));
const SLOW_FROM = -1.5, SLOW_TO = 1.0, SLOW_RATE = 0.3;

// The real footage, held to the shared clock. Only re-seeks on real drift, so playback stays smooth.
function Footage({ caseId, t, t0, playing, rate }: { caseId: string; t: number; t0: number; playing: boolean; rate: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.playbackRate = rate;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
    if (Math.abs(v.currentTime - (t + t0)) > (playing ? 0.15 : 0.02)) v.currentTime = Math.max(0, t + t0);
  }, [t, t0, playing, rate]);
  return <video ref={ref} src={`/api/cases/${caseId}/file/cctv.mp4`} muted playsInline preload="auto" className="absolute inset-0 h-full w-full" />;
}

export default function Reconstruction() {
  const { id } = useParams();
  const { t, seek, toggle, playing, range, setRate } = useClock();
  const scene = useApi<SceneData>(`/cases/${id}/scene3d`);
  const caseData = useApi<any>(`/cases/${id}/case`);
  const metric = useApi<Metric>(`/cases/${id}/tracks_metric`);
  const events = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<any>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const ins = useApi<Finding[]>(`/cases/${id}/insights`);
  const dash = useApi<Dashcam>(`/cases/${id}/dashcam`);
  const [view, setView] = useState<"driver" | "top" | "3d">("3d");
  const [preset, setPreset] = useState<CamPreset>("bird");
  const [look, setLook] = useState<Look>("twin");
  const [curtain, setCurtain] = useState(false);
  const [slow, setSlow] = useState(true);
  const [effects, setEffects] = useState(true);
  const [boxes, setBoxes] = useState(false);
  const [blend, setBlend] = useState(60);
  const [immersive, setImmersive] = useState(true);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setImmersive(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  const [sight, setSight] = useState(false);
  const [solid, setSolid] = useState(true);
  const [sel, setSel] = useState<Selection | null>(null);

  const ent = an.data?.entities;
  const large = useMemo(() => new Set<string>(ent?.large ?? []), [ent]);
  const rate = slow && t > SLOW_FROM && t < SLOW_TO ? SLOW_RATE : 1;
  useEffect(() => { setRate(rate); return () => setRate(1); }, [rate]);
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
  const cctv = view === "3d" && preset === "cctv" && !!scene.data;
  const brake = events.data.find((e) => e.action === "brake" && e.actor === ent?.primary && e.t.start < 0);
  const rest = prim ? prim.points.find((p, i, a) => p.t >= 0 && a.slice(i).every((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1)) : undefined;
  const moments = [
    prim && { label: "first seen", t: prim.points[0].t },
    brake && { label: "braking", t: brake.t.start },
    { label: "impact", t: 0 },
    rest && { label: "at rest", t: rest.t },
  ].filter(Boolean) as { label: string; t: number }[];

  return (
    <div className="flex flex-col gap-4">
      <div className={immersive ? "fixed left-5 right-5 top-4 z-[60] flex flex-wrap items-center gap-3  border border-ink bg-white/90 px-3 py-2 backdrop-blur-md" : "flex flex-wrap items-center gap-3"}>
        {immersive && <Link to=".." relative="path" className="rounded-lg px-2 py-1 text-sm text-muted hover:text-ink">← Case</Link>}
        <button onClick={() => setImmersive(!immersive)} className="rounded-lg border border-accent px-3 py-1.5 text-sm font-semibold text-accent transition hover:bg-accent/10">{immersive ? "Exit full screen (Esc)" : "Full screen"}</button>
        {view === "3d" && scene.data && (
          <div className="flex rounded-lg border border-line p-0.5">
            {([["twin", "Digital twin"], ["photo", "Real footage"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => { setLook(v); if (preset === "cctv") setPreset("bird"); }} className={`rounded-md px-3 py-1.5 text-sm ${look === v && !cctv ? "bg-ink text-white" : "text-muted hover:text-ink"}`}>{l}</button>
            ))}
          </div>
        )}
        {view === "3d" && (
          <div className="flex flex-wrap rounded-lg border border-line p-0.5 text-xs">
            {([["cinema", "Cinematic"], ...(scene.data ? [["cctv", "CCTV match"]] : []), ["bird", "Overview"], ["top", "Overhead"], ["chase", "Follow vehicle"], ...Object.entries(W).filter(([, m]: any) => m.position_m).map(([w, m]: any) => [`witness:${w}`, `${m.name}'s view`])] as [CamPreset, string][]).map(([p, l]) => (
              <button key={p} onClick={() => setPreset(p)} className={`rounded-md px-2.5 py-1 ${preset === p ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"}`}>{l}</button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm text-muted">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} />slow-mo at impact</label>
          {view === "3d" && !cctv && <label className="flex items-center gap-1.5"><input type="checkbox" checked={curtain} onChange={(e) => setCurtain(e.target.checked)} />speed curtain</label>}
          {view === "3d" && !cctv && <label className="flex items-center gap-1.5"><input type="checkbox" checked={effects} onChange={(e) => setEffects(e.target.checked)} />impact effect</label>}
          {cctv && <label className="flex items-center gap-1.5"><input type="checkbox" checked={boxes} onChange={(e) => setBoxes(e.target.checked)} />fitted boxes</label>}
          {cctv && <label className="flex items-center gap-1.5"><input type="checkbox" checked={solid} onChange={(e) => setSolid(e.target.checked)} />solid vehicles</label>}
          {Object.values(W).some((m: any) => m.position_m) && <label className="flex items-center gap-1.5"><input type="checkbox" checked={sight} onChange={(e) => setSight(e.target.checked)} />witness line of sight</label>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className={immersive ? "fixed inset-0 z-50 overflow-hidden bg-black" : "relative aspect-[16/9] w-full overflow-hidden  border border-line bg-black"}>
          {view === "driver" && dash.data
            ? <div className="h-full bg-white p-3"><DriverView dc={dash.data} t={t} names={ent?.names ?? {}} egoName={(ent?.names?.[ent?.primary] ?? "You").replace(" (primary)", "")} /></div>
            : view === "top"
            ? <TopView metric={metric.data} t={t} events={events.data} entities={ent} witnesses={W} sight={sight} large={large} onSelect={setSel} findings={ins.data} />
            : <Suspense fallback={<div className="p-6 text-sm text-muted">Loading 3D…</div>}>
                {/* In CCTV match the frame takes the video's own shape, because the solved lens assumes it. */}
                {/* Oversized, not CSS-scaled, to crop the video's black bars: the 3D canvas measures its own box, and a scale would apply twice. */}
                <div className="absolute" style={cctv
                  ? { left: "50%", top: "50%", height: `${(100 * scene.data!.camera.height) / (scene.data!.camera.content[3] - scene.data!.camera.content[1])}%`, aspectRatio: `${scene.data!.camera.width} / ${scene.data!.camera.height}`, transform: "translate(-50%, -50%)" }
                  : { inset: 0 }}>
                  {cctv && <Footage caseId={id!} t={t} t0={caseData.data?.t0_video_s ?? 0} playing={playing} rate={rate} />}
                  <div className="absolute inset-0" style={cctv ? { opacity: blend / 100 } : undefined}>
                    <Scene3D caseId={id!} metric={metric.data} scene={scene.data} t={t} entities={ent} witnesses={W} preset={preset} curtain={curtain} sight={sight} large={large} effects={effects} showBoxes={cctv && boxes} solid={solid} look={look} />
                  </div>
                </div>
              </Suspense>}
          <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line bg-bg/85 text-xs">
            {((dash.data ? [["driver", "DRV"], ["top", "2D"], ["3d", "3D"]] : [["top", "2D"], ["3d", "3D"]]) as ["driver" | "top" | "3d", string][]).map(([v, l]) => (
              <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`px-2.5 py-2 font-semibold ${view === v ? "bg-ink text-white" : "text-muted hover:text-ink"}`}>{l}</button>
            ))}
          </div>
          {view === "3d" && prim && (() => {
            const p = at(prim, t), gone = !p.live;
            const q = at(prim, t - 0.3), r = at(prim, t + 0.3), g = ((r.v_kmh - q.v_kmh) / 3.6 / 0.6) / 9.81;
            return !gone && (
              <div className="pointer-events-none absolute right-3 top-3 rounded-lg bg-bg/85 px-3 py-2 text-right">
                <div className="mono text-2xl font-bold leading-none">{p.v_kmh.toFixed(0)}<span className="ml-1 text-xs font-normal text-muted">km/h</span></div>
                <div className={`mono mt-1 text-[11px] ${g < -0.12 ? "text-bad" : "text-muted"}`}>{g < -0.12 ? `braking ${Math.abs(g).toFixed(2)} g` : g > 0.12 ? `speeding up ${g.toFixed(2)} g` : "steady"}</div>
                {rate < 1 && playing && <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-warn">slow motion</div>}
              </div>
            );
          })()}
          {cctv && (
            <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg bg-bg/85 px-3 py-2 text-xs text-muted">
              <span>Footage only</span>
              <input aria-label="Blend between footage and 3D" type="range" min={0} max={100} value={blend} onChange={(e) => setBlend(+e.target.value)} className="flex-1 accent-[#4f8cff]" />
              <span>Overlay</span>
            </div>
          )}
          <div className={`pointer-events-none absolute left-3 top-3 rounded-lg bg-bg/80 px-3 py-2 text-[11px] text-muted ${cctv ? "hidden" : ""}`}>
            <div className="flex items-center gap-2">speed
              <span className="h-2 w-24 rounded" style={{ background: "linear-gradient(90deg,#3ecf8e,#f5b84f,#ff5d5d)" }} />
              <span className="mono">0–{Math.max(10, ...keyTracks.flatMap((tr) => tr.points.map((p) => p.v_kmh))).toFixed(0)} km/h</span>
            </div>
            {sight && Object.values(W).some((m: any) => m.position_m) && <div className="mt-1"><span className="text-ok">green</span> = witness can see the vehicle · <span className="text-bad">red</span> = view blocked</div>}
          </div>
        </div>

        <div className={immersive ? "fixed bottom-24 left-5 top-24 z-[60] flex w-[300px] flex-col gap-3 overflow-auto opacity-95" : "flex flex-col gap-4"}>
          {ins.data && ins.data.length > 0 && (
            <Panel title="Key findings" className="max-h-[420px] overflow-auto" right={<span className="text-[10px] text-muted">click to jump</span>}>
              <KeyFindings findings={ins.data} />
            </Panel>
          )}
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
          {view === "3d" && scene.data && (
            <Panel title="Is this real?">
              <div className="flex items-baseline gap-2"><span className="text-3xl font-bold text-ok">{Math.round((scene.data.fit.iou_key ?? scene.data.fit.iou_all ?? 0) * 100)}%</span><span className="text-sm text-muted">overlap with the footage</span></div>
              <p className="mt-1 text-xs text-muted">Each fitted vehicle is projected back into the frame and compared with what the detector saw, over {scene.data.fit.frames_checked.toLocaleString()} boxes. Switch to CCTV match to see it.</p>
              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between gap-3"><dt className="text-muted">Camera</dt><dd className="text-right">{scene.data.camera.height_m.toFixed(1)} m up, {scene.data.camera.fov_deg.toFixed(0)}° lens</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Solved from</dt><dd className="text-right">{scene.data.camera.method}{scene.data.camera.people_used ? ` (${scene.data.camera.people_used} sightings)` : ""}</dd></div>
                {scene.data.actors?.model && <div className="flex justify-between gap-3"><dt className="text-muted">Qwen vision</dt><dd className="text-right">{scene.data.actors.asked} road users checked; {scene.data.actors.riders_on_tracked_bikes + scene.data.actors.riders_seen_by_vision} riders put back on bikes</dd></div>}
                {scene.data.scale_check && <div className="flex justify-between gap-3"><dt className="text-muted">Road map vs camera</dt><dd className="text-right">×{scene.data.scale_check.map_vs_camera_across_road} across, ×{scene.data.scale_check.map_vs_camera_along_road} along</dd></div>}
              </dl>
              <p className="mt-3 text-[11px] text-muted"><span className="text-ink">Measured:</span> positions, speeds, headings, sizes, brake lamps and body pitch. <span className="text-ink">From the footage:</span> the road and the vehicles' visible faces. <span className="text-ink">Illustrative:</span> the sparks, the shape of anything the camera couldn't see{look === "twin" && !cctv ? ", and the surrounding buildings. The city isn't the real one" : ""}.</p>
            </Panel>
          )}
          <Panel title="How accurate is this?">
            <p className="text-sm">Positions and speeds are <b>±{Math.round(metric.data.scale_sigma * 100)}%</b>.</p>
            <p className="mt-1 text-xs text-muted">{metric.data.auto ? "Auto-calibrated from object sizes (no measured road points)." : "Calibrated from measured road points."} {metric.data.note?.split(". ")[0]}.</p>
            <Link to="../calibrate" relative="path" className="mt-2 inline-block text-xs text-accent">refine calibration →</Link>
          </Panel>
        </div>
      </div>

      <div className={`${immersive ? "fixed inset-x-5 bottom-4 z-[60] border-ink bg-white/90" : "sticky bottom-0 z-20 border-line bg-panel/95"} flex flex-wrap items-center gap-3  border px-4 py-3 backdrop-blur`}>
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
