"""Where an incident happened, logged from the evidence so nobody has to type it. In order of trust: the case this one is
linked to, the registered position of the camera (data/cameras.json, matched by camera id or by the feed's file), GPS in
the video's own metadata, GPS in the telematics log. With none of those, the location is an estimate on the road network
and says so: every location carries its method and source, and the first one is written to the custody ledger."""
import csv
import hashlib
import json
import math
import re
import subprocess
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from .custody import Ledger

ROOT = Path(__file__).resolve().parents[2]
CAMS = ROOT / "data" / "cameras.json"
ROADS = ROOT / "data" / "map" / "hyderabad.json"
SIM_GPS = (17.4401, 78.3489)   # the constant the telematics simulator writes: not a reading
ISO6709 = re.compile(r"([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)")
GPS_TAGS = ("com.apple.quicktime.location.ISO6709", "location", "location-eng")
ROAD_NEAR_M = 400


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _registry() -> dict:
    try:
        return json.loads(CAMS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


@lru_cache(maxsize=64)
def _sha(path: str, _mtime: float) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_sha(p: Path) -> str | None:
    try:
        return _sha(str(p), p.stat().st_mtime)
    except OSError:
        return None


def from_camera(cam: dict) -> dict:
    return {"name": f"{cam['name']}, Hyderabad", "lat": cam["lat"], "lon": cam["lon"], "method": "camera_registry", "camera": cam["id"],
            "source": f"registered position of camera {cam['id']}", "logged_at": _now()}


def matching_camera(case_id: str, src: Path | None, camera_id: str | None = None) -> dict | None:
    """The registered camera behind this case: by id, by the case it covers, or because the clip is that camera's feed."""
    reg = _registry()
    feeds, sites = reg.get("cameras", []), reg.get("sites", [])
    for c in feeds + sites:
        if c["id"] == camera_id or c.get("case") == case_id:
            return c
    digest = _file_sha(src) if src else None
    if digest:
        for c in feeds:
            feed = ROOT / str(c.get("source", ""))
            if feed.is_file() and _file_sha(feed) == digest:
                return c
    return None


def _probe(src: Path | None) -> dict:
    """The video's metadata tags; empty if it has none or ffprobe isn't installed."""
    if not src or not Path(src).is_file():
        return {}
    try:
        r = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format_tags", "-of", "json", str(src)], capture_output=True, text=True, timeout=20)
        return (json.loads(r.stdout or "{}").get("format") or {}).get("tags") or {}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def video_gps(tags: dict) -> tuple[float, float] | None:
    for k in GPS_TAGS:
        m = ISO6709.match(str(tags.get(k, "")))
        if m:
            lat, lon = float(m[1]), float(m[2])
            if abs(lat) <= 90 and abs(lon) <= 180 and (lat, lon) != (0.0, 0.0):
                return lat, lon
    return None


def telematics_gps(path: Path) -> tuple[float, float] | None:
    """The vehicle's position at the hardest jolt in its log."""
    try:
        with open(path, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f) if r.get("lat") and r.get("lon")]
        best = max(rows, key=lambda r: abs(float(r.get("accel_g") or 0)))
        lat, lon = float(best["lat"]), float(best["lon"])
    except (OSError, ValueError):   # no log, no GPS column, or an empty one
        return None
    if math.isclose(lat, SIM_GPS[0], abs_tol=1e-4) and math.isclose(lon, SIM_GPS[1], abs_tol=1e-4):
        return None
    return lat, lon


@lru_cache(maxsize=1)
def _named_roads() -> tuple:
    try:
        roads = json.loads(ROADS.read_text(encoding="utf-8")).get("roads", [])
    except (OSError, ValueError):
        return ()
    return tuple((r["name"], tuple(map(tuple, r["geom"]))) for r in roads if r.get("name") and r.get("geom"))


