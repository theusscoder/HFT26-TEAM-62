import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Ambulance, ArrowUpRight, Box, ChevronRight, Download, MapPin, Play, Radio, Shield, X } from "lucide-react";
import { CityScene } from "../city3d/scene/CityScene";
import type { CameraReadout, FlyRequest } from "../city3d/scene/camera/CityCameraRig";
import { defaultPose, accidentFocusPose } from "../city3d/scene/camera/poses";
import { HeightField } from "../city3d/geo/heightfield";
import type { BuildingRenderMode } from "../city3d/config/cameraConfig";
import { loadCityData } from "../city3d/services/cityData/cityDataService";
import type { CityDataset } from "../city3d/types/city";
import type { Accident } from "../city3d/types/accident";
import { DataStateOverlay } from "../city3d/components/DataStateOverlay";
import { Attribution } from "../city3d/components/Attribution";
import { usePoll } from "../lib/api";
import LiveAnalysis from "../components/LiveAnalysis";
import LangToggle from "../components/LangToggle";
import "../city3d/styles/scene.css";

/* Home: the 3D city (OpenStreetMap buildings, roads, lakes and terrain for Gachibowli, HITEC City and Kondapur) with every
   case as a beacon coloured by kind, and the hospitals and police stations around them. Clicking a beacon opens the case at
   the side: footage, what happened, the people and vehicles on record; from there into the full case, its report, or the
   live operation. */
const KIND_LABEL: Record<string, string> = { hit_and_run: "Hit-and-run", pedestrian: "Pedestrian struck", two_wheeler: "Two-wheeler", collision: "Collision" };
const LEVEL: Record<string, string> = { L0: "#8a8a85", L1: "#22c55e", L2: "#f59e0b", L3: "#ff2a2a" };
const LEVEL_TEXT: Record<string, string> = { L0: "#000", L1: "#000", L2: "#000", L3: "#fff" };
const KEY_CASES = ["hero", "demo", "dashcam", "india-junction", "rear-end"];   // the walkthrough cases come first

/* The story of the system in six steps, each with its live number and a jump to the best example of it. */
function Capabilities({ h }: { h: any }) {
  const tiles: [string, string, string, string][] = [
    ["Detect", h ? `${h.cameras} cameras` : "Cameras", h ? `AI agents opened ${h.agent_cases} cases on their own` : "AI agents open cases on their own", "/cameras"],
    ["Reconstruct", h?.fit_pct != null ? `${h.fit_pct}% fit` : "3D replay", "3D model's overlap with the real footage", "/case/hero/reconstruction"],
    ["Cross-check", h ? `${h.caught}/${h.planted} caught` : "Contradictions", h ? `Planted contradictions, ${h.false_flags} false flags` : "Witnesses against the physical evidence", "/case/hero/courtroom"],
    ["Respond", h ? `${h.alerts_sent} alerts sent` : "Alerts", "Police, hospital and family on Telegram", "/police"],
    ["Trace", h ? `${h.hit_and_run} hit-and-runs` : "Hit-and-run", "Plate, likely route and intercept", "/case/demo/intercept"],
    ["Explain", "Ask the case", "Cited answers only. Fault questions are refused", "/case/hero/ask"],
  ];
  return (
    <motion.nav aria-label="What YATHARTH does" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }} transition={{ duration: 0.25 }}
      className="absolute inset-x-4 bottom-4 z-30 flex gap-px overflow-x-auto border border-white/15 bg-white/15">
      {tiles.map(([step, value, label, to], i) => (
        <Link key={step} to={to} className="group min-w-[190px] flex-1 bg-[#0b0f14]/95 px-4 py-3 text-white transition-colors hover:bg-[#1a2028] focus-visible:bg-[#1a2028]">
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.14em] text-white/55"><span><span className="text-[#ff5a5a]">{i + 1}</span> {step}</span><ArrowUpRight size={14} className="transition-colors group-hover:text-white" /></div>
          <div className="mt-1 truncate text-xl font-extrabold tracking-tight">{value}</div>
          <div className="mt-0.5 line-clamp-2 min-h-[2.1em] text-[12px] leading-snug text-white/70">{label}</div>
        </Link>
      ))}
    </motion.nav>
  );
}

