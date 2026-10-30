"""Hit-and-run intercept: a SIMULATION on the real Hyderabad road map (OpenStreetMap).

Nothing here touches a real signal, camera or police radio. The map is real. Signal control, traffic, cameras, patrol units and
the driver's behaviour are simulated, and the driver model is an assumption (below), not something measured.

The assumed driver: having hit someone, he doesn't wait at a red. At each junction he takes an exit that's open, preferring the
direction he was heading, the bigger road, and going straight. That's what makes him steerable: a junction with one green exit
is a junction with one choice.

The agent loops: observe (camera sightings), predict (roll the driver model forward), decide (which spot to steer him to, such that
police get there first and few roads lead out), act (propose signal phases and send units), and re-plan when he goes off the
plan. An officer approves the plan before it runs. Junctions without a controllable signal are where it can lose him, and it says so.

Safety rules in the planner: a junction is only held for the seconds around his arrival, every other junction runs normally,
and spots near a hospital are never chosen as the place to stop him."""
import heapq
import json
import math
import random
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAP_FILE = ROOT / "data" / "map" / "hyderabad.json"
SPEED_KMH = {"motorway": 70, "trunk": 60, "primary": 50, "secondary": 45, "tertiary": 40, "unclassified": 30, "residential": 25}
RANK = {"motorway": 5, "trunk": 5, "primary": 4, "secondary": 3, "tertiary": 2, "unclassified": 1, "residential": 0}
POLICE_KMH = 55.0
SIGNAL_RADIUS_M = 60.0
BLOCK_SETUP_S = 5.0  # a unit has to be in place this long before he arrives to actually stop him
RADIO_DELAY_S = 30.0
EDGE_MARGIN_M = 120.0
HOSPITAL_KEEP_OUT_M = 250.0
REACH_SECONDS = 90.0
HORIZON = (45.0, 260.0)
POLICE_LEAD_S = 15.0
ROLLOUTS = 8
TOP_CANDIDATES = 10
TIMEOUT_S = 600.0
HOLD_BEFORE_S, HOLD_AFTER_S = 20.0, 6.0
PATROLS = 6


def base_class(c: str) -> str:
    return c.replace("_link", "")


