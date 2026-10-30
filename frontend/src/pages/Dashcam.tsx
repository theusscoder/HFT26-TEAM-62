import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Camera, Upload } from "lucide-react";
import { useApi } from "../lib/api";
import { ClockProvider, useClock } from "../lib/clock";
import { Loading, Panel } from "../components/ui";
import DriverView, { type Dashcam as DashData } from "../components/DriverView";
import KeyFindings, { type Finding } from "../components/Findings";

/* Dashcam, available in every case. A dashcam case shows its own footage; a case with a dashcam clip of the same crash shows
   that one; otherwise a clip can be added, and it's analysed as its own linked case with the dashcam pipeline. */

function Footage({ src, t0 }: { src: string; t0: number }) {
  const { t, playing } = useClock();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
    if (Math.abs(v.currentTime - (t + t0)) > (playing ? 0.2 : 0.03)) v.currentTime = Math.max(0, t + t0);
  }, [t, t0, playing]);
  return <video ref={ref} src={src} muted playsInline preload="auto" className="w-full bg-black" />;
}

function Controls() {
  const { t, seek, toggle, playing, range } = useClock();
  return (
    <div className="flex items-center gap-3 border border-ink bg-panel px-4 py-3">
      <button onClick={toggle} className="w-20 bg-accent py-1.5 text-sm font-semibold text-white">{playing ? "Pause" : "Play"}</button>
      <button onClick={() => seek(0)} className="border border-bad px-2.5 py-1 text-xs text-bad">impact 0.0s</button>
      <input aria-label="Time" type="range" min={range[0]} max={range[1]} step={0.05} value={t} onChange={(e) => seek(+e.target.value)} className="flex-1 accent-[#e30613]" />
      <span className="mono w-24 text-right text-sm">T{t >= 0 ? "+" : ""}{t.toFixed(2)} s</span>
    </div>
  );
}

function Viewer({ src, linked }: { src: string; linked: boolean }) {
  const c = useApi<any>(`/cases/${src}/case`);
  const dc = useApi<DashData>(`/cases/${src}/dashcam`);
  const an = useApi<any>(`/cases/${src}/analysis`);
  const ins = useApi<Finding[]>(`/cases/${src}/insights`);
  if (!c.data || !dc.data || !an.data) return <Loading error={c.error ?? dc.error ?? an.error} />;
  const names = an.data.entities?.names ?? {};
  return (
    <ClockProvider key={src} range={c.data.range}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold">Dashcam</h1>
            <p className="text-sm text-muted">{linked ? "Dashcam clip of this crash, analysed as a linked case. " : ""}{c.data.camera?.why ?? "Camera inside a vehicle."} Distances and speeds are ±30%.</p>
          </div>
          {linked && <Link to={`/case/${src}`} className="text-sm font-semibold text-accent">Open the dashcam case →</Link>}
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Panel title="Footage"><Footage src={`/api/cases/${src}/file/cctv.mp4`} t0={c.data.t0_video_s} /></Panel>
          <LiveDriver dc={dc.data} names={names} ego={(names[an.data.entities?.primary] ?? "Camera vehicle").replace(" (primary)", "")} />
        </div>
        <Controls />
        <Panel title="Key findings"><KeyFindings findings={ins.data ?? []} /></Panel>
      </div>
    </ClockProvider>
  );
}

// The radar of what was ahead, drawn at the shared playhead, so it moves with the footage.
function LiveDriver({ dc, names, ego }: { dc: DashData; names: Record<string, string>; ego: string }) {
  const { t } = useClock();
  return <Panel title="Driver's view"><div className="h-[460px]"><DriverView dc={dc} t={t} names={names} egoName={ego} /></div></Panel>;
}

