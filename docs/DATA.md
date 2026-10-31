# City data — sources, pipeline and limitations

The rendered city is built from two open datasets, processed at dev time into
compact static assets under `public/data/city/`. Everything the renderer needs
ships with the app; the pipeline never runs in the browser.

## Coverage — important

- **Current (Phase 2):** representative sample window **17.405–17.445 N,
  78.425–78.485 E** (≈ 6.4 × 4.4 km around Hussain Sagar / Banjara Hills).
  This is a **subset of the approved city window** — it is *not* the full
  urban coverage area and *not* the GHMC boundary.
- **Phase 3 target:** the full approved window **17.36–17.50 N, 78.33–78.51 E**.
- `public/data/city/manifest.json` records the exact coverage of the shipped
  assets and must be updated whenever the window changes.

The terrain heightfield spans the *full* approved window (it is cheap — a
192×144 grid), while OSM geometry currently covers only the sample window.

## Island silhouette — derived, not official

The floating island's outline is **not** a rectangle and **not** an official
boundary: there is no GHMC (or any administrative) boundary asset in the
pipeline. The silhouette is **derived from the shipped OSM density** at load
time (`src/geo/boundary.ts`): building footprint area, road length and
park/water coverage are rasterised over the data window (~48 m cells), blurred,
threshold-calibrated so the largest connected component keeps ≥90 % of the
building mass, dilated for rim safety, contoured (marching squares) and
smoothed (Douglas-Peucker + Chaikin). The derivation is deterministic and
logs its diagnostics to the console.

Two consequences of the current sample-only coverage:

- The silhouette hugs the data-window edge on sides where the (dense) urban
  fabric continues beyond the shipped data — those straight-ish runs are data
  truncations, not city edges.
- With full-window OSM data (a later phase), the same derivation would
  produce a genuinely full-city silhouette with real bays and gaps.

## Sources and licences

| Use            | Source                                        | Licence             |
| -------------- | --------------------------------------------- | ------------------- |
| Buildings, roads, water, parks | OpenStreetMap via Overpass API | ODbL 1.0 — © OpenStreetMap contributors |
| Elevation      | AWS Terrain Tiles (Terrarium), zoom 12 (SRTM/NASA via Mapzen) | Public domain |

Attribution strings surface in the app UI (`src/components/Attribution.tsx`)
and in the manifest. Overpass mirrors are rotated with retries — the API is
flaky (502/504s are normal; just re-run the fetch).

## Pipeline

```
scripts/fetch-sample-data.mjs     data/raw/    (gitignored cache)
  └─ Overpass quadrants: buildings (with height/levels tags), roads by class,
     water areas, parks; Terrarium z12 tiles decoded to a height grid
scripts/process-sample-data.mjs   public/data/city/
  └─ simplify (Douglas-Peucker 0.7 m buildings / 1.0 m roads)
  └─ estimate building heights (see below)
  └─ write manifest.json + binary assets ("HCV1" format)
```

Asset formats (read by `src/services/cityData/`):

- `buildings.bin` / `roads.bin` — packed rings, read via `DataView`
- `terrain.bin` — 192×144 height grid, **real metres ASL**
- `water.json` / `parks.json` — polygons with per-area elevation

## Known limitations / disclosure

1. **Building heights are mostly estimates.** Of 23,442 rendered buildings,
   14 have verified `height` tags (plausibility-checked against
   `building:levels`; implausible tag values such as a 90 m reading on a
   mapped 4-level block fall back to the levels derivation), 112 derive from
   `building:levels × 3.2 m`, and 23,316 (~99.5 %) use a deterministic
   estimate. Estimates are keyed first on the **mapped building type**
   (hotel / mall / hospital / government / place-of-worship / apartments /
   house … each with a metre band), then fall back to the OSM way id +
   footprint area for untagged `building=yes` shells. The skyline is a
   plausible silhouette, **not surveyed data**.
2. **Landmarks are flagged, not modelled.** 69 named OSM buildings with a
   city-scale use category (hotels, malls, hospitals, government seats,
   places of worship, banks) carry a landmark flag (manifest
   `counts.buildings.landmarks`) and render with an accent material at every
   zoom tier. Their geometry stays the mapped footprint + estimated height —
   no hand-modelled detail, no invented shapes.
2. **Terrain exaggeration.** Elevations are stored in real metres; the scene
   applies a ×1.6 vertical exaggeration at runtime (`cityConfig`
   `.terrainExaggeration`) for diorama legibility. Zero is the window minimum
   (478.4 m ASL).
3. **Sample coverage only** — see above. A refetch probe of Overpass for
   building relations and `building:part` ways found only ~100 extra features
   in the sample window (~0.4 %); the shipped cache is the footprint source
   of record for this phase.
4. **Projection** is local equirectangular (metres per degree constants),
   accurate to well under a metre over this window — not a global CRS.
   All layers share `src/geo/projection.ts` as the single source of truth.