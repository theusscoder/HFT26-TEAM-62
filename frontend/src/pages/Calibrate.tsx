import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { post, useApi } from "../lib/api";
import { Loading, Panel } from "../components/ui";

/* OWNER: P1. Road calibration: click 4 points that lie ON the road (lane-marking or zebra corners), type where they
   are in metres, see a 1 m grid projected back onto the frame, apply → backend recomputes metres, km/h, fusion. */

type Pt = [number, number];

/** Homography mapping src→dst from 4 point pairs (DLT, Gaussian elimination). */
function homography(src: Pt[], dst: Pt[]): number[] | null {
  const A: number[][] = [];
  src.forEach(([x, y], i) => {
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return [...A.map((row, i) => row[n] / row[i]), 1];
}
const apply = (h: number[], [x, y]: Pt): Pt => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };

export default function Calibrate() {
  const { id } = useParams();
  const nav = useNavigate();
  const c = useApi<any>(`/cases/${id}/case`);
  const cal = useApi<any>(`/cases/${id}/calibration`);
  const [img, setImg] = useState<Pt[]>([]);
  const [world, setWorld] = useState<Pt[]>([[0, 3], [7, 3], [7, 0], [0, 0]]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  useEffect(() => {
    if (cal.data) { setImg(cal.data.img_pts); setWorld(cal.data.world_pts); }
  }, [cal.data]);

  const H = useMemo(() => (img.length === 4 ? homography(world, img) : null), [img, world]);
  if (!c.data) return <Loading error={c.error} />;
  const W = c.data.video?.width ?? 960, Hh = c.data.video?.height ?? 720;

  const grid: Pt[][] = [];
  if (H) {
    for (let x = -2; x <= 10; x += 1) grid.push(Array.from({ length: 31 }, (_, i) => apply(H, [x, -10 + i])));
    for (let y = -10; y <= 20; y += 1) grid.push(Array.from({ length: 13 }, (_, i) => apply(H, [-2 + i, y])));
  }

  async function save() {
    setBusy(true);
    try {
      setResult(await post(`/cases/${id}/calibration`, {
        img_pts: img, world_pts: world, scale_sigma: cal.data?.scale_sigma ?? 0.15,
        note: cal.data?.note ?? "Set on the Calibrate page", features: cal.data?.features ?? {},
      }));
    } finally { setBusy(false); }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Panel title="Click 4 points on the road surface" right={<button onClick={() => setImg([])} className="text-xs text-muted">clear</button>}>
        <svg viewBox={`0 0 ${W} ${Hh}`} className="w-full cursor-crosshair rounded-lg bg-black"
          onClick={(e) => {
            if (img.length >= 4) return;
            const r = e.currentTarget.getBoundingClientRect();
            setImg([...img, [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * Hh)]]);
          }}>
          <image href={`/api/cases/${id}/file/background.jpg`} width={W} height={Hh} />
          {grid.map((line, i) => <polyline key={i} points={line.map((p) => p.join(",")).join(" ")} fill="none" stroke="#3ecf8e" strokeOpacity={0.45} strokeWidth={1} />)}
          {img.length > 1 && <polygon points={img.map((p) => p.join(",")).join(" ")} fill="#4f8cff" fillOpacity={0.15} stroke="#4f8cff" strokeWidth={2} />}
          {img.map(([x, y], i) => (
            <g key={i}><circle cx={x} cy={y} r={9} fill="#4f8cff" stroke="#0b0d10" strokeWidth={2} />
              <text x={x} y={y + 4} fontSize={12} textAnchor="middle" fill="#fff" fontWeight={700}>{i + 1}</text></g>
          ))}
        </svg>
        <p className="mt-2 text-xs text-muted">Green = a 1 m road grid projected back onto the camera. If it lines up with lane markings, the calibration is good.</p>
      </Panel>
      <div className="space-y-4">
        <Panel title="Where those points are on the road (metres)">
          <p className="mb-3 text-xs text-muted">x = across the road (0 at the divider edge), y = along the road (0 at the near zebra edge, positive away from the camera).</p>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="mb-2 flex items-center gap-2 text-sm">
              <span className="w-6 text-muted">{i + 1}</span>
              <span className="mono w-24 text-xs text-muted">{img[i] ? `(${img[i][0]}, ${img[i][1]}) px` : "click…"}</span>
              {[0, 1].map((k) => (
                <input key={k} type="number" step={0.1} value={world[i][k]} className="w-20 rounded border border-line bg-panel-2 px-2 py-1"
                  onChange={(e) => { const w = world.map((p) => [...p] as Pt); w[i][k] = +e.target.value; setWorld(w); }} />
              ))}
            </div>
          ))}
          <button disabled={img.length !== 4 || busy} onClick={save}
            className="mt-3 w-full rounded-lg bg-accent py-2 text-sm font-semibold text-white disabled:opacity-40">
            {busy ? "Recomputing…" : "Apply & recompute case"}
          </button>
          {cal.data?.note && <p className="mt-3 text-[11px] text-muted">{cal.data.note}</p>}
        </Panel>
        {result && (
          <Panel title="Recomputed">
            <ul className="space-y-1 text-sm">{Object.entries(result).map(([k, v]) => <li key={k}><span className="text-muted">{k}:</span> {typeof v === "string" ? v : JSON.stringify(v)}</li>)}</ul>
            <button onClick={() => nav(`/case/${id}/replay`)} className="mt-3 text-sm text-accent">Open the track map →</button>
          </Panel>
        )}
      </div>
    </div>
  );
}