class City:
    """The road graph in local metres (x east, y north)."""

    def __init__(self):
        raw = json.loads(MAP_FILE.read_text(encoding="utf-8"))
        s, w, n, e = raw["bbox"]
        self.lat0, self.lon0 = (s + n) / 2, (w + e) / 2
        self.kx, self.ky = 111320.0 * math.cos(math.radians(self.lat0)), 110540.0
        self.xmin, self.ymin = self.xy(s, w)
        self.xmax, self.ymax = self.xy(n, e)
        self.raw, self.attribution = raw, raw["attribution"]
        self._build(raw)

    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def _build(self, raw):
        uses = defaultdict(int)
        for r in raw["roads"]:
            for k, nid in enumerate(r["nodes"]):
                uses[nid] += 2 if k in (0, len(r["nodes"]) - 1) else 1
        pos, segs, out = {}, [], defaultdict(list)
        for r in raw["roads"]:
            pts = [self.xy(*p) for p in r["geom"]]
            start = 0
            for k, nid in enumerate(r["nodes"]):
                pos[nid] = pts[k]
                if k and (uses[nid] >= 2 or k == len(r["nodes"]) - 1):
                    geom = pts[start:k + 1]
                    length = sum(math.dist(a, b) for a, b in zip(geom, geom[1:]))
                    if length > 0.5:
                        sid = len(segs)
                        segs.append({"id": sid, "u": r["nodes"][start], "v": nid, "pts": geom, "len": length, "class": base_class(r["class"]), "name": r.get("name"), "oneway": r["oneway"]})
                        out[r["nodes"][start]].append((nid, sid, 1))
                        if not r["oneway"]:
                            out[nid].append((r["nodes"][start], sid, -1))
                    start = k
        # Keep what's strongly connected to the main network, so nobody starts somewhere they can't leave.
        keep = self._main_component(out)
        self.pos = {n: pos[n] for n in keep}
        self.out = {n: [(v, sid, d) for v, sid, d in out[n] if v in keep] for n in keep}
        self.segs = segs
        # Roads in and out. One-way carriageways only have exits forwards, so a junction has to count both.
        self.links = defaultdict(set)
        for n in keep:
            for v, sid, _ in self.out[n]:
                self.links[n].add((v, sid))
                self.links[v].add((n, sid))
        rng = random.Random(26)
        self.traffic = {s["id"]: (0.62 + 0.25 * rng.random() if RANK.get(s["class"], 0) >= 2 else 0.8 + 0.2 * rng.random()) for s in segs}
        self.junctions = {}
        sig = [self.xy(g["lat"], g["lon"]) for g in raw["signals"]]
        for n in keep:
            if self.degree(n) < 3 or not self.out[n]:
                continue
            mapped = any(math.dist(self.pos[n], q) <= SIGNAL_RADIUS_M for q in sig)
            majors = len({sid for _, sid in self.links[n] if RANK.get(segs[sid]["class"], 0) >= 2})
            if mapped or majors >= 3:  # a real mapped signal, or main roads meeting, assumed to have one
                name = next((segs[sid]["name"] for _, sid, _ in sorted(self.out[n], key=lambda o: -RANK.get(segs[o[1]]["class"], 0)) if segs[sid]["name"]), None)
                self.junctions[n] = {"id": n, "x": self.pos[n][0], "y": self.pos[n][1], "mapped": mapped, "name": name}
        self.hospitals = [self.xy(p["lat"], p["lon"]) for p in raw["places"] if p["amenity"] == "hospital"]
        self.stations = [{"name": p["name"], "xy": self.xy(p["lat"], p["lon"])} for p in raw["places"] if p["amenity"] == "police"]

    def degree(self, n: int) -> int:
        return len({v for v, _ in self.links[n]})

    @staticmethod
    def _main_component(out) -> set:
        # Kosaraju, iteratively: the largest strongly connected component.
        nodes = list({n for n in out} | {v for vs in out.values() for v, _, _ in vs})
        seen, order = set(), []
        for root in nodes:
            if root in seen:
                continue
            stack = [(root, iter(out.get(root, [])))]
            seen.add(root)
            while stack:
                n, it = stack[-1]
                for v, _, _ in it:
                    if v not in seen:
                        seen.add(v)
                        stack.append((v, iter(out.get(v, []))))
                        break
                else:
                    order.append(n)
                    stack.pop()
        rev = defaultdict(list)
        for n, vs in out.items():
            for v, _, _ in vs:
                rev[v].append(n)
        comp, best = {}, set()
        for root in reversed(order):
            if root in comp:
                continue
            members, stack = {root}, [root]
            comp[root] = root
            while stack:
                for v in rev[stack.pop()]:
                    if v not in comp:
                        comp[v] = root
                        members.add(v)
                        stack.append(v)
            if len(members) > len(best):
                best = members
        return best

    def nearest(self, x: float, y: float, major: bool = False) -> int:
        pool = [n for n in self.pos if not major or any(RANK.get(self.segs[s]["class"], 0) >= 2 for _, s, _ in self.out[n])]
        return min(pool, key=lambda n: math.dist(self.pos[n], (x, y)))

    def time_of(self, sid: int, police: bool = False) -> float:
        s = self.segs[sid]
        if police:
            return s["len"] / (POLICE_KMH / 3.6)
        return s["len"] / (SPEED_KMH.get(s["class"], 25) / 3.6 * self.traffic[sid])

    def dijkstra(self, src: int, police: bool = False, limit: float = 1e9) -> tuple[dict, dict]:
        dist, prev, heap = {src: 0.0}, {}, [(0.0, src)]
        while heap:
            d, n = heapq.heappop(heap)
            if d > dist[n] or d > limit:
                continue
            for v, sid, _ in self.out[n]:
                nd = d + self.time_of(sid, police)
                if nd < dist.get(v, 1e18):
                    dist[v], prev[v] = nd, (n, sid)
                    heapq.heappush(heap, (nd, v))
        return dist, prev

    def path(self, prev: dict, src: int, dst: int) -> list[tuple[int, int, int]]:
        """[(from, seg, to), ...]"""
        out, n = [], dst
        while n != src:
            if n not in prev:
                return []
            p, sid = prev[n]
            out.append((p, sid, n))
            n = p
        return out[::-1]

    def near_edge(self, n: int) -> bool:
        x, y = self.pos[n]
        return x < self.xmin + EDGE_MARGIN_M or x > self.xmax - EDGE_MARGIN_M or y < self.ymin + EDGE_MARGIN_M or y > self.ymax - EDGE_MARGIN_M

    def bearing(self, sid: int, a: int) -> float:
        s = self.segs[sid]
        pts = s["pts"] if s["u"] == a else s["pts"][::-1]
        b = pts[min(3, len(pts) - 1)]
        return math.atan2(b[0] - pts[0][0], b[1] - pts[0][1])

    def seg_pts(self, sid: int, a: int) -> list:
        s = self.segs[sid]
        return s["pts"] if s["u"] == a else s["pts"][::-1]

    def exit_name(self, sid: int) -> str:
        return self.segs[sid]["name"] or f"the {self.segs[sid]['class']} road"


