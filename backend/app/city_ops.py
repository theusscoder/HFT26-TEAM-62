"""City operations: every incident and every dispatch across the mapped part of Hyderabad, as one picture.

Real: the road network, hospitals and police stations (OpenStreetMap), and any case whose location falls on the map.
SIMULATED, and labelled so: the stream of other incidents (seeded), the fleet (two ambulances per hospital, two patrol cars
per station) and traffic. The dispatch agent sends, for each incident, the closest unit that is free by road time, not the
closest building; a busy unit is skipped and the agent says so. Severe incidents take the nearest free trauma-ready
ambulance first."""
import json
import math
import random
from pathlib import Path

from . import intercept

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "data" / "cases"
WINDOW_S = 1800
INCIDENTS = 14
AMBULANCES_PER_HOSPITAL = 2
CARS_PER_STATION = 2
ON_SCENE_S = {"L3": 900, "L2": 600, "L1": 300, "L0": 120}
SEVERITY_MIX = [("L1", 0.45), ("L2", 0.35), ("L3", 0.2)]


def _latlon(c, x, y):
    return round(y / c.ky + c.lat0, 6), round(x / c.kx + c.lon0, 6)


def run(seed: int = 7, fixed: list | None = None, sims: int = INCIDENTS) -> dict:
    c = intercept.city()
    rng = random.Random(seed)
    s, w, n, e = c.raw["bbox"]
    majors = [nd for nd in c.pos if any(intercept.RANK.get(c.segs[o[1]]["class"], 0) >= 2 for o in c.out[nd]) and not c.near_edge(nd)]
    incidents = [{**f, "node": c.nearest(*c.xy(f["lat"], f["lon"]), major=True)} for f in (fixed or [])]
    for cdir in ([] if fixed is not None else sorted(CASES.iterdir())):   # real cases located on this map
        cj = cdir / "case.json"
        if not cj.exists():
            continue
        case = json.loads(cj.read_text(encoding="utf-8"))
        loc = case.get("location", {})
        if loc.get("lat") is None or not (s <= loc["lat"] <= n and w <= loc["lon"] <= e):
            continue
        sev = json.loads((cdir / "severity.json").read_text()) if (cdir / "severity.json").exists() else {}
        incidents.append({"id": case["id"], "t": 60, "node": c.nearest(*c.xy(loc["lat"], loc["lon"]), major=True), "level": sev.get("level", "L2"),
                          "title": case.get("title", case["id"]), "real": True, "case": case["id"]})
    for i in range(sims):
        r, acc = rng.random(), 0.0
        level = next(l for l, p in SEVERITY_MIX if (acc := acc + p) >= r)
        kind = rng.choice(["Two-wheeler skid", "Car rear-ended", "Pedestrian struck", "Auto-rickshaw collision", "Bus scraped a car", "Bike hit a divider"])
        incidents.append({"id": f"SIM-{i + 1:02d}", "t": rng.randint(0, WINDOW_S - 300), "node": rng.choice(majors), "level": level, "title": kind, "real": False})
    incidents.sort(key=lambda x: x["t"])

    units = []
    for p in c.raw["places"]:
        k = "ambulance" if p["amenity"] == "hospital" else "police"
        for j in range(AMBULANCES_PER_HOSPITAL if k == "ambulance" else CARS_PER_STATION):
            units.append({"id": f"{'AMB' if k == 'ambulance' else 'PC'}-{len([u for u in units if u['kind'] == k]) + 1:02d}", "kind": k, "base": p["name"],
                          "home": c.nearest(*c.xy(p["lat"], p["lon"])), "free_at": 0, "keys": [], "jobs": 0})
    for u in units:
        u["keys"].append([0, *_latlon(c, *c.pos[u["home"]])])
    from_cache = {}

    def times_from(node):
        if node not in from_cache:
            from_cache[node] = c.dijkstra(node, police=True, limit=2400)
        return from_cache[node]

    log, served = [], []
    for inc in incidents:
        for kind in ("ambulance", "police"):
            free, busy = [], []
            for u in units:
                if u["kind"] != kind:
                    continue
                start = u.get("at", u["home"])
                dist, prev = times_from(start)
                eta = dist.get(inc["node"])
                if eta is None:
                    continue
                (free if u["free_at"] <= inc["t"] else busy).append((eta, u, prev, start))
            if not free:
                log.append({"t": inc["t"], "incident": inc["id"], "text": f"{inc['id']}: no {kind} free; queued for the next one to clear."})
                continue
            free.sort(key=lambda x: x[0])
            eta, u, prev, start = free[0]
            nearest_busy = min(busy, key=lambda x: x[0]) if busy else None
            path = c.path(prev, start, inc["node"])
            t = inc["t"]
            for a, sid, b in path:
                dt = c.time_of(sid, True)
                pts = c.seg_pts(sid, a)
                for k, q in enumerate(pts[1:], start=1):
                    u["keys"].append([round(t + dt * k / (len(pts) - 1), 1), *_latlon(c, *q)])
                t += dt
            arrive = t
            u["keys"].append([round(arrive + ON_SCENE_S[inc["level"]], 1), *_latlon(c, *c.pos[inc["node"]])])
            u["free_at"], u["at"], u["jobs"] = arrive + ON_SCENE_S[inc["level"]], inc["node"], u["jobs"] + 1
            note = f" The nearer {nearest_busy[1]['id']} is busy." if nearest_busy and nearest_busy[0] < eta else ""
            log.append({"t": inc["t"], "incident": inc["id"], "unit": u["id"], "eta_s": round(eta),
                        "text": f"{inc['id']} ({inc['level']}): {u['id']} from {u['base']}, {eta / 60:.1f} min by road.{note}"})
            served.append({"incident": inc["id"], "kind": kind, "unit": u["id"], "eta_s": round(eta), "arrive": round(arrive, 1)})
    amb = [x["eta_s"] for x in served if x["kind"] == "ambulance"]
    return {"window_s": WINDOW_S, "simulated": True, "attribution": c.attribution, "center": _latlon(c, 0, 0),
            "incidents": [{**{k: v for k, v in i.items() if k != "node"}, "lat": _latlon(c, *c.pos[i["node"]])[0], "lon": _latlon(c, *c.pos[i["node"]])[1]} for i in incidents],
            "places": [{"amenity": p["amenity"], "name": p["name"], "lat": p["lat"], "lon": p["lon"]} for p in c.raw["places"]],
            "units": [{"id": u["id"], "kind": u["kind"], "base": u["base"], "keys": u["keys"], "jobs": u["jobs"]} for u in units],
            "log": sorted(log, key=lambda x: x["t"]), "served": served,
            "kpi": {"incidents": len(incidents), "real": sum(i["real"] for i in incidents), "ambulance_eta_median_s": sorted(amb)[len(amb) // 2] if amb else None,
                    "ambulances": sum(u["kind"] == "ambulance" for u in units), "police": sum(u["kind"] == "police" for u in units)}}
