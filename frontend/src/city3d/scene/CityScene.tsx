// Root 3D scene: canvas, atmosphere, camera rig, terrain slab, water, parks,
// roads and buildings. Accident markers arrive in Phase 4 — the props for
// them are already declared here as the documented integration surface.

import { useMemo, useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { CityDataset } from '../types/city'
import type { Accident } from '../types/accident'
import { HeightField } from '../geo/heightfield'
import {
  windowBoundary,
  buildingsInsideBoundary,
  roadsInsideBoundary,
  polygonsInsideBoundary,
} from '../geo/boundary'
import { palette } from '../config/palette'
import { cameraConfig, type BuildingRenderMode } from '../config/cameraConfig'
import { TerrainSlab } from './terrain/TerrainSlab'
import { ParkLayer, WaterLayer } from './water/WaterLayer'
import { RoadNetwork } from './roads/RoadNetwork'
import { BuildingLayer } from './buildings/BuildingLayer'
import { AccidentMarkers } from './markers/AccidentMarkers'
import { CityCameraRig, type FlyRequest, type CameraReadout } from './camera/CityCameraRig'
import { defaultPose } from './camera/poses'
import { StatsCollector, getCityPerf, publishCityPerfToWindow } from './perf/renderStats'

/** Dev-only probe: logs effective renderer color state, supports 'bgTest' on the bench channel. */
function DebugProbe() {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    // ?sceneDebug — expose read-only camera/scene handles for the probe scripts.
    if (new URLSearchParams(window.location.search).has('sceneDebug')) {
      ;(window as unknown as Record<string, unknown>).__CITY_SCENE__ = { camera, scene, THREE }
    }
    const canvas = gl.domElement
    const ctx = canvas.getContext('webgl2')
    console.log(
      '[dbg] colorState',
      JSON.stringify({
        outputColorSpace: gl.outputColorSpace,
        toneMapping: gl.toneMapping,
        exposure: gl.toneMappingExposure,
        colorManagement: THREE.ColorManagement.enabled,
        drawingBufferColorSpace: ctx?.drawingBufferColorSpace ?? 'n/a',
        dpr: window.devicePixelRatio,
      }),
    )
    const onBench = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.cmd === 'bgTest') {
        if (detail.color) scene.background = new THREE.Color(detail.color)
        else scene.background = new THREE.Color(palette.sceneBackground)
      } else if (detail?.cmd === 'hide' || detail?.cmd === 'show') {
        const obj = scene.getObjectByName(detail.name)
        if (obj) obj.visible = detail.cmd === 'show'
        else console.log('[dbg] hide/show: no object named', detail.name)
      } else if (detail?.cmd === 'doubleSide') {
        for (const name of ['roads', 'roads-minor', 'water', 'parks', 'buildings-footprints', 'buildings-landmarks']) {
          const obj = scene.getObjectByName(name) as THREE.Mesh | undefined
          if (obj) {
            const mat = obj.material as THREE.Material
            mat.side = THREE.DoubleSide
            mat.needsUpdate = true
          }
        }
      } else if (detail?.cmd === 'dumpBounds') {
        for (const name of ['terrain-top', 'roads', 'roads-minor', 'water', 'parks', 'buildings-footprints', 'buildings-landmarks']) {
          const obj = scene.getObjectByName(name)
          const geo = (obj as THREE.Mesh | undefined)?.geometry
          if (!geo) {
            console.log('[dbg] bounds', name, 'NOT FOUND')
            continue
          }
          geo.computeBoundingBox()
          const bb = geo.boundingBox
          console.log(
            `[dbg] bounds ${name} visible=${(obj as THREE.Mesh).visible}: x[${bb?.min.x.toFixed(0)},${bb?.max.x.toFixed(0)}] y[${bb?.min.y.toFixed(0)},${bb?.max.y.toFixed(0)}] z[${bb?.min.z.toFixed(0)},${bb?.max.z.toFixed(0)}]`,
          )
        }
        const boxes = scene.getObjectByName('buildings-boxes') as THREE.InstancedMesh | undefined
        if (boxes) {
          const m = new THREE.Matrix4()
          boxes.getMatrixAt(0, m)
          const p = new THREE.Vector3().setFromMatrixPosition(m)
          const s = new THREE.Vector3().setFromMatrixScale(m)
          console.log(`[dbg] bounds buildings-boxes[0]: pos ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} scale ${s.x.toFixed(2)} count ${boxes.count}`)
        }
      }
    }
    window.addEventListener('city:bench', onBench)
    return () => window.removeEventListener('city:bench', onBench)
  }, [scene, gl, camera])
  return null
}

