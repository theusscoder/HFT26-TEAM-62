import { Fragment, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { AnimatePresence, motion } from "framer-motion";
import { Ambulance, CheckCircle2, Flame, MapPin, ShieldAlert, Siren, Truck } from "lucide-react";
import { post, useApi } from "../lib/api";
import { CountUp, Loading, Panel, Ref, Status } from "../components/ui";
import ContextPanel from "../components/ContextPanel";
import EmergencyAuto from "../components/EmergencyAuto";
import CaseRecords from "../components/CaseRecords";

/* Emergency response. Rules recommend from what the case shows; a named officer sends each unit; nothing goes out on its
   own and every step is in the custody ledger. Sends are simulated unless a channel is set up, and the page says so. */

const ICON: Record<string, any> = { ambulance: Ambulance, police: ShieldAlert, fire: Flame, tow: Truck };
const PRIORITY: Record<string, { label: string; cls: string }> = {
  now: { label: "Send now", cls: "border-bad/60 bg-bad/10 text-bad" },
  check: { label: "Send to check", cls: "border-warn/50 bg-warn/10 text-warn" },
  not_needed: { label: "Not indicated", cls: "border-line text-muted" },
};
const LEVEL_COLOUR: Record<string, string> = { L0: "#8a93a0", L1: "#3ecf8e", L2: "#f5b84f", L3: "#ff5d5d" };

function ScoreRing({ score, level, label }: { score: number; level: string; label: string }) {
  const R = 54, C = 2 * Math.PI * R, col = LEVEL_COLOUR[level] ?? "#8a93a0";
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx={64} cy={64} r={R} fill="none" stroke="#181c22" strokeWidth={11} />
        <motion.circle cx={64} cy={64} r={R} fill="none" stroke={col} strokeWidth={11} strokeLinecap="round" strokeDasharray={C} initial={{ strokeDashoffset: C }} animate={{ strokeDashoffset: C * (1 - score / 100) }} transition={{ duration: 1, ease: "easeOut" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-3xl font-bold" style={{ color: col }}><CountUp value={score} /></div>
        <div className="text-[11px] text-muted">{level} · {label}</div>
      </div>
    </div>
  );
}

function GoldenClock({ started, limit }: { started: string; limit: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  const gone = Math.max(0, (now - new Date(started).getTime()) / 1000), left = Math.max(0, limit - gone);
  const mm = String(Math.floor(left / 60)).padStart(2, "0"), ss = String(Math.floor(left % 60)).padStart(2, "0");
  return (
    <div className="text-right">
      <div className={`mono text-3xl font-bold tabular-nums ${left < 600 ? "text-bad" : "text-ink"}`}>{mm}:{ss}</div>
      <div className="text-[11px] text-muted">left of the golden hour, since response opened</div>
    </div>
  );
}

export default function GoldenHour() {
  const { id } = useParams();
  const [plan, setPlan] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [officer, setOfficer] = useState("");
  const sev = useApi<any>(`/cases/${id}/severity`);
  const plates = useApi<any>(`/cases/${id}/plates`);
  const fac = useApi<any>(`/cases/${id}/facilities`);
  const c = useApi<any>(`/cases/${id}/case`);
  const plate = plates.data?.vehicles[0];
  const reg = useApi<any>(plate ? `/registry/${plate.plate}` : null);
  const [count, setCount] = useState<number | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // The crash being on screen means it was detected: if the automatic response hasn't run for this case yet, it runs now.
  useEffect(() => {
    fetch(`/api/cases/${id}/emergency`).then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((p) => p.auto ? setPlan(p) : post<any>(`/cases/${id}/emergency/auto`, {}).then((x) => setPlan(x.plan)))
      .catch((e) => setErr(String(e)));
  }, [id]);
  useEffect(() => {
    if (count == null || count <= 0) return;
    const h = setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(h);
  }, [count]);
  useEffect(() => {
    if (count !== 0 || !plate) return;
    post<any>(`/cases/${id}/alert`, {
      plate: plate.plate,
      text: `🚨 YATHARTH alert: vehicle ${plate.plate} was involved in a road incident at ${c.data?.location.name}. Severity ${sev.data.level}. Emergency services informed. Ref ${id}.`,
    }).then((r) => setSent(r.status));
  }, [count]);

  if (!plan || !c.data) return <Loading error={err ?? c.error} />;
  const loc: [number, number] | null = c.data.location.lat != null ? [c.data.location.lat, c.data.location.lon] : null;
  const autoOk = (plate?.confidence ?? 0) >= 0.8;
  const act = async (path: string, body: any) => { try { setPlan(await post(`/cases/${id}/emergency/${path}`, body)); } catch (e) { setErr(String(e)); } };
  const scene = plan.scene;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-6  border border-line bg-panel p-5">
        <ScoreRing score={plan.score ?? 0} level={plan.level} label={plan.label ?? ""} />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Siren size={22} className={plan.level === "L3" ? "animate-pulse text-bad" : "text-accent"} />Emergency response</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{plan.injury_note}</p>
          {plan.clock_at_impact && <p className="mono mt-1 text-xs text-muted">Impact on the CCTV clock: {plan.clock_at_impact}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input aria-label="Officer name" placeholder="Officer's name" value={officer} onChange={(e) => setOfficer(e.target.value)} className="w-52 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm" />
            {!plan.started && <button disabled={!officer.trim()} onClick={() => act("start", { officer })} className="rounded-lg bg-bad px-4 py-1.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-40">Open response</button>}
            <span className="text-[11px] text-muted">{plan.channel === "simulated" ? "Sends are simulated: no channel is set up" : "Sends go out on the configured channel"}</span>
          </div>
        </div>
        {plan.started && <GoldenClock started={plan.started} limit={plan.golden_hour_s} />}
      </div>

      <EmergencyAuto caseId={id!} plan={plan} setPlan={setPlan} officer={officer} />
      <CaseRecords />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {plan.units.map((u: any, i: number) => {
          const P = PRIORITY[u.priority], Icon = ICON[u.id], done = u.dispatch;
          return (
            <motion.div key={u.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }} className={`flex flex-col  border p-4 ${done ? "border-ok/50 bg-ok/5" : "border-line bg-panel"}`}>
              <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 font-semibold"><Icon size={17} />{u.name}</span><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${P.cls}`}>{P.label}</span></div>
              <ul className="mt-2 flex-1 space-y-1 text-xs text-muted">{u.why.map((w: string) => <li key={w}>{w}</li>)}</ul>
              <AnimatePresence mode="wait">
                {done ? (
                  <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-ok"><CheckCircle2 size={14} />{done.status === "simulated" ? "Simulated dispatch" : `Dispatch ${done.status}`} by {done.officer}</motion.div>
                ) : (
                  <motion.button key="send" disabled={!officer.trim()} onClick={() => act("dispatch", { unit: u.id, officer })} className={`mt-3 rounded-lg border py-1.5 text-xs font-semibold transition disabled:opacity-40 ${u.priority === "not_needed" ? "border-line text-muted hover:text-ink" : "border-accent/50 text-accent hover:bg-accent/10"}`}>
                    {officer.trim() ? `Dispatch ${u.name.toLowerCase()}` : "Enter the officer's name to dispatch"}
                  </motion.button>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          {loc && fac.data ? (
            <Panel title="Nearest help" right={<span className="text-xs text-muted">{fac.data.source}</span>}>
              <div className="h-[420px] overflow-hidden rounded-lg">
                <MapContainer center={loc} zoom={14} className="h-full w-full">
                  <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap" />
                  <CircleMarker center={loc} radius={10} pathOptions={{ color: "#ff5d5d", fillOpacity: 0.8 }}><Tooltip permanent>Incident</Tooltip></CircleMarker>
                  {fac.data.police.map((p: any) => <CircleMarker key={p.name} center={[p.lat, p.lon]} radius={7} pathOptions={{ color: "#4f8cff" }}><Tooltip>{p.name} · {p.dist_km} km{p.eta_min ? ` · ${p.eta_min} min` : ""}</Tooltip></CircleMarker>)}
                  {fac.data.hospitals.map((h: any) => <CircleMarker key={h.name} center={[h.lat, h.lon]} radius={7} pathOptions={{ color: "#3ecf8e" }}><Tooltip>{h.name} · {h.dist_km} km{h.trauma ? " · trauma" : ""}</Tooltip></CircleMarker>)}
                  {[...fac.data.police, ...fac.data.hospitals.filter((h: any) => h.trauma)].map((f: any) => <Polyline key={f.name} positions={[loc, [f.lat, f.lon]]} pathOptions={{ color: "#8a93a0", dashArray: "4 6" }} />)}
                </MapContainer>
              </div>
              <div className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                {Object.entries(plan.nearest).map(([k, n]: any) => <div key={k} className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-2"><MapPin size={14} className={k === "police" ? "text-accent" : "text-ok"} /><span className="min-w-0 flex-1 truncate">{n.name}</span><span className="mono text-xs text-muted">{n.dist_km} km · ~{n.eta_min} min</span></div>)}
              </div>
              <p className="mt-2 text-[11px] text-muted">Straight lines and a {30} km/h estimate, so real routes will take longer.</p>
            </Panel>
          ) : (
            <div><p className="mb-2 flex items-center gap-1.5 text-sm text-muted"><MapPin size={14} />The footage doesn't say where this happened. Set the place to find the nearest police and hospitals.</p><ContextPanel /></div>
          )}
          {scene.frames.length > 0 && (
            <Panel title="What the vision model sees" right={<span className="text-xs text-muted">{scene.ran ? "Qwen vision" : "not run"}</span>}>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {scene.frames.map((f: any) => <figure key={f.name} className="overflow-hidden rounded-lg border border-line"><img src={`/api/cases/${id}/${f.file}`} alt={`${f.name} frame`} className="aspect-video w-full object-cover" /><figcaption className="px-2 py-1 text-[10px] text-muted">{f.name} · T{f.t >= 0 ? "+" : ""}{f.t.toFixed(1)} s</figcaption></figure>)}
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
                {([["Someone newly on the ground", scene.person_down_seen], ["Fire or smoke", scene.fire_smoke_seen], ["Overturned vehicle", scene.overturned_seen]] as const).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-muted">{k}</dt><dd className={v ? "font-semibold text-bad" : "text-muted"}>{v ? "seen" : "not seen"}</dd></div>)}
                <div className="flex justify-between"><dt className="text-muted">Weather, road</dt><dd>{scene.weather ?? "?"}, {scene.road_surface ?? "?"}</dd></div>
              </dl>
              <p className="mt-2 text-[11px] text-muted">"On the ground" only counts if it's new after the impact, because the model over-reports it on busy roads. "Not seen" doesn't rule anything out.</p>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          <Panel title="Why this severity">
            <ul className="space-y-2 text-sm">
              {plan.breakdown.map((b: any, i: number) => (
                <motion.li key={b.signal} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }} className="flex justify-between gap-2"><span>{b.why}<br /><Ref value={b.ref} /></span><span className="mono font-semibold text-bad">+{b.points}</span></motion.li>
              ))}
            </ul>
            <p className="mono mt-3 border-t border-line/70 pt-2 text-right text-sm">{plan.breakdown.map((b: any) => b.points).join(" + ") || "0"} = {plan.score}</p>
            <p className="mt-2 text-xs text-muted">Notifies: {plan.notify.join(", ")}{sev.data?.minor_example ? ` · a minor bump scores ${sev.data.minor_example.level} and alerts ${sev.data.minor_example.notify.join(", ")}` : ""}</p>
          </Panel>
          <Panel title="Response log">
            {plan.log.length === 0 && <p className="text-sm text-muted">Nothing yet. Every step here is also written to the custody ledger.</p>}
            <ol className="space-y-2 text-sm">
              {plan.log.map((e: any, i: number) => <motion.li key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2"><span className="mono shrink-0 text-[11px] text-muted">{new Date(e.time).toLocaleTimeString()}</span><span>{e.text}</span></motion.li>)}
            </ol>
          </Panel>
          {!plate ? <Panel title="Involved vehicle"><p className="text-sm text-muted">{plates.data ? `No plate was readable on the vehicles checked. ${plates.data.method}.` : "Plates haven't been read for this case yet."}</p></Panel> : <Panel title="Involved vehicle" right={<span className="mono text-xs">{Math.round(plate.confidence * 100)}%</span>}>
            <div className="mono text-2xl tracking-widest">{plate.plate}</div>
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              {plate.reads.map((r: string, i: number) => <div key={i} className={`mono rounded border px-1.5 py-1 text-center text-[11px] ${r === plate.plate ? "border-ok/40 text-ok" : "border-line text-muted"}`}>f{plate.frames[i]} {r}</div>)}
            </div>
            {reg.data && <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm">{Object.entries(reg.data).map(([k, v]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd>{String(v)}</dd></Fragment>)}</dl>}
            <p className="mt-2 text-[11px] text-muted">Demo registry (fictional). Registered owner may not be the driver.</p>
            {reg.data && <div className="mt-4">
              {sent ? <div className="text-sm text-ok">Alert {sent} → {reg.data?.owner}</div>
                : count != null ? <button onClick={() => setCount(null)} className="w-full rounded-lg border border-bad py-2 text-sm">Sending in {count}s · Cancel</button>
                : <button onClick={() => setCount(autoOk ? 10 : 0)} className="w-full rounded-lg bg-bad py-2 text-sm font-semibold text-white">{autoOk ? "Start alert countdown" : "Officer confirm & send"}</button>}
            </div>}
          </Panel>}
        </div>
      </div>
      <p className="text-[11px] text-muted"><Status value={plan.level} /> Recommendations are rules over this case's evidence. A dispatcher decides.</p>
    </div>
  );
}
