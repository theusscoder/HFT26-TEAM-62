import { Link, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useApi, type Analysis, type Event } from "../lib/api";
import { Loading, Panel, Stat, Status } from "../components/ui";
import ContextPanel from "../components/ContextPanel";
import CaseRecords from "../components/CaseRecords";
import KeyFindings, { type Finding } from "../components/Findings";

/* What happened, in a sentence built from the evidence, then the moments, the findings and how far to trust them. */
function storyOf(ev: Event[], an: any): string[] {
  const ent = an.entities ?? {}, name = (id?: string) => (ent.names?.[id ?? ""] ?? "the vehicle").replace(" (primary)", "");
  const prim = name(ent.primary);
  const inferred = (action: string) => ev.find((e) => e.kind === "INFERRED" && e.action === action && e.actor === ent.primary);
  const speed = inferred("speed"), brake = inferred("brake"), rest = ev.find((e) => e.kind === "INFERRED" && e.actor === ent.primary && (e.action === "stop" || e.action === "moving"));
  const out = [];
  if (speed) out.push(`${prim} was travelling at about ${String(speed.value).split("(")[0].trim()} before the impact.`);
  if (brake) out.push(`It was ${String(brake.value).split("(")[0].trim()}.`);
  if (rest) out.push(`It ${String(rest.value).split("(")[0].trim()}.`);
  const others = (ent.involved ?? []).map((i: string) => name(i));
  if (others.length) out.push(`${others.join(" and ")} ${others.length > 1 ? "were" : "was"} within reach of the impact.`);
  return out;
}

export default function Overview() {
  const { id } = useParams();
  const c = useApi<any>(`/cases/${id}/case`);
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<Analysis>(`/cases/${id}/analysis`);
  const sev = useApi<any>(`/cases/${id}/severity`);
  const metric = useApi<any>(`/cases/${id}/tracks_metric`);
  const vis = useApi<any>(`/cases/${id}/vision`);
  const wx = useApi<any[]>(`/cases/${id}/witness_extractions`);
  const scene = useApi<any>(`/cases/${id}/scene3d`);
  const ins = useApi<Finding[]>(`/cases/${id}/insights`);
  if (!c.data || !ev.data || !an.data || !sev.data) return <Loading error={c.error ?? ev.error ?? an.error ?? sev.error} />;
  const a: any = an.data;
  const score = a.score;
  const story = storyOf(ev.data, a);
  // what the other vehicle did comes first when it changed the situation (a vehicle cutting into the rider's lane)
  const cut = (ins.data ?? []).find((k) => k.title.endsWith("moved into the camera vehicle's lane"));
  const avoid = (ins.data ?? []).find((k) => k.kind === "counterfactual");
  const tail = avoid ? avoid.detail.split(": ").slice(-1)[0] : "";
  if (cut) story.unshift(`${cut.title} ${Math.abs(cut.t).toFixed(1)} s before impact. ${cut.detail}${tail ? " " + tail.charAt(0).toUpperCase() + tail.slice(1) : ""}`);
  const frames: any[] = vis.data?.frames ?? [];
  return (
    <div className="space-y-5">
      <Panel>
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">What happened</div>
        <div className="mt-2 max-w-4xl text-xl font-medium leading-relaxed">
          {story.length ? story.map((s, i) => <motion.span key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 + i * 0.25, duration: 0.5 }}>{s} </motion.span>) : c.data.title}
        </div>
        <p className="mt-2 text-xs text-muted">Built from measured events, not written by a model. Fault and intent aren't decided here.</p>
      </Panel>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Evidence sources" value={c.data.evidence.length} delay={0.05} />
        <Stat label="Events extracted" value={ev.data.length} delay={0.1} />
        <Stat label="Contradictions" value={a.contradictions.length} tone={a.contradictions.length ? "text-claimed" : ""} delay={0.15} />
        <Stat label="Evidence gaps" value={a.gaps.length} tone={a.gaps.length ? "text-warn" : ""} delay={0.2} />
      </div>

      {frames.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {frames.map((f, i) => (
            <motion.figure key={f.name} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15 + i * 0.08 }} className={`overflow-hidden  border ${f.name === "impact" ? "border-bad/60" : "border-line"}`}>
              <img src={`/api/cases/${id}/${f.file}`} alt={`Frame at T${f.t}`} className="aspect-video w-full object-cover" />
              <figcaption className="flex justify-between bg-panel px-2.5 py-1.5 text-[11px]"><span className={f.name === "impact" ? "font-semibold text-bad" : "text-muted"}>{f.name}</span><span className="mono text-muted">T{f.t >= 0 ? "+" : ""}{f.t.toFixed(1)} s</span></figcaption>
            </motion.figure>
          ))}
        </div>
      )}

      <CaseRecords />

      {ins.data && ins.data.length > 0 && (
        <Panel title="Key findings" right={<Link to="reconstruction" className="text-xs text-accent">see them on the reconstruction →</Link>}>
          <KeyFindings findings={ins.data} compact />
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Top findings" right={<Link to="courtroom" className="flex items-center gap-1 text-xs text-accent">All contradictions <ArrowRight size={12} /></Link>}>
          {a.contradictions.length === 0 && <p className="text-sm text-muted">No contradictions. Either every checkable claim agrees with the physical evidence, or there is only one source so far.</p>}
          <ul className="space-y-2.5">
            {a.contradictions.slice(0, 4).map((x: any, i: number) => (
              <motion.li key={x.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 + i * 0.07 }} className="flex items-start justify-between gap-3 text-sm">
                <span>{x.summary}</span><Status value={x.severity} />
              </motion.li>
            ))}
          </ul>
        </Panel>
        <Panel title="How much to trust this case">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted">Positions and speeds</dt><dd className="text-right">{metric.data ? `±${Math.round(metric.data.scale_sigma * 100)}%, ${metric.data.auto ? "auto-calibrated" : "from measured road points"}` : "not calibrated"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">3D against footage</dt><dd className="text-right">{scene.data?.fit?.iou_all != null ? `${Math.round(scene.data.fit.iou_all * 100)}% overlap` : "not built"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Impact time</dt><dd className="text-right">{c.data.check?.label_impact_video_s != null ? `${Math.abs(c.data.t0_video_s - c.data.check.label_impact_video_s).toFixed(2)} s from the benchmark's label` : `from ${c.data.t0_anchor ?? "?"}`}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Witness claims</dt><dd className="text-right">{wx.data?.length ? [...new Set(wx.data.map((w: any) => w.method.split(" · ")[0].split(":").pop()!.replace(" (cached)", "")))].join(", ") : "no statements"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Vision model</dt><dd className="text-right">{vis.data?.method?.split(":").pop() ?? "not run"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Sensor clock</dt><dd className="text-right">{a.offsets?.sensor ? `aligned on the impact spike, ±${a.offsets.sensor.sigma} s` : "no telematics"}</dd></div>
          </dl>
          {score && <p className="mt-3 border-t border-line/70 pt-3 text-xs text-muted"><span className="font-semibold text-ok">{score.caught}/{score.planted}</span> planted errors caught, <span className="font-semibold text-ink">{score.false_flags}</span> false flags. The statements were written to test the system, so this shows it working on this case, not its accuracy in general.</p>}
        </Panel>
      </div>

      <ContextPanel />

      <Panel title="Evidence">
        <ul className="divide-y divide-line/60 text-sm">
          {c.data.evidence.map((e: any) => (
            <li key={e.id} className="flex justify-between gap-3 py-2"><span>{e.label}</span><span className="mono text-xs text-muted">{e.file}</span></li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
