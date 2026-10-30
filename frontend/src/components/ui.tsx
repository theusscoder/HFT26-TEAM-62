import type { ReactNode } from "react";
import type { Kind } from "../lib/api";

export function Panel({ title, right, children, className = "" }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const KIND_STYLE: Record<Kind, string> = {
  OBSERVED: "text-observed border-observed/40 bg-observed/10",
  CLAIMED: "text-claimed border-claimed/40 bg-claimed/10",
  INFERRED: "text-inferred border-inferred/40 bg-inferred/10",
};
export function KindBadge({ kind }: { kind: Kind }) {
  return <span className={`mono rounded border px-1.5 py-0.5 text-[10px] ${KIND_STYLE[kind]}`}>{kind}</span>;
}

const STATUS: Record<string, string> = {
  supported: "text-ok", contradicted: "text-bad", inconclusive: "text-warn", untested: "text-muted",
  high: "text-bad", medium: "text-warn", low: "text-muted",
  L0: "text-muted", L1: "text-ok", L2: "text-warn", L3: "text-bad",
};
export function Status({ value }: { value: string }) {
  return <span className={`text-xs font-semibold uppercase ${STATUS[value] ?? "text-muted"}`}>{value}</span>;
}

export function Ref({ value }: { value: string }) {
  return value ? <span className="mono text-[11px] text-muted">{value}</span> : null;
}

export function Loading({ error }: { error?: string | null }) {
  if (error?.startsWith("404"))
    return (
      <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
        Not computed yet for this case. This view fills in when its pipeline stage runs
        <div className="mono mt-2 text-[11px]">{error.replace(/^404 /, "")}</div>
      </div>
    );
  return <div className="p-8 text-sm text-muted">{error ? `Could not load: ${error}. Is the API running on :8000?` : "Loading…"}</div>;
}
