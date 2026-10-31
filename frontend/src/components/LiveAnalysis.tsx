import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Ambulance, Car, CheckCircle2, Eye, IdCard, Loader2, Radio, ScanLine, Send, Shield, SkipForward, RotateCcw, User } from "lucide-react";

/* A case worked through in order, the way the system does it: the camera reports, road users are found, each plate is
   read (characters settle as frames agree), the registry and the licence come back, the vision model and the rules decide
   who was hurt, severity is set, and only then the dispatch agent sends the ambulance and police and the alerts go out.
   Every step waits for the one before it and shows when it finished. Once per case per session; replay or skip. */
type Tone = "dark" | "light";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour12: false });
const CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

function PlateReveal({ partial, final, tone }: { partial?: string | null; final: string; tone: Tone }) {
  const [text, setText] = useState(final.replace(/./g, "·"));
  useEffect(() => {
    let alive = true;
    (async () => {
      const target = final.split("");
      const known = (partial || "").padEnd(final.length, "?").split("");
      for (let round = 0; round < 14 && alive; round++) {   // frames voting: characters flicker, then the read ones settle
        setText(target.map((c, i) => (known[i] && known[i] !== "?" && round > 3 + i / 2 ? known[i] : CHARS[Math.floor(Math.random() * CHARS.length)])).join(""));
        await sleep(90);
      }
      if (partial && partial.includes("?") && alive) { setText(known.join("")); await sleep(900); }   // the partial read
      for (let i = 0; i < target.length && alive; i++) {   // the registry resolves the rest
        setText(target.slice(0, i + 1).join("") + (partial && partial !== final ? known.slice(i + 1).join("") : target.slice(i + 1).join("")));
        await sleep(45);
      }
      if (alive) setText(final);
    })();
    return () => { alive = false; };
  }, [final, partial]);
  return <span className={`inline-block whitespace-nowrap border-2 px-2 py-0.5 font-mono text-[15px] font-bold tracking-[0.18em] ${tone === "dark" ? "border-white bg-white text-black" : "border-ink bg-white text-black"}`}>{text}</span>;
}

interface Step { key: string; icon: any; title: string; working: string; ms: number; body: () => React.ReactNode }

