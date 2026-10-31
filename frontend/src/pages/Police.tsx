import { useMemo } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { AnimatePresence, motion } from "framer-motion";
import { Ambulance, CheckCircle2, FileText, Map as MapIcon, Shield } from "lucide-react";
import { Loading } from "../components/ui";
import { at, clock, incidentState, mmss, officerState, useOps } from "../lib/ops";

/* Police control room: every officer, what the dispatch and intercept agents have them on, who is chasing whom, and each
   incident's paperwork (intimation, treat-first certificate to the hospital, the hospital's acknowledgement). */
const icons = new Map<string, L.DivIcon>();
const icon = (cls: string, size = 14) => {
  const k = cls + size;
  if (!icons.has(k)) icons.set(k, L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }));
  return icons.get(k)!;
};
const LEVEL: Record<string, string> = { L0: "#8a8a85", L1: "#22c55e", L2: "#f59e0b", L3: "#ff2a2a" };

export function OpsHeader({ title, Icon, t, cycleStart }: { title: string; Icon: any; t: number; cycleStart: number }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-2.5">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-xl font-extrabold tracking-tight">YATHARTH</Link>
        <span className="flex items-center gap-1.5 bg-[#ff2a2a] px-2 py-0.5 text-[11px] font-bold"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />LIVE</span>
        <span className="flex items-center gap-1.5 text-sm text-white/70"><Icon size={15} />{title}</span>
        <span className="mono text-lg font-bold tabular-nums">{clock(cycleStart + t * 1000)}</span>
      </div>
      <nav className="flex flex-wrap gap-1.5 text-[13px]">
        <Link to="/" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><MapIcon size={13} />City map</Link>
        <Link to="/operations" className="border border-white/20 px-2.5 py-1 hover:bg-white/10">Live operation</Link>
        <Link to="/police" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><Shield size={13} />Police</Link>
        <Link to="/hospital" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><Ambulance size={13} />Hospital</Link>
      </nav>
    </header>
  );
}

