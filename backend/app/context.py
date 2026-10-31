"""Facts about the crash's time and place: weather (Open-Meteo) and friction, sun and glare, the mapped speed limit
and the nearest police and hospitals (OpenStreetMap). Each comes from a named source or stays empty. A network
failure never turns into a made-up value, and fetched results are stored so the demo works offline."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .physics import MU_DRY, MU_WET

OPEN_METEO = "https://archive-api.open-meteo.com/v1/archive"
OVERPASS = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
TIMEOUT_S = 20
USER_AGENT = "yatharth-hackathon/0.1"
WET_MM = 0.1
GLARE_ELEVATION_DEG = 25.0
GLARE_HEADING_DEG = 30.0
DARK_ELEVATION_DEG = -6.0
SEARCH_M = 8000
CITY_KMH = 30.0


def _get_json(url: str, data: bytes | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.load(r)


def weather(lat: float, lon: float, when: datetime, fetch=_get_json) -> dict | None:
    day = when.date().isoformat()
    q = urllib.parse.urlencode({"latitude": lat, "longitude": lon, "start_date": day, "end_date": day, "hourly": "precipitation,visibility", "timezone": "UTC"})
    try:
        hourly = fetch(f"{OPEN_METEO}?{q}")["hourly"]
        rain = hourly["precipitation"][when.hour]
        vis = (hourly.get("visibility") or [None] * 24)[when.hour]
    except (OSError, KeyError, IndexError, TypeError, ValueError):
        return None
    if rain is None:
        return None
    wet = rain >= WET_MM
    return {"provider": "Open-Meteo historical archive", "time_utc": when.isoformat(), "precipitation_mm": rain, "visibility_m": vis,
            "road_state": "wet" if wet else "dry", "mu": MU_WET if wet else MU_DRY,
            "mu_basis": f"typical {'wet' if wet else 'dry'} asphalt, from {rain} mm of rain that hour"}


def sun_position(when: datetime, lat: float, lon: float) -> tuple[float, float]:
    """(elevation, azimuth clockwise from north) in degrees, by the NOAA solar equations."""
    when = when.astimezone(timezone.utc)
    hours = when.hour + when.minute / 60 + when.second / 3600
    gamma = 2 * math.pi / 365 * ((when - datetime(when.year, 1, 1, tzinfo=timezone.utc)).days + (hours - 12) / 24)
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma) - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma))
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma) - 0.006758 * math.cos(2 * gamma)
            + 0.000907 * math.sin(2 * gamma) - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))
    ha = math.radians((hours * 60 + eqtime + 4 * lon) / 4 - 180)
    phi = math.radians(lat)
    elevation = math.asin(max(-1.0, min(1.0, math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(ha))))
    azimuth = math.atan2(math.sin(ha), math.cos(ha) * math.sin(phi) - math.tan(decl) * math.cos(phi))
    return round(math.degrees(elevation), 2), round((math.degrees(azimuth) + 180) % 360, 2)


def sun_check(when: datetime, lat: float, lon: float, heading_deg: float | None = None) -> dict:
    elevation, azimuth = sun_position(when, lat, lon)
    dark = elevation < DARK_ELEVATION_DEG
    glare = None
    if heading_deg is not None:
        diff = abs((azimuth - heading_deg + 180) % 360 - 180)
        glare = 0.0 < elevation <= GLARE_ELEVATION_DEG and diff <= GLARE_HEADING_DEG
    note = ("The sun was below the horizon, so it was dark. Sun glare is ruled out." if dark
            else "The sun was low and near the direction of travel, which is consistent with glare." if glare
            else "The sun's position does not support glare along the direction of travel." if glare is False
            else "Direction of travel is unknown, so glare can't be tested.")
    return {"elevation_deg": elevation, "azimuth_deg": azimuth, "is_dark": dark, "glare_possible": glare, "note": note}


def _overpass(query: str, fetch=None) -> dict | None:
    data = urllib.parse.urlencode({"data": query}).encode()
    for url in OVERPASS:
        try:
            return fetch(url) if fetch else _get_json(url, data)
        except (OSError, ValueError):
            continue
    return None


def speed_limit(lat: float, lon: float, measured_kmh: float | None, fetch=None) -> dict | None:
    r = _overpass(f'[out:json][timeout:15];way(around:40,{lat},{lon})["highway"]["maxspeed"];out tags 5;', fetch)
    if r is None:
        return None
    limits = []
    for el in r.get("elements", []):
        raw = str(el.get("tags", {}).get("maxspeed", "")).strip()
        if raw.isdigit():
            limits.append(float(raw))
        elif raw.endswith("mph") and raw[:-3].strip().isdigit():
            limits.append(round(float(raw[:-3]) * 1.609))
    if not limits:
        return {"limit_kmh": None, "source": "OpenStreetMap (unofficial): no limit tagged nearby", "measured_kmh": measured_kmh}
    limit = min(limits)
    return {"limit_kmh": limit, "source": "OpenStreetMap maxspeed (unofficial; check the posted limit)", "measured_kmh": measured_kmh,
            "exceeds": measured_kmh > limit if measured_kmh is not None else None}


def _km(lat1, lon1, lat2, lon2) -> float:
    a = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(a[0] / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(a[1] / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def facilities_local(lat: float, lon: float) -> dict | None:
    """Nearest police and hospitals from the shipped OpenStreetMap extract, with drive times on its road network."""
    from . import intercept
    c = intercept.city()
    s, w, n, e = c.raw["bbox"]
    if not (s - 0.05 <= lat <= n + 0.05 and w - 0.05 <= lon <= e + 0.05):
        return None
    node = c.nearest(*c.xy(lat, lon))
    police, hospitals = [], []
    for p in c.raw["places"]:
        d = round(_km(lat, lon, p["lat"], p["lon"]), 1)
        dist, _ = c.dijkstra(c.nearest(*c.xy(p["lat"], p["lon"])), police=True, limit=1800)
        eta = dist.get(node)
        item = {"name": p["name"], "lat": p["lat"], "lon": p["lon"], "dist_km": d, "eta_min": round(eta / 60) if eta is not None else round(d / CITY_KMH * 60)}
        (police if p["amenity"] == "police" else hospitals).append(item if p["amenity"] == "police" else {**item, "trauma": True})
    police.sort(key=lambda x: x["eta_min"])
    hospitals.sort(key=lambda x: x["eta_min"])
    return {"source": "OpenStreetMap extract shipped with the app; drive times on its road network at emergency speed", "police": police[:6], "hospitals": hospitals[:8]}


def facilities(lat: float, lon: float, fetch=None) -> dict | None:
    """Nearest police and hospitals. Distances are straight-line, and the ETA assumes city speed; neither is a route."""
    q = f'[out:json][timeout:20];(nwr(around:{SEARCH_M},{lat},{lon})["amenity"="police"];nwr(around:{SEARCH_M},{lat},{lon})["amenity"="hospital"];);out center tags 60;'
    r = _overpass(q, fetch)
    if r is None:
        return facilities_local(lat, lon) if fetch is None else None
    police, hospitals = [], []
    for el in r.get("elements", []):
        la, lo = el.get("lat") or el.get("center", {}).get("lat"), el.get("lon") or el.get("center", {}).get("lon")
        tags = el.get("tags", {})
        if la is None or lo is None or not tags.get("name"):
            continue
        d = round(_km(lat, lon, la, lo), 1)
        item = {"name": tags["name"], "lat": la, "lon": lo, "dist_km": d, "eta_min": round(d / CITY_KMH * 60)}
        if tags.get("amenity") == "police":
            police.append(item)
        else:
            hospitals.append({**item, "trauma": tags.get("emergency") == "yes"})
    police.sort(key=lambda x: x["dist_km"])
    hospitals.sort(key=lambda x: x["dist_km"])
    return {"source": "OpenStreetMap via Overpass; straight-line distance", "police": police[:3], "hospitals": hospitals[:3]}