function CaseSide({ c, onClose }: { c: any; onClose: () => void }) {
  return (
    <motion.aside key={c.id} initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
      className="absolute bottom-4 right-4 top-16 z-30 flex w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden border border-white/15 bg-[#0b0f14]/95 text-white backdrop-blur">
      <div className="flex items-start justify-between gap-2 border-b border-white/10 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em]">
            <span className="h-2 w-2 rounded-full" style={{ background: c.colour }} /><span style={{ color: c.colour }}>{KIND_LABEL[c.kind]}</span>
            <span className="text-white/40">· {c.place}</span>
          </div>
          <div className="mt-1 text-[17px] font-bold leading-snug">{c.title}</div>
          <div className="mt-1 flex items-start gap-1 text-[11px] text-white/60"><MapPin size={12} className="mt-0.5 shrink-0" /><span><span className="mono">{c.lat.toFixed(4)}, {c.lon.toFixed(4)}</span>{c.location_source ? ` · ${c.location_estimated ? "estimated" : "auto-logged"}: ${c.location_source}` : ""}</span></div>
          <div className="mt-1 text-[11px] text-white/50">{c.time ? new Date(c.time).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : ""} · {c.camera.toUpperCase()} · {c.contradictions} contradictions</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="px-1.5 py-0.5 text-[11px] font-bold" style={{ background: LEVEL[c.level] ?? "#555", color: LEVEL_TEXT[c.level] ?? "#fff" }}>{c.level}</span>
          <button aria-label="Close" onClick={onClose} className="p-1 hover:bg-white/10"><X size={16} /></button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="relative aspect-video bg-black">
          {c.video ? <video key={c.id} src={`/api/cases/${c.id}/file/${c.video}`} autoPlay muted loop playsInline className="h-full w-full object-contain" />
            : c.thumb ? <img src={`/api/cases/${c.id}/${c.thumb}`} alt="" className="h-full w-full object-cover" />
            : <div className="flex h-full items-center justify-center text-xs text-white/40">Reconstructed from the sensor log</div>}
          <span className="absolute left-2 top-2 flex items-center gap-1 bg-black/70 px-1.5 py-0.5 text-[10px] font-bold"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff2a2a]" />CAM · {c.place}</span>
        </div>
        <LiveAnalysis key={c.id} caseId={c.id} tone="dark" compact />
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-white/10 p-3 text-[13px]">
        <Link to={`/case/${c.id}`} className="flex items-center justify-center gap-1 bg-white py-2 font-semibold text-black">Open case <ChevronRight size={14} /></Link>
        <a href={`/api/cases/${c.id}/reports/dar.html`} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1 border border-white/25 py-2 font-semibold hover:bg-white/10"><Download size={14} />Export report</a>
        <Link to={`/case/${c.id}/${c.camera === "dashcam" ? "dashcam" : "reconstruction"}`} className="flex items-center justify-center gap-1 border border-white/25 py-2 hover:bg-white/10"><Box size={14} />{c.camera === "dashcam" ? "Dashcam" : "3D replay"}</Link>
        <Link to={`/operations?case=${c.id}`} className="flex items-center justify-center gap-1 border border-white/25 py-2 hover:bg-white/10"><Play size={14} />Live operation</Link>
      </div>
    </motion.aside>
  );
}

