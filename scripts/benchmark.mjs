// ---------------------------------------------------------------------------
// Automated performance benchmark against the PRODUCTION build.
//
//   1. `vite preview` serves dist/
//   2. A real (visible) Chrome window with HW acceleration renders the app
//   3. Scenarios drive the camera/mode via the same window events the UI uses
//   4. Numbers are sampled from window.__CITY_PERF__ — identical to the
//      on-screen PERF panel
//   5. Screenshots land in docs/screenshots/, summary in docs/benchmark-results.json
//
// Usage:  npm run benchmark     (requires a fresh `npm run build`)
// ---------------------------------------------------------------------------

import { spawn, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer'

const PORT = 4173
const BASE_URL = `http://localhost:${PORT}`
const SHOT_DIR = 'docs/screenshots'
const RESULTS_FILE = 'docs/benchmark-results.json'
mkdirSync(SHOT_DIR, { recursive: true })

// --- start preview server ----------------------------------------------------

async function waitForServer(timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const server = spawn('npm', ['run', 'preview'], {
  shell: true,
  stdio: 'ignore',
  detached: false,
})
const killServer = () => {
  try {
    // Windows: kill the whole process tree.
    execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    server.kill()
  }
}

// --- scenarios ----------------------------------------------------------------

const SCENARIOS = [
  { id: 'default-boxes', view: 'default', mode: 'boxes', shot: true },
  { id: 'default-footprints', view: 'default', mode: 'footprints', shot: true },
  { id: 'default-auto', view: 'default', mode: 'auto', shot: false },
  { id: 'near-boxes', view: 'near', mode: 'boxes', shot: false },
  { id: 'near-footprints', view: 'near', mode: 'footprints', shot: true },
]

const SETTLE_MS = 3500 // fly tween is 1.6s
const SAMPLE_MS = 6000

async function bench() {
  if (!(await waitForServer(30_000))) {
    killServer()
    throw new Error('preview server did not start')
  }
  console.log(`[bench] server ready at ${BASE_URL}`)

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1440, height: 860 },
    args: [
      '--enable-precise-memory-info',
      '--window-size=1460,900',
      // Headful Chrome on Windows throttles/occludes background windows —
      // without these flags both fps and canvas content go stale.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  })
  const page = await browser.newPage()
  await page.bringToFront()
  await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 60_000 })

  // Wait for the perf object to exist (scene created + first frame).
  const t0 = Date.now()
  while (Date.now() - t0 < 90_000) {
    const ready = await page.evaluate(() => {
      const p = window.__CITY_PERF__
      return Boolean(p && p.ready)
    })
    if (ready) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const loadMs = await page.evaluate(() => window.__CITY_PERF__?.loadMs ?? null)
  console.log('[bench] scene ready:', loadMs)

  const rows = []
  for (const scenario of SCENARIOS) {
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
      { cmd: 'setMode', mode: scenario.mode },
    )
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
      { cmd: 'flyTo', view: scenario.view },
    )
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    const samples = []
    const sampleStart = Date.now()
    while (Date.now() - sampleStart < SAMPLE_MS) {
      const s = await page.evaluate(() => {
        const p = window.__CITY_PERF__
        if (!p) return null
        return {
          fps: p.fps,
          fps1pLow: p.fps1pLow,
          frameMs: p.frameMs,
          drawCalls: p.drawCalls,
          triangles: p.triangles,
          geometries: p.geometries,
          heapMB: p.heapMB,
          mode: p.buildingMode,
        }
      })
      if (s) samples.push(s)
      await new Promise((r) => setTimeout(r, 350))
    }

    const med = (key) => {
      const a = samples.map((s) => s[key]).filter((v) => typeof v === 'number' && Number.isFinite(v))
      a.sort((x, y) => x - y)
      return a.length ? a[Math.floor(a.length / 2)] : null
    }
    const row = {
      scenario: scenario.id,
      fps: med('fps'),
      fps1pLowWorst: med('fps1pLow'),
      frameMs: med('frameMs'),
      drawCalls: med('drawCalls'),
      triangles: med('triangles'),
      geometries: med('geometries'),
      heapMB: med('heapMB'),
    }
    rows.push(row)
    console.log(
      `[bench] ${scenario.id.padEnd(20)} fps=${row.fps?.toFixed(1)}  1%low=${row.fps1pLowWorst?.toFixed(1)}  frame=${row.frameMs?.toFixed(1)}ms  draws=${row.drawCalls}  tris=${row.triangles?.toLocaleString?.() ?? row.triangles}  heap=${row.heapMB?.toFixed(0)}MB`,
    )

    if (scenario.shot) {
      const file = `${SHOT_DIR}/${scenario.id}.png`
      // Read pixels from the WebGL canvas directly — OS-compositor
      // screenshots proved unreliable for occluded headful windows.
      const dataUrl = await page.evaluate(() => document.querySelector('canvas')?.toDataURL('image/png') ?? '')
      if (dataUrl.startsWith('data:image/png;base64,')) {
        writeFileSync(file, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
        console.log(`[bench]   screenshot -> ${file}`)
      } else {
        console.log('[bench]   screenshot FAILED (no canvas data)')
      }
    }
  }

  const results = {
    generatedAt: new Date().toISOString(),
    viewport: '1440x860',
    loadMs,
    scenarios: rows,
  }
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))
  console.log(`[bench] results -> ${RESULTS_FILE}`)

  await browser.close()
  killServer()
}

bench().catch((err) => {
  killServer()
  console.error(`[bench] failed: ${err.message}`)
  process.exit(1)
})