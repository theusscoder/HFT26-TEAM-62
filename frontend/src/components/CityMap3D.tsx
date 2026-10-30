import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* Real Hyderabad (OpenStreetMap footprints and roads) as a dark digital twin, with the intercept simulation played on it.
   World: x east, y north in metres. three.js: X = x, Z = -y, Y = up. */

export interface CityMap { bounds: number[]; roads: { id: number; pts: number[][]; class: string; name?: string | null; flow?: number }[]; buildings: { pts: number[][]; h: number; mapped: boolean }[];
  junctions: { id: number; x: number; y: number; mapped: boolean; name?: string | null }[]; places: { amenity: string; name: string; x: number; y: number }[] }
export interface Key { t: number; x: number; y: number; yaw?: number }

const W2T = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
const ROAD_W: Record<string, number> = { motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8, unclassified: 6, residential: 5 };
const ROAD_C: Record<string, string> = { motorway: "#9a9a95", trunk: "#9a9a95", primary: "#a8a8a3", secondary: "#b5b5b0", tertiary: "#c2c2bd", unclassified: "#cbcbc6", residential: "#d2d2cd" };
const MAJOR = new Set(["motorway", "trunk", "primary", "secondary"]);
// Simulated traffic, shown the way traffic maps do: green flowing, amber slow, red jammed.
const flowColour = (f: number) => (f < 0.7 ? "#e30613" : f < 0.8 ? "#f2a900" : "#0e7a43");

export function keyAt(keys: Key[], t: number) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0];
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].t <= t) lo = m; else hi = m; }
  const a = keys[lo], b = keys[hi], k = (t - a.t) / (b.t - a.t || 1);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, yaw: Math.atan2(b.x - a.x, b.y - a.y) };
}

function ribbon(pts: number[][], w: number, h: number): THREE.BufferGeometry | null {
  if (pts.length < 2) return null;
  const pos: number[] = [], idx: number[] = [];
  pts.forEach((p, i) => {
    const q = pts[Math.min(i + 1, pts.length - 1)], r = pts[Math.max(i - 1, 0)];
    const dx = q[0] - r[0], dy = q[1] - r[1], n = Math.hypot(dx, dy) || 1, ox = (dy / n) * w / 2, oy = (-dx / n) * w / 2;
    pos.push(p[0] - ox, h, -(p[1] - oy), p[0] + ox, h, -(p[1] + oy));
    if (i < pts.length - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function Buildings({ map }: { map: CityMap }) {
  const geo = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    for (const b of map.buildings) {
      if (b.pts.length < 4) continue;
      const s = new THREE.Shape(b.pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(s, { depth: b.h, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.deleteAttribute("uv");
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    merged?.computeVertexNormals();
    return merged;
  }, [map]);
  if (!geo) return null;
  return <mesh geometry={geo} castShadow receiveShadow><meshStandardMaterial color="#ffffff" roughness={0.9} metalness={0} /></mesh>;
}

function Roads({ map }: { map: CityMap }) {
  const byClass = useMemo(() => {
    const groups: Record<string, THREE.BufferGeometry[]> = {};
    for (const r of map.roads) {
      const g = ribbon(r.pts, ROAD_W[r.class] ?? 5, 0.05 + (ROAD_W[r.class] ?? 5) * 0.002);
      if (g) (groups[r.class] ??= []).push(g);
    }
    return Object.entries(groups).map(([k, gs]) => [k, mergeGeometries(gs, false)] as const);
  }, [map]);
  const glow = useMemo(() => {
    const groups: Record<string, THREE.BufferGeometry[]> = {};
    for (const r of map.roads) {
      if (!MAJOR.has(r.class)) continue;
      const w = ROAD_W[r.class] ?? 8, col = flowColour(r.flow ?? 0.9);
      const halo = ribbon(r.pts, w * 2.6, 0.12), core = ribbon(r.pts, w * 0.55, 0.18);
      if (halo) (groups[`h${col}`] ??= []).push(halo);
      if (core) (groups[`c${col}`] ??= []).push(core);
    }
    return Object.entries(groups).map(([k, gs]) => [k, mergeGeometries(gs, false)] as const);
  }, [map]);
  return <>
    {byClass.map(([k, g]) => g && <mesh key={k} geometry={g} receiveShadow><meshStandardMaterial color={ROAD_C[k] ?? "#0c322d"} roughness={1} /></mesh>)}
    {glow.map(([k, g]) => g && <mesh key={k} geometry={g}><meshBasicMaterial color={k.slice(1)} transparent opacity={k[0] === "h" ? 0.18 : 0.95} depthWrite={false} toneMapped={false} /></mesh>)}
  </>;
}

/** Roads he could reach within 90 s at this moment, under the signal plan. */
function Reach({ map, segs, colour }: { map: CityMap; segs: number[]; colour: string }) {
  const geo = useMemo(() => {
    const ids = new Set(segs), gs = map.roads.filter((r) => ids.has(r.id)).map((r) => ribbon(r.pts, (ROAD_W[r.class] ?? 5) + 3, 0.3)).filter(Boolean) as THREE.BufferGeometry[];
    return gs.length ? mergeGeometries(gs, false) : null;
  }, [map, segs]);
  if (!geo) return null;
  return <mesh geometry={geo}><meshBasicMaterial color={colour} transparent opacity={0.35} depthWrite={false} toneMapped={false} /></mesh>;
}

function Car({ k, colour, glow, label, flash }: { k: Key; colour: string; glow?: boolean; label?: string; flash?: boolean }) {
  const light = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (light.current && flash) light.current.color.set(Math.floor(clock.elapsedTime * 4) % 2 ? "#ff2a2a" : "#2a6bff");
  });
  return (
    <group position={W2T(k.x, k.y)} rotation={[0, -(k.yaw ?? 0), 0]}>
      {glow && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.4, 0]}><circleGeometry args={[14, 32]} /><meshBasicMaterial color={colour} transparent opacity={0.22} depthWrite={false} toneMapped={false} /></mesh>}
      <mesh position={[0, 2.2, 0]} castShadow><boxGeometry args={[7, 4, 14]} /><meshStandardMaterial color={colour} emissive={colour} emissiveIntensity={glow ? 0.9 : 0.35} toneMapped={false} /></mesh>
      <mesh position={[0, 5, 1]}><boxGeometry args={[6, 2, 7]} /><meshStandardMaterial color={colour} emissive={colour} emissiveIntensity={0.3} /></mesh>
      {flash && <mesh position={[0, 5.6, 1]}><boxGeometry args={[3.6, 0.7, 1.2]} /><meshStandardMaterial ref={light} color="#ff2a2a" emissive="#ffffff" emissiveIntensity={0.6} toneMapped={false} /></mesh>}
      {label && <Html position={[0, 16, 0]} center distanceFactor={900} zIndexRange={[20, 0]}><div className="pointer-events-none whitespace-nowrap rounded bg-bg/85 px-2 py-0.5 text-[11px] font-semibold text-ink">{label}</div></Html>}
    </group>
  );
}

function Target({ x, y, label }: { x: number; y: number; label: string }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ring.current) return;
    const k = (clock.elapsedTime * 0.7) % 1;
    ring.current.scale.setScalar(1 + k * 2.5);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
  });
  return (
    <group position={W2T(x, y)}>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.6, 0]}><ringGeometry args={[22, 28, 48]} /><meshBasicMaterial color="#3ecf8e" transparent toneMapped={false} /></mesh>
      <mesh position={[0, 30, 0]}><cylinderGeometry args={[1.5, 8, 60, 16, 1, true]} /><meshBasicMaterial color="#3ecf8e" transparent opacity={0.25} side={THREE.DoubleSide} toneMapped={false} /></mesh>
      <Html position={[0, 68, 0]} center distanceFactor={900} zIndexRange={[20, 0]}><div className="pointer-events-none whitespace-nowrap rounded bg-ok px-2 py-0.5 text-[11px] font-bold text-bg">{label}</div></Html>
    </group>
  );
}