export default function CityHome() {
  const m = usePoll<any>("/citymap", 15000);   // cases the camera agent opens appear without a reload
  const h = usePoll<any>("/highlights", 30000);
  const [dataset, setDataset] = useState<CityDataset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readyAt, setReadyAt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode] = useState<BuildingRenderMode>("auto");
  const [fly, setFly] = useState<FlyRequest | null>(null);
  const [, setReadout] = useState<CameraReadout | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const flyId = useRef(0);
  const ground = useMemo(() => (dataset ? new HeightField(dataset.terrain) : null), [dataset]);
  useEffect(() => { loadCityData().then((d) => { setReadyAt(performance.now()); setDataset(d); }).catch((e) => setLoadError(String(e?.message ?? e))); }, []);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);

  const accidents: Accident[] = useMemo(() => {
    if (!m.data) return [];
    const cases = m.data.cases.filter((c: any) => !filter || c.kind === filter).map((c: any) => ({
      id: c.id, locationName: c.place, latitude: c.lat, longitude: c.lon, type: "collision", severity: c.severity,
      reportedAt: c.time ?? "", displayStatus: c.kind === "hit_and_run" || c.level === "L3" ? "active" : "investigating", vehiclesInvolved: c.vehicles,
      summary: c.title, color: c.colour, kind: c.kind,
    }));
    const places = m.data.places.map((p: any, i: number) => ({
      id: `place-${i}`, locationName: p.name, latitude: p.lat, longitude: p.lon, type: "obstruction", severity: "moderate", reportedAt: "", displayStatus: "investigating",
      vehiclesInvolved: 0, summary: p.name, color: p.kind === "hospital" ? "#2f7bff" : "#ff3b3b", facility: p.kind,
    }));
    return [...cases, ...places] as Accident[];
  }, [m.data, filter]);
  const selected = m.data?.cases.find((c: any) => c.id === selectedId) ?? null;

  const select = useCallback((a: Accident) => {
    if (a.facility) return;
    setSelectedId(a.id);
    if (ground) { const f = accidentFocusPose(ground, a); flyId.current += 1; setFly({ id: flyId.current, target: f.target, position: f.position }); }
  }, [ground]);
  const reset = useCallback(() => {
    setSelectedId(null);
    if (ground) { const p = defaultPose(ground); flyId.current += 1; setFly({ id: flyId.current, target: p.target, position: p.position }); }
  }, [ground]);

  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const x of m.data?.cases ?? []) c[x.kind] = (c[x.kind] ?? 0) + 1; return c; }, [m.data]);
  const listed = useMemo(() => {
    const rank = (c: any) => { const i = KEY_CASES.indexOf(c.id); return i < 0 ? KEY_CASES.length : i; };
    return (m.data?.cases ?? []).filter((c: any) => !filter || c.kind === filter)
      .sort((a: any, b: any) => rank(a) - rank(b) || String(b.level).localeCompare(String(a.level)) || String(b.time ?? "").localeCompare(String(a.time ?? "")));
  }, [m.data, filter]);
  return (
    <main className="relative h-screen w-full overflow-hidden bg-[#05080b]">
      {dataset && ground && (
        <CityScene dataset={dataset} datasetReadyAt={readyAt} buildingMode={mode} flyRequest={fly} onCameraChange={setReadout}
          accidents={accidents} selectedId={selectedId} onSelectAccident={select} />
      )}
      <div className="scene-vignette" />
      {!dataset && <DataStateOverlay state={loadError ? "error" : "loading"} message={loadError ?? undefined} />}

      <header className="absolute inset-x-0 top-0 z-30 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 bg-gradient-to-b from-black/85 to-transparent px-5 py-3 text-white">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-xl font-extrabold leading-none tracking-tight">YATHARTH</span>
            <span className="flex items-center gap-1.5 bg-[#ff2a2a] px-2 py-0.5 text-[11px] font-bold"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />LIVE</span>
            <span className="mono text-sm font-bold tabular-nums">{new Date(now).toLocaleTimeString("en-GB", { hour12: false })}</span>
          </div>
          <div className="mt-0.5 hidden truncate text-[12px] text-white/70 2xl:block">Road accidents reconstructed from CCTV, sensors and witnesses</div>
        </div>
        <nav className="flex flex-wrap items-center gap-2 text-[13px]">
          <Link to="/operations" className="flex items-center gap-1.5 px-2 py-1 text-white/80 hover:text-white"><Play size={13} />Live operation</Link>
          <Link to="/cases" className="px-2 py-1 text-white/80 hover:text-white">All cases</Link>
          <Link to="/dashcam" className="px-2 py-1 text-white/80 hover:text-white">Dashcam</Link>
          <Link to="/telegram" className="px-2 py-1 text-white/80 hover:text-white">Telegram</Link>
          <span className="flex divide-x divide-white/25 border border-white/25 bg-black/40 font-semibold">
            <Link to="/police" className="flex items-center gap-1.5 px-3 py-1 hover:bg-white/10"><Shield size={13} />Police</Link>
            <Link to="/hospital" className="flex items-center gap-1.5 px-3 py-1 hover:bg-white/10"><Ambulance size={13} />Hospital</Link>
            <Link to="/cameras" className="flex items-center gap-1.5 px-3 py-1 hover:bg-white/10"><Radio size={13} />Cameras</Link>
          </span>
          <Link to="/new" className="bg-[#ff2a2a] px-3 py-1 font-semibold">New case</Link>
          <LangToggle dark />
        </nav>
      </header>

      <aside aria-label="Incidents" className={`absolute left-4 top-16 z-30 hidden w-[310px] flex-col border border-white/15 bg-black/80 text-white backdrop-blur md:flex ${selected ? "bottom-4" : "bottom-[136px]"}`}>
        <div className="border-b border-white/10 p-3">
          <div className="flex items-baseline justify-between text-[11px] font-bold uppercase tracking-[0.14em] text-white/55"><span>Incidents</span><span className="mono text-white/70">{m.data?.cases.length ?? 0}</span></div>
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.entries(m.data?.kinds ?? {}).map(([k, col]) => (
              <button key={k} aria-pressed={filter === k} onClick={() => setFilter(filter === k ? null : k)}
                className={`flex items-center gap-1.5 border px-1.5 py-0.5 text-[11px] ${filter === k ? "border-white bg-white/15" : "border-white/20 hover:bg-white/10"}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: col as string }} />{KIND_LABEL[k]} <span className="mono text-white/60">{counts[k] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {listed.map((c: any) => (
            <button key={c.id} onClick={() => select({ id: c.id, latitude: c.lat, longitude: c.lon } as Accident)}
              className={`flex w-full items-start gap-2 border-b border-white/10 px-3 py-2 text-left text-[13px] hover:bg-white/10 ${c.id === selectedId ? "bg-white/15" : ""}`}>
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.colour }} />
              <span className="min-w-0 flex-1"><span className="line-clamp-2 font-semibold leading-snug">{c.title}</span><span className="block truncate text-[12px] text-white/60">{c.place}</span></span>
              <span className="shrink-0 px-1 text-[11px] font-bold" style={{ background: LEVEL[c.level] ?? "#555", color: LEVEL_TEXT[c.level] ?? "#fff" }}>{c.level}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-white/10 px-3 py-2 text-[11px] text-white/65">
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-[#2f7bff]" />Hospitals</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-[#ff3b3b]" />Police</span>
          <button onClick={reset} className="ml-auto border border-white/25 px-2 py-0.5 font-semibold hover:bg-white/10">City view</button>
        </div>
      </aside>

      <AnimatePresence>{selected ? <CaseSide key="side" c={selected} onClose={() => setSelectedId(null)} /> : <Capabilities key="strip" h={h.data} />}</AnimatePresence>
      {dataset && <div className={`absolute z-20 h-10 w-[640px] max-w-[60vw] ${selected ? "bottom-1 left-[330px]" : "bottom-[130px] right-2"}`}><Attribution manifest={dataset.manifest} /></div>}
    </main>
  );
}
