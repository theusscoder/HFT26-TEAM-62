import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Ambulance, Bot, Camera, CheckCircle2, Clock, FileText, Hospital, Send, Shield, Stethoscope } from "lucide-react";
import { Loading, Panel, Stat } from "../components/ui";

/* Every step of the response with its time: the crash, detection, police informed, dispatches, Telegram alerts, the FIR,
   the treat-first certificate, the hospital accepting, the ambulance on scene and on the way, arrival, treatment and the
   treatment report. Done steps show when they happened; the rest count down to when they're due. The hospital can accept
   and file the treatment report here; otherwise the hospital system files them on schedule. */
const ICON: Record<string, any> = { occurred: Camera, detected: Bot, analysed: Bot, police_informed: Shield, hospital_alerted: Hospital, fir: FileText,
  certificate: FileText, accepted: Hospital, at_scene: Ambulance, transport: Ambulance, arrived: Hospital, treatment: Stethoscope, treatment_report: Stethoscope };
const iconOf = (k: string) => ICON[k] ?? (k.startsWith("dispatch") ? Ambulance : k.startsWith("telegram") ? Send : Clock);
const clock = (s: string) => new Date(s).toLocaleTimeString("en-GB", { hour12: false });
const dur = (s: number | null | undefined) => (s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`);

export default function ResponseTimeline() {
  const { id } = useParams();
  const [tl, setTl] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState<{ key: string; by: string; detail: string } | null>(null);
  const load = () => fetch(`/api/cases/${id}/response-timeline`).then(async (r) => (r.ok ? setTl(await r.json()) : setErr(await r.text()))).catch((e) => setErr(String(e)));
  useEffect(() => { load(); const h = setInterval(load, 4000); const c = setInterval(() => setNow(Date.now()), 1000); return () => { clearInterval(h); clearInterval(c); }; }, [id]);
  if (!tl) return <Loading error={err} />;
  const submit = async () => {
    if (!form) return;
    const r = await fetch(`/api/cases/${id}/response-timeline/${form.key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ by: form.by, detail: form.detail }) });
    if (r.ok) { setTl(await r.json()); setForm(null); }
  };
  const k = tl.kpi ?? {};
  const occ = new Date(tl.occurred).getTime();
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {[["police_informed", "Police informed after"], ["fir", "FIR registered after"], ["accepted", "Hospital accepted after"], ["at_scene", "Ambulance on scene after"], ["arrived", "At hospital after"]].map(([key, label]) => {
          const e = tl.events.find((x: any) => x.key === key);
          return <Stat key={key} label={label} value={e ? e.t_plus_s / 60 : 0} decimals={1} suffix={!e ? " min" : e.status === "done" ? " min" : " min · due"} tone={e && e.status !== "done" ? "text-muted" : ""} />;
        })}
        <Stat label="Golden hour left" value={Math.max(0, 3600 - (now - occ) / 1000) / 60} decimals={0} suffix=" min" tone="text-accent" />
      </div>

      <Panel title="Response timeline" right={<span className="text-xs text-muted">crash at {clock(tl.occurred)} · times are local · refreshes live</span>}>
        <ol className="relative ml-3 border-l-2 border-line">
          {tl.events.map((e: any, i: number) => {
            const I = iconOf(e.key), done = e.status === "done";
            const due = Math.round((new Date(e.time).getTime() - now) / 1000);
            const canAct = !done && ["accepted", "treatment_report"].includes(e.key);
            return (
              <motion.li key={e.key} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }} className="relative mb-4 ml-6">
                <span className={`absolute -left-[37px] flex h-7 w-7 items-center justify-center rounded-full border-2 ${done ? "border-ok bg-ok text-white" : "border-line bg-panel text-muted"}`}><I size={14} /></span>
                <div className={`flex flex-wrap items-baseline justify-between gap-2 ${done ? "" : "opacity-70"}`}>
                  <div className="font-semibold">{e.label}{e.by_person && <span className="ml-2 text-[10px] font-bold uppercase text-ok">by staff</span>}{e.auto_by && done && <span className="ml-2 text-[10px] text-muted">filed by {e.auto_by}</span>}</div>
                  <div className="mono text-sm">{done ? <>{clock(e.time)} <span className="text-muted">· T+{dur(e.t_plus_s)}</span></> : <span className="text-warn">due in {dur(Math.max(0, due))} · {clock(e.time)}</span>}</div>
                </div>
                <div className="text-[13px] text-muted"><b className="font-medium text-ink">{e.actor}</b>{e.detail ? ` · ${e.detail}` : ""}</div>
                {tl.notified?.[e.key] && <div className="mt-0.5 text-[11px] text-muted">Telegram: {Object.entries(tl.notified[e.key]).map(([r, s]) => `${r} ${s}`).join(", ")}</div>}
                {canAct && (form?.key === e.key ? (
                  <div className="mt-2 flex flex-wrap gap-2 text-sm">
                    <input aria-label="Name" value={form!.by} onChange={(x) => setForm({ ...form!, by: x.target.value })} placeholder={e.key === "accepted" ? "Doctor / desk name" : "Doctor's name"} className="border border-ink bg-bg px-2 py-1" />
                    <input aria-label="Detail" value={form!.detail} onChange={(x) => setForm({ ...form!, detail: x.target.value })} placeholder={e.key === "accepted" ? "Bed, e.g. Trauma bay 2" : "Findings, treatment, condition"} className="min-w-[260px] flex-1 border border-ink bg-bg px-2 py-1" />
                    <button disabled={form!.by.trim().length < 2 || form!.detail.trim().length < 2} onClick={submit} className="flex items-center gap-1 bg-accent px-3 py-1 font-semibold text-white disabled:opacity-40"><CheckCircle2 size={14} />Record now</button>
                  </div>
                ) : <button onClick={() => setForm({ key: e.key, by: "", detail: "" })} className="mt-1 text-xs text-accent underline">{e.key === "accepted" ? "Accept the patient now (hospital)" : "File the treatment report now (hospital)"}</button>)}
              </motion.li>
            );
          })}
        </ol>
      </Panel>
    </div>
  );
}
