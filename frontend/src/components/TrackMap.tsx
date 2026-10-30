import { useMemo, useState } from "react";
import { useClock } from "../lib/clock";
import type { Event } from "../lib/api";

/* OWNER: P4. B1, the Track Map: a top-down reconstruction read like an F1 circuit map.
   World frame (from calibration): x across the road (0 = divider edge), y along the road (0 = zebra near edge).
   Drawn with the road running left→right so the map can be wide. Paths are coloured by speed, vehicles are
   true-size footprints, the collision gets a marker, braking zones are shaded, witness pins + camera cone show
   who could see what. Toggle "3D" tilts the whole map into perspective. */

export interface MetricPoint { t: number; x: number; y: number; v_kmh: number; v_sigma: number }
export interface MetricTrack { id: string; class: string; colour?: string; points: MetricPoint[] }
export interface Metric {
  units: "m"; scale_sigma: number; reproj_err_m: number; note?: string;
  features: { carriageway?: { x: number[] }; divider?: { x: number[] }; zebra?: { y: number[] }; camera?: { x: number; y: number } };
  tracks: MetricTrack[];
}
export interface Selection { kind: string; title: string; lines: string[]; refs?: string[] }

const SIZE: Record<string, [number, number]> = { bus: [7.5, 2.4], truck: [8, 2.5], car: [4.2, 1.8], motorcycle: [2.0, 0.8], bicycle: [1.8, 0.6] };
const speedColour = (v: number, vmax: number) => {
  const k = Math.min(1, v / Math.max(vmax, 1));
  // green → amber → red, like a telemetry trace
  const stops = [[62, 207, 142], [245, 184, 79], [255, 93, 93]];
  const [a, b, f] = k < 0.5 ? [stops[0], stops[1], k / 0.5] : [stops[1], stops[2], (k - 0.5) / 0.5];
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * f)).join(",")})`;
};

function at(tr: MetricTrack, t: number) {
  const p = tr.points;
  if (t <= p[0].t) return { ...p[0], live: t >= p[0].t - 0.05 };
  if (t >= p[p.length - 1].t) return { ...p[p.length - 1], live: t <= p[p.length - 1].t + 0.05 };
  const i = p.findIndex((q) => q.t >= t);
  const a = p[i - 1], b = p[i], k = (t - a.t) / (b.t - a.t || 1);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, v_kmh: a.v_kmh + (b.v_kmh - a.v_kmh) * k, v_sigma: a.v_sigma, live: true };
}

/** Direction of travel: look back until the object has moved at least 0.8 m, so a near-stopped vehicle keeps
    its last confident heading instead of spinning on tracking jitter. */
function heading(tr: MetricTrack, t: number, minMove = 0.8) {
  const b = at(tr, Math.min(t, tr.points[tr.points.length - 1].t));
  for (let back = 0.5; back <= 4; back += 0.25) {
    const a = at(tr, b.t - back);
    if (a.t < tr.points[0].t) break;
    if (Math.hypot(b.x - a.x, b.y - a.y) >= minMove) return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;  // screen angle: world y runs right→left, x top→bottom
  }
  return null;
}

export default function TrackMap({ metric, events, entities, witnesses, onSelect, tilt3d }: {
  metric: Metric; events: Event[]; entities: Record<string, any>; witnesses: Record<string, any>;
  onSelect?: (s: Selection) => void; tilt3d?: boolean;
}) {
  const { t, seek } = useClock();
  const [hover, setHover] = useState<string | null>(null);
  const roles: Record<string, string> = {};
  Object.entries(entities).forEach(([k, v]) => { if (typeof v === "string") roles[v] = k; });
  const main = new Set(Object.keys(roles));

  // Map extent: the important tracks + road furniture, with margin. Screen X = world y (along), screen Y = world x (across).
  const { Y0, Y1, X0, X1 } = useMemo(() => {
    const pts = metric.tracks.filter((tr) => main.has(tr.id)).flatMap((tr) => tr.points);
    const ys = pts.map((p) => p.y), xs = pts.map((p) => p.x);
    return { Y0: Math.min(-5, ...ys) - 2, Y1: Math.max(8, ...ys) + 2, X0: Math.min(-4, ...xs) - 1.5, X1: Math.max(10, ...xs) + 1.5 };
  }, [metric]);
  const S = 40; // px per metre
  const W = (Y1 - Y0) * S, H = (X1 - X0) * S;
  const sx = (y: number) => (Y1 - y) * S;          // far (large y) on the left, camera side on the right
  const sy = (x: number) => (x - X0) * S;
  const f = metric.features;
  const cw = f.carriageway?.x ?? [0, 7], dv = f.divider?.x ?? [-1.4, 0], zb = f.zebra?.y ?? [0, 3];
  const vmax = Math.max(...metric.tracks.filter((tr) => main.has(tr.id)).flatMap((tr) => tr.points.map((p) => p.v_kmh)), 10);

  const bus = metric.tracks.find((tr) => tr.id === entities.bus);
  const impactPos = bus ? at(bus, 0) : null;
  const brakes = events.filter((e) => e.action === "brake" && e.source === "sensor" && bus);
  const showImpact = t >= -0.15;
  const label = (id: string) => (roles[id] ? roles[id].replace("_", " ") : id);

  const select = (s: Selection) => onSelect?.(s);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg bg-[#0e1116]" style={{ perspective: "1400px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full transition-transform duration-700"
        style={{ transform: tilt3d ? "rotateX(52deg) scale(1.15) translateY(-4%)" : "none", transformOrigin: "50% 60%" }}>
        <defs>
          <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="10" height="10" fill="#3a3f47" /><line x1="0" y1="0" x2="0" y2="10" stroke="#e7eaee" strokeOpacity="0.5" strokeWidth="4" />
          </pattern>
          <radialGradient id="burst"><stop offset="0%" stopColor="#ff5d5d" stopOpacity="0.9" /><stop offset="100%" stopColor="#ff5d5d" stopOpacity="0" /></radialGradient>
          <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#e7eaee" /></marker>
        </defs>

        {/* ground, footpaths, carriageway, divider, lane line, zebra */}
        <rect width={W} height={H} fill="#151a20" />
        <rect x={0} y={sy(cw[0])} width={W} height={sy(cw[1]) - sy(cw[0])} fill="#23272e" />
        <rect x={0} y={sy(dv[0])} width={W} height={sy(dv[1]) - sy(dv[0])} fill="url(#hatch)" />
        <line x1={0} x2={W} y1={sy((cw[0] + cw[1]) / 2)} y2={sy((cw[0] + cw[1]) / 2)} stroke="#e7eaee" strokeOpacity={0.35} strokeWidth={3} strokeDasharray="30 30" />
        <line x1={0} x2={W} y1={sy(cw[1])} y2={sy(cw[1])} stroke="#e7eaee" strokeOpacity={0.5} strokeWidth={3} />
        {Array.from({ length: Math.round((cw[1] - cw[0]) / 0.9) }).map((_, i) => (
          <rect key={i} x={sx(zb[1])} y={sy(cw[0] + 0.15 + i * 0.9)} width={sx(zb[0]) - sx(zb[1])} height={0.5 * S} fill="#e7eaee" opacity={0.75} />
        ))}
        <text x={sx(zb[1]) + 4} y={sy(cw[1]) + 22} fill="#8a93a0" fontSize={16}>zebra</text>
        <text x={12} y={sy((dv[0] + dv[1]) / 2) + 6} fill="#e7eaee" fontSize={16} opacity={0.8}>divider</text>
        <text x={12} y={sy(cw[0] + 0.9)} fill="#8a93a0" fontSize={16}>← towards camera is right · traffic flows →</text>

        {/* camera field of view */}
        {f.camera && (
          <g opacity={0.9}>
            <path d={`M${sx(f.camera.y)},${sy(f.camera.x)} L${sx(Y1)},${sy(X0 + 0.5)} L${sx(Y1)},${sy(X1 - 0.5)} Z`} fill="#4f8cff" opacity={0.05} />
            <circle cx={sx(Math.max(f.camera.y, Y0 + 0.5))} cy={sy(f.camera.x)} r={9} fill="#4f8cff" />
            <text x={sx(Math.max(f.camera.y, Y0 + 0.5)) - 70} y={sy(f.camera.x) - 14} fill="#4f8cff" fontSize={15}>CCTV</text>
          </g>
        )}

        {/* braking zones (sensor, aligned) shaded along the bus path */}
        {bus && brakes.map((b) => {
          const seg = bus.points.filter((p) => p.t >= b.t.start && p.t <= b.t.end);
          if (seg.length < 2) return null;
          return <polyline key={b.id} points={seg.map((p) => `${sx(p.y)},${sy(p.x)}`).join(" ")} fill="none" stroke="#f5b84f" strokeOpacity={0.25} strokeWidth={2.6 * S}
            strokeLinecap="round" className="cursor-pointer" onClick={() => select({ kind: "brake", title: "Braking zone (telematics)", lines: [b.value ?? "", `T${b.t.start.toFixed(2)} → T${b.t.end.toFixed(2)} s`], refs: [b.ref] })} />;
        })}

        {/* paths: faint full path, then the travelled part coloured by speed, with an uncertainty corridor */}
        {metric.tracks.filter((tr) => main.has(tr.id)).map((tr) => {
          const isMain = true;
          const done = tr.points.filter((p) => p.t <= t);
          const corridor = isMain ? (0.25 + metric.scale_sigma * 2) * S : 0;
          return (
            <g key={tr.id} opacity={isMain ? 1 : 0.35} onMouseEnter={() => setHover(tr.id)} onMouseLeave={() => setHover(null)}
              className="cursor-pointer" onClick={() => select({ kind: "track", title: label(tr.id), lines: [`track ${tr.id} · ${tr.class}`, `peak ${Math.max(...tr.points.map((p) => p.v_kmh)).toFixed(0)} km/h ± ${Math.round(metric.scale_sigma * 100)}%`], refs: [`tracks_metric:${tr.id}`] })}>
              <polyline points={tr.points.map((p) => `${sx(p.y)},${sy(p.x)}`).join(" ")} fill="none" stroke="#8a93a0" strokeOpacity={0.15} strokeWidth={isMain ? 4 : 2} strokeDasharray="6 8" />
              {isMain && done.length > 1 && <polyline points={done.map((p) => `${sx(p.y)},${sy(p.x)}`).join(" ")} fill="none" stroke="#4f8cff" strokeOpacity={0.08} strokeWidth={corridor} strokeLinecap="round" strokeLinejoin="round" />}
              {done.slice(1).map((p, i) => (
                <line key={i} x1={sx(done[i].y)} y1={sy(done[i].x)} x2={sx(p.y)} y2={sy(p.x)} stroke={isMain ? speedColour(p.v_kmh, vmax) : "#8a93a0"}
                  strokeWidth={isMain ? (hover === tr.id ? 9 : 7) : 2.5} strokeLinecap="round" />
              ))}
            </g>
          );
        })}

        {/* witness pins */}
        {Object.entries(witnesses).map(([w, m]: [string, any]) => m.position_m && (
          <g key={w} className="cursor-pointer" transform={`translate(${sx(m.position_m[1])},${sy(m.position_m[0])})`}
            onClick={() => select({ kind: "witness", title: m.name, lines: [m.vantage, `~${m.distance_m} m from impact`], refs: [`${w}.txt`] })}>
            <path d="M0,0 C-14,-18 -14,-34 0,-34 C14,-34 14,-18 0,0 Z" fill="#c58cff" />
            <text x={0} y={-17} fill="#0b0d10" fontSize={14} fontWeight={700} textAnchor="middle">{w.slice(-1)}</text>
          </g>
        ))}

        {/* moving objects at the playhead (true-size footprints) */}
        {metric.tracks.map((tr) => {
          const p = at(tr, t);
          if (!p.live) return null;
          const isMain = main.has(tr.id);
          const role = roles[tr.id];
          const sz = SIZE[role === "bus" ? "bus" : tr.class];
          const hd = heading(tr, t, sz ? Math.max(0.8, 0.4 * sz[0]) : 0.8);
          const ang = hd ?? 0;
          const col = isMain ? speedColour(p.v_kmh, vmax) : "#8a93a0";
          return (
            <g key={tr.id} transform={`translate(${sx(p.y)},${sy(p.x)})`} opacity={isMain ? 1 : 0.55}>
              {sz ? (
                <g transform={`rotate(${ang})`}>
                  <rect x={(-sz[0] / 2) * S} y={(-sz[1] / 2) * S} width={sz[0] * S} height={sz[1] * S} rx={6} fill="#0b0d10" stroke={col} strokeWidth={isMain ? 5 : 2} />
                  <rect x={(sz[0] / 2) * S - 10} y={(-sz[1] / 2) * S + 4} width={6} height={sz[1] * S - 8} fill={col} />
                </g>
              ) : (
                <circle r={0.45 * S} fill={role === "officer" ? "#5fd4e6" : "#0b0d10"} stroke={col} strokeWidth={3} />
              )}
              {isMain && (
                <g transform={`translate(0, ${-(sz ? sz[1] : 1) * S * 0.5 - 14})`}>
                  <rect x={-70} y={-26} width={140} height={30} rx={6} fill="#0b0d10" opacity={0.85} />
                  <text x={0} y={-6} fontSize={17} fill="#e7eaee" textAnchor="middle" fontWeight={600}>
                    {label(tr.id)}{sz ? ` · ${p.v_kmh.toFixed(0)} km/h` : ""}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* collision marker */}
        {impactPos && showImpact && (
          <g className="cursor-pointer" onClick={() => select({ kind: "impact", title: "Impact (T0)", lines: [`${label(entities.bus)} meets the divider`, `position x ${impactPos.x.toFixed(1)} m, y ${impactPos.y.toFixed(1)} m`], refs: events.filter((e) => Math.abs(e.t.start) < 0.3 && e.action === "impact").map((e) => e.ref || e.id) })}>
            <circle cx={sx(impactPos.y)} cy={sy(impactPos.x)} r={2.2 * S} fill="url(#burst)">
              <animate attributeName="r" values={`${1.4 * S};${2.6 * S};${1.4 * S}`} dur="1.6s" repeatCount="indefinite" />
            </circle>
            <path d={Array.from({ length: 8 }).map((_, i) => { const a = (i * Math.PI) / 4, r1 = 0.5 * S, r2 = 1.1 * S; return `M${sx(impactPos.y) + r1 * Math.cos(a)},${sy(impactPos.x) + r1 * Math.sin(a)} L${sx(impactPos.y) + r2 * Math.cos(a)},${sy(impactPos.x) + r2 * Math.sin(a)}`; }).join(" ")} stroke="#ff5d5d" strokeWidth={4} />
            <g transform={`translate(${sx(impactPos.y)}, ${sy(impactPos.x) + 2.2 * S})`}><rect x={-62} y={-20} width={124} height={28} rx={6} fill="#ff5d5d" /><text x={0} y={0} fill="#0b0d10" fontSize={17} fontWeight={800} textAnchor="middle">IMPACT · T0</text></g>
          </g>
        )}

        {/* scale bar */}
        <g transform={`translate(${W - 5 * S - 30}, ${H - 30})`}>
          <rect width={5 * S} height={6} fill="#e7eaee" /><rect width={2.5 * S} height={6} fill="#8a93a0" />
          <text x={0} y={-8} fill="#8a93a0" fontSize={14}>0</text><text x={5 * S} y={-8} fill="#8a93a0" fontSize={14} textAnchor="end">5 m</text>
        </g>
      </svg>

      {/* legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-bg/85 px-3 py-2 text-[11px] text-muted">
        <div className="flex items-center gap-2">speed
          <span className="h-2 w-28 rounded" style={{ background: `linear-gradient(90deg, ${speedColour(0, 1)}, ${speedColour(0.5, 1)}, ${speedColour(1, 1)})` }} />
          <span className="mono">0–{vmax.toFixed(0)} km/h</span>
        </div>
        <div className="mt-1">shaded band = braking (telematics) · halo = position uncertainty ±{Math.round(metric.scale_sigma * 100)}%</div>
      </div>
      {showImpact || (
        <button onClick={() => seek(0)} className="absolute right-3 top-3 rounded-md border border-bad/50 bg-bg/80 px-3 py-1 text-xs text-bad">Jump to impact</button>
      )}
    </div>
  );
}
