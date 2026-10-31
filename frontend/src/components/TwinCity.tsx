import { useMemo } from "react";
import * as THREE from "three";
import { useLoader } from "@react-three/fiber";

/* The digital-twin look: a dark, matte city around the crash, with the vehicles in question lit up.
   The road's position, width, divider and crossing come from the case. The surrounding buildings are ILLUSTRATIVE
   (seeded from the case id), because a road camera can't see them; the page says so. Traffic is only what was tracked:
   no filler cars, since on an evidence screen a car that wasn't there would be a false statement. */

export interface RoadModel { axis: number; cx: number; cy: number; half: number; divider?: number[] | null; zebra?: number[] | null }
/** The real road surface: the footage's clean plate projected straight down onto the solved ground (scene3d.ground_photo). */
export interface GroundPhoto { file: string; x0: number; x1: number; y0: number; y1: number }

export function GroundPhotoLayer({ caseId, g }: { caseId: string; g: GroundPhoto }) {
  const tex = useLoader(THREE.TextureLoader, `/api/cases/${caseId}/scene/${g.file}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(g.x0 + g.x1) / 2, 0.012, -(g.y0 + g.y1) / 2]} receiveShadow renderOrder={1}>
      <planeGeometry args={[g.x1 - g.x0, g.y1 - g.y0]} />
      <meshStandardMaterial map={tex} transparent alphaTest={0.02} roughness={1} depthWrite={false} />
    </mesh>
  );
}

export const TWIN = { sky: "#f3f3f0", ground: "#e6e6e2", road: "#cfcfca", kerb: "#bdbdb8", line: "#ffffff", wall: "#fbfbf9", window: "#e2e2de", neutral: "#a3a39e", person: "#3c3c38",
  primary: "#e30613", involved: "#0a0a0a" };

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2147483647 + 2) ^ Math.imul(h ^ (h >>> 13), 1597334677);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

function windowTexture() {
  const S = 64, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = TWIN.wall;
  g.fillRect(0, 0, S, S);
  g.fillStyle = TWIN.window;
  g.fillRect(16, 12, 32, 38);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** All buildings in one mesh and one draw call. Walls map to window cells per metre; roofs to a plain corner of the tile. */
function buildingGeometry(boxes: number[][]) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const CELL_W = 1.7, CELL_H = 2.3;
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], uvs: number[][]) => {
    const i = pos.length / 3;
    [a, b, c, d].forEach((p, k) => { pos.push(...p); nor.push(...n); uv.push(...uvs[k]); });
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  for (const [x0, x1, z0, z1, h0, h1] of boxes) {
    const us = Math.max(1, Math.round((x1 - x0) / CELL_W)), ud = Math.max(1, Math.round((z1 - z0) / CELL_W)), v0 = h0 / CELL_H, v1 = Math.max(v0 + 1, Math.round(h1 / CELL_H));
    quad([x0, h0, z1], [x1, h0, z1], [x1, h1, z1], [x0, h1, z1], [0, 0, 1], [[0, v0], [us, v0], [us, v1], [0, v1]]);
    quad([x1, h0, z0], [x0, h0, z0], [x0, h1, z0], [x1, h1, z0], [0, 0, -1], [[0, v0], [us, v0], [us, v1], [0, v1]]);
    quad([x1, h0, z1], [x1, h0, z0], [x1, h1, z0], [x1, h1, z1], [1, 0, 0], [[0, v0], [ud, v0], [ud, v1], [0, v1]]);
    quad([x0, h0, z0], [x0, h0, z1], [x0, h1, z1], [x0, h1, z0], [-1, 0, 0], [[0, v0], [ud, v0], [ud, v1], [0, v1]]);
    const r = [0.02, 0.02];
    quad([x0, h1, z1], [x1, h1, z1], [x1, h1, z0], [x0, h1, z0], [0, 1, 0], [r, r, r, r]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** The overview camera looks across from the near corner, so what's on that side stays low and doesn't block the crash. */
function cityBlocks(seed: string, half: number, span: number) {
  const r = rng(seed), boxes: number[][] = [];
  const firstRow = half + 7;
  for (const side of [-1, 1]) {
    let across = firstRow;
    for (let row = 0; row < 5; row++) {
      const depth = 20 + r() * 12;
      for (let along = -span; along < span;) {
        const len = 18 + r() * 16, gap = 7 + r() * 3;
        const a0 = across, a1 = across + depth;
        const x0 = side > 0 ? a0 : -a1, x1 = side > 0 ? a1 : -a0;
        const z0 = along, z1 = along + len;
        const nearCamera = z0 > -6;
        const tall = nearCamera ? 3 + r() * (side < 0 ? 4 : 7) : row === 0 ? 5 + r() * 6 : 9 + row * row * 6 + r() * (10 + row * 16);
        const inset = 1 + r() * 2;
        if (row === 0 && r() < 0.25) {
          boxes.push([x0 + inset, x1 - inset, z0 + inset, z1 - inset, 0, 3 + r() * 3]);   // a low block by the road
        } else {
          boxes.push([x0 + inset, x1 - inset, z0 + inset, z1 - inset, 0, tall]);
          if (!nearCamera && r() < 0.65) {   // setback tower
            const s = 2.5 + r() * 3;
            boxes.push([x0 + inset + s, x1 - inset - s, z0 + inset + s, z1 - inset - s, tall, tall + 5 + r() * (row * 12 + 8)]);
          }
        }
        along += len + gap;
      }
      across += depth + 8;
    }
  }
  return boxes;
}

export function TwinCity({ seed, road, photo }: { seed: string; road: RoadModel; photo?: boolean }) {
  const span = 170;
  const geo = useMemo(() => buildingGeometry(cityBlocks(seed, road.half, span)), [seed, road.half]);
  const tex = useMemo(windowTexture, []);
  const stripes = useMemo(() => {
    if (!road.zebra) return [];
    const n = Math.max(3, Math.round((road.half * 2) / 0.9)), out: number[] = [];
    for (let i = 0; i < n; i++) out.push(-road.half + 0.45 + i * ((road.half * 2 - 0.9) / Math.max(1, n - 1)));
    return out;
  }, [road]);
  const dashes = useMemo(() => Array.from({ length: Math.floor(span / 3) }, (_, i) => -span + i * 6 + 1.5), []);
  const flat = [-Math.PI / 2, 0, 0] as [number, number, number];
  return (
    <group position={[road.cx, 0, -road.cy]} rotation={[0, -road.axis, 0]}>
      <mesh rotation={flat} position={[0, -0.03, 0]} receiveShadow><planeGeometry args={[900, 900]} /><meshStandardMaterial color={TWIN.ground} roughness={1} /></mesh>
      <mesh rotation={flat} position={[0, -0.01, 0]} receiveShadow><planeGeometry args={[road.half * 2, span * 2]} /><meshStandardMaterial color={TWIN.road} roughness={1} /></mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (road.half + 1.6), 0.07, 0]} receiveShadow castShadow><boxGeometry args={[3.2, 0.14, span * 2]} /><meshStandardMaterial color={TWIN.kerb} roughness={1} /></mesh>
      ))}
      {!photo && dashes.map((z) => <mesh key={z} rotation={flat} position={[0, 0.005, z]}><planeGeometry args={[0.13, 3]} /><meshBasicMaterial color={TWIN.line} toneMapped={false} /></mesh>)}
      {road.divider && <mesh position={[(road.divider[0] + road.divider[1]) / 2, 0.14, 0]} castShadow receiveShadow><boxGeometry args={[Math.abs(road.divider[1] - road.divider[0]), 0.28, span * 2]} /><meshStandardMaterial color="#454d61" roughness={1} /></mesh>}
      {!photo && road.zebra && stripes.map((x) => (
        <mesh key={x} rotation={flat} position={[x, 0.008, -(road.zebra![0] + road.zebra![1]) / 2]}><planeGeometry args={[0.5, Math.abs(road.zebra![1] - road.zebra![0])]} /><meshBasicMaterial color="#8791a8" toneMapped={false} /></mesh>
      ))}
      <mesh geometry={geo} castShadow receiveShadow><meshStandardMaterial map={tex} roughness={0.9} metalness={0} /></mesh>
    </group>
  );
}

// Side silhouettes, front at +x, as fractions of length (x) and height (y). Glass is a second, inset outline.
const PROFILES: Record<string, { body: number[][]; glass: number[][]; clearance: number; wheels: number[]; wheel: number }> = {
  car: { body: [[-0.5, 0.2], [0.5, 0.2], [0.5, 0.42], [0.47, 0.5], [0.22, 0.56], [0.06, 0.95], [-0.24, 0.96], [-0.4, 0.62], [-0.5, 0.58]],
         glass: [[0.2, 0.58], [0.06, 0.9], [-0.22, 0.9], [-0.36, 0.62]], clearance: 0.2, wheels: [-0.32, 0.31], wheel: 0.21 },
  van: { body: [[-0.5, 0.16], [0.5, 0.16], [0.5, 0.45], [0.42, 0.62], [0.3, 0.95], [-0.48, 0.97], [-0.5, 0.9]],
         glass: [[0.36, 0.64], [0.27, 0.9], [-0.1, 0.9], [-0.1, 0.64]], clearance: 0.16, wheels: [-0.33, 0.3], wheel: 0.17 },
  bus: { body: [[-0.5, 0.12], [0.5, 0.12], [0.5, 0.9], [0.47, 0.99], [-0.48, 0.99], [-0.5, 0.94]],
         glass: [[0.49, 0.55], [0.47, 0.88], [-0.46, 0.88], [-0.46, 0.6]], clearance: 0.12, wheels: [-0.3, 0.33], wheel: 0.15 },
  truck: { body: [[-0.5, 0.14], [0.5, 0.14], [0.5, 0.5], [0.45, 0.72], [0.3, 0.74], [0.3, 0.98], [-0.5, 0.98]],
           glass: [[0.48, 0.52], [0.44, 0.7], [0.34, 0.7], [0.34, 0.52]], clearance: 0.14, wheels: [-0.34, 0.35], wheel: 0.16 },
  auto: { body: [[-0.5, 0.18], [0.5, 0.18], [0.5, 0.5], [0.4, 0.92], [0.2, 0.98], [-0.45, 0.98], [-0.5, 0.75]],
          glass: [[0.44, 0.5], [0.37, 0.86], [0.22, 0.86], [0.22, 0.5]], clearance: 0.18, wheels: [-0.3, 0.36], wheel: 0.16 },
};

function extrudeProfile(pts: number[][], L: number, H: number, W: number, bevel: number) {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x * L, y * H)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, W - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -(W - 2 * bevel) / 2);
  g.rotateY(Math.PI / 2);  // shape +x (front) becomes -z, three's forward
  g.computeVertexNormals();
  return g;
}

export function bodyKind(kind: string) {
  return kind in PROFILES ? kind : kind === "suv" ? "van" : "car";
}

/** A vehicle body shaped by its type, sized to the fitted dimensions, posed by the measured track. */
export function ClayVehicle({ kind, L, W, H, colour, glow, braking, pitch }: { kind: string; L: number; W: number; H: number; colour: string; glow: boolean; braking: boolean; pitch: number }) {
  const P = PROFILES[bodyKind(kind)];
  const geo = useMemo(() => ({ body: extrudeProfile(P.body, L, H, W, Math.min(0.12, W * 0.07)), glass: extrudeProfile(P.glass, L, H, W + 0.03, 0) }), [P, L, H, W]);
  const r = Math.max(0.24, P.wheel * H * 1.15);
  const lampY = Math.max(r + 0.1, H * 0.42);
  return (
    <group rotation={[pitch, 0, 0]}>
      {glow && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}><planeGeometry args={[W + 1.2, L + 1.2]} /><meshBasicMaterial color={colour} transparent opacity={0.2} depthWrite={false} toneMapped={false} /></mesh>}
      <mesh geometry={geo.body} castShadow receiveShadow>
        <meshPhysicalMaterial color={colour} emissive={glow ? colour : "#000"} emissiveIntensity={glow ? 0.22 : 0} roughness={0.35} metalness={0.45} clearcoat={0.8} clearcoatRoughness={0.25} />
      </mesh>
      <mesh geometry={geo.glass}><meshPhysicalMaterial color="#141a26" roughness={0.08} metalness={0.2} clearcoat={1} /></mesh>
      {P.wheels.flatMap((z) => [-1, 1].map((sd) => (
        <group key={`${z}${sd}`} position={[sd * (W / 2 - 0.08), r, -z * L]}>
          <mesh rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[r, r, 0.26, 28]} /><meshStandardMaterial color="#121418" roughness={0.95} /></mesh>
          <mesh rotation={[0, 0, Math.PI / 2]} position={[sd * 0.135, 0, 0]}><cylinderGeometry args={[r * 0.6, r * 0.6, 0.01, 20]} /><meshStandardMaterial color="#9aa1aa" metalness={0.8} roughness={0.3} /></mesh>
        </group>
      )))}
      {[-1, 1].map((k) => <mesh key={`h${k}`} position={[k * W * 0.34, lampY, -L / 2 - 0.02]}><boxGeometry args={[W * 0.18, 0.12, 0.03]} /><meshStandardMaterial color="#f5f1dc" emissive="#f5f1dc" emissiveIntensity={0.6} /></mesh>)}
      {[-1, 1].map((k) => (
        <mesh key={k} position={[k * W * 0.36, lampY, L / 2 + 0.02]}>
          <boxGeometry args={[W * 0.18, 0.12, 0.03]} />
          <meshStandardMaterial color={braking ? "#ff4a4a" : "#4a1f28"} emissive={braking ? "#ff2020" : "#000"} emissiveIntensity={braking ? 3 : 0} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
