import type { Analysis, Event } from "./api";

/* Turns raw pipeline events into what a person reads: named actors, plain sentences, phases and salience.
   Used by the Timeline (story + swimlanes), Evidence replay and Reconstruction panels. */

export type Entities = { primary?: string | null; involved?: string[]; names?: Record<string, string>; impact_xy?: number[] | null };

export function nameOf(id: string, ent?: Entities): string {
  if (ent?.names?.[id]) return ent.names[id];
  if (id === "fusion" || id === "cctv") return id.toUpperCase();
  return id.replace(/_\d+$/, "").replace("_", " ");
}

const VERB: Record<string, string> = {
  enter: "comes into view", exit: "leaves the view", moving: "is moving", stop: "comes to a stop", sudden_decel: "slows sharply",
  swerve: "swerves", possible_contact: "comes into contact", person_down: "appears to be on the ground", speed: "speed", brake: "brakes",
  impact: "impact", airbag: "airbag deploys", no_brake: "did not slow down", cut_in: "cut in", turn: "turns", fell: "fell",
  signal: "signal", time_of_day: "time of day", presence: "was present", posture: "posture",
};

export function sentence(e: Event, ent?: Entities): string {
  const who = e.actor.startsWith("group:") ? e.actor.slice(6) + "s" : e.actor === "witness" ? "the witness" : nameOf(e.actor, ent);
  const v = e.value ? String(e.value).replace(/(car|bus|truck|motorcycle|bicycle|person)_\d+/g, (m) => nameOf(m, ent)) : "";
  switch (e.action) {
    case "speed": return `${who}: ${v}`;
    case "brake": return `${who} brakes${v ? ` (${v})` : ""}`;
    case "impact": return e.source === "sensor" ? `Impact spike in telematics (${v})` : e.source === "dataset_label" ? "Impact (benchmark annotation)" : `${who}: impact${v ? ` · ${v}` : ""}`;
    case "possible_contact": return `${who} comes into contact ${v.replace(/\(.*\)/, "")}`.trim();
    case "time_of_day": return `Clock: ${v}`;
    case "signal": return `Signal ${v}`;
    case "moving": return `${who} is moving`;
    default: return `${who} ${VERB[e.action] ?? e.action.replace("_", " ")}${v && !["moving"].includes(e.action) ? ` · ${v}` : ""}`;
  }
}

export const SOURCE_LABEL = (s: string, wit?: Record<string, any>) =>
  s === "cctv" ? "CCTV" : s === "sensor" ? "Telematics" : s === "fusion" ? "Reasoning" : s === "dataset_label" ? "Benchmark label"
    : wit?.[s]?.name ?? s.replace("_", " ").replace(/^\w/, (c) => c.toUpperCase());

/** Phase of an event; a witness remark with no moment attached (very wide window) reads as background. */
export function phaseOf(e: { kind: string; t: { start: number; end: number } }) {
  if (e.kind === "CLAIMED" && e.t.end - e.t.start > 8) return "approach";
  return phase(e.kind === "CLAIMED" ? (e.t.start + e.t.end) / 2 : e.t.start);
}

export function phase(t: number) {
  return t < -1.0 ? "approach" : t <= 0.6 ? "critical" : "aftermath";
}

/** Is this event worth showing a human by default? (raw detector chatter on background objects is not) */
export function salient(e: Event, ent?: Entities): boolean {
  if (e.source === "dataset_label") return false;
  if (e.source !== "cctv") return true;            // telematics, witnesses and reasoning are always shown
  const key = new Set([ent?.primary, ...(ent?.involved ?? [])].filter(Boolean) as string[]);
  return key.has(e.actor) && e.confidence >= 0.45 && e.action !== "moving";
}

export function claimStatus(e: Event, an?: Analysis & { checks?: { claim: string; status: string }[] }) {
  return an?.checks?.find((c) => c.claim === e.id)?.status;
}

export function contradictionsFor(id: string, an?: Analysis) {
  return (an?.contradictions ?? []).filter((c) => c.events.includes(id));
}