@lru_cache(maxsize=1)
def city() -> City:
    return City()


@lru_cache(maxsize=1)
def map_payload() -> dict:
    """What the 3D view draws. Footprints are real; a height is the mapped one, else an estimate."""
    c = city()
    rng = random.Random(7)
    buildings = []
    for b in c.raw["buildings"]:
        pts = [[round(v, 1) for v in c.xy(*p)] for p in b["geom"]]
        h = None
        try:
            h = float(str(b["height"]).split()[0]) if b.get("height") else float(b["levels"]) * 3.3 if b.get("levels") else None
        except ValueError:
            pass
        buildings.append({"pts": pts, "h": round(h if h else 6 + rng.random() ** 2 * 22, 1), "mapped": h is not None})
    return {"attribution": c.attribution, "bounds": [c.xmin, c.ymin, c.xmax, c.ymax],
            "roads": [{"id": s["id"], "pts": [[round(x, 1), round(y, 1)] for x, y in s["pts"]], "class": s["class"], "name": s["name"], "flow": round(c.traffic[s["id"]], 2)} for s in c.segs if s["u"] in c.pos and s["v"] in c.pos],
            "buildings": buildings, "junctions": list(c.junctions.values()),
            "places": [{"amenity": p["amenity"], "name": p["name"], "x": c.xy(p["lat"], p["lon"])[0], "y": c.xy(p["lat"], p["lon"])[1]} for p in c.raw["places"]]}


def driver_choice(c: City, at: int, via: int | None, greens: set | None, heading: float, rng: random.Random) -> tuple | None:
    """The assumed driver. Doesn't wait: takes an open exit, leaning to his heading, the bigger road, and straight on."""
    exits = [o for o in c.out[at] if o[1] != via]
    if not exits:
        return None
    if greens is not None:
        open_exits = [o for o in exits if o[1] in greens]
        if open_exits:
            exits = open_exits
    best, top = None, -1e9
    came = c.bearing(via, c.segs[via]["u"] if c.segs[via]["v"] == at else c.segs[via]["v"]) if via is not None else heading
    for o in exits:
        b = c.bearing(o[1], at)
        score = 1.4 * math.cos(b - heading) + 0.9 * math.cos(b - came) + 0.45 * RANK.get(c.segs[o[1]]["class"], 0) - rng.random() * 0.0 + rng.gauss(0, 0.45)
        if score > top:
            best, top = o, score
    return best


def reach(c: City, at: int, via: int | None, plan_greens: dict, seconds: float = REACH_SECONDS) -> set:
    """Road segments he could be on within the time. Junctions with a held green only let him one way."""
    seen, heap, best = set(), [(0.0, at, via)], {}
    while heap:
        d, n, v = heapq.heappop(heap)
        if d > seconds or best.get((n, v), 1e18) < d:
            continue
        greens = plan_greens.get(n)
        for w, sid, _ in c.out[n]:
            if sid == v or (greens is not None and sid not in greens):
                continue
            seen.add(sid)
            nd = d + c.time_of(sid)
            if nd < best.get((w, sid), 1e18):
                best[(w, sid)] = nd
                heapq.heappush(heap, (nd, w, sid))
    return seen


def rollout(c: City, start: int, via: int | None, plan: dict, target: int, blocks: set, heading: float, seed: int, max_t: float) -> tuple[bool, float, int]:
    rng = random.Random(seed)
    n, v, t = start, via, 0.0
    while t < max_t:
        if n == target or n in blocks:
            return True, t, n
        if c.near_edge(n):
            return False, t, n
        step = driver_choice(c, n, v, plan.get(n), heading, rng)
        if step is None:
            return True, t, n
        t += c.time_of(step[1])
        n, v = step[0], step[1]
    return False, t, n


