import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useApi, type Analysis, type Event } from "../lib/api";
import { useClock } from "../lib/clock";
import { claimStatus, contradictionsFor, phaseOf, salient, sentence, SOURCE_LABEL, type Entities } from "../lib/story";
import { KindBadge, Loading, Panel } from "../components/ui";

/* OWNER: P4. Two readings of the same events.
   Story (default): what happened, in three phases, only the events a person needs, every witness claim marked
   consistent / contradicted / unverifiable. Swimlanes: one lane per evidence source on the shared clock. */

const PHASES = [
  { key: "approach", title: "Approach", hint: "before the critical second" },
  { key: "critical", title: "Critical seconds", hint: "T-1 s to T+0.6 s" },
  { key: "aftermath", title: "Aftermath", hint: "after impact" },
];
const STATUS_STYLE: Record<string, string> = { consistent: "bg-ok/15 text-ok", contradicted: "bg-bad/15 text-bad", unverifiable: "bg-panel-2 text-muted" };
const SRC_DOT: Record<string, string> = { cctv: "bg-observed", sensor: "bg-[#5fd4e6]", fusion: "bg-inferred" };

function fmtT(e: Event) {
  if (e.kind === "CLAIMED") return e.t.start < -0.5 ? "before" : e.t.start > 0.1 ? "after" : "at impact";
  return `T${e.t.start >= 0 ? "+" : ""}${e.t.start.toFixed(1)}s`;
}

