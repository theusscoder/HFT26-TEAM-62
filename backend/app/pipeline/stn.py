"""Simple Temporal Network over the case's events. Floyd-Warshall gives each event its tightest window, and a
negative cycle proves a set of statements can't all be true. Each edge (a, b, w) means t(b) - t(a) <= w.

Timed events (video, sensor, inferred) contribute their window. A witness gives order, not time, so a claim
only says before / at / after impact, plus any "A then B" the witness states."""
from dataclasses import dataclass

import numpy as np

T0 = "T0"
EPS = 1e-9
MATCH_TOLERANCE_S = 0.1  # a witness's "it braked" is the same physical event the sensor timed
MATCH_CONFIDENCE = 0.95
AT_IMPACT_S = 0.5
ONSET_ACTIONS = {"brake", "turn"}
SAME_CLOCK_TOLERANCE_S = 0.05


@dataclass(frozen=True)
class Edge:
    a: str
    b: str
    w: float
    ref: str
    constraint: bool
    confidence: float


def event_bounds(e: dict) -> tuple[float | None, float | None]:
    if e.get("clock") == "order":
        order = e.get("order", "unknown")
        return {"before_impact": (None, 0.0), "at_impact": (-AT_IMPACT_S, AT_IMPACT_S), "after_impact": (0.0, None)}.get(order, (None, None))
    sigma = e["t"].get("sigma", 0.0)
    # "It braked" means when braking began, not the whole time the brakes were on.
    end = e["t"]["start"] if e["action"] in ONSET_ACTIONS else e["t"]["end"]
    return e["t"]["start"] - sigma, end + sigma


def build_edges(events: list[dict], constraints: list[dict]) -> list[Edge]:
    edges = []
    for e in events:
        lo, hi = event_bounds(e)
        if hi is not None:
            edges.append(Edge(T0, e["id"], hi, e["id"], False, e["confidence"]))
        if lo is not None:
            edges.append(Edge(e["id"], T0, -lo, e["id"], False, e["confidence"]))
    for c in constraints:
        if c.get("max_s") is not None:
            edges.append(Edge(c["from"], c["to"], c["max_s"], c["id"], True, c["confidence"]))
        if c.get("min_s") is not None:
            edges.append(Edge(c["to"], c["from"], -c["min_s"], c["id"], True, c["confidence"]))
    return edges


def floyd_warshall(nodes: list[str], edges: list[Edge]) -> tuple[np.ndarray, bool]:
    index = {n: i for i, n in enumerate(nodes)}
    n = len(nodes)
    dist = np.full((n, n), np.inf)
    np.fill_diagonal(dist, 0.0)
    for e in edges:
        i, j = index[e.a], index[e.b]
        dist[i, j] = min(dist[i, j], e.w)
    for k in range(n):
        dist = np.minimum(dist, dist[:, k, None] + dist[k, None, :])
        if (np.diag(dist) < -EPS).any():
            return dist, False
    return dist, True


def negative_cycle(nodes: list[str], edges: list[Edge]) -> list[Edge] | None:
    """Bellman-Ford with parent edges; returns one negative cycle's edges in order."""
    dist = dict.fromkeys(nodes, 0.0)
    parent: dict[str, Edge] = {}
    changed = None
    for _ in range(len(nodes)):
        changed = None
        for e in edges:
            if dist[e.a] + e.w < dist[e.b] - EPS:
                dist[e.b] = dist[e.a] + e.w
                parent[e.b] = e
                changed = e.b
        if changed is None:
            return None
    node = changed
    for _ in range(len(nodes)):
        node = parent[node].a
    cycle, current = [], node
    while True:
        edge = parent[current]
        cycle.append(edge)
        current = edge.a
        if current == node:
            break
    cycle.reverse()
    return cycle


