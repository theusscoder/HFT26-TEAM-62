// Quick data sanity: reads the processed sample assets and prints value ranges.
// (Standalone mini-readers so Node can run it without bundler-style imports.)

import { readFileSync } from 'node:fs'

class R {
  constructor(buf) {
    this.v = new DataView(buf)
    this.o = 0
  }
  u16() {
    const x = this.v.getUint16(this.o, true)
    this.o += 2
    return x
  }
  u32() {
    const x = this.v.getUint32(this.o, true)
    this.o += 4
    return x
  }
  u8() {
    return this.v.getUint8(this.o++)
  }
  f32() {
    const x = this.v.getFloat32(this.o, true)
    this.o += 4
    return x
  }
  magic() {
    this.o += 4
  }
}

// terrain
{
  const r = new R(readFileSync('public/data/city/terrain.bin').buffer)
  r.magic()
  const version = r.u16()
  const gridW = r.u16()
  const gridH = r.u16()
  const originX = r.f32()
  const originZ = r.f32()
  const dx = r.f32()
  const dz = r.f32()
  const minM = r.f32()
  const maxM = r.f32()
  const n = gridW * gridH
  let nan = 0
  for (let i = 0; i < n; i++) if (!Number.isFinite(r.f32())) nan++
  console.log('terrain', { version, gridW, gridH, originX: +originX.toFixed(1), originZ: +originZ.toFixed(1), dx: +dx.toFixed(2), dz: +dz.toFixed(2), minM: +minM.toFixed(1), maxM: +maxM.toFixed(1), nan })
}

// buildings
{
  const r = new R(readFileSync('public/data/city/buildings.bin').buffer)
  r.magic()
  r.u16()
  const count = r.u32()
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, bad = 0
  let hMin = Infinity, hMax = -Infinity
  for (let b = 0; b < count; b++) {
    const pts = r.u16()
    const h = r.f32()
    r.u8()
    r.u8()
    hMin = Math.min(hMin, h); hMax = Math.max(hMax, h)
    for (let i = 0; i < pts; i++) {
      const x = r.f32()
      const z = r.f32()
      if (!Number.isFinite(x) || !Number.isFinite(z)) { bad++; continue }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
  }
  console.log('buildings', { count, x: [+minX.toFixed(0), +maxX.toFixed(0)], z: [+minZ.toFixed(0), +maxZ.toFixed(0)], h: [+hMin.toFixed(1), +hMax.toFixed(1)], bad })
}

// roads
{
  const r = new R(readFileSync('public/data/city/roads.bin').buffer)
  r.magic()
  r.u16()
  const count = r.u32()
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, bad = 0
  let ptCount = 0
  for (let b = 0; b < count; b++) {
    r.u8(); r.u8()
    const pts = r.u16()
    for (let i = 0; i < pts; i++) {
      const x = r.f32()
      const z = r.f32()
      ptCount++
      if (!Number.isFinite(x) || !Number.isFinite(z)) { bad++; continue }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
  }
  console.log('roads', { count, pts: ptCount, x: [+minX.toFixed(0), +maxX.toFixed(0)], z: [+minZ.toFixed(0), +maxZ.toFixed(0)], bad })
}

const water = JSON.parse(readFileSync('public/data/city/water.json', 'utf8'))
console.log('water', { count: water.length, elevations: water.map((w) => w.elevation).slice(0, 8), outerPts: water.map((w) => w.outer.length).slice(0, 8) })

const parks = JSON.parse(readFileSync('public/data/city/parks.json', 'utf8'))
console.log('parks', { count: parks.length, pts: parks.map((p) => p.ring.length).slice(0, 8) })