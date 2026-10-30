import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { AnimatePresence, motion } from "framer-motion";
import { Box, Camera, ChevronRight, Eye, IdCard, MapPinned, Pause, Play, Plus, Radio, RotateCcw, ScanFace, Siren, Car } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading, Panel, Stat } from "../components/ui";
import KnowledgeGraph from "../components/KnowledgeGraph";
import ThemePicker from "../components/ThemePicker";

/* The home page: Hyderabad, live. Every incident on one map, the dispatch agent's units moving, hospitals receiving, a card
   per scene (footage, what happened, the identity chain, responders converging), a guided tour from scene to scene, and the
   city's knowledge graph. Footage and analysis are real; four clips are placed here for the demo; identities are mock. */
const LEVEL: Record<string, string> = { L0: "#8a8a85", L1: "#0e7a43", L2: "#b86e00", L3: "#e30613" };
const TOUR_S = 10;

function at(keys: number[][], t: number): [number, number] | null {
  if (!keys.length) return null;
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  if (t >= keys[keys.length - 1][0]) return [keys[keys.length - 1][1], keys[keys.length - 1][2]];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m][0] <= t) lo = m; else hi = m; }
  const a = keys[lo], b = keys[hi], k = (t - a[0]) / (b[0] - a[0] || 1);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
const mm = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function FlyTo({ to, zoom }: { to: [number, number] | null; zoom: number }) {
  const map = useMap();
  useEffect(() => { if (to) map.flyTo(to, zoom, { duration: 1.6 }); }, [to?.[0], to?.[1], zoom]);
  return null;
}

function Units({ units, t, only }: { units: any[]; t: number; only?: Set<string> }) {
  return <>{units.filter((u) => !only || only.has(u.id)).map((u) => {
    const p = at(u.keys, t), active = u.keys.length > 1 && t >= u.keys[1][0] && t <= u.keys[u.keys.length - 1][0];
    if (!p) return null;
    const col = active ? (u.kind === "ambulance" ? "#0e7a43" : "#0047ab") : "#8a8a85";
    return (
      <span key={u.id}>
        {active && <Polyline positions={u.keys.filter((k: number[]) => k[0] >= t).map((k: number[]) => [k[1], k[2]])} pathOptions={{ color: col, weight: 3, dashArray: "6 6" }} />}
        <CircleMarker center={p} radius={active ? 7 : 3.5} pathOptions={{ color: col, fillColor: "#fff", weight: 3, fillOpacity: 1 }}><Tooltip>{u.id} · {u.base}{active ? " · responding" : ""}</Tooltip></CircleMarker>
      </span>
    );
  })}</>;
}

function Chain({ c }: { c: any }) {
  const idn = c.identity;
  const steps = [
    { Icon: Eye, label: "Vision model: who was hit", value: idn?.victim ?? "not judged", sub: c.vlm ? `on the impact frame: ${c.vlm.people_on_ground ? "someone on the ground" : "no one on the ground"}${c.vlm.vehicle ? `, ${c.vlm.vehicle}` : ""}` : "mock judgement for this demo case" },
    { Icon: Car, label: "Number plate", value: idn?.plate ?? "none (a pedestrian has no plate)", sub: idn?.plate ? "read from the footage (mock for placed cases)" : "" },
    { Icon: IdCard, label: "Registration", value: idn?.registration ? `${idn.registration.owner} · ${idn.registration.vehicle}` : "—", sub: idn?.registration ? `${idn.registration.rto} · insurance ${idn.registration.insurance} · emergency contact ${idn.registration.emergency_contact}` : "" },
    { Icon: ScanFace, label: "Face → driving licence", value: idn?.licence ? `${idn.licence.dl_no}` : "—", sub: idn?.licence ? `${idn.licence.holder} · ${idn.licence.class} · valid till ${idn.licence.valid_till} · match ${Math.round((idn.face_match ?? 0) * 100)}% (mock)` : "" },
  ];
  return (
    <div>
      <div className="mb-2 flex items-center justify-between"><span className="text-[11px] font-bold uppercase tracking-[0.14em]">Identity chain</span><span className="bg-warn px-1.5 py-0.5 text-[10px] font-bold text-white">MOCK DATA</span></div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <motion.li key={s.label} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.25 }} className="flex gap-2 text-sm">
            <s.Icon size={16} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0"><div className="text-[11px] text-muted">{s.label}</div><div className="font-semibold">{s.value}</div>{s.sub && <div className="text-[11px] text-muted">{s.sub}</div>}</div>
          </motion.li>
        ))}
      </ol>
      {idn?.licence && <img src={`/api/toll-images/${idn.licence.photo}`} alt="Placeholder licence photo" className="mt-2 h-16 w-16 border border-ink" />}
    </div>
  );
}

