"""Continuous tracking of a suspect vehicle after the alerts go out (A3 follow-up).

The live FASTag feed is the mock toll log after the incident, replayed on a compressed clock (`speed`, default 10x:
one real minute = ten minutes after the incident). When the recorded log runs out, the vehicle keeps being
"seen" by a SIMULATED feed along a plausible route (nearest unvisited plaza, 40-55 km/h), until an officer stops
tracking. Every new sighting:
  • alerts the jurisdiction police (position, speed, next likely plazas, map link; implausible ones as possible clone),
  • sends the suspect's registered number (the demo phone) a reminder to report,
  • updates the vehicle's status in the TS police DB and the custody ledger.
A single daemon thread drives every case; state lives in data/cases/<id>/tracking.json, so it survives restarts."""
import json
import os
import random
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import notify, ts_police_db as db
from .custody import Ledger

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
TICK_S = 2.0
_lock = threading.Lock()
_worker: threading.Thread | None = None


def _p(cid: str) -> Path:
    return DATA / cid / "tracking.json"


def load(cid: str) -> dict | None:
    p = _p(cid)
    for _ in range(5):  # tolerate a concurrent writer (writes are atomic, but be safe on Windows)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, PermissionError, OSError):
            time.sleep(0.05)
    return None


def _save(cid: str, st: dict):
    p = _p(cid)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=2, default=str), encoding="utf-8")
    for _ in range(5):
        try:
            os.replace(tmp, p)  # atomic swap: readers never see a half-written file
            return
        except PermissionError:
            time.sleep(0.05)


def _sim_min(st: dict, now: float | None = None) -> float:
    now = now or time.time()
    if not st["active"]:
        return st["sim_min"]
    return st["sim_min"] + (now - st["wall_at"]) * st["speed"] / 60


def start(cid: str, plate: str, incident: datetime, lat: float, lon: float, station: dict | None,
          speed: float | None = None, notify_suspect: bool = True, contact: str | None = None) -> dict:
    """(Re)start tracking a plate. Recorded post-incident passages are queued; nothing is released until its time."""
    with _lock:
        old = load(cid)
        if old and old["plate"] == db.norm(plate):
            old.update(active=True, wall_at=time.time(), speed=float(speed or old["speed"]))
            _save(cid, old)
            ensure_worker()
            return old
        ta = db.toll_analysis(plate, incident, lat, lon, window_min=24 * 60)
        st = {"plate": db.norm(plate), "active": True, "speed": float(speed or os.getenv("TRACKING_SPEED", 10)),
              "started_at": datetime.now().astimezone().isoformat(timespec="seconds"), "wall_at": time.time(), "sim_min": 0.0,
              "incident": incident.isoformat(), "origin": {"lat": lat, "lon": lon},
              "station": {k: station[k] for k in ("id", "name", "phone", "lat", "lon")} if station else None,
              "notify_suspect": notify_suspect, "contact": contact, "queue": ta["after"], "sightings": [], "alerts_sent": 0, "simulated_from": None,
              "seed": random.randint(1, 10**6)}
        _save(cid, st)
        Ledger(DATA / cid / "custody.jsonl").append("tracking_started", plate=st["plate"], speed=st["speed"])
    ensure_worker()
    return st


def stop(cid: str, officer: str = "Duty officer") -> dict | None:
    with _lock:
        st = load(cid)
        if not st:
            return None
        st["sim_min"], st["active"], st["stopped_by"] = _sim_min(st), False, officer
        _save(cid, st)
    Ledger(DATA / cid / "custody.jsonl").append("tracking_stopped", plate=st["plate"], by=officer)
    db.update_link(cid, st["plate"], status=f"Tracking stopped by {officer}")
    return st


def set_speed(cid: str, speed: float) -> dict | None:
    with _lock:
        st = load(cid)
        if not st:
            return None
        st["sim_min"], st["wall_at"], st["speed"] = _sim_min(st), time.time(), max(0.5, min(600.0, speed))
        _save(cid, st)
        return st


