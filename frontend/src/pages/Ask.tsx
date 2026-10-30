import { useState } from "react";
import { useParams } from "react-router-dom";
import { post } from "../lib/api";
import { Panel } from "../components/ui";

/* OWNER: P3. N7: ask the case. Answers come only from stored evidence; every sentence cites its items; questions
   about fault, blame or liability are refused with a reason. */

const SUGGEST = ["How fast was the primary vehicle going?", "Did it brake before the impact?", "Which witness statements are contradicted?",
  "What is not covered by any evidence?", "Who is at fault?"];

export default function Ask() {
  const { id } = useParams();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ q: string; r: any }[]>([]);

  async function ask(question: string) {
    if (!question.trim()) return;
    setBusy(true);
    try {
      const r = await post<any>(`/cases/${id}/ask`, { question });
      setLog((l) => [{ q: question, r }, ...l]);
      setQ("");
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Panel title="Ask the case">
        <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. How fast was the bus going?" className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm" />
          <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "…" : "Ask"}</button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGEST.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-ink">{s}</button>)}
        </div>
        <p className="mt-3 text-[11px] text-muted">Answers use only this case's evidence and cite it. The tool describes what the evidence shows; it does not decide fault.</p>
      </Panel>
      {log.map(({ q, r }, i) => (
        <Panel key={i} title={q} right={<span className="mono text-[10px] text-muted">{r.method}</span>}>
          {r.refused && <div className="mb-2 inline-block rounded bg-warn/15 px-2 py-0.5 text-xs font-semibold text-warn">declined: outside what evidence can establish</div>}
          <ul className="space-y-2">
            {r.answer.map((s: any, k: number) => (
              <li key={k} className="text-sm">
                {s.text}{" "}
                {s.cites?.map((c: string) => <span key={c} title={r.evidence?.find((e: any) => e.id === c)?.text} className="mono ml-1 rounded bg-accent/15 px-1 text-[10px] text-accent">{c}</span>)}
              </li>
            ))}
          </ul>
          {r.suggestions && <div className="mt-3 flex flex-wrap gap-2">{r.suggestions.map((s: string) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-ink">{s}</button>)}</div>}
        </Panel>
      ))}
    </div>
  );
}