class Unit:
    def __init__(self, c: City, uid: str, name: str, node: int):
        self.c, self.id, self.name, self.node = c, uid, name, node
        self.role, self.goal = "patrol", None
        self.history = []
        self.keys = [(0.0, *c.pos[node])]
        self.route, self.t_free, self.arrive = [], 0.0, None

    def send(self, goal: int, role: str, now: float):
        self.settle(now)
        self.role, self.goal = role, goal
        self.history.append({"t": round(now, 1), "goal": goal, "role": role})
        if goal == self.node:
            self.route, self.arrive = [], now
            return
        _, prev = self.c.dijkstra(self.node, police=True)
        self.route = self.c.path(prev, self.node, goal)
        self.t_free = max(self.t_free, now)
        self.arrive = self.t_free + sum(self.c.time_of(s, True) for _, s, _ in self.route)

    def settle(self, now: float):
        """Advance along the route up to `now`, recording the path."""
        while self.route:
            a, sid, b = self.route[0]
            dt = self.c.time_of(sid, True)
            if self.t_free + dt > now:
                break
            pts = self.c.seg_pts(sid, a)
            for k, p in enumerate(pts[1:], start=1):
                self.keys.append((self.t_free + dt * k / (len(pts) - 1), *p))
            self.t_free += dt
            self.node = b
            self.route.pop(0)
        self.t_free = max(self.t_free, min(now, self.t_free)) if self.route else max(self.t_free, now)

    def where(self, now: float) -> int:
        self.settle(now)
        return self.node

    def there_by(self, node: int, now: float) -> bool:
        self.settle(now)
        return self.goal == node and self.arrive is not None and self.arrive <= now


def choose_plan(c: City, at: int, via: int | None, t: float, units: list[Unit], heading: float, rollouts: int = ROLLOUTS) -> dict | None:
    """Predict and decide. Candidate spots are few-exit places he reaches in time and police reach first; each is scored by
    rolling the driver model forward under the signal plan that would steer him there."""
    dist, prev = c.dijkstra(at, limit=HORIZON[1])
    police = {u.id: c.dijkstra(u.where(t), police=True, limit=HORIZON[1] + 60)[0] for u in units}
    cands = []
    for n, eta in dist.items():
        if not HORIZON[0] <= eta <= HORIZON[1] or c.near_edge(n):
            continue
        degree = c.degree(n)
        if degree > 3:
            continue
        if any(math.dist(c.pos[n], h) < HOSPITAL_KEEP_OUT_M for h in c.hospitals):
            continue
        p_eta = min(d.get(n, 1e9) for d in police.values())
        if p_eta > eta + POLICE_LEAD_S:
            continue
        path = c.path(prev, at, n)
        if not path or (via is not None and path[0][1] == via):
            continue
        ctrl = sum(1 for a, _, _ in path if a in c.junctions and len(c.out[a]) >= 2)
        free = sum(1 for a, _, _ in path[1:] if a not in c.junctions and len(c.out[a]) >= 2)
        cands.append((ctrl * 1.5 - free * 1.8 + (3 - degree) * 1.5 + (eta - p_eta) / 60 - eta / 200, n, eta, p_eta, path, degree, ctrl, free))
    if not cands:
        return None
    cands.sort(key=lambda r: -r[0])
    best = None
    for _, n, eta, p_eta, path, degree, ctrl, free in cands[:TOP_CANDIDATES]:
        plan = {a: {sid} for a, sid, _ in path if a in c.junctions}
        wins = sum(rollout(c, at, via, plan, n, set(), heading, 1000 + i, eta * 2.5)[0] for i in range(rollouts))
        rec = {"target": n, "eta": eta, "police_eta": p_eta, "path": path, "plan": plan, "p": wins / rollouts, "degree": degree, "ctrl": ctrl, "free": free}
        if best is None or (rec["p"], -rec["eta"]) > (best["p"], -best["eta"]):
            best = rec
    return best


