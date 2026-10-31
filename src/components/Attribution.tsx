// Data-source attribution and coverage notice. ODbL requires visible credit.

import type { CityManifest } from '../types/city'

export function Attribution({ manifest }: { manifest: CityManifest | null }) {
  const osm = manifest?.sources.find((s) => s.id === 'osm')
  return (
    <footer className="attribution">
      <p>
        {osm ? osm.attribution : '© OpenStreetMap contributors'} ·{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          ODbL
        </a>{' '}
        · Elevation: NASA SRTM/USGS via Mapzen Terrarium
      </p>
      <p className="attribution-note">
        Coverage: representative sample area{manifest ? ` (${manifest.counts.buildings.total.toLocaleString()} OSM buildings)` : ''} — building heights mostly estimated
      </p>
    </footer>
  )
}