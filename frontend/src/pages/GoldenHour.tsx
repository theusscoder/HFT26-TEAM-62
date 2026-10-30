import { Fragment, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { post, useApi } from "../lib/api";
import { Loading, Panel, Ref, Status } from "../components/ui";

/* OWNER: P4. Severity breakdown → plate vote → registry card → alert (countdown for L3) → police/hospital map.
   Alerts go only to the parties the severity level allows (backend/app/severity.py LEVELS). */
export default function GoldenHour() {
  const { id } = useParams();
  const sev = useApi<any>(`/cases/${id}/severity`);
  const plates = useApi<any>(`/cases/${id}/plates`);
  const fac = useApi<any>(`/cases/${id}/facilities`);
  const c = useApi<any>(`/cases/${id}/case`);
  const plate = plates.data?.vehicles[0];
  const reg = useApi<any>(plate ? `/registry/${plate.plate}` : null);
  const [count, setCount] = useState<number | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (count == null || count <= 0) return;
    const h = setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(h);
  }, [count]);
  useEffect(() => {
    if (count !== 0 || !plate) return;
    post<any>(`/cases/${id}/alert`, {
      plate: plate.plate,
      text: `🚨 YATHARTH alert: vehicle ${plate.plate} was involved in a road incident at ${c.data?.location.name}. Severity ${sev.data.level}. Emergency services informed. Ref ${id}.`,
    }).then((r) => setSent(r.status));
  }, [count]);

  if (!sev.data || !c.data) return <Loading error={sev.error ?? c.error} />;
  const loc: [number, number] | null = c.data.location.lat != null ? [c.data.location.lat, c.data.location.lon] : null;
  const autoOk = (plate?.confidence ?? 0) >= 0.8;

  return (
    <div className="grid grid-cols-[380px_1fr] gap-6">
      <div className="space-y-4">
        <Panel title="Severity" right={<Status value={sev.data.level} />}>
          <div className="text-3xl font-bold">{sev.data.label} <span className="text-muted">· {sev.data.score}/100</span></div>
          <ul className="mt-4 space-y-2 text-sm">
            {sev.data.breakdown.map((b: any) => (
              <li key={b.signal} className="flex justify-between gap-2">
                <span>{b.why}<br /><Ref value={b.ref} /></span><span className="mono text-bad">+{b.points}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted">Notifies: {sev.data.notify.join(", ")}{sev.data.minor_example ? ` · a minor bump scores ${sev.data.minor_example.level} and alerts ${sev.data.minor_example.notify.join(", ")}` : ""}</p>
        </Panel>
        {!plate ? <Loading error="404 plate reading not run for this case yet (P1)" /> : <Panel title="Involved vehicle" right={<span className="mono text-xs">{Math.round(plate.confidence * 100)}%</span>}>
          <div className="mono text-2xl tracking-widest">{plate.plate}</div>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {plate.reads.map((r: string, i: number) => (
              <div key={i} className={`mono rounded border px-1.5 py-1 text-center text-[11px] ${r === plate.plate ? "border-ok/40 text-ok" : "border-line text-muted"}`}>
                f{plate.frames[i]} {r}
              </div>
            ))}
          </div>
          {reg.data && (
            <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm">
              {Object.entries(reg.data).map(([k, v]) => (<Fragment key={k}><dt className="text-muted">{k}</dt><dd>{String(v)}</dd></Fragment>))}
            </dl>
          )}
          <p className="mt-2 text-[11px] text-muted">Demo registry (fictional). Registered owner may not be the driver.</p>
          <div className="mt-4">
            {sent ? <div className="text-sm text-ok">Alert {sent} → {reg.data?.owner}</div>
              : count != null ? <button onClick={() => setCount(null)} className="w-full rounded-lg border border-bad py-2 text-sm">Sending in {count}s · Cancel</button>
              : <button onClick={() => setCount(autoOk ? 10 : 0)} className="w-full rounded-lg bg-bad py-2 text-sm font-semibold text-white">
                  {autoOk ? "Start alert countdown" : "Officer confirm & send"}
                </button>}
          </div>
        </Panel>}
      </div>
      {!fac.data || !loc ? <Loading error="404 police / hospital data and incident location not set for this case yet (P3)" /> : <Panel title="Emergency response" right={<span className="text-xs text-muted">{fac.data.source}</span>} className="min-h-[560px]">
        <div className="h-[500px] overflow-hidden rounded-lg">
          <MapContainer center={loc} zoom={14} className="h-full w-full">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap" />
            <CircleMarker center={loc} radius={10} pathOptions={{ color: "#ff5d5d", fillOpacity: 0.8 }}><Tooltip permanent>Incident</Tooltip></CircleMarker>
            {fac.data.police.map((p: any) => (
              <CircleMarker key={p.name} center={[p.lat, p.lon]} radius={7} pathOptions={{ color: "#4f8cff" }}>
                <Tooltip>{p.name} · {p.dist_km} km · {p.eta_min} min</Tooltip>
              </CircleMarker>
            ))}
            {fac.data.hospitals.map((h: any) => (
              <CircleMarker key={h.name} center={[h.lat, h.lon]} radius={7} pathOptions={{ color: "#3ecf8e" }}>
                <Tooltip>{h.name} · {h.dist_km} km{h.trauma ? " · trauma" : ""}</Tooltip>
              </CircleMarker>
            ))}
            {/* TODO(P4): replace straight lines with cached OSRM route geometry */}
            {[...fac.data.police, ...fac.data.hospitals.filter((h: any) => h.trauma)].map((f: any) => (
              <Polyline key={f.name} positions={[loc, [f.lat, f.lon]]} pathOptions={{ color: "#8a93a0", dashArray: "4 6" }} />
            ))}
          </MapContainer>
        </div>
      </Panel>}
    </div>
  );
}
