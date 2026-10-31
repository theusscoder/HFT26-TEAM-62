// Camera interaction probe with assertions: initial pose fidelity, orbit
// (left), pan (right), zoom (wheel), target grounding. Trusted CDP events.
import { spawn, execSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const DEV = process.argv.includes('--dev')
const URL_PROD = 'http://localhost:4173'
const URL_DEV = 'http://localhost:5173'

async function probeUrl(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Wait for the expected server; also detect a port-shifted preview server. */
async function waitForServer(timeoutMs) {
  const want = DEV ? URL_DEV : URL_PROD
  const other = DEV ? URL_PROD : URL_DEV
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await probeUrl(want)) return want
    await new Promise((r) => setTimeout(r, 400))
  }
  if (await probeUrl(other)) {
    console.warn(`  note: expected ${want} but found ${other} (stale server on the expected port?)`)
    return other
  }
  return null
}

const server = spawn('npm', ['run', DEV ? 'dev' : 'preview'], { shell: true, stdio: 'ignore' })
const killServer = () => {
  try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' }) } catch { server.kill() }
}

const snap = (page) =>
  page.evaluate(() => {
    const p = window.__CITY_PERF__
    return p ? { cam: p.camera, tgt: p.target } : null
  })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

try {
  const base = await waitForServer(45_000)
  if (!base) throw new Error('server did not start')
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message))
  await page.bringToFront()
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60_000 })

  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    if (await page.evaluate(() => Boolean(window.__CITY_PERF__?.ready))) break
    await new Promise((r) => setTimeout(r, 400))
  }
  await new Promise((r) => setTimeout(r, 2500))

  const dist = (s) => Math.hypot(s.cam.x - s.tgt.x, s.cam.y - s.tgt.y, s.cam.z - s.tgt.z)

  // --- 1. initial pose fidelity (expected: dist 4824m, target at 17.4245N/78.455E) ---
  const init = await snap(page)
  check(
    'initial distance == 4824 m',
    Math.abs(dist(init) - 4824) < 5,
    `dist=${dist(init).toFixed(1)}`,
  )
  check(
    'initial target on sample centre',
    Math.abs(init.tgt.x - 3718) < 5 && Math.abs(init.tgt.z - 609) < 5,
    `tgt(${init.tgt.x.toFixed(0)},${init.tgt.y.toFixed(0)},${init.tgt.z.toFixed(0)})`,
  )
  check('initial target grounded', init.tgt.y >= 0 && init.tgt.y <= 160, `tgt.y=${init.tgt.y.toFixed(1)}`)

  const cx = 640, cy = 400
  // --- 2. orbit (left drag): camera moves around a FIXED target ---
  await page.mouse.move(cx, cy)
  await page.mouse.down({ button: 'left' })
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 18, cy + i * 6)
  await page.mouse.up({ button: 'left' })
  await new Promise((r) => setTimeout(r, 1500))
  const afterOrbit = await snap(page)
  const dOrbitCam = Math.hypot(afterOrbit.cam.x - init.cam.x, afterOrbit.cam.y - init.cam.y, afterOrbit.cam.z - init.cam.z)
  const dOrbitTgt = Math.hypot(afterOrbit.tgt.x - init.tgt.x, afterOrbit.tgt.y - init.tgt.y, afterOrbit.tgt.z - init.tgt.z)
  check('orbit: camera moved', dOrbitCam > 100, `dCam=${dOrbitCam.toFixed(0)}m`)
  check('orbit: target fixed', dOrbitTgt < 2, `dTgt=${dOrbitTgt.toFixed(2)}m`)
  const orbitDistKept = Math.abs(dist(afterOrbit) - dist(init)) < 60
  check('orbit: radius preserved', orbitDistKept, `dist ${dist(init).toFixed(0)} -> ${dist(afterOrbit).toFixed(0)}`)

  // --- 3. pan (right drag): target moves across the plane, stays grounded ---
  const beforePan = afterOrbit
  await page.mouse.move(cx, cy)
  await page.mouse.down({ button: 'right' })
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 15, cy + i * 10)
  await page.mouse.up({ button: 'right' })
  await new Promise((r) => setTimeout(r, 1500))
  const afterPan = await snap(page)
  const dPanTgt = Math.hypot(afterPan.tgt.x - beforePan.tgt.x, afterPan.tgt.y - beforePan.tgt.y, afterPan.tgt.z - beforePan.tgt.z)
  check('pan: target moved', dPanTgt > 20, `dTgt=${dPanTgt.toFixed(0)}m`)
  check('pan: target grounded', afterPan.tgt.y >= 0 && afterPan.tgt.y <= 160, `tgt.y=${afterPan.tgt.y.toFixed(1)}`)
  check('pan: camera above terrain', afterPan.cam.y > 0, `cam.y=${afterPan.cam.y.toFixed(0)}m`)

  // --- 4. zoom in (wheel up: deltaY < 0) ---
  const beforeZoom = afterPan
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -300 }); await new Promise((r) => setTimeout(r, 150)) }
  await new Promise((r) => setTimeout(r, 1500))
  const afterZoomIn = await snap(page)
  check('zoom-in: distance decreased', dist(afterZoomIn) < dist(beforeZoom) - 100, `${dist(beforeZoom).toFixed(0)} -> ${dist(afterZoomIn).toFixed(0)}`)

  // --- 5. zoom out (wheel down) ---
  for (let i = 0; i < 10; i++) { await page.mouse.wheel({ deltaY: 400 }); await new Promise((r) => setTimeout(r, 120)) }
  await new Promise((r) => setTimeout(r, 1500))
  const afterZoomOut = await snap(page)
  check('zoom-out: distance increased', dist(afterZoomOut) > dist(afterZoomIn) + 200, `${dist(afterZoomIn).toFixed(0)} -> ${dist(afterZoomOut).toFixed(0)}`)
  check('zoom clamped at max 13000', dist(afterZoomOut) <= 13001, `${dist(afterZoomOut).toFixed(0)}`)

  // --- 6. reset via the UI button restores the initial framing ---
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    btns.find((b) => b.textContent?.trim() === 'CITY VIEW')?.click()
  })
  await new Promise((r) => setTimeout(r, 2600))
  const afterReset = await snap(page)
  const dResetTgt = Math.hypot(afterReset.tgt.x - init.tgt.x, afterReset.tgt.y - init.tgt.y, afterReset.tgt.z - init.tgt.z)
  check('reset: target restored', dResetTgt < 5, `dTgt=${dResetTgt.toFixed(2)}m`)
  check('reset: distance restored', Math.abs(dist(afterReset) - 4824) < 10, `dist=${dist(afterReset).toFixed(0)}`)

  // --- 7. context menu suppressed on right-click over canvas ---
  const ctxOk = await page.evaluate(async () => {
    const c = document.querySelector('canvas')
    let prevented = false
    const h = (e) => { e.preventDefault(); prevented = true }
    c.addEventListener('contextmenu', h, { once: true })
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    c.removeEventListener('contextmenu', h)
    return prevented
  })
  check('context menu suppressed', ctxOk)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[probe] ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
  await browser.close()
} finally {
  killServer()
}