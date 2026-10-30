import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Metric, MetricTrack } from "./TopView";

/* OWNER: P4. B1 bird's-eye: the calibrated reconstruction in 3D.
   World: x across the road, y along it (metres). three.js: X = x, Z = -y, Y = up.
   - speed curtain: a wall along each key path, height and colour = speed (where it braked is visible at a glance)
   - true-scale vehicles (bus / car / bike / person) moving on the shared clock, heading from motion
   - impact beacon at the impact point, braking strip from telematics
   - witness line of sight: green = clear view of the primary at this instant, red = blocked by another vehicle
   - camera presets: bird's-eye, top, chase the primary, stand where a witness stood */

export type CamPreset = "bird" | "top" | "chase" | `witness:${string}`;

const DIMS: Record<string, [number, number, number]> = {   // length, height, width (m)
  bus: [9, 3.0, 2.5], truck: [8, 3.2, 2.5], car: [4.4, 1.5, 1.8], motorcycle: [2.0, 1.2, 0.7], bicycle: [1.8, 1.1, 0.5],
};
const COLOUR: Record<string, string> = { white: "#e8eaee", silver: "#b9bfc8", grey: "#7c838e", black: "#2a2d33", red: "#d8443c", blue: "#3f74d8",
  green: "#3fa86b", yellow: "#e4c341", orange: "#e58b3a", purple: "#8a5cd0" };
const W2T = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

export function speedColour(v: number, vmax: number) {
  const k = Math.min(1, v / Math.max(vmax, 1));
  const a = k < 0.5 ? [0.24, 0.81, 0.56] : [0.96, 0.72, 0.31], b = k < 0.5 ? [0.96, 0.72, 0.31] : [1, 0.36, 0.36];
  const f = k < 0.5 ? k / 0.5 : (k - 0.5) / 0.5;
  return new THREE.Color(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

export function at(tr: MetricTrack, t: number) {
  const p = tr.points;
  if (t <= p[0].t) return { ...p[0], live: t >= p[0].t - 0.05 };
  if (t >= p[p.length - 1].t) return { ...p[p.length - 1], live: t <= p[p.length - 1].t + 0.05 };
  const i = p.findIndex((q) => q.t >= t);
  const a = p[i - 1], b = p[i], k = (t - a.t) / (b.t - a.t || 1);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, v_kmh: a.v_kmh + (b.v_kmh - a.v_kmh) * k, v_sigma: a.v_sigma, live: true };
}

/** World heading (radians, 0 = +y) from the last confident movement. */
export function headingAt(tr: MetricTrack, t: number, minMove: number) {
  const b = at(tr, Math.min(t, tr.points[tr.points.length - 1].t));
  for (let back = 0.5; back <= 4; back += 0.25) {
    const a = at(tr, b.t - back);
    if (a.t < tr.points[0].t) break;
    if (Math.hypot(b.x - a.x, b.y - a.y) >= minMove) return Math.atan2(b.x - a.x, b.y - a.y);
  }
  return null;
}

export function dimsFor(tr: MetricTrack, large: Set<string>): [number, number, number] | null {
  if (tr.class === "person") return null;
  return large.has(tr.id) && tr.class === "car" ? DIMS.bus : DIMS[tr.class] ?? DIMS.car;
}

/** Does the segment a→b pass through the footprint of any other vehicle at time t? */
export function blocked(a: { x: number; y: number }, b: { x: number; y: number }, tracks: MetricTrack[], t: number, skip: Set<string>, large: Set<string>) {
  for (const tr of tracks) {
    if (skip.has(tr.id)) continue;
    const d = dimsFor(tr, large);
    if (!d) continue;
    const p = at(tr, t);
    if (!p.live) continue;
    const h = headingAt(tr, t, 0.4 * d[0]) ?? 0;
    const c = Math.cos(-h), s = Math.sin(-h);
    for (let k = 0.05; k < 0.95; k += 0.05) {   // sample the sight line
      const qx = a.x + (b.x - a.x) * k - p.x, qy = a.y + (b.y - a.y) * k - p.y;
      const lx = qx * c - qy * s, ly = qx * s + qy * c;    // into vehicle frame (y = along)
      if (Math.abs(lx) < d[2] / 2 && Math.abs(ly) < d[0] / 2) return tr.id;
    }
  }
  return null;
}

function SpeedCurtain({ tr, t, vmax, scale }: { tr: MetricTrack; t: number; vmax: number; scale: number }) {
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(() => {
    const pts = tr.points.filter((p) => p.t <= t);
    if (pts.length < 2) { geo.setDrawRange(0, 0); return; }
    const pos: number[] = [], col: number[] = [];
    pts.forEach((p) => {
      const c = speedColour(p.v_kmh, vmax), h = Math.max(0.05, p.v_kmh * scale);
      pos.push(p.x, 0.02, -p.y, p.x, h, -p.y);
      col.push(c.r * 0.6, c.g * 0.6, c.b * 0.6, c.r, c.g, c.b);
    });
    const idx: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.setDrawRange(0, idx.length);
    geo.computeBoundingSphere();
  }, [tr, t, vmax, scale, geo]);
  return <mesh geometry={geo}><meshBasicMaterial vertexColors transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} /></mesh>;
}

