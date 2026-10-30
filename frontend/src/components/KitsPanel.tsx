import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { post, useApi } from "../lib/api";

/* Demo kits: ready-made evidence sets in demo_kits/, one click each. Split by how the clip was filmed. */
interface Kit { name: string; title: string; summary: string; location: string; camera: string; video: string | null; witnesses: string[]; sensor: boolean; ground_truth: boolean }

export default function KitsPanel() {
  const nav = useNavigate();
  const kits = useApi<Kit[]>("/kits");
  const [tab, setTab] = useState<"cctv" | "dashcam">("cctv");
  const [busy, setBusy] = useState<string | null>(null);
  async function run(k: Kit) {
    setBusy(k.name);
    try { const { id } = await post<{ id: string }>(`/kits/${k.name}/run`, {}); nav(`/new?job=${id}`); } finally { setBusy(null); }
  }
  return (
    <section className="mt-8">
      <div className="flex items-end justify-between gap-3 border-b-2 border-ink">
        <h2 className="pb-1 text-[11px] font-bold uppercase tracking-[0.14em]">Demo kits · real footage, ready to run</h2>
        <div className="flex">
          {([["cctv", "CCTV · fixed camera"], ["dashcam", "Dashcam · camera in a vehicle"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-1.5 text-xs font-semibold ${tab === k ? "bg-ink text-white" : "text-muted hover:text-ink"}`}>{l}</button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">{tab === "cctv"
        ? "Seen from outside: who moved where and how fast, what each witness could see, and where the statements disagree with the footage."
        : "Seen from inside the vehicle: distance and time-to-collision to the hazard, the driver's reaction time, and whether a stop was possible. The camera type is detected automatically."}</p>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
        {(kits.data ?? []).filter((k) => (k.camera ?? "cctv") === tab).map((k) => (
          <div key={k.name} className="flex flex-col border border-ink bg-panel p-4">
            {k.video && <video src={`/api/kits/${k.name}/file/${k.video}`} muted playsInline preload="metadata" className="aspect-video w-full bg-black object-cover"
              onMouseEnter={(e) => e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />}
            <div className="mt-3 font-semibold leading-snug">{k.title}</div>
            <div className="mt-0.5 text-[11px] text-muted">{k.location}</div>
            <p className="mt-2 flex-1 text-xs text-muted">{k.summary}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
              <span className="border border-observed px-1.5 py-0.5 text-observed">video</span>
              {k.witnesses.length > 0 && <span className="border border-claimed px-1.5 py-0.5 text-claimed">{k.witnesses.length} witnesses</span>}
              {k.sensor && <span className="border border-ink px-1.5 py-0.5">telematics</span>}
              {k.ground_truth && <span className="border border-ok px-1.5 py-0.5 text-ok">ground truth</span>}
            </div>
            <button disabled={!!busy} onClick={() => run(k)} className="mt-3 bg-accent py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === k.name ? "Starting…" : "Run this kit"}</button>
          </div>
        ))}
        {kits.data && !kits.data.filter((k) => (k.camera ?? "cctv") === tab).length && <p className="text-sm text-muted">No kits of this kind in demo_kits/.</p>}
      </div>
    </section>
  );
}
