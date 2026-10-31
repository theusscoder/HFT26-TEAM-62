import { Link } from "react-router-dom";
import { Radio } from "lucide-react";
import { usePoll } from "../lib/api";

/* Cases the camera agent opened, with the real status of each one's response. The boards above replay the city's incidents
   on a loop; this list is what has actually just come in. */
const LEVEL: Record<string, string> = { L0: "#8a8a85", L1: "#22c55e", L2: "#f59e0b", L3: "#ff2a2a" };
const STEPS: [string, string][] = [["police", "Police"], ["fir", "FIR"], ["accepted", "Hospital"], ["at_scene", "Ambulance"], ["arrived", "Arrived"], ["report", "Report"]];

export default function AgentCases() {
  const r = usePoll<any[]>("/ops/recent", 5000);
  const rows = (r.data ?? []).slice(0, 3);   // the latest only: the desk's own board stays above the fold
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50"><Radio size={12} />New from the cameras</div>
      {!rows.length && <div className="border border-dashed border-white/20 p-3 text-[12px] text-white/50">No camera incidents yet.</div>}
      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={c.id} className="border border-white/15 bg-white/[0.03] p-2.5 text-[12px]">
            <div className="flex items-start justify-between gap-2">
              <Link to={`/case/${c.id}/response`} className="min-w-0 font-semibold hover:underline">{c.title}</Link>
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-bold" style={{ background: LEVEL[c.level] ?? "#555" }}>{c.level}</span>
            </div>
            <div className="mt-0.5 text-white/50">{c.camera} · {new Date(c.occurred).toLocaleTimeString("en-GB", { hour12: false })}</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {STEPS.filter(([k]) => c[k]).map(([k, label]) => (
                <span key={k} title={c[k].detail} className={`px-1.5 py-0.5 text-[10px] font-semibold ${c[k].status === "done" ? "bg-[#22c55e]/20 text-[#4ade80]" : "bg-white/10 text-white/50"}`}>{c[k].status === "done" ? "✓ " : ""}{label}</span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
