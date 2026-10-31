import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Ambulance, BedDouble, CheckCircle2, Droplet, FileText, Phone, Shield } from "lucide-react";
import { Loading } from "../components/ui";
import { clock, incidentState, mmss, useOps } from "../lib/ops";
import { OpsHeader } from "./Police";

/* Hospital emergency desk: who is coming in, how soon, who they are (name, age, blood group, vehicle, licence, family
   contact), what the police have already sent (the intimation and the treat-first certificate, which arrives before the
   patient), and a one-click "bed ready" that the police control room sees. Hospitals that were alerted but aren't
   receiving stay on standby. */
const BEDS = ["Trauma bay 1", "Trauma bay 2", "Emergency ICU", "Resus room", "Orthopaedic emergency"];
const TRIAGE: Record<string, string> = { L3: "#ff2a2a", L2: "#f59e0b", L1: "#22c55e", L0: "#22c55e" };

function Patient({ inc, t, ts, ack, hospital, onAck }: any) {
  const st = incidentState(inc, t);
  const v = inc.victim || {};
  const lead = inc.lead_officer;
  const [bed, setBed] = useState(BEDS[0]);
  const [by, setBy] = useState("");
  const steps = [
    { on: st.notified, at: 31, label: "Alert from the dispatch agent", Icon: Ambulance },
    { on: st.certSent, at: inc.t_cert, label: `Police certificate received (${inc.intimation})`, Icon: FileText, link: inc.certificate_url },
    { on: st.tl >= st.ambArrive, at: st.ambArrive, label: "Ambulance with the patient", Icon: Ambulance },
    { on: st.tl >= st.toHosp, at: st.toHosp, label: "On the way to you", Icon: Ambulance },
    { on: st.tl >= st.atHosp, at: st.atHosp, label: "Arrived", Icon: CheckCircle2 },
  ];
  return (
    <motion.div layout className="border border-white/15 bg-white/[0.03]">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 text-[10px] font-bold" style={{ background: TRIAGE[inc.level] }}>{inc.triage}</span>
          <span className="font-semibold">{inc.place}</span><span className="text-white/45">· {inc.title}</span>
        </div>
        <div className="text-right"><div className="text-[10px] uppercase tracking-[0.14em] text-white/45">{st.patient === "arrived" ? "arrived" : "ETA to you"}</div>
          <div className="mono text-2xl font-bold tabular-nums" style={{ color: st.patient === "arrived" ? "#22c55e" : "#fff" }}>{st.patient === "arrived" ? clock(ts(st.atHosp)) : mmss(st.atHosp - st.tl)}</div></div>
      </div>
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex gap-3">
          <img src={`/api/toll-images/${v.photo}`} alt="" className="h-28 w-24 shrink-0 border border-white/20 object-cover" />
          <dl className="min-w-0 flex-1 space-y-1 text-[12px]">
            <div className="text-[15px] font-bold">{v.name ?? "Unknown"}<span className="ml-1 font-normal text-white/60">{v.age ? `, ${v.age}` : ""}</span></div>
            <div className="flex items-center gap-1.5"><Droplet size={12} className="text-[#ff6b6b]" />Blood group <b>{v.blood_group ?? "?"}</b></div>
            <div className="text-white/70">{v.vehicle}{v.plate ? ` · ${v.plate}` : ""}</div>
            <div className="text-white/70">Licence {v.licence ?? "—"}</div>
            <div className="flex items-center gap-1.5 text-white/70"><Phone size={11} />Family: {v.contact} ({v.relation}) · informed</div>
            <div className="text-[#fbbf24]">{inc.injuries}</div>
          </dl>
        </div>
        <ol className="space-y-1.5 text-[12px]">
          {steps.map((s) => (
            <li key={s.label} className={`flex items-center gap-2 ${s.on ? "" : "opacity-35"}`}>
              <s.Icon size={13} className={s.on ? "text-[#22c55e]" : ""} />
              <span className="flex-1">{s.label}{s.on && s.link && <> · <a href={s.link} target="_blank" rel="noreferrer" className="text-[#93c5fd] underline">open</a></>}</span>
              <span className="mono text-white/45">{s.on ? clock(ts(s.at)) : "--:--:--"}</span>
            </li>
          ))}
          {lead && <li className="flex items-center gap-2 border-t border-white/10 pt-1.5 text-white/70"><Shield size={13} />{lead.rank_short} {lead.name} · {lead.call_sign} · {lead.phone}</li>}
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-2.5 text-[12px]">
        {ack ? <span className="flex items-center gap-1.5 font-semibold text-[#22c55e]"><BedDouble size={14} />{ack.bed} ready · confirmed by {ack.by} · police informed</span> : <>
          <BedDouble size={14} className="text-white/60" />
          <select aria-label="Bed" value={bed} onChange={(e) => setBed(e.target.value)} className="border border-white/25 bg-black px-2 py-1">{BEDS.map((b) => <option key={b}>{b}</option>)}</select>
          <input aria-label="Doctor on duty" value={by} onChange={(e) => setBy(e.target.value)} placeholder="Doctor on duty" className="w-44 border border-white/25 bg-black px-2 py-1" />
          <button disabled={by.trim().length < 2} onClick={() => onAck(inc.id, hospital, by.trim(), bed)} className="bg-[#2f7bff] px-3 py-1 font-semibold disabled:opacity-40">Confirm bed ready</button>
          <span className="text-white/45">The police control room sees this at once.</span>
        </>}
        <Link to={`/case/${inc.id}`} className="ml-auto border border-white/25 px-2 py-1 hover:bg-white/10">Case file</Link>
      </div>
    </motion.div>
  );
}

