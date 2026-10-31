// Loading / failure states for the city dataset. Failure is never silent —
// the scene is unusable without its data, so we say so and how to fix it.

interface DataStateOverlayProps {
  state: 'loading' | 'error'
  message?: string
}

export function DataStateOverlay({ state, message }: DataStateOverlayProps) {
  if (state === 'loading') {
    return (
      <div className="data-overlay" role="status">
        <div className="data-card">
          <div className="data-spinner" />
          <p>LOADING CITY GEOMETRY</p>
          <p className="data-sub">buildings · roads · terrain · water</p>
        </div>
      </div>
    )
  }
  return (
    <div className="data-overlay data-overlay-error" role="alert">
      <div className="data-card">
        <p className="data-error-title">CITY DATA UNAVAILABLE</p>
        <p className="data-sub">{message ?? 'The processed assets could not be loaded.'}</p>
        <p className="data-sub">
          Run{' '}
          <code>
            npm run data:fetch &amp;&amp; npm run data:process
          </code>{' '}
          then reload.
        </p>
      </div>
    </div>
  )
}