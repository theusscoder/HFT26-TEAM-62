import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, FileCheck2, MessageCircle, Send, ShieldAlert, Siren } from "lucide-react";
import { post, useApi } from "../lib/api";
import { Panel } from "./ui";

/* What happened on its own the moment the crash was detected, and the police-to-hospital certificate that lets treatment
   start without waiting for an FIR. Every send is simulated unless a channel is configured; the page says which. */
const mmss = (s?: number | null) => (s == null ? "" : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

export default function EmergencyAuto({ caseId, plan, setPlan, officer }: { caseId: string; plan: any; setPlan: (p: any) => void; officer: string }) {
  const a = plan.auto;
  const tg = useApi<any>("/telegram/chats");
  const [hospital, setHospital] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!a) return null;
  const cert = plan.certificate;
  async function issue() {
    setErr(null);
    try { setPlan(await post(`/cases/${caseId}/emergency/certificate`, { officer, hospital: hospital || null })); } catch (e) { setErr(String(e)); }
  }
  const steps = [
    { label: "Crash detected", time: a.time, done: true },
    { label: `Police informed: ${a.police_intimation.to}`, time: a.police_intimation.time, done: true },
    { label: cert ? `Certificate sent to ${cert.hospital}` : "Certificate to the hospital", time: cert?.issued, done: !!cert },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Panel title="Automatic response" right={<span className="flex items-center gap-1 text-xs text-accent"><Siren size={13} />dispatch agent · {a.level}</span>}>
        <ul className="space-y-2 text-sm">
          {a.dispatched.map((d: any, i: number) => (
            <motion.li key={d.unit} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.1 }} className="flex items-start gap-2">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
              <span><b>{d.name}</b> sent automatically{d.from ? ` from ${d.from}` : ""}{d.eta_s != null ? `, ${mmss(d.eta_s)} by road` : ""}.<br /><span className="text-xs text-muted">{d.why.join("; ")}</span></span>
            </motion.li>
          ))}
          {a.held.map((d: any) => <li key={d.unit} className="flex items-start gap-2 text-muted"><ShieldAlert size={16} className="mt-0.5 shrink-0" /><span>{d.name}: recommended, waiting for an officer.</span></li>)}
          {!a.dispatched.length && <li className="text-muted">Nothing urgent enough to send without an officer. Recommendations are below.</li>}
        </ul>
        <div className="mt-3 border-t border-ink/20 pt-3 text-sm">
          <div className="flex items-start gap-2"><MessageCircle size={16} className="mt-0.5 shrink-0 text-observed" />
            <span>{a.notifications.length ? <><b>Emergency contact</b> of {a.victim.owner} ({a.victim.plate}) told on Telegram: <span className={a.notifications[0].status === "sent" ? "text-ok" : "text-warn"}>{a.notifications[0].status}</span>.</> : <>No emergency contact notified.</>}
              <br /><span className="text-xs text-muted">{a.victim.reason}</span></span>
          </div>
          {tg.data && !tg.data.configured && <p className="mt-2 text-[11px] text-muted">Telegram isn't set up, so messages are simulated. {tg.data.how}</p>}
          {tg.data?.configured && <p className="mt-2 text-[11px] text-muted">Telegram bot connected. Chats that have messaged it: {tg.data.chats.map((c: any) => `${c.name} (${c.id})`).join(", ") || "none yet"}. {tg.data.how}</p>}
        </div>
      </Panel>

      <Panel title="Police → hospital: treat now, paperwork later" right={<span className="text-xs text-muted">no waiting for an FIR</span>}>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-3 text-sm">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center text-xs font-bold ${s.done ? "bg-ink text-white" : "border border-ink"}`}>{i + 1}</span>
              <span className={s.done ? "" : "text-muted"}>{s.label}</span>
              {s.time && <span className="mono ml-auto text-[11px] text-muted">{new Date(s.time).toLocaleTimeString()}</span>}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted">Police intimation {a.police_intimation.ref}: “{a.police_intimation.text}”</p>
        {cert ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 border border-ok p-3 text-sm">
            <FileCheck2 size={18} className="text-ok" /><span>Certificate <b>{cert.ref}</b> issued by {cert.officer}, {cert.minutes_after_detection} min after detection ({cert.status}).</span>
            <a href={`/api/cases/${caseId}/emergency/certificate.html`} target="_blank" rel="noreferrer" className="ml-auto text-accent underline">Open certificate</a>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <input aria-label="Hospital" placeholder={a.help?.hospital?.name ?? "Receiving hospital"} value={hospital} onChange={(e) => setHospital(e.target.value)} className="min-w-[200px] flex-1 border px-3 py-1.5 text-sm" />
            <button disabled={!officer.trim()} onClick={issue} className="flex items-center gap-1.5 bg-accent px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"><Send size={14} />{officer.trim() ? "Issue certificate to hospital" : "Enter the officer's name above"}</button>
          </div>
        )}
        {err && <p className="mt-2 text-xs text-bad">{err}</p>}
        <p className="mt-3 text-[11px] text-muted">Hospitals must give emergency treatment without waiting for police formalities (Supreme Court of India, Parmanand Katara v. Union of India, 1989). The certificate puts that on paper, from the police, the moment the crash is reported.</p>
      </Panel>
    </div>
  );
}
