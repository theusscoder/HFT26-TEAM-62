// The floating city island: terrain clipped to the derived urban silhouette,
// perimeter walls, rocky dark underside, an emissive rim ribbon and an
// atmospheric glow shaped like the silhouette itself.

import { useMemo } from 'react'
import * as THREE from 'three'
import type { HeightField } from '../../geo/heightfield'
import type { CityBoundary } from '../../geo/boundary'
import { buildSlab } from './slabGeometry'
import { palette } from '../../config/palette'

interface TerrainSlabProps {
  ground: HeightField
  boundary: CityBoundary
}

/** Silhouette-shaped halo: the island outline stroked with soft glow passes. */
function makeGlowTexture(boundary: CityBoundary): THREE.Texture {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const rgb = palette.underGlow
  const [r, g, b] = [1, 1, 1].map((_, i) => parseInt(rgb.substring(1 + i * 2, 3 + i * 2), 16))

  const margin = size * 0.16
  const w = boundary.maxX - boundary.minX
  const d = boundary.maxZ - boundary.minZ
  const s = Math.min((size - 2 * margin) / Math.max(w, 1), (size - 2 * margin) / Math.max(d, 1))
  const ox = size / 2 - ((boundary.minX + boundary.maxX) / 2) * s
  const oz = size / 2 - ((boundary.minZ + boundary.maxZ) / 2) * s

  const path = new Path2D()
  const ring = boundary.ring
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const px = ring[2 * i] * s + ox
    const pz = ring[2 * i + 1] * s + oz
    if (i === 0) path.moveTo(px, pz)
    else path.lineTo(px, pz)
  }
  path.closePath()

  ctx.clearRect(0, 0, size, size)
  // Faint interior haze (visible from below-horizon angles).
  ctx.fillStyle = `rgba(${r},${g},${b},0.12)`
  ctx.fill(path)
  // Rim passes: tight bright core, then a wide soft falloff.
  ctx.shadowColor = `rgba(${r},${g},${b},0.9)`
  ctx.strokeStyle = `rgba(${r},${g},${b},0.75)`
  ctx.lineWidth = 3
  ctx.shadowBlur = size * 0.045
  for (let i = 0; i < 4; i++) ctx.stroke(path)
  ctx.shadowBlur = size * 0.1
  ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`
  ctx.lineWidth = 5
  ctx.stroke(path)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function TerrainSlab({ ground, boundary }: TerrainSlabProps) {
  const parts = useMemo(() => buildSlab(ground.data, ground, boundary), [ground, boundary])

  const colored = useMemo(() => {
    // Elevation-graded vertex colours on the top surface.
    const top = parts.top
    const pos = top.getAttribute('position') as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    let maxY = 0
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i))
    const low = new THREE.Color(palette.terrainTopLow)
    const high = new THREE.Color(palette.terrainTopHigh)
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const t = maxY > 0 ? pos.getY(i) / maxY : 0
      c.copy(low).lerp(high, t)
      colors[3 * i] = c.r
      colors[3 * i + 1] = c.g
      colors[3 * i + 2] = c.b
    }
    top.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    // Strata gradient on the perimeter walls: lighter just under the rim,
    // fading to a dark base — layered "rock" under the city surface.
    const skirt = parts.skirt
    const spos = skirt.getAttribute('position') as THREE.BufferAttribute
    const scolors = new Float32Array(spos.count * 3)
    const sTop = new THREE.Color(palette.terrainSideTop)
    const sBottom = new THREE.Color(palette.terrainSideBottom)
    for (let i = 0; i < spos.count; i++) {
      const t = THREE.MathUtils.clamp((spos.getY(i) - parts.bottomY) / Math.max(maxY - parts.bottomY, 1), 0, 1)
      c.copy(sBottom).lerp(sTop, t)
      scolors[3 * i] = c.r
      scolors[3 * i + 1] = c.g
      scolors[3 * i + 2] = c.b
    }
    skirt.setAttribute('color', new THREE.BufferAttribute(scolors, 3))

    // Underside: dark rock, deepening towards the cap, with facet noise.
    const bottom = parts.bottom
    const bpos = bottom.getAttribute('position') as THREE.BufferAttribute
    const bcolors = new Float32Array(bpos.count * 3)
    const deep = new THREE.Color(palette.undersideDeep)
    const shallow = new THREE.Color(palette.terrainSideBottom)
    for (let i = 0; i < bpos.count; i++) {
      const y = bpos.getY(i)
      const t = THREE.MathUtils.clamp((y - parts.glowY - 30) / Math.max(parts.bottomY - (parts.glowY + 30), 1), 0, 1)
      const noise = 0.85 + 0.3 * (((Math.imul(i, 2654435761) >>> 16) & 0xff) / 255)
      c.copy(deep).lerp(shallow, t).multiplyScalar(noise)
      bcolors[3 * i] = c.r
      bcolors[3 * i + 1] = c.g
      bcolors[3 * i + 2] = c.b
    }
    bottom.setAttribute('color', new THREE.BufferAttribute(bcolors, 3))
    return parts
  }, [parts])

  const glowTexture = useMemo(() => makeGlowTexture(boundary), [boundary])

  const spanX = colored.maxX - colored.minX
  const spanZ = colored.maxZ - colored.minZ

  return (
    <group>
      <mesh name="terrain-top" geometry={colored.top} receiveShadow={false}>
        <meshStandardMaterial vertexColors roughness={0.97} metalness={0} />
      </mesh>

      <mesh name="terrain-skirt" geometry={colored.skirt}>
        <meshStandardMaterial vertexColors roughness={0.9} metalness={0} flatShading />
      </mesh>

      <mesh name="terrain-bottom" geometry={colored.bottom}>
        <meshStandardMaterial vertexColors roughness={0.95} metalness={0} flatShading side={THREE.DoubleSide} />
      </mesh>

      {/* Restrained emissive perimeter tracing the city silhouette. */}
      <mesh name="terrain-rim-glow" geometry={colored.rimGlow} renderOrder={1}>
        <meshBasicMaterial
          color={palette.rimGlow}
          transparent
          opacity={0.42}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Atmospheric glow hugging the underside of the floating island. */}
      <mesh
        name="under-glow"
        position={[(colored.minX + colored.maxX) / 2, colored.glowY, (colored.minZ + colored.maxZ) / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[spanX * 1.35, spanZ * 1.35, 1]}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={glowTexture}
          transparent
          opacity={0.8}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}