import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Attribution } from './components/Attribution'
import { DataStateOverlay } from './components/DataStateOverlay'
import { HudOverlay } from './components/HudOverlay'
import { PerfHud } from './components/PerfHud'
import { AccidentInfoCard } from './components/AccidentInfoCard'
import { CityScene } from './scene/CityScene'
import type { CameraReadout, FlyRequest } from './scene/camera/CityCameraRig'
import { defaultPose, nearPose, surveyPose, nadirPose, profilePose, accidentFocusPose } from './scene/camera/poses'
import { HeightField } from './geo/heightfield'
import type { BuildingRenderMode } from './config/cameraConfig'
import { loadCityData } from './services/cityData/cityDataService'
import { getAccidents } from './services/accidentService'
import type { CityDataset } from './types/city'
import {
  ACCIDENT_SELECTED_EVENT,
  ACCIDENT_DESELECTED_EVENT,
  type Accident,
  type AccidentSelectedDetail,
  type AccidentDeselectedDetail,
} from './types/accident'
import './styles/scene.css'

/** Benchmark/dev command channel (scripts/benchmark.mjs dispatches these). */
type BenchCommand =
  | { cmd: 'setMode'; mode: BuildingRenderMode }
  | { cmd: 'flyTo'; view: 'default' | 'near' | 'survey' | 'nadir' | 'profile' }
  | { cmd: 'showPerf'; visible: boolean }

export default function App() {
  // --- city dataset ---
  const [dataset, setDataset] = useState<CityDataset | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [datasetReadyAt, setDatasetReadyAt] = useState(0)

  // --- accident feed (existing integration seam, markers render in Phase 4) ---
  const [accidents, setAccidents] = useState<Accident[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // --- view state ---
  const [buildingMode, setBuildingMode] = useState<BuildingRenderMode>('auto')
  const [flyRequest, setFlyRequest] = useState<FlyRequest | null>(null)
  const [readout, setReadout] = useState<CameraReadout | null>(null)
  const [perfVisible, setPerfVisible] = useState(() =>
    new URLSearchParams(window.location.search).has('perf'),
  )
  const flyId = useRef(0)

  const ground = useMemo(() => (dataset ? new HeightField(dataset.terrain) : null), [dataset])

  /** The selected record, resolved from the feed for the info overlay. */
  const selectedAccident = useMemo(
    () => accidents.find((a) => a.id === selectedId) ?? null,
    [accidents, selectedId],
  )

  useEffect(() => {
    let active = true
    loadCityData()
      .then((data) => {
        if (active) {
          setDatasetReadyAt(performance.now())
          setDataset(data)
        }
      })
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    getAccidents().then((data) => {
      if (active) setAccidents(data)
    })
    return () => {
      active = false
    }
  }, [])

  /**
   * Marker selection: the single mutation point for selection state.
   * Updates selectedId, notifies the analysis module via the documented
   * `accident:selected` event, and flies the camera to the incident.
   */
  const handleSelectAccident = useCallback(
    (accident: Accident) => {
      setSelectedId(accident.id)
      // Integration seam: the analysis module (built separately) listens for
      // this event and opens its interface. No analysis UI lives here.
      const detail: AccidentSelectedDetail = { id: accident.id, accident }
      window.dispatchEvent(new CustomEvent<AccidentSelectedDetail>(ACCIDENT_SELECTED_EVENT, { detail }))
      if (ground) {
        const focus = accidentFocusPose(ground, accident)
        flyId.current += 1
        setFlyRequest({ id: flyId.current, target: focus.target, position: focus.position })
      }
    },
    [ground],
  )

  /** Deselect (info card close): keeps the camera where the user has it. */
  const handleDeselectAccident = useCallback(() => {
    setSelectedId((current) => {
      if (current) {
        const detail: AccidentDeselectedDetail = { id: current }
        window.dispatchEvent(new CustomEvent<AccidentDeselectedDetail>(ACCIDENT_DESELECTED_EVENT, { detail }))
      }
      return null
    })
  }, [])

  const flyToPose = useCallback(
    (view: 'default' | 'near' | 'survey' | 'nadir' | 'profile') => {
      if (!ground) return
      const pose =
        view === 'near'
          ? nearPose(ground)
          : view === 'survey'
            ? surveyPose(ground)
            : view === 'nadir'
              ? nadirPose(ground)
              : view === 'profile'
                ? profilePose(ground)
                : defaultPose(ground)
      flyId.current += 1
      setFlyRequest({ id: flyId.current, target: pose.target, position: pose.position })
    },
    [ground],
  )

  const handleResetView = useCallback(() => {
    handleDeselectAccident()
    flyToPose('default')
  }, [handleDeselectAccident, flyToPose])

  // Dev/benchmark channel + "P" perf toggle.
  useEffect(() => {
    const onBench = (e: Event) => {
      const detail = (e as CustomEvent<BenchCommand>).detail
      if (detail.cmd === 'setMode') setBuildingMode(detail.mode)
      else if (detail.cmd === 'flyTo') flyToPose(detail.view)
      else if (detail.cmd === 'showPerf') setPerfVisible(detail.visible)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'p' || e.key === 'P') setPerfVisible((v) => !v)
    }
    window.addEventListener('city:bench', onBench)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('city:bench', onBench)
      window.removeEventListener('keydown', onKey)
    }
  }, [flyToPose])

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      {dataset && ground && (
        <CityScene
          dataset={dataset}
          datasetReadyAt={datasetReadyAt}
          buildingMode={buildingMode}
          flyRequest={flyRequest}
          onCameraChange={setReadout}
          accidents={accidents}
          selectedId={selectedId}
          onSelectAccident={handleSelectAccident}
        />
      )}

      <div className="scene-vignette" />

      {dataset && (
        <>
          <HudOverlay
            readout={readout}
            accidentCount={accidents.length}
            buildingMode={buildingMode}
            onSetMode={setBuildingMode}
            onResetView={handleResetView}
          />
          <Attribution manifest={dataset.manifest} />
        </>
      )}

      {selectedAccident && <AccidentInfoCard accident={selectedAccident} onClose={handleDeselectAccident} />}

      <PerfHud visible={perfVisible} />

      {!dataset && <DataStateOverlay state={loadError ? 'error' : 'loading'} message={loadError ?? undefined} />}
    </main>
  )
}