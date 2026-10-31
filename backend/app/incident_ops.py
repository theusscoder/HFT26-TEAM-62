"""One incident at a time, as it unfolds: the vehicles meet, the vision model names who was hit, the records agent pulls the
plate, registration and licence, hospitals are told (they light up), police head in (they light up), an ambulance routes to
the victim, and, if the other vehicle fled, the intercept agent holds signals and closes in until it's caught.

Real: the road network, hospitals, police stations, each case's footage and analysis, and whether a vehicle left the scene
(the case's hit-and-run check). Drawn for the operation: the approach paths into the crash. Simulated: signals, units, the
chase. Fictional: the people (data/fictional/live_identities.json)."""
import math
import random
from functools import lru_cache

from . import intercept, live

T_CRASH, T_VICTIM, T_PLATE, T_LICENCE, T_NOTIFY = 15.0, 19.0, 23.0, 27.0, 31.0
APPROACH_KMH = 38.0
NOTIFY_RADIUS_M = 2500.0


def _ll(c, x, y):
    return [round(y / c.ky + c.lat0, 6), round(x / c.kx + c.lon0, 6)]


def _keys_from_path(c, path, t0, speed_kmh=None):
    """[(t, lat, lon)] along a node path starting at time t0."""
    keys, t = [], t0
    for a, sid, b in path:
        dt = c.segs[sid]["len"] / (speed_kmh / 3.6) if speed_kmh else c.time_of(sid, True)
        pts = c.seg_pts(sid, a)
        if not keys:
            keys.append([round(t, 2), *_ll(c, *pts[0])])
        for k, q in enumerate(pts[1:], start=1):
            keys.append([round(t + dt * k / (len(pts) - 1), 2), *_ll(c, *q)])
        t += dt
    return keys, t


def _approaches(c, node, rng, n=2):
    """Roads into the crash from different directions, a few hundred metres out."""
    x0, y0 = c.pos[node]
    for lo, hi, edge in ((250, 600, True), (120, 900, False)):
        cands = [m for m in c.pos if lo < math.dist(c.pos[m], (x0, y0)) < hi and not (edge and c.near_edge(m))]
        rng.shuffle(cands)
        picked = []
        for m in cands[:80]:
            dist, prev = c.dijkstra(m, limit=300)
            if node not in dist:
                continue
            b = math.atan2(c.pos[m][0] - x0, c.pos[m][1] - y0)
            if all(abs((b - pb + math.pi) % (2 * math.pi) - math.pi) > math.radians(70) for pb, _ in picked):
                picked.append((b, c.path(prev, m, node)))
            if len(picked) == n:
                return [p for _, p in picked]
    return [p for _, p in picked]


def _route_in(c, places, node, t0, limit=1200):
    """Each place's road route to the crash node, nearest first: (place, eta_s, keys, arrive)."""
    out = []
    for p in places:
        src = c.nearest(*c.xy(p["lat"], p["lon"]))
        dist, prev = c.dijkstra(src, police=True, limit=limit)
        if node in dist:
            keys, arrive = _keys_from_path(c, c.path(prev, src, node), t0)
            out.append((p, dist[node], keys, arrive))
    return sorted(out, key=lambda r: r[1])


def _clip(s):
    return s if len(s) < 60 else s[:57] + "…"


