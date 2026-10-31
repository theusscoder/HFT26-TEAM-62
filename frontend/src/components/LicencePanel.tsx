import { useState } from "react";
import { IdCard } from "lucide-react";
import { post, useApi } from "../lib/api";
import { Panel } from "./ui";

// Plate → registered owner → their driving licence (fictional demo records), with a one-to-one face check against the footage.
export default function LicencePanel({ caseId }: { caseId: string }) {
  const r = useApi<any>(`/cases/${caseId}/licence`);
  const [res, setRes] = useState<Record<string, any>>({});
  if (!r.data) return null;
  const list = r.data.licences;
  async function check(plate: string) {
    try { const x = await post(`/cases/${caseId}/licence/${plate}/face-check`, {}); setRes((m) => ({ ...m, [plate]: x })); } catch (e) { setRes((m) => ({ ...m, [plate]: { status: "error", reason: String(e) } })); }
  }
  return (
    <Panel title="Registration and licence" right={<span className="flex items-center gap-1 text-xs text-warn"><IdCard size={13} />RTA registry</span>}>
      {!list.length && <p className="text-sm text-muted">No exactly-read plate matches the demo registry, so there's no licence to show. Partial plates aren't looked up.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {list.map((l: any) => (
          <div key={l.plate} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border border-ink p-3">
            <img src={`/api/toll-images/${l.photo}`} alt="Licence photo placeholder" className="w-full" />
            <div className="text-sm">
              <div className="mono text-lg tracking-widest">{l.plate}</div>
              <dl className="mt-1 space-y-0.5 text-xs">
                {[["Licence", l.dl_no], ["Holder", l.holder], ["Class", l.class], ["Valid till", l.valid_till], ["Vehicle", l.vehicle], ["Insurance", l.insurance]].map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd></div>)}
              </dl>
              <button onClick={() => check(l.plate)} className="mt-2 w-full border border-claimed py-1 text-xs font-semibold text-claimed">Face check against the footage</button>
              {res[l.plate] && <p className="mt-1 text-xs"><b>{res[l.plate].status}</b>: {res[l.plate].reason}</p>}
            </div>
          </div>
        ))}
      </div>
      {list.length > 0 && <p className="mt-2 text-[11px] text-muted">{list[0].caveat}</p>}
    </Panel>
  );
}
