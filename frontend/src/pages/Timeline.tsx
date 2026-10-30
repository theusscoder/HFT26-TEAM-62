import { useParams } from "react-router-dom";
import { useApi, type Analysis, type Event } from "../lib/api";
import { useClock } from "../lib/clock";
import { Loading, Panel } from "../components/ui";

// OWNER: P3. One lane per source; events drawn as time windows; gaps shaded; contradicting events outlined red.
const KIND_FILL = { OBSERVED: "bg-observed", CLAIMED: "bg-claimed", INFERRED: "bg-inferred" } as const;

export default function Timeline() {
  const { id } = useParams();
  const { t, seek, range } = useClock();
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis>(`/cases/${id}/analysis`);
  if (!ev.data || !an.data) return <Loading error={ev.error ?? an.error} />;

  const [lo, hi] = range, pct = (x: number) => ((x - lo) / (hi - lo)) * 100;
  const conflicted = new Set(an.data.contradictions.flatMap((c) => c.events));
  // One lane per source; a busy video source is split into one lane per actor so it stays readable.
  const perSource: Record<string, number> = {};
  ev.data.forEach((e) => (perSource[e.source] = (perSource[e.source] ?? 0) + 1));
  const laneOf = (e: Event) => (perSource[e.source] > 8 ? `${e.source} · ${e.actor}` : e.source);
  const lanes = [...new Set(ev.data.map(laneOf))];
  return (
    <Panel title="Unified timeline · T0 = impact" right={<span className="mono text-xs text-muted">click a lane to seek</span>}>
      <div className="relative space-y-1">
        {lanes.map((s) => (
          <div key={s} className="flex items-center gap-3">
            <div className="mono w-44 shrink-0 truncate text-right text-[11px] text-muted" title={s}>{s}</div>
            <div className="relative h-6 flex-1 rounded bg-panel-2" onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect(); seek(lo + ((e.clientX - r.left) / r.width) * (hi - lo));
            }}>
              {an.data!.gaps.map((g, i) => (
                <div key={i} className="absolute inset-y-0 bg-warn/10" style={{ left: `${pct(g.start)}%`, width: `${pct(g.end) - pct(g.start)}%` }} />
              ))}
              {ev.data!.filter((e) => laneOf(e) === s).map((e) => (
                <div key={e.id} title={`${e.id} ${e.actor} ${e.action} ${e.value ?? ""}`}
                  className={`absolute top-1 h-4 rounded ${KIND_FILL[e.kind]} ${conflicted.has(e.id) ? "ring-2 ring-bad" : ""}`}
                  style={{ left: `${pct(e.t.start)}%`, width: `max(6px, ${pct(e.t.end) - pct(e.t.start)}%)`, opacity: 0.4 + e.confidence * 0.6 }} />
              ))}
            </div>
          </div>
        ))}
        <div className="pointer-events-none absolute inset-y-0 w-px bg-ink" style={{ left: `calc(11.75rem + (100% - 11.75rem) * ${pct(t) / 100})` }} />
      </div>
    </Panel>
  );
}
