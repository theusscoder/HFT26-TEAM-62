import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Metric, MetricTrack } from "./TopView";
import { ClayVehicle, TWIN, TwinCity, type RoadModel } from "./TwinCity";

/* The reconstruction in 3D, built from the footage and checked against it (backend/app/pipeline/scene3d.py).
   World: x across the road, y along it (metres). three.js: X = x, Z = -y, Y = up.
   - The solved CCTV camera projects a clean plate of the real scene onto the ground and proxy walls, so this is the
     place itself. Stand where the camera stood and the 3D lines up with the footage: that is the test.
   - Vehicles are fitted to their detector boxes, and carry their own faces rectified out of the video.
   - Motion, heading, brake lamps and body pitch are measured. The impact sparks are illustrative, and labelled so.
   - Two looks over the same measured motion: "twin" (the dark city, vehicles in question lit up; its buildings are
     illustrative) and "photo" (the projected footage). */

export type CamPreset = "cinema" | "cctv" | "bird" | "top" | "chase" | `witness:${string}`;
export type Look = "twin" | "photo";

const DIMS: Record<string, [number, number, number]> = {   // length, height, width (m)
  bus: [9, 3.0, 2.5], truck: [8, 3.2, 2.5], car: [4.4, 1.5, 1.8], motorcycle: [2.0, 1.2, 0.7], bicycle: [1.8, 1.1, 0.5],
};
const COLOUR: Record<string, string> = { white: "#e8eaee", silver: "#b9bfc8", grey: "#7c838e", black: "#2a2d33", red: "#d8443c", blue: "#2f6fc4",
  green: "#3fa86b", yellow: "#e4c341", orange: "#e58b3a", purple: "#8a5cd0", brown: "#6b4a32" };
const W2T = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
const SKY = "#a9b8c6";
const BRAKE_G = 0.12;  // same threshold as sensor.py

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

// ---------- scene data ----------

export interface ScenePoint { t: number; x: number; y: number; yaw: number; v_kmh: number; v_sigma: number }
export interface SceneTrack { id: string; class: string; kind: string; colour_name?: string | null; dims: { length: number; width: number; height: number };
  iou?: number | null; n_checked?: number; riders?: number; vlm?: { type?: string | null; colour?: string | null }; points: ScenePoint[]; texture?: { faces?: Record<string, string>; from_t?: number } }
export interface SceneData {
  camera: { position: number[]; forward: number[]; up: number[]; fov_deg: number; focal_px: number; width: number; height: number; content: number[]; height_m: number; reproj_err_px: number; method: string; people_used: number };
  actors?: { model: string | null; asked: number; riders_on_tracked_bikes: number; riders_seen_by_vision: number };
  plate: string; tracks: SceneTrack[]; impact?: number[] | null; witnesses: Record<string, number[]>; road?: RoadModel;
  scale_check?: { map_vs_camera_across_road: number; map_vs_camera_along_road: number };
  fit: { iou_key: number | null; iou_all: number | null; frames_checked: number; median_person_height_m: number | null };
}
interface Prepared extends SceneTrack { dist: number[] }

const FALLBACK: Record<string, [number, number, number]> = { bus: [9, 2.5, 3], truck: [8, 2.5, 3.2], car: [4.4, 1.8, 1.5], motorcycle: [2, 0.7, 1.4], bicycle: [1.8, 0.5, 1.4], person: [0.42, 0.42, 1.7] };

function prepare(tr: SceneTrack): Prepared {
  const dist = [0];
  for (let i = 1; i < tr.points.length; i++) dist.push(dist[i - 1] + Math.hypot(tr.points[i].x - tr.points[i - 1].x, tr.points[i].y - tr.points[i - 1].y));
  return { ...tr, dist };
}

function fromMetric(metric: Metric, large: Set<string>): SceneTrack[] {
  return metric.tracks.map((tr) => {
    const kind = tr.class === "car" && large.has(tr.id) ? "bus" : tr.class;
    const [length, width, height] = FALLBACK[kind] ?? FALLBACK.car;
    return { id: tr.id, class: tr.class, kind, colour_name: tr.colour_name, dims: { length, width, height },
      points: tr.points.map((p) => ({ ...p, yaw: headingAt(tr, p.t, Math.max(0.8, 0.4 * length)) ?? 0 })) };
  });
}

