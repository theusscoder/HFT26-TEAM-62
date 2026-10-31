# Hyderabad Accident Visualisation Platform

A 3D visualisation platform for road-accident data across Hyderabad, built as a
geographically grounded "floating diorama" of the city rendered from
OpenStreetMap data with real terrain elevation.

**Status: Phase 3 complete** — city geometry refinement, LOD strategy and
full camera navigation on the Phase 2 sample area (Hussain Sagar / Banjara
Hills), benchmarked at 142–144 fps. Accident markers and analysis features
arrive in later phases (see [docs/DATA.md](docs/DATA.md) for coverage scope).

## Stack

- React 19 + TypeScript (Vite, oxlint)
- three.js via @react-three/fiber + drei
- Data pipeline: Node scripts (Overpass API + AWS Terrarium terrain tiles)

## Run

```bash
npm install
npm run dev          # dev server with HMR
npm run build        # production build to dist/
npm run preview      # serve the production build
npm run lint         # oxlint
npm run typecheck    # tsc -b
```

The app loads pre-built city assets from `public/data/city/` and renders the
scene immediately.

## Camera controls

| Input                     | Action                                  |
| ------------------------- | --------------------------------------- |
| Left drag / one finger    | Orbit around the view target            |
| Right drag / two fingers  | Pan across the ground plane             |
| Wheel / pinch             | Zoom (clamped 260 m … 13 km)            |
| CITY VIEW button          | Reset to the initial framing            |

The camera never dips below the terrain, tilt is bounded (10°–76°), and the
orbit target stays on the city slab — navigation reads as exploring a model,
not flying an editor. Camera behaviour is regression-tested:
`node scripts/camera-probe.mjs` (add `--dev` for the dev server) drives the
real build with trusted input events and asserts 15 checks — initial framing,
orbit, grounded pan, zoom direction/clamps, reset and context-menu handling.
`node scripts/accident-probe.mjs` asserts the accident integration end-to-end:
placement math, click-to-select, camera focus, overlay content, city-view
restore and the `accident:selected` / `accident:deselected` events.

## Data pipeline (dev-time)

Rebuilding the city assets from source data:

```bash
npm run data:fetch     # Overpass + terrain tiles -> data/raw/ (gitignored)
npm run data:process   # -> public/data/city/ compact assets + manifest
```

Both scripts target the **Phase 2 sample window** (17.405–17.445 N,
78.425–78.485 E). Scaling the fetch to the full approved window (17.36–17.50 N,
78.33–78.51 E) is a Phase 3 task. Sources, licences and limitations are
documented in [docs/DATA.md](docs/DATA.md).

## Benchmark

```bash
npm run build
npm run benchmark
```

Drives the production build in a real (hardware-accelerated) Chrome window
through five scenarios, sampling `window.__CITY_PERF__` (same source as the
on-screen PERF panel). Screenshots land in `docs/screenshots/`, results in
`docs/benchmark-results.json`. Latest run (1440×860, vsync 144 Hz):

| scenario           |   fps | 1% low | draw calls | triangles |
| ------------------ | -----: | -----: | ---------: | --------: |
| default / boxes    |  142.9 |   46.1 |         11 |   296,819 |
| default/footprints |  142.6 |   68.5 |         11 |   274,665 |
| near / footprints  |  142.9 |   70.4 |         12 |   296,749 |

The LOD tiers now differ by design: zoomed out renders the silhouette, major
roads and instanced building boxes; medium zoom adds the minor street
network; close zoom swaps boxes for true footprint extrusions. Named
landmarks (69 buildings) render as accent-tinted extrusions at every tier.

## Debugging the scene

`node scripts/debug-scene.mjs` loads the production build, flies through
diagnostic camera poses and dumps camera state, per-mesh scene audit and
canvas-exact screenshots to `docs/screenshots/`.

## Accident-data integration seam

The rendered incident feed is **simulated** (`src/data/mockAccidents.ts`,
every record flagged `isSimulated: true`); `src/services/accidentService.ts`
is the single data seam — swap it for the backend without touching markers.

Selection flow (App state is the single source of truth):

- Marker click → `onSelectAccident(accident)` → selection state updates and
  the camera flies to the incident; the info card shows the record fields.
- `window` event **`accident:selected`** (`ACCIDENT_SELECTED_EVENT`) fires
  with `{ id, accident }`; **`accident:deselected`** fires with `{ id }`.
- **The analysis module (separate workstream) must listen for these events —
  it must not own selection state and no analysis UI lives in this codebase.**
- `selectedId` is passed to `CityScene` and available app-wide from App state.

## Attribution

Map data © OpenStreetMap contributors (ODbL 1.0). Elevation: NASA SRTM / USGS
via Mapzen Terrarium tiles. See [docs/DATA.md](docs/DATA.md).