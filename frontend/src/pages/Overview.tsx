import { Link, useParams } from "react-router-dom";
import KeyFindings, { type Finding } from "../components/Findings";
import { useApi, type Analysis, type Event } from "../lib/api";
import { Loading, Panel, Status } from "../components/ui";

// OWNER: P3. Case overview: severity, counts, evidence inventory, act shortcuts.
export default function Overview() {
  const { id } = useParams();
  const c = useApi<any>(`/cases/${id}/case`);
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis>(`/cases/${id}/analysis`);
  const sev = useApi<any>(`/cases/${id}/severity`);
  const metric = useApi<any>(`/cases/${id}/tracks_metric`);
  const vis = useApi<any>(`/cases/${id}/vision`);
  const wx = useApi<any[]>(`/cases/${id}/witness_extractions`);
  const ins = useApi<Finding[]>(`/cases/${id}/insights`);
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
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
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
      {ins.data && ins.data.length > 0 && (
        <Panel title="Key findings" right={<Link to="reconstruction" className="text-xs text-accent">see them on the reconstruction →</Link>}>
          <KeyFindings findings={ins.data} compact />
        </Panel>
      )}
      <Panel title="How much to trust this case">
        <div className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm md:grid-cols-2">
          <div><span className="text-muted">Positions & speeds · </span>{metric.data ? `±${Math.round(metric.data.scale_sigma * 100)}% (${metric.data.auto ? "auto-calibrated from object sizes" : "calibrated from measured road points"})` : "not calibrated"}</div>
          <div><span className="text-muted">Impact time · </span>T0 from {c.data.t0_anchor ?? "?"}{c.data.check?.label_impact_video_s != null ? ` · benchmark label differs by ${Math.abs(c.data.t0_video_s - c.data.check.label_impact_video_s).toFixed(2)} s` : ""}</div>
          <div><span className="text-muted">Witness claims · </span>{wx.data?.length ? [...new Set(wx.data.map((w: any) => w.method.split(" · ")[0]))].join(", ") : "no statements"}</div>
          <div><span className="text-muted">Vision model · </span>{vis.data?.method ?? "not run"}</div>
          <div><span className="text-muted">Sensor clock · </span>{(an.data as any).offsets?.sensor ? `aligned on impact spike (±${(an.data as any).offsets.sensor.sigma} s)` : "no telematics"}</div>
          <div><span className="text-muted">Evidence gaps · </span>{an.data.gaps.length ? an.data.gaps.map((g) => `T${g.start.toFixed(1)}→T${g.end.toFixed(1)}s`).join(", ") : "none found"}</div>
        </div>
        <p className="mt-3 text-[11px] text-muted">Every contradiction states what would have to be wrong for it to flip. This tool reports what the evidence is consistent with; it does not establish fault, intent or liability.</p>
      </Panel>
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
