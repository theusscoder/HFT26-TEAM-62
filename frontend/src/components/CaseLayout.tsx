import { useMemo } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { ClockProvider } from "../lib/clock";

// Act order = demo order (PLAN.md section 7).
const NAV = [
  ["", "Overview"],
  ["golden-hour", "0 · Golden Hour"],
  ["replay", "1 · Reconstruction"],
  ["timeline", "Timeline"],
  ["courtroom", "2 · Courtroom"],
  ["avoidable", "3 · Avoidable?"],
  ["pursuit", "4 · Hit-and-run"],
  ["report", "Report"],
  ["calibrate", "Road calibration"],
];

export default function CaseLayout() {
  const { id } = useParams();
  const { data: c } = useApi<{ title: string; location: { name: string }; simulated: boolean; range?: [number, number]; license?: string }>(`/cases/${id}/case`);
  // Each case has its own time range (seconds from impact); mount the clock once the case is known.
  const range = useMemo<[number, number]>(() => c?.range ?? [-5, 3], [c?.range?.[0], c?.range?.[1]]);
  if (!c) return <div className="p-8 text-sm text-muted">Loading case…</div>;
  return (
    <ClockProvider key={id} range={range}>
      <div className="flex h-full">
        <aside className="w-56 shrink-0 border-r border-line bg-panel p-4">
          <NavLink to="/" className="text-lg font-bold tracking-tight">YATHARTH</NavLink>
          <p className="mt-1 text-xs text-muted">{c?.title ?? "…"}</p>
          <nav className="mt-6 flex flex-col gap-0.5">
            {NAV.map(([path, label]) => (
              <NavLink key={path} end={path === ""} to={`/case/${id}/${path}`}
                className={({ isActive }) => `rounded-md px-3 py-2 text-sm ${isActive ? "bg-accent/15 text-ink" : "text-muted hover:text-ink"}`}>
                {label}
              </NavLink>
            ))}
          </nav>
          {c.simulated ? <p className="mt-8 text-[11px] text-muted">Demo case · simulated sensor, witnesses and registry</p>
            : <p className="mt-8 text-[11px] text-muted">Real footage{c.license ? ` · ${c.license}` : ""}</p>}
        </aside>
        <main className="min-w-0 flex-1 overflow-auto p-6"><Outlet /></main>
      </div>
    </ClockProvider>
  );
}