def _metres(a: tuple, b: tuple) -> float:
    return math.hypot((a[0] - b[0]) * 111_000, (a[1] - b[1]) * 111_000 * math.cos(math.radians(a[0])))


def road_name(lat: float, lon: float) -> str | None:
    best, near = None, ROAD_NEAR_M
    for name, geom in _named_roads():
        d = min(_metres((lat, lon), p) for p in geom)
        if d < near:
            best, near = name, d
    return best


def _at(lat: float, lon: float, method: str, source: str) -> dict:
    road = road_name(lat, lon)
    return {"name": f"{road}, Hyderabad" if road else f"{lat:.4f}, {lon:.4f}", "lat": lat, "lon": lon, "method": method, "source": source, "logged_at": _now()}


def _estimate(case_id: str, src: Path | None, label: str | None) -> dict:
    roads = _named_roads()
    source = "no registered camera or GPS in this clip; estimated from the road network"
    if not roads:
        return {"name": label or "Hyderabad", "lat": SIM_GPS[0], "lon": SIM_GPS[1], "method": "estimated", "estimated": True, "source": source, "logged_at": _now()}
    seed = _file_sha(src) if src else None
    name, geom = roads[int(hashlib.sha256((seed or case_id).encode()).hexdigest()[:8], 16) % len(roads)]
    lat, lon = geom[len(geom) // 2]
    return {"name": label or f"Near {name}, Hyderabad", "lat": lat, "lon": lon, "method": "estimated", "estimated": True, "source": source, "logged_at": _now()}


def resolve(case_id: str, d: Path, src: Path | None, prev: dict | None = None, label: str | None = None, hint: dict | None = None) -> tuple[dict, bool]:
    """(location, newly logged). A location already on the case stays where it is; only its source gets filled in."""
    prev = prev or {}
    if prev.get("lat") is not None:
        if prev.get("source"):
            return prev, False
        cam = matching_camera(case_id, None)
        tag = {"method": "camera_registry", "camera": cam["id"], "source": f"registered position of camera {cam['id']}"} if cam else {"method": "case_record", "source": "the case record"}
        return {**prev, **tag}, False
    parent = (hint or {}).get("location") or {}
    if parent.get("lat") is not None:
        return {**parent, "method": "linked_case", "source": "same incident as the linked case", "logged_at": _now()}, True
    cam = matching_camera(case_id, src)
    if cam:
        return from_camera(cam), True
    gps = video_gps(_probe(src))
    if gps:
        return _at(*gps, "video_gps", "GPS in the video's metadata"), True
    gps = telematics_gps(d / "evidence" / "sensor.csv")
    if gps:
        return _at(*gps, "telematics_gps", "GPS in the telematics log, at the impact"), True
    return _estimate(case_id, src, label), True


def _video_time(src: Path | None) -> str | None:
    raw = _probe(src).get("creation_time")
    try:
        t = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t.isoformat() if t.year >= 2000 and t.tzinfo else None


def record(d: Path, case: dict, src: Path | None) -> None:
    """Log a newly found location, and what it unlocks: the time if the case has none, the weather, the nearest responders."""
    from . import context
    loc = case["location"]
    Ledger(d / "custody.jsonl").append("location_logged", place=loc["name"], lat=loc["lat"], lon=loc["lon"], method=loc["method"], basis=loc["source"])
    if not case.get("incident_time_utc"):
        found = _video_time(src)
        case["incident_time_utc"] = found or datetime.now(timezone.utc).isoformat()
        case["incident_time_source"] = "video metadata" if found else "the time the footage arrived"
    try:
        if "weather" not in case:
            w = context.weather(loc["lat"], loc["lon"], datetime.fromisoformat(case["incident_time_utc"]))
            if w:
                case["weather"] = w
        if not (d / "facilities.json").exists():
            fac = context.facilities_local(loc["lat"], loc["lon"])
            if fac:
                (d / "facilities.json").write_text(json.dumps(fac, indent=2))
    except Exception:   # a lookup failing must never stop the case
        pass