/** State at time t, by binary search: this runs for every road user on every frame. */
function sample(tr: Prepared, t: number) {
  const p = tr.points, n = p.length;
  if (t < p[0].t - 0.05 || t > p[n - 1].t + 0.05) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].t <= t) lo = m; else hi = m; }
  const a = p[lo], b = p[hi], k = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
  const v = a.v_kmh + (b.v_kmh - a.v_kmh) * k;
  const back = p[Math.max(0, lo - 8)], ahead = p[Math.min(n - 1, hi + 8)];
  const accelG = ((ahead.v_kmh - back.v_kmh) / 3.6) / Math.max(ahead.t - back.t, 0.05) / 9.81;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, yaw: a.yaw + (b.yaw - a.yaw) * k, v, accelG, dist: tr.dist[lo] + (tr.dist[hi] - tr.dist[lo]) * k };
}

// ---------- the real place: footage projected from the solved camera ----------

function projectorOf(cam: SceneData["camera"]) {
  const c = new THREE.PerspectiveCamera(cam.fov_deg, cam.width / cam.height, 0.1, 1000);
  const [x, y, z] = cam.position;
  c.position.copy(W2T(x, y, z));
  c.up.set(cam.up[0], cam.up[2], -cam.up[1]);
  c.lookAt(new THREE.Vector3(x + cam.forward[0] * 10, z + cam.forward[2] * 10, -(y + cam.forward[1] * 10)));
  c.updateProjectionMatrix();
  c.updateMatrixWorld(true);
  return c;
}

function ProjectedSet({ caseId, scene, bounds }: { caseId: string; scene: SceneData; bounds: { x0: number; x1: number; y0: number; y1: number } }) {
  const tex = useLoader(THREE.TextureLoader, `/api/cases/${caseId}/scene/${scene.plate}`);
  const material = useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 8;
    const cam = scene.camera, proj = projectorOf(cam);
    const vp = new THREE.Matrix4().multiplyMatrices(proj.projectionMatrix, proj.matrixWorldInverse);
    const [cx0, cy0, cx1, cy1] = cam.content;
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, vp: { value: vp }, box: { value: new THREE.Vector4(cx0 / cam.width, 1 - cy1 / cam.height, cx1 / cam.width, 1 - cy0 / cam.height) }, fogCol: { value: new THREE.Color(SKY) } },
      vertexShader: `varying vec4 vClip; uniform mat4 vp; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vClip = vp * w; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `varying vec4 vClip; uniform sampler2D map; uniform vec4 box; uniform vec3 fogCol;
        void main() {
          if (vClip.w <= 0.0) discard;
          vec2 uv = vClip.xy / vClip.w * 0.5 + 0.5;
          float m = 3.0 / 720.0;
          if (uv.x < box.x + m || uv.x > box.z - m || uv.y < box.y + m || uv.y > box.w - m) discard;
          gl_FragColor = texture2D(map, uv);
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
    });
  }, [tex, scene]);
  const { x0, x1, y0, y1 } = bounds, W = 14;
  const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={W2T(xm, ym, 0.005)} material={material}><planeGeometry args={[x1 - x0, y1 - y0, 1, 1]} /></mesh>
      <mesh position={W2T(x0, ym, W / 2)} rotation={[0, Math.PI / 2, 0]} material={material}><planeGeometry args={[y1 - y0, W]} /></mesh>
      <mesh position={W2T(x1, ym, W / 2)} rotation={[0, -Math.PI / 2, 0]} material={material}><planeGeometry args={[y1 - y0, W]} /></mesh>
      <mesh position={W2T(xm, y1, W / 2)} material={material}><planeGeometry args={[x1 - x0, W]} /></mesh>
    </group>
  );
}

// ---------- road users ----------

function useFaces(caseId: string, tr: SceneTrack) {
  const faces = tr.texture?.faces ?? {};
  return useMemo(() => {
    const loader = new THREE.TextureLoader(), out: Record<string, THREE.Texture> = {};
    Object.entries(faces).forEach(([k, f]) => {
      const t = loader.load(`/api/cases/${caseId}/scene/${f}`);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      out[k] = t;
    });
    return out;
  }, [caseId, tr.id]);
}

