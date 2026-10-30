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
            from .pipeline.dashcam import ttc_crossing
            ttc3, ttc15 = ttc_crossing(rel, 3.0), ttc_crossing(rel, 1.5)
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
    return out