export default function LiveAnalysis({ caseId, tone = "light", compact = false, onDone }: { caseId: string; tone?: Tone; compact?: boolean; onDone?: () => void }) {
  const [data, setData] = useState<any>(null);
  const [idx, setIdx] = useState(-1);
  const [times, setTimes] = useState<Record<string, Date>>({});
  const [run, setRun] = useState(0);
  const skip = useRef(false);
  useEffect(() => {
    let alive = true;
    const get = (p: string) => fetch(`/api/cases/${caseId}/${p}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    Promise.all([get("case"), get("records"), get("severity"), get("vision"), get("insights"), get("plates"), get("response-timeline")]).then(([c, rec, sev, vis, ins, pl, tl]) => {
      if (alive) setData({ c, rec, sev, vis, ins: ins ?? [], pl, tl });
    });
    return () => { alive = false; };
  }, [caseId]);

  const steps: Step[] = useMemo(() => {
    if (!data) return [];
    const { c, rec, sev, vis, ins, tl } = data;
    const src = c?.source ?? {};
    const vehicles: any[] = rec?.vehicles ?? [], people: any[] = rec?.people ?? [];
    const victim = vehicles.find((v) => v.track === rec?.victim) ?? people.find((p) => p.track === rec?.victim);
    const visionK = (ins as any[]).find((k) => k.kind === "vision");
    const ev = (key: string) => (tl?.events ?? []).find((e: any) => e.key === key);
    const disp = (tl?.events ?? []).filter((e: any) => e.key.startsWith("dispatch_"));
    const tg = (tl?.events ?? []).filter((e: any) => e.key.startsWith("telegram_"));
    const muted = tone === "dark" ? "text-white/55" : "text-muted";
    const card = tone === "dark" ? "border-white/15 bg-white/[0.04]" : "border-line bg-panel-2/40";
    const out: Step[] = [
      { key: "report", icon: Radio, title: src.kind === "camera agent" ? `Incident reported by ${src.camera}` : "Footage received", working: "Receiving the feed…", ms: 900,
        body: () => <div className={`text-[12px] ${muted}`}>{c?.location?.name}{src.detection?.why ? ` · ${src.detection.why}` : ""}</div> },
      { key: "detect", icon: ScanLine, title: `${vehicles.length + people.length} road users in the collision`, working: "Detecting and tracking road users…", ms: 1800,
        body: () => <div className="flex flex-wrap gap-1.5">{[...vehicles.map((v) => v.name), ...people.map((p) => p.description || "Person")].map((n, i) => (
          <motion.span key={n + i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.25 }} className={`border px-1.5 py-0.5 text-[11px] ${card}`}>{n}</motion.span>))}</div> },
    ];
    vehicles.forEach((v) => {
      out.push({ key: `plate_${v.track}`, icon: Car, title: `Plate · ${v.name}`, working: `Reading the number plate on ${v.name.toLowerCase()} across frames…`, ms: 2600,
        body: () => (
          <div className="flex items-center gap-2">
            <img src={`/api/cases/${caseId}/keyframes/veh_${v.track}.jpg`} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} alt="" className="h-10 w-16 object-cover" />
            <PlateReveal partial={v.plate_read} final={v.plate} tone={tone} />
            <span className={`text-[11px] ${muted}`}>{v.plate_basis}</span>
          </div>) });
      out.push({ key: `rc_${v.track}`, icon: IdCard, title: `Registration · ${v.plate}`, working: "Querying the RTA registry (RC)…", ms: 1700,
        body: () => <div className={`grid grid-cols-2 gap-x-3 text-[12px] ${muted}`}><span>Owner <b className={tone === "dark" ? "text-white" : "text-ink"}>{v.registration.owner}</b></span><span>{v.registration.vehicle}</span>
          <span>{v.registration.rto}</span><span className={v.registration.insurance_ok === false ? "text-[#ff6b6b]" : ""}>{v.registration.insurance}</span></div> });
      out.push({ key: `dl_${v.track}`, icon: User, title: `Driver · ${v.driver.name}`, working: "Matching the driver to a licence…", ms: 2100,
        body: () => (
          <div className="flex items-center gap-2.5">
            <motion.img initial={{ opacity: 0, filter: "blur(6px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} transition={{ duration: 0.9 }} src={`/api/toll-images/${v.driver.photo}`} alt="" className="h-12 w-10 object-cover" />
            <div className={`text-[12px] ${muted}`}><div>Licence {v.driver.dl_no} · {v.driver.class}</div><div>Valid till {v.driver.valid_till} · face vs licence {Math.round((v.driver.face_match ?? 0) * 100)}%</div></div>
          </div>) });
    });
    people.forEach((p) => out.push({ key: `person_${p.track}`, icon: User, title: `Person · ${p.name}`, working: `Identifying the person on foot (${p.identified_by})…`, ms: 1900,
      body: () => <div className="flex items-center gap-2.5"><motion.img initial={{ opacity: 0 }} animate={{ opacity: 1 }} src={`/api/toll-images/${p.photo}`} alt="" className="h-12 w-10 object-cover" /><div className={`text-[12px] ${muted}`}>{p.description} · {p.age} · blood group {p.blood_group}</div></div> }));
    out.push({ key: "victim", icon: Eye, title: `Victim: ${victim ? (victim.driver?.name ?? victim.name) : "being determined"}`, working: "Vision model and rules: who was hurt?…", ms: 2200,
      body: () => <div className={`text-[12px] ${muted}`}>{visionK ? visionK.detail : vis?.method}</div> });
    out.push({ key: "severity", icon: Shield, title: `Severity ${sev?.level ?? "?"} · ${sev?.label ?? ""}`, working: "Scoring severity…", ms: 1100, body: () => null });
    out.push({ key: "dispatch", icon: Ambulance, title: disp.length ? disp.map((e: any) => e.label.replace(" dispatched", "")).join(" + ") + " dispatched" : "Dispatch decided", working: "Dispatch agent: nearest free units by road…", ms: 2000,
      body: () => <ul className={`text-[12px] ${muted}`}>{disp.map((e: any) => <li key={e.key}>{e.label}: {e.detail}</li>)}{ev("no_transport") && <li>{ev("no_transport").detail}</li>}</ul> });
    out.push({ key: "alerts", icon: Send, title: "Police, hospital and family alerted", working: "Sending the intimation and Telegram alerts…", ms: 1300,
      body: () => <ul className={`text-[12px] ${muted}`}>{ev("police_informed") && <li>{ev("police_informed").detail}</li>}{tg.map((e: any) => <li key={e.key}>{e.label}: {e.detail.split("(").slice(-1)[0].replace(")", "")}</li>)}</ul> });
    return out;
  }, [data, tone, caseId]);

  useEffect(() => {
    if (!steps.length) return;
    const seenKey = `live-analysis:${caseId}`;
    let seen = false;
    try { seen = run === 0 && sessionStorage.getItem(seenKey) === "1"; } catch { /* private mode */ }
    if (seen) { const now = new Date(); setTimes(Object.fromEntries(steps.map((s) => [s.key, now]))); setIdx(steps.length); onDone?.(); return; }
    let alive = true;
    skip.current = false;
    setIdx(0); setTimes({});
    (async () => {
      for (let i = 0; i < steps.length && alive; i++) {
        setIdx(i);
        const jitter = 0.75 + Math.random() * 0.5;
        if (!skip.current) await sleep(steps[i].ms * jitter);
        if (!alive) return;
        setTimes((t) => ({ ...t, [steps[i].key]: new Date() }));
      }
      if (alive) { setIdx(steps.length); try { sessionStorage.setItem(seenKey, "1"); } catch { /* ignore */ } onDone?.(); }
    })();
    return () => { alive = false; };
  }, [steps, run]);

  if (!data) return <div className={`flex items-center gap-2 text-sm ${tone === "dark" ? "text-white/60" : "text-muted"}`}><Loader2 size={14} className="animate-spin" />Connecting to the case…</div>;
  const done = idx >= steps.length;
  return (
    <div className={tone === "dark" ? "text-white" : ""}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-60">{done ? "Analysis complete" : "Live analysis"}</span>
        <span className="flex gap-2 text-[11px]">
          {!done && <button onClick={() => { skip.current = true; }} className="flex items-center gap-1 opacity-70 hover:opacity-100"><SkipForward size={12} />Skip</button>}
          {done && <button onClick={() => setRun((r) => r + 1)} className="flex items-center gap-1 opacity-70 hover:opacity-100"><RotateCcw size={12} />Replay</button>}
        </span>
      </div>
      <ol className={compact ? "space-y-2" : "space-y-3"}>
        <AnimatePresence initial={false}>
          {steps.slice(0, Math.min(idx + 1, steps.length)).map((s, i) => {
            const finished = !!times[s.key];
            const I = s.icon;
            return (
              <motion.li key={s.key + run} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5">
                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${finished ? "bg-[#22c55e] text-white" : tone === "dark" ? "bg-white/10" : "bg-panel-2"}`}>
                  {finished ? <CheckCircle2 size={12} /> : <Loader2 size={12} className="animate-spin" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`flex items-center gap-1.5 text-[13px] ${finished ? "font-semibold" : "opacity-70"}`}><I size={13} className="shrink-0 opacity-60" />{finished ? s.title : s.working}</span>
                    {finished && <span className="mono shrink-0 text-[10px] opacity-50">{clock(times[s.key])}</span>}
                  </div>
                  {finished && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-1">{s.body()}</motion.div>}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
}
