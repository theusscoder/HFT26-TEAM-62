import { Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/* OWNER: P4. Dashcam "Driver's view": what the camera vehicle had in front of it, as a radar.
   The ego vehicle sits at the bottom; every road user is placed by its estimated distance ahead (Z) and lateral offset (X)
   from dashcam.json, coloured by time-to-collision. Below: distance + TTC to the hazard and the ego's own speed over time. */

interface Rel { t: number; Z: number; X: number; closing_ms: number; ttc: number | null }
export interface Dashcam { hazard?: string | null; relative: Record<string, Rel[]>; ego_series: { t: number; v: number | null }[]; t0_video_s: number; t0_method: string; params: any; ego_body?: string[] }

function relAt(r: Rel[], t: number): Rel | null {
  if (!r.length || t < r[0].t - 0.15 || t > r[r.length - 1].t + 0.15) return null;
  const i = r.findIndex((q) => q.t >= t);
  if (i <= 0) return r[Math.max(0, i)];
  const a = r[i - 1], b = r[i], k = (t - a.t) / (b.t - a.t || 1);
  return { t, Z: a.Z + (b.Z - a.Z) * k, X: a.X + (b.X - a.X) * k, closing_ms: b.closing_ms, ttc: b.ttc };
}
const ttcCol = (ttc: number | null) => (ttc == null ? "#8a93a0" : ttc < 1.5 ? "#ff5d5d" : ttc < 3 ? "#f5b84f" : "#3ecf8e");

export default function DriverView({ dc, t, names, egoName }: { dc: Dashcam; t: number; names: Record<string, string>; egoName: string }) {
  const RANGE = 40, LAT = 14, W = 900, H = 520;
  const sx = (x: number) => W / 2 + (x / LAT) * (W / 2), sy = (z: number) => H - 40 - (z / RANGE) * (H - 70);
  const hz = dc.hazard ?? undefined;
  const series = (hz && dc.relative[hz]) || [];
  const egoV = dc.ego_series.filter((s) => s.v != null).map((s) => ({ t: +(s.t - dc.t0_video_s).toFixed(2), v: +(s.v! * 3.6).toFixed(1) }));
  const chart = series.map((r) => ({ t: r.t, Z: r.Z, ttc: r.ttc != null ? Math.min(r.ttc, 6) : null }));
  const egoNow = egoV.length ? egoV.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)) : null;
  const hzNow = hz ? relAt(series, t) : null;

  return (
    <div className="grid h-full grid-rows-[1fr_150px] gap-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full bg-white">
        {/* lane guides + range rings */}
        <polygon points={`${sx(-1.8)},${sy(0)} ${sx(1.8)},${sy(0)} ${sx(1.8)},${sy(RANGE)} ${sx(-1.8)},${sy(RANGE)}`} fill="#4f8cff" opacity={0.06} />
        {[-5.4, -1.8, 1.8, 5.4].map((x) => <line key={x} x1={sx(x)} y1={sy(0)} x2={sx(x)} y2={sy(RANGE)} stroke="#c9c9c4" strokeDasharray="10 10" />)}
        {[10, 20, 30, 40].map((z) => (
          <g key={z}><line x1={0} x2={W} y1={sy(z)} y2={sy(z)} stroke="#e2e2de" /><text x={8} y={sy(z) - 4} fill="#5c5c58" fontSize={13}>{z} m</text></g>
        ))}
        <text x={sx(0)} y={sy(RANGE) + 16} fill="#5c5c58" fontSize={12} textAnchor="middle">your lane</text>
        {/* road users */}
        {Object.entries(dc.relative).map(([id, r]) => {
          const p = relAt(r, t);
          if (!p || p.Z > RANGE + 2 || Math.abs(p.X) > LAT) return null;
          const trail = r.filter((q) => q.t <= t && q.t >= t - 1.5 && q.Z <= RANGE);
          const isHz = id === hz;
          const col = ttcCol(p.ttc);
          const w = id.startsWith("person") ? 0.6 : id.startsWith("motorcycle") || id.startsWith("bicycle") ? 0.8 : id.startsWith("bus") || id.startsWith("truck") ? 2.5 : 1.8;
          return (
            <g key={id}>
              {trail.length > 1 && <polyline points={trail.map((q) => `${sx(q.X)},${sy(q.Z)}`).join(" ")} fill="none" stroke={col} strokeOpacity={0.35} strokeWidth={3} />}
              <rect x={sx(p.X - w / 2)} y={sy(p.Z) - 16} width={(w / LAT) * (W / 2)} height={22} rx={4} fill="#ffffff" stroke={col} strokeWidth={isHz ? 4 : 2} />
              <text x={sx(p.X)} y={sy(p.Z) - 24} fill="#0a0a0a" fontSize={isHz ? 15 : 12} textAnchor="middle" fontWeight={isHz ? 700 : 400}>
                {(names[id] ?? id).replace(" (primary)", "")}{isHz ? " · hazard" : ""} · {p.Z.toFixed(0)} m{p.ttc != null ? ` · TTC ${p.ttc.toFixed(1)} s` : ""}
              </text>
            </g>
          );
        })}
        {/* ego */}
        <g transform={`translate(${sx(0)}, ${sy(0) + 6})`}>
          <path d="M0,-26 L16,10 L-16,10 Z" fill="#4f8cff" />
          <text y={30} fill="#4f8cff" fontSize={14} textAnchor="middle" fontWeight={700}>{egoName}{egoNow ? ` · ${egoNow.v.toFixed(0)} km/h` : ""}</text>
        </g>
        {t >= -0.15 && t <= 0.6 && <text x={W / 2} y={40} fill="#ff5d5d" fontSize={24} fontWeight={800} textAnchor="middle">IMPACT</text>}
        {hzNow?.ttc != null && hzNow.ttc < 3 && t < 0 && (
          <g><rect x={W - 260} y={20} width={240} height={58} rx={8} fill={hzNow.ttc < 1.5 ? "#ff5d5d" : "#f5b84f"} opacity={0.95} />
            <text x={W - 140} y={46} fill="#ffffff" fontSize={18} fontWeight={800} textAnchor="middle">TIME TO COLLISION {hzNow.ttc.toFixed(1)} s</text>
            <text x={W - 140} y={68} fill="#ffffff" fontSize={13} textAnchor="middle">{hzNow.Z.toFixed(1)} m · closing {(hzNow.closing_ms * 3.6).toFixed(0)} km/h</text></g>
        )}
      </svg>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className="text-[11px] text-muted">Distance to hazard (m) · time-to-collision (s, capped at 6)</div>
          <ResponsiveContainer width="100%" height={110}>
            <LineChart data={chart}>
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} stroke="#8a93a0" fontSize={10} />
              <YAxis stroke="#8a93a0" fontSize={10} width={28} />
              <ReferenceArea y1={0} y2={1.5} fill="#ff5d5d" fillOpacity={0.08} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #0a0a0a", fontSize: 11 }} />
              <Line dataKey="Z" name="distance m" dot={false} stroke="#4f8cff" isAnimationActive={false} />
              <Line dataKey="ttc" name="TTC s" dot={false} stroke="#f5b84f" isAnimationActive={false} connectNulls={false} />
              <ReferenceLine x={t} stroke="#0a0a0a" /><ReferenceLine x={0} stroke="#ff5d5d" strokeDasharray="3 3" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className="text-[11px] text-muted">Camera vehicle speed (km/h, from road flow, ±30%; unreliable after impact)</div>
          <ResponsiveContainer width="100%" height={110}>
            <LineChart data={egoV}>
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} stroke="#8a93a0" fontSize={10} />
              <YAxis stroke="#8a93a0" fontSize={10} width={28} />
              <ReferenceArea x1={0} x2={egoV.length ? egoV[egoV.length - 1].t : 1} fill="#8a93a0" fillOpacity={0.08} />
              <Line dataKey="v" dot={false} stroke="#3ecf8e" isAnimationActive={false} />
              <ReferenceLine x={t} stroke="#0a0a0a" /><ReferenceLine x={0} stroke="#ff5d5d" strokeDasharray="3 3" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
