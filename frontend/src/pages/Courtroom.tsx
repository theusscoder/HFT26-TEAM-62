import { useParams } from "react-router-dom";
import { useApi, type Analysis, type Event } from "../lib/api";
import { sentence, SOURCE_LABEL } from "../lib/story";
import { KindBadge, Loading, Panel, Ref, Status } from "../components/ui";

/* OWNER: P3. Contradictions: what was claimed vs what the evidence shows, side by side, with the frame the camera
   saw at impact, the rule that decided, how robust the verdict is ("holds unless …"), and the model's possible
   explanation labelled as a suggestion. Plus witness reliability and competing hypotheses. */
export default function Courtroom() {
  const { id } = useParams();
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis & { entities?: any; checks?: any[] }>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const vis = useApi<any>(`/cases/${id}/vision`);
  if (!ev.data || !an.data) return <Loading error={ev.error ?? an.error} />;
  const byId = Object.fromEntries(ev.data.map((e) => [e.id, e]));
  const ent = an.data.entities;
  const W = wit.data ?? {};
  const frame = (name: string) => vis.data?.frames?.find((f: any) => f.name === name);
  const why = (e: Event) => (e.kind === "CLAIMED" ? "claimed" : e.kind === "INFERRED" ? "measured" : "observed");

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        {!an.data.contradictions.length && (
          <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
            No contradictions. Either every checkable claim agrees with the physical evidence, or there is only one source so far.
          </div>
        )}
        {an.data.contradictions.map((c: any) => {
          const items = c.events.map((eid: string) => byId[eid]).filter(Boolean) as Event[];
          const kf = c.type === "temporal" ? frame("first") : frame(c.type === "presence" ? "before" : "impact");
          return (
            <Panel key={c.id} title={`${c.id} · ${c.type} contradiction`} right={<Status value={c.severity} />}>
              <p className="text-base font-medium">{c.summary}</p>
              <div className={`mt-4 grid gap-3 ${kf ? "md:grid-cols-[1fr_1fr_220px]" : "md:grid-cols-2"}`}>
                {items.map((e) => (
                  <div key={e.id} className={`rounded-lg border p-3 text-sm ${e.kind === "CLAIMED" ? "border-claimed/40 bg-claimed/5" : "border-observed/40 bg-observed/5"}`}>
                    <div className="flex items-center justify-between"><KindBadge kind={e.kind} /><span className="text-[11px] uppercase tracking-wider text-muted">{why(e)}</span></div>
                    <div className="mt-1 text-xs text-muted">{SOURCE_LABEL(e.source, W)}</div>
                    <div className="mt-2">{e.quote ? <span className="italic text-claimed">“{e.quote}”</span> : sentence(e, ent)}</div>
                    <div className="mt-2 flex justify-between gap-2"><Ref value={e.ref || (e.derived_from?.length ? `from ${e.derived_from.slice(0, 2).join(", ")}` : "")} /><span className="mono text-[11px] text-muted">{Math.round(e.confidence * 100)}%</span></div>
                  </div>
                ))}
                {kf && (
                  <figure className="overflow-hidden rounded-lg border border-line">
                    <img src={`/api/cases/${id}/${kf.file}`} alt="key frame" className="w-full" />
                    <figcaption className="px-2 py-1 text-[10px] text-muted">CCTV frame · T{kf.t >= 0 ? "+" : ""}{kf.t.toFixed(1)} s{kf.name !== "first" ? " · primary boxed red" : ""}</figcaption>
                  </figure>
                )}
              </div>
              {c.holds_unless && <p className="mt-3 text-sm"><span className="font-semibold text-ok">Robustness:</span> this holds unless {c.holds_unless}.</p>}
              {c.explanation && <p className="mt-1 text-sm text-muted"><span className="text-inferred">Possible explanation (AI suggestion, not a finding):</span> {c.explanation.replace(/^Suggestion:\s*/, "")}</p>}
            </Panel>
          );
        })}
      </div>
      <div className="space-y-4">
        <Panel title="Witness reliability">
          {Object.entries(an.data.reliability).map(([w, r]) => (
            <div key={w} className="mb-3">
              <div className="flex justify-between text-sm"><span>{SOURCE_LABEL(w, W)}</span><span className="mono">{r == null ? "n/a" : `${Math.round((r as number) * 100)}%`}</span></div>
              <div className="mt-1 h-1.5 rounded bg-panel-2"><div className={`h-full rounded ${(r as number) >= 0.6 ? "bg-ok" : (r as number) >= 0.4 ? "bg-warn" : "bg-bad"}`} style={{ width: `${((r as number) ?? 0) * 100}%` }} /></div>
              {W[w]?.vantage && <div className="mt-0.5 text-[11px] text-muted">{W[w].vantage}{W[w].distance_m ? ` · ~${W[w].distance_m} m away` : ""}</div>}
            </div>
          ))}
          <p className="text-[11px] text-muted">Share of this witness's checkable claims that agree with the physical evidence. A low score is about these claims, not about honesty.</p>
        </Panel>
        <Panel title="Competing explanations">
          {an.data.hypotheses.map((h) => (
            <div key={h.id} className="mb-3 text-sm">
              <div className="flex justify-between gap-2"><span>{h.text}</span><Status value={h.status} /></div>
              <div className="mono mt-1 text-[10px] text-muted">for {h.for.filter(Boolean).join(", ") || "–"} · against {h.against.join(", ") || "–"}</div>
              {h.untested?.length > 0 && <div className="mt-0.5 text-[11px] text-muted">untested: {h.untested.join(", ")}</div>}
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
