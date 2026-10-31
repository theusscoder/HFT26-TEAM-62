import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { get, post, useApi, type Event } from "../lib/api";
import { useClock } from "../lib/clock";
import { claimStatus, salient, sentence, SOURCE_LABEL } from "../lib/story";
import { KindBadge, Loading, Panel } from "../components/ui";

/* Evidence replay: the annotated footage on the shared clock, with what every source says at this instant.
   While it plays, the culprit's and victim's number plates are detected on the footage (A2): each plate locks
   at its clearest frame, "Number detected" appears, and that party's profile card opens from the TS police DB.
   Once the culprit's plate is detected, alerts go out after a 5 s countdown (A3): the culprit's registered
   number + the police station, the victim's number + the hospitals. Statuses are shown on the cards. */

function SyncedVideo({ src, t0 }: { src: string; t0: number }) {
  const { t, playing } = useClock();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [playing]);
  useEffect(() => {
    const v = ref.current;
    if (v && Math.abs(v.currentTime - (t + t0)) > (playing ? 0.3 : 0.04)) v.currentTime = Math.max(0, t + t0);
  }, [t, t0, playing]);
  return <video ref={ref} src={src} muted playsInline className="h-full w-full rounded-lg bg-black object-contain" />;
}

/* Plate box that follows the vehicle: dashed "scanning" before its clearest frame, locked with the plate after. */
function PlateBoxes({ cards, W, H }: { cards: any[]; W: number; H: number }) {
  const { t } = useClock();
  return (
    <>
      {cards.filter((c) => c.detection && t >= c.detection.t - 1.5).map((c) => {
        const path: any[] = c.detection.path;
        let best = path[0], dist = Infinity;
        for (const p of path) { const d = Math.abs(p.t - t); if (d < dist) { dist = d; best = p; } }
        if (dist > 0.2) return null;
        const [x1, y1, x2, y2] = best.box;
        const locked = t >= c.detection.t;
        const col = c.kind === "culprit" ? "#ff5d5d" : "#f5b84f";
        return (
          <div key={c.track} className="pointer-events-none absolute transition-all duration-100"
            style={{ left: `${(x1 / W) * 100}%`, top: `${(y1 / H) * 100}%`, width: `${((x2 - x1) / W) * 100}%`, height: `${((y2 - y1) / H) * 100}%`,
              border: `2px ${locked ? "solid" : "dashed"} ${col}`, boxShadow: locked ? `0 0 12px ${col}` : undefined }}>
            <span className="mono absolute -top-6 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold"
              style={{ background: locked ? col : "rgba(0,0,0,.7)", color: locked ? "#0b0d10" : col }}>
              {locked ? `${c.kind === "culprit" ? "PERPETRATOR" : "VICTIM"} · ${c.legible && c.plate ? c.plate : "no plate read"}` : "reading plate…"}
            </span>
          </div>
        );
      })}
    </>
  );
}

function Tick({ s }: { s?: string | null }) {
  if (!s) return <span className="text-[11px] text-muted">pending</span>;
  if (s === "sent") return <span className="text-[11px] font-semibold text-ok">✓✓ delivered</span>;
  if (s === "simulated") return <span className="text-[11px] font-semibold text-sky-300">✓✓ sent (simulated)</span>;
  return <span className="text-[11px] font-semibold text-bad">✗ {s}</span>;
}

function fmtPhone(n?: string | null) {
  if (!n) return "—";
  const d = n.replace(/\D/g, "");
  return d.length === 12 && d.startsWith("91") ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : n;
}