def simulate(start_xy: tuple[float, float], heading: float, seed: int, use_agent: bool = True, use_signals: bool = True, detail: bool = True, rollouts: int = ROLLOUTS, defy: bool = False) -> dict:
    """Three arms: agent with signals; the same agent with no signal control; and no agent at all, where units just chase the
    last camera sighting by radio. In every arm a unit only stops him if it was at that spot, set up, before he got there."""
    c = city()
    rng = random.Random(seed)
    start = c.nearest(*start_xy, major=True)
    # Patrol units: real stations where the map has them, otherwise on main roads. All simulated.
    urng = random.Random(11)
    units = []
    for i, s in enumerate(c.stations[:3]):
        units.append(Unit(c, f"P{i + 1}", s["name"], c.nearest(*s["xy"], major=True)))
    majors = [n for n in c.pos if any(RANK.get(c.segs[o[1]]["class"], 0) >= 3 for o in c.out[n]) and not c.near_edge(n) and math.dist(c.pos[n], c.pos[start]) > 500]
    while len(units) < PATROLS:
        units.append(Unit(c, f"P{len(units) + 1}", f"Patrol {len(units) + 1}", urng.choice(majors)))

    t, at, via = 0.0, start, None
    keys = [(0.0, *c.pos[at], heading)]
    route, sightings, decisions, signals, reach_log, off_plan = [], [], [], [], [], 0
    last_said = {}
    cur, outcome = None, None
    target_history = []

    AGENT = {"observe": "Tracker", "plan": "Planner", "signal": "Signal", "dispatch": "Dispatch"}
    defied, defy_now = False, False

    def say(text, kind="decide", **kw):
        if detail:
            decisions.append({"t": round(t, 1), "kind": kind, "agent": AGENT.get(kind, "Coordinator"), "text": text, **kw})

    def apply_plan(p):
        nonlocal cur
        cur = p
        target_history.append({"t": round(t, 1), "node": p["target"], "x": c.pos[p["target"]][0], "y": c.pos[p["target"]][1], "p": p["p"], "name": c.exit_name(p["path"][-1][1]), "eta": round(t + p["eta"], 1)})
        order = sorted(units, key=lambda u: c.dijkstra(u.where(t), police=True, limit=400)[0].get(p["target"], 1e9))
        was = {u.id: (u.goal, u.role) for u in units}
        order[0].send(p["target"], "block the spot", t)
        if len(order) > 1:
            order[1].send(p["target"], "back-up at the spot", t)
        # Cover where he's likeliest to slip away: the first uncontrolled turn off the route.
        leaks = []
        for a, sid, _ in p["path"]:
            if a not in c.junctions and len(c.out[a]) >= 2:
                leaks += [v for v, s2, _ in c.out[a] if s2 != sid and s2 != via]
        for u, leak in zip(order[2:4], leaks[:2]):
            u.send(leak, "cover a side road", t)
        msgs = []
        for u in order[:4]:
            if u.goal is not None and u.arrive is not None:
                g0, r0 = was[u.id]
                verb = "sent to" if g0 is None else "re-routed to" if g0 != u.goal else "now" if r0 != u.role else "stays on"
                msgs.append((f"{u.id} {u.name}: {verb} {u.role}, in place by T+{u.arrive:.0f} s.", u.id))
        return msgs

    if use_agent:
        say(f"Hit-and-run flagged. Reading plate at the scene, tracking on every camera.", "observe")
        p = choose_plan(c, at, via, t, units, heading, rollouts)
        if p:
            msgs = apply_plan(p)
            say(f"Steer him to {c.exit_name(p['path'][-1][1])}: only {p['degree']} way{'s' if p['degree'] != 1 else ''} out, police can be there {max(0, p['eta'] - p['police_eta']):.0f} s before him. Using {p['ctrl']} signal{'s' if p['ctrl'] != 1 else ''}; {p['free']} uncontrolled turn{'s' if p['free'] != 1 else ''} on the way. Model says {p['p'] * 100:.0f}% he goes that way.", "plan")
            for m, uid in msgs:
                say(m, "dispatch", unit=uid)
    else:
        # Without the system: police head for his last known position, and nothing narrows his choices.
        pass

    while t < TIMEOUT_S:
        for u in units:
            u.settle(t)
        # Contained?
        here = [u for u in units if u.goal == at and u.arrive is not None and u.arrive <= t - BLOCK_SETUP_S]
        if here:
            outcome = {"result": "contained", "t": round(t, 1), "node": at, "x": c.pos[at][0], "y": c.pos[at][1], "unit": here[0].name}
            say(f"Stopped at the planned spot by {here[0].name}, which was in place {t - here[0].arrive:.0f} s before he arrived.", "observe")
            break
        if c.near_edge(at) and t > 5:
            outcome = {"result": "left_map", "t": round(t, 1), "node": at, "x": c.pos[at][0], "y": c.pos[at][1]}
            break
        greens = None
        if at in c.junctions:
            sightings.append({"t": round(t, 1), "junction": at, "x": c.pos[at][0], "y": c.pos[at][1], "conf": round(0.82 + 0.17 * rng.random(), 2), "mapped": c.junctions[at]["mapped"]})
            if use_agent and use_signals and cur and at in cur["plan"]:
                greens = cur["plan"][at]
        if use_agent and detail:
            active = cur["plan"] if cur and use_signals else {}
            free_set, held_set = reach(c, at, via, {}), reach(c, at, via, active)
            reach_log.append({"t": round(t, 1), "free": sorted(free_set), "held": sorted(held_set), "free_km": round(sum(c.segs[s]["len"] for s in free_set) / 1000, 1), "held_km": round(sum(c.segs[s]["len"] for s in held_set) / 1000, 1)})
        step = driver_choice(c, at, via, greens, heading, rng)
        defy_now = False
        if defy and not defied and greens is not None and t > 20:
            # The showcase: at a held junction he jumps the red and goes left, to dodge the queue, instead of the green.
            exits = [o for o in c.out[at] if o[1] != via and o[1] not in greens]
            if exits:
                came = c.bearing(via, c.segs[via]["u"] if c.segs[via]["v"] == at else c.segs[via]["v"]) if via is not None else heading
                turn = lambda o: (c.bearing(o[1], at) - came + math.pi) % (2 * math.pi) - math.pi
                step, defied, defy_now = min(exits, key=turn), True, True
        if step is None:
            outcome = {"result": "dead_end", "t": round(t, 1), "node": at, "x": c.pos[at][0], "y": c.pos[at][1]}
            say("He has run into a road with no way out. Units close in.", "observe")
            break
        nxt, sid, _ = step
        dt = c.time_of(sid)
        if use_agent and detail and greens is not None:
            exits = [o for o in c.out[at] if o[1] != via]
            signals.append({"junction": at, "from": round(max(0, t - HOLD_BEFORE_S), 1), "to": round(t + HOLD_AFTER_S, 1), "green": sorted(greens), "red": sorted(o[1] for o in exits if o[1] not in greens), "x": c.pos[at][0], "y": c.pos[at][1]})
            name = c.junctions[at]["name"] or "the junction"
            # One real junction is several map nodes, so say it once per junction, and only where there was a choice to take away.
            if len(exits) > 1 and t - last_said.get(name, -1e9) > 25:
                last_said[name] = t
                say(f"{name}: green only towards {c.exit_name(next(iter(greens)))}, red on the other {len(exits) - 1} exit{'s' if len(exits) > 2 else ''}. He doesn't wait, so he takes it.", "signal")
        pts = c.seg_pts(sid, at)
        for k, q in enumerate(pts[1:], start=1):
            keys.append((t + dt * k / (len(pts) - 1), *q, math.atan2(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1])))
        route.append(sid)
        if use_agent and cur and not any(a == at and s == sid for a, s, _ in cur["path"]) and at != cur["target"]:
            off_plan += 1
            t += dt
            at, via = nxt, sid
            if defy_now:
                say(f"He jumped the red and turned left onto {c.exit_name(sid)}, dodging the traffic held on the right. Off the plan.", "observe")
            else:
                say(f"He turned onto {c.exit_name(sid)}: an uncontrolled turn, off the plan. Re-planning.", "observe")
            p = choose_plan(c, at, via, t, units, heading, rollouts)
            if p:
                msgs = apply_plan(p)
                gap = math.dist(c.pos[p["target"]], c.pos[target_history[-2]["node"]]) if len(target_history) > 1 else 0
                where = "The same spot still works" if gap < 30 else f"New spot on {c.exit_name(p['path'][-1][1])}, {gap:.0f} m from the old one"
                say(f"{where}: {p['degree']} way{'s' if p['degree'] != 1 else ''} out, {p['ctrl']} signals re-timed to bring him back, model says {p['p'] * 100:.0f}%.", "plan")
                for m, uid in msgs:
                    say(m, "dispatch", unit=uid)
            continue
        t += dt
        at, via = nxt, sid
        if not use_agent and sightings and sightings[-1]["t"] <= t - RADIO_DELAY_S and (not units[0].goal or units[0].goal != sightings[-1]["junction"]):
            # Radio chase: the nearest units head for where a camera last saw him, about 30 s late.
            for u in units[:3]:
                u.send(sightings[-1]["junction"], "chase", t)
    if outcome is None:
        outcome = {"result": "timeout", "t": round(t, 1), "node": at, "x": c.pos[at][0], "y": c.pos[at][1]}
    for u in units:
        u.settle(outcome["t"])
    if not detail:
        return {"outcome": outcome, "off_plan": off_plan}
    return {"seed": seed, "start": {"node": start, "x": c.pos[start][0], "y": c.pos[start][1]}, "heading": heading, "outcome": outcome, "off_plan": off_plan, "duration": outcome["t"],
            "suspect": [{"t": round(a, 2), "x": round(b, 1), "y": round(d, 1), "yaw": round(e, 3)} for a, b, d, e in keys], "route": route, "sightings": sightings, "decisions": decisions,
            "signals": signals, "reach": reach_log, "targets": target_history,
            "units": [{"id": u.id, "name": u.name, "role": u.role, "goal": u.goal, "history": u.history, "arrive": round(u.arrive, 1) if u.arrive else None, "keys": [{"t": round(a, 2), "x": round(b, 1), "y": round(d, 1)} for a, b, d in u.keys]} for u in units]}


