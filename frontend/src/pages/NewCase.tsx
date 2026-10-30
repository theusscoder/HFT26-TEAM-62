import { useState } from "react";
import { useNavigate } from "react-router-dom";

// OWNER: P3. Drag-drop evidence → upload (hashed server-side) → live pipeline stages over WebSocket.
const STAGES = ["hash", "video", "plates", "sensor", "witness", "fusion", "contradictions", "severity", "report"];

export default function NewCase() {
  const nav = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Record<string, string>>({});
  const caseId = "demo"; // TODO(P2/P3): POST /api/cases to create a new id

  async function run() {
    for (const f of files) {
      const fd = new FormData(); fd.append("file", f);
      const r = await fetch(`/api/cases/${caseId}/evidence`, { method: "POST", body: fd });
      const j = await r.json(); setHashes((h) => ({ ...h, [f.name]: j.sha256 }));
    }
    const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws/cases/${caseId}/run`);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.stage === "all") nav(`/case/${caseId}`);
      else setStage((s) => ({ ...s, [d.stage]: d.status }));
    };
  }

  return (
    <div className="mx-auto max-w-3xl p-10">
      <h1 className="text-2xl font-bold">New case</h1>
      <label onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); setFiles([...files, ...Array.from(e.dataTransfer.files)]); }}
        className="mt-6 flex h-40 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-line bg-panel text-sm text-muted">
        Drop CCTV / dashcam video, sensor CSV, witness statements
        <input type="file" multiple className="hidden" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
      </label>
      <ul className="mt-4 space-y-1 text-sm">
        {files.map((f) => (
          <li key={f.name} className="flex justify-between"><span>{f.name}</span>
            <span className="mono text-xs text-muted">{hashes[f.name] ? `sha256 ${hashes[f.name].slice(0, 16)}…` : ""}</span></li>
        ))}
      </ul>
      <button onClick={run} className="mt-6 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Analyse</button>
      <ol className="mt-8 grid grid-cols-3 gap-2">
        {STAGES.map((s) => (
          <li key={s} className={`rounded-lg border px-3 py-2 text-sm ${stage[s] === "done" ? "border-ok/50 text-ok" : stage[s] ? "border-accent text-ink" : "border-line text-muted"}`}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
