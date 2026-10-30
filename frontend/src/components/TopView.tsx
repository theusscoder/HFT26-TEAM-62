import { useMemo } from "react";
import type { Event } from "../lib/api";
import { at, blocked, dimsFor, headingAt, speedColour } from "./Scene3D";

/* OWNER: P4. B1 top view: the calibrated reconstruction as a plan, read like an F1 telemetry map.
   Only the key actors carry paths (coloured by speed, 1-second ticks); everything else is a faint dot.
   Road = calibrated layout when known, else the observed drivable area. Shares geometry helpers with Scene3D. */

export interface MetricPoint { t: number; x: number; y: number; v_kmh: number; v_sigma: number }
export interface MetricTrack { id: string; class: string; colour?: string; colour_name?: string; points: MetricPoint[] }
export interface Metric {
  units: "m"; scale_sigma: number; reproj_err_m: number; note?: string; auto?: boolean;
  features: { carriageway?: { x: number[] }; divider?: { x: number[] }; zebra?: { y: number[] }; camera?: { x: number; y: number }; road_hull?: number[][] };
  tracks: MetricTrack[];
}
export interface Selection { kind: string; title: string; lines: string[]; refs?: string[] }

const hex = (v: number, vmax: number) => `#${speedColour(v, vmax).getHexString()}`;

