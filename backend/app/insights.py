"""Key findings: what the reconstruction tells you that the raw video does not. Each finding is a number tied to a moment
and a place (so the UI can pop it up on the map at that time), with the evidence it rests on.

CCTV and dashcam share: first sighting, peak speed, braking onset (and how far from impact it began), whether a stop was
physically possible, closest approach to each involved road user, post-impact travel, and each witness's line of sight.
Dashcam adds: hazard first visible, time-to-collision thresholds and the driver's reaction time."""
import json
import math
from pathlib import Path

import numpy as np

G, MU, REACT = 9.81, 0.7, 1.0
DIMS = {"bus": (9.0, 2.5), "truck": (8.0, 2.5), "car": (4.4, 1.8), "motorcycle": (2.0, 0.7), "bicycle": (1.8, 0.5)}


def at(tr, t):
    p = tr["points"]
    if t <= p[0]["t"]: return p[0]
    if t >= p[-1]["t"]: return p[-1]
    i = next(i for i, q in enumerate(p) if q["t"] >= t)
    a, b = p[i - 1], p[i]
    k = (t - a["t"]) / ((b["t"] - a["t"]) or 1)
    return {"t": t, "x": a["x"] + (b["x"] - a["x"]) * k, "y": a["y"] + (b["y"] - a["y"]) * k, "v_kmh": a["v_kmh"] + (b["v_kmh"] - a["v_kmh"]) * k}


def live(tr, t):
    return tr["points"][0]["t"] - 0.05 <= t <= tr["points"][-1]["t"] + 0.05


def path_len(tr, t0, t1):
    pts = [p for p in tr["points"] if t0 <= p["t"] <= t1]
    return float(sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(pts, pts[1:])))


def stop_dist(v_kmh, react=REACT):
    v = v_kmh / 3.6
    return v * react + v * v / (2 * MU * G)


def heading(tr, t):
    b = at(tr, t)
    for back in np.arange(0.5, 4.0, 0.25):
        a = at(tr, t - back)
        if math.hypot(b["x"] - a["x"], b["y"] - a["y"]) > 0.8:
            return math.atan2(b["x"] - a["x"], b["y"] - a["y"])
    return 0.0


def blocker(wp, pp, tracks, t, skip, large):
    for tr in tracks:
        if tr["id"] in skip or tr["class"] not in DIMS or not live(tr, t):
            continue
        L, Wd = DIMS["bus"] if tr["id"] in large else DIMS[tr["class"]]
        q, h = at(tr, t), heading(tr, t)
        c, s = math.cos(-h), math.sin(-h)
        for k in np.arange(0.05, 0.95, 0.05):
            dx, dy = wp[0] + (pp[0] - wp[0]) * k - q["x"], wp[1] + (pp[1] - wp[1]) * k - q["y"]
            lx, ly = dx * c - dy * s, dx * s + dy * c
            if abs(lx) < Wd / 2 and abs(ly) < L / 2:
                return tr["id"]
    return None