export default function LiveCity() {
  const d = useApi<any>("/live");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(20);
  const [sel, setSel] = useState<string | null>(null);
  const [tour, setTour] = useState(false);
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
  const order: string[] = useMemo(() => (d.data?.incidents ?? []).map((i: any) => i.id), [d.data]);
  // Auto-open each incident as it's detected; the tour walks through them on its own.
  useEffect(() => { const newest = (d.data?.incidents ?? []).filter((i: any) => i.t <= t).pop(); if (newest && !tour && newest.id !== sel && t - newest.t < 1.5 * speed) setSel(newest.id); }, [Math.floor(t / speed)]);
  useEffect(() => {
    if (!tour || !order.length) return;
    let i = Math.max(0, order.indexOf(sel ?? order[0]));
    setSel(order[i]);
    const h = setInterval(() => { i = (i + 1) % order.length; setSel(order[i]); }, TOUR_S * 1000);
    return () => clearInterval(h);
  }, [tour, order.length]);
  if (!d.data) return <div className="p-8"><Loading error={d.error} /></div>;
  const D = d.data;
  const live = D.incidents.filter((i: any) => i.t <= t || tour);
  const inc = D.incidents.find((i: any) => i.id === sel);
  const card = sel ? D.cards[sel] : null;
  const mine = new Set<string>((card?.responders ?? []).map((r: any) => r.unit));
  const active = D.units.filter((u: any) => u.keys.length > 1 && t >= u.keys[1][0] && t <= u.keys[u.keys.length - 1][0]);
  const log = D.log.filter((l: any) => l.t <= t).slice(-10).reverse();
  return (
    <div className="h-full overflow-auto">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-ink bg-panel px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-extrabold tracking-tight">YATHARTH</span>
          <span className="flex items-center gap-1.5 bg-accent px-2 py-0.5 text-xs font-bold text-white"><span className="h-2 w-2 animate-pulse bg-white" />LIVE · HYDERABAD</span>
          <span className="mono text-lg font-bold">+{mm(t)}</span>
        </div>
        <nav className="flex flex-wrap items-center gap-2 text-sm">
          <Link to="/cases" className="border border-ink px-3 py-1.5 font-semibold hover:bg-panel-2">All cases</Link>
          <Link to="/dashcam" className="flex items-center gap-1.5 border border-ink px-3 py-1.5 font-semibold hover:bg-panel-2"><Camera size={14} />Dashcam</Link>
          <Link to="/cameras" className="flex items-center gap-1.5 border border-ink px-3 py-1.5 font-semibold hover:bg-panel-2"><Radio size={14} />Cameras</Link>
          <Link to="/new" className="flex items-center gap-1.5 bg-accent px-3 py-1.5 font-semibold text-white"><Plus size={14} />New case</Link>
          <ThemePicker compact />
        </nav>
      </header>

      <div className="p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Incidents detected" value={live.length} tone="text-accent" />
          <Stat label="Units responding" value={active.length} hint={`${D.kpi.ambulances} ambulances, ${D.kpi.police} patrol cars in the fleet`} />
          <Stat label="Patients on the way to hospital" value={active.filter((u: any) => u.kind === "ambulance").length} />
          <Stat label="Median ambulance time" value={(D.kpi.ambulance_eta_median_s ?? 0) / 60} decimals={1} suffix=" min" />
          <Stat label="Hospitals on the map" value={D.places.filter((p: any) => p.amenity === "hospital").length} />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_480px] xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="relative border border-ink" style={{ height: "68vh", minHeight: 480 }}>
            <MapContainer center={D.center} zoom={14} className="h-full w-full">
              <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap contributors" />
              <FlyTo to={inc ? [inc.lat, inc.lon] : null} zoom={16} />
              {D.places.map((p: any) => <CircleMarker key={p.name + p.lat} center={[p.lat, p.lon]} radius={6} pathOptions={{ color: p.amenity === "hospital" ? "#0e7a43" : "#0047ab", weight: 2, fillOpacity: 0.9 }}><Tooltip>{p.amenity === "hospital" ? "Hospital" : "Police"} · {p.name}</Tooltip></CircleMarker>)}
              {live.map((i: any) => (
                <CircleMarker key={i.id} center={[i.lat, i.lon]} radius={i.id === sel ? 16 : 11} eventHandlers={{ click: () => { setTour(false); setSel(i.id); } }} pathOptions={{ color: LEVEL[i.level], weight: i.id === sel ? 5 : 3, fillOpacity: 0.35 }}>
                  <Tooltip>{i.level} · {i.title}</Tooltip>
                </CircleMarker>
              ))}
              <Units units={D.units} t={t} />
            </MapContainer>
            <div className="pointer-events-none absolute bottom-3 left-3 z-[500] bg-panel/90 px-3 py-1.5 text-[11px] text-muted">rings: incidents by severity · green: hospitals and ambulances · blue: police · {D.placed_note}</div>
          </div>

          <AnimatePresence mode="wait">
            {card ? (
              <motion.div key={sel} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} className="space-y-3 border border-ink bg-panel p-4">
                <div className="flex items-start justify-between gap-2">
                  <div><div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{card.place}{card.really_here ? "" : " · placed for the demo"}</div><div className="text-lg font-bold leading-snug">{card.title}</div></div>
                  <span className="shrink-0 px-2 py-0.5 text-xs font-bold text-white" style={{ background: LEVEL[card.level] ?? "#8a8a85" }}>{card.level} · {card.label}</span>
                </div>
                {card.video ? <video key={card.case} src={`/api/cases/${card.case}/file/${card.video}`} autoPlay muted loop playsInline className="aspect-video w-full bg-black object-contain" />
                  : <div className="flex aspect-video items-center justify-center bg-panel-2 text-xs text-muted">Synthetic demo case: no footage</div>}
                <div>
                  <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em]">What happened</div>
                  <ul className="space-y-1 text-sm">{card.what.slice(0, 3).map((w: string, i: number) => <motion.li key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.2 }}>· {w}</motion.li>)}</ul>
                </div>
                <Chain c={card} />
                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em]"><MapPinned size={13} />Responders coming here</div>
                  <div className="h-44 border border-ink">
                    <MapContainer key={card.case} center={[inc.lat, inc.lon]} zoom={15} zoomControl={false} attributionControl={false} className="h-full w-full">
                      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" />
                      <CircleMarker center={[inc.lat, inc.lon]} radius={10} pathOptions={{ color: LEVEL[inc.level], weight: 4, fillOpacity: 0.4 }} />
                      <Units units={D.units} t={t} only={mine} />
                    </MapContainer>
                  </div>
                  <ul className="mt-1 space-y-0.5 text-xs">{(card.responders ?? []).map((r: any) => <li key={r.unit} className="flex justify-between gap-2"><span><b>{r.unit}</b> · {r.base}</span><span className="mono text-muted">{mm(r.eta_s)} by road</span></li>)}</ul>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Link to={`/case/${card.case}`} className="flex items-center justify-center gap-1 border border-ink py-2 text-sm font-semibold hover:bg-panel-2">Open case <ChevronRight size={14} /></Link>
                  <Link to={`/case/${card.case}/${card.camera === "dashcam" ? "dashcam" : "reconstruction"}`} className="flex items-center justify-center gap-1 bg-ink py-2 text-sm font-semibold text-white"><Box size={14} />{card.camera === "dashcam" ? "Dashcam view" : "3D reconstruction"}</Link>
                </div>
              </motion.div>
            ) : (
              <div className="flex items-center justify-center border border-dashed border-ink p-8 text-sm text-muted">Waiting for the first incident. Click a ring, or start the tour.</div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border border-ink bg-panel px-4 py-3">
          <button onClick={() => { if (t >= D.window_s) setT(0); setPlaying(!playing); }} className="flex w-24 items-center justify-center gap-1.5 bg-accent py-1.5 text-sm font-semibold text-white">{t >= D.window_s ? <RotateCcw size={14} /> : playing ? <Pause size={14} /> : <Play size={14} />}{t >= D.window_s ? "Replay" : playing ? "Pause" : "Play"}</button>
          <button onClick={() => setTour(!tour)} className={`flex items-center gap-1.5 border px-3 py-1.5 text-sm font-semibold ${tour ? "border-accent bg-accent text-white" : "border-ink"}`}><Siren size={14} />{tour ? "Stop tour" : "Tour the scenes"}</button>
          <input aria-label="Time" type="range" min={0} max={D.window_s} value={t} onChange={(e) => setT(+e.target.value)} className="min-w-[200px] flex-1 accent-[#e30613]" />
          <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(+e.target.value)} className="border px-2 py-1 text-xs">{[5, 10, 20, 40, 80].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="space-y-4">
            <Panel title="Incident feed">
              <ul className="space-y-1.5">{D.incidents.map((i: any) => (
                <li key={i.id}><button onClick={() => { setTour(false); setSel(i.id); }} className={`flex w-full items-center gap-2 border px-2 py-1.5 text-left text-sm ${i.id === sel ? "border-accent" : "border-line"} ${i.t > t ? "opacity-40" : ""}`}>
                  <span className="h-3 w-3 shrink-0" style={{ background: LEVEL[i.level] }} /><span className="min-w-0 flex-1 truncate">{i.title}</span><span className="mono text-[11px] text-muted">+{mm(i.t)}</span>
                </button></li>
              ))}</ul>
            </Panel>
            <Panel title="Dispatch agent">
              <ol className="space-y-1.5 text-sm">{log.map((l: any, i: number) => <li key={i}><span className="mono mr-1 text-[11px] text-muted">+{mm(l.t)}</span>{l.text}</li>)}{!log.length && <li className="text-muted">No dispatches yet.</li>}</ol>
            </Panel>
          </div>
          <Panel title="The city, as a knowledge graph" right={<span className="text-xs text-muted">{D.mock_note}</span>}>
            <KnowledgeGraph graph={D.graph} t={t} headers={["Incidents", "Agents", "Units", "Records and hospitals"]} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