function Wheels({ L, W, r, dist, count = 2 }: { L: number; W: number; r: number; dist: number; count?: number }) {
  const zs = count === 2 ? [-L * 0.32, L * 0.32] : [-L * 0.36, L * 0.3, L * 0.38];
  return (
    <>
      {zs.flatMap((z) => [-1, 1].map((s) => (
        <group key={`${z}${s}`} position={[s * (W / 2 + 0.005), r, z]} rotation={[-dist / r, 0, 0]}>
          <mesh rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[r, r, 0.24, 18]} /><meshStandardMaterial color="#17191c" roughness={0.9} /></mesh>
          <mesh rotation={[0, 0, Math.PI / 2]} position={[s * 0.125, 0, 0]}><cylinderGeometry args={[r * 0.55, r * 0.55, 0.01, 8]} /><meshStandardMaterial color="#8d939b" metalness={0.5} roughness={0.4} /></mesh>
        </group>
      )))}
    </>
  );
}

const FACE_ORDER = ["px", "nx", "py", "ny", "pz", "nz"];

function BoxVehicle({ tr, caseId, s, main }: { tr: Prepared; caseId: string; s: NonNullable<ReturnType<typeof sample>>; main: boolean }) {
  const { length: L, width: W, height: H } = tr.dims;
  const tex = useFaces(caseId, tr);
  const col = COLOUR[tr.colour_name ?? ""] ?? "#8f96a0";
  const materials = useMemo(() => FACE_ORDER.map((f) => tex[f]
    ? new THREE.MeshBasicMaterial({ map: tex[f], toneMapped: false })
    : new THREE.MeshStandardMaterial({ color: f === "ny" ? "#111" : col, metalness: 0.25, roughness: 0.55 })), [tex, col]);
  const textured = Object.keys(tex).length > 0;
  const big = L > 5.5;
  const braking = s.accelG < -BRAKE_G && s.v > 1;
  // Body pitch follows the measured deceleration (nose dips by up to 2 degrees).
  const pitch = THREE.MathUtils.clamp(-s.accelG * 0.09, -0.035, 0.035);
  const glassZ = -L / 2 - 0.01;
  return (
    <group rotation={[pitch, 0, 0]}>
      <mesh position={[0, H / 2, 0]} castShadow material={materials}><boxGeometry args={[W, H, L]} /></mesh>
      {!textured && !big && (
        <mesh position={[0, H * 0.82, L * 0.03]} castShadow><boxGeometry args={[W * 0.86, H * 0.36, L * 0.52]} /><meshStandardMaterial color="#1c2733" metalness={0.6} roughness={0.2} /></mesh>
      )}
      {!tex.px && !textured && big && <mesh position={[W / 2 + 0.01, H * 0.66, 0]}><boxGeometry args={[0.01, H * 0.28, L * 0.86]} /><meshStandardMaterial color="#1c2733" metalness={0.6} roughness={0.2} /></mesh>}
      {!tex.nx && !textured && big && <mesh position={[-W / 2 - 0.01, H * 0.66, 0]}><boxGeometry args={[0.01, H * 0.28, L * 0.86]} /><meshStandardMaterial color="#1c2733" metalness={0.6} roughness={0.2} /></mesh>}
      <Wheels L={L} W={W} r={big ? 0.48 : 0.32} dist={s.dist} />
      {/* brake lamps: lit when the track itself is decelerating */}
      {[-1, 1].map((k) => (
        <mesh key={k} position={[k * W * 0.38, H * (big ? 0.28 : 0.55), L / 2 + 0.02]}>
          <boxGeometry args={[W * 0.14, 0.12, 0.03]} />
          <meshStandardMaterial color={braking ? "#ff2a2a" : "#4a1414"} emissive={braking ? "#ff1a1a" : "#000"} emissiveIntensity={braking ? 3 : 0} />
        </mesh>
      ))}
      {main && !tex.nz && [-1, 1].map((k) => <mesh key={`h${k}`} position={[k * W * 0.36, H * 0.35, glassZ]}><boxGeometry args={[W * 0.16, 0.14, 0.02]} /><meshStandardMaterial color="#fff6d8" emissive="#fff0b8" emissiveIntensity={0.6} /></mesh>)}
    </group>
  );
}

