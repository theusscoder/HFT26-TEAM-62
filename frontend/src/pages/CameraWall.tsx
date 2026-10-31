import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Map as MapIcon, Radio, ScanSearch, Send } from "lucide-react";
import LangToggle from "../components/LangToggle";

/* The city's traffic cameras, live, with the camera agent watching them: each tile shows the feed, what the agent is
   doing on it (watching, screening, analysing an incident) and the case it opened. New cases appear on the map and go
   out on Telegram without anyone pressing "New case". */
const TONE: Record<string, string> = { watching: "#22c55e", screening: "#f59e0b", analysing: "#ff2a2a", error: "#ff2a2a", offline: "#5b6470" };

export default function CameraWall() {
  const [st, setSt] = useState<any>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  const load = () => fetch("/api/cameras").then((r) => r.json()).then(setSt).catch(() => {});
  useEffect(() => { load(); const h = setInterval(load, 3000); return () => clearInterval(h); }, []);
  const scan = (id: string) => fetch(`/api/cameras/${id}/scan`, { method: "POST" }).then(load);
  const toggle = () => fetch(`/api/cameras/agent/${st?.running ? "off" : "on"}`, { method: "POST" }).then(load);
  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0b0f14] text-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-2.5">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-xl font-extrabold tracking-tight">YATHARTH</Link>
          <span className="flex items-center gap-1.5 bg-[#ff2a2a] px-2 py-0.5 text-[11px] font-bold"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />LIVE</span>
          <span className="flex items-center gap-1.5 text-sm text-white/70"><Radio size={15} />Traffic cameras · {st?.cameras?.length ?? 0} feeds</span>
        </div>
        <nav className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <button onClick={toggle} className={`flex items-center gap-1.5 px-2.5 py-1 font-semibold ${st?.running ? "bg-[#22c55e]/20 text-[#4ade80]" : "bg-white/10"}`}><Bot size={14} />Camera agent {st?.running ? "on" : "off"}</button>
          <Link to="/" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><MapIcon size={13} />City map</Link>
          <Link to="/telegram" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><Send size={13} />Telegram</Link>
          <Link to="/new" className="border border-white/20 px-2.5 py-1 hover:bg-white/10">Add a case by hand</Link>
          <LangToggle dark />
        </nav>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="grid auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-4 md:grid-cols-2 2xl:grid-cols-3">
          {(st?.cameras ?? []).map((c: any) => (
            <div key={c.id} className={`border bg-black ${st?.current === c.id ? "border-[#f59e0b]" : "border-white/15"}`}>
              <div className="relative aspect-video bg-black">
                {c.live ? <img src={`/api/cameras/${c.id}/stream`} alt={c.name} className="h-full w-full object-cover" />
                  : <video src={`/api/cameras/${c.id}/feed`} autoPlay muted loop playsInline className="h-full w-full object-cover" />}
                <span data-notranslate className="mono absolute bottom-1.5 left-2 bg-black/60 px-1 text-[10px]">{c.id} {new Date(now).toLocaleString("en-GB", { hour12: false }).replace(",", "")}</span>
                <span className="absolute left-2 top-2 flex items-center gap-1 bg-black/70 px-1.5 py-0.5 text-[10px] font-bold"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff2a2a]" />{c.id}</span>
                <span className="absolute right-2 top-2 px-1.5 py-0.5 text-[10px] font-bold uppercase" style={{ background: TONE[c.status] ?? "#5b6470" }}>{c.status ?? "queued"}</span>
              </div>
              <div className="space-y-1 p-2.5 text-[12px]">
                <div className="flex items-center justify-between gap-2"><span className="font-semibold">{c.name}</span><span className="text-white/40">{c.camera}</span></div>
                <div className="truncate text-white/55">{c.detail ?? "waiting for its turn"}</div>
                <div className="flex items-center justify-between gap-2">
                  {c.case ? <Link to={`/case/${c.case}`} className="text-[#93c5fd] underline">Case {c.case}</Link> : <span className="text-white/35">no case</span>}
                  <button disabled={c.busy || c.status === "analysing"} onClick={() => scan(c.id)} className="flex items-center gap-1 border border-white/20 px-2 py-0.5 hover:bg-white/10 disabled:opacity-40"><ScanSearch size={12} />{c.busy || c.status === "analysing" ? "Working…" : "Scan now"}</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-white/10 p-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Camera agent</div>
          <ol className="space-y-2">
            <AnimatePresence initial={false}>
              {(st?.log ?? []).map((l: any, i: number) => (
                <motion.li key={l.time + l.text} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="text-[12px] leading-snug">
                  <span className="mono mr-1.5 text-white/40">{l.time.slice(11, 19)}</span>
                  <span className="mr-1.5 font-bold" style={{ color: l.kind === "error" ? "#ff6b6b" : l.kind === "case" ? "#4ade80" : "#f59e0b" }}>{l.camera}</span>
                  {l.text} {l.case && <Link to={`/case/${l.case}`} className="text-[#93c5fd] underline">open</Link>}
                </motion.li>
              ))}
            </AnimatePresence>
            {!(st?.log ?? []).length && <li className="text-[12px] text-white/45">The agent is watching. Detected incidents and the cases it opens appear here.</li>}
          </ol>
        </aside>
      </div>
    </div>
  );
}