@lru_cache(maxsize=1)
def scenarios() -> tuple:
    c = intercept.city()
    feed = live.run()
    hosp = [p for p in c.raw["places"] if p["amenity"] == "hospital"]
    stations = [p for p in c.raw["places"] if p["amenity"] == "police"]
    out = []
    for i, inc in enumerate(feed["incidents"]):
        card = feed["cards"][inc["id"]]
        purs = live._j(live.CASES / inc["id"] / "pursuit.json", {}) or {}
        fled = purs.get("status") == "departed"
        idn = card.get("identity") or {}
        rng = random.Random(100 + i)
        node = c.nearest(*c.xy(inc["lat"], inc["lon"]), major=True)
        cx, cy = c.pos[node]
        crash = _ll(c, cx, cy)
        roads = _approaches(c, node, rng)
        vehicles = []
        for role, path in zip(("victim", "other"), roads):
            k, t_end = _keys_from_path(c, path, 0.0, APPROACH_KMH)
            shift = T_CRASH - t_end
            k = [[round(a + shift, 2), la, lo] for a, la, lo in k if a + shift >= 0] or [[0.0, *crash]]
            vehicles.append({"role": role, "keys": k + [[T_CRASH, *crash]]})
        log = [{"t": T_CRASH, "agent": "Vision", "text": f"Collision detected on camera at {card['place']} ({card['level']})."},
               {"t": T_VICTIM, "agent": "Vision", "text": f"Victim: {idn.get('victim') or 'not judged'}."}]

        flee, sus = None, idn.get("suspect")
        if fled and len(roads) > 1:
            last = roads[1][-1]
            heading = math.atan2(c.pos[last[2]][0] - c.pos[last[0]][0], c.pos[last[2]][1] - c.pos[last[0]][1])
            sim = intercept.simulate((cx, cy), heading, 3 + i, defy=True)
            off = T_CRASH
            L = lambda k: [round(k["t"] + off, 2), *_ll(c, k["x"], k["y"])]
            flee = {"keys": [L(k) for k in sim["suspect"]],
                    "units": [{"id": u["id"], "name": u["name"], "role": u["role"], "keys": [L(k) for k in u["keys"]]} for u in sim["units"] if u["goal"] is not None],
                    "signals": [{"at": _ll(c, s["x"], s["y"]), "from": round(s["from"] + off, 1), "to": round(s["to"] + off, 1)} for s in sim["signals"]],
                    "outcome": {"result": sim["outcome"]["result"], "t": round(sim["outcome"]["t"] + off, 1), "at": _ll(c, sim["outcome"]["x"], sim["outcome"]["y"])},
                    "suspect": sus}
            log.append({"t": T_CRASH + 2, "agent": "Tracker", "text": f"{(sus or {}).get('vehicle', 'The other vehicle')} did not stop. Tracking it camera to camera."})
            log += [{"t": round(x["t"] + off, 1), "agent": x.get("agent") or "Planner", "text": x["text"]} for x in sim["decisions"]]

        told = [p for p in hosp if math.dist(c.xy(p["lat"], p["lon"]), (cx, cy)) < NOTIFY_RADIUS_M] or hosp[:3]
        amb = _route_in(c, told, node, T_NOTIFY)
        best = amb[0] if amb else None
        cops = _route_in(c, stations, node, T_NOTIFY + 2)[:2]
        police = [{"name": p["name"], "lat": p["lat"], "lon": p["lon"], "keys": k, "arrive": round(a, 1), "eta_s": round(e)} for p, e, k, a in cops]

        if idn.get("plate"):
            log.append({"t": T_PLATE, "agent": "Records", "text": f"Plate {idn['plate']}: {idn['registration']['owner']}, {idn['registration']['vehicle']}, insurance: {idn['registration']['insurance']}."})
        if idn.get("licence"):
            log.append({"t": T_LICENCE, "agent": "Records", "text": f"Face matched to licence {idn['licence']['dl_no']} ({idn['licence']['holder']}, {round(idn.get('face_match', 0) * 100)}%)."})
        if idn.get("registration"):
            log.append({"t": T_NOTIFY, "agent": "Alerts", "text": f"Emergency contact {idn['registration']['emergency_contact']} informed on Telegram."})
        log.append({"t": T_NOTIFY, "agent": "Dispatch", "text": f"{len(told)} hospitals alerted. Ambulance from {best[0]['name']}, {best[1] / 60:.1f} min by road." if best else "No hospital reachable by road."})
        for pc in police:
            log.append({"t": T_NOTIFY + 2, "agent": "Dispatch", "text": f"Patrol from {pc['name']} heading in, {pc['eta_s'] / 60:.1f} min."})
        if best:
            log.append({"t": round(best[3], 1), "agent": "Dispatch", "text": f"Ambulance on scene with the victim."})

        phases = [{"t": 0, "key": "approach", "label": "Vehicles approaching", "detail": card["place"]},
                  {"t": T_CRASH, "key": "crash", "label": "Collision detected", "detail": f"{card['level']} · {card.get('label') or ''}"},
                  {"t": T_VICTIM, "key": "victim", "label": "Victim identified", "detail": idn.get("victim") or "—"},
                  {"t": T_PLATE, "key": "plate", "label": "Plate → registration", "detail": f"{idn['plate']} · {idn['registration']['owner']}" if idn.get("plate") else "On foot: no vehicle"},
                  {"t": T_LICENCE, "key": "licence", "label": "Face → driving licence", "detail": idn["licence"]["holder"] if idn.get("licence") else "—"},
                  {"t": T_NOTIFY, "key": "notify", "label": "Hospitals and police alerted", "detail": f"{len(told)} hospitals · {len(police)} patrols"}]
        if flee:
            phases.append({"t": T_CRASH + 2, "key": "flee", "label": "Hit-and-run in progress", "detail": f"{(sus or {}).get('vehicle', 'Vehicle')} fleeing · {(sus or {}).get('plate', 'plate unread')}"})
            caught = flee["outcome"]["result"] == "contained"
            phases.append({"t": flee["outcome"]["t"], "key": "caught", "label": "Suspect stopped" if caught else "Suspect cornered", "detail": f"{(sus or {}).get('resolved', '')} · {flee['outcome']['t'] - T_CRASH:.0f} s after the crash"})
            log.append({"t": flee["outcome"]["t"], "agent": "Dispatch", "text": f"{'Stopped' if caught else 'Cornered'}: {(sus or {}).get('resolved') or 'the suspect vehicle'}."})
        if best:
            phases.append({"t": round(best[3], 1), "key": "ambulance", "label": "Ambulance with the victim", "detail": f"{(best[3] - T_NOTIFY) / 60:.1f} min after the alert"})
        phases.sort(key=lambda p: p["t"])
        log.sort(key=lambda r: r["t"])
        end = max([p["t"] for p in phases] + [T_NOTIFY + 30]) + 8
        out.append({"id": inc["id"], "card": card, "crash": crash, "fled": fled, "vehicles": vehicles, "flee": flee, "end": round(end, 1),
                    "ambulance": {"from": best[0]["name"], "keys": best[2], "arrive": round(best[3], 1), "eta_s": round(best[1])} if best else None,
                    "hospitals": [{"name": p["name"], "lat": p["lat"], "lon": p["lon"], "sending": bool(best) and p is best[0]} for p in told],
                    "police": police, "stations": [{"name": p["name"], "lat": p["lat"], "lon": p["lon"]} for p in stations],
                    "phases": phases, "log": [{**r, "text": r["text"]} for r in log]})
    return tuple(out)


def run() -> dict:
    sc = list(scenarios())
    return {"scenarios": sc, "center": sc[0]["crash"] if sc else [17.4401, 78.3489]}