function TwoWheeler({ tr, s, main, tint }: { tr: Prepared; s: NonNullable<ReturnType<typeof sample>>; main: boolean; tint?: string }) {
  const L = tr.dims.length, H = tr.dims.height, r = 0.29;
  const body = tint ?? COLOUR[tr.colour_name ?? ""] ?? "#40444b";
  const riders = tr.riders ?? (H > 1.25 ? 1 : 0);
  const rider = riders > 0;
  return (
    <group>
      {[-L * 0.34, L * 0.34].map((z) => (
        <group key={z} position={[0, r, z]} rotation={[-s.dist / r, 0, 0]}>
          <mesh rotation={[0, Math.PI / 2, 0]} castShadow><torusGeometry args={[r * 0.8, r * 0.22, 8, 22]} /><meshStandardMaterial color="#141517" /></mesh>
        </group>
      ))}
      <mesh position={[0, 0.58, 0]} rotation={[0.1, 0, 0]} castShadow><boxGeometry args={[0.26, 0.34, L * 0.52]} /><meshStandardMaterial color={body} metalness={0.4} roughness={0.45} /></mesh>
      <mesh position={[0, 0.92, -L * 0.28]}><boxGeometry args={[0.62, 0.05, 0.05]} /><meshStandardMaterial color="#222" /></mesh>
      {rider && <group position={[0, 0, L * 0.03]}>
        <mesh position={[0, 1.08, 0]} rotation={[-0.25, 0, 0]} castShadow><capsuleGeometry args={[0.17, 0.42, 4, 10]} /><meshStandardMaterial color={tint ?? (main ? "#31404f" : "#3c4048")} emissive={tint && main ? tint : "#000"} emissiveIntensity={tint && main ? 0.4 : 0} /></mesh>
        <mesh position={[0, 1.55, -0.1]} castShadow><sphereGeometry args={[0.135, 14, 12]} /><meshStandardMaterial color="#20242a" metalness={0.3} roughness={0.35} /></mesh>
        {[-1, 1].map((k) => <mesh key={k} position={[k * 0.18, 0.72, -0.1]} rotation={[0.8, 0, 0]}><capsuleGeometry args={[0.065, 0.36, 3, 8]} /><meshStandardMaterial color="#26282c" /></mesh>)}
      </group>}
      {riders > 1 && <group position={[0, 0, L * 0.26]}>
        <mesh position={[0, 1.12, 0]} rotation={[-0.15, 0, 0]} castShadow><capsuleGeometry args={[0.15, 0.38, 4, 10]} /><meshStandardMaterial color={tint ?? "#4a4f58"} /></mesh>
        <mesh position={[0, 1.56, -0.04]} castShadow><sphereGeometry args={[0.12, 14, 12]} /><meshStandardMaterial color={tint ?? "#8a6a52"} /></mesh>
      </group>}
    </group>
  );
}

function Pedestrian({ tr, s, main, tint }: { tr: Prepared; s: NonNullable<ReturnType<typeof sample>>; main: boolean; tint?: string }) {
  const H = tr.dims.height;
  // Legs swing with distance actually walked, so someone standing still stands still.
  const swing = Math.sin(s.dist * 3.4) * Math.min(0.6, s.v / 5);
  const cloth = tint ?? (main ? "#1e2b42" : COLOUR[tr.colour_name ?? ""] ?? "#5a616b");
  const legH = H * 0.46;
  return (
    <group>
      {[-1, 1].map((k) => (
        <group key={k} position={[k * 0.1, legH, 0]} rotation={[k * swing, 0, 0]}>
          <mesh position={[0, -legH / 2, 0]} castShadow><capsuleGeometry args={[0.07, legH - 0.14, 3, 8]} /><meshStandardMaterial color="#20232a" /></mesh>
        </group>
      ))}
      <mesh position={[0, H * 0.66, 0]} castShadow><capsuleGeometry args={[0.15, H * 0.2, 4, 10]} /><meshStandardMaterial color={cloth} /></mesh>
      {[-1, 1].map((k) => (
        <group key={k} position={[k * 0.21, H * 0.8, 0]} rotation={[-k * swing * 0.8, 0, 0]}>
          <mesh position={[0, -H * 0.15, 0]}><capsuleGeometry args={[0.05, H * 0.24, 3, 8]} /><meshStandardMaterial color={cloth} /></mesh>
        </group>
      ))}
      <mesh position={[0, H * 0.93, 0]} castShadow><sphereGeometry args={[0.11, 14, 12]} /><meshStandardMaterial color={tint ?? "#8a6a52"} /></mesh>
    </group>
  );
}

