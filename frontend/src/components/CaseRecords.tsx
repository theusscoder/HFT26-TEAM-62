import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Car, IdCard, Phone, ShieldCheck, ShieldAlert, User } from "lucide-react";
import { useApi } from "../lib/api";
import { Panel } from "./ui";

/* Everyone in the crash, from the registry: each vehicle's plate, registration, insurance and driver's licence, and each
   person involved. Shown on the overview, the hit-and-run page and the emergency page. */
const ROLE: Record<string, { label: string; cls: string }> = {
  victim: { label: "Victim", cls: "bg-[#0047ab] text-white" },
  suspect: { label: "Left the scene", cls: "bg-accent text-white" },
  primary: { label: "Primary", cls: "bg-ink text-white" },
  involved: { label: "Involved", cls: "border border-ink" },
};

function Row({ k, v }: { k: string; v: any }) {
  if (v == null || v === "") return null;
  return <div className="flex justify-between gap-3 py-0.5"><dt className="text-muted">{k}</dt><dd className="text-right font-medium">{v}</dd></div>;
}

export default function CaseRecords({ only }: { only?: "victim" | "suspect" }) {
  const { id } = useParams();
  const r = useApi<any>(`/cases/${id}/records`);
  if (!r.data) return null;
  const vehicles = (r.data.vehicles ?? []).filter((v: any) => !only || v.role === only);
  const people = (r.data.people ?? []).filter((p: any) => !only || p.role === only);
  if (!vehicles.length && !people.length) return null;
  return (
    <Panel title="Case records" right={<span className="text-xs text-muted">registry · RTA · insurer</span>}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {vehicles.map((v: any, i: number) => {
          const reg = v.registration, d = v.driver;
          return (
            <motion.div key={v.track} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }} className="border border-ink">
              <div className="flex items-center justify-between gap-2 border-b border-ink px-3 py-2">
                <div className="flex items-center gap-2 font-semibold"><Car size={15} />{v.name}</div>
                <span className={`px-1.5 py-0.5 text-[10px] font-bold uppercase ${ROLE[v.role]?.cls ?? "border"}`}>{ROLE[v.role]?.label ?? v.role}</span>
              </div>
              <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 p-3">
                <div className="space-y-2">
                  <img src={`/api/cases/${id}/keyframes/veh_${v.track}.jpg`} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} alt="" className="aspect-video w-full border border-line object-cover" />
                  <div className="border-2 border-ink bg-white px-1 py-0.5 text-center font-mono text-sm font-bold tracking-wider text-black">{v.plate}</div>
                  <div className="text-[10px] leading-tight text-muted">{v.plate_basis}{v.plate_read && v.plate_read !== v.plate ? ` (${v.plate_read})` : ""}</div>
                </div>
                <dl className="text-[12px]">
                  <Row k="Registered owner" v={reg.owner} />
                  <Row k="Vehicle" v={reg.vehicle} />
                  <Row k="RTO" v={`${reg.rto}${reg.registered ? ` · ${reg.registered}` : ""}`} />
                  <Row k="Fuel" v={reg.fuel} />
                  <Row k="Insurance" v={<span className={`inline-flex items-center gap-1 ${reg.insurance_ok === false ? "text-bad" : ""}`}>{reg.insurance_ok === false ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}{reg.insurance}</span>} />
                  <Row k="Pollution cert." v={reg.puc} />
                  <Row k="Pending challans" v={reg.pending_challans != null ? String(reg.pending_challans) : null} />
                  <Row k="Owner's area" v={reg.address_area} />
                  <Row k="Emergency contact" v={reg.emergency_contact && `${reg.emergency_contact}${reg.contact_relation ? ` (${reg.contact_relation})` : ""}`} />
                </dl>
              </div>
              {d && (
                <div className="flex gap-3 border-t border-line bg-panel-2/50 p-3">
                  <img src={`/api/toll-images/${d.photo}`} alt="" className="h-24 w-20 shrink-0 border border-ink object-cover" />
                  <dl className="min-w-0 flex-1 text-[12px]">
                    <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em]"><IdCard size={12} />Driver and licence</div>
                    <Row k="Driver" v={`${d.name}${d.age ? `, ${d.age}` : ""}`} />
                    <Row k="Licence" v={d.dl_no} />
                    <Row k="Class · valid till" v={`${d.class} · ${d.valid_till}`} />
                    <Row k="Blood group" v={d.blood_group} />
                    <Row k="Phone" v={d.phone} />
                    <Row k="Owner driving?" v={d.owner_is_driver == null ? null : d.owner_is_driver ? "yes" : "no, a different driver"} />
                    <Row k="Face vs licence photo" v={d.face_match != null ? `${Math.round(d.face_match * 100)}% similar` : null} />
                  </dl>
                </div>
              )}
            </motion.div>
          );
        })}
        {people.map((p: any) => (
          <div key={p.track} className="border border-ink">
            <div className="flex items-center justify-between gap-2 border-b border-ink px-3 py-2">
              <div className="flex items-center gap-2 font-semibold"><User size={15} />{p.description}</div>
              <span className={`px-1.5 py-0.5 text-[10px] font-bold uppercase ${ROLE[p.role]?.cls ?? "border"}`}>{ROLE[p.role]?.label ?? p.role}</span>
            </div>
            <div className="flex gap-3 p-3">
              <img src={`/api/toll-images/${p.photo}`} alt="" className="h-24 w-20 shrink-0 border border-ink object-cover" />
              <dl className="min-w-0 flex-1 text-[12px]">
                <Row k="Name" v={`${p.name}, ${p.age}`} />
                <Row k="Identified by" v={p.identified_by} />
                <Row k="Blood group" v={p.blood_group} />
                <Row k="Phone" v={p.phone} />
                <Row k="Emergency contact" v={<span className="inline-flex items-center gap-1"><Phone size={11} />{p.emergency_contact} ({p.contact_relation})</span>} />
                {p.licence && <Row k="Licence" v={`${p.licence.dl_no} · ${p.licence.class}`} />}
              </dl>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
