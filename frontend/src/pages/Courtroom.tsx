import { useState } from "react";
import { useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftRight, Atom, Clock, Eye, Gauge, ShieldCheck, Sparkles, Users } from "lucide-react";
import { useApi, type Analysis, type Event } from "../lib/api";
import { sentence, SOURCE_LABEL } from "../lib/story";
import { KindBadge, Loading, Meter, Panel, Ref, Status } from "../components/ui";
import Challenge from "../components/Challenge";

/* The contradictions board. Left: every conflict, by severity. Middle: the one you picked, claim against evidence, with
   the rule that decided, what would have to be wrong for it to flip, and the frame. Right: the tools around it. */

const TYPE: Record<string, { Icon: any; label: string; rule: string }> = {
  quantity: { Icon: Gauge, label: "Number", rule: "Eyewitness speeds count as matching within the larger of 10 km/h or 35% of the measured speed." },
  state: { Icon: Eye, label: "What happened", rule: "The claim is compared with the track, posture or telematics at that moment." },
  presence: { Icon: Users, label: "Who was there", rule: "The vehicle named is checked against its own track: a stationary vehicle can't cut in or ram anything." },
  temporal: { Icon: Clock, label: "Timing", rule: "Clock times are compared with the CCTV overlay, and stated orders go through the timing solver, where a negative cycle proves they can't all be true." },
  witness: { Icon: ArrowLeftRight, label: "Witness vs witness", rule: "Two accounts of the same quantity are compared with each other." },
  physics: { Icon: Atom, label: "Physics", rule: "Braking distance v²/2μg is compared with the road actually covered before the logged impact." },
};
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function SpeedGauge({ claim, measured, sigma }: { claim: number; measured: number; sigma: number }) {
  const top = Math.max(claim, measured + sigma) * 1.15, pct = (v: number) => `${(v / top) * 100}%`;
  const tol = Math.max(10, 0.35 * measured);
  return (
    <div className="mt-4  border border-line bg-panel-2/60 p-3">
      <div className="relative h-14">
        <div className="absolute inset-x-0 top-6 h-2 rounded-full bg-panel" />
        <motion.div className="absolute top-6 h-2 rounded bg-ok/25" initial={{ width: 0 }} animate={{ left: pct(Math.max(0, measured - tol)), width: `${((Math.min(top, measured + tol) - Math.max(0, measured - tol)) / top) * 100}%` }} transition={{ duration: 0.7 }} title="Range that would count as matching" />
        <motion.div className="absolute top-3 h-8 w-1 rounded bg-observed" initial={{ left: 0 }} animate={{ left: pct(measured) }} transition={{ duration: 0.7 }} />
        <motion.div className="absolute top-3 h-8 w-1 rounded bg-claimed" initial={{ left: 0 }} animate={{ left: pct(claim) }} transition={{ duration: 0.9, delay: 0.1 }} />
        <motion.div className="mono absolute top-0 -translate-x-1/2 text-[11px] text-observed" initial={{ left: 0 }} animate={{ left: pct(measured) }} transition={{ duration: 0.7 }}>{measured.toFixed(0)}</motion.div>
        <motion.div className="mono absolute top-0 -translate-x-1/2 text-[11px] text-claimed" initial={{ left: 0 }} animate={{ left: pct(claim) }} transition={{ duration: 0.9, delay: 0.1 }}>{claim.toFixed(0)}</motion.div>
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted">
        <span><span className="text-observed">measured</span> ± {sigma.toFixed(0)} · <span className="text-claimed">claimed</span> · <span className="text-ok">counts as matching</span></span>
        <span className="mono">|{claim.toFixed(0)} − {measured.toFixed(0)}| = {Math.abs(claim - measured).toFixed(0)} km/h, limit {tol.toFixed(0)}</span>
      </div>
    </div>
  );
}

function frameOf(ref: string): { file: string; frame: number } | null {
  const m = /^([\w.-]+\.mp4)#f=(\d+)/.exec(ref ?? "");
  return m ? { file: m[1], frame: +m[2] } : null;
}

// A person says which track is the primary vehicle. Everything downstream recomputes.
function EntityEditor({ caseId, entities }: { caseId: string; entities: any }) {
  const tracks = useApi<{ tracks: { id: string; class: string }[] }>(`/cases/${caseId}/tracks_metric`);
  const [primary, setPrimary] = useState<string>(entities.primary ?? "");
  const [state, setState] = useState<string | null>(null);
  async function save() {
    setState("Recomputing…");
    const r = await fetch(`/api/cases/${caseId}/entities`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ primary }) });
    if (!r.ok) { setState(`Couldn't save (${r.status})`); return; }
    location.reload();
  }
  return (
    <div>
      <label className="block text-sm">Primary vehicle
        <select value={primary} onChange={(e) => setPrimary(e.target.value)} className="mono mt-1 w-full rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-xs">
          {(tracks.data?.tracks ?? []).filter((t) => t.class !== "person").map((t) => <option key={t.id} value={t.id}>{entities.names?.[t.id] ?? t.class} · {t.id}</option>)}
        </select>
      </label>
      <button disabled={primary === entities.primary} onClick={save} className="mt-2 w-full rounded-lg border border-line py-1.5 text-xs transition hover:border-accent disabled:opacity-40">Save and recompute</button>
      {state && <p className="mt-1 text-[11px] text-muted">{state}</p>}
    </div>
  );
}

