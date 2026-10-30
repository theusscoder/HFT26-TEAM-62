import { useMemo } from "react";
import { motion } from "framer-motion";

/* What the agents know and did, as linked facts, revealed as the simulation clock reaches them. Laid out in columns:
   the case and the vehicle, the agents, what they act on, and where it ends. */
const COLUMN: Record<string, number> = { case: 0, suspect: 0, record: 0, agent: 1, camera: 2, signal: 2, unit: 2, spot: 3, outcome: 3 };
const COLOUR: Record<string, string> = { case: "#5c5c58", suspect: "#e30613", record: "#6b2fd6", agent: "#0a0a0a", camera: "#0047ab", signal: "#b86e00", unit: "#0047ab", spot: "#0e7a43", outcome: "#e30613" };

export default function KnowledgeGraph({ graph, t }: { graph: { nodes: any[]; edges: any[] }; t: number }) {
  const W = 1100, rowH = 34;
  const layout = useMemo(() => {
    const cols: any[][] = [[], [], [], []];
    graph.nodes.forEach((n) => cols[COLUMN[n.type] ?? 2].push(n));
    const H = Math.max(...cols.map((c) => c.length)) * rowH + 40;
    const pos: Record<string, { x: number; y: number }> = {};
    cols.forEach((c, i) => c.forEach((n, j) => { pos[n.id] = { x: 90 + i * ((W - 180) / 3), y: 30 + (j + 0.5) * ((H - 40) / c.length) }; }));
    return { pos, H };
  }, [graph]);
  const { pos, H } = layout;
  const shown = new Set(graph.nodes.filter((n) => n.t <= t + 0.01).map((n) => n.id));
  // One label per pair of nodes: the latest thing that happened between them.
  const latest = new Map<string, number>();
  graph.edges.forEach((e, i) => { if (e.t <= t + 0.01) latest.set(`${e.source}>${e.target}`, i); });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Knowledge graph of the intercept">
      {["Case and vehicle", "Agents", "What they act on", "Outcome"].map((h, i) => <text key={h} x={90 + i * ((W - 180) / 3)} y={14} fill="#0a0a0a" fontWeight={700} fontSize={11} textAnchor="middle" letterSpacing={1}>{h.toUpperCase()}</text>)}
      {graph.edges.map((e, i) => {
        const a = pos[e.source], b = pos[e.target];
        if (!a || !b) return null;
        const on = e.t <= t + 0.01 && shown.has(e.source) && shown.has(e.target);
        const mx = (a.x + b.x) / 2;
        const d = `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
        return (
          <g key={i} opacity={on ? 1 : 0.06}>
            <motion.path d={d} fill="none" stroke={on ? "#0a0a0a" : "#c9c9c4"} strokeOpacity={on ? 0.55 : 1} strokeWidth={1.3} initial={false} animate={{ pathLength: on ? 1 : 0.001 }} transition={{ duration: 0.6 }} />
            {on && latest.get(`${e.source}>${e.target}`) === i && <text x={mx} y={(a.y + b.y) / 2 - 3} fill="#5c5c58" fontSize={9} textAnchor="middle">{e.label}</text>}
          </g>
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos[n.id], on = shown.has(n.id), col = COLOUR[n.type] ?? "#8a93a0";
        return (
          <motion.g key={n.id} initial={false} animate={{ opacity: on ? (n.abandoned && t > n.t ? 0.55 : 1) : 0.12 }} transform={`translate(${p.x},${p.y})`}>
            <rect x={-80} y={-12} width={160} height={24} fill="#ffffff" stroke={col} strokeWidth={on ? 1.5 : 0.6} />
            <circle cx={-68} cy={0} r={4} fill={col} />
            <text x={-58} y={4} fill="#0a0a0a" fontSize={10.5}>{n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label}</text>
            {n.abandoned && on && <text x={0} y={22} fill="#5c5c58" fontSize={9} textAnchor="middle">replaced</text>}
          </motion.g>
        );
      })}
    </svg>
  );
}
