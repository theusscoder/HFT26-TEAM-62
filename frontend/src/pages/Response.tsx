import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Circle, CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { motion } from "framer-motion";
import { get, post } from "../lib/api";
import { Loading, Panel, Status } from "../components/ui";

/* A2 + A3 · Response & alerts.
   Every vehicle's plate → TS police DB (mock) → victim / suspect dossiers → suspect's toll trail →
   nearest hospitals and police → officer approves → alerts sent → suspect's number linked in the TS police DB.
   Hospitals get the medical picture only; police get the suspect dossier. A suspect is a lead, not a finding. */

const ROLE_STYLE: Record<string, string> = {
  suspect: "border-bad/50 bg-bad/10 text-bad",
  victim: "border-warn/50 bg-warn/10 text-warn",
  bystander: "border-line text-muted",
  hospital: "border-ok/50 bg-ok/10 text-ok",
  police: "border-accent/50 bg-accent/10 text-accent",
};
const ROLE_ICON: Record<string, string> = { hospital: "🚑", police: "🚓", victim: "🚨", suspect: "⚠️" };

function RoleBadge({ role }: { role: string }) {
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${ROLE_STYLE[role] ?? ROLE_STYLE.bystander}`}>{role}</span>;
}

function Field({ k, v, warn }: { k: string; v: any; warn?: boolean }) {
  if (v == null || v === "") return null;
  return (<><dt className="text-muted">{k}</dt><dd className={warn ? "text-bad" : ""}>{String(v)}</dd></>);
}

function StatusTick({ s }: { s?: string }) {
  if (!s) return <span className="text-[11px] text-muted">not sent</span>;
  const c = s === "sent" ? "text-ok" : s === "simulated" ? "text-warn" : "text-bad";
  return <span className={`text-[11px] font-semibold ${c}`}>{s === "sent" ? "✓ delivered" : s === "simulated" ? "◌ simulated" : "✗ " + s}</span>;
}

function Record({ p }: { p: any }) {
  const r = p.record;
  if (!r) return <p className="text-sm text-muted">{p.note ?? "Not found in the TS police DB (mock)."}</p>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1 text-sm">
        <Field k="Registered owner" v={`${r.owner.name}${r.owner.type === "company" ? " (company)" : ""}`} />
        <Field k="Driver on record" v={r.owner.driver_on_record} />
        <Field k="Registered phone" v={r.owner.phone} />
        <Field k="Address" v={r.owner.address} />
        <Field k="Driving licence" v={`${r.owner.dl_number} · valid till ${r.owner.dl_valid_till}`} warn={r.owner.dl_valid_till < today} />
        <Field k="Vehicle" v={`${r.colour} ${r.make_model} · ${r.class} · ${r.fuel}`} />
        <Field k="Registration" v={`${r.registration.date} · ${r.registration.rto} · chassis ${r.registration.chassis}`} />
        <Field k="Insurance" v={`${r.insurance.status} · ${r.insurance.insurer} · till ${r.insurance.valid_till}`} warn={r.insurance.status !== "Valid"} />
        <Field k="PUC" v={`valid till ${r.puc_valid_till}`} warn={r.puc_valid_till < today} />
        <Field k="FASTag" v={r.fastag_id ?? "none (two-wheeler)"} />
        <Field k="Emergency contact" v={`${r.emergency_contact.name} (${r.emergency_contact.relation}) · ${r.emergency_contact.phone}`} />
      </dl>
      {r.challans.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">Challans</div>
          <table className="w-full text-xs">
            <tbody className="divide-y divide-line">
              {r.challans.map((c: any, i: number) => (
                <tr key={i}><td className="mono py-1 pr-2 text-muted">{c.date}</td><td className="pr-2">{c.offence}</td>
                  <td className="mono pr-2">₹{c.amount_inr}</td><td className={c.status === "unpaid" ? "text-bad" : "text-ok"}>{c.status}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.accident_history.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">Earlier accident records</div>
          {r.accident_history.map((a: any, i: number) => <div key={i} className="text-xs">{a.date} · {a.fir} · {a.summary}</div>)}
        </div>
      )}
      {p.same_owner?.length > 0 && (
        <div className="text-xs"><span className="text-muted">Other vehicles of this owner: </span>
          {p.same_owner.map((o: any) => <span key={o.plate} className="mono mr-2">{o.plate} ({o.colour} {o.make_model})</span>)}</div>
      )}
    </div>
  );
}

function PartyCard({ p }: { p: any }) {
  return (
    <div className={`rounded-lg border p-4 ${p.role === "suspect" ? "border-bad/40" : "border-warn/40"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><RoleBadge role={p.role === "suspect" ? "suspect" : "victim"} />
            <span className="font-semibold">{p.name}</span><span className="text-xs text-muted">{p.type}</span></div>
          <p className="mt-1 text-[11px] text-muted">Role rule: {p.role_rule}</p>
        </div>
        {p.plate && (
          <div className="text-right">
            <div className="mono rounded border-2 border-ink/80 bg-ink px-2 py-0.5 text-lg font-bold tracking-widest text-bg">{p.resolved_plate ?? p.plate}</div>
            {p.resolved_plate && <div className="mono mt-1 text-[10px] text-ok">read {p.plate} → 1 DB match</div>}
            <div className="mt-1 text-[10px] text-muted">{p.plate_confidence > 0 ? `${Math.round(p.plate_confidence * 100)}% plate vote` : "demo-assigned plate"}</div>
          </div>
        )}
      </div>
      {p.risk_notes?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.risk_notes.map((n: string) => <span key={n} className="rounded border border-bad/40 bg-bad/10 px-1.5 py-0.5 text-[11px] text-bad">{n}</span>)}
        </div>
      )}
      <div className="mt-3"><Record p={p} /></div>
      {p.toll && <TollAnalysis t={p.toll} />}
    </div>
  );
}

