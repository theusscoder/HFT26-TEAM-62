// Runtime render statistics — the single source consulted by the on-screen
// PERF panel AND the automated benchmark (window.__CITY_PERF__), so both
// always report identical numbers.

import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { useRef } from 'react'

export interface PerfSnapshot {
  ready: boolean
  fps: number
  fps1pLow: number
  frameMs: number
  drawCalls: number
  triangles: number
  geometries: number
  programs: number
  heapMB: number | null
  buildingMode: string
  cameraDistanceM: number
  /** Resolved building tier (auto) + minor-road visibility — LOD diagnostics. */
  lodTier: string
  minorRoadsVisible: boolean
  /** camera position / orbit target (diagnostics). */
  camera: { x: number; y: number; z: number } | null
  target: { x: number; y: number; z: number } | null
  /** Milliseconds from dataset-ready to first rendered frame. */
  loadMs: { dataset: number; geometry: number } | null
  /** One-shot audit of visible meshes (debugging draw-call accounting). */
  sceneAudit: Array<{ name: string; type: string; tris: number; frustumCulled: boolean }> | null
}

const perf: PerfSnapshot = {
  ready: false,
  fps: 0,
  fps1pLow: 0,
  frameMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  programs: 0,
  heapMB: null,
  buildingMode: '-',
  cameraDistanceM: 0,
  lodTier: '-',
  minorRoadsVisible: false,
  camera: null,
  target: null,
  loadMs: null,
  sceneAudit: null,
}

export function getCityPerf(): PerfSnapshot {
  return perf
}

/** Dev/benchmark hook. Set once the canvas exists. */
export function publishCityPerfToWindow(): void {
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__CITY_PERF__ = perf
  }
}

const FRAME_WINDOW = 240

export function StatsCollector({ buildingMode }: { buildingMode: string }) {
  const gl = useThree((s) => s.gl) as THREE.WebGLRenderer
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null
  const frameDeltas = useRef<number[]>([])
  const auditDone = useRef(false)

  useFrame((_, delta) => {
    const dt = delta * 1000
    const arr = frameDeltas.current
    arr.push(dt)
    if (arr.length > FRAME_WINDOW) arr.shift()

    // fps as mean, 1p-low as the slowest frame approximation.
    let sum = 0
    let worst = 0
    for (const d of arr) {
      sum += d
      if (d > worst) worst = d
    }
    perf.frameMs = sum / arr.length
    perf.fps = 1000 / perf.frameMs
    perf.fps1pLow = worst > 0 ? 1000 / worst : 0

    perf.drawCalls = gl.info.render.calls
    perf.triangles = gl.info.render.triangles
    perf.geometries = gl.info.memory.geometries
    perf.programs = gl.info.programs?.length ?? 0

    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    perf.heapMB = mem ? mem.usedJSHeapSize / (1024 * 1024) : null

    perf.buildingMode = buildingMode
    perf.ready = true

    perf.camera = { x: camera.position.x, y: camera.position.y, z: camera.position.z }
    if (controls?.target) {
      perf.target = { x: controls.target.x, y: controls.target.y, z: controls.target.z }
    }
    perf.cameraDistanceM = controls?.target ? camera.position.distanceTo(controls.target) : 0

    if (!auditDone.current && frameDeltas.current.length > 30) {
      auditDone.current = true
      const audit: Array<{ name: string; type: string; tris: number; frustumCulled: boolean }> = []
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
          const geometry = mesh.geometry as THREE.BufferGeometry & { index?: { count: number } }
          const positionAttr = geometry?.getAttribute('position')
          audit.push({
            name: mesh.name || '(unnamed)',
            type: mesh.type,
            tris: positionAttr ? Math.round(positionAttr.count / 3) : 0,
            frustumCulled: mesh.frustumCulled,
          })
        }
      })
      perf.sceneAudit = audit
    }
  })

  return null
}