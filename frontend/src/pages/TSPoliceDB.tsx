import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { get } from "../lib/api";
import { Loading, Panel } from "../components/ui";

/* A2 · MOCK Telangana State Police vehicle & owner registry (data/ts_police_db/).
   Case-linked vehicles (pushed by Response & alerts) are listed first. Inside a case, its plates are highlighted. */
export default function TSPoliceDB() {
  const { id } = useParams();
  const [q, setQ] = useState("");
  const [list, setList] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [plate, setPlate] = useState<string | null>(null);
  const [rec, setRec] = useState<any>(null);
  const [casePlates, setCasePlates] = useState<Record<string, string>>({});

  useEffect(() => {
    const h = setTimeout(() => get<any>(`/ts-db/vehicles?q=${encodeURIComponent(q)}`).then(setList).catch((e) => setError(String(e))), 200);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (!id) return;
    get<any>(`/response/${id}`).then((r) => {
      const m: Record<string, string> = {};
      for (const v of r.plates.vehicles) m[v.plate] = v.role;
      for (const p of [...r.victims, ...r.suspects]) if (p.resolved_plate) m[p.resolved_plate] = p.role;
      setCasePlates(m);
      const s = r.suspects[0];
      if (s && !plate) setPlate(s.resolved_plate ?? s.plate);
    }).catch(() => {});
  }, [id]);
  useEffect(() => {
    if (!plate) return;
    setRec(null);
    get<any>(`/ts-db/vehicle/${encodeURIComponent(plate)}`).then(setRec).catch((e) => setRec({ error: String(e) }));
  }, [plate]);

  if (!list) return <Loading error={error} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">TS State Police · Vehicle & Owner Registry <span className="ml-2 rounded border border-warn/50 px-1.5 py-0.5 align-middle text-[10px] text-warn">MOCK</span></h1>
          <p className="mt-1 text-xs text-muted">{list.meta.count} vehicles · {list.meta.links} case link(s) · {list.meta.note}</p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search plate, owner, phone, model…"
          className="w-80 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm" />
      </div>
      <div className="grid grid-cols-[1fr_480px] gap-6">
        <Panel title="Records">
          <div className="max-h-[680px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase tracking-wider text-muted">
                <tr><th className="py-1.5">Plate</th><th>Owner · phone</th><th>Vehicle</th><th>Insurance</th><th>Flags</th><th>Case</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.vehicles.map((v: any) => {
                  const inCase = casePlates[v.plate];
                  return (
                    <tr key={v.plate} onClick={() => setPlate(v.plate)}
                      className={`cursor-pointer hover:bg-panel-2 ${plate === v.plate ? "bg-accent/10" : inCase === "suspect" ? "bg-bad/10" : inCase === "victim" ? "bg-warn/10" : ""}`}>
                      <td className="mono py-1.5 pr-3 font-semibold">{v.plate}</td>
                      <td className="pr-3">{v.owner}<div className="mono text-[11px] text-muted">{v.phone}</div></td>
                      <td className="pr-3 text-xs">{v.colour} {v.make_model}<div className="text-[11px] text-muted">{v.rto}</div></td>
                      <td className={`pr-3 text-xs ${v.insurance === "Valid" ? "" : "text-bad"}`}>{v.insurance}</td>
                      <td className="pr-3 text-xs">{v.flags.length + (v.unpaid_challans ? 1 : 0) > 0 ? <span className="text-bad">{v.flags.length} flag(s){v.unpaid_challans ? ` · ${v.unpaid_challans} unpaid` : ""}</span> : <span className="text-muted">none</span>}</td>
                      <td className="text-xs">
                        {v.case_link ? <span className={v.case_link.role === "suspect" ? "text-bad" : "text-warn"}>{v.case_link.role} · {v.case_link.case_id}</span>
                          : inCase && inCase !== "bystander" ? <span className="text-muted">{inCase} (not linked yet)</span> : inCase ? <span className="text-muted">in this case</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title={plate ? `Record · ${plate}` : "Record"}>
          {!plate ? <p className="text-sm text-muted">Select a vehicle.</p> : !rec ? <Loading /> : rec.error ? <p className="text-sm text-bad">{rec.error}</p> : (
            <div className="space-y-4 text-sm">
              {rec.case_links.map((l: any) => (
                <div key={l.case_id} className={`rounded border px-3 py-2 ${l.role === "suspect" ? "border-bad/50 bg-bad/10" : "border-warn/50 bg-warn/10"}`}>
                  <b className="uppercase">{l.role}</b> in case <Link to={`/case/${l.case_id}/response`} className="mono text-accent">{l.case_id}</Link> · {l.status}
                  <div className="text-xs">Registered number {l.registered_phone} redirected to {l.assigned_station} · {l.summary}</div>
                </div>
              ))}
              {rec.flags.length > 0 && <div className="flex flex-wrap gap-1.5">{rec.flags.map((f: string) => <span key={f} className="rounded border border-bad/40 bg-bad/10 px-1.5 py-0.5 text-[11px] text-bad">{f}</span>)}</div>}
              <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted">Owner</dt><dd>{rec.owner.name} <span className="text-muted">({rec.owner.type})</span></dd>
                {rec.owner.driver_on_record && <><dt className="text-muted">Driver on record</dt><dd>{rec.owner.driver_on_record}</dd></>}
                <dt className="text-muted">Phone</dt><dd className="mono">{rec.owner.phone}</dd>
                <dt className="text-muted">Address</dt><dd>{rec.owner.address}</dd>
                <dt className="text-muted">DL</dt><dd className="mono">{rec.owner.dl_number} · till {rec.owner.dl_valid_till}</dd>
                <dt className="text-muted">Vehicle</dt><dd>{rec.colour} {rec.make_model} · {rec.class} · {rec.fuel}</dd>
                <dt className="text-muted">Registration</dt><dd>{rec.registration.date} · {rec.registration.rto}</dd>
                <dt className="text-muted">Chassis / engine</dt><dd className="mono">{rec.registration.chassis} / {rec.registration.engine}</dd>
                <dt className="text-muted">Insurance</dt><dd className={rec.insurance.status === "Valid" ? "" : "text-bad"}>{rec.insurance.status} · {rec.insurance.insurer} · {rec.insurance.policy} · till {rec.insurance.valid_till}</dd>
                <dt className="text-muted">PUC</dt><dd>till {rec.puc_valid_till}</dd>
                <dt className="text-muted">FASTag</dt><dd className="mono">{rec.fastag_id ?? "none"}</dd>
                <dt className="text-muted">Emergency</dt><dd>{rec.emergency_contact.name} ({rec.emergency_contact.relation}) · <span className="mono">{rec.emergency_contact.phone}</span></dd>
              </dl>
              {rec.same_owner.length > 0 && <div className="text-xs"><span className="text-muted">Same owner: </span>{rec.same_owner.map((o: any) => <button key={o.plate} onClick={() => setPlate(o.plate)} className="mono mr-2 text-accent">{o.plate}</button>)}</div>}
              {rec.challans.length > 0 && (
                <div><div className="mb-1 text-[11px] uppercase tracking-wider text-muted">Challans</div>
                  {rec.challans.map((c: any, i: number) => <div key={i} className="flex justify-between text-xs"><span>{c.date} · {c.offence}</span><span className={c.status === "unpaid" ? "text-bad" : "text-ok"}>₹{c.amount_inr} {c.status}</span></div>)}</div>
              )}
              {rec.accident_history.length > 0 && (
                <div><div className="mb-1 text-[11px] uppercase tracking-wider text-muted">Accident records</div>
                  {rec.accident_history.map((a: any, i: number) => <div key={i} className="text-xs">{a.date} · {a.fir} · {a.summary}</div>)}</div>
              )}
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">FASTag toll passages (latest {rec.toll_passages.length}, mock timeline)</div>
                <div className="max-h-48 overflow-auto">
                  {rec.toll_passages.length === 0 ? <p className="text-xs text-muted">No passages.</p> : [...rec.toll_passages].reverse().map((t: any, i: number) => (
                    <div key={i} className="flex justify-between border-b border-line/50 py-0.5 text-xs"><span className="mono text-muted">{t.time.slice(0, 16).replace("T", " ")}</span><span>{t.plaza}</span><span className="text-muted">{t.direction}</span></div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
