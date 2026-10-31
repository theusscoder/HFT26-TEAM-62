"""Markers for the 3D city on the home page: every case (placed where it happened, or on a major road for clips filmed
elsewhere), coloured by kind (hit-and-run, pedestrian, two-wheeler, collision), plus hospitals and police stations."""
import json
import math
from pathlib import Path

from . import intercept, live, records

KIND_COLOUR = {"hit_and_run": "#ff2a2a", "pedestrian": "#f59e0b", "two_wheeler": "#a78bfa", "collision": "#38bdf8"}
SEV = {"L3": "critical", "L2": "high", "L1": "moderate", "L0": "moderate"}


def _j(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except ValueError:
        return default


def _kind(d: Path) -> str:
    purs = _j(d / "pursuit.json", {}) or {}
    if purs.get("status") == "departed":
        return "hit_and_run"
    ent = _j(d / "entities.json", {}) or {}
    ids = [ent.get("primary") or "", *ent.get("involved", [])]
    if any(str(i).startswith("person") for i in ids):
        return "pedestrian"
    if any(str(i).startswith(("motorcycle", "bicycle", "ego")) for i in ids):
        return "two_wheeler"
    return "collision"


def markers() -> dict:
    c = intercept.city()
    majors = sorted((n for n in c.pos if not c.near_edge(n)), key=lambda n: (c.pos[n][0], c.pos[n][1]))
    out, seen = [], {}
    for d in sorted(live.CASES.iterdir()):
        case = _j(d / "case.json")
        if not case or not (d / "analysis.json").exists() and d.name != "demo":
            continue
        if d.name in live.PLACES:
            lat, lon, _, place, real = live.PLACES[d.name]
        else:   # a deterministic spot on the road network, spread around the map
            h = int.from_bytes(d.name.encode()[:8].ljust(8, b"x"), "little")
            n = majors[h % len(majors)]
            lat, lon = n and (c.pos[n][1] / c.ky + c.lat0, c.pos[n][0] / c.kx + c.lon0)
            place, real = (case.get("location") or {}).get("name") or "Hyderabad", False
        k = (round(lat, 4), round(lon, 4))   # two cases on one spot: fan them out a little
        lat, lon = lat + 0.0006 * seen.get(k, 0), lon + 0.0006 * seen.get(k, 0)
        seen[k] = seen.get(k, 0) + 1
        sev = _j(d / "severity.json", {}) or {}
        an = _j(d / "analysis.json", {}) or {}
        ent = _j(d / "entities.json", {}) or {}
        kind = _kind(d)
        rec = records.load(d) or {}
        vis = _j(d / "vision.json", {}) or {}
        thumb = next((f["file"] for f in vis.get("frames", []) if f["name"] == "impact"), None)
        out.append({"id": d.name, "title": case.get("title", d.name), "place": place, "really_here": real, "lat": round(lat, 6), "lon": round(lon, 6),
                    "level": sev.get("level", "L1"), "label": sev.get("label"), "severity": SEV.get(sev.get("level", "L1"), "moderate"), "kind": kind,
                    "colour": KIND_COLOUR[kind], "contradictions": len(an.get("contradictions", [])), "camera": (case.get("camera") or {}).get("type", "cctv"),
                    "vehicles": len([n for n in (ent.get("names") or {}) if not n.startswith("person")]) or len(rec.get("vehicles", [])),
                    "involved": [(ent.get("names") or {}).get(i, i) for i in [ent.get("primary"), *ent.get("involved", [])] if i],
                    "thumb": thumb, "video": "annotated.mp4" if (d / "evidence" / "annotated.mp4").exists() else None,
                    "time": case.get("incident_time_utc"), "records": rec or None})
    places = [{"name": p["name"], "lat": p["lat"], "lon": p["lon"], "kind": p["amenity"]} for p in c.raw["places"]]
    return {"cases": out, "places": places, "kinds": KIND_COLOUR,
            "centre": [17.4395, 78.3560]}
