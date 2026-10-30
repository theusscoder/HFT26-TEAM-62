import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading, Panel, Stat } from "../components/ui";

/* What's happening across the city: every incident and every dispatch on one live map. The road network, hospitals,
   police stations and any real case located here are real; the other incidents, the fleet and traffic are simulated. */
const LEVEL: Record<string, string> = { L0: "#8a8a85", L1: "#0e7a43", L2: "#b86e00", L3: "#e30613" };

function at(keys: number[][], t: number): [number, number] | null {
  if (!keys.length) return null;
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  if (t >= keys[keys.length - 1][0]) return [keys[keys.length - 1][1], keys[keys.length - 1][2]];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m][0] <= t) lo = m; else hi = m; }
  const a = keys[lo], b = keys[hi], k = (t - a[0]) / (b[0] - a[0] || 1);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export default function City() {
  const d = useApi<any>("/city");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(30);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing || !d.data) return;
    let last: number | null = null;
    const step = (now: number) => {
      if (last != null) setT((v) => Math.min(d.data.window_s, v + ((now - last!) / 1000) * speed));
      last = now;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, d.data]);
  const live = useMemo(() => (d.data?.incidents ?? []).filter((i: any) => i.t <= t), [d.data, Math.floor(t / 5)]);
  if (!d.data) return <div className="p-8"><Loading error={d.error} /></div>;
  const D = d.data;
  const moving = D.units.map((u: any) => ({ u, p: at(u.keys, t), active: u.keys.length > 1 && t >= u.keys[1][0] && t <= u.keys[u.keys.length - 1][0] }));
  const log = D.log.filter((l: any) => l.t <= t).slice(-14).reverse();
  const busyAmb = moving.filter((m: any) => m.active && m.u.kind === "ambulance").length;
  const mm = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <div className="mx-auto h-full max-w-[1600px] overflow-auto p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/" className="text-xs text-muted hover:text-ink">← Command centre</Link>
          <h1 className="text-3xl font-bold">City operations · Hyderabad</h1>
          <p className="text-sm text-muted">Every incident and dispatch on one map. Roads, hospitals and police stations are real (OpenStreetMap); the other incidents, the fleet and traffic are simulated.</p>
        </div>
        <div className="mono text-3xl font-bold">+{mm(t)}</div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Incidents so far" value={live.length} tone="text-accent" />
        <Stat label="Ambulances on a job" value={busyAmb} hint={`of ${D.kpi.ambulances}`} />
        <Stat label="Median ambulance time to scene" value={(D.kpi.ambulance_eta_median_s ?? 0) / 60} decimals={1} suffix=" min" />
        <Stat label="Real cases on this map" value={D.kpi.real} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="border border-ink" style={{ height: "64vh", minHeight: 460 }}>
          <MapContainer center={D.center} zoom={14} className="h-full w-full">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap contributors" />
            {D.places.map((p: any) => <CircleMarker key={p.name + p.lat} center={[p.lat, p.lon]} radius={6} pathOptions={{ color: p.amenity === "hospital" ? "#0e7a43" : "#0047ab", weight: 2, fillOpacity: 0.9 }}><Tooltip>{p.name}</Tooltip></CircleMarker>)}
            {live.map((i: any) => (
              <CircleMarker key={i.id} center={[i.lat, i.lon]} radius={i.level === "L3" ? 13 : 10} pathOptions={{ color: LEVEL[i.level], weight: 3, fillOpacity: 0.35 }}>
                <Tooltip>{i.id} · {i.title} · {i.level}{i.real ? " · real case" : " · simulated"}</Tooltip>
              </CircleMarker>
            ))}
            {moving.filter((m: any) => m.active).map(({ u }: any) => <Polyline key={`r${u.id}`} positions={u.keys.filter((k: number[]) => k[0] >= t).map((k: number[]) => [k[1], k[2]])} pathOptions={{ color: u.kind === "ambulance" ? "#0e7a43" : "#0047ab", weight: 3, dashArray: "6 6" }} />)}
            {moving.filter((m: any) => m.p).map(({ u, p, active }: any) => (
              <CircleMarker key={u.id} center={p} radius={active ? 7 : 4} pathOptions={{ color: active ? (u.kind === "ambulance" ? "#0e7a43" : "#0047ab") : "#8a8a85", fillColor: "#ffffff", weight: 3, fillOpacity: 1 }}>
                <Tooltip>{u.id} · {u.base}{active ? " · on a job" : ""}</Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
        <Panel title="Dispatch agent" right={<span className="text-xs text-muted">nearest free unit by road</span>}>
          <ol className="max-h-[56vh] space-y-2 overflow-auto text-sm">
            {log.map((l: any, i: number) => <li key={i} className={i === 0 ? "font-semibold" : ""}><span className="mono mr-1.5 text-[11px] text-muted">+{mm(l.t)}</span>{l.text}</li>)}
            {!log.length && <li className="text-muted">Waiting for the first incident…</li>}
          </ol>
        </Panel>
      </div>
      <div className="mt-4 flex items-center gap-3 border border-ink bg-panel px-4 py-3">
        <button onClick={() => { if (t >= D.window_s) setT(0); setPlaying(!playing); }} className="flex w-24 items-center justify-center gap-1.5 bg-accent py-1.5 text-sm font-semibold text-white">{t >= D.window_s ? <RotateCcw size={14} /> : playing ? <Pause size={14} /> : <Play size={14} />}{t >= D.window_s ? "Replay" : playing ? "Pause" : "Play"}</button>
        <input aria-label="Time" type="range" min={0} max={D.window_s} value={t} onChange={(e) => setT(+e.target.value)} className="flex-1 accent-[#e30613]" />
        <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(+e.target.value)} className="border px-2 py-1 text-xs">{[10, 30, 60, 120].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
        <span className="text-xs text-muted">green: hospitals and ambulances · blue: police · rings: incidents by severity</span>
      </div>
    </div>
  );
}
