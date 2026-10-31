import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { get } from "../lib/api";
import { Panel } from "./ui";

// Time, place, weather, sun and mapped speed limit, all logged from the evidence. Each stays empty until it has a real source.
export default function ContextPanel() {
  const { id } = useParams();
  const [c, setC] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get<any>(`/cases/${id}/context`).then(setC).catch((e) => setError(String(e))); }, [id]);

  if (!c) return error ? <Panel title="Time and place"><p className="text-sm text-muted">Couldn't load this: {error}</p></Panel> : null;
  const rows: [string, string][] = [];
  const l = c.location;
  if (l?.lat != null) rows.push(["Place", `${l.name} · ${(+l.lat).toFixed(4)}, ${(+l.lon).toFixed(4)}${l.source ? ` · ${l.estimated ? "estimated" : "auto-logged"}: ${l.source}` : ""}`]);
  if (c.incident_time_utc) rows.push(["Time", `${new Date(c.incident_time_utc).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}${c.incident_time_source ? ` · from ${c.incident_time_source}` : ""}`]);
  if (c.weather) rows.push(["Road", `${c.weather.road_state}, friction ${c.weather.mu} (${c.weather.provider})`]);
  if (c.sun) rows.push(["Sun", c.sun.note]);
  if (c.speed_limit) rows.push(["Limit", c.speed_limit.limit_kmh != null
    ? `${c.speed_limit.limit_kmh} km/h${c.speed_limit.exceeds != null ? ` · measured ${c.speed_limit.measured_kmh} km/h` : ""} · ${c.speed_limit.source}` : c.speed_limit.source]);
  return (
    <Panel title="Time and place">
      {rows.length > 0 && <dl className="mb-3 space-y-1 text-sm">{rows.map(([k, v]) => <div key={k} className="flex gap-3"><dt className="w-14 shrink-0 text-muted">{k}</dt><dd>{v}</dd></div>)}</dl>}
      {c.notes.map((n: string) => <p key={n} className="mb-2 text-xs text-muted">{n}</p>)}
    </Panel>
  );
}
