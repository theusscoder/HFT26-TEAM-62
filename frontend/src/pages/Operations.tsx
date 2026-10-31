import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { AnimatePresence, motion } from "framer-motion";
import { Box, Camera, Check, ChevronRight, Grid3x3, Pause, Play, Radio, RotateCcw, SkipForward } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading } from "../components/ui";

/* The home page: one incident at a time, as it unfolds. The vehicles come in and collide; the vision agent names the victim;
   the records agent pulls plate, registration and licence; every nearby hospital lights up blue and every patrol heading in
   lights up red; the ambulance routes to the victim; if the other vehicle fled, the intercept agents hold signals and close
   in until it's stopped. Then the next incident. */
const T_NOTIFY = 31;
const FAST = 6;
const LEVEL: Record<string, string> = { L0: "#8a8a85", L1: "#22c55e", L2: "#f59e0b", L3: "#ff2a2a" };
const AGENT: Record<string, string> = { Vision: "#a78bfa", Records: "#38bdf8", Alerts: "#38bdf8", Dispatch: "#f59e0b", Tracker: "#ff2a2a", Planner: "#ff2a2a", Signal: "#22c55e" };

function at(keys: number[][], t: number): [number, number] | null {
  if (!keys?.length) return null;
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  if (t >= keys[keys.length - 1][0]) return [keys[keys.length - 1][1], keys[keys.length - 1][2]];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m][0] <= t) lo = m; else hi = m; }
  const a = keys[lo], b = keys[hi], k = (t - a[0]) / (b[0] - a[0] || 1);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
const trail = (keys: number[][], t: number) => { const p = at(keys, t); return [...keys.filter((k) => k[0] <= t).map((k) => [k[1], k[2]] as [number, number]), ...(p ? [p] : [])]; };
const ahead = (keys: number[][], t: number) => { const p = at(keys, t); return [...(p ? [p] : []), ...keys.filter((k) => k[0] > t).map((k) => [k[1], k[2]] as [number, number])]; };

const icons = new Map<string, L.DivIcon>();
const icon = (cls: string, size = 16) => {
  const k = cls + size;
  if (!icons.has(k)) icons.set(k, L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }));
  return icons.get(k)!;
};
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });

function Follow({ s, phase }: { s: any; phase: string }) {
  const map = useMap();
  useEffect(() => {
    if (!s) return;
    if (phase === "approach") map.flyTo(s.crash, 16, { duration: 1.4 });
    else if (phase === "crash" || phase === "victim" || phase === "flee") map.flyTo(s.crash, 17, { duration: 1.4 });
    else if (phase === "plate" || phase === "licence") map.flyTo(s.crash, 16, { duration: 1.2 });
    else {
      const pts: [number, number][] = [s.crash, ...s.hospitals.map((h: any) => [h.lat, h.lon]), ...s.police.map((p: any) => [p.lat, p.lon])];
      if (s.flee) pts.push(...s.flee.keys.map((k: number[]) => [k[1], k[2]] as [number, number]));
      map.flyToBounds(L.latLngBounds(pts).pad(0.08), { duration: 1.6, maxZoom: 16 });
    }
  }, [s?.id, phase]);
  return null;
}

function Person({ title, photo, show, rows, tone }: { title: string; photo?: string; show: boolean; rows: [string, any][]; tone: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3 border border-white/15 bg-white/[0.03] p-3">
      <div className="relative h-20 w-16 shrink-0 overflow-hidden bg-white/5">
        {photo && show ? <motion.img initial={{ opacity: 0, scale: 1.1 }} animate={{ opacity: 1, scale: 1 }} src={`/api/toll-images/${photo}`} alt="" className="h-full w-full object-cover" />
          : <div className="ops-scan absolute inset-0" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: tone }}>{title}</div>
        <dl className="mt-1 space-y-0.5 text-[12px]">
          {rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => <div key={k} className="flex gap-2"><dt className="w-20 shrink-0 text-white/45">{k}</dt><dd className="min-w-0 truncate font-medium text-white">{v}</dd></div>)}
        </dl>
      </div>
    </motion.div>
  );
}