def build(case_dir: Path) -> list[dict]:
    metric = json.loads((case_dir / "tracks_metric.json").read_text())
    an = json.loads((case_dir / "analysis.json").read_text())
    events = json.loads((case_dir / "events.json").read_text())
    wit = json.loads((case_dir / "witnesses.json").read_text()) if (case_dir / "witnesses.json").exists() else {}
    dc = json.loads((case_dir / "dashcam.json").read_text()) if (case_dir / "dashcam.json").exists() else None
    ent = an["entities"]
    names = ent.get("names", {})
    nm = lambda i: names.get(i, i).replace(" (primary)", "")
    tracks = {t["id"]: t for t in metric["tracks"]}
    prim = tracks.get(ent.get("primary") or "")
    sig = metric.get("scale_sigma", 0.3)
    out = []

    def add(t, kind, title, detail, actor=None, xy=None, evidence=(), importance=2):
        out.append({"id": f"K{len(out) + 1}", "t": round(float(t), 2), "kind": kind, "title": title, "detail": detail, "actor": actor,
                    "xy": [round(float(xy[0]), 2), round(float(xy[1]), 2)] if xy is not None else None, "evidence": list(evidence), "importance": importance})

    if prim:
        P = nm(prim["id"])
        ix = ent.get("impact_xy") or [at(prim, 0)["x"], at(prim, 0)["y"]]
        first = prim["points"][0]
        dash = dc is not None and prim["id"] == "ego"
        if first["t"] < -0.5 and not dash:
            d = path_len(prim, first["t"], 0)
            add(first["t"], "moment", f"{P} first seen", f"{d:.0f} m before the impact point, moving at {first['v_kmh']:.0f} km/h ({-first['t']:.1f} s before impact).",
                prim["id"], (first["x"], first["y"]), [f"tracks_metric:{prim['id']}"])
        pre = [p for p in prim["points"] if p["t"] <= 0]
        if dash and pre:
            last = [p["v_kmh"] for p in pre if p["t"] >= -1.0]
            if last:
                v1 = float(np.mean(last))
                add(-0.5, "measure", f"Speed before impact ≈ {v1:.0f} ± {v1 * sig + 3:.0f} km/h",
                    f"Average speed of the camera vehicle over the last second, estimated from how fast the road surface streams past (±{sig * 100:.0f}%).",
                    prim["id"], (pre[-1]["x"], pre[-1]["y"]), ["dashcam.json#ego_series"], 3)
        elif pre:
            pk = max(pre, key=lambda p: p["v_kmh"])
            add(pk["t"], "measure", f"Peak speed {pk['v_kmh']:.0f} ± {pk['v_kmh'] * sig + 2:.0f} km/h",
                f"{P} was at its fastest {-pk['t']:.1f} s before impact. Uncertainty comes from the road calibration (±{sig * 100:.0f}%).",
                prim["id"], (pk["x"], pk["y"]), [f"tracks_metric:{prim['id']}"])
        brake = next((e for e in events if e["action"] == "brake" and e["actor"] == prim["id"] and e["t"]["start"] < 0.05), None)
        if brake:
            tb = brake["t"]["start"]
            vb = at(prim, tb)["v_kmh"]
            left = path_len(prim, tb, 0)
            need = stop_dist(vb, react=0)
            add(tb, "moment", f"Braking began {-tb:.1f} s before impact",
                f"At {vb:.0f} km/h with {left:.1f} m left to the impact point. Braking alone needs about {need:.1f} m to stop from that speed{', so it could not stop in time' if need > left + 0.3 else ', so a stop was possible'}.",
                prim["id"], (at(prim, tb)["x"], at(prim, tb)["y"]), [brake["id"]], 3)
        else:
            add(-0.5, "warning", "No braking detected before impact", f"Neither the video track nor telematics shows {P} slowing before the impact.", prim["id"], ix, [], 3)
        tv = -1.6
        if live(prim, tv):
            v = at(prim, tv)["v_kmh"]
            avail = path_len(prim, tv, 0)
            need = stop_dist(v)
            vmax = math.sqrt(max(0.0, 2 * MU * G * max(avail - 0, 0) + (MU * G * REACT) ** 2) - MU * G * REACT) * 3.6 if avail > 0 else 0
            add(tv, "counterfactual", "Could it have stopped?",
                f"1.6 s before impact {P} was at {v:.0f} km/h with {avail:.1f} m to go. A full stop (1 s reaction + braking) needs {need:.1f} m. "
                f"{'It could not stop in time' if need > avail else 'A stop was possible'}; the highest speed that would have allowed a stop is about {vmax:.0f} km/h.",
                prim["id"], (at(prim, tv)["x"], at(prim, tv)["y"]), [f"tracks_metric:{prim['id']}"], 3)
        for oid in ent.get("involved", []):
            o = tracks.get(oid)
            if not o:
                continue
            best = min(((math.hypot(at(o, t)["x"] - at(prim, t)["x"], at(o, t)["y"] - at(prim, t)["y"]), t) for t in np.arange(-1.5, 2.0, 0.1)
                        if live(o, t) and live(prim, t)), default=None)
            if best:
                d, t = best
                q = at(o, t)
                add(t, "measure", f"Closest approach: {nm(oid)}", f"{nm(oid)} came within {max(d - 1.0, 0):.1f} m of {P}'s body ({d:.1f} m centre to centre) at T{t:+.1f} s.",
                    oid, (q["x"], q["y"]), [f"tracks_metric:{oid}"], 3 if tracks[oid]["class"] == "person" else 2)
        post = [p for p in prim["points"] if p["t"] >= 0]
        if len(post) > 3 and not dash:   # a dashcam's own motion after impact is a tumble, not a measurement
            moved = path_len(prim, 0, post[-1]["t"])
            rest = next((p for i, p in enumerate(post) if all(q["v_kmh"] < 3 for q in post[i:])), None)
            if rest:
                add(rest["t"], "moment", f"{P} at rest", f"It travelled {moved:.1f} m after the impact and stopped {rest['t']:.1f} s later.", prim["id"], (rest["x"], rest["y"]), [f"tracks_metric:{prim['id']}"])
        large = set(ent.get("large", []))
        for w, m in wit.items():
            if not m.get("position_m"):
                continue
            ts = [t for t in np.arange(-3.0, 0.01, 0.1) if live(prim, t)]
            hits = [(t, blocker(m["position_m"], (at(prim, t)["x"], at(prim, t)["y"]), list(tracks.values()), t, {prim["id"]}, large)) for t in ts]
            blocked = [(t, b) for t, b in hits if b]
            if ts:
                frac = len(blocked) / len(ts)
                by = max(set(b for _, b in blocked), key=[b for _, b in blocked].count) if blocked else None
                add(blocked[0][0] if blocked else -3.0, "visibility", f"{m.get('name', w)}: line of sight",
                    (f"View of {P} blocked for {len(blocked) * 0.1:.1f} of the last {len(ts) * 0.1:.1f} s before impact (mostly by {nm(by)})." if blocked
                     else f"Clear view of {P} throughout the last {len(ts) * 0.1:.1f} s before impact."),
                    w, tuple(m["position_m"]), [f"{w}.txt"], 3 if frac > 0.3 else 1)

    if dc and dc.get("t0_method", "").startswith("no collision"):
        add(0, "warning", "No collision detected", "The camera never jolts and no vehicle fills the frame, so this clip looks like normal driving. T0 marks the moment of largest camera motion, not an impact.", "ego", None, ["dashcam.json#t0_method"], 3)
    if dc:
        hz = dc.get("hazard")
        rel = dc.get("relative", {}).get(hz) if hz else None
        ego = tracks.get("ego")
        if rel:
            f0 = rel[0]
            vh = at(ego, f0["t"])["v_kmh"] if ego else None
            add(f0["t"], "moment", f"Hazard visible: {nm(hz)}", f"First seen {f0['Z']:.0f} m ahead, {abs(f0['X']):.1f} m {'left' if f0['X'] < 0 else 'right'} of the camera's line"
                + (f", with the camera vehicle at {vh:.0f} km/h." if vh is not None else "."), hz, (at(tracks[hz], f0["t"])["x"], at(tracks[hz], f0["t"])["y"]) if hz in tracks else None, [f"dashcam.json#{hz}"], 3)
            # What the vehicle ahead did: came across into the camera vehicle's lane, and how fast it was still going
            from .pipeline.dashcam import lane_entry
            pre = [r for r in rel if r["t"] <= 0.2]
            le = lane_entry(rel)
            far, inlane = ([le["from"]], le["entered"]) if le else ([], None)
            if far and inlane:
                add(inlane["t"], "moment", f"{nm(hz)} moved into the camera vehicle's lane",
                    f"It came {abs(far[0]['X']):.1f} m across from the {'left' if far[0]['X'] < 0 else 'right'} (T{far[0]['t']:+.1f} s) to {abs(inlane['X']):.1f} m off the camera's line "
                    f"by T{inlane['t']:+.1f} s, {inlane['Z']:.0f} m ahead.", hz, None, [f"dashcam.json#{hz}"], 3)
            last = [r for r in pre if -1.5 <= r["t"] <= 0 and abs(r["closing_ms"]) < 40]
            closing = None
            if ego and len(last) >= 4:
                closing = float(np.median([r["closing_ms"] for r in last])) * 3.6
                v_ego = float(np.median([at(ego, r["t"])["v_kmh"] for r in last]))
                v_lead = max(0.0, v_ego - closing)
                add(-0.75, "measure", f"{nm(hz)} ahead at ≈ {v_lead:.0f} km/h" + (" (nearly stopped in the lane)" if v_lead < 12 else ""),
                    f"In the last 1.5 s the camera vehicle ({v_ego:.0f} km/h) was closing on it at about {closing:.0f} km/h, so it was doing about {v_lead:.0f} km/h"
                    + (": it had braked to almost a standstill in a running lane." if v_lead < 12 else "."), hz, None, [f"dashcam.json#{hz}"], 3 if v_lead < 12 else 2)
            if far and inlane and closing is not None and closing > 0:
                # The obstacle only existed from the moment it entered the lane: judge the stop from there, on the closing speed.
                vc = closing / 3.6
                need = vc * REACT + vc * vc / (2 * MU * G)
                out[:] = [k for k in out if k["kind"] != "counterfactual"]
                add(inlane["t"], "counterfactual", "Could the rider have avoided it?",
                    f"When {nm(hz)} entered the lane {-inlane['t']:.1f} s before impact it was {inlane['Z']:.1f} m ahead and the gap was closing at about {closing:.0f} km/h. "
                    f"Avoiding contact needed about {need:.1f} m (1 s reaction + braking): "
                    + ("there wasn't room, which is consistent with the rider being unable to avoid it once the vehicle was in the lane. This doesn't establish fault." if need > inlane["Z"] else
                       "there was room to stop if the rider had reacted within about 1 s."), "ego", None, [f"dashcam.json#{hz}"], 3)
            from .pipeline.dashcam import ttc_crossing
            # a vehicle off to the side isn't on a collision course yet; closing speeds over 140 km/h are tracking noise
            in_lane = [r for r in rel if abs(r["closing_ms"]) < 40 and (r["t"] >= inlane["t"] - 0.3 if (far and inlane) else abs(r["X"]) < 1.5)]
            ttc3, ttc15 = ttc_crossing(in_lane, 3.0), ttc_crossing(in_lane, 1.5)
            if far and inlane:
                for k in out:
                    if k["kind"] == "moment" and k["title"].startswith("Braking began") and k["t"] < inlane["t"]:
                        k["detail"] = k["detail"].split(" Braking alone")[0] + f" The rider was already braking {inlane['t'] - k['t']:.1f} s before {nm(hz)} came into the lane."
            for thr, x in ((3.0, ttc3), (1.5, ttc15)):
                if x:
                    add(x["t"], "warning", f"Time-to-collision below {thr:.1f} s", f"{x['Z']:.1f} m apart and closing at {x['closing_ms'] * 3.6:.0f} km/h at T{x['t']:+.1f} s.",
                        hz, (at(tracks[hz], x["t"])["x"], at(tracks[hz], x["t"])["y"]) if hz in tracks else None, [f"dashcam.json#{hz}"], 3 if thr < 2 else 2)
            brake = next((e for e in events if e["action"] == "brake" and e["actor"] == "ego"), None)
            ref = ttc3 or f0
            if brake and ref and brake["t"]["start"] >= ref["t"]:
                rt = brake["t"]["start"] - ref["t"]
                add(brake["t"]["start"], "measure", f"Reaction time ≈ {rt:.1f} s",
                    f"Braking began {rt:.1f} s after the hazard {'reached a 3 s time-to-collision' if ref is ttc3 else 'became visible'} "
                    f"(typical perception-reaction time is 1.0–1.5 s).", "ego", None, [brake["id"]], 3)
            elif brake:
                add(brake["t"]["start"], "measure", "Slowing began before the hazard became critical",
                    f"The camera vehicle was already slowing {-brake['t']['start']:.1f} s before impact, before the time-to-collision fell below 3 s.", "ego", None, [brake["id"]], 2)
            elif ref:
                add(0, "warning", "No braking before impact", "The camera vehicle shows no clear deceleration before the impact.", "ego", None, [], 3)
    out.sort(key=lambda k: k["t"])
    (case_dir / "insights.json").write_text(json.dumps(out, indent=2))
    try:   # the vision model's reading of the sequence, grounded in these findings and checked against them
        k = vision_reading(case_dir, an, out, dc)
        if k:
            out.append(k)
            out.sort(key=lambda k: k["t"])
            (case_dir / "insights.json").write_text(json.dumps(out, indent=2))
    except Exception:
        pass
    return out


