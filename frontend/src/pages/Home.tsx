import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post, useApi } from "../lib/api";

/* OWNER: P4. Home is upload-first: drop any road video to start a case, or run a ready-made demo kit in one click.
   Previous cases are listed below. Nothing is pre-assigned: every case here was created from uploaded evidence. */

interface Kit { name: string; title: string; summary: string; location: string; camera: string; video: string | null; witnesses: string[]; sensor: boolean; ground_truth: boolean }

export default function Home() {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"cctv" | "dashcam">("cctv");
  const cases = useApi<{ id: string; title: string; location: { name: string }; status?: string; camera?: { type: string; confidence?: number } }[]>("/cases");
  const kits = useApi<Kit[]>("/kits");

  const go = (files: File[]) => files.length && nav("/new", { state: { files } });
  async function runKit(k: Kit) {
    setBusy(k.name);
    try {
      const { id } = await post<{ id: string }>(`/kits/${k.name}/run`, {});
      nav(`/new?job=${id}`);
    } finally { setBusy(null); }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-4xl font-bold tracking-tight">YATHARTH</h1>
      <p className="mt-2 max-w-2xl text-muted">Upload road-accident footage with whatever else you have (witness statements, a vehicle's telematics) and get a
        cross-checked timeline, a calibrated reconstruction, and every contradiction between the sources with its evidence.</p>

      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); go(Array.from(e.dataTransfer.files)); }} onClick={() => input.current?.click()}
        className={`mt-8 flex h-48 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed transition ${drag ? "border-accent bg-accent/10" : "border-line bg-panel hover:border-accent/60"}`}>
        <div className="text-lg font-semibold">Analyse a video</div>
        <div className="mt-1 text-sm text-muted">Drop a CCTV or dashcam clip here, or click to choose (.mp4 .mov .avi .mkv)</div>
        <div className="mt-1 text-xs text-muted">Witness statements (.txt) and a telematics log (.csv) are optional and can be dropped together</div>
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => go(Array.from(e.target.files ?? []))} />
      </div>

      <p className="mt-2 text-xs text-muted">The system detects on its own whether a clip is a fixed CCTV camera or a moving dashcam / helmet-cam, and reconstructs it accordingly.</p>

      <div className="mt-10 flex items-center gap-1 border-b border-line">
        {([["cctv", "CCTV · fixed camera"], ["dashcam", "Dashcam · camera in a vehicle"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === k ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}>{l}</button>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">{tab === "cctv"
        ? "Seen from outside: who moved where and how fast, what each witness could see, and where the statements disagree with the footage."
        : "Seen from inside the vehicle: distance and time-to-collision to the hazard, the driver's reaction time, and whether a stop was possible."}</p>

      <h2 className="mt-6 text-xs font-semibold uppercase tracking-wider text-muted">Demo kits · real footage, ready to run</h2>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
        {(kits.data ?? []).filter((k) => (k.camera ?? "cctv") === tab).map((k) => (
          <div key={k.name} className="flex flex-col rounded-xl border border-line bg-panel p-4">
            {k.video && <video src={`/api/kits/${k.name}/file/${k.video}`} muted playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-black object-cover"
              onMouseEnter={(e) => e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />}
            <div className="mt-3 font-semibold leading-snug">{k.title}</div>
            <div className="mt-0.5 text-[11px] text-muted">{k.location}</div>
            <p className="mt-2 flex-1 text-xs text-muted">{k.summary}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
              <span className="rounded bg-observed/15 px-1.5 py-0.5 text-observed">video</span>
              {k.witnesses.length > 0 && <span className="rounded bg-claimed/15 px-1.5 py-0.5 text-claimed">{k.witnesses.length} witnesses</span>}
              {k.sensor && <span className="rounded bg-[#5fd4e6]/15 px-1.5 py-0.5 text-[#5fd4e6]">telematics</span>}
              {k.ground_truth && <span className="rounded bg-ok/15 px-1.5 py-0.5 text-ok">ground truth</span>}
            </div>
            <button disabled={!!busy} onClick={() => runKit(k)} className="mt-3 rounded-lg bg-accent py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy === k.name ? "Starting…" : "Run this kit"}
            </button>
          </div>
        ))}
        {kits.data && !kits.data.length && <p className="text-sm text-muted">No kits found in demo_kits/.</p>}
      </div>

      <h2 className="mt-12 text-xs font-semibold uppercase tracking-wider text-muted">Cases</h2>
      <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-panel">
        {(cases.data ?? []).filter((c) => (c.camera?.type ?? "cctv") === tab || c.status === "running").map((c) => (
          <li key={c.id}>
            <Link to={c.status === "running" ? `/new?job=${c.id}` : `/case/${c.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-panel-2">
              <span className="font-medium">{c.title}{c.camera?.type === "dashcam" && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">dashcam</span>}</span>
              <span className="flex items-center gap-3 text-sm text-muted">
                {c.location?.name}
                {c.status === "running" && <span className="animate-pulse rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">processing</span>}
                {c.status === "error" && <span className="rounded bg-bad/20 px-2 py-0.5 text-xs text-bad">failed</span>}
              </span>
            </Link>
          </li>
        ))}
        {cases.data && !cases.data.length && <li className="px-4 py-3 text-sm text-muted">No cases yet. Upload a video or run a demo kit.</li>}
      </ul>
    </div>
  );
}
