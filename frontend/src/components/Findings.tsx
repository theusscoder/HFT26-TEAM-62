import { useClock } from "../lib/clock";

/* OWNER: P4. Key findings (backend/app/insights.py): numbers the video alone does not give you, each tied to a moment.
   KeyFindings = the clickable list; activeFindings = the ones to pop up on a map at the current playhead. */

export interface Finding { id: string; t: number; kind: string; title: string; detail: string; actor?: string | null; xy?: number[] | null; evidence: string[]; importance: number }

const KIND: Record<string, string> = { moment: "text-accent", measure: "text-ok", counterfactual: "text-inferred", visibility: "text-claimed", warning: "text-bad" };
const ICON: Record<string, string> = { moment: "◆", measure: "▲", counterfactual: "↺", visibility: "◉", warning: "!" };

export const activeFindings = (all: Finding[] | null | undefined, t: number, win = 0.7) =>
  (all ?? []).filter((k) => k.xy && Math.abs(t - k.t) <= win && k.importance >= 2);

export default function KeyFindings({ findings, compact }: { findings: Finding[]; compact?: boolean }) {
  const { t, seek } = useClock();
  const list = compact ? [...findings].sort((a, b) => b.importance - a.importance).slice(0, 5).sort((a, b) => a.t - b.t) : findings;
  return (
    <ol className="space-y-2">
      {list.map((k) => {
        const near = Math.abs(t - k.t) <= 0.7;
        return (
          <li key={k.id}>
            <button onClick={() => seek(k.t)} className={`w-full rounded-lg border p-2.5 text-left transition ${near ? "border-accent bg-accent/10" : "border-line bg-panel-2 hover:border-accent/50"}`}>
              <div className="flex items-baseline gap-2">
                <span className={`text-xs ${KIND[k.kind] ?? "text-muted"}`}>{ICON[k.kind] ?? "•"}</span>
                <span className="text-sm font-semibold leading-snug">{k.title}</span>
                <span className="mono ml-auto shrink-0 text-[10px] text-muted">T{k.t >= 0 ? "+" : ""}{k.t.toFixed(1)}s</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{k.detail}</p>
            </button>
          </li>
        );
      })}
      {!list.length && <li className="text-sm text-muted">No findings computed for this case yet.</li>}
    </ol>
  );
}
