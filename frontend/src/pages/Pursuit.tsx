import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, HelpCircle, MapPin, Play, RotateCcw } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading, Panel, Ref } from "../components/ui";
import TollCapture from "../components/TollCapture";
import FaceCheck from "../components/FaceCheck";
import LicencePanel from "../components/LicencePanel";

/* Hit-and-run, from what the case can show: who stayed and who left (track rules), the plate Qwen could read on
   the sharpest crops, and, with coordinates, the reach of the vehicle over time against a toll log that is
   fictional and labelled so. Every result is a candidate for authorised follow-up, not an identification. */

const VERDICT = {
  stayed: { Icon: CheckCircle2, tone: "border-ok/40 bg-ok/10 text-ok", title: "No hit-and-run in this footage" },
  departed: { Icon: AlertTriangle, tone: "border-bad/50 bg-bad/10 text-bad", title: "A vehicle left the scene" },
  unclear: { Icon: HelpCircle, tone: "border-warn/40 bg-warn/10 text-warn", title: "Can't be ruled out" },
} as const;
const STATUS: Record<string, { label: string; cls: string }> = {
  stopped: { label: "stayed", cls: "bg-ok/15 text-ok" },
  lost_at_rest: { label: "last seen at rest", cls: "bg-ok/15 text-ok" },
  left_view: { label: "left view", cls: "bg-bad/15 text-bad" },
  moving: { label: "still moving", cls: "bg-warn/15 text-warn" },
  uncertain: { label: "unclear", cls: "bg-warn/15 text-warn" },
  not_seen_after: { label: "not tracked after", cls: "bg-panel-2 text-muted" },
};

// The vehicle's own path after T0, drawn on when the card appears. Red dot = where it was at impact.
function PathSketch({ path, left }: { path: number[][]; left: boolean }) {
  const pts = path.filter((p) => p[0] >= -1.5);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[2]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 2);
  const W = 150, H = 54, k = Math.min((W - 16) / span, (H - 16) / span);
  const sx = (v: number) => (W - (x1 - x0) * k) / 2 + (v - x0) * k, sy = (v: number) => (H - (y1 - y0) * k) / 2 + (v - y0) * k;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p[2]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
  const at0 = pts.reduce((a, b) => (Math.abs(b[0]) < Math.abs(a[0]) ? b : a));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" role="img" aria-label="Path around the impact">
      <motion.path d={d} fill="none" stroke={left ? "#ff5d5d" : "#3ecf8e"} strokeWidth={2.5} strokeLinecap="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: "easeInOut" }} />
      <circle cx={sx(at0[2])} cy={sy(at0[1])} r={3.5} fill="#ff5d5d" />
    </svg>
  );
}

function VehicleCard({ v, caseId, i }: { v: any; caseId: string; i: number }) {
  const s = STATUS[v.status] ?? STATUS.uncertain;
  const plate = v.plate;
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.12 }} className="overflow-hidden  border border-line bg-panel">
      <div className="flex gap-3 p-3">
        {v.thumb ? <img src={`/api/cases/${caseId}/keyframes/${v.thumb}`} alt={v.name} className="h-20 w-28 shrink-0 rounded-lg object-cover" />
          : <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-[11px] text-muted">no crop</div>}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="truncate font-semibold">{v.name}</div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-muted">{v.role}</div>
          <p className="mt-1 text-sm text-muted">{v.label}</p>
        </div>
      </div>
      {v.path?.length > 1 && <div className="border-t border-line px-3 py-1"><PathSketch path={v.path} left={v.status === "left_view"} /></div>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs">
        <span className="text-muted">Plate: {plate?.plate
          ? <><span className="mono text-sm text-ink">{plate.plate}</span> · {Math.round(plate.confidence * 100)}% · {plate.reads.length} of {plate.asked} crops</>
          : plate ? `none readable in ${plate.asked} crops` : "not checked"}</span>
        <Ref value={v.ref} />
      </div>
    </motion.div>
  );
}