function RoadUser({ tr, t, caseId, main, label, showBox, look, primary, solid }: { tr: Prepared; t: number; caseId: string; main: boolean; label?: string; showBox: boolean; look: Look; primary: boolean; solid: boolean }) {
  const s = sample(tr, t);
  if (!s) return null;
  const { length: L, width: W, height: H } = tr.dims;
  const person = tr.kind === "person", two = tr.kind === "motorcycle" || tr.kind === "bicycle";
  return (
    <group position={W2T(s.x, s.y)} rotation={[0, -s.yaw, 0]}>
      {!solid ? null : look === "twin" ? (() => {
        const tint = primary ? TWIN.primary : main ? TWIN.involved : person ? TWIN.person : TWIN.neutral;
        if (person) return <Pedestrian tr={tr} s={s} main={main} tint={tint} />;
        if (two) return <TwoWheeler tr={tr} s={s} main={main} tint={tint} />;
        return <ClayVehicle kind={tr.kind} L={L} W={W} H={H} colour={tint} glow={main} braking={s.accelG < -BRAKE_G && s.v > 1} pitch={THREE.MathUtils.clamp(-s.accelG * 0.09, -0.035, 0.035)} />;
      })() : person ? <Pedestrian tr={tr} s={s} main={main} /> : two ? <TwoWheeler tr={tr} s={s} main={main} />
        : <ClayVehicle kind={tr.kind} L={L} W={W} H={H} colour={COLOUR[tr.colour_name ?? ""] ?? "#8f96a0"} glow={false} braking={s.accelG < -BRAKE_G && s.v > 1} pitch={THREE.MathUtils.clamp(-s.accelG * 0.09, -0.035, 0.035)} />}
      {showBox && <lineSegments position={[0, H / 2, 0]}>
        <edgesGeometry args={[new THREE.BoxGeometry(W, H, L)]} />
        <lineBasicMaterial color={person ? "#ffe45c" : "#3cff8f"} />
      </lineSegments>}
      {label && <Html position={[0, H + 0.7, 0]} center distanceFactor={16} zIndexRange={[20, 0]}>
        <div className="pointer-events-none whitespace-nowrap rounded bg-bg/85 px-2 py-0.5 text-[11px] font-semibold text-ink">{label}{person ? "" : ` · ${s.v.toFixed(0)} km/h`}</div>
      </Html>}
    </group>
  );
}

// ---------- marks on the road ----------

function SpeedRibbon({ tr, t, vmax }: { tr: Prepared; t: number; vmax: number }) {
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(() => {
    const pts = tr.points.filter((p) => p.t <= t);
    if (pts.length < 2) { geo.setDrawRange(0, 0); return; }
    const w = 0.28, pos: number[] = [], col: number[] = [], idx: number[] = [];
    pts.forEach((p, i) => {
      const q = pts[Math.min(i + 1, pts.length - 1)], r = pts[Math.max(i - 1, 0)];
      const dx = q.x - r.x, dy = q.y - r.y, n = Math.hypot(dx, dy) || 1;
      const ox = (dy / n) * w, oy = (-dx / n) * w;
      const c = speedColour(p.v_kmh, vmax);
      pos.push(p.x - ox, 0.03, -(p.y - oy), p.x + ox, 0.03, -(p.y + oy));
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (i < pts.length - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geo.setDrawRange(0, idx.length);
  }, [tr, t, vmax, geo]);
  return <mesh geometry={geo}><meshBasicMaterial vertexColors transparent opacity={0.8} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} /></mesh>;
}

function SpeedCurtain({ tr, t, vmax, scale }: { tr: Prepared; t: number; vmax: number; scale: number }) {
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
  return <mesh geometry={geo}><meshBasicMaterial vertexColors transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} /></mesh>;
}

/** Illustrative only. Everything is a function of t, so scrubbing backwards replays it exactly. */
function ImpactFX({ x, y, t }: { x: number; y: number; t: number }) {
  const N = 70;
  const seeds = useMemo(() => Array.from({ length: N }, (_, i) => {
    const a = (i * 2.399963) % (Math.PI * 2), sp = 2 + ((i * 37) % 50) / 10;
    return [Math.cos(a) * sp, 1.5 + ((i * 53) % 40) / 10, Math.sin(a) * sp];
  }), []);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    return g;
  }, []);
  const dt = t;
  useEffect(() => {
    if (dt < 0 || dt > 1.1) return;
    const a = geo.getAttribute("position") as THREE.BufferAttribute;
    seeds.forEach((s, i) => a.setXYZ(i, s[0] * dt, Math.max(0.02, 0.6 + s[1] * dt - 4.9 * dt * dt), s[2] * dt));
    a.needsUpdate = true;
    geo.computeBoundingSphere();
  }, [dt, geo, seeds]);
  const ring = Math.max(0, dt);
  return (
    <group position={W2T(x, y)}>
      {dt >= 0 && dt < 1.1 && <points geometry={geo}><pointsMaterial color="#ffb347" size={0.09} transparent opacity={Math.max(0, 1 - dt / 1.1)} depthWrite={false} toneMapped={false} /></points>}
      {dt >= 0 && dt < 1.4 && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} scale={1 + ring * 5}><ringGeometry args={[0.72, 0.8, 64]} /><meshBasicMaterial color="#ff5d5d" transparent opacity={Math.max(0, 0.9 - dt * 0.65)} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} /></mesh>}
    </group>
  );
}