export default function Operations() {
  const d = useApi<any>("/incidents");
  const S: any[] = d.data?.scenarios ?? [];
  const [idx, setIdx] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [base, setBase] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const raf = useRef(0);
  const s = S[idx];
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  useEffect(() => { if (d.data) setBase(Date.now()); }, [!!d.data]);
  useEffect(() => {
    if (!playing || !s) return;
    let last: number | null = null;
    const step = (ms: number) => {
      if (last != null) setT((v) => v + ((ms - last!) / 1000) * (v < T_NOTIFY + 6 ? 1 : FAST));
      last = ms;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, s?.id]);
  useEffect(() => { if (s && t > s.end) go((idx + 1) % S.length); }, [t > (s?.end ?? 1e9)]);
  function go(i: number) { setIdx(i); setT(0); setBase(Date.now()); setPlaying(true); }

  const phase = useMemo(() => (s ? [...s.phases].reverse().find((p: any) => p.t <= t) ?? s.phases[0] : null), [s, Math.floor(t * 2)]);
  if (!d.data) return <div className="p-8"><Loading error={d.error} /></div>;
  if (!s) return <div className="p-8">No incidents.</div>;
  const ts = (sec: number) => clock(base + sec * 1000);
  const idn = s.card.identity ?? {};
  const sus = s.flee?.suspect;
  const notified = t >= T_NOTIFY;
  const fleeing = s.flee && t >= 15;
  const caught = s.flee && t >= s.flee.outcome.t;
  const log = s.log.filter((l: any) => l.t <= t).slice().reverse();

  return (
    <div className="ops flex h-full flex-col overflow-hidden bg-[#0b0f14] text-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-xl font-extrabold tracking-tight">YATHARTH</span>
          <span className="flex items-center gap-1.5 bg-[#ff2a2a] px-2 py-0.5 text-[11px] font-bold"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />LIVE</span>
          <span className="text-sm text-white/60">Cyberabad traffic command</span>
          <span className="mono text-lg font-bold tabular-nums">{s ? clock(base + t * 1000) : clock(now)}</span>
        </div>
        <nav className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <Link to="/overview" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><Grid3x3 size={13} />City overview</Link>
          <Link to="/cases" className="border border-white/20 px-2.5 py-1 hover:bg-white/10">All cases</Link>
          <Link to="/dashcam" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><Camera size={13} />Dashcam</Link>
          <Link to="/cameras" className="flex items-center gap-1.5 border border-white/20 px-2.5 py-1 hover:bg-white/10"><Radio size={13} />Cameras</Link>
        </nav>
      </header>

      <div className="flex gap-1.5 overflow-x-auto border-b border-white/10 px-5 py-2">
        {S.map((x, i) => (
          <button key={x.id} onClick={() => go(i)} className={`flex shrink-0 items-center gap-2 border px-2.5 py-1 text-left text-[12px] ${i === idx ? "border-white bg-white/10" : "border-white/15 text-white/55 hover:text-white"}`}>
            <span className={`h-2 w-2 rounded-full ${i === idx ? "animate-pulse" : ""}`} style={{ background: i < idx ? "#5b6470" : LEVEL[x.card.level] ?? "#888" }} />
            <span className="font-semibold">{x.card.place}</span>
            {x.fled && <span className="bg-[#ff2a2a]/20 px-1 text-[10px] font-bold text-[#ff6b6b]">HIT &amp; RUN</span>}
            {i < idx && <Check size={12} className="text-white/50" />}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="relative min-h-[420px]">
          <MapContainer center={s.crash} zoom={16} zoomControl={false} className="ops-map h-full w-full">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="ops-tiles" attribution="© OpenStreetMap contributors" />
            <Follow s={s} phase={phase?.key ?? "approach"} />
            {S.map((x, i) => i !== idx && i < idx && <CircleMarker key={x.id} center={x.crash} radius={6} eventHandlers={{ click: () => go(i) }} pathOptions={{ color: "#5b6470", weight: 2, fillOpacity: 0.5 }}><Tooltip>{x.card.place} · closed</Tooltip></CircleMarker>)}

            {notified && s.hospitals.map((h: any) => (
              <Marker key={h.name} position={[h.lat, h.lon]} icon={icon(h.sending ? "ops-hosp ops-big" : "ops-hosp", h.sending ? 22 : 15)}>
                <Tooltip direction="top" permanent={h.sending} className="ops-label">{h.sending ? "Ambulance from " : ""}{h.name}</Tooltip>
              </Marker>
            ))}
            {notified && s.police.map((p: any) => (
              <span key={p.name}>
                <Marker position={[p.lat, p.lon]} icon={icon("ops-police", 15)}><Tooltip direction="top" className="ops-label">{p.name}</Tooltip></Marker>
                {t >= p.keys[0][0] && t < p.arrive && <Polyline positions={ahead(p.keys, t)} pathOptions={{ color: "#ff2a2a", weight: 2, dashArray: "4 6", opacity: 0.8 }} />}
                {t >= p.keys[0][0] && <Marker position={at(p.keys, t)!} icon={icon("ops-police ops-unit", 12)}><Tooltip direction="top" className="ops-label">Patrol · {p.name}</Tooltip></Marker>}
              </span>
            ))}
            {s.ambulance && notified && (
              <>
                {t < s.ambulance.arrive && <Polyline positions={ahead(s.ambulance.keys, t)} pathOptions={{ color: "#2f7bff", weight: 3, dashArray: "6 6" }} />}
                <Marker position={at(s.ambulance.keys, t)!} icon={icon("ops-amb", 16)}><Tooltip direction="right" permanent className="ops-label">{t < s.ambulance.arrive ? `Ambulance · ${Math.max(0, Math.ceil((s.ambulance.arrive - t) / 60 * 10) / 10)} min` : "Ambulance on scene"}</Tooltip></Marker>
              </>
            )}

            {s.vehicles.map((v: any) => {
              if (v.role === "other" && fleeing) return null;
              const p = at(v.keys, Math.min(t, 15));
              return p && (
                <span key={v.role}>
                  <Polyline positions={trail(v.keys, Math.min(t, 15))} pathOptions={{ color: v.role === "victim" ? "#e5e7eb" : "#f59e0b", weight: 3, opacity: 0.7 }} />
                  <Marker position={p} icon={icon(v.role === "victim" ? "ops-car ops-car-v" : "ops-car ops-car-o", 13)}>
                    {t >= 19 && v.role === "victim" && <Tooltip direction="left" permanent className="ops-label ops-label-v">VICTIM · {idn.plate ?? "pedestrian"}</Tooltip>}
                  </Marker>
                </span>
              );
            })}
            {t >= 15 && <Marker position={s.crash} icon={icon("ops-crash", 26)} />}

            {fleeing && (
              <>
                {s.flee.signals.filter((g: any) => t >= g.from && t <= g.to).map((g: any, i: number) => <Marker key={i} position={g.at} icon={icon("ops-signal", 12)}><Tooltip direction="top" className="ops-label">Signal held by the agent</Tooltip></Marker>)}
                {s.flee.units.map((u: any) => (
                  <span key={u.id}>
                    {!caught && <Polyline positions={ahead(u.keys, t)} pathOptions={{ color: "#ff2a2a", weight: 2, dashArray: "3 6", opacity: 0.7 }} />}
                    <Marker position={at(u.keys, t)!} icon={icon("ops-police ops-unit", 13)}><Tooltip direction="top" className="ops-label">{u.name}</Tooltip></Marker>
                  </span>
                ))}
                <Polyline positions={trail(s.flee.keys, t)} pathOptions={{ color: "#ff2a2a", weight: 4 }} />
                <Marker position={at(s.flee.keys, t)!} icon={icon(caught ? "ops-suspect ops-caught" : "ops-suspect", 18)}>
                  <Tooltip direction="right" permanent className="ops-label ops-label-s">{caught ? "STOPPED · " : "FLEEING · "}{t >= 21 ? sus?.resolved : sus?.plate ?? "plate unread"}</Tooltip>
                </Marker>
              </>
            )}
          </MapContainer>

          <AnimatePresence mode="wait">
            {phase && (
              <motion.div key={s.id + phase.key} initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                className="pointer-events-none absolute left-1/2 top-4 z-[600] w-[min(92%,560px)] -translate-x-1/2 border border-white/20 bg-black/80 px-4 py-2.5 backdrop-blur">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: phase.key === "flee" || phase.key === "crash" ? "#ff6b6b" : phase.key === "caught" ? "#22c55e" : "#93c5fd" }}>{phase.label}</span>
                  <span className="mono text-[12px] text-white/60">{ts(phase.t)}</span>
                </div>
                <div className="mt-0.5 truncate text-[15px] font-semibold">{phase.detail}</div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="absolute bottom-3 left-3 z-[600] flex items-center gap-2 border border-white/15 bg-black/75 px-2 py-1.5 text-[12px]">
            <button aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)} className="p-1 hover:bg-white/10">{playing ? <Pause size={14} /> : <Play size={14} />}</button>
            <button aria-label="Restart incident" onClick={() => go(idx)} className="p-1 hover:bg-white/10"><RotateCcw size={14} /></button>
            <button aria-label="Next incident" onClick={() => go((idx + 1) % S.length)} className="p-1 hover:bg-white/10"><SkipForward size={14} /></button>
            <div className="h-1 w-40 bg-white/15"><div className="h-full bg-white" style={{ width: `${Math.min(100, (t / s.end) * 100)}%` }} /></div>
            <span className="mono text-white/60">{t < T_NOTIFY + 6 ? "1×" : `${FAST}×`}</span>
          </div>
          <div className="absolute bottom-3 right-3 z-[600] flex gap-3 bg-black/70 px-2.5 py-1.5 text-[11px] text-white/70">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-[#2f7bff]" />hospitals alerted</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-[#ff2a2a]" />police responding</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-[#e5e7eb]" />victim</span>
          </div>
        </div>

        <aside className="min-h-0 space-y-3 overflow-y-auto border-l border-white/10 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">{s.card.place} · detected {ts(15)}</div>
              <div className="text-[17px] font-bold leading-snug">{s.card.title}</div>
            </div>
            <span className="shrink-0 px-2 py-0.5 text-[11px] font-bold" style={{ background: LEVEL[s.card.level] ?? "#555" }}>{s.card.level}</span>
          </div>

          <div className="relative aspect-video bg-black">
            {s.card.video ? <video key={s.id} src={`/api/cases/${s.card.case}/file/${s.card.video}`} autoPlay muted loop playsInline className="h-full w-full object-contain" />
              : <div className="flex h-full items-center justify-center text-[12px] text-white/40">Junction camera · reconstructed from sensor log</div>}
            <span className="absolute left-2 top-2 flex items-center gap-1 bg-black/70 px-1.5 py-0.5 text-[10px] font-bold"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff2a2a]" />CAM · {s.card.place}</span>
          </div>

          <ol className="space-y-1">
            {s.phases.map((p: any) => {
              const done = p.t <= t, cur = phase?.key === p.key;
              return (
                <li key={p.key} className={`flex items-center gap-2 text-[12px] ${done ? "" : "opacity-35"}`}>
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${cur ? "animate-pulse border-white bg-white text-black" : done ? "border-white/60" : "border-white/25"}`}>{done && !cur && <Check size={10} />}</span>
                  <span className={`flex-1 ${cur ? "font-bold" : ""}`}>{p.label}</span>
                  <span className="mono text-white/45">{done ? ts(p.t) : "--:--:--"}</span>
                </li>
              );
            })}
          </ol>

          {t >= 19 && (
            <Person title="Victim" tone="#e5e7eb" photo={idn.licence?.photo} show={t >= 27} rows={[
              ["Who", idn.victim],
              ["Plate", t >= 23 ? idn.plate ?? "on foot" : "reading…"],
              ["Owner", t >= 23 ? idn.registration?.owner : null],
              ["Vehicle", t >= 23 ? idn.registration?.vehicle : null],
              ["Licence", t >= 27 ? idn.licence?.dl_no : "matching face…"],
              ["Holder", t >= 27 && idn.licence ? `${idn.licence.holder} · ${Math.round((idn.face_match ?? 0) * 100)}% match` : null],
              ["Contact", t >= T_NOTIFY ? idn.registration?.emergency_contact && `${idn.registration.emergency_contact} · informed` : null],
            ]} />
          )}
          {fleeing && sus && (
            <Person title={caught ? "Suspect · stopped" : "Suspect · fleeing"} tone={caught ? "#22c55e" : "#ff6b6b"} photo={sus.photo} show={t >= 25} rows={[
              ["Plate", t >= 21 ? `${sus.resolved} (read ${sus.plate})` : sus.plate],
              ["Vehicle", sus.vehicle],
              ["Owner", t >= 25 ? sus.owner : "looking up…"],
              ["Last seen", caught ? "Stopped by the patrol at the planned spot" : sus.last_seen],
            ]} />
          )}
          {notified && s.ambulance && (
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <div className="border border-[#2f7bff]/50 bg-[#2f7bff]/10 p-2"><div className="text-white/50">Ambulance</div><div className="font-semibold">{t >= s.ambulance.arrive ? "With the victim" : `${Math.ceil((s.ambulance.arrive - t) / 6) / 10} min out`}</div><div className="truncate text-white/50">{s.ambulance.from}</div></div>
              <div className="border border-[#ff2a2a]/50 bg-[#ff2a2a]/10 p-2"><div className="text-white/50">Police</div><div className="font-semibold">{s.police.length + (s.flee?.units.length ?? 0)} units moving</div><div className="truncate text-white/50">{s.hospitals.length} hospitals on alert</div></div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Agents</div>
            <ol className="space-y-1.5">
              <AnimatePresence initial={false}>
                {log.slice(0, 14).map((l: any) => (
                  <motion.li key={l.t + l.text} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} className="text-[12px] leading-snug">
                    <span className="mono mr-1.5 text-white/40">{ts(l.t)}</span>
                    <span className="mr-1.5 font-bold" style={{ color: AGENT[l.agent] ?? "#ccc" }}>{l.agent}</span>
                    <span className="text-white/85">{l.text}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Link to={`/case/${s.card.case}`} className="flex items-center justify-center gap-1 border border-white/25 py-2 text-[13px] font-semibold hover:bg-white/10">Open case <ChevronRight size={14} /></Link>
            <Link to={s.flee ? `/case/${s.card.case}/intercept` : `/case/${s.card.case}/${s.card.camera === "dashcam" ? "dashcam" : "reconstruction"}`} className="flex items-center justify-center gap-1 bg-white py-2 text-[13px] font-semibold text-black"><Box size={14} />{s.flee ? "Intercept detail" : s.card.camera === "dashcam" ? "Dashcam view" : "3D reconstruction"}</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
