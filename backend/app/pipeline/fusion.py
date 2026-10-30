"""OWNER: P2. Fusion: one clock, entity resolution, rule-based claim checks, gaps, reliability, hypotheses,
robustness (sensitivity) and the counterfactual setup. Works for any clip: nothing here assumes a bus or an officer.
Rules decide; every verdict cites the events it rests on and states what would have to be wrong for it to flip.

Clock: T0 = impact. Video events arrive on T0. Sensor events (device clock) are aligned on the impact spike.
Witness claims carry ordering only (before / at / after impact)."""
import json
import re
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from .. import physics
from .. import reliability as rel_rules
from . import sensor, stn
from . import witness as W

VEHICLE_CLASSES = ("car", "bus", "truck", "motorcycle", "bicycle")
PERSON_WORDS = r"police|constable|officer|pedestrian|lady|woman|man|boy|girl|person|rider|driver"
GROUP_WORDS = {"bikes": "motorcycle", "motorcycles": "motorcycle", "cars": "car", "people": "person", "pedestrians": "person", "vehicles": None, "autos": "car"}
CLASS_WORDS = [(r"bus|truck|lorry|van|tempo", "large"), (r"car|jeep|suv|auto", "car"), (r"motorbike|motorcycle|scooter|bike", "motorcycle"), (r"bicycle|cycle", "bicycle")]
COLOUR_SYN = {"white": {"white", "silver"}, "silver": {"silver", "white", "grey"}, "grey": {"grey", "silver"}, "gray": {"grey", "silver"},
              "black": {"black"}, "red": {"red", "orange"}, "blue": {"blue"}, "green": {"green"}, "yellow": {"yellow", "orange"}, "orange": {"orange", "red", "yellow"}}
SPEED_TOL = lambda measured: max(10.0, 0.35 * measured)   # eyewitness speed estimates are coarse


def speed_flip_pct(claim: float, measured: float) -> float:
    """How wrong the speed scale must be for the claim to fall inside the tolerance. That needs the measured speed
    scaled to s*v with |claim - s*v| <= SPEED_TOL(s*v), and the tolerance is the larger of 10 km/h and 35%."""
    v = max(measured, 1.0)
    s = min((claim - 10) / v, claim / (1.35 * v)) if claim > v else max((claim + 10) / v, claim / (0.65 * v))
    return abs(s - 1) * 100


# ---------------- scene model ----------------

def at(tr, t):
    p = tr["points"]
    if t <= p[0]["t"]: return p[0]
    if t >= p[-1]["t"]: return p[-1]
    i = next(i for i, q in enumerate(p) if q["t"] >= t)
    a, b = p[i - 1], p[i]
    k = (t - a["t"]) / ((b["t"] - a["t"]) or 1)
    return {"t": t, "x": a["x"] + (b["x"] - a["x"]) * k, "y": a["y"] + (b["y"] - a["y"]) * k, "v_kmh": a["v_kmh"] + (b["v_kmh"] - a["v_kmh"]) * k}


def window(tr, t0, t1):
    return [p for p in tr["points"] if t0 <= p["t"] <= t1]


