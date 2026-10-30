import { useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";

/* OWNER: P4. N1: upload ANY road video (+ optional witness statements, telematics CSV, demo-kit metadata), create a
   case, and watch the real pipeline run stage by stage. Files are sorted by type, so dropping a whole demo-kit
   folder's files at once just works. */

const STAGES: [string, string][] = [
  ["video", "Detect & track road users"], ["calibration", "Calibrate road (metres, km/h)"], ["vision", "Vision model on key frames"],
  ["sensor", "Telematics events"], ["witnesses", "Witness claims"], ["fusion", "Align, cross-check, contradictions"], ["severity", "Severity"], ["pursuit", "Who stayed, who left; read plates"], ["scene3d", "Solve the camera, build the 3D scene"],
];

export default function NewCase() {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [wit, setWit] = useState<File[]>([]);
  const [sensor, setSensor] = useState<File | null>(null);
  const [meta, setMeta] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [sim, setSim] = useState(false);
  const [job, setJob] = useState<any>(null);
  const [cid, setCid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function add(files: File[]) {
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (/\.(mp4|mov|avi|mkv|webm|m4v)$/.test(n)) setVideo(f);
      else if (/\.(txt|wav|mp3|m4a|ogg|flac|opus)$/.test(n)) setWit((w) => [...w.filter((x) => x.name !== f.name), f].sort((a, b) => a.name.localeCompare(b.name)));
      else if (n.endsWith(".csv")) setSensor(f);
      else if (n === "witnesses.json" || n === "ground_truth.json") setMeta((m) => [...m.filter((x) => x.name !== f.name), f]);
    }
  }

  async function start() {
    if (!video) return;
    setErr(null);
    const fd = new FormData();
    fd.append("video", video);
    wit.forEach((w) => fd.append("witnesses", w));
    if (sensor) fd.append("sensor", sensor);
    meta.forEach((m) => fd.append("meta", m));
    fd.append("title", title || video.name.replace(/\.[^.]+$/, ""));
    fd.append("location", location);
    fd.append("simulate_sensor", String(sim && !sensor));
    const r = await fetch("/api/cases", { method: "POST", body: fd });
    if (!r.ok) { setErr((await r.json()).detail ?? `upload failed (${r.status})`); return; }
    const { id } = await r.json();
    setCid(id);
    const ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/cases/${id}/run`);
    ws.onmessage = (m) => {
      const j = JSON.parse(m.data);
      setJob(j);
      if (j.status === "done") setTimeout(() => nav(`/case/${id}`), 900);
    };
  }

  const busy = !!cid && job?.status !== "error";
  return (
    <div className="mx-auto max-w-4xl p-10">
      <Link to="/" className="text-sm text-muted">← cases</Link>
      <h1 className="mt-2 text-2xl font-bold">New case</h1>
      <p className="mt-1 text-sm text-muted">Any road CCTV or dashcam clip works. Witness statements and a telematics log are optional; each one adds cross-checks.
        Ready-made sets are in <span className="mono">demo_kits/</span>: drop a whole folder's files here.</p>

      {!cid && (
        <>
          <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(Array.from(e.dataTransfer.files)); }} onClick={() => input.current?.click()}
            className="mt-6 flex h-36 cursor-pointer flex-col items-center justify-center  border border-dashed border-line bg-panel text-sm text-muted hover:border-accent">
            <span className="text-ink">Drop files or click to choose</span>
            <span className="mt-1 text-xs">video (.mp4 .mov .avi .mkv) · witness_*.txt or a Telugu/Hindi voice note (.wav .mp3 .m4a) · sensor.csv · witnesses.json · ground_truth.json</span>
            <input ref={input} type="file" multiple className="hidden" onChange={(e) => add(Array.from(e.target.files ?? []))} />
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            {[
              ["Video", video ? video.name : "required", !!video],
              ["Witness statements", wit.length ? wit.map((w) => w.name).join(", ") : "optional", wit.length > 0],
              ["Telematics", sensor ? sensor.name : "optional", !!sensor],
              ["Kit metadata", meta.length ? meta.map((m) => m.name).join(", ") : "optional (names, ground truth)", meta.length > 0],
            ].map(([k, v, ok]) => (
              <div key={k as string} className={`rounded-lg border px-4 py-3 text-sm ${ok ? "border-ok/40" : "border-line"}`}>
                <div className="text-xs uppercase tracking-wider text-muted">{k}</div>
                <div className={ok ? "text-ink" : "text-muted"}>{v}</div>
              </div>
            ))}
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Case title (optional)" className="rounded-lg border border-line bg-panel px-3 py-2 text-sm" />
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" className="rounded-lg border border-line bg-panel px-3 py-2 text-sm" />
          </div>
          {!sensor && <label className="mt-3 flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} />No telematics? Simulate one from the video track (clearly labelled as simulated)</label>}
          {err && <p className="mt-3 text-sm text-bad">{err}</p>}
          <button disabled={!video} onClick={start} className="mt-5 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40">Analyse</button>
        </>
      )}

      {cid && (
        <div className="mt-8  border border-line bg-panel p-5">
          <div className="flex items-center justify-between">
            <span className="mono text-sm">{cid}</span>
            <span className={`text-sm ${job?.status === "error" ? "text-bad" : job?.status === "done" ? "text-ok" : "text-muted"}`}>{job?.status ?? "starting…"}</span>
          </div>
          <ol className="mt-4 space-y-2">
            {STAGES.map(([k, label]) => {
              const s = job?.stages?.[k];
              const st = s?.status ?? "pending";
              return (
                <li key={k} className="flex items-center gap-3 text-sm">
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${st === "done" ? "bg-ok text-bg" : st === "running" ? "animate-pulse bg-accent text-white" : "bg-panel-2 text-muted"}`}>{st === "done" ? "✓" : ""}</span>
                  <span className={st === "pending" ? "text-muted" : ""}>{label}</span>
                  <span className="ml-auto truncate text-xs text-muted">{s?.detail}</span>
                </li>
              );
            })}
          </ol>
          {job?.status === "error" && <pre className="mt-4 overflow-auto rounded bg-bg p-3 text-[11px] text-bad">{job.error}</pre>}
          {busy && job?.status !== "done" && <p className="mt-4 text-xs text-muted">Video analysis takes about a minute on a laptop CPU.</p>}
        </div>
      )}
    </div>
  );
}
