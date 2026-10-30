"""Generates the mock demo case (data/cases/demo/) so the frontend can be built before the pipeline
exists. OWNER: P4 replaces numbers/text with the real scenario; P1/P2 replace files with real output.

Scenario: junction near Gachibowli. Car A (white hatchback, TS09EA1234) hits pedestrian ped_1 at a
zebra crossing at T0. Car B (red sedan, TS07GK5521) clips car A's rear and flees north.
Planted contradictions: signal colour (W2), car A speed (W1), ped presence order (W3), car B stopped (W2).
Run: python data/make_demo.py"""
import json
import math
from pathlib import Path

D = Path(__file__).parent / "cases" / "demo"
EV = D / "evidence"
EV.mkdir(parents=True, exist_ok=True)


def dump(name, obj):
    (D / f"{name}.json").write_text(json.dumps(obj, indent=2), encoding="utf-8")


WITNESSES = {
    "witness_1": ("Ravi K., tea stall, NE corner, ~15 m",
                  "I was at my stall. The white car was going slowly, maybe 30. The lady had already "
                  "started crossing when the car came. Then the crash, and a red car hit the white car "
                  "from behind and drove off towards the flyover."),
    "witness_2": ("S. Fatima, bus stop, opposite side, ~30 m",
                  "The signal was red for the white car, I am sure. The red car stopped after the "
                  "accident for some time and then left."),
    "witness_3": ("Auto driver, waiting at signal, ~10 m",
                  "I think the car hit her first and then she was on the road. She came from the left "
                  "side suddenly. The white car was fast, around 60."),
}
for k, (_, text) in WITNESSES.items():
    (EV / f"{k}.txt").write_text(text, encoding="utf-8")

# Sensor log for car A: cruising ~62 km/h, brake at -0.9 s, impact at 0.
rows = ["t,speed_kmh,accel_g,brake,indicator,airbag,lat,lon"]
for i in range(-50, 31):
    t = i / 10
    if t < -0.9: v, g, b = 62, 0.0, 0
    elif t < 0: v, g, b = 62 - (t + 0.9) * 26, -0.75, 1
    elif t < 0.1: v, g, b = 38, -7.9, 1
    else: v, g, b = max(0, 38 - (t - 0.1) * 40), -1.1 if t < 1.0 else 0.0, 1
    rows.append(f"{t:.1f},{v:.1f},{g},{b},0,{1 if 0 <= t < 0.3 else 0},17.4401,78.3489")
(EV / "sensor.csv").write_text("\n".join(rows), encoding="utf-8")

dump("case", {"id": "demo", "title": "Gachibowli junction collision", "created": "2026-10-30T14:02:00+05:30",
              "location": {"name": "Gachibowli X-roads, Hyderabad", "lat": 17.4401, "lon": 78.3489},
              "evidence": [
                  {"id": "cctv", "type": "video", "file": "cctv.mp4", "label": "Junction CCTV (fixed)", "fps": 30},
                  {"id": "dashcam", "type": "video", "file": "dashcam.mp4", "label": "Car A dashcam", "fps": 30},
                  {"id": "sensor", "type": "sensor", "file": "sensor.csv", "label": "Car A telematics"},
                  *[{"id": k, "type": "witness", "file": f"{k}.txt", "label": v[0]} for k, v in WITNESSES.items()]],
              "simulated": True})


def ev(i, source, kind, t0, t1, actor, action, value=None, conf=0.9, ref="", sigma=0.1, quote=None, xy=None, **kw):
    return {"id": i, "source": source, "kind": kind, "t": {"start": t0, "end": t1, "sigma": sigma},
            "actor": actor, "action": action, "value": value, "xy": xy, "confidence": conf,
            "ref": ref, "quote": quote, "derived_from": kw.get("derived_from", []), "rule": kw.get("rule")}