def override_of(case_dir: Path) -> dict:
    """What a person corrected on the Contradictions page; it outranks the geometry and survives every re-run."""
    p = case_dir / "entities_override.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def scene(metric: dict, ui: dict, override: dict | None = None) -> dict:
    """Primary vehicle, impact point, the road user it met, sizes and colours, from geometry alone."""
    tracks = {t["id"]: t for t in metric["tracks"]}
    boxes = {t["id"]: np.median([q["box"][3] - q["box"][1] for q in t["points"]]) for t in ui["tracks"]}
    colours = {t["id"]: t.get("colour_name") for t in ui["tracks"]}
    # candidates: vehicles tracked for at least 1 s around the impact (short flickering tracks are not the crash)
    vehicles = [t for t in tracks.values() if t["class"] in VEHICLE_CLASSES and len(window(t, -3, 0.5)) >= 3
                and (window(t, -3, 0.5)[-1]["t"] - window(t, -3, 0.5)[0]["t"]) >= 1.0]
    def pre_speed(t):
        w = [p["v_kmh"] for p in window(t, -2, 0)]
        return float(np.median(w)) if w else 0.0
    def gap(a, b):
        return min(np.hypot(at(a, s)["x"] - at(b, s)["x"], at(a, s)["y"] - at(b, s)["y"]) for s in (-0.5, -0.25, 0, 0.25, 0.5))
    # a collision needs at least one of the pair to be moving (two parked cars side by side are not a crash)
    pairs = sorted((gap(a, b), a["id"], b["id"]) for i, a in enumerate(vehicles) for b in vehicles[i + 1:] if max(pre_speed(a), pre_speed(b)) > 3.0)
    if pairs and pairs[0][0] < 4.0:  # a vehicle-vehicle collision: primary = the faster of the closest pair
        a, b = tracks[pairs[0][1]], tracks[pairs[0][2]]
        primary = max((a, b), key=pre_speed)
    else:
        primary = max(vehicles, key=lambda t: (pre_speed(t), boxes.get(t["id"], 0)), default=None)
    primary = tracks.get((override or {}).get("primary"), primary)
    impact = at(primary, 0) if primary else None
    others = []
    if primary:
        for t in tracks.values():
            if t["id"] == primary["id"] or not window(t, -0.6, 0.6):
                continue
            d = min(np.hypot(at(t, s)["x"] - at(primary, s)["x"], at(t, s)["y"] - at(primary, s)["y"]) for s in (-0.5, -0.25, 0, 0.25, 0.5))
            others.append((d, t["id"]))
    others.sort()
    cars = [boxes[t["id"]] for t in vehicles if t["class"] == "car"]
    large = {tid for tid, h in boxes.items() if tracks.get(tid, {}).get("class") in ("bus", "truck")
             or (tracks.get(tid, {}).get("class") == "car" and cars and h > 1.6 * np.median(cars))}
    return {"primary": primary["id"] if primary else None, "impact_xy": [round(impact["x"], 2), round(impact["y"], 2)] if impact else None,
            "nearest": [{"id": i, "dist_m": round(float(d), 2)} for d, i in others[:8]], "large": sorted(large), "colours": colours,
            "tracks": tracks}


def resolve(text: str, sc: dict) -> str | None:
    """Map a witness noun phrase ('the bus', 'a white car', 'the policeman') to a track id, or a group, or None."""
    s = (text or "").lower().replace("_", " ")
    tracks, prim = sc["tracks"], sc["primary"]
    if re.fullmatch(r"\s*(i|me|self|myself)\s*", s):
        return "witness"
    for w, cls in GROUP_WORDS.items():
        if re.search(rf"\b{w}\b", s):
            return f"group:{cls or 'vehicle'}"
    if re.search(PERSON_WORDS, s):
        people = [t for t in tracks.values() if t["class"] == "person" and window(t, -1, 2)]
        # What vision saw of each person narrows it: "the policeman" is someone in uniform, and not a passing rider.
        seen = sc.get("actors", {})
        uniformed = [t for t in people if seen.get(t["id"], {}).get("uniformed")]
        on_foot = [t for t in people if not str(seen.get(t["id"], {}).get("type", "")).endswith("_rider")]
        if re.search(r"police|constable|officer", s) and uniformed:
            people = uniformed
        elif not re.search(r"rider|driver", s) and on_foot:
            people = on_foot
        if not people or not sc["impact_xy"]:
            return None
        ix, iy = sc["impact_xy"]
        return min(people, key=lambda t: min(np.hypot(p["x"] - ix, p["y"] - iy) for p in window(t, -1, 2)))["id"]
    want_cls = next((c for pat, c in CLASS_WORDS if re.search(rf"\b(?:{pat})\b", s)), None)
    want_col = next((c for c in COLOUR_SYN if re.search(rf"\b{c}\b", s)), None)
    if not want_cls and not want_col:
        return None
    best, best_score = None, 0.0
    for t in tracks.values():
        if t["class"] not in VEHICLE_CLASSES or not window(t, -4, 2):
            continue
        sc_ = 0.0
        col = sc["colours"].get(t["id"])
        if want_col:
            sc_ += 2 if col in COLOUR_SYN[want_col] else (-1 if col else 0)
        if want_cls == "large":
            sc_ += 1.5 if t["id"] in sc["large"] else 0
        elif want_cls:
            sc_ += 1 if t["class"] == want_cls else 0
        if t["id"] == prim and not want_col:
            sc_ += 1.5
        if sc_ > best_score:
            best, best_score = t["id"], sc_
    return best or (prim if want_cls and not want_col else None)