def _next_simulated(st: dict) -> dict | None:
    """One more sighting beyond the recorded log: nearest plaza not visited yet, from the last plausible position."""
    pz = db.plazas()
    seen = {s["plaza_id"] for s in st["sightings"]} | {q["plaza_id"] for q in st["queue"]}
    last = next((s for s in reversed(st["sightings"]) if s["reachable"]), None)
    lat, lon, t0 = (last["lat"], last["lon"], last["minutes_after"]) if last else (st["origin"]["lat"], st["origin"]["lon"], 0.0)
    options = sorted((db.km(lat, lon, p["lat"], p["lon"]), p) for p in pz.values() if p["id"] not in seen)
    if not options:
        return None
    d, p = options[0]
    rnd = random.Random(st["seed"] + len(st["sightings"]))
    mins = t0 + max(6.0, d * db.ROAD_FACTOR / rnd.uniform(40, 55) * 60)
    when = datetime.fromisoformat(st["incident"]) + timedelta(minutes=mins)
    inc_d = db.km(st["origin"]["lat"], st["origin"]["lon"], p["lat"], p["lon"]) * db.ROAD_FACTOR
    return {"time": when.isoformat(timespec="minutes"), "minutes_after": round(mins, 1), "plaza": p["name"], "plaza_id": p["id"],
            "lat": p["lat"], "lon": p["lon"], "direction": rnd.choice(["inbound", "outbound"]), "fastag_id": "",
            "dist_km": round(inc_d, 1), "implied_kmh": round(d * db.ROAD_FACTOR / max((mins - t0) / 60, 1e-6)), "reachable": True,
            "note": "simulated live feed (beyond the recorded mock log)", "simulated": True}


def predict(st: dict, n: int = 2) -> list[dict]:
    """Next likely plazas from the last plausible sighting, with ETA ranges at 30-70 km/h."""
    last = next((s for s in reversed(st["sightings"]) if s["reachable"]), None)
    lat, lon = (last["lat"], last["lon"]) if last else (st["origin"]["lat"], st["origin"]["lon"])
    seen = {s["plaza_id"] for s in st["sightings"]}
    out = []
    for d, p in sorted((db.km(lat, lon, p["lat"], p["lon"]), p) for p in db.plazas().values() if p["id"] not in seen)[:n]:
        road = d * db.ROAD_FACTOR
        out.append({"plaza": p["name"], "lat": p["lat"], "lon": p["lon"], "dist_km": round(road, 1),
                    "eta_min": [round(road / 70 * 60), round(road / 30 * 60)]})
    return out


def _alert(cid: str, st: dict, s: dict, n: int):
    plate, station = st["plate"], st["station"]
    rec = db.lookup(plate)
    nxt = predict(st)
    nxt_line = "; ".join(f"{x['plaza']} in {x['eta_min'][0]}-{x['eta_min'][1]} min" for x in nxt) or "n/a"
    t = s["time"][11:16]
    if s["reachable"]:
        title = f"📍 TRACKING #{n} · {plate} at {s['plaza']}"
        text = (f"Suspect vehicle {plate} ({rec['colour'] + ' ' + rec['make_model'] if rec else ''}) recorded at {s['plaza']} at {t} "
                f"(+{s['minutes_after']} min after the incident), {s['direction']}, ~{s['implied_kmh']} km/h average.\n"
                f"Next likely: {nxt_line}.\nhttps://maps.google.com/?q={s['lat']},{s['lon']}\n"
                f"{'Source: simulated live feed.' if s.get('simulated') else 'Source: FASTag toll log.'} Ref YATHARTH case {cid}.")
    else:
        title = f"⚠️ TRACKING #{n} · possible CLONED plate {plate}"
        text = (f"{plate} was also recorded at {s['plaza']} at {t}, {s['dist_km']} km from the incident site: that needs "
                f"~{s['implied_kmh']} km/h, physically implausible. Treat as a misread or a cloned plate; stop and check that vehicle. Ref {cid}.")
    if station:
        r = notify.send("police", station["name"], station["phone"], title, text)
        st["alerts_sent"] += 1
        s["police_alert"] = r["status"]
    contact = st.get("contact") or (rec["owner"]["phone"] if rec else None)
    if st.get("notify_suspect") and contact and s["reachable"]:
        r = notify.send("suspect", f"Vehicle of interest · registered contact of {plate}", contact,
                        f"⚠️ [YATHARTH DEMO] Vehicle {plate} is being tracked",
                        f"Your vehicle {plate} was recorded at {s['plaza']} at {t}. It is linked to a road accident case ({cid}) and is under "
                        f"continuous tracking. Stop the vehicle safely and report to {station['name'] if station else 'the nearest police station'}"
                        f"{' (' + station['phone'] + ')' if station else ''} now.", real=True, allow_sms=False)
        st["alerts_sent"] += 1
        s["suspect_alert"] = r["status"]
    Ledger(DATA / cid / "custody.jsonl").append("tracking_sighting", plate=plate, plaza=s["plaza"], minutes_after=s["minutes_after"],
                                               reachable=s["reachable"], simulated=bool(s.get("simulated")))
    if s["reachable"]:
        db.update_link(cid, plate, status=f"Under tracking · last seen {s['plaza']} {t}", last_seen=s)


