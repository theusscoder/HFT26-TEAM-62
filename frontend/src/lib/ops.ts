import { useEffect, useRef, useState } from "react";

/* The operations centre (/api/ops) on one shared clock: the police and hospital dashboards compute every status from the
   same server timeline, so a certificate the police issue shows at the hospital at the same moment, and a hospital's
   acknowledgement shows back on the police board on the next poll. */
export function at(keys: number[][], t: number): [number, number] | null {
  if (!keys?.length) return null;
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  if (t >= keys[keys.length - 1][0]) return [keys[keys.length - 1][1], keys[keys.length - 1][2]];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m][0] <= t) lo = m; else hi = m; }
  const a = keys[lo], b = keys[hi], k = (t - a[0]) / (b[0] - a[0] || 1);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
export const ON_SCENE_S = 90;

export function useOps(poll = 4000) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const skew = useRef(0);
  const [now, setNow] = useState(Date.now());
  const load = () => fetch("/api/ops").then((r) => r.json()).then((d) => { skew.current = Date.now() / 1000 - d.server_now; setData(d); }).catch((e) => setError(String(e)));
  useEffect(() => { load(); const h = setInterval(load, poll); return () => clearInterval(h); }, []);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(h); }, []);
  if (!data) return { data: null, error, t: 0, cycleStart: 0, reload: load, now };
  const serverNow = now / 1000 - skew.current;
  const t = (serverNow - data.started_at) % data.cycle_s;
  const cycleStart = (serverNow - t) * 1000;   // wall time of cycle t=0
  return { data, error, t, cycleStart, reload: load, now };
}

/** Where an incident is in its own timeline, and its ambulance's trip including the drive to hospital. */
export function incidentState(inc: any, t: number) {
  const tl = t - inc.offset_s;
  const amb = inc.ambulance || {};
  const toHosp = (amb.arrive ?? 0) + ON_SCENE_S;
  const atHosp = toHosp + (amb.eta_s ?? 300);
  return { tl, live: tl >= 15 && tl <= inc.end_s, started: tl >= 15, notified: tl >= 31, certSent: tl >= inc.t_cert, ambArrive: amb.arrive, toHosp, atHosp,
           patient: tl < 31 ? "none" : tl < amb.arrive ? "dispatched" : tl < toHosp ? "at_scene" : tl < atHosp ? "transporting" : "arrived" };
}

export function officerState(o: any, data: any, t: number) {
  for (const inc of data.incidents) {
    const tl = t - inc.offset_s;
    const c = inc.crew.find((c: any) => c.officer === o.id);
    if (!c || !c.keys?.length || tl < c.keys[0][0] || tl > inc.end_s) continue;
    const pos = at(c.keys, tl);
    if (c.role === "scene") {
      return tl < c.arrive ? { status: "En route", tone: "#f59e0b", eta: c.arrive - tl, inc, crew: c, pos }
                           : { status: "On scene", tone: "#22c55e", inc, crew: c, pos };
    }
    const caught = inc.flee && tl >= inc.flee.outcome.t;
    return caught ? { status: "Suspect stopped", tone: "#22c55e", inc, crew: c, pos, tracking: inc.suspect?.plate }
                  : { status: "Pursuing", tone: "#ff2a2a", inc, crew: c, pos, tracking: inc.suspect?.plate, task: c.role };
  }
  return { status: "Available", tone: "#5b6470", pos: [o.lat, o.lon] as [number, number] };
}
