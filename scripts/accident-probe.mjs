// Phase 4 accident integration probe (production build, trusted CDP events).
//
// Verifies end-to-end:
//   1. marker placement math (scene graph positions vs independent projection)
//   2. real mouse click on a marker selects it (raycast -> callback)
//   3. `accident:selected` event fires with { id, accident }
//   4. camera flies to the incident (distance ≈ focus pose, target on marker)
//   5. info overlay shows the correct record
//   6. CITY VIEW restores the default framing and clears selection
//   7. markers exist for every record in the feed
//
// Requires a fresh `npm run build` (it serves dist/ via vite preview).
import { spawn, execSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const BASE_URL = 'http://localhost:4173'

async function waitForServer(timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

const server = spawn('npm', ['run', 'preview'], { shell: true, stdio: 'ignore' })
const killServer = () => {
  try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' }) } catch { server.kill() }
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

try {
  if (!(await waitForServer(45_000))) throw new Error('server did not start')
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message))
  await page.bringToFront()
  // ?accidents=1 is NOT a real flag; the app always renders the feed. We DO
  // need ?sceneDebug for the camera/marker handles.
  await page.goto(`${BASE_URL}/?sceneDebug`, { waitUntil: 'networkidle0', timeout: 60_000 })

  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ready = await page.evaluate(() =>
      Boolean(window.__CITY_PERF__?.ready && window.__CITY_SCENE__ && window.__CITY_PERF__?.target),
    )
    if (ready) break
    await new Promise((r) => setTimeout(r, 400))
  }
  await new Promise((r) => setTimeout(r, 2000))

  // --- 1. marker count + placement math --------------------------------
  const markers = await page.evaluate(() => {
    const { scene } = window.__CITY_SCENE__
    const group = scene.getObjectByName('accident-markers')
    if (!group) return []
    return group.children.map((m) => ({
      pos: [m.position.x, m.position.y, m.position.z],
      // independent lat/lng -> metres projection (equirectangular at 17.43 N)
      expected: null,
      userData: m.userData ?? {},
    }))
  })
  check('markers rendered for every record', markers.length === 6, `count=${markers.length}`)

  // Independent projection check: placeAccident uses METRES_PER_DEG_LAT/LNG
  // computed from PROJECTION_ORIGIN; re-derive them here from first principles.
  const projection = await page.evaluate(async () => {
    const manifest = await (await fetch('/data/city/manifest.json')).json()
    const { lat: oLat, lng: oLng } = manifest.projection.origin
    const mLat = manifest.projection.metresPerDegLat
    const mLng = manifest.projection.metresPerDegLng
    const accidents = [
      { id: 'SIM-001', latitude: 17.4183, longitude: 78.4553 },
      { id: 'SIM-002', latitude: 17.4239, longitude: 78.449 },
      { id: 'SIM-003', latitude: 17.4335, longitude: 78.4506 },
      { id: 'SIM-004', latitude: 17.4122, longitude: 78.4383 },
      { id: 'SIM-005', latitude: 17.422, longitude: 78.476 },
      { id: 'SIM-006', latitude: 17.4372, longitude: 78.4461 },
    ]
    const { scene } = window.__CITY_SCENE__
    const group = scene.getObjectByName('accident-markers')
    const scenePositions = group.children.map((m) => [m.position.x, m.position.z])
    return accidents.map((a, i) => {
      const x = (a.longitude - oLng) * mLng
      const z = -(a.latitude - oLat) * mLat
      return {
        id: a.id,
        dx: Math.abs(scenePositions[i][0] - x),
        dz: Math.abs(scenePositions[i][1] - z),
      }
    })
  })
  const maxDrift = Math.max(...projection.map((p) => Math.max(p.dx, p.dz)))
  check('markers at projected lat/lng (order-stable)', maxDrift < 2, `maxDrift=${maxDrift.toFixed(3)}m`)

  // --- 1b. every marker sits over the island (terrain below, not void) --
  const islandHits = await page.evaluate(() => {
    const { scene, THREE } = window.__CITY_SCENE__
    const group = scene.getObjectByName('accident-markers')
    const terrain = scene.getObjectByName('terrain-top')
    if (!terrain) return []
    const raycaster = new THREE.Raycaster()
    return group.children.map((m) => {
      const p = m.position
      raycaster.set(new THREE.Vector3(p.x, p.y + 500, p.z), new THREE.Vector3(0, -1, 0))
      const hits = raycaster.intersectObject(terrain, false)
      return { overTerrain: hits.length > 0, gap: hits.length ? Math.round(p.y - hits[0].point.y) : null }
    })
  })
  check(
    'all markers over island terrain',
    islandHits.length === 6 && islandHits.every((h) => h.overTerrain && Math.abs(h.gap) < 6),
    JSON.stringify(islandHits),
  )

  // --- 2. click the first marker in screen space ------------------------
  // Listen for the documented integration event during the test.
  await page.evaluate(() => {
    window.__ACCIDENT_EVENTS__ = []
    window.addEventListener('accident:selected', (e) => window.__ACCIDENT_EVENTS__.push({ type: 'selected', id: e.detail.id }))
    window.addEventListener('accident:deselected', (e) => window.__ACCIDENT_EVENTS__.push({ type: 'deselected', id: e.detail.id }))
  })

  const clickPoint = await page.evaluate(() => {
    const { camera, scene } = window.__CITY_SCENE__
    const group = scene.getObjectByName('accident-markers')
    const marker = group.children[0] // SIM-001, Khairatabad Circle
    const world = marker.children[1].getWorldPosition(new (marker.position.constructor)())
    const v = world.clone().project(camera)
    if (v.z > 1) return null
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((-v.y + 1) / 2) * window.innerHeight }
  })
  check('first marker projects on-screen', clickPoint !== null && clickPoint.x > 0, JSON.stringify(clickPoint))

  const camBefore = await page.evaluate(() => {
    const p = window.__CITY_PERF__
    return { cam: { ...p.camera }, tgt: { ...p.target }, dist: p.cameraDistanceM }
  })

  await page.mouse.click(clickPoint.x, clickPoint.y)
  await new Promise((r) => setTimeout(r, 2200)) // fly duration is 1.6 s

  // --- 3/4. selection + camera focus ------------------------------------
  const camAfter = await page.evaluate(() => {
    const p = window.__CITY_PERF__
    return { cam: { ...p.camera }, tgt: { ...p.target }, dist: p.cameraDistanceM }
  })
  const moved = Math.hypot(camAfter.cam.x - camBefore.cam.x, camAfter.cam.y - camBefore.cam.y, camAfter.cam.z - camBefore.cam.z)
  check('selection flew the camera', moved > 100, `dCam=${moved.toFixed(0)}m`)
  check('focus distance ≈ 720 m', Math.abs(camAfter.dist - 720) < 80, `dist=${camAfter.dist.toFixed(0)}m`)

  const markerWorld = await page.evaluate(() => {
    const { scene } = window.__CITY_SCENE__
    const marker = scene.getObjectByName('accident-markers').children[0]
    const p = marker.position
    return { x: p.x, y: p.y, z: p.z }
  })
  const tgtErr = Math.hypot(camAfter.tgt.x - markerWorld.x, camAfter.tgt.z - markerWorld.z)
  check('orbit target on the incident', tgtErr < 12, `err=${tgtErr.toFixed(1)}m`)

  const events = await page.evaluate(() => window.__ACCIDENT_EVENTS__)
  check('accident:selected event fired', events.some((e) => e.type === 'selected' && e.id === 'SIM-001'), JSON.stringify(events))

  // --- 5. info overlay content ------------------------------------------
  const card = await page.evaluate(() => {
    const el = document.querySelector('.accident-card')
    if (!el) return null
    return { text: el.textContent ?? '', visible: el.offsetParent !== null }
  })
  check('info overlay visible', Boolean(card?.visible))
  check('overlay shows the selected record', Boolean(card?.text.includes('SIM-001') && card.text.includes('Khairatabad Circle') && card.text.includes('SIMULATED')))

  // --- 6. CITY VIEW restores + deselects --------------------------------
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'CITY VIEW')
    btn?.click()
  })
  await new Promise((r) => setTimeout(r, 2400))
  const camReset = await page.evaluate(() => {
    const p = window.__CITY_PERF__
    return { dist: p.cameraDistanceM, tgt: { ...p.target } }
  })
  check('CITY VIEW restores framing', Math.abs(camReset.dist - camBefore.dist) < 40, `dist ${camReset.dist.toFixed(0)} vs ${camBefore.dist.toFixed(0)}`)
  const eventsAfter = await page.evaluate(() => window.__ACCIDENT_EVENTS__)
  check('accident:deselected event fired', eventsAfter.some((e) => e.type === 'deselected' && e.id === 'SIM-001'), JSON.stringify(eventsAfter))
  const cardGone = await page.evaluate(() => !document.querySelector('.accident-card'))
  check('overlay closed after reset', cardGone)

  // --- 7. controls still work after selection flow ----------------------
  const beforeDrag = await page.evaluate(() => ({ ...window.__CITY_PERF__.camera }))
  await page.mouse.move(640, 400)
  await page.mouse.down({ button: 'left' })
  for (let i = 1; i <= 6; i++) await page.mouse.move(640 + i * 20, 400 + i * 6)
  await page.mouse.up({ button: 'left' })
  await new Promise((r) => setTimeout(r, 1200))
  const afterDrag = await page.evaluate(() => ({ ...window.__CITY_PERF__.camera }))
  const dOrbit = Math.hypot(afterDrag.x - beforeDrag.x, afterDrag.y - beforeDrag.y, afterDrag.z - beforeDrag.z)
  check('orbit still works after selection flow', dOrbit > 100, `dCam=${dOrbit.toFixed(0)}m`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[probe] ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
  await browser.close()
} finally {
  killServer()
}