events = [
    ev("EV-V-001", "cctv", "OBSERVED", -4.2, -4.2, "car_A", "enter", "from south", .93, "cctv.mp4#f=24"),
    ev("EV-V-002", "cctv", "OBSERVED", -4.0, 0.0, "signal_main", "signal", "green", .88, "cctv.mp4#f=30-150", rule="HSV+VLM"),
    ev("EV-V-003", "cctv", "OBSERVED", -1.6, -1.6, "ped_1", "cross", "enters zebra from west", .81, "cctv.mp4#f=102"),
    ev("EV-V-004", "cctv", "OBSERVED", -0.9, -0.9, "car_A", "brake", "brake lights on", .84, "cctv.mp4#f=123"),
    ev("EV-V-005", "cctv", "OBSERVED", 0.0, 0.0, "car_A", "impact", "with ped_1", .9, "cctv.mp4#f=150"),
    ev("EV-V-006", "cctv", "OBSERVED", 1.2, 1.2, "car_B", "impact", "rear of car_A", .77, "cctv.mp4#f=186"),
    ev("EV-V-007", "cctv", "OBSERVED", 1.8, 4.5, "car_B", "exit", "north, not stopping", .86, "cctv.mp4#f=204-285"),
    ev("EV-V-008", "cctv", "OBSERVED", 0.5, 9.5, "ped_1", "stop", "on road, no movement", .8, "cctv.mp4#f=165-435"),
    ev("EV-S-000", "sensor", "OBSERVED", -0.9, -0.9, "car_A", "brake", "-0.75 g", .95, "sensor.csv#r=43", sigma=.05, rule="R_brake_0.4g"),
    ev("EV-S-001", "sensor", "OBSERVED", -5.0, -0.9, "car_A", "speed", "62 km/h", .97, "sensor.csv#r=2-42", sigma=.05),
    ev("EV-S-002", "sensor", "OBSERVED", 0.0, 0.0, "car_A", "impact", "-7.9 g", .97, "sensor.csv#r=52", sigma=.05, rule="R_peak_accel"),
    ev("EV-W-001", "witness_1", "CLAIMED", -6, 0, "car_A", "speed", "~30 km/h", .45, "witness_1.txt", quote="going slowly, maybe 30"),
    ev("EV-W-002", "witness_1", "CLAIMED", -3, 0, "ped_1", "cross", "already crossing before car arrived", .7, "witness_1.txt",
       quote="The lady had already started crossing when the car came"),
    ev("EV-W-003", "witness_1", "CLAIMED", 1, 5, "car_B", "exit", "towards flyover", .75, "witness_1.txt", quote="drove off towards the flyover"),
    ev("EV-W-004", "witness_2", "CLAIMED", -4, 0, "signal_main", "signal", "red", .8, "witness_2.txt", quote="The signal was red for the white car, I am sure"),
    ev("EV-W-005", "witness_2", "CLAIMED", 1, 6, "car_B", "stop", "stopped for some time", .6, "witness_2.txt",
       quote="The red car stopped after the accident for some time"),
    ev("EV-W-006", "witness_3", "CLAIMED", -1, 0, "ped_1", "cross", "came suddenly from left", .4, "witness_3.txt", quote="She came from the left side suddenly"),
    ev("EV-W-007", "witness_3", "CLAIMED", -3, 0, "car_A", "speed", "~60 km/h", .4, "witness_3.txt", quote="The white car was fast, around 60"),
    ev("EV-I-001", "fusion", "INFERRED", -1.6, -0.9, "car_A", "late_reaction", "0.7 s from ped visible to brake", .72, "",
       derived_from=["EV-V-003", "EV-V-004", "EV-S-000"], rule="R_reaction_window"),
    ev("EV-I-002", "fusion", "INFERRED", 1.8, 4.5, "car_B", "hit_and_run", "left scene without stopping", .83, "",
       derived_from=["EV-V-006", "EV-V-007"], rule="R_exit_after_impact"),
]
dump("events", events)

# Tracks in bird's-eye metres (x east, y north). Zebra at y=0, junction centre (0, 8).
def track(tid, cls, colour, pts):
    return {"id": tid, "class": cls, "colour": colour, "points": [{"t": round(t, 2), "x": round(x, 2), "y": round(y, 2)} for t, x, y in pts]}

carA = []
for i in range(-50, 31):
    t = i / 10
    y = -62 / 3.6 * 0.9 - 62 / 3.6 * (-0.9 - t) if t < -0.9 else (-(62 / 3.6) * 0.9 + (62 / 3.6) * (t + 0.9) - 0.5 * 7.4 * (t + 0.9) ** 2 if t < 0 else min(4.5, 1.2 * t))
    carA.append((t, 1.75, y))
ped = [(t / 10, -6 + max(0, (t / 10 + 1.6)) * 1.4 if t / 10 < 0 else -3.76 + 0.4 * min(t / 10, 0.5), 0.2 if t / 10 < 0 else 0.6) for t in range(-50, 31)]
carB = [(t / 10, 1.75, -30 + (t / 10 + 5) * 7 if t / 10 < 1.2 else -30 + 6.2 * 7 + (t / 10 - 1.2) * 15) for t in range(-50, 31)]
dump("tracks", {"frame": {"units": "m", "zebra_y": 0, "lane_width": 3.5, "homography_points": [[412, 610], [880, 605], [990, 420], [330, 425]]},
                "tracks": [track("car_A", "car", "white", carA), track("ped_1", "person", "-", ped), track("car_B", "car", "red", carB)]})