function LocationForm({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const [lat, setLat] = useState(""), [lon, setLon] = useState("");
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/cases/${caseId}/location`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat: +lat, lon: +lon }) });
    setBusy(false);
    if (!r.ok) { setErr(`Couldn't save (${r.status})`); return; }
    onDone();
  }
  return (
    <Panel title="Where to next?">
      <p className="text-sm text-muted">The footage doesn't say where this happened. Enter the crash's coordinates to work out where the vehicle could have reached.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input aria-label="Latitude" placeholder="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} className="w-36 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm" />
        <input aria-label="Longitude" placeholder="Longitude" value={lon} onChange={(e) => setLon(e.target.value)} className="w-36 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm" />
        <button disabled={busy || !lat || !lon} onClick={save} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Working…" : "Trace"}</button>
      </div>
      {err && <p className="mt-2 text-xs text-bad">{err}</p>}
    </Panel>
  );
}

// The chase, on a timeline of minutes: the reach grows, plazas light up as their window opens, the funnel narrows.
function Trail({ d }: { d: any }) {
  const horizon = useMemo(() => Math.max(5, ...d.tolls.map((t: any) => t.window_min[1])), [d]);
  const [min, setMin] = useState(0);
  const [running, setRunning] = useState(true);
  useEffect(() => {
    if (!running) return;
    let raf = 0, last: number | null = null;
    const step = (now: number) => {
      if (last != null) setMin((m) => { const n = m + ((now - last!) / 1000) * (horizon / 8); if (n >= horizon) { setRunning(false); return horizon; } return n; });
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, horizon]);
  const vmax = d.exit.speed_kmh[1], vmin = d.exit.speed_kmh[0];
  const reachMax = (vmax * min / 60) * 1000, reachMin = (vmin * min / 60) * 1000;
  const top = d.funnel[0].count;
  const done = min >= horizon;
  const shown = Math.min(d.funnel.length, Math.floor((min / horizon) * d.funnel.length) + 1);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="How far could it have got?" right={<span className="mono text-xs text-muted">{min.toFixed(1)} min after leaving</span>}>
        <div className="h-[440px] overflow-hidden rounded-lg">
          <MapContainer center={[d.exit.lat, d.exit.lon]} zoom={11} className="h-full w-full">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap" />
            <Circle center={[d.exit.lat, d.exit.lon]} radius={reachMax} pathOptions={{ color: "#4f8cff", weight: 1, fillOpacity: 0.08 }} />
            <Circle center={[d.exit.lat, d.exit.lon]} radius={reachMin} pathOptions={{ color: "#4f8cff", weight: 1, dashArray: "4 6", fillOpacity: 0.1 }} />
            <CircleMarker center={[d.exit.lat, d.exit.lon]} radius={9} pathOptions={{ color: "#ff5d5d", fillOpacity: 0.9 }}><Tooltip permanent>Left here · {d.exit.heading}</Tooltip></CircleMarker>
            {d.tolls.map((t: any) => {
              const open = min >= t.window_min[0] && min <= t.window_min[1], passed = min > t.window_min[1], hit = done && t.name === d.match?.toll;
              return (
                <CircleMarker key={t.name} center={[t.lat, t.lon]} radius={hit ? 12 : open ? 10 : 7}
                  pathOptions={{ color: hit ? "#3ecf8e" : open ? "#f5b84f" : passed ? "#5d6570" : "#8a93a0", fillOpacity: open || hit ? 0.8 : 0.3 }}>
                  <Tooltip>{t.name} · {t.dist_km} km · reachable {t.window_min[0]}–{t.window_min[1]} min</Tooltip>
                </CircleMarker>
              );
            })}
          </MapContainer>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button aria-label={done ? "Replay" : running ? "Pause" : "Play"} onClick={() => { if (done) setMin(0); setRunning(done ? true : !running); }} className="rounded-lg border border-line p-2 text-muted hover:text-ink">
            {done ? <RotateCcw size={16} /> : <Play size={16} />}
          </button>
          <input aria-label="Minutes after leaving" type="range" min={0} max={horizon} step={0.1} value={min} onChange={(e) => { setRunning(false); setMin(+e.target.value); }} className="flex-1 accent-[#4f8cff]" />
        </div>
        <p className="mt-2 text-[11px] text-muted">Inner ring: at {vmin} km/h. Outer ring: at {vmax} km/h. Straight-line reach, so a real route takes longer.</p>
      </Panel>
      <div className="space-y-4">
        <Panel title="Narrowing the toll log">
          {d.funnel.map((f: any, i: number) => (
            <div key={f.stage} className={`mb-3 transition-opacity duration-500 ${i < shown ? "opacity-100" : "opacity-25"}`}>
              <div className="flex justify-between text-sm"><span>{f.stage}</span><span className="mono">{i < shown ? f.count : "…"}</span></div>
              <div className="mt-1 h-2 overflow-hidden rounded bg-panel-2">
                <motion.div className="h-full rounded bg-accent" initial={{ width: 0 }} animate={{ width: i < shown ? `${Math.max(1.5, (f.count / top) * 100)}%` : 0 }} transition={{ duration: 0.7, ease: "easeOut" }} />
              </div>
            </div>
          ))}
        </Panel>
        <AnimatePresence>
          {done && (
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Panel title="Candidate" right={<span className="text-xs text-warn">unverified</span>}>
                {d.match ? <>
                  <div className="mono text-2xl tracking-widest text-ok">{d.match.plate}</div>
                  <p className="mt-1 text-sm text-muted">{d.match.toll} · {d.match.time} · FASTag {d.match.fastag}</p>
                </> : <p className="text-sm text-muted">{d.candidates > 1 ? `${d.candidates} passages still fit, so this doesn't narrow to one vehicle.` : "No passage in the log fits."}</p>}
                <p className="mt-2 text-[11px] text-muted">A request for authorised follow-up, not an identification.</p>
              </Panel>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">FICTIONAL demo data: the toll plazas and the toll log are generated, with one passage planted to show the method. The counts are real counts over that log.</div>
      </div>
    </div>
  );
}

export default function Pursuit() {
  const { id } = useParams();
  const [nonce, setNonce] = useState(0);
  const p = useApi<any>(`/cases/${id}/pursuit?v=${nonce}`);
  if (!p.data) return <Loading error={p.error} />;
  const d = p.data;
  const V = VERDICT[(d.status ?? "departed") as keyof typeof VERDICT] ?? VERDICT.unclear;
  const vehicles: any[] = d.vehicles ?? [];
  return (
    <div className="space-y-5">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className={`flex items-start gap-3  border p-4 ${V.tone}`}>
        <V.Icon className="mt-0.5 shrink-0" size={22} />
        <div>
          <div className="text-lg font-semibold">{V.title}</div>
          <p className="text-sm text-ink/80">{d.summary}</p>
        </div>
      </motion.div>

      {vehicles.length > 0 && <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">{vehicles.map((v, i) => <VehicleCard key={v.track} v={v} caseId={id!} i={i} />)}</div>}

      {d.nearby_left?.length > 0 && (
        <Panel title="Other traffic that left near the impact">
          <ul className="space-y-1 text-sm">{d.nearby_left.map((v: any) => <li key={v.track} className="flex justify-between gap-3"><span>{v.name}: <span className="text-muted">{v.label}</span></span><Ref value={v.ref} /></li>)}</ul>
          <p className="mt-2 text-[11px] text-muted">Passing near the impact doesn't mean a vehicle was part of it. These may be possible witnesses.</p>
        </Panel>
      )}

      <TollCapture caseId={id!} />
      <LicencePanel caseId={id!} />
      <FaceCheck caseId={id!} />

      <a href={`/case/${id}/intercept`} className="flex items-center justify-between gap-3  border border-claimed/40 bg-claimed/10 p-4 transition hover:border-claimed">
        <div><div className="font-semibold">Intercept on the Hyderabad map</div><p className="text-sm text-muted">An agent steers the driver with traffic signals towards a spot police reach first. A simulation, run after an officer approves it.</p></div>
        <span className="text-sm font-semibold text-claimed">Open →</span>
      </a>

      {d.needs === "coordinates" && <LocationForm caseId={id!} onDone={() => setNonce((n) => n + 1)} />}
      {d.tolls && d.funnel && d.exit?.lat != null && <Trail d={d} />}
      {d.partial_plate && !vehicles.length && <Panel title="Partial plate"><div className="mono text-2xl tracking-widest">{d.partial_plate}</div></Panel>}
      {d.plates_method && <p className="flex items-center gap-1.5 text-[11px] text-muted"><MapPin size={12} />Plates: {d.plates_method}. Stayed or left comes from the tracks, not from the model.</p>}
    </div>
  );
}