/* Telegram-style notification as the recipient sees it. */
function TelegramBubble({ m }: { m: any }) {
  const time = m.at ? new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="rounded-xl border border-sky-500/30 bg-[#17212b] p-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold text-sky-300"><span className="grid h-5 w-5 place-items-center rounded-full bg-sky-500 text-[10px] text-white">✈</span>Telegram · YATHARTH Alerts</span>
        <span className="mono text-muted">to {fmtPhone(m.number)}</span>
      </div>
      <div className="rounded-lg rounded-tl-none bg-[#182533] px-3 py-2 text-[12px] leading-relaxed text-[#e9eef3]">
        <div className="font-semibold">{m.title}</div>
        <div className="mt-1 whitespace-pre-wrap text-[#c8d3dd]">{m.text}</div>
        <div className="mt-1 flex justify-end gap-2 text-[10px] text-muted">{time && <span>{time}</span>}<Tick s={m.status} /></div>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  full_read: "border-ok/60 text-ok", investigator_confirmed: "border-ok/60 text-ok", partial_read: "border-warn/60 text-warn",
  plate_detected_ocr_failed: "border-line text-muted", plate_not_detected: "border-line text-muted", insufficient_image_quality: "border-line text-muted",
};

function Plate({ plate }: { plate: string }) {
  return (
    <span className="mono rounded border-2 border-ink/80 bg-ink px-2 py-0.5 text-lg font-bold tracking-widest text-bg">
      {plate.split("").map((ch, i) => ch === "?" ? <span key={i} className="text-red-600">?</span> : <span key={i}>{ch}</span>)}
    </span>
  );
}