PERSON_WORDS = ("police", "constable", "officer", "pedestrian", "person", "man", "woman", "policeman")


def vision_reading(case_dir: Path, an: dict, out: list[dict], dc: dict | None) -> dict | None:
    """Ask the vision model what happened (before / impact / after, with the measured facts), then check its 'first change'
    against what was measured to change first. Agreement is shown as support; disagreement is flagged and the measurements stand."""
    from .pipeline import vision
    vp = case_dir / "vision.json"
    vis = json.loads(vp.read_text()) if vp.exists() else {}
    case = json.loads((case_dir / "case.json").read_text())
    if not vis.get("frames"):
        return None
    seq = vision.sequence(case_dir, vis["frames"], (case.get("camera") or {}).get("type") == "dashcam")
    if not seq or seq.get("error"):
        return None
    names, ent = an["entities"].get("names", {}), an["entities"]
    nm = lambda i: (names.get(i) or i or "").replace(" (primary)", "").lower()
    who, act = str((seq.get("first_change") or {}).get("who", "")).lower(), str((seq.get("first_change") or {}).get("action", ""))
    expected, why = None, None
    lane = next((k for k in out if k["title"].endswith("moved into the camera vehicle's lane")), None)
    if lane:
        expected, why = (nm(lane["actor"]), {"cut_in", "changed_lane", "braked_suddenly", "stopped_in_lane"}), lane["title"]
    elif any(h["id"] == "H4" and h["status"] == "supported" for h in an.get("hypotheses", [])):
        expected, why = (nm(ent.get("primary")), {"lost_control", "changed_lane", "turned_across", "cut_in"}), next(h["text"] for h in an["hypotheses"] if h["id"] == "H4")
    blames_person = any(w in who for w in PERSON_WORDS) and act not in ("none_visible",)
    if expected:
        generic = {"car", "vehicle", "the", "van", "sedan", "hatchback"}   # "car" names every car: match on colour / kind
        words = [w for w in expected[0].split() if len(w) > 2 and w not in generic] or expected[0].split()
        agrees = any(w in who for w in words) and act != "none_visible" and not blames_person
        check = "agrees" if agrees else "overruled"
        note = (" This agrees with the measurements." if agrees else
                f" This doesn't match what was measured ({why}); the measurements stand.")
    else:
        check = "overruled" if blames_person else "unverified"
        note = (" It puts the start on a person on foot, which nothing measured supports; set aside." if blames_person else
                " Nothing measured confirms or rules out who changed the situation first.")
    seq["check"] = check
    vis["sequence"] = seq
    vp.write_text(json.dumps(vis, indent=2))
    return {"id": "K-vision", "t": -1.0, "kind": "vision", "title": "Vision model's reading" + {"agrees": "", "overruled": " (overruled)", "unverified": " (unverified)"}[check],
            "detail": str(seq.get("sequence", "")).strip() + note, "actor": None, "xy": None, "evidence": ["vision.json#sequence"], "importance": 3 if check == "agrees" else 1}
