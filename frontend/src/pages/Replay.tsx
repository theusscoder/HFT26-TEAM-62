import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { useApi, type Event, type Track } from "../lib/api";
import { useClock } from "../lib/clock";
import { KindBadge, Loading, Panel } from "../components/ui";
import TrackMap, { type Metric, type Selection } from "../components/TrackMap";

/* OWNER: P3 (layout, video, chart, witness panel) + P4 (BirdsEye → react-three-fiber 2.5D once homography exists).
   Every panel reads the shared clock `t` (seconds from impact); that is the whole trick. */

interface UiTracks { frame: { units: "px" | "m"; width?: number; height?: number; background?: string }; tracks: (Track & { colour?: string })[] }

const DEMO_COLOURS: Record<string, string> = { car_A: "#e7eaee", car_B: "#ff5d5d", ped_1: "#f5b84f" };

function posAt(tr: Track, t: number) {
  const p = tr.points;
  const i = p.findIndex((q) => q.t >= t);
  if (i === -1) return p[p.length - 1];
  if (i === 0) return p[0];
  const a = p[i - 1], b = p[i], k = (t - a.t) / (b.t - a.t || 1);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Metric bird's-eye (needs homography). Used by the mock demo case. */
export function BirdsEye({ tracks, ghost }: { tracks: Track[]; ghost?: { y: number } | null }) {
  const { t } = useClock();
  const X = (x: number) => (x + 15) * 10, Y = (y: number) => (25 - y) * 3.6;
  return (
    <svg viewBox="0 0 300 420" className="h-full w-full">
      <rect x={X(-3.5)} y={0} width={70} height={420} fill="#1a1e25" />
      <rect x={0} y={Y(12)} width={300} height={Y(4) - Y(12)} fill="#1a1e25" />
      {[...Array(8)].map((_, i) => <rect key={i} x={X(-3.5) + i * 9} y={Y(1)} width={5} height={Y(-1) - Y(1)} fill="#3a404a" />)}
      {tracks.map((tr) => {
        const c = DEMO_COLOURS[tr.id] ?? "#8a93a0";
        const trail = tr.points.filter((q) => q.t <= t);
        const p = posAt(tr, t);
        return (
          <g key={tr.id}>
            <polyline points={trail.map((q) => `${X(q.x)},${Y(q.y)}`).join(" ")} fill="none" stroke={c} strokeOpacity={0.35} strokeWidth={1.5} />
            {tr.class === "person" ? <circle cx={X(p.x)} cy={Y(p.y)} r={4} fill={c} /> : <rect x={X(p.x) - 9} y={Y(p.y) - 13} width={18} height={26} rx={3} fill={c} />}
            <text x={X(p.x) + 12} y={Y(p.y)} fontSize={9} fill="#8a93a0">{tr.id}</text>
          </g>
        );
      })}
      {ghost && <rect x={X(1.75) - 9} y={Y(ghost.y) - 13} width={18} height={26} rx={3} fill="none" stroke="#3ecf8e" strokeDasharray="3 2" />}
    </svg>
  );
}

/** Image-plane trajectory map: real tracks drawn over a still of the camera view (before road calibration). */
function TrajectoryMap({ id, data, focus }: { id: string; data: UiTracks; focus: Set<string> }) {
  const { t } = useClock();
  const W = data.frame.width ?? 960, H = data.frame.height ?? 720;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
      {data.frame.background && <image href={`/api/cases/${id}/file/${data.frame.background}`} width={W} height={H} opacity={0.35} />}
      {data.tracks.map((tr) => {
        const seen = tr.points.filter((q) => q.t <= t);
        const live = seen.length && tr.points[tr.points.length - 1].t >= t - 0.1;
        const strong = focus.has(tr.id);
        const c = tr.colour ?? "#8a93a0";
        if (!seen.length) return null;
        const p = posAt(tr, t);
        return (
          <g key={tr.id} opacity={strong ? 1 : 0.45}>
            <polyline points={seen.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={c} strokeWidth={strong ? 5 : 2.5} strokeLinecap="round" />
            {live ? <>
              <circle cx={p.x} cy={p.y} r={strong ? 11 : 7} fill={c} stroke="#0b0d10" strokeWidth={2} />
              <text x={p.x + 14} y={p.y - 8} fontSize={strong ? 22 : 16} fill="#e7eaee" stroke="#0b0d10" strokeWidth={4} paintOrder="stroke">{tr.id}</text>
            </> : null}
          </g>
        );
      })}
    </svg>
  );
}

function SyncedVideo({ src, t0 }: { src: string; t0: number }) {
  const { t, playing } = useClock();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [playing]);
  useEffect(() => {
    const v = ref.current;
    if (v && Math.abs(v.currentTime - (t + t0)) > (playing ? 0.3 : 0.04)) v.currentTime = Math.max(0, t + t0);
  }, [t, t0, playing]);
  return <video ref={ref} src={src} muted playsInline className="h-full w-full rounded-lg bg-black object-contain" />;
}