export default function Courtroom() {
  const { id } = useParams();
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis & { entities?: any; checks?: any[] }>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const vis = useApi<any>(`/cases/${id}/vision`);
  const flags = useApi<any[]>(`/cases/${id}/interview-flags`);
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<"reliability" | "explain" | "redteam" | "who">("reliability");
  if (!ev.data || !an.data) return <Loading error={ev.error ?? an.error} />;
  const byId = Object.fromEntries(ev.data.map((e) => [e.id, e]));
  const ent = an.data.entities;
  const W = wit.data ?? {};
  const frame = (name: string) => vis.data?.frames?.find((f: any) => f.name === name);
  const list = [...an.data.contradictions].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
  const cur: any = list.find((c) => c.id === picked) ?? list[0];
  const items = cur ? (cur.events.map((eid: string) => byId[eid]).filter(Boolean) as Event[]) : [];
  const claim = items.find((e) => e.kind === "CLAIMED"), other = items.find((e) => e.kind !== "CLAIMED");
  const kf = cur && (cur.type === "temporal" ? frame("first") : frame(cur.type === "presence" ? "before" : "impact"));
  const measuredMatch = other && /(\d+(?:\.\d+)?)\s*(?:±\s*(\d+(?:\.\d+)?))?\s*km\/h/.exec(String(other.value ?? ""));
  const claimSpeed = cur?.type === "quantity" && claim ? parseFloat(String(claim.value)) : NaN;
  const T = TYPE[cur?.type] ?? TYPE.state;
  const tabs = [["reliability", "Reliability"], ["explain", "Explanations"], ["redteam", "Red team"], ["who", "Who is who"]] as const;

  return (
    <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[300px_minmax(0,1fr)_340px] xl:grid-cols-[280px_minmax(0,1fr)]">
      <div className="space-y-2">
        <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{list.length} contradiction{list.length === 1 ? "" : "s"}</div>
        {list.map((c: any, i: number) => {
          const t = TYPE[c.type] ?? TYPE.state, on = c.id === cur?.id;
          return (
            <motion.button key={c.id} onClick={() => setPicked(c.id)} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
              className={`w-full  border p-3 text-left transition-colors ${on ? "border-accent/60 bg-accent/10" : "border-line bg-panel hover:border-line/80 hover:bg-panel-2"}`}>
              <div className="flex items-center justify-between gap-2 text-[11px]"><span className="flex items-center gap-1.5 text-muted"><t.Icon size={13} />{t.label}</span><Status value={c.severity} /></div>
              <div className="mt-1 line-clamp-2 text-sm">{c.summary}</div>
            </motion.button>
          );
        })}
        {!list.length && <div className=" border border-dashed border-line p-6 text-center text-sm text-muted">No contradictions. Either every checkable claim agrees with the physical evidence, or there is only one source so far.</div>}
      </div>

      <div className="min-w-0">
        <AnimatePresence mode="wait">
          {cur && (
            <motion.div key={cur.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }} className=" border border-line bg-panel p-5">
              <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-muted"><span className="flex items-center gap-1.5"><T.Icon size={14} />{T.label} · {cur.id}</span><Status value={cur.severity} /></div>
              <h2 className="mt-2 text-xl font-semibold leading-snug">{cur.summary}</h2>
              {cur.type === "quantity" && !isNaN(claimSpeed) && measuredMatch && <SpeedGauge claim={claimSpeed} measured={+measuredMatch[1]} sigma={+(measuredMatch[2] ?? 0)} />}

              <div className={`mt-4 grid gap-3 ${kf ? "lg:grid-cols-[1fr_1fr_240px]" : "md:grid-cols-2"}`}>
                {items.map((e, i) => (
                  <motion.div key={e.id} initial={{ opacity: 0, x: i ? 14 : -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 + i * 0.05 }}
                    className={` border p-3 text-sm ${e.kind === "CLAIMED" ? "border-claimed/40 bg-claimed/5" : "border-observed/40 bg-observed/5"}`}>
                    <div className="flex items-center justify-between"><KindBadge kind={e.kind} /><span className="mono text-[11px] text-muted">{Math.round(e.confidence * 100)}%</span></div>
                    <div className="mt-1 text-xs text-muted">{SOURCE_LABEL(e.source, W)}</div>
                    {!kf && frameOf(e.ref) && <img loading="lazy" alt={`Frame cited by ${e.id}`} className="mt-2 w-full rounded" src={`/api/cases/${id}/frame/${frameOf(e.ref)!.file}/${frameOf(e.ref)!.frame}`} />}
                    <div className="mt-2">{e.quote ? <span className="italic text-claimed">“{e.quote}”</span> : sentence(e, ent)}</div>
                    {e.translation && <div className="mt-1 text-xs text-muted">Translation: {e.translation}</div>}
                    <div className="mt-2"><Ref value={e.ref || (e.derived_from?.length ? `from ${e.derived_from.slice(0, 2).join(", ")}` : "")} /></div>
                  </motion.div>
                ))}
                {kf && (
                  <motion.figure initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="overflow-hidden  border border-line">
                    <img src={`/api/cases/${id}/${kf.file}`} alt="Key frame" className="w-full" />
                    <figcaption className="px-2 py-1 text-[10px] text-muted">CCTV · T{kf.t >= 0 ? "+" : ""}{kf.t.toFixed(1)} s{kf.name !== "first" ? " · primary boxed red" : ""}</figcaption>
                  </motion.figure>
                )}
              </div>

              <div className="mt-4 space-y-2 text-sm">
                <p className="flex gap-2"><Gauge size={15} className="mt-0.5 shrink-0 text-muted" /><span><span className="font-semibold">Rule: </span><span className="text-muted">{T.rule}</span></span></p>
                {cur.holds_unless && <p className="flex gap-2"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-ok" /><span><span className="font-semibold text-ok">Holds unless </span>{cur.holds_unless}.</span></p>}
                {cur.explanation && <p className="flex gap-2"><Sparkles size={15} className="mt-0.5 shrink-0 text-inferred" /><span><span className="font-semibold text-inferred">Possible explanation, a suggestion and not a finding: </span><span className="text-muted">{cur.explanation.replace(/^Suggestion:\s*/, "")}</span></span></p>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="space-y-4 xl:col-span-2 2xl:col-span-1">
        <div className="flex  border border-line bg-panel p-1 text-xs">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`relative flex-1 rounded-lg px-1 py-1.5 transition-colors ${tab === k ? "text-ink" : "text-muted hover:text-ink"}`}>
              {tab === k && <motion.span layoutId="tab-bg" className="absolute inset-0 rounded-lg bg-accent/20" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
        {tab === "reliability" && (
          <Panel title="Witness reliability">
            {Object.entries(an.data.reliability).map(([w, r], i) => {
              const d = an.data!.reliability_detail?.[w], v = (r as number) ?? 0;
              return (
                <div key={w} className="mb-4">
                  <div className="flex justify-between text-sm"><span>{SOURCE_LABEL(w, W)}</span><span className="mono">{r == null ? "n/a" : `${Math.round(v * 100)}%`}</span></div>
                  <div className="mt-1"><Meter value={v} tone={v >= 0.6 ? "bg-ok" : v >= 0.4 ? "bg-warn" : "bg-bad"} delay={i * 0.08} /></div>
                  {W[w]?.vantage && <div className="mt-1 text-[11px] text-muted">{W[w].vantage}{W[w].distance_m ? ` · ~${W[w].distance_m} m away` : ""}</div>}
                  {d && <div className="mt-0.5 text-[11px] text-muted">Conditions {Math.round(d.weight * 100)}%: {d.reasons.join("; ") || "nothing against"}</div>}
                </div>
              );
            })}
            <p className="text-[11px] text-muted">Bar: share of checkable claims that agree with the physical evidence. A low score is about these claims, not about honesty. Conditions: what to expect from where and how they saw it; speed estimates are marked down further.</p>
            {flags.data && flags.data.length > 0 && (
              <div className="mt-4 border-t border-line/70 pt-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Leading questions</div>
                {flags.data.map((f: any, i: number) => <div key={i} className="mt-2 text-sm"><p>“{f.question}”</p><p className="mt-0.5 text-xs text-muted">{f.suggestion} {f.note}</p></div>)}
              </div>
            )}
          </Panel>
        )}
        {tab === "explain" && (
          <Panel title="Competing explanations">
            {an.data.hypotheses.map((h, i) => (
              <motion.div key={h.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="mb-3 text-sm">
                <div className="flex justify-between gap-2"><span>{h.text}</span><Status value={h.status} /></div>
                <div className="mono mt-1 text-[10px] text-muted">for {h.for.filter(Boolean).join(", ") || "–"} · against {h.against.join(", ") || "–"}</div>
                {h.untested?.length > 0 && <div className="mt-0.5 text-[11px] text-muted">untested: {h.untested.join(", ")}</div>}
              </motion.div>
            ))}
          </Panel>
        )}
        {tab === "redteam" && <Challenge caseId={id!} />}
        {tab === "who" && <Panel title="Who is who">{ent?.primary ? <EntityEditor caseId={id!} entities={ent} /> : <p className="text-sm text-muted">No vehicle identified yet.</p>}</Panel>}
      </div>
    </div>
  );
}
