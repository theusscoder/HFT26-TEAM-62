import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Plus, Radio, ScanEye } from "lucide-react";
import { useApi } from "../lib/api";
import { LevelPill } from "../components/ui";

/* The monitoring wall. Each tile replays a recorded clip from a case, with the detector's boxes drawn live over it, and
   raises an alert when the clip reaches the moment the pipeline found the impact. Every tile is labelled as a replay:
   nothing here claims to be a live camera. */

interface Tile { id: string; title: string; location: string; level?: string; label?: string; t0: number; tracks: any[]; primary?: string; involved: string[] }
const CLASS_COLOUR: Record<string, string> = { car: "#4f8cff", bus: "#4f8cff", truck: "#4f8cff", motorcycle: "#5fd4e6", bicycle: "#5fd4e6", person: "#f5b84f" };

function boxesAt(tracks: any[], t: number) {
  const out: { box: number[]; cls: string; id: string }[] = [];
  for (const tr of tracks) {
    const p = tr.points;
    if (!p.length || t < p[0].t - 0.1 || t > p[p.length - 1].t + 0.1) continue;
    let lo = 0, hi = p.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].t <= t) lo = m; else hi = m; }
    const q = Math.abs(p[lo].t - t) < Math.abs(p[hi].t - t) ? p[lo] : p[hi];
    if (Math.abs(q.t - t) < 0.15) out.push({ box: q.box, cls: tr.class, id: tr.id });
  }
  return out;
}

function Camera({ tile, n, onAlert }: { tile: Tile; n: number; onAlert: (tile: Tile, n: number) => void }) {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const fired = useRef(false);
  const [hot, setHot] = useState(false);
  const [now, setNow] = useState(new Date());
  useEffect(() => { const h = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(h); }, []);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const v = video.current, c = canvas.current;
      if (v && c && v.videoWidth) {
        const r = v.getBoundingClientRect();
        if (c.width !== r.width || c.height !== r.height) { c.width = r.width; c.height = r.height; }
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), ox = (r.width - v.videoWidth * k) / 2, oy = (r.height - v.videoHeight * k) / 2;
        const g = c.getContext("2d")!;
        g.clearRect(0, 0, c.width, c.height);
        const t = v.currentTime - tile.t0;
        for (const b of boxesAt(tile.tracks, t)) {
          const key = b.id === tile.primary || tile.involved.includes(b.id), impact = Math.abs(t) < 1.2 && key;
          g.strokeStyle = impact ? "#ff3b3b" : key ? "#ff8a3b" : CLASS_COLOUR[b.cls] ?? "#8a93a0";
          g.lineWidth = key ? 2.5 : 1.2;
          g.strokeRect(ox + b.box[0] * k, oy + b.box[1] * k, (b.box[2] - b.box[0]) * k, (b.box[3] - b.box[1]) * k);
        }
        if (t >= 0 && t < 0.5 && !fired.current) { fired.current = true; setHot(true); onAlert(tile, n); setTimeout(() => setHot(false), 4000); }
        if (t < -0.5) fired.current = false;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tile]);
  return (
    <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: n * 0.08 }}
      className={`relative overflow-hidden  border bg-black transition-colors ${hot ? "border-bad shadow-[0_0_0_3px_rgba(255,93,93,0.35)]" : "border-line"}`}>
      <video ref={video} src={`/api/cases/${tile.id}/file/cctv.mp4`} autoPlay muted loop playsInline className="aspect-video w-full object-contain" />
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent px-3 py-2 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold text-white"><span className="h-2 w-2 animate-pulse rounded-full bg-bad" />CAM-{String(n + 1).padStart(2, "0")} · {tile.location || tile.title}</span>
        <span className="mono text-white/80">{now.toLocaleTimeString()}</span>
      </div>
      <div className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80">replaying a recorded clip</div>
      <AnimatePresence>{hot && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-bad/90 px-3 py-1.5 text-xs font-semibold text-white">
          <span className="flex items-center gap-1.5"><AlertTriangle size={13} />Possible collision</span><Link to={`/case/${tile.id}`} className="underline">Open case</Link>
        </motion.div>
      )}</AnimatePresence>
    </motion.div>
  );
}

export default function Live() {
  const dash = useApi<any>("/dashboard");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [alerts, setAlerts] = useState<{ tile: Tile; n: number; at: Date }[]>([]);
  useEffect(() => {
    if (!dash.data) return;
    const real = dash.data.cases.filter((c: any) => !c.simulated).slice(0, 3);
    Promise.all(real.map(async (c: any) => {
      const [cs, ui, an] = await Promise.all([fetch(`/api/cases/${c.id}/case`).then((r) => r.json()), fetch(`/api/cases/${c.id}/tracks_ui`).then((r) => r.json()), fetch(`/api/cases/${c.id}/analysis`).then((r) => r.json())]);
      return { id: c.id, title: c.title, location: c.location, level: c.level, label: c.label, t0: cs.t0_video_s, tracks: ui.tracks, primary: an.entities?.primary, involved: an.entities?.involved ?? [] } as Tile;
    })).then(setTiles).catch(() => setTiles([]));
  }, [dash.data]);
  const onAlert = (tile: Tile, n: number) => setAlerts((a) => [{ tile, n, at: new Date() }, ...a].slice(0, 12));

  return (
    <div className="mx-auto h-full max-w-[1600px] overflow-auto p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="text-xs text-muted hover:text-ink">← Command centre</Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold"><Radio size={20} className="text-bad" />Monitoring wall</h1>
          <p className="text-sm text-muted">Each camera replays a recorded clip, with the detector running over it. An alert fires at the moment the pipeline found the impact.</p>
        </div>
        <Link to="/new" className="inline-flex items-center gap-2  bg-accent px-4 py-2 text-sm font-semibold text-white"><Plus size={15} />Add a clip</Link>
      </header>
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {tiles.map((t, i) => <Camera key={t.id} tile={t} n={i} onAlert={onAlert} />)}
          <Link to="/new" className="flex aspect-video flex-col items-center justify-center  border border-dashed border-line text-sm text-muted transition hover:border-accent hover:text-ink">
            <ScanEye size={26} className="mb-2" />Add a camera clip<span className="mt-1 text-xs">it runs through the full pipeline</span>
          </Link>
        </div>
        <section className=" border border-line bg-panel">
          <header className="border-b border-line/70 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Alerts</header>
          <ol className="space-y-2 p-3">
            <AnimatePresence initial={false}>
              {alerts.map((a, i) => (
                <motion.li key={a.at.getTime() + a.tile.id} layout initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className={` border p-3 ${i === 0 ? "border-bad/60 bg-bad/10" : "border-line bg-panel-2/60"}`}>
                  <div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold">CAM-{String(a.n + 1).padStart(2, "0")} · possible collision</span><span className="mono text-muted">{a.at.toLocaleTimeString()}</span></div>
                  <div className="mt-1 truncate text-sm">{a.tile.title}</div>
                  <div className="mt-2 flex items-center justify-between"><LevelPill level={a.tile.level} label={a.tile.label} /><Link to={`/case/${a.tile.id}`} className="flex items-center gap-1 text-xs font-semibold text-accent">Open case <ArrowRight size={12} /></Link></div>
                </motion.li>
              ))}
            </AnimatePresence>
            {!alerts.length && <li className="p-3 text-sm text-muted">Watching {tiles.length} camera{tiles.length === 1 ? "" : "s"}. Alerts appear here.</li>}
          </ol>
        </section>
      </div>
    </div>
  );
}