function AddClip({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const [ego, setEgo] = useState("car");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function send(f: File) {
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.append("video", f); fd.append("ego_class", ego);
    const r = await fetch(`/api/cases/${caseId}/dashcam`, { method: "POST", body: fd });
    setBusy(false);
    if (!r.ok) { setErr(`Upload refused (${r.status})`); return; }
    onDone();
  }
  return (
    <Panel title="Dashcam">
      <h2 className="text-2xl font-bold">No dashcam footage for this crash yet</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">Add a clip filmed from inside a vehicle at this crash (a car's dashcam, a rider's helmet camera). It's hashed into the custody ledger, analysed with the dashcam pipeline (own speed from the road, distance and time-to-collision to the hazard, reaction time) and linked here.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm">Camera is in a
          <select aria-label="Camera vehicle" value={ego} onChange={(e) => setEgo(e.target.value)} className="ml-2 border px-2 py-1 text-sm"><option value="car">car</option><option value="motorcycle">motorcycle</option><option value="bus">bus</option><option value="truck">truck</option></select>
        </label>
        <label className={`flex cursor-pointer items-center gap-2 bg-ink px-4 py-2 text-sm font-semibold text-white ${busy ? "opacity-50" : ""}`}>
          <Upload size={15} />{busy ? "Uploading…" : "Add a dashcam clip"}
          <input type="file" accept="video/*" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
        </label>
        <Link to="/dashcam" className="flex items-center gap-1.5 text-sm font-semibold text-accent"><Camera size={15} />See every dashcam case</Link>
      </div>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
    </Panel>
  );
}

function Processing({ job }: { job: string }) {
  const [j, setJ] = useState<any>(null);
  useEffect(() => {
    const h = setInterval(() => fetch(`/api/jobs/${job}`).then((r) => (r.ok ? r.json() : null)).then((x) => { setJ(x); if (x && x.status !== "running") location.reload(); }), 2500);
    return () => clearInterval(h);
  }, [job]);
  const st = j?.stages ?? {};
  return (
    <Panel title="Dashcam · analysing">
      <p className="text-sm">The clip is running through the dashcam pipeline. This takes about two minutes.</p>
      <ol className="mt-3 grid grid-cols-2 gap-1 text-xs md:grid-cols-4">{Object.entries(st).map(([k, v]: any) => <li key={k} className={v.status === "done" ? "text-ok" : v.status === "running" ? "font-semibold text-accent" : "text-muted"}>{v.status === "done" ? "✓" : "·"} {k}</li>)}</ol>
    </Panel>
  );
}

export default function DashcamPage() {
  const { id } = useParams();
  const [n, setN] = useState(0);
  const c = useApi<any>(`/cases/${id}/case?n=${n}`);
  const [jobDone, setJobDone] = useState<boolean | null>(null);
  const linked: string | undefined = c.data?.dashcam_case;
  useEffect(() => {
    if (!linked) return;
    fetch(`/api/jobs/${linked}`).then((r) => (r.ok ? r.json() : null)).then((j) => setJobDone(!j || j.status !== "running"));
  }, [linked]);
  if (!c.data) return <Loading error={c.error} />;
  if (c.data.camera?.type === "dashcam") return <Viewer src={id!} linked={false} />;
  if (linked && jobDone === false) return <Processing job={linked} />;
  if (linked && jobDone) return <Viewer src={linked} linked />;
  if (linked) return <Loading />;
  return <AddClip caseId={id!} onDone={() => setN((x) => x + 1)} />;
}

/* Every dashcam case, wherever you are. */
export function DashcamIndex() {
  const d = useApi<any>("/dashboard");
  const cases = (d.data?.cases ?? []).filter((c: any) => c.camera === "dashcam");
  return (
    <div className="mx-auto h-full max-w-6xl overflow-auto p-8">
      <Link to="/" className="text-xs text-muted hover:text-ink">← Command centre</Link>
      <h1 className="mt-1 text-3xl font-bold">Dashcam</h1>
      <p className="text-sm text-muted">Every case filmed from inside a vehicle, detected automatically. Any case can also take a dashcam clip from its Dashcam tab.</p>
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cases.map((c: any) => (
          <Link key={c.id} to={`/case/${c.id}/dashcam`} className="block border border-ink bg-panel transition hover:border-accent">
            {c.thumb ? <img src={`/api/cases/${c.id}/${c.thumb}`} alt="" className="aspect-video w-full object-cover" /> : <video src={`/api/cases/${c.id}/file/cctv.mp4`} muted preload="metadata" className="aspect-video w-full bg-black object-cover" />}
            <div className="p-4"><div className="font-semibold">{c.title}</div><div className="text-xs text-muted">{c.location || "Location not set"}</div></div>
          </Link>
        ))}
        {d.data && !cases.length && <p className="text-sm text-muted">No dashcam cases yet. Run the dashcam demo kit from the home page.</p>}
      </div>
    </div>
  );
}