function GroundTrace({ tr, vmax }: { tr: MetricTrack; vmax: number }) {
  const pts = useMemo(() => tr.points.map((p) => W2T(p.x, p.y, 0.03)), [tr]);
  const cols = useMemo(() => tr.points.map((p) => speedColour(p.v_kmh, vmax)), [tr, vmax]);
  return <Line points={pts} vertexColors={cols} lineWidth={2} transparent opacity={0.45} />;
}

function Vehicle({ tr, t, large, main, label, vmax }: { tr: MetricTrack; t: number; large: Set<string>; main: boolean; label?: string; vmax: number }) {
  const p = at(tr, t);
  if (!p.live) return null;
  const d = dimsFor(tr, large);
  const col = COLOUR[(tr as any).colour_name] ?? (main ? "#c9ced6" : "#596170");
  if (!d) {
    return (
      <group position={W2T(p.x, p.y)}>
        <mesh position={[0, 0.85, 0]}><capsuleGeometry args={[0.25, 1.1, 4, 10]} /><meshStandardMaterial color={main ? "#5fd4e6" : "#8a93a0"} /></mesh>
        {label && <Html position={[0, 2.3, 0]} center distanceFactor={14}><div className="whitespace-nowrap rounded bg-bg/90 px-2 py-0.5 text-[11px] text-ink">{label}</div></Html>}
      </group>
    );
  }
  const h = headingAt(tr, t, Math.max(0.8, 0.4 * d[0]));
  const yaw = h == null ? 0 : -h;   // world heading → rotation about +Y (Z = -y)
  return (
    <group position={W2T(p.x, p.y)} rotation={[0, yaw, 0]}>
      <mesh position={[0, d[1] / 2, 0]} castShadow>
        <boxGeometry args={[d[2], d[1], d[0]]} />
        <meshStandardMaterial color={col} metalness={0.3} roughness={0.5} transparent opacity={main ? 1 : 0.55} />
      </mesh>
      <mesh position={[0, d[1] * 0.75, -d[0] / 2 + 0.02]}><boxGeometry args={[d[2] * 0.85, d[1] * 0.3, 0.05]} /><meshStandardMaterial color="#9ad1ff" emissive="#335" /></mesh>
      {main && <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[d[2] + 0.6, d[0] + 0.6]} /><meshBasicMaterial color={speedColour(p.v_kmh, vmax)} transparent opacity={0.35} /></mesh>}
      {label && <Html position={[0, d[1] + 0.9, 0]} center distanceFactor={14}>
        <div className="whitespace-nowrap rounded bg-bg/90 px-2 py-0.5 text-[11px] font-semibold text-ink">{label} · {p.v_kmh.toFixed(0)} km/h</div>
      </Html>}
    </group>
  );
}

function ImpactBeacon({ x, y, t }: { x: number; y: number; t: number }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ring.current) return;
    const s = 1 + ((clock.elapsedTime * 0.8) % 1) * 3;
    ring.current.scale.set(s, s, s);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - ((clock.elapsedTime * 0.8) % 1));
  });
  if (t < -0.15) return null;
  return (
    <group position={W2T(x, y)}>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}><ringGeometry args={[0.8, 1.0, 48]} /><meshBasicMaterial color="#ff5d5d" transparent /></mesh>
      <mesh position={[0, 4, 0]}><cylinderGeometry args={[0.12, 0.6, 8, 16, 1, true]} /><meshBasicMaterial color="#ff5d5d" transparent opacity={0.25} side={THREE.DoubleSide} /></mesh>
      <Html position={[0, 8.6, 0]} center distanceFactor={18}><div className="rounded bg-bad px-2 py-0.5 text-[11px] font-bold text-bg">IMPACT · T0</div></Html>
    </group>
  );
}

