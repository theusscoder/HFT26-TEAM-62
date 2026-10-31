"""Read-only access to the MOCK TS State Police database in data/ts_police_db/ (built by
scripts/make_ts_police_db.py), plus the one thing we write: case links (vehicles flagged against a case).

All records are fictional. Toll passages are stored relative to meta.anchor and re-based to each case's
incident time with `rebase()`, so the analysis always has history before and a live feed after the incident."""
import csv
import copy
import json
import math
import os
import re
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "ts_police_db"
PLATE_RE = re.compile(r"^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$")


def _load(name: str):
    p = DB / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@lru_cache(maxsize=1)
def meta() -> dict:
    return _load("meta.json") or {"anchor": "2026-10-30T17:31:00+05:30", "incident_default": {"name": "Hyderabad (assumed)", "lat": 17.4401, "lon": 78.3489}, "pools": {}}


@lru_cache(maxsize=1)
def vehicles() -> dict[str, dict]:
    d = _load("vehicles.json") or {"vehicles": []}
    return {v["plate"]: v for v in d["vehicles"]}


@lru_cache(maxsize=1)
def tolls() -> list[dict]:
    p = DB / "toll_logs.csv"
    if not p.exists():
        return []
    with p.open(encoding="utf-8") as f:
        return [r | {"_t": datetime.fromisoformat(r["time"])} for r in csv.DictReader(f)]


def plazas() -> dict[str, dict]:
    return {t["id"]: t for t in (_load("toll_plazas.json") or [])}


def police_stations() -> list[dict]:
    return _load("police_stations.json") or []


def hospitals() -> list[dict]:
    return _load("hospitals.json") or []


def norm(plate: str | None) -> str:
    return re.sub(r"[^A-Z0-9?]", "", (plate or "").upper())


def demo_suspect_phone() -> str | None:
    """The demo phone stands in for a suspect's registered number (DEMO_SUSPECT_PHONE, else DEMO_PHONE).
    Set DEMO_SUSPECT_PHONE=off to keep the fictional numbers."""
    p = os.getenv("DEMO_SUSPECT_PHONE") or os.getenv("DEMO_PHONE")
    return None if not p or p.lower() == "off" else p


def _is_suspect_plate(plate: str) -> bool:
    return plate in meta().get("pools", {}).get("suspect", {}).values() or any(l["plate"] == plate and l["role"] == "suspect" for l in links())


def lookup(plate: str) -> dict | None:
    v = vehicles().get(norm(plate))
    phone = demo_suspect_phone()
    if v and phone and _is_suspect_plate(v["plate"]):
        v = copy.deepcopy(v)
        v["owner"]["fictional_phone"] = v["owner"]["phone"]
        v["owner"]["phone"] = phone
        v["owner"]["phone_note"] = "demo phone standing in for the registered number"
    return v


def match_partial(partial: str) -> list[dict]:
    """'TS07G?5521' -> every registered vehicle the partial read could be ('?' = unreadable character)."""
    rx = re.compile("^" + norm(partial).replace("?", ".") + "$")
    return [v for p, v in vehicles().items() if rx.match(p)]


def same_owner(plate: str) -> list[dict]:
    v = lookup(plate)
    if not v:
        return []
    oid = v["owner"]["id"]
    return [{"plate": o["plate"], "class": o["class"], "make_model": o["make_model"], "colour": o["colour"]}
            for o in vehicles().values() if o["owner"]["id"] == oid and o["plate"] != v["plate"]]


def registry_card(plate: str) -> dict | None:
    """Flat card in the shape alerts.REGISTRY uses (Golden hour screen)."""
    v = lookup(plate)
    if not v:
        return None
    return {"owner": v["owner"]["name"], "vehicle": f"{v['colour'].title()} {v['make_model']}", "rto": v["registration"]["rto"],
            "insurance": v["insurance"]["status"], "emergency_contact": v["emergency_contact"]["phone"],
            "registered_phone": v["owner"]["phone"], "source": "TS police DB (mock)",
            "telegram_chat_id": __import__("os").getenv("DEMO_CHAT_ID_1")}  # demo phone receives the owner alert