function ImpactMark({ x, y, t, cctv }: { x: number; y: number; t: number; cctv: boolean }) {
  if (t < -0.15 || cctv) return null;
  return (
    <group position={W2T(x, y)}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}><ringGeometry args={[0.9, 1.0, 48]} /><meshBasicMaterial color="#ff5d5d" transparent opacity={0.8} toneMapped={false} /></mesh>
      <Html position={[0, 4.6, 0]} center distanceFactor={18} zIndexRange={[20, 0]}><div className="pointer-events-none rounded bg-bad px-2 py-0.5 text-[11px] font-bold text-bg">IMPACT · T0</div></Html>
    </group>
  );
}

// ---------- camera ----------

const smooth = (a: number, b: number, x: number) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
/** The cinematic path is a function of t, not of wall-clock time: scrub it and the shot follows. [t, behind, side, up] */
const SHOTS = [[-6, 26, -10, 12], [-3, 20, -9, 8], [-0.8, 13, -10, 4.5], [0.3, 8, -12, 3.2], [1.8, -4, -15, 4.5], [4, -12, -18, 9]];

function CameraRig({ preset, focus, witnesses, impact, scene, t, axis }: { preset: CamPreset; focus: () => { pos: THREE.Vector3; yaw: number }; witnesses: Record<string, number[]>; impact: THREE.Vector3; scene: SceneData | null; t: number; axis: number }) {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3().copy(impact));
  const controls = useThree((s) => (s as any).controls);
  const until = useRef(0);
  const cam = camera as THREE.PerspectiveCamera;
  useEffect(() => {
    until.current = performance.now() + 1600;
    if (preset === "cctv" && scene) {
      const p = projectorOf(scene.camera);
      cam.fov = scene.camera.fov_deg;
      cam.position.copy(p.position);
      cam.up.copy(p.up);
      cam.quaternion.copy(p.quaternion);
      cam.updateProjectionMatrix();
      return;
    }
    cam.fov = preset === "bird" ? 30 : 42;
    cam.up.set(0, 1, 0);
    cam.updateProjectionMatrix();
  }, [preset, scene, cam]);
  useFrame(() => {
    if (preset === "cctv") return;
    const continuous = preset === "chase" || preset === "cinema" || preset.startsWith("witness:");
    if (!continuous && performance.now() > until.current) return;   // settle, then hand control back to the user
    let pos: THREE.Vector3, look: THREE.Vector3;
    const f = focus();
    const fw = new THREE.Vector3(Math.sin(f.yaw), 0, -Math.cos(f.yaw)), right = new THREE.Vector3(Math.cos(f.yaw), 0, Math.sin(f.yaw));
    if (preset === "top") { pos = impact.clone().add(new THREE.Vector3(0, 34, 0.01)); look = impact; }
    else if (preset === "chase") { pos = f.pos.clone().addScaledVector(fw, -13).add(new THREE.Vector3(0, 5.5, 0)); look = f.pos; }
    else if (preset === "cinema") {
      let i = 0;
      while (i < SHOTS.length - 2 && t > SHOTS[i + 1][0]) i++;
      const a = SHOTS[i], b = SHOTS[i + 1], k = smooth(a[0], b[0], t);
      const behind = a[1] + (b[1] - a[1]) * k, side = a[2] + (b[2] - a[2]) * k, up = a[3] + (b[3] - a[3]) * k;
      const anchor = f.pos.clone().lerp(impact, smooth(-1.5, 0.5, t) * 0.7);
      pos = anchor.clone().addScaledVector(fw, -behind).addScaledVector(right, side).add(new THREE.Vector3(0, up, 0));
      look = anchor.clone().add(new THREE.Vector3(0, 1, 0));
    } else if (preset.startsWith("witness:")) {
      const w = witnesses[preset.slice(8)];
      if (!w) return;
      pos = W2T(w[0], w[1], 1.6); look = f.pos;
    } else {
      // From the road's near corner, high up, looking across at the city: the crash sits in the lower part of the frame.
      const across = new THREE.Vector3(Math.cos(axis), 0, Math.sin(axis)), along = new THREE.Vector3(Math.sin(axis), 0, -Math.cos(axis));
      pos = impact.clone().addScaledVector(across, -32).addScaledVector(along, -52).add(new THREE.Vector3(0, 50, 0));
      look = impact.clone().addScaledVector(along, 15);
    }
    camera.position.lerp(pos, preset === "cinema" ? 0.12 : 0.08);
    target.current.lerp(look, 0.14);
    if (controls) { controls.target.copy(target.current); controls.update(); } else camera.lookAt(target.current);
  });
  return null;
}