export default function Timeline() {
  const { id } = useParams();
  const { t, seek, range } = useClock();
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis & { entities?: Entities; checks?: any[] }>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const [mode, setMode] = useState<"story" | "lanes">("story");
  const [raw, setRaw] = useState(false);
  const [sel, setSel] = useState<Event | null>(null);
  const ent = an.data?.entities;
  const shown = useMemo(() => (ev.data ?? []).filter((e) => raw || salient(e, ent)), [ev.data, raw, ent]);
  if (!ev.data || !an.data) return <Loading error={ev.error ?? an.error} />;
  const W = wit.data ?? {};

  const header = (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="flex rounded-lg border border-line p-0.5">
        {(["story", "lanes"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`rounded-md px-3 py-1 text-sm ${mode === m ? "bg-accent text-white" : "text-muted"}`}>
            {m === "story" ? "Story" : "Swimlanes"}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> show raw detections ({ev.data.length - ev.data.filter((e) => salient(e, ent)).length} hidden)</label>
      <div className="ml-auto flex items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-observed" />observed</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-claimed" />witness claim</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-inferred" />inferred</span>
      </div>
    </div>
  );

  const detail = sel && (
    <Panel title="Evidence" right={<button onClick={() => setSel(null)} className="text-xs text-muted">close</button>}>
      <div className="flex items-center gap-2"><KindBadge kind={sel.kind} /><span className="text-xs text-muted">{SOURCE_LABEL(sel.source, W)}</span></div>
      <p className="mt-2 font-medium">{sentence(sel, ent)}</p>
      {sel.quote && <p className="mt-1 italic text-claimed">“{sel.quote}”</p>}
      <dl className="mono mt-3 grid grid-cols-[90px_1fr] gap-y-1 text-[11px]">
        <dt className="text-muted">id</dt><dd>{sel.id}</dd>
        <dt className="text-muted">time</dt><dd>T{sel.t.start.toFixed(2)} → T{sel.t.end.toFixed(2)} s</dd>
        <dt className="text-muted">confidence</dt><dd>{Math.round(sel.confidence * 100)}%</dd>
        {sel.ref && <><dt className="text-muted">source ref</dt><dd className="text-accent">{sel.ref}</dd></>}
        {sel.rule && <><dt className="text-muted">rule</dt><dd>{sel.rule}</dd></>}
        {sel.derived_from?.length > 0 && <><dt className="text-muted">derived from</dt><dd>{sel.derived_from.join(", ")}</dd></>}
        {(sel as any).method && <><dt className="text-muted">extracted by</dt><dd>{(sel as any).method}</dd></>}
      </dl>
      {contradictionsFor(sel.id, an.data).map((c) => (
        <div key={c.id} className="mt-3 rounded-lg border border-bad/40 bg-bad/5 p-2 text-sm"><span className="text-bad">{c.id}</span> {c.summary}</div>
      ))}
      {sel.kind !== "CLAIMED" && <button onClick={() => seek(sel.t.start)} className="mt-3 text-xs text-accent">jump replay clock here →</button>}
    </Panel>
  );

  if (mode === "story") {
    return (
      <div>
        {header}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            {PHASES.map((ph) => {
              const items = shown.filter((e) => phaseOf(e) === ph.key)
                .sort((a, b) => a.t.start - b.t.start);
              return (
                <section key={ph.key}>
                  <div className="mb-2 flex items-baseline gap-3">
                    <h2 className={`text-lg font-semibold ${ph.key === "critical" ? "text-bad" : ""}`}>{ph.title}</h2>
                    <span className="text-xs text-muted">{ph.hint} · {items.length} items</span>
                  </div>
                  <ol className="relative space-y-2 border-l border-line pl-5">
                    {items.map((e) => {
                      const st = e.kind === "CLAIMED" ? claimStatus(e, an.data!) : undefined;
                      const cs = contradictionsFor(e.id, an.data!);
                      return (
                        <li key={e.id} onClick={() => setSel(e)} className={`relative cursor-pointer rounded-lg border bg-panel p-3 hover:border-accent/60 ${sel?.id === e.id ? "border-accent" : "border-line"}`}>
                          <span className={`absolute -left-[27px] top-4 h-3 w-3 rounded-full ring-4 ring-bg ${e.kind === "CLAIMED" ? "bg-claimed" : SRC_DOT[e.source] ?? "bg-observed"}`} />
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="mono text-muted">{fmtT(e)}</span>
                            <span className="text-muted">·</span>
                            <span className="text-muted">{SOURCE_LABEL(e.source, W)}</span>
                            {st && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[st]}`}>{st}</span>}
                            {cs.map((c) => <span key={c.id} className="rounded bg-bad/15 px-1.5 py-0.5 text-[10px] font-semibold text-bad">{c.id}</span>)}
                            <span className="ml-auto mono text-[10px] text-muted">{Math.round(e.confidence * 100)}%</span>
                          </div>
                          <div className="mt-1 text-sm">{e.quote ? <span className="italic text-claimed">“{e.quote}”</span> : sentence(e, ent)}</div>
                        </li>
                      );
                    })}
                    {!items.length && <li className="text-sm text-muted">Nothing recorded in this phase.</li>}
                  </ol>
                </section>
              );
            })}
            {an.data.gaps.length > 0 && (
              <Panel title="Evidence gaps">
                {an.data.gaps.map((g, i) => <p key={i} className="text-sm"><span className="mono text-warn">T{g.start.toFixed(1)} → T{g.end.toFixed(1)} s</span> · {g.note}</p>)}
              </Panel>
            )}
          </div>
          <div className="space-y-4">{detail || <Panel title="Evidence"><p className="text-sm text-muted">Click any item to see its source, rule, confidence and contradictions.</p></Panel>}</div>
        </div>
      </div>
    );
  }

  // Swimlanes: one lane per source; claims (ordering only) drawn as hatched windows
  const [lo, hi] = range;
  const pct = (x: number) => ((Math.min(hi, Math.max(lo, x)) - lo) / (hi - lo)) * 100;
  const conflicted = new Set(an.data.contradictions.flatMap((c) => c.events));
  const lanes = [...new Set(shown.map((e) => e.source))].sort((a, b) => ["cctv", "sensor", "fusion"].indexOf(a) - ["cctv", "sensor", "fusion"].indexOf(b));
  const ticks = Array.from({ length: Math.floor(hi) - Math.ceil(lo) + 1 }, (_, i) => Math.ceil(lo) + i);
  return (
    <div>
      {header}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Swimlanes · one lane per source · T0 = impact">
          <div className="relative">
            <div className="ml-36 flex justify-between pb-1 text-[10px] text-muted">{ticks.map((k) => <span key={k} className={k === 0 ? "text-bad" : ""}>{k}s</span>)}</div>
            {lanes.map((s) => (
              <div key={s} className="flex items-center gap-3 border-t border-line/50 py-2">
                <div className="w-32 shrink-0 text-right text-xs text-muted">{SOURCE_LABEL(s, W)}</div>
                <div className="relative h-8 flex-1 rounded bg-panel-2" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(lo + ((e.clientX - r.left) / r.width) * (hi - lo)); }}>
                  {an.data!.gaps.map((g, i) => <div key={i} className="absolute inset-y-0 bg-warn/10" style={{ left: `${pct(g.start)}%`, width: `${pct(g.end) - pct(g.start)}%` }} />)}
                  {shown.filter((e) => e.source === s).map((e, i) => (
                    <button key={e.id} title={sentence(e, ent)} onClick={(x) => { x.stopPropagation(); setSel(e); }}
                      className={`absolute rounded ${e.kind === "CLAIMED" ? "bg-claimed/40 [background-image:repeating-linear-gradient(45deg,transparent_0_4px,rgba(0,0,0,.25)_4px_8px)]" : e.kind === "INFERRED" ? "bg-inferred" : SRC_DOT[e.source] ?? "bg-observed"} ${conflicted.has(e.id) ? "ring-2 ring-bad" : ""} ${sel?.id === e.id ? "outline outline-2 outline-white" : ""}`}
                      style={{ left: `${pct(e.t.start)}%`, width: `max(8px, ${pct(e.t.end) - pct(e.t.start)}%)`, top: 4 + (i % 3) * 7, height: 10, opacity: 0.45 + e.confidence * 0.55 }} />
                  ))}
                </div>
              </div>
            ))}
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-ink/80" style={{ left: `calc(9rem + (100% - 9rem) * ${pct(t) / 100})` }} />
            <div className="pointer-events-none absolute inset-y-0 w-px bg-bad/70" style={{ left: `calc(9rem + (100% - 9rem) * ${pct(0) / 100})` }} />
          </div>
          <p className="mt-3 text-[11px] text-muted">Hatched = witness claim (ordering only, no exact time). Red outline = part of a contradiction. Amber band = evidence gap. White line = playhead, red line = impact.</p>
        </Panel>
        <div>{detail || <Panel title="Evidence"><p className="text-sm text-muted">Click a mark to inspect it.</p></Panel>}</div>
      </div>
    </div>
  );
}
