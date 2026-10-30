import { useState } from "react";
import { post } from "../lib/api";
import { Panel, Status } from "./ui";

// Red team: type a fake statement and the same rules test it, live. Nothing it does changes the case.
export default function Challenge({ caseId }: { caseId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await post(`/cases/${caseId}/redteam`, { text }));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  return (
    <Panel title="Red team">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Statement to test"
        placeholder="Type a statement to test, such as: The bus was doing 90 and it stopped in time."
        className="w-full rounded-lg border border-line bg-panel-2 p-3 text-sm outline-none focus:border-accent" />
      <button disabled={busy || !text.trim()} onClick={submit} className="mt-2 w-full rounded-lg bg-accent py-2 text-sm font-semibold text-white disabled:opacity-40">
        {busy ? "Checking…" : "Test against the evidence"}
      </button>
      {error && <p className="mt-3 text-sm text-bad">Couldn't complete that: {error}</p>}
      {result && (
        <div className="mt-4 space-y-3 text-sm">
          <div className={`font-semibold ${result.status === "flagged" ? "text-bad" : "text-muted"}`}>
            {result.status === "flagged" ? "Flagged" : result.status === "not_checked" ? "Not checked" : "No conflict found"}
          </div>
          <p>{result.reason}</p>
          {result.contradictions?.slice(1).map((c: any) => <p key={c.id} className="border-t border-line pt-2">{c.summary}</p>)}
          {result.claims?.length > 0 && (
            <ul className="space-y-1 border-t border-line pt-2 text-xs text-muted">
              {result.claims.map((c: any) => (
                <li key={c.id} className="flex justify-between gap-2"><span>“{c.quote}”</span><Status value={c.status === "contradicted" ? "contradicted" : c.status === "consistent" ? "supported" : "untested"} /></li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted">Nothing here changes the case. A statement with no conflict isn't shown to be true.</p>
        </div>
      )}
    </Panel>
  );
}
