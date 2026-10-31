import { useMemo } from "react";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Activity, Box, Camera, Car, Clock, Crosshair, ChevronLeft, ClipboardList, FileText, Gauge, LayoutDashboard, MapPin, MessageCircleQuestion, Ruler, Scale, Siren, Video } from "lucide-react";
import { useApi } from "../lib/api";
import { ClockProvider } from "../lib/clock";
import { LevelPill } from "./ui";
import ThemePicker from "./ThemePicker";

// Grouped by what the reader is trying to do, in demo order.
const NAV = [
  { group: "The case", items: [["", "Overview", LayoutDashboard], ["replay", "Evidence replay", Video], ["reconstruction", "Reconstruction", Box], ["dashcam", "Dashcam", Camera], ["timeline", "Timeline", Activity]] },
  { group: "The analysis", items: [["courtroom", "Contradictions", Scale], ["avoidable", "Could it be avoided?", Gauge], ["ask", "Ask the case", MessageCircleQuestion]] },
  { group: "The response", items: [["golden-hour", "Emergency response", Siren], ["response", "Response timeline", Clock], ["dossiers", "Plates & dossiers", ClipboardList], ["pursuit", "Hit-and-run", Car], ["intercept", "Intercept (sim)", Crosshair], ["report", "Report", FileText]] },
  { group: "Setup", items: [["calibrate", "Road calibration", Ruler]] },
] as const;

export default function CaseLayout() {
  const { id } = useParams();
  const { pathname } = useLocation();
  const { data: c, error } = useApi<{ title: string; location: { name: string; lat?: number | null; lon?: number | null; source?: string; estimated?: boolean }; simulated: boolean; range?: [number, number]; license?: string }>(`/cases/${id}/case`);
  const sev = useApi<{ level: string; label: string }>(`/cases/${id}/severity`);
  // Each case has its own time range (seconds from impact); mount the clock once the case is known.
  const range = useMemo<[number, number]>(() => c?.range ?? [-5, 3], [c?.range?.[0], c?.range?.[1]]);
  if (!c) return error
    ? <div className="p-8 text-sm"><p className="text-bad">Couldn't load this case ({error}).</p><p className="mt-1 text-muted">If this says 500 or 502, the API isn't running on port 8000. Run start.bat from the repo folder.</p><Link to="/" className="mt-3 inline-block text-accent underline">Back to the command centre</Link></div>
    : <div className="p-8 text-sm text-muted">Loading case…</div>;
  return (
    <ClockProvider key={id} range={range}>
      <div className="flex h-full">
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur">
          <Link to="/" className="flex items-center gap-2 px-4 pb-1 pt-4 text-lg font-bold tracking-tight"><ClipboardList size={18} className="text-accent" />YATHARTH</Link>
          <Link to="/" className="flex items-center gap-1 px-4 text-[11px] text-muted hover:text-ink"><ChevronLeft size={12} />Live city map</Link>
          <nav className="mt-4 flex flex-1 flex-col gap-4 overflow-auto px-3 pb-4">
            {NAV.map(({ group, items }) => (
              <div key={group}>
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted/70">{group}</div>
                <div className="flex flex-col gap-0.5">
                  {items.map(([path, label, Icon]) => (
                    <NavLink key={path} end={path === ""} to={`/case/${id}/${path}`} className="group relative">
                      {({ isActive }) => (
                        <div className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${isActive ? "text-ink" : "text-muted hover:text-ink"}`}>
                          {isActive && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg border border-accent/30 bg-accent/15" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                          <Icon size={15} className="relative" /><span className="relative">{label}</span>
                        </div>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="border-t border-line px-3 py-2"><div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Theme</div><ThemePicker compact /></div>
          <p className="border-t border-line px-4 py-3 text-[11px] text-muted">{c.simulated ? "Demo case · simulated sensor, witnesses and registry" : `Real footage${c.license ? ` · ${c.license}` : ""}`}</p>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-line bg-bg/70 px-6 py-3 backdrop-blur">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{c.title}</div>
              <div className="flex items-center gap-1 truncate text-[11px] text-muted">
                <MapPin size={11} className="shrink-0" /><span className="truncate">{c.location?.name || "Logging the location…"}</span>
                {c.location?.lat != null && <a href={`https://maps.google.com/?q=${c.location.lat},${c.location.lon}`} target="_blank" rel="noreferrer" className="mono shrink-0 underline decoration-dotted">{(+c.location.lat).toFixed(4)}, {(+c.location.lon!).toFixed(4)}</a>}
                {c.location?.source && <span className="truncate"><b className={c.location.estimated ? "text-warn" : "text-ok"}>· {c.location.estimated ? "Estimated" : "Auto-logged"}</b> · {c.location.source}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {(c as any).camera && <span title={(c as any).camera.why} className={`border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${(c as any).camera.type === "dashcam" ? "border-accent text-accent" : "border-ink"}`}>{(c as any).camera.type === "dashcam" ? "Dashcam" : "CCTV"}{(c as any).camera.confidence ? ` · auto ${Math.round((c as any).camera.confidence * 100)}%` : ""}</span>}
              <Link to={`/case/${id}/golden-hour`}><LevelPill level={sev.data?.level} label={sev.data?.label} /></Link>
            </div>
          </header>
          <main className="min-w-0 flex-1 overflow-auto p-6">
            <motion.div key={pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: "easeOut" }}><Outlet /></motion.div>
          </main>
        </div>
      </div>
    </ClockProvider>
  );
}
