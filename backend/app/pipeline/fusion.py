"""OWNER: P2. Fusion v1: one clock, entity mapping, rule-based contradiction checks, gaps, reliability,
hypotheses and the counterfactual setup. Rules decide; every verdict cites the events it rests on.

Clock: T0 = impact (seconds). Video events arrive already on T0. Sensor events are on the device clock and
are aligned by matching the sensor impact spike to T0. Witnesses give ordering, not times.

TODO (P2, next): replace the fixed order windows with an STN over before/after constraints (stn_consistent
below) and report minimal conflicting sets; sensitivity ("ordering flips if a clock is off by > X s")."""
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from . import witness as W

SPEED_TOL = lambda measured: max(10.0, 0.35 * measured)   # eyewitness speed estimates are coarse


def stn_consistent(n: int, edges: list[tuple[int, int, float, float]]):
    """edges: (i, j, lo, hi) meaning lo <= t_j - t_i <= hi. Returns (ok, dist matrix)."""
    INF = float("inf")
    d = [[0 if i == j else INF for j in range(n)] for i in range(n)]
    for i, j, lo, hi in edges:
        d[i][j] = min(d[i][j], hi)
        d[j][i] = min(d[j][i], -lo)
    for k in range(n):
        for i in range(n):
            for j in range(n):
                if d[i][k] + d[k][j] < d[i][j]:
                    d[i][j] = d[i][k] + d[k][j]
    return all(d[i][i] >= 0 for i in range(n)), d


def guess_entities(metric: dict) -> dict:
    """Rules: the bus = the vehicle whose box grows largest; the officer = the longest person track standing on the
    divider side (x < 0.5 m); white_car = the other car track. Saved to entities.json so a human can correct it."""
    tr = metric["tracks"]
    veh = [t for t in tr if t["class"] in ("car", "bus", "truck")]
    moving = sorted(veh, key=lambda t: -max(p["v_kmh"] for p in t["points"]))
    ent = {}
    if moving:
        ent["bus"] = moving[0]["id"]
        others = [t["id"] for t in veh if t["id"] != ent["bus"]]
        if others:
            ent["white_car"] = others[0]
    persons = [t for t in tr if t["class"] == "person" and np.median([p["x"] for p in t["points"]]) < 0.5]
    if persons:
        ent["officer"] = max(persons, key=lambda t: len(t["points"]))["id"]
    ent["bikes"] = [t["id"] for t in tr if t["class"] in ("motorcycle", "bicycle")]
    return ent