export interface CitySceneProps {
  dataset: CityDataset
  buildingMode: BuildingRenderMode
  flyRequest: FlyRequest | null
  onCameraChange?: (readout: CameraReadout) => void
  /** Epoch timestamp (performance.now) when the dataset became ready. */
  datasetReadyAt: number
  /** Simulated incident feed (accidentService) — rendered as markers. */
  accidents: Accident[]
  /** Selection state owned by the app shell. */
  selectedId: string | null
  /** Marker click callback (integration seam — see types/accident.ts). */
  onSelectAccident: (accident: Accident) => void
}

export function CityScene(props: CitySceneProps) {
  const { dataset, buildingMode, flyRequest, onCameraChange, accidents, selectedId, onSelectAccident } = props

  const ground = useMemo(() => new HeightField(dataset.terrain), [dataset.terrain])
  const pose = useMemo(() => defaultPose(ground), [ground])

  // Irregular island silhouette derived once from the shipped OSM density
  // (buildings + roads + parks + water). A data-grounded study-area
  // silhouette — NOT an administrative boundary.
  const island = useMemo(() => {
    const coverage = dataset.manifest.coverage
    // YATHARTH: the whole data window, solid; the density silhouette (deriveCityBoundary) left voids around our cases
    const result = windowBoundary(coverage)
    if (!result) {
      console.warn('[city] boundary derivation failed — check dataset coverage')
      return null
    }
    console.info(
      `[city] island silhouette: ${result.contourPoints} pts, building containment ${(result.buildingContainment * 100).toFixed(1)}%${result.calibrated ? '' : ' (best-effort threshold)'}`,
    )
    return result
  }, [dataset])

  const boundary = island?.boundary ?? null

  // Clip the draped layers to the island so nothing floats past the rim.
  const clipped = useMemo(() => {
    if (!boundary) return { buildings: dataset.buildings, roads: dataset.roads, water: dataset.water, parks: dataset.parks }
    const b = buildingsInsideBoundary(dataset.buildings, boundary)
    const r = roadsInsideBoundary(dataset.roads, boundary)
    const w = polygonsInsideBoundary(dataset.water, (a) => a.outer, boundary)
    const p = polygonsInsideBoundary(dataset.parks, (a) => a.ring, boundary)
    if (b.dropped || r.dropped || w.dropped || p.dropped) {
      console.info(`[city] rim clip: buildings -${b.dropped}, roads -${r.dropped}, water -${w.dropped}, parks -${p.dropped}`)
    }
    return { buildings: b.kept, roads: r.kept, water: w.kept, parks: p.kept }
  }, [dataset, boundary])

  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      camera={{
        fov: cameraConfig.fov,
        near: cameraConfig.near,
        far: cameraConfig.far,
        position: pose.position,
      }}
      onCreated={({ gl }) => {
        gl.setClearColor(palette.sceneBackground)
        publishCityPerfToWindow()
        getCityPerf().loadMs = {
          dataset: props.datasetReadyAt > 0 ? performance.now() - props.datasetReadyAt : 0,
          geometry: 0, // superseded: dataset -> first-frame measurement above
        }
      }}
    >
      <color attach="background" args={[palette.sceneBackground]} />
      <fog attach="fog" args={[palette.fog, 9000, 34000]} />

      {/* Lighting: cool slate key from SW-top (camera side, so visible faces are
          lit), warm counter-light from NE, teal hemisphere fill below. */}
      <directionalLight position={[-1900, 4600, 2900]} intensity={1.75} color="#a8c4d4" />
      <directionalLight position={[3200, 3400, -2600]} intensity={0.55} color="#8fb0c8" />
      <hemisphereLight args={['#3f646a', '#1a2225', 0.95]} />

      <CityCameraRig flyRequest={flyRequest} initialPose={pose} onCameraChange={onCameraChange} />

      {boundary && <TerrainSlab ground={ground} boundary={boundary} />}
      <ParkLayer parks={clipped.parks} ground={ground} />
      <WaterLayer water={clipped.water} ground={ground} />
      <RoadNetwork roads={clipped.roads} ground={ground} />
      <BuildingLayer buildings={clipped.buildings} ground={ground} mode={buildingMode} />
      <AccidentMarkers accidents={accidents} selectedId={selectedId} onSelectAccident={onSelectAccident} ground={ground} />

      <StatsCollector buildingMode={buildingMode} />
      <DebugProbe />
    </Canvas>
  )
}