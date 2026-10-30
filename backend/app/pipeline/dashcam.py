"""OWNER: P1. Dashcam / helmet-cam analysis: the camera is IN one of the vehicles (the "ego" vehicle).

From background optical flow (video.py) and the detector boxes, with no calibration clicks:
  - focus of expansion (FOE) = vanishing point of forward motion -> horizon row and image centre of travel
  - ego speed: a road point at row v is at distance Z = f*h/(v - v_h); while driving forward it slides down the image at
    dv/dt = (v - v_h)^2 / (f*h) * speed, so speed = (dv/dt) * Z^2 / (f*h), median over many ground points per frame pair
  - impact time: the violent jolt (background flow jumps far above its running level) or a vehicle filling the frame
  - distance to each road user: from its box size (known real size per class) and its ground contact row; bearing from u
  - closing speed, time-to-collision (TTC) to whatever is in the ego's path, the hazard, and braking onset
Everything is then put in a world frame by integrating ego speed (straight-line), so the shared reconstruction, fusion,
severity and witness checks work unchanged. Accuracy is coarse (about +/-30%) and is reported as such."""
import json
from pathlib import Path

import numpy as np

REAL_H = {"person": 1.7, "car": 1.5, "bus": 3.0, "truck": 3.2, "motorcycle": 1.3, "bicycle": 1.1}
REAL_W = {"person": 0.5, "car": 1.8, "bus": 2.5, "truck": 2.5, "motorcycle": 0.8, "bicycle": 0.6}