def match_constraints(ordered: list[dict], events: list[dict]) -> list[dict]:
    """Tie each witness event in a stated order to the timed event it describes, so they can be compared."""
    out, matched = [], []
    timed = [e for e in events if e.get("clock") != "order" and e.get("kind") != "CLAIMED"]
    for w in ordered:
        candidates = [e for e in timed if e["action"] == w["action"] and e["actor"] == w["actor"]]
        if not candidates:
            continue
        # A direct measurement outranks an inference built on it.
        first = min(candidates, key=lambda e: (e["kind"] != "OBSERVED", e["t"]["start"]))
        out.append({"id": f"MATCH-{w['id']}", "from": w["id"], "to": first["id"], "min_s": -MATCH_TOLERANCE_S, "max_s": MATCH_TOLERANCE_S,
                    "confidence": MATCH_CONFIDENCE, "ref": w.get("ref", "")})
        if first not in matched:
            matched.append(first)
    # A clock error moves everything on that clock together, so the spacing between its events stays exact.
    for i, a in enumerate(matched):
        for b in matched[i + 1:]:
            if a["source"] == b["source"]:
                gap = b["t"]["start"] - a["t"]["start"]
                out.append({"id": f"SAME-CLOCK-{a['id']}-{b['id']}", "from": a["id"], "to": b["id"], "min_s": gap - SAME_CLOCK_TOLERANCE_S,
                            "max_s": gap + SAME_CLOCK_TOLERANCE_S, "confidence": MATCH_CONFIDENCE, "ref": a.get("ref", "")})
    return out


def solve(events: list[dict], constraints: list[dict]) -> dict:
    """Windows, plus every conflict. A conflicting statement is set aside so the rest still solve."""
    nodes = [T0, *[e["id"] for e in events]]
    edges = build_edges(events, constraints)
    witness_ids = {e["id"] for e in events if e.get("kind") == "CLAIMED"}
    by_id = {c["id"]: c for c in constraints}
    conflicts, excluded = [], []
    active = list(edges)
    while True:
        _, ok = floyd_warshall(nodes, active)
        if ok:
            break
        cycle = negative_cycle(nodes, active)
        conflicts.append(cycle)
        # Statements give way before measurements; among those, the least confident goes first.
        weakest = min(cycle, key=lambda e: (not e.constraint, e.confidence, e.ref))
        if weakest.constraint:
            c = by_id[weakest.ref]
            dropped = {c["from"], c["to"]}
        else:
            dropped = {weakest.ref}
        dropped = (dropped & witness_ids) or dropped
        excluded.extend(d for d in dropped if d not in excluded)
        active = [e for e in active if e.a not in dropped and e.b not in dropped]

    dist, _ = floyd_warshall(nodes, active)
    windows = {}
    for i, e in enumerate(events, start=1):
        if e["id"] in excluded:
            continue
        hi, lo = dist[0, i], dist[i, 0]
        windows[e["id"]] = [None if np.isinf(lo) else round(float(-lo), 3), None if np.isinf(hi) else round(float(hi), 3)]
    return {
        "consistent": not conflicts,
        "windows": windows,
        "excluded": sorted(excluded),
        "conflicts": [
            {"events": sorted({n for e in cyc for n in (e.a, e.b) if n != T0}),
             "constraints": sorted({e.ref for e in cyc if e.constraint}),
             "off_by_s": round(abs(sum(e.w for e in cyc)), 2)}
            for cyc in conflicts
        ],
    }


ORDER_ACTIONS = {"brake", "impact", "stop", "sudden_decel", "turn", "signal", "crash_sound", "skid", "possible_contact"}
ORDER_SENSITIVE_S = 0.2


def sensitivity(events: list[dict], offsets: dict, actors: set[str] | None = None, labels: dict[str, str] | None = None) -> list[dict]:
    """Orderings between different sources rest on those clocks. For each, the amount a clock would need to be
    wrong to flip it: "this ordering holds unless the sensor clock is off by more than X s". Limited to the
    vehicles involved, since an unrelated motorcycle's braking order tells nobody anything."""
    timed = [e for e in events if e.get("clock") != "order" and e.get("source") in offsets and e["action"] in ORDER_ACTIONS
             and (actors is None or e["actor"] in actors)]
    out = []
    name = lambda e: f"{(labels or {}).get(e['actor'], e['actor'])} {e['action'].replace('_', ' ')}"
    for later in sorted(timed, key=lambda e: e["t"]["start"]):
        before = [e for e in timed if e["source"] != later["source"] and e["action"] != later["action"] and e["t"]["end"] < later["t"]["start"]]
        if not before:
            continue
        earlier = max(before, key=lambda e: e["t"]["end"])
        margin = round(later["t"]["start"] - earlier["t"]["end"], 2)
        sigma = offsets.get(later["source"], {}).get("sigma", 0.0) or 0.0
        out.append({"earlier": earlier["id"], "later": later["id"], "margin_s": margin, "clock": later["source"],
                    "clock_sigma_s": sigma, "sensitive": margin < max(ORDER_SENSITIVE_S, 2 * sigma),
                    "text": f"{name(earlier)} came before {name(later)}. "
                            f"This ordering holds unless the {later['source']} clock is off by more than {margin} s."})
    return out
