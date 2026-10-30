import { useEffect, useRef, useState } from "react";
import { ScanFace } from "lucide-react";
import { useApi } from "../lib/api";
import { Panel } from "./ui";

// Faces the footage holds, and a one-to-one check of a consented photo against them. Never an identification.
// Live camera: grab a still as a JPEG file, so it goes through the same routes as an uploaded one.
function Camera({ onShot, label }: { onShot: (f: File) => void; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => () => { (video.current?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop()); }, []);
  async function start() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" } });
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
      setOn(true); setErr(null);
    } catch (e) { setErr("Camera unavailable or permission denied."); }
  }
  function shoot() {
    const v = video.current!;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => b && onShot(new File([b], `camera-${Date.now()}.jpg`, { type: "image/jpeg" })), "image/jpeg", 0.92);
  }
  return (
    <div className="mt-2">
      <video ref={video} muted playsInline className={on ? "w-full border border-ink bg-black" : "hidden"} />
      {!on ? <button onClick={start} className="w-full border border-ink py-2 text-sm font-semibold hover:bg-panel-2">Use the camera</button>
        : <button onClick={shoot} className="mt-1 w-full bg-ink py-2 text-sm font-semibold text-white">{label}</button>}
      {err && <p className="mt-1 text-xs text-bad">{err}</p>}
    </div>
  );
}

export default function FaceCheck({ caseId }: { caseId: string }) {
  const [v, setV] = useState(0);
  const f = useApi<any>(`/cases/${caseId}/faces?v=${v}`);
  const [adding, setAdding] = useState(false);
  async function addSource(file: File) {
    setAdding(true);
    const fd = new FormData(); fd.append("file", file);
    await fetch(`/api/cases/${caseId}/faces/evidence`, { method: "POST", body: fd });
    setAdding(false); setV((x) => x + 1); setRes(null);
  }
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [preview, setPreview] = useState<string | null>(null);
  async function check(file: File) {
    setBusy(true); setRes(null); setPreview(URL.createObjectURL(file));
    const fd = new FormData(); fd.append("photo", file); fd.append("consent", String(consent));
    const r = await fetch(`/api/cases/${caseId}/faces/compare`, { method: "POST", body: fd });
    setRes(r.ok ? await r.json() : { status: "error", reason: `Refused (${r.status})` });
    setBusy(false);
  }
  const label: Record<string, string> = { similar: "Similar face in the footage", not_similar: "No similar face in the footage", inconclusive: "Inconclusive", not_comparable: "Can't compare", unavailable: "Face models not installed", error: "Error" };
  return (
    <Panel title="Face check" right={<span className="flex items-center gap-1 text-xs text-claimed"><ScanFace size={13} />one-to-one, never an identification</span>}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="text-xs text-muted">Faces found in this case's footage{f.data ? `: ${f.data.usable} usable in ${f.data.frames_scanned} frames scanned` : ""}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {f.data?.faces?.map((x: any) => <figure key={x.id} className="w-20"><img src={`/api/cases/${caseId}/faces/${x.file}`} alt="Face crop from the footage" className="h-20 w-20 rounded-lg object-cover" /><figcaption className="mono mt-0.5 text-[10px] text-muted">{x.t != null ? `T${x.t >= 0 ? "+" : ""}${x.t}s` : x.source} · {Math.round(x.size_px)}px</figcaption></figure>)}
            {f.data && !f.data.faces?.length && <p className="text-sm text-muted">None clear enough to use. Street CCTV usually can't see faces; a closer camera can.</p>}
          </div>
          <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-observed/60 py-2.5 text-sm text-observed transition hover:bg-observed/10">
            {adding ? "Adding and scanning…" : "Add a frame or clip where faces are visible"}
            <input type="file" accept="image/*,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && addSource(e.target.files[0])} />
          </label>
          <p className="mt-1 text-[11px] text-muted">Dashcam, phone or toll-camera footage of the scene. It's hashed into the custody ledger as evidence.</p>
          <Camera label="Capture a frame as scene evidence" onShot={addSource} />
          <div className="hidden">
            {!f.data && <p className="text-sm text-muted">Scanning the footage…</p>}
          </div>
        </div>
        <div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />The person in the photo agreed to it being used</label>
          <label className={`mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed py-3 text-sm transition ${consent ? "border-claimed/60 text-claimed hover:bg-claimed/10" : "pointer-events-none border-line text-muted opacity-50"}`}>
            <ScanFace size={16} />{busy ? "Checking…" : "Choose a photo to compare"}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} />
          </label>
          {res && (
            <div className={`mt-3 rounded-lg border p-3 text-sm ${res.status === "similar" ? "border-warn/50 bg-warn/10" : "border-line bg-panel-2/60"}`}>
              <div className="font-semibold">{label[res.status] ?? res.status}</div>
              <div className="mt-2 flex items-center gap-3">
                {preview && <img src={preview} alt="Photo being checked" className="h-16 w-16 rounded object-cover" />}
                {res.best && <img src={`/api/cases/${caseId}/faces/${res.best.file}`} alt="Closest face in the footage" className="h-16 w-16 rounded object-cover" />}
                {res.best && <div className="flex-1"><div className="relative h-2 rounded-full bg-panel"><div className="absolute inset-y-0 left-0 rounded-full bg-claimed" style={{ width: `${Math.max(0, res.best.similarity) * 100}%` }} /><div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `${res.threshold * 100}%` }} /></div><div className="mono mt-1 text-[10px] text-muted">cosine {res.best.similarity}, model threshold {res.threshold}</div></div>}
              </div>
              <p className="mt-2 text-xs text-muted">{res.reason}</p>
            </div>
          )}
          {consent && <Camera label="Capture a photo to compare" onShot={check} />}
          <p className="mt-2 text-[11px] text-muted">The photo is checked against this case only and isn't kept. Each check is logged in the custody ledger. To try it end to end: capture your face as scene evidence on the left, then capture yourself again here.</p>
        </div>
      </div>
    </Panel>
  );
}