function Sync({ canvasAlpha, look }: { canvasAlpha: boolean; look: Look }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const sky = look === "twin" ? TWIN.sky : SKY;
    gl.setClearColor(canvasAlpha ? 0x000000 : new THREE.Color(sky).getHex(), canvasAlpha ? 0 : 1);
    scene.fog = canvasAlpha ? null : look === "twin" ? new THREE.Fog(sky, 140, 420) : new THREE.Fog(sky, 70, 170);
  }, [canvasAlpha, look, gl, scene]);
  return null;
}

export default function Scene3D({ caseId, metric, scene, t, entities, witnesses, preset, curtain, sight, large, effects, showBoxes, solid, look: wanted }: {
  caseId: string; metric: Metric; scene: SceneData | null; t: number; entities: any; witnesses: Record<string, any>; preset: CamPreset;
  curtain: boolean; sight: boolean; large: Set<string>; effects: boolean; showBoxes: boolean; solid: boolean; look: Look;
}) {
  const look: Look = preset === "cctv" ? "photo" : wanted;
  const key = useMemo(() => new Set<string>([entities?.primary, ...(entities?.involved ?? [])].filter(Boolean)), [entities]);
  const all = useMemo(() => (scene?.tracks ?? fromMetric(metric, large)).filter((tr) => tr.points.length > 1).map(prepare), [scene, metric, large]);
  const keyTracks = all.filter((tr) => key.has(tr.id));
  const vmax = Math.max(10, ...keyTracks.flatMap((tr) => tr.points.map((p) => p.v_kmh)));
  const prim = all.find((tr) => tr.id === entities?.primary);
  const ps0 = prim ? sample(prim, 0) : null;
  const ix = scene?.impact ?? entities?.impact_xy ?? (ps0 ? [ps0.x, ps0.y] : [0, 0]);
  const impact = useMemo(() => W2T(ix[0], ix[1]), [ix[0], ix[1]]);
  const focus = () => {
    const s = prim ? sample(prim, Math.min(t, prim.points[prim.points.length - 1].t)) ?? sample(prim, prim.points[0].t) : null;
    return { pos: s ? W2T(s.x, s.y, 1) : impact, yaw: s?.yaw ?? 0 };
  };
  const names: Record<string, string> = entities?.names ?? {};
  const cctv = preset === "cctv" && !!scene;
  const near = all.filter((tr) => !key.has(tr.id) && tr.points.some((p) => Math.hypot(p.x - ix[0], p.y - ix[1]) < 40));
  const bounds = useMemo(() => {
    const pts = all.flatMap((tr) => tr.points).filter((p) => Math.hypot(p.x - ix[0], p.y - ix[1]) < 80);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const cy = scene?.camera.position[1] ?? Math.min(...ys);
    return { x0: Math.min(...xs) - 5, x1: Math.max(...xs) + 5, y0: Math.min(cy, Math.min(...ys)) - 1, y1: Math.max(...ys) + 6 };
  }, [all, scene]);
  const pinned: Record<string, number[]> = scene?.witnesses ?? Object.fromEntries(Object.entries(witnesses).filter(([, m]: any) => m.position_m).map(([w, m]: any) => [w, m.position_m]));
  const metricPrim = metric.tracks.find((tr) => tr.id === entities?.primary);
  const sun = useMemo(() => impact.clone().add(look === "twin" ? new THREE.Vector3(-46, 58, 24) : new THREE.Vector3(14, 26, 10)), [impact, look]);
  const road: RoadModel = useMemo(() => scene?.road ?? { axis: 0, cx: ix[0], cy: ix[1], half: 5 }, [scene, ix[0], ix[1]]);

  return (
    <Canvas shadows gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }} camera={{ position: [impact.x - 32, 50, impact.z + 52], fov: 30, near: 0.1, far: 900 }} style={{ background: "transparent" }}>
      <Sync canvasAlpha={cctv} look={look} />
      <ambientLight intensity={look === "twin" ? 1.0 : 1.1} color="#fff" />
      <hemisphereLight args={look === "twin" ? ["#ffffff", "#bdbdb8", 0.7] : ["#dfe9f5", "#5b5f63", 0.7]} />
      <directionalLight key={look} position={sun} target-position={impact} intensity={look === "twin" ? 2.1 : 1.6} color="#fff" castShadow shadow-mapSize={[4096, 4096]} shadow-bias={-0.0004}
        shadow-camera-left={-120} shadow-camera-right={120} shadow-camera-top={120} shadow-camera-bottom={-120} shadow-camera-far={320} />

      {!cctv && look === "twin" && <TwinCity seed={caseId} road={road} />}
      {!cctv && <>
        {look === "photo" && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[impact.x, -0.02, impact.z]}><planeGeometry args={[500, 500]} /><meshBasicMaterial color="#6d7176" /></mesh>}
        {look === "photo" && scene && <ProjectedSet caseId={caseId} scene={scene} bounds={bounds} />}
        {look === "photo" && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[impact.x, 0.012, impact.z]} receiveShadow><planeGeometry args={[220, 220]} /><shadowMaterial opacity={0.38} /></mesh>}
        {keyTracks.filter((tr) => tr.kind !== "person").map((tr) => <SpeedRibbon key={`r${tr.id}`} tr={tr} t={t} vmax={vmax} />)}
        {curtain && keyTracks.filter((tr) => tr.kind !== "person").map((tr) => <SpeedCurtain key={`c${tr.id}`} tr={tr} t={t} vmax={vmax} scale={0.09} />)}
      </>}

      {[...keyTracks, ...near].map((tr) => (
        <RoadUser key={tr.id} tr={tr} t={t} caseId={caseId} main={key.has(tr.id)} primary={tr.id === entities?.primary} look={look} showBox={showBoxes} solid={!cctv || solid}
          label={!cctv && tr.id === entities?.primary ? names[tr.id]?.replace(" (primary)", "") ?? tr.id : undefined} />
      ))}
      {effects && !cctv && <ImpactFX x={ix[0]} y={ix[1]} t={t} />}
      <ImpactMark x={ix[0]} y={ix[1]} t={t} cctv={cctv} />

      {!cctv && look === "photo" && scene && <group position={projectorOf(scene.camera).position}>
        <mesh><boxGeometry args={[0.5, 0.35, 0.7]} /><meshStandardMaterial color="#1a2a44" /></mesh>
        <Html position={[0, 0.7, 0]} center distanceFactor={16} zIndexRange={[20, 0]}><div className="pointer-events-none rounded bg-observed/90 px-1.5 text-[10px] text-white">CCTV · {scene.camera.height_m.toFixed(1)} m up</div></Html>
      </group>}

      {!cctv && sight && Object.entries(pinned).map(([w, p]) => {
        const m = witnesses[w];
        if (!m) return null;
        const s = prim ? sample(prim, t) : null;
        const pp = metricPrim ? at(metricPrim, t) : null;
        const by = sight && pp?.live && m.position_m ? blocked({ x: m.position_m[0], y: m.position_m[1] }, pp, metric.tracks, t, new Set([metricPrim!.id]), large) : null;
        return (
          <group key={w}>
            <mesh position={W2T(p[0], p[1], 0.9)} castShadow><capsuleGeometry args={[0.2, 1.3, 4, 10]} /><meshStandardMaterial color="#c58cff" emissive="#4b2a6b" /></mesh>
            <Html position={W2T(p[0], p[1], 2.3)} center distanceFactor={14} zIndexRange={[20, 0]}><div className="pointer-events-none whitespace-nowrap rounded bg-claimed/90 px-1.5 text-[10px] font-semibold text-bg">{m.name}</div></Html>
            {sight && s && <Line points={[W2T(p[0], p[1], 1.6), W2T(s.x, s.y, 1.2)]} color={by ? "#ff5d5d" : "#3ecf8e"} lineWidth={2} dashed dashSize={0.6} gapSize={0.35} />}
          </group>
        );
      })}

      <OrbitControls makeDefault enabled={!cctv && preset !== "cinema"} enableDamping maxPolarAngle={Math.PI / 2.05} />
      <CameraRig preset={preset} focus={focus} witnesses={pinned} impact={impact} scene={scene} t={t} axis={road.axis} />
    </Canvas>
  );
}
