import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/* One shared playhead for the whole case. Video, map, sensor chart, witness panel and timeline all
   read `t` (seconds relative to impact) and call `seek`. This is what makes the Replay Room "synced". */
interface Clock { t: number; playing: boolean; seek: (t: number) => void; toggle: () => void; range: [number, number]; setRate: (r: number) => void }
const Ctx = createContext<Clock | null>(null);

export function ClockProvider({ children, range = [-5, 3] as [number, number] }: { children: ReactNode; range?: [number, number] }) {
  const [t, setT] = useState(range[0]);
  const [playing, setPlaying] = useState(false);
  const last = useRef<number | null>(null);
  const rate = useRef(1);

  useEffect(() => {
    if (!playing) { last.current = null; return; }
    let raf = 0;
    const step = (now: number) => {
      if (last.current != null) {
        const dt = ((now - last.current) / 1000) * rate.current;
        setT((p) => { const n = p + dt; if (n >= range[1]) { setPlaying(false); return range[1]; } return n; });
      }
      last.current = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, range]);

  const seek = (v: number) => setT(Math.min(range[1], Math.max(range[0], v)));
  const toggle = () => { if (t >= range[1]) setT(range[0]); setPlaying((p) => !p); };
  return <Ctx.Provider value={{ t, playing, seek, toggle, range, setRate: (r) => { rate.current = r; } }}>{children}</Ctx.Provider>;
}

export function useClock() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useClock outside ClockProvider");
  return c;
}