function TollAnalysis({ t }: { t: any }) {
  const h = t.history, max = t.funnel[0]?.count || 1;
  const tod = Object.entries(h.time_of_day) as [string, number][];
  const todMax = Math.max(1, ...tod.map(([, v]) => v));
  return (
    <div className="mt-4 space-y-4 border-t border-line pt-4">
      <div className="text-[11px] uppercase tracking-wider text-muted">FASTag movement analysis · toll logs re-based to the incident time</div>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-muted">Last 30 days</div>
          <div className="mt-1"><b>{h.passages_30d}</b> passages on <b>{h.active_days}</b> days · {h.pattern}</div>
          {h.last_seen_before && <div className="mt-1 text-xs">Last seen before: {h.last_seen_before.plaza} · <span className="mono">{h.last_seen_before.time.replace("T", " ")}</span></div>}
          <ul className="mt-2 space-y-1 text-xs">
            {h.top_plazas.map((p: any) => <li key={p.plaza} className="flex justify-between"><span>{p.plaza}</span><span className="mono">{p.count}×</span></li>)}
          </ul>
        </div>
        <div>
          <div className="text-muted">Time of day</div>
          <div className="mt-2 flex h-16 items-end gap-2">
            {tod.map(([k, v]) => (
              <div key={k} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-accent/70" style={{ height: `${(v / todMax) * 100}%`, minHeight: 2 }} />
                <span className="mono text-[9px] text-muted">{k}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div className="text-muted text-sm">After the incident</div>
        {t.after.length === 0 ? <p className="text-xs text-muted">No FASTag passage in the 2 h after the incident.</p> : (
          <ol className="mt-2 space-y-1.5 text-xs">
            {t.after.map((a: any, i: number) => (
              <li key={i} className={`flex items-start gap-2 rounded border px-2 py-1.5 ${a.reachable ? "border-line" : "border-bad/50 bg-bad/10"}`}>
                <span className="mono w-14 shrink-0">{a.time.slice(11, 16)}</span>
                <span className="mono w-14 shrink-0 text-muted">+{a.minutes_after}m</span>
                <span className="flex-1"><b>{a.plaza}</b> · {a.direction} · {a.dist_km} km · ~{a.implied_kmh} km/h<br />
                  <span className={a.reachable ? "text-muted" : "text-bad"}>{a.reachable ? "✓ " : "⚠ "}{a.note}</span></span>
              </li>
            ))}
          </ol>
        )}
        {t.last_seen_after && <p className="mt-2 text-sm">Last plausible sighting: <b>{t.last_seen_after.plaza}</b> at <span className="mono">{t.last_seen_after.time.slice(11, 16)}</span></p>}
      </div>
      <div>
        <div className="text-muted text-sm">Toll-feed match funnel</div>
        {t.funnel.map((f: any, i: number) => (
          <div key={f.stage} className="mt-2">
            <div className="flex justify-between text-xs"><span>{f.stage}</span><span className="mono">{f.count}</span></div>
            <motion.div initial={{ width: 0 }} animate={{ width: `${Math.max(2, (f.count / max) * 100)}%` }} transition={{ delay: i * 0.4, duration: 0.5 }}
              className={`mt-1 h-1.5 rounded ${i === t.funnel.length - 1 ? "bg-bad" : "bg-accent"}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* Continuous tracking of the suspect vehicle (backend/app/tracking.py). Polls every 2 s. */
function LiveTracking({ id, hasSuspect, refresh }: { id: string; hasSuspect: boolean; refresh: number }) {
  const [t, setT] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [notifySuspect, setNotifySuspect] = useState(true);
  useEffect(() => {
    let live = true;
    const pull = () => get<any>(`/tracking/${id}`).then((r) => live && setT(r)).catch(() => {});
    pull();
    const h = setInterval(pull, 2000);
    return () => { live = false; clearInterval(h); };
  }, [id, refresh]);
  const call = (path: string, body: any) => { setBusy(true); post<any>(`/tracking/${id}/${path}`, body).then(setT).finally(() => setBusy(false)); };
  if (!t) return null;
  const sights: any[] = t.sightings ?? [];
  const ok = sights.filter((s) => s.reachable);
  const last = t.last_seen;
  const origin: [number, number] | null = t.origin ? [t.origin.lat, t.origin.lon] : null;
  return (
    <Panel title="Live tracking · suspect vehicle"
      right={<span className={`text-xs font-semibold ${t.active ? "text-bad" : "text-muted"}`}>{t.active ? "● LIVE" : t.plate ? "■ stopped" : "not started"}</span>}>
      {!t.plate ? (
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-muted">Tracking starts automatically when the police / suspect alerts are approved, or start it now.</span>
          <button disabled={!hasSuspect || busy} onClick={() => call("start", { speed: 10, notify_suspect: notifySuspect })}
            className="rounded-lg bg-bad px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Start tracking</button>
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_420px] gap-6">
          <div className="h-[420px] overflow-hidden rounded-lg">
            {origin && (
              <MapContainer center={last ? [last.lat, last.lon] : origin} zoom={10} className="h-full w-full">
                <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap" />
                <CircleMarker center={origin} radius={9} pathOptions={{ color: "#ff5d5d", fillOpacity: 0.8 }}><Tooltip permanent>Incident</Tooltip></CircleMarker>
                <Polyline positions={[origin, ...ok.map((s) => [s.lat, s.lon] as [number, number])]} pathOptions={{ color: "#f5b84f", weight: 3 }} />
                {sights.map((s, i) => (
                  <CircleMarker key={i} center={[s.lat, s.lon]} radius={s === last ? 9 : 6}
                    pathOptions={{ color: s.reachable ? "#f5b84f" : "#ff5d5d", dashArray: s.simulated ? "3 3" : undefined }}>
                    <Tooltip permanent={s === last}>#{i + 1} {s.plaza} · {s.time.slice(11, 16)}</Tooltip>
                  </CircleMarker>
                ))}
                {last && t.search_radius_km > 0 && (
                  <Circle center={[last.lat, last.lon]} radius={t.search_radius_km * 1000} pathOptions={{ color: "#ff5d5d", weight: 1, fillOpacity: 0.06, dashArray: "4 6" }} />
                )}
                {t.predicted.map((p: any) => (
                  <Polyline key={p.plaza} positions={[last ? [last.lat, last.lon] : origin, [p.lat, p.lon]]} pathOptions={{ color: "#8a93a0", dashArray: "2 6", weight: 1.5 }} />
                ))}
              </MapContainer>
            )}
          </div>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded border border-line p-2"><div className="text-[11px] text-muted">Plate</div><div className="mono font-bold">{t.plate}</div></div>
              <div className="rounded border border-line p-2"><div className="text-[11px] text-muted">Incident clock</div><div className="mono">{t.sim_clock.slice(11, 16)} <span className="text-[11px] text-muted">(+{t.sim_minutes} min)</span></div></div>
              <div className="rounded border border-line p-2"><div className="text-[11px] text-muted">Last seen</div><div>{last ? `${last.plaza} · ${last.time.slice(11, 16)}` : "awaiting first sighting"}</div></div>
              <div className="rounded border border-line p-2"><div className="text-[11px] text-muted">Search radius now</div><div className="mono">{t.search_radius_km} km <span className="text-[11px] text-muted">({t.minutes_since_last} min since)</span></div></div>
            </div>
            <div className="text-xs text-muted">Feed: {t.feed} · {t.alerts_sent} tracking alerts sent{t.next_due_in_real_s != null ? ` · next sighting in ~${t.next_due_in_real_s}s` : ""}</div>
            {t.predicted.length > 0 && <div className="text-xs">Next likely: {t.predicted.map((p: any) => `${p.plaza} (${p.eta_min[0]}–${p.eta_min[1]} min)`).join(" · ")}</div>}
            <ol className="max-h-48 space-y-1 overflow-auto text-xs">
              {[...sights].reverse().map((s, i) => (
                <li key={i} className={`rounded border px-2 py-1 ${s.reachable ? "border-line" : "border-bad/50 bg-bad/10"}`}>
                  <span className="mono">#{sights.length - i} {s.time.slice(11, 16)}</span> · <b>{s.plaza}</b> · ~{s.implied_kmh} km/h
                  {s.simulated && <span className="ml-1 text-[10px] text-muted">(simulated)</span>}
                  <div className="text-[11px] text-muted">{s.reachable ? "" : "⚠ possible cloned plate · "}🚓 {s.police_alert ?? "…"}{s.suspect_alert ? ` · 📱 suspect ${s.suspect_alert}` : ""}</div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
              <span className="text-muted">Replay speed</span>
              {[1, 10, 60].map((s) => (
                <button key={s} disabled={busy} onClick={() => call("speed", { speed: s })}
                  className={`rounded border px-2 py-0.5 ${t.speed === s ? "border-accent text-accent" : "border-line"}`}>{s}×</button>
              ))}
              <span className="flex-1" />
              {t.active
                ? <button disabled={busy} onClick={() => call("stop", { officer: "Duty officer" })} className="rounded border border-bad px-3 py-1 text-bad">Stop tracking</button>
                : <button disabled={busy} onClick={() => call("start", { notify_suspect: notifySuspect })} className="rounded bg-bad px-3 py-1 font-semibold text-white">Resume</button>}
            </div>
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <input type="checkbox" checked={notifySuspect} onChange={(e) => setNotifySuspect(e.target.checked)} />
              also text the suspect's registered number on each sighting (applies when tracking is started)
            </label>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function Response() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [officer, setOfficer] = useState("Duty officer");
  const [result, setResult] = useState<any>(null);
  const [loc, setLoc] = useState({ lat: "", lon: "", name: "" });
  const [tg, setTg] = useState<any>(null);
  const [tgTest, setTgTest] = useState<string | null>(null);

  const load = (fresh: any) => {
    setD(fresh);
    setSel(Object.fromEntries(fresh.notifications.plan.map((p: any) => [p.id, p.default_on])));
    const l = fresh.incident.location;
    setLoc({ lat: String(l.lat), lon: String(l.lon), name: l.name });
  };
  useEffect(() => { get<any>(`/response/${id}`).then(load).catch((e) => setError(String(e))); }, [id]);
  useEffect(() => { get<any>(`/telegram/status`).then(setTg).catch(() => setTg({ ok: false, detail: "status unavailable" })); }, []);
  const testTelegram = () => {
    setTgTest("sending…");
    post<any>(`/telegram/test`, {}).then((r) => setTgTest(r.status === "sent" ? "✓ test delivered" : `✗ ${r.status}`))
      .catch((e) => setTgTest(`✗ ${String(e)}`));
  };

  const act = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    try { const r = await fn(); load(r.response ?? r); if (r.results) setResult(r); }
    catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  };

  if (!d) return <Loading error={error} />;
  const inc = d.incident, sev = inc.severity;
  const center: [number, number] = [inc.location.lat, inc.location.lon];
  const trail = d.suspects.flatMap((s: any) => s.toll?.after ?? []);
  const chosen = Object.entries(sel).filter(([, v]) => v).map(([k]) => k);

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Response & alerts</h1>
          <p className="mt-1 text-sm text-muted">
            <Status value={sev.level ?? "L?"} /> {sev.label} · {sev.score}/100 · {inc.time.replace("T", " ")} <span className="text-[11px]">({inc.time_source})</span> · {inc.people_at_risk} people at risk
          </p>
          <p className={`mt-1 text-xs ${inc.location.assumed ? "text-warn" : "text-muted"}`}>📍 {inc.location.name} · {inc.location.source}</p>
        </div>
        <form className="flex items-end gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); act("loc", () => post(`/response/${id}/location`, { lat: +loc.lat, lon: +loc.lon, name: loc.name })); }}>
          <label className="flex flex-col gap-1 text-muted">Incident site
            <input value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} className="w-48 rounded border border-line bg-panel-2 px-2 py-1 text-ink" /></label>
          <input value={loc.lat} onChange={(e) => setLoc({ ...loc, lat: e.target.value })} className="mono w-24 rounded border border-line bg-panel-2 px-2 py-1" />
          <input value={loc.lon} onChange={(e) => setLoc({ ...loc, lon: e.target.value })} className="mono w-24 rounded border border-line bg-panel-2 px-2 py-1" />
          <button className="rounded border border-line px-3 py-1 hover:border-accent" disabled={!!busy}>{busy === "loc" ? "…" : "Set location"}</button>
        </form>
      </div>
      {error && <div className="rounded border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}

      {/* A2: every plate */}
      <Panel title="Number plates · every tracked vehicle"
        right={<div className="flex items-center gap-3 text-xs text-muted">
          <span>{d.plates.counts.vehicles} vehicles · {d.plates.counts.involved} involved · {d.plates.counts.registered} in TS DB · {d.plates.counts.legible} read by OCR</span>
          <button onClick={() => act("plates", () => post(`/response/${id}/plates/rerun`, {}))} className="rounded border border-line px-2 py-0.5 hover:border-accent" disabled={!!busy}>
            {busy === "plates" ? "reading…" : "Re-read plates"}</button></div>}>
        <div className="max-h-[340px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase tracking-wider text-muted">
              <tr><th className="py-1.5">Road user</th><th>Plate</th><th>How read</th><th>TS police DB</th><th>Role</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.plates.vehicles.map((v: any) => (
                <tr key={v.track} className={v.role === "suspect" ? "bg-bad/10" : v.role === "victim" ? "bg-warn/10" : ""}>
                  <td className="py-1.5 pr-3">{v.involved && <span className="mr-1 text-bad">●</span>}{v.name} <span className="mono text-[11px] text-muted">{v.track}</span></td>
                  <td className="pr-3"><span className={`mono rounded px-1.5 py-0.5 tracking-wider ${v.involved ? "bg-ink font-bold text-bg" : "border border-line"}`}>{v.plate}</span></td>
                  <td className="pr-3 text-[11px] text-muted">{v.confidence > 0 ? `${Math.round(v.confidence * 100)}% · ` : ""}{v.method}</td>
                  <td className="pr-3 text-xs">{v.db ? <>{v.db.owner} · {v.db.make_model}{v.db.flags ? <span className="ml-1 text-bad">· {v.db.flags} flag(s)</span> : null}</> : <span className="text-muted">{v.registered ? "partial plate: candidates in DB" : "not registered"}</span>}</td>
                  <td>
                    <select value={v.role} disabled={!!busy} onChange={(e) => act("role", () => post(`/response/${id}/role`, { track: v.track, role: e.target.value }))}
                      className={`rounded border bg-panel-2 px-1.5 py-0.5 text-xs ${ROLE_STYLE[v.role]}`}>
                      <option value="suspect">suspect</option><option value="victim">victim</option><option value="bystander">bystander</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted">{d.plates.note} Roles come from rules (striking / fleeing vehicle = suspect) and can be changed here; a suspect is a lead to verify, not a finding of fault.</p>
      </Panel>

      {/* victims and suspect */}
      <div className="grid grid-cols-2 gap-6">
        <Panel title={`Victims · ${d.victims.length}`}>
          <div className="space-y-4">{d.victims.length ? d.victims.map((p: any) => <PartyCard key={p.track} p={p} />) : <p className="text-sm text-muted">No victim identified.</p>}</div>
        </Panel>
        <Panel title={`Vehicles of interest · ${d.suspects.length}`}>
          <div className="space-y-4">{d.suspects.length ? d.suspects.map((p: any) => <PartyCard key={p.track} p={p} />) : <p className="text-sm text-muted">No suspect vehicle identified. Mark one in the plate table.</p>}</div>
        </Panel>
      </div>

      {/* map + alert plan */}
      <div className="grid grid-cols-[1fr_460px] gap-6">
        <Panel title="Responders and suspect trail" className="min-h-[560px]">
          <div className="h-[520px] overflow-hidden rounded-lg">
            <MapContainer key={center.join(",")} center={center} zoom={11} className="h-full w-full">
              <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap" />
              <CircleMarker center={center} radius={10} pathOptions={{ color: "#ff5d5d", fillOpacity: 0.8 }}><Tooltip permanent>Incident</Tooltip></CircleMarker>
              {d.facilities.hospitals.map((h: any) => (
                <Fragment key={h.id}>
                  <CircleMarker center={[h.lat, h.lon]} radius={7} pathOptions={{ color: "#3ecf8e" }}><Tooltip>🚑 {h.name} · {h.dist_km} km · {h.eta_min} min</Tooltip></CircleMarker>
                  <Polyline positions={[center, [h.lat, h.lon]]} pathOptions={{ color: "#3ecf8e", dashArray: "4 6", weight: 1.5 }} />
                </Fragment>
              ))}
              {d.facilities.police.map((p: any) => (
                <Fragment key={p.id}>
                  <CircleMarker center={[p.lat, p.lon]} radius={7} pathOptions={{ color: "#4f8cff" }}><Tooltip>🚓 {p.name} · {p.dist_km} km</Tooltip></CircleMarker>
                  <Polyline positions={[center, [p.lat, p.lon]]} pathOptions={{ color: "#4f8cff", dashArray: "4 6", weight: 1.5 }} />
                </Fragment>
              ))}
              <Polyline positions={[center, ...trail.filter((a: any) => a.reachable).map((a: any) => [a.lat, a.lon] as [number, number])]} pathOptions={{ color: "#f5b84f", weight: 3 }} />
              {trail.map((a: any, i: number) => (
                <CircleMarker key={i} center={[a.lat, a.lon]} radius={6} pathOptions={{ color: a.reachable ? "#f5b84f" : "#ff5d5d", dashArray: a.reachable ? undefined : "2 3" }}>
                  <Tooltip>{a.reachable ? "Suspect" : "⚠ implausible"} · {a.plaza} · {a.time.slice(11, 16)} (+{a.minutes_after} min)</Tooltip>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
          <p className="mt-2 text-[11px] text-muted">Green = hospitals (trauma-capable, at least one government), blue = police, amber = suspect's FASTag trail, red ring = physically implausible passage. Coordinates approximate.</p>
        </Panel>

        <Panel title="Alert plan · officer approval required"
          right={<span className="text-[11px] text-muted">{d.notifications.channels.telegram ? "Telegram ✓" : "Telegram ✗"} · {d.notifications.channels.ntfy ? "ntfy ✓" : "ntfy ✗"}</span>}>
          <div className={`mb-3 flex items-center justify-between gap-2 rounded border px-2.5 py-2 text-xs ${tg?.ok ? "border-ok/40 bg-ok/10" : "border-warn/40 bg-warn/10"}`}>
            <span>{tg?.ok ? <>📱 All alerts go to Telegram{tg.bot ? <> via <b>@{tg.bot}</b></> : null} → <b className="mono">{tg.demo_phone ?? "demo chat"}</b></>
              : <>📱 Telegram not ready: {tg?.detail ?? "checking…"}</>}</span>
            <span className="flex shrink-0 items-center gap-2">
              {tgTest && <span className="text-[11px]">{tgTest}</span>}
              <button onClick={testTelegram} disabled={!tg?.configured} className="rounded border border-line px-2 py-0.5 hover:border-accent disabled:opacity-40">Send test</button>
            </span>
          </div>
          <ul className="space-y-2">
            {d.notifications.plan.map((p: any) => (
              <li key={p.id} className={`rounded-lg border p-2.5 ${sel[p.id] ? "border-line bg-panel-2" : "border-line/60 opacity-70"}`}>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="checkbox" checked={!!sel[p.id]} onChange={(e) => setSel({ ...sel, [p.id]: e.target.checked })} className="mt-1" />
                  <span className="flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm">{ROLE_ICON[p.role]} {p.to_label}</span><StatusTick s={p.last?.status} />
                    </span>
                    <span className="mono block text-[11px] text-muted">{p.to_number}</span>
                    <span className="mt-0.5 block text-[11px] text-muted"><RoleBadge role={p.role} /> {p.payload} · {p.reason}</span>
                  </span>
                </label>
                <button onClick={() => setOpen(open === p.id ? null : p.id)} className="ml-6 mt-1 text-[11px] text-accent">{open === p.id ? "hide message" : "preview message"}</button>
                {open === p.id && <pre className="ml-6 mt-1 whitespace-pre-wrap rounded bg-bg p-2 text-[11px] leading-relaxed">{p.title}{"\n"}{p.text}</pre>}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-2">
            <input value={officer} onChange={(e) => setOfficer(e.target.value)} className="flex-1 rounded border border-line bg-panel-2 px-2 py-1.5 text-sm" placeholder="Approving officer" />
            <button disabled={!!busy || !chosen.length} onClick={() => act("send", () => post(`/response/${id}/dispatch`, { ids: chosen, officer }))}
              className="rounded-lg bg-bad px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {busy === "send" ? "Sending…" : `Approve & send (${chosen.length})`}</button>
          </div>
          {!d.notifications.channels.telegram && !d.notifications.channels.ntfy &&
            <p className="mt-2 text-[11px] text-warn">No channel configured: alerts are built and logged but simulated. Set TELEGRAM_BOT_TOKEN + DEMO_CHAT_ID_* or NTFY_TOPIC in backend/.env.</p>}
          <p className="mt-2 text-[11px] text-muted">Registered numbers are fictional; every message is delivered to the demo phone{d.notifications.channels.demo_phone ? ` (${d.notifications.channels.demo_phone})` : ""} and names the number it is addressed to.</p>
          {result && (
            <div className="mt-3 rounded border border-line p-2 text-xs">
              <div className="mb-1 font-semibold">Dispatched by {officer}</div>
              {result.results.map((r: any) => <div key={r.id} className="flex justify-between"><span>{ROLE_ICON[r.role]} {r.to}</span><StatusTick s={r.status} /></div>)}
              {result.linked.length > 0 && <div className="mt-2 text-ok">→ {result.linked.map((l: any) => `${l.plate} (${l.role})`).join(", ")} linked in the TS police DB</div>}
              {result.tracking_started && <div className="mt-1 font-semibold text-bad">● Continuous tracking started for {result.tracking_started} (panel below)</div>}
            </div>
          )}
        </Panel>
      </div>

      <LiveTracking id={id!} hasSuspect={d.suspects.some((s: any) => s.record)} refresh={result ? 1 : 0} />

      {/* TS police DB links */}
      <Panel title="TS police database · vehicles linked to this case"
        right={<Link to={`/case/${id}/ts-police-db`} className="text-xs text-accent">Open TS police DB →</Link>}>
        {d.db_links.length === 0 ? <p className="text-sm text-muted">Nothing linked yet. Approving the police / suspect alerts links the suspect's plate and registered number here.</p> : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {d.db_links.map((l: any) => (
                <tr key={l.plate}><td className="mono py-1.5 pr-3 font-bold">{l.plate}</td><td className="pr-3"><RoleBadge role={l.role} /></td>
                  <td className="mono pr-3 text-xs">{l.registered_phone}</td><td className="pr-3 text-xs">{l.assigned_station}</td>
                  <td className="pr-3 text-xs text-warn">{l.status}</td><td className="mono text-[11px] text-muted">{l.linked_at.replace("T", " ").slice(0, 19)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