function Road({ metric }: { metric: Metric }) {
  const f = metric.features as any;
  const hull: number[][] = f.road_hull ?? [];
  const shape = useMemo(() => {
    if (f.carriageway || hull.length < 3) return null;
    const s = new THREE.Shape();
    hull.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    s.closePath();
    return s;
  }, [metric]);
  const ys = metric.tracks.flatMap((t) => t.points.map((p) => p.y));
  const y0 = Math.min(...ys) - 6, y1 = Math.max(...ys) + 6;
  if (f.carriageway) {
    const cw = f.carriageway.x, dv = f.divider?.x, zb = f.zebra?.y;
    const len = y1 - y0, mid = (y0 + y1) / 2;
    return (
      <group>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={W2T((cw[0] + cw[1]) / 2, mid, 0.005)}><planeGeometry args={[cw[1] - cw[0], len]} /><meshStandardMaterial color="#262a31" /></mesh>
        {dv && <mesh position={W2T((dv[0] + dv[1]) / 2, mid, 0.12)}><boxGeometry args={[dv[1] - dv[0], 0.24, len]} /><meshStandardMaterial color="#5b616b" /></mesh>}
        {Array.from({ length: Math.floor(len / 6) }).map((_, i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={W2T((cw[0] + cw[1]) / 2, y0 + i * 6 + 1.5, 0.01)}><planeGeometry args={[0.12, 3]} /><meshBasicMaterial color="#cfd3da" transparent opacity={0.5} /></mesh>
        ))}
        {zb && Array.from({ length: Math.round((cw[1] - cw[0]) / 0.9) }).map((_, i) => (
          <mesh key={`z${i}`} rotation={[-Math.PI / 2, 0, 0]} position={W2T(cw[0] + 0.4 + i * 0.9, (zb[0] + zb[1]) / 2, 0.012)}><planeGeometry args={[0.5, zb[1] - zb[0]]} /><meshBasicMaterial color="#e7eaee" transparent opacity={0.8} /></mesh>
        ))}
      </group>
    );
  }
  return shape ? (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}><shapeGeometry args={[shape]} /><meshStandardMaterial color="#262a31" transparent opacity={0.9} /></mesh>
  ) : null;
}

function CameraRig({ preset, focus, witnesses, impact }: { preset: CamPreset; focus: () => THREE.Vector3; witnesses: Record<string, any>; impact: THREE.Vector3 }) {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3());
  const controls = useThree((s) => (s as any).controls);
  const until = useRef(0);
  useEffect(() => { until.current = performance.now() + 1600; }, [preset]);
  useFrame(() => {
    const follow = preset === "chase" || preset.startsWith("witness:");
    if (!follow && performance.now() > until.current) return;   // settle, then hand control back to the user
    let pos: THREE.Vector3, look: THREE.Vector3;
    if (preset === "top") { pos = impact.clone().add(new THREE.Vector3(0, 28, 0.01)); look = impact; }
    else if (preset === "chase") { const f = focus(); pos = f.clone().add(new THREE.Vector3(0, 6, 12)); look = f; }
    else if (preset.startsWith("witness:")) {
      const w = witnesses[preset.slice(8)];
      if (!w?.position_m) return;
      pos = W2T(w.position_m[0], w.position_m[1], 1.6); look = focus();
    } else { pos = impact.clone().add(new THREE.Vector3(-9, 10, 13)); look = impact; }
    camera.position.lerp(pos, 0.08);
    target.current.lerp(look, 0.12);
    if (controls) { controls.target.copy(target.current); controls.update(); } else camera.lookAt(target.current);
  });
  return null;
}

