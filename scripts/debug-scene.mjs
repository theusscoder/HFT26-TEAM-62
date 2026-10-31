// One-shot debug: load the app in a real browser, dump the scene audit.
import { spawn, execSync } from 'node:child_process'

const server = spawn('npm', ['run', 'preview'], { shell: true, stdio: 'ignore' })
const killServer = () => {
  try {
    execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    server.kill()
  }
}

async function main() {
  await new Promise((r) => setTimeout(r, 4500))
  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--window-position=0,0',
      '--window-size=1000,760',
    ],
  })
  const page = await browser.newPage()
  await page.bringToFront()
  page.on('console', (msg) => console.log('[page]', msg.text()))
  page.on('pageerror', (err) => console.log('[pageerror]', err.message))
  await page.goto('http://localhost:4173', { waitUntil: 'networkidle0', timeout: 60_000 })
  await new Promise((r) => setTimeout(r, 7000))
  const visState = await page.evaluate(() => ({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  }))
  console.log('page state:', JSON.stringify(visState))
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })), { cmd: 'dumpBounds' })
  await new Promise((r) => setTimeout(r, 600))
  const dump = await page.evaluate(() => {
    const p = window.__CITY_PERF__
    return {
      audit: p?.sceneAudit,
      draws: p?.drawCalls,
      tris: p?.triangles,
      heap: p?.heapMB,
      dist: p?.cameraDistanceM,
      camera: p?.camera,
      target: p?.target,
    }
  })
  console.log('page loaded:')
  console.log('drawCalls:', dump.draws, ' triangles:', dump.triangles, ' camDist:', Math.round(dump.dist ?? -1))
  console.log('camera:', dump.camera)
  console.log('target:', dump.target)

  const fly = async (view) => {
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
      { cmd: 'flyTo', view },
    )
    await new Promise((r) => setTimeout(r, 3500))
    const cam = await page.evaluate(() => {
      const p = window.__CITY_PERF__
      return { camera: p?.camera, target: p?.target, dist: p?.cameraDistanceM }
    })
    console.log(`after flyTo(${view}):`, JSON.stringify(cam))
  }
  const shot = async (name) => {
    // Read pixels straight from the WebGL canvas (bypasses OS compositor
    // staleness seen with headful Chrome screenshots on Windows).
    const dataUrl = await page.evaluate(() => document.querySelector('canvas')?.toDataURL('image/png') ?? '')
    if (!dataUrl.startsWith('data:image/png;base64,')) {
      console.log(`shot ${name}: FAILED (no canvas data)`)
      return
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`docs/screenshots/${name}.png`, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
    console.log(`shot -> docs/screenshots/${name}.png (canvas)`)
  }

  await fly('survey')
  await shot('debug-survey')
  await fly('profile')
  await shot('debug-profile')

  // Buried-layers probe: at nadir, hide ONLY the terrain surface.
  await fly('nadir')
  await shot('probe-nadir-full')
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
    { cmd: 'doubleSide' },
  )
  await new Promise((r) => setTimeout(r, 400))
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
    { cmd: 'hide', name: 'terrain-top' },
  )
  await new Promise((r) => setTimeout(r, 400))
  await shot('probe-nadir-noterrain-doubleside')

  await fly('near')
  await shot('debug-near')
  await fly('default')
  await shot('debug-default')

  // Live-render proof: screenshot twice DURING the near-fly (camera in motion).
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
    { cmd: 'flyTo', view: 'near' },
  )
  await new Promise((r) => setTimeout(r, 700))
  await shot('proof-motion-a')
  await new Promise((r) => setTimeout(r, 900))
  await shot('proof-motion-b')
  await new Promise((r) => setTimeout(r, 2500))

  // Output-pipeline sanity: hide EVERY mesh, force known backgrounds.
  const allMeshes = await page.evaluate(() => {
    const p = window.__CITY_PERF__
    return (p?.sceneAudit ?? []).map((m) => m.name)
  })
  for (const name of allMeshes) {
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
      { cmd: 'hide', name },
    )
  }
  for (const bg of ['#ff0000', '#00ff00', '#3c3c3c']) {
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
      { cmd: 'bgTest', color: bg },
    )
    await new Promise((r) => setTimeout(r, 300))
    await shot(`probe-bg${bg.slice(1)}`)
  }
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
    { cmd: 'bgTest' },
  )
  for (const name of allMeshes) {
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('city:bench', { detail })),
      { cmd: 'show', name },
    )
  }
  await new Promise((r) => setTimeout(r, 300))

  // Ground truth probe: is the canvas actually contributing pixels?
  const before = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    return {
      canvasSize: canvas ? `${canvas.width}x${canvas.height}` : 'none',
      fps: window.__CITY_PERF__?.fps?.toFixed(1),
      ready: window.__CITY_PERF__?.ready,
    }
  })
  console.log('canvas probe:', before)
  await shot('probe-with-canvas')
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (canvas) canvas.style.display = 'none'
  })
  await shot('probe-without-canvas')
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (canvas) canvas.style.display = ''
  })

  const stats = await page.evaluate(() => {
    const p = window.__CITY_PERF__
    return { draws: p?.drawCalls, tris: p?.triangles, dist: p?.cameraDistanceM, mode: p?.buildingMode }
  })
  console.log('final stats:', JSON.stringify(stats))
  if (dump.audit) {
    for (const m of dump.audit) {
      console.log(`  ${m.name.padEnd(22)} ${m.type.padEnd(15)} tris=${String(m.tris).padStart(9)} culled=${m.frustumCulled}`)
    }
  } else {
    console.log('audit: (not available)')
  }

  await browser.close()
  killServer()
}

main().catch((err) => {
  killServer()
  console.error('failed:', err.message)
  process.exit(1)
})