export default function TopView({ metric, t, events, entities, witnesses, sight, large, onSelect }: {
  metric: Metric; t: number; events: Event[]; entities: any; witnesses: Record<string, any>; sight: boolean; large: Set<string>;
  onSelect?: (s: Selection) => void;
}) {
  const key = new Set<string>([entities?.primary, ...(entities?.involved ?? [])].filter(Boolean));
  const keyTracks = metric.tracks.filter((tr) => key.has(tr.id));
  const names: Record<string, string> = entities?.names ?? {};
  const prim = metric.tracks.find((tr) => tr.id === entities?.primary);
  const vmax = Math.max(10, ...keyTracks.flatMap((tr) => tr.points.map((p) => p.v_kmh)));
  const ix: number[] = entities?.impact_xy ?? (prim ? [at(prim, 0).x, at(prim, 0).y] : [0, 0]);

  const { Y0, Y1, X0, X1 } = useMemo(() => {
    const pts = keyTracks.flatMap((tr) => tr.points.filter((p) => p.t >= -5 && p.t <= 4));
    const ys = [ix[1], ...pts.map((p) => p.y)], xs = [ix[0], ...pts.map((p) => p.x)];
    const W = Object.values(witnesses).filter((w: any) => w.position_m).map((w: any) => w.position_m);
    W.forEach(([x, y]: number[]) => { xs.push(x); ys.push(y); });
    let y0 = Math.min(...ys) - 4, y1 = Math.max(...ys) + 4, x0 = Math.min(...xs) - 4, x1 = Math.max(...xs) + 4;
    const R = 16 / 9;                           // match the 16:9 frame exactly so nothing is letter-boxed
    if ((y1 - y0) / (x1 - x0) > R) { const n = (y1 - y0) / R, m = (x0 + x1) / 2; x0 = m - n / 2; x1 = m + n / 2; }
    else { const n = (x1 - x0) * R, m = (y0 + y1) / 2; y0 = m - n / 2; y1 = m + n / 2; }
    return { Y0: y0, Y1: y1, X0: x0, X1: x1 };
  }, [metric, entities, witnesses]);
  const S = 36;
  const W = (Y1 - Y0) * S, H = (X1 - X0) * S;
  const sx = (y: number) => (Y1 - y) * S, sy = (x: number) => (x - X0) * S;
  const f = metric.features;
  const sel = (s: Selection) => onSelect?.(s);
  const brakes = events.filter((e) => e.action === "brake" && (e.source === "sensor" || e.kind === "INFERRED") && e.actor === prim?.id && e.t.start < 0.1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full rounded-lg bg-[#0e1116]">
      <defs>
        <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="10" height="10" fill="#3a3f47" /><line x1="0" y1="0" x2="0" y2="10" stroke="#e7eaee" strokeOpacity="0.45" strokeWidth="4" />
        </pattern>
        <pattern id="grid" width={S * 5} height={S * 5} patternUnits="userSpaceOnUse"><path d={`M ${S * 5} 0 L 0 0 0 ${S * 5}`} fill="none" stroke="#1d232b" strokeWidth="1" /></pattern>
        <radialGradient id="burst"><stop offset="0%" stopColor="#ff5d5d" stopOpacity="0.85" /><stop offset="100%" stopColor="#ff5d5d" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width={W} height={H} fill="url(#grid)" />

      {/* road */}
      {f.carriageway ? (
        <g>
          <rect x={0} y={sy(f.carriageway.x[0])} width={W} height={(f.carriageway.x[1] - f.carriageway.x[0]) * S} fill="#23272e" />
          {f.divider && <rect x={0} y={sy(f.divider.x[0])} width={W} height={(f.divider.x[1] - f.divider.x[0]) * S} fill="url(#hatch)" />}
          <line x1={0} x2={W} y1={sy((f.carriageway.x[0] + f.carriageway.x[1]) / 2)} y2={sy((f.carriageway.x[0] + f.carriageway.x[1]) / 2)} stroke="#e7eaee" strokeOpacity={0.3} strokeWidth={3} strokeDasharray="28 28" />
          {f.zebra && Array.from({ length: Math.round((f.carriageway.x[1] - f.carriageway.x[0]) / 0.9) }).map((_, i) => (
            <rect key={i} x={sx(f.zebra!.y[1])} y={sy(f.carriageway!.x[0] + 0.2 + i * 0.9)} width={(f.zebra!.y[1] - f.zebra!.y[0]) * S} height={0.5 * S} fill="#e7eaee" opacity={0.7} />
          ))}
        </g>
      ) : f.road_hull && f.road_hull.length > 2 ? (
        <g>
          <polygon points={f.road_hull.map(([x, y]) => `${sx(y)},${sy(x)}`).join(" ")} fill="#23272e" stroke="#3a404a" strokeDasharray="8 6" />
          <text x={sx(f.road_hull[0][1]) + 6} y={sy(f.road_hull[0][0]) - 6} fill="#5d6570" fontSize={13}>observed drivable area</text>
        </g>
      ) : null}

      {/* camera */}
      {f.camera && f.camera.y > Y0 - 50 && (
        <g opacity={0.9}>
          <circle cx={Math.min(W - 12, sx(f.camera.y))} cy={Math.max(12, Math.min(H - 12, sy(f.camera.x)))} r={8} fill="#4f8cff" />
          <text x={Math.min(W - 12, sx(f.camera.y)) - 54} y={Math.max(12, Math.min(H - 12, sy(f.camera.x))) + 5} fill="#4f8cff" fontSize={13}>CCTV</text>
        </g>
      )}

      {/* braking strip */}
      {prim && brakes.map((b) => {
        const seg = prim.points.filter((p) => p.t >= b.t.start - 0.05 && p.t <= Math.max(b.t.end, b.t.start + 0.2));
        return seg.length > 1 ? <polyline key={b.id} points={seg.map((p) => `${sx(p.y)},${sy(p.x)}`).join(" ")} fill="none" stroke="#f5b84f" strokeOpacity={0.22} strokeWidth={2.4 * S} strokeLinecap="round"
          className="cursor-pointer" onClick={() => sel({ kind: "braking", title: "Braking zone", lines: [b.value ?? "", `T${b.t.start.toFixed(2)} → T${b.t.end.toFixed(2)} s`], refs: [b.ref || b.id] })} /> : null;
      })}

      {/* key paths: uncertainty halo, speed-coloured trace, 1 s ticks */}
      {keyTracks.map((tr) => {
        const done = tr.points.filter((p) => p.t <= t);
        const ticks = tr.points.filter((p, i, a) => i > 0 && Math.floor(p.t) !== Math.floor(a[i - 1].t) && p.t <= t);
        return (
          <g key={tr.id} className="cursor-pointer" onClick={() => sel({ kind: "actor", title: names[tr.id] ?? tr.id, lines: [`peak ${Math.max(...tr.points.map((p) => p.v_kmh)).toFixed(0)} km/h ± ${Math.round(metric.scale_sigma * 100)}%`, `tracked T${tr.points[0].t.toFixed(1)} → T${tr.points[tr.points.length - 1].t.toFixed(1)} s`], refs: [`tracks_metric:${tr.id}`] })}>
            <polyline points={tr.points.map((p) => `${sx(p.y)},${sy(p.x)}`).join(" ")} fill="none" stroke="#8a93a0" strokeOpacity={0.18} strokeWidth={3} strokeDasharray="5 7" />
            {done.length > 1 && <polyline points={done.map((p) => `${sx(p.y)},${sy(p.x)}`).join(" ")} fill="none" stroke="#4f8cff" strokeOpacity={0.07} strokeWidth={(0.3 + metric.scale_sigma * 2) * S} strokeLinecap="round" strokeLinejoin="round" />}
            {done.slice(1).map((p, i) => <line key={i} x1={sx(done[i].y)} y1={sy(done[i].x)} x2={sx(p.y)} y2={sy(p.x)} stroke={hex(p.v_kmh, vmax)} strokeWidth={7} strokeLinecap="round" />)}
            {ticks.map((p) => (
              <g key={p.t}>
                <circle cx={sx(p.y)} cy={sy(p.x)} r={5} fill="#0b0d10" stroke="#e7eaee" strokeWidth={2} />
                <text x={sx(p.y)} y={sy(p.x) + 22} fill="#8a93a0" fontSize={12} textAnchor="middle">{Math.round(p.t) > 0 ? "+" : ""}{Math.round(p.t)}s</text>
              </g>
            ))}
          </g>
        );
      })}

      {/* everyone else: faint dots at the playhead */}
      {metric.tracks.filter((tr) => !key.has(tr.id)).map((tr) => {
        const p = at(tr, t);
        return p.live && p.x > X0 && p.x < X1 && p.y > Y0 && p.y < Y1 ? <circle key={tr.id} cx={sx(p.y)} cy={sy(p.x)} r={tr.class === "person" ? 5 : 8} fill="#5d6570" opacity={0.5} /> : null;
      })}

      {/* witness pins + line of sight to the primary */}
      {Object.entries(witnesses).map(([w, m]: [string, any]) => {
        if (!m.position_m) return null;
        const wp = { x: m.position_m[0], y: m.position_m[1] };
        const pp = prim ? at(prim, t) : null;
        const by = sight && pp?.live ? blocked(wp, pp, metric.tracks, t, new Set([prim!.id]), large) : null;
        return (
          <g key={w}>
            {sight && pp?.live && <line x1={sx(wp.y)} y1={sy(wp.x)} x2={sx(pp.y)} y2={sy(pp.x)} stroke={by ? "#ff5d5d" : "#3ecf8e"} strokeWidth={2} strokeDasharray="6 5" />}
            <g transform={`translate(${sx(wp.y)},${sy(wp.x)})`} className="cursor-pointer"
              onClick={() => sel({ kind: "witness", title: m.name, lines: [m.vantage ?? "", by ? `view of the primary blocked by ${names[by] ?? by} at this instant` : "clear line of sight to the primary at this instant"], refs: [`${w}.txt`] })}>
              <path d="M0,0 C-13,-17 -13,-32 0,-32 C13,-32 13,-17 0,0 Z" fill="#c58cff" />
              <text y={-15} fill="#0b0d10" fontSize={13} fontWeight={700} textAnchor="middle">{w.replace(/\D/g, "")}</text>
            </g>
          </g>
        );
      })}

      {/* key actors at the playhead, true size */}
      {keyTracks.map((tr) => {
        const p = at(tr, t);
        if (!p.live) return null;
        const d = dimsFor(tr, large);
        const h = d ? headingAt(tr, t, Math.max(0.8, 0.4 * d[0])) : null;
        const ang = h == null ? 0 : (Math.atan2(Math.sin(h), -Math.cos(h)) * 180) / Math.PI;   // world heading → screen
        const col = hex(p.v_kmh, vmax);
        return (
          <g key={tr.id} transform={`translate(${sx(p.y)},${sy(p.x)})`}>
            {d ? (
              <g transform={`rotate(${ang})`}>
                <rect x={(-d[0] / 2) * S} y={(-d[2] / 2) * S} width={d[0] * S} height={d[2] * S} rx={5} fill="#0b0d10" stroke={col} strokeWidth={4} />
                <rect x={(d[0] / 2) * S - 9} y={(-d[2] / 2) * S + 4} width={5} height={d[2] * S - 8} fill={col} />
              </g>
            ) : <circle r={0.45 * S} fill="#5fd4e6" stroke="#0b0d10" strokeWidth={3} />}
            <g transform={`translate(0, ${-(d ? d[2] : 1.2) * S * 0.5 - 16})`}>
              <rect x={-78} y={-22} width={156} height={26} rx={6} fill="#0b0d10" opacity={0.88} />
              <text y={-4} fontSize={15} fill="#e7eaee" textAnchor="middle" fontWeight={600}>{(names[tr.id] ?? tr.id).replace(" (primary)", "")}{d ? ` · ${p.v_kmh.toFixed(0)} km/h` : ""}</text>
            </g>
          </g>
        );
      })}

      {/* impact */}
      {t >= -0.15 && (
        <g transform={`translate(${sx(ix[1])},${sy(ix[0])})`} className="cursor-pointer"
          onClick={() => sel({ kind: "impact", title: "Impact (T0)", lines: [`at x ${ix[0].toFixed(1)} m, y ${ix[1].toFixed(1)} m`, ...(entities?.involved ?? []).map((i: string) => `involved: ${names[i] ?? i}`)], refs: events.filter((e) => Math.abs(e.t.start) < 0.35 && /impact|contact/.test(e.action)).map((e) => e.ref || e.id) })}>
          <circle r={2.2 * S} fill="url(#burst)"><animate attributeName="r" values={`${1.3 * S};${2.6 * S};${1.3 * S}`} dur="1.6s" repeatCount="indefinite" /></circle>
          <g transform={`translate(0, ${2.4 * S})`}><rect x={-58} y={-18} width={116} height={26} rx={6} fill="#ff5d5d" /><text y={1} fill="#0b0d10" fontSize={15} fontWeight={800} textAnchor="middle">IMPACT · T0</text></g>
        </g>
      )}

      {/* scale */}
      <g transform={`translate(${W - 5 * S - 24}, ${H - 22})`}>
        <rect width={5 * S} height={5} fill="#e7eaee" /><rect width={2.5 * S} height={5} fill="#8a93a0" />
        <text y={-7} fill="#8a93a0" fontSize={12}>0</text><text x={5 * S} y={-7} fill="#8a93a0" fontSize={12} textAnchor="end">5 m</text>
      </g>
    </svg>
  );
}
