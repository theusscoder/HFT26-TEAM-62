import { useParams } from "react-router-dom";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import { motion } from "framer-motion";
import { useApi } from "../lib/api";
import { Loading, Panel } from "../components/ui";

/* OWNER: P4. Hit-and-run trace: exit vector → reachable toll windows → partial-plate funnel → match.
   TODO(P4): animate a growing reachability circle over time; light up tolls as their window opens. */
export default function Pursuit() {
  const { id } = useParams();
  const p = useApi<any>(`/cases/${id}/pursuit`);
  if (!p.data) return <Loading error={p.error} />;
  const d = p.data, max = d.funnel[0].count;

  return (
    <div className="grid grid-cols-[1fr_380px] gap-6">
      <Panel title="Reachable toll plazas" className="min-h-[560px]">
        <div className="h-[500px] overflow-hidden rounded-lg">
          <MapContainer center={[d.exit.lat, d.exit.lon]} zoom={12} className="h-full w-full">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" attribution="© OpenStreetMap" />
            <CircleMarker center={[d.exit.lat, d.exit.lon]} radius={9} pathOptions={{ color: "#ff5d5d" }}><Tooltip permanent>Exit · {d.exit.heading}</Tooltip></CircleMarker>
            {d.tolls.map((t: any) => (
              <CircleMarker key={t.name} center={[t.lat, t.lon]} radius={8}
                pathOptions={{ color: t.name === d.match.toll ? "#3ecf8e" : "#f5b84f" }}>
                <Tooltip>{t.name} · {t.dist_km} km · window {t.window_min[0]}–{t.window_min[1]} min</Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
      </Panel>
      <div className="space-y-4">
        <Panel title="Partial plate"><div className="mono text-2xl tracking-widest">{d.partial_plate}</div></Panel>
        <Panel title="Match funnel">
          {d.funnel.map((f: any, i: number) => (
            <div key={f.stage} className="mb-3">
              <div className="flex justify-between text-sm"><span>{f.stage}</span><span className="mono">{f.count}</span></div>
              <motion.div initial={{ width: 0 }} animate={{ width: `${Math.max(2, (f.count / max) * 100)}%` }} transition={{ delay: i * 0.6, duration: 0.6 }}
                className="mt-1 h-2 rounded bg-accent" />
            </div>
          ))}
        </Panel>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: d.funnel.length * 0.6 }}>
          <Panel title="Match">
            <div className="mono text-2xl text-ok">{d.match.plate}</div>
            <p className="mt-1 text-sm text-muted">{d.match.toll} · {d.match.time} · FASTag {d.match.fastag}</p>
          </Panel>
        </motion.div>
      </div>
    </div>
  );
}