# ---------------- geography ----------------
def km(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    return 2 * r * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


ROAD_FACTOR = 1.3      # road distance ≈ 1.3 × straight-line distance in a city
CITY_KMH = 30          # for ETAs of responders


def nearest(items: list[dict], lat: float, lon: float, n: int = 3, where=lambda x: True) -> list[dict]:
    out = []
    for it in items:
        if not where(it):
            continue
        d = km(lat, lon, it["lat"], it["lon"]) * ROAD_FACTOR
        out.append(it | {"dist_km": round(d, 1), "eta_min": max(2, round(d / CITY_KMH * 60))})
    return sorted(out, key=lambda x: x["dist_km"])[:n]


# ---------------- time re-basing ----------------
def anchor() -> datetime:
    return datetime.fromisoformat(meta()["anchor"])


def rebase(t: datetime, incident: datetime) -> datetime:
    return t + (incident - anchor())


def passages(plate: str) -> list[dict]:
    p = norm(plate)
    return [r for r in tolls() if r["plate"] == p]


def toll_analysis(plate: str, incident: datetime, lat: float, lon: float, window_min: int = 120,
                  v_min: float = 12, v_max: float = 110) -> dict:
    """History before the incident (patterns) and passages after it (possible escape trail).
    A post-incident passage is 'reachable' when the average speed needed to get there from the incident site
    (straight line × road factor) lies in [v_min, v_max] km/h; otherwise it is flagged (misread or cloned plate)."""
    A = anchor()
    rows = passages(plate)
    before = [r for r in rows if r["_t"] < A]
    after = [r for r in rows if A <= r["_t"] <= A + timedelta(minutes=window_min)]
    pz = plazas()

    counts: dict[str, int] = {}
    hours = {"06-10": 0, "10-16": 0, "16-21": 0, "21-06": 0}
    days = set()
    for r in before:
        counts[r["plaza"]] = counts.get(r["plaza"], 0) + 1
        h = r["_t"].hour
        hours["06-10" if 6 <= h < 10 else "10-16" if 10 <= h < 16 else "16-21" if 16 <= h < 21 else "21-06"] += 1
        days.add(r["_t"].date())
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:4]
    last = before[-1] if before else None

    trail, prev = [], (A, lat, lon)
    for r in after:
        p = pz.get(r["plaza_id"], {})
        d_inc = km(lat, lon, p.get("lat", lat), p.get("lon", lon)) * ROAD_FACTOR
        mins = (r["_t"] - A).total_seconds() / 60
        need = d_inc / max(mins / 60, 1e-6)
        # consecutive-hop check catches a plate seen at two far-apart plazas minutes apart
        d_hop = km(prev[1], prev[2], p.get("lat", lat), p.get("lon", lon)) * ROAD_FACTOR
        hop_min = max((r["_t"] - prev[0]).total_seconds() / 60, 1e-6)
        hop_need = d_hop / (hop_min / 60)
        ok = v_min * 0.5 <= need <= v_max and hop_need <= v_max
        trail.append({"time": rebase(r["_t"], incident).isoformat(timespec="minutes"), "minutes_after": round(mins, 1),
                      "plaza": r["plaza"], "plaza_id": r["plaza_id"], "lat": p.get("lat"), "lon": p.get("lon"),
                      "direction": r["direction"], "fastag_id": r["fastag_id"], "dist_km": round(d_inc, 1),
                      "implied_kmh": round(need), "reachable": ok,
                      "note": "consistent with travel from the incident site" if ok else
                              f"needs {round(max(need, hop_need))} km/h: physically implausible, possible misread or cloned plate"})
        if ok:
            prev = (r["_t"], p.get("lat", lat), p.get("lon", lon))
    return {
        "plate": norm(plate), "rebased_to": incident.isoformat(timespec="minutes"),
        "history": {"passages_30d": len(before), "active_days": len(days), "top_plazas": [{"plaza": k, "count": c} for k, c in top],
                    "time_of_day": hours, "pattern": "regular commuter" if len(days) >= 15 else "occasional" if before else "no FASTag history",
                    "last_seen_before": {"plaza": last["plaza"], "time": rebase(last["_t"], incident).isoformat(timespec="minutes")} if last else None},
        "after": trail,
        "last_seen_after": next((t for t in reversed(trail) if t["reachable"]), None),
        "flagged": [t for t in trail if not t["reachable"]],
    }