def tick(cid: str) -> int:
    """Release every queued sighting whose time has come. Returns how many were released."""
    released = []
    with _lock:
        st = load(cid)
        if not st or not st["active"]:
            return 0
        now_min = _sim_min(st)
        if not st["queue"]:
            nxt = _next_simulated(st)
            if nxt:
                st["queue"].append(nxt)
                st["simulated_from"] = st["simulated_from"] or nxt["minutes_after"]
        while st["queue"] and st["queue"][0]["minutes_after"] <= now_min:
            s = st["queue"].pop(0)
            s["released_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
            st["sightings"].append(s)
            released.append(s)
        _save(cid, st)
    for s in released:  # network calls outside the lock
        with _lock:
            st = load(cid)
            n = len([x for x in st["sightings"] if x is not None])
            idx = next(i for i, x in enumerate(st["sightings"]) if x["minutes_after"] == s["minutes_after"] and x["plaza_id"] == s["plaza_id"])
        _alert(cid, st, st["sightings"][idx], idx + 1)
        with _lock:
            cur = load(cid)
            cur["sightings"][idx] = st["sightings"][idx]
            cur["alerts_sent"] = st["alerts_sent"]
            _save(cid, cur)
    return len(released)


def status(cid: str) -> dict | None:
    st = load(cid)
    if not st:
        return None
    now = _sim_min(st)
    last = next((s for s in reversed(st["sightings"]) if s["reachable"]), None)
    since = now - (last["minutes_after"] if last else 0)
    nxt = st["queue"][0] if st["queue"] else None
    return {k: st[k] for k in ("plate", "active", "speed", "started_at", "station", "notify_suspect", "sightings", "alerts_sent", "incident", "origin")} | {
        "sim_minutes": round(now, 1), "sim_clock": (datetime.fromisoformat(st["incident"]) + timedelta(minutes=now)).isoformat(timespec="minutes"),
        "last_seen": last, "minutes_since_last": round(since, 1),
        # where it could be now: up to 70 km/h since the last sighting
        "search_radius_km": round(min(since, 120) / 60 * 70, 1),
        "next_due_in_real_s": round(max(0, (nxt["minutes_after"] - now) * 60 / st["speed"])) if nxt and st["active"] else None,
        "predicted": predict(st), "recorded_left": sum(1 for q in st["queue"] if not q.get("simulated")),
        "feed": "simulated live feed" if st.get("simulated_from") is not None and now >= st["simulated_from"] else "FASTag toll log (mock)",
    }


def _loop():
    while True:
        try:
            for d in DATA.iterdir():
                p = d / "tracking.json"
                if p.exists():
                    try:
                        if json.loads(p.read_text(encoding="utf-8")).get("active"):
                            tick(d.name)
                    except Exception:
                        pass
        except Exception:
            pass
        time.sleep(TICK_S)


def ensure_worker():
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_loop, name="yatharth-tracking", daemon=True)
        _worker.start()
