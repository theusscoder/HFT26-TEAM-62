import { useState } from "react";
import { ScanFace, ShieldAlert } from "lucide-react";
import { post, useApi } from "../lib/api";
import { Panel } from "./ui";

// The toll database's record for the plate this case read, and a notification only a named officer can send.
function Capture({ m, caseId, authorities, caveat, startOpen }: { m: any; caseId: string; authorities: string[]; caveat: string; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [officer, setOfficer] = useState("");
  const [authority, setAuthority] = useState(authorities[0]);
  const [reviewed, setReviewed] = useState(false);
  const [sent, setSent] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  async function send() {
    setErr(null);
    try { setSent(await post(`/cases/${caseId}/toll-match/notify`, { capture_id: m.id, officer, authority, reviewed })); }
    catch (e) { setErr(String(e)); }
  }
  const [face, setFace] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [photoV, setPhotoV] = useState(0);
  const [consent, setConsent] = useState(false);
  async function faceCheck() {
    setChecking(true);
    try { setFace(await post(`/cases/${caseId}/toll-match/${m.id}/face-check`, {})); } catch (e) { setFace({ status: "error", reason: String(e) }); } finally { setChecking(false); }
  }
  async function upload(file: File) {
    const fd = new FormData(); fd.append("photo", file); fd.append("consent", String(consent));
    const r = await fetch(`/api/toll-captures/${m.id}/photo`, { method: "POST", body: fd });
    if (r.ok) { const rec = await r.json(); m.driver_image = rec.driver_image; setPhotoV((v) => v + 1); setFace(null); } else setFace({ status: "error", reason: `Upload refused (${r.status})` });
  }
  const rows: [string, string][] = [["Booth", `${m.plaza}, lane ${m.lane}`], ["Time", m.time], ["Vehicle", `${m.colour} ${m.class}`], ["FASTag", m.fastag], ["Registered to", m.owner], ["Contact", m.contact]];
  if (!open) return (
    <button onClick={() => setOpen(true)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-left text-sm hover:border-accent">
      <span className="mono tracking-widest">{m.plate}</span>
      <span className="text-xs text-muted">{m.colour} {m.class} · {m.plaza} · {m.exact ? "exact match" : `fits ${m.searched}`}</span>
    </button>
  );
  return (
    <div className="grid gap-4 rounded-lg border border-line bg-panel-2 p-3 md:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]">
      <figure>
        <img src={`/api/toll-images/${m.driver_image}?v=${photoV}`} alt="Toll booth driver photo" className="w-full rounded-lg" />
        <figcaption className="mt-1 text-[10px] text-muted">{"Booth camera · lane capture"}</figcaption>
        <button onClick={faceCheck} disabled={checking} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-claimed/50 py-1.5 text-xs font-semibold text-claimed transition hover:bg-claimed/10 disabled:opacity-40"><ScanFace size={13} />{checking ? "Checking…" : "Face check"}</button>
        <label className="mt-2 flex items-start gap-1.5 text-[10px] text-muted"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />This person agreed to be in the demo</label>
        <label className={`mt-1 block cursor-pointer rounded border border-dashed border-line py-1 text-center text-[10px] ${consent ? "text-muted hover:text-ink" : "pointer-events-none opacity-40"}`}>Replace photo<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
      </figure>
      <div>
        <div className="mono text-xl tracking-widest">{m.plate}</div>
        {face && (
          <div className={`mt-2 rounded-lg border p-2 text-xs ${face.status === "similar" ? "border-warn/50 bg-warn/10" : "border-line bg-panel"}`}>
            <div className="font-semibold">{{ similar: "Similar face in the footage", not_similar: "No similar face in the footage", inconclusive: "Inconclusive", not_comparable: "Can't compare", unavailable: "Face models not installed", error: "Error" }[face.status as string] ?? face.status}</div>
            {face.best && <div className="mt-2 flex items-center gap-2">
              <img src={`/api/cases/${caseId}/faces/${face.best.file}`} alt="Face from the footage" className="h-14 w-14 rounded object-cover" />
              <div className="flex-1"><div className="relative h-2 rounded-full bg-panel-2"><div className="absolute inset-y-0 left-0 rounded-full bg-claimed" style={{ width: `${Math.max(0, face.best.similarity) * 100}%` }} /><div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `${face.threshold * 100}%` }} title="model threshold" /></div>
                <div className="mono mt-1 text-[10px] text-muted">cosine {face.best.similarity} · threshold {face.threshold} · T{face.best.t >= 0 ? "+" : ""}{face.best.t}s</div></div>
            </div>}
            <p className="mt-1 text-muted">{face.reason}</p>
            <p className="mt-1 text-[10px] text-muted">One-to-one check against this record only. Never an identification.</p>
          </div>
        )}
        <div className="mt-0.5 text-[11px] text-muted">{m.exact ? "exact match" : `fits the partial read ${m.searched}`}</div>
        <dl className="mt-2 space-y-1 text-xs">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd></div>)}</dl>
      </div>
      <div className="space-y-2 text-sm">
        {sent ? (
          <div className="rounded-lg border border-ok/40 bg-ok/10 p-3 text-sm">
            <div className="font-semibold text-ok">{sent.status === "simulated" ? "Simulated: nothing was actually sent" : `Notification ${sent.status}`}</div>
            <p className="mt-1 text-xs text-muted">To {sent.to}. Logged in the custody ledger.</p>
          </div>
        ) : <>
          <p className="text-xs text-warn">{caveat}</p>
          <select aria-label="Authority to notify" value={authority} onChange={(e) => setAuthority(e.target.value)} className="w-full rounded border border-line bg-panel px-2 py-1.5 text-xs">
            {authorities.map((a) => <option key={a}>{a}</option>)}
          </select>
          <input aria-label="Officer name" placeholder="Reviewing officer's name" value={officer} onChange={(e) => setOfficer(e.target.value)} className="w-full rounded border border-line bg-panel px-2 py-1.5 text-xs" />
          <label className="flex items-start gap-2 text-xs text-muted"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} className="mt-0.5" />I've checked this record against the footage.</label>
          <button disabled={!officer.trim() || !reviewed} onClick={send} className="w-full rounded-lg bg-bad py-2 text-sm font-semibold text-white disabled:opacity-40">Notify authorities</button>
          {err && <p className="text-xs text-bad">{err}</p>}
        </>}
      </div>
    </div>
  );
}

export default function TollCapture({ caseId }: { caseId: string }) {
  const r = useApi<any>(`/cases/${caseId}/toll-match`);
  if (!r.data) return null;
  const d = r.data;
  return (
    <Panel title="Toll database" right={<span className="flex items-center gap-1 text-xs text-warn"><ShieldAlert size={12} />toll feed · FASTag</span>}>
      {d.searched.length === 0 && <p className="text-sm text-muted">No plate has been read for this case, so there's nothing to look up.</p>}
      {d.searched.length > 0 && d.matches.length === 0 && <p className="text-sm text-muted">Searched {d.searched.join(", ")}. No passage in the toll feed. Nothing is inferred from that.</p>}
      <div className="space-y-3">{[...d.matches].sort((a: any, b: any) => Number(b.exact) - Number(a.exact)).map((m: any, i: number) => <Capture key={m.id} m={m} caseId={caseId} authorities={d.authorities} caveat={d.caveat} startOpen={i === 0} />)}</div>
      <p className="mt-3 text-[11px] text-muted">{d.method}.</p>
    </Panel>
  );
}