/** A held junction: a green bar along the one open exit, red along the rest. */
function SignalHold({ map, s, roadIndex }: { map: CityMap; s: any; roadIndex: Map<number, number[][]> }) {
  const bars = useMemo(() => {
    const out: { pts: THREE.Vector3[]; green: boolean }[] = [];
    for (const [ids, green] of [[s.green, true], [s.red, false]] as const) {
      for (const id of ids) {
        const pts = roadIndex.get(id);
        if (!pts) continue;
        const first = Math.hypot(pts[0][0] - s.x, pts[0][1] - s.y) < Math.hypot(pts[pts.length - 1][0] - s.x, pts[pts.length - 1][1] - s.y);
        const seq = first ? pts : [...pts].reverse();
        const a = seq[0], b = seq[Math.min(1, seq.length - 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, len = Math.min(40, L);
        out.push({ pts: [W2T(a[0], a[1], 1.2), W2T(a[0] + ((b[0] - a[0]) / L) * len, a[1] + ((b[1] - a[1]) / L) * len, 1.2)], green });
      }
    }
    return out;
  }, [s, roadIndex]);
  return (
    <group>
      {bars.map((b, i) => <Line key={i} points={b.pts} color={b.green ? "#3ecf8e" : "#ff4a4a"} lineWidth={6} />)}
      <mesh position={W2T(s.x, s.y, 9)}><sphereGeometry args={[3, 12, 10]} /><meshStandardMaterial color="#3ecf8e" emissive="#3ecf8e" emissiveIntensity={1.5} toneMapped={false} /></mesh>
      <mesh position={W2T(s.x, s.y, 4.5)}><cylinderGeometry args={[0.6, 0.6, 9, 8]} /><meshStandardMaterial color="#6b7590" /></mesh>
    </group>
  );
}

function Rig({ follow, focus }: { follow: boolean; focus: () => THREE.Vector3 | null }) {
  const controls = useThree((s) => (s as any).controls);
  const { camera } = useThree();
  useFrame(() => {
    if (!follow || !controls) return;
    const f = focus();
    if (!f) return;
    const delta = f.clone().sub(controls.target).multiplyScalar(0.06);
    controls.target.add(delta);
    camera.position.add(delta);
    controls.update();
  });
  return null;
}

export default function CityMap3D({ map, sim, t, follow, showReach, showBaseline }: { map: CityMap; sim: any; t: number; follow: boolean; showReach: boolean; showBaseline: boolean }) {
  const run = sim.run;
  const roadIndex = useMemo(() => new Map(map.roads.map((r) => [r.id, r.pts])), [map]);
  const suspect = keyAt(run.suspect, t);
  const trail = useMemo(() => run.suspect.filter((k: Key) => k.t <= t).map((k: Key) => W2T(k.x, k.y, 1.5)), [run, Math.floor(t)]);
  const ghost = showBaseline ? keyAt(sim.baseline.suspect, t) : null;
  const reachNow = [...run.reach].reverse().find((r: any) => r.t <= t);
  const target = [...run.targets].reverse().find((g: any) => g.t <= t);
  const old = run.targets.filter((g: any) => g.t <= t && g !== target && Math.hypot(g.x - (target?.x ?? 0), g.y - (target?.y ?? 0)) > 30);
  const holds = run.signals.filter((s: any) => t >= s.from && t <= s.to);
  const done = t >= run.duration;
  const start = run.start;
  const focus = () => (suspect ? W2T(suspect.x, suspect.y) : null);
  const c0 = W2T(start.x, start.y);

  return (
    <Canvas shadows gl={{ antialias: true, preserveDrawingBuffer: true }} camera={{ position: [c0.x - 380, 520, c0.z + 560], fov: 42, near: 5, far: 12000 }}>
      <color attach="background" args={["#f3f3f0"]} />
      <fog attach="fog" args={["#f3f3f0", 2200, 6000]} />
      <ambientLight intensity={0.85} color="#ffffff" />
      <hemisphereLight args={["#ffffff", "#b5b5b0", 0.7]} />
      <directionalLight position={[c0.x - 900, 1600, c0.z + 600]} intensity={1.6} color="#ffffff" castShadow shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-2200} shadow-camera-right={2200} shadow-camera-top={2200} shadow-camera-bottom={-2200} shadow-camera-far={5000} shadow-bias={-0.0005} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]} receiveShadow><planeGeometry args={[9000, 9000]} /><meshStandardMaterial color="#e6e6e2" roughness={1} /></mesh>
      <Roads map={map} />
      <Buildings map={map} />
      {showReach && reachNow && <Reach map={map} segs={reachNow.held} colour="#f5b84f" />}
      {holds.map((s: any, i: number) => <SignalHold key={`${s.junction}-${i}`} map={map} s={s} roadIndex={roadIndex} />)}
      {trail.length > 1 && <Line points={trail} color="#ff3b3b" lineWidth={4} />}
      {target && <Target x={target.x} y={target.y} label={done ? "Stopped here" : run.targets.indexOf(target) > 0 ? "New spot: steer him here" : "Steer him here"} />}
      {old.map((g: any, i: number) => (
        <group key={i} position={W2T(g.x, g.y)}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.5, 0]}><ringGeometry args={[20, 24, 40]} /><meshBasicMaterial color="#8a93a0" transparent opacity={0.5} toneMapped={false} /></mesh>
          <Html position={[0, 30, 0]} center distanceFactor={900} zIndexRange={[20, 0]}><div className="pointer-events-none whitespace-nowrap rounded bg-bg/85 px-2 py-0.5 text-[11px] text-muted line-through">old spot</div></Html>
        </group>
      ))}
      {map.places.filter((p) => p.amenity === "police").map((p, i) => (
        <group key={i} position={W2T(p.x, p.y)}>
          <mesh position={[0, 6, 0]}><boxGeometry args={[12, 12, 12]} /><meshStandardMaterial color="#2a6bff" emissive="#2a6bff" emissiveIntensity={0.4} /></mesh>
        </group>
      ))}
      {run.units.map((u: any) => { const k = keyAt(u.keys, t); return k ? <Car key={u.id} k={k} colour="#2f6dff" flash={u.goal != null} label={u.goal != null ? `${u.id} · ${u.role}` : undefined} /> : null; })}
      {ghost && <Car k={ghost} colour="#8a93a0" label="without the system" />}
      {suspect && <Car k={suspect} colour="#ff2b2b" glow label={sim.plate ? `Suspect · ${sim.plate}` : "Suspect"} />}
      <mesh position={W2T(start.x, start.y, 0.5)} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[14, 18, 32]} /><meshBasicMaterial color="#ff5d5d" toneMapped={false} /></mesh>
      <OrbitControls makeDefault target={W2T(start.x + 150, start.y + 150)} maxPolarAngle={Math.PI / 2.15} minDistance={150} maxDistance={6000} />
      <Rig follow={follow} focus={focus} />
    </Canvas>
  );
}
