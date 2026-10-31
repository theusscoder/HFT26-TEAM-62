// Accident markers: restrained red beacons at precise geographic positions.
//
// Visual language (kept deliberately small — not map pins, no glow blooms):
//   - a slim vertical beam (taller with severity) so markers stay findable
//     when zoomed out over the whole island,
//   - a flat ground ring marking the exact projected point, readable when
//     zoomed in.
// Both pulse subtly; the selected marker is brighter and slightly larger.
// Four material skins are shared across all markers and pulsed from ONE
// useFrame, so marker count does not add per-frame work.

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Accident, AccidentDisplayStatus } from '../../types/accident'
import type { HeightField } from '../../geo/heightfield'
import { palette } from '../../config/palette'
import { placeAccident, type MarkerPlacement } from './placement'

interface AccidentMarkersProps {
  accidents: Accident[]
  selectedId: string | null
  onSelectAccident: (accident: Accident) => void
  ground: HeightField
}

const ACCENT = new THREE.Color(palette.marker) // '#f43f5e'
const ACCENT_BRIGHT = new THREE.Color('#ff7a92')
const ACCENT_DIM = new THREE.Color('#8a4450')

/** Beam height per severity — restrained; the tallest is ~26 m at city scale. */
const BEAM_HEIGHT: Record<Accident['severity'], number> = {
  critical: 26,
  high: 20,
  moderate: 15,
}

type PulsedMaterial = THREE.MeshBasicMaterial & { baseOpacity: number; pulseAmp: number }

/**
 * Pulse state is carried ON the shared materials (baseOpacity/pulseAmp), so
 * the animation loop reads everything it needs without touching React state.
 */
function makeMaterial(color: THREE.Color, baseOpacity: number, pulseAmp: number, doubleSide = false): PulsedMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: baseOpacity,
    depthWrite: false,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  }) as PulsedMaterial
  mat.baseOpacity = baseOpacity
  mat.pulseAmp = pulseAmp
  return mat
}

interface MarkerSkin {
  beam: PulsedMaterial
  ring: PulsedMaterial
}

export function AccidentMarkers({ accidents, selectedId, onSelectAccident, ground }: AccidentMarkersProps) {
  const placements = useMemo(
    () =>
      accidents.map((accident) => ({
        accident,
        placement: placeAccident(accident, ground),
      })),
    [accidents, ground],
  )

  // Shared skins: one per display status, plus the selected highlight.
  const skins = useMemo<Record<AccidentDisplayStatus | 'selected', MarkerSkin>>(() => ({
    active: { beam: makeMaterial(ACCENT, 0.56, 0.18), ring: makeMaterial(ACCENT, 0.9, 0.1, true) },
    investigating: { beam: makeMaterial(ACCENT, 0.44, 0.13), ring: makeMaterial(ACCENT, 0.72, 0.08, true) },
    cleared: { beam: makeMaterial(ACCENT_DIM, 0.26, 0.06), ring: makeMaterial(ACCENT_DIM, 0.4, 0.04, true) },
    selected: { beam: makeMaterial(ACCENT_BRIGHT, 0.72, 0.26), ring: makeMaterial(ACCENT_BRIGHT, 0.95, 0.14, true) },
  }), [])

  // Per-colour skins for coloured markers (case kinds, hospitals, police), pulsed with the rest.
  const colorSkins = useMemo(() => {
    const m = new Map<string, MarkerSkin>()
    for (const a of accidents) {
      if (a.color && !m.has(a.color)) {
        const c = new THREE.Color(a.color)
        const fac = !!a.facility
        m.set(a.color + (fac ? ':f' : ''), { beam: makeMaterial(c, fac ? 0.5 : 0.7, fac ? 0.45 : 0.25), ring: makeMaterial(c, 0.9, 0.1, true) })
      }
    }
    return m
  }, [accidents])

  const skinFor = (status: AccidentDisplayStatus, selected: boolean, a?: Accident): MarkerSkin =>
    selected ? skins.selected : (a?.color && colorSkins.get(a.color + (a.facility ? ':f' : ''))) || skins[status]

  // One shared pulse loop for every marker material (no per-marker frames).
  const elapsed = useRef(0)
  useFrame((_, delta) => {
    elapsed.current += delta
    const phase = 0.5 + 0.5 * Math.sin(elapsed.current * 2.1)
    for (const skin of [...Object.values(skins), ...colorSkins.values()]) {
      for (const mat of [skin.beam, skin.ring]) {
        mat.opacity = mat.baseOpacity + mat.pulseAmp * phase
      }
    }
  })

  return (
    <group name="accident-markers">
      {placements.map(({ accident, placement }) => (
        <AccidentMarker
          key={accident.id}
          accident={accident}
          placement={placement}
          selected={accident.id === selectedId}
          onSelect={onSelectAccident}
          skinFor={skinFor}
        />
      ))}
    </group>
  )
}

interface AccidentMarkerProps {
  accident: Accident
  placement: MarkerPlacement
  selected: boolean
  onSelect: (accident: Accident) => void
  skinFor: (status: AccidentDisplayStatus, selected: boolean, a?: Accident) => MarkerSkin
}

function AccidentMarker({ accident, placement, selected, onSelect, skinFor }: AccidentMarkerProps) {
  const skin = skinFor(accident.displayStatus, selected, accident)
  // case beams are tall enough to find from the city view; facilities are shorter
  const beamHeight = accident.facility ? 70 : BEAM_HEIGHT[accident.severity] * 7

  return (
    <group
      position={placement.position}
      onPointerDown={(e) => {
        e.stopPropagation()
        onSelect(accident)
      }}
    >
      {/* Slim vertical beam — tapered, open-ended, taller for higher severity. */}
      <mesh position={[0, beamHeight / 2, 0]} material={skin.beam} renderOrder={5}>
        <cylinderGeometry args={accident.facility ? [4, 4, beamHeight, 6, 1, true] : [6, 11, beamHeight, 12, 1, true]} />
      </mesh>
      {/* Ground ring at the exact projected point. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.25, 0]}
        material={skin.ring}
        renderOrder={5}
        scale={selected ? 1.25 : 1}
      >
        <ringGeometry args={accident.facility ? [10, 16, 6] : [26, 42, 40]} />
      </mesh>
    </group>
  )
}