dump("analysis", {
    "t0_iso": "2026-10-30T14:02:07+05:30",
    "offsets": {"cctv": {"offset_s": 0.0, "sigma": 0.03}, "dashcam": {"offset_s": -2.31, "sigma": 0.05},
                "sensor": {"offset_s": 0.42, "sigma": 0.05}, "witness_1": {"offset_s": None, "note": "ordering only"}},
    "contradictions": [
        {"id": "C1", "type": "state", "events": ["EV-W-004", "EV-V-002"], "severity": "high",
         "summary": "Witness 2 says the signal was red for car A; CCTV shows green from -4.0 s to impact.",
         "explanation": "Suggestion: Witness 2 stood on the opposite side and may have seen the cross-street signal."},
        {"id": "C2", "type": "quantity", "events": ["EV-W-001", "EV-S-001"], "severity": "high",
         "summary": "Witness 1 estimates ~30 km/h; telematics records 62 km/h before braking.",
         "explanation": "Suggestion: speed estimates by eye are commonly off by 30-50%."},
        {"id": "C3", "type": "temporal", "events": ["EV-W-006", "EV-W-002", "EV-V-003"], "severity": "medium",
         "summary": "Witness 3 says the pedestrian appeared suddenly; CCTV shows her on the zebra 1.6 s before impact, as Witness 1 says.",
         "explanation": None},
        {"id": "C4", "type": "witness", "events": ["EV-W-005", "EV-V-007"], "severity": "high",
         "summary": "Witness 2 says car B stopped; CCTV shows car B leaving north within 0.6 s without stopping.",
         "explanation": None},
    ],
    "gaps": [{"start": -2.5, "end": -1.6, "covered_by": ["cctv"], "note": "Pedestrian partly occluded by bus; only one camera covers her approach."}],
    "reliability": {"witness_1": 0.75, "witness_2": 0.0, "witness_3": 0.33},
    "hypotheses": [
        {"id": "H1", "text": "Car A was speeding and braked late after the pedestrian was visible", "status": "supported",
         "for": ["EV-S-001", "EV-I-001", "EV-V-003"], "against": ["EV-W-001"], "untested": []},
        {"id": "H2", "text": "Car A ran a red signal", "status": "contradicted", "for": ["EV-W-004"], "against": ["EV-V-002"], "untested": []},
        {"id": "H3", "text": "Pedestrian stepped out suddenly with no time to react", "status": "contradicted",
         "for": ["EV-W-006"], "against": ["EV-V-003", "EV-W-002"], "untested": ["dashcam view of west kerb"]},
    ],
    "counterfactual": {"actor": "car_A", "observed_speed_kmh": 62, "hazard_at_m": 26.5, "brake_start_s": -0.9,
                       "note": "Distance from car A to zebra when pedestrian became visible (-1.6 s)."},
})

sig = {"peak_g": 7.9, "dv_kmh": 24, "vru_involved": True, "person_down_s": 9, "rollover": False, "airbag": True,
       "fire_smoke": False, "collision_type": "pedestrian",
       "refs": {"peak_g": "sensor.csv#r=52", "dv_kmh": "tracks:car_A", "vru_involved": "cctv.mp4#f=150",
                "person_down_s": "cctv.mp4#f=165-435", "airbag": "sensor.csv#r=52"}}
import sys
sys.path.insert(0, str(Path(__file__).parents[1] / "backend"))
from app.severity import score  # noqa: E402
dump("severity", {"signals": sig, **score(sig), "minor_example": score({"peak_g": 2.5, "dv_kmh": 12})})

dump("plates", {"vehicles": [
    {"track": "car_A", "plate": "TS09EA1234", "confidence": 0.83, "frames": [140, 142, 144, 146, 148, 150],
     "reads": ["TS09EA1234", "TS09EA1234", "TS09FA1234", "TS09EA1234", "TS09EA12?4", "TS09EA1234"], "partial": False},
    {"track": "car_B", "plate": "TS07G?5521", "confidence": 0.5, "frames": [186, 190, 194, 198],
     "reads": ["TS07GK5521", "TS07G?5521", "TS07GX5521", "TS07G?552?"], "partial": True}]})

tolls = [("Gachibowli ORR Exit 17", 17.4480, 78.3550, 1.6), ("Nanakramguda Toll", 17.4196, 78.3420, 3.4),
         ("Kokapet ORR Toll", 17.3990, 78.3330, 6.1), ("Shamshabad ORR Toll", 17.2500, 78.4200, 24.0)]
win = [{"name": n, "lat": la, "lon": lo, "dist_km": d,
        "window_min": [round(d / 80 * 60, 1), round(d / 30 * 60, 1)]} for n, la, lo, d in tolls]
dump("pursuit", {"exit": {"t": 1.8, "heading": "north", "speed_kmh": [30, 80], "lat": 17.4401, "lon": 78.3489},
                 "partial_plate": "TS07G?5521", "tolls": win,
                 "funnel": [{"stage": "Toll passages in 30 min", "count": 312}, {"stage": "Inside reachable window", "count": 41},
                            {"stage": "Plate pattern TS07G?5521", "count": 3}, {"stage": "Red sedan (VLM colour/class)", "count": 1}],
                 "match": {"plate": "TS07GK5521", "toll": "Gachibowli ORR Exit 17", "time": "14:04:31", "fastag": "DEMO-FT-88213"}})

dump("facilities", {"source": "OSM Overpass (cached)", "police": [
    {"name": "Gachibowli Police Station", "lat": 17.4436, "lon": 78.3519, "dist_km": 1.2, "eta_min": 4}],
    "hospitals": [{"name": "Area Hospital (Govt), Kondapur", "lat": 17.4580, "lon": 78.3640, "dist_km": 2.4, "eta_min": 7, "trauma": True},
                  {"name": "Govt PHC Nanakramguda", "lat": 17.4200, "lon": 78.3460, "dist_km": 2.3, "eta_min": 7, "trauma": False}]})
print("demo case written to", D)
