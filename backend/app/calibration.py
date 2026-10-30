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
        out.append({"id": tr["id"], "class": tr["class"], "colour": tr.get("colour"),
                    "points": [{"t": float(ts[i]), "x": round(float(xs[i]), 2), "y": round(float(ys[i]), 2),
                                "v_kmh": round(float(v[i]), 1), "v_sigma": round(float(v[i] * sig + 2.0), 1)}
                               for i in range(len(ts))]})
    return {"units": "m", "reproj_err_m": round(err, 3), "scale_sigma": sig,
            "features": calib.get("features", {}), "note": calib.get("note", ""), "tracks": out}


def run(case_dir: Path) -> dict | None:
    cp = case_dir / "calibration.json"
    if not cp.exists():
        return None
    calib = json.loads(cp.read_text())
    ui = json.loads((case_dir / "tracks_ui.json").read_text())
    res = metric_tracks(ui, calib)
    (case_dir / "tracks_metric.json").write_text(json.dumps(res))
    return res