export default function Scene3D({ metric, t, entities, witnesses, preset, curtain, sight, large }: {
  metric: Metric; t: number; entities: any; witnesses: Record<string, any>; preset: CamPreset; curtain: boolean; sight: boolean; large: Set<string>;
}) {
  const key = new Set<string>([entities?.primary, ...(entities?.involved ?? [])].filter(Boolean));
  const keyTracks = metric.tracks.filter((tr) => key.has(tr.id));
  const vmax = Math.max(10, ...keyTracks.flatMap((tr) => tr.points.map((p) => p.v_kmh)));
  const prim = metric.tracks.find((tr) => tr.id === entities?.primary);
  const ix = entities?.impact_xy ?? (prim ? [at(prim, 0).x, at(prim, 0).y] : [0, 0]);
  const impact = W2T(ix[0], ix[1]);
  const focus = () => (prim ? W2T(at(prim, t).x, at(prim, t).y, 1) : impact);
  const cam = (metric.features as any).camera;
  const names: Record<string, string> = entities?.names ?? {};
  const near = metric.tracks.filter((tr) => !key.has(tr.id) && tr.points.some((p) => Math.hypot(p.x - ix[0], p.y - ix[1]) < 25));

  return (
    <Canvas shadows camera={{ position: [impact.x - 9, 10, impact.z + 13], fov: 42, near: 0.1, far: 800 }} style={{ background: "#0b0d10" }}>
      <ambientLight intensity={0.9} />
      <directionalLight position={[20, 40, 10]} intensity={1.1} castShadow />
      <hemisphereLight args={["#9ab", "#111", 0.3]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[impact.x, 0, impact.z]} receiveShadow><planeGeometry args={[220, 220]} /><meshStandardMaterial color="#12161c" /></mesh>
      <gridHelper args={[220, 44, "#1f252d", "#1a1f26"]} position={[impact.x, 0.004, impact.z]} />
      <Road metric={metric} />

      {keyTracks.map((tr) => <GroundTrace key={`g${tr.id}`} tr={tr} vmax={vmax} />)}
      {curtain && keyTracks.map((tr) => <SpeedCurtain key={`c${tr.id}`} tr={tr} t={t} vmax={vmax} scale={0.09} />)}
      {[...keyTracks, ...near].map((tr) => (
        <Vehicle key={tr.id} tr={tr} t={t} large={large} main={key.has(tr.id)} label={key.has(tr.id) ? names[tr.id]?.replace(" (primary)", "") ?? tr.id : undefined} vmax={vmax} />
      ))}
      <ImpactBeacon x={ix[0]} y={ix[1]} t={t} />

      {cam && <group position={W2T(cam.x, cam.y, 6)}>
        <mesh><boxGeometry args={[0.6, 0.4, 0.8]} /><meshStandardMaterial color="#4f8cff" emissive="#1d3a7a" /></mesh>
        <Html position={[0, 0.8, 0]} center distanceFactor={16}><div className="rounded bg-observed/90 px-1.5 text-[10px] text-white">CCTV</div></Html>
      </group>}

      {Object.entries(witnesses).map(([w, m]: [string, any]) => {
        if (!m.position_m) return null;
        const wp = { x: m.position_m[0], y: m.position_m[1] };
        const pp = prim ? at(prim, t) : null;
        const by = sight && pp?.live ? blocked(wp, pp, metric.tracks, t, new Set([prim!.id]), large) : null;
        const pts = pp ? [W2T(wp.x, wp.y, 1.6), W2T(pp.x, pp.y, 1.2)] : [];
        return (
          <group key={w}>
            <mesh position={W2T(wp.x, wp.y, 0.9)}><coneGeometry args={[0.35, 1.8, 16]} /><meshStandardMaterial color="#c58cff" emissive="#4b2a6b" /></mesh>
            <Html position={W2T(wp.x, wp.y, 2.4)} center distanceFactor={14}><div className="whitespace-nowrap rounded bg-claimed/90 px-1.5 text-[10px] font-semibold text-bg">{m.name}</div></Html>
            {sight && pts.length === 2 && <Line points={pts} color={by ? "#ff5d5d" : "#3ecf8e"} lineWidth={2} dashed dashSize={0.6} gapSize={0.35} />}
          </group>
        );
      })}

      <OrbitControls makeDefault enableDamping maxPolarAngle={Math.PI / 2.05} />
      <CameraRig preset={preset} focus={focus} witnesses={witnesses} impact={impact} />
    </Canvas>
  );
}
