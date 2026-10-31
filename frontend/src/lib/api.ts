import { useEffect, useState } from "react";

// Mirrors backend/app/schema.py. Times are seconds relative to T0 = impact.
export type Kind = "OBSERVED" | "CLAIMED" | "INFERRED";
export interface Event {
  id: string; source: string; kind: Kind;
  t: { start: number; end: number; sigma: number };
  actor: string; action: string; value?: string | null; xy?: number[] | null;
  confidence: number; ref: string; quote?: string | null; derived_from: string[]; rule?: string | null;
  translation?: string | null; reliability_weight?: number; reliability_reasons?: string[];
}
export interface Contradiction {
  id: string; type: string; events: string[]; summary: string; explanation?: string | null; severity: string;
}
export interface Analysis {
  contradictions: Contradiction[];
  gaps: { start: number; end: number; covered_by: string[]; note: string }[];
  reliability: Record<string, number>;
  hypotheses: { id: string; text: string; status: string; for: string[]; against: string[]; untested: string[] }[];
  counterfactual: { actor: string; observed_speed_kmh: number; hazard_at_m: number; brake_start_s: number; note: string };
  offsets: Record<string, { offset_s: number | null; sigma?: number; note?: string }>;
  reliability_detail?: Record<string, { evidence_score: number | null; weight: number; reasons: string[] }>;
  stn?: { consistent: boolean; windows: Record<string, [number | null, number | null]>; excluded: string[]; constraints: { id: string; quote?: string }[] };
  sensitivity?: { earlier: string; later: string; margin_s: number; clock: string; sensitive: boolean; text: string }[];
}
export interface Track { id: string; class: string; colour: string; points: { t: number; x: number; y: number }[] }

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

/** Like useApi, refetched every `ms` so new data streams in (new cases on the map, agent progress). */
export function usePoll<T>(path: string | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () => get<T>(path).then((d) => live && setData(d)).catch((e) => live && setError(String(e)));
    load();
    const h = setInterval(load, ms);
    return () => { live = false; clearInterval(h); };
  }, [path, ms]);
  return { data, error };
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    get<T>(path).then((d) => live && setData(d)).catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [path]);
  return { data, error };
}
