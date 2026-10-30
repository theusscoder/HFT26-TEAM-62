import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Camera, CheckCircle2, Map, Plus, Radio, Scale } from "lucide-react";
import { useApi } from "../lib/api";
import { LevelPill, Loading, Stat } from "../components/ui";
import KitsPanel from "../components/KitsPanel";
import ThemePicker from "../components/ThemePicker";

/* The command centre: what every case found, at a glance, each number read from the case's own files. */
const RUN: Record<string, string> = { stayed: "No hit-and-run", departed: "Vehicle left", unclear: "Hit-and-run unclear" };

export default function Home() {
  const { data, error } = useApi<any>("/dashboard");
  const [kind, setKind] = useState<"all" | "cctv" | "dashcam">("all");
  const T = data?.totals;
  return (
    <div className="mx-auto h-full max-w-7xl overflow-auto p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/" className="text-xs text-muted hover:text-ink">← Live city map</Link>
          <motion.h1 initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="text-4xl font-bold tracking-tight">YATHARTH · all cases</motion.h1>
          <div className="mt-2"><ThemePicker /></div>
          <p className="mt-1 max-w-2xl text-muted">Every claim proven or flagged, nothing asserted. Crash evidence put back together: what happened, whose account holds up, and who must be told right now.</p>
        </div>
        <div className="flex gap-2">
          <Link to="/city" className="inline-flex items-center gap-2 border border-ink px-4 py-2.5 text-sm font-semibold transition hover:bg-panel-2"><Map size={16} />City operations</Link>
          <Link to="/dashcam" className="inline-flex items-center gap-2 border border-ink px-4 py-2.5 text-sm font-semibold transition hover:bg-panel-2"><Camera size={16} />Dashcam</Link>
          <Link to="/live" className="inline-flex items-center gap-2  border border-bad/50 bg-bad/10 px-4 py-2.5 text-sm font-semibold text-bad transition hover:bg-bad/20"><Radio size={16} />Monitoring wall</Link>
          <Link to="/new" className="inline-flex items-center gap-2  bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110"><Plus size={16} />New case</Link>
        </div>
      </header>
      {!data ? <div className="mt-8"><Loading error={error} /></div> : <>
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Cases" value={T.cases} />
          <Stat label="Contradictions found" value={T.contradictions} tone="text-claimed" delay={0.05} />
          <Stat label="Planted errors caught" value={T.caught} tone="text-ok" hint={`of ${T.planted}, in statements we wrote to test it`} delay={0.1} />
          <Stat label="False flags" value={T.false_flags} tone={T.false_flags ? "text-bad" : ""} hint="on those same test statements" delay={0.15} />
        </div>
        <KitsPanel />
        <div className="mt-8 flex items-end justify-between gap-3 border-b-2 border-ink">
          <h2 className="pb-1 text-[11px] font-bold uppercase tracking-[0.14em]">Cases</h2>
          <div className="flex">
            {([["all", "All"], ["cctv", "CCTV"], ["dashcam", "Dashcam"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setKind(k)} className={`px-3 py-1.5 text-xs font-semibold ${kind === k ? "bg-ink text-white" : "text-muted hover:text-ink"}`}>{l} ({data.cases.filter((c: any) => k === "all" || (c.camera ?? "cctv") === k).length})</button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.cases.filter((c: any) => kind === "all" || (c.camera ?? "cctv") === kind).map((c: any, i: number) => (
            <motion.div key={c.id} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i + 0.1, duration: 0.35 }} whileHover={{ y: -3 }}>
              <Link to={`/case/${c.id}`} className="group block overflow-hidden  border border-line bg-panel transition-colors hover:border-accent/60">
                <div className="relative aspect-video bg-panel-2">
                  {c.thumb ? <img src={`/api/cases/${c.id}/${c.thumb}`} alt="" className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100" /> : <div className="flex h-full items-center justify-center text-xs text-muted">no footage</div>}
                  <div className="absolute left-3 top-3"><LevelPill level={c.level} label={c.label} /></div>
                  <div className="absolute right-3 top-3 flex gap-1 text-[10px]">{c.camera === "dashcam" && <span className="bg-accent px-2 py-0.5 font-bold uppercase text-white">Dashcam</span>}<span className="bg-bg/80 px-2 py-0.5 text-muted">{c.simulated ? "simulated" : "real footage"}</span></div>
                </div>
                <div className="p-4">
                  <div className="truncate font-semibold">{c.title}</div>
                  <div className="truncate text-xs text-muted">{c.location || "Location not set"}</div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="flex items-center gap-1"><Scale size={13} className="text-claimed" />{c.contradictions} contradictions</span>
                    {c.test && <span className="flex items-center gap-1"><CheckCircle2 size={13} className="text-ok" />{c.test.caught}/{c.test.planted} caught · {c.test.false_flags} false</span>}
                    {c.hit_and_run && <span className="flex items-center gap-1"><AlertTriangle size={13} className={c.hit_and_run === "departed" ? "text-bad" : "text-muted"} />{RUN[c.hit_and_run]}</span>}
                  </div>
                  <div className="mt-3 flex items-center gap-1 text-xs font-semibold text-accent opacity-0 transition group-hover:opacity-100">Open case <ArrowRight size={13} /></div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
        <p className="mt-6 text-[11px] text-muted">Test statements were written to check the system, so these scores show it working on these cases. They aren't a measure of accuracy in general.</p>
      </>}
    </div>
  );
}