def evaluate(start_xy, heading, runs: int = 30) -> dict:
    """The same driver model and map, with and without the agent. Simulated runs, so this tests the plan against its own assumptions."""
    res = {}
    for label, agent, signals, defy in (("agent_signals", True, True, False), ("agent_defied", True, True, True), ("agent_only", True, False, False), ("chase", False, False, False)):
        out = [simulate(start_xy, heading, 500 + i, use_agent=agent, use_signals=signals, detail=False, rollouts=4, defy=defy)["outcome"] for i in range(runs)]
        got = [o for o in out if o["result"] in ("contained", "dead_end")]
        times = sorted(o["t"] for o in got)
        res[label] = {"runs": runs, "contained": len(got), "rate": round(len(got) / runs, 2), "median_s": times[len(times) // 2] if times else None, "left_map": sum(o["result"] == "left_map" for o in out)}
    return res


def run_for_case(case_dir: Path, case: dict) -> dict:
    c = city()
    loc = case.get("location", {})
    lat, lon = loc.get("lat"), loc.get("lon")
    drill = lat is None or lon is None
    if drill or not (c.raw["bbox"][0] <= lat <= c.raw["bbox"][2] and c.raw["bbox"][1] <= lon <= c.raw["bbox"][3]):
        lat, lon, drill = 17.4401, 78.3489, True
    xy = c.xy(lat, lon)
    p = case_dir / "pursuit.json"
    pursuit = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    compass = {"north": 0, "north-east": 45, "east": 90, "south-east": 135, "south": 180, "south-west": 225, "west": 270, "north-west": 315}
    heading = math.radians(compass.get(str((pursuit.get("exit") or {}).get("heading", "north")).lower(), 0))
    best = None
    for seed in range(1, 25):  # one illustrative run for the screen: the first that shows the plan working and at least one re-plan
        r = simulate(xy, heading, seed, defy=True)
        if r["outcome"]["result"] in ("contained", "dead_end") and (best is None or (r["off_plan"] >= 1 and best["off_plan"] < 1)):
            best = r
            if r["off_plan"] >= 1 and r["duration"] > 60:
                break
    if best is None:
        best = simulate(xy, heading, 1)
    base = simulate(xy, heading, best["seed"], use_agent=False, use_signals=False)
    plate = (pursuit.get("match") or {}).get("plate") or pursuit.get("partial_plate")
    return {"drill": drill, "plate": plate, "simulated": True, "run": best, "graph": knowledge_graph(best, plate, case), "baseline": {"suspect": base["suspect"], "outcome": base["outcome"]}, "evaluation": evaluate(xy, heading),
            "assumptions": ["The driver doesn't wait at a red and takes an open exit, leaning to his heading and the bigger road.", "Every major junction is treated as having a controllable signal, though the map only records 17 real ones here.",
                            "Cameras sit at those junctions and always see him.", "Traffic speeds and patrol positions are invented."], "attribution": c.attribution}


def knowledge_graph(run: dict, plate: str | None, case: dict) -> dict:
    """What the agents know and did, as linked facts. Each node and edge carries the time it became known."""
    from . import toll_db
    nodes, edges = {}, []

    def node(nid, label, kind, t=0.0, **kw):
        if nid not in nodes:
            nodes[nid] = {"id": nid, "label": label, "type": kind, "t": round(t, 1), **kw}
        return nid

    def edge(a, b, label, t=0.0):
        edges.append({"source": a, "target": b, "label": label, "t": round(t, 1)})

    node("case", case.get("title", "Case"), "case")
    node("suspect", f"Suspect vehicle{' · ' + plate if plate else ''}", "suspect")
    edge("case", "suspect", "hit-and-run")
    for m in toll_db.search([plate])["matches"][:2] if plate else []:
        node(m["id"], f"Toll record {m['plate']}", "record", 0, fictional=True)
        edge("suspect", m["id"], "plate match")
    for a in ("Tracker", "Planner", "Signal", "Dispatch"):
        node(a, f"{a} agent", "agent")
    c = city()
    seen = {}
    for s in run["sightings"]:
        name = c.junctions.get(s["junction"], {}).get("name") or f"Junction {s['junction']}"
        if name not in seen and len(seen) < 6:
            seen[name] = node(f"cam:{name}", f"Camera · {name}", "camera", s["t"])
            edge("Tracker", seen[name], "watches", s["t"])
            edge(seen[name], "suspect", f"saw him T+{s['t']:.0f}s", s["t"])
    prev, prev_node, spot_of = None, None, {}
    for i, g in enumerate(run["targets"]):
        if g["node"] == prev_node:  # re-planned and kept the same spot
            edge("Planner", prev, f"kept after re-plan ({g['p'] * 100:.0f}%)", g["t"])
            spot_of[i] = prev
            continue
        sid = node(f"spot:{i}", f"Spot {len(set(spot_of.values())) + 1} · {g['name']}", "spot", g["t"])
        edge("Planner", sid, f"chose ({g['p'] * 100:.0f}%)", g["t"])
        if prev:
            nodes[prev]["abandoned"] = True
            edge(prev, sid, "replaced by", g["t"])
        prev, prev_node, spot_of[i] = sid, g["node"], sid
    said = set()
    for sg in run["signals"]:
        name = c.junctions.get(sg["junction"], {}).get("name") or f"Junction {sg['junction']}"
        if name in said:
            continue
        said.add(name)
        jid = node(f"sig:{name}", f"Signal · {name}", "signal", sg["from"])
        edge("Signal", jid, "holds one green", sg["from"])
        spot = max((i for i, g in enumerate(run["targets"]) if g["t"] <= sg["from"] + HOLD_BEFORE_S), default=0)
        edge(jid, spot_of.get(spot, prev), "steers toward", sg["from"])
    spots = {g["node"]: spot_of[i] for i, g in enumerate(run["targets"])}
    for u in run["units"]:
        if not u["history"]:
            continue
        uid = node(u["id"], f"{u['id']} · {u['name']}", "unit", u["history"][0]["t"])
        for h in u["history"]:
            edge("Dispatch", uid, "sends" if h is u["history"][0] else "re-routes", h["t"])
            if h["goal"] in spots:
                edge(uid, spots[h["goal"]], h["role"], h["t"])
    o = run["outcome"]
    node("outcome", {"contained": "Stopped", "dead_end": "Cornered", "left_map": "Lost", "timeout": "Not stopped"}[o["result"]], "outcome", o["t"])
    edge("suspect", "outcome", f"T+{o['t']:.0f}s", o["t"])
    if prev and o["result"] in ("contained", "dead_end"):
        edge(prev, "outcome", "here", o["t"])
    return {"nodes": list(nodes.values()), "edges": edges}
