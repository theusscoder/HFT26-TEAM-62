import { useParams } from "react-router-dom";
import { useApi, type Analysis, type Event } from "../lib/api";
import { KindBadge, Loading, Panel, Ref, Status } from "../components/ui";

/* OWNER: P3. Each contradiction: the two sides of the evidence side by side (frame vs quote), the rule,
   and the LLM's suggested explanation labelled as a suggestion. Plus witness reliability and hypotheses.
   TODO: show the actual video frame (thumbnail from P1) for OBSERVED refs; "edit witness" → POST /witness. */
export default function Courtroom() {
  const { id } = useParams();
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis>(`/cases/${id}/analysis`);
  if (!ev.data || !an.data) return <Loading error={ev.error ?? an.error} />;
  const byId = Object.fromEntries(ev.data.map((e) => [e.id, e]));

  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div className="space-y-4">
        {!an.data.contradictions.length && (
          <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
            No contradictions yet. They appear once a second source (witness statement or sensor log) is added to this case.
          </div>
        )}
        {an.data.contradictions.map((c) => (
          <Panel key={c.id} title={`${c.id} · ${c.type}`} right={<Status value={c.severity} />}>
            <p className="font-medium">{c.summary}</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {c.events.map((eid) => byId[eid]).filter(Boolean).map((e) => (
                <div key={e.id} className="rounded-lg border border-line bg-panel-2 p-3 text-sm">
                  <div className="flex items-center justify-between"><KindBadge kind={e.kind} /><span className="text-xs text-muted">{e.source}</span></div>
                  <div className="mt-2">{e.quote ? <span className="italic text-claimed">“{e.quote}”</span> : `${e.actor} · ${e.action} · ${e.value ?? ""}`}</div>
                  <div className="mt-2 flex justify-between"><Ref value={e.ref} /><span className="mono text-[11px] text-muted">conf {Math.round(e.confidence * 100)}%</span></div>
                </div>
              ))}
            </div>
            {c.explanation && <p className="mt-3 text-sm text-muted"><span className="text-inferred">AI suggestion, not a finding:</span> {c.explanation.replace(/^Suggestion:\s*/, "")}</p>}
          </Panel>
        ))}
      </div>
      <div className="space-y-4">
        <Panel title="Witness reliability">
          {Object.entries(an.data.reliability).map(([w, r]) => (
            <div key={w} className="mb-3">
              <div className="flex justify-between text-sm"><span>{w}</span><span className="mono">{Math.round(r * 100)}%</span></div>
              <div className="mt-1 h-1.5 rounded bg-panel-2"><div className="h-full rounded bg-accent" style={{ width: `${r * 100}%` }} /></div>
            </div>
          ))}
          <p className="text-[11px] text-muted">Share of checkable claims consistent with physical evidence.</p>
        </Panel>
        <Panel title="Hypotheses">
          {an.data.hypotheses.map((h) => (
            <div key={h.id} className="mb-3 text-sm">
              <div className="flex justify-between gap-2"><span>{h.id} · {h.text}</span><Status value={h.status} /></div>
              <div className="mono mt-1 text-[11px] text-muted">for {h.for.join(", ") || "–"} · against {h.against.join(", ") || "–"}</div>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
