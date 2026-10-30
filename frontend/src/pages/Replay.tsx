import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { useApi, type Event } from "../lib/api";
import { useClock } from "../lib/clock";
import { claimStatus, salient, sentence, SOURCE_LABEL } from "../lib/story";
import { KindBadge, Loading, Panel } from "../components/ui";

/* OWNER: P3. Evidence replay: the annotated footage on the shared clock, with what every source says at this
   instant written as plain sentences, and the telematics trace. (The reconstruction map has its own tab.) */

function SyncedVideo({ src, t0 }: { src: string; t0: number }) {
  const { t, playing } = useClock();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [playing]);
  useEffect(() => {
    const v = ref.current;
    if (v && Math.abs(v.currentTime - (t + t0)) > (playing ? 0.3 : 0.04)) v.currentTime = Math.max(0, t + t0);
  }, [t, t0, playing]);
  return <video ref={ref} src={src} muted playsInline className="h-full w-full rounded-lg bg-black object-contain" />;
}

const ORDER: Record<string, number> = { INFERRED: 0, OBSERVED: 1, CLAIMED: 2 };

export default function Replay() {
  const { id } = useParams();
  const { t, seek, toggle, playing, range } = useClock();
  const c = useApi<any>(`/cases/${id}/case`);
  const events = useApi<Event[]>(`/cases/${id}/events`);
  const an = useApi<any>(`/cases/${id}/analysis`);
  const wit = useApi<Record<string, any>>(`/cases/${id}/witnesses`);
  const [raw, setRaw] = useState(false);
  const [sensor, setSensor] = useState<{ t: number; v: number }[] | null>(null);
  const offset = an.data?.offsets?.sensor?.offset_s ?? 0;
  useEffect(() => {
    fetch(`/api/cases/${id}/file/sensor.csv`).then((r) => (r.ok ? r.text() : Promise.reject())).then((txt) =>
      setSensor(txt.trim().split("\n").slice(1).map((l) => { const c = l.split(","); return { t: +(+c[0] + offset).toFixed(2), v: +c[1] }; }))).catch(() => setSensor(null));
  }, [id, offset]);
  if (!c.data || !events.data) return <Loading error={c.error ?? events.error} />;

  const ent = an.data?.entities;
  const t0 = c.data.t0_video_s ?? 0;
  const active = events.data
    .filter((e) => (raw || salient(e, ent)) && t >= e.t.start - 0.25 && t <= e.t.end + 0.25)
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.confidence - a.confidence)
    .slice(0, 12);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Annotated footage · YOLO11 + ByteTrack" right={<span className="mono text-xs text-muted">video {(t + t0).toFixed(2)} s</span>}>
          <div className="aspect-video w-full"><SyncedVideo src={`/api/cases/${id}/file/annotated.mp4`} t0={t0} /></div>
        </Panel>
        <Panel title="What the evidence says now" className="max-h-[560px] overflow-auto"
          right={<label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />raw</label>}>
          <ul className="space-y-2">
            {active.map((e) => {
              const st = e.kind === "CLAIMED" ? claimStatus(e, an.data) : undefined;
              return (
                <li key={e.id} className="rounded-lg border border-line bg-panel-2 p-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <KindBadge kind={e.kind} />
                    <span className="truncate text-[11px] text-muted">{SOURCE_LABEL(e.source, wit.data ?? {})}</span>
                    {st && <span className={`text-[10px] font-semibold uppercase ${st === "contradicted" ? "text-bad" : st === "consistent" ? "text-ok" : "text-muted"}`}>{st}</span>}
                  </div>
                  <div className="mt-1">{e.quote ? <span className="italic text-claimed">“{e.quote}”</span> : sentence(e, ent)}</div>
                  <div className="mono mt-1 text-[10px] text-muted">{e.ref || (e.derived_from?.length ? `from ${e.derived_from.slice(0, 3).join(", ")}` : "")} · {Math.round(e.confidence * 100)}%</div>
                </li>
              );
            })}
            {!active.length && <li className="text-sm text-muted">No evidence covers this instant.</li>}
          </ul>
        </Panel>
      </div>
      {sensor && (
        <Panel title="Telematics · speed km/h (aligned to impact)">
          <div className="h-[110px]">
            <ResponsiveContainer>
              <LineChart data={sensor}>
                <XAxis dataKey="t" type="number" domain={range} stroke="#8a93a0" fontSize={10} />
                <YAxis stroke="#8a93a0" fontSize={10} width={30} />
                <Line dataKey="v" dot={false} stroke="#4f8cff" isAnimationActive={false} />
                <ReferenceLine x={t} stroke="#e7eaee" />
                <ReferenceLine x={0} stroke="#ff5d5d" strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}
      <div className="sticky bottom-0 z-20 flex items-center gap-4  border border-line bg-panel/95 px-4 py-3 backdrop-blur">
        <button onClick={toggle} className="w-20 rounded-md bg-accent py-1.5 text-sm font-semibold text-white">{playing ? "Pause" : "Play"}</button>
        <button onClick={() => seek(0)} className="rounded-md border border-bad/50 px-3 py-1.5 text-xs text-bad">Jump to impact</button>
        <input type="range" min={range[0]} max={range[1]} step={0.05} value={t} onChange={(e) => seek(+e.target.value)} className="flex-1 accent-[#4f8cff]" />
        <span className="mono w-24 text-right text-sm">T{t >= 0 ? "+" : ""}{t.toFixed(2)} s</span>
      </div>
    </div>
  );
}