function Chip({ children, tone = "muted", title }: { children: any; tone?: "muted" | "bad" | "ok" | "warn" | "accent"; title?: string }) {
  const t = { muted: "border-line text-muted", bad: "border-bad/60 bg-bad/15 text-bad", ok: "border-ok/50 text-ok", warn: "border-warn/50 text-warn", accent: "border-accent/50 text-accent" }[tone];
  return <span title={title} className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] ${t}`}>{children}</span>;
}

function Delivery({ m }: { m: any }) {
  const [open, setOpen] = useState(false);
  if (!m) return null;
  return (
    <div className="text-[12px]">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <span>📱 Alert to <span className="mono">{fmtPhone(m.number)}</span></span>
        <span className="flex items-center gap-2">{m.status === "sent" && m.ms != null && <span className="text-[10px] text-muted">{(m.ms / 1000).toFixed(1)} s · {m.channel}</span>}<Tick s={m.status} /></span>
      </button>
      {open && <div className="mt-1"><TelegramBubble m={m} /></div>}
    </div>
  );
}

/* One compact card per party. Key facts as tags; evidence and verification behind "Details". */
function RoleCard({ c, kind, id, onConfirm, extra }: { c: any; kind: "culprit" | "victim"; id: string; onConfirm: (t: string, r: string | null) => void; extra?: any }) {
  const a = c.anpr ?? {}, ev = a.evidence ?? {}, vd = a.vehicle_details ?? {}, q = a.quality ?? {};
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  useEffect(() => { if (a.best_reading && !val) setVal(String(a.best_reading).replace(/\?/g, "")); }, [a.best_reading]);
  const reg = a.confirmed_registration || a.best_reading;
  const facts = (a.plate_info ?? []).filter((i: any) => i.field !== "Plate layout");
  const tone = kind === "culprit" ? "border-bad/50" : "border-warn/50";
  return (
    <div className={`space-y-2.5 rounded-xl border-2 ${tone} bg-panel p-3.5`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className={`text-[11px] font-bold uppercase tracking-wider ${kind === "culprit" ? "text-bad" : "text-warn"}`}>
            {kind === "culprit" ? "Perpetrator" : "Victim"} <span className="font-normal normal-case text-muted">· proposed</span>
          </div>
          <div className="text-sm font-semibold">{a.vehicle_label ? `${a.vehicle_label} · ` : ""}{[vd.colour ?? c.colour, (vd.category ?? c.type ?? "").toLowerCase()].filter(Boolean).join(" ")}</div>
        </div>
        {a.status_label && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[a.registration_status] ?? "border-line"}`}>{a.status_label}</span>}
      </div>

      {c.type !== "person" && (
        <div className="flex items-center gap-3">
          {ev.plate_fused || ev.plate_crop ? <img src={`/api/cases/${id}/file/${ev.plate_fused || ev.plate_crop}`} alt="plate" className="h-16 rounded border border-line object-contain" title={ev.plate_fused ? `${ev.plate_fused_frames} frames fused` : "plate crop"} /> : null}
          <div className="min-w-0">
            {reg ? <Plate plate={reg} /> : <span className="text-sm text-warn">Number not read</span>}
            <div className="mt-1 text-[10px] text-muted">{a.confirmed_registration ? "investigator-confirmed" : reg ? "OCR candidate · unverified" : "verify from the plate image"}</div>
          </div>
        </div>
      )}
      {c.type === "person" && <p className="text-[12px] text-muted">{c.note}</p>}

      <div className="flex flex-wrap gap-1.5">
        {facts.map((i: any) => <Chip key={i.field} tone="accent" title={`${i.level} · ${i.basis}`}>{i.value.replace(" / transport vehicle (yellow plate)", "").replace(" (yellow plate)", "")}</Chip>)}
        {c.speed_kmh != null && <Chip>{c.speed_kmh} km/h</Chip>}
        {vd.direction && <Chip>{vd.direction}</Chip>}
        {(c.challans ?? []).map((ch: any) => <Chip key={ch.section} tone="bad" title={`${ch.offence} · ${ch.basis} · ${ch.status}`}>{ch.section} · {ch.amount}</Chip>)}
      </div>

      <div className="space-y-1 border-t border-line pt-2">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted">☎ <span className="mono text-ink">{fmtPhone(c.contact)}</span></span>
          <span className="text-[10px] text-muted">{(c.reach ?? []).length ? `✓ ${c.reach.join(" + ")}` : c.tg_link ? <>link phone: <a href={`https://${c.tg_link}`} target="_blank" className="text-accent underline">{c.tg_link}</a></> : "no live channel yet"}</span>
        </div>
        {(c.telegram ?? []).map((m: any) => <Delivery key={m.to} m={m} />)}
        {extra}
      </div>

      <button onClick={() => setOpen(!open)} className="text-[11px] text-accent">{open ? "▾ Hide details" : "▸ Details & verification"}</button>
      {open && (
        <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 p-2.5 text-[11px]">
          {ev.vehicle_crop && <img src={`/api/cases/${id}/file/${ev.vehicle_crop}`} alt="vehicle" className="h-24 rounded border border-line object-contain" />}
          {a.reason && <div className="text-warn">{a.reason}</div>}
          {a.raw_reads?.length > 0 && <div><span className="text-muted">Raw OCR: </span><span className="mono">{a.raw_reads.slice(0, 6).join(" · ")}</span></div>}
          {a.candidate_registrations?.length > 0 && <div><span className="text-muted">Candidates (unverified): </span>{a.candidate_registrations.map((x: string) => <button key={x} onClick={() => onConfirm(c.track, x)} className="mono mr-1 text-claimed underline">{x}</button>)}</div>}
          <div className="text-muted">Seen {ev.first_seen} → {ev.last_seen} · plate {q.plate_detection} · OCR {q.ocr_confidence != null ? Math.round(q.ocr_confidence * 100) + "%" : "—"} · {q.frames_with_reading ?? 0} frame(s) · class {q.classification_confidence ?? "—"}</div>
          <div className="text-muted">{a.matching_note} · {a.verification_status}</div>
          {c.type !== "person" && (
            <div className="flex gap-1.5 pt-1">
              <input value={val} onChange={(e) => setVal(e.target.value.toUpperCase())} placeholder="verified number" className="mono flex-1 rounded border border-line bg-panel px-2 py-1" />
              <button onClick={() => val && onConfirm(c.track, val)} className="rounded border border-ok/50 px-2 text-ok">Confirm</button>
              {a.confirmed_registration && <button onClick={() => onConfirm(c.track, null)} className="rounded border border-line px-2 text-muted">Clear</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Small incident map: alerted hospitals (green), police (blue) and checkpoints (amber) are highlighted. */
function IncidentMap({ m }: { m: any }) {
  if (!m?.incident) return null;
  const inc: [number, number] = [m.incident.lat, m.incident.lon];
  const pts = [...m.hospitals.map((h: any) => ({ ...h, kind: "hospital" })), ...m.police.map((p: any) => ({ ...p, kind: "police" })),
    ...m.checkpoints.filter((c: any) => c.lat != null).map((c: any) => ({ ...c, kind: "checkpoint" }))];
  const col: Record<string, string> = { hospital: "#3ecf8e", police: "#4f8cff", checkpoint: "#f5b84f" };
  return (
    <Panel title="Incident map · responders alerted" right={<span className="text-[11px] text-muted">{m.incident.name}{m.incident.assumed ? " (assumed location)" : ""}</span>}>
      <div className="h-[300px] overflow-hidden rounded-lg">
        <MapContainer center={inc} zoom={12} className="h-full w-full" scrollWheelZoom={false}>
          <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap" />
          {pts.filter((p: any) => p.alerted).map((p: any) => <Polyline key={"l" + p.kind + p.name} positions={[inc, [p.lat, p.lon]]} pathOptions={{ color: col[p.kind], weight: 1.5, dashArray: "4 6" }} />)}
          {pts.map((p: any) => (
            <CircleMarker key={p.kind + p.name} center={[p.lat, p.lon]} radius={p.alerted ? 9 : 5}
              pathOptions={{ color: col[p.kind], fillColor: col[p.kind], fillOpacity: p.alerted ? 0.85 : 0.15, weight: p.alerted ? 3 : 1 }}>
              <Tooltip>{p.kind === "hospital" ? "🚑" : p.kind === "police" ? "🚓" : "🛑"} {p.name}{p.dist_km != null ? ` · ${p.dist_km} km` : ""}{p.eta_min != null && p.kind !== "checkpoint" ? ` · ETA ${p.eta_min} min` : ""} · {p.alerted ? "ALERTED" : "not alerted yet"}</Tooltip>
            </CircleMarker>
          ))}
          <CircleMarker center={inc} radius={11} pathOptions={{ color: "#ff5d5d", fillColor: "#ff5d5d", fillOpacity: 0.9 }}><Tooltip permanent>Accident</Tooltip></CircleMarker>
        </MapContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
        <span><b className="text-ok">●</b> hospitals ({m.hospitals.filter((h: any) => h.alerted).length}/{m.hospitals.length} alerted)</span>
        <span><b className="text-accent">●</b> police station</span><span><b className="text-warn">●</b> toll checkpoints</span>
        <span>filled = alerted · approximate coordinates</span>
      </div>
    </Panel>
  );
}

function Toasts({ items, onClose }: { items: any[]; onClose: () => void }) {
  if (!items.length) return null;
  return (
    <div className="fixed right-4 top-4 z-50 w-[360px] space-y-2">
      {items.map((m, i) => (
        <div key={i} className="animate-[fadein_.3s_ease] rounded-2xl border border-sky-500/40 bg-[#17212b]/95 p-3 shadow-2xl backdrop-blur" style={{ animationDelay: `${i * 0.4}s` }}>
          <div className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1.5 font-semibold text-sky-300"><span className="grid h-5 w-5 place-items-center rounded-full bg-sky-500 text-[10px] text-white">✈</span>Telegram · now</span>
            <span className="mono text-muted">{fmtPhone(m.number)}</span>
          </div>
          <div className="mt-1 text-[12px] font-semibold text-[#e9eef3]">{m.title}</div>
          <div className="mt-0.5 line-clamp-3 text-[11px] text-[#c8d3dd]">{m.text}</div>
          <div className="mt-1 text-right"><Tick s={m.status} /></div>
        </div>
      ))}
      <button onClick={onClose} className="w-full rounded-lg border border-line bg-panel/90 py-1 text-[11px] text-muted">dismiss</button>
    </div>
  );
}

function Waiting({ label, t, onJump }: { label: string; t?: number; onJump?: () => void }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
      <div className="mono text-xs">Number detected: <span className="tracking-widest">— — — —</span></div>
      <div>{label} profile opens at {t != null && t < 0 ? `plate read (T${t}s)` : "impact (T+0 s)"}.</div>
      {onJump && <button onClick={onJump} className="rounded border border-line px-2 py-0.5 text-xs hover:border-accent">Jump there</button>}
    </div>
  );
}

const ORDER: Record<string, number> = { INFERRED: 0, OBSERVED: 1, CLAIMED: 2 };

export default function Replay() {
  const { id } = useParams();
  const { t, seek, toggle, playing, range } = useClock();
  const c = useApi<any>(`/cases/${id}/case`);
  const events = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<any>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const [raw, setRaw] = useState(false);
  const [sensor, setSensor] = useState<{ t: number; v: number }[] | null>(null);
  const [rs, setRs] = useState<any>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [sending, setSending] = useState(false);
  const [toasts, setToasts] = useState<any[]>([]);
  const offset = an.data?.offsets?.sensor?.offset_s ?? 0;
  useEffect(() => {
    fetch(`/api/cases/${id}/file/sensor.csv`).then((r) => (r.ok ? r.text() : Promise.reject())).then((txt) =>
      setSensor(txt.trim().split("\n").slice(1).map((l) => { const c = l.split(","); return { t: +(+c[0] + offset).toFixed(2), v: +c[1] }; }))).catch(() => setSensor(null));
  }, [id, offset]);

  // plate detections + profiles + notification status; refreshed every 5 s once alerts are out (tracking updates)
  const refresh = () => get<any>(`/response/${id}/replay`).then(setRs).catch(() => {});
  const confirmPlate = (track: string, registration: string | null) =>
    post<any>(`/response/${id}/confirm-plate`, { track, registration, by: "Investigator" }).then(setRs).catch(() => {});
  useEffect(() => { refresh(); }, [id]);
  useEffect(() => {
    if (!rs?.dispatched) return;
    const h = setInterval(refresh, 5000);
    return () => clearInterval(h);
  }, [id, rs?.dispatched]);

  const culprit = rs?.culprits?.[0];
  const victims: any[] = rs?.victims ?? [];
  const victim = victims.find((v) => v.type !== "person") ?? victims[0];
  const others = victims.filter((v) => v !== victim);
  // a party is "identified" at its plate read or at the impact itself, whichever comes first, so alerts always leave within seconds of T0
  const seen = (x: any) => !!x && (!x.detection || t >= Math.min(x.detection.t, 0));
  const culpritSeen = seen(culprit);

  // culprit plate read → 5 s countdown → dispatch (once per case; Cancel stops it)
  useEffect(() => {
    if (rs && culpritSeen && !rs.dispatched && !cancelled && countdown == null && !sending) setCountdown(2);  // T0 (or earlier plate read) + 2 s countdown + ~1 s delivery: inside 10 s of the incident
  }, [culpritSeen, rs?.dispatched, cancelled]);
  const send = () => {
    setCountdown(null); setSending(true);
    post<any>(`/response/${id}/dispatch`, { ids: rs.dispatch_ids, officer: "Duty officer (replay)" })
      .then(() => get<any>(`/response/${id}/replay`))
      .then((fresh) => {
        setRs(fresh);
        setToasts([...(fresh.culprits ?? []), ...(fresh.victims ?? [])].flatMap((x: any) => x.telegram ?? []));
        setTimeout(() => setToasts([]), 12000);
      })
      .finally(() => setSending(false));
  };
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) { send(); return; }
    const h = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(h);
  }, [countdown]);

  if (!c.data || !events.data) return <Loading error={c.error ?? events.error} />;

  const ent = an.data?.entities;
  const t0 = c.data.t0_video_s ?? 0;
  const W = c.data.video?.width ?? 1280, H = c.data.video?.height ?? 720;
  const cards = [culprit, victim].filter(Boolean);
  const active = events.data
    .filter((e) => (raw || salient(e, ent)) && t >= e.t.start - 0.25 && t <= e.t.end + 0.25)
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.confidence - a.confidence)
    .slice(0, 12);

  return (
    <div className="flex flex-col gap-4">
      <Toasts items={toasts} onClose={() => setToasts([])} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Annotated footage · YOLO11 + ByteTrack · plate reading" right={<span className="mono text-xs text-muted">video {(t + t0).toFixed(2)} s</span>}>
          <div className="flex aspect-video w-full items-center justify-center">
            <div className="relative h-full max-w-full" style={{ aspectRatio: `${W} / ${H}` }}>
              <SyncedVideo src={`/api/cases/${id}/file/annotated.mp4`} t0={t0} />
              <PlateBoxes cards={cards} W={W} H={H} />
            </div>
          </div>
          {/* Number detected strip */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {cards.map((x: any) => (
              <div key={x.track} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${seen(x) ? (x.kind === "culprit" ? "border-bad/60 bg-bad/10" : "border-warn/60 bg-warn/10") : "border-line"}`}>
                <span className={`text-[11px] font-semibold uppercase ${x.kind === "culprit" ? "text-bad" : "text-warn"}`}>{x.kind === "culprit" ? "perpetrator" : "victim"}</span>
                <span className="text-sm">Number detected:</span>
                {seen(x) && x.legible && x.plate ? <><Plate plate={x.plate} />{x.partial && <span className="text-[10px] text-warn">partial</span>}</>
                  : seen(x) ? <span className="text-sm text-warn">no plate read</span>
                  : <span className="mono text-base tracking-widest text-muted">{x.detection && t >= x.detection.t - 1.5 ? "reading…" : "— — — —"}</span>}
              </div>
            ))}
            {rs?.dispatched && <span className="text-xs font-semibold text-ok">✓ Alerts sent: perpetrator + police + checkpoints, victim + hospitals</span>}
            {rs && !rs.channels?.telegram && <span className="text-[11px] text-warn">Telegram not linked: alerts are simulated (run link_telegram.bat)</span>}
          </div>
        </Panel>
        <Panel title="What the evidence says now" className="max-h-[620px] overflow-auto"
          right={<label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />raw</label>}>
          <ul className="space-y-2">
            {active.map((e) => {
              const st = e.kind === "CLAIMED" ? claimStatus(e, an.data) : undefined;
              return (
                <li key={e.id} className="rounded-lg border border-line bg-panel-2 p-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <KindBadge kind={e.kind} />
                    <span className="truncate text-[11px] text-muted">{SOURCE_LABEL(e.source, wit.data ?? {})}</span>
                    {st && <span className={`text-[10px] font-semibold uppercase ${st === "contradicted" ? "text-bad" : st === "consistent" ? "text-ok" : "text-muted"}`}>{st}</span>}
                  </div>
                  <div className="mt-1">{e.quote ? <span className="italic text-claimed">“{e.quote}”</span> : sentence(e, ent)}</div>
                  <div className="mono mt-1 text-[10px] text-muted">{e.ref || (e.derived_from?.length ? `from ${e.derived_from.slice(0, 3).join(", ")}` : "")} · {Math.round(e.confidence * 100)}%</div>
                </li>
              );
            })}
            {!active.length && <li className="text-sm text-muted">No evidence covers this instant.</li>}
          </ul>
        </Panel>
      </div>

      {rs && (culprit || victim) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {culprit ? (culpritSeen ? (
            <RoleCard c={culprit} kind="culprit" id={id!} onConfirm={confirmPlate} extra={<>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]"><span className="text-muted">Notified:</span>
                {(culprit.checkpoints ?? []).map((s: any) => <Chip key={s.to} tone={s.status ? "ok" : "muted"}>{s.kind === "police station" ? "🚓" : "🛑"} {s.to.replace(" checkpoint", "").replace(" Police Station", " PS").replace(" ORR Toll", "")}{s.status ? " ✓" : ""}</Chip>)}
              </div>
              {culprit.tracking && <div className="text-[11px]"><b className={culprit.tracking.active ? "text-bad" : ""}>{culprit.tracking.active ? "● Tracking" : "Tracking stopped"}</b>{culprit.tracking.last_seen ? ` · last seen ${culprit.tracking.last_seen.plaza} ${culprit.tracking.last_seen.time.slice(11, 16)}` : " · awaiting first sighting"}</div>}
            </>} />
          ) : <Waiting label="Perpetrator" t={culprit.detection?.t} onJump={() => seek(Math.min(culprit.detection.t, 0))} />) : <div />}
          {victim ? (seen(victim) ? (
            <RoleCard c={victim} kind="victim" id={id!} onConfirm={confirmPlate} extra={<>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]"><span className="text-muted">Hospitals:</span>
                {(victim.hospitals ?? []).map((h: any) => <Chip key={h.name} tone={h.status ? "ok" : "muted"} title={`${h.dist_km} km${h.govt ? " · govt" : ""}`}>🚑 {h.name.split(",")[0].replace(" Hospitals", "").replace(" (Govt)", " (G)")} {h.eta_min}′{h.status ? " ✓" : ""}</Chip>)}
              </div>
              {others.length > 0 && <div className="text-[11px] text-muted">Also at risk: {others.map((o) => o.name).join(", ")} (in hospital alert)</div>}
            </>} />
          ) : <Waiting label="Victim" t={victim.detection?.t} onJump={() => seek(Math.min(victim.detection.t, 0))} />) : <div />}
        </div>
      )}
      {countdown != null && (
        <div className="flex items-center justify-between rounded-lg border border-bad bg-bad/10 px-3 py-2 text-sm">
          <span className="font-semibold text-bad">Plates read · alerting both numbers, police & hospitals in {countdown}s</span>
          <span className="flex gap-2"><button onClick={send} className="rounded bg-bad px-2 py-0.5 text-xs font-semibold text-white">Send now</button>
            <button onClick={() => { setCountdown(null); setCancelled(true); }} className="rounded border border-line px-2 py-0.5 text-xs">Cancel</button></span>
        </div>
      )}
      {rs?.map && (culpritSeen || rs.dispatched) && <IncidentMap m={rs.map} />}
      {cancelled && !rs?.dispatched && (
        <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
          <span className="text-muted">Alerts cancelled by the officer.</span>
          <button onClick={() => { setCancelled(false); send(); }} className="rounded bg-bad px-3 py-1 text-xs font-semibold text-white">Send alerts now</button>
        </div>
      )}

      {sensor && (
        <Panel title="Telematics · speed km/h (aligned to impact)">
          <div className="h-[110px]">
            <ResponsiveContainer>
              <LineChart data={sensor}>
                <XAxis dataKey="t" type="number" domain={range} stroke="#8a93a0" fontSize={10} />
                <YAxis stroke="#8a93a0" fontSize={10} width={30} />
                <Line dataKey="v" dot={false} stroke="#4f8cff" isAnimationActive={false} />
                <ReferenceLine x={t} stroke="#e7eaee" />
                <ReferenceLine x={0} stroke="#ff5d5d" strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}
      <div className="sticky bottom-0 z-20 flex items-center gap-4  border border-line bg-panel/95 px-4 py-3 backdrop-blur">
        <button onClick={toggle} className="w-20 rounded-md bg-accent py-1.5 text-sm font-semibold text-white">{playing ? "Pause" : "Play"}</button>
        <button onClick={() => seek(0)} className="rounded-md border border-bad/50 px-3 py-1.5 text-xs text-bad">Jump to impact</button>
        <input type="range" min={range[0]} max={range[1]} step={0.05} value={t} onChange={(e) => seek(+e.target.value)} className="flex-1 accent-[#4f8cff]" />
        <span className="mono w-24 text-right text-sm">T{t >= 0 ? "+" : ""}{t.toFixed(2)} s</span>
      </div>
    </div>
  );
}
