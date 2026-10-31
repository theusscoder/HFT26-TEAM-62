import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import type { Kind } from "../lib/api";

export function Panel({ title, right, children, className = "", delay = 0 }: { title?: string; right?: ReactNode; children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay, ease: "easeOut" }}
      className={`border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </motion.section>
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

const LEVEL_STYLE: Record<string, string> = { L0: "border-line text-muted", L1: "border-ok/50 bg-ok/10 text-ok", L2: "border-warn/50 bg-warn/10 text-warn", L3: "border-bad/60 bg-bad/15 text-bad" };
export function LevelPill({ level, label }: { level?: string | null; label?: string | null }) {
  if (!level) return null;
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${LEVEL_STYLE[level] ?? "border-line text-muted"}`}>{level}{label ? ` · ${label}` : ""}</span>;
}

export function Ref({ value }: { value: string }) {
  return value ? <span className="mono text-[11px] text-muted">{value}</span> : null;
}

/** Counts up to its value when it appears or changes. */
export function CountUp({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now(), a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 700), e = 1 - (1 - k) ** 3;
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toFixed(decimals)}{suffix}</>;
}

export function Stat({ label, value, tone = "", hint, delay = 0, decimals = 0, suffix = "", to }: { label: string; value: number; tone?: string; hint?: string; delay?: number; decimals?: number; suffix?: string; to?: string }) {
  const body = (
    <>
      <div className={`text-4xl font-extrabold tracking-tighter ${tone}`}><CountUp value={value} decimals={decimals} suffix={suffix} /></div>
      <div className="mt-1 flex items-center justify-between gap-2 text-sm text-muted"><span>{label}</span>{to && <ArrowUpRight size={15} className="shrink-0 transition-colors group-hover:text-accent" />}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted/70">{hint}</div>}
    </>
  );
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay }}>
      {to ? <Link to={to} className="group block h-full border border-line bg-panel p-4 transition-colors hover:border-ink focus-visible:border-ink">{body}</Link>
        : <div className="h-full border border-line bg-panel p-4">{body}</div>}
    </motion.div>
  );
}

/** A bar that grows to its share when it appears. */
export function Meter({ value, tone = "bg-accent", delay = 0 }: { value: number; tone?: string; delay?: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
      <motion.div className={`h-full rounded-full ${tone}`} initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} transition={{ duration: 0.8, delay, ease: "easeOut" }} />
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  if (error?.startsWith("404") || error?.includes(" 404 "))
    return (
      <div className=" border border-dashed border-line p-10 text-center text-sm text-muted">
        Not computed yet for this case. This view fills in when its pipeline stage runs.
        <div className="mono mt-2 text-[11px]">{error.replace(/^(Error: )?404 /, "")}</div>
      </div>
    );
  if (error) return <div className=" border border-bad/40 bg-bad/10 p-6 text-sm">Couldn't load this: {error}. If it says 500 or 502, the API isn't running on port 8000. Run start.bat from the repo folder.</div>;
  return <div className="space-y-3 p-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse  bg-panel-2/70" />)}</div>;
}
