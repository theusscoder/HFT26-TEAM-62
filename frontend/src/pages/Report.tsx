import { useState } from "react";
import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { CheckCircle2, FileText, ShieldAlert, ShieldCheck } from "lucide-react";
import { useApi, type Event } from "../lib/api";
import { KindBadge, Loading, Panel, Ref } from "../components/ui";

/* Draft documents for an officer, the custody chain with every file re-hashed, and every finding with its evidence.
   Wording rule: "consistent with" / "not supported by"; never fault or blame. */
export default function Report() {
  const { id } = useParams();
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const cu = useApi<any>(`/cases/${id}/custody`);
  const files = useApi<any>(`/cases/${id}/custody/files`);
  const an = useApi<any>(`/cases/${id}/analysis`);
  const [doc, setDoc] = useState<"dar" | "packet" | null>(null);
  const [all, setAll] = useState(false);
  if (!ev.data || !cu.data) return <Loading error={ev.error ?? cu.error} />;
  const names = an.data?.entities?.names ?? {};
  const score = an.data?.score;
  const intact = cu.data.verify.ok && files.data?.ok !== false;
  const shown = all ? ev.data : ev.data.filter((e) => e.source !== "cctv" || e.kind !== "OBSERVED" || e.confidence >= 0.7).slice(0, 25);
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        {([["dar", "Detailed Accident Report", "Time and place, evidence hashes, undisputed sequence, statements, contradictions, gaps and severity."], ["packet", "Evidence packet", "For authorised follow-up: candidate plates, toll trail, timeline and hashes. It identifies no one."]] as const).map(([k, label, text], i) => (
          <motion.button key={k} onClick={() => setDoc(doc === k ? null : k)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }} whileHover={{ y: -2 }}
            className={` border p-4 text-left transition-colors ${doc === k ? "border-accent/60 bg-accent/10" : "border-line bg-panel hover:border-accent/40"}`}>
            <div className="flex items-center gap-2 font-semibold"><FileText size={16} className="text-accent" />{label}</div>
            <p className="mt-1 text-sm text-muted">{text}</p>
            <p className="mt-2 text-[11px] text-warn">Draft for an officer to verify</p>
          </motion.button>
        ))}
      </div>
      {doc && (
        <Panel title={doc === "dar" ? "Detailed Accident Report" : "Evidence packet"} right={<a href={`/api/cases/${id}/reports/${doc}.html`} target="_blank" rel="noreferrer" className="text-xs text-accent underline">Open to print or save as PDF</a>}>
          <iframe title={doc} sandbox="" src={`/api/cases/${id}/reports/${doc}.html`} className="h-[640px] w-full rounded-lg bg-white" />
        </Panel>
      )}
      {score && (
        <Panel title="How this was tested">
          <p className="flex items-center gap-2 text-sm"><CheckCircle2 size={16} className="text-ok" /><span><b>{score.caught} of {score.planted}</b> planted contradictions caught, <b>{score.false_flags}</b> false flags.</span></p>
          <p className="mt-1 text-xs text-muted">The witness statements were written to test the system, so this shows it working on this case. It isn't a measure of accuracy in general.</p>
        </Panel>
      )}
      <Panel title="Custody chain" right={<span className={`flex items-center gap-1 text-xs font-semibold ${intact ? "text-ok" : "text-bad"}`}>{intact ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}{!cu.data.verify.ok ? `broken at ${cu.data.verify.broken_at}` : files.data?.ok === false ? "a file has changed" : "verified"}</span>}>
        {files.data && (
          <ul className="mb-3 space-y-1.5 text-xs">
            {files.data.files.map((f: any, i: number) => (
              <motion.li key={f.file} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.05 }} className="flex flex-wrap justify-between gap-3"><span className="flex items-center gap-1.5">{f.ok ? <ShieldCheck size={12} className="text-ok" /> : <ShieldAlert size={12} className="text-bad" />}{f.file}</span>
                <span className={`mono ${f.ok ? "text-muted" : "text-bad"}`}>{f.ok ? `${f.recorded.slice(0, 16)}… matches${f.versions > 1 ? ` · ${f.versions} versions in the ledger` : ""}` : "does not match its recorded hash"}</span></motion.li>
            ))}
          </ul>
        )}
        <details className="text-xs"><summary className="cursor-pointer text-muted hover:text-ink">Ledger entries ({cu.data.entries.length})</summary>
          <ul className="mono mt-2 space-y-1 text-[11px] text-muted">
            {cu.data.entries.map((e: any) => <li key={e.seq} className="break-all">#{e.seq} {e.time.slice(0, 19)} {e.action} {JSON.stringify(e.details)}</li>)}
          </ul>
        </details>
      </Panel>
      <Panel title="Findings with evidence" right={<button onClick={() => setAll(!all)} className="text-xs text-accent">{all ? "Key findings" : `All ${ev.data.length} events`}</button>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line/60">
              {shown.map((e) => (
                <tr key={e.id}>
                  <td className="mono whitespace-nowrap py-2 pr-3 text-xs">T{e.t.start >= 0 ? "+" : ""}{e.t.start.toFixed(1)} s</td>
                  <td className="pr-3"><KindBadge kind={e.kind} /></td>
                  <td className="pr-3">{e.quote ? <span className="italic text-claimed">“{e.quote}”</span> : `${(names[e.actor] ?? e.actor).replace(" (primary)", "")}: ${e.action.replace(/_/g, " ")}${e.value ? `, ${e.value}` : ""}`}</td>
                  <td className="text-right"><Ref value={e.ref || (e.derived_from.length ? `from ${e.derived_from.slice(0, 2).join(", ")}` : "")} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
