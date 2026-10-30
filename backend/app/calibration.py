"""Road calibration: image pixels -> road-plane metres via a homography from 4+ clicked points.

World frame: x across the road (m, 0 = divider edge), y along the road (m, 0 = near edge of the zebra,
increasing away from the camera). Only points ON the road plane are valid, so tracks use the box
bottom-centre (where the object touches the road).

calibration.json = {img_pts: [[u,v],...], world_pts: [[x,y],...], scale_sigma: 0.15, features: {...}, note}
Output tracks_metric.json: per track, positions in metres and speed in km/h with an uncertainty band."""
import json
from pathlib import Path

import cv2
import numpy as np


def homography(img_pts, world_pts):
    H, _ = cv2.findHomography(np.float32(img_pts), np.float32(world_pts))
    back = cv2.perspectiveTransform(np.float32(img_pts).reshape(-1, 1, 2), H).reshape(-1, 2)
    err = float(np.sqrt(np.mean(np.sum((back - np.float32(world_pts)) ** 2, axis=1))))
    return H, err


def to_world(H, pts):
    return cv2.perspectiveTransform(np.float32(pts).reshape(-1, 1, 2), H).reshape(-1, 2)


def metric_tracks(tracks_ui: dict, calib: dict, max_range_m: float = 60.0) -> dict:
    H, err = homography(calib["img_pts"], calib["world_pts"])
    sig = calib.get("scale_sigma", 0.15)
    out = []
    for tr in tracks_ui["tracks"]:
        p = tr["points"]
        w = to_world(H, [[q["x"], q["y"]] for q in p])
        ts = np.array([q["t"] for q in p])
        keep = (np.abs(w[:, 0]) < max_range_m) & (w[:, 1] > -max_range_m) & (w[:, 1] < max_range_m)
        if keep.sum() < 6:
            continue
        w, ts = w[keep], ts[keep]
        # Smooth position, then speed from a local linear fit (more robust than frame differences).
        k = 5
        pad = lambda a: np.convolve(np.pad(a, (k // 2, k // 2), mode="edge"), np.ones(k) / k, mode="valid")
        xs, ys = pad(w[:, 0]), pad(w[:, 1])
        v = np.zeros(len(ts))
        half = 4
        for i in range(len(ts)):
            a, b = max(0, i - half), min(len(ts), i + half + 1)
            if b - a >= 3 and ts[b - 1] > ts[a]:
                vx = np.polyfit(ts[a:b], xs[a:b], 1)[0]
                vy = np.polyfit(ts[a:b], ys[a:b], 1)[0]
                v[i] = np.hypot(vx, vy) * 3.6
        out.append({"id": tr["id"], "class": tr["class"], "colour": tr.get("colour"), "colour_name": tr.get("colour_name"),
                    "points": [{"t": float(ts[i]), "x": round(float(xs[i]), 2), "y": round(float(ys[i]), 2),
                                "v_kmh": round(float(v[i]), 1), "v_sigma": round(float(v[i] * sig + 2.0), 1)}
                               for i in range(len(ts))]})
    return {"units": "m", "reproj_err_m": round(err, 3), "scale_sigma": sig,
            "features": calib.get("features", {}), "note": calib.get("note", ""), "tracks": out}


REAL_HEIGHT_M = {"person": 1.7, "car": 1.5, "bus": 3.0, "truck": 3.2, "motorcycle": 1.3, "bicycle": 1.1}


def auto_calibrate(tracks: dict, info: dict, hfov_deg: float = 60.0) -> dict:
    """Calibration with no clicks: pinhole camera over flat ground, fitted from object sizes.
    For an object of real height Hc whose box bottom is at row v: pixel height h = Hc * (v - v_horizon) / cam_height.
    A robust line fit of h/Hc against v over every detection gives the horizon and the camera height; an assumed
    60 degree field of view gives the focal length. Four synthetic road points then feed the normal homography."""
    W, H = info["width"], info["height"]
    vs, ys = [], []
    for t in tracks.values():
        hc = REAL_HEIGHT_M.get(t["class"])
        if not hc:
            continue
        for q in t["points"][::2]:
            x1, y1, x2, y2 = q["box"]
            if q["conf"] < 0.5 or y1 < 3 or y2 > H - 3 or x1 < 3 or x2 > W - 3:
                continue  # truncated boxes lie about height
            vs.append(y2); ys.append((y2 - y1) / hc)
    a, b, n_used = None, None, 0
    if len(vs) >= 20:
        v, y = np.array(vs), np.array(ys)
        keep = np.ones(len(v), bool)
        for _ in range(4):  # trimmed least squares
            a, b = np.polyfit(v[keep], y[keep], 1)
            r = np.abs(y - (a * v + b))
            keep = r <= np.percentile(r, 70)
        n_used = int(keep.sum())
    if a is None or a <= 1e-4:
        vh, cam_h, method = 0.25 * H, 6.0, "fallback (horizon at 25% of frame, 6 m camera height)"
    else:
        vh, cam_h, method = -b / a, 1 / a, f"object-size fit over {n_used} detections"
    vh = min(vh, 0.8 * H)
    f = W / (2 * np.tan(np.radians(hfov_deg / 2)))
    def ground(u, v):
        Z = f * cam_h / max(v - vh, 1.0)
        return [round((u - W / 2) * Z / f, 3), round(Z, 3)]
    v1, v2 = vh + 0.35 * (H - vh), 0.96 * H
    img = [[0.2 * W, v1], [0.8 * W, v1], [0.8 * W, v2], [0.2 * W, v2]]
    return {"img_pts": [[round(u, 1), round(v, 1)] for u, v in img], "world_pts": [ground(u, v) for u, v in img],
            "scale_sigma": 0.3, "auto": True,
            "note": f"Auto-calibrated ({method}; horizon row {vh:.0f}, camera height {cam_h:.1f} m, assumed {hfov_deg:.0f} deg FOV). Approximate: refine on the Calibrate page with 4 known road points.",
            "features": {"camera": {"x": 0.0, "y": 0.0}}}


def road_hull(metric: dict) -> list:
    """Observed drivable area: convex hull of every vehicle ground position (used when no road layout is known)."""
    pts = [[p["x"], p["y"]] for t in metric["tracks"] if t["class"] in ("car", "bus", "truck", "motorcycle", "bicycle") for p in t["points"]]
    if len(pts) < 3:
        return []
    hull = cv2.convexHull(np.float32(pts)).reshape(-1, 2)
    return [[round(float(x), 2), round(float(y), 2)] for x, y in hull]


def run(case_dir: Path) -> dict | None:
    cp = case_dir / "calibration.json"
    if not cp.exists():
        tr_p = case_dir / "tracks.json"
        if not tr_p.exists():
            return None
        tr = json.loads(tr_p.read_text())
        cp.write_text(json.dumps(auto_calibrate(tr["tracks"], tr["video"]), indent=2))
    calib = json.loads(cp.read_text())
    ui = json.loads((case_dir / "tracks_ui.json").read_text())
    res = metric_tracks(ui, calib)
    res["auto"] = bool(calib.get("auto"))
    res["features"] = {**res["features"], "road_hull": road_hull(res)}
    (case_dir / "tracks_metric.json").write_text(json.dumps(res))
    return res
