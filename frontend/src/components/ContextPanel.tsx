import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { get } from "../lib/api";
import { Panel } from "./ui";

// Weather, sun and mapped speed limit for the crash's time and place. Each stays empty until it has a real source.
export default function ContextPanel() {
  const { id } = useParams();
  const [c, setC] = useState<any>(null);
  const [form, setForm] = useState({ lat: "", lon: "", time_utc: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get<any>(`/cases/${id}/context`).then(setC).catch((e) => setError(String(e))); }, [id]);

  async function save() {
    setSaving(true); setError(null);
    try {
      const r = await fetch(`/api/cases/${id}/location`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: +form.lat, lon: +form.lon, time_utc: form.time_utc ? new Date(form.time_utc).toISOString() : null }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setC(await r.json());
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  if (!c) return error ? <Panel title="Time and place"><p className="text-sm text-muted">Couldn't load this: {error}</p></Panel> : null;
  const rows: [string, string][] = [];
  if (c.weather) rows.push(["Road", `${c.weather.road_state}, friction ${c.weather.mu} (${c.weather.provider})`]);
  if (c.sun) rows.push(["Sun", c.sun.note]);
  if (c.speed_limit) rows.push(["Limit", c.speed_limit.limit_kmh != null
    ? `${c.speed_limit.limit_kmh} km/h${c.speed_limit.exceeds != null ? ` · measured ${c.speed_limit.measured_kmh} km/h` : ""} · ${c.speed_limit.source}` : c.speed_limit.source]);
  return (
    <Panel title="Time and place">
      {rows.length > 0 && <dl className="mb-3 space-y-1 text-sm">{rows.map(([k, v]) => <div key={k} className="flex gap-3"><dt className="w-14 shrink-0 text-muted">{k}</dt><dd>{v}</dd></div>)}</dl>}
      {c.notes.map((n: string) => <p key={n} className="mb-2 text-xs text-muted">{n}</p>)}
      <div className="grid grid-cols-[1fr_1fr_1.5fr_auto] gap-2">
        <input aria-label="Latitude" placeholder="Latitude" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} className="rounded border border-line bg-panel-2 px-2 py-1.5 text-sm" />
        <input aria-label="Longitude" placeholder="Longitude" value={form.lon} onChange={(e) => setForm({ ...form, lon: e.target.value })} className="rounded border border-line bg-panel-2 px-2 py-1.5 text-sm" />
        <input aria-label="Time of crash" type="datetime-local" value={form.time_utc} onChange={(e) => setForm({ ...form, time_utc: e.target.value })} className="rounded border border-line bg-panel-2 px-2 py-1.5 text-sm" />
        <button disabled={saving || !form.lat || !form.lon} onClick={save} className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">{saving ? "Looking up…" : "Set"}</button>
      </div>
      {error && <p className="mt-2 text-xs text-bad">Couldn't save: {error}</p>}
    </Panel>
  );
}
