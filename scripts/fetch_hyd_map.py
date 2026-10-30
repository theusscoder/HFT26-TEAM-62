"""Download the real road network, buildings and signals for part of Hyderabad from OpenStreetMap (ODbL, (c) OSM contributors).

Run once: backend/.venv/Scripts/python scripts/fetch_hyd_map.py
Output: data/map/hyderabad.json (committed, so the demo needs no network)."""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BBOX = (17.425, 78.335, 17.458, 78.372)  # south, west, north, east: Gachibowli to HITEC City
OUT = Path(__file__).resolve().parents[1] / "data" / "map" / "hyderabad.json"
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
ROADS = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential"


def query() -> str:
    s, w, n, e = BBOX
    box = f"({s},{w},{n},{e})"
    return f"""[out:json][timeout:120];
(way["highway"~"^({ROADS})$"]{box};
 node["highway"="traffic_signals"]{box};
 way["building"]{box};
 node["amenity"~"^(police|hospital)$"]{box};
 way["amenity"~"^(police|hospital)$"]{box};);
out body geom;"""


def fetch() -> dict:
    data = urllib.parse.urlencode({"data": query()}).encode()
    for url in MIRRORS:
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "yatharth-hackathon-demo/0.1"})
            with urllib.request.urlopen(req, timeout=150) as r:
                return json.loads(r.read())
        except Exception as e:
            print("failed", url, str(e)[:100], file=sys.stderr)
            time.sleep(2)
    raise SystemExit("no Overpass mirror answered")


def main():
    raw = fetch()["elements"]
    roads, buildings, signals, places = [], [], [], []
    for el in raw:
        tags = el.get("tags", {})
        if el["type"] == "way" and "highway" in tags and el.get("geometry"):
            roads.append({"id": el["id"], "nodes": el["nodes"], "geom": [[round(p["lat"], 6), round(p["lon"], 6)] for p in el["geometry"]], "class": tags["highway"], "name": tags.get("name"),
                          "oneway": tags.get("oneway") in ("yes", "1", "true"), "lanes": tags.get("lanes")})
        elif el["type"] == "way" and "building" in tags and el.get("geometry"):
            levels = tags.get("building:levels")
            buildings.append({"geom": [[round(p["lat"], 6), round(p["lon"], 6)] for p in el["geometry"]], "levels": levels, "height": tags.get("height"), "name": tags.get("name")})
        elif el["type"] == "node" and tags.get("highway") == "traffic_signals":
            signals.append({"id": el["id"], "lat": el["lat"], "lon": el["lon"]})
        if tags.get("amenity") in ("police", "hospital"):
            lat = el.get("lat") or (el["geometry"][0]["lat"] if el.get("geometry") else None)
            lon = el.get("lon") or (el["geometry"][0]["lon"] if el.get("geometry") else None)
            if lat:
                places.append({"amenity": tags["amenity"], "name": tags.get("name") or tags["amenity"].title(), "lat": lat, "lon": lon})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"bbox": BBOX, "attribution": "(c) OpenStreetMap contributors, ODbL", "roads": roads, "buildings": buildings, "signals": signals, "places": places}, separators=(",", ":")), encoding="utf-8")
    print(f"roads {len(roads)}, buildings {len(buildings)}, signals {len(signals)}, places {len(places)}, {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