export default function Hospital() {
  const { data, error, t, cycleStart, reload } = useOps(3000);
  const [hosp, setHosp] = useState<string | null>(() => { try { return localStorage.getItem("hospital"); } catch { return null; } });
  useEffect(() => { try { if (hosp) localStorage.setItem("hospital", hosp); } catch { /* private mode */ } }, [hosp]);
  const busiest = useMemo(() => {
    if (!data) return null;
    const n: Record<string, number> = {};
    for (const i of data.incidents) if (i.hospital) n[i.hospital] = (n[i.hospital] ?? 0) + 1;
    return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [data]);
  if (!data) return <div className="h-full bg-[#0b0f14] p-8 text-white"><Loading error={error} /></div>;
  const name = hosp && data.hospitals.includes(hosp) ? hosp : busiest;
  const ts = (inc: any) => (sec: number) => cycleStart + (inc.offset_s + sec) * 1000;
  const officers = Object.fromEntries(data.officers.map((o: any) => [o.id, o]));
  const mine = data.incidents.filter((i: any) => i.hospital === name).map((i: any) => ({ ...i, lead_officer: officers[i.lead] }))
    .filter((i: any) => { const s = incidentState(i, t); return s.notified && s.tl < s.atHosp + 240; });
  const standby = data.incidents.filter((i: any) => i.hospital !== name && i.hospitals_alerted.includes(name)).filter((i: any) => { const s = incidentState(i, t); return s.notified && s.tl < s.atHosp; });
  const onAck = async (cid: string, hospital: string, by: string, bed: string) => {
    await fetch("/api/ops/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case: cid, hospital, by, bed }) });
    reload();
  };
  const upcoming = data.incidents.filter((i: any) => i.hospital === name).map((i: any) => i.offset_s + 31).filter((s: number) => s > t).sort((a: number, b: number) => a - b)[0];
  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0b0f14] text-white">
      <OpsHeader title="Hospital emergency desk" Icon={Ambulance} t={t} cycleStart={cycleStart} />
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-5 py-2.5 text-[13px]">
        <span className="text-white/50">Hospital</span>
        <select aria-label="Hospital" value={name ?? ""} onChange={(e) => setHosp(e.target.value)} className="border border-white/25 bg-black px-2 py-1 font-semibold">{data.hospitals.map((h: string) => <option key={h}>{h}</option>)}</select>
        <span className="ml-2 flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-[#2f7bff]" />{mine.length} incoming · {standby.length} on standby</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Incoming patients</div>
          {mine.length === 0 && <div className="border border-dashed border-white/20 p-6 text-sm text-white/55">No patient on the way to {name} right now.{upcoming != null && ` The next alert for this hospital is due in ${mmss(upcoming - t)}.`}</div>}
          {mine.map((inc: any) => <Patient key={inc.id} inc={inc} t={t} ts={ts(inc)} ack={data.acks[inc.id]} hospital={name} onAck={onAck} />)}
        </section>
        <aside className="space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Standby: alerted, another hospital receiving</div>
          {standby.length === 0 && <div className="text-[12px] text-white/45">None.</div>}
          {standby.map((inc: any) => (
            <div key={inc.id} className="border border-white/15 p-3 text-[12px]">
              <div className="font-semibold">{inc.place} · {inc.level}</div>
              <div className="text-white/55">Receiving: {inc.hospital}</div>
            </div>
          ))}
          <div className="border border-white/15 p-3 text-[12px] text-white/70">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">How the link works</div>
            The dispatch agent alerts every hospital within 2.5 km the moment a crash is confirmed. The lead police officer's treat-first certificate (Parmanand Katara v. Union of India) reaches the receiving hospital about 12 s later, minutes before the patient. Confirming a bed here shows on the police control room straight away.
          </div>
        </aside>
      </div>
    </div>
  );
}