def toll_funnel(plate: str, cls: str | None, colour: str | None, window_min: int = 120) -> list[dict]:
    """How the toll feed narrows to this vehicle: all passages in the window → class → colour → plate."""
    A = anchor()
    rows = [r for r in tolls() if A <= r["_t"] <= A + timedelta(minutes=window_min)]
    out = [{"stage": f"FASTag passages in {window_min} min after the incident", "count": len(rows)}]
    if cls:
        rows = [r for r in rows if r["vehicle_class"] == cls]
        out.append({"stage": f"class = {cls}", "count": len(rows)})
    if colour:
        rows = [r for r in rows if r["colour"] == colour]
        out.append({"stage": f"colour = {colour}", "count": len(rows)})
    rx = re.compile("^" + norm(plate).replace("?", ".") + "$")
    rows = [r for r in rows if rx.match(r["plate"])]
    out.append({"stage": f"plate matches {norm(plate)}", "count": len(rows)})
    return out


# ---------------- case links (the only writes) ----------------
LINKS = DB / "case_links.json"


def links() -> list[dict]:
    return json.loads(LINKS.read_text(encoding="utf-8")) if LINKS.exists() else []


def link_vehicle(case_id: str, plate: str, role: str, phone: str | None, station: str | None, summary: str) -> dict:
    """Push a case-linked vehicle into the TS police DB (mock): plate + registered number + role + station."""
    all_ = [l for l in links() if not (l["case_id"] == case_id and l["plate"] == norm(plate))]
    rec = {"case_id": case_id, "plate": norm(plate), "role": role, "registered_phone": phone, "assigned_station": station,
           "status": "Linked · awaiting officer verification", "summary": summary,
           "linked_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    all_.append(rec)
    LINKS.write_text(json.dumps(all_, indent=1))
    return rec


def update_link(case_id: str, plate: str, status: str | None = None, last_seen: dict | None = None):
    all_ = links()
    for l in all_:
        if l["case_id"] == case_id and l["plate"] == norm(plate):
            if status:
                l["status"] = status
            if last_seen:
                l["last_seen"] = {k: last_seen.get(k) for k in ("plaza", "time", "minutes_after", "lat", "lon")}
            l["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    LINKS.write_text(json.dumps(all_, indent=1))


def search(q: str = "", limit: int = 200) -> list[dict]:
    q = q.strip().upper()
    linked = {l["plate"]: l for l in links()}
    out = []
    for v in vehicles().values():
        v = lookup(v["plate"])
        hay = f"{v['plate']} {v['owner']['name']} {v['owner']['phone']} {v['make_model']} {v['colour']} {v['class']}".upper()
        if q and q.replace(" ", "") not in hay.replace(" ", ""):
            continue
        out.append({"plate": v["plate"], "class": v["class"], "make_model": v["make_model"], "colour": v["colour"],
                    "owner": v["owner"]["name"], "phone": v["owner"]["phone"], "rto": v["registration"]["rto"],
                    "insurance": v["insurance"]["status"], "flags": v["flags"],
                    "unpaid_challans": sum(c["status"] == "unpaid" for c in v["challans"]), "case_link": linked.get(v["plate"])})
    out.sort(key=lambda r: (r["case_link"] is None, not r["flags"], r["plate"]))
    return out[:limit]


def detail(plate: str) -> dict | None:
    v = lookup(plate)
    if not v:
        return None
    return v | {"same_owner": same_owner(plate),
                "toll_passages": [{k: r[k] for k in ("time", "plaza", "direction", "fastag_id")} for r in passages(plate)][-60:],
                "case_links": [l for l in links() if l["plate"] == v["plate"]]}