def side_of_turn(ui_track: dict) -> tuple[str | None, float]:
    """Left/right from image geometry (handedness-safe): heading over [-3,-1.5] s vs displacement over [-1.5,0.3] s."""
    p = ui_track["points"]
    seg = lambda a, b: [q for q in p if a <= q["t"] <= b]
    h, d = seg(-3.0, -1.4), seg(-1.5, 0.3)
    if len(h) < 3 or len(d) < 3:
        return None, 0.0
    hx, hy = h[-1]["x"] - h[0]["x"], -(h[-1]["y"] - h[0]["y"])
    dx, dy = d[-1]["x"] - d[0]["x"], -(d[-1]["y"] - d[0]["y"])
    n = np.hypot(hx, hy) or 1
    cross = (hx * dy - hy * dx) / n
    lateral_px = abs(cross)
    return ("left" if cross > 0 else "right"), lateral_px


# ---------------- main ----------------

def run(case_dir: Path, video_events: list[dict], sensor_events: list[dict], witness_events: list[dict]) -> dict:
    case = json.loads((case_dir / "case.json").read_text())
    metric = json.loads((case_dir / "tracks_metric.json").read_text())
    ui = json.loads((case_dir / "tracks_ui.json").read_text())
    vision = json.loads((case_dir / "vision.json").read_text()) if (case_dir / "vision.json").exists() else None
    override = override_of(case_dir)
    sc = scene(metric, ui, override)
    tracks, prim = sc["tracks"], sc["primary"]
    sc["actors"] = json.loads((case_dir / "vision_actors.json").read_text()) if (case_dir / "vision_actors.json").exists() else {}
    ui_tracks = {t["id"]: t for t in ui["tracks"]}
    wit_meta = json.loads((case_dir / "witnesses.json").read_text()) if (case_dir / "witnesses.json").exists() else {}
    who = lambda src: wit_meta.get(src, {}).get("name", src.replace("_", " ").title())

    def stop_check():
        csv_p = case_dir / "evidence" / "sensor.csv"
        if not csv_p.exists():
            return None
        weather = case.get("weather") or {}
        return physics.stop_claim_check(sensor.rows_of(csv_p), weather.get("mu", physics.MU_DRY),
                                        weather.get("mu_basis", "assumed dry road; no weather data"))

    inferred, n_inf = [], 0
    def infer(actor, action, value, t0, t1, derived, rule, conf):
        nonlocal n_inf
        n_inf += 1
        inferred.append({"id": f"EV-I-{n_inf:03d}", "source": "fusion", "kind": "INFERRED", "t": {"start": round(t0, 2), "end": round(t1, 2), "sigma": 0.2},
                         "clock": "T0", "actor": actor, "action": action, "value": value, "confidence": round(conf, 2), "ref": "",
                         "derived_from": derived, "rule": rule})
        return inferred[-1]["id"]

    # 1. sensor alignment (telematics belongs to the primary vehicle)
    offsets = {"cctv": {"offset_s": -case["t0_video_s"], "sigma": 0.05, "anchor": case.get("t0_anchor")}}
    s_imp = next((e for e in sensor_events if e["action"] == "impact"), None)
    if s_imp:
        off = -s_imp["t"]["start"]
        for e in sensor_events:
            e["t"] = {**e["t"], "start": round(e["t"]["start"] + off, 2), "end": round(e["t"]["end"] + off, 2)}
            e["clock"], e["actor"] = "T0", prim or e["actor"]
        offsets["sensor"] = {"offset_s": round(off, 2), "sigma": 0.1, "anchor": s_imp["id"], "note": "telematics clock aligned on its acceleration spike = video impact"}
    for w in {e["source"] for e in witness_events}:
        offsets[w] = {"offset_s": None, "note": "ordering only (before / at / after impact)"}

    # 2. resolve witness actors to tracks
    for e in witness_events:
        e["actor"] = resolve(e.get("actor_text") or e["actor"], sc) or e["actor"]

    # 3. measurements as INFERRED events
    M = {}
    def speed_of(tid):
        tr = tracks.get(tid)
        pre = window(tr, -3.0, -0.1) if tr else []
        v = max((p["v_kmh"] for p in pre), default=None)
        if tid == prim:
            s_speed = next((e for e in sensor_events if e["action"] == "speed"), None)
            sp = W.parse_speed(s_speed["value"]) if s_speed else None
            if sp is not None:
                return (max(v or 0, sp), s_speed["id"])
        return (v, None)
    if prim:
        v, sid = speed_of(prim)
        sig = round((v or 0) * metric["scale_sigma"] + 2, 1)
        M["prim_speed"] = (infer(prim, "speed", f"{v:.0f} ± {sig:.0f} km/h (calibrated CCTV{' + telematics' if sid else ''})", -3.0, -0.1,
                                 [x for x in [sid, f"tracks_metric:{prim}"] if x], "R_speed_homography", 0.8), v, sig)
        brakes = [e for e in sensor_events if e["action"] == "brake" and e["t"]["start"] < 0]
        decel = [e for e in video_events if e["actor"] == prim and e["action"] in ("sudden_decel", "stop")]
        pre = window(tracks[prim], -2.5, 0)
        v_drop = (max(p["v_kmh"] for p in pre) - pre[-1]["v_kmh"]) if len(pre) > 2 else 0
        if brakes or decel or v_drop > 5:
            M["prim_brake"] = (infer(prim, "brake", f"slowing before impact ({'telematics ' + brakes[0]['value'] if brakes else f'{v_drop:.0f} km/h drop on video'})",
                                     min([e["t"]["start"] for e in brakes] or [-1.5]), 0, [e["id"] for e in brakes + decel] or [f"tracks_metric:{prim}"],
                                     "R_brake_evidence", 0.85 if brakes else 0.6), min([e["t"]["start"] for e in brakes] or [-1.5]))
        rest = at(tracks[prim], tracks[prim]["points"][-1]["t"])
        moving_after = max((p["v_kmh"] for p in window(tracks[prim], 1.0, 3.0)), default=0)
        M["prim_rest"] = (infer(prim, "stop" if moving_after < 4 else "moving", f"{'comes to rest' if moving_after < 4 else 'keeps moving'} after impact (≤ {moving_after:.0f} km/h from T+1 s)",
                                0, 3, [f"tracks_metric:{prim}"] + [e["id"] for e in video_events if e["actor"] == prim and e["action"] == "stop"],
                                "R_post_impact_motion", 0.75), moving_after < 4)
        if prim in ui_tracks:
            side, lat = side_of_turn(ui_tracks[prim])
            if side:
                M["prim_turn"] = (infer(prim, "turn", f"drifts {side} before impact", -1.5, 0.3, [f"tracks_ui:{prim}"], "R_heading_vs_displacement", 0.65), side, lat)
    clk = case.get("clock_overlay")
    if clk:
        t0c = datetime.strptime(clk["value"], "%H:%M:%S") + timedelta(seconds=case["t0_video_s"] - clk["at_video_s"])
        M["clock"] = (infer("cctv", "time_of_day", t0c.strftime("%H:%M:%S") + f" at impact ({clk.get('method', 'overlay')})", 0, 0, [f"cctv.mp4#overlay@{clk['at_video_s']}s"], "R_overlay_clock", 0.9), t0c)
    sig_state = (vision or {}).get("signal_state")
    if sig_state and sig_state != "not_visible":
        M["signal"] = (infer("signal", "signal", f"{sig_state} near impact (vision model, keyframe {vision.get('signal_frame')})", -1, 0,
                             [f"vision.json#{vision.get('signal_frame')}"], "R_vlm_signal", 0.6), sig_state)

    # 4. check every claim
    contradictions, checks, nC = [], [], 0
    rel = {w: [0, 0] for w in {e["source"] for e in witness_events}}
    def verdict(e, status, against, ctype=None, summary="", explanation=None, sev="medium", holds_unless=None):
        nonlocal nC
        checks.append({"claim": e["id"], "status": status, "evidence": against})
        if status in ("consistent", "contradicted"):
            rel[e["source"]][0 if status == "consistent" else 1] += 1
        if status == "contradicted":
            nC += 1
            contradictions.append({"id": f"C{nC}", "type": ctype, "events": [e["id"]] + against, "summary": summary, "explanation": explanation,
                                   "severity": sev, "holds_unless": holds_unless})

    for e in witness_events:
        act, tid, w = e["action"], e["actor"], who(e["source"])
        tr = tracks.get(tid) if isinstance(tid, str) else None
        name = e.get("actor_text") or tid
        if act == "speed" and tr:
            claim = W.parse_speed(e["value"])
            v, sid = speed_of(tid)
            if claim is None or v is None:
                verdict(e, "unverifiable", [])
                continue
            mid = M["prim_speed"][0] if tid == prim else infer(tid, "speed", f"{v:.0f} km/h (calibrated CCTV)", -3, -0.1, [f"tracks_metric:{tid}"], "R_speed_homography", 0.7)
            if abs(claim - v) <= SPEED_TOL(v):
                verdict(e, "consistent", [mid])
            else:
                verdict(e, "contradicted", [mid], "quantity", f"{w} puts {name} at ~{claim:.0f} km/h; the evidence measures {v:.0f} km/h.",
                        "Suggestion: eyewitness speed estimates are often off by 30-50%, more so for large vehicles and under stress.", "high",
                        f"the speed scale is off by more than {speed_flip_pct(claim, v):.0f}% (calibration is ±{metric['scale_sigma'] * 100:.0f}%)")
        elif act in ("no_brake", "brake") and tid == prim:
            if "prim_brake" in M:
                if act == "brake":
                    verdict(e, "consistent", [M["prim_brake"][0]])
                else:
                    verdict(e, "contradicted", [M["prim_brake"][0]], "state", f"{w} says {name} did not slow down; the evidence records slowing before impact.",
                            "Suggestion: braking at low speed is easy to miss from the side.", "high",
                            f"the telematics clock is misaligned by more than {abs(M['prim_brake'][1]):.1f} s" if "sensor" in offsets else "the video track is wrong about the slowdown")
            else:
                verdict(e, "consistent" if act == "no_brake" else "contradicted", [], "state", f"{w} says {name} braked; no slowing is visible before impact.")
        elif act == "cut_in" and tr:
            pre = window(tr, -3, 0)
            vmax = max((p["v_kmh"] for p in pre), default=0)
            mid = infer(tid, "speed", f"max {vmax:.0f} km/h in the 3 s before impact", -3, 0, [f"tracks_metric:{tid}"], "R_track_state", 0.75)
            if vmax < 5:
                verdict(e, "contradicted", [mid], "presence", f"{w} says {name} cut in; that vehicle is stationary in the 3 s before impact.",
                        "Suggestion: the witness may be explaining the swerve after the fact, or saw a vehicle outside the camera view.", "high",
                        "a different vehicle, outside the camera's view, did the cutting in")
            else:
                verdict(e, "consistent", [mid])
        elif act == "impact" and tr and tid != prim and tr["class"] in VEHICLE_CLASSES and max((p["v_kmh"] for p in window(tr, -3, 0.2)), default=99) < 4:
            # A vehicle that isn't moving can't have rammed anything, however close it was.
            mid = infer(tid, "speed", "stationary before impact", -3, 0.2, [f"tracks_metric:{tid}"], "R_track_state", 0.75)
            verdict(e, "contradicted", [mid], "presence", f"{w} says {name} hit {e.get('value') or 'something'}; that vehicle is stationary before the impact.", None, "high",
                    "a different vehicle, outside the camera's view, did the hitting")
        elif act == "impact" and tr:
            target = resolve(e.get("value") or "", sc)
            if target and target in tracks:
                d = min(np.hypot(at(tr, s)["x"] - at(tracks[target], s)["x"], at(tr, s)["y"] - at(tracks[target], s)["y"]) for s in (-0.3, 0, 0.3))
                lim = 4.5 if tracks[target]["class"] in VEHICLE_CLASSES and tr["class"] in VEHICLE_CLASSES else 3.0  # centre-to-centre when touching
                verdict(e, "consistent" if d < lim else "contradicted", [], "state", f"{w} says {name} hit {e['value']}; they are {d:.1f} m apart at impact.",
                        holds_unless=f"positions are off by more than {d - lim:.1f} m")
            elif "prim_rest" in M and tid == prim:
                verdict(e, "consistent" if M["prim_rest"][1] else "contradicted", [M["prim_rest"][0]], "state",
                        f"{w} says {name} hit {e['value']}, but it keeps moving after the impact time.")
            else:
                verdict(e, "unverifiable", [])
        elif act == "turn" and tid == prim and "prim_turn" in M:
            said = "left" if "left" in str(e["value"]).lower() else "right" if "right" in str(e["value"]).lower() else None
            if said is None:
                verdict(e, "consistent", [M["prim_turn"][0]])
            else:
                ok = said == M["prim_turn"][1]
                verdict(e, "consistent" if ok else "contradicted", [M["prim_turn"][0]], "state",
                        f"{w} says {name} turned {said}; its track drifts {M['prim_turn'][1]}.",
                        "Suggestion: left/right is often told from the witness's own viewpoint, not the driver's.", "medium",
                        "the witness meant their own left/right rather than the driver's")
        elif act == "fell" and tr:
            downs = [x for x in video_events if x["action"] == "person_down" and x["actor"] == tid]
            mid = infer(tid, "posture", "fell / lying detected" if downs else "upright after impact (box taller than wide)", 0, 4,
                        [f"tracks_metric:{tid}"] + [x["id"] for x in downs], "R_box_aspect_posture", 0.65)
            if downs:
                verdict(e, "consistent", [mid])
            else:
                verdict(e, "contradicted", [mid], "state", f"{w} says {name} fell; the person stays upright and keeps moving after impact.",
                        f"Suggestion: from {wit_meta.get(e['source'], {}).get('distance_m', 'a distance')} m, jumping clear can look like a fall.", "medium",
                        "the person was hidden behind a vehicle while on the ground")
        elif act == "time_of_day" and "clock" in M:
            try:
                ct = datetime.strptime(str(e["value"]), "%H:%M")
                diff = abs((ct - M["clock"][1].replace(second=0)).total_seconds()) / 60
                if diff > 3:
                    verdict(e, "contradicted", [M["clock"][0]], "temporal", f"{w} places it around {e['value']}; the CCTV clock reads {M['clock'][1].strftime('%H:%M')} ({diff:.0f} min apart).",
                            "Suggestion: an approximate recollection, or the recorder clock itself drifts.", "low", f"the CCTV clock is wrong by more than {diff - 3:.0f} min")
                else:
                    verdict(e, "consistent", [M["clock"][0]])
            except ValueError:
                verdict(e, "unverifiable", [])
        elif act == "signal" and "signal" in M:
            said = str(e["value"]).lower()
            ok = said == M["signal"][1]
            verdict(e, "consistent" if ok else "contradicted", [M["signal"][0]], "state", f"{w} says the signal was {said}; the frame shows {M['signal'][1]}.",
                    "Suggestion: the witness may have been looking at a different signal head.", "high", "the vision model misread the signal colour")
        elif act == "stopped_in_time" and tid == prim:
            check = stop_check()
            if check is None:
                verdict(e, "unverifiable", [])
            elif check["possible"]:
                verdict(e, "consistent", [])
            else:
                verdict(e, "contradicted", [s["id"] for s in sensor_events if s["action"] == "impact"], "physics",
                        f"{w} says {name} stopped in time. From {check['speed_kmh']:.0f} km/h at friction {check['mu']} ({check['mu_basis']}), "
                        f"braking needs about {check['needed_m']:.1f} m, but only {check['had_m']:.1f} m were covered before the logged impact "
                        f"(sensor.csv rows {check['start_row']}-{check['impact_row']}), still at {check['speed_at_impact_kmh']:.0f} km/h.", None, "high",
                        f"the telematics speed is wrong by more than {check['speed_at_impact_kmh'] - physics.STOPPED_KMH:.0f} km/h")
        elif act == "presence" and isinstance(tid, str) and tid.startswith("group:"):
            cls = tid.split(":")[1]
            n = sum(1 for t in tracks.values() if (cls == "vehicle" and t["class"] in VEHICLE_CLASSES) or t["class"] == cls)
            many = bool(re.search(r"many|lots|several", str(e["value"]).lower()))
            verdict(e, "consistent" if (n >= 3) == many or not many else "contradicted", [], "presence",
                    f"{w} describes many {cls}s; {n} are tracked.")
        else:
            verdict(e, "unverifiable", [])

    sp = [(e, W.parse_speed(e["value"])) for e in witness_events if e["action"] == "speed" and W.parse_speed(e["value"]) and e["actor"] == prim]
    for i in range(len(sp)):
        for j in range(i + 1, len(sp)):
            (a, va), (b, vb) = sp[i], sp[j]
            if abs(va - vb) > SPEED_TOL(min(va, vb)):
                nC += 1
                contradictions.append({"id": f"C{nC}", "type": "witness", "events": [a["id"], b["id"]], "severity": "medium", "explanation": None,
                                       "summary": f"{who(a['source'])} (~{va:.0f} km/h) and {who(b['source'])} (~{vb:.0f} km/h) disagree on the speed.",
                                       "holds_unless": "both witnesses meant different moments"})

    # 5. gaps
    rng = case["range"]
    cover = {}
    if prim:
        cover["cctv"] = (tracks[prim]["points"][0]["t"], tracks[prim]["points"][-1]["t"])
    if sensor_events:
        cover["sensor"] = (min(e["t"]["start"] for e in sensor_events), max(e["t"]["end"] for e in sensor_events))
    gaps = []
    if cover:
        first = min(c[0] for c in cover.values())
        if first > rng[0] + 0.3:
            gaps.append({"start": rng[0], "end": round(first, 2), "covered_by": [], "note": "The primary vehicle is not yet in view; its approach is covered only by untimed witness accounts."})
        both = max(c[0] for c in cover.values())
        if len(cover) > 1 and both > first + 0.3:
            gaps.append({"start": round(first, 2), "end": round(both, 2), "covered_by": [k for k, c in cover.items() if c[0] <= first + 0.01], "note": "Single timed source only."})
        if prim:
            pts = tracks[prim]["points"]
            for a, b in zip(pts, pts[1:]):
                if b["t"] - a["t"] > 0.6:
                    gaps.append({"start": round(a["t"], 2), "end": round(b["t"], 2), "covered_by": [k for k in cover if k != "cctv"], "note": "Primary vehicle lost by the tracker (occlusion)."})

    reliability = {w: round(c / (c + x), 2) if c + x else None for w, (c, x) in rel.items()}

    # conditions-based reliability, and a weight on each claim, with reasons
    statements = {w: (case_dir / "evidence" / f"{w}.txt").read_text(encoding="utf-8") for w in rel if (case_dir / "evidence" / f"{w}.txt").exists()}
    reliability_detail = {w: {"evidence_score": reliability[w], **rel_rules.weigh_statement(statements.get(w, ""), wit_meta.get(w, {}))} for w in rel}
    for e in witness_events:
        base = reliability_detail[e["source"]]
        weighed = rel_rules.weigh_claim(base["weight"], e["action"], base["reasons"])
        e["reliability_weight"], e["reliability_reasons"] = weighed["weight"], weighed["reasons"]

    # 6. hypotheses (status from evidence, never from the LLM)
    pname = prim or "the vehicle"
    hyps = []
    if "prim_speed" in M:
        fast = M["prim_speed"][1] >= 40
        hyps.append({"id": "H1", "text": "The primary vehicle was travelling fast (over 40 km/h)", "status": "supported" if fast else "contradicted",
                     "for": [M["prim_speed"][0]] if fast else [e["id"] for e in witness_events if e["action"] == "speed" and (W.parse_speed(e["value"]) or 0) >= 40],
                     "against": [] if fast else [M["prim_speed"][0]], "untested": []})
    hyps.append({"id": "H2", "text": "It did not slow down before the impact", "status": "contradicted" if "prim_brake" in M else "supported",
                 "for": [e["id"] for e in witness_events if e["action"] == "no_brake"], "against": [M["prim_brake"][0]] if "prim_brake" in M else [], "untested": []})
    cuts = [c for c in checks if any(e["id"] == c["claim"] and e["action"] == "cut_in" for e in witness_events)]
    if cuts:
        bad = any(c["status"] == "contradicted" for c in cuts)
        hyps.append({"id": "H3", "text": "Another vehicle cut in and forced the manoeuvre", "status": "contradicted" if bad else "supported",
                     "for": [c["claim"] for c in cuts], "against": [x for c in cuts for x in c["evidence"]] if bad else [], "untested": ["vehicles outside the camera view"]})
    if "prim_turn" in M:
        hyps.append({"id": "H4", "text": f"It drifted {M['prim_turn'][1]} on its own into the point of impact", "status": "supported" if not cuts or any(c["status"] == "contradicted" for c in cuts) else "inconclusive",
                     "for": [M["prim_turn"][0], M.get("prim_rest", [None])[0]], "against": [], "untested": ["driver state", "brake or steering fault", "road surface"]})

    # 7. counterfactual: from 1.6 s before impact
    cf = None
    if prim:
        pts = [p for p in tracks[prim]["points"] if p["t"] <= 0]
        if len(pts) > 3:
            a = min(pts, key=lambda p: abs(p["t"] + 1.6))
            dist = sum(np.hypot(b["x"] - q["x"], b["y"] - q["y"]) for q, b in zip(pts, pts[1:]) if q["t"] >= a["t"])
            cf = {"actor": prim, "observed_speed_kmh": round(a["v_kmh"], 1), "hazard_at_m": round(float(dist), 2), "brake_start_s": -1.6,
                  "note": f"Distance the primary vehicle covered in the last 1.6 s before impact: {dist:.1f} m. Would it have stopped short at a lower speed?"}

    # 8. names for the UI (vision type > witness noun > colour + class)
    names = {}
    vis_type = (vision or {}).get("primary_type")
    said = {}
    for e in witness_events:
        if isinstance(e["actor"], str) and e["actor"] in tracks:
            m = re.search(r"(bus|truck|lorry|van|car|auto|bike|motorcycle|scooter|policeman|constable|officer|pedestrian|lady|woman|man)", (e.get("actor_text") or "").lower())
            if m:
                said.setdefault(e["actor"], m.group(1))
    for tid, t in tracks.items():
        col = ((vision or {}).get("primary_colour") if tid == prim else None) or sc["colours"].get(tid)
        base = (vis_type if tid == prim and vis_type else said.get(tid) or t["class"]).replace("_", " ")
        names[tid] = f"{col + ' ' if col and t['class'] != 'person' else ''}{base}".strip().capitalize()
    for tid in list(names):
        if tid == prim:
            names[tid] += " (primary)"

    # involved = the vehicle it met (nearest, < 4 m) + people the witnesses name near the impact; else the nearest person
    near_v = [n["id"] for n in sc["nearest"] if tracks[n["id"]]["class"] in VEHICLE_CLASSES and n["dist_m"] < 4.0][:1]
    named_p = [tid for tid in dict.fromkeys(e["actor"] for e in witness_events if isinstance(e["actor"], str) and tracks.get(e["actor"], {}).get("class") == "person")
               if any(n["id"] == tid and n["dist_m"] < 4.0 for n in sc["nearest"]) or tid in [n["id"] for n in sc["nearest"]]]
    near_p = named_p or [n["id"] for n in sc["nearest"] if tracks[n["id"]]["class"] == "person" and n["dist_m"] < 2.5][:1]
    ent = {"primary": prim, "involved": override.get("involved") or near_v + near_p, "impact_xy": sc["impact_xy"], "names": names,
           "large": sc["large"], "colours": sc["colours"]}
    (case_dir / "entities.json").write_text(json.dumps(ent, indent=2))

    # 9. STN over the vehicles in question: tightest windows, plus any stated order that can't be true
    actors = {prim, *ent["involved"], *(e["actor"] for e in witness_events)}
    timed = [e for e in [*video_events, *sensor_events, *inferred, *witness_events] if e["actor"] in actors]
    orders_p = case_dir / "witness_orderings.json"
    known = {e["id"] for e in witness_events}
    orders = [c for c in (json.loads(orders_p.read_text(encoding="utf-8")) if orders_p.exists() else []) if c["from"] in known and c["to"] in known]
    ordered_ids = {c["from"] for c in orders} | {c["to"] for c in orders}
    constraints = orders + stn.match_constraints([e for e in witness_events if e["id"] in ordered_ids], timed)
    solved = stn.solve(timed, constraints)
    for conflict in solved["conflicts"]:
        said = [e for e in witness_events if e["id"] in conflict["events"]]
        clocks = sorted({e["source"] for e in timed if e["id"] in conflict["events"] and e.get("clock") != "order"})
        quotes = " / ".join(f'"{e["quote"]}"' for e in said[:2])
        nC += 1
        contradictions.append({"id": f"C{nC}", "type": "temporal", "events": conflict["events"], "severity": "high", "explanation": None,
                               "constraints": conflict["constraints"],
                               "summary": f"{who(said[0]['source']) if said else 'A statement'}'s order ({quotes}) and the timing from {', '.join(clocks) or 'other statements'} can't both be true: "
                                          f"it would need an ordering that is off by at least {conflict['off_by_s']} s.",
                               "holds_unless": f"the {' or '.join(clocks) or 'stated'} timing is off by more than {conflict['off_by_s']} s"})
    order_flips = stn.sensitivity(timed, offsets, {prim, *ent["involved"]}, names)
    analysis = {"status": "computed", "offsets": offsets, "entities": ent, "contradictions": contradictions, "gaps": gaps,
                "reliability": reliability, "reliability_detail": reliability_detail, "checks": checks, "hypotheses": hyps, "counterfactual": cf,
                "stn": {"consistent": solved["consistent"], "windows": solved["windows"], "excluded": solved["excluded"], "constraints": constraints},
                "sensitivity": order_flips}
    (case_dir / "analysis.json").write_text(json.dumps(analysis, indent=2, default=str))
    return {"analysis": analysis, "inferred": inferred, "sensor_events": sensor_events, "witness_events": witness_events}
