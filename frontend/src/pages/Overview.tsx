import { Link, useParams } from "react-router-dom";
import { useApi, type Analysis, type Event } from "../lib/api";
import { Loading, Panel, Status } from "../components/ui";

// OWNER: P3. Case overview: severity, counts, evidence inventory, act shortcuts.
export default function Overview() {
  const { id } = useParams();
  const c = useApi<any>(`/cases/${id}/case`);
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis>(`/cases/${id}/analysis`);
  const sev = useApi<any>(`/cases/${id}/severity`);
  if (!c.data || !ev.data || !an.data || !sev.data) return <Loading error={c.error ?? ev.error ?? an.error ?? sev.error} />;

  const stats = [
    ["Evidence sources", c.data.evidence.length],
    ["Events extracted", ev.data.length],
    ["Contradictions", an.data.contradictions.length],
    ["Evidence gaps", an.data.gaps.length],
  ];
  const score = (an.data as any).score;
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">{c.data.title}</h1>
          <p className="text-sm text-muted">{c.data.location.name}</p>
        </div>
        <Link to="golden-hour" className="rounded-lg border border-bad/50 bg-bad/10 px-4 py-2 text-sm">
          Severity <Status value={sev.data.level} /> · {sev.data.label}
        </Link>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {stats.map(([k, v]) => (
          <Panel key={k as string}><div className="text-3xl font-bold">{v}</div><div className="text-xs text-muted">{k}</div></Panel>
        ))}
      </div>
      {score && (
        <Panel title="Accuracy vs planted ground truth">
          <div className="flex items-baseline gap-6">
            <div><span className="text-3xl font-bold text-ok">{score.caught}/{score.planted}</span> <span className="text-sm text-muted">planted contradictions caught</span></div>
            <div><span className="text-3xl font-bold">{score.false_flags}</span> <span className="text-sm text-muted">false flags</span></div>
            <div><span className="text-3xl font-bold">{score.extra_found.length}</span> <span className="text-sm text-muted">extra (witness vs witness)</span></div>
          </div>
        </Panel>
      )}
      <Panel title="Evidence">
        <ul className="divide-y divide-line text-sm">
          {c.data.evidence.map((e: any) => (
            <li key={e.id} className="flex justify-between py-2"><span>{e.label}</span><span className="mono text-xs text-muted">{e.file}</span></li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