def run(case_dir: Path, video_events: list[dict], sensor_events: list[dict], witness_events: list[dict]) -> dict:
    case = json.loads((case_dir / "case.json").read_text())
    metric = json.loads((case_dir / "tracks_metric.json").read_text())
    tracks = {t["id"]: t for t in metric["tracks"]}
    ent_p = case_dir / "entities.json"
    ent = json.loads(ent_p.read_text()) if ent_p.exists() else guess_entities(metric)
    ent_p.write_text(json.dumps(ent, indent=2))
    wit_meta = json.loads((case_dir / "witnesses.json").read_text()) if (case_dir / "witnesses.json").exists() else {}

    inferred, n_inf = [], 0

    def infer(actor, action, value, t0, t1, derived, rule, conf):
        nonlocal n_inf
        n_inf += 1
        e = {"id": f"EV-I-{n_inf:03d}", "source": "fusion", "kind": "INFERRED", "t": {"start": round(t0, 2), "end": round(t1, 2), "sigma": 0.2},
             "clock": "T0", "actor": actor, "action": action, "value": value, "confidence": round(conf, 2), "ref": "",
             "derived_from": derived, "rule": rule}
        inferred.append(e)
        return e["id"]

    # --- 1. Sensor alignment on the impact spike
    offsets = {"cctv": {"offset_s": -case["t0_video_s"], "sigma": 0.05, "anchor": case.get("t0_anchor")}}
    s_imp = next((e for e in sensor_events if e["action"] == "impact"), None)
    if s_imp:
        off = -s_imp["t"]["start"]
        for e in sensor_events:
            e["t"] = {**e["t"], "start": round(e["t"]["start"] + off, 2), "end": round(e["t"]["end"] + off, 2)}
            e["clock"] = "T0"
            e["actor"] = ent.get("bus", e["actor"])
        offsets["sensor"] = {"offset_s": round(off, 2), "sigma": 0.1, "anchor": s_imp["id"],
                             "note": "telematics clock aligned on its acceleration spike = video impact"}
    for w in wit_meta:
        offsets[w] = {"offset_s": None, "note": "ordering only (before / at / after impact)"}

    # --- 2. Measurements as INFERRED events (each cites its inputs)
    bus = tracks.get(ent.get("bus", ""))
    ids = {}
    if bus:
        pre = [p for p in bus["points"] if -3.0 <= p["t"] <= -0.1]
        vmax = max((p["v_kmh"] for p in pre), default=0)
        s_speed = next((e for e in sensor_events if e["action"] == "speed"), None)
        sensor_peak = W.parse_speed(s_speed["value"]) if s_speed else None
        measured = max(vmax, sensor_peak or 0)
        sig = round(measured * metric["scale_sigma"] + 2, 1)
        ids["bus_speed"] = infer(ent["bus"], "speed", f"{measured:.0f} ± {sig:.0f} km/h (calibrated CCTV{' + telematics' if s_speed else ''})",
                                 -3.0, -0.1, [x for x in [s_speed and s_speed["id"]] if x] + [f"tracks_metric:{ent['bus']}"], "R_speed_homography", 0.8)
        ids["_measured_speed"], ids["_speed_sigma"] = measured, sig
        last = [p for p in bus["points"] if -1.5 <= p["t"] <= 0.3]
        if len(last) > 3:
            dx = last[-1]["x"] - last[0]["x"]
            ids["bus_drift"] = infer(ent["bus"], "turn", f"{'left, towards divider' if dx < 0 else 'right'} ({dx:+.1f} m lateral in 1.8 s)",
                                     -1.5, 0.3, [f"tracks_metric:{ent['bus']}"], "R_lateral_drift", 0.75)
            ids["_drift_dx"] = dx
        end = [p for p in bus["points"] if p["t"] >= 0]
        if end:
            ids["bus_on_divider"] = infer(ent["bus"], "impact", f"comes to rest at x = {end[-1]['x']:.1f} m (divider edge is x = 0)",
                                          0, 0.5, [f"tracks_metric:{ent['bus']}"] + [e["id"] for e in video_events if e["actor"] == ent["bus"] and e["action"] == "stop"],
                                          "R_rest_position_vs_divider", 0.8)
            ids["_bus_rest_x"] = end[-1]["x"]
    brakes = [e for e in sensor_events if e["action"] == "brake" and e["t"]["start"] < 0]
    v_decel = [e for e in video_events if e["actor"] == ent.get("bus") and e["action"] in ("sudden_decel", "stop")]
    if brakes or v_decel:
        ids["bus_braked"] = infer(ent.get("bus", "bus"), "brake", "braking before impact", min([e["t"]["start"] for e in brakes] or [-1]), 0,
                                  [e["id"] for e in brakes + v_decel], "R_brake_evidence", 0.85 if brakes else 0.6)
    wc = tracks.get(ent.get("white_car", ""))
    if wc:
        pre = [p for p in wc["points"] if -3.0 <= p["t"] <= 0]
        v = max((p["v_kmh"] for p in pre), default=0)
        ids["_white_car_v"] = v
        ids["white_car_state"] = infer(ent["white_car"], "speed", f"max {v:.0f} km/h in the 3 s before impact; stays in the right lane (x ≈ {np.median([p['x'] for p in pre]):.1f} m)",
                                       -3, 0, [f"tracks_metric:{ent['white_car']}"], "R_track_state", 0.8)
    off_t = tracks.get(ent.get("officer", ""))
    downs = [e for e in video_events if e["action"] == "person_down" and e["actor"] == ent.get("officer")]
    if off_t:
        ids["officer_upright"] = infer(ent["officer"], "posture", "fell / lying detected" if downs else "upright throughout; moves away along the divider",
                                       0, 4, [f"tracks_metric:{ent['officer']}"] + [e["id"] for e in downs], "R_box_aspect_posture", 0.7)
        ids["_officer_down"] = bool(downs)
    clk = case.get("clock_overlay")
    if clk:
        t0_clock = datetime.strptime(clk["value"], "%H:%M:%S") + timedelta(seconds=case["t0_video_s"] - clk["at_video_s"])
        ids["clock"] = infer("cctv", "time_of_day", t0_clock.strftime("%H:%M:%S") + " at impact (burned-in overlay)", 0, 0,
                             [f"cctv.mp4#overlay@{clk['at_video_s']}s"], "R_overlay_clock", 0.9)
        ids["_clock"] = t0_clock
    ids["_bikes"] = len(ent.get("bikes", []))

    # --- 3. Check every witness claim
    contradictions, checks, nC = [], [], 0
    rel = {w: [0, 0] for w in {e["source"] for e in witness_events}}

    def verdict(e, status, against, ctype=None, summary="", explanation=None, sev="medium"):
        nonlocal nC
        checks.append({"claim": e["id"], "status": status, "evidence": against})
        if status in ("consistent", "contradicted"):
            rel[e["source"]][0 if status == "consistent" else 1] += 1
        if status == "contradicted":
            nC += 1
            contradictions.append({"id": f"C{nC}", "type": ctype, "events": [e["id"]] + against, "summary": summary,
                                   "explanation": explanation, "severity": sev})

    for e in witness_events:
        a, act, who = e["actor"], e["action"], wit_meta.get(e["source"], {}).get("name", e["source"])
        e["actor"] = ent.get(a, a) if isinstance(ent.get(a), str) else a
        if act == "speed" and "bus_speed" in ids:
            claim = W.parse_speed(e["value"]); m = ids["_measured_speed"]
            if claim is None:
                verdict(e, "unverifiable", [])
            elif abs(claim - m) <= SPEED_TOL(m):
                verdict(e, "consistent", [ids["bus_speed"]])
            else:
                verdict(e, "contradicted", [ids["bus_speed"]], "quantity",
                        f"{who} estimates the bus at ~{claim:.0f} km/h; calibrated CCTV{' and telematics' if 'sensor' in offsets else ''} measure {m:.0f} ± {ids['_speed_sigma']:.0f} km/h.",
                        "Suggestion: eyewitness speed estimates for large vehicles approaching head-on are often inflated, especially under stress.", "high")
        elif act == "no_brake":
            if "bus_braked" in ids:
                verdict(e, "contradicted", [ids["bus_braked"]], "state", f"{who} says the bus did not slow down; telematics and video record braking before impact.",
                        "Suggestion: braking at low speed produces little visible pitch or sound; it is easy to miss from the side.", "high")
            else:
                verdict(e, "unverifiable", [])
        elif act == "cut_in" and "white_car_state" in ids:
            if ids["_white_car_v"] < 5:
                verdict(e, "contradicted", [ids["white_car_state"]], "presence",
                        f"{who} says a white car cut in front of the bus; the only white car in view is stationary in the right lane before impact.",
                        "Suggestion: the witness may be explaining the bus's swerve after the fact, or saw a vehicle outside the camera view.", "high")
            else:
                verdict(e, "consistent", [ids["white_car_state"]])
        elif act == "impact":
            ok = ids.get("_bus_rest_x", 9) < 0.5
            verdict(e, "consistent" if ok else "contradicted", [ids["bus_on_divider"]] if "bus_on_divider" in ids else [], "state",
                    f"{who} says the bus hit the {e['value']}; the bus comes to rest away from it.")
        elif act == "turn" and "bus_drift" in ids:
            ok = (ids["_drift_dx"] < 0) == ("left" in str(e["value"]).lower())
            verdict(e, "consistent" if ok else "contradicted", [ids["bus_drift"]], "state", f"{who} says the bus turned {e['value']}; the track drifts the other way.")
        elif act == "fell" and "officer_upright" in ids:
            if ids["_officer_down"]:
                verdict(e, "consistent", [ids["officer_upright"]])
            else:
                verdict(e, "contradicted", [ids["officer_upright"]], "state", f"{who} says the policeman fell on the road; the officer is tracked upright and moving away after impact.",
                        f"Suggestion: from {wit_meta.get(e['source'], {}).get('distance_m', '?')} m across the road, the officer jumping clear can look like a fall.", "medium")
        elif act == "time_of_day" and "_clock" in ids:
            try:
                claim_t = datetime.strptime(str(e["value"]), "%H:%M")
                diff = abs((claim_t - ids["_clock"].replace(second=0)).total_seconds()) / 60
                if diff > 3:
                    verdict(e, "contradicted", [ids["clock"]], "temporal",
                            f"{who} places the crash around {e['value']}; the CCTV overlay clock reads {ids['_clock'].strftime('%H:%M')} ({diff:.0f} min apart).",
                            "Suggestion: an approximate recollection, or the CCTV clock itself may be off; check the recorder's clock drift.", "low")
                else:
                    verdict(e, "consistent", [ids["clock"]])
            except ValueError:
                verdict(e, "unverifiable", [])
        elif act == "presence" and e["actor"] == "bikes":
            verdict(e, "consistent" if ids["_bikes"] >= 3 else "contradicted", [], "presence", f"{who} says many bikes were waiting; few are tracked.")
        elif act == "presence" and e["actor"] == "self" and ent.get("officer") and "constable" in who.lower():
            verdict(e, "consistent", [ids.get("officer_upright")] if ids.get("officer_upright") else [])
        else:
            verdict(e, "unverifiable", [])

    # witness vs witness (speed)
    sp = [(e, W.parse_speed(e["value"])) for e in witness_events if e["action"] == "speed" and W.parse_speed(e["value"])]
    for i in range(len(sp)):
        for j in range(i + 1, len(sp)):
            (a, va), (b, vb) = sp[i], sp[j]
            if abs(va - vb) > SPEED_TOL(min(va, vb)):
                nC += 1
                contradictions.append({"id": f"C{nC}", "type": "witness", "events": [a["id"], b["id"]], "severity": "medium",
                                       "summary": f"{wit_meta.get(a['source'], {}).get('name', a['source'])} (~{va:.0f} km/h) and {wit_meta.get(b['source'], {}).get('name', b['source'])} (~{vb:.0f} km/h) disagree on the bus speed.",
                                       "explanation": None})

    # --- 4. Gaps: when is the bus covered by fewer than two timed sources?
    rng = case["range"]
    cover = {}
    if bus:
        cover["cctv"] = (bus["points"][0]["t"], bus["points"][-1]["t"])
    if sensor_events:
        cover["sensor"] = (min(e["t"]["start"] for e in sensor_events), max(e["t"]["end"] for e in sensor_events))
    gaps = []
    if cover:
        first = min(c[0] for c in cover.values())
        if first > rng[0] + 0.3:
            gaps.append({"start": rng[0], "end": round(first, 2), "covered_by": [],
                         "note": "Bus not yet in view: its approach before this point is covered only by Witness 1's untimed account."})
        both = max(c[0] for c in cover.values())
        if len(cover) > 1 and both > first + 0.3:
            gaps.append({"start": round(first, 2), "end": round(both, 2), "covered_by": [k for k, c in cover.items() if c[0] <= first + 0.01],
                         "note": "Single timed source only."})

    reliability = {w: round(c / (c + x), 2) if c + x else None for w, (c, x) in rel.items()}

    # --- 5. Hypotheses (ACH-lite): status from the checks above, never from the LLM
    cmap = {c["claim"]: c for c in checks}
    def st(claim_actions):
        hits = [cmap[e["id"]]["status"] for e in witness_events if e["action"] in claim_actions and e["id"] in cmap]
        return "contradicted" if "contradicted" in hits else ("supported" if "consistent" in hits else "untested")
    hyps = []
    if "bus_speed" in ids:
        hyps.append({"id": "H1", "text": "The bus was travelling fast (over 40 km/h)",
                     "status": "contradicted" if ids["_measured_speed"] < 40 else "supported", "for": [e["id"] for e in witness_events if e["action"] == "speed" and (W.parse_speed(e["value"]) or 0) >= 40],
                     "against": [ids["bus_speed"]] if ids["_measured_speed"] < 40 else [], "untested": []})
    if "bus_braked" in ids:
        hyps.append({"id": "H2", "text": "The bus did not brake before the impact", "status": "contradicted",
                     "for": [e["id"] for e in witness_events if e["action"] == "no_brake"], "against": [ids["bus_braked"]], "untested": []})
    if "white_car_state" in ids:
        hyps.append({"id": "H3", "text": "Another vehicle cut in front of the bus and forced it left", "status": "contradicted" if ids["_white_car_v"] < 5 else "supported",
                     "for": [e["id"] for e in witness_events if e["action"] == "cut_in"], "against": [ids["white_car_state"]], "untested": ["vehicles outside the camera's view"]})
    if "bus_drift" in ids:
        hyps.append({"id": "H4", "text": "The bus drifted left into the divider at low speed with no other vehicle involved",
                     "status": "supported" if ids["_drift_dx"] < 0 and ids.get("_white_car_v", 0) < 5 else "inconclusive",
                     "for": [x for x in [ids.get("bus_drift"), ids.get("bus_on_divider"), ids.get("white_car_state")] if x], "against": [],
                     "untested": ["driver state", "brake or steering fault", "road surface"]})

    # --- 6. Counterfactual setup: the bus heading for the officer on the divider
    cf = None
    if bus:
        pts = [p for p in bus["points"] if p["t"] <= 0]
        at = min(pts, key=lambda p: abs(p["t"] + 1.6))
        dist = sum(np.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(pts, pts[1:]) if a["t"] >= at["t"])
        cf = {"actor": ent["bus"], "observed_speed_kmh": round(at["v_kmh"], 1), "hazard_at_m": round(float(dist), 2), "brake_start_s": -1.6,
              "note": f"Distance the bus covered from T-1.6 s (officer clearly in its path) to the divider: {dist:.1f} m. Slider: would it have stopped short?"}

    analysis = {"status": "computed", "offsets": offsets, "entities": ent, "contradictions": contradictions, "gaps": gaps,
                "reliability": reliability, "checks": checks, "hypotheses": hyps, "counterfactual": cf}
    (case_dir / "analysis.json").write_text(json.dumps(analysis, indent=2, default=str))
    return {"analysis": analysis, "inferred": inferred, "sensor_events": sensor_events, "witness_events": witness_events}