def _smooth(a, k=5):
    a = np.asarray(a, float)
    if len(a) < k:
        return a
    return np.convolve(np.pad(a, (k // 2, k - 1 - k // 2), mode="edge"), np.ones(k) / k, mode="valid")


def hampel(a, k=7, tol=0.35):
    """Mask of values within tol (relative) of their rolling median."""
    a = np.asarray(a, float)
    keep = np.ones(len(a), bool)
    for i in range(len(a)):
        m = np.median(a[max(0, i - k // 2): i + k // 2 + 1])
        keep[i] = abs(a[i] - m) <= tol * max(m, 1e-3)
    return keep


def ttc_crossing(rel: list[dict], thr: float):
    """First time TTC stays below thr for 3 consecutive readings with a physically plausible closing speed (< 120 km/h)."""
    ok = [x["ttc"] is not None and x["ttc"] < thr and 0 < x["closing_ms"] * 3.6 < 120 and x["t"] <= 0.1 for x in rel]
    for i in range(len(rel) - 2):
        if ok[i] and ok[i + 1] and ok[i + 2]:
            return rel[i]
    return None


def focus_of_expansion(flow: list[dict], W: int, H: int) -> tuple[float, float]:
    """Least-squares point closest to every flow line (u,v)+s*(du,dv); robust re-weighting drops outliers."""
    P, D = [], []
    for s in flow:
        for u, v, du, dv in s["pts"]:
            m = np.hypot(du, dv)
            if m > 0.8:
                P.append((u, v)); D.append((du / m, dv / m))
    if len(P) < 30:
        return W / 2, H * 0.45
    P, D = np.array(P), np.array(D)
    w = np.ones(len(P))
    x = np.array([W / 2, H * 0.45])
    for _ in range(5):
        A, b = np.zeros((2, 2)), np.zeros(2)
        for (p, d, wi) in zip(P, D, w):
            M = np.eye(2) - np.outer(d, d)
            A += wi * M; b += wi * M @ p
        x = np.linalg.solve(A + 1e-6 * np.eye(2), b)
        r = np.abs((P[:, 0] - x[0]) * D[:, 1] - (P[:, 1] - x[1]) * D[:, 0])   # perpendicular distance to each line
        w = (r < np.percentile(r, 60)).astype(float)
    return float(np.clip(x[0], 0.2 * W, 0.8 * W)), float(np.clip(x[1], 0.15 * H, 0.7 * H))


def ego_speed(flow: list[dict], W: int, H: int, cam_h: float, f: float, vh: float) -> list[dict]:
    out = []
    for s in flow:
        sp = []
        for u, v, du, dv in s["pts"]:
            if v < vh + 0.08 * H or v > 0.88 * H or abs(du) + abs(dv) < 0.3:   # ground only; skip hood / static parts
                continue
            Z = f * cam_h / (v - vh)
            if Z > 40:
                continue
            sp.append((dv / max(s["dt"], 1e-3)) * Z * Z / (f * cam_h))
        sp = [x for x in sp if x > 0]
        out.append({"t": s["t"], "v": float(np.median(sp)) if len(sp) >= 5 else np.nan, "n": len(sp), "mag": s["mag"] / max(s["dt"], 1e-3) / W})
    v = np.array([o["v"] for o in out], float)
    ok = ~np.isnan(v)
    if ok.sum() >= 2:
        v = np.interp(np.arange(len(v)), np.where(ok)[0], v[ok])
        v = np.minimum(_smooth(np.minimum(v, 45), 15), 45)
    for o, x in zip(out, v):
        o["v"] = round(float(x), 2) if not np.isnan(x) else None
    return out


def ego_body(tracks: dict, W: int, H: int, dur: float) -> list[str]:
    """The camera vehicle's own hood / handlebars / dash: low in the frame and nearly fixed in the image."""
    out = []
    for tid, t in tracks.items():
        b = np.array([q["box"] for q in t["points"]])
        if len(b) < 6:
            continue
        low = np.mean(b[:, 3] > 0.8 * H)
        cx = (b[:, 0] + b[:, 2]) / 2
        fixed = np.std(cx) < 0.08 * W and np.std(b[:, 3]) < 0.08 * H
        big = np.median(b[:, 2] - b[:, 0]) > 0.25 * W
        span = (t["points"][-1]["t"] - t["points"][0]["t"]) / max(dur, 1e-3)
        own_bike = t["class"] == "motorcycle" and np.median(b[:, 3]) > 0.7 * H and big and span > 0.4   # handlebars / tank
        if (fixed and (low > 0.6 or (big and span > 0.5))) or own_bike:
            out.append(tid)
    return out


def impact_time(series: list[dict], tracks: dict, W: int) -> tuple[float, str]:
    """The jolt: background flow far above its running median, or a vehicle box wider than 55% of the frame."""
    mags = np.array([s["mag"] for s in series])
    ts = np.array([s["t"] for s in series])
    jolt = None
    base = np.median(mags[: max(5, int(len(mags) * 0.4))]) if len(mags) else 0
    for i in range(1, len(mags) - 1):   # sustained: this sample and the next both far above the clip's normal shake
        if mags[i] > max(5 * base, 0.8) and mags[i + 1] > max(3 * base, 0.5):
            jolt = float(ts[i]); break
    fill = None
    for t in tracks.values():
        if t["class"] in ("car", "bus", "truck", "motorcycle"):
            for q in t["points"]:
                if q["box"][2] - q["box"][0] > 0.62 * W:
                    fill = q["t"] if fill is None else min(fill, q["t"]); break
    dur = float(ts[-1]) if len(ts) else 0.0
    if jolt is not None:   # a frame-filling vehicle only counts as contact just before the jolt (cars pass close all the time)
        return (fill, "vehicle fills the frame just before the jolt") if fill is not None and jolt - 1.0 <= fill <= jolt else (jolt, "camera jolt (background flow spike)")
    if fill is not None and fill > 0.2 * dur:
        return fill, "vehicle fills the frame"
    return (float(ts[int(np.argmax(mags))]) if len(ts) else 0.0), "no collision detected (largest background motion used as reference)"


def analyse(case_dir: Path, ego_class: str = "car") -> dict:
    tr = json.loads((case_dir / "tracks.json").read_text())
    info, tracks = tr["video"], tr["tracks"]
    W, H = info["width"], info["height"]
    flow = info.get("ego_flow", [])
    cam_h = 1.25 if ego_class == "motorcycle" else 1.35
    f = W / (2 * np.tan(np.radians(70 / 2)))
    cx, vh = focus_of_expansion(flow, W, H)
    series = ego_speed(flow, W, H, cam_h, f, vh)
    body = ego_body(tracks, W, H, info["duration"])
    t0, how = impact_time(series, {k: v for k, v in tracks.items() if k not in body}, W)
    res = {"params": {"focal_px": round(f, 1), "horizon_row": round(vh, 1), "foe_x": round(cx, 1), "cam_height_m": cam_h, "hfov_deg": 70, "ego_class": ego_class},
           "t0_video_s": round(t0, 2), "t0_method": how, "ego_series": series, "ego_body": body}
    (case_dir / "dashcam.json").write_text(json.dumps(res))
    return res


def to_metric(case_dir: Path) -> dict:
    """World-frame tracks (ego straight along +y) for the shared reconstruction + per-track distance / TTC."""
    dc = json.loads((case_dir / "dashcam.json").read_text())
    tr = json.loads((case_dir / "tracks.json").read_text())
    info, tracks = tr["video"], tr["tracks"]
    W, H = info["width"], info["height"]
    p = dc["params"]
    f, vh, cx, cam_h = p["focal_px"], p["horizon_row"], p["foe_x"], p["cam_height_m"]
    t0 = dc["t0_video_s"]
    s = [x for x in dc["ego_series"] if x["v"] is not None]
    ts = np.array([x["t"] for x in s]) - t0
    vs = np.array([x["v"] for x in s])
    # integrate ego position; freeze after impact (the camera tumbles, flow is meaningless)
    vs_used = np.where(ts <= 0.2, vs, 0.0)
    y_ego = np.concatenate([[0], np.cumsum(0.5 * (vs_used[1:] + vs_used[:-1]) * np.diff(ts))]) if len(ts) > 1 else np.zeros(len(ts))
    y_ego -= np.interp(0, ts, y_ego) if len(ts) else 0
    ego_y = lambda t: float(np.interp(t, ts, y_ego)) if len(ts) else 0.0
    ego_v = lambda t: float(np.interp(t, ts, vs)) if len(ts) else 0.0

    out, rel = [], {}
    ego_pts = [{"t": round(float(t), 3), "x": 0.0, "y": round(float(y), 2), "v_kmh": round(float(v) * 3.6 if t <= 0.2 else 0.0, 1),
                "v_sigma": round(float(v) * 3.6 * 0.3 + 3, 1)} for t, y, v in zip(ts, y_ego, vs)]
    if len(ego_pts) >= 3:   # no usable road flow (e.g. stationary or night) -> no ego track; others stay camera-relative
        out.append({"id": "ego", "class": p["ego_class"], "colour": "#4f8cff", "colour_name": None, "points": ego_pts})
    for tid, t in tracks.items():
        cls = t["class"]
        if cls not in REAL_H or len(t["points"]) < 6 or tid in dc.get("ego_body", []):
            continue
        rows = []
        for q in t["points"]:
            x1, y1, x2, y2 = q["box"]
            ests = []
            if y1 > 3 and y2 < H - 3:
                ests.append(f * REAL_H[cls] / max(y2 - y1, 1))
            if x1 > 3 and x2 < W - 3:
                ests.append(f * REAL_W[cls] / max(x2 - x1, 1))
            if y2 < H - 3 and y2 > vh + 5:
                ests.append(f * cam_h / (y2 - vh))
            if not ests:
                continue
            Z = float(np.median(ests))
            X = ((x1 + x2) / 2 - W / 2) * Z / f   # lateral from the optical axis (the FOE only sets the horizon)
            rows.append((q["t"] - t0, X, Z))
        if len(rows) < 6:
            continue
        r = np.array(rows)
        r = r[hampel(r[:, 2], k=11)]          # drop distance readings far off the rolling median (partial / mis-sized boxes)
        if len(r) < 6:
            continue
        r[:, 1], r[:, 2] = _smooth(r[:, 1], 7), _smooth(r[:, 2], 7)
        wy = np.array([ego_y(t) for t in r[:, 0]]) + r[:, 2]
        wx = r[:, 1]
        dtt = np.gradient(r[:, 0]) if len(r) > 1 else np.ones(len(r))
        vx, vy = np.gradient(wx) / np.maximum(dtt, 1e-3), np.gradient(wy) / np.maximum(dtt, 1e-3)
        sp = _smooth(np.hypot(vx, vy), 5) * 3.6
        closing = -_smooth(np.gradient(r[:, 2]) / np.maximum(dtt, 1e-3), 5)
        ttc = [float(Z / c) if c > 0.5 and abs(X) < 2.5 + 0.15 * Z else None for X, Z, c in zip(r[:, 1], r[:, 2], closing)]   # in path: lane offset grows with range
        name = tid   # tracks.json keys are already "<class>_<id>"
        out.append({"id": name, "class": cls, "colour": None, "colour_name": t.get("colour"),
                    "points": [{"t": round(float(a), 3), "x": round(float(x), 2), "y": round(float(y), 2), "v_kmh": round(float(min(v, 150)), 1),
                                "v_sigma": round(float(v) * 0.35 + 4, 1)} for a, x, y, v in zip(r[:, 0], wx, wy, sp)]})
        rel[name] = [{"t": round(float(a), 3), "Z": round(float(z), 2), "X": round(float(x), 2), "closing_ms": round(float(c), 2),
                      "ttc": round(tt, 2) if tt is not None else None} for a, x, z, c, tt in zip(r[:, 0], r[:, 1], r[:, 2], closing, ttc)]
    # hazard = the road user with the lowest TTC in the 4 s before impact (in the ego's path), else the nearest at impact
    best, hazard = None, None
    for name, rr in rel.items():
        w = [x for x in rr if -4 <= x["t"] <= 0.2 and x["ttc"] is not None]
        if w and (best is None or min(x["ttc"] for x in w) < best):
            best, hazard = min(x["ttc"] for x in w), name
    if hazard is None and rel:
        hazard = min(rel, key=lambda n: min((abs(x["t"]) + x["Z"] / 10 for x in rel[n]), default=99))
    dc.update({"relative": rel, "hazard": hazard, "ego_track": "ego"})
    (case_dir / "dashcam.json").write_text(json.dumps(dc))
    metric = {"units": "m", "mode": "dashcam", "reproj_err_m": 0.0, "scale_sigma": 0.3, "auto": True,
              "note": f"Dashcam geometry: horizon/vanishing point from flow (row {vh:.0f}), camera height {cam_h} m, 70 deg FOV; ego speed from road flow; distances from object size",
              "features": {"camera": None}, "tracks": out}
    (case_dir / "tracks_metric.json").write_text(json.dumps(metric))
    return metric


def events(case_dir: Path) -> list[dict]:
    """Dashcam-specific OBSERVED / INFERRED events on T0: ego speed, braking onset, hazard first seen, TTC thresholds."""
    dc = json.loads((case_dir / "dashcam.json").read_text())
    t0 = dc["t0_video_s"]
    s = [x for x in dc["ego_series"] if x["v"] is not None]
    ts = np.array([x["t"] for x in s]) - t0
    vs = np.array([x["v"] for x in s]) * 3.6
    ev, n = [], 0
    def add(kind, actor, action, a, b, value, conf, rule, ref="cctv.mp4"):
        nonlocal n
        n += 1
        ev.append({"id": f"EV-D-{n:03d}", "source": "cctv", "kind": kind, "t": {"start": round(float(a), 2), "end": round(float(b), 2), "sigma": 0.15},
                   "clock": "T0", "actor": actor, "action": action, "value": value, "confidence": conf, "ref": ref, "derived_from": [], "rule": rule})
    pre = ts <= 0
    if pre.sum() > 3:
        i = int(np.argmax(np.where(pre, vs, -1)))
        add("INFERRED", "ego", "speed", ts[pre][0], 0, f"peak {vs[i]:.0f} km/h, {np.interp(-0.1, ts, vs):.0f} km/h just before impact (from road flow, ±30%)", 0.6, "R_ego_speed_flow")
        # braking = a sustained slowdown: speed falls by >= 8 km/h within the next 0.5-1.5 s and keeps falling to impact
        for k in range(len(ts)):
            if not (-4 < ts[k] < -0.2):
                continue
            ahead = [j for j in range(k, len(ts)) if ts[j] <= min(0.05, ts[k] + 1.5)]
            if len(ahead) > 3 and vs[k] - vs[ahead[-1]] >= 8 and all(vs[j] <= vs[k] + 2 for j in ahead):
                add("INFERRED", "ego", "brake", ts[k], 0, f"slowing from {vs[k]:.0f} to {vs[ahead[-1]]:.0f} km/h before impact", 0.5, "R_ego_sustained_slowdown")
                break
    add("INFERRED", "ego", "impact", 0, 0, dc["t0_method"], 0.75, "R_dashcam_impact")
    hz = dc.get("hazard")
    if hz and hz in dc["relative"]:
        rr = dc["relative"][hz]
        first = rr[0]
        add("OBSERVED", hz, "enter", first["t"], first["t"], f"first visible {first['Z']:.0f} m ahead, {abs(first['X']):.1f} m {'left' if first['X'] < 0 else 'right'} of the camera's line", 0.6, "R_first_detection")
        for thr in (3.0, 1.5):
            k = ttc_crossing(rr, thr)
            if k:
                add("INFERRED", hz, "ttc", k["t"], k["t"], f"time-to-collision below {thr:.1f} s ({k['Z']:.1f} m, closing {k['closing_ms'] * 3.6:.0f} km/h)", 0.55, f"R_ttc_{thr}")
    return ev