export default function Replay() {
  const { id } = useParams();
  const { t, seek, toggle, playing, range } = useClock();
  const c = useApi<any>(`/cases/${id}/case`);
  const metric = useApi<Metric>(`/cases/${id}/tracks_metric`);
  const ui = useApi<UiTracks>(metric.error ? `/cases/${id}/tracks_ui` : null);
  const demo = useApi<{ tracks: Track[] }>(metric.error && ui.error ? `/cases/${id}/tracks` : null);
  const events = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<any>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const [tilt, setTilt] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [sensor, setSensor] = useState<{ t: number; v: number }[] | null>(null);
  const offset = an.data?.offsets?.sensor?.offset_s ?? 0;
  useEffect(() => {
    fetch(`/api/cases/${id}/file/sensor.csv`).then((r) => (r.ok ? r.text() : Promise.reject())).then((txt) =>
      setSensor(txt.trim().split("\n").slice(1).map((l) => { const c = l.split(","); return { t: +(+c[0] + offset).toFixed(2), v: +c[1] }; }))).catch(() => setSensor(null));
  }, [id, offset]);
  if (!c.data || !events.data || (!metric.data && !ui.data && !demo.data)) return <Loading error={c.error ?? events.error ?? demo.error} />;

  const t0 = c.data.t0_video_s ?? 0;
  const hasVideo = c.data.evidence.some((e: any) => e.file === "annotated.mp4");
  const active = events.data.filter((e) => t >= e.t.start - 0.25 && t <= e.t.end + 0.25 && (e.kind !== "OBSERVED" || e.source !== "cctv" || e.confidence >= 0.5))
    .sort((a, b) => (a.kind === "CLAIMED" ? -1 : 0) - (b.kind === "CLAIMED" ? -1 : 0) || b.confidence - a.confidence).slice(0, 10);
  const focus = new Set(active.map((e) => e.actor));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title={metric.data ? "Track map · top view reconstruction" : ui.data ? "Trajectory map · image plane" : "Bird's-eye reconstruction"}
          right={metric.data ? (
            <div className="flex items-center gap-3">
              <span className="mono text-[11px] text-muted">calibrated · metres · ±{Math.round(metric.data.scale_sigma * 100)}%</span>
              <button onClick={() => setTilt(!tilt)} className={`rounded-md border px-2 py-0.5 text-xs ${tilt ? "border-accent text-ink" : "border-line text-muted"}`}>3D</button>
              <Link to="../calibrate" relative="path" className="text-xs text-accent">recalibrate</Link>
            </div>) : <Link to="../calibrate" relative="path" className="text-xs text-accent">calibrate road →</Link>}>
          <div className="aspect-[16/10] w-full">
            {metric.data ? <TrackMap metric={metric.data} events={events.data} entities={an.data?.entities ?? {}} witnesses={wit.data ?? {}} onSelect={setSel} tilt3d={tilt} />
              : ui.data ? <TrajectoryMap id={id!} data={ui.data} focus={focus} /> : <BirdsEye tracks={demo.data!.tracks} />}
          </div>
        </Panel>
        <div className="flex min-h-0 flex-col gap-4">
          {hasVideo && <Panel title="Annotated CCTV"><div className="aspect-[4/3] w-full"><SyncedVideo src={`/api/cases/${id}/file/annotated.mp4`} t0={t0} /></div></Panel>}
          {sel && (
            <Panel title={sel.kind} right={<button onClick={() => setSel(null)} className="text-xs text-muted">close</button>}>
              <div className="font-semibold">{sel.title}</div>
              {sel.lines.map((l, i) => <div key={i} className="text-sm text-muted">{l}</div>)}
              {sel.refs?.map((r) => <div key={r} className="mono mt-1 text-[11px] text-accent">{r}</div>)}
            </Panel>
          )}
          <Panel title="At this moment" className="max-h-[420px] overflow-auto">
            <ul className="space-y-2">
              {active.map((e) => (
                <li key={e.id} className="rounded-lg border border-line bg-panel-2 p-2.5 text-sm">
                  <div className="flex items-center justify-between"><KindBadge kind={e.kind} /><span className="mono text-[11px] text-muted">{e.source}</span></div>
                  <div className="mt-1">{an.data?.entities && Object.entries(an.data.entities).find(([, v]) => v === e.actor)?.[0]?.replace("_", " ") || e.actor} · {e.action.replace("_", " ")} {e.value && <span className="text-muted">({e.value})</span>}</div>
                  {e.quote && <div className="mt-1 italic text-claimed">“{e.quote}”</div>}
                  <div className="mono mt-1 text-[10px] text-muted">{e.ref || (e.derived_from.length ? `from ${e.derived_from.slice(0, 3).join(", ")}` : "")} · conf {Math.round(e.confidence * 100)}%</div>
                </li>
              ))}
              {!active.length && <li className="text-sm text-muted">No evidence covers this instant.</li>}
            </ul>
          </Panel>
        </div>
      </div>
      {sensor && (
        <Panel title="Bus telematics · speed km/h (aligned to T0)">
          <div className="h-[100px]">
            <ResponsiveContainer>
              <LineChart data={sensor}>
                <XAxis dataKey="t" type="number" domain={range} stroke="#8a93a0" fontSize={10} />
                <YAxis stroke="#8a93a0" fontSize={10} width={30} />
                <Line dataKey="v" dot={false} stroke="#4f8cff" isAnimationActive={false} />
                <ReferenceLine x={t} stroke="#e7eaee" />
                <ReferenceLine x={0} stroke="#ff5d5d" strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}
      <div className="sticky bottom-0 z-20 flex items-center gap-4 rounded-xl border border-line bg-panel/95 px-4 py-3 backdrop-blur">
        <button onClick={toggle} className="w-20 rounded-md bg-accent py-1.5 text-sm font-semibold text-white">{playing ? "Pause" : "Play"}</button>
        <button onClick={() => seek(0)} className="rounded-md border border-bad/50 px-3 py-1.5 text-xs text-bad">Jump to impact</button>
        <input type="range" min={range[0]} max={range[1]} step={0.05} value={t} onChange={(e) => seek(+e.target.value)} className="flex-1 accent-[#4f8cff]" />
        <span className="mono w-36 text-right text-sm">T{t >= 0 ? "+" : ""}{t.toFixed(2)} s <span className="text-muted">· {(t + t0).toFixed(2)}</span></span>
      </div>
    </div>
  );
}