export default function Police() {
  const { data, error, t, cycleStart } = useOps();
  const rows = useMemo(() => (data ? data.officers.map((o: any) => ({ o, s: officerState(o, data, t) })) : []), [data, Math.floor(t * 2)]);
  if (!data) return <div className="h-full bg-[#0b0f14] p-8 text-white"><Loading error={error} /></div>;
  const ts = (inc: any, sec: number) => clock(cycleStart + (inc.offset_s + sec) * 1000);
  const live = data.incidents.filter((i: any) => incidentState(i, t).started && t - i.offset_s <= i.end_s + 120);
  const busy = rows.filter((r: any) => r.s.status !== "Available");
  const log = data.incidents.flatMap((inc: any) => [...inc.log, ...data.log.filter((l: any) => l.incident === inc.id)]
    .map((l: any) => ({ ...l, inc, abs: inc.offset_s + l.t }))).filter((l: any) => l.abs <= t && t - l.abs < 400).sort((a: any, b: any) => b.abs - a.abs).slice(0, 18);
  const kpi = [
    ["Officers on duty", data.officers.length], ["Assigned now", busy.length], ["En route", rows.filter((r: any) => r.s.status === "En route").length],
    ["In pursuit", rows.filter((r: any) => r.s.status === "Pursuing").length], ["Active incidents", live.length],
    ["Certificates sent", live.filter((i: any) => incidentState(i, t).certSent).length],
  ];
  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0b0f14] text-white">
      <OpsHeader title="Police control room · Cyberabad" Icon={Shield} t={t} cycleStart={cycleStart} />
      <div className="grid grid-cols-3 gap-px border-b border-white/10 bg-white/10 lg:grid-cols-6">
        {kpi.map(([k, v]) => <div key={k as string} className="bg-[#0b0f14] px-4 py-2.5"><div className="text-[10px] uppercase tracking-[0.14em] text-white/50">{k}</div><div className="text-2xl font-bold tabular-nums">{v}</div></div>)}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_560px]">
        <div className="relative min-h-[380px]">
          <MapContainer center={[17.4395, 78.356]} zoom={14} zoomControl={false} className="ops-map h-full w-full">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="ops-tiles" attribution="© OpenStreetMap contributors" />
            {data.stations.map((s: any) => <CircleMarker key={s.name} center={[s.lat, s.lon]} radius={5} pathOptions={{ color: "#ff3b3b", weight: 2, fillOpacity: 0.6 }}><Tooltip>{s.name}</Tooltip></CircleMarker>)}
            {live.map((inc: any) => {
              const st = incidentState(inc, t);
              const fl = inc.flee;
              const caught = fl && st.tl >= fl.outcome.t;
              return (
                <span key={inc.id}>
                  <Marker position={inc.crash} icon={icon("ops-crash", 24)}><Tooltip direction="top" className="ops-label">{inc.level} · {inc.place}</Tooltip></Marker>
                  {fl && <Polyline positions={fl.keys.filter((k: number[]) => k[0] <= st.tl).map((k: number[]) => [k[1], k[2]])} pathOptions={{ color: "#ff2a2a", weight: 3 }} />}
                  {fl && <Marker position={at(fl.keys, st.tl)!} icon={icon(caught ? "ops-suspect ops-caught" : "ops-suspect", 16)}><Tooltip permanent direction="right" className="ops-label ops-label-s">{caught ? "STOPPED" : "FLEEING"} · {inc.suspect?.plate}</Tooltip></Marker>}
                </span>
              );
            })}
            {busy.filter(({ s }: any) => s.pos).map(({ o, s }: any) => (
              <span key={o.id}>
                {s.crew && (s.status === "En route" || s.status === "Pursuing") && <Polyline positions={[s.pos, ...s.crew.keys.filter((k: number[]) => k[0] > t - s.inc.offset_s).map((k: number[]) => [k[1], k[2]])]} pathOptions={{ color: "#ff2a2a", weight: 2, dashArray: "4 6", opacity: 0.75 }} />}
                <Marker position={s.pos} icon={icon("ops-police ops-unit", 13)}><Tooltip direction="top" className="ops-label">{o.call_sign} · {o.rank_short} {o.name} · {s.status}</Tooltip></Marker>
              </span>
            ))}
          </MapContainer>
          <div className="absolute bottom-3 left-3 z-[600] flex gap-3 bg-black/75 px-2.5 py-1.5 text-[11px] text-white/70">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 bg-[#ff2a2a]" />officers on a case</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-[#ff3b3b]/60" />stations</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full border-2 border-[#ff2a2a]" />incidents</span>
          </div>
        </div>

        <aside className="min-h-0 space-y-4 overflow-y-auto border-l border-white/10 p-4">
          <section>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Incidents and paperwork</div>
            <div className="space-y-2">
              {live.length === 0 && <div className="border border-dashed border-white/20 p-3 text-sm text-white/50">No active incidents right now.</div>}
              {live.map((inc: any) => {
                const st = incidentState(inc, t);
                const lead = data.officers.find((o: any) => o.id === inc.lead);
                const ack = data.acks[inc.id];
                return (
                  <motion.div layout key={inc.id} className="border border-white/15 bg-white/[0.03] p-3 text-[12px]">
                    <div className="flex items-start justify-between gap-2">
                      <div><div className="font-semibold">{inc.title}</div><div className="text-white/50">{inc.place} · detected {ts(inc, 15)}</div></div>
                      <span className="px-1.5 py-0.5 text-[10px] font-bold" style={{ background: LEVEL[inc.level] }}>{inc.level}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <div className="text-white/50">Lead officer</div><div>{lead ? `${lead.rank_short} ${lead.name} (${lead.call_sign})` : "—"}</div>
                      <div className="text-white/50">Crew</div><div>{inc.crew.length} officers{inc.flee ? `, ${inc.crew.filter((c: any) => c.role !== "scene").length} on the pursuit` : ""}</div>
                      {inc.suspect && <><div className="text-white/50">Tracking</div><div className="font-mono text-[#ff8080]">{inc.suspect.plate} · {inc.suspect.vehicle}</div></>}
                      <div className="text-white/50">Victim</div><div>{inc.victim ? `${inc.victim.name}, ${inc.victim.age}` : "—"}</div>
                    </div>
                    <ol className="mt-2 space-y-1 border-t border-white/10 pt-2">
                      <li className={st.notified ? "" : "opacity-35"}><CheckCircle2 size={12} className="mr-1 inline text-[#22c55e]" />Intimation {inc.intimation} {st.notified && <span className="mono text-white/40">{ts(inc, 31)}</span>}</li>
                      <li className={st.certSent ? "" : "opacity-35"}><FileText size={12} className="mr-1 inline text-[#93c5fd]" />Treat-first certificate to {inc.hospital} {st.certSent && <><span className="mono text-white/40">{ts(inc, inc.t_cert)}</span> <a href={inc.certificate_url} target="_blank" rel="noreferrer" className="text-[#93c5fd] underline">view</a></>}</li>
                      <li className={ack ? "" : "opacity-35"}><Ambulance size={12} className="mr-1 inline text-[#93c5fd]" />{ack ? `${inc.hospital}: ${ack.bed} ready · ${ack.by}` : "Waiting for the hospital to confirm a bed"}</li>
                      <li className={st.patient === "arrived" ? "" : "opacity-60"}>Patient: {{ none: "—", dispatched: "ambulance on the way", at_scene: "ambulance with the victim", transporting: `on the way to hospital, ${mmss(st.atHosp - st.tl)}`, arrived: "at hospital" }[st.patient]}</li>
                    </ol>
                    <div className="mt-2 flex gap-2"><Link to={`/case/${inc.id}`} className="border border-white/25 px-2 py-1 hover:bg-white/10">Open case</Link><Link to={`/case/${inc.id}/golden-hour`} className="border border-white/25 px-2 py-1 hover:bg-white/10">Emergency page</Link></div>
                  </motion.div>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Officers</div>
            <table className="w-full text-[12px]">
              <thead className="text-left text-white/45"><tr><th className="py-1">Officer</th><th>Station</th><th>Status</th><th>Case / tracking</th></tr></thead>
              <tbody>
                {rows.sort((a: any, b: any) => (a.s.status === "Available" ? 1 : 0) - (b.s.status === "Available" ? 1 : 0)).map(({ o, s }: any) => (
                  <tr key={o.id} className="border-t border-white/10 align-top">
                    <td className="py-1.5"><div className="font-semibold">{o.rank_short} {o.name}</div><div className="mono text-white/45">{o.call_sign} · {o.vehicle}</div></td>
                    <td className="py-1.5 text-white/70">{o.station.replace(" Police station", "").replace(" police station", "")}</td>
                    <td className="py-1.5"><span className="inline-flex items-center gap-1 font-semibold" style={{ color: s.tone }}><span className={`h-1.5 w-1.5 rounded-full ${s.status !== "Available" ? "animate-pulse" : ""}`} style={{ background: s.tone }} />{s.status}</span>{s.eta != null && <div className="mono text-white/50">ETA {mmss(s.eta)}</div>}</td>
                    <td className="py-1.5">{s.inc ? <><div>{s.inc.place}</div>{s.tracking && <div className="font-mono text-[#ff8080]">{s.status === "Pursuing" ? "chasing" : "holding"} {s.tracking}</div>}{s.task && <div className="text-white/45">{s.task}</div>}</> : <span className="text-white/35">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Agents</div>
            <ol className="space-y-1">
              <AnimatePresence initial={false}>
                {log.map((l: any) => (
                  <motion.li key={l.inc.id + l.t + l.text} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="text-[12px] leading-snug">
                    <span className="mono mr-1.5 text-white/40">{ts(l.inc, l.t)}</span><span className="mr-1.5 font-bold text-[#f59e0b]">{l.agent}</span>{l.text